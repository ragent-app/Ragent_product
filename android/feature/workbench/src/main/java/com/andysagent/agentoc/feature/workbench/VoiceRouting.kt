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
    val computers: List<VoiceComputerState> = emptyList(),
    val choice: String = "auto",
    val recording: Boolean = false,
    val processing: Boolean = false,
    val waveformLevel: Float = 0f,
    val operationTargetId: String? = null,
    val message: String? = null,
) {
    fun choiceLabel(sessionTargetId: String?): String = when (val route = resolveVoiceDestination(
        choice = choice,
        sessionTargetId = sessionTargetId,
        phoneAvailable = phoneAvailable,
        computers = computers,
    )) {
        is VoiceDestination.Computer -> computers.firstOrNull { it.targetId == route.targetId }?.label ?: "Computer"
        VoiceDestination.Phone -> "This phone"
        is VoiceDestination.Unavailable -> "Unavailable"
    }
}

sealed interface VoiceDestination {
    data class Computer(val targetId: String) : VoiceDestination
    data object Phone : VoiceDestination
    data class Unavailable(val reason: String) : VoiceDestination
}

/** Route speech locally. Automatic mode prefers an enabled session computer, then this phone. */
fun resolveVoiceDestination(
    choice: String,
    sessionTargetId: String?,
    phoneAvailable: Boolean,
    computers: List<VoiceComputerState>,
): VoiceDestination {
    fun phone() = if (phoneAvailable) VoiceDestination.Phone else null
    fun computer(id: String) = computers.firstOrNull { it.targetId == id && it.canRouteVoice }
        ?.let { VoiceDestination.Computer(it.targetId) }

    return when {
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
