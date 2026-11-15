package com.andysagent.ragent

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test

class AccountRendezvousSingleFlightTest {
    @Test fun overlappingJoinsShareOnlyTheirInFlightResult() = runBlocking {
        val flights = AccountRendezvousSingleFlight<Int>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        val first = async(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { calls++; release.await(); 17 }
        }
        val second = async(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { calls++; 18 }
        }
        assertEquals(1, calls)
        release.complete(Unit)
        assertEquals(17, first.await())
        assertEquals(17, second.await())
        assertEquals(19, flights.run("pc", "phone") { calls++; 19 })
        assertEquals(2, calls)
    }

    @Test fun cancelledLeaderAllowsAWaitingCallerToRetry() = runBlocking {
        val flights = AccountRendezvousSingleFlight<Int>()
        val leader = launch(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { CompletableDeferred<Unit>().await(); 1 }
        }
        val follower = async(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { 2 }
        }
        leader.cancelAndJoin()
        assertEquals(2, withTimeout(5_000) { follower.await() })
    }

    @Test fun cancellingAWaiterDoesNotCancelTheSharedJoin() = runBlocking {
        val flights = AccountRendezvousSingleFlight<Int>()
        val release = CompletableDeferred<Unit>()
        val leader = async(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { release.await(); 1 }
        }
        val waiter = launch(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc", "phone") { error("A waiting join must not run") }
        }
        waiter.cancelAndJoin()
        release.complete(Unit)
        assertEquals(1, leader.await())
    }

    @Test fun aFailedJoinReachesWaitersAndDoesNotPoisonLaterAttempts() = runBlocking {
        val flights = AccountRendezvousSingleFlight<Int>()
        val release = CompletableDeferred<Unit>()
        val leader = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { flights.run("pc", "phone") { release.await(); error("join failed") } }
        }
        val waiter = async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { flights.run("pc", "phone") { 2 } }
        }
        release.complete(Unit)
        assertEquals("join failed", leader.await().exceptionOrNull()?.message)
        assertEquals("join failed", waiter.await().exceptionOrNull()?.message)
        assertEquals(3, flights.run("pc", "phone") { 3 })
    }

    @Test fun differentTargetsAndDeviceNamesRemainIndependent() = runBlocking {
        val flights = AccountRendezvousSingleFlight<Int>()
        val release = CompletableDeferred<Unit>()
        val first = async(start = CoroutineStart.UNDISPATCHED) {
            flights.run("pc-a", "phone-a") { release.await(); 1 }
        }
        assertEquals(2, flights.run("pc-b", "phone-a") { 2 })
        assertEquals(3, flights.run("pc-a", "phone-b") { 3 })
        release.complete(Unit)
        assertEquals(1, first.await())
    }
}
