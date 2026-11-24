package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Give transient ICE loss time to recover; FAILED and CLOSED bypass this watchdog. */
internal class IceDisconnectWatchdog(
    private val scope: CoroutineScope,
    private val graceMs: Long = 2_500L,
    private val onDisconnectStarted: (() -> Unit)? = null,
    private val onPersistentDisconnect: () -> Unit,
) {
    private val lock = Any()
    private var generation = 0L
    private var pending: Job? = null

    /** A disconnected ICE event may arrive before the data channel opens. */
    fun channelOpened(iceDisconnected: Boolean) {
        if (iceDisconnected) disconnected()
    }

    fun disconnected() {
        val started = synchronized(lock) {
            if (pending?.isActive == true) return@synchronized false
            val ticket = ++generation
            pending = scope.launch {
                delay(graceMs)
                val expired = synchronized(lock) {
                    if (generation != ticket) false else { pending = null; true }
                }
                if (expired) onPersistentDisconnect()
            }
            true
        }
        if (started) onDisconnectStarted?.invoke()
    }

    fun recovered() = synchronized(lock) {
        generation++
        pending?.cancel()
        pending = null
    }
}
