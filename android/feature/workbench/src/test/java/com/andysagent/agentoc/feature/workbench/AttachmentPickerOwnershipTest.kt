package com.andysagent.agentoc.feature.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentPickerOwnershipTest {
    @Test fun pickerResultReturnsToOriginalComputerAndSession() {
        val drafts = AttachmentDraftStore()
        val original = AttachmentDraftOwner("computer-a", "session-a", null)
        val otherSession = AttachmentDraftOwner("computer-a", "session-b", null)
        val otherComputer = AttachmentDraftOwner("computer-b", "session-a", null)
        val first = ComposerAttachment(id = "first", name = "first.txt")
        val selectedWhileAway = ComposerAttachment(id = "second", name = "second.txt")
        drafts[original] = listOf(first)
        // A picker opened for original returns after navigation elsewhere.
        drafts.append(original, listOf(selectedWhileAway))
        assertTrue(drafts[otherSession].isEmpty())
        assertTrue(drafts[otherComputer].isEmpty())
        assertEquals(listOf(first, selectedWhileAway), drafts[original])
        val newProjectA = AttachmentDraftOwner("computer-a", null, "project-a")
        val newProjectB = AttachmentDraftOwner("computer-a", null, "project-b")
        drafts.append(newProjectA, listOf(first))
        assertTrue(drafts[newProjectB].isEmpty())
        drafts[original] = emptyList()
        assertTrue(drafts[original].isEmpty())
    }

    @Test fun draftsSurviveStateRestorationWithMultipleOwnersAndAttachments() {
        val drafts = AttachmentDraftStore()
        val firstOwner = AttachmentDraftOwner("computer-a", "session-a", null)
        val secondOwner = AttachmentDraftOwner("computer-b", null, "project-b")
        val files = listOf(
            ComposerAttachment(id = "1", name = "销售.csv", mimeType = "text/csv", sizeBytes = 42,
                localPath = "content://documents/one", previewUrl = null),
            ComposerAttachment(id = "2", name = "销售.csv", mimeType = "text/csv", sizeBytes = 99,
                localPath = "content://documents/two", state = AttachmentState.Uploading, progress = 0.25f),
        )
        drafts[firstOwner] = files
        drafts[secondOwner] = listOf(ComposerAttachment(id = "3", name = "server.pdf", assetId = "asset-3"))
        val restored = AttachmentDraftStore.restore(drafts.snapshot())
        assertEquals(files, restored[firstOwner])
        assertEquals(drafts[secondOwner], restored[secondOwner])
        assertTrue(restored[AttachmentDraftOwner("computer-a", "session-b", null)].isEmpty())
    }
}
