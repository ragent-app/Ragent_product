package com.andysagent.ragent.core.timeline

import com.andysagent.ragent.core.protocol.SessionEventDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class LiveTokenRebaseTest {
    @Test fun ephemeralThinkingStaysBeforeARebasedDurableReply() {
        val live = LiveTimelineProjector()
        val timeline = IncrementalTimelineProjector()
        live.reconcileDurableCursor(3)
        live.apply(listOf(SessionEventDto(seq = 0, eventId = "thought", type = "reasoning",
            text = "Thinking", runId = "run-a", requestId = "request-a")))
        timeline.project(emptyList(), live.snapshotEvents())
        live.apply(listOf(SessionEventDto(seq = 0, eventId = "token", type = "text_delta", entityId = "reply",
            role = "assistant", text = "Hello", runId = "run-a", requestId = "request-a")))
        val projected = timeline.project(emptyList(), live.snapshotEvents())
        val id = projected.filterIsInstance<TimelineItem.Message>().single().id
        val answer = com.andysagent.ragent.core.model.Message(id, "session", "assistant", "Hello",
            seq = 3, completed = true, runId = "run-a")
        live.reconcileDurableCursor(4, mapOf(id to "Hello"), setOf(id))
        val rebased = timeline.project(listOf(answer), live.snapshotEvents())
        assertTrue(rebased[0] is TimelineItem.Operation)
        assertEquals(id, rebased[1].id)
    }

    @Test fun thinkingObservedBeforeFirstTextStaysBeforeDurableAnswer() {
        val projector = IncrementalTimelineProjector()
        val start = TimelineEvent("start", 3, "text_delta", entityId = "reply", revision = 1,
            text = "", role = TimelineRole.Agent, runId = "run-a", messageState = "streaming")
        val thinking = TimelineEvent("thinking", 4, "reasoning", entityId = "thinking:run-a", revision = 2,
            text = "Thinking", operationKind = TimelineOperationKind.Tool, operationTitle = "Thinking", runId = "run-a")
        projector.project(emptyList(), listOf(start, thinking))
        val text = start.copy(id = "text", revision = 3, text = "Hello")
        val live = projector.project(emptyList(), listOf(text, thinking))
        assertEquals(listOf("thinking:run-a", "reply"), live.map { it.id })
        val answer = com.andysagent.ragent.core.model.Message("reply", "session", "assistant", "Hello",
            seq = 3, completed = true, runId = "run-a")
        val rebased = projector.project(listOf(answer), listOf(thinking.copy(seq = 5)))
        assertEquals(listOf("thinking:run-a", "reply"), rebased.map { it.id })
        assertEquals(rebased.map { it.id }, mergeTimelineItems(emptyList(), rebased).map { it.id })
    }

    @Test fun reasoningAfterVisibleTextIsNotMovedBeforeIt() {
        val projector = IncrementalTimelineProjector()
        val text = TimelineEvent("text", 3, "text_delta", entityId = "reply", revision = 1,
            text = "Hello", role = TimelineRole.Agent, runId = "run-a", messageState = "streaming")
        projector.project(emptyList(), listOf(text))
        val later = TimelineEvent("thinking", 4, "reasoning", entityId = "thinking:run-a", revision = 2,
            text = "Later", operationKind = TimelineOperationKind.Tool, runId = "run-a")
        assertEquals(listOf("reply", "thinking:run-a"), projector.project(emptyList(), listOf(text, later)).map { it.id })
    }

    @Test fun completedReplyWithNewIdentityKeepsObservedThinkingOrder() {
        val projector = IncrementalTimelineProjector()
        val thinking = TimelineEvent("thinking", 4, "reasoning", entityId = "thought", revision = 2,
            text = "Thinking", operationKind = TimelineOperationKind.Tool, runId = "run-a")
        val text = TimelineEvent("text", 3, "text_delta", entityId = "live-reply", revision = 3,
            text = "Hello", role = TimelineRole.Agent, runId = "run-a", messageState = "streaming")
        projector.project(emptyList(), listOf(thinking, text))
        val answer = com.andysagent.ragent.core.model.Message("durable-reply", "session", "assistant", "Hello",
            seq = 3, completed = true, runId = "run-a")
        assertEquals(listOf("thought", "durable-reply"),
            projector.project(listOf(answer), listOf(thinking.copy(seq = 6))).map { it.id })
    }

    @Test fun interveningToolAndOtherRunDoNotCreateAFalseAnchor() {
        val projector = IncrementalTimelineProjector()
        val thinking = TimelineEvent("thinking", 2, "reasoning", entityId = "thinking:run-a", revision = 1,
            operationKind = TimelineOperationKind.Tool, runId = "run-a")
        val tool = TimelineEvent("tool", 3, "tool_use", entityId = "tool", revision = 2,
            operationKind = TimelineOperationKind.Tool, runId = "run-a")
        val text = TimelineEvent("text", 4, "text_delta", entityId = "reply", revision = 3,
            text = "Hello", role = TimelineRole.Agent, runId = "run-a", messageState = "streaming")
        val unrelated = thinking.copy(id = "other", entityId = "thinking:other", runId = "run-b")
        val items = projector.project(emptyList(), listOf(thinking, unrelated, tool, text))
        assertEquals(2L, items.first { it.id == "thinking:run-a" }.seq)
        assertEquals(2L, items.first { it.id == "thinking:other" }.seq)
    }

    @Test fun liveTextWinsOverAnIncompleteDurableSnapshotWithAHigherRevision() {
        val durable = com.andysagent.ragent.core.model.Message(
            "reply", "session", "assistant", "", seq = 500, completed = false,
            revision = 500, lastEventSeq = 500,
        )
        val live = TimelineEvent("live:1", 501, "text_delta", entityId = "reply",
            revision = 1, text = "First real token", role = TimelineRole.Agent,
            messageState = "streaming", lastEventSeq = 0)
        val base = IncrementalTimelineProjector().project(listOf(durable), listOf(live))
        assertEquals("First real token", (base.single() as TimelineItem.Message).text)
        val visible = TimelineItem.Message("reply", 500, TimelineRole.Agent, "", false,
            revision = 500, lastEventSeq = 500)
        assertEquals("First real token", (mergeTimelineItems(listOf(visible), base).single() as TimelineItem.Message).text)
        assertEquals("First real token", (mergeTimelineItems(base, listOf(visible)).single() as TimelineItem.Message).text)
        val final = visible.copy(text = "Final authoritative answer", completed = true, messageState = "completed")
        assertEquals(final.text, (mergeTimelineItems(base, listOf(final)).single() as TimelineItem.Message).text)
    }

    @Test fun tokenTextSurvivesUnrelatedDurableProgressAndFinalHistoryReplacesIt() {
        val projector = LiveTimelineProjector()
        projector.reconcileDurableCursor(1)
        fun token(id: String, text: String) = SessionEventDto(seq = 0, eventId = id, type = "text_delta",
            entityId = "reply", role = "assistant", text = text, requestId = "request-a", runId = "run-a")
        projector.apply(listOf(token("one", "Hel")))
        assertEquals("Hel", projector.snapshotEvents().single().text)
        projector.reconcileDurableCursor(5)
        assertEquals("Hel", projector.snapshotEvents().single().text)
        projector.apply(listOf(token("two", "lo")))
        assertEquals("Hello", projector.snapshotEvents().single().text)
        val id = requireNotNull(projector.snapshotEvents().single().entityId)
        projector.reconcileDurableCursor(6, mapOf(id to "Hello"), setOf(id))
        assertTrue(projector.snapshotEvents().isEmpty())
    }

    @Test fun accumulatedTerminalRunIdsRetiresEphemeralTextAndReasoningAcrossReconcileCalls() {
        val projector = LiveTimelineProjector()
        projector.reconcileDurableCursor(9)
        projector.apply(listOf(
            SessionEventDto(seq = 0, eventId = "r1", type = "reasoning", entityId = "block-r", text = "Thinking...", runId = "run-1"),
            SessionEventDto(seq = 0, eventId = "t1", type = "text_delta", entityId = "stream-block", role = "assistant", text = "Answer", runId = "run-1"),
        ))
        assertEquals(2, projector.snapshotEvents().size)

        // Call 1: durable cursor advances with run_completed before MessageEntity arrives in Room.
        // Reasoning (messageState == null) retires after durable catch-up; streaming text waits for durableMessageRunIds.
        projector.reconcileDurableCursor(
            durableSeq = 10,
            durableMessages = emptyMap(),
            completedEntityIds = emptySet(),
            completedRunIds = setOf("run-1"),
            durableMessageRunIds = emptySet(),
        )
        assertEquals(listOf("message:stream-block:assistant"), projector.snapshotEvents().mapNotNull { it.entityId })

        // Call 2: Room receives durable MessageEntity with different entityId; completedRunIds is empty this call.
        projector.reconcileDurableCursor(
            durableSeq = 10,
            durableMessages = mapOf("durable-msg-1" to "Answer"),
            completedEntityIds = setOf("durable-msg-1"),
            completedRunIds = emptySet(),
            durableMessageRunIds = setOf("run-1"),
        )
        assertTrue(projector.snapshotEvents().isEmpty())

        // Late unsequenced reasoning or token for terminal run-1 is dropped, while completed commentary mid-run
        // on run-2 does not stop active run-2 streaming.
        projector.apply(listOf(
            SessionEventDto(seq = 0, eventId = "late-r", type = "reasoning", entityId = "block-r", text = "stale", runId = "run-1"),
            SessionEventDto(seq = 0, eventId = "late-t", type = "text_delta", entityId = "stream-block", role = "assistant", text = "stale", runId = "run-1"),
            SessionEventDto(seq = 0, eventId = "r2-t", type = "text_delta", entityId = "stream-2", role = "assistant", text = "Next", runId = "run-2"),
        ))
        projector.reconcileDurableCursor(
            durableSeq = 11,
            durableMessages = mapOf("durable-msg-1" to "Answer", "commentary-2" to "Checking..."),
            completedEntityIds = setOf("durable-msg-1", "commentary-2"),
            completedRunIds = emptySet(),
            durableMessageRunIds = setOf("run-1", "run-2"),
        )
        assertEquals(listOf("Next"), projector.snapshotEvents().mapNotNull { it.text })
    }
}
