package com.andysagent.agentoc

import android.content.Context
import android.speech.SpeechRecognizer
import android.util.Base64
import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.protocol.AccountAsrUsageDto
import com.andysagent.agentoc.feature.workbench.VoiceComputerState
import com.andysagent.agentoc.feature.workbench.CloudVoiceAccess
import com.andysagent.agentoc.feature.workbench.CloudVoiceActionResult
import com.andysagent.agentoc.feature.workbench.VoiceDestination
import com.andysagent.agentoc.feature.workbench.VoiceUiState
import com.andysagent.agentoc.feature.workbench.isMissingComputerVoiceEndpoint
import com.andysagent.agentoc.feature.workbench.resolveCloudVoiceAccess
import com.andysagent.agentoc.feature.workbench.resolveVoiceDestination
import com.andysagent.agentoc.feature.workbench.runCloudVoiceActionIfAuthorized
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.Locale
import java.util.UUID
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
    private var cloudUsageJob: Job? = null
    private var cloudAccessCheckJob: Job? = null

    init {
        refreshCloudUsage()
        scope.launch {
            val installedLanguage = runCatching { localRecognizer.hasInstalledLanguage(Locale.getDefault()) }.getOrNull()
            mutableState.update { current ->
                current.copy(
                    phoneNativeLanguageSupported = installedLanguage,
                    phoneAvailable = localRecognizer.isAvailable() && installedLanguage != false,
                )
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
        refreshCloudUsage()
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
        if (choice != "auto" && choice != "phone" && choice != "cloud"
            && !choice.matches(Regex("computer:[A-Za-z0-9._:-]{1,128}"))) return
        if (choice == "cloud") {
            requestCloudRoute()
            return
        }
        persistChoice(choice)
    }

    private fun persistChoice(choice: String) {
        val sessionId = activeSessionId ?: return
        val cancelCloudCheck = choice != "cloud" && cloudAccessCheckJob?.isActive == true
        if (cancelCloudCheck) {
            cloudAccessCheckJob?.cancel()
            cloudAccessCheckJob = null
        }
        mutableState.update { it.copy(choice = choice, message = null,
            cloudAccessChecking = if (cancelCloudCheck) false else it.cloudAccessChecking) }
        scope.launch { runCatching { app.runtime.configStore.setChatVoiceChoice(sessionId, choice) } }
    }

    fun acceptCloudVoiceConsent() {
        if (mutableState.value.cloudConsentBusy) return
        mutableState.update { it.copy(cloudConsentBusy = true, message = null) }
        scope.launch {
            runCatching { app.runtime.accountSessions.setAccountAsrConsent(accepted = true) }
                .onSuccess { consent ->
                    mutableState.update { it.copy(
                        cloudConsentKnown = true,
                        cloudConsentGranted = consent.granted,
                        cloudConsentPrompt = false,
                        cloudConsentBusy = false,
                    ) }
                    if (consent.granted) persistChoice("cloud")
                }
                .onFailure { error ->
                    mutableState.update { it.copy(cloudConsentBusy = false,
                        message = cloudErrorMessage(error)) }
                }
        }
    }

    fun declineCloudVoiceConsent() {
        mutableState.update { it.copy(cloudConsentPrompt = false, cloudConsentBusy = false) }
        if (mutableState.value.choice == "cloud" && !mutableState.value.cloudConsentGranted) persistChoice("auto")
    }

    fun revokeCloudVoiceConsent() {
        if (mutableState.value.cloudConsentBusy) return
        mutableState.update { it.copy(cloudConsentBusy = true, message = null) }
        scope.launch {
            runCatching { app.runtime.accountSessions.setAccountAsrConsent(accepted = false) }
                .onSuccess {
                    val sessionId = activeSessionId
                    mutableState.update { it.copy(cloudConsentKnown = true, cloudConsentGranted = false,
                        cloudConsentPrompt = false, cloudConsentBusy = false,
                        choice = if (it.choice == "cloud") "auto" else it.choice) }
                    if (sessionId != null) runCatching {
                        app.runtime.configStore.setChatVoiceChoice(sessionId, mutableState.value.choice)
                    }
                }
                .onFailure { error ->
                    mutableState.update { it.copy(cloudConsentBusy = false,
                        message = cloudErrorMessage(error)) }
                }
        }
    }

    private fun requestCloudRoute() {
        scope.launch {
            runCatching { app.runtime.accountSessions.getAccountAsrUsage() }
                .onSuccess { usage ->
                    when (updateCloudUsageState(usage)) {
                        CloudVoiceAccess.Allowed -> persistChoice("cloud")
                        else -> showCloudAccessResult(resolveCloudVoiceAccess(
                            usage.available, usage.remainingMs, usage.consent.granted,
                        ))
                    }
                }
                .onFailure { error -> mutableState.update { it.copy(
                    cloudConsentKnown = false,
                    cloudConsentGranted = false,
                    message = cloudErrorMessage(error),
                ) } }
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
        if (current.processing || current.cloudAccessChecking) return
        if (current.choice == "cloud") {
            startCloudVoicePreflight(onText)
            return
        }
        val destination = resolveVoiceDestination(
            choice = current.choice,
            sessionTargetId = sessionTargetId,
            phoneAvailable = current.phoneAvailable,
            computers = current.computers,
            cloudAvailable = current.cloudAvailable,
        )
        when (destination) {
            VoiceDestination.Phone -> startPhoneRecognition(onText)
            VoiceDestination.Cloud -> startCloudRecognition(onText)
            is VoiceDestination.Computer -> startComputerRecognition(destination.targetId, onText)
            is VoiceDestination.Unavailable -> {
                val message = if (current.choice == "cloud" && current.cloudLimitMs > 0 && current.cloudRemainingMs <= 0) {
                    app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_quota_exceeded)
                } else if (current.choice == "cloud") {
                    app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_unavailable)
                } else destination.reason
                mutableState.update { it.copy(message = message) }
            }
        }
    }

    fun stopVoiceInput() {
        val current = mutableState.value
        if (current.cloudAccessChecking) {
            cancelVoiceInput()
            return
        }
        when (voiceStopAction(
            recording = current.recording,
            processing = current.processing,
            bufferedRoute = current.operationTargetId != null || current.bufferedCaptureActive,
        )) {
            VoiceStopAction.FinishBufferedRecording -> {
                val stop = stopRequested
                if (stop == null) {
                    cancelVoiceInput()
                    return
                }
                stop.set(true)
                mutableState.update { state ->
                    if (state.recording && (state.operationTargetId != null || state.bufferedCaptureActive)) {
                        state.copy(recording = false, processing = true)
                    } else state
                }
                return
            }
            VoiceStopAction.StopPhoneRecording -> {
                val stop = stopRequested
                if (stop != null && current.operationTargetId == null && !current.bufferedCaptureActive) {
                    stop.set(true)
                    mutableState.update { it.copy(recording = false, processing = true, waveformLevel = 0f) }
                } else {
                    localRecognizer.stop(destroy = false, cancel = false)
                    mutableState.update { it.copy(recording = false, processing = true, waveformLevel = 0f) }
                }
                return
            }
            VoiceStopAction.CancelProcessing -> cancelVoiceInput()
            VoiceStopAction.NoOp -> Unit
        }
    }

    fun cancelVoiceInput() {
        val current = mutableState.value
        val cloudRequestMayBeInFlight = current.processing && current.choice == "cloud"
        if ((current.recording || current.processing)
            && current.operationTargetId == null && !current.bufferedCaptureActive) {
            localRecognizer.stop(destroy = true, cancel = true)
        }
        cloudAccessCheckJob?.cancel()
        cloudAccessCheckJob = null
        stopRequested?.set(true)
        activeJob?.cancel()
        activeJob = null
        stopRequested = null
        mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f,
            operationTargetId = null, bufferedCaptureActive = false,
            cloudAccessChecking = false,
            message = if (cloudRequestMayBeInFlight) {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_outcome_uncertain)
            } else it.message) }
    }

    fun clearMessage() = mutableState.update { it.copy(message = null) }

    fun setMessage(message: String) = mutableState.update { it.copy(message = message) }

    private fun startPhoneRecognition(onText: (String) -> Unit) {
        val current = mutableState.value
        if (!current.phoneAvailable) {
            val message = if (current.phoneNativeLanguageSupported == false) {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_phone_native_language_unsupported)
            } else {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_phone_unsupported)
            }
            mutableState.update { it.copy(message = message) }
            return
        }
        mutableState.update { it.copy(recording = true, processing = false, waveformLevel = 0f, message = null,
            operationTargetId = null, bufferedCaptureActive = false) }
        localRecognizer.start(
            onResult = { text ->
                mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f) }
                onText(text)
            },
            onError = { errorCode ->
                mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f, message = phoneRecognitionError(errorCode)) }
            },
            onLevel = { level -> mutableState.update { it.copy(waveformLevel = level) } },
        )
    }

    private fun startComputerRecognition(targetId: String, onText: (String) -> Unit) {
        val languageCode = "auto"
        val computer = mutableState.value.computers.firstOrNull { it.targetId == targetId }
        if (languageCode !in (computer?.supportedLanguages ?: setOf("auto"))) {
            mutableState.update {
                it.copy(message = app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_computer_update_required))
            }
            return
        }
        val stop = AtomicBoolean(false)
        stopRequested = stop
        mutableState.update {
            it.copy(recording = true, processing = false, waveformLevel = 0f, message = null,
                operationTargetId = targetId, bufferedCaptureActive = false)
        }
        activeJob = scope.launch {
            try {
                val audio = recordVoiceWav(stop) { level -> mutableState.update { it.copy(waveformLevel = level) } }
                mutableState.update { it.copy(recording = false, processing = true, waveformLevel = 0f) }
                val response = app.runtime.executeOnTarget(
                    targetId,
                    ApiRequest(
                        method = "POST",
                        path = "/api/local-voice-recognition",
                        body = "{\"audio\":\"${Base64.encodeToString(audio, Base64.NO_WRAP)}\",\"language\":\"$languageCode\"}",
                    ),
                )
                check(response.isSuccessful) { responseError(response.body, "Computer voice recognition failed") }
                val text = usableComputerVoiceTranscript(
                    Json.parseToJsonElement(response.body).jsonObject["text"]?.jsonPrimitive?.contentOrNull,
                )
                check(text != null) { "No speech was recognized. Try again." }
                onText(text)
                mutableState.update { it.copy(message = null) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableState.update { it.copy(message = error.message ?: "Computer voice recognition failed") }
            } finally {
                activeJob = null
                stopRequested = null
                mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f,
                    operationTargetId = null, bufferedCaptureActive = false) }
            }
        }
    }

    private fun startCloudRecognition(onText: (String) -> Unit) {
        val stop = AtomicBoolean(false)
        stopRequested = stop
        mutableState.update { it.copy(recording = true, processing = false, waveformLevel = 0f, message = null,
            operationTargetId = null, bufferedCaptureActive = true) }
        activeJob = scope.launch {
            try {
                val audio = recordVoiceWav(stop) { level -> mutableState.update { it.copy(waveformLevel = level) } }
                mutableState.update { it.copy(recording = false, processing = true, waveformLevel = 0f) }
                val requestId = UUID.randomUUID().toString()
                when (val result = runCloudVoiceActionIfAuthorized(
                    readCurrentAccess = { readCurrentCloudAccess() },
                    action = { app.runtime.accountSessions.transcribeAccountAudio(audio, requestId) },
                )) {
                    is CloudVoiceActionResult.Allowed -> {
                        onText(result.value.text)
                        mutableState.update { it.copy(message = null) }
                        refreshCloudUsage()
                    }
                    is CloudVoiceActionResult.Denied -> showCloudAccessResult(result.access)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if ((error as? AccountSessionException)?.code == "asr_consent_required") {
                    mutableState.update { it.copy(cloudConsentKnown = false, cloudConsentGranted = false,
                        cloudConsentPrompt = true, message = null) }
                } else {
                    mutableState.update { it.copy(message = cloudErrorMessage(error)) }
                }
                refreshCloudUsage()
            } finally {
                activeJob = null
                stopRequested = null
                mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f,
                    operationTargetId = null, bufferedCaptureActive = false) }
            }
        }
    }

    private fun refreshCloudUsage() {
        cloudUsageJob?.cancel()
        cloudUsageJob = scope.launch {
            val usage = runCatching { app.runtime.accountSessions.getAccountAsrUsage() }.getOrNull()
            if (usage == null) mutableState.update { it.copy(
                cloudAvailable = false,
                cloudLimitMs = 0,
                cloudUsedMs = 0,
                cloudReservedMs = 0,
                cloudRemainingMs = 0,
                cloudConsentKnown = false,
                cloudConsentGranted = false,
            ) } else updateCloudUsageState(usage)
        }
    }

    private fun startCloudVoicePreflight(onText: (String) -> Unit) {
        if (cloudAccessCheckJob?.isActive == true) return
        mutableState.update { it.copy(cloudAccessChecking = true, message = null) }
        cloudAccessCheckJob = scope.launch {
            try {
                when (val result = runCloudVoiceActionIfAuthorized(
                    readCurrentAccess = { readCurrentCloudAccess() },
                    action = {
                        if (mutableState.value.choice == "cloud") startCloudRecognition(onText)
                    },
                )) {
                    is CloudVoiceActionResult.Allowed -> Unit
                    is CloudVoiceActionResult.Denied -> showCloudAccessResult(result.access)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableState.update { it.copy(cloudConsentKnown = false, cloudConsentGranted = false,
                    cloudConsentPrompt = false, message = cloudErrorMessage(error)) }
            } finally {
                mutableState.update { it.copy(cloudAccessChecking = false) }
                cloudAccessCheckJob = null
            }
        }
    }

    private suspend fun readCurrentCloudAccess(): CloudVoiceAccess {
        val usage = app.runtime.accountSessions.getAccountAsrUsage()
        return updateCloudUsageState(usage)
    }

    private fun updateCloudUsageState(usage: AccountAsrUsageDto): CloudVoiceAccess {
        val access = resolveCloudVoiceAccess(usage.available, usage.remainingMs, usage.consent.granted)
        mutableState.update { it.copy(
            cloudAvailable = usage.available && usage.remainingMs > 0,
            cloudLimitMs = usage.limitMs,
            cloudUsedMs = usage.usedMs,
            cloudReservedMs = usage.reservedMs,
            cloudRemainingMs = usage.remainingMs,
            cloudConsentKnown = true,
            cloudConsentGranted = usage.consent.granted,
        ) }
        return access
    }

    private fun showCloudAccessResult(access: CloudVoiceAccess) {
        mutableState.update { current ->
            when (access) {
                CloudVoiceAccess.Allowed -> current.copy(cloudConsentPrompt = false, message = null)
                CloudVoiceAccess.ConsentRequired -> current.copy(cloudConsentPrompt = true, message = null)
                CloudVoiceAccess.QuotaExceeded -> current.copy(cloudConsentPrompt = false,
                    message = app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_quota_exceeded))
                CloudVoiceAccess.Unavailable -> current.copy(cloudConsentPrompt = false,
                    message = app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_unavailable))
            }
        }
    }

    private fun cloudErrorMessage(error: Throwable): String = when ((error as? AccountSessionException)?.code) {
        "asr_monthly_quota_exceeded" -> app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_quota_exceeded)
        "owner_auth_account_credential_invalid", "owner_auth_account_credential_expired",
        "owner_auth_account_device_revoked", "account_session_reauthorization_required" ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_sign_in_required)
        "asr_provider_outcome_unknown", "asr_request_outcome_unknown", "asr_request_in_progress" ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_outcome_uncertain)
        "asr_idempotency_result_expired" ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_retry_new_recording)
        "asr_unavailable", "asr_provider_unavailable", "asr_provider_rate_limited" ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_unavailable)
        "asr_audio_too_long", "asr_audio_too_large" -> app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_recording_too_long)
        "asr_audio_too_short", "asr_audio_format_unsupported", "asr_audio_invalid",
        "asr_provider_rejected_audio", "asr_provider_invalid_response" ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_recording_invalid)
        else -> app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_unavailable)
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
        check(response.isSuccessful) {
            if (isMissingComputerVoiceEndpoint(response.statusCode, null)) {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_computer_update_required)
            } else {
                responseError(response.body, "Ragent voice service is unavailable")
            }
        }
        readStatusBody(response.body, target.instanceId, target.label)
    }.getOrElse { error ->
        VoiceComputerState(
            targetId = target.instanceId,
            label = target.label.ifBlank { target.instanceId },
            connected = app.runtime.targetConnectionStates.value[target.instanceId] == RuntimeConnectionState.Connected,
            error = if (isMissingComputerVoiceEndpoint(null, error.message)) {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_computer_update_required)
            } else {
                error.message ?: "Computer voice status is unavailable"
            },
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
            supportedLanguages = value["supportedLanguages"]?.jsonArray
                ?.mapNotNull { it.jsonPrimitive.contentOrNull }
                ?.toSet()
                ?.takeIf { it.isNotEmpty() }
                ?: setOf("auto"),
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

    private fun phoneRecognitionError(errorCode: Int): String {
        val resource = phoneRecognitionErrorStringResource(errorCode)
        return if (resource == com.andysagent.agentoc.feature.workbench.R.string.voice_error_recognition_failed) {
            app.getString(resource, errorCode)
        } else {
            app.getString(resource)
        }
    }
}

internal fun phoneRecognitionErrorStringResource(errorCode: Int): Int = when (errorCode) {
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_language_unsupported
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_language_pack_missing
    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_no_speech
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_microphone_permission
    SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_support_check_failed
    else -> com.andysagent.agentoc.feature.workbench.R.string.voice_error_recognition_failed
}

internal enum class VoiceStopAction {
    FinishBufferedRecording,
    StopPhoneRecording,
    CancelProcessing,
    NoOp,
}

internal fun usableComputerVoiceTranscript(transcript: String?): String? {
    val text = transcript?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val silenceMarker = Regex("(?i)^\\[\\s*(?:blank[ _]audio|silence)\\s*\\]$")
    return text.takeUnless(silenceMarker::matches)
}

internal fun voiceStopAction(recording: Boolean, processing: Boolean, bufferedRoute: Boolean): VoiceStopAction = when {
    recording && bufferedRoute -> VoiceStopAction.FinishBufferedRecording
    recording -> VoiceStopAction.StopPhoneRecording
    processing -> VoiceStopAction.CancelProcessing
    else -> VoiceStopAction.NoOp
}
