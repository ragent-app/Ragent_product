package com.andysagent.ragent

import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.datastore.ComputerDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking

class AccountRendezvousAutoReconnectTest {
    @Test fun `background connection waits for its own carrier while primary remains connected`() = runBlocking {
        val states = MutableStateFlow(mapOf("primary" to RuntimeConnectionState.Connected,
            "background" to RuntimeConnectionState.Connecting))
        val wait = async { awaitConnectedComputer(states, "background", 1_000) }
        delay(25)
        assertFalse(wait.isCompleted)
        states.value = states.value + ("background" to RuntimeConnectionState.Disconnected)
        delay(25)
        assertFalse(wait.isCompleted)
        states.value = states.value + ("background" to RuntimeConnectionState.Connected)
        assertTrue(wait.await())
        assertEquals(RuntimeConnectionState.Connected, states.value["primary"])
    }

    @Test fun `background connection wait times out without another target completing it`() = runBlocking {
        val states = MutableStateFlow(mapOf("primary" to RuntimeConnectionState.Connected))
        assertFalse(awaitConnectedComputer(states, "background", 50))
    }
    private val accountTarget = LinkedComputer(
        instanceId = "windows",
        // Account-owned TURN targets do not retain a reusable target endpoint.
        endpoint = "",
        autoConnect = true,
    )

    @Test
    fun `foreground launch renews the last selected account target`() {
        assertTrue(
            shouldRenewAccountRendezvousOnForeground(
                target = accountTarget,
                activeInstanceId = "windows",
                foreground = true,
            ),
        )
    }

    @Test
    fun `background app does not renew its account rendezvous`() {
        assertFalse(
            shouldRenewAccountRendezvousOnForeground(
                target = accountTarget,
                activeInstanceId = "windows",
                foreground = false,
            ),
        )
    }

    @Test
    fun `only the active opted-in endpointless target reconnects automatically`() {
        assertFalse(
            shouldRenewAccountRendezvousOnForeground(
                target = accountTarget.copy(autoConnect = false),
                activeInstanceId = "windows",
                foreground = true,
            ),
        )
        assertFalse(
            shouldRenewAccountRendezvousOnForeground(
                target = accountTarget,
                activeInstanceId = "another-computer",
                foreground = true,
            ),
        )
        assertFalse(
            shouldRenewAccountRendezvousOnForeground(
                target = accountTarget.copy(endpoint = "https://desktop.example.test"),
                activeInstanceId = "windows",
                foreground = true,
            ),
        )
    }

    @Test
    fun `account plan reserves one connection for the primary target`() {
        val ids = automaticBackgroundTargetIds(
            computers = listOf(
                accountTarget,
                accountTarget.copy(instanceId = "mac"),
                accountTarget.copy(instanceId = "linux"),
            ),
            activeInstanceId = "windows",
            maximumConcurrentConnections = 2,
        )

        assertEquals(listOf("mac"), ids)
    }

    @Test
    fun `single connection plan never restores a second computer in background`() {
        val ids = automaticBackgroundTargetIds(
            computers = listOf(accountTarget, accountTarget.copy(instanceId = "mac")),
            activeInstanceId = "windows",
            maximumConcurrentConnections = 1,
        )

        assertEquals(emptyList<String>(), ids)
    }

    @Test
    fun `restart recovery keeps persisted primary out of background connections`() {
        val plan = automaticConnectionRecoveryPlan(
            directory = ComputerDirectory(
                computers = listOf(
                    accountTarget,
                    accountTarget.copy(instanceId = "mac"),
                ),
                activeTargetId = "windows",
            ),
            maximumConcurrentConnections = 2,
        )

        assertEquals("windows", plan.primaryInstanceId)
        assertEquals(listOf("mac"), plan.backgroundInstanceIds)
    }

    @Test fun `legacy primary without background opt in remains the primary on reopen`() {
        val plan = automaticConnectionRecoveryPlan(ComputerDirectory(
            computers = listOf(accountTarget.copy(autoConnect = false), accountTarget.copy(instanceId = "mac"),
                accountTarget.copy(instanceId = "paired-only", autoConnect = false)),
            activeTargetId = "windows"), maximumConcurrentConnections = 2)
        assertEquals("windows", plan.primaryInstanceId)
        assertEquals(listOf("mac"), plan.backgroundInstanceIds)
    }
}
