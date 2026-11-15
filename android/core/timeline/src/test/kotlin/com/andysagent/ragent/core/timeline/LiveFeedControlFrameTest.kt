package com.andysagent.ragent.core.timeline

import com.andysagent.ragent.core.protocol.SessionEventDto
import org.junit.Assert.*
import org.junit.Test

class LiveFeedControlFrameTest {
    @Test fun codexInventoryBeforeTokensDoesNotRejectTheLivePage() {
        val projector = LiveTimelineProjector()
        projector.reconcileDurableCursor(3)
        val result = projector.apply(listOf(
            SessionEventDto(type = "status", eventId = "live:1", role = "system", runId = "run-a"),
            SessionEventDto(type = "status", eventId = "live:2", role = "system", runId = "run-a"),
            token("live:3", "1\n"), token("live:4", "2"),
        ))
        assertNull(result.invalidEvent)
        assertNull(result.gapExpectedSeq)
        assertEquals(3L, result.latestSeq)
        assertEquals("1\n2", result.events.single().text)
        assertEquals("streaming", result.events.single().messageState)
    }

    @Test fun sequencelessTerminalControlCompletesOnlyItsRun() {
        val projector = LiveTimelineProjector()
        projector.apply(listOf(token("live:1", "hello")))
        val result = projector.apply(listOf(SessionEventDto(type = "run_completed", eventId = "live:2", runId = "run-a")))
        assertNull(result.invalidEvent)
        assertEquals("completed", result.events.single().messageState)
    }

    @Test fun unknownSequencelessEventsStillFailClosed() {
        assertNotNull(LiveTimelineProjector().apply(listOf(SessionEventDto(type = "unknown", eventId = "live:1"))).invalidEvent)
    }

    @Test fun compactionInternalsDoNotAppearInHistory() {
        val events = LiveTimelineProjector().projectPage(listOf(
            SessionEventDto(seq = 1, eventId = "barrier", type = "context_barrier", content = kotlinx.serialization.json.JsonPrimitive("internal marker")),
            SessionEventDto(seq = 2, eventId = "handoff", type = "message", role = "assistant", source = "context_compaction_handoff", content = kotlinx.serialization.json.JsonPrimitive("internal handoff")),
            SessionEventDto(seq = 3, eventId = "answer", type = "message", role = "assistant", content = kotlinx.serialization.json.JsonPrimitive("visible answer")),
        ))
        assertEquals(listOf("visible answer"), events.map { it.text })
    }

    private fun token(id: String, text: String) = SessionEventDto(
        type = "text_delta", eventId = id, role = "assistant", canonicalMessageId = "message-a",
        firstSeq = 3, text = text, textMode = "delta", messageState = "streaming", runId = "run-a",
    )
}
