package com.andysagent.ragent.feature.workbench.accounts

import com.andysagent.ragent.core.domain.DiscoveredComputer
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class DemoConnectionViewModelTest {
    private val demo = "acct_demo_" + "a".repeat(48)
    private val computer = DiscoveredComputer("inst_demo", "Demo workspace", null)

    @Test fun automaticallyConnectsTheSoleDemoAndWaitsForProtectedReadiness() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val calls = mutableListOf<String>()
        val vm = DemoConnectionViewModel({ listOf(computer) }, { _, id -> calls += id }, { testScheduler.currentTime })
        try {
            vm.activate(demo); vm.activate(demo); runCurrent()
            assertEquals(listOf("inst_demo"), calls)
            assertFalse(vm.state.value.ready, "pairing persistence is not a protected probe")
            vm.connectionChanged("inst_other", RuntimeConnectionState.Connected)
            assertFalse(vm.state.value.ready)
            advanceTimeBy(1_700); runCurrent()
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            assertTrue(vm.state.value.ready)
            assertEquals(true, vm.state.value.readyWithinFiveSeconds)
            assertEquals(1_700, vm.state.value.elapsedMillis)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun aSlowConnectionStaysVisibleAndDoesNotInventFiveSecondSuccess() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val vm = DemoConnectionViewModel({ listOf(computer) }, { _, _ -> }, { testScheduler.currentTime })
        try {
            vm.activate(demo); runCurrent(); advanceTimeBy(5_100); runCurrent()
            assertTrue(vm.state.value.takingLonger)
            assertFalse(vm.state.value.ready)
            assertEquals(null, vm.state.value.readyWithinFiveSeconds)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            assertEquals(false, vm.state.value.readyWithinFiveSeconds)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun onlyDemoAutomaticallyChoosesTheServerOrderedDefaultFromMultipleInstances() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var discoveries = 0; var connections = 0
        val vm = DemoConnectionViewModel({ discoveries++; listOf(computer, computer.copy(instanceId = "inst_second")) },
            { _, _ -> connections++ }, { testScheduler.currentTime })
        try {
            vm.activate("acct_google_fixture"); runCurrent()
            assertFalse(vm.state.value.active); assertEquals(0, discoveries)
            vm.activate(demo); runCurrent()
            assertEquals(DemoConnectionPhase.Connecting, vm.state.value.phase)
            assertEquals("inst_demo", vm.state.value.targetId)
            assertEquals(1, connections)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun logoutCancelsDiscoveryWithoutConnectingOrRevivingTheGate() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val delayed = CompletableDeferred<List<DiscoveredComputer>>(); var connections = 0
        val vm = DemoConnectionViewModel({ delayed.await() }, { _, _ -> connections++ }, { testScheduler.currentTime })
        try {
            vm.activate(demo); runCurrent(); vm.deactivate()
            delayed.complete(listOf(computer)); runCurrent()
            assertEquals(0, connections); assertFalse(vm.state.value.active)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun anEstablishedConnectionAutomaticallyRecoversOnlyItsOriginalTarget() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val calls = mutableListOf<String>()
        val vm = DemoConnectionViewModel({ listOf(computer) }, { _, id -> calls += id }, { testScheduler.currentTime })
        try {
            vm.activate(demo); runCurrent(); vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Reconnecting)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Reconnecting); runCurrent()
            assertEquals(listOf("inst_demo", "inst_demo"), calls)
            assertEquals(DemoConnectionPhase.Reconnecting, vm.state.value.phase)
            assertFalse(vm.state.value.ready)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            assertTrue(vm.state.value.ready)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun explicitRetryRefreshesTheSameReconnectingTargetAndStillWaitsForAProtectedProbe() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val normal = mutableListOf<String>()
        val refreshes = mutableListOf<String>()
        val vm = DemoConnectionViewModel(
            discover = { listOf(computer, computer.copy(instanceId = "inst_second")) },
            connect = { _, id -> normal += id }, monotonicMillis = { testScheduler.currentTime },
            reconnect = { _, id -> refreshes += id },
        )
        try {
            vm.activate(demo); runCurrent()
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Reconnecting); runCurrent()
            assertEquals(listOf("inst_demo", "inst_demo"), normal)
            assertTrue(refreshes.isEmpty())
            vm.retry(); runCurrent()
            assertEquals(listOf("inst_demo"), refreshes)
            assertEquals(DemoConnectionPhase.Reconnecting, vm.state.value.phase)
            assertFalse(vm.state.value.ready)
            vm.connectionChanged("inst_demo", RuntimeConnectionState.Connected)
            assertTrue(vm.state.value.ready)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }

    @Test fun transientDiscoveryFailureRetriesWithoutAnotherPasswordLogin() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        var attempts = 0; var connects = 0
        val vm = DemoConnectionViewModel({ if (++attempts == 1) error("network unavailable") else listOf(computer) },
            { _, _ -> connects++ }, { testScheduler.currentTime })
        try {
            vm.activate(demo); runCurrent()
            assertEquals(DemoConnectionPhase.Unavailable, vm.state.value.phase)
            advanceTimeBy(1_000); runCurrent()
            assertEquals(2, attempts); assertEquals(1, connects)
            assertEquals(DemoConnectionPhase.Connecting, vm.state.value.phase)
        } finally { vm.deactivate(); Dispatchers.resetMain() }
    }
}
