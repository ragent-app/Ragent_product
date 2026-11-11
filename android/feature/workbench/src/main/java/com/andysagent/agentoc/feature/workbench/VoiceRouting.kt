package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.Immutable

@Immutable
data class VoiceUiState(
    val cloudAvailable: Boolean = false,
    val cloudLimitMs: Long = 0,
    val cloudUsedMs: Long = 0,
    val cloudReservedMs: Long = 0,
    val cloudRemainingMs: Long = 0,
    val cloudConsentKnown: Boolean = false,
    val cloudConsentGranted: Boolean = false,
    val cloudConsentPrompt: Boolean = false,
    val cloudConsentBusy: Boolean = false,
    val cloudAccessChecking: Boolean = false,
    val recording: Boolean = false,
    val processing: Boolean = false,
    val waveformLevel: Float = 0f,
    val message: String? = null,
)

enum class CloudVoiceAccess {
    Allowed,
    ConsentRequired,
    QuotaExceeded,
    Unavailable,
}

sealed interface CloudVoiceActionResult<out T> {
    data class Allowed<T>(val value: T) : CloudVoiceActionResult<T>
    data class Denied(val access: CloudVoiceAccess) : CloudVoiceActionResult<Nothing>
}

fun resolveCloudVoiceAccess(
    available: Boolean,
    remainingMs: Long,
    consentGranted: Boolean,
): CloudVoiceAccess = when {
    !available -> CloudVoiceAccess.Unavailable
    remainingMs <= 0 -> CloudVoiceAccess.QuotaExceeded
    !consentGranted -> CloudVoiceAccess.ConsentRequired
    else -> CloudVoiceAccess.Allowed
}

/** Re-fetch access before running an action that would record or upload cloud voice audio. */
suspend fun <T> runCloudVoiceActionIfAuthorized(
    readCurrentAccess: suspend () -> CloudVoiceAccess,
    action: suspend () -> T,
): CloudVoiceActionResult<T> {
    val access = readCurrentAccess()
    return if (access == CloudVoiceAccess.Allowed) {
        CloudVoiceActionResult.Allowed(action())
    } else {
        CloudVoiceActionResult.Denied(access)
    }
}
