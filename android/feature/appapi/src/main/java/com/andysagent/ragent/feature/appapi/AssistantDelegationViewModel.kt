package com.andysagent.ragent.feature.appapi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class AssistantDelegationReview(val context: CallerGrantContext, val targetLabels: Map<String, String>,
    val delegations: List<AssistantDelegation>, val openedAtElapsed: Long)
interface AssistantDelegationPort {
    suspend fun review(): AssistantDelegationReview
    suspend fun approve(review: AssistantDelegationReview, scope: AssistantDelegationScope)
    suspend fun revoke(row: AssistantDelegation)
    suspend fun deleteRevoked(row: AssistantDelegation)
    fun now(): Long
}
data class AssistantDelegationUiState(val loading: Boolean = true, val review: AssistantDelegationReview? = null,
    val capabilities: Set<String> = emptySet(), val targets: Set<String> = emptySet(), val mayCreateSessions: Boolean = false,
    val sessionsText: String = "", val projectsText: String = "", val acknowledgedGroup: Boolean = false,
    val lifetimeMs: Long = 60 * 60 * 1000, val busy: Boolean = false, val error: ApiErrorCode? = null) {
    val canApprove get() = !loading && !busy && error == null && review != null && acknowledgedGroup &&
        capabilities.isNotEmpty() && targets.isNotEmpty()
}
sealed interface AssistantDelegationEvent {
    data object Refresh : AssistantDelegationEvent
    data object Approve : AssistantDelegationEvent
    data class Capability(val id: String, val selected: Boolean) : AssistantDelegationEvent
    data class Target(val id: String, val selected: Boolean) : AssistantDelegationEvent
    data class Creation(val selected: Boolean) : AssistantDelegationEvent
    data class Acknowledge(val selected: Boolean) : AssistantDelegationEvent
    data class Sessions(val text: String) : AssistantDelegationEvent
    data class Projects(val text: String) : AssistantDelegationEvent
    data class Lifetime(val millis: Long) : AssistantDelegationEvent
    data class Revoke(val id: String) : AssistantDelegationEvent
    data class DeleteRevoked(val id: String) : AssistantDelegationEvent
}
class AssistantDelegationViewModel(private val port: AssistantDelegationPort) : ViewModel() {
    private val mutable = MutableStateFlow(AssistantDelegationUiState())
    val state = mutable.asStateFlow()
    init { refresh() }
    private fun refresh() {
        mutable.value = AssistantDelegationUiState()
        viewModelScope.launch {
            try { mutable.value = AssistantDelegationUiState(loading = false, review = port.review()) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = AssistantDelegationUiState(loading = false, error = error.code()) }
        }
    }
    fun onEvent(event: AssistantDelegationEvent) {
        val current = mutable.value
        if (current.loading || current.busy) return
        if (event == AssistantDelegationEvent.Refresh) { refresh(); return }
        val review = current.review ?: return
        fun Set<String>.toggle(id: String, selected: Boolean) = if (selected) this + id else this - id
        when (event) {
            is AssistantDelegationEvent.Capability -> if (event.id in AssistantTaskCapabilities.ids)
                mutable.value = current.copy(capabilities = current.capabilities.toggle(event.id, event.selected))
            is AssistantDelegationEvent.Target -> if (event.id in review.targetLabels && event.id in review.context.pairedTargetIds)
                mutable.value = current.copy(targets = current.targets.toggle(event.id, event.selected))
            is AssistantDelegationEvent.Creation -> mutable.value = current.copy(mayCreateSessions = event.selected)
            is AssistantDelegationEvent.Acknowledge -> mutable.value = current.copy(acknowledgedGroup = event.selected)
            is AssistantDelegationEvent.Sessions -> if (event.text.length <= 8192) mutable.value = current.copy(sessionsText = event.text)
            is AssistantDelegationEvent.Projects -> if (event.text.length <= 8192) mutable.value = current.copy(projectsText = event.text)
            is AssistantDelegationEvent.Lifetime -> if (event.millis in setOf(60 * 60 * 1000L, 24 * 60 * 60 * 1000L))
                mutable.value = current.copy(lifetimeMs = event.millis)
            AssistantDelegationEvent.Approve -> if (current.canApprove) mutate {
                fun parse(text: String): Set<String>? {
                    if (text.isBlank()) return null
                    val items = text.split(',', '\n').map(String::trim)
                    require(items.size <= 256 && items.all { it.isNotBlank() && it.length <= 256 && it.none(Char::isISOControl) })
                    return items.toSet()
                }
                val time = port.now()
                require(time in 0..Long.MAX_VALUE - current.lifetimeMs)
                port.approve(review, AssistantDelegationScope(current.capabilities, current.targets, time + current.lifetimeMs,
                    parse(current.sessionsText), parse(current.projectsText), current.mayCreateSessions))
            }
            is AssistantDelegationEvent.Revoke -> review.delegations.firstOrNull { it.id == event.id && it.revokedAt == null }
                ?.let { row -> mutate { port.revoke(row) } }
            is AssistantDelegationEvent.DeleteRevoked -> review.delegations.firstOrNull { it.id == event.id && it.revokedAt != null }
                ?.let { row -> mutate { port.deleteRevoked(row) } }
            AssistantDelegationEvent.Refresh -> Unit
        }
    }
    private fun mutate(operation: suspend () -> Unit) {
        val before = mutable.value
        mutable.value = before.copy(busy = true, error = null)
        viewModelScope.launch {
            try { operation(); mutable.value = AssistantDelegationUiState(loading = false, review = port.review()) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = before.copy(error = error.code()) }
        }
    }
    private fun Exception.code() = (this as? AppApiException)?.error?.code
        ?: if (this is IllegalArgumentException) ApiErrorCode.INVALID_ARGUMENT else ApiErrorCode.INTERNAL_ERROR
}
