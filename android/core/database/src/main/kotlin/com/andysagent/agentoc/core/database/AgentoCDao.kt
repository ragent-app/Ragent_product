package com.andysagent.agentoc.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface AgentoCDao {
    @Query("SELECT * FROM run_durations WHERE sessionId = :sessionId")
    fun observeRunDurations(sessionId: String): Flow<List<RunDurationEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertRunDuration(item: RunDurationEntity)

    @Query("DELETE FROM run_durations WHERE sessionId = :sessionId")
    suspend fun deleteRunDurations(sessionId: String)

    @Query("SELECT * FROM computers ORDER BY name")
    fun observeComputers(): Flow<List<ComputerEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertComputers(items: List<ComputerEntity>)

    @Query("DELETE FROM computers")
    suspend fun deleteAllComputers()

    @androidx.room.Transaction
    suspend fun replaceComputers(items: List<ComputerEntity>) {
        deleteAllComputers()
        upsertComputers(items)
    }

    @Query("SELECT * FROM projects ORDER BY name")
    fun observeProjects(): Flow<List<ProjectEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProjects(items: List<ProjectEntity>)

    @Query("DELETE FROM projects WHERE id = :projectId")
    suspend fun deleteProject(projectId: String)

    @Query("DELETE FROM projects")
    suspend fun deleteAllProjects()

    @androidx.room.Transaction
    suspend fun replaceProjects(items: List<ProjectEntity>) {
        deleteAllProjects()
        upsertProjects(items)
    }

    @Query("SELECT * FROM sessions ORDER BY updatedAt DESC")
    fun observeSessions(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE id = :sessionId LIMIT 1")
    suspend fun getSession(sessionId: String): SessionEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSessions(items: List<SessionEntity>)

    @Query("DELETE FROM sessions")
    suspend fun deleteAllSessions()

    @androidx.room.Transaction
    suspend fun replaceSessions(items: List<SessionEntity>) {
        deleteAllSessions()
        upsertSessions(items)
    }

    @Query("SELECT * FROM messages WHERE sessionId = :sessionId ORDER BY seq ASC, updatedAt ASC")
    fun observeMessages(sessionId: String): Flow<List<MessageEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertMessages(items: List<MessageEntity>)

    @Query("SELECT * FROM timeline_message_staging WHERE sessionId = :sessionId AND id = :id")
    suspend fun getStagedMessage(sessionId: String, id: String): TimelineMessageStagingEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertStagedMessage(message: TimelineMessageStagingEntity)

    @Query("DELETE FROM timeline_message_staging WHERE sessionId = :sessionId")
    suspend fun clearStagedMessages(sessionId: String)

    @Query("UPDATE timeline_message_staging SET messageState = :state WHERE sessionId = :sessionId AND messageState = 'streaming' AND ((:runId IS NOT NULL AND runId = :runId) OR (:runId IS NULL AND :requestId IS NOT NULL AND requestId = :requestId))")
    suspend fun settleStagedMessages(sessionId: String, runId: String?, requestId: String?, state: String)

    @Query("DELETE FROM messages WHERE sessionId = :sessionId")
    suspend fun deleteSessionMessages(sessionId: String)

    @Query("DELETE FROM session_events WHERE sessionId = :sessionId")
    suspend fun deleteSessionEventProjection(sessionId: String)

    @Query("INSERT INTO messages (id, sessionId, role, content, seq, requestId, runId, completed, updatedAt, lastEventSeq, revision, messageState, messagePhase) SELECT id, sessionId, role, content, seq, requestId, runId, messageState != 'streaming', :now, lastEventSeq, revision, messageState, messagePhase FROM timeline_message_staging WHERE sessionId = :sessionId")
    suspend fun publishStagedMessages(sessionId: String, now: Long)

    @Query("UPDATE sessions SET timelineProjectionVersion = 2 WHERE id = :sessionId")
    suspend fun markTimelineProjectionCurrent(sessionId: String)

    @Query("SELECT * FROM messages WHERE sessionId = :sessionId ORDER BY seq ASC, updatedAt ASC")
    suspend fun getMessages(sessionId: String): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE id = :messageId LIMIT 1")
    suspend fun getMessage(messageId: String): MessageEntity?

    @Query("SELECT * FROM messages WHERE sessionId = :sessionId AND requestId = :requestId AND role = :role ORDER BY seq ASC, updatedAt ASC LIMIT 1")
    suspend fun getMessageByRequestId(sessionId: String, requestId: String, role: String): MessageEntity?

    @Query("SELECT * FROM messages WHERE sessionId = :sessionId AND runId = :runId AND role = :role ORDER BY seq ASC, updatedAt ASC")
    suspend fun getMessagesByRunId(sessionId: String, runId: String, role: String): List<MessageEntity>

    @Query("SELECT * FROM approvals WHERE sessionId = :sessionId AND status = 'pending' ORDER BY updatedAt ASC")
    fun observePendingApprovals(sessionId: String): Flow<List<ApprovalEntity>>

    @Query("SELECT * FROM approvals WHERE sessionId = :sessionId AND status = 'pending' ORDER BY updatedAt ASC")
    suspend fun getPendingApprovals(sessionId: String): List<ApprovalEntity>

    @Query("SELECT * FROM approvals WHERE status = 'pending' AND runId = :runId AND batchId = :batchId")
    suspend fun getPendingApprovalsForBatch(runId: String, batchId: String): List<ApprovalEntity>

    /** Global pending approvals across every cached session of one computer. */
    @Query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY updatedAt ASC")
    fun observeAllPendingApprovals(): Flow<List<ApprovalEntity>>

    @Query("SELECT * FROM approvals WHERE sessionId = :sessionId AND id = :approvalId LIMIT 1")
    suspend fun getApproval(sessionId: String, approvalId: String): ApprovalEntity?

    @Query("SELECT * FROM approvals WHERE sessionId = :sessionId AND batchId = :batchId LIMIT 1")
    suspend fun getApprovalByBatchId(sessionId: String, batchId: String): ApprovalEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertApprovals(items: List<ApprovalEntity>)

    @Query("UPDATE approvals SET status = :status, updatedAt = :updatedAt WHERE id = :approvalId")
    suspend fun updateApprovalStatus(approvalId: String, status: String, updatedAt: Long)

    @Query("SELECT * FROM sync_cursors WHERE scope = :scope LIMIT 1")
    suspend fun getCursor(scope: String): SyncCursorEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCursor(cursor: SyncCursorEntity)

    @Query("SELECT * FROM session_events WHERE eventId = :eventId LIMIT 1")
    suspend fun getSessionEvent(eventId: String): SessionEventEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSessionEvent(event: SessionEventEntity): Long

    @Query("SELECT * FROM target_runtime_summaries WHERE targetId = :targetId LIMIT 1")
    suspend fun getTargetRuntimeSummary(targetId: String): TargetRuntimeSummaryEntity?

    @Query("SELECT * FROM target_runtime_summaries WHERE targetId = :targetId LIMIT 1")
    fun observeTargetRuntimeSummary(targetId: String): Flow<TargetRuntimeSummaryEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTargetRuntimeSummary(summary: TargetRuntimeSummaryEntity)

    @Query("SELECT * FROM target_runtime_summary_cursors WHERE targetId = :targetId LIMIT 1")
    suspend fun getTargetRuntimeSummaryCursor(targetId: String): TargetRuntimeSummaryCursorEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTargetRuntimeSummaryCursor(cursor: TargetRuntimeSummaryCursorEntity)

    @Query("SELECT * FROM target_runtime_summary_events WHERE eventKey = :eventKey LIMIT 1")
    suspend fun getTargetRuntimeSummaryEvent(eventKey: String): TargetRuntimeSummaryEventEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertTargetRuntimeSummaryEvent(event: TargetRuntimeSummaryEventEntity): Long

    @Query("SELECT * FROM pending_operations WHERE state IN ('pending', 'sending') ORDER BY createdAt ASC")
    suspend fun pendingOperations(): List<PendingOperationEntity>

    @Query("SELECT * FROM pending_operations WHERE state = 'acknowledged' ORDER BY createdAt ASC")
    suspend fun acknowledgedOperations(): List<PendingOperationEntity>

    @Query("SELECT * FROM pending_operations WHERE requestId = :requestId LIMIT 1")
    suspend fun getPendingOperation(requestId: String): PendingOperationEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertOperation(operation: PendingOperationEntity)

    @Query("DELETE FROM pending_operations WHERE requestId = :requestId")
    suspend fun deleteOperation(requestId: String)
}
