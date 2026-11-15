package com.andysagent.ragent.core.timeline

import com.andysagent.ragent.core.protocol.SessionEventDto
import kotlin.test.*
import org.junit.Test

class TimelineConsistencyTest {
    @Test fun startAndTokensInOnePushDoNotEraseTheReceivedBody() {
        val p = LiveTimelineProjector()
        val result = p.apply(listOf(
            SessionEventDto(seq = 1, eventId = "start", type = "message_start", canonicalMessageId = "m", firstSeq = 1,
                messageState = "streaming", textMode = "snapshot", text = ""),
            SessionEventDto(eventId = "token", type = "text_delta", canonicalMessageId = "m", firstSeq = 1, text = "Visible"),
        ))
        val item = TimelineProjector.project(emptyList(), result.events).filterIsInstance<TimelineItem.Message>().single()
        assertEquals("Visible", item.text)
        assertFalse(item.completed)
    }

    @Test fun unrelatedDurableAcknowledgementCannotRemoveUnsequencedTokens() {
        val p = LiveTimelineProjector()
        p.reconcileDurableCursor(1, mapOf("m" to ""))
        p.apply(listOf(SessionEventDto(eventId = "token", type = "text_delta", canonicalMessageId = "m", firstSeq = 1, text = "Retained")))
        p.reconcileDurableCursor(2, mapOf("m" to ""))
        assertEquals("Retained", p.snapshotEvents().single().text)
    }
    private fun message(seq: Long, id: String, text: String, role: String = "assistant") = SessionEventDto(
        seq = seq, eventId = "event-$seq", type = "message", role = role,
        requestId = "request", runId = "run", providerMessageId = id, text = text,
    )

    @Test fun distinctMessagesInOneRequestRemainDistinctEvenWithIdenticalBodies() {
        val events = LiveTimelineProjector().apply(listOf(message(1, "a", "Same"), message(2, "b", "Same"))).events
        assertEquals(2, TimelineProjector.project(emptyList(), events).size)
    }

    @Test fun historySnapshotUpdatesKeepTheirFirstPositionAcrossUserInput() {
        val events = LiveTimelineProjector().projectPage(listOf(
            message(10, "a", "First"), message(11, "u", "Follow-up", "user"), message(12, "a", "Final"),
        ))
        val items = TimelineProjector.project(emptyList(), events).filterIsInstance<TimelineItem.Message>()
        assertEquals(listOf("Final", "Follow-up"), items.map { it.text })
        assertEquals(listOf(10L, 11L), items.map { it.seq })
    }

    @Test fun reusedHarnessEventIdsInDifferentRunsKeepBothUserMessages() {
        val events = listOf(
            SessionEventDto(seq = 1, id = "evt_000001", type = "message", role = "user", runId = "run-a", requestId = "a", canonicalMessageId = "user-a", text = "first"),
            SessionEventDto(seq = 2, id = "reply-a", type = "message", role = "assistant", runId = "run-a", requestId = "a", canonicalMessageId = "assistant-a", text = "first answer"),
            SessionEventDto(seq = 3, id = "evt_000001", type = "message", role = "user", runId = "run-b", requestId = "b", canonicalMessageId = "user-b", text = "second"),
            SessionEventDto(seq = 4, id = "reply-b", type = "message", role = "assistant", runId = "run-b", requestId = "b", canonicalMessageId = "assistant-b", text = "second answer"),
        )
        val projected = LiveTimelineProjector().projectPage(events)
        val messages = TimelineProjector.project(emptyList(), projected).filterIsInstance<TimelineItem.Message>()
        assertEquals(listOf("first", "first answer", "second", "second answer"), messages.map { it.text })
    }
    @Test fun terminalRunSettlesOnlyItsMessagesWithoutCreatingAnEmptyBubble() {
        val events = LiveTimelineProjector().apply(listOf(
            SessionEventDto(seq = 1, eventId = "a", type = "text_delta", runId = "r1", providerItemId = "a", text = "Done"),
            SessionEventDto(seq = 2, eventId = "b", type = "text_delta", runId = "r2", providerItemId = "b", text = "Working"),
            SessionEventDto(seq = 3, eventId = "c", type = "status", runId = "r1", runState = "completed"),
        )).events
        val items = TimelineProjector.project(emptyList(), events).filterIsInstance<TimelineItem.Message>()
        assertEquals(2, items.size)
        assertTrue(items.first().completed)
        assertFalse(items.last().completed)
    }

    @Test fun authoritativeShorterRevisionReplacesTextWithoutChangingIdentity() {
        val p = LiveTimelineProjector()
        p.apply(listOf(message(1, "a", "Incorrect long answer")))
        val final = p.apply(listOf(message(2, "a", "Correct"))).events
        assertEquals("Correct", TimelineProjector.project(emptyList(), final).filterIsInstance<TimelineItem.Message>().single().text)
    }

    @Test fun metadataAndStatusDoNotBecomePhantomAssistantMessages() {
        val events = LiveTimelineProjector().apply(listOf(
            SessionEventDto(seq = 1, eventId = "s", type = "status", status = "completed"),
            SessionEventDto(seq = 2, eventId = "u", type = "usage", totalTokens = 50),
        )).events
        assertTrue(TimelineProjector.project(emptyList(), events).none { it is TimelineItem.Message })
    }
}
