package com.andysagent.ragent.core.p2p

/** Share a single cooldown across concurrent history requests. */
internal class BulkChannelRetryGate(private val cooldownMs: Long = 5_000L) {
    private val nextAttempt = java.util.concurrent.atomic.AtomicLong(Long.MIN_VALUE)

    fun tryAcquire(nowMs: Long): Boolean {
        while (true) {
            val previous = nextAttempt.get()
            if (nowMs < previous) return false
            val next = if (nowMs > Long.MAX_VALUE - cooldownMs) Long.MAX_VALUE else nowMs + cooldownMs
            if (nextAttempt.compareAndSet(previous, next)) return true
        }
    }
}
