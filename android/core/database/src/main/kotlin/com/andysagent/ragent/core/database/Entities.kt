package com.andysagent.ragent.core.database

import androidx.room.Entity
import androidx.room.Index

@Entity(tableName = "computers")
data class ComputerEntity(
    @androidx.room.PrimaryKey val id: String,
    val name: String,
    val platform: String?,
    val endpoint: String?,
    val connected: Boolean,
    val updatedAt: Long,
)

@Entity(tableName = "projects")
data class ProjectEntity(
    @androidx.room.PrimaryKey val id: String,
    val name: String,
    val folder: String?,
    val updatedAt: Long,
    @androidx.room.ColumnInfo(defaultValue = "0") val pinned: Boolean = false,
)

@Entity(tableName = "sessions", indices = [Index(value = ["projectId"])])
data class SessionEntity(
    @androidx.room.PrimaryKey val id: String,
    val title: String,
    val projectId: String?,
    val status: String,
    val latestSeq: Long,
    val updatedAt: Long,
    val lastAssistantMessageAt: Long? = null,
    val lastReviewedAt: Long? = null,
    val workflowStateChangedAt: Long? = null,
    val workflowState: String? = null,
    val waitingAction: String? = null,
    val templateId: String? = null,
    /** JSON array of QueuedFollowUpDto; null means this list response did not include detail. */
    val queuedMessagesJson: String? = null,
    @androidx.room.ColumnInfo(defaultValue = "0")
    val timelineProjectionVersion: Int = 2,
    @androidx.room.ColumnInfo(defaultValue = "0") val pinned: Boolean = false,
)

@Entity(
    tableName = "messages",
    indices = [Index(value = ["sessionId", "seq"]), Index(value = ["sessionId", "requestId"])],
)
data class MessageEntity(
    @androidx.room.PrimaryKey val id: String,
    val sessionId: String,
    val role: String,
    val content: String,
    val seq: Long?,
    val requestId: String?,
    val runId: String? = null,
    val completed: Boolean,
    val updatedAt: Long,
    @androidx.room.ColumnInfo(defaultValue = "0") val lastEventSeq: Long = seq ?: 0,
    @androidx.room.ColumnInfo(defaultValue = "0") val revision: Long = 0,
    @androidx.room.ColumnInfo(defaultValue = "'completed'") val messageState: String = if (completed) "completed" else "streaming",
    val messagePhase: String? = null,
    val metadataJson: String? = null,
)

/** Rebuilds remain invisible until the complete authoritative prefix is verified. */
@Entity(tableName = "timeline_message_staging", primaryKeys = ["sessionId", "id"])
data class TimelineMessageStagingEntity(
    val sessionId: String,
    val id: String,
    val role: String,
    val content: String,
    val seq: Long,
    val lastEventSeq: Long,
    val revision: Long,
    val messageState: String,
    val requestId: String?,
    val runId: String?,
    val messagePhase: String? = null,
    val metadataJson: String? = null,
)

/** Completed duration is immutable and remains available while offline. */
@Entity(tableName = "run_durations", primaryKeys = ["sessionId", "runId"])
data class RunDurationEntity(val sessionId: String, val runId: String, val durationMs: Long)

@Entity(tableName = "approvals", indices = [Index(value = ["sessionId", "status"])])
data class ApprovalEntity(
    @androidx.room.PrimaryKey val id: String,
    val sessionId: String,
    val title: String,
    val status: String,
    val runId: String? = null,
    val batchId: String? = null,
    val kind: String = "approval",
    val detailsJson: String? = null,
    val reason: String? = null,
    val saferAlternative: String? = null,
    val approveLabel: String = "Approve",
    val denyLabel: String = "Deny",
    val updatedAt: Long,
)

@Entity(tableName = "pending_operations")
data class PendingOperationEntity(
    @androidx.room.PrimaryKey val requestId: String,
    val kind: String,
    val path: String,
    val payload: String,
    val state: String,
    val createdAt: Long,
    val updatedAt: Long,
    /** The original HTTP method must survive process death; old rows default to POST. */
    val method: String = "POST",
    /** JSON-encoded request headers required to replay the request faithfully. */
    val headersJson: String = "{}",
    val idempotencyKey: String? = null,
    val lastError: String? = null,
)

@Entity(tableName = "sync_cursors")
data class SyncCursorEntity(
    @androidx.room.PrimaryKey val scope: String,
    val lastAppliedSeq: Long,
    val lastEventId: String?,
    val lastServerCursor: String? = null,
    val lastSnapshotVersion: Long? = null,
    val updatedAt: Long,
)

@Entity(
    tableName = "session_events",
    indices = [Index(value = ["sessionId", "seq"]), Index(value = ["sessionId", "entityId"])],
)
data class SessionEventEntity(
    @androidx.room.PrimaryKey val eventId: String,
    val sessionId: String,
    val seq: Long,
    val entityId: String?,
    val revision: Long?,
    val clientId: String?,
    val type: String?,
    val fingerprint: String,
    val appliedAt: Long,
)

@Entity(tableName = "target_runtime_summaries")
data class TargetRuntimeSummaryEntity(
    @androidx.room.PrimaryKey val targetId: String,
    val instanceId: String,
    val revision: Long,
    val eventCursor: Long,
    val generatedAt: String,
    val payloadJson: String,
    val updatedAt: Long,
)

@Entity(tableName = "target_runtime_summary_events", indices = [Index(value = ["targetId", "cursor"])])
data class TargetRuntimeSummaryEventEntity(
    @androidx.room.PrimaryKey val eventKey: String,
    val eventId: String,
    val targetId: String,
    val instanceId: String,
    val entityType: String,
    val entityId: String,
    val revision: Long,
    val type: String,
    val emittedAt: String,
    val cursor: Long,
    val summaryJson: String,
    val appliedAt: Long,
)

@Entity(tableName = "target_runtime_summary_cursors")
data class TargetRuntimeSummaryCursorEntity(
    @androidx.room.PrimaryKey val targetId: String,
    val cursor: Long,
    val revision: Long,
    val updatedAt: Long,
)
