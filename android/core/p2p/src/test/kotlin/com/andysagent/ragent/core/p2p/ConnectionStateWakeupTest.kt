package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class ConnectionStateWakeupTest {
    @Test fun terminalFailureCannotBeMistakenForAnOpenChannel() {
        assertFailsWith<IllegalStateException> { connectionChannelReady("ICE connection entered FAILED", false, true) }
        assertFailsWith<IllegalStateException> { connectionChannelReady(null, true, true) }
        assertFalse(connectionChannelReady(null, false, false))
        kotlin.test.assertTrue(connectionChannelReady(null, false, true))
    }

    @Test fun stateCallbackWakesAWaitingConnectionImmediately() = runBlocking {
        val wakeup = ConnectionStateWakeup()
        var ready = false
        val waiting = async(start = CoroutineStart.UNDISPATCHED) { wakeup.await(2_000) { ready } }
        assertFalse(waiting.isCompleted)
        ready = true
        wakeup.signal()
        withTimeout(200) { waiting.await() }
    }

    @Test fun callbackBetweenStateCheckAndWaitIsNotLost() = runBlocking {
        val wakeup = ConnectionStateWakeup()
        var checks = 0
        wakeup.await(1_000) {
            checks++
            if (checks == 1) wakeup.signal()
            checks > 1
        }
        assertEquals(2, checks)
    }

    @Test fun timeoutAndStateFailureRemainObservable() = runBlocking {
        val wakeup = ConnectionStateWakeup()
        assertFailsWith<TimeoutCancellationException> { wakeup.await(30) { false } }
        assertFailsWith<IllegalStateException> { wakeup.await(1_000) { error("closed") } }
        Unit
    }
}
