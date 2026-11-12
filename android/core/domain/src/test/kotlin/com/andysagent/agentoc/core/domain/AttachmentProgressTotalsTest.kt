package com.andysagent.agentoc.core.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AttachmentProgressTotalsTest {
    @Test fun unknownSizesAreDiscoveredBeforeAggregatePercentIsShown() {
        val totals = AttachmentProgressTotals(listOf(0, 12))
        assertNull(totals.total())
        totals.discover(0, 33)
        assertEquals(45L, totals.total())
        totals.update(0, 20)
        assertEquals(20L, totals.transferred())
        totals.complete(0)
        totals.update(1, 5)
        assertEquals(38L, totals.transferred())
        totals.complete(1)
        assertEquals(45L, totals.transferred())
    }

    @Test fun completedKnownAttachmentDoesNotMakeAnUnknownLaterAttachmentLookComplete() {
        val totals = AttachmentProgressTotals(listOf(12, 0))
        totals.complete(0)
        assertNull(totals.total())
        totals.discover(1, 33)
        assertEquals(45L, totals.total())
        totals.update(1, 5)
        assertEquals(17L, totals.transferred())
    }

    @Test fun concurrentProgressAndDuplicateCompletionDoNotDoubleCount() {
        val totals = AttachmentProgressTotals(listOf(10, 20))
        totals.update(0, 6)
        totals.update(1, 8)
        assertEquals(14L, totals.transferred())
        totals.complete(1)
        totals.complete(1)
        totals.update(1, 5)
        assertEquals(26L, totals.transferred())
        totals.complete(0)
        assertEquals(30L, totals.transferred())
    }
}
