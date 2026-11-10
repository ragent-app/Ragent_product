package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.Immutable

@Immutable
data class VoiceComputerState(
    val targetId: String,
    val label: String,
    val connected: Boolean = false,
    val installable: Boolean = false,
    val installed: Boolean = false,
    val enabled: Boolean = false,
    val running: Boolean = false,
    val ready: Boolean = false,
    val busy: Boolean = false,
    val error: String? = null,
    /** Retained for compatibility with older computer APIs; voice requests now always use automatic detection. */
    val supportedLanguages: Set<String> = setOf("auto"),
) {
    val canRouteVoice: Boolean get() = connected && installed && enabled
    val canProcessVoice: Boolean get() = canRouteVoice && running && ready && !busy
}

@Immutable
data class VoiceUiState(
    val phoneAvailable: Boolean = false,
    val phoneSupported: Boolean = false,
    val phoneNativeLanguageSupported: Boolean? = null,
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
    val computers: List<VoiceComputerState> = emptyList(),
    val choice: String = "auto",
    val recording: Boolean = false,
    val processing: Boolean = false,
    val waveformLevel: Float = 0f,
    val operationTargetId: String? = null,
    val bufferedCaptureActive: Boolean = false,
    val message: String? = null,
) {
    fun choiceLabel(
        sessionTargetId: String?,
        phoneLabel: String = "This phone",
        cloudLabel: String = "Cloud recognition",
        computerFallbackLabel: String = "Computer",
    ): String {
        if (choice == "cloud") return cloudLabel
        return when (val route = resolveVoiceDestination(
            choice = choice,
            sessionTargetId = sessionTargetId,
            phoneAvailable = phoneAvailable,
            computers = computers,
            cloudAvailable = cloudAvailable,
        )) {
            is VoiceDestination.Computer -> computers.firstOrNull { it.targetId == route.targetId }?.label ?: computerFallbackLabel
            VoiceDestination.Phone -> phoneLabel
            VoiceDestination.Cloud -> cloudLabel
            is VoiceDestination.Unavailable -> "Unavailable"
        }
    }
}

sealed interface VoiceDestination {
    data class Computer(val targetId: String) : VoiceDestination
    data object Phone : VoiceDestination
    data object Cloud : VoiceDestination
    data class Unavailable(val reason: String) : VoiceDestination
}

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

/** Automatic mode stays local; cloud recognition is only used after explicit selection. */
fun resolveVoiceDestination(
    choice: String,
    sessionTargetId: String?,
    phoneAvailable: Boolean,
    computers: List<VoiceComputerState>,
    cloudAvailable: Boolean = false,
): VoiceDestination {
    fun phone() = if (phoneAvailable) VoiceDestination.Phone else null
    fun computer(id: String) = computers.firstOrNull { it.targetId == id && it.canRouteVoice }
        ?.let { VoiceDestination.Computer(it.targetId) }

    return when {
        choice == "cloud" -> if (cloudAvailable) VoiceDestination.Cloud
            else VoiceDestination.Unavailable("Cloud speech recognition is unavailable")
        choice == "phone" -> phone() ?: VoiceDestination.Unavailable("Phone-local recognition is unavailable")
        choice.startsWith("computer:") -> {
            val targetId = choice.removePrefix("computer:")
            computer(targetId) ?: VoiceDestination.Unavailable("The selected computer cannot process voice")
        }
        sessionTargetId != null && computer(sessionTargetId) != null -> computer(sessionTargetId)!!
        phone() != null -> VoiceDestination.Phone
        else -> VoiceDestination.Unavailable("Choose a phone or paired computer with voice recognition available")
    }
}

fun encodeVoiceChoice(targetId: String?): String = when {
    targetId == null -> "auto"
    targetId == "phone" -> "phone"
    else -> "computer:$targetId"
}

/** Older paired Ragent builds may not expose the local voice API yet. */
fun isMissingComputerVoiceEndpoint(statusCode: Int?, errorMessage: String?): Boolean =
    statusCode == 404 || errorMessage?.contains("(404)", ignoreCase = true) == true
