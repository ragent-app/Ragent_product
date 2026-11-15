package com.andysagent.ragent.core.domain

import androidx.room.withTransaction
import com.andysagent.ragent.core.database.RagentDao
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.database.TargetRuntimeSummaryCursorEntity
import com.andysagent.ragent.core.database.TargetRuntimeSummaryEntity
import com.andysagent.ragent.core.database.TargetRuntimeSummaryEventEntity
import com.andysagent.ragent.core.protocol.ProtocolCodec
import com.andysagent.ragent.core.protocol.TargetSummary
import com.andysagent.ragent.core.protocol.TargetSummaryEvent
import com.andysagent.ragent.core.sync.TargetSummaryCursor
import com.andysagent.ragent.core.sync.TargetSummaryLedger
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.serializer

/** Room-backed target summary/event ledger. All event and cursor writes share one transaction. */
internal class RoomTargetSummaryLedger(
    private val database: RagentDatabase,
    private val dao: RagentDao,
    private val codec: ProtocolCodec,
) : TargetSummaryLedger {
    override suspend fun loadCursor(targetId: String): TargetSummaryCursor =
        dao.getTargetRuntimeSummaryCursor(targetId)?.let { cursor ->
            TargetSummaryCursor(cursor.targetId, cursor.cursor, cursor.revision)
        } ?: TargetSummaryCursor(targetId)

    override suspend fun findEvent(targetId: String, eventId: String): TargetSummaryEvent? =
        dao.getTargetRuntimeSummaryEvent(eventKey(targetId, eventId))?.let { event ->
            event.toProtocol(codec)
        }

    override suspend fun applyAtomically(
        targetId: String,
        event: TargetSummaryEvent,
        cursor: TargetSummaryCursor,
    ) {
        require(targetId == event.targetId) { "Target summary event target does not match ledger target" }
        require(cursor.targetId == targetId) { "Target summary cursor target does not match ledger target" }
        database.withTransaction {
            val key = eventKey(targetId, event.eventId)
            val existing = dao.getTargetRuntimeSummaryEvent(key)
            if (existing == null) {
                dao.insertTargetRuntimeSummaryEvent(event.toEntity(codec))
            } else {
                require(existing.toProtocol(codec) == event) { "Target summary event ID was reused" }
            }
            dao.upsertTargetRuntimeSummaryCursor(
                TargetRuntimeSummaryCursorEntity(
                    targetId = targetId,
                    cursor = cursor.cursor,
                    revision = cursor.revision,
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    suspend fun saveSnapshot(summary: TargetSummary, targetId: String = summary.targetId) {
        require(targetId == summary.targetId) { "Target summary target does not match ledger target" }
        database.withTransaction {
            val existing = dao.getTargetRuntimeSummary(targetId)
            if (existing == null || summary.revision >= existing.revision) {
                dao.upsertTargetRuntimeSummary(
                    TargetRuntimeSummaryEntity(
                        targetId = targetId,
                        instanceId = summary.instanceId,
                        revision = summary.revision,
                        eventCursor = summary.eventCursor.toLong(),
                        generatedAt = summary.generatedAt,
                        payloadJson = codec.encode(serializer<TargetSummary>(), summary),
                        updatedAt = System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    private fun eventKey(targetId: String, eventId: String): String = "$targetId:$eventId"
}

internal fun targetSummaryFromEntity(
    codec: ProtocolCodec,
): (TargetRuntimeSummaryEntity) -> TargetSummary = { entity ->
    codec.decode(serializer<TargetSummary>(), entity.payloadJson).validate()
}

private fun TargetSummaryEvent.toEntity(codec: ProtocolCodec): TargetRuntimeSummaryEventEntity =
    TargetRuntimeSummaryEventEntity(
        eventKey = "$targetId:$eventId",
        eventId = eventId,
        targetId = targetId,
        instanceId = instanceId,
        entityType = entityType,
        entityId = entityId,
        revision = revision,
        type = type,
        emittedAt = emittedAt,
        cursor = cursor,
        summaryJson = codec.encode(JsonObject.serializer(), summary),
        appliedAt = System.currentTimeMillis(),
    )

private fun TargetRuntimeSummaryEventEntity.toProtocol(codec: ProtocolCodec): TargetSummaryEvent =
    TargetSummaryEvent(
        eventId = eventId,
        targetId = targetId,
        instanceId = instanceId,
        entityType = entityType,
        entityId = entityId,
        revision = revision,
        type = type,
        emittedAt = emittedAt,
        cursor = cursor,
        summary = codec.parseElement(summaryJson).jsonObject,
    )
