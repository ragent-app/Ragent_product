package com.andysagent.agentoc.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AttachmentUploadTimingTest {
    @Test fun recordsMonotonicPhasesAndOneBodyCompletionPerAttempt() {
        var now = 10_000_000L
        val lines = mutableListOf<String>()
        val timing = AttachmentUploadTiming({ now }, lines::add, "anonymous")
        now += 3_000_000; timing.mark("hash_complete", 100)
        timing.progress(FileUploadProgress(FileUploadPhase.TRANSFERRING, 100, 50))
        now += 5_000_000; timing.progress(FileUploadProgress(FileUploadPhase.TRANSFERRING, 100, 100))
        timing.progress(FileUploadProgress(FileUploadPhase.TRANSFERRING, 100, 100))
        timing.progress(FileUploadProgress(FileUploadPhase.RETRYING, 100, 0))
        timing.progress(FileUploadProgress(FileUploadPhase.TRANSFERRING, 100, 100))
        timing.progress(FileUploadProgress(FileUploadPhase.CONFIRMED, 100, 100))
        timing.mark("untrusted-name-or-path")
        assertTrue(lines.first().contains("stage=hash_complete elapsedMs=3 bytes=100"))
        assertEquals(2, lines.count { it.contains("stage=body_started") })
        assertEquals(2, lines.count { it.contains("stage=body_written") })
        assertTrue(lines.last().contains("stage=phase_confirmed"))
        assertFalse(lines.any { it.contains("untrusted-name-or-path") })
    }

    @Test fun failingDiagnosticSinkDoesNotAffectProgress() {
        val timing = AttachmentUploadTiming({ 10L }, { error("sink failure") }, "anonymous")
        timing.mark("hash_complete", 1)
        timing.progress(FileUploadProgress(FileUploadPhase.CONFIRMED, 1, 1))
    }
}
