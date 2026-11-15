package com.andysagent.ragent.core.timeline

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.model.Message

class TimelineEngineTest {
    @Test fun projectedDeclinedAndInterruptedOperationsAreTerminalFailures() {
        for (state in listOf("failed", "declined", "denied", "interrupted", "cancelled", "canceled")) {
            val event = SessionEventDto(seq = 4, type = "operation", operationId = "tool-1", runId = "r",
                kind = "command", state = state, title = "Command")
            val operation = TimelineProjector.project(emptyList(), LiveTimelineProjector().projectPage(listOf(event)))
                .filterIsInstance<TimelineItem.Operation>().single()
            assertEquals(TimelineOperationStatus.Failed, operation.status, state)
            assertEquals(TimelineOperationKind.Command, operation.kind, state)
        }
    }
    @Test fun toolResultOverridesStaleRunningProjectionRegardlessOfArrivalOrder() {
        val running = TimelineItem.Operation("tool:1", 4, TimelineOperationKind.Tool, "Command", "Running",
            TimelineOperationStatus.InProgress, requiresApproval = true, toolName = "Bash", inputJson = "input", runId = "run")
        val denied = running.copy(seq = 7, detail = "Denied", status = TimelineOperationStatus.Failed,
            requiresApproval = false, inputJson = null, outputJson = "denied")
        for ((first, second) in listOf(running to denied, denied to running)) {
            val result = mergeTimelineItems(listOf(first), listOf(second)).single() as TimelineItem.Operation
            assertEquals(TimelineOperationStatus.Failed, result.status)
            assertEquals(false, result.requiresApproval)
            assertEquals("input", result.inputJson)
            assertEquals("denied", result.outputJson)
            assertEquals(4L, result.seq)
        }
    }
    @Test fun historyThinkingAnchorRemainsBeforeAssistantAtSamePosition() {
        val events = listOf(
            SessionEventDto(seq = 4, displaySeq = 3, blockStartSeq = 4, blockEndSeq = 4, type = "thinking_block", runId = "r",
                providerMessageId = "m", providerBlockId = "thinking:0", state = "completed",
                beforeAssistantAtSameSeq = true, content = JsonPrimitive("Before")),
            SessionEventDto(seq = 3, firstSeq = 3, lastEventSeq = 8, type = "message", role = "assistant",
                runId = "r", providerMessageId = "m", content = JsonPrimitive("Reply")),
        )
        val items = TimelineProjector.project(emptyList(), LiveTimelineProjector().projectPage(events))
        assertIs<TimelineItem.Operation>(items[0])
        assertIs<TimelineItem.Message>(items[1])
    }
    @Test fun separatelyFetchedProviderBlocksRestoreOrderOnlyWithinSameMessageAndRun() {
        val thinking = SessionEventDto(seq = 7, type = "thinking_block", runId = "r", providerMessageId = "m",
            providerBlockId = "thinking:0", state = "completed", content = JsonPrimitive("Before"))
        val reply = SessionEventDto(seq = 3, firstSeq = 3, type = "message", role = "assistant", runId = "r",
            providerMessageId = "m", providerContentBlockIndex = 1, content = JsonPrimitive("Reply"))
        val firstPage = LiveTimelineProjector().projectPage(listOf(thinking))
        val secondPage = LiveTimelineProjector().projectPage(listOf(reply))
        val events = firstPage + secondPage
        val items = TimelineProjector.project(emptyList(), events)
        assertIs<TimelineItem.Operation>(items[0])
        assertIs<TimelineItem.Message>(items[1])
        assertEquals(7L, firstPage.single().seq)
        assertEquals(7L, anchorProviderThinking(listOf(firstPage.single().copy(runId = "other")) + secondPage).first().seq)
        assertEquals(7L, anchorProviderThinking(firstPage + listOf(secondPage.single().copy(providerContentBlockIndex = 0))).first().seq)
        val incremental = IncrementalTimelineProjector()
        incremental.project(emptyList(), firstPage)
        val afterMerge = incremental.project(emptyList(), events)
        assertIs<TimelineItem.Operation>(afterMerge[0])
        assertIs<TimelineItem.Message>(afterMerge[1])
    }
    @Test fun matchingThinkingSurfacesKeepNewestTextAndTerminalStatus() {
        val snapshot = TimelineItem.Operation("thought", 4, TimelineOperationKind.Tool, "Thinking", "First",
            TimelineOperationStatus.InProgress, isReasoning = true)
        val live = snapshot.copy(seq = 8, detail = "First second")
        val merged = mergeTimelineItems(listOf(snapshot), listOf(live)).single() as TimelineItem.Operation
        assertEquals("First second", merged.detail)
        assertEquals(4L, merged.seq)
        val finished = merged.copy(status = TimelineOperationStatus.Completed)
        assertEquals(TimelineOperationStatus.Completed,
            (mergeTimelineItems(listOf(finished), listOf(live)).single() as TimelineItem.Operation).status)
    }
    @Test fun messagePhaseSurvivesLiveCompletionAndDurableProjection() {
        val live = LiveTimelineProjector()
        live.apply(listOf(SessionEventDto(seq = 1, type = "text_delta", providerMessageId = "m", runId = "r", text = "Done")))
        val result = live.apply(listOf(SessionEventDto(seq = 2, type = "message", providerMessageId = "m", runId = "r",
            messagePhase = "final_answer", content = JsonPrimitive("Done"))))
        assertEquals("final_answer", TimelineProjector.project(emptyList(), result.events).filterIsInstance<TimelineItem.Message>().single().messagePhase)
        val durable = Message("m", "s", "assistant", "Done", seq = 1, runId = "r", messagePhase = "final_answer")
        assertEquals("final_answer", TimelineProjector.fromMessages(listOf(durable)).filterIsInstance<TimelineItem.Message>().single().messagePhase)
    }
    @Test fun reasoningStreamUpdatesAndSettlesAtBlockCompletion() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(SessionEventDto(seq = 1, type = "reasoning", runId = "run-1", state = "running", content = JsonPrimitive("First "))))
        val next = projector.apply(listOf(SessionEventDto(seq = 2, type = "reasoning", runId = "run-1", state = "running", content = JsonPrimitive("second"))))
        val live = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), next.events).single())
        assertEquals("First second", live.detail)
        assertEquals(TimelineOperationStatus.InProgress, live.status)
        val stop = projector.apply(listOf(SessionEventDto(seq = 3, type = "reasoning", runId = "run-1", state = "completed", content = JsonPrimitive("First second"))))
        val done = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), stop.events).single())
        assertEquals("First second", done.detail)
        assertEquals(TimelineOperationStatus.Completed, done.status)
    }
    @Test fun distinctClaudeThinkingBlocksDoNotSuppressEachOther() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(SessionEventDto(seq = 1, type = "reasoning", runId = "r", providerMessageId = "m1", providerBlockId = "thinking:0", state = "completed", content = JsonPrimitive("first"))))
        val next = projector.apply(listOf(SessionEventDto(seq = 2, type = "reasoning", runId = "r", providerMessageId = "m2", providerBlockId = "thinking:0", state = "running", content = JsonPrimitive("second"))))
        val rows = TimelineProjector.project(emptyList(), next.events).filterIsInstance<TimelineItem.Operation>()
        assertEquals(2, rows.size)
        assertEquals("second", rows.last().detail)
        assertEquals(TimelineOperationStatus.InProgress, rows.last().status)
    }
    @Test fun canonicalClaudeOperationsRetainStructuredInputForTheActionLine() {
        fun action(json: String): String? {
            val dto = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString<SessionEventDto>(json)
            val live = LiveTimelineProjector().apply(listOf(dto))
            val items = TimelineProjector.project(emptyList(), live.events)
            return RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, items)?.sentence
        }
        assertEquals("Editing report.md", action("""{"type":"operation","seq":1,"operationId":"one","state":"running","kind":"file_edit","toolName":"Write","input":{"file_path":"/work/report.md"}}"""))
        assertEquals("Listing workspace", action("""{"type":"operation","seq":1,"operationId":"two","state":"running","kind":"execute","input":{"command":"ls -l"}}"""))
    }
    @Test fun authoritativeTerminalStatusSettlesOnlyTheLatestMatchingRun() {
        val old = TimelineItem.Message("old", 1, TimelineRole.Agent, "old", false, runId = "old-run")
        val prompt = TimelineItem.Message("user", 2, TimelineRole.User, "request", true, runId = "run-1")
        val answer = TimelineItem.Message("live", 3, TimelineRole.Agent, "answer", false, runId = "run-1")
        val other = TimelineItem.Message("other", 4, TimelineRole.Agent, "other", false, runId = "run-2")
        val thinking = TimelineItem.Operation("thinking", 5, TimelineOperationKind.Tool, "Thinking", "reason", TimelineOperationStatus.InProgress, runId = "run-1", isReasoning = true)
        val items = listOf(old, prompt, answer, other, thinking)
        assertEquals(items, settleLatestTurnMessages(items, false))
        val settled = settleLatestTurnMessages(items, true)
        assertTrue((settled[2] as TimelineItem.Message).completed)
        assertEquals(false, (settled[0] as TimelineItem.Message).completed)
        assertEquals(false, (settled[3] as TimelineItem.Message).completed)
        assertEquals(TimelineOperationStatus.Completed, (settled[4] as TimelineItem.Operation).status)
    }
    @Test fun terminalRunCanBeResolvedFromAnUnambiguousRequestEvenWhenReplyArrivesFirst() {
        val reply = TimelineItem.Message("reply", 1, TimelineRole.Agent, "answer", false, requestId = "req", runId = "run")
        val prompt = TimelineItem.Message("user", 2, TimelineRole.User, "request", true, requestId = "req")
        val unrelated = TimelineItem.Message("other", 3, TimelineRole.Agent, "other", false, requestId = "other", runId = "other-run")
        val items = listOf(reply, prompt, unrelated)
        assertEquals("run", latestTurnRunId(items))
        val settled = settleLatestTurnMessages(items, true)
        assertTrue((settled[0] as TimelineItem.Message).completed)
        assertEquals(false, (settled[2] as TimelineItem.Message).completed)
        val ambiguous = items + reply.copy(id = "different-run", runId = "run-2")
        assertEquals(null, latestTurnRunId(ambiguous))
        assertEquals(ambiguous, settleLatestTurnMessages(ambiguous, true))
        val unlinked = listOf(prompt.copy(requestId = null), reply)
        assertEquals(null, latestTurnRunId(unlinked))
        assertEquals(unlinked, settleLatestTurnMessages(unlinked, true))
    }
    @Test fun liveTerminalEventSettlesTheRunAndRejectsLateUnsequencedTokens() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(SessionEventDto(id = "delta", type = "text_delta", entityId = "block-1", runId = "run-1", text = "answer")))
        val terminal = projector.apply(listOf(SessionEventDto(id = "terminal", type = "status", runId = "run-1", runState = "completed")))
        assertEquals("completed", terminal.events.single().messageState)
        val late = projector.apply(listOf(SessionEventDto(id = "late", type = "text_delta", entityId = "block-1", runId = "run-1", text = "stale")))
        assertEquals("answer", late.events.single().text)
        assertEquals("completed", late.events.single().messageState)
    }
    @Test
    fun durableRunCompletionRetiresMismatchedLiveBlockAndIgnoresLateDeltas() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(SessionEventDto(id = "delta", type = "text_delta", entityId = "block-1", runId = "run-1", text = "answer")))
        projector.reconcileDurableCursor(15, mapOf("block-0" to "answer"), setOf("block-0"), setOf("run-1"))
        assertTrue(projector.snapshotEvents().isEmpty())
        val late = projector.apply(listOf(SessionEventDto(id = "late", type = "text_delta", entityId = "block-1", runId = "run-1", text = "stale")))
        assertTrue(late.events.isEmpty())
        val nextRun = projector.apply(listOf(SessionEventDto(id = "new", type = "text_delta", entityId = "block-2", runId = "run-2", text = "new")))
        assertEquals("new", nextRun.events.single().text)
    }
    @Test
    fun canonicalFileOperationWaitsForApprovalBeforeCompleting() {
        val projector = LiveTimelineProjector()
        val change = com.andysagent.ragent.core.protocol.FileChangeDto(filePath = "/workspace/report.md", changeType = "modify", added = 3)
        val waiting = projector.apply(listOf(SessionEventDto(
            seq = 1, eventId = "op-1", type = "operation", operationId = "op-1",
            state = "waiting_approval", fileChanges = listOf(change),
        )))
        val pending = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), waiting.events).single())
        assertEquals(TimelineOperationStatus.Pending, pending.status)
        assertTrue(pending.requiresApproval)
        assertEquals("/workspace/report.md", pending.fileChanges.single().path)
        val completed = projector.apply(listOf(SessionEventDto(
            seq = 2, eventId = "op-2", type = "operation", operationId = "op-1",
            state = "completed", fileChanges = listOf(change),
        )))
        val result = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), completed.events).single())
        assertEquals(TimelineOperationStatus.Completed, result.status)
        assertEquals(false, result.requiresApproval)
    }
    @Test
    fun planArtifactUpdatesFoldByPlanIdAndPreserveStepState() {
        val projector = LiveTimelineProjector()
        val first = projector.apply(listOf(
            SessionEventDto(
                seq = 1,
                eventId = "plan-1",
                type = "plan",
                planId = "plan-a",
                title = "Prepare report",
                status = "awaiting_decision",
                revision = 1,
                items = listOf(JsonObject(mapOf("text" to JsonPrimitive("Inspect input"), "status" to JsonPrimitive("completed")))),
            ),
        ))
        val second = projector.apply(listOf(
            SessionEventDto(
                seq = 2,
                eventId = "plan-2",
                type = "plan",
                planId = "plan-a",
                title = "Prepare report",
                status = "ready",
                revision = 2,
                items = listOf(
                    JsonObject(mapOf("text" to JsonPrimitive("Inspect input"), "status" to JsonPrimitive("completed"))),
                    JsonObject(mapOf("step" to JsonPrimitive("Generate report"), "status" to JsonPrimitive("pending"))),
                ),
            ),
        ))

        assertEquals(1, first.events.size)
        assertEquals(1, second.events.size)
        val plan = assertIs<TimelineItem.Plan>(TimelineProjector.project(emptyList(), second.events).single())
        assertEquals("plan-a", plan.planId)
        assertEquals(2L, plan.revision)
        assertEquals(listOf("completed", "pending"), plan.items.map { it.status })
    }

    @Test
    fun sortsByDurableSequenceAndIgnoresDuplicateIds() {
        val engine = TimelineEngine()
        val items = engine.apply(listOf(
            TimelineEvent("b", 2, "assistant_message", text = "second"),
            TimelineEvent("a", 1, "user_message", role = TimelineRole.User, text = "first"),
            TimelineEvent("b", 2, "assistant_message", text = "replayed"),
        ))

        assertEquals(listOf("a", "b"), items.map { it.id })
        assertEquals("second", assertIs<TimelineItem.Message>(items[1]).text)
    }

    @Test
    fun snapshotIsReusedUntilTheRenderedEntityChanges() {
        val engine = TimelineEngine()
        val first = engine.apply(listOf(TimelineEvent("a", 1, "assistant_message", text = "stable")))
        assertSame(first, engine.snapshot())

        val unchanged = engine.apply(listOf(TimelineEvent("a", 1, "assistant_message", text = "stable")))
        assertSame(first, unchanged)

        val changed = engine.apply(listOf(TimelineEvent("b", 2, "assistant_message", text = "next")))
        assertEquals(listOf("a", "b"), changed.map { it.id })
        assertEquals(false, first === changed)
    }

    @Test
    fun missingRequestAnchorDoesNotBecomeAnActionableMessageId() {
        val durable = TimelineProjector.fromMessages(listOf(
            Message("message-1", "session-1", "user", "legacy message", seq = 1),
        ))
        assertEquals(null, assertIs<TimelineItem.Message>(durable.single()).requestId)

        val live = TimelineProjector.project(emptyList(), listOf(
            TimelineEvent("event-1", 1, "user_message", entityId = "message-2", text = "live legacy"),
        ))
        assertEquals(null, assertIs<TimelineItem.Message>(live.single()).requestId)
    }

    @Test
    fun durableUserMessagePreservesAttachmentsForRendering() {
        val durable = TimelineProjector.fromMessages(listOf(
            Message(
                "message-with-attachment",
                "session-1",
                "user",
                "请读取这个文件",
                seq = 1,
                attachments = listOf(
                    com.andysagent.ragent.core.model.Attachment(
                        assetId = "asset-1",
                        originalName = "notes.txt",
                        mimeType = "text/plain",
                        sizeBytes = 42L,
                        downloadUrl = "https://example.test/notes.txt",
                    ),
                ),
            ),
        ))

        val message = assertIs<TimelineItem.Message>(durable.single())
        assertEquals("asset-1", message.attachments.single().assetId)
        assertEquals("notes.txt", message.attachments.single().originalName)
        assertEquals("https://example.test/notes.txt", message.attachments.single().downloadUrl)
    }

    @Test
    fun foldsStreamingEventIntoOneStableMessage() {
        val engine = TimelineEngine()
        val items = engine.apply(listOf(
            TimelineEvent("evt-3", 3, "assistant_delta", entityId = "message-1", revision = 1, text = "Hel"),
            TimelineEvent("evt-4", 4, "assistant_completed", entityId = "message-1", revision = 2, text = "Hello"),
        ))

        val message = assertIs<TimelineItem.Message>(items.single())
        assertEquals("message-1", message.id)
        assertEquals(3, message.seq)
        assertEquals("Hello", message.text)
        assertEquals(true, message.completed)
    }

    @Test
    fun keepsUnseenCountUntilUserReturnsToBottom() {
        val initial = TimelineUiState(items = listOf(TimelineItem.Notice("a", 1, "a")), atBottom = false)
        val next = initial.withIncomingItems(initial.items + TimelineItem.Notice("b", 2, "b"))
        assertEquals(1, next.unseenCount)
        assertEquals(0, next.onScrollChanged(true).unseenCount)
    }

    @Test
    fun liveProjectorDedupesReplayAndKeepsOneStableStreamingRow() {
        val projector = LiveTimelineProjector()
        val events = listOf(
            SessionEventDto(seq = 1, eventId = "e1", type = "assistant_delta", entityId = "m1", requestId = "r1", text = "Hel"),
            SessionEventDto(seq = 2, eventId = "e2", type = "assistant_delta", entityId = "m1", requestId = "r1", text = "lo"),
            SessionEventDto(seq = 3, eventId = "e3", type = "assistant_completed", entityId = "m1", requestId = "r1", text = "Hello"),
        )
        val result = projector.apply(events + events)
        assertEquals(3, result.latestSeq)
        val message = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("message:m1:assistant", message.id)
        assertEquals("Hello", message.text)
        assertEquals(true, message.completed)
    }

    @Test
    fun liveProjectorMergesProviderAliasesOnlyWithCanonicalMessageIdentity() {
        val projector = LiveTimelineProjector()
        val result = projector.apply(listOf(
            SessionEventDto(
                seq = 1,
                eventId = "delta-1",
                canonicalMessageId = "canonical-message-1",
                type = "text_delta",
                requestId = "request-1",
                streamItemId = "provider-item-1",
                text = "Hello",
            ),
            SessionEventDto(
                seq = 2,
                eventId = "message-1",
                canonicalMessageId = "canonical-message-1",
                type = "assistant_completed",
                requestId = "request-1",
                providerMessageId = "provider-message-1",
                text = "Hello world",
            ),
        ))

        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("Hello world", item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun projectPageKeepsServerSequenceWhenProjectingOlderHistory() {
        val events = LiveTimelineProjector().projectPage(listOf(
            SessionEventDto(seq = 42, eventId = "later", type = "message", role = "user", text = "later"),
            SessionEventDto(seq = 17, eventId = "older", type = "message", role = "assistant", text = "older"),
        ))

        assertEquals(listOf(17L, 42L), events.map { it.seq }.sorted())
        assertEquals(listOf("older", "later"), events.sortedBy { it.seq }.map { it.id.removePrefix("event:") })
    }

    @Test
    fun projectPageKeepsServerSequenceWithoutDedupeKeys() {
        val events = LiveTimelineProjector().projectPage(listOf(
            SessionEventDto(seq = 42, type = "message", role = "user", text = "later"),
            SessionEventDto(seq = 17, type = "message", role = "assistant", text = "older"),
        ))

        assertEquals(listOf(17L, 42L), events.map { it.seq }.sorted())
        assertEquals(listOf("older", "later"), events.sortedBy { it.seq }.map { it.text })
    }

    @Test
    fun liveProjectorBuffersOutOfOrderEventsAndCompletionBeforeDelta() {
        val projector = LiveTimelineProjector()
        val gap = projector.apply(listOf(
            SessionEventDto(seq = 2, eventId = "e2", type = "assistant_completed", entityId = "m1", text = "Hello"),
        ))
        assertEquals(1L, gap.gapExpectedSeq)
        val recovered = projector.apply(listOf(
            SessionEventDto(seq = 1, eventId = "e1", type = "assistant_delta", entityId = "m1", text = "Hel"),
        ))
        assertEquals(2L, recovered.latestSeq)
        assertEquals("Hello", assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), recovered.events).single()).text)
    }

    @Test
    fun durableCursorAcknowledgementRemovesLiveOverlay() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(SessionEventDto(seq = 1, eventId = "e1", type = "assistant_delta", entityId = "m1", text = "ok")))
        projector.reconcileDurableCursor(1)
        val result = projector.apply(emptyList())
        assertEquals(1L, result.latestSeq)
        assertEquals(emptyList(), result.events)
    }

    @Test
    fun liveDeltaUsesDurableMessageAsItsBaseline() {
        val projector = LiveTimelineProjector()
        projector.reconcileDurableCursor(1, mapOf("message:m1:assistant" to "Hel"))
        val result = projector.apply(listOf(
            SessionEventDto(seq = 2, eventId = "e2", type = "assistant_delta", entityId = "m1", text = "lo"),
        ))
        val item = TimelineProjector.project(emptyList(), result.events).single()
        assertEquals("Hello", assertIs<TimelineItem.Message>(item).text)
    }

    @Test
    fun ephemeralWebSocketDeltasWithoutDurableSeqRenderAndDoNotCreateGap() {
        val projector = LiveTimelineProjector()
        val result = projector.apply(listOf(
            SessionEventDto(id = "delta-1", type = "text_delta", entityId = "m1", requestId = "r1", text = "Hel"),
            SessionEventDto(id = "delta-2", type = "text_delta", entityId = "m1", requestId = "r1", text = "lo"),
            SessionEventDto(seq = 1, id = "done-1", type = "message", entityId = "m1", requestId = "r1", text = "Hello"),
        ))

        assertEquals(null, result.gapExpectedSeq)
        assertEquals(1L, result.latestSeq)
        assertEquals(1, result.events.size)
        assertEquals(1L, result.events.single().seq)
        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("Hello", item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun durableCompletedMessageSuppressesLateEphemeralDelta() {
        val projector = LiveTimelineProjector()
        projector.reconcileDurableCursor(
            durableSeq = 4,
            durableMessages = mapOf("message:m1:assistant" to "Hello"),
            completedEntityIds = setOf("message:m1:assistant"),
        )

        val result = projector.apply(listOf(
            SessionEventDto(id = "late", type = "text_delta", entityId = "m1", requestId = "r1", text = " stale"),
        ))
        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("Hello", item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun durableCompletionWinsOverEarlierEphemeralDeltaInOneBatch() {
        val projector = LiveTimelineProjector()
        val result = projector.apply(listOf(
            SessionEventDto(id = "delta-1", type = "text_delta", entityId = "m1", requestId = "r1", text = "Hel"),
            SessionEventDto(seq = 1, id = "done-1", type = "assistant_completed", entityId = "m1", requestId = "r1", text = "Hello"),
        ))

        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("Hello", item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun emptyCompletionKeepsPreviouslyStreamedText() {
        val projector = LiveTimelineProjector()
        val result = projector.apply(listOf(
            SessionEventDto(
                id = "empty-completion-delta",
                type = "text_delta",
                requestId = "request-empty-completion",
                providerItemId = "item-empty-completion",
                text = "This streamed answer must remain visible.",
            ),
            SessionEventDto(
                seq = 1,
                id = "empty-completion-final",
                type = "message",
                requestId = "request-empty-completion",
                providerMessageId = "item-empty-completion",
                text = "",
            ),
        ))

        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("This streamed answer must remain visible.", item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun highFrequencyStreamingFoldsToSingleStableMessage() {
        val projector = LiveTimelineProjector()
        val fullText = (1..2000).joinToString("") { charFor(it).toString() }
        val deltas = (1..2000).map { i ->
            SessionEventDto(
                seq = i.toLong(), eventId = "e$i", type = "assistant_delta",
                entityId = "m1", requestId = "r1", text = charFor(i).toString(),
            )
        }
        val completed = SessionEventDto(
            seq = 2001, eventId = "e2001", type = "assistant_completed",
            entityId = "m1", requestId = "r1", text = fullText,
        )

        val result = projector.apply(deltas + completed)

        assertEquals(2001L, result.latestSeq)
        assertEquals(null, result.gapExpectedSeq)
        assertEquals(1, result.events.size)
        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("message:m1:assistant", item.id)
        assertEquals(fullText, item.text)
        assertEquals(true, item.completed)
    }

    @Test
    fun highFrequencyOutOfOrderBurstConvergesIdempotently() {
        val projector = LiveTimelineProjector()
        val fullText = (1..2000).joinToString("") { charFor(it).toString() }
        val deltas = (1..2000).map { i ->
            SessionEventDto(
                seq = i.toLong(), eventId = "e$i", type = "assistant_delta",
                entityId = "m1", requestId = "r1", text = charFor(i).toString(),
            )
        }
        val completed = SessionEventDto(
            seq = 2001, eventId = "e2001", type = "assistant_completed",
            entityId = "m1", requestId = "r1", text = fullText,
        )
        // Feed completion first and deltas in reverse to force the pending-buffer path.
        val shuffled = listOf(completed) + deltas.reversed()

        val result = projector.apply(shuffled)

        assertEquals(null, result.gapExpectedSeq)
        assertEquals(2001L, result.latestSeq)
        assertEquals(1, result.events.size)
        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals(fullText, item.text)
        assertEquals(true, item.completed)

        // Replaying the same burst must be idempotent: still exactly one stable row.
        val afterReplay = TimelineProjector.project(emptyList(), projector.apply(shuffled).events)
        assertEquals(1, afterReplay.size)
        assertEquals(fullText, assertIs<TimelineItem.Message>(afterReplay.single()).text)
    }

    @Test
    fun incrementalProjectorMatchesStatelessProjectionAcrossLiveUpdates() {
        val messages = listOf(
            Message("durable-1", "session-1", "user", "Sort this file", seq = 1),
        )
        val delta = SessionEventDto(
            seq = 1,
            eventId = "e2",
            type = "assistant_delta",
            entityId = "m1",
            requestId = "r1",
            text = "Hel",
        )
        val completion = SessionEventDto(
            seq = 2,
            eventId = "e3",
            type = "assistant_completed",
            entityId = "m1",
            requestId = "r1",
            text = "Hello",
        )
        val live = LiveTimelineProjector()
        val incremental = IncrementalTimelineProjector()

        val first = live.apply(listOf(delta)).events
        assertEquals(
            TimelineProjector.project(messages, first),
            incremental.project(messages, first),
        )

        val second = live.apply(listOf(completion)).events
        assertEquals(
            TimelineProjector.project(messages, second),
            incremental.project(messages, second),
        )

        // A durable refresh can remove the overlay entirely; the incremental
        // engine must rebuild instead of retaining a stale streaming row.
        assertEquals(
            TimelineProjector.project(messages, emptyList()),
            incremental.project(messages, emptyList()),
        )
    }

    @Test
    fun visibleAndDurableMessageAliasesMergeWithoutCrossRunTextDeduplication() {
        val durable = TimelineItem.Message(
            id = "durable-message",
            seq = 7,
            role = TimelineRole.Agent,
            text = "SSH 引号转义出了问题，改用脚本文件方式查询：",
            completed = true,
            requestId = "request-7",
            runId = "run-7",
        )
        val visibleAlias = durable.copy(id = "message:assistant:durable-message")
        val mergedAlias = mergeTimelineItems(listOf(visibleAlias), listOf(durable))
        assertEquals(1, mergedAlias.size)
        assertEquals(durable.text, assertIs<TimelineItem.Message>(mergedAlias.single()).text)
        assertEquals(true, assertIs<TimelineItem.Message>(mergedAlias.single()).completed)

        val sameTextDifferentRun = durable.copy(
            id = "other-run-message",
            requestId = "request-other",
            runId = "run-other",
        )
        assertEquals(
            2,
            mergeTimelineItems(listOf(durable), listOf(sameTextDifferentRun)).size,
            "identical text from different runs must remain separate",
        )

        val sameRunDifferentSequence = durable.copy(
            id = visibleAlias.id,
            seq = 101,
            completed = false,
            text = durable.text.removeSuffix("："),
        )
        assertEquals(
            1,
            mergeTimelineItems(listOf(sameRunDifferentSequence), listOf(durable)).size,
            "the same run must reconcile even when visible and durable projections use different sequence spaces",
        )
    }

    @Test
    fun projectsCanonicalVisibleCommandWithItsStateAndDetail() {
        val event = com.andysagent.ragent.core.protocol.RagentProtocol.json.decodeFromString(
            SessionEventDto.serializer(),
            """{"seq":5,"endSeq":6,"type":"operation","operationId":"operation-1","state":"completed","kind":"command","title":"List files","detail":"ls","exitCode":0,"outputPreview":{"head":["README.md"],"tail":[],"totalLines":1,"omittedLines":0,"bodyAvailable":false}}""",
        )
        val events = LiveTimelineProjector().projectPage(listOf(event))
        val item = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), events).single())
        assertEquals("operation-1", item.id)
        assertEquals(TimelineOperationKind.Command, item.kind)
        assertEquals(TimelineOperationStatus.Completed, item.status)
        assertEquals("ls", item.detail)
        assertEquals("README.md", item.outputJson)
    }

    @Test
    fun projectsToolCallAndToolResultLifecycleWithExitCodes() {
        val projector = LiveTimelineProjector()
        val toolUse = SessionEventDto(
            seq = 1,
            eventId = "e1",
            type = "tool_use",
            operationId = "op-1",
            toolName = "run_command",
            title = "Execute gradle build",
            durationMs = 50,
        )
        val inProgress = projector.apply(listOf(toolUse))
        val inProgressItem = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), inProgress.events).single())
        assertEquals("op-1", inProgressItem.id)
        assertEquals("Execute gradle build", inProgressItem.title)
        assertEquals(TimelineOperationKind.Command, inProgressItem.kind)
        assertEquals(TimelineOperationStatus.InProgress, inProgressItem.status)

        val toolResult = SessionEventDto(
            seq = 2,
            eventId = "e2",
            type = "tool_result",
            operationId = "op-1",
            toolName = "run_command",
            text = "BUILD SUCCESSFUL",
            exitCode = 0,
            durationMs = 1200,
        )
        val completed = projector.apply(listOf(toolResult))
        val completedItem = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), completed.events).single())
        assertEquals("op-1", completedItem.id)
        assertEquals(TimelineOperationStatus.Completed, completedItem.status)
        assertEquals("BUILD SUCCESSFUL", completedItem.detail)
        assertEquals(0, completedItem.exitCode)
        assertEquals(1200L, completedItem.durationMs)
    }

    @Test
    fun claudeToolResultsMatchProviderToolIdsWithinTheRun() {
        val events = listOf(
            SessionEventDto(seq = 1, eventId = "e1", type = "tool_use", runId = "run-a", requestId = "request-a", providerToolUseId = "call-1", toolName = "Bash"),
            SessionEventDto(seq = 2, eventId = "e2", type = "tool_result", runId = "run-a", requestId = "request-a", providerToolUseId = "call-1", toolName = "Bash", exitCode = 0),
            SessionEventDto(seq = 3, eventId = "e3", type = "tool_use", runId = "run-a", requestId = "request-a", providerToolUseId = "call-2", toolName = "Bash"),
            SessionEventDto(seq = 4, eventId = "e4", type = "tool_result", runId = "run-a", requestId = "request-a", providerToolUseId = "call-2", toolName = "Bash", exitCode = 1),
        )
        val items = TimelineProjector.project(emptyList(), LiveTimelineProjector().projectPage(events))
            .filterIsInstance<TimelineItem.Operation>()
        assertEquals(2, items.size)
        assertEquals(TimelineOperationStatus.Completed, items[0].status)
        assertEquals(TimelineOperationStatus.Failed, items[1].status)
        assertEquals(0, items[0].exitCode)
        assertEquals(1, items[1].exitCode)
    }

    @Test
    fun claudeWriteResultRetainsTheSuccessfulFileChange() {
        val events = listOf(
            SessionEventDto(seq = 1, eventId = "e1", type = "tool_use", runId = "run-a", requestId = "request-a", providerToolUseId = "call-1", toolName = "Write"),
            SessionEventDto(seq = 2, eventId = "e2", type = "file_change", runId = "run-a", requestId = "request-a", providerToolUseId = "call-1", operationLifecycle = "started", filePath = "G:\\qa\\preview check.md"),
            SessionEventDto(seq = 3, eventId = "e3", type = "tool_result", runId = "run-a", requestId = "request-a", providerToolUseId = "call-1", toolName = "call-1", operationLifecycle = "completed", exitCode = 0),
        )
        val item = TimelineProjector.project(emptyList(), LiveTimelineProjector().projectPage(events))
            .filterIsInstance<TimelineItem.Operation>().single()
        assertEquals(TimelineOperationKind.Diff, item.kind)
        assertEquals(TimelineOperationStatus.Completed, item.status)
        assertEquals("Write", item.toolName)
        assertEquals("G:\\qa\\preview check.md", item.fileChanges.single().path)
    }

    @Test
    fun projectsFailedToolResultCorrectly() {
        val projector = LiveTimelineProjector()
        val toolResult = SessionEventDto(
            seq = 1,
            eventId = "e1",
            type = "tool_result",
            operationId = "op-2",
            toolName = "run_command",
            text = "Command failed with exit code 127",
            exitCode = 127,
            status = "failed",
        )
        val result = projector.apply(listOf(toolResult))
        val item = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals(TimelineOperationStatus.Failed, item.status)
        assertEquals(127, item.exitCode)
    }

    @Test
    fun projectsFileChangesWithDiffMetrics() {
        val projector = LiveTimelineProjector()
        val fileChangeEvent = SessionEventDto(
            seq = 1,
            eventId = "e1",
            type = "file_change",
            operationId = "file-1",
            title = "Updated dependencies",
            fileChanges = listOf(
                com.andysagent.ragent.core.protocol.FileChangeDto(
                    path = "build.gradle.kts",
                    name = "build.gradle.kts",
                    type = "modify",
                    additions = 5,
                    deletions = 2,
                    diffSummary = "+ implementation(libs.compose)",
                ),
            ),
        )
        val result = projector.apply(listOf(fileChangeEvent))
        val item = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals(TimelineOperationKind.Diff, item.kind)
        assertEquals("Updated dependencies", item.title)
        assertEquals(1, item.fileChanges.size)
        assertEquals("build.gradle.kts", item.fileChanges.first().name)
        assertEquals(5, item.fileChanges.first().additions)
        assertEquals(2, item.fileChanges.first().deletions)
    }

    @Test
    fun projectsAttachmentDeliveryEvents() {
        val projector = LiveTimelineProjector()
        val attachmentEvent = SessionEventDto(
            seq = 1,
            eventId = "e1",
            type = "attachment_delivery",
            entityId = "att-msg-1",
            text = "Generated chart",
            attachments = listOf(
                com.andysagent.ragent.core.protocol.AttachmentItemDto(
                    assetId = "chart-1",
                    filename = "chart.png",
                    mimeType = "image/png",
                    downloadUrl = "https://example.test/chart.png",
                ),
            ),
        )
        val result = projector.apply(listOf(attachmentEvent))
        val item = assertIs<TimelineItem.Message>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals(1, item.attachments.size)
        assertEquals("chart-1", item.attachments.first().assetId)
        assertEquals("chart.png", item.attachments.first().filename)
    }

    @Test
    fun projectsThinkingAndReasoningStreamLifecycle() {
        val projector = LiveTimelineProjector()
        val thinkingDelta1 = SessionEventDto(
            seq = 1,
            eventId = "e1",
            type = "reasoning",
            entityId = "turn-1",
            text = "Analyzing the codebase",
        )
        val thinkingDelta2 = SessionEventDto(
            seq = 2,
            eventId = "e2",
            type = "reasoning",
            entityId = "turn-1",
            text = " and checking tests...",
        )
        val thinkingComplete = SessionEventDto(
            seq = 3,
            eventId = "e3",
            type = "thinking_block",
            state = "completed",
            entityId = "turn-1",
            text = "Analyzing the codebase and checking tests...",
            durationMs = 450,
        )
        val result = projector.apply(listOf(thinkingDelta1, thinkingDelta2, thinkingComplete))
        val item = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), result.events).single())
        assertEquals("Thinking", item.title)
        assertTrue(item.isReasoning)
        assertEquals(TimelineOperationStatus.Completed, item.status)
        assertEquals("Analyzing the codebase and checking tests...", item.detail)
        assertEquals(450L, item.durationMs)
    }

    @Test
    fun lateReasoningDeltaRetainsItsThinkingIdentity() {
        val projector = LiveTimelineProjector()
        val completed = SessionEventDto(seq = 1, eventId = "done", type = "reasoning", state = "completed",
            entityId = "block", text = "Complete")
        val late = SessionEventDto(seq = 2, eventId = "late", type = "reasoning", state = "running",
            entityId = "block", text = "stale")
        val item = assertIs<TimelineItem.Operation>(TimelineProjector.project(emptyList(), projector.apply(listOf(completed, late)).events).single())
        assertTrue(item.isReasoning)
        assertEquals("Complete", item.detail)
        assertEquals(TimelineOperationStatus.Completed, item.status)
    }

    private fun charFor(i: Int): Char = ('a'.code + ((i - 1) % 26)).toChar()
}
