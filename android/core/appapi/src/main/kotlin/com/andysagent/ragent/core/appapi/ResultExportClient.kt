package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.*
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.Base64

// The DataChannel HTTP envelope base64-encodes this already-base64 JSON once
// more. Keep each requested block small enough for a bounded carrier frame.
internal const val RESULT_EXPORT_TRANSFER_BYTES = 16 * 1024

/** Uses an already authenticated fixed carrier; never opens a direct connection or owns retries. */
class ResultExportClient(private val instanceId: String, private val transport: RagentTransport,
    private val now: () -> Long = System::currentTimeMillis) {
    init {
        require(instanceId.isNotBlank())
        require(transport !is SwitchingRagentTransport) { "Result exports require a fixed target transport" }
    }

    suspend fun readManifest(operation: TaskOperation, checkAccess: suspend () -> Unit): ResultExportManifest {
        requireExportOperation(operation, instanceId)
        requireContract(checkAccess)
        return decodeResultExport(operation, request(base(operation), 32 * 1024, checkAccess), now())
    }

    /** Sink receives verified chunks, but must publish bytes only after this entire call succeeds. */
    suspend fun stream(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
        checkAccess: suspend () -> Unit, prefix: ResultExportPrefix? = null, sink: suspend (ByteArray) -> Unit): ResultExportReceipt {
        requireExportOperation(operation, instanceId)
        // Detach caller-owned lists and revalidate persisted metadata before any suspension.
        val frozen = manifest.validated(operation, now())
        val resource = frozen.resources.firstOrNull { it.resourceId == resourceId && it.available }
            ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Result resource is not downloadable")
        val hash = MessageDigest.getInstance("SHA-256")
        var offset = feedExportPrefix(prefix, resource.sizeBytes!!, checkAccess) { hash.update(it) }
        requireContract(checkAccess)
        do {
            currentCoroutineContext().ensureActive()
            if (java.time.Instant.parse(frozen.expiresAt).toEpochMilli() <= now()) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Download snapshot expired")
            val requested = minOf(RESULT_EXPORT_TRANSFER_BYTES.toLong(), frozen.maxChunkBytes.toLong(), resource.sizeBytes!! - offset).coerceAtLeast(1)
            val body = request("${base(operation)}/${encode(resourceId)}?revision=${frozen.revision}&offset=$offset&length=$requested", 96 * 1024, checkAccess)
            val bytes = decodeChunk(frozen, resource, body, offset, requested)
            hash.update(bytes)
            checkAccess(); currentCoroutineContext().ensureActive()
            sink(bytes)
            checkAccess(); currentCoroutineContext().ensureActive()
            offset += bytes.size
        } while (offset < resource.sizeBytes!!)
        if (offset != resource.sizeBytes || hash.digest().hex() != resource.sha256) invalidExport()
        checkAccess(); currentCoroutineContext().ensureActive()
        if (java.time.Instant.parse(frozen.expiresAt).toEpochMilli() <= now()) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Download snapshot expired before completion")
        return ResultExportReceipt(frozen.revision, resourceId, offset, resource.sha256!!)
    }

    private fun decodeChunk(manifest: ResultExportManifest, resource: ResultExportResource, body: JsonObject,
        offset: Long, requested: Long): ByteArray {
        body.exportKeys("exportContractVersion", "instanceId", "sessionId", "requestId", "runId", "finalRunId", "revision",
            "resourceId", "offset", "nextOffset", "eof", "sizeBytes", "sha256", "chunkSha256", "dataBase64")
        if (body.exportNumber("exportContractVersion") != 1L || body.exportString("instanceId") != manifest.instanceId ||
            body.exportString("sessionId") != manifest.sessionId || body.exportString("requestId") != manifest.requestId ||
            body.exportString("runId") != manifest.runId || body.exportString("finalRunId") != manifest.finalRunId ||
            body.exportString("revision") != manifest.revision || body.exportString("resourceId") != resource.resourceId ||
            body.exportNumber("offset") != offset || body.exportNumber("sizeBytes") != resource.sizeBytes ||
            body.exportString("sha256") != resource.sha256) invalidExport()
        val encoded = body.exportString("dataBase64")
        if (encoded.length > 87_384) invalidExport()
        val bytes = runCatching { Base64.getDecoder().decode(encoded) }.getOrElse { invalidExport() }
        // Require canonical padded base64; no alternate spellings or ignored trailing data.
        if (Base64.getEncoder().encodeToString(bytes) != encoded || bytes.size.toLong() != minOf(requested, resource.sizeBytes!! - offset) ||
            body.exportNumber("nextOffset") != offset + bytes.size || body.exportBoolean("eof") != (offset + bytes.size == resource.sizeBytes) ||
            MessageDigest.getInstance("SHA-256").digest(bytes).hex() != body.exportString("chunkSha256")) invalidExport()
        return bytes
    }

    private suspend fun requireContract(checkAccess: suspend () -> Unit) {
        val body = request("/api/result-export-contract", 4096, checkAccess, contract = true)
        body.exportKeys("version", "maxChunkBytes", "maxTextBytes", "maxFileBytes", "maxBatchBytes", "maxResources", "snapshotTtlMs")
        if (body.exportNumber("version") != 1L || body.exportNumber("maxChunkBytes") != RESULT_EXPORT_CHUNK_BYTES.toLong() ||
            body.exportNumber("maxTextBytes") != RESULT_EXPORT_RESOURCE_BYTES || body.exportNumber("maxFileBytes") != RESULT_EXPORT_RESOURCE_BYTES ||
            body.exportNumber("maxBatchBytes") != RESULT_EXPORT_BATCH_BYTES || body.exportNumber("maxResources") != 17L ||
            body.exportNumber("snapshotTtlMs") != 900_000L) {
            apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Target does not support result export contract v1")
        }
    }

    private suspend fun request(path: String, maximumBytes: Int, checkAccess: suspend () -> Unit, contract: Boolean = false): JsonObject {
        checkAccess(); currentCoroutineContext().ensureActive()
        val response = try { transport.execute(ApiRequest("GET", path)) }
        catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
        catch (failure: ApiException) { throw httpFailure(failure.statusCode, failure.code, contract) }
        checkAccess(); currentCoroutineContext().ensureActive()
        if (response.body.length > maximumBytes || response.body.toByteArray(Charsets.UTF_8).size > maximumBytes ||
            (response.bodyBytes?.size ?: 0) > maximumBytes) invalidExport()
        val body = runCatching { AppApiJson.parseToJsonElement(response.body) as? JsonObject }.getOrNull()
        if (response.statusCode != 200) throw httpFailure(response.statusCode,
            (body?.get("code") as? JsonPrimitive)?.takeIf { it.isString }?.content, contract)
        return body ?: invalidExport()
    }

    private fun httpFailure(status: Int, code: String?, contract: Boolean): AppApiException = AppApiException(ApiError(when (status) {
        400 -> ApiErrorCode.INVALID_ARGUMENT; 401 -> ApiErrorCode.AUTHENTICATION_REQUIRED; 403 -> ApiErrorCode.PERMISSION_DENIED
        404 -> if (contract) ApiErrorCode.CAPABILITY_UNSUPPORTED else ApiErrorCode.RESOURCE_NOT_FOUND
        409 -> if (code == "RESULT_EXPORT_INCOMPLETE") ApiErrorCode.RESULT_UNKNOWN else ApiErrorCode.REVISION_CONFLICT
        410 -> ApiErrorCode.REQUEST_EXPIRED; 413, 507 -> ApiErrorCode.RESOURCE_LIMIT; 429 -> ApiErrorCode.RATE_LIMITED
        else -> ApiErrorCode.RESULT_UNKNOWN
    }, "PC result export could not be verified", retryable = status in setOf(408, 429, 502, 503, 504)))

    private fun base(operation: TaskOperation) = "/api/sessions/${encode(operation.sessionId!!)}/message-results/${encode(operation.messageRequestId)}/exports"
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

internal fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }
