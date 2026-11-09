package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiRequestBodySource
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.SwitchingAgentoCTransport
import com.andysagent.agentoc.core.network.retryAfterDelayMs
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.net.URI
import java.net.URLEncoder
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale

/** Frozen file metadata; the durable resource owner supplies the original bytes. */
data class FileUploadInput(
    val requestId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val quotaBatchId: String? = null,
)

data class TargetFileAsset(
    val instanceId: String,
    val sessionId: String,
    val assetId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val ready: Boolean,
    val scopeContractVersion: Int? = null,
)

/**
 * Fixed-target control-plane client. It never owns a connection, queues legacy
 * retries or treats a ready attachment as an accepted message/finished Run.
 * The caller holds the target lease throughout each call.
 */
class FileAssetUploadClient(private val instanceId: String, private val transport: AgentoCTransport) {
    init {
        require(instanceId.isNotBlank())
        require(transport !is SwitchingAgentoCTransport) { "Uploads require a fixed target transport" }
    }

    /** Read-only, including version negotiation. No upload credentials are minted. */
    suspend fun requireSupport(scope: SessionScopeCondition? = null) { requireContract(scope) }

    /** Probe before creating a Session; no context, asset or upload credential is created. */
    suspend fun requireScopedSupport() { requireUploadScope(); requireContract() }

    /** Read-only recovery never creates an upload intent. */
    suspend fun findReceipt(sessionId: String, input: FileUploadInput, scope: SessionScopeCondition? = null,
        checkAccess: suspend () -> Unit = {}): TargetFileAsset? {
        val frozen = validate(sessionId, input)
        require(scope == null || scope.validate().sessionId == sessionId)
        checkAccess()
        val targetMaximumBytes = requireContract(scope)
        require(frozen.sizeBytes <= targetMaximumBytes) {
            "This computer accepts attachments up to ${sizeLabel(targetMaximumBytes)}"
        }
        checkAccess()
        return lookup(sessionId, frozen, scope).also { checkAccess() }
    }

    /** Explicit resumable upload. Durable server checkpoints make transient failures safe to retry. */
    suspend fun upload(sessionId: String, input: FileUploadInput, bytes: ByteArray, scope: SessionScopeCondition? = null,
        onProgress: (FileUploadProgress) -> Unit = {},
        checkAccess: suspend () -> Unit = {}): TargetFileAsset {
        val frozen = validate(sessionId, input)
        require(bytes.size.toLong() == frozen.sizeBytes) { "File size differs from its frozen descriptor" }
        require(frozen.sizeBytes <= MAX_IN_MEMORY_UPLOAD_BYTES) {
            "In-memory uploads are limited to ${sizeLabel(MAX_IN_MEMORY_UPLOAD_BYTES)}; use a streaming source for larger files"
        }
        val body = bytes.copyOf()
        val digest = MessageDigest.getInstance("SHA-256").digest(body).hexDigest()
        require(digest == frozen.sha256) { "File digest differs from its frozen descriptor" }
        val source = ApiRequestBodySource(frozen.sizeBytes, frozen.sha256) { body.inputStream() }
        return uploadVerified(sessionId, frozen, source, body, scope, onProgress, checkAccess)
    }

    /** Reopenable source API keeps normal attachment uploads bounded to one transport chunk. */
    suspend fun upload(sessionId: String, input: FileUploadInput, source: ApiRequestBodySource, scope: SessionScopeCondition? = null,
        onProgress: (FileUploadProgress) -> Unit = {},
        checkAccess: suspend () -> Unit = {}): TargetFileAsset {
        val frozen = validate(sessionId, input)
        require(source.sizeBytes == frozen.sizeBytes && source.sha256 == frozen.sha256) {
            "Streaming source differs from its frozen descriptor"
        }
        return uploadVerified(sessionId, frozen, source, null, scope, onProgress, checkAccess)
    }

    private suspend fun uploadVerified(sessionId: String, frozen: FileUploadInput, source: ApiRequestBodySource,
        legacyBytes: ByteArray?, scope: SessionScopeCondition?, onProgress: (FileUploadProgress) -> Unit,
        checkAccess: suspend () -> Unit): TargetFileAsset {
        fun report(phase: FileUploadPhase, writtenBytes: Long? = null) {
            try { onProgress(FileUploadProgress(phase, frozen.sizeBytes, writtenBytes)) }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { /* Progress is observational, receipt validation is authoritative. */ }
        }
        require(scope == null || scope.validate().sessionId == sessionId)
        currentCoroutineContext().ensureActive()
        checkAccess()
        val targetMaximumBytes = requireContract(scope)
        require(frozen.sizeBytes <= targetMaximumBytes) {
            "This computer accepts attachments up to ${sizeLabel(targetMaximumBytes)}"
        }
        checkAccess()
        report(FileUploadPhase.CHECKING)
        val previous = lookup(sessionId, frozen, scope)
        checkAccess()
        if (previous?.ready == true) { report(FileUploadPhase.CONFIRMED); return previous }
        report(FileUploadPhase.PREPARING)
        val intentBody = buildJsonObject {
            put("sessionId", sessionId); put("requestId", frozen.requestId)
            put("quotaBatchId", frozen.quotaBatchId?.takeIf { it.isNotBlank() } ?: frozen.requestId)
            put("originalName", frozen.originalName); put("mimeType", frozen.mimeType)
            put("sizeBytes", frozen.sizeBytes); put("sha256", frozen.sha256)
        }.toString()
        val intent = json(execute(ApiRequest("POST", "/api/assets/upload-intents", intentBody,
            headers = scope?.headers().orEmpty(), contentType = "application/json")))
        checkAccess()
        check(intent["uploadContractVersion"]?.jsonPrimitive?.intOrNull == 1) { "Target did not acknowledge stable upload identity" }
        val asset = parseAsset(sessionId, frozen, intent, scope)
        check(previous == null || previous.assetId == asset.assetId) { "Upload identity changed at the target" }
        if (asset.ready) { report(FileUploadPhase.CONFIRMED); return asset }
        val upload = intent["upload"] as? JsonObject ?: error("Pending upload has no upload destination")
        val path = string(upload, "url")
        val method = string(upload, "method")
        val headers = (upload["headers"] as? JsonObject).orEmpty().mapValues { (_, value) ->
            (value as? JsonPrimitive)?.contentOrNull ?: error("Invalid upload header")
        }
        check(headers.keys.all { it.equals("Content-Type", ignoreCase = true) }) { "Unexpected upload credential header" }
        check(headers.values.none { '\r' in it || '\n' in it }) { "Invalid upload header value" }
        val mime = headers.entries.firstOrNull { it.key.equals("Content-Type", ignoreCase = true) }?.value ?: frozen.mimeType
        check(mime == frozen.mimeType) { "Upload content type differs from frozen metadata" }
        if (path.startsWith('/')) {
            check(method == "POST" && path == "/api/assets/${asset.assetId}/upload") { "Unexpected control-plane upload destination" }
        } else {
            val uri = URI(path)
            check(method == "PUT" && uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()
                && uri.userInfo == null && uri.fragment == null) { "Invalid signed object upload destination" }
        }
        checkAccess()
        // Object-store credentials are not a PC control-plane delegation.
        val bodyHeaders = if (path.startsWith('/')) headers + scope?.headers().orEmpty() else headers
        report(FileUploadPhase.TRANSFERRING)
        val resumable = intent["resumableUpload"] as? JsonObject
        val uploaded = if (resumable != null) {
            require(path == "/api/assets/${asset.assetId}/upload" && method == "POST") {
                "Resumable upload contract advertised an unexpected upload destination"
            }
            uploadLocalChunks(asset.assetId, frozen, source, resumable, scope, ::report, checkAccess)
            ApiResponse(200, "")
        } else if (path.startsWith('/')) {
            val bytes = legacyBytes ?: error("Target does not support bounded resumable uploads")
            execute(ApiRequest(method, path, headers = bodyHeaders, bodyBytes = bytes, contentType = mime,
                onBodyBytesWritten = { report(FileUploadPhase.TRANSFERRING, it) }))
        } else {
            if (legacyBytes != null) execute(ApiRequest(method, path, headers = bodyHeaders, bodyBytes = legacyBytes,
                contentType = mime, onBodyBytesWritten = { report(FileUploadPhase.TRANSFERRING, it) }))
            else execute(ApiRequest(method, path, headers = bodyHeaders, bodySource = source, contentType = mime,
                onBodyBytesWritten = { report(FileUploadPhase.TRANSFERRING, it) }))
        }
        checkAccess()
        report(FileUploadPhase.VERIFYING)
        val finalizeBody = buildJsonObject {
            put("sizeBytes", frozen.sizeBytes)
            put("etag", uploaded.headers.entries.firstOrNull { it.key.equals("ETag", ignoreCase = true) }?.value.orEmpty())
        }.toString()
        val finalized = parseAsset(sessionId, frozen, json(execute(
            ApiRequest("POST", "/api/assets/${asset.assetId}/finalize", finalizeBody,
                headers = scope?.headers().orEmpty(), contentType = "application/json"),
        )), scope)
        checkAccess()
        check(finalized.assetId == asset.assetId && finalized.ready) { "Target did not acknowledge the verified file" }
        report(FileUploadPhase.CONFIRMED)
        return finalized
    }

    private suspend fun uploadLocalChunks(assetId: String, input: FileUploadInput, source: ApiRequestBodySource,
        contract: JsonObject, scope: SessionScopeCondition?, report: (FileUploadPhase, Long?) -> Unit,
        checkAccess: suspend () -> Unit) {
        val contractVersion = contract["version"]?.jsonPrimitive?.intOrNull
        val chunkBytes = contract["chunkBytes"]?.jsonPrimitive?.intOrNull
        check(contractVersion == 1 && contract["checksum"]?.jsonPrimitive?.contentOrNull == "sha256"
            && contract["fixedChunks"] == JsonPrimitive(true) && chunkBytes == UPLOAD_CHUNK_BYTES) {
            "Target advertised an unsupported resumable upload contract"
        }
        val path = "/api/assets/$assetId/upload"
        val checkpointPath = "/api/assets/$assetId/upload-checkpoint"
        val state = json(execute(ApiRequest("GET", checkpointPath, headers = scope?.headers().orEmpty())))
        check(state["uploadCheckpointVersion"]?.jsonPrimitive?.intOrNull == 1
            && state["assetId"]?.jsonPrimitive?.contentOrNull == assetId
            && state["totalBytes"]?.jsonPrimitive?.longOrNull == input.sizeBytes
            && state["sha256"]?.jsonPrimitive?.contentOrNull == input.sha256
            && state["chunkBytes"]?.jsonPrimitive?.intOrNull == UPLOAD_CHUNK_BYTES) {
            "Target checkpoint differs from the frozen file"
        }
        var offset = state["offset"]?.jsonPrimitive?.longOrNull ?: error("Missing upload offset")
        check(offset in 0..input.sizeBytes && (offset == input.sizeBytes || offset % UPLOAD_CHUNK_BYTES.toLong() == 0L)) {
            "Target returned an invalid upload offset"
        }
        check(state["status"]?.jsonPrimitive?.contentOrNull in setOf("uploading", "uploaded", "ready")) {
            "Target upload checkpoint is not writable"
        }
        val wholeDigest = MessageDigest.getInstance("SHA-256")
        var totalRead = 0L
        source.openStream().buffered(DEFAULT_SOURCE_BUFFER_BYTES).use { stream ->
            val skipBuffer = ByteArray(DEFAULT_SOURCE_BUFFER_BYTES)
            while (totalRead < offset) {
                val wanted = minOf(skipBuffer.size.toLong(), offset - totalRead).toInt()
                val read = stream.read(skipBuffer, 0, wanted)
                if (read < 0) error("Streaming source ended before the checkpoint offset")
                if (read == 0) continue
                wholeDigest.update(skipBuffer, 0, read)
                totalRead += read
            }
            report(FileUploadPhase.TRANSFERRING, offset)
            while (offset < input.sizeBytes) {
                checkAccess()
                currentCoroutineContext().ensureActive()
                val length = minOf(UPLOAD_CHUNK_BYTES.toLong(), input.sizeBytes - offset).toInt()
                val bytes = ByteArray(length)
                var filled = 0
                while (filled < length) {
                    val read = stream.read(bytes, filled, length - filled)
                    if (read < 0) error("Streaming source ended before its frozen size")
                    if (read == 0) continue
                    wholeDigest.update(bytes, filled, read)
                    filled += read
                    totalRead += read
                }
                val chunkHash = MessageDigest.getInstance("SHA-256").digest(bytes).hexDigest()
                val headers = scope?.headers().orEmpty() + mapOf(
                    "X-Agentoc-Upload-Offset" to offset.toString(),
                    "X-Agentoc-Upload-Length" to length.toString(),
                    "X-Agentoc-Upload-Sha256" to chunkHash,
                )
                val expectedOffset = offset + length
                uploadChunkWithRetry(assetId, input, path, checkpointPath, offset, expectedOffset,
                    headers, bytes, scope, checkAccess)
                offset = expectedOffset
                report(FileUploadPhase.TRANSFERRING, offset)
            }
            check(stream.read() == -1 && totalRead == input.sizeBytes) { "Streaming source exceeds its frozen size" }
        }
        check(wholeDigest.digest().hexDigest() == input.sha256) { "Streaming source digest differs from its frozen descriptor" }
    }

    /**
     * Each PATCH is idempotent at its fixed offset. When its reply is lost, ask
     * the server's durable checkpoint whether the write committed before retrying.
     */
    private suspend fun uploadChunkWithRetry(assetId: String, input: FileUploadInput, path: String,
        checkpointPath: String, offset: Long, expectedOffset: Long, headers: Map<String, String>, bytes: ByteArray,
        scope: SessionScopeCondition?, checkAccess: suspend () -> Unit) {
        var attempt = 0
        var lastFailure: Exception? = null
        while (attempt < MAX_CHUNK_ATTEMPTS) {
            checkAccess()
            currentCoroutineContext().ensureActive()
            try {
                val response = json(execute(ApiRequest("PATCH", path, headers = headers, bodyBytes = bytes,
                    contentType = "application/octet-stream")))
                check(response["uploadCheckpointVersion"]?.jsonPrimitive?.intOrNull == 1
                    && response["assetId"]?.jsonPrimitive?.contentOrNull == assetId
                    && response["offset"]?.jsonPrimitive?.longOrNull == expectedOffset) {
                    "Target did not confirm the expected upload offset"
                }
                return
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (!isRetryableChunkFailure(failure)) throw failure
                lastFailure = failure
                attempt++

                // A timeout can mean the server committed the chunk but its
                // response was lost. Never infer progress from client bytes.
                try {
                    val state = json(execute(ApiRequest("GET", checkpointPath, headers = scope?.headers().orEmpty())))
                    validateCheckpoint(state, assetId, input)
                    val serverOffset = state["offset"]?.jsonPrimitive?.longOrNull
                        ?: error("Missing upload offset")
                    when (serverOffset) {
                        expectedOffset -> return
                        offset -> Unit // The server did not commit it; safely resend these same bytes.
                        else -> error("Target checkpoint moved to an unexpected upload offset")
                    }
                } catch (cancelled: kotlinx.coroutines.CancellationException) {
                    throw cancelled
                } catch (checkpointFailure: Exception) {
                    if (!isRetryableChunkFailure(checkpointFailure)) throw checkpointFailure
                    lastFailure = checkpointFailure
                }
                if (attempt >= MAX_CHUNK_ATTEMPTS) break
                val backoff = minOf(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS shl (attempt - 1))
                val serverDelay = (failure as? ApiException)?.retryAfterMs?.coerceAtMost(MAX_SERVER_RETRY_DELAY_MS) ?: 0L
                delay(maxOf(backoff, serverDelay))
            }
        }
        throw lastFailure ?: IOException("Attachment chunk upload failed")
    }

    private fun validateCheckpoint(state: JsonObject, assetId: String, input: FileUploadInput) {
        check(state["uploadCheckpointVersion"]?.jsonPrimitive?.intOrNull == 1
            && state["assetId"]?.jsonPrimitive?.contentOrNull == assetId
            && state["totalBytes"]?.jsonPrimitive?.longOrNull == input.sizeBytes
            && state["sha256"]?.jsonPrimitive?.contentOrNull == input.sha256
            && state["chunkBytes"]?.jsonPrimitive?.intOrNull == UPLOAD_CHUNK_BYTES
            && state["status"]?.jsonPrimitive?.contentOrNull in setOf("uploading", "uploaded", "ready")) {
            "Target checkpoint differs from the frozen file"
        }
    }

    private fun isRetryableChunkFailure(error: Exception): Boolean = when (error) {
        is ApiException -> error.retryable
        is IOException -> true
        else -> false
    }

    private suspend fun requireContract(scope: SessionScopeCondition? = null): Long {
        if (scope != null) {
            scope.validate()
            requireUploadScope()
        }
        val contract = json(execute(ApiRequest("GET", "/api/asset-upload-contract")))
        val targetMaximumBytes = contract["maximumBytes"]?.jsonPrimitive?.longOrNull ?: 0L
        check(contract["version"]?.jsonPrimitive?.intOrNull == 1
            && contract["sha256Required"]?.jsonPrimitive?.booleanOrNull == true
            && contract["readonlyReceiptLookup"]?.jsonPrimitive?.booleanOrNull == true
            && targetMaximumBytes > 0L
            && (contract["requestIdMaximumLength"]?.jsonPrimitive?.intOrNull ?: 0) >= 200) {
            "Target does not support the stable upload contract"
        }
        return minOf(targetMaximumBytes, MAXIMUM_BYTES)
    }

    private suspend fun requireUploadScope() = requireSessionScopeEffects(transport, mapOf(
        "asset.upload.intent" to ("POST" to "/api/assets/upload-intents"),
        "asset.upload.body" to ("POST" to "/api/assets/{assetId}/upload"),
        "asset.upload.chunk" to ("PATCH" to "/api/assets/{assetId}/upload"),
        "asset.upload.checkpoint" to ("GET" to "/api/assets/{assetId}/upload-checkpoint"),
        "asset.upload.finalize" to ("POST" to "/api/assets/{assetId}/finalize"),
        "asset.upload.receipt" to ("GET" to "/api/assets/upload-intents?sessionId={sessionId}&requestId={requestId}"),
    ))

    private suspend fun lookup(sessionId: String, input: FileUploadInput, scope: SessionScopeCondition?): TargetFileAsset? {
        val response = try { execute(ApiRequest("GET", "/api/assets/upload-intents?sessionId=${encode(sessionId)}&requestId=${encode(input.requestId)}",
            headers = scope?.headers().orEmpty())) }
        catch (error: ApiException) {
            if (error.statusCode == 404 && error.code == "FILE_ASSET_NOT_FOUND") return null
            throw error
        }
        val receipt = json(response)
        check(receipt["uploadContractVersion"]?.jsonPrimitive?.intOrNull == 1) { "Unsupported upload receipt version" }
        return parseAsset(sessionId, input, receipt, scope)
    }

    private fun parseAsset(sessionId: String, input: FileUploadInput, payload: JsonObject, scope: SessionScopeCondition?): TargetFileAsset {
        val asset = payload["asset"] as? JsonObject ?: error("Missing file asset receipt")
        if (scope != null) check(asset["scopeContractVersion"] == JsonPrimitive(1)) { "Scoped upload receipt was downgraded" }
        val id = string(asset, "id")
        check(Regex("fasset_[a-f0-9]{24}").matches(id)) { "Invalid file asset identity" }
        val status = string(asset, "status")
        check(status in setOf("pending_upload", "ready")) { "Unknown upload state" }
        check(string(asset, "sessionId") == sessionId && string(asset, "originalName") == input.originalName
            && string(asset, "mimeType") == input.mimeType
            && asset["sizeBytes"]?.jsonPrimitive?.longOrNull == input.sizeBytes
            && string(asset, "sha256") == input.sha256) { "Upload receipt differs from the frozen file" }
        return TargetFileAsset(instanceId, sessionId, id, input.originalName, input.mimeType, input.sizeBytes, input.sha256, status == "ready",
            asset["scopeContractVersion"]?.jsonPrimitive?.intOrNull)
    }

    private fun validate(sessionId: String, input: FileUploadInput): FileUploadInput {
        require(sessionId.isNotBlank() && sessionId == sessionId.trim() && sessionId.length <= 256)
        require(input.requestId.isNotBlank() && input.requestId.length <= 200)
        require(input.quotaBatchId == null || (input.quotaBatchId.isNotBlank() && input.quotaBatchId.length <= 200
            && input.quotaBatchId.none { it in "\u0000\r\n" }))
        require(input.originalName.isNotBlank() && input.originalName.length <= 255
            && input.originalName.none { it in "\\/\u0000\r\n" }) { "A bounded file name is required" }
        require(input.mimeType.length <= 256 && input.mimeType.none { it in "\u0000\r\n" })
        require(input.sizeBytes in 1..MAXIMUM_BYTES && Regex("[a-fA-F0-9]{64}").matches(input.sha256))
        return input.copy(requestId = input.requestId.trim(), originalName = input.originalName.trim().replace(Regex("\\s+"), " "),
            mimeType = input.mimeType.trim().lowercase(Locale.ROOT).ifBlank { "application/octet-stream" },
            sha256 = input.sha256.lowercase(Locale.ROOT), quotaBatchId = input.quotaBatchId?.trim())
    }

    private suspend fun execute(request: ApiRequest): ApiResponse {
        val result = transport.execute(request)
        if (!result.isSuccessful) {
            val code = runCatching { json(result)["code"]?.jsonPrimitive?.contentOrNull }.getOrNull()
            throw ApiException(result.statusCode, code, "File upload request failed",
                retryAfterMs = result.retryAfterDelayMs(), headers = result.headers)
        }
        return result
    }
    private fun json(response: ApiResponse): JsonObject = AgentocProtocol.json.parseToJsonElement(response.body).jsonObject
    private fun string(value: JsonObject, key: String): String = (value[key] as? JsonPrimitive)?.contentOrNull ?: error("Missing $key")
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    private fun sizeLabel(bytes: Long): String = when {
        bytes % GIB == 0L -> "${bytes / GIB} GiB"
        bytes % MIB == 0L -> "${bytes / MIB} MiB"
        else -> "$bytes bytes"
    }
    companion object {
        const val MAXIMUM_BYTES = 1024L * 1024 * 1024
        const val MAX_IN_MEMORY_UPLOAD_BYTES = 25L * 1024 * 1024
        const val UPLOAD_CHUNK_BYTES = 256 * 1024
        private const val MAX_CHUNK_ATTEMPTS = 10
        private const val INITIAL_RETRY_DELAY_MS = 500L
        private const val MAX_RETRY_DELAY_MS = 30_000L
        private const val MAX_SERVER_RETRY_DELAY_MS = 60_000L
        private const val DEFAULT_SOURCE_BUFFER_BYTES = 64 * 1024
        private const val MIB = 1024L * 1024
        private const val GIB = 1024L * 1024 * 1024
    }
}

private fun ByteArray.hexDigest(): String = joinToString("") { "%02x".format(it) }
