package com.andysagent.ragent

import com.andysagent.ragent.core.auth.StagedTemporaryAttachment
import com.andysagent.ragent.core.auth.TemporaryTextOperation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TemporaryShareRecoveryTest {
    private val instanceId = "inst_${"a".repeat(32)}"
    private val digest = "1".repeat(64)
    private val now = 10_000L

    private fun attachment(stage: String, request: String, name: String = "notes.txt",
        size: Long = 5, sha256: String = digest) = StagedTemporaryAttachment(
        stageId = "tast_${stage.repeat(32)}", requestId = request,
        originalName = name, mimeType = "text/plain", sizeBytes = size, sha256 = sha256)

    private fun operation(id: String, createdAt: Long, attachment: StagedTemporaryAttachment,
        text: String = "Review these notes", instance: String = instanceId, expiresAt: Long = now + 60_000) =
        TemporaryTextOperation(operationId = id, instanceId = instance,
            grantId = "rtg_${"b".repeat(32)}", sessionKey = "session_$id", messageRequestId = "message_$id",
            tool = "codex", text = text, createdAt = createdAt, expiresAt = expiresAt,
            attachments = listOf(attachment))

    @Test fun matchingFileShareRecoversOriginalOperationAcrossFreshLocalStageIds() {
        val existing = operation("top_old", 1, attachment("a", "first-request"))
        val newlyStaged = attachment("c", "new-request")

        val recovered = findRecoverableTemporaryFileShare(listOf(existing), instanceId,
            "Review these notes", listOf(newlyStaged), now)

        assertEquals(existing.operationId, recovered?.operationId)
    }

    @Test fun fileRecoveryRejectsDifferentBytesTextTargetAndExpiredOperations() {
        val original = attachment("a", "first-request")
        val existing = operation("top_old", 1, original)

        assertNull(findRecoverableTemporaryFileShare(listOf(existing), instanceId, "Do something else",
            listOf(attachment("c", "new-request")), now))
        assertNull(findRecoverableTemporaryFileShare(listOf(existing), instanceId, "Review these notes",
            listOf(attachment("c", "new-request", sha256 = "2".repeat(64))), now))
        assertNull(findRecoverableTemporaryFileShare(listOf(existing.copy(instanceId = "inst_${"d".repeat(32)}")), instanceId,
            "Review these notes", listOf(attachment("c", "new-request")), now))
        assertNull(findRecoverableTemporaryFileShare(listOf(existing.copy(expiresAt = now)), instanceId,
            "Review these notes", listOf(attachment("c", "new-request")), now))
    }

    @Test fun fileRecoveryChoosesNewestMatchingOperation() {
        val expected = attachment("c", "new-request")
        val old = operation("top_old", 1, attachment("a", "old-request"))
        val recent = operation("top_recent", 2, attachment("b", "recent-request"))

        val recovered = findRecoverableTemporaryFileShare(listOf(old, recent), instanceId,
            "Review these notes", listOf(expected), now)

        assertEquals(recent.operationId, recovered?.operationId)
    }
}
