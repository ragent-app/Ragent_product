package com.andysagent.agentoc

import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.protocol.AccountAsrUsageDto
import com.andysagent.agentoc.feature.workbench.CloudVoiceAccess
import com.andysagent.agentoc.feature.workbench.CloudVoiceActionResult
import com.andysagent.agentoc.feature.workbench.VoiceUiState
import com.andysagent.agentoc.feature.workbench.resolveCloudVoiceAccess
import com.andysagent.agentoc.feature.workbench.runCloudVoiceActionIfAuthorized
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.coroutineContext

/** Voice input is sent only to the account-scoped central transcription service. */
internal class LocalVoiceController(
    private val app: AgentoCApplication,
    private val scope: CoroutineScope,
) {
    private val mutableState = MutableStateFlow(VoiceUiState())
    val state: StateFlow<VoiceUiState> = mutableState.asStateFlow()
    private var activeSessionId: String? = null
    private var activeJob: Job? = null
    private var stopRequested: AtomicBoolean? = null
    private var cloudUsageJob: Job? = null
    private var cloudAccessCheckJob: Job? = null

    init { refreshCloudUsage() }

    fun loadSession(sessionId: String?) {
        if (activeSessionId == sessionId) return
        cancelVoiceInput()
        activeSessionId = sessionId
    }

    fun acceptCloudVoiceConsent() {
        if (mutableState.value.cloudConsentBusy) return
        mutableState.update { it.copy(cloudConsentBusy = true, message = null) }
        scope.launch {
            runCatching { app.runtime.accountSessions.setAccountAsrConsent(accepted = true) }
                .onSuccess { consent -> mutableState.update { it.copy(
                    cloudConsentKnown = true, cloudConsentGranted = consent.granted,
                    cloudConsentPrompt = false, cloudConsentBusy = false,
                ) } }
                .onFailure { error -> mutableState.update { it.copy(
                    cloudConsentBusy = false, message = cloudErrorMessage(error),
                ) } }
        }
    }

    fun declineCloudVoiceConsent() {
        mutableState.update { it.copy(cloudConsentPrompt = false, cloudConsentBusy = false) }
    }

    fun revokeCloudVoiceConsent() {
        if (mutableState.value.cloudConsentBusy) return
        mutableState.update { it.copy(cloudConsentBusy = true, message = null) }
        scope.launch {
            runCatching { app.runtime.accountSessions.setAccountAsrConsent(accepted = false) }
                .onSuccess { mutableState.update { it.copy(
                    cloudConsentKnown = true, cloudConsentGranted = false,
                    cloudConsentPrompt = false, cloudConsentBusy = false,
                ) } }
                .onFailure { error -> mutableState.update { it.copy(
                    cloudConsentBusy = false, message = cloudErrorMessage(error),
                ) } }
        }
    }

    fun startVoiceInput(onText: (String) -> Unit) {
        val current = mutableState.value
        if (current.recording) { stopVoiceInput(); return }
        if (current.processing || current.cloudAccessChecking) return
        startCloudVoicePreflight(onText)
    }

    fun stopVoiceInput() {
        val current = mutableState.value
        if (current.cloudAccessChecking || current.processing) { cancelVoiceInput(); return }
        if (!current.recording) return
        val stop = stopRequested ?: run { cancelVoiceInput(); return }
        stop.set(true)
        mutableState.update { it.copy(recording = false, processing = true, waveformLevel = 0f) }
    }

    fun cancelVoiceInput() {
        val cloudRequestMayBeInFlight = mutableState.value.processing
        cloudAccessCheckJob?.cancel()
        cloudAccessCheckJob = null
        stopRequested?.set(true)
        activeJob?.cancel()
        activeJob = null
        stopRequested = null
        mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f,
            cloudAccessChecking = false,
            message = if (cloudRequestMayBeInFlight) {
                app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_outcome_uncertain)
            } else it.message) }
    }

    fun clearMessage() = mutableState.update { it.copy(message = null) }
    fun setMessage(message: String) = mutableState.update { it.copy(message = message) }

    private fun startCloudRecognition(onText: (String) -> Unit) {
        val stop = AtomicBoolean(false)
        val sessionId = activeSessionId
        stopRequested = stop
        mutableState.update { it.copy(recording = true, processing = false, waveformLevel = 0f, message = null) }
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
                        if (activeSessionId == sessionId) onText(result.value.text)
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
                if (activeJob === coroutineContext[Job]) {
                    activeJob = null
                    stopRequested = null
                    mutableState.update { it.copy(recording = false, processing = false, waveformLevel = 0f) }
                }
            }
        }
    }

    fun refreshCloudUsage() {
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
                        startCloudRecognition(onText)
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
                if (cloudAccessCheckJob === coroutineContext[Job]) {
                    mutableState.update { it.copy(cloudAccessChecking = false) }
                    cloudAccessCheckJob = null
                }
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

    private fun cloudErrorMessage(error: Throwable): String = when {
        error is VoiceRecordingTooShortException ->
            app.getString(com.andysagent.agentoc.feature.workbench.R.string.voice_cloud_recording_invalid)
        else -> cloudAccountErrorMessage(error)
    }

    private fun cloudAccountErrorMessage(error: Throwable): String = when ((error as? AccountSessionException)?.code) {
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

}
