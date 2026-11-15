package com.andysagent.ragent.core.agentui

import androidx.compose.ui.text.TextRange
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ComposerSelectionRetentionTest {
    @Test fun blurCannotOverwriteTheEditingRange() {
        val retention = ComposerSelectionRetention()
        retention.observe(true, true, TextRange(2, 5))
        retention.observe(false, true, TextRange(2, 5))
        retention.observe(false, false, TextRange(5))
        retention.observe(true, false, TextRange(5))
        assertEquals(TextRange(2, 5), retention.selectionToRestore(10))
    }

    @Test fun restoringAndEditingUsesTheNewRangeOnTheNextCollapse() {
        val retention = ComposerSelectionRetention()
        retention.observe(true, true, TextRange(2, 5))
        retention.observe(false, false, TextRange(5))
        retention.restored(TextRange(2, 5))
        retention.observe(true, true, TextRange(8, 4))
        retention.observe(false, false, TextRange(4))
        assertEquals(TextRange(8, 4), retention.selectionToRestore(10))
    }

    @Test fun externalDocumentReplacementDiscardsTheOldRange() {
        val retention = ComposerSelectionRetention()
        retention.observe(true, true, TextRange(2, 5))
        retention.observe(false, false, TextRange(5))
        retention.discard()
        assertNull(retention.selectionToRestore(3))
    }

    @Test fun aRetainedRangeIsClampedWithoutReversingItsDirection() {
        val retention = ComposerSelectionRetention()
        retention.observe(true, true, TextRange(8, 2))
        retention.observe(false, false, TextRange(2))
        assertEquals(TextRange(4, 2), retention.selectionToRestore(4))
    }

    @Test fun noFocusedEditingDoesNotInventASelection() {
        val retention = ComposerSelectionRetention()
        retention.observe(false, false, TextRange(0))
        assertNull(retention.selectionToRestore(10))
    }
}
