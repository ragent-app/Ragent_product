package com.andysagent.agentoc.core.sync

import com.andysagent.agentoc.core.model.SyncCursor
import com.andysagent.agentoc.core.protocol.SessionEventDto
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class SessionSyncEngineTest {
    private class FakeCursorStore : CursorStore {
        var value = SyncCursor("session:test", lastAppliedSeq = 100)
        override suspend fun load(scope: String): SyncCursor = value.copy(scope = scope)
        override suspend fun save(cursor: SyncCursor) { value = cursor }
    }

    @Test
    fun dedupesReplayAndAppliesOrderedEvents() = runBlocking {
        val store = FakeCursorStore()
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        val events = listOf(101, 102, 103, 103, 104).map { SessionEventDto(seq = it.toLong(), type = "assistant_delta", text = it.toString()) }
        val result = engine.apply(events)
        assertEquals(4, assertIs<SyncResult.Applied>(result).count)
        assertEquals(104, store.value.lastAppliedSeq)
        assertEquals(4, sink.state("session:test").messages.size)
    }

    @Test
    fun buffersOutOfOrderEventUntilMissingSequenceArrives() = runBlocking {
        val store = FakeCursorStore()
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        val first = engine.apply(listOf(SessionEventDto(seq = 101, type = "started"), SessionEventDto(seq = 103, type = "completed")))
        val gap = assertIs<SyncResult.GapDetected>(first)
        assertEquals(102, gap.expectedSeq)
        val recovered = engine.apply(listOf(SessionEventDto(seq = 102, type = "assistant_delta", text = "ok")))
        assertEquals(103, assertIs<SyncResult.Applied>(recovered).cursor.lastAppliedSeq)
        assertEquals("completed", sink.state("session:test").status)
    }

    @Test
    fun replayProviderClosesGapBeforeReturning() = runBlocking {
        val store = FakeCursorStore()
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine(
            "session:test",
            store,
            sink,
            ReplayProvider { _, _, _ -> listOf(SessionEventDto(seq = 102, type = "assistant_delta", text = "replayed")) },
        )
        val result = engine.apply(listOf(SessionEventDto(seq = 101, type = "started"), SessionEventDto(seq = 103, type = "completed")))
        assertEquals(103, assertIs<SyncResult.Applied>(result).cursor.lastAppliedSeq)
        assertEquals("replayed", sink.state("session:test").messages["event:102"])
    }

    @Test
    fun accumulatorCoalescesStreamingDeltasAndOnlyCompletesOnce() {
        val accumulator = StreamingAccumulator()
        accumulator.append("req", "H")
        accumulator.append("req", "i")
        assertEquals("Hi", accumulator.complete("req").text)
        assertEquals("done", accumulator.complete("req", "done").text)
    }

    @Test
    fun aNewEngineResumesFromTheDurableCursorAfterProcessDeath() = runBlocking {
        val store = FakeCursorStore()
        val firstSink = SessionEventReducer()
        SessionSyncEngine("session:test", store, firstSink).apply(listOf(
            SessionEventDto(seq = 101, type = "started"),
            SessionEventDto(seq = 102, type = "assistant_completed", text = "first"),
        ))

        val secondSink = SessionEventReducer()
        val result = SessionSyncEngine("session:test", store, secondSink).apply(listOf(
            SessionEventDto(seq = 102, type = "assistant_completed", text = "duplicate"),
            SessionEventDto(seq = 103, type = "assistant_completed", text = "second"),
        ))
        assertEquals(103, assertIs<SyncResult.Applied>(result).cursor.lastAppliedSeq)
        assertEquals(1, assertIs<SyncResult.Applied>(result).count)
    }

    @Test
    fun foregroundSocketIsClosedInBackground() = runBlocking {
        var connects = 0
        var closes = 0
        val coordinator = ConnectionLifecycleCoordinator(object : InvalidationConnection {
            override fun connect() { connects += 1 }
            override suspend fun close() { closes += 1 }
        })
        coordinator.onForeground()
        coordinator.onBackground()
        assertEquals(1, connects)
        assertEquals(1, closes)
        assertEquals(com.andysagent.agentoc.core.model.RuntimeConnectionState.Disconnected, coordinator.state.value)
    }

    @Test
    fun appliesEventsThatShareAStartSequenceAndAdvancesToTheirBoundaries() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        val result = engine.apply(listOf(
            SessionEventDto(seq = 1, type = "operation", startSeq = 1, endSeq = 1, operationId = "op"),
            SessionEventDto(seq = 2, type = "operation", startSeq = 1, endSeq = 2, operationId = "op"),
        ))
        assertEquals(2, assertIs<SyncResult.Applied>(result).count)
        assertEquals(2, store.value.lastAppliedSeq)
    }

    @Test
    fun rejectsProviderEventIdReuseWithDifferentSequence() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        val event = SessionEventDto(seq = 1, type = "text_delta", providerEventId = "provider:1", text = "Hi")
        engine.apply(listOf(event))
        val result = engine.apply(listOf(event.copy(seq = 2)))
        assertIs<SyncResult.InvalidEvent>(result)
        assertEquals(1, store.value.lastAppliedSeq)
    }

    @Test
    fun distinctNormalizedEventsFromOneProviderFrameBothAdvanceHistoryCursor() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 37) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)

        // Claude emits tool_use and file_change from the same provider frame.
        // They share providerEventId but have different immutable history ids.
        val result = engine.apply(listOf(
            SessionEventDto(
                seq = 38,
                id = "evt_022659",
                providerEventId = "claude-frame-94d8349b",
                runId = "run-a",
                type = "tool_use",
                toolName = "Read",
            ),
            SessionEventDto(
                seq = 39,
                id = "evt_022660",
                providerEventId = "claude-frame-94d8349b",
                runId = "run-a",
                type = "file_change",
                filePath = "README.md",
            ),
        ))

        assertEquals(2, assertIs<SyncResult.Applied>(result).count)
        assertEquals(39, store.value.lastAppliedSeq)
    }

    @Test
    fun reusedHarnessEventIdAcrossRunsDoesNotStopSync() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        val result = engine.apply(listOf(
            SessionEventDto(seq = 1, id = "evt_000001", runId = "run-a", type = "user_message", text = "first"),
            SessionEventDto(seq = 2, id = "evt_000001", runId = "run-b", type = "user_message", text = "second"),
        ))
        assertEquals(2, assertIs<SyncResult.Applied>(result).count)
        assertEquals(2, store.value.lastAppliedSeq)
    }
    @Test
    fun rejectsEventIdReuseWithDifferentSequenceOrPayload() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)
        engine.apply(listOf(SessionEventDto(seq = 1, eventId = "evt-1", type = "message", text = "first")))

        val result = engine.apply(listOf(SessionEventDto(seq = 2, eventId = "evt-1", type = "message", text = "changed")))
        assertIs<SyncResult.InvalidEvent>(result)
        assertEquals(1, store.value.lastAppliedSeq)
    }

    @Test
    fun multiChannelAccumulationHandlesParallelTextAndReasoning() {
        val accumulator = StreamingAccumulator()
        accumulator.appendChannel("req-1", "reasoning", "Thinking about")
        accumulator.appendChannel("req-1", "text", "Hello ")
        accumulator.appendChannel("req-1", "reasoning", " the solution")
        accumulator.appendChannel("req-1", "text", "World!")

        assertEquals("Thinking about the solution", accumulator.currentChannel("req-1", "reasoning"))
        assertEquals("Hello World!", accumulator.currentChannel("req-1", "text"))

        val completedReasoning = accumulator.completeChannel("req-1", "reasoning")
        assertEquals("Thinking about the solution", completedReasoning.text)
        assertEquals(null, accumulator.currentChannel("req-1", "reasoning"))
        assertEquals("Hello World!", accumulator.currentChannel("req-1", "text"))

        val completedText = accumulator.completeChannel("req-1", "text")
        assertEquals("Hello World!", completedText.text)
        assertEquals(null, accumulator.currentChannel("req-1", "text"))
    }

    @Test
    fun reducerHandlesPrivilegedBatchAndApprovedActionEvents() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)

        val batchReq = SessionEventDto(
            seq = 1,
            type = "approved_action_batch_request",
            batchId = "batch-101",
            title = "Execute file edits",
        )
        engine.apply(listOf(batchReq))
        assertEquals("waiting_approval", sink.state("session:test").status)
        assertEquals(setOf("batch-101"), sink.state("session:test").approvals)

        val batchResp = SessionEventDto(
            seq = 2,
            type = "approved_action_batch_response",
            batchId = "batch-101",
        )
        engine.apply(listOf(batchResp))
        assertEquals("working", sink.state("session:test").status)
        assertEquals(emptySet(), sink.state("session:test").approvals)
    }

    @Test
    fun reducerHandlesToolUseThinkingAndFileChangeEvents() = runBlocking {
        val store = FakeCursorStore().also { it.value = SyncCursor("session:test", lastAppliedSeq = 0) }
        val sink = SessionEventReducer()
        val engine = SessionSyncEngine("session:test", store, sink)

        engine.apply(listOf(
            SessionEventDto(seq = 1, type = "thinking_block", state = "running", text = "Thinking..."),
            SessionEventDto(seq = 2, type = "tool_use", toolName = "write_to_file", title = "Write file"),
            SessionEventDto(seq = 3, type = "file_change", title = "File modified"),
        ))
        assertEquals("working", sink.state("session:test").status)
        assertEquals(3, store.value.lastAppliedSeq)
    }
}
