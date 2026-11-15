package com.andysagent.ragent

import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.junit.Assert.*
import org.junit.Test

class TargetPairingCommitsTest {
    @Test fun initiatingOperationRetainsItsRuntimeIdentityInsideNonCancellableCleanup() = runBlocking {
        val root = SupervisorJob(); val scope = CoroutineScope(root + Dispatchers.Unconfined)
        val commits = TargetPairingCommits(Mutex())
        try {
            scope.async { commits.withTarget("a") {
                withContext(NonCancellable) {
                    val initiator = commits.initiatingJob()
                    assertTrue(isWithinJobTree(root, initiator))
                    assertFalse(isWithinJobTree(Job(), initiator))
                }
            } }.await()
        } finally { root.cancelAndJoin() }
    }

    @Test fun logoutInsideAJoinCompletesAuthorityRemovalBeforeRejectingItsOwnLateWrite() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); var cleared = false; var wrote = false
        val error = runCatching { commits.withTarget("old") { guard ->
            commits.switchAccount { yield(); cleared = true }
            guard.persist("old") { wrote = true }
        } }.exceptionOrNull()
        assertTrue(error is CancellationException); assertTrue(cleared); assertFalse(wrote)
        assertEquals(3, commits.withTarget("new") { 3 })
    }

    @Test fun initialAccountQrPreservesOnlyItsOwnAuthorizedPairingGeneration() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val reply = CompletableDeferred<Unit>(); var oldWrote = false; var newWrote = false
        val old = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("old") { guard ->
            withContext(NonCancellable) { reply.await(); guard.persist("old") { oldWrote = true } }
        } }
        commits.withTarget("new") { guard ->
            coroutineScope { commits.switchAccount(preserveCaller = true) { } }
            guard.persist("new") { newWrote = true }
        }
        reply.complete(Unit)
        assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
        assertFalse(oldWrote); assertTrue(newWrote)
    }

    @Test fun noPairingCanEnterWhileAccountStorageIsBeingReplaced() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val entered = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        val change = launch(start = CoroutineStart.UNDISPATCHED) {
            commits.switchAccount { entered.complete(Unit); finish.await() }
        }
        entered.await()
        assertTrue(runCatching { commits.withTarget("a") { error("must not enter") } }.exceptionOrNull() is CancellationException)
        finish.complete(Unit); change.join()
        assertEquals(2, commits.withTarget("a") { 2 })
    }

    @Test fun accountSwitchFencesEveryOldTargetWithoutClosingNewAccountPairing() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val reply = CompletableDeferred<Unit>()
        val writes = mutableListOf<String>()
        val old = listOf("a", "b").map { id ->
            async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget(id) { guard ->
                withContext(NonCancellable) { reply.await(); guard.persist(id) { writes += "old-$id" } }
            } }
        }
        commits.switchAccount { writes += "switched" }
        commits.withTarget("a") { guard -> guard.persist("a") { writes += "new-a" } }
        reply.complete(Unit)
        old.forEach { assertTrue(runCatching { it.await() }.exceptionOrNull() is CancellationException) }
        assertEquals(listOf("switched", "new-a"), writes)
        assertTrue(commits.pendingTargetIds().isEmpty())
    }

    @Test fun failedAccountSwitchStillInvalidatesLateOldPairingReplies() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val reply = CompletableDeferred<Unit>()
        var wrote = false
        val old = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard ->
            withContext(NonCancellable) { reply.await(); guard.persist("a") { wrote = true } }
        } }
        assertTrue(runCatching { commits.switchAccount { error("local storage failed") } }.isFailure)
        reply.complete(Unit)
        assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
        assertFalse(wrote)
        assertEquals(1, commits.withTarget("a") { 1 })
    }

    @Test fun removedGenerationCannotOverwriteAnExplicitFreshPairing() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val requested = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        var credential: String? = null
        val old = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard ->
            // Model a platform callback which arrives despite cancellation.
            withContext(NonCancellable) {
                requested.complete(Unit); reply.await(); guard.persist("a") { credential = "old" }
            }
        } }
        requested.await()
        commits.remove("a") { credential = null }
        commits.withTarget("a") { guard -> guard.persist("a") { credential = "fresh" } }
        reply.complete(Unit)
        assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
        assertEquals("fresh", credential)
        assertFalse(commits.hasPending("a"))
    }

    @Test fun removalInvalidatesAJoinAlreadyQueuedBehindTheSameTarget() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); val network = TargetRendezvousCoordinator()
        val release = CompletableDeferred<Unit>()
        val writes = mutableListOf<String>()
        val active = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard ->
            network.withTarget("a") { release.await(); guard.persist("a") { writes += "active" } }
        } }
        val queued = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard ->
            network.withTarget("a") { guard.persist("a") { writes += "queued" } }
        } }
        commits.remove("a") { writes.clear() }; release.complete(Unit)
        assertTrue(runCatching { active.await() }.exceptionOrNull() is CancellationException)
        assertTrue(runCatching { queued.await() }.exceptionOrNull() is CancellationException)
        assertTrue(writes.isEmpty())
        assertEquals(7, commits.withTarget("a") { 7 })
    }

    @Test fun localCommitAndRemovalAreOrderedWithoutHoldingTheNetworkLock() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var paired = false; var removed = false
        val writer = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard ->
            guard.persist("a") { entered.complete(Unit); release.await(); paired = true }
        } }
        entered.await()
        val removal = launch(start = CoroutineStart.UNDISPATCHED) { commits.remove("a") { paired = false; removed = true } }
        assertFalse(removed)
        // Registration/network work for another target does not take this lock.
        val otherEntered = CompletableDeferred<Unit>()
        val other = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("b") { otherEntered.complete(Unit) } }
        assertTrue(otherEntered.isCompleted)
        release.complete(Unit); removal.join(); runCatching { writer.await() }; other.await()
        assertTrue(removed); assertFalse(paired)
    }

    @Test fun cancellationCleanupCanJoinWhileConfigurationLockIsHeld() = runBlocking {
        val mutex = Mutex(); val commits = TargetPairingCommits(mutex)
        val started = CompletableDeferred<Unit>()
        mutex.withLock {
            // Its action has returned; only the final generation check is
            // queued on the configuration lock held by target teardown.
            val worker = launch(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { started.complete(Unit) } }
            started.await()
            withTimeout(5_000) { worker.cancelAndJoin() }
        }
        assertFalse(commits.hasPending("a"))
    }

    @Test fun guardRejectsAResponseForAnotherTargetBeforeWriting() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); var wrote = false
        val error = runCatching { commits.withTarget("a") { guard -> guard.persist("b") { wrote = true } } }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException); assertFalse(wrote)
        commits.withTarget("b") { guard -> guard.persist("b") { wrote = true } }
        assertTrue(wrote)
    }

    @Test fun closingInvalidatesOutstandingAndFutureOperationsButRemovalIsTargetScoped() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); val release = CompletableDeferred<Unit>()
        val a = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("a") { guard -> release.await(); guard.persist("a") { error("stale write") } } }
        commits.remove("a") { }
        assertEquals(3, commits.withTarget("b") { 3 })
        commits.close(); release.complete(Unit)
        assertTrue(runCatching { a.await() }.exceptionOrNull() is CancellationException)
        assertTrue(runCatching { commits.withTarget("a") { error("closed") } }.exceptionOrNull() is CancellationException)
    }

    @Test fun removalCancelsAQueuedBackgroundTapBeforeItCanStartCapacityOrJoin() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); val backgroundQueue = Mutex()
        var capacityRequested = false; var joined = false
        val queued: Deferred<Unit>
        backgroundQueue.withLock {
            queued = async(start = CoroutineStart.UNDISPATCHED) {
                commits.withTarget("a") { guard ->
                    backgroundQueue.withLock {
                        capacityRequested = true
                        guard.persist("a") { joined = true }
                    }
                }
            }
            assertTrue(commits.hasPending("a"))
            commits.remove("a") { }
            withTimeout(5_000) { queued.join() }
            assertTrue(queued.isCancelled)
        }
        assertFalse(capacityRequested); assertFalse(joined)
    }

    @Test fun cancellationDuringCapacityReleasesBackgroundQueueForAnotherComputer() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); val backgroundQueue = Mutex()
        val capacityStarted = CompletableDeferred<Unit>(); val capacityCancelled = CompletableDeferred<Unit>()
        val old = async(start = CoroutineStart.UNDISPATCHED) {
            commits.withTarget("a") { guard ->
                backgroundQueue.withLock {
                    try { capacityStarted.complete(Unit); awaitCancellation() }
                    finally { capacityCancelled.complete(Unit) }
                    @Suppress("UNREACHABLE_CODE")
                    guard.persist("a") { error("removed computer rejoined") }
                }
            }
        }
        capacityStarted.await()
        val other = async(start = CoroutineStart.UNDISPATCHED) {
            commits.withTarget("b") { guard -> backgroundQueue.withLock { guard.persist("b") { }; 42 } }
        }
        commits.remove("a") { }
        assertEquals(42, withTimeout(5_000) { other.await() })
        capacityCancelled.await()
        assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
        assertTrue(currentCoroutineContext().isActive)
    }

    @Test fun removalFreesRendezvousPermitWithoutWaitingForTheRemoteTimeout() = runBlocking {
        val commits = TargetPairingCommits(Mutex()); val network = TargetRendezvousCoordinator(maximumInFlight = 1)
        val started = CompletableDeferred<Unit>(); val stopped = CompletableDeferred<Unit>()
        val old = async(start = CoroutineStart.UNDISPATCHED) {
            commits.withTarget("a") { network.withTarget("a") {
                try { started.complete(Unit); awaitCancellation() }
                finally { stopped.complete(Unit) }
            } }
        }
        started.await()
        val other = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("b") { network.withTarget("b") { 7 } } }
        commits.remove("a") { }
        assertEquals(7, withTimeout(5_000) { other.await() })
        stopped.await()
        assertTrue(runCatching { old.await() }.exceptionOrNull() is CancellationException)
    }

    @Test fun removalCancelsOnlyTheOperationChildAndClosingCancelsOtherTargets() = runBlocking {
        val commits = TargetPairingCommits(Mutex())
        val removalDone = CompletableDeferred<Unit>()
        val caller = launch(start = CoroutineStart.UNDISPATCHED) {
            assertTrue(runCatching { commits.withTarget("a") { awaitCancellation() } }.exceptionOrNull() is CancellationException)
            assertTrue(currentCoroutineContext().isActive)
            removalDone.complete(Unit)
        }
        val other = async(start = CoroutineStart.UNDISPATCHED) { commits.withTarget("b") { awaitCancellation() } }
        commits.remove("a") { }
        withTimeout(5_000) { removalDone.await(); caller.join() }
        assertFalse(other.isCancelled)
        commits.close()
        withTimeout(5_000) { other.join() }
        assertTrue(other.isCancelled)
    }
}
