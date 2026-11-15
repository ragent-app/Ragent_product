package com.andysagent.ragent.core.appapi

import androidx.room.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

interface CaptureDraftStore {
    fun observe(caller: VerifiedCaller, limit: Int = 100): Flow<List<CaptureDraft>>
    suspend fun get(draftId: String, caller: VerifiedCaller): CaptureDraft?
    suspend fun getByOperationId(operationId: String, caller: VerifiedCaller): CaptureDraft?
    suspend fun insert(draft: CaptureDraft, caller: VerifiedCaller): Boolean
    suspend fun replace(draft: CaptureDraft, caller: VerifiedCaller, expectedRevision: Long): Boolean
    suspend fun delete(draftId: String, caller: VerifiedCaller, expectedRevision: Long): Boolean
}

@Entity(tableName = "capture_drafts", indices = [Index(value = ["callerBinding", "updatedAt"]),
    Index(value = ["operationId"], unique = true), Index(value = ["preparationId"], unique = true)])
data class CaptureDraftEntity(
    @PrimaryKey val draftId: String,
    val callerBinding: String,
    val createdAt: Long,
    val updatedAt: Long,
    val revision: Long,
    val operationId: String?,
    val preparationId: String?,
    val payload: String,
)

@Dao
interface CaptureDraftDao {
    @Query("SELECT * FROM capture_drafts WHERE draftId = :draftId AND callerBinding = :callerBinding")
    suspend fun get(draftId: String, callerBinding: String): CaptureDraftEntity?
    @Query("SELECT * FROM capture_drafts WHERE operationId = :operationId AND callerBinding = :callerBinding LIMIT 1")
    suspend fun getByOperationId(operationId: String, callerBinding: String): CaptureDraftEntity?
    @Query("SELECT * FROM capture_drafts WHERE callerBinding = :callerBinding ORDER BY updatedAt DESC, draftId ASC LIMIT :limit")
    fun observe(callerBinding: String, limit: Int): Flow<List<CaptureDraftEntity>>
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: CaptureDraftEntity): Long
    @Query("UPDATE capture_drafts SET updatedAt = :updatedAt, revision = :revision, operationId = :operationId, preparationId = :preparationId, payload = :payload WHERE draftId = :draftId AND callerBinding = :callerBinding AND revision = :expectedRevision")
    suspend fun replace(draftId: String, callerBinding: String, updatedAt: Long, revision: Long,
        operationId: String?, preparationId: String?, payload: String, expectedRevision: Long): Int
    @Query("DELETE FROM capture_drafts WHERE draftId = :draftId AND callerBinding = :callerBinding AND revision = :expectedRevision AND operationId IS NULL")
    suspend fun delete(draftId: String, callerBinding: String, expectedRevision: Long): Int
}

/** All reads are caller-bound. Exported adapters must also check capability grants. */
class RoomCaptureDraftStore(private val database: AppApiDatabase) : CaptureDraftStore {
    private val dao = database.drafts()
    override fun observe(caller: VerifiedCaller, limit: Int): Flow<List<CaptureDraft>> {
        require(limit in 1..100)
        return dao.observe(caller.binding, limit).map { rows -> rows.map { it.decode() } }
    }
    override suspend fun get(draftId: String, caller: VerifiedCaller): CaptureDraft? = dao.get(draftId, caller.binding)?.decode()
    override suspend fun getByOperationId(operationId: String, caller: VerifiedCaller): CaptureDraft? =
        dao.getByOperationId(operationId, caller.binding)?.decode()
    override suspend fun insert(draft: CaptureDraft, caller: VerifiedCaller): Boolean {
        requireCaller(draft, caller)
        validateCaptureDraft(draft)
        if (draft.revision != 0L || draft.operationId != null || draft.preparationId != null) {
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "A new draft must be editable at revision zero")
        }
        return dao.insert(draft.entity()) != -1L
    }
    override suspend fun replace(draft: CaptureDraft, caller: VerifiedCaller, expectedRevision: Long): Boolean = database.withTransaction {
        requireCaller(draft, caller)
        validateCaptureDraft(draft)
        if (draft.revision != expectedRevision + 1) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Draft revision must advance exactly once")
        val previous = dao.get(draft.draftId, caller.binding)?.decode() ?: return@withTransaction false
        if (previous.revision != expectedRevision) return@withTransaction false
        if (previous.createdAt != draft.createdAt || draft.updatedAt < previous.updatedAt) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Draft creation identity and ordering must be preserved")
        }
        if (previous.operationId == null && draft.operationId != null && draft.preparationId != null) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Freeze the draft before binding a preparation")
        }
        if (previous.operationId != null) {
            if ((previous.preparationId != null && previous.preparationId != draft.preparationId)
                || previous.copy(updatedAt = draft.updatedAt, revision = draft.revision, preparationId = draft.preparationId) != draft) {
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Frozen draft cannot be edited; create another draft")
            }
        } else if (previous.projectCreationOperationId != null) {
            if (previous.projectId == null && draft.operationId != null) {
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Save the new Project identity before freezing the task")
            }
            if (draft.projectCreationOperationId != previous.projectCreationOperationId ||
                draft.intakeId != previous.intakeId || draft.intakeDecision != previous.intakeDecision ||
                draft.targetInstanceId != previous.targetInstanceId || draft.input != previous.input ||
                draft.instruction != previous.instruction || draft.runtime != previous.runtime ||
                draft.existingSessionId != previous.existingSessionId || draft.agentId != previous.agentId ||
                (previous.projectId != null && draft.projectId != previous.projectId)) {
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Project creation has started; resume the original intake")
            }
        }
        val saved = dao.replace(draft.draftId, draft.callerBinding, draft.updatedAt, draft.revision, draft.operationId,
            draft.preparationId, AppApiJson.encodeToString(draft), expectedRevision) == 1
        if (saved && draft.operationId != null) database.resources().pinAll("draft:${draft.draftId}", caller.binding, draft.input.resources)
        saved
    }
    override suspend fun delete(draftId: String, caller: VerifiedCaller, expectedRevision: Long): Boolean = database.withTransaction {
        val previous = dao.get(draftId, caller.binding)?.decode() ?: return@withTransaction false
        if (previous.projectCreationOperationId != null) return@withTransaction false
        dao.delete(draftId, caller.binding, expectedRevision) == 1
    }

    private fun requireCaller(draft: CaptureDraft, caller: VerifiedCaller) {
        if (draft.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Draft belongs to another caller")
    }
    private fun CaptureDraft.entity() = CaptureDraftEntity(draftId, callerBinding, createdAt, updatedAt, revision,
        operationId, preparationId, AppApiJson.encodeToString(this))
    private fun CaptureDraftEntity.decode(): CaptureDraft = AppApiJson.decodeFromString<CaptureDraft>(payload).also {
        check(it.draftId == draftId && it.callerBinding == callerBinding && it.createdAt == createdAt && it.updatedAt == updatedAt
            && it.revision == revision && it.operationId == operationId && it.preparationId == preparationId) { "Draft row identity is inconsistent" }
        validateCaptureDraft(it)
    }
}
