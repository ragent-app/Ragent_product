package com.andysagent.ragent.core.appapi

import androidx.room.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonPrimitive

@Entity(tableName = "api_session_mutations", primaryKeys = ["callerBinding", "operationId"],
    indices = [Index(value = ["requestId"], unique = true)])
data class SessionMutationEntity(
    val callerBinding: String, val operationId: String, val requestId: String,
    val revision: Long, val payload: String,
)

@Dao
interface SessionMutationDao {
    @Query("SELECT * FROM api_session_mutations WHERE callerBinding = :caller AND operationId = :operationId")
    suspend fun get(caller: String, operationId: String): SessionMutationEntity?
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: SessionMutationEntity): Long
    @Query("UPDATE api_session_mutations SET revision = :revision, payload = :payload WHERE callerBinding = :caller AND operationId = :operationId AND requestId = :requestId AND revision = :expectedRevision")
    suspend fun replace(caller: String, operationId: String, requestId: String, revision: Long, payload: String, expectedRevision: Long): Int
}

/** All immutable preparation fields are checked inside the same transaction as the revision CAS. */
class RoomSessionMutationStore(private val database: AppApiDatabase) : SessionMutationStore {
    private val dao = database.sessionMutations()
    override suspend fun get(callerBinding: String, operationId: String) = dao.get(callerBinding, operationId)?.decode()
    override suspend fun insert(operation: SessionMutationOperation): Boolean {
        require(operation.revision == 1L && operation.stage == SessionMutationStage.PREPARED && operation.receipt == null)
        return dao.insert(operation.entity()) != -1L
    }
    override suspend fun replace(operation: SessionMutationOperation, expectedRevision: Long): Boolean = database.withTransaction {
        require(operation.revision == expectedRevision + 1)
        val old = get(operation.callerBinding, operation.request.operationId) ?: return@withTransaction false
        require(operation.samePreparation(old)) { "Mutation preparation is immutable" }
        if (old.revision != expectedRevision) return@withTransaction false
        val entity = operation.entity()
        dao.replace(entity.callerBinding, entity.operationId, entity.requestId, entity.revision, entity.payload, expectedRevision) == 1
    }
    private fun SessionMutationOperation.entity() = SessionMutationEntity(callerBinding, request.operationId,
        command.requestId, revision, AppApiJson.encodeToString(this))
    private fun SessionMutationEntity.decode() = AppApiJson.decodeFromString<SessionMutationOperation>(payload).also {
        check(it.callerBinding == callerBinding && it.request.operationId == operationId &&
            it.command.requestId == requestId && it.revision == revision && revision > 0) { "Mutation journal identity is inconsistent" }
        it.request.validate(); it.command.validate(); it.receipt?.validate()
        check((it.stage == SessionMutationStage.APPLIED) == (it.receipt != null)) { "Mutation journal stage is inconsistent" }
        check(it.command.kind == it.request.kind && it.command.value ==
            (if (it.request.kind == com.andysagent.ragent.core.domain.SessionMutationKind.RENAME)
                JsonPrimitive(it.request.title!!) else JsonPrimitive(it.request.flag!!))) { "Mutation journal value is inconsistent" }
        check(it.request.projectId == null || it.request.projectId == it.command.expectedProjectId) { "Mutation journal project is inconsistent" }
        check(it.deadlineAt > it.createdAt && it.deadlineAt - it.createdAt <= 3_600_000) { "Mutation journal deadline is inconsistent" }
        it.receipt?.let { receipt ->
            check(receipt.requestId == requestId && receipt.sessionId == it.request.sessionId && receipt.kind == it.command.kind &&
                receipt.scopeRevision == it.command.expectedScopeRevision && receipt.projectId == it.command.expectedProjectId &&
                receipt.revision != it.command.expectedRevision && !receipt.duplicate) { "Mutation journal receipt is inconsistent" }
        }
    }
}
