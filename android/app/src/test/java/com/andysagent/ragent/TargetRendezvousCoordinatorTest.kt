package com.andysagent.ragent

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class TargetRendezvousCoordinatorTest {
    @Test fun unrelatedTargetCanRecoverWhileTheFirstTargetIsWaiting() = runBlocking {
        val coordinator = TargetRendezvousCoordinator()
        val release = CompletableDeferred<Unit>()
        val first = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("pc-a") { release.await() } }
        var sameTargetEntered = false
        val queued = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("pc-a") { sameTargetEntered = true } }
        assertFalse(sameTargetEntered)
        try {
            assertEquals("pc-b", withTimeout(5_000) { coordinator.withTarget("pc-b") { "pc-b" } })
            assertFalse(sameTargetEntered)
        } finally { release.complete(Unit); first.join(); queued.join() }
        assertTrue(sameTargetEntered)
    }

    @Test fun atMostTwoDifferentTargetsSpendNetworkWorkConcurrently() = runBlocking {
        val coordinator = TargetRendezvousCoordinator()
        val releaseA = CompletableDeferred<Unit>(); val releaseB = CompletableDeferred<Unit>()
        val a = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("a") { releaseA.await() } }
        val b = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("b") { releaseB.await() } }
        var entered = false
        val c = async(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("c") { entered = true } }
        assertFalse(entered)
        try { releaseA.complete(Unit); withTimeout(5_000) { c.await() }; assertTrue(entered) }
        finally { releaseA.complete(Unit); releaseB.complete(Unit); a.join(); b.join(); c.cancelAndJoin() }
    }

    @Test fun cancellationOfQueuedAndActiveJoinsDoesNotStrandTheKeyOrPermit() = runBlocking {
        val coordinator = TargetRendezvousCoordinator(1)
        val hold = CompletableDeferred<Unit>()
        val active = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("a") { hold.await() } }
        val same = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("a") { error("Cancelled waiter ran") } }
        val other = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.withTarget("b") { error("Cancelled permit waiter ran") } }
        same.cancelAndJoin(); other.cancelAndJoin(); active.cancelAndJoin()
        assertEquals("a", withTimeout(5_000) { coordinator.withTarget("a") { "a" } })
        assertEquals("b", withTimeout(5_000) { coordinator.withTarget("b") { "b" } })
    }

    @Test fun failedJoinDoesNotPreventTheNextAttempt() = runBlocking {
        val coordinator = TargetRendezvousCoordinator(1)
        val failure = runCatching { coordinator.withTarget("a") { error("fixture failure") } }.exceptionOrNull()
        assertEquals("fixture failure", failure?.message)
        assertEquals(7, withTimeout(5_000) { coordinator.withTarget("a") { 7 } })
    }
}
