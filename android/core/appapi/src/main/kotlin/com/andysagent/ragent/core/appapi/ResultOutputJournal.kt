package com.andysagent.ragent.core.appapi

import androidx.room.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString

@Serializable
enum class ResultOutputState { DOWNLOADING, PARTIAL, COMMITTING, READY, FAILED, DELETED }

/** Private journal data; caller bindings and filesystem paths are not public metadata. */
@Serializable
data class ResultOutput(
    val downloadId: String, val operationId: String, val callerBinding: String,
    val manifest: ResultExportManifest, val resourceId: String, val createdAt: Long, val updatedAt: Long,
    val state: ResultOutputState = ResultOutputState.DOWNLOADING, val revision: Long = 0,
    val receivedBytes: Long = 0, val prefixSha256: String = EMPTY_OUTPUT_SHA256,
    val verifiedAt: Long? = null, val error: ApiErrorCode? = null,
) {
    val resource: ResultExportResource get() = manifest.resources.firstOrNull { it.resourceId == resourceId && it.available }
        ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Output resource metadata is unavailable")
}

internal const val EMPTY_OUTPUT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

@Entity(tableName = "result_outputs", foreignKeys = [ForeignKey(entity = ApiOperationEntity::class,
    parentColumns = ["operationId"], childColumns = ["operationId"], onDelete = ForeignKey.RESTRICT)],
    indices = [Index("operationId"), Index(value = ["callerBinding", "state", "updatedAt"])])
data class ResultOutputEntity(@PrimaryKey val downloadId: String, val operationId: String,
    val callerBinding: String, val state: String, val revision: Long, val reservedBytes: Long,
    val updatedAt: Long, val payload: String)

@Dao
interface ResultOutputDao {
    @Query("SELECT * FROM result_outputs WHERE downloadId = :id") suspend fun get(id: String): ResultOutputEntity?
    @Query("SELECT * FROM result_outputs WHERE callerBinding = :caller AND state != 'DELETED' ORDER BY updatedAt DESC, downloadId LIMIT 64")
    suspend fun list(caller: String): List<ResultOutputEntity>
    @Query("SELECT * FROM result_outputs WHERE operationId = :operationId AND callerBinding = :caller AND state != 'DELETED' ORDER BY updatedAt DESC, downloadId LIMIT 64")
    suspend fun listForOperation(operationId: String, caller: String): List<ResultOutputEntity>
    @Query("SELECT COUNT(*) FROM result_outputs WHERE state != 'DELETED'") suspend fun liveCount(): Int
    @Query("SELECT IFNULL(SUM(reservedBytes), 0) FROM result_outputs WHERE state != 'DELETED'") suspend fun reservedBytes(): Long
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insert(entity: ResultOutputEntity): Long
    @Query("UPDATE result_outputs SET state = :state, revision = :revision, updatedAt = :updatedAt, payload = :payload WHERE downloadId = :id AND operationId = :operationId AND callerBinding = :caller AND revision = :expectedRevision")
    suspend fun replace(id: String, operationId: String, caller: String, state: String, revision: Long,
        updatedAt: Long, payload: String, expectedRevision: Long): Int
}

internal fun ResultOutput.entity() = ResultOutputEntity(downloadId, operationId, callerBinding, state.name,
    revision, resource.sizeBytes!!, updatedAt, AppApiJson.encodeToString(this))
internal fun ResultOutputEntity.decodeOutput(): ResultOutput = AppApiJson.decodeFromString<ResultOutput>(payload).also {
    if (it.downloadId != downloadId || it.operationId != operationId || it.callerBinding != callerBinding ||
        it.state.name != state || it.revision != revision || it.updatedAt != updatedAt ||
        it.resource.sizeBytes != reservedBytes || it.receivedBytes !in 0..reservedBytes ||
        !exportDigestPattern.matches(it.prefixSha256) ||
        (it.state in setOf(ResultOutputState.COMMITTING, ResultOutputState.READY) &&
            (it.verifiedAt == null || it.receivedBytes != reservedBytes || it.prefixSha256 != it.resource.sha256))) {
        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Output journal identity or verification marker differs")
    }
}
