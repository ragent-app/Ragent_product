package com.andysagent.ragent.core.timeline

import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.protocol.allAttachments
import com.andysagent.ragent.core.protocol.boundarySeq
import com.andysagent.ragent.core.protocol.dedupeKey
import com.andysagent.ragent.core.protocol.encodeMessageMetadataJson
import com.andysagent.ragent.core.protocol.mergeMessageMetadataJson
import com.andysagent.ragent.core.protocol.requestKey
import com.andysagent.ragent.core.protocol.sessionEventFingerprint
import com.andysagent.ragent.core.protocol.startingSeq
import com.andysagent.ragent.core.protocol.textContent
import com.andysagent.ragent.core.protocol.toolInputText
import com.andysagent.ragent.core.protocol.toolOutputText
import com.andysagent.ragent.core.protocol.messageEntityKey
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import com.andysagent.ragent.core.sync.StreamingAccumulator
import com.andysagent.ragent.core.sync.ProjectedMessage
import com.andysagent.ragent.core.sync.isTimelineMessage
import com.andysagent.ragent.core.sync.messageProjectionId
import com.andysagent.ragent.core.sync.reduceMessage
import com.andysagent.ragent.core.sync.terminalRunState

data class LiveTimelineResult(
    val events: List<TimelineEvent>,
    val latestSeq: Long,
    val gapExpectedSeq: Long? = null,
    val invalidEvent: SessionEventDto? = null,
)

/** Projects a WS event stream without changing the durable HTTP cursor. */
class LiveTimelineProjector {
    private val pending = linkedMapOf<String, SessionEventDto>()
    private val seenKeys = linkedSetOf<String>()
    private val identities = mutableMapOf<String, String>()
    private val textByEntity = mutableMapOf<String, String>()
    private val durableBaseline = mutableMapOf<String, String>()
    private var durableCompletedBaseline = emptySet<String>()
    private val completedEntities = mutableSetOf<String>()
    /** Latest renderable event per entity. Protocol events remain deduped in seenKeys. */
    private val renderedEvents = linkedMapOf<String, TimelineEvent>()
    private val ephemeralRenderKeys = mutableSetOf<String>()
    private val terminalRunIds = mutableSetOf<String>()
    private val accumulator = StreamingAccumulator()
    private val messageStates = linkedMapOf<String, ProjectedMessage>()
    private var durableSeq = 0L
    private var latestSeq = 0L
    private var nextLiveRenderSeq = 0L
    private var revisionClock = 0L

    fun reconcileDurableCursor(
        durableSeq: Long,
        durableMessages: Map<String, String> = emptyMap(),
        completedEntityIds: Set<String> = emptySet(),
        completedRunIds: Set<String> = emptySet(),
        durableMessageRunIds: Set<String> = completedRunIds,
    ) {
        if (durableSeq < this.durableSeq) return
        terminalRunIds.addAll(completedRunIds)
        val durableChanged = durableSeq > this.durableSeq
            || durableMessages != durableBaseline
            || completedEntityIds != durableCompletedBaseline
        // Live deltas may use a different provider block identity than the
        // finalized durable snapshot. Once its terminal event is durable, the
        // snapshot is authoritative and the ephemeral overlay must retire.
        renderedEvents.entries.removeIf { (key, event) ->
            if (key !in ephemeralRenderKeys) return@removeIf false
            val runId = event.runId ?: return@removeIf false
            if (runId !in terminalRunIds) return@removeIf false
            if (event.messageState != null) {
                runId in durableMessageRunIds
            } else {
                durableChanged || runId in durableMessageRunIds
            }
        }
        this.durableSeq = durableSeq
        pending.entries.removeIf { it.value.boundarySeq() > 0L && it.value.boundarySeq() <= durableSeq }
        if (durableChanged) {
            // Rebase the text accumulator only when Room has advanced. Calling
            // this for every WS hint must not replay the whole stream.
            textByEntity.clear()
            textByEntity.putAll(durableMessages)
            accumulator.clear()
            completedEntities.clear()
            completedEntities.addAll(completedEntityIds)
            durableBaseline.clear()
            durableBaseline.putAll(durableMessages)
            durableCompletedBaseline = completedEntityIds.toSet()
            renderedEvents.entries.removeIf { (key, event) ->
                (key !in ephemeralRenderKeys && (event.messageState == null || (event.lastEventSeq ?: 0L) > 0L) && (event.lastEventSeq ?: event.seq) <= durableSeq)
                    || event.entityId?.let(completedEntityIds::contains) == true
            }
            renderedEvents.values.forEach { event ->
                val entityId = event.entityId
                if (entityId != null && event.text != null) textByEntity[entityId] = event.text
            }
        } else {
            renderedEvents.entries.removeIf { (key, event) ->
                key !in ephemeralRenderKeys && (event.messageState == null || (event.lastEventSeq ?: 0L) > 0L) && (event.lastEventSeq ?: event.seq) <= durableSeq
            }
        }
        ephemeralRenderKeys.retainAll(renderedEvents.keys)
        completedEntityIds.forEach { id ->
            messageStates[id]?.let { before ->
                messageStates[id] = before.copy(text = durableMessages[id] ?: before.text, state = "completed")
            }
        }
        latestSeq = maxOf(latestSeq, durableSeq)
        nextLiveRenderSeq = maxOf(durableSeq, renderedEvents.values.maxOfOrNull { it.seq } ?: 0L)
        renderedEvents.replaceAll { key, event ->
            if (key in ephemeralRenderKeys && event.seq <= durableSeq) event.copy(seq = ++nextLiveRenderSeq) else event
        }
        // Render sequence numbers never advance the durable protocol cursor.
        latestSeq = maxOf(durableSeq, renderedEvents.filterKeys { it !in ephemeralRenderKeys }.values.maxOfOrNull { it.seq } ?: 0L)
        revisionClock = renderedEvents.values.mapNotNull { it.revision }.maxOrNull() ?: 0L
    }

    /**
     * Retires stale ephemeral live text/thinking overlays once the session is
     * authoritatively idle or durable history has caught up, and marks their
     * run IDs terminal so replayed live frames cannot resurrect them.
     */
    fun retireEphemeralTextOverlays(): Set<String> {
        val retiredRunIds = linkedSetOf<String>()
        val retiredKeys = mutableListOf<String>()
        renderedEvents.entries.forEach { (key, event) ->
            if (key !in ephemeralRenderKeys) return@forEach
            val isEphemeralTextDelta = event.type == "text_delta" ||
                (event.messageState == "streaming" && event.role == TimelineRole.Agent)
            val isEphemeralThinking = key.startsWith("thinking:") &&
                event.operationStatus in setOf(TimelineOperationStatus.Pending, TimelineOperationStatus.InProgress)
            if (isEphemeralTextDelta || isEphemeralThinking) {
                retiredKeys += key
                event.runId?.takeIf(String::isNotBlank)?.let {
                    terminalRunIds += it
                    retiredRunIds += it
                }
            }
        }
        retiredKeys.forEach { key ->
            val removed = renderedEvents.remove(key)
            ephemeralRenderKeys.remove(key)
            messageStates.remove(key)
            val entityId = removed?.entityId ?: key
            textByEntity.remove(entityId)
            textByEntity.remove(key)
            if (key.startsWith("thinking:")) {
                val raw = key.removePrefix("thinking:")
                accumulator.clear("$raw:reasoning")
            } else {
                accumulator.clear(entityId)
                accumulator.clear(key)
            }
        }
        if (retiredKeys.isNotEmpty()) {
            latestSeq = maxOf(
                durableSeq,
                renderedEvents.filterKeys { it !in ephemeralRenderKeys }.values.maxOfOrNull { it.seq } ?: 0L,
            )
        }
        return retiredRunIds
    }

    fun apply(events: Iterable<SessionEventDto>): LiveTimelineResult {
        for (event in events) {
            val isReasoningType = event.type?.lowercase() in setOf("reasoning", "thinking_block")
            if (event.boundarySeq() == 0L && event.runId in terminalRunIds && (event.isTimelineMessage() || isReasoningType)) continue
            val start = event.startingSeq()
            val boundary = event.boundarySeq()
            val key = event.dedupeKey() ?: "fingerprint:${event.sessionEventFingerprint()}"
            val identity = event.sessionEventFingerprint()
            val previous = identities[key]
            if (previous != null && previous != identity) return invalid(event)
            identities[key] = identity
            if (seenKeys.contains(key) || pending.containsKey(key) || (boundary > 0L && boundary <= latestSeq)) continue
            if (boundary == 0L && start == 0L && isEphemeralLiveEvent(event)) {
                drainPending()
                val renderKey = renderKey(event)
                ephemeralRenderKeys += renderKey
                val renderSeq = renderedEvents[renderKey]?.seq ?: ++nextLiveRenderSeq
                upsertRenderedEvent(event, renderSeq)
                seenKeys += key
                while (seenKeys.size > 8192) seenKeys.remove(seenKeys.first())
                continue
            }
            if (start <= 0L || boundary < start) return invalid(event)
            pending[key] = event
        }

        drainPending()

        val firstPending = pending.values.minByOrNull { it.startingSeq() }
        val gap = firstPending?.startingSeq()?.takeIf { it > latestSeq + 1L }
        return LiveTimelineResult(snapshotEvents(), latestSeq, gapExpectedSeq = gap?.let { latestSeq + 1L })
    }

    private fun drainPending() {
        while (true) {
            val expected = latestSeq + 1L
            val next = pending.values
                .filter { it.startingSeq() <= expected && it.boundarySeq() > latestSeq }
                .minWithOrNull(compareBy<SessionEventDto> { it.boundarySeq() }.thenBy { it.startingSeq() })
                ?: break
            val key = next.dedupeKey() ?: "fingerprint:${next.sessionEventFingerprint()}"
            pending.remove(key)
            val renderKey = renderKey(next)
            val renderSeq = renderedEvents[renderKey]?.seq ?: next.boundarySeq()
            upsertRenderedEvent(next, renderSeq)
            latestSeq = next.boundarySeq()
            nextLiveRenderSeq = maxOf(nextLiveRenderSeq, next.boundarySeq())
            seenKeys += key
            while (seenKeys.size > 8192) seenKeys.remove(seenKeys.first())
        }

    }

    /** Rehydrates durable non-message artifacts without advancing the event cursor. */
    fun applyArtifactEvents(events: Iterable<SessionEventDto>) {
        events.filter { event ->
            val type = event.type.orEmpty().lowercase()
            type == "plan" || event.planId != null || event.artifactId != null
        }.forEach { event ->
            val key = renderKey(event)
            val renderSeq = renderedEvents[key]?.seq ?: (++nextLiveRenderSeq).coerceAtLeast(durableSeq + 1L)
            upsertRenderedEvent(event, renderSeq)
        }
    }

    private fun upsertRenderedEvent(event: SessionEventDto, renderSeq: Long) {
        if (event.source == "context_compaction_handoff" || event.type == "context_barrier") return
        val statusError = event.type?.lowercase() == "status" && event.role?.lowercase() == "system" &&
            event.textContent()?.trimStart()?.startsWith("error:", ignoreCase = true) == true
        if (statusError) {
            val key = renderKey(event)
            renderedEvents[key] = TimelineEvent(
                id = event.dedupeKey() ?: "live:${event.boundarySeq()}", seq = renderSeq,
                type = "error", text = event.textContent(), requestId = event.requestId, runId = event.runId,
            )
        }
        event.terminalRunState()?.let { state ->
            event.runId?.takeIf(String::isNotBlank)?.let(terminalRunIds::add)
            messageStates.entries.toList().forEach { (id, message) ->
                val inScope = if (!event.runId.isNullOrBlank()) message.runId == event.runId
                    else !event.requestId.isNullOrBlank() && message.requestId == event.requestId
                if (inScope && !message.completed) {
                    messageStates[id] = message.copy(state = state)
                    renderedEvents[id]?.let { before ->
                        renderedEvents[id] = before.copy(
                            type = "assistant_completed", messageState = state,
                            operationStatus = TimelineOperationStatus.Completed,
                        )
                    }
                }
            }
            renderedEvents.entries.toList().forEach { (key, before) ->
                if (!key.startsWith("thinking:")) return@forEach
                val inScope = if (!event.runId.isNullOrBlank()) before.runId == event.runId
                    else !event.requestId.isNullOrBlank() && before.requestId == event.requestId
                val inProgress = before.operationStatus in setOf(TimelineOperationStatus.Pending, TimelineOperationStatus.InProgress)
                if (inScope && inProgress) {
                    renderedEvents[key] = before.copy(operationStatus = TimelineOperationStatus.Completed)
                }
            }
            return
        }
        if (statusError || event.type in setOf("status", "usage", "run_started", "run_completed", "run_failed", "run_cancelled", "run_terminal", "provider_turn_started")) return
        if (event.isTimelineMessage()) {
            val id = event.messageProjectionId()
            val before = messageStates[id] ?: textByEntity[id]?.let { baseline ->
                ProjectedMessage(id, event.role ?: "assistant", baseline, renderSeq, 0, 0,
                    if (id in completedEntities) "completed" else "streaming", event.requestId, event.runId)
            }
            val next = reduceMessage(before, event, renderSeq)
            messageStates[id] = next
            val previous = renderedEvents[id]
            renderedEvents[id] = TimelineEvent(
                id = event.dedupeKey() ?: "live:$id:${event.providerEventId ?: event.boundarySeq()}",
                seq = next.firstSeq, entityId = next.id, type = if (next.completed) "message" else "text_delta",
                text = next.text, revision = event.revision ?: maxOf(next.lastEventSeq, ++revisionClock),
                requestId = next.requestId, runId = next.runId,
                role = when (next.role) { "user" -> TimelineRole.User; "system" -> TimelineRole.System; else -> TimelineRole.Agent },
                messageState = next.state, lastEventSeq = if (event.boundarySeq() == 0L) 0L else next.lastEventSeq,
                messagePhase = next.messagePhase,
                metadataJson = mergeMessageMetadataJson(previous?.metadataJson, next.metadataJson),
                providerMessageId = event.providerMessageId ?: previous?.providerMessageId,
                providerContentBlockIndex = event.providerContentBlockIndex ?: event.messageBlockIndex ?: previous?.providerContentBlockIndex,
                operationStatus = if (next.completed) TimelineOperationStatus.Completed else TimelineOperationStatus.InProgress,
                attachments = event.allAttachments().map { AttachmentItem(
                    assetId = it.assetId, filename = it.filename, originalName = it.originalName,
                    mimeType = it.mimeType, sizeBytes = it.sizeBytes, downloadUrl = it.downloadUrl,
                    url = it.url, caption = it.caption ?: it.text,
                ) }.ifEmpty { previous?.attachments.orEmpty() },
            )
            return
        }
        val renderKey = renderKey(event)
        val previous = renderedEvents[renderKey]
        renderedEvents[renderKey] = applyEvent(event, renderSeq, previous)
    }

    private fun applyEvent(event: SessionEventDto, renderSeq: Long, previous: TimelineEvent?): TimelineEvent {
        val type = event.type.orEmpty().lowercase()
        val rawEntityId = if (type == "reasoning" || type == "thinking_block") reasoningEntityKey(event)
            else event.entityId ?: event.messageId ?: event.operationId ?: event.requestKey()
        val isPlan = type == "plan" || event.planId != null || event.artifactId != null
        val planId = (event.planId ?: event.artifactId ?: rawEntityId).takeIf { it.isNotBlank() }
        val text = event.textContent() ?: event.detail ?: event.command
        val isReasoning = type == "reasoning" || type == "thinking_block"
        val isDelta = (type.contains("delta") || type.contains("stream") || isReasoning) && event.state != "completed"
        val isComplete = type == "message"
            || type == "user_message"
            || type == "assistant_message"
            || type.contains("completed")
            || type.contains("done")
            || type.contains("finished")
            || (isReasoning && event.state == "completed")
            || (type == "tool_result" && event.operationLifecycle != "delta")

        val operationState = event.status ?: event.state ?: event.operationLifecycle
        val isToolUse = type == "tool_use" || type == "tool_call" || (type == "operation" && operationState in setOf("in_progress", "running", "started"))
        val isToolResult = type == "tool_result" || (type == "operation" && operationState in setOf(
            "completed", "failed", "error", "declined", "denied", "interrupted", "cancelled", "canceled",
        ))
        val isFileChange = type == "file_change" || event.fileChanges.isNotEmpty()
        val isAttachment = type == "attachment_delivery" || event.attachments.isNotEmpty() || event.images.isNotEmpty()
        val isMessageLike = !isReasoning && !isToolUse && !isToolResult && !isFileChange && !isAttachment && (
            type == "message" || type == "user_message" || type == "assistant_message"
                || type.contains("message") || type.contains("delta") || type.contains("stream")
                || type.contains("completed") || type.contains("done") || type.contains("finished")
        )

        if (isPlan && planId != null) {
            val planItems = event.items.mapNotNull { item ->
                val text = listOf("text", "step", "title").asSequence()
                    .mapNotNull { key -> item[key]?.jsonPrimitive?.contentOrNull }
                    .firstOrNull { it.isNotBlank() } ?: return@mapNotNull null
                val status = item["status"]?.jsonPrimitive?.contentOrNull
                    ?: item["state"]?.jsonPrimitive?.contentOrNull
                    ?: if (item["completed"]?.jsonPrimitive?.contentOrNull == "true") "completed" else "pending"
                PlanStepItem(text, status)
            }
            return TimelineEvent(
                id = event.dedupeKey() ?: "live:${event.boundarySeq()}",
                seq = renderSeq,
                type = "plan",
                requestId = event.requestId?.takeIf { it.isNotBlank() },
                entityId = "plan:$planId",
                revision = event.revision ?: renderSeq,
                text = event.bodyMarkdown ?: event.textContent(),
                planId = planId,
                planTitle = event.title ?: "Codex plan",
                planState = event.status ?: event.state ?: "drafting",
                planItems = planItems,
                planBodyMarkdown = event.bodyMarkdown ?: event.textContent().orEmpty(),
                planIntent = event.planIntent,
                interactionMode = event.interactionMode,
                source = event.source,
                runId = event.runId,
            )
        }

        val role = when (event.role?.lowercase()) {
            "user" -> TimelineRole.User
            "system" -> TimelineRole.System
            null -> TimelineRole.Agent
            else -> TimelineRole.Agent
        }
        val entityId = if (isReasoning) {
            "thinking:$rawEntityId"
        } else if (isAttachment) {
            event.deliveryKey ?: "attachment:$rawEntityId"
        } else if (isToolUse || isToolResult || isFileChange) {
            operationRenderKey(event)
        } else if (isMessageLike) {
            canonicalMessageEntityId(event, role)
        } else {
            messageTimelineId(event.messageEntityKey(), role)
        }

        val baseline = textByEntity[entityId] ?: textByEntity[rawEntityId].orEmpty()
        val accumulatorKey = if (isReasoning) "$rawEntityId:reasoning" else entityId
        if (accumulator.current(accumulatorKey) == null && baseline.isNotEmpty()) {
            accumulator.seed(accumulatorKey, baseline)
        }
        val lateDelta = isDelta && completedEntities.contains(entityId)
        val projectedText = when {
            lateDelta -> textByEntity[entityId] ?: baseline
            isDelta -> accumulator.append(accumulatorKey, text.orEmpty()).text
            // Some structured-provider completion envelopes carry identity
            // but no text. An empty completion must settle the streamed text,
            // never erase it from the native timeline.
            isComplete -> accumulator.complete(accumulatorKey, text?.takeIf { it.isNotEmpty() }).text
            text != null -> text
            else -> accumulator.current(accumulatorKey) ?: baseline
        }
        if (isComplete) completedEntities += entityId
        if (text != null || isDelta || isComplete) textByEntity[entityId] = projectedText
        val revision = event.revision ?: maxOf(renderSeq, revisionClock + 1L)
        revisionClock = maxOf(revisionClock, revision)

        // Claude tool results can put the opaque tool-use ID in toolName.
        // Keep the actual tool name from the matching operation in that case.
        val resultNameIsId = isToolResult && !event.toolName.isNullOrBlank() &&
            event.toolName == event.providerToolUseId
        val toolName = event.toolName?.takeIf { it.isNotBlank() && !resultNameIsId }
            ?: previous?.toolName ?: event.kind ?: event.title
        val inputJson = event.toolInputText() ?: previous?.inputJson
        val preview = event.outputPreview as? JsonObject
        val previewLines = listOf("head", "tail").flatMap { key ->
            (preview?.get(key) as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        }.joinToString("\n").takeIf { it.isNotEmpty() }
        val outputJson = event.toolOutputText() ?: previewLines ?: (if (isToolResult) text else null) ?: previous?.outputJson
        val exitCode = event.exitCode ?: previous?.exitCode
        val fileChanges = if (event.fileChanges.isNotEmpty()) {
            event.fileChanges.map {
                FileChangeItem(
                    path = it.filePath?.takeIf(String::isNotBlank) ?: it.path,
                    name = it.name ?: (it.filePath?.takeIf(String::isNotBlank) ?: it.path).substringAfterLast('/'),
                    type = it.changeType ?: it.type,
                    additions = it.added ?: it.additions,
                    deletions = it.removed ?: it.deletions,
                    diffSummary = it.diffSummary,
                )
            }
        } else if (type == "file_change" && !event.filePath.isNullOrBlank()) {
            listOf(FileChangeItem(path = event.filePath!!, type = event.changeType ?: "modify", additions = event.added ?: 0, deletions = event.removed ?: 0))
        } else {
            previous?.fileChanges.orEmpty()
        }

        val attachments = event.allAttachments().map {
            AttachmentItem(
                assetId = it.assetId,
                filename = it.filename,
                originalName = it.originalName,
                mimeType = it.mimeType,
                sizeBytes = it.sizeBytes,
                downloadUrl = it.downloadUrl,
                url = it.url,
                caption = it.caption ?: it.text,
            )
        }.ifEmpty { previous?.attachments.orEmpty() }

        val normalizedToolName = toolName.orEmpty().lowercase()
        val operationKind = when {
            isReasoning -> TimelineOperationKind.Tool
            isFileChange -> TimelineOperationKind.Diff
            isToolResult && previous?.operationKind != null -> previous.operationKind
            isToolUse || isToolResult -> when {
                event.kind in setOf("command", "execute") || normalizedToolName.contains("command") || normalizedToolName.contains("exec") || normalizedToolName.contains("bash") -> TimelineOperationKind.Command
                event.kind in setOf("file_edit", "edit", "write") || normalizedToolName.contains("edit") || normalizedToolName.contains("write") || normalizedToolName.contains("replace") -> TimelineOperationKind.FileEdit
                normalizedToolName.contains("diff") || normalizedToolName.contains("file") -> TimelineOperationKind.Diff
                normalizedToolName.contains("agent") -> TimelineOperationKind.SubAgent
                else -> TimelineOperationKind.Tool
            }
            type.contains("command") -> TimelineOperationKind.Command
            type.contains("file_edit") -> TimelineOperationKind.FileEdit
            type.contains("diff") -> TimelineOperationKind.Diff
            type.contains("subagent") -> TimelineOperationKind.SubAgent
            type.contains("tool") || type == "operation" -> TimelineOperationKind.Tool
            else -> null
        }

        val operationStatus = when {
            isReasoning -> if (isComplete || lateDelta) TimelineOperationStatus.Completed else TimelineOperationStatus.InProgress
            previous?.operationStatus in setOf(TimelineOperationStatus.Completed, TimelineOperationStatus.Failed) &&
                operationState in setOf("delta", "started", "running", "in_progress") -> previous?.operationStatus
            operationState in setOf("waiting_approval", "waiting_user", "approval_requested", "pending") -> TimelineOperationStatus.Pending
            operationState in setOf("delta", "started", "running", "in_progress") -> TimelineOperationStatus.InProgress
            isToolResult -> if ((exitCode != null && exitCode != 0) || operationState in setOf(
                "failed", "error", "declined", "denied", "interrupted", "cancelled", "canceled",
            )) TimelineOperationStatus.Failed else TimelineOperationStatus.Completed
            isToolUse -> TimelineOperationStatus.InProgress
            isFileChange -> TimelineOperationStatus.Completed
            isComplete || lateDelta -> TimelineOperationStatus.Completed
            isDelta -> TimelineOperationStatus.InProgress
            type.contains("fail") || type.contains("error") -> TimelineOperationStatus.Failed
            else -> previous?.operationStatus
        }

        val operationTitle = when {
            isReasoning -> "Thinking"
            isToolUse || isToolResult -> event.title ?: toolName ?: "Tool activity"
            isFileChange -> event.title ?: "File changes"
            else -> event.title ?: previous?.operationTitle
        }

        val options = event.options.ifEmpty { event.choices }.ifEmpty { previous?.options.orEmpty() }
        val isMultiSelect = event.isMultiSelect ?: previous?.isMultiSelect ?: false
        val requiresApproval = operationState in setOf("waiting_approval", "waiting_user", "approval_requested") || type.contains("approval") || type.contains("confirmation") || (previous?.requiresApproval == true && !isComplete && !isToolResult)

        val topDescription = event.activityDescription?.takeIf { it.isNotBlank() }
        val topSource = event.activityDescriptionSource?.takeIf { it.isNotBlank() }
        val presentationDescription = (event.presentation?.get("activityDescription") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        val presentationSource = (event.presentation?.get("activityDescriptionSource") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        val useTopLevel = topDescription != null && topSource in setOf("provider_title", "tool_input_description")
        val candidateDescription = if (useTopLevel) topDescription else presentationDescription
        val candidateSource = if (useTopLevel) topSource else presentationSource
        val candidateSeq = (if (useTopLevel) event.activityDescriptionSeq else
            (event.presentation?.get("activityDescriptionSeq") as? JsonPrimitive)?.contentOrNull?.toLongOrNull())
            ?: event.boundarySeq().takeIf { it > 0L }
        val sourceRank = mapOf("provider_title" to 1, "tool_input_description" to 2)
        val reliableDescriptionIdentity = !event.operationId.isNullOrBlank() || !event.providerToolUseId.isNullOrBlank() ||
            !event.providerItemId.isNullOrBlank() || (previous == null && isToolUse)
        val useCandidate = reliableDescriptionIdentity && !candidateDescription.isNullOrBlank() && sourceRank.containsKey(candidateSource) &&
            (sourceRank[candidateSource] ?: 0) >= (sourceRank[previous?.activityDescriptionSource] ?: 0) &&
            (candidateSeq == null || previous?.activityDescriptionSeq == null || candidateSeq >= previous.activityDescriptionSeq)
        return TimelineEvent(
            id = event.dedupeKey() ?: "live:${event.boundarySeq()}",
            seq = renderSeq,
            type = if (lateDelta && !isReasoning) "assistant_completed" else event.type ?: "message",
            // requestKey() is useful for dedupe/entity projection, but it can
            // fall back to an event/sequence key. That is not a valid source
            // run anchor for regenerate or edited resend.
            requestId = event.requestId?.takeIf { it.isNotBlank() },
            entityId = entityId,
            revision = revision,
            text = projectedText,
            role = role,
            operationKind = operationKind ?: previous?.operationKind,
            operationTitle = operationTitle,
            operationStatus = operationStatus,
            activityDescription = if (useCandidate) candidateDescription else previous?.activityDescription,
            activityDescriptionSource = if (useCandidate) candidateSource else previous?.activityDescriptionSource,
            activityDescriptionSeq = if (useCandidate) candidateSeq else previous?.activityDescriptionSeq,
            durableStartSeq = previous?.durableStartSeq ?: event.startingSeq().takeIf { it > 0L },
            requiresApproval = requiresApproval,
            toolName = toolName,
            inputJson = inputJson,
            outputJson = outputJson,
            exitCode = exitCode,
            durationMs = event.durationMs ?: previous?.durationMs,
            operationProgress = event.operationProgress?.takeIf { it.isNotBlank() } ?: previous?.operationProgress,
            operationProgressSeq = if (!event.operationProgress.isNullOrBlank()) event.boundarySeq().takeIf { it > 0L } ?: previous?.operationProgressSeq else previous?.operationProgressSeq,
            webAction = event.webAction?.takeIf { it in setOf("search", "open", "find", "mixed", "generic") } ?: previous?.webAction,
            beforeAssistantAtSameSeq = event.beforeAssistantAtSameSeq || previous?.beforeAssistantAtSameSeq == true,
            options = options,
            isMultiSelect = isMultiSelect,
            attachments = attachments,
            fileChanges = fileChanges,
            riskLevel = event.riskLevel ?: event.severity ?: previous?.riskLevel,
            runId = event.runId ?: previous?.runId,
            streamItemId = event.streamItemId,
            providerMessageId = event.providerMessageId ?: previous?.providerMessageId,
            providerBlockId = event.providerBlockId ?: previous?.providerBlockId,
            providerItemId = event.providerItemId ?: previous?.providerItemId,
            providerToolUseId = event.providerToolUseId ?: previous?.providerToolUseId,
            responseId = event.responseId,
            metadataJson = mergeMessageMetadataJson(previous?.metadataJson, event.encodeMessageMetadataJson()),
        )
    }

    fun snapshotEvents(): List<TimelineEvent> = renderedEvents.values.sortedWith(compareBy<TimelineEvent> { it.seq }.thenBy { it.id })

    private fun reasoningEntityKey(event: SessionEventDto): String {
        val block = event.providerBlockId?.takeIf(String::isNotBlank)
        return if (block != null) listOfNotNull(event.runId, event.providerMessageId, block).joinToString(":")
            else event.entityId ?: event.messageId ?: event.requestKey()
    }

    private fun renderKey(event: SessionEventDto): String {
        val type = event.type.orEmpty().lowercase()
        if (type == "plan" || event.planId != null || event.artifactId != null) {
            return "plan:${event.planId ?: event.artifactId ?: event.entityId ?: event.id}"
        }
        val isReasoning = type == "reasoning" || type == "thinking_block"
        if (isReasoning) {
            val rawEntityId = reasoningEntityKey(event)
            return "thinking:$rawEntityId"
        }
        val isAttachment = type == "attachment_delivery" || event.attachments.isNotEmpty() || event.images.isNotEmpty()
        if (isAttachment) {
            val rawEntityId = event.entityId ?: event.messageId ?: event.requestKey()
            return event.deliveryKey ?: "attachment:$rawEntityId"
        }
        val isMessageLike = type.contains("message") || type.contains("delta") || type.contains("stream")
            || type.contains("completed") || type.contains("done") || type.contains("finished")
        if (isMessageLike && !type.contains("tool") && !type.contains("file_change")) {
            val role = when (event.role?.lowercase()) {
                "user" -> TimelineRole.User
                "system" -> TimelineRole.System
                else -> TimelineRole.Agent
            }
            return canonicalMessageEntityId(event, role)
        }
        return operationRenderKey(event)
    }

    private fun operationRenderKey(event: SessionEventDto): String =
        event.operationId?.takeIf { it.isNotBlank() }
            ?: event.entityId?.takeIf { it.isNotBlank() }
            ?: event.providerToolUseId?.takeIf { it.isNotBlank() }?.let { id ->
                "provider-tool:${event.runId ?: event.requestId.orEmpty()}:$id"
            }
            ?: event.requestKey()

    /**
     * Provider streams sometimes identify the live item and durable message
     * differently. Prefer a previously rendered message that shares a
     * provider identity or the same turn scope, then fall back to a stable
     * explicit identity. This keeps the completion in the same Compose row.
     */
    private fun canonicalMessageEntityId(event: SessionEventDto, role: TimelineRole): String {
        return event.messageProjectionId()
    }

    /** History pages may contain gaps; they share the reducer, not the contiguous transport cursor. */
    fun projectPage(events: Iterable<SessionEventDto>): List<TimelineEvent> {
        val projector = LiveTimelineProjector()
        events.filter { it.boundarySeq() > 0L }
            .distinctBy { it.dedupeKey() ?: it.sessionEventFingerprint() }
            .sortedBy { it.boundarySeq() }.forEach { event ->
            val key = projector.renderKey(event)
            val first = projector.renderedEvents[key]?.seq
                ?: event.displaySeq?.takeIf { it > 0 } ?: event.firstSeq?.takeIf { it > 0 } ?: event.seq ?: event.boundarySeq()
            projector.upsertRenderedEvent(event, first)
        }
        return projector.snapshotEvents()
    }

    private fun invalid(event: SessionEventDto) = LiveTimelineResult(
        events = snapshotEvents(),
        latestSeq = latestSeq,
        invalidEvent = event,
    )

    private fun isEphemeralLiveEvent(event: SessionEventDto): Boolean {
        val type = event.type.orEmpty().lowercase()
        // The HTTP live feed includes control notifications (for example Codex
        // MCP inventory) before text. They have no durable sequence and must
        // not reject the rest of the page or advance the durable cursor.
        return type in setOf("text_delta", "reasoning", "status", "usage", "run_started",
            "run_completed", "run_failed", "run_cancelled", "session_completed") ||
            (type == "thinking_block" && event.state == "running")
    }
}
