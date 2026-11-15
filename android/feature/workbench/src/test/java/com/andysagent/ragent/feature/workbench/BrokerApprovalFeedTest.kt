package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class BrokerApprovalFeedTest {
    private fun approval(target: String) = Approval(
        id = "same-request",
        sessionId = "session-1",
        title = "Restart QA service",
        expiresAt = Instant.now().plusSeconds(120).toString(),
        brokerTargetInstanceId = target,
    )

    @Test
    fun `carrier reconciliation refreshes an eligible target every five seconds`() = runTest {
        var eligible = true
        var interval = 5_000L
        var signals = 0
        backgroundScope.launch {
            brokerApprovalReconciliationSignals({ interval }, { eligible }).collect { signals++ }
        }
        runCurrent()
        advanceTimeBy(4_999)
        runCurrent()
        assertEquals(0, signals)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(1, signals)

        eligible = false
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(1, signals)

        eligible = true
        interval = 15_000L
        advanceTimeBy(5_000)
        runCurrent()
        assertEquals(2, signals)
        advanceTimeBy(14_999)
        runCurrent()
        assertEquals(2, signals)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(3, signals)
    }

    @Test
    fun `rate limit waits the complete retry period and stays target scoped`() = runTest {
        val gate = BrokerApprovalRetryGate(
            elapsedMs = { testScheduler.currentTime },
            sleepMs = { delay(it) },
        )
        gate.defer("computer-a", 12_000L)
        val waiting = async { gate.await("computer-a") }
        runCurrent()
        gate.await("computer-b")
        advanceTimeBy(5_000)
        runCurrent()
        gate.defer("computer-a", 10_000L)
        advanceTimeBy(6_999)
        runCurrent()
        assertTrue(!waiting.isCompleted)
        advanceTimeBy(3_001)
        runCurrent()
        assertTrue(waiting.isCompleted)
        assertEquals(15_000L, testScheduler.currentTime)
    }

    @Test
    fun `invalidation during a rate limit cannot trigger an early pending retry`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val invalidations = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val gate = BrokerApprovalRetryGate({ testScheduler.currentTime }, { delay(it) })
        var reads = 0
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(
                targetIds = target,
                refreshSignals = { invalidations },
                fetch = { id ->
                    gate.await(id)
                    reads++
                    if (reads == 1) throw ApiException(429, "RATE_LIMITED", "wait", retryAfterMs = 9_000)
                    listOf(approval(id))
                },
                onFailure = { id, error ->
                    if (error is ApiException && error.statusCode == 429) gate.defer(id, error.retryAfterMs ?: 30_000)
                },
            ).collect { snapshots += it }
        }
        runCurrent()
        assertEquals(1, reads)
        invalidations.tryEmit(Unit)
        runCurrent()
        advanceTimeBy(8_999)
        runCurrent()
        assertEquals(1, reads)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(2, reads)
        assertEquals("computer-a", snapshots.last().single().brokerTargetInstanceId)
    }

    @Test
    fun `new pending request arrives on an invalidation without recreating the collector`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val invalidations = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        var pending = emptyList<Approval>()
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(target, { invalidations }, { pending }).collect { snapshots += it }
        }
        runCurrent()
        assertTrue(snapshots.last().isEmpty())

        pending = listOf(approval("computer-a"))
        invalidations.tryEmit(Unit)
        runCurrent()
        assertEquals("computer-a", snapshots.last().single().brokerTargetInstanceId)
    }

    @Test
    fun `refresh ticks do not cancel a slow signed pending read`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val ticks = MutableSharedFlow<Unit>(extraBufferCapacity = 4)
        val gate = CompletableDeferred<Unit>()
        var reads = 0
        var firstReadCompleted = false
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(target, { ticks }, fetch = {
                reads++
                if (reads == 1) {
                    gate.await()
                    firstReadCompleted = true
                }
                listOf(approval(it))
            }).collect { snapshots += it }
        }
        runCurrent()
        assertEquals(1, reads)
        ticks.tryEmit(Unit)
        ticks.tryEmit(Unit)
        runCurrent()
        assertEquals(1, reads)
        gate.complete(Unit)
        runCurrent()
        assertTrue(firstReadCompleted)
        assertTrue(reads >= 2)
        assertEquals("computer-a", snapshots.last().single().brokerTargetInstanceId)
    }

    @Test
    fun `target switch clears the old card before the new read completes`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val gate = CompletableDeferred<Unit>()
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(target, { MutableSharedFlow<Unit>() }, fetch = { id ->
                if (id == "computer-b") gate.await()
                listOf(approval(id))
            }).collect { snapshots += it }
        }
        runCurrent()
        assertEquals("computer-a", snapshots.last().single().brokerTargetInstanceId)

        target.value = "computer-b"
        runCurrent()
        assertTrue(snapshots.last().isEmpty())
        gate.complete(Unit)
        runCurrent()
        assertEquals("computer-b", snapshots.last().single().brokerTargetInstanceId)
        assertTrue(snapshots.last().none { it.brokerTargetInstanceId == "computer-a" })
    }

    @Test
    fun `target switch cancels an in-flight read for the old computer`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val blocked = CompletableDeferred<Unit>()
        var canceledOldRead = false
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(target, { MutableSharedFlow<Unit>() }, fetch = { id ->
                if (id == "computer-a") {
                    try { blocked.await() }
                    catch (cancelled: CancellationException) {
                        canceledOldRead = true
                        throw cancelled
                    }
                }
                listOf(approval(id))
            }).collect { snapshots += it }
        }
        runCurrent()
        target.value = "computer-b"
        runCurrent()
        assertTrue(canceledOldRead)
        assertEquals("computer-b", snapshots.last().single().brokerTargetInstanceId)
    }

    @Test
    fun `failed refresh retains only an unexpired prior card`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val invalidations = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        var fail = false
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(target, { invalidations }, fetch = {
                if (fail) error("offline")
                listOf(
                    approval("computer-a"),
                    approval("computer-a").copy(id = "expired", expiresAt = Instant.now().minusSeconds(1).toString()),
                )
            }).collect { snapshots += it }
        }
        runCurrent()
        fail = true
        invalidations.tryEmit(Unit)
        runCurrent()
        assertEquals("computer-a", snapshots.last().single().brokerTargetInstanceId)
        assertEquals("same-request", snapshots.last().single().id)
    }

    @Test
    fun `an authorization failure clears a previously visible card`() = runTest {
        val target = MutableStateFlow<String?>("computer-a")
        val invalidations = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        var revoked = false
        val snapshots = mutableListOf<List<Approval>>()
        backgroundScope.launch {
            observeBrokerApprovalFeed(
                targetIds = target,
                refreshSignals = { invalidations },
                fetch = {
                    if (revoked) throw SecurityException("revoked")
                    listOf(approval("computer-a"))
                },
                retainOnFailure = { it !is SecurityException },
            ).collect { snapshots += it }
        }
        runCurrent()
        assertEquals(1, snapshots.last().size)
        revoked = true
        invalidations.tryEmit(Unit)
        runCurrent()
        assertTrue(snapshots.last().isEmpty())
    }
}
