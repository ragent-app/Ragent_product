package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.*
import kotlinx.coroutines.runBlocking
import kotlin.test.*

class TurnLeaseSessionTest {
    private fun carrier(id: String) = TurnCarrier("turn://fixture", "candidate", "fixture",
        P2PCandidate("https://signal.fixture.invalid", "room", "secret", emptyList()), connectionId = id)

    private class Session(private val failClose: Boolean = false) : P2PSession {
        override var isOpen = true
        override suspend fun connect(): Result<Unit> { isOpen = true; return Result.success(Unit) }
        override suspend fun request(request: P2PHttpRequest) = Result.success(P2PHttpResponse(id = request.id, status = 200))
        override fun close() { isOpen = false; if (failClose) throw IllegalStateException("controlled close failure") }
    }

    @Test fun `old close only releases its own reservation after a replacement opens`() {
        val released = mutableListOf<String>(); val old = TurnLeaseSession(carrier("old"), Session(), released::add)
        val next = TurnLeaseSession(carrier("next"), Session(), released::add)
        old.close(); old.close()
        assertEquals(listOf("old"), released); assertTrue(next.isOpen)
        next.close(); assertEquals(listOf("old", "next"), released)
    }

    @Test fun `delegate failure cannot skip the one exact release`() {
        val released = mutableListOf<String>(); val session = TurnLeaseSession(carrier("owned"), Session(true), released::add)
        assertFailsWith<IllegalStateException> { session.close() }
        assertFailsWith<IllegalStateException> { session.close() }
        assertEquals(listOf("owned"), released)
    }

    @Test fun `late resource reopening can be closed again without repeating the release`() = runBlocking {
        val released = mutableListOf<String>(); val delegate = Session(); val session = TurnLeaseSession(carrier("owned"), delegate, released::add)
        session.close(); delegate.connect(); assertTrue(session.isOpen)
        session.close(); assertFalse(session.isOpen); assertEquals(listOf("owned"), released)
    }
}
