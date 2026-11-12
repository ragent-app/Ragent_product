package com.andysagent.agentoc.core.domain

import java.util.UUID

/** Opt-in, per-attempt monotonic timing; never records names, URIs or account identifiers. */
internal class AttachmentUploadTiming(
    private val clock: () -> Long,
    private val sink: (String) -> Unit,
    private val correlation: String,
) {
    private val startedAt = clock()
    private var previousPhase: FileUploadPhase? = null
    private var bodyStarted = false
    private var bodyComplete = false

    @Synchronized fun mark(stage: String, bytes: Long? = null) {
        if (stage !in stages) return
        runCatching {
            val elapsedMs = ((clock() - startedAt).coerceAtLeast(0L)) / 1_000_000
            val size = bytes?.takeIf { it >= 0 }?.let { " bytes=$it" }.orEmpty()
            sink("id=$correlation stage=$stage elapsedMs=$elapsedMs$size")
        }
    }

    @Synchronized fun progress(value: FileUploadProgress) {
        if (value.phase != previousPhase) {
            previousPhase = value.phase
            if (value.phase == FileUploadPhase.RETRYING) {
                bodyStarted = false
                bodyComplete = false
            }
            mark("phase_${value.phase.name.lowercase(java.util.Locale.ROOT)}", value.totalBytes)
        }
        if (!bodyStarted && value.phase == FileUploadPhase.TRANSFERRING && (value.writtenBytes ?: 0L) > 0L) {
            bodyStarted = true
            mark("body_started", value.totalBytes)
        }
        if (!bodyComplete && value.phase == FileUploadPhase.TRANSFERRING && value.writtenBytes == value.totalBytes) {
            bodyComplete = true
            mark("body_written", value.totalBytes)
        }
    }

    companion object {
        private val stages = setOf("hash_complete", "body_started", "body_written", "failed") +
            FileUploadPhase.entries.map { "phase_${it.name.lowercase(java.util.Locale.ROOT)}" }
        fun enabled(): AttachmentUploadTiming? = runCatching {
            val tag = "AgentoC.Upload"
            if (!android.util.Log.isLoggable(tag, android.util.Log.DEBUG)) null
            else AttachmentUploadTiming(System::nanoTime, { android.util.Log.d(tag, it) }, UUID.randomUUID().toString())
        }.getOrNull()
    }
}
