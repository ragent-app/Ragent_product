package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.datastore.AppApiRoutingPreferences
import com.andysagent.ragent.core.datastore.ComputerDirectory
import com.andysagent.ragent.core.datastore.LinkedComputer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class RoutingSettingsViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private val computers = listOf(LinkedComputer("a", "", "Office"), LinkedComputer("b", "", "Home"))
    private inner class Port : RoutingSettingsPort {
        val snapshot = MutableStateFlow(ComputerDirectory(computers, "a", AppApiRoutingPreferences(defaultShareTargetId = "b")))
        override val directory: Flow<ComputerDirectory> get() = snapshot
        val defaults = mutableListOf<String?>()
        val aliases = mutableListOf<Pair<String, List<String>>>()
        var gate: CompletableDeferred<Unit>? = null
        var aliasError: Exception? = null
        var resetCount = 0
        override suspend fun setDefault(instanceId: String?) {
            defaults += instanceId
            gate?.await()
            snapshot.value = snapshot.value.copy(appApiRouting = snapshot.value.appApiRouting.copy(defaultShareTargetId = instanceId))
        }
        override suspend fun setAliases(instanceId: String, aliases: List<String>) {
            aliasError?.let { throw it }
            this.aliases += instanceId to aliases
            snapshot.value = snapshot.value.copy(appApiRouting = snapshot.value.appApiRouting.copy(aliasesByTarget = mapOf(instanceId to aliases.toSet())))
        }
        override suspend fun reset() {
            resetCount++
            snapshot.value = snapshot.value.copy(appApiRouting = AppApiRoutingPreferences())
        }
    }
    @Test fun defaultIsIndependentFromOpenComputerAndConcurrentTapCannotOverrideSave() = runTest(dispatcher) {
        val port = Port()
        val model = RoutingSettingsViewModel(port)
        runCurrent()
        assertEquals("a", model.state.value.directory.activeTargetId)
        assertEquals("b", model.state.value.directory.appApiRouting.defaultShareTargetId)
        port.gate = CompletableDeferred()
        model.onEvent(RoutingSettingsEvent.SelectDefault(null))
        model.onEvent(RoutingSettingsEvent.SelectDefault("a"))
        runCurrent()
        assertEquals(listOf<String?>(null), port.defaults)
        assertTrue(model.state.value.saving)
        port.gate!!.complete(Unit)
        runCurrent()
        assertFalse(model.state.value.saving)
        assertNull(model.state.value.directory.appApiRouting.defaultShareTargetId)
        assertEquals("a", model.state.value.directory.activeTargetId)
    }
    @Test fun aliasErrorPreservesFullInputAndRetrySavesTrimmedNonemptyLines() = runTest(dispatcher) {
        val port = Port()
        val model = RoutingSettingsViewModel(port)
        runCurrent()
        model.onEvent(RoutingSettingsEvent.EditAliases("b"))
        val input = "  家里电脑  \n\n Home PC \n"
        model.onEvent(RoutingSettingsEvent.ChangeAliases(input))
        port.aliasError = IllegalArgumentException("invalid")
        model.onEvent(RoutingSettingsEvent.SaveAliases)
        runCurrent()
        assertEquals(RoutingSettingsError.INVALID_ALIASES, model.state.value.error)
        assertEquals(input, model.state.value.aliasesText)
        assertEquals("b", model.state.value.editingTargetId)
        port.aliasError = null
        model.onEvent(RoutingSettingsEvent.SaveAliases)
        runCurrent()
        assertEquals(listOf("b" to listOf("家里电脑", "Home PC")), port.aliases)
        assertNull(model.state.value.editingTargetId)
    }
    @Test fun unpairedTargetCannotSaveAliasEditorToAnotherComputer() = runTest(dispatcher) {
        val port = Port()
        val model = RoutingSettingsViewModel(port)
        runCurrent()
        model.onEvent(RoutingSettingsEvent.EditAliases("b"))
        port.snapshot.value = port.snapshot.value.copy(computers = computers.take(1))
        runCurrent()
        model.onEvent(RoutingSettingsEvent.SaveAliases)
        runCurrent()
        assertEquals(RoutingSettingsError.TARGET_REMOVED, model.state.value.error)
        assertTrue(port.aliases.isEmpty())
    }
    @Test fun resetUnreadableConfigurationDoesNotChangeOpenTarget() = runTest(dispatcher) {
        val port = Port()
        port.snapshot.value = port.snapshot.value.copy(appApiRouting = AppApiRoutingPreferences(readable = false))
        val model = RoutingSettingsViewModel(port)
        runCurrent()
        assertFalse(model.state.value.directory.appApiRouting.readable)
        model.onEvent(RoutingSettingsEvent.Reset)
        runCurrent()
        assertTrue(model.state.value.directory.appApiRouting.readable)
        assertEquals("a", model.state.value.directory.activeTargetId)
        assertEquals(1, port.resetCount)
    }
    @Test fun loadFailureCanRetryWithoutSavingAnything() = runTest(dispatcher) {
        val stored = Port()
        var fail = true
        val port = object : RoutingSettingsPort by stored {
            override val directory: Flow<ComputerDirectory> = flow {
                if (fail) error("load failed")
                stored.directory.collect { emit(it) }
            }
        }
        val model = RoutingSettingsViewModel(port)
        runCurrent()
        assertEquals(RoutingSettingsError.LOAD, model.state.value.error)
        fail = false
        model.onEvent(RoutingSettingsEvent.Reload)
        runCurrent()
        assertNull(model.state.value.error)
        assertEquals("b", model.state.value.directory.appApiRouting.defaultShareTargetId)
        assertTrue(stored.defaults.isEmpty())
    }
}
