package com.andysagent.ragent.feature.appapi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.ComputerDirectory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

interface RoutingSettingsPort {
    val directory: Flow<ComputerDirectory>
    suspend fun setDefault(instanceId: String?)
    suspend fun setAliases(instanceId: String, aliases: List<String>)
    suspend fun reset()
}

class StoredRoutingSettings(private val config: ClientConfigStore) : RoutingSettingsPort {
    override val directory = config.directory
    override suspend fun setDefault(instanceId: String?) = config.setDefaultShareTarget(instanceId)
    override suspend fun setAliases(instanceId: String, aliases: List<String>) = config.setTargetAliases(instanceId, aliases)
    override suspend fun reset() = config.resetAppApiRouting()
}

enum class RoutingSettingsError { LOAD, INVALID_ALIASES, TARGET_REMOVED, SAVE }

data class RoutingSettingsUiState(
    val loading: Boolean = true,
    val directory: ComputerDirectory = ComputerDirectory(),
    val saving: Boolean = false,
    val editingTargetId: String? = null,
    val aliasesText: String = "",
    val error: RoutingSettingsError? = null,
)

sealed interface RoutingSettingsEvent {
    data class SelectDefault(val instanceId: String?) : RoutingSettingsEvent
    data class EditAliases(val instanceId: String) : RoutingSettingsEvent
    data class ChangeAliases(val text: String) : RoutingSettingsEvent
    data object SaveAliases : RoutingSettingsEvent
    data object CloseEditor : RoutingSettingsEvent
    data object Reset : RoutingSettingsEvent
    data object Reload : RoutingSettingsEvent
}

class RoutingSettingsViewModel(private val port: RoutingSettingsPort) : ViewModel() {
    private val mutableState = MutableStateFlow(RoutingSettingsUiState())
    val state: StateFlow<RoutingSettingsUiState> = mutableState.asStateFlow()
    private var observation: Job? = null
    init { observe() }

    private fun observe() {
        observation?.cancel()
        observation = viewModelScope.launch {
            try {
                port.directory.collect { directory ->
                    mutableState.update { it.copy(loading = false, directory = directory,
                        error = it.error.takeUnless { error -> error == RoutingSettingsError.LOAD }) }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { mutableState.update { it.copy(loading = false, error = RoutingSettingsError.LOAD) } }
        }
    }

    fun onEvent(event: RoutingSettingsEvent) {
        if (mutableState.value.saving) return
        when (event) {
            is RoutingSettingsEvent.SelectDefault -> save { port.setDefault(event.instanceId) }
            is RoutingSettingsEvent.EditAliases -> {
                if (mutableState.value.directory.computers.none { it.instanceId == event.instanceId }) return
                mutableState.update { it.copy(editingTargetId = event.instanceId,
                    aliasesText = it.directory.appApiRouting.aliasesByTarget[event.instanceId].orEmpty().joinToString("\n"), error = null) }
            }
            is RoutingSettingsEvent.ChangeAliases -> mutableState.update { it.copy(aliasesText = event.text, error = null) }
            RoutingSettingsEvent.SaveAliases -> {
                val current = mutableState.value
                val id = current.editingTargetId ?: return
                if (current.directory.computers.none { it.instanceId == id }) {
                    mutableState.update { it.copy(error = RoutingSettingsError.TARGET_REMOVED) }; return
                }
                val aliases = current.aliasesText.lines().map(String::trim).filter(String::isNotBlank)
                save(aliasEdit = true) { port.setAliases(id, aliases) }
            }
            RoutingSettingsEvent.CloseEditor -> mutableState.update { it.copy(editingTargetId = null, error = null) }
            RoutingSettingsEvent.Reset -> save { port.reset() }
            RoutingSettingsEvent.Reload -> { mutableState.update { it.copy(loading = true, error = null) }; observe() }
        }
    }

    private fun save(aliasEdit: Boolean = false, operation: suspend () -> Unit) {
        mutableState.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            try {
                operation()
                if (aliasEdit) mutableState.update { it.copy(editingTargetId = null) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: IllegalArgumentException) { mutableState.update { it.copy(error = if (aliasEdit) RoutingSettingsError.INVALID_ALIASES else RoutingSettingsError.SAVE) } }
            catch (_: Exception) { mutableState.update { it.copy(error = RoutingSettingsError.SAVE) } }
            finally { mutableState.update { it.copy(saving = false) } }
        }
    }
}
