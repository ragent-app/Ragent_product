package com.andysagent.ragent.core.network

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/** Releases one captured ID; a peer outage can use this phone's Accounts scope. */
class TurnReservationRelease(
    private val peerRelease: suspend (String) -> Unit,
    private val accountRelease: (suspend (String) -> Unit)? = null,
    private val peerTimeoutMs: Long = 1_000,
) {
    suspend fun release(connectionId: String) {
        require(connectionId.isNotBlank())
        try {
            if (withTimeoutOrNull(peerTimeoutMs) { peerRelease(connectionId); true } == true) return
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Only exact-ID logical quota cleanup is retried, never business work.
        }
        val fallback = accountRelease ?: error("TURN peer release unavailable")
        fallback(connectionId)
    }
}
