package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PSession
import java.util.IdentityHashMap

/** Atomically switch new requests while allowing already-started work to drain. */
internal class TurnSessionSlot {
    private val lock = Any()
    private var current: P2PSession? = null
    private val references = IdentityHashMap<P2PSession, Int>()
    private val retiring = IdentityHashMap<P2PSession, Boolean>()

    fun get(): P2PSession? = synchronized(lock) { current }

    fun acquire(): P2PSession? = synchronized(lock) {
        val session = current?.takeIf { it.isOpen } ?: return@synchronized null
        references[session] = (references[session] ?: 0) + 1
        session
    }

    fun release(session: P2PSession) {
        val close = synchronized(lock) {
            val count = references[session] ?: return@synchronized false
            if (count > 1) { references[session] = count - 1; false }
            else { references.remove(session); retiring.remove(session) != null }
        }
        if (close) session.close()
    }

    fun replace(session: P2PSession, drain: Boolean) {
        val close = synchronized(lock) {
            val old = current
            current = session
            retiring.remove(session)
            if (old == null || old === session) null
            else if (drain && (references[old] ?: 0) > 0) { retiring[old] = true; null }
            else old
        }
        close?.close()
    }

    /** Detach only the requested current session; its owner remains responsible for closing it. */
    fun clear(session: P2PSession? = null) {
        val draining = synchronized(lock) {
            if (session != null && current !== session) return@synchronized emptyList()
            current = null
            val old = retiring.keys.toList()
            old.forEach { references.remove(it) }
            retiring.clear()
            old
        }
        draining.forEach { it.close() }
    }

    /** Shutdown/revocation closes both current and draining sessions immediately. */
    fun closeAll() {
        val sessions = synchronized(lock) {
            val all = IdentityHashMap<P2PSession, Boolean>()
            current?.let { all[it] = true }
            retiring.keys.forEach { all[it] = true }
            current = null
            retiring.clear()
            references.clear()
            all.keys.toList()
        }
        sessions.forEach { it.close() }
    }
}
