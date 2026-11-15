package com.andysagent.ragent.core.appapi

/** Transient local-copy observation. It is never a resource receipt or a persisted URI handle. */
data class CaptureImportProgress(
    val resourceId: String,
    val originalName: String,
    val copiedBytes: Long,
    val totalBytes: Long?,
    val phase: CaptureImportPhase = CaptureImportPhase.COPYING,
) {
    init {
        require(copiedBytes >= 0)
        require(totalBytes == null || (totalBytes > 0 && copiedBytes <= totalBytes))
    }
}

enum class CaptureImportPhase { COPYING, SAVING }
