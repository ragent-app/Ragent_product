package com.andysagent.ragent

import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

internal fun capacityRateLimitDelayMs(error: Exception): Long {
    val hint = when (error) {
        is AccountSessionException -> error.retryAfterMs
        is AccountsRepositoryException -> (error.cause as? ApiException)?.retryAfterMs
        else -> null
    }
    return hint?.takeIf { it > 0L }?.coerceAtLeast(1_000L) ?: 5_000L
}

/** One bounded-backoff capacity refresh per selected target. */
internal class TargetCapacityRetry(
    private val scope: CoroutineScope,
    private val eligible: suspend (String) -> Boolean,
    private val attempt: suspend (String) -> Boolean,
    private val minimumDelayMs: () -> Long = { 0L },
    private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000L },
    private val wait: suspend (Long, Channel<Unit>) -> Unit = { millis, wake ->
        withTimeoutOrNull(millis) { wake.receive() }
        Unit
    },
) {
    private val lock = Any()
    private var target: String? = null
    private var job: Job? = null
    private var wakeup: Channel<Unit>? = null
    private var generation = 0L
    private var cooldownUntil: Long? = null

    fun remainingCooldownMs(): Long = synchronized(lock) {
        val deadline = cooldownUntil
        val now = monotonicMillis()
        when {
            deadline == null || deadline <= now -> 0L
            now < 0L && deadline > Long.MAX_VALUE + now -> Long.MAX_VALUE
            else -> deadline - now
        }
    }

    /** A 429 from any caller fences both direct refreshes and queued retries. */
    fun deferFor(delayMs: Long) = synchronized(lock) {
        if (delayMs <= 0L) return@synchronized
        val now = monotonicMillis()
        val deadline = if (now > Long.MAX_VALUE - delayMs) Long.MAX_VALUE else now + delayMs
        if (cooldownUntil == null || deadline > cooldownUntil!!) cooldownUntil = deadline
    }

    /** Caller holds lock. Preserve a cooldown across lifecycle or target changes. */
    private fun rememberCooldown() {
        val delay = minimumDelayMs().coerceAtLeast(0L)
        val now = monotonicMillis()
        if (delay > 0L && (cooldownUntil == null || cooldownUntil!! <= now)) {
            cooldownUntil = if (now > Long.MAX_VALUE - delay) Long.MAX_VALUE else now + delay
        }
    }

    fun request(instanceId: String, expedite: Boolean = false) = synchronized(lock) {
        if (target == instanceId && job?.isActive == true) {
            if (expedite && minimumDelayMs() <= 0L) wakeup?.trySend(Unit)
            return@synchronized
        }
        if (job?.isActive == true) rememberCooldown()
        job?.cancel()
        val ticket = ++generation
        val wake = Channel<Unit>(Channel.CONFLATED)
        wakeup = wake
        target = instanceId
        val next = scope.launch(start = CoroutineStart.LAZY) {
            try {
                var failures = 0
                while (eligible(instanceId)) {
                    // Another direct caller can receive a 429 while this job
                    // is already sleeping in ordinary backoff. Recheck before
                    // every attempt, including after an expedited wakeup.
                    while (eligible(instanceId)) {
                        val remaining = remainingCooldownMs()
                        if (remaining == 0L) break
                        wait(remaining, wake)
                    }
                    if (!eligible(instanceId)) break
                    val succeeded = try { attempt(instanceId) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { false }
                    if (succeeded) return@launch
                    val backoff = minOf(15_000L, 1_000L * (1L shl failures.coerceAtMost(4)))
                    val floor = synchronized(lock) {
                        if (minimumDelayMs() > 0L) {
                            rememberCooldown()
                            while (wake.tryReceive().isSuccess) { }
                            remainingCooldownMs()
                        } else {
                            cooldownUntil = null
                            0L
                        }
                    }
                    wait(maxOf(backoff, floor), wake)
                    failures++
                }
            } finally {
                synchronized(lock) {
                    if (generation == ticket) { job = null; target = null; wakeup = null }
                    wake.close()
                }
            }
        }
        job = next
        next.start()
    }

    fun cancel() = synchronized(lock) {
        generation++
        if (job?.isActive == true) rememberCooldown()
        job?.cancel()
        job = null
        target = null
        wakeup = null
    }
}
