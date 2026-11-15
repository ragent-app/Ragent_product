package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

/** A terminal failure wins even if the channel reports OPEN at the same time. */
internal fun connectionChannelReady(failure: String?, closed: Boolean, open: Boolean): Boolean {
    failure?.let { throw IllegalStateException(it) }
    check(!closed) { "WebRTC connection was closed" }
    return open
}

/** Wake immediately on a state callback, while retaining a bounded fallback check. */
internal class ConnectionStateWakeup {
    private val changes = Channel<Unit>(Channel.CONFLATED)

    fun signal() { changes.trySend(Unit) }

    suspend fun await(timeoutMs: Long, isReady: () -> Boolean) = withTimeout(timeoutMs) {
        while (!isReady()) withTimeoutOrNull(100) { changes.receive() }
    }
}
