package com.andysagent.ragent.feature.appapi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class CallerConsentReview(val identity: InstalledCallerIdentity, val appLabel: String,
    val request: CallerConsentRequest, val targetLabels: Map<String, String>, val context: CallerGrantContext,
    val openedAtElapsed: Long)

interface CallerConsentPort {
    suspend fun review(): CallerConsentReview
    suspend fun approve(review: CallerConsentReview, capabilities: Set<String>, targets: Set<String>,
        createSessions: Boolean, durationMs: Long): CallerConsentReceipt
}

data class CallerConsentUiState(val loading: Boolean = true, val review: CallerConsentReview? = null,
    val capabilities: Set<String> = emptySet(), val targets: Set<String> = emptySet(),
    val createSessions: Boolean = false, val durationMs: Long = 0, val saving: Boolean = false,
    val error: ApiErrorCode? = null, val receipt: CallerConsentReceipt? = null) {
    val canApprove get() = !loading && !saving && error == null && receipt == null && review != null &&
        capabilities.isNotEmpty() && targets.isNotEmpty() && durationMs > 0
}

sealed interface CallerConsentEvent {
    data class Capability(val id: String, val enabled: Boolean) : CallerConsentEvent
    data class Target(val id: String, val enabled: Boolean) : CallerConsentEvent
    data class Creation(val enabled: Boolean) : CallerConsentEvent
    data class Duration(val millis: Long) : CallerConsentEvent
    data object Approve : CallerConsentEvent
    data object Reload : CallerConsentEvent
}

class CallerConsentViewModel(private val port: CallerConsentPort) : ViewModel() {
    private val mutable = MutableStateFlow(CallerConsentUiState())
    val state = mutable.asStateFlow()
    init { load() }
    private fun load() {
        mutable.value = CallerConsentUiState()
        viewModelScope.launch {
            try {
                val review = port.review()
                review.request.validate()
                check(review.targetLabels.keys.containsAll(review.request.targetIds))
                mutable.value = CallerConsentUiState(loading = false, review = review,
                    durationMs = minOf(review.request.lifetimeMs, 60L * 60 * 1000))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = CallerConsentUiState(loading = false, error = error.apiCode()) }
        }
    }
    fun onEvent(event: CallerConsentEvent) {
        val current = mutable.value
        if (current.loading || current.saving || current.receipt != null) return
        if (event == CallerConsentEvent.Reload) { load(); return }
        val review = current.review ?: return
        if (current.error != null) return
        fun Set<String>.toggle(id: String, enabled: Boolean) = if (enabled) this + id else this - id
        when (event) {
            is CallerConsentEvent.Capability -> if (event.id in review.request.capabilityIds)
                mutable.value = current.copy(capabilities = current.capabilities.toggle(event.id, event.enabled))
            is CallerConsentEvent.Target -> if (event.id in review.targetLabels && (review.request.targetIds.isEmpty() || event.id in review.request.targetIds)) {
                val selected = current.targets.toggle(event.id, event.enabled)
                if (selected.size <= 16) mutable.value = current.copy(targets = selected)
            }
            is CallerConsentEvent.Creation -> mutable.value = current.copy(createSessions = event.enabled && review.request.mayCreateSessions)
            is CallerConsentEvent.Duration -> if (event.millis in 1..review.request.lifetimeMs) mutable.value = current.copy(durationMs = event.millis)
            CallerConsentEvent.Approve -> if (current.canApprove) {
                mutable.value = current.copy(saving = true)
                viewModelScope.launch {
                    try {
                        val receipt = port.approve(review, current.capabilities, current.targets, current.createSessions, current.durationMs)
                        mutable.value = current.copy(receipt = receipt)
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Exception) { mutable.value = current.copy(error = error.apiCode()) }
                }
            }
            CallerConsentEvent.Reload -> Unit
        }
    }
}

interface CallerGrantManagementPort {
    suspend fun list(): List<PersistedCallerGrant>
    suspend fun revoke(grant: PersistedCallerGrant)
    suspend fun deleteRevoked(grant: PersistedCallerGrant)
}
data class CallerGrantsUiState(val loading: Boolean = true, val grants: List<PersistedCallerGrant> = emptyList(),
    val busy: Boolean = false, val error: ApiErrorCode? = null)
sealed interface CallerGrantsEvent {
    data object Refresh : CallerGrantsEvent
    data class Revoke(val id: String) : CallerGrantsEvent
    data class DeleteRevoked(val id: String) : CallerGrantsEvent
}
class CallerGrantsViewModel(private val port: CallerGrantManagementPort) : ViewModel() {
    private val mutable = MutableStateFlow(CallerGrantsUiState())
    val state = mutable.asStateFlow()
    init { refresh() }
    private fun refresh() {
        mutable.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try { mutable.value = CallerGrantsUiState(loading = false, grants = port.list()) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = CallerGrantsUiState(loading = false, error = error.apiCode()) }
        }
    }
    fun onEvent(event: CallerGrantsEvent) {
        val current = mutable.value
        if (current.loading || current.busy) return
        if (event == CallerGrantsEvent.Refresh) { refresh(); return }
        val id = when (event) { is CallerGrantsEvent.Revoke -> event.id; is CallerGrantsEvent.DeleteRevoked -> event.id; else -> return }
        val row = current.grants.find { it.grantId == id } ?: return
        if (event is CallerGrantsEvent.DeleteRevoked && row.revokedAt == null) return
        mutable.value = current.copy(busy = true, error = null)
        viewModelScope.launch {
            try {
                when (event) { is CallerGrantsEvent.Revoke -> port.revoke(row); is CallerGrantsEvent.DeleteRevoked -> port.deleteRevoked(row); else -> Unit }
                mutable.value = CallerGrantsUiState(loading = false, grants = port.list())
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { mutable.value = current.copy(error = error.apiCode()) }
        }
    }
}
private fun Exception.apiCode() = (this as? AppApiException)?.error?.code ?: ApiErrorCode.INTERNAL_ERROR
