package com.andysagent.ragent.core.network

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(ExperimentalCoroutinesApi::class)
class OfflineStartupRecoveryTest {
    @Test fun `network becoming available after offline startup wakes bootstrap immediately`() = runTest {
        val monitor = FakeNetworkMonitor(initialOnline = false)
        var recoveryCalls = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, monitor, this,
            bootstrapPending = { true }, onRecoveryRequired = { recoveryCalls++ })
        try {
            supervisor.start(); runCurrent()
            assertEquals(0, recoveryCalls)
            monitor.setOnline(true); runCurrent()
            assertEquals(1, recoveryCalls, "Restored connectivity must not wait for bootstrap retry backoff")
            monitor.setOnline(true); runCurrent()
            assertEquals(1, recoveryCalls, "Duplicate availability must not restart the in-flight recovery")
        } finally { supervisor.stop() }
    }

    @Test fun `initial online availability does not restart bootstrap`() = runTest {
        val monitor = FakeNetworkMonitor(initialOnline = true)
        var recoveryCalls = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, monitor, this,
            bootstrapPending = { true }, onRecoveryRequired = { recoveryCalls++ })
        try {
            supervisor.start(); monitor.setOnline(true); runCurrent()
            assertEquals(0, recoveryCalls)
        } finally { supervisor.stop() }
    }

    @Test fun `two offline targets each wake once when network returns`() = runTest {
        val firstMonitor = FakeNetworkMonitor(false)
        val secondMonitor = FakeNetworkMonitor(false)
        val recoveries = mutableListOf<String>()
        val first = ConnectivitySupervisor({ "" }, { "rda_one" }, firstMonitor, this,
            onRecoveryRequired = { recoveries += "one" })
        val second = ConnectivitySupervisor({ "" }, { "rda_two" }, secondMonitor, this,
            onRecoveryRequired = { recoveries += "two" })
        try {
            first.start(); second.start(); runCurrent()
            firstMonitor.setOnline(true); secondMonitor.setOnline(true); runCurrent()
            assertEquals(listOf("one", "two"), recoveries)
        } finally { first.stop(); second.stop() }
    }
}
