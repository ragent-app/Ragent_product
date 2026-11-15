package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PProtocol
import com.andysagent.ragent.core.protocol.TemporaryAccessProtocol
import com.andysagent.ragent.core.protocol.TemporaryPairingProtocol
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

data class TemporarySessionScope(val sessionId: String, val expectedScopeRevision: String,
    val expectedProjectId: String?) {
    fun json(): JsonObject {
        require(expectedScopeRevision.matches(Regex("^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")))
        return JsonObject(mapOf("version" to JsonPrimitive(1), "sessionId" to JsonPrimitive(sessionId),
            "expectedScopeRevision" to JsonPrimitive(expectedScopeRevision),
            "expectedProjectId" to (expectedProjectId?.let(::JsonPrimitive) ?: JsonNull)))
    }
}

data class TemporaryRuntimeOption(val id: String, val name: String, val ready: Boolean, val status: String)

interface TemporaryTextTaskApi {
    suspend fun createSession(body: JsonObject): JsonObject
    suspend fun prepareMessage(scope: TemporarySessionScope, body: JsonObject): JsonObject
    suspend fun preparation(scope: TemporarySessionScope, requestId: String): JsonObject
    suspend fun commitMessage(scope: TemporarySessionScope, requestId: String, body: JsonObject): JsonObject
    suspend fun messageReceipt(scope: TemporarySessionScope, requestId: String): JsonObject
}

/** Finite routes, always on the original verified DataChannel with a fresh DPoP proof. */
class TemporaryCarrierApi(
    private val connector: TemporaryCarrierConnector,
    private val connection: VerifiedTemporaryConnection,
    private val completion: TemporaryAccessProtocol.Completion,
    private val identity: DeviceIdentityStore,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val random: SecureRandom = SecureRandom(),
) : TemporaryTextTaskApi, TemporaryAttachmentApi {
    private val json = Json { ignoreUnknownKeys = false }
    private val base = "/api/temporary/v1/instances/${connection.instanceId}"

    init {
        require(connection.businessAccessReady && connection.deviceId == completion.grant.deviceId &&
            connection.instanceId.matches(Regex("^inst_[A-Za-z0-9_-]{24,64}$")))
    }

    override suspend fun createSession(body: JsonObject): JsonObject = send("POST", "$base/sessions", null, body)
    suspend fun listRuntimes(): List<TemporaryRuntimeOption> {
        val response = send("GET", "$base/runtimes", null)
        require(response["version"]?.jsonPrimitive?.content == "1")
        return response["runtimes"]?.jsonArray?.map { value ->
            val item = value.jsonObject
            TemporaryRuntimeOption(
                id = item.getValue("id").jsonPrimitive.content,
                name = item.getValue("name").jsonPrimitive.content,
                ready = item.getValue("ready").jsonPrimitive.content.toBooleanStrict(),
                status = item.getValue("status").jsonPrimitive.content,
            )
        } ?: error("Temporary runtime catalog is missing")
    }
    suspend fun readSession(scope: TemporarySessionScope): JsonObject = send("GET", session(scope), scope)
    override suspend fun prepareMessage(scope: TemporarySessionScope, body: JsonObject): JsonObject =
        send("POST", "${session(scope)}/messages/prepare", scope, body)
    override suspend fun preparation(scope: TemporarySessionScope, requestId: String): JsonObject =
        send("GET", "${session(scope)}/messages/preparations/${segment(requestId)}", scope)
    override suspend fun commitMessage(scope: TemporarySessionScope, requestId: String, body: JsonObject): JsonObject =
        send("POST", "${session(scope)}/messages/${segment(requestId)}/commit", scope, body)
    override suspend fun messageReceipt(scope: TemporarySessionScope, requestId: String): JsonObject =
        send("GET", "${session(scope)}/messages/${segment(requestId)}/receipt", scope)
    override suspend fun createAsset(scope: TemporarySessionScope, body: JsonObject): JsonObject =
        send("POST", "${session(scope)}/assets", scope, body)
    override suspend fun assetReceipt(scope: TemporarySessionScope, requestId: String): JsonObject =
        send("GET", "${session(scope)}/assets/receipts/${segment(requestId)}", scope)
    override suspend fun uploadCheckpoint(scope: TemporarySessionScope, assetId: String): JsonObject =
        send("GET", "${session(scope)}/assets/${segment(assetId)}/upload-checkpoint", scope)
    override suspend fun uploadChunk(scope: TemporarySessionScope, assetId: String, offset: Long,
        source: TemporaryAttachmentBodySource): JsonObject {
        require(offset >= 0 && source.sizeBytes in 1..TemporaryAttachmentUploader.MAX_CHUNK_BYTES.toLong())
        return send("PATCH", "${session(scope)}/assets/${segment(assetId)}/upload", scope,
            bodySource = source, additionalHeaders = mapOf(
                "X-Ragent-Upload-Offset" to offset.toString(),
                "X-Ragent-Upload-Length" to source.sizeBytes.toString(),
                "X-Ragent-Upload-Sha256" to source.sha256))
    }
    override suspend fun cancelUpload(scope: TemporarySessionScope, assetId: String): JsonObject =
        send("DELETE", "${session(scope)}/assets/${segment(assetId)}/upload-checkpoint", scope)
    override suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String, bytes: ByteArray): JsonObject {
        require(bytes.size <= 25 * 1024 * 1024)
        return send("POST", "${session(scope)}/assets/${segment(assetId)}/upload", scope, bytes = bytes)
    }
    override suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String,
        source: TemporaryAttachmentBodySource,
        onProgress: (sentBytes: Long, totalBytes: Long) -> Unit): JsonObject {
        require(source.sizeBytes in 1..TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES.toLong())
        return send("POST", "${session(scope)}/assets/${segment(assetId)}/upload", scope,
            bodySource = source, onUploadProgress = onProgress)
    }
    override suspend fun finalizeAsset(scope: TemporarySessionScope, assetId: String, body: JsonObject): JsonObject =
        send("POST", "${session(scope)}/assets/${segment(assetId)}/finalize", scope, body)
    suspend fun runStatus(scope: TemporarySessionScope, runId: String): JsonObject =
        send("GET", "${session(scope)}/runs/${segment(runId)}", scope)
    suspend fun result(scope: TemporarySessionScope, runId: String): JsonObject =
        send("GET", "${session(scope)}/runs/${segment(runId)}/result", scope)
    suspend fun exports(scope: TemporarySessionScope, runId: String): JsonObject =
        send("GET", "${session(scope)}/runs/${segment(runId)}/exports", scope)
    suspend fun exportChunk(scope: TemporarySessionScope, runId: String, resourceId: String,
        revision: String, offset: Long, length: Int): JsonObject {
        require(revision.matches(Regex("^[A-Za-z0-9_-]{1,256}$")) && offset >= 0 && length in 1..65_536)
        return send("GET", "${session(scope)}/runs/${segment(runId)}/exports/${segment(resourceId)}" +
            "?revision=$revision&offset=$offset&length=$length", scope)
    }
    suspend fun cancelRun(scope: TemporarySessionScope, runId: String, body: JsonObject): JsonObject =
        send("POST", "${session(scope)}/runs/${segment(runId)}/cancel", scope, body)

    private fun session(scope: TemporarySessionScope) = "$base/sessions/${segment(scope.sessionId)}"

    private suspend fun send(method: String, path: String, scope: TemporarySessionScope?,
        body: JsonObject? = null, bytes: ByteArray? = null,
        bodySource: TemporaryAttachmentBodySource? = null,
        additionalHeaders: Map<String, String> = emptyMap(),
        onUploadProgress: (sentBytes: Long, totalBytes: Long) -> Unit = { _, _ -> }): JsonObject {
        require(listOf(body != null, bytes != null, bodySource != null).count { it } <= 1)
        val now = nowMs()
        require(connection.businessAccessReady && now < connection.expiresAt && now < completion.credential.expiresAt)
        require(TemporaryPairingProtocol.deviceKeyFingerprint(identity.publicKeyEncoded()) ==
            completion.grant.deviceKeyFingerprint) { "Temporary device identity changed" }
        val carrier = connector.session(connection) ?: throw ApiException(0, "TEMPORARY_CARRIER_UNAVAILABLE",
            "Temporary carrier is unavailable", retryable = true)
        val pathname = path.substringBefore('?')
        val jti = "rtn_${Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(random::nextBytes))}"
        val proof = TemporaryAccessProtocol.dpop(completion.credential.accessToken,
            identity.publicKeyEncoded(), method, pathname, now, jti, identity::sign)
        val headers = mutableMapOf("Authorization" to "DPoP ${completion.credential.accessToken}", "DPoP" to proof)
        if (scope != null) {
            val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(scope.json().toString().toByteArray())
            require(encoded.length <= 2048)
            headers["X-Ragent-App-Api-Scope"] = encoded
        }
        if (body != null) headers["Content-Type"] = "application/json"
        if (bytes != null || bodySource != null) headers["Content-Type"] = "application/octet-stream"
        headers.putAll(additionalHeaders)
        val request = P2PHttpRequest(UUID.randomUUID().toString(), method = method,
            path = path, headers = headers,
            bodyBase64 = bytes?.let(P2PProtocol::encodeBody) ?: body?.toString()?.let(P2PProtocol::encodeBody) ?: "")
        val result = if (bodySource != null) carrier.requestStream(request, bodySource.sizeBytes,
            bodySource.sha256, bodySource.openStream, onUploadProgress) else carrier.request(request)
        val response = result.getOrElse { throw ApiException(0, "TEMPORARY_CARRIER_LOST", it.message ?: "Temporary carrier request failed", retryable = true) }
        response.error?.let { throw ApiException(0, "TEMPORARY_CARRIER_ERROR", it, retryable = true) }
        val data = P2PProtocol.decodeBody(response.bodyBase64)
        require(data.size <= 1_048_576) { "Temporary response is too large" }
        val parsed = runCatching { json.parseToJsonElement(data.toString(Charsets.UTF_8)).jsonObject }.getOrNull()
        if (response.status !in 200..299) {
            val code = parsed?.get("code")?.jsonPrimitive?.content ?: "TEMPORARY_REQUEST_FAILED"
            throw ApiException(response.status, code, code, retryable = response.status == 408 || response.status == 429 || response.status >= 500)
        }
        return requireNotNull(parsed) { "Temporary carrier returned invalid JSON" }
    }

    private fun segment(value: String): String {
        require(value.isNotBlank() && value.length <= 256 && value != "." && value != ".." &&
            value.none { it == '/' || it == '\\' || it == '?' || it == '#' || it.code < 32 || it.code == 127 })
        return buildString {
            value.toByteArray(Charsets.UTF_8).forEach { byte ->
                val n = byte.toInt() and 0xff
                if (n in 65..90 || n in 97..122 || n in 48..57 || n in listOf(45, 46, 95, 126)) append(n.toChar())
                else append('%').append("%02X".format(n))
            }
        }
    }
}
