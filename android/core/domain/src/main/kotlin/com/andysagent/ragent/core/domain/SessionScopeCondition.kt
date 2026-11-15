package com.andysagent.ragent.core.domain

import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import com.andysagent.ragent.core.network.*

/** Immutable PC concurrency condition. It carries no phone or PC authorization. */
@Serializable
data class SessionScopeCondition(
    val sessionId: String,
    val expectedScopeRevision: String,
    val expectedProjectId: String?,
    val version: Int = 1,
) {
    fun validate(): SessionScopeCondition = apply {
        require(version == 1 && canonicalIdentifier(sessionId, 256))
        require(Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(expectedScopeRevision))
        require(expectedProjectId == null || canonicalIdentifier(expectedProjectId, 256))
    }
    fun headers(): Map<String, String> {
        validate()
        val bytes = SessionMutationJson.encodeToString(this).toByteArray(Charsets.UTF_8)
        require(bytes.size <= 2048)
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        require(encoded.length <= 4096)
        return mapOf(HEADER to encoded)
    }
    companion object { const val HEADER = "x-ragent-app-api-scope" }
}

internal fun canonicalIdentifier(value: String, max: Int) = value == value.trim() &&
    sessionMutationIdentifier(value, max) && scopedUnicode(value)

internal fun scopedUnicode(value: String): Boolean {
    var i = 0
    while (i < value.length) {
        val c = value[i++]
        if (c.isHighSurrogate()) {
            if (i == value.length || !value[i++].isLowSurrogate()) return false
        } else if (c.isLowSurrogate()) return false
    }
    return true
}

/** Negotiation always reads the bound carrier; no cached UI context or inferred paths. */
internal suspend fun requireSessionScopeEffects(transport: RagentTransport, expected: Map<String, Pair<String, String>>) {
    val contract = scopedObject(scopedExecute(transport, ApiRequest("GET", "/api/session-scope-contract")))
    fun unsupported(): Nothing = throw ApiException(501, "CAPABILITY_UNSUPPORTED", "Required Session scope protocol is unavailable")
    if (contract["version"] != JsonPrimitive(1) || contract["header"] != JsonPrimitive(SessionScopeCondition.HEADER) ||
        contract["encoding"] != JsonPrimitive("base64url-utf8-json") ||
        contract["contextPath"] != JsonPrimitive("/api/sessions/{sessionId}/app-api-context") ||
        (contract["maxHeaderBytes"] as? JsonPrimitive)?.intOrNull?.let { it >= 4096 } != true ||
        (contract["maxDecodedBytes"] as? JsonPrimitive)?.intOrNull?.let { it >= 2048 } != true ||
        (contract["fields"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() !=
            setOf("version", "sessionId", "expectedScopeRevision", "expectedProjectId")) unsupported()
    val effects = contract["effects"] as? JsonArray ?: unsupported()
    for ((id, endpoint) in expected) {
        val matches = effects.filter { (it as? JsonObject)?.get("id") == JsonPrimitive(id) }
        if (matches.size != 1) unsupported()
        val effect = matches.single() as JsonObject
        if (effect["method"] != JsonPrimitive(endpoint.first) || effect["path"] != JsonPrimitive(endpoint.second)) unsupported()
        if (endpoint.first == "GET" && effect["readonly"] != JsonPrimitive(true)) unsupported()
        if (id == "message.prepare" && effect["startsRun"] != JsonPrimitive(false)) unsupported()
        if (id == "message.commit" && effect["durableQueue"] != JsonPrimitive(true)) unsupported()
        if (id == "asset.upload.body" && effect["stagedBeforeGuard"] != JsonPrimitive(true)) unsupported()
        if (id == "asset.upload.finalize" && effect["verifiedBeforeGuard"] != JsonPrimitive(true)) unsupported()
    }
}

internal suspend fun scopedExecute(transport: RagentTransport, request: ApiRequest): ApiResponse {
    val response = transport.execute(request)
    if (!response.isSuccessful) {
        val code = runCatching { scopedObject(response)["code"]?.jsonPrimitive?.contentOrNull }.getOrNull()
        throw ApiException(response.statusCode, code, "Conditional PC operation failed")
    }
    return response
}
internal fun scopedObject(response: ApiResponse): JsonObject {
    require(response.body.toByteArray(Charsets.UTF_8).size <= 128 * 1024) { "Conditional response exceeds its bound" }
    return SessionMutationJson.parseToJsonElement(response.body).jsonObject
}
