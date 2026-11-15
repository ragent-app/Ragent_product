package com.andysagent.ragent.core.sync

import com.andysagent.ragent.core.protocol.TargetSummaryEvent
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class TargetSummarySyncEngineTest {
    private class FakeLedger : TargetSummaryLedger {
        var cursor = TargetSummaryCursor("target-a")
        val events = linkedMapOf<String, TargetSummaryEvent>()

        override suspend fun loadCursor(targetId: String): TargetSummaryCursor = cursor

        override suspend fun findEvent(targetId: String, eventId: String): TargetSummaryEvent? =
            events["$targetId:$eventId"]

        override suspend fun applyAtomically(
            targetId: String,
            event: TargetSummaryEvent,
            cursor: TargetSummaryCursor,
        ) {
            events["$targetId:${event.eventId}"] = event
            this.cursor = cursor
        }
    }

    private fun event(cursor: Long, eventId: String = "event-$cursor", targetId: String = "target-a") =
        TargetSummaryEvent(
            eventId = eventId,
            targetId = targetId,
            instanceId = targetId,
            entityId = "session-1",
            revision = cursor,
            emittedAt = "2099-01-01T00:00:00Z",
            cursor = cursor,
            summary = buildJsonObject { put("cursor", cursor) },
        )

    @Test
    fun appliesOrderedEventsAndIgnoresExactReplay() = runBlocking {
        val ledger = FakeLedger()
        val engine = TargetSummarySyncEngine("target-a", ledger)

        assertEquals(2, assertIs<TargetSummarySyncResult.Applied>(engine.apply(listOf(event(1), event(2)))).count)
        assertEquals(0, assertIs<TargetSummarySyncResult.Applied>(engine.apply(listOf(event(1), event(2)))).count)
        assertEquals(2L, ledger.cursor.cursor)
        assertEquals(2, ledger.events.size)
    }

    @Test
    fun reportsGapWithoutPartiallyApplyingLaterEvents() = runBlocking {
        val ledger = FakeLedger()
        val result = TargetSummarySyncEngine("target-a", ledger).apply(listOf(event(1), event(3)))

        val gap = assertIs<TargetSummarySyncResult.GapDetected>(result)
        assertEquals(2L, gap.expectedCursor)
        assertEquals(3L, gap.receivedCursor)
        assertEquals(1L, ledger.cursor.cursor)
        assertEquals(1, ledger.events.size)
    }

    @Test
    fun rejectsTargetMismatchAndEventIdReuse() = runBlocking {
        val ledger = FakeLedger()
        val engine = TargetSummarySyncEngine("target-a", ledger)
        engine.apply(listOf(event(1)))

        assertIs<TargetSummarySyncResult.InvalidEvent>(engine.apply(listOf(event(2, targetId = "target-b"))))
        assertIs<TargetSummarySyncResult.InvalidEvent>(
            engine.apply(listOf(event(2, eventId = "event-1").copy(summary = buildJsonObject { put("changed", true) }))),
        )
        assertEquals(1L, ledger.cursor.cursor)
    }
}
