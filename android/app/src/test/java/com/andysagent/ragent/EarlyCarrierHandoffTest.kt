package com.andysagent.ragent

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class EarlyCarrierHandoffTest {
    @Test fun requestsBeforeExpiryAndStopsWhenCarrierChanges() = runBlocking {
        var elapsed = 0L
        var current = true
        var requestAt = -1L
        requestEarlyCarrierHandoff(1_300_000L, 300_000_000_000L,
            isCurrent = { current }, request = { requestAt = elapsed; current = false; 202 },
            nowMs = { 1_000_000L + elapsed }, nowNs = { elapsed * 1_000_000L }, sleep = { elapsed += it })
        assertEquals(180_000L, requestAt)
    }

    @Test fun retriesTransientFailureButStopsForOlderServer() = runBlocking {
        var elapsed = 0L
        var requests = 0
        val statuses = listOf(202, 503, 404)
        requestEarlyCarrierHandoff(2_120_000L, 120_000_000_000L,
            isCurrent = { true }, request = { statuses[requests++] },
            nowMs = { 2_000_000L + elapsed }, nowNs = { elapsed * 1_000_000L }, sleep = { elapsed += it })
        assertEquals(3, requests)
        assertEquals(50_000L, elapsed)
    }

    @Test fun neverRequestsAfterSignedOrMonotonicExpiry() = runBlocking {
        var requests = 0
        requestEarlyCarrierHandoff(1_000L, 500_000_000L, isCurrent = { true }, request = { requests++; 202 },
            nowMs = { 2_000L }, nowNs = { 1_000_000_000L }, sleep = {})
        assertEquals(0, requests)
    }

    @Test fun closesDrainingCarrierAtOriginalMonotonicExpiry() = runBlocking {
        var elapsed = 0L
        var closedAt = -1L
        closeCarrierAtSignedExpiry(999_999L, 2_500_000_000L,
            isOpen = { closedAt < 0 }, close = { closedAt = elapsed },
            nowMs = { 1_000L }, nowNs = { elapsed * 1_000_000L }, sleep = { elapsed += it })
        assertEquals(2_500L, closedAt)
    }
}
