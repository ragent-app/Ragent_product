package com.andysagent.agentoc.core.timeline

import com.andysagent.agentoc.core.model.SessionStatus

enum class TimelineRole { User, Agent, System }

enum class TimelineOperationKind { Command, FileEdit, Diff, Tool, SubAgent, Unknown }

enum class TimelineOperationStatus { Pending, InProgress, Completed, Failed }

data class AttachmentItem(
    val assetId: String? = null,
    val filename: String? = null,
    val originalName: String? = null,
    val mimeType: String? = null,
    val sizeBytes: Long? = null,
    val downloadUrl: String? = null,
    val url: String? = null,
    val caption: String? = null,
)

data class FileChangeItem(
    val path: String,
    val name: String = path.substringAfterLast('/'),
    val type: String = "modify",
    val additions: Int = 0,
    val deletions: Int = 0,
    val diffSummary: String = "",
)

data class PlanStepItem(
    val text: String,
    val status: String = "pending",
)

sealed interface TimelineItem {
    val id: String
    val seq: Long

    data class Message(
        override val id: String,
        override val seq: Long,
        val role: TimelineRole,
        val text: String,
        val completed: Boolean,
        val attachments: List<AttachmentItem> = emptyList(),
        val timestamp: Long? = null,
        /** Server request/run anchor for message actions. */
        val requestId: String? = null,
        /** Provider run anchor used to reconcile live and durable aliases. */
        val runId: String? = null,
        val revision: Long = 0,
        val lastEventSeq: Long = seq,
        val messageState: String = if (completed) "completed" else "streaming",
        val messagePhase: String? = null,
    ) : TimelineItem

    data class Operation(
        override val id: String,
        override val seq: Long,
        val kind: TimelineOperationKind,
        val title: String,
        val detail: String,
        val status: TimelineOperationStatus,
        val requiresApproval: Boolean = false,
        val toolName: String? = null,
        val inputJson: String? = null,
        val outputJson: String? = null,
        val exitCode: Int? = null,
        val durationMs: Long? = null,
        val fileChanges: List<FileChangeItem> = emptyList(),
        val runId: String? = null,
        val beforeAssistantAtSameSeq: Boolean = false,
        val isReasoning: Boolean = false,
    ) : TimelineItem

    data class Notice(
        override val id: String,
        override val seq: Long,
        val text: String,
        val requestId: String? = null,
        val runId: String? = null,
    ) : TimelineItem

    data class Plan(
        override val id: String,
        override val seq: Long,
        val planId: String,
        val title: String,
        val state: String,
        val revision: Long,
        val items: List<PlanStepItem> = emptyList(),
        val bodyMarkdown: String = "",
        val planIntent: String? = null,
        val interactionMode: String? = null,
        val source: String? = null,
        val runId: String? = null,
    ) : TimelineItem
}

/** Identify the latest prompt's run without borrowing an unrelated run. */
fun latestTurnRunId(items: List<TimelineItem>): String? {
    val start = items.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User }
    if (start < 0) return null
    val prompt = items[start] as TimelineItem.Message
    prompt.runId?.takeIf(String::isNotBlank)?.let { return it }
    val requestId = prompt.requestId?.takeIf(String::isNotBlank) ?: return null
    // Some durable user messages carry only a request ID. Infer a run only
    // when replies explicitly linked to that request agree on its identity.
    return items.asSequence().filterIsInstance<TimelineItem.Message>()
        .filter { it.role == TimelineRole.Agent && it.requestId == requestId }
        .mapNotNull { it.runId?.takeIf(String::isNotBlank) }
        .distinct().toList().singleOrNull()
}

/** Settle the latest turn when the authoritative session says its run ended. */
fun settleLatestTurnMessages(items: List<TimelineItem>, terminal: Boolean): List<TimelineItem> {
    if (!terminal) return items
    val runId = latestTurnRunId(items) ?: return items
    return items.map { item ->
        when {
            item is TimelineItem.Message && item.role == TimelineRole.Agent && item.runId == runId && !item.completed ->
                item.copy(completed = true, messageState = "completed")
            item is TimelineItem.Operation && item.isReasoning && item.runId == runId &&
                item.status in setOf(TimelineOperationStatus.Pending, TimelineOperationStatus.InProgress) ->
                item.copy(status = TimelineOperationStatus.Completed)
            else -> item
        }
    }
}

data class TimelineEvent(
    val id: String,
    val seq: Long,
    val type: String,
    /** Server-owned run/request anchor. Null means message actions are unavailable. */
    val requestId: String? = null,
    val entityId: String? = null,
    val revision: Long? = null,
    val text: String? = null,
    val role: TimelineRole? = null,
    val operationKind: TimelineOperationKind? = null,
    val operationTitle: String? = null,
    val operationStatus: TimelineOperationStatus? = null,
    val requiresApproval: Boolean = false,
    val toolName: String? = null,
    val inputJson: String? = null,
    val outputJson: String? = null,
    val exitCode: Int? = null,
    val durationMs: Long? = null,
    val options: List<String> = emptyList(),
    val isMultiSelect: Boolean = false,
    val attachments: List<AttachmentItem> = emptyList(),
    val fileChanges: List<FileChangeItem> = emptyList(),
    val riskLevel: String? = null,
    val runId: String? = null,
    val planId: String? = null,
    val planTitle: String? = null,
    val planState: String? = null,
    val planItems: List<PlanStepItem> = emptyList(),
    val planBodyMarkdown: String = "",
    val planIntent: String? = null,
    val interactionMode: String? = null,
    val source: String? = null,
    val streamItemId: String? = null,
    val providerMessageId: String? = null,
    val providerBlockId: String? = null,
    val providerContentBlockIndex: Int? = null,
    val providerItemId: String? = null,
    val providerToolUseId: String? = null,
    val responseId: String? = null,
    val messageState: String? = null,
    val messagePhase: String? = null,
    val lastEventSeq: Long? = null,
    val beforeAssistantAtSameSeq: Boolean = false,
    )

data class TimelineUiState(
    val items: List<TimelineItem> = emptyList(),
    val latestSeq: Long = 0,
    val sessionStatus: SessionStatus = SessionStatus.Idle,
    val atBottom: Boolean = true,
    val unseenCount: Int = 0,
    val loadingOlder: Boolean = false,
    val hasOlder: Boolean = false,
    val error: String? = null,
)

/**
 * Reuses the durable projection while only the live overlay changes. A
 * response can produce hundreds of live updates, but its durable history is
 * usually unchanged for the whole run.
 */
class IncrementalTimelineProjector {
    private val engine = TimelineEngine()
    private var durableMessages: List<com.andysagent.agentoc.core.model.Message>? = null
    private var previousLiveEvents: List<TimelineEvent> = emptyList()
    private var previousLiveById: Map<String, TimelineEvent> = emptyMap()
    private var previousLiveIds: Set<String> = emptySet()
    private var cachedItems: List<TimelineItem> = emptyList()
    private val reasoningAnchors = mutableMapOf<String, String>()
    private val messagesWithVisibleText = mutableSetOf<String>()

    fun project(
        messages: List<com.andysagent.agentoc.core.model.Message>,
        liveEvents: List<TimelineEvent>,
    ): List<TimelineItem> {
        // A provider may emit message_start before thinking, then stream the
        // first visible text afterwards. Anchor only a reasoning event that was
        // actually observed before that first text in the same run, with no
        // intervening tool operation. Never infer ordering across runs.
        liveEvents.filter { it.role == TimelineRole.Agent && it.messageState != null && !it.text.isNullOrBlank() }
            .filter { message -> message.entityId?.let(messagesWithVisibleText::add) == true }
            .forEach { message ->
                val run = message.runId?.takeIf { it.isNotBlank() } ?: return@forEach
                val msgRevision = message.revision ?: return@forEach
                val target = message.entityId ?: return@forEach
                liveEvents.filter { event ->
                    event.type in setOf("reasoning", "thinking_block") && event.runId == run &&
                        event.entityId != null && (event.revision ?: Long.MAX_VALUE) < msgRevision
                }.forEach inner@{ thinking ->
                    val start = thinking.revision ?: return@inner
                    val hasInterveningTool = liveEvents.any { other ->
                        other.runId == run && other.operationKind != null &&
                            other.type !in setOf("reasoning", "thinking_block") &&
                            (other.revision ?: Long.MIN_VALUE) in (start + 1) until msgRevision
                    }
                    if (!hasInterveningTool) reasoningAnchors.putIfAbsent(thinking.entityId!!, target)
                }
            }
        val durablePositions = messages.mapNotNull { message -> message.seq?.let { message.id to it } }.toMap()
        val livePositions = liveEvents.mapNotNull { event -> event.entityId?.let { it to event.seq } }.toMap()
        val orderedLive = liveEvents.map { event ->
            val target = event.entityId?.let(reasoningAnchors::get)
            val position = target?.let { id ->
                durablePositions[id] ?: livePositions[id] ?: event.runId?.let { run ->
                    // The completed snapshot may replace the provider's live
                    // message identity. Reconcile only an unambiguous reply.
                    messages.filter { it.role.equals("assistant", true) && it.runId == run }
                        .singleOrNull()?.seq
                }
            }
            if (position != null && position > 0) event.copy(seq = position, beforeAssistantAtSameSeq = true) else event
        }
        val anchoredLive = anchorProviderThinking(orderedLive)
        val liveIds = anchoredLive.asSequence().map { it.id }.toSet()
        // Room emits immutable list instances. Referential comparison avoids a
        // full message-body equality scan every time only the live overlay
        // changes, while still rebuilding whenever the durable query emits.
        val durableChanged = durableMessages == null || durableMessages !== messages
        val liveOverlayShrank = !liveIds.containsAll(previousLiveIds)
        val liveEventUpdated = anchoredLive.any { event ->
            previousLiveById[event.id]?.let { it != event } == true
        }

        if (durableChanged || liveOverlayShrank || liveEventUpdated) {
            engine.clear()
            engine.apply(TimelineProjector.durableEvents(messages, orderedLive))
            previousLiveEvents = emptyList()
            previousLiveById = emptyMap()
            previousLiveIds = emptySet()
        } else if (anchoredLive == previousLiveEvents) {
            return cachedItems
        }

        engine.apply(anchoredLive)
        cachedItems = engine.snapshot()
        durableMessages = messages
        previousLiveEvents = anchoredLive
        previousLiveById = anchoredLive.associateBy { it.id }
        previousLiveIds = liveIds
        return cachedItems
    }
}

/**
 * Reducer for the native timeline projection. Event IDs identify immutable
 * events; entity IDs/revisions describe updates to the rendered object.
 */
class TimelineEngine {
    private val eventsById = linkedMapOf<String, TimelineEvent>()
    private val latestEventByEntity = linkedMapOf<String, TimelineEvent>()
    private val operationByRequest = linkedMapOf<String, String>()
    private var cachedSnapshot: List<TimelineItem>? = null

    fun apply(events: Iterable<TimelineEvent>): List<TimelineItem> {
        for (event in events) {
            if (event.id.isBlank() || event.seq <= 0) continue
            val existing = eventsById[event.id]
            if (existing == null) {
                eventsById[event.id] = event
            } else if (sameIdentity(existing, event)) {
                continue
            } else {
                // Protocol-invalid duplicate IDs must never overwrite an event.
                continue
            }
            val entityKey = event.entityId ?: event.id
            val current = latestEventByEntity[entityKey]
            if (current == null || isNewer(event, current)) {
                latestEventByEntity[entityKey] = if (current == null) event else event.copy(seq = current.seq)
                cachedSnapshot = null
            }
            event.requestId?.takeIf { it.isNotBlank() }?.let { operationByRequest[it] = event.id }
        }
        return snapshot()
    }

    fun clear() {
        eventsById.clear()
        latestEventByEntity.clear()
        operationByRequest.clear()
        cachedSnapshot = null
    }

    internal fun size(): Int = eventsById.size

    fun snapshot(): List<TimelineItem> {
        cachedSnapshot?.let { return it }
        return latestEventByEntity.values
            .sortedWith(compareBy<TimelineEvent> { it.seq }.thenBy { if (it.role == TimelineRole.User && it.messageState != null) 0 else if (it.beforeAssistantAtSameSeq) 1 else 2 }.thenBy { it.id })
            .map(::toItem)
            .also { cachedSnapshot = it }
    }

    private fun sameIdentity(previous: TimelineEvent, incoming: TimelineEvent): Boolean =
        previous == incoming

    private fun isNewer(incoming: TimelineEvent, previous: TimelineEvent): Boolean = when {
        previous.messageState != null && previous.messageState != "streaming" && incoming.messageState == "streaming" -> false
        incoming.messageState != null && incoming.messageState != "streaming" && previous.messageState == "streaming" -> true
        incoming.messageState == "streaming" && previous.messageState == "streaming" &&
            incoming.lastEventSeq == 0L && (previous.lastEventSeq ?: 0L) > 0L -> true
        incoming.messageState == "streaming" && previous.messageState == "streaming" &&
            previous.lastEventSeq == 0L && (incoming.lastEventSeq ?: 0L) > 0L -> false
        incoming.revision != null && previous.revision != null -> incoming.revision > previous.revision
        incoming.revision != null -> true
        previous.revision != null -> false
        else -> incoming.seq > previous.seq
    }

    private fun toItem(event: TimelineEvent): TimelineItem {
        val type = event.type.lowercase()
        // event.id identifies an immutable log entry. Rendered objects need a
        // stable key across revisions, so prefer the entity identity when one
        // is present (message/tool updates must not remount their UI row).
        val renderId = event.entityId ?: event.id
        if (type == "plan" || event.planId != null) {
            return TimelineItem.Plan(
                id = renderId,
                seq = event.seq,
                planId = event.planId ?: renderId,
                title = event.planTitle ?: "Codex plan",
                state = event.planState ?: "drafting",
                revision = event.revision ?: 1L,
                items = event.planItems,
                bodyMarkdown = event.planBodyMarkdown,
                planIntent = event.planIntent,
                interactionMode = event.interactionMode,
                source = event.source,
            )
        }
        val operation = event.operationKind != null
            || type.contains("tool")
            || type.contains("command")
            || type.contains("file_")
            || type.contains("diff")
            || type.contains("operation")
            || type.contains("thinking")
            || type.contains("reasoning")
            || type == "usage"

        if (operation) {
            val kind = event.operationKind ?: kindFromType(type)
            val title = event.operationTitle ?: event.toolName ?: event.text ?: when (kind) {
                TimelineOperationKind.Command -> "Run command"
                TimelineOperationKind.FileEdit -> "Edit file"
                TimelineOperationKind.Diff -> "File changes"
                TimelineOperationKind.SubAgent -> "SubAgent activity"
                TimelineOperationKind.Tool -> event.toolName ?: "Tool activity"
                TimelineOperationKind.Unknown -> "Activity"
            }
            return TimelineItem.Operation(
                id = renderId,
                seq = event.seq,
                kind = kind,
                title = title,
                detail = event.text ?: event.inputJson ?: event.outputJson.orEmpty(),
                status = event.operationStatus ?: statusFromType(type),
                requiresApproval = event.requiresApproval,
                toolName = event.toolName,
                inputJson = event.inputJson,
                outputJson = event.outputJson,
                exitCode = event.exitCode,
                durationMs = event.durationMs,
                fileChanges = event.fileChanges,
                runId = event.runId,
                beforeAssistantAtSameSeq = event.beforeAssistantAtSameSeq,
                isReasoning = type == "reasoning" || type == "thinking_block",
            )
        }
        if (type.contains("approval") || type.contains("confirmation") || type.contains("error") || type.contains("system")) {
            return TimelineItem.Notice(renderId, event.seq, event.text.orEmpty(), event.requestId, event.runId)
        }
            return TimelineItem.Message(
            id = renderId,
            seq = event.seq,
            role = event.role ?: if (type.contains("user")) TimelineRole.User else TimelineRole.Agent,
            text = event.text.orEmpty(),
            completed = event.messageState?.let { it != "streaming" }
                ?: (!type.contains("delta") && !type.contains("stream") && event.operationStatus != TimelineOperationStatus.InProgress),
                attachments = event.attachments,
                requestId = event.requestId,
                runId = event.runId,
                revision = event.revision ?: 0,
                lastEventSeq = event.lastEventSeq ?: event.seq,
                messageState = event.messageState ?: if (type.contains("delta")) "streaming" else "completed",
                messagePhase = event.messagePhase,
            )
    }

    private fun kindFromType(type: String): TimelineOperationKind = when {
        type.contains("command") || type.contains("execute") -> TimelineOperationKind.Command
        type.contains("file_edit") || type.contains("edit") -> TimelineOperationKind.FileEdit
        type.contains("diff") -> TimelineOperationKind.Diff
        type.contains("subagent") || type.contains("sub_agent") -> TimelineOperationKind.SubAgent
        type.contains("tool") -> TimelineOperationKind.Tool
        else -> TimelineOperationKind.Unknown
    }

    private fun statusFromType(type: String): TimelineOperationStatus = when {
        type.contains("fail") || type.contains("error") || type.contains("declin") -> TimelineOperationStatus.Failed
        type.contains("done") || type.contains("complet") || type.contains("success") -> TimelineOperationStatus.Completed
        type.contains("run") || type.contains("start") || type.contains("delta") -> TimelineOperationStatus.InProgress
        else -> TimelineOperationStatus.Pending
    }
}

/** Reconcile provider block order after separately fetched history pages are merged. */
internal fun anchorProviderThinking(events: List<TimelineEvent>): List<TimelineEvent> {
    val messages = events.filter {
        it.role == TimelineRole.Agent && it.messageState != null &&
            !it.runId.isNullOrBlank() && !it.providerMessageId.isNullOrBlank() &&
            it.providerContentBlockIndex != null
    }.groupBy { it.runId to it.providerMessageId }
    return events.map { event ->
        if (event.type !in setOf("reasoning", "thinking_block") ||
            event.runId.isNullOrBlank() || event.providerMessageId.isNullOrBlank()) return@map event
        val block = event.providerBlockId?.removePrefix("thinking:")?.toIntOrNull()
            ?.takeIf { event.providerBlockId.startsWith("thinking:") } ?: return@map event
        val message = messages[event.runId to event.providerMessageId].orEmpty()
            .filter { it.providerContentBlockIndex!! > block }
            .minByOrNull { it.providerContentBlockIndex!! } ?: return@map event
        if (event.seq >= message.seq) event.copy(seq = message.seq, beforeAssistantAtSameSeq = true) else event
    }
}

/** The only adapter from a durable message snapshot to renderable timeline items. */
object TimelineProjector {
    fun fromMessages(messages: List<com.andysagent.agentoc.core.model.Message>): List<TimelineItem> = project(messages, emptyList())

    fun project(
        messages: List<com.andysagent.agentoc.core.model.Message>,
        liveEvents: List<TimelineEvent>,
    ): List<TimelineItem> {
        val engine = TimelineEngine()
        engine.apply(durableEvents(messages, liveEvents))
        engine.apply(anchorProviderThinking(liveEvents))
        return engine.snapshot()
    }

    internal fun durableEvents(
        messages: List<com.andysagent.agentoc.core.model.Message>,
        liveEvents: List<TimelineEvent> = emptyList(),
    ): List<TimelineEvent> =
        messages.mapIndexed { index, message ->
            val seq = message.seq ?: (index + 1L)
            val role = when (message.role.lowercase()) {
                "user" -> TimelineRole.User
                "system" -> TimelineRole.System
                else -> TimelineRole.Agent
            }
            // A durable completion can use a provider message id while the
            // live delta used a provider item id. Request identity is the
            // stable turn anchor that lets the completion reuse that row.
            val liveEntityId = liveEvents.asReversed().firstOrNull { live ->
                live.entityId != null && sameMessageProjection(message, live, role)
            }?.entityId
            TimelineEvent(
                id = "message-snapshot:${message.id}",
                seq = seq,
                type = "${message.role.lowercase()}_message",
                entityId = liveEntityId ?: message.id,
                // An incomplete Room snapshot is a durable baseline, not a
                // newer presentation than a live overlay. Let the live
                // projection win while the response is still changing.
                revision = message.revision.takeIf { it > 0 } ?: message.lastEventSeq.takeIf { message.completed },
                text = message.content,
                role = role,
                operationStatus = if (message.completed) null else TimelineOperationStatus.InProgress,
                requestId = message.requestId?.takeIf { it.isNotBlank() },
                runId = message.runId?.takeIf { it.isNotBlank() },
                messageState = message.messageState,
                messagePhase = message.messagePhase,
                lastEventSeq = message.lastEventSeq,
                attachments = message.attachments.map { attachment ->
                    AttachmentItem(
                        assetId = attachment.assetId,
                        filename = attachment.filename,
                        originalName = attachment.originalName,
                        mimeType = attachment.mimeType,
                        sizeBytes = attachment.sizeBytes,
                        downloadUrl = attachment.downloadUrl,
                        url = attachment.url,
                        caption = attachment.caption,
                    )
                },
            )
        }

    private fun sameMessageProjection(
        message: com.andysagent.agentoc.core.model.Message,
        live: TimelineEvent,
        role: TimelineRole,
    ): Boolean {
        if (live.role != role) return false
        val messageId = message.id.trim()
        val liveId = live.entityId?.trim().orEmpty()
        if (messageId.isNotEmpty() &&
            (messageId == liveId || messageTimelineId(messageId, role) == liveId)
        ) return true

        return false
    }
}

/**
 * Merges independently fetched timeline surfaces without relying on provider
 * event ids. Visible-history pages and Room/live projection can describe the
 * same message with legacy wrappers. Only canonical identity (or the exact
 * legacy identity after wrapper normalization) may reconcile two rows.
 */
fun mergeTimelineItems(primary: List<TimelineItem>, secondary: List<TimelineItem>): List<TimelineItem> {
    val merged = linkedMapOf<String, TimelineItem>()
    (primary.asSequence() + secondary.asSequence()).forEach { incoming ->
        val key = timelineMergeKey(incoming)
        merged[key] = merged[key]?.let { preferTimelineItem(it, incoming) } ?: incoming
    }
    return merged.values.sortedWith(compareBy<TimelineItem> { it.seq }.thenBy {
        if (it is TimelineItem.Message && it.role == TimelineRole.User) 0
        else if (it is TimelineItem.Operation && it.beforeAssistantAtSameSeq) 1 else 2
    }.thenBy { it.id })
}

private fun timelineMergeKey(item: TimelineItem): String {
    if (item !is TimelineItem.Message) return "item:${item.id}"
    val role = when (item.role) { TimelineRole.User -> "user"; TimelineRole.System -> "system"; else -> "assistant" }
    return messageTimelineId(item.id.removePrefix("message:$role:"), item.role)
}

private fun preferTimelineItem(current: TimelineItem, incoming: TimelineItem): TimelineItem {
    if (current is TimelineItem.Operation && incoming is TimelineItem.Operation && current.isReasoning && incoming.isReasoning) {
        val terminal = setOf(TimelineOperationStatus.Completed, TimelineOperationStatus.Failed)
        val newer = when {
            current.status in terminal && incoming.status !in terminal -> current
            incoming.status in terminal && current.status !in terminal -> incoming
            incoming.detail.length > current.detail.length -> incoming
            else -> current
        }
        return newer.copy(seq = minOf(current.seq, incoming.seq),
            beforeAssistantAtSameSeq = current.beforeAssistantAtSameSeq || incoming.beforeAssistantAtSameSeq)
    }
    if (current is TimelineItem.Operation && incoming is TimelineItem.Operation) {
        val terminal = setOf(TimelineOperationStatus.Completed, TimelineOperationStatus.Failed)
        val newer = when {
            current.status in terminal && incoming.status !in terminal -> current
            incoming.status in terminal && current.status !in terminal -> incoming
            current.status == TimelineOperationStatus.Pending && incoming.status == TimelineOperationStatus.InProgress -> incoming
            else -> current
        }
        val other = if (newer === current) incoming else current
        return newer.copy(
            seq = minOf(current.seq, incoming.seq),
            toolName = newer.toolName ?: other.toolName,
            inputJson = newer.inputJson ?: other.inputJson,
            outputJson = newer.outputJson ?: other.outputJson,
            exitCode = newer.exitCode ?: other.exitCode,
            durationMs = newer.durationMs ?: other.durationMs,
            fileChanges = newer.fileChanges.ifEmpty { other.fileChanges },
            runId = newer.runId ?: other.runId,
            beforeAssistantAtSameSeq = current.beforeAssistantAtSameSeq || incoming.beforeAssistantAtSameSeq,
        )
    }
    if (current !is TimelineItem.Message || incoming !is TimelineItem.Message) return current
    val newer = when {
        current.completed && !incoming.completed -> current
        incoming.completed && !current.completed -> incoming
        !incoming.completed && incoming.lastEventSeq == 0L && current.lastEventSeq > 0L -> incoming
        !current.completed && current.lastEventSeq == 0L && incoming.lastEventSeq > 0L -> current
        incoming.revision != current.revision -> if (incoming.revision > current.revision) incoming else current
        incoming.lastEventSeq > current.lastEventSeq -> incoming
        else -> current
    }
    return newer.copy(
        id = current.id, seq = minOf(current.seq, incoming.seq),
        attachments = newer.attachments.ifEmpty { current.attachments.ifEmpty { incoming.attachments } },
        requestId = newer.requestId ?: current.requestId ?: incoming.requestId,
        runId = newer.runId ?: current.runId ?: incoming.runId,
        messagePhase = newer.messagePhase ?: current.messagePhase ?: incoming.messagePhase,
    )
}

fun messageTimelineId(entityId: String, role: TimelineRole): String {
    val suffix = when (role) {
        TimelineRole.User -> "user"
        TimelineRole.System -> "system"
        TimelineRole.Agent -> "assistant"
    }
    return if (entityId.startsWith("message:") && entityId.endsWith(":$suffix")) {
        entityId
    } else {
        "message:$entityId:$suffix"
    }
}

fun TimelineUiState.withIncomingItems(next: List<TimelineItem>): TimelineUiState {
    val newlyVisible = if (atBottom) 0 else (next.size - items.size).coerceAtLeast(0)
    return copy(
        items = next,
        latestSeq = next.maxOfOrNull { it.seq } ?: latestSeq,
        unseenCount = if (atBottom) 0 else unseenCount + newlyVisible,
    )
}

fun TimelineUiState.onScrollChanged(isAtBottom: Boolean): TimelineUiState = copy(
    atBottom = isAtBottom,
    unseenCount = if (isAtBottom) 0 else unseenCount,
)
