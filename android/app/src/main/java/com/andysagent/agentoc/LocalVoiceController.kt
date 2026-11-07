package com.andysagent.agentoc

import android.content.Context
import android.util.Base64
import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.feature.workbench.VoiceComputerState
import com.andysagent.agentoc.feature.workbench.VoiceDestination
import com.andysagent.agentoc.feature.workbench.VoiceUiState
import com.andysagent.agentoc.feature.workbench.resolveVoiceDestination
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.atomic.AtomicBoolean

internal class LocalVoiceController(
    private val app: AgentoCApplication,
    context: Context,
    private val scope: CoroutineScope,
) {
    private val localRecognizer = PhoneOnDeviceSpeechRecognizer(context)
    private val mutableState = MutableStateFlow(
        VoiceUiState(
            phoneAvailable = localRecognizer.isAvailable(),
            phoneSupported = localRecognizer.isAvailable(),
        ),
    )
    val state: StateFlow<VoiceUiState> = mutableState.asStateFlow()
    private var activeSessionId: String? = null
    private var activeJob: Job? = null
    private var stopRequested: AtomicBoolean? = null

    init {
        scope.launch {
            app.runtime.configStore.phoneLocalVoiceEnabled.collect { enabled ->
                mutableState.update { it.copy(phoneEnabled = enabled) }
            }
        }
    }

    fun loadSession(sessionId: String?) {
        if (activeSessionId == sessionId) return
        cancelVoiceInput()
        activeSessionId = sessionId
        if (sessionId == null) {
            mutableState.update { it.copy(choice = "auto") }
            return
        }
        scope.launch {
            val choice = runCatching { app.runtime.configStore.chatVoiceChoice(sessionId).first() }
                .getOrDefault("auto")
            if (activeSessionId == sessionId) mutableState.update { it.copy(choice = choice) }
        }
    }

    fun refreshComputers(targets: List<RemoteTarget>) {
        val distinct = targets.distinctBy { it.instanceId }
        scope.launch {
            val fetched = distinct.map { target ->
                async {
                    val connected = app.runtime.targetConnectionStates.value[target.instanceId] == RuntimeConnectionState.Connected
                    if (!connected) VoiceComputerState(target.instanceId, target.label, connected = false)
                    else readComputerStatus(target)
                }
            }.awaitAll()
            mutableState.update { current ->
                current.copy(
                    computers = fetched,
                    message = current.message?.takeIf { current.recording || current.processing },
                )
            }
        }
    }

    fun selectChoice(choice: String) {
        if (choice != "auto" && choice != "phone" && !choice.matches(Regex("computer:[A-Za-z0-9._:-]{1,128}"))) return
        val sessionId = activeSessionId ?: return
        mutableState.update { it.copy(choice = choice, message = null) }
        scope.launch { runCatching { app.runtime.configStore.setChatVoiceChoice(sessionId, choice) } }
    }

    fun setPhoneEnabled(enabled: Boolean) {
        if (enabled && !localRecognizer.isAvailable()) {
            mutableState.update { it.copy(message = "On-device speech recognition is unavailable on this phone") }
            return
        }
        scope.launch {
            runCatching { app.runtime.configStore.setPhoneLocalVoiceEnabled(enabled) }
                .onFailure { error -> mutableState.update { it.copy(message = error.message ?: "Could not save phone voice setting") } }
        }
    }

    fun setComputerEnabled(targetId: String, enabled: Boolean) {
        updateComputer(targetId) { it.copy(busy = true, error = null) }
        scope.launch {
            runCatching {
                val result = app.runtime.executeOnTarget(
                    targetId,
                    ApiRequest(method = "PATCH", path = "/api/local-voice-settings", body = "{\"enabled\":$enabled}"),
                )
                check(result.isSuccessful) { responseError(result.body, "Computer voice setting could not be changed") }
                readStatusBody(result.body, targetId)
            }.onSuccess { status -> replaceComputer(status) }
                .onFailure { error -> updateComputer(targetId) { it.copy(busy = false, error = error.message) } }
        }
    }

    fun installComputer(targetId: String) {
        updateComputer(targetId) { it.copy(busy = true, error = null) }
        scope.launch {
            runCatching {
                val response = app.runtime.executeOnTarget(
                    targetId,
                    ApiRequest(method = "POST", path = "/api/local-voice-install", body = "{}"),
                )
                check(response.isSuccessful) { responseError(response.body, "Whisper installation could not start") }
                val operationId = Json.parseToJsonElement(response.body).jsonObject["operationId"]
                    ?.jsonPrimitive?.contentOrNull
                require(!operationId.isNullOrBlank()) { "Computer did not return an installation operation id" }
                pollInstall(targetId, operationId)
            }.onSuccess { status -> replaceComputer(status) }
                .onFailure { error -> updateComputer(targetId) { it.copy(busy = false, error = error.message) } }
        }
    }

    fun startVoiceInput(
        sessionTargetId: String?,
        onText: (String) -> Unit,
    ) {
        val current = mutableState.value
        if (current.recording) {
            stopVoiceInput()
            return
        }
        if (current.processing) return
        val destination = resolveVoiceDestination(
            choice = current.choice,
            sessionTargetId = sessionTargetId,
            phoneEnabled = current.phoneEnabled,
            phoneAvailable = current.phoneAvailable,
            computers = current.computers,
        )
        when (destination) {
            VoiceDestination.Phone -> startPhoneRecognition(onText)
            is VoiceDestination.Computer -> startComputerRecognition(destination.targetId, onText)
            is VoiceDestination.Unavailable -> mutableState.update { it.copy(message = destination.reason) }
        }
    }

    fun stopVoiceInput() {
        val current = mutableState.value
        when (voiceStopAction(
            recording = current.recording,
            processing = current.processing,
            computerRoute = current.operationTargetId != null,
        )) {
            VoiceStopAction.FinishComputerRecording -> {
                val stop = stopRequested
                if (stop == null) {
                    cancelVoiceInput()
                    return
                }
                stop.set(true)
                mutableState.update { state ->
                    if (state.recording && state.operationTargetId != null) {
                        state.copy(recording = false, processing = true)
                    } else state
                }
                return
            }
            VoiceStopAction.StopPhoneRecording -> {
                localRecognizer.stop(destroy = true, cancel = true)
                mutableState.update { it.copy(recording = false, processing = false, operationTargetId = null) }
                return
            }
            VoiceStopAction.CancelProcessing -> cancelVoiceInput()
            VoiceStopAction.NoOp -> Unit
        }
    }

    private fun cancelVoiceInput() {
        if (mutableState.value.recording && mutableState.value.operationTargetId == null) {
            localRecognizer.stop(destroy = true, cancel = true)
        }
        stopRequested?.set(true)
        activeJob?.cancel()
        activeJob = null
        stopRequested = null
        mutableState.update { it.copy(recording = false, processing = false, operationTargetId = null) }
    }

    fun clearMessage() = mutableState.update { it.copy(message = null) }

    fun setMessage(message: String) = mutableState.update { it.copy(message = message) }

    private fun startPhoneRecognition(onText: (String) -> Unit) {
        if (!mutableState.value.phoneEnabled || !localRecognizer.isAvailable()) {
            mutableState.update { it.copy(message = "Enable phone-local recognition in Settings first") }
            return
        }
        mutableState.update { it.copy(recording = true, processing = false, message = null, operationTargetId = null) }
        localRecognizer.start(
            onResult = { text ->
                mutableState.update { it.copy(recording = false, processing = false) }
                onText(text)
            },
            onError = { error ->
                mutableState.update { it.copy(recording = false, processing = false, message = error) }
            },
        )
    }

    private fun startComputerRecognition(targetId: String, onText: (String) -> Unit) {
        val stop = AtomicBoolean(false)
        stopRequested = stop
        mutableState.update {
            it.copy(recording = true, processing = false, message = null, operationTargetId = targetId)
        }
        activeJob = scope.launch {
            try {
                val audio = recordVoiceWav(stop)
                mutableState.update { it.copy(recording = false, processing = true) }
                val response = app.runtime.executeOnTarget(
                    targetId,
                    ApiRequest(
                        method = "POST",
                        path = "/api/local-voice-recognition",
                        body = "{\"audio\":\"${Base64.encodeToString(audio, Base64.NO_WRAP)}\"}",
                    ),
                )
                check(response.isSuccessful) { responseError(response.body, "Computer voice recognition failed") }
                val text = Json.parseToJsonElement(response.body).jsonObject["text"]
                    ?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                check(text.isNotBlank()) { "Computer returned an empty transcript" }
                onText(text)
                mutableState.update { it.copy(message = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableState.update { it.copy(message = error.message ?: "Computer voice recognition failed") }
            } finally {
                activeJob = null
                stopRequested = null
                mutableState.update { it.copy(recording = false, processing = false, operationTargetId = null) }
            }
        }
    }

    private suspend fun pollInstall(targetId: String, operationId: String): VoiceComputerState {
        repeat(180) {
            kotlinx.coroutines.delay(1_000)
            val response = app.runtime.executeOnTarget(
                targetId,
                ApiRequest(method = "GET", path = "/api/local-voice-install/$operationId"),
            )
            check(response.isSuccessful) { responseError(response.body, "Whisper installation status is unavailable") }
            val body = Json.parseToJsonElement(response.body).jsonObject
            if (body["status"]?.jsonPrimitive?.contentOrNull == "succeeded") {
                val label = mutableState.value.computers.firstOrNull { it.targetId == targetId }?.label ?: targetId
                return readComputerStatus(RemoteTarget(targetId, label, ""))
            }
            if (body["status"]?.jsonPrimitive?.contentOrNull in setOf("failed", "unknown")) {
                error(body["error"]?.jsonPrimitive?.contentOrNull ?: "Whisper installation failed")
            }
        }
        error("Whisper installation is still running; refresh this page to check again")
    }

    private suspend fun readComputerStatus(target: RemoteTarget): VoiceComputerState = runCatching {
        val response = app.runtime.executeOnTarget(target.instanceId, ApiRequest("GET", "/api/local-voice-settings"))
        check(response.isSuccessful) { responseError(response.body, "Ragent voice service is unavailable; update Ragent if needed") }
        readStatusBody(response.body, target.instanceId, target.label)
    }.getOrElse { error ->
        VoiceComputerState(
            targetId = target.instanceId,
            label = target.label.ifBlank { target.instanceId },
            connected = app.runtime.targetConnectionStates.value[target.instanceId] == RuntimeConnectionState.Connected,
            error = error.message ?: "Computer voice status is unavailable",
        )
    }

    private fun readStatusBody(body: String, targetId: String, label: String = targetId): VoiceComputerState {
        val value = Json.parseToJsonElement(body).jsonObject
        return VoiceComputerState(
            targetId = targetId,
            label = label,
            connected = true,
            installable = value["installable"]?.jsonPrimitive?.booleanOrNull == true,
            installed = value["installed"]?.jsonPrimitive?.booleanOrNull == true,
            enabled = value["enabled"]?.jsonPrimitive?.booleanOrNull == true,
            running = value["running"]?.jsonPrimitive?.booleanOrNull == true,
            ready = value["ready"]?.jsonPrimitive?.booleanOrNull == true,
            busy = value["installing"]?.jsonPrimitive?.booleanOrNull == true,
        )
    }

    private fun replaceComputer(status: VoiceComputerState) {
        mutableState.update { current ->
            current.copy(computers = current.computers.filterNot { it.targetId == status.targetId } + status)
        }
    }

    private fun updateComputer(targetId: String, transform: (VoiceComputerState) -> VoiceComputerState) {
        mutableState.update { current -> current.copy(computers = current.computers.map { if (it.targetId == targetId) transform(it) else it }) }
    }

    private fun responseError(body: String, fallback: String): String = runCatching {
        Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
    }.getOrNull() ?: fallback
}

internal enum class VoiceStopAction {
    FinishComputerRecording,
    StopPhoneRecording,
    CancelProcessing,
    NoOp,
}

internal fun voiceStopAction(recording: Boolean, processing: Boolean, computerRoute: Boolean): VoiceStopAction = when {
    recording && computerRoute -> VoiceStopAction.FinishComputerRecording
    recording -> VoiceStopAction.StopPhoneRecording
    processing -> VoiceStopAction.CancelProcessing
    else -> VoiceStopAction.NoOp
}
