package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class OfferSignalingPreparationTest {
    @Test fun `offer preparation overlaps join but cannot return before join`() = runBlocking {
        val joinStarted = CompletableDeferred<Unit>()
        val joined = CompletableDeferred<Unit>()
        val offerStarted = CompletableDeferred<Unit>()
        val operation = async {
            prepareOfferAndSignaling(openSignaling = { joinStarted.complete(Unit); joined.await() },
                createOffer = { offerStarted.complete(Unit); "offer" })
        }
        joinStarted.await(); offerStarted.await()
        assertFalse(operation.isCompleted)
        joined.complete(Unit)
        assertEquals("offer", operation.await())
    }

    @Test fun `failed join cancels pending offer`() = runBlocking {
        supervisorScope {
            val started = CompletableDeferred<Unit>()
            var cancelled = false
            val operation = async {
                prepareOfferAndSignaling(openSignaling = { started.await(); error("join failed") },
                    createOffer = { started.complete(Unit); try { CompletableDeferred<String>().await() } finally { cancelled = true } })
            }
            assertFailsWith<IllegalStateException> { operation.await() }
            assertTrue(cancelled)
        }
    }

    @Test fun `failed offer cancels pending join`() = runBlocking {
        supervisorScope {
            val started = CompletableDeferred<Unit>()
            var cancelled = false
            val operation = async {
                prepareOfferAndSignaling(openSignaling = { started.complete(Unit); try { CompletableDeferred<Unit>().await() } finally { cancelled = true } },
                    createOffer = { started.await(); error("offer failed") })
            }
            assertFailsWith<IllegalStateException> { operation.await() }
            assertTrue(cancelled)
        }
    }

    @Test fun `caller cancellation stops both preparations`() = runBlocking {
        val joinStarted = CompletableDeferred<Unit>()
        val offerStarted = CompletableDeferred<Unit>()
        var joinStopped = false
        var offerStopped = false
        val operation = async {
            prepareOfferAndSignaling(openSignaling = {
                joinStarted.complete(Unit)
                try { CompletableDeferred<Unit>().await() } finally { joinStopped = true }
            }, createOffer = {
                offerStarted.complete(Unit)
                try { CompletableDeferred<String>().await() } finally { offerStopped = true }
            })
        }
        joinStarted.await(); offerStarted.await()
        operation.cancelAndJoin()
        assertTrue(joinStopped)
        assertTrue(offerStopped)
    }
}
