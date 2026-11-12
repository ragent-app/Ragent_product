package com.andysagent.agentoc.core.domain

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CombinedIntentAvailabilityTest {
    @Test fun absentEndpointsExpireAndAreIsolatedByComputer() {
        var now = 100L
        val availability = CombinedIntentAvailability({ now }, ttlNanos = 10, maximumEntries = 2)
        availability.markAbsent("old")
        assertFalse(availability.mayProbe("old"))
        assertTrue(availability.mayProbe("other"))
        now += 10
        assertTrue(availability.mayProbe("old"))
    }

    @Test fun cacheEvictsOldestComputerAtItsBound() {
        val availability = CombinedIntentAvailability({ 100L }, ttlNanos = 10, maximumEntries = 2)
        availability.markAbsent("one")
        availability.markAbsent("two")
        availability.markAbsent("three")
        assertTrue(availability.mayProbe("one"))
        assertFalse(availability.mayProbe("two"))
        assertFalse(availability.mayProbe("three"))
    }
}
