package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PSession
import java.util.concurrent.atomic.AtomicBoolean

/** A close belongs to the reservation that created this session, never a newer plan. */
class TurnLeaseSession(
    val carrier: TurnCarrier,
    private val delegate: P2PSession,
    private val onRelease: (String) -> Unit,
) : P2PSession by delegate {
    private val released = AtomicBoolean()
    override fun close() {
        try { delegate.close() }
        finally {
            if (released.compareAndSet(false, true)) carrier.connectionId?.takeIf(String::isNotBlank)?.let(onRelease)
        }
    }
}
