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
        assertEquals(20L, totals.transferred(20))
        totals.complete(0)
        assertEquals(38L, totals.transferred(5))
        totals.complete(1)
        assertEquals(45L, totals.transferred(0))
    }
}
