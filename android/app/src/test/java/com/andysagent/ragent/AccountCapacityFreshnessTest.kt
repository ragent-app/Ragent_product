package com.andysagent.ragent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountCapacityFreshnessTest {
    @Test fun onlyRecentSuccessfulChecksAreReusable() {
        assertFalse(canReuseAccountCapacity(null, 20_000))
        assertTrue(canReuseAccountCapacity(10_000, 24_999))
        assertFalse(canReuseAccountCapacity(10_000, 25_000))
        assertFalse(canReuseAccountCapacity(10_000, 9_999))
    }
}
