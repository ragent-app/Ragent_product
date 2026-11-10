package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.Immutable
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.domain.AttachmentUploadProgress
import com.andysagent.agentoc.core.timeline.FileChangeItem
import com.andysagent.agentoc.core.timeline.PlanStepItem
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import com.andysagent.agentoc.core.timeline.TimelineRole
import com.andysagent.agentoc.core.timeline.latestTurnRunId

/**
 * Representation of a user prompt within a Turn.
 */
@Immutable
data class TurnUserPrompt(
    val id: String,
    val text: String,
    val attachments: List<ComposerAttachment> = emptyList(),
    val attachmentUploadProgress: AttachmentUploadProgress? = null,
    val timestamp: String? = null,
    val isPending: Boolean = false,
    val isSending: Boolean = false,
    val pendingFailed: Boolean = false,
    val pendingError: String? = null,
    val seq: Long = 0L,
    val requestId: String? = null,
)

/**
 * Summary of operations (tools, commands, file edits) executed within a Turn.
 */
@Immutable
data class TurnOperationSummary(
    val totalCount: Int,
    val runningCount: Int,
    val failedCount: Int,
    val isWorking: Boolean,
    val summaryText: String,
    val operations: List<TimelineItem.Operation> = emptyList(),
)

/**
 * A cohesive TurnGroup representing one full round of interaction.
 *
 * User Request
 *  ├─ Agent Current Summary (in-progress activity)
 *  ├─ Plan & Steps (collapsible)
 *  ├─ Tool Process (default collapsed)
 *  ├─ Files / Tests / Artifacts
 *  └─ Agent Final Answer
 */
@Immutable
data class TurnGroup(
    val id: String,
    val requestId: String? = null,
    val runId: String? = null,
    val userPrompt: TurnUserPrompt? = null,
    val agentSummary: String? = null,
    val plans: List<TimelineItem.Plan> = emptyList(),
    val operationSummary: TurnOperationSummary? = null,
    val fileChanges: List<FileChangeItem> = emptyList(),
    val notices: List<TimelineItem.Notice> = emptyList(),
    /** Ordered distinct assistant messages; a turn is not a single replacement answer. */
    val agentMessages: List<TimelineItem.Message> = emptyList(),
    val finalAnswer: TimelineItem.Message? = null,
    val streamingAnswer: TimelineItem.Message? = null,
    val isLive: Boolean = false,
    /** Chronological entries; grouping must never reorder messages around tools. */
    val entries: List<TimelineItem> = emptyList(),
)

internal fun latestTimelineRunId(items: List<TimelineItem>): String? = latestTurnRunId(items) ?: items.asReversed().firstNotNullOfOrNull { item ->
    when (item) {
        is TimelineItem.Message -> item.runId
        is TimelineItem.Operation -> item.runId
        is TimelineItem.Plan -> item.runId
        is TimelineItem.Notice -> null
    }?.takeIf(String::isNotBlank)
}

internal fun shouldAcceptRunProjection(current: RunMetricsUiState, runId: String, incoming: AgentRunStatus?): Boolean {
    val terminal = setOf(AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled)
    return current.runId != runId || current.status !in terminal || incoming in terminal
}

internal fun latestTurnHasTerminalRun(items: List<TimelineItem>, pending: PendingTurnUiState?,
    sessionStatus: AgentRunStatus, metrics: RunMetricsUiState): Boolean {
    if (pending?.state == PendingTurnState.Sending || pending?.state == PendingTurnState.Accepted) return false
    val terminal = setOf(AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled)
    val runId = latestTurnRunId(items)
    val matchingRun = runId != null && runId == metrics.runId && metrics.status in terminal
    return sessionStatus in terminal || matchingRun
}

/** Preserve explicit final phases; at terminal state, recover a missing final phase from the last completed reply. */
internal fun splitTurnEntries(
    entries: List<TimelineItem>,
    allowTerminalFallback: Boolean = false,
): Pair<List<TimelineItem>, List<TimelineItem>> {
    val explicitIndex = entries.indexOfFirst {
        it is TimelineItem.Message && it.role == TimelineRole.Agent && it.messagePhase == "final_answer"
    }
    val finalIndex = if (explicitIndex >= 0) explicitIndex else if (allowTerminalFallback) {
        val last = entries.indexOfLast { it !is TimelineItem.Notice }
        val reply = entries.getOrNull(last) as? TimelineItem.Message
        if (reply?.let {
                it.role == TimelineRole.Agent && it.completed &&
                    it.messagePhase?.lowercase() in setOf(null, "commentary")
            } == true
        ) last else -1
    } else -1
    if (finalIndex < 0) return emptyList<TimelineItem>() to entries
    return entries.take(finalIndex) to entries.drop(finalIndex)
}

internal fun activeRunTurnIndex(turns: List<TurnGroup>, runId: String?, requestId: String?): Int {
    val match = turns.indexOfLast { turn ->
        (!runId.isNullOrBlank() && turn.runId == runId) ||
            (!requestId.isNullOrBlank() && turn.requestId == requestId)
    }
    return if (match >= 0) match else turns.lastIndex
}

/**
 * Projector that groups sequential timeline items and pending turns into
 * cohesive, well-ordered TurnGroups by requestId/runId.
 */
class TurnGroupProjector {

    private var previousItems: List<TimelineItem> = emptyList()
    private var previousTurnGroups: List<TurnGroup> = emptyList()

    fun project(
        items: List<TimelineItem>,
        pendingTurn: PendingTurnUiState? = null,
        acceptedTurns: List<PendingTurnUiState> = emptyList(),
    ): List<TurnGroup> {
        if (items.isEmpty() && pendingTurn == null && acceptedTurns.isEmpty()) {
            previousItems = emptyList()
            previousTurnGroups = emptyList()
            return emptyList()
        }

        val durableRequestIds = items.filterIsInstance<TimelineItem.Message>()
            .filter { it.role == TimelineRole.User }.mapNotNull { it.requestId }.toSet()
        val local = (acceptedTurns + listOfNotNull(pendingTurn)).distinctBy { it.requestId }
            .filterNot { it.requestId in durableRequestIds }
        val localByRequest = local.associateBy { it.requestId }
        val injected = mutableSetOf<String>()
        val ordered = buildList {
            for (item in items) {
                val reply = item as? TimelineItem.Message
                val localTurn = reply?.takeIf { it.role == TimelineRole.Agent }?.requestId?.let(localByRequest::get)
                if (localTurn != null && injected.add(localTurn.requestId)) {
                    add(TimelineItem.Message("pending-${localTurn.requestId}", item.seq, TimelineRole.User,
                        localTurn.text, true, requestId = localTurn.requestId, runId = reply.runId))
                }
                add(item)
            }
        }
        val durableTurns = buildTurnGroups(ordered, localByRequest)
        val finalTurns = durableTurns + local.filterNot { it.requestId in injected }.map(::createPendingTurnGroup)

        previousItems = items
        previousTurnGroups = finalTurns
        return finalTurns
    }

    private fun createPendingTurnGroup(pending: PendingTurnUiState): TurnGroup {
        val userPrompt = TurnUserPrompt(
            id = "pending-${pending.requestId}",
            text = pending.text,
            attachments = pending.attachments,
            attachmentUploadProgress = pending.attachmentUploadProgress,
            isPending = true,
            isSending = pending.state == PendingTurnState.Sending,
            pendingFailed = pending.state == PendingTurnState.Failed,
            pendingError = pending.error,
            requestId = pending.requestId,
        )
        return TurnGroup(
            id = "turn-pending-${pending.requestId}",
            requestId = pending.requestId,
            userPrompt = userPrompt,
            isLive = pending.state == PendingTurnState.Sending,
        )
    }

    private fun buildTurnGroups(items: List<TimelineItem>, localByRequest: Map<String, PendingTurnUiState>): List<TurnGroup> {
        val groups = mutableListOf<TurnGroup>()

        var currentRequestId: String? = null
        var currentRunId: String? = null
        var currentUserPrompt: TurnUserPrompt? = null
        var currentAgentSummary: String? = null
        val currentPlans = mutableListOf<TimelineItem.Plan>()
        val currentOperations = mutableListOf<TimelineItem.Operation>()
        val currentFileChanges = mutableListOf<FileChangeItem>()
        val currentNotices = mutableListOf<TimelineItem.Notice>()
        val currentAgentMessages = linkedMapOf<String, TimelineItem.Message>()
        val currentEntries = mutableListOf<TimelineItem>()

        fun flushTurn() {
            if (currentUserPrompt == null &&
                currentAgentSummary == null &&
                currentPlans.isEmpty() &&
                currentOperations.isEmpty() &&
                currentFileChanges.isEmpty() &&
                currentNotices.isEmpty() &&
                currentAgentMessages.isEmpty()
            ) {
                return
            }

            val opSummary = if (currentOperations.isNotEmpty()) {
                val total = currentOperations.size
                val running = currentOperations.count { it.status == TimelineOperationStatus.InProgress }
                val failed = currentOperations.count { it.status == TimelineOperationStatus.Failed }
                val isWorking = running > 0

                val summaryText = when {
                    isWorking -> {
                        val active = currentOperations.firstOrNull { it.status == TimelineOperationStatus.InProgress }
                        active?.title?.let { "⌁ $it" } ?: "⌁ Working on $total actions"
                    }
                    failed > 0 -> {
                        "⌁ Completed with $failed error${if (failed > 1) "s" else ""}"
                    }
                    total == 1 -> {
                        val single = currentOperations.first()
                        "⌁ ${single.title}"
                    }
                    else -> {
                        "⌁ Completed $total actions"
                    }
                }

                TurnOperationSummary(
                    totalCount = total,
                    runningCount = running,
                    failedCount = failed,
                    isWorking = isWorking,
                    summaryText = summaryText,
                    operations = currentOperations.toList(),
                )
            } else null

            val agentMessages = currentAgentMessages.values.toList()
            val finalAnswer = agentMessages.lastOrNull { it.completed }
            val streamingAnswer = agentMessages.lastOrNull { !it.completed }
            val turnId = currentUserPrompt?.id?.let { "turn-$it" }
                // Appending/finalizing a reply must not replace the LazyColumn key.
                ?: agentMessages.firstOrNull()?.id?.let { "turn-$it" }
                ?: currentEntries.firstOrNull()?.id?.let { "turn-$it" }
                ?: currentRequestId?.let { "turn-$it" }
                ?: "turn-${groups.size}"

            groups.add(
                TurnGroup(
                    id = turnId,
                    requestId = currentRequestId,
                    runId = currentRunId,
                    userPrompt = currentUserPrompt,
                    agentSummary = currentAgentSummary,
                    plans = currentPlans.toList(),
                    operationSummary = opSummary,
                    fileChanges = currentFileChanges.toList(),
                    notices = currentNotices.toList(),
                    agentMessages = agentMessages,
                    finalAnswer = finalAnswer,
                    streamingAnswer = streamingAnswer,
                    isLive = streamingAnswer != null || (opSummary?.isWorking == true),
                    entries = currentEntries.toList(),
                ),
            )

            currentRequestId = null
            currentRunId = null
            currentUserPrompt = null
            currentAgentSummary = null
            currentPlans.clear()
            currentOperations.clear()
            currentFileChanges.clear()
            currentNotices.clear()
            currentAgentMessages.clear()
            currentEntries.clear()
        }

        for (item in pairAnchoredItems(items)) {
            if (item is TimelineItem.Message && item.role == TimelineRole.Agent &&
                !item.requestId.isNullOrBlank() && !currentRequestId.isNullOrBlank() &&
                item.requestId != currentRequestId &&
                (item.runId.isNullOrBlank() || item.runId != currentRunId)) flushTurn()
            if (item !is TimelineItem.Message || item.role != TimelineRole.User) currentEntries += item
            when (item) {
                is TimelineItem.Message -> {
                    if (item.role == TimelineRole.User) {
                        // User message marks start of a new turn
                        flushTurn()
                        currentRequestId = item.requestId ?: item.runId
                        currentRunId = item.runId
                        currentUserPrompt = item.requestId?.let(localByRequest::get)?.takeIf { item.id == "pending-${it.requestId}" }
                            ?.let { createPendingTurnGroup(it).userPrompt } ?: TurnUserPrompt(
                            id = item.id,
                            text = item.text,
                            attachments = item.attachments.mapIndexed { idx, att ->
                                ComposerAttachment(
                                    id = att.assetId ?: "att-$idx",
                                    name = att.originalName ?: att.filename ?: "attachment",
                                    mimeType = att.mimeType ?: "application/octet-stream",
                                    sizeBytes = att.sizeBytes ?: 0L,
                                    previewUrl = att.downloadUrl ?: att.url,
                                )
                            },
                            timestamp = null,
                            isPending = false,
                            seq = item.seq,
                            requestId = item.requestId,
                        )
                    } else if (item.role == TimelineRole.Agent) {
                        if (currentRunId == null) currentRunId = item.runId
                        if (currentRequestId == null) {
                            currentRequestId = item.requestId ?: item.runId
                        }
                        val previous = currentAgentMessages[item.id]
                        // Same-entity updates replace in place; distinct messages
                        // remain ordered. A late delta cannot reopen a final reply.
                        currentAgentMessages[item.id] = if (previous?.completed == true && !item.completed) previous else item
                    }
                }
                is TimelineItem.Plan -> {
                    if (currentRunId == null) currentRunId = item.runId
                    if (currentRequestId == null) currentRequestId = item.runId
                    currentPlans.add(item)
                }
                is TimelineItem.Operation -> {
                    if (currentRunId == null) currentRunId = item.runId
                    if (currentRequestId == null) currentRequestId = item.runId
                    currentOperations.add(item)
                    if (item.fileChanges.isNotEmpty()) {
                        currentFileChanges.addAll(item.fileChanges)
                    } else if ((item.kind == TimelineOperationKind.FileEdit || item.kind == TimelineOperationKind.Diff) && item.detail.isNotBlank()) {
                        val lines = item.detail.lines()
                        val additions = lines.count { it.startsWith("+") && !it.startsWith("+++") }
                        val deletions = lines.count { it.startsWith("-") && !it.startsWith("---") }
                        currentFileChanges.add(
                            FileChangeItem(
                                path = item.title,
                                additions = additions,
                                deletions = deletions,
                                diffSummary = item.detail,
                            ),
                        )
                    }
                }
                is TimelineItem.Notice -> {
                    currentNotices.add(item)
                }
            }
        }

        flushTurn()
        return groups
    }

    /** Arrival order cannot attach a late reply to a newer queued user turn. */
    private fun pairAnchoredItems(items: List<TimelineItem>): List<TimelineItem> {
        val messages = items.filterIsInstance<TimelineItem.Message>()
        if (messages.mapNotNull { it.requestId }.distinct().size < 2) return items
        val requestByRun = messages.filter { !it.runId.isNullOrBlank() && !it.requestId.isNullOrBlank() }
            .associate { requireNotNull(it.runId) to requireNotNull(it.requestId) }
        fun requestAnchor(requestId: String?, runId: String?): String? = when {
            !requestId.isNullOrBlank() -> "request:$requestId"
            runId != null && runId in requestByRun -> "request:${requestByRun[runId]}"
            !runId.isNullOrBlank() -> "run:$runId"
            else -> null
        }
        val groups = linkedMapOf<String, MutableList<TimelineItem>>()
        var current = "unscoped"
        for (item in items) {
            val anchor = when (item) {
                is TimelineItem.Message -> requestAnchor(item.requestId, item.runId)
                is TimelineItem.Operation -> requestAnchor(null, item.runId)
                is TimelineItem.Plan -> requestAnchor(null, item.runId)
                is TimelineItem.Notice -> null
            }
            if (item is TimelineItem.Message && item.role == TimelineRole.User) current = anchor ?: "user:${item.id}"
            groups.getOrPut(anchor ?: current) { mutableListOf() }.add(item)
        }
        return groups.values.flatMap { group ->
            group.filter { it is TimelineItem.Message && it.role == TimelineRole.User } +
                group.filterNot { it is TimelineItem.Message && it.role == TimelineRole.User }
        }
    }
}

/**
 * 停靠锚点解析：优先 pending 条目本身；pending 在提交瞬间被换血成真正的用户
 * 消息后，按 requestId 重新锚定到提交后的行，保持「turn 顶边」连续。
 */
fun resolveTurnDockAnchorIndex(turns: List<TurnGroup>, requestId: String): Int {
    val pendingIndex = turns.indexOfFirst { it.id == "turn-pending-$requestId" || it.id == "pending-$requestId" }
    if (pendingIndex >= 0) return pendingIndex
    return turns.indexOfFirst { turn ->
        turn.requestId == requestId || turn.userPrompt?.requestId == requestId
    }
}

fun uniqueTurnRenderKeys(turns: List<TurnGroup>): List<String> {
    val occurrences = mutableMapOf<String, Int>()
    return turns.map { turn ->
        val occurrence = occurrences.getOrDefault(turn.id, 0)
        occurrences[turn.id] = occurrence + 1
        // A length-delimited namespace prevents an ID from colliding with a
        // generated suffix or a fixed item key in the surrounding LazyColumn.
        "timeline-turn:${turn.id.length}:${turn.id}:$occurrence"
    }
}
