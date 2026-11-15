package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.P2PSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

class TurnSessionSlotTest {
    private class Session : P2PSession {
        var closes = 0
        override val isOpen get() = closes == 0
        override suspend fun connect() = Result.success(Unit)
        override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> = error("not used")
        override fun close() { closes++ }
    }

    @Test fun `handoff serves new work on the new session while old work drains`() {
        val slot = TurnSessionSlot()
        val old = Session()
        val next = Session()
        slot.replace(old, drain = false)
        assertSame(old, slot.acquire())
        assertSame(old, slot.acquire())
        slot.replace(next, drain = true)
        assertSame(next, slot.acquire())
        assertEquals(0, old.closes)
        slot.release(old)
        assertEquals(0, old.closes)
        slot.release(old)
        assertEquals(1, old.closes)
        slot.release(next)
        slot.closeAll()
        assertEquals(1, next.closes)
    }

    @Test fun `clear of the current carrier immediately closes draining carriers`() {
        val slot = TurnSessionSlot()
        val old = Session()
        val next = Session()
        slot.replace(old, drain = false)
        slot.acquire()
        slot.replace(next, drain = true)
        slot.clear(old)
        assertSame(next, slot.get(), "stale closure must not clear the replacement")
        assertEquals(0, old.closes)
        slot.clear(next)
        assertNull(slot.get())
        assertEquals(1, old.closes)
        slot.release(old)
        assertEquals(1, old.closes)
        // The owner of the detached current carrier closes it separately.
        assertEquals(0, next.closes)
    }

    @Test fun `forced shutdown closes all carriers exactly once`() {
        val slot = TurnSessionSlot()
        val old = Session()
        val next = Session()
        slot.replace(old, drain = false)
        slot.acquire()
        slot.replace(next, drain = true)
        slot.closeAll()
        slot.release(old)
        slot.closeAll()
        assertEquals(1, old.closes)
        assertEquals(1, next.closes)
    }
}
