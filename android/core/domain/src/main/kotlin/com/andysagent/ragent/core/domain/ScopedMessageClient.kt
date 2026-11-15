package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.network.*
import java.net.URLEncoder
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*

@Serializable
data class PreparedMessageAsset(val assetId: String, val sha256: String, val sizeBytes: Long,
    @OptIn(ExperimentalSerializationApi::class) @EncodeDefault(EncodeDefault.Mode.NEVER) val renderAs: String? = null)

@Serializable
data class ScopedMessageRequest(
    val requestId: String, val text: String, val attachments: List<PreparedMessageAsset>,
    val runOptions: JsonObject, val expiresAt: String, val version: Int = 1,
) {
    fun validate(): ScopedMessageRequest = apply {
        require(version == 1 && canonicalIdentifier(requestId, 200))
        require(text.isNotBlank() && '\u0000' !in text && scopedUnicode(text) && text.toByteArray(Charsets.UTF_8).size <= 65536)
        require(scopedTimestamp(expiresAt))
        require(attachments.size <= 16 && attachments.map { it.assetId }.distinct().size == attachments.size)
        require(attachments.sumOf { it.sizeBytes } <= 100L * 1024 * 1024)
        attachments.forEach {
            require(Regex("fasset_[a-f0-9]{24}").matches(it.assetId) && Regex("[a-f0-9]{64}").matches(it.sha256))
            require(it.sizeBytes in 1..FileAssetUploadClient.MAXIMUM_BYTES)
            require(it.renderAs == null || it.renderAs == "file")
        }
        runOptions.forEach { (key, value) ->
            require(key in OPTION_KEYS)
            val primitive = value as? JsonPrimitive ?: error("Invalid Run option")
            if (key in BOOLEAN_KEYS) require(!primitive.isString && primitive.booleanOrNull != null)
            else require(primitive.isString && canonicalIdentifier(primitive.content, 256))
            if (key == "interactionMode") require(primitive.content in setOf("agent", "plan"))
            if (key == "planAction") require(primitive.content in setOf("revise", "execute"))
        }
        require(SessionMutationJson.encodeToString(this).toByteArray(Charsets.UTF_8).size <= 128 * 1024)
    }
    companion object {
        val BOOLEAN_KEYS = setOf("thinking", "freshThread", "browserMcpEnabled")
        val OPTION_KEYS = setOf("tool", "model", "effort", "serviceTier", "providerProfile", "uiLanguage",
            "interactionMode", "permissionMode", "templateId", "planAction", "planId") + BOOLEAN_KEYS
        fun expiry(epochMillis: Long): String = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.ofEpochMilli(epochMillis))
    }
}

@Serializable
data class ScopedMessagePreparation(
    val version: Int, val sessionId: String, val requestId: String, val preparationId: String,
    val state: String, val duplicate: Boolean, val createdAt: String, val expiresAt: String,
    val accepted: Boolean, val dispatched: Boolean,
)

@Serializable
data class ScopedMessageCommitReceipt(
    val version: Int, val sessionId: String, val requestId: String, val preparationId: String,
    val runId: String?, val state: String, val accepted: Boolean, val queued: Boolean, val duplicate: Boolean,
    val expiresAt: String, val acceptedAt: String?, val updatedAt: String,
    val launchAdmittedAt: String?, val dispatched: Boolean, val failureCode: String?,
)

internal fun scopedTimestamp(value: String): Boolean = runCatching {
    value.length == 24 && ScopedMessageRequest.expiry(Instant.parse(value).toEpochMilli()) == value
}.getOrDefault(false)
private fun validPreparationId(value: String) = Regex("mprep_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(value)

/** Fixed-PC v1. GETs never dispatch; POSTs are explicit and never retry internally. */
class ScopedMessageClient(val instanceId: String, private val transport: RagentTransport) {
    init { require(instanceId.isNotBlank() && transport !is SwitchingRagentTransport) }

    suspend fun requireSupport() {
        requireSessionScopeEffects(transport, mapOf(
            "message.prepare" to ("POST" to PREPARE_PATH), "message.preparation.receipt" to ("GET" to RECEIPT_PATH),
            "message.commit" to ("POST" to COMMIT_PATH), "message.commit.receipt" to ("GET" to COMMIT_PATH),
        ))
        val c = scopedObject(scopedExecute(transport, ApiRequest("GET", "/api/message-preparation-contract")))
        val supported = c["version"] == JsonPrimitive(1) && c["preparesOnly"] == JsonPrimitive(true) &&
            c["startsRun"] == JsonPrimitive(false) && c["commitSupported"] == JsonPrimitive(true) &&
            c["scopeHeader"] == JsonPrimitive(SessionScopeCondition.HEADER) &&
            c["scopeContractPath"] == JsonPrimitive("/api/session-scope-contract") &&
            c["preparePath"] == JsonPrimitive(PREPARE_PATH) && c["receiptPath"] == JsonPrimitive(RECEIPT_PATH) &&
            c["commitPath"] == JsonPrimitive(COMMIT_PATH) && c["commitReceiptPath"] == JsonPrimitive(COMMIT_PATH) &&
            c["maxBodyBytes"]?.jsonPrimitive?.intOrNull?.let { it >= 131072 } == true &&
            c["maxTextBytes"]?.jsonPrimitive?.intOrNull?.let { it >= 65536 } == true &&
            c["commitBodyBytes"]?.jsonPrimitive?.intOrNull?.let { it >= 4096 } == true &&
            c["maxAttachments"]?.jsonPrimitive?.intOrNull?.let { it >= 16 } == true &&
            (c["attachmentOptionKeys"] as? JsonArray)?.contains(JsonPrimitive("renderAs")) == true &&
            c["maxLifetimeSeconds"]?.jsonPrimitive?.intOrNull?.let { it >= 86400 } == true &&
            (c["runOptionKeys"] as? JsonArray)?.map { it.jsonPrimitive.content }?.containsAll(ScopedMessageRequest.OPTION_KEYS) == true
        if (!supported) throw ApiException(501, "CAPABILITY_UNSUPPORTED", "Required conditional message protocol is unavailable")
    }

    suspend fun readScope(sessionId: String): SessionScopeCondition {
        require(canonicalIdentifier(sessionId, 256))
        val response = scopedExecute(transport, ApiRequest("GET", "/api/sessions/${encode(sessionId)}/app-api-context"))
        val context = SessionMutationJson.decodeFromString<SessionMutationContext>(scopedObject(response).toString()).validate()
        check(context.sessionId == sessionId) { "Session context identity differs" }
        return SessionScopeCondition(sessionId, context.scopeRevision, context.projectId).validate()
    }

    suspend fun prepare(scope: SessionScopeCondition, request: ScopedMessageRequest): ScopedMessagePreparation {
        request.validate(); scope.validate()
        val response = scopedExecute(transport, ApiRequest("POST", preparePath(scope), SessionMutationJson.encodeToString(request),
            headers = scope.headers(), contentType = "application/json"))
        return preparation(response, scope, request)
    }

    suspend fun findPreparation(scope: SessionScopeCondition, request: ScopedMessageRequest): ScopedMessagePreparation? {
        request.validate(); scope.validate()
        val response = lookup(ApiRequest("GET", receiptPath(scope, request.requestId), headers = scope.headers())) ?: return null
        return preparation(response, scope, request)
    }

    suspend fun commit(scope: SessionScopeCondition, request: ScopedMessageRequest, preparationId: String): ScopedMessageCommitReceipt {
        request.validate(); scope.validate(); require(validPreparationId(preparationId))
        val body = buildJsonObject { put("version", 1); put("preparationId", preparationId) }.toString()
        val response = scopedExecute(transport, ApiRequest("POST", receiptPath(scope, request.requestId) + "/commit", body,
            headers = scope.headers(), contentType = "application/json"))
        return commitReceipt(response, scope, request, preparationId).also { check(it.accepted) { "PC did not confirm acceptance" } }
    }

    suspend fun findCommit(scope: SessionScopeCondition, request: ScopedMessageRequest, preparationId: String): ScopedMessageCommitReceipt? {
        request.validate(); scope.validate(); require(validPreparationId(preparationId))
        val response = lookup(ApiRequest("GET", receiptPath(scope, request.requestId) + "/commit", headers = scope.headers())) ?: return null
        return commitReceipt(response, scope, request, preparationId)
    }

    private suspend fun lookup(request: ApiRequest): ApiResponse? = try { scopedExecute(transport, request) }
    catch (error: ApiException) { if (error.statusCode == 404 && error.code == "RESOURCE_NOT_FOUND") null else throw error }

    private fun preparation(response: ApiResponse, scope: SessionScopeCondition, request: ScopedMessageRequest): ScopedMessagePreparation =
        SessionMutationJson.decodeFromString<ScopedMessagePreparation>(scopedObject(response).toString()).also {
            check(it.version == 1 && it.sessionId == scope.sessionId && it.requestId == request.requestId &&
                validPreparationId(it.preparationId) && it.state in setOf("prepared", "expired") &&
                !it.accepted && !it.dispatched && it.expiresAt == request.expiresAt && scopedTimestamp(it.createdAt) &&
                Instant.parse(it.createdAt) < Instant.parse(it.expiresAt)) { "Preparation receipt differs from original facts" }
        }

    private fun commitReceipt(response: ApiResponse, scope: SessionScopeCondition, request: ScopedMessageRequest, preparationId: String): ScopedMessageCommitReceipt =
        SessionMutationJson.decodeFromString<ScopedMessageCommitReceipt>(scopedObject(response).toString()).also {
            check(it.version == 1 && it.sessionId == scope.sessionId && it.requestId == request.requestId &&
                it.preparationId == preparationId && it.expiresAt == request.expiresAt && scopedTimestamp(it.updatedAt) &&
                canonicalIdentifier(it.state, 64)) {
                "Commit receipt differs from original preparation"
            }
            check(it.accepted == (it.runId != null) && it.queued == (it.state == "queued"))
            if (it.accepted) check(Regex("run_appapi_[a-f0-9]{32}").matches(it.runId!!) &&
                it.state != "unconfirmed" && it.acceptedAt?.let(::scopedTimestamp) == true)
            else check(it.state == "unconfirmed" && !it.queued && !it.dispatched && it.acceptedAt == null && it.launchAdmittedAt == null)
            check(it.launchAdmittedAt == null || scopedTimestamp(it.launchAdmittedAt))
            check(it.failureCode == null || canonicalIdentifier(it.failureCode, 128))
        }

    private fun preparePath(scope: SessionScopeCondition) = "/api/sessions/${encode(scope.sessionId)}/app-api-message-preparations"
    private fun receiptPath(scope: SessionScopeCondition, requestId: String) = preparePath(scope) + "/${encode(requestId)}"
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    companion object {
        const val PREPARE_PATH = "/api/sessions/{sessionId}/app-api-message-preparations"
        const val RECEIPT_PATH = "$PREPARE_PATH/{requestId}"
        const val COMMIT_PATH = "$RECEIPT_PATH/commit"
    }
}
