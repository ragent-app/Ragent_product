package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class TargetConnectionLeasesTest {
    private class Resource : TargetConnectionResource {
        var starts = 0
        var stops = 0
        var stopBarrier: CompletableDeferred<Unit>? = null
        override fun start() { starts++ }
        override suspend fun stop() { stops++; stopBarrier?.await() }
    }

    @Test fun joiningTargetSurvivesReaderTimeoutUntilUiTakesOwnership() = runTest {
        val resources = mutableMapOf<String, Resource>()
        val pool = TargetConnectionLeases { id: String -> Resource().also { resources[id] = it } }
        pool.setOwnerTargets("ui", setOf("primary"))
        val join = pool.acquire("background")
        val read = async {
            withTimeoutOrNull(30_000) { pool.withTarget("background") { delay(60_000) } }
        }
        runCurrent()
        advanceTimeBy(30_001)
        runCurrent()
        assertNull(read.await())
        assertEquals(1, join.resource.starts)
        assertEquals(0, join.resource.stops, "A temporary read must not cancel the join")
        assertEquals(0, resources.getValue("primary").stops)
        pool.setOwnerTargets("ui", setOf("primary", "background"))
        join.close()
        assertEquals(0, join.resource.stops, "The UI owns the completed join")
        pool.setOwnerTargets("ui", emptySet())
        assertEquals(1, join.resource.stops)
    }

    @Test fun callsShareOneStartAndUiStopCannotReleaseTheirConnection() = runTest {
        val resources = mutableListOf<Resource>()
        val pool = TargetConnectionLeases { _: String -> Resource().also { resources += it } }
        pool.setOwnerTargets("ui", setOf("a"))
        val first = pool.acquire("a"); val second = pool.acquire("a")
        pool.setOwnerTargets("ui", setOf("b"))
        assertEquals(2, resources.size); assertEquals(1, first.resource.starts)
        assertEquals(0, first.resource.stops)
        pool.setOwnerTargets("ui", emptySet())
        assertEquals(1, resources[1].stops)
        first.close(); first.close(); assertEquals(0, first.resource.stops)
        second.close(); assertEquals(1, first.resource.stops)
    }

    @Test fun cancellationReleasesHeadlessUse() = runTest {
        val resource = Resource(); val pool = TargetConnectionLeases { _: String -> resource }
        val started = CompletableDeferred<Unit>()
        val job = launch { pool.withTarget("a") { started.complete(Unit); CompletableDeferred<Unit>().await() } }
        started.await(); job.cancelAndJoin()
        assertEquals(1, resource.starts); assertEquals(1, resource.stops)
    }

    @Test fun revokeDoesNotAllowOldLeaseToStopNewGeneration() = runTest {
        val pool = TargetConnectionLeases { _: String -> Resource() }
        val old = pool.acquire("a"); pool.revoke("a")
        val replacement = pool.acquire("a")
        old.close(); assertEquals(0, replacement.resource.stops)
        replacement.close(); assertEquals(1, replacement.resource.stops)
        assertEquals(1, old.resource.stops)
    }

    @Test fun reacquisitionWaitsUntilPreviousTeardownFinishes() = runTest {
        val pool = TargetConnectionLeases { _: String -> Resource() }
        val old = pool.acquire("a"); old.resource.stopBarrier = CompletableDeferred()
        val closing = launch { old.close() }; runCurrent()
        val opening = async { pool.acquire("a") }; runCurrent()
        assertFalse(opening.isCompleted)
        old.resource.stopBarrier!!.complete(Unit); closing.join()
        val next = opening.await(); assertNotSame(old.resource, next.resource); next.close()
    }

    @Test fun stoppingOneTargetDoesNotBlockAnExistingUnrelatedTarget() = runTest {
        val pool = TargetConnectionLeases { _: String -> Resource() }
        val active = pool.acquire("active")
        val background = pool.acquire("background")
        background.resource.stopBarrier = CompletableDeferred()
        val closing = launch { background.close() }; runCurrent()
        val unrelated = async { pool.acquire("active") }; runCurrent()
        try {
            assertTrue(unrelated.isCompleted, "The active target must remain usable during background teardown")
            unrelated.await().close()
        } finally {
            background.resource.stopBarrier!!.complete(Unit)
            closing.join()
            unrelated.await().close()
            active.close()
        }
    }

    @Test fun ownerRemovalDoesNotBlockAnUnrelatedTarget() = runTest {
        val resources = mutableMapOf<String, Resource>()
        val pool = TargetConnectionLeases { id: String -> Resource().also { resources[id] = it } }
        pool.setOwnerTargets("ui", setOf("active", "background"))
        val background = resources.getValue("background")
        background.stopBarrier = CompletableDeferred()
        val removing = launch { pool.setOwnerTargets("ui", setOf("active")) }; runCurrent()
        val unrelated = async { pool.acquire("active") }; runCurrent()
        try { assertTrue(unrelated.isCompleted) }
        finally {
            background.stopBarrier!!.complete(Unit)
            removing.join()
            unrelated.await().close()
            pool.setOwnerTargets("ui", emptySet())
        }
    }

    @Test fun revokeWaitsForAlreadyRunningTeardown() = runTest {
        val pool = TargetConnectionLeases { _: String -> Resource() }
        val lease = pool.acquire("a")
        lease.resource.stopBarrier = CompletableDeferred()
        val closing = launch { lease.close() }; runCurrent()
        val revoking = launch { pool.revoke("a") }; runCurrent()
        assertFalse(revoking.isCompleted)
        lease.resource.stopBarrier!!.complete(Unit)
        closing.join(); revoking.join()
    }

    @Test fun failedTeardownReleasesTargetBarrier() = runTest {
        var fail = true
        val pool = TargetConnectionLeases { _: String -> object : TargetConnectionResource {
            override fun start() = Unit
            override suspend fun stop() { if (fail) error("Teardown failed") }
        } }
        val old = pool.acquire("a")
        assertFailsWith<IllegalStateException> { old.close() }
        fail = false
        val replacement = pool.acquire("a")
        replacement.close()
    }

    @Test fun independentOwnerSetsDoNotRestartSharedTarget() = runTest {
        val resource = Resource(); val pool = TargetConnectionLeases { _: String -> resource }
        pool.setOwnerTargets("ui", setOf("a")); pool.setOwnerTargets("ui", setOf("a"))
        pool.setOwnerTargets("worker", setOf("a")); pool.setOwnerTargets("ui", emptySet())
        assertEquals(1, resource.starts); assertEquals(0, resource.stops)
        pool.setOwnerTargets("worker", emptySet()); assertEquals(1, resource.stops)
    }

    @Test fun failedOwnerReplacementRollsBackNewConnectionsAndRetainsOldSet() = runTest {
        val resources = mutableMapOf<String, Resource>()
        val pool = TargetConnectionLeases { id: String ->
            if (id == "failed") error("Cannot initialize target")
            Resource().also { resources[id] = it }
        }
        pool.setOwnerTargets("ui", setOf("old"))
        assertFailsWith<IllegalStateException> { pool.setOwnerTargets("ui", linkedSetOf("new", "failed")) }
        assertEquals(1, resources.getValue("new").stops)
        assertEquals(0, resources.getValue("old").stops)
        pool.setOwnerTargets("ui", emptySet()); assertEquals(1, resources.getValue("old").stops)
    }

    @Test fun failedStartCleansUpAndDoesNotPoisonSubsequentAcquisition() = runTest {
        var cleanup = 0; var fail = true
        val pool = TargetConnectionLeases { _: String -> object : TargetConnectionResource {
            override fun start() { if (fail) error("Bootstrap scheduling failed") }
            override suspend fun stop() { cleanup++ }
        } }
        assertFailsWith<IllegalStateException> { pool.acquire("a") }
        assertEquals(1, cleanup)
        fail = false; val next = pool.acquire("a"); next.close()
        assertEquals(2, cleanup)
    }
}
