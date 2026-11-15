package com.andysagent.ragent

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.network.ApiException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class TargetCapacityRetryTest {
    @Test fun `a direct 429 during ordinary backoff fences the next retry`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val clock = AtomicLong(1_000L)
        val waits = Channel<Long>(Channel.UNLIMITED)
        val calls = Channel<Int>(Channel.UNLIMITED)
        val count = AtomicInteger()
        val retry = TargetCapacityRetry(scope, eligible = { true }, monotonicMillis = { clock.get() },
            attempt = { val call = count.incrementAndGet(); calls.send(call); call == 2 },
            wait = { millis, wake -> waits.send(millis); wake.receive() })
        try {
            retry.request("pc-a")
            assertEquals(1, withTimeout(1_000) { calls.receive() })
            assertEquals(1_000L, withTimeout(1_000) { waits.receive() })
            retry.deferFor(30_000L)
            retry.request("pc-a", expedite = true)
            assertEquals(30_000L, withTimeout(1_000) { waits.receive() })
            assertFalse(calls.tryReceive().isSuccess)
            clock.set(31_000L)
            retry.request("pc-a", expedite = true)
            assertEquals(2, withTimeout(1_000) { calls.receive() })
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `capacity fallback preserves the transport retry hint`() {
        val transport = ApiException(429, "rate_limited", "busy", retryAfterMs = 90_000L)
        val fallback = AccountsRepositoryException(429, "rate_limited", "busy", true, transport)
        assertEquals(90_000L, capacityRateLimitDelayMs(fallback))
        assertEquals(75_000L, capacityRateLimitDelayMs(AccountSessionException(429, "rate_limited", "busy", retryAfterMs = 75_000L)))
        assertEquals(5_000L, capacityRateLimitDelayMs(IllegalStateException("unknown")))
    }

    @Test fun `direct refresh cooldown fences new jobs and cannot be shortened`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val clock = AtomicLong(1_000L)
        val observed = CompletableDeferred<Long>()
        val permits = Channel<Unit>(Channel.UNLIMITED)
        val calls = Channel<Unit>(Channel.UNLIMITED)
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = { calls.send(Unit); true },
            monotonicMillis = { clock.get() }, wait = { millis, _ -> observed.complete(millis); permits.receive() })
        try {
            retry.deferFor(30_000L)
            clock.set(6_000L)
            retry.deferFor(1_000L)
            assertEquals(25_000L, retry.remainingCooldownMs())
            retry.request("pc-a")
            assertEquals(25_000L, withTimeout(1_000) { observed.await() })
            retry.request("pc-a", expedite = true)
            assertFalse(calls.tryReceive().isSuccess)
            clock.set(31_000L)
            permits.send(Unit)
            withTimeout(1_000) { calls.receive() }
            assertEquals(0L, retry.remainingCooldownMs())
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `long server cooldown is not shortened`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val observed = CompletableDeferred<Long>()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = { false },
            minimumDelayMs = { 90_000L }, wait = { millis, _ ->
                observed.complete(millis)
                CompletableDeferred<Unit>().await()
            })
        try {
            retry.request("pc-a")
            assertEquals(90_000L, withTimeout(1_000) { observed.await() })
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `target switch and foreground restart preserve the remaining server cooldown`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = Channel<String>(Channel.UNLIMITED)
        val delays = Channel<Long>(Channel.UNLIMITED)
        val permits = Channel<Unit>(Channel.UNLIMITED)
        val clock = AtomicLong(-100_000L)
        val floor = AtomicInteger()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = {
            calls.send(it)
            if (it == "pc-a") { floor.set(25_000); false } else true
        }, minimumDelayMs = { floor.get().toLong() }, monotonicMillis = { clock.get() },
            wait = { millis, _ -> delays.send(millis); permits.receive() })
        try {
            retry.request("pc-a")
            assertEquals("pc-a", withTimeout(1_000) { calls.receive() })
            assertEquals(25_000L, withTimeout(1_000) { delays.receive() })
            clock.set(-93_000L)
            retry.cancel()
            retry.request("pc-b")
            assertEquals(18_000L, withTimeout(1_000) { delays.receive() })
            retry.request("pc-b", expedite = true)
            assertFalse(calls.tryReceive().isSuccess)
            clock.set(-75_000L)
            permits.send(Unit)
            assertEquals("pc-b", withTimeout(1_000) { calls.receive() })
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `transient failures retry and duplicate requests share one job`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = Channel<String>(Channel.UNLIMITED)
        val delays = Channel<Long>(Channel.UNLIMITED)
        val permits = Channel<Unit>(Channel.UNLIMITED)
        val attempts = AtomicInteger()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = {
            val count = attempts.incrementAndGet(); calls.send(it); count >= 3
        }, wait = { millis, _ -> delays.send(millis); permits.receive() })
        try {
            retry.request("pc-a")
            assertEquals("pc-a", withTimeout(1_000) { calls.receive() })
            assertEquals(1_000L, withTimeout(1_000) { delays.receive() })
            retry.request("pc-a")
            assertFalse(calls.tryReceive().isSuccess)
            permits.send(Unit)
            assertEquals("pc-a", withTimeout(1_000) { calls.receive() })
            assertEquals(2_000L, withTimeout(1_000) { delays.receive() })
            permits.send(Unit)
            assertEquals("pc-a", withTimeout(1_000) { calls.receive() })
            assertEquals(3, attempts.get())
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `new target cancels an old target retry`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = Channel<String>(Channel.UNLIMITED)
        val waiting = Channel<Unit>(Channel.UNLIMITED)
        val never = Channel<Unit>()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = { calls.send(it); false },
            wait = { _, _ -> waiting.send(Unit); never.receive() })
        try {
            retry.request("pc-a")
            assertEquals("pc-a", withTimeout(1_000) { calls.receive() })
            withTimeout(1_000) { waiting.receive() }
            retry.request("pc-b")
            assertEquals("pc-b", withTimeout(1_000) { calls.receive() })
            retry.cancel()
            assertFalse(calls.tryReceive().isSuccess)
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `server retry delay is respected and revocation stops retries`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = Channel<Unit>(Channel.UNLIMITED)
        val delays = Channel<Long>(Channel.UNLIMITED)
        val permits = Channel<Unit>(Channel.UNLIMITED)
        val stopped = CompletableDeferred<Unit>()
        var permitted = true
        val retry = TargetCapacityRetry(scope, eligible = {
            if (!permitted) stopped.complete(Unit)
            permitted
        }, attempt = { calls.send(Unit); false }, minimumDelayMs = { 25_000L },
            wait = { millis, _ -> delays.send(millis); permits.receive() })
        try {
            retry.request("pc-a")
            withTimeout(1_000) { calls.receive() }
            assertEquals(25_000L, withTimeout(1_000) { delays.receive() })
            permitted = false
            permits.send(Unit)
            withTimeout(1_000) { stopped.await() }
            assertFalse(calls.tryReceive().isSuccess)
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `network return wakes a pending backoff without starting a second job`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val calls = Channel<Int>(Channel.UNLIMITED)
        val waiting = Channel<Unit>(Channel.UNLIMITED)
        val count = AtomicInteger()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = {
            val current = count.incrementAndGet(); calls.send(current); current == 2
        }, wait = { _, wake -> waiting.send(Unit); wake.receive() })
        try {
            retry.request("pc-a")
            assertEquals(1, withTimeout(1_000) { calls.receive() })
            withTimeout(1_000) { waiting.receive() }
            retry.request("pc-a", expedite = true)
            assertEquals(2, withTimeout(1_000) { calls.receive() })
            assertEquals(2, count.get())
        } finally { retry.cancel(); scope.cancel() }
    }

    @Test fun `queued network return does not bypass a later rate limit`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val started = CompletableDeferred<Unit>()
        val finishAttempt = CompletableDeferred<Unit>()
        val waitObserved = CompletableDeferred<Pair<Long, Boolean>>()
        val floor = AtomicInteger()
        val retry = TargetCapacityRetry(scope, eligible = { true }, attempt = {
            started.complete(Unit); finishAttempt.await(); floor.set(25_000); false
        }, minimumDelayMs = { floor.get().toLong() }, wait = { millis, wake ->
            waitObserved.complete(millis to wake.tryReceive().isSuccess)
            CompletableDeferred<Unit>().await()
        })
        try {
            retry.request("pc-a")
            withTimeout(1_000) { started.await() }
            retry.request("pc-a", expedite = true)
            finishAttempt.complete(Unit)
            assertEquals(25_000L to false, withTimeout(1_000) { waitObserved.await() })
        } finally { retry.cancel(); scope.cancel() }
    }
}
