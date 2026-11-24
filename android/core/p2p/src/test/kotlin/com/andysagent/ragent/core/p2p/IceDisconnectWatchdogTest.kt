package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class IceDisconnectWatchdogTest {
    @Test fun `channel opening after ice disconnect starts bounded recovery`() = runTest {
        var failures = 0
        val watchdog = IceDisconnectWatchdog(this) { failures++ }
        watchdog.channelOpened(iceDisconnected = true)
        runCurrent()
        advanceTimeBy(2_501)
        runCurrent()
        assertEquals(1, failures)
    }

    @Test fun `channel opening after ice recovery does not schedule failure`() = runTest {
        var failures = 0
        val watchdog = IceDisconnectWatchdog(this) { failures++ }
        watchdog.channelOpened(iceDisconnected = false)
        advanceTimeBy(2_501)
        runCurrent()
        assertEquals(0, failures)
    }

    @Test fun `temporary loss preserves the carrier`() = runTest {
        var failures = 0
        val watchdog = IceDisconnectWatchdog(this) { failures++ }
        watchdog.disconnected()
        runCurrent()
        advanceTimeBy(1_500)
        runCurrent()
        assertEquals(0, failures, "A brief outage must not destroy the carrier")
        watchdog.recovered()
        advanceTimeBy(1_500)
        runCurrent()
        assertEquals(0, failures)
    }

    @Test fun `persistent loss triggers one recovery even with repeated notifications`() = runTest {
        var failures = 0
        val watchdog = IceDisconnectWatchdog(this) { failures++ }
        watchdog.disconnected()
        runCurrent()
        advanceTimeBy(1_000)
        watchdog.disconnected()
        advanceTimeBy(1_501)
        runCurrent()
        assertEquals(1, failures)
    }

    @Test fun `recovery followed by a new loss starts a fresh grace period`() = runTest {
        var failures = 0
        val watchdog = IceDisconnectWatchdog(this) { failures++ }
        watchdog.disconnected()
        runCurrent()
        advanceTimeBy(1_500)
        watchdog.recovered()
        watchdog.disconnected()
        runCurrent()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(0, failures)
        advanceTimeBy(1_501)
        runCurrent()
        assertEquals(1, failures)
    }

    @Test fun `entering disconnected triggers immediate probe callback once per episode`() = runTest {
        var probes = 0
        var failures = 0
        val watchdog = IceDisconnectWatchdog(
            scope = this,
            onDisconnectStarted = { probes++ },
            onPersistentDisconnect = { failures++ },
        )
        watchdog.disconnected()
        watchdog.disconnected()
        assertEquals(1, probes)
        assertEquals(0, failures)
        watchdog.recovered()
        watchdog.disconnected()
        assertEquals(2, probes)
        advanceTimeBy(2_501)
        runCurrent()
        assertEquals(1, failures)
    }
}
