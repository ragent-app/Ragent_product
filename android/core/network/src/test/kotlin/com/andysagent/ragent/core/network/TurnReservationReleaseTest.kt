package com.andysagent.ragent.core.network

import kotlinx.coroutines.*
import kotlin.test.*

class TurnReservationReleaseTest {
    @Test fun `reachable peer releases without spending account authorization`() = runBlocking {
        val peer = mutableListOf<String>()
        TurnReservationRelease({ peer += it }, { error("Account fallback must not run") }).release("old")
        assertEquals(listOf("old"), peer)
    }

    @Test fun `peer failure preserves the captured ID when a newer plan replaces it`() = runBlocking {
        var latest = "old"; val account = mutableListOf<String>()
        TurnReservationRelease({ latest = "new"; error("PC unavailable") }, { account += it }).release(latest)
        assertEquals("new", latest); assertEquals(listOf("old"), account)
    }

    @Test fun `unreachable peer has a bounded wait before the same ID account fallback`() = runBlocking {
        val account = mutableListOf<String>()
        withTimeout(1_000) {
            TurnReservationRelease({ delay(Long.MAX_VALUE) }, { account += it }, peerTimeoutMs = 20).release("captured")
        }
        assertEquals(listOf("captured"), account)
    }

    @Test fun `caller cancellation cannot initiate an account request`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); var fallback = false
        val operation = launch {
            TurnReservationRelease({ entered.complete(Unit); delay(Long.MAX_VALUE) }, { fallback = true }).release("old")
        }
        entered.await(); operation.cancelAndJoin(); assertFalse(fallback)
    }

    @Test fun `failed account cleanup is returned without replaying the peer request`() = runBlocking {
        var calls = 0
        assertFailsWith<IllegalArgumentException> {
            TurnReservationRelease({ calls++; error("PC unavailable") }, { throw IllegalArgumentException("RAC revoked") }).release("old")
        }
        assertEquals(1, calls)
    }
}
