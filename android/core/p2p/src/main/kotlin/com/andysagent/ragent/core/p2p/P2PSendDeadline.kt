package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.withTimeoutOrNull

internal class P2PSendTimeoutException : IllegalStateException("P2P data channel send timed out")

/** Internal send deadlines are transport failures; caller cancellation still propagates. */
internal suspend fun withP2PSendDeadline(timeoutMs: Long, block: suspend () -> Unit) {
    val completed = withTimeoutOrNull(timeoutMs) { block(); true }
    if (completed != true) throw P2PSendTimeoutException()
}
