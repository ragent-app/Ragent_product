package com.andysagent.ragent

import com.andysagent.ragent.core.network.BootstrapConnectionPlan
import com.andysagent.ragent.core.network.ConnectionState
import com.andysagent.ragent.core.network.ConnectionStatus
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test

class ForegroundConnectionRecoveryTest {
    @Test fun retriesOnlyUnhealthyConnections() {
        val controller = FakeController()
        for (status in ConnectionStatus.entries) {
            controller.connectivityState.value = ConnectionState(status)
            val before = controller.refreshes
            retryUnhealthyForegroundConnection(controller)
            val expected = status in setOf(ConnectionStatus.Offline, ConnectionStatus.Degraded, ConnectionStatus.Error)
            assertEquals(status.name, before + if (expected) 1 else 0, controller.refreshes)
        }
        retryUnhealthyForegroundConnection(null)
    }

    private class FakeController : TargetConnectionController {
        override val connectivityState = MutableStateFlow(ConnectionState(ConnectionStatus.Paired))
        var refreshes = 0
        override fun refresh() { refreshes++ }
        override fun start() = Unit
        override suspend fun stop() = Unit
        override fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan) = Unit
    }
}
