package com.andysagent.ragent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/** Request a replacement while the original signed carrier is still valid. */
internal suspend fun requestEarlyCarrierHandoff(
    signedExpiryMs: Long,
    monotonicDeadlineNs: Long,
    isCurrent: () -> Boolean,
    request: suspend () -> Int,
    nowMs: () -> Long = System::currentTimeMillis,
    nowNs: () -> Long = System::nanoTime,
    sleep: suspend (Long) -> Unit = { delay(it) },
) {
    fun remainingMs(): Long = minOf(
        signedExpiryMs - nowMs(),
        TimeUnit.NANOSECONDS.toMillis(monotonicDeadlineNs - nowNs()),
    ).coerceAtLeast(0L)

    sleep((remainingMs() - 120_000L).coerceAtLeast(0L))
    while (currentCoroutineContext().isActive && isCurrent() && remainingMs() > 0L) {
        val status = try { withTimeoutOrNull(8_000L) { request() } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { null }
        // Older servers and explicit authorization failures must not be
        // hammered or silently converted into a new pairing.
        if (status in setOf(401, 403, 404, 405)) return
        val remaining = remainingMs()
        if (remaining <= 0L || !isCurrent()) return
        sleep(minOf(25_000L, remaining))
    }
}

/** A draining old carrier must never outlive its original signed window. */
internal suspend fun closeCarrierAtSignedExpiry(
    signedExpiryMs: Long,
    monotonicDeadlineNs: Long,
    isOpen: () -> Boolean,
    close: () -> Unit,
    nowMs: () -> Long = System::currentTimeMillis,
    nowNs: () -> Long = System::nanoTime,
    sleep: suspend (Long) -> Unit = { delay(it) },
) {
    while (currentCoroutineContext().isActive && isOpen()) {
        val remaining = minOf(signedExpiryMs - nowMs(),
            TimeUnit.NANOSECONDS.toMillis(monotonicDeadlineNs - nowNs()))
        if (remaining <= 0L) { close(); return }
        sleep(minOf(remaining, 1_000L))
    }
}
