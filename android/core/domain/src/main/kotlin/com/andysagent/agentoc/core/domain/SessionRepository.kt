package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.RuntimeModelOption
import com.andysagent.agentoc.core.model.RuntimeProviderOption
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.TargetSummary
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject

/** Fresh PC resource scope; never reconstructed from display/cache fallback fields. */
data class SessionAccessContext(val sessionId: String, val projectId: String?)
/** Exact response metadata for read-only external projections; contains no history or paths. */
data class SessionMetadataSnapshot(val sessionId: String, val title: String, val projectId: String?,
    val state: String, val updatedAt: String?)

data class SessionInvalidation(
    val type: String,
    val sessionId: String? = null,
    val events: List<SessionEventDto> = emptyList(),
)

data class RuntimeSelection(
    val tool: String,
    val providerProfile: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String = "standard",
    val interactionMode: String = "agent",
    val permissionMode: String? = null,
    val planAction: String? = null,
    val planId: String? = null,
)

data class TimelinePagingState(
    val loadingOlder: Boolean = false,
    val hasOlder: Boolean = false,
    val nextBeforeSeq: Long? = null,
    val latestSeq: Long = 0L,
    val error: String? = null,
)

enum class QueuedFollowUpAction(val wireValue: String) {
    Delete("delete"),
    TruncateFrom("truncate_from"),
    Clear("clear"),
}

data class QueueMutationResult(
    val session: Session?,
    val requestId: String? = null,
    val steered: Boolean = false,
    val pendingCancel: Boolean = false,
    val interruptedRunId: String? = null,
    val queued: Boolean = false,
)

/** A local file to publish, or an existing server asset to reuse. */
data class OutboundAttachment(
    val contentUri: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long = 0L,
    val renderAsFile: Boolean = false,
    val assetId: String? = null,
)

/** Transient per-message attachment transfer progress, measured in bytes written by the transport. */
data class AttachmentUploadProgress(
    val sessionId: String,
    val phase: FileUploadPhase,
    val transferredBytes: Long,
    val totalBytes: Long,
) {
    init {
        require(sessionId.isNotBlank())
        require(totalBytes > 0)
        require(transferredBytes in 0..totalBytes)
    }
    val fraction: Float get() = transferredBytes.toFloat() / totalBytes.toFloat()
}

/** A directory exposed by the connected computer's folder browser. */
data class ProjectFolder(
    val path: String,
    val name: String,
)

/** The current directory, its parent, and the direct child folders. */
data class ProjectFolderBrowser(
    val path: String,
    val parentPath: String? = null,
    val children: List<ProjectFolder> = emptyList(),
)

class SessionRepositoryException(
    val statusCode: Int,
    val code: String?,
    override val message: String,
    val retryable: Boolean,
    cause: Throwable? = null,
) : RuntimeException(message, cause)

interface SessionRepository {
    val runtimeTargetId: String? get() = null
    val connectionState: StateFlow<RuntimeConnectionState>
    val invalidations: Flow<SessionInvalidation>
    val requiresLiveSync: Boolean get() = false
    fun observeComputers(): Flow<List<Computer>>
    fun observeProjects(): Flow<List<Project>>
    fun observeSessions(): Flow<List<Session>>
    fun observeSession(sessionId: String): Flow<Session?>
    fun observeMessages(sessionId: String): Flow<List<Message>>
    fun observeTimeline(sessionId: String): Flow<List<TimelineItem>>
    /** Current transient upload progress keyed by the message request id. */
    fun observeAttachmentUploadProgress(sessionId: String): Flow<Map<String, AttachmentUploadProgress>> =
        kotlinx.coroutines.flow.flowOf(emptyMap())
    /** Canonical action projection shared with the Web live activity strip. */
    fun observeRunActivity(sessionId: String): Flow<JsonObject?> = kotlinx.coroutines.flow.flowOf(null)
    fun observeRunDurations(sessionId: String): Flow<Map<String, Long>> = kotlinx.coroutines.flow.flowOf(emptyMap())
    suspend fun saveRunDuration(sessionId: String, runId: String, durationMs: Long) {}
    fun observeTimelinePaging(sessionId: String): Flow<TimelinePagingState> =
        kotlinx.coroutines.flow.flowOf(TimelinePagingState())
    fun observePendingApprovals(sessionId: String): Flow<List<Approval>>
    /** Cross-session pending approvals for the active computer's attention surface. */
    fun observeAllPendingApprovals(): Flow<List<Approval>> = kotlinx.coroutines.flow.flowOf(emptyList())
    suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval?
    suspend fun createSession(name: String = "New session", tool: String = "codex"): Session
    /** Caller journals/retries this request; the legacy pending queue does not own it. */
    suspend fun createSessionIdempotent(
        request: com.andysagent.agentoc.core.protocol.CreateSessionRequestDto,
        idempotencyKey: String,
    ): SessionCreationReceipt = error("Idempotent session creation is not supported by this repository")
    /** Caller journals/retries this request and receives the actual PC acknowledgement. */
    suspend fun submitMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String? = null,
        attachments: List<com.andysagent.agentoc.core.protocol.AttachmentItemDto> = emptyList(),
    ): MessageSubmissionReceipt = error("Message submission receipts are not supported by this repository")
    /** Read-only retained evidence, including after a submission deadline. Never sends a message. */
    suspend fun findMessageSubmissionReceipt(sessionId: String, requestId: String): MessageSubmissionReceipt? =
        error("Read-only receipt lookup is not supported by this repository")
    suspend fun createSessionInProject(
        projectId: String?,
        name: String = "New session",
        tool: String = "codex",
    ): Session = createSession(name, tool)
    /** Applies the server-owned Agent/template binding where the Web contract allows it. */
    suspend fun bindAgent(sessionId: String, templateId: String) {}
    suspend fun renameSession(sessionId: String, name: String) {
        error("Renaming sessions is not supported by this repository")
    }
    suspend fun deleteSession(sessionId: String) {
        error("Deleting sessions is not supported by this repository")
    }
    suspend fun setSessionPinned(sessionId: String, pinned: Boolean) {
        error("Pinning sessions is not supported by this repository")
    }
    /** Stamps the owner review cursor that focus/attention lists use as the read marker. */
    suspend fun markSessionReviewed(sessionId: String) {}
    suspend fun compactSession(sessionId: String) {
        error("Compacting sessions is not supported by this repository")
    }
    suspend fun dropTools(sessionId: String) {
        error("Dropping tool results is not supported by this repository")
    }
    suspend fun forkSession(sessionId: String): Session {
        error("Forking sessions is not supported by this repository")
    }
    /** Re-runs a completed assistant reply using the Web version-rail contract. */
    suspend fun regenerateMessage(sessionId: String, parentRequestId: String, requestId: String = newRequestId()) {
        error("Regenerating messages is not supported by this repository")
    }
    /** Replaces a completed user turn and re-runs it using a fresh provider thread. */
    suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String = newRequestId(),
    ) {
        error("Edited message resend is not supported by this repository")
    }

    /**
     * Replaces a completed user turn and publishes a new attachment set.  The
     * overload keeps older repository fakes source-compatible while production
     * repositories can run the same upload transaction used by sendMessage.
     */
    suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String = newRequestId(),
        attachments: List<OutboundAttachment> = emptyList(),
    ) {
        if (attachments.isEmpty()) {
            resendEditedMessage(sessionId, parentRequestId, prompt, selection, requestId)
        } else {
            error("Edited message resend with attachments is not supported by this repository")
        }
    }
    /** Creates a branch anchored at the selected historical message/event. */
    suspend fun forkSessionAt(
        sessionId: String,
        anchorSeq: Long,
        mode: String,
        idempotencyKey: String = newRequestId(),
    ): Session {
        error("Fork-at is not supported by this repository")
    }
    suspend fun createProject(name: String, rootPath: String): Project
    /**
     * Lists folders on the connected computer for the project picker.  The
     * browser is intentionally separate from workspace-file reads because a
     * project has not been created yet and therefore has no workspace root.
     */
    suspend fun browseProjectFolders(path: String = "~"): ProjectFolderBrowser {
        error("Project folder browsing is not supported by this repository")
    }
    suspend fun createProjectFolder(parentPath: String, name: String): ProjectFolder {
        error("Creating project folders is not supported by this repository")
    }
    suspend fun updateProject(projectId: String, name: String? = null, rootPath: String? = null): Project {
        error("Updating projects is not supported by this repository")
    }
    suspend fun setProjectPinned(projectId: String, pinned: Boolean) {
        throw UnsupportedOperationException("Project pinning is not supported")
    }
    suspend fun deleteProject(projectId: String, deleteSessions: Boolean = false) {
        error("Deleting projects is not supported by this repository")
    }
    suspend fun refreshComputers()
    suspend fun refreshProjects()
    suspend fun refreshSessions()
    suspend fun refreshEvents(sessionId: String): RefreshResult
    /** Refreshes the selected target's small cross-device summary projection. */
    suspend fun refreshTargetSummary(): TargetSummary? = null
    fun observeTargetSummary(): Flow<TargetSummary?> = kotlinx.coroutines.flow.flowOf(null)
    suspend fun refreshTimeline(sessionId: String): RefreshResult = refreshEvents(sessionId)
    suspend fun loadOlderTimeline(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0L)
    /** Refreshes the detail projection, including the server-owned follow-up queue. */
    suspend fun refreshSessionDetail(sessionId: String): Session? = null
    /** Exact response identity and project scope, without persisting or reading cached fields. */
    suspend fun readSessionAccessContext(sessionId: String): SessionAccessContext? =
        throw SessionRepositoryException(501, "SESSION_SCOPE_UNSUPPORTED", "Authoritative Session scope is unsupported", false)
    suspend fun readSessionMetadataList(): List<SessionMetadataSnapshot> =
        throw SessionRepositoryException(501, "SESSION_METADATA_UNSUPPORTED", "Session metadata is unsupported", false)
    suspend fun readSessionMetadata(sessionId: String): SessionMetadataSnapshot? =
        throw SessionRepositoryException(501, "SESSION_METADATA_UNSUPPORTED", "Session metadata is unsupported", false)
    suspend fun readSessionMutationProtocol(): SessionMutationProtocol =
        throw SessionRepositoryException(501, "SESSION_MUTATION_UNSUPPORTED", "Session mutations are unsupported", false)
    suspend fun readSessionMutationContext(sessionId: String): SessionMutationContext =
        throw SessionRepositoryException(501, "SESSION_MUTATION_UNSUPPORTED", "Session mutations are unsupported", false)
    suspend fun applySessionMutation(sessionId: String, command: SessionMutationCommand): SessionMutationReceipt =
        throw SessionRepositoryException(501, "SESSION_MUTATION_UNSUPPORTED", "Session mutations are unsupported", false)
    suspend fun readSessionMutationReceipt(sessionId: String, requestId: String): SessionMutationReceipt? =
        throw SessionRepositoryException(501, "SESSION_MUTATION_UNSUPPORTED", "Session mutations are unsupported", false)
    suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult
    /** Starts foreground-only reconciliation for endpoint-less carriers. */
    fun startLiveSync() {}
    fun stopLiveSync() {}
    /** Terminal repository teardown; wait for owned jobs before its database closes. */
    suspend fun close() { stopLiveSync() }
    suspend fun sendMessage(sessionId: String, text: String, requestId: String = newRequestId())
    suspend fun sendMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String = newRequestId(),
        agentId: String? = null,
        attachments: List<OutboundAttachment> = emptyList(),
    ) = sendMessage(sessionId, text, requestId)
    suspend fun updateQueuedFollowUp(
        sessionId: String,
        action: QueuedFollowUpAction,
        requestId: String? = null,
    ): Session? {
        error("Queued follow-up mutations are not supported by this repository")
    }
    suspend fun steerQueuedFollowUp(sessionId: String, requestId: String): QueueMutationResult {
        error("Queued follow-up steering is not supported by this repository")
    }
    suspend fun loadRuntimeCatalog(): RuntimeCatalog = RuntimeCatalog()
    suspend fun loadRuntimeProviders(tool: String): List<RuntimeProviderOption> = emptyList()
    suspend fun loadRuntimeModels(tool: String, providerProfile: String): List<RuntimeModelOption> = emptyList()
    suspend fun loadSessionRuntimeSelection(sessionId: String): RuntimeSelection? = null
    suspend fun loadGlobalRuntimeSelection(): RuntimeSelection? = null
    suspend fun saveGlobalRuntimeSelection(selection: RuntimeSelection) {}
    suspend fun updateRuntimeSelection(
        sessionId: String,
        tool: String,
        providerProfile: String?,
        model: String?,
        effort: String?,
        serviceTier: String,
    ) {}
    suspend fun cancelSession(sessionId: String)
    suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String = newRequestId())
    suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String = newRequestId())
    suspend fun resolveApprovedActions(
        sessionId: String,
        runId: String,
        batchId: String,
        approve: Boolean,
        requestId: String = newRequestId(),
    )

    /**
     * Resolves an approved-action batch with the exact per-action decisions
     * selected by the owner. Implementations that have not migrated their
     * transport can fall back to the legacy all-or-nothing operation.
     */
    suspend fun resolveApprovedActionBatch(
        sessionId: String,
        runId: String,
        batchId: String,
        decisions: List<ApprovalActionDecision>,
        approvalIntent: String = "approve",
        requestId: String = newRequestId(),
    ) {
        resolveApprovedActions(
            sessionId = sessionId,
            runId = runId,
            batchId = batchId,
            approve = approvalIntent == "approve",
            requestId = requestId,
        )
    }

    suspend fun resolveApprovedActionBatchWithProof(
        sessionId: String,
        runId: String,
        batchId: String,
        decisions: List<ApprovalActionDecision>,
        approvalIntent: String = "approve",
        webauthnProof: WebAuthnProofDto? = null,
        requestId: String = newRequestId(),
    ) {
        require(webauthnProof == null) { "This repository cannot submit a passkey proof" }
        resolveApprovedActionBatch(sessionId, runId, batchId, decisions, approvalIntent, requestId)
    }

    /** Returns the server challenge that must be satisfied by a native passkey. */
    suspend fun createApprovedActionWebAuthnChallenge(
        runId: String,
        batchId: String,
        selectedActionIds: List<String>,
        requestId: String = newRequestId(),
    ): JsonObject {
        error("Approved-action WebAuthn is not supported by this repository")
    }

    /** Returns the server challenge for one privileged batch category. */
    suspend fun createPrivilegedCategoryWebAuthnChallenge(
        runId: String,
        batchId: String,
        category: String,
        checkedOpIds: List<String>,
        requestId: String = newRequestId(),
    ): JsonObject {
        error("Privileged WebAuthn is not supported by this repository")
    }

    suspend fun resolvePrivilegedCategory(
        sessionId: String,
        runId: String,
        batchId: String,
        category: String,
        checkedOpIds: List<String>,
        webauthnProof: WebAuthnProofDto? = null,
        requestId: String = newRequestId(),
    ) {
        error("Privileged category approval is not supported by this repository")
    }
    suspend fun resolveRuntimeApproval(
        runId: String,
        approvalId: String,
        decision: String,
        choices: List<String> = emptyList(),
        customAnswer: String? = null,
        requestId: String = newRequestId(),
    )
    /** Uses an explicit decision understood only by servers that preserve per-question answers. */
    suspend fun resolveRuntimeApprovalWithAnswers(
        runId: String,
        approvalId: String,
        choices: List<String>,
        customAnswers: List<String>,
        requestId: String = newRequestId(),
    ) { error("Per-question approval answers are not supported by this repository") }
    suspend fun resolveRuntimeApprovalWithMultiChoices(
        runId: String, approvalId: String, multiChoices: List<List<Int>>, customAnswers: List<String>,
        requestId: String = newRequestId(),
    ) { error("Multiple-choice approval answers are not supported by this repository") }
    suspend fun updateSessionGoal(sessionId: String, goal: String?, autoContinue: Boolean = false) {}
    /** Submits a server-owned plan artifact action; never encodes the action as chat text. */
    suspend fun submitPlanAction(
        sessionId: String,
        planId: String,
        action: String,
        text: String = "",
        requestId: String = newRequestId(),
    ): JsonObject {
        error("Plan actions are not supported by this repository")
    }
    /** Read-only retained result for this exact submission; no dispatch or Run reconciliation. */
    suspend fun loadMessageResult(sessionId: String, requestId: String): JsonObject {
        error("Message result lookup is not supported by this repository")
    }

    /** Fetches the server-owned run projection used by the Run Sheet. */
    suspend fun loadRunProjection(runId: String): JsonObject {
        error("Run projections are not supported by this repository")
    }
    suspend fun resumePendingOperations(): Int
}

sealed interface RefreshResult {
    data class Applied(val count: Int, val latestSeq: Long) : RefreshResult
    data class Gap(val expectedSeq: Long, val receivedSeq: Long) : RefreshResult
    data class ResetRequired(val reason: String?) : RefreshResult
}

fun newRequestId(): String = "android:${java.util.UUID.randomUUID()}"
