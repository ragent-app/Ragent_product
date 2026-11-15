package com.andysagent.ragent.feature.appapi

/** A completed, explicit check of the fixed paired carrier; never a task permission or live presence. */
data class CaptureConnectionObservation(
    val targetId: String,
    val status: CaptureConnectionStatus,
    val checkedAtMillis: Long,
)

enum class CaptureConnectionStatus { AVAILABLE, UNREACHABLE, AUTHENTICATION_REQUIRED, SERVICE_UNAVAILABLE, UNPAIRED, UNKNOWN }
