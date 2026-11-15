package com.andysagent.ragent.core.sync

import com.andysagent.ragent.core.protocol.TargetSummaryEvent

data class TargetSummaryCursor(
    val targetId: String,
    val cursor: Long = 0L,
    val revision: Long = 0L,
)

interface TargetSummaryLedger {
    suspend fun loadCursor(targetId: String): TargetSummaryCursor
    suspend fun findEvent(targetId: String, eventId: String): TargetSummaryEvent?
    suspend fun applyAtomically(
        targetId: String,
        event: TargetSummaryEvent,
        cursor: TargetSummaryCursor,
    )
}

sealed interface TargetSummarySyncResult {
    data class Applied(val cursor: TargetSummaryCursor, val count: Int) : TargetSummarySyncResult
    data class GapDetected(val targetId: String, val expectedCursor: Long, val receivedCursor: Long) : TargetSummarySyncResult
    data class InvalidEvent(val targetId: String, val event: TargetSummaryEvent, val reason: String) : TargetSummarySyncResult
}

/** Cursor/revision-ordered summary reconciliation shared by Android targets. */
class TargetSummarySyncEngine(
    private val targetId: String,
    private val ledger: TargetSummaryLedger,
) {
    suspend fun apply(incoming: List<TargetSummaryEvent>): TargetSummarySyncResult {
        var cursor = ledger.loadCursor(targetId)
        if (cursor.targetId != targetId || cursor.cursor < 0L || cursor.revision < 0L) {
            return TargetSummarySyncResult.InvalidEvent(targetId, incoming.firstOrNull() ?: invalidPlaceholder(), "Cursor is invalid")
        }

        var applied = 0
        for (event in incoming.sortedBy { it.cursor }) {
            try {
                event.validate()
            } catch (error: Throwable) {
                return TargetSummarySyncResult.InvalidEvent(targetId, event, error.message ?: "Event is invalid")
            }
            if (event.targetId != targetId) {
                return TargetSummarySyncResult.InvalidEvent(targetId, event, "Event target does not match the selected target")
            }
            val existing = ledger.findEvent(targetId, event.eventId)
            if (existing != null) {
                if (existing != event) {
                    return TargetSummarySyncResult.InvalidEvent(targetId, event, "Event ID was reused with different content")
                }
                cursor = cursor.copy(
                    cursor = maxOf(cursor.cursor, event.cursor),
                    revision = maxOf(cursor.revision, event.revision),
                )
                continue
            }
            if (event.cursor <= cursor.cursor) {
                return TargetSummarySyncResult.InvalidEvent(targetId, event, "Unknown event arrived behind the persisted cursor")
            }
            val expected = cursor.cursor + 1L
            if (event.cursor != expected) {
                return TargetSummarySyncResult.GapDetected(targetId, expected, event.cursor)
            }
            val next = TargetSummaryCursor(targetId, event.cursor, maxOf(cursor.revision, event.revision))
            ledger.applyAtomically(targetId, event, next)
            cursor = next
            applied += 1
        }
        return TargetSummarySyncResult.Applied(cursor, applied)
    }

    private fun invalidPlaceholder(): TargetSummaryEvent = TargetSummaryEvent(
        eventId = "invalid",
        targetId = targetId,
        instanceId = targetId,
        entityId = targetId,
        emittedAt = "1970-01-01T00:00:00Z",
        cursor = 1L,
    )
}
