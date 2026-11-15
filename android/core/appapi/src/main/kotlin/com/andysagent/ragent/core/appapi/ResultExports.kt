package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlinx.coroutines.ensureActive
import java.time.Instant

const val RESULT_EXPORT_CHUNK_BYTES = 65_536
const val RESULT_EXPORT_RESOURCE_BYTES = 25L * 1024 * 1024
const val RESULT_EXPORT_BATCH_BYTES = 100L * 1024 * 1024
internal val exportDigestPattern = Regex("[a-f0-9]{64}")

@Serializable
data class ResultExportResource(
    val resourceId: String, val originalName: String, val mimeType: String, val available: Boolean,
    val sizeBytes: Long? = null, val sha256: String? = null, val errorCode: String? = null,
)

/** Complete bytes from one exact retained publication, distinct from a UI preview. */
@Serializable
data class ResultExportManifest(
    val exportContractVersion: Int, val instanceId: String, val sessionId: String, val requestId: String,
    val runId: String, val finalRunId: String, val resources: List<ResultExportResource>,
    val totalBytes: Long, val maxChunkBytes: Int, val expiresAt: String, val revision: String,
)

data class ResultExportReceipt(val manifestRevision: String, val resourceId: String, val sizeBytes: Long, val sha256: String)

/** Trusted private-store reader; never serialized as an external request or URI. */
class ResultExportPrefix(val sizeBytes: Long, val sha256: String,
    val read: suspend (suspend (ByteArray) -> Unit) -> Unit)

internal suspend fun feedExportPrefix(prefix: ResultExportPrefix?, maximumBytes: Long,
    checkAccess: suspend () -> Unit, consume: suspend (ByteArray) -> Unit): Long {
    if (prefix == null) return 0
    if (prefix.sizeBytes !in 0..maximumBytes || !exportDigestPattern.matches(prefix.sha256))
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid private download checkpoint")
    var size = 0L; val hash = java.security.MessageDigest.getInstance("SHA-256")
    checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
    prefix.read { bytes ->
        checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
        if (bytes.size > RESULT_EXPORT_CHUNK_BYTES || size + bytes.size > prefix.sizeBytes)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Stored download prefix exceeds checkpoint")
        size += bytes.size; hash.update(bytes); consume(bytes)
    }
    checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
    if (size != prefix.sizeBytes || hash.digest().hex() != prefix.sha256)
        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Stored download prefix differs from checkpoint")
    return size
}

internal fun invalidExport(): Nothing = apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Result export contract, identity or integrity differs")
internal fun JsonObject.exportString(key: String): String =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalidExport()
internal fun JsonObject.exportNumber(key: String): Long =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull ?: invalidExport()
internal fun JsonObject.exportBoolean(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: invalidExport()
internal fun JsonObject.exportKeys(vararg keys: String) { if (this.keys != keys.toSet()) invalidExport() }

internal fun requireExportOperation(operation: TaskOperation, instanceId: String) {
    if (operation.targetInstanceId != instanceId || !Regex("[A-Za-z0-9_-]{1,160}").matches(operation.sessionId.orEmpty()) ||
        operation.messageRequestId.isBlank() || operation.messageRequestId.length > 200 ||
        operation.messageRequestId.any { it <= '\u001f' || it == '\u007f' } ||
        operation.stage !in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Export requires an exact dispatched submission at the bound computer")
    }
}

/** Stored DTOs encode default nullable fields; the v1 wire format omits those fields. */
internal fun ResultExportManifest.validated(operation: TaskOperation, now: Long): ResultExportManifest {
    val body = AppApiJson.parseToJsonElement(AppApiJson.encodeToString(this)).jsonObject
    val resources = JsonArray(body.getValue("resources").jsonArray.map { item ->
        JsonObject(item.jsonObject.filterValues { it != JsonNull })
    })
    return decodeResultExport(operation, JsonObject(body + ("resources" to resources)), now)
}

fun decodeResultExport(operation: TaskOperation, body: JsonObject, now: Long = System.currentTimeMillis()): ResultExportManifest {
    requireExportOperation(operation, operation.targetInstanceId)
    body.exportKeys("exportContractVersion", "instanceId", "sessionId", "requestId", "runId", "finalRunId",
        "resources", "totalBytes", "maxChunkBytes", "expiresAt", "revision")
    if (body.exportNumber("exportContractVersion") != 1L || body.exportString("instanceId") != operation.targetInstanceId ||
        body.exportString("sessionId") != operation.sessionId || body.exportString("requestId") != operation.messageRequestId ||
        body.exportNumber("maxChunkBytes") != RESULT_EXPORT_CHUNK_BYTES.toLong()) invalidExport()
    val runId = body.exportString("runId"); val finalRunId = body.exportString("finalRunId")
    if (listOf(runId, finalRunId).any { it.isBlank() || it.length > 256 || it.any { c -> c <= '\u001f' || c == '\u007f' } } ||
        operation.runId?.let { it != runId } == true) invalidExport()
    val revision = body.exportString("revision")
    if (!exportDigestPattern.matches(revision)) invalidExport()
    val expiry = body.exportString("expiresAt")
    val expiryMillis = runCatching { Instant.parse(expiry).toEpochMilli() }.getOrElse { invalidExport() }
    if (expiryMillis <= now) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Download snapshot has expired; query a new manifest")
    val items = body["resources"] as? JsonArray ?: invalidExport()
    if (items.isEmpty() || items.size > 17) invalidExport()
    val resources = items.map { item ->
        val value = item as? JsonObject ?: invalidExport()
        val id = value.exportString("resourceId"); val name = value.exportString("originalName"); val mime = value.exportString("mimeType")
        val available = value.exportBoolean("available")
        if (!(id == "text" || Regex("fasset_[a-f0-9]{24}").matches(id) || Regex("reference_[0-9]{1,2}").matches(id)) ||
            name.isBlank() || name.codePointCount(0, name.length) > 255 || name.any { it <= '\u001f' || it == '\u007f' || it == '/' || it == '\\' } ||
            mime.length > 128 || !Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+").matches(mime)) invalidExport()
        if (available) {
            value.exportKeys("resourceId", "originalName", "mimeType", "available", "sizeBytes", "sha256")
            val size = value.exportNumber("sizeBytes"); val sha = value.exportString("sha256")
            if (id.startsWith("reference_") || size !in 0..RESULT_EXPORT_RESOURCE_BYTES || !exportDigestPattern.matches(sha)) invalidExport()
            ResultExportResource(id, name, mime, true, size, sha)
        } else {
            value.exportKeys("resourceId", "originalName", "mimeType", "available", "errorCode")
            val error = value.exportString("errorCode")
            if (id == "text" || error !in setOf("CAPABILITY_UNSUPPORTED", "RESOURCE_LIMIT")) invalidExport()
            ResultExportResource(id, name, mime, false, errorCode = error)
        }
    }
    if (resources.map { it.resourceId }.distinct().size != resources.size || resources.first().resourceId != "text" ||
        !resources.first().available || resources.first().mimeType != "text/plain") invalidExport()
    val total = body.exportNumber("totalBytes")
    if (total !in 0..RESULT_EXPORT_BATCH_BYTES || resources.filter { it.available }.sumOf { it.sizeBytes!! } != total) invalidExport()
    return ResultExportManifest(1, operation.targetInstanceId, operation.sessionId!!, operation.messageRequestId,
        runId, finalRunId, resources, total, RESULT_EXPORT_CHUNK_BYTES, expiry, revision)
}
