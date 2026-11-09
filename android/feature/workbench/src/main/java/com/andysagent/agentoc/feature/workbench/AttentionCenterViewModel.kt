package com.andysagent.agentoc.feature.workbench

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.andysagent.agentoc.core.domain.ApprovalResolutionCoordinator
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SwitchingSessionRepository
import com.andysagent.agentoc.core.domain.RefreshResult
import com.andysagent.agentoc.core.domain.SessionRepositoryException
import com.andysagent.agentoc.core.domain.isTerminalApprovalFailure
import com.andysagent.agentoc.core.domain.newRequestId
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

sealed interface AttentionEvent {
    /** The Session currently open on screen; its items never surface globally. */
    data class SetVisibleSession(val sessionId: String?) : AttentionEvent
    data class SetExpanded(val itemId: String, val expanded: Boolean) : AttentionEvent
    /** Closes the current presentation only; server-side facts stay untouched. */
    data class Dismiss(val itemId: String) : AttentionEvent
    data class ResolveApproval(val itemId: String, val approve: Boolean) : AttentionEvent
    data class ResolveActionBatch(
        val itemId: String,
        val selectedActionIds: Set<String>,
        val approvalIntent: String = "approve",
    ) : AttentionEvent
    data class ResolvePrivilegedCategory(val itemId: String, val category: String, val selectedIds: Set<String>) : AttentionEvent

    /**
     * Answers an ask-user approval from the overlay: tapping [optionIndex] of
     * question [questionIndex], or submitting the typed [customAnswer]. Every
     * answer still re-validates against the server projection before it is
     * submitted.
     */
    data class ResolveQuestion(
        val itemId: String,
        val questionIndex: Int,
        val optionIndex: Int?,
        val customAnswer: String = "",
    ) : AttentionEvent

    /** Submits one answer slot per question after a multi-question prompt is complete. */
    data class ResolveQuestions(
        val itemId: String,
        val choices: List<Int>,
        val customAnswer: String = "",
        val customAnswers: List<String> = emptyList(),
    ) : AttentionEvent
    data class ResolveMultiChoices(val itemId: String, val selections: List<List<Int>>, val customAnswers: List<String>) : AttentionEvent
    data object ClearError : AttentionEvent
}

/**
 * Single source of truth for the global attention surface. It only projects
 * Room/server facts into a display queue: approvals stay owned by the
 * repository, and dismissal never mutates server state.
 */
class AttentionCenterViewModel(
    private val repository: SessionRepository,
    private val brokerApprovalController: BrokerApprovalController? = null,
    private val passkeyProvider: (suspend (String) -> WebAuthnProofDto)? = null,
) : ViewModel() {

    private val coordinator = ApprovalResolutionCoordinator(repository)
    private val mutableState = MutableStateFlow(AttentionUiState())
    val state: StateFlow<AttentionUiState> = mutableState.asStateFlow()

    private val visibleSessionId = MutableStateFlow<String?>(null)
    private val brokerApprovals = MutableStateFlow<List<Approval>>(emptyList())

    init {
        // Live timeline events are an ephemeral projection; approval cards
        // observe durable Room facts. Reconcile approval-bearing pushes for
        // every session, including the currently visible one, and recover the
        // same facts when a push degrades to an invalidation-only notification.
        viewModelScope.launch {
            repository.invalidations.collect { hint ->
                val sessionId = hint.sessionId ?: return@collect
                if (hint.type != "session_invalidated" && hint.events.none { event ->
                        val type = event.type.orEmpty().lowercase()
                        type.contains("approval") || type.contains("confirmation") ||
                            type.startsWith("privileged_batch_") || type.startsWith("approved_action_")
                    }) return@collect
                val switching = repository as? SwitchingSessionRepository
                val fixed = if (switching != null) switching.delegate.value ?: return@collect else repository
                try {
                    fixed.refreshEvents(sessionId)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    // Retain the last known facts; normal reconnect/reconciliation retries.
                }
            }
        }
        viewModelScope.launch {
            combine(
                repository.observeSessions(),
                repository.observeAllPendingApprovals(),
                visibleSessionId,
                brokerApprovals,
            ) { sessions, approvals, visible, broker ->
                (AttentionReducer.project(sessions, approvals) + AttentionReducer.projectBrokerApprovals(broker)) to visible
            }.collect { (items, visible) ->
                mutableState.update { current ->
                    AttentionReducer.reduce(current.copy(visibleSessionId = visible), items)
                }
            }
        }
        brokerApprovalController?.let { controller ->
            viewModelScope.launch {
                controller.observePendingApprovals().collect { brokerApprovals.value = it }
            }
        }
    }

    fun onEvent(event: AttentionEvent) {
        when (event) {
            is AttentionEvent.SetVisibleSession -> {
                if (visibleSessionId.value != event.sessionId) visibleSessionId.value = event.sessionId
            }
            is AttentionEvent.SetExpanded -> mutableState.update { current ->
                if (current.activeItemId != event.itemId) current
                else current.copy(expanded = event.expanded)
            }
            is AttentionEvent.Dismiss -> mutableState.update { current ->
                val remaining = current.items.filterNot { it.id == event.itemId }
                current.copy(
                    dismissedItemIds = current.dismissedItemIds + event.itemId,
                    items = remaining,
                    activeItemId = remaining.firstOrNull()?.id,
                    expanded = false,
                )
            }
            is AttentionEvent.ResolveApproval -> resolveApproval(event.itemId, event.approve)
            is AttentionEvent.ResolveActionBatch -> resolveActionBatch(event)
            is AttentionEvent.ResolvePrivilegedCategory -> resolvePrivilegedCategory(event)
            is AttentionEvent.ResolveQuestion -> resolveQuestion(event)
            is AttentionEvent.ResolveQuestions -> resolveQuestions(event)
            is AttentionEvent.ResolveMultiChoices -> resolveMultiChoices(event)
            AttentionEvent.ClearError -> mutableState.update { it.copy(error = null) }
        }
    }

    private fun resolveApproval(itemId: String, approve: Boolean) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == itemId } ?: return
        val approval = item.approval ?: return
        if (approval.brokerDecisionUncertain) return
        if (approval.kind == AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND) {
            val controller = brokerApprovalController ?: return
            mutableState.update { it.copy(resolvingItemId = itemId, error = null) }
            viewModelScope.launch {
                val outcome = try {
                    controller.resolve(approval, approve)
                    ApprovalResolutionCoordinator.Outcome.Submitted
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (unknown: BrokerApprovalOutcomeUnknownException) {
                    markBrokerUnknown(itemId, approval, unknown.message ?: "Broker decision outcome unknown")
                    ApprovalResolutionCoordinator.Outcome.Failed(unknown.message ?: "Broker decision outcome unknown")
                } catch (error: Throwable) {
                    ApprovalResolutionCoordinator.Outcome.Failed(error.message ?: "Windows Broker approval failed")
                }
                consumeResolution(itemId, outcome)
                if (outcome is ApprovalResolutionCoordinator.Outcome.Submitted) {
                    brokerApprovals.value = brokerApprovals.value.filterNot {
                        it.id == approval.id && it.brokerTargetInstanceId == approval.brokerTargetInstanceId &&
                            it.brokerChallengeDigest == approval.brokerChallengeDigest
                    }
                }
            }
            return
        }
        mutableState.update { it.copy(resolvingItemId = itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolvePlainApproval(item.sessionId, approval.id, approve)
            consumeResolution(itemId, outcome)
        }
    }

    private fun resolveActionBatch(event: AttentionEvent.ResolveActionBatch) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        if (approval.kind != "approved_action_batch_request" || event.approvalIntent !in setOf("approve", "deny")) return
        val switching = repository as? SwitchingSessionRepository
        val fixed = if (switching != null) switching.delegate.value ?: return else repository
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            var attempted = false
            try {
                val pending = fixed.findPendingApproval(item.sessionId, approval.id)
                    ?.takeIf { it.status == "pending" && it.kind == "approved_action_batch_request" }
                    ?: error("This approval is no longer pending")
                val runId = pending.runId ?: error("Approval run is unavailable")
                val batchId = pending.batchId ?: error("Approval batch is unavailable")
                val available = pending.actions.filter { it.state in setOf("proposed", "classified", "waiting_user") }
                require(available.isNotEmpty() && event.selectedActionIds.all { id -> available.any { it.id == id } } &&
                    (event.approvalIntent != "approve" || event.selectedActionIds.isNotEmpty()) &&
                    (event.approvalIntent != "deny" || event.selectedActionIds.isEmpty())) { "Approval selection is no longer valid" }
                val decisions = available.map { action ->
                    ApprovalActionDecision(action.id, if (action.id in event.selectedActionIds) "approve" else "deny")
                }
                val passkeyIds = available.filter { it.id in event.selectedActionIds && it.needsPasskey }.map { it.id }
                val requestId = newRequestId()
                val proof = if (passkeyIds.isNotEmpty()) {
                    val provider = passkeyProvider ?: error("Passkey approval requires the Android system credential provider")
                    if (switching != null && switching.delegate.value !== fixed) error("The connected computer changed")
                    provider(fixed.createApprovedActionWebAuthnChallenge(runId, batchId, passkeyIds, requestId).toString())
                } else null
                if (switching != null && switching.delegate.value !== fixed) error("The connected computer changed")
                attempted = true
                fixed.resolveApprovedActionBatchWithProof(item.sessionId, runId, batchId, decisions, event.approvalIntent, proof, requestId)
                consumeResolution(event.itemId, ApprovalResolutionCoordinator.Outcome.Submitted)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                val retryable = when (error) {
                    is ApiException -> error.retryable
                    is SessionRepositoryException -> error.retryable
                    else -> true
                }
                if (error.isTerminalApprovalFailure()) {
                    fixed.retireStaleApproval(item.sessionId, approval.id)
                    consumeResolution(event.itemId, ApprovalResolutionCoordinator.Outcome.Stale)
                } else if (attempted && retryable) awaitActionBatch(fixed, switching, item.sessionId, approval.id, event.itemId)
                else mutableState.update { it.copy(resolvingItemId = null, error = error.message ?: "审批提交失败") }
            }
        }
    }

    private suspend fun awaitActionBatch(fixed: SessionRepository, switching: SwitchingSessionRepository?, sessionId: String, approvalId: String, itemId: String) {
        mutableState.update { it.copy(error = "Approval submitted; waiting to confirm the result.") }
        while (true) {
            delay(2_000)
            if (switching != null && switching.delegate.value !== fixed) return
            if (mutableState.value.items.none { it.id == itemId }) return
            try {
                if (fixed.refreshEvents(sessionId) is RefreshResult.Applied) {
                    val pending = fixed.findPendingApproval(sessionId, approvalId)
                    if (pending == null || pending.status != "pending" || pending.actions.none { it.state in setOf("proposed", "classified", "waiting_user") }) {
                        consumeResolution(itemId, ApprovalResolutionCoordinator.Outcome.Submitted)
                        return
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Wait for the authoritative result before enabling another decision. */ }
        }
    }

    private fun resolvePrivilegedCategory(event: AttentionEvent.ResolvePrivilegedCategory) {
        val current = mutableState.value
        if (current.resolvingItemId != null || event.category !in setOf("privileged_other", "destructive_delete")) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val original = item.approval ?: return
        if (original.kind != "privileged_batch_request") return
        val switching = repository as? SwitchingSessionRepository
        val fixed = if (switching != null) switching.delegate.value ?: return else repository
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            var attempted = false
            try {
                val pending = fixed.findPendingApproval(item.sessionId, original.id)
                    ?.takeIf { it.status == "pending" && it.kind == "privileged_batch_request" }
                    ?: error("This approval is no longer pending")
                val runId = pending.runId ?: error("Approval run is unavailable")
                val batchId = pending.batchId ?: error("Approval batch is unavailable")
                val available = pending.actions.filter { it.category == event.category && it.state in setOf("proposed", "classified", "waiting_user") }
                require(available.isNotEmpty() && event.selectedIds.all { id -> available.any { it.id == id } }) { "Approval selection is no longer valid" }
                val selected = available.map { it.id }.filter { it in event.selectedIds }
                val requestId = newRequestId()
                val proof = if (selected.isNotEmpty() && pending.passkeyRequired) {
                    val provider = passkeyProvider ?: error("Passkey approval requires the Android system credential provider")
                    if (switching != null && switching.delegate.value !== fixed) error("The connected computer changed")
                    val challenge = fixed.createPrivilegedCategoryWebAuthnChallenge(runId, batchId, event.category, selected, requestId)
                    provider(challenge.toString())
                } else null
                if (switching != null && switching.delegate.value !== fixed) error("The connected computer changed")
                attempted = true
                fixed.resolvePrivilegedCategory(item.sessionId, runId, batchId, event.category, selected, proof, requestId)
                if (refreshPrivilegedCategory(fixed, item.sessionId, original.id, event.category)) {
                    mutableState.update { it.copy(resolvingItemId = null, error = null) }
                } else {
                    awaitPrivilegedCategory(fixed, switching, item.sessionId, original.id, event)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                val retryable = when (error) {
                    is ApiException -> error.retryable
                    is SessionRepositoryException -> error.retryable
                    else -> true
                }
                if (error.isTerminalApprovalFailure()) {
                    fixed.retireStaleApproval(item.sessionId, original.id)
                    consumeResolution(event.itemId, ApprovalResolutionCoordinator.Outcome.Stale)
                } else if (attempted && retryable) awaitPrivilegedCategory(fixed, switching, item.sessionId, original.id, event)
                else mutableState.update { it.copy(resolvingItemId = null, error = error.message ?: "Approval could not be resolved") }
            }
        }
    }

    private suspend fun refreshPrivilegedCategory(fixed: SessionRepository, sessionId: String, approvalId: String, category: String): Boolean {
        if (fixed.refreshEvents(sessionId) !is RefreshResult.Applied) return false
        val pending = fixed.findPendingApproval(sessionId, approvalId) ?: return true
        return pending.status != "pending" || pending.actions.none {
            it.category == category && it.state in setOf("proposed", "classified", "waiting_user")
        }
    }

    private suspend fun awaitPrivilegedCategory(fixed: SessionRepository, switching: SwitchingSessionRepository?,
        sessionId: String, approvalId: String, event: AttentionEvent.ResolvePrivilegedCategory) {
        mutableState.update { it.copy(error = "Approval submitted; waiting to confirm the result.") }
        while (true) {
            delay(2_000)
            if (switching != null && switching.delegate.value !== fixed) return
            if (mutableState.value.items.none { it.id == event.itemId }) return
            try {
                if (refreshPrivilegedCategory(fixed, sessionId, approvalId, event.category)) {
                    mutableState.update { it.copy(resolvingItemId = null, error = null) }
                    return
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Keep the decision locked until an authoritative result arrives. */ }
        }
    }

    private fun resolveQuestion(event: AttentionEvent.ResolveQuestion) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolveQuestionApproval(
                sessionId = item.sessionId,
                approvalId = approval.id,
                questionIndex = event.questionIndex,
                optionIndex = event.optionIndex,
                customAnswer = event.customAnswer,
            )
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun resolveMultiChoices(event: AttentionEvent.ResolveMultiChoices) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolveMultiChoiceQuestions(item.sessionId, approval.id, event.selections, event.customAnswers)
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun resolveQuestions(event: AttentionEvent.ResolveQuestions) {
        val current = mutableState.value
        if (current.resolvingItemId != null) return
        val item = current.items.firstOrNull { it.id == event.itemId } ?: return
        val approval = item.approval ?: return
        mutableState.update { it.copy(resolvingItemId = event.itemId, error = null) }
        viewModelScope.launch {
            val outcome = coordinator.resolveQuestionsApproval(
                sessionId = item.sessionId,
                approvalId = approval.id,
                choices = event.choices,
                customAnswer = event.customAnswer,
                customAnswers = event.customAnswers,
            )
            consumeResolution(event.itemId, outcome)
        }
    }

    private fun consumeResolution(itemId: String, outcome: ApprovalResolutionCoordinator.Outcome) {
        mutableState.update { state ->
            when (outcome) {
                is ApprovalResolutionCoordinator.Outcome.Submitted,
                is ApprovalResolutionCoordinator.Outcome.Stale,
                ->
                    // The next Room projection owns the post-resolution
                    // queue; drop the presentation immediately so the same
                    // approval cannot be submitted twice.
                    state.copy(
                        resolvingItemId = null,
                        dismissedItemIds = state.dismissedItemIds + itemId,
                        items = state.items.filterNot { it.id == itemId },
                        activeItemId = if (state.activeItemId == itemId) state.items.firstOrNull { it.id != itemId }?.id else state.activeItemId,
                        expanded = false,
                    )
                is ApprovalResolutionCoordinator.Outcome.RequiresSession -> state.copy(resolvingItemId = null)
                is ApprovalResolutionCoordinator.Outcome.Failed -> state.copy(
                    resolvingItemId = null,
                    error = outcome.message,
                )
            }
        }
    }

    private fun markBrokerUnknown(itemId: String, approval: Approval, message: String) {
        val uncertain = approval.copy(
            brokerDecisionUncertain = true,
            title = message,
            reason = "$message\n${approval.reason.orEmpty()}",
        )
        brokerApprovals.update { approvals ->
            approvals.map { if (it.id == approval.id && it.brokerChallengeDigest == approval.brokerChallengeDigest &&
                it.brokerTargetInstanceId == approval.brokerTargetInstanceId) uncertain else it }
        }
        mutableState.update { state ->
            state.copy(items = state.items.map { item ->
                if (item.id == itemId) item.copy(title = message, summary = message, reason = uncertain.reason, approval = uncertain)
                else item
            })
        }
    }

}

class AttentionCenterViewModelFactory(
    private val repository: SessionRepository,
    private val brokerApprovalController: BrokerApprovalController? = null,
    private val passkeyProvider: (suspend (String) -> WebAuthnProofDto)? = null,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T =
        AttentionCenterViewModel(repository, brokerApprovalController, passkeyProvider) as T
}
