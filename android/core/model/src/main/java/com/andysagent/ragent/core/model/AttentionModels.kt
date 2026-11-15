package com.andysagent.ragent.core.model

/**
 * Cross-session attention items projected from Room facts for the global
 * attention surface. The models and reducer stay protocol-agnostic: identity
 * keys use server-projected approval ids and session status, never FCM payload
 * guesses. Approval actionability is still owned by the repository/server.
 */
enum class AttentionKind {
    Approval,
    Question,
    Plan,
    Completion,
    Failure,
}

data class AttentionItem(
    /** Stable identity key; identical keys collapse into one surface entry. */
    val id: String,
    val sessionId: String,
    val sessionTitle: String,
    val kind: AttentionKind,
    val title: String,
    val summary: String,
    val reason: String? = null,
    val priority: Int = PRIORITY_NORMAL,
    /** Present for approval items; the surface never mutates it directly. */
    val approval: Approval? = null,
    val runId: String? = null,
    val batchId: String? = null,
    val updatedAt: Long = 0L,
    /** True when the item must be resolved inside its session (batch/passkey). */
    val requiresSession: Boolean = false,
) {
    val isApproval: Boolean get() = approval != null

    companion object {
        const val PRIORITY_DANGEROUS = 0
        const val PRIORITY_NORMAL = 1
        const val PRIORITY_FAILURE = 2
        const val PRIORITY_COMPLETION = 3
    }
}

data class AttentionUiState(
    val items: List<AttentionItem> = emptyList(),
    val activeItemId: String? = null,
    val expanded: Boolean = false,
    /** The Session the user is currently reading; its items never surface globally. */
    val visibleSessionId: String? = null,
    val resolvingItemId: String? = null,
    val dismissedItemIds: Set<String> = emptySet(),
    val error: String? = null,
) {
    val activeItem: AttentionItem? get() = items.firstOrNull { it.id == activeItemId }
    val queuedCount: Int get() = (items.size - 1).coerceAtLeast(0)
}

/**
 * Pure projection helpers: build the deduplicated, prioritized queue from Room
 * facts and fold it into display state. No Android or I/O dependencies so the
 * ordering and identity rules stay unit-testable.
 */
object AttentionReducer {

    const val WINDOWS_BROKER_APPROVAL_KIND = "windows_broker_approval"

    fun approvalItemId(sessionId: String, approvalId: String): String = "approval:$sessionId:$approvalId"

    fun sessionItemId(sessionId: String, marker: String): String = "$marker:$sessionId"

    /**
     * Projects sessions plus globally pending approvals into attention items.
     * Each pending approval remains independently reachable. A session with no
     * pending approval can instead contribute its waiting/failed/completed status.
     * Ordinary running progress never becomes a global interruption.
     */
    fun project(sessions: List<Session>, approvals: List<Approval>): List<AttentionItem> {
        val pendingBySession = withoutBatchApprovalShadows(approvals)
            .filter { it.status == "pending" }
            .groupBy { it.sessionId }
        val items = ArrayList<AttentionItem>(sessions.size)
        for (session in sessions) {
            val pending = pendingBySession[session.id].orEmpty()
            if (pending.isNotEmpty()) {
                items += pending.map { approval -> approvalItem(session, approval) }
                continue
            }
            statusItem(session)?.let { items += it }
        }
        return items.sortedWith(COMPARATOR)
    }

    /** Broker challenges are independent of the session approval endpoint but share its in-app attention surface. */
    fun projectBrokerApprovals(approvals: List<Approval>): List<AttentionItem> = approvals
        .filter { it.status == "pending" && it.kind == WINDOWS_BROKER_APPROVAL_KIND }
        .map { approval ->
            approvalItem(
                sessionId = approval.sessionId,
                sessionTitle = "Windows Broker",
                updatedAt = 0L,
                approval = approval,
            ).copy(id = "windows-broker:${approval.brokerTargetInstanceId ?: "unbound"}:${approval.id}:${approval.brokerChallengeDigest ?: "unbound"}")
        }

    private fun approvalItem(session: Session, approval: Approval): AttentionItem {
        return approvalItem(session.id, session.title, session.updatedAt, approval)
    }

    private fun approvalItem(
        sessionId: String,
        sessionTitle: String,
        updatedAt: Long,
        approval: Approval,
    ): AttentionItem {
        val dangerous = approval.isDangerous()
        val kind = when {
            approval.kind.equals("question", ignoreCase = true) || approval.questions.isNotEmpty() -> AttentionKind.Question
            approval.kind == "plan" || approval.kind == "plan_approval" || approval.requestKind == "plan" -> AttentionKind.Plan
            else -> AttentionKind.Approval
        }
        val summary = if (approval.kind == WINDOWS_BROKER_APPROVAL_KIND) {
            approval.title
        } else {
            approval.reason?.takeIf { it.isNotBlank() } ?: approval.title
        }
        return AttentionItem(
            id = approvalItemId(sessionId, approval.id),
            sessionId = sessionId,
            sessionTitle = sessionTitle,
            kind = kind,
            title = approval.title,
            summary = summary,
            reason = approval.reason,
            priority = if (dangerous) AttentionItem.PRIORITY_DANGEROUS else AttentionItem.PRIORITY_NORMAL,
            approval = approval,
            runId = approval.runId,
            batchId = approval.batchId,
            updatedAt = updatedAt,
            // Batch and passkey resolutions stay inside the session's structured
            // card; the surface never reimplements that protocol.
            // Supported batch formats have their own structured decision
            // endpoints and can request native passkey verification inline.
            requiresSession = approval.kind != WINDOWS_BROKER_APPROVAL_KIND && (
                (approval.kind == "privileged_batch_request" && (approval.runId.isNullOrBlank() || approval.batchId.isNullOrBlank() ||
                    approval.actions.none { it.category in setOf("privileged_other", "destructive_delete") })) ||
                (approval.batchId != null && approval.actions.isEmpty()) ||
                (approval.kind == "approved_action_batch_request" && (approval.runId.isNullOrBlank() || approval.batchId.isNullOrBlank())) ||
                (approval.kind !in setOf("privileged_batch_request", "approved_action_batch_request") && approval.actions.isNotEmpty()) ||
                (approval.actions.isEmpty() && approval.passkeyRequired && !approval.isQuestionApproval())
            ),
        )
    }

    private fun statusItem(session: Session): AttentionItem? {
        val waitingReply = session.waitingAction == "reply" &&
            (session.status == SessionStatus.WaitingApproval || session.workflowState.equals("waiting_user", ignoreCase = true))
        return when {
            session.status == SessionStatus.WaitingApproval && !waitingReply -> AttentionItem(
                id = sessionItemId(session.id, "waiting"),
                sessionId = session.id,
                sessionTitle = session.title,
                kind = AttentionKind.Approval,
                title = session.title,
                summary = WAITING_SUMMARY,
                priority = AttentionItem.PRIORITY_NORMAL,
                updatedAt = session.workflowStateChangedAt ?: session.updatedAt,
                requiresSession = true,
            )
            waitingReply -> AttentionItem(
                id = sessionItemId(session.id, "waiting"),
                sessionId = session.id,
                sessionTitle = session.title,
                kind = AttentionKind.Question,
                title = session.title,
                summary = QUESTION_SUMMARY,
                priority = AttentionItem.PRIORITY_NORMAL,
                updatedAt = session.workflowStateChangedAt ?: session.updatedAt,
                requiresSession = true,
            )
            session.status == SessionStatus.Failed -> AttentionItem(
                id = sessionItemId(session.id, "failure"),
                sessionId = session.id,
                sessionTitle = session.title,
                kind = AttentionKind.Failure,
                title = session.title,
                summary = FAILURE_SUMMARY,
                priority = AttentionItem.PRIORITY_FAILURE,
                updatedAt = session.updatedAt,
                requiresSession = true,
            )
            session.status == SessionStatus.Completed -> {
                // Stale completed runs stop being news once the freshness
                // window passes; failures keep demanding attention until the
                // session leaves the failed state.
                if (!isFresh(session.updatedAt)) return null
                AttentionItem(
                    id = sessionItemId(session.id, "completion"),
                    sessionId = session.id,
                    sessionTitle = session.title,
                    kind = AttentionKind.Completion,
                    title = session.title,
                    summary = COMPLETION_SUMMARY,
                    priority = AttentionItem.PRIORITY_COMPLETION,
                    updatedAt = session.updatedAt,
                    requiresSession = true,
                )
            }
            else -> null
        }
    }

    private fun Approval.isDangerous(): Boolean {
        val risk = riskLevel?.lowercase()
        if (risk != null && (risk.contains("danger") || risk.contains("privileged") || risk.contains("destructive"))) return true
        return actions.any { it.needsPasskey } || (passkeyRequired && !isQuestionApproval())
    }

    private fun Approval.isQuestionApproval(): Boolean = kind.equals("question", ignoreCase = true) || questions.isNotEmpty()

    private fun isFresh(epochMs: Long): Boolean =
        epochMs <= 0L || java.lang.System.currentTimeMillis() - epochMs < COMPLETION_FRESHNESS_MS

    /**
     * Folds freshly projected items into the display state:
     * identical ids collapse, the visible session is filtered out, dismissed
     * items stay hidden until their fact disappears, and ordering is stable.
     */
    fun reduce(current: AttentionUiState, items: List<AttentionItem>): AttentionUiState {
        val visible = current.visibleSessionId
        val displayed = items
            .distinctBy { it.id }
            .filter { it.sessionId != visible || it.approval?.kind == WINDOWS_BROKER_APPROVAL_KIND }
            .filter { it.id !in current.dismissedItemIds }
            .sortedWith(COMPARATOR)
        val liveIds = items.mapTo(HashSet()) { it.id }
        // A dismissed fact that no longer exists server-side must not keep
        // suppressing a future re-occurrence of the same session marker.
        val dismissed = current.dismissedItemIds.filterTo(HashSet()) { it in liveIds }
        val activeItemId = current.activeItemId
            ?.takeIf { id -> displayed.any { it.id == id } }
            ?: displayed.firstOrNull()?.id
        return current.copy(
            items = displayed,
            activeItemId = activeItemId,
            dismissedItemIds = dismissed,
            resolvingItemId = current.resolvingItemId?.takeIf { id -> displayed.any { it.id == id } },
        )
    }

    private val COMPARATOR = compareBy<AttentionItem> { it.priority }
        .thenByDescending { it.updatedAt }
        .thenBy { it.id }

    const val WAITING_SUMMARY = "等待你处理一个执行请求"
    const val QUESTION_SUMMARY = "有一个问题等待你的回答"
    const val FAILURE_SUMMARY = "运行失败，需要人工处理"
    const val COMPLETION_SUMMARY = "任务已完成"

    /** Completed sessions older than this stay in the session list, not the overlay. */
    const val COMPLETION_FRESHNESS_MS = 10L * 60L * 1000L
}

/** A provider approval represented by a structured batch must not offer a second, ungated decision. */
fun withoutBatchApprovalShadows(approvals: List<Approval>): List<Approval> {
    val batches = approvals.filter { it.status == "pending" && it.kind in setOf("privileged_batch_request", "approved_action_batch_request") }
    return approvals.filterNot { approval ->
        if (approval.status != "pending" || approval.kind != "approval_request") return@filterNot false
        val ids = approval.identityAliases + approval.id
        batches.any { batch ->
            if (batch.sessionId != approval.sessionId ||
                (batch.runId != null && approval.runId != null && batch.runId != approval.runId)) return@any false
            val batchIds = batch.identityAliases + batch.id + batch.batchId.orEmpty() +
                batch.actions.flatMap { listOf(it.id) + it.identityAliases }
            ids.any { it.isNotBlank() && it in batchIds }
        }
    }
}
