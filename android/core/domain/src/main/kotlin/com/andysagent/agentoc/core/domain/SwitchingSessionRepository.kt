package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.TargetSummary
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.json.JsonObject

/**
 * Keeps ViewModels stable while the active remote computer changes.
 * Each delegate owns a different Room database, so no target can expose
 * another target's cached sessions or pending mutations.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SwitchingSessionRepository(scope: CoroutineScope) : SessionRepository {
    override val runtimeTargetId: String? get() = mutableDelegate.value?.runtimeTargetId
    private val mutableDelegate = MutableStateFlow<SessionRepository?>(null)
    val delegate: StateFlow<SessionRepository?> = mutableDelegate.asStateFlow()

    override val connectionState: StateFlow<RuntimeConnectionState> = mutableDelegate
        .flatMapLatest { it?.connectionState ?: flowOf(RuntimeConnectionState.Disconnected) }
        .stateIn(scope, SharingStarted.Eagerly, RuntimeConnectionState.Disconnected)

    override val invalidations: Flow<SessionInvalidation> = mutableDelegate
        .flatMapLatest { it?.invalidations ?: emptyFlow() }

    override val requiresLiveSync: Boolean
        get() = mutableDelegate.value?.requiresLiveSync == true

    fun switchTo(repository: SessionRepository?) {
        mutableDelegate.value = repository
    }

    override suspend fun createSessionIdempotent(
        request: com.andysagent.agentoc.core.protocol.CreateSessionRequestDto,
        idempotencyKey: String,
    ): SessionCreationReceipt = current().createSessionIdempotent(request, idempotencyKey)

    override suspend fun submitMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String?,
        attachments: List<com.andysagent.agentoc.core.protocol.AttachmentItemDto>,
    ): MessageSubmissionReceipt = current().submitMessage(sessionId, text, selection, requestId, agentId, attachments)

    override suspend fun findMessageSubmissionReceipt(sessionId: String, requestId: String): MessageSubmissionReceipt? =
        current().findMessageSubmissionReceipt(sessionId, requestId)

    override fun observeComputers(): Flow<List<Computer>> = delegateFlow { it.observeComputers() }
    override fun observeProjects(): Flow<List<Project>> = delegateFlow { it.observeProjects() }
    override fun observeAcceptedFirstTurnSessionIds(): Flow<Set<String>> =
        delegateFlow { it.observeAcceptedFirstTurnSessionIds() }
    override fun observeSession(sessionId: String): Flow<Session?> = delegateFlow { it.observeSession(sessionId) }
    override fun observeRunActivity(sessionId: String): Flow<JsonObject?> = delegateFlow { it.observeRunActivity(sessionId) }
    override fun observeRunDurations(sessionId: String): Flow<Map<String, Long>> = delegateFlow { it.observeRunDurations(sessionId) }
    override suspend fun saveRunDuration(sessionId: String, runId: String, durationMs: Long) =
        current().saveRunDuration(sessionId, runId, durationMs)
    override fun observeMessages(sessionId: String): Flow<List<Message>> = delegateFlow { it.observeMessages(sessionId) }
    override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = delegateFlow { it.observeTimeline(sessionId) }
    override fun observeAttachmentUploadProgress(sessionId: String): Flow<Map<String, AttachmentUploadProgress>> =
        delegateFlow { it.observeAttachmentUploadProgress(sessionId) }
    override fun observeTimelinePaging(sessionId: String): Flow<TimelinePagingState> = delegateFlow { it.observeTimelinePaging(sessionId) }
    override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = delegateFlow { it.observePendingApprovals(sessionId) }

    // The attention projection must observe a computer switch the moment it
    // happens: with no active target these flows emit an empty list instead of
    // completing silently, so stale items can never linger in the surface.
    override fun observeSessions(): Flow<List<Session>> = activeDelegateFlow { it.observeSessions() }
    override fun observeAllPendingApprovals(): Flow<List<Approval>> = activeDelegateFlow { it.observeAllPendingApprovals() }

    private fun <T> activeDelegateFlow(selector: (SessionRepository) -> Flow<T>): Flow<T> =
        mutableDelegate.flatMapLatest { delegate ->
            @Suppress("UNCHECKED_CAST")
            (delegate?.let(selector) ?: flowOf(emptyList<Any?>())) as Flow<T>
        }

    override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = current().findPendingApproval(sessionId, approvalId)
    override suspend fun createSession(name: String, tool: String): Session = current().createSession(name, tool)
    override suspend fun createSessionInProject(projectId: String?, name: String, tool: String): Session = current().createSessionInProject(projectId, name, tool)
    override suspend fun setSessionPinned(sessionId: String, pinned: Boolean) = current().setSessionPinned(sessionId, pinned)
    override suspend fun bindAgent(sessionId: String, templateId: String) = current().bindAgent(sessionId, templateId)
    override suspend fun renameSession(sessionId: String, name: String) = current().renameSession(sessionId, name)
    override suspend fun deleteSession(sessionId: String) = current().deleteSession(sessionId)
    override suspend fun compactSession(sessionId: String) = current().compactSession(sessionId)
    override suspend fun dropTools(sessionId: String) = current().dropTools(sessionId)
    override suspend fun forkSession(sessionId: String): Session = current().forkSession(sessionId)
    override suspend fun regenerateMessage(sessionId: String, parentRequestId: String, requestId: String) = current().regenerateMessage(sessionId, parentRequestId, requestId)
    override suspend fun resendEditedMessage(sessionId: String, parentRequestId: String, prompt: String, selection: RuntimeSelection, requestId: String) = current().resendEditedMessage(sessionId, parentRequestId, prompt, selection, requestId)
    override suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String,
        attachments: List<OutboundAttachment>,
    ) = current().resendEditedMessage(sessionId, parentRequestId, prompt, selection, requestId, attachments)
    override suspend fun forkSessionAt(sessionId: String, anchorSeq: Long, mode: String, idempotencyKey: String): Session = current().forkSessionAt(sessionId, anchorSeq, mode, idempotencyKey)
    override suspend fun createProject(name: String, rootPath: String): Project = current().createProject(name, rootPath)
    override suspend fun browseProjectFolders(path: String): ProjectFolderBrowser = current().browseProjectFolders(path)
    override suspend fun createProjectFolder(parentPath: String, name: String): ProjectFolder = current().createProjectFolder(parentPath, name)
    override suspend fun updateProject(projectId: String, name: String?, rootPath: String?): Project = current().updateProject(projectId, name, rootPath)
    override suspend fun deleteProject(projectId: String, deleteSessions: Boolean) = current().deleteProject(projectId, deleteSessions)
    override suspend fun setProjectPinned(projectId: String, pinned: Boolean) = current().setProjectPinned(projectId, pinned)
    override suspend fun refreshComputers() = current().refreshComputers()
    override suspend fun refreshProjects() = current().refreshProjects()
    override suspend fun refreshSessions() = current().refreshSessions()
    override suspend fun refreshEvents(sessionId: String): RefreshResult = current().refreshEvents(sessionId)
    override suspend fun refreshTargetSummary(): TargetSummary? = current().refreshTargetSummary()
    override fun observeTargetSummary(): Flow<TargetSummary?> = delegateFlow { it.observeTargetSummary() }
    override suspend fun refreshTimeline(sessionId: String): RefreshResult = current().refreshTimeline(sessionId)
    override suspend fun loadOlderTimeline(sessionId: String): RefreshResult = current().loadOlderTimeline(sessionId)
    override suspend fun refreshSessionDetail(sessionId: String): Session? = current().refreshSessionDetail(sessionId)
    override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult = current().applyLiveEvents(sessionId, events)
    override fun startLiveSync() {
        mutableDelegate.value?.startLiveSync()
    }
    override fun stopLiveSync() {
        mutableDelegate.value?.stopLiveSync()
    }
    override suspend fun sendMessage(sessionId: String, text: String, requestId: String) = current().sendMessage(sessionId, text, requestId)
    override suspend fun sendMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String?,
        attachments: List<OutboundAttachment>,
        harnessCapabilityIds: List<String>,
    ) = current().sendMessage(sessionId, text, selection, requestId, agentId, attachments, harnessCapabilityIds)
    override suspend fun updateQueuedFollowUp(
        sessionId: String,
        action: QueuedFollowUpAction,
        requestId: String?,
    ): Session? = current().updateQueuedFollowUp(sessionId, action, requestId)
    override suspend fun steerQueuedFollowUp(sessionId: String, requestId: String): QueueMutationResult =
        current().steerQueuedFollowUp(sessionId, requestId)
    override suspend fun updateRuntimeSelection(
        sessionId: String,
        tool: String,
        providerProfile: String?,
        model: String?,
        effort: String?,
        serviceTier: String,
    ) = current().updateRuntimeSelection(sessionId, tool, providerProfile, model, effort, serviceTier)
    override suspend fun loadRuntimeCatalog(): RuntimeCatalog = current().loadRuntimeCatalog()
    override suspend fun loadHarnessCapabilities(
        sessionId: String,
        tool: String?,
        providerProfile: String?,
    ): HarnessCapabilityCatalog = current().loadHarnessCapabilities(sessionId, tool, providerProfile)
    override suspend fun loadSessionRuntimeSelection(sessionId: String): RuntimeSelection? = current().loadSessionRuntimeSelection(sessionId)
    override suspend fun loadGlobalRuntimeSelection(): RuntimeSelection? = current().loadGlobalRuntimeSelection()
    override suspend fun saveGlobalRuntimeSelection(selection: RuntimeSelection) = current().saveGlobalRuntimeSelection(selection)
    override suspend fun cancelSession(sessionId: String) = current().cancelSession(sessionId)
    override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) = current().decideConfirmation(sessionId, confirmationId, decision, requestId)
    override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = current().resolveApproval(runId, batchId, decisionsJson, requestId)
    override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) = current().resolveApprovedActions(sessionId, runId, batchId, approve, requestId)
    override suspend fun resolveApprovedActionBatch(sessionId: String, runId: String, batchId: String, decisions: List<ApprovalActionDecision>, approvalIntent: String, requestId: String) = current().resolveApprovedActionBatch(sessionId, runId, batchId, decisions, approvalIntent, requestId)
    override suspend fun resolveApprovedActionBatchWithProof(sessionId: String, runId: String, batchId: String, decisions: List<ApprovalActionDecision>, approvalIntent: String, webauthnProof: WebAuthnProofDto?, requestId: String) = current().resolveApprovedActionBatchWithProof(sessionId, runId, batchId, decisions, approvalIntent, webauthnProof, requestId)
    override suspend fun createApprovedActionWebAuthnChallenge(runId: String, batchId: String, selectedActionIds: List<String>, requestId: String): JsonObject =
        current().createApprovedActionWebAuthnChallenge(runId, batchId, selectedActionIds, requestId)
    override suspend fun createPrivilegedCategoryWebAuthnChallenge(runId: String, batchId: String, category: String, checkedOpIds: List<String>, requestId: String): JsonObject =
        current().createPrivilegedCategoryWebAuthnChallenge(runId, batchId, category, checkedOpIds, requestId)
    override suspend fun resolvePrivilegedCategory(sessionId: String, runId: String, batchId: String, category: String, checkedOpIds: List<String>, webauthnProof: WebAuthnProofDto?, requestId: String) =
        current().resolvePrivilegedCategory(sessionId, runId, batchId, category, checkedOpIds, webauthnProof, requestId)
    override suspend fun resolveRuntimeApproval(runId: String, approvalId: String, decision: String, choices: List<String>, customAnswer: String?, requestId: String) = current().resolveRuntimeApproval(runId, approvalId, decision, choices, customAnswer, requestId)
    override suspend fun resolveRuntimeApprovalWithAnswers(runId: String, approvalId: String, choices: List<String>, customAnswers: List<String>, requestId: String) =
        current().resolveRuntimeApprovalWithAnswers(runId, approvalId, choices, customAnswers, requestId)
    override suspend fun resolveRuntimeApprovalWithMultiChoices(runId: String, approvalId: String, multiChoices: List<List<Int>>, customAnswers: List<String>, requestId: String) =
        current().resolveRuntimeApprovalWithMultiChoices(runId, approvalId, multiChoices, customAnswers, requestId)
    override suspend fun updateSessionGoal(sessionId: String, goal: String?, autoContinue: Boolean) = current().updateSessionGoal(sessionId, goal, autoContinue)
    override suspend fun submitPlanAction(sessionId: String, planId: String, action: String, text: String, requestId: String): JsonObject =
        current().submitPlanAction(sessionId, planId, action, text, requestId)
    override suspend fun loadRunProjection(runId: String): JsonObject = current().loadRunProjection(runId)
    override suspend fun resumePendingOperations(): Int = current().resumePendingOperations()
    override suspend fun pendingApprovalIds(sessionId: String, approvalIds: List<String>): Set<String> =
        current().pendingApprovalIds(sessionId, approvalIds)
    override suspend fun resumePendingApproval(sessionId: String, approvalId: String): Int =
        current().resumePendingApproval(sessionId, approvalId)

    private fun current(): SessionRepository = mutableDelegate.value
        ?: error("No remote computer target is selected")

    private fun <T> delegateFlow(selector: (SessionRepository) -> Flow<T>): Flow<T> = mutableDelegate
        .flatMapLatest { it?.let(selector) ?: emptyFlow() }
}
