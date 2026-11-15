package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.protocol.TemporaryIceServer
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class TemporaryCarrierConnectorTest {
    private fun delivery(expiresAt: Long = 2_000_000, target: Char = 'a'): VerifiedTemporaryConnection = VerifiedTemporaryConnection(
        "inst_${target.toString().repeat(32)}", "rdev_${"b".repeat(32)}", "rtr_${"c".repeat(32)}", expiresAt,
        true, target.toString().repeat(40), target.toString().repeat(64), "https://signal.example.test/",
        listOf(TemporaryIceServer("turn:turn.example.test:3478", "user", "password")), "signed-$target")

    private class FakeSession(private val gate: CompletableDeferred<Result<Unit>>? = null,
        private val outcome: Result<Unit> = Result.success(Unit)) : P2PSession {
        override var isOpen = false
        var closes = 0
        val started = CompletableDeferred<Unit>()
        private var listener: ((String) -> Unit)? = null
        override fun setUnexpectedCloseListener(listener: ((String) -> Unit)?) { this.listener = listener }
        override suspend fun connect(): Result<Unit> {
            started.complete(Unit)
            return (gate?.await() ?: outcome).also { if (it.isSuccess) isOpen = true }
        }
        override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> =
            Result.success(P2PHttpResponse(request.id, status = 200))
        override fun close() { closes++; isOpen = false }
        fun lose() { isOpen = false; listener?.invoke("transport-lost") }
    }

    @Test fun `signed temporary carrier begins with relay and never falls back on failed upgrade`() = runBlocking {
        var now = 1_000_000L
        val candidates = mutableListOf<P2PCandidate>()
        val first = FakeSession()
        val failedUpgrade = FakeSession(outcome = Result.failure(IllegalStateException("direct unavailable")))
        val factory = P2PSessionFactory { candidate ->
            candidates += candidate
            if (candidates.size == 1) first else failedUpgrade
        }
        val connector = TemporaryCarrierConnector(factory, this, { now })
        assertSame(first, connector.connect(delivery()))
        assertTrue(candidates.single().turnOnly)
        assertEquals("user", candidates.single().iceServers.single().username)
        assertSame(first, connector.connect(delivery()))
        assertEquals(1, candidates.size)
        assertFalse(connector.upgrade())
        assertFalse(candidates.last().turnOnly)
        assertSame(first, connector.session())
        now = 2_000_000L
        assertNull(connector.session())
        assertEquals(1, first.closes)
    }

    @Test fun `stop during negotiation cannot publish a late DataChannel`() = runBlocking {
        val gate = CompletableDeferred<Result<Unit>>()
        val pending = FakeSession(gate)
        val connector = TemporaryCarrierConnector(P2PSessionFactory { pending }, this, { 1_000_000L })
        val task = async { runCatching { connector.connect(delivery()) } }
        pending.started.await()
        connector.stop()
        gate.complete(Result.success(Unit))
        assertTrue(task.await().isFailure)
        assertNull(connector.session())
        assertTrue(pending.closes >= 1)
    }

    @Test fun `unexpected close removes the capability and requests original-grant recovery`() = runBlocking {
        val session = FakeSession()
        val reasons = mutableListOf<String>()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { session }, this, { 1_000_000L },
            onRecoveryRequired = { _, reason -> reasons += reason })
        connector.connect(delivery())
        session.lose()
        assertNull(connector.session())
        assertEquals(listOf("transport-lost"), reasons)
        connector.stop()
    }

    @Test fun `independent computers keep separate live relays and expire independently`() = runBlocking {
        var now = 1_000_000L
        val made = mutableListOf<FakeSession>()
        val connector = TemporaryCarrierConnector(P2PSessionFactory {
            FakeSession().also(made::add)
        }, this, { now })
        val first = delivery(expiresAt = 2_000_000, target = 'a')
        val second = delivery(expiresAt = 3_000_000, target = 'd')

        val firstSession = connector.connect(first)
        val secondSession = connector.connect(second)

        assertSame(firstSession, connector.session(first))
        assertSame(secondSession, connector.session(second))
        assertNull(connector.session(), "Untargeted lookup is ambiguous with multiple live computers")
        assertEquals(setOf(first.instanceId, second.instanceId), connector.connectedInstanceIds())

        now = 2_000_000
        assertNull(connector.session(first))
        assertSame(secondSession, connector.session(second))
        assertEquals(1, (firstSession as FakeSession).closes)
        assertEquals(0, (secondSession as FakeSession).closes)
        connector.stop(second.instanceId)
        assertEquals(1, (secondSession as FakeSession).closes)
        assertTrue(made.all { it.closes == 1 })
    }

    @Test fun `stopping one target leaves another pending negotiation intact`() = runBlocking {
        val gate = CompletableDeferred<Result<Unit>>()
        val first = FakeSession(gate)
        val second = FakeSession()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { candidate ->
            if (candidate.roomId == "a".repeat(40)) first else second
        }, this, { 1_000_000L })

        val pendingFirst = async { runCatching { connector.connect(delivery(target = 'a')) } }
        first.started.await()
        assertSame(second, connector.connect(delivery(target = 'd')))
        connector.stop("inst_${"a".repeat(32)}")
        gate.complete(Result.success(Unit))

        assertTrue(pendingFirst.await().isFailure)
        assertSame(second, connector.session(delivery(target = 'd')))
        assertEquals(0, second.closes)
        connector.stop()
    }
}
