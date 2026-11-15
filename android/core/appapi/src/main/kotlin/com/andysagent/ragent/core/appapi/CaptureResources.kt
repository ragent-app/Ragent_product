package com.andysagent.ragent.core.appapi

import androidx.room.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString

@Serializable
enum class CaptureResourceState { IMPORTING, READY, FAILED, DELETED }

/** No URI, credential, local path or caller-supplied target is a resource handle. */
@Serializable
data class CaptureResourceRef(
    val resourceId: String,
    val revision: Long,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val renderAsFile: Boolean = true,
)

@Serializable
data class CaptureResource(
    val resourceId: String,
    val callerBinding: String,
    val originalName: String,
    val mimeType: String,
    val createdAt: Long,
    val declaredSize: Long? = null,
    val state: CaptureResourceState = CaptureResourceState.IMPORTING,
    val revision: Long = 0,
    val sizeBytes: Long? = null,
    val sha256: String? = null,
    val error: ApiErrorCode? = null,
) {
    fun reference(renderAsFile: Boolean = true): CaptureResourceRef {
        if (state != CaptureResourceState.READY) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Resource is not ready")
        val size = sizeBytes ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Ready resource has no size")
        val digest = sha256 ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Ready resource has no digest")
        return CaptureResourceRef(resourceId, revision, originalName, mimeType, size, digest, renderAsFile)
    }
}

interface TaskResources {
    suspend fun validate(refs: List<CaptureResourceRef>, caller: VerifiedCaller)
    suspend fun read(ref: CaptureResourceRef, caller: VerifiedCaller): ByteArray
}

internal object NoTaskResources : TaskResources {
    override suspend fun validate(refs: List<CaptureResourceRef>, caller: VerifiedCaller) {
        if (refs.isNotEmpty()) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Resource storage is not configured")
    }
    override suspend fun read(ref: CaptureResourceRef, caller: VerifiedCaller): ByteArray =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Resource storage is not configured")
}

@Entity(tableName = "capture_resources", indices = [Index(value = ["callerBinding", "state"])])
data class CaptureResourceEntity(
    @PrimaryKey val resourceId: String,
    val callerBinding: String,
    val state: String,
    val revision: Long,
    val payload: String,
)

/** Atomic references in the same database as drafts and operations. */
@Entity(tableName = "capture_resource_bindings", primaryKeys = ["bindingId", "resourceId"],
    indices = [Index(value = ["resourceId"])], foreignKeys = [ForeignKey(entity = CaptureResourceEntity::class,
        parentColumns = ["resourceId"], childColumns = ["resourceId"], onDelete = ForeignKey.RESTRICT)])
data class CaptureResourceBindingEntity(val bindingId: String, val resourceId: String, val callerBinding: String)

@Dao
interface CaptureResourceDao {
    @Query("SELECT * FROM capture_resources WHERE resourceId = :id AND callerBinding = :caller")
    suspend fun get(id: String, caller: String): CaptureResourceEntity?
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: CaptureResourceEntity): Long
    @Query("UPDATE capture_resources SET state = :state, revision = :revision, payload = :payload WHERE resourceId = :id AND callerBinding = :caller AND revision = :previous")
    suspend fun replace(id: String, caller: String, state: String, revision: Long, payload: String, previous: Long): Int
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun pin(binding: CaptureResourceBindingEntity): Long
    @Query("SELECT COUNT(*) FROM capture_resource_bindings WHERE resourceId = :id")
    suspend fun references(id: String): Int
    @Transaction
    suspend fun pinAll(bindingId: String, caller: String, refs: List<CaptureResourceRef>) {
        refs.forEach { ref -> requireResourceMatch(get(ref.resourceId, caller)?.decodeResource(), ref) }
        refs.forEach { pin(CaptureResourceBindingEntity(bindingId, it.resourceId, caller)) }
    }
}

internal fun CaptureResourceEntity.decodeResource(): CaptureResource = AppApiJson.decodeFromString<CaptureResource>(payload).also {
    check(it.resourceId == resourceId && it.callerBinding == callerBinding && it.state.name == state && it.revision == revision) {
        "Resource row identity is inconsistent"
    }
}

internal fun requireResourceMatch(resource: CaptureResource?, ref: CaptureResourceRef): CaptureResource {
    if (resource == null || resource.state != CaptureResourceState.READY) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Resource is unavailable for this caller")
    if (resource.reference(ref.renderAsFile) != ref) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Resource differs from its frozen reference")
    return resource
}

internal fun validateResourceRefs(refs: List<CaptureResourceRef>) {
    if (refs.size > 16 || refs.map { it.resourceId }.distinct().size != refs.size) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid resource count or duplicate identity")
    refs.forEach {
        if (!Regex("[A-Za-z0-9_-]{1,64}").matches(it.resourceId) || it.revision < 1
            || it.originalName.isBlank() || it.originalName.length > 255 || it.originalName.any { c -> c in "\\/\u0000\r\n" }
            || it.mimeType.isBlank() || it.mimeType.length > 256 || it.mimeType.any { c -> c in "\u0000\r\n" }
            || it.sizeBytes !in 1..25L * 1024 * 1024 || !Regex("[a-f0-9]{64}").matches(it.sha256)) {
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid resource descriptor")
        }
    }
    if (refs.sumOf { it.sizeBytes } > 100L * 1024 * 1024) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Resources exceed the combined byte limit")
}
