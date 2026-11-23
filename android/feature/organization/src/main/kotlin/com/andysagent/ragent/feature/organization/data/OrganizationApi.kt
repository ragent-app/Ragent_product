package com.andysagent.ragent.feature.organization.data

import android.net.Uri
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import java.net.URI
import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put

private val SESSION_AUTH_REVOCATION_ERROR_CODES = setOf(
    "DEVICE_REVOKED",
    "GOOGLE_REQUIRED",
    "OWNER_ACCESS_REQUIRED",
    "PERMISSION_DENIED",
    "TEMPORARY_CONTROL_CARRIER_REQUIRED",
    "TEMPORARY_CONTROL_DENIED",
    "ACCOUNT_PAIRING_OWNER_REQUIRED",
    "TEMPORARY_HOST_OWNER_REQUIRED",
    "AUTHENTICATION_REQUIRED",
    "UNAUTHORIZED",
)

private val FEATURE_UNAVAILABLE_403_ERROR_CODES = setOf(
    "RESPONSIBILITY_OWNER_UNAVAILABLE",
    "RESPONSIBILITY_DEVICE_BINDING_REQUIRED",
    "ROUTE_UNAVAILABLE",
    "FEATURE_UNAVAILABLE",
    "CAPABILITY_UNAVAILABLE",
)

internal fun encodeOrganizationUriComponent(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

private fun normalizeOrganizationRequestPath(path: String): String {
    val withoutQuery = path.trim().substringBefore('?').substringBefore('#')
    return if (withoutQuery.startsWith("http://") || withoutQuery.startsWith("https://")) {
        runCatching { URI(withoutQuery).rawPath ?: withoutQuery }.getOrDefault(withoutQuery)
    } else {
        withoutQuery
    }
}

internal fun extractApiErrorCode(body: String): String? = runCatching {
    val parsed = Json.parseToJsonElement(body)
    if (parsed is JsonObject) {
        parsed["code"]?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
    } else null
}.getOrNull()

internal fun isCoreOrganizationAuthPath(path: String): Boolean {
    val normalized = normalizeOrganizationRequestPath(path)
    return normalized == "/api/auth" ||
        normalized.startsWith("/api/auth/") ||
        normalized.matches(Regex("^/api/organizations/[^/]+/projection$")) ||
        normalized.matches(Regex("^/api/organizations/[^/]+/nodes/[^/]+/conversation$")) ||
        normalized.matches(Regex("^/api/sessions/[^/]+/organization(?:/.*)?$")) ||
        normalized.matches(Regex("^/api/sessions/[^/]+/(?:snapshot|events(?:/wait)?)$"))
}

internal fun isOptionalOrganizationSubFeaturePath(path: String): Boolean {
    val normalized = normalizeOrganizationRequestPath(path)
    return normalized == "/api/responsibilities" ||
        normalized.startsWith("/api/responsibilities/") ||
        normalized.matches(Regex("^/api/sessions/[^/]+/responsibility-context$")) ||
        normalized.matches(Regex("^/api/runs/[^/]+/email-targets/[^/]+/manual-review$"))
}

internal fun isOrganizationFeatureUnavailable403(
    statusCode: Int,
    errorCode: String? = null,
    requestPath: String? = null,
): Boolean {
    if (statusCode != 403) return false
    val normalizedCode = errorCode?.trim()?.uppercase()?.takeIf { it.isNotEmpty() } ?: return false
    if (normalizedCode in SESSION_AUTH_REVOCATION_ERROR_CODES) return false
    if (requestPath != null && isCoreOrganizationAuthPath(requestPath)) return false
    if (normalizedCode in FEATURE_UNAVAILABLE_403_ERROR_CODES) return true
    return requestPath != null && isOptionalOrganizationSubFeaturePath(requestPath)
}

internal fun isOrganizationAuthorizationRevokedStatus(
    statusCode: Int,
    errorCode: String? = null,
    requestPath: String? = null,
): Boolean {
    if (statusCode == 401) return true
    if (statusCode != 403) return false
    return !isOrganizationFeatureUnavailable403(statusCode, errorCode, requestPath)
}

internal fun isOrganizationFeatureUnavailableStatus(
    statusCode: Int,
    errorCode: String? = null,
    requestPath: String? = null,
): Boolean =
    statusCode in setOf(404, 405, 410, 501) ||
        isOrganizationFeatureUnavailable403(statusCode, errorCode, requestPath)

internal fun normalizeOrganizationUnavailableResponse(
    response: ApiResponse,
    requestPath: String? = null,
): ApiResponse {
    val code = extractApiErrorCode(response.body)
    if (!isOrganizationFeatureUnavailableStatus(response.statusCode, code, requestPath)) return response
    val parsed = runCatching { Json.parseToJsonElement(response.body) as? JsonObject }.getOrNull()
    if (parsed != null) {
        val hasError = parsed["error"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true
        if (hasError || response.statusCode != 403) return response
        val normalizedBody = buildJsonObject {
            parsed.forEach { (key, value) ->
                if (key != "error") put(key, value)
            }
            put("error", "Feature or route unavailable (HTTP ${response.statusCode})")
        }.toString()
        return response.copy(body = normalizedBody, bodyBytes = null)
    }
    return response.copy(
        body = """{"error":"Feature or route unavailable (HTTP ${response.statusCode})","code":"ROUTE_UNAVAILABLE"}""",
        bodyBytes = null,
    )
}

internal fun parseOrganizationApiException(
    statusCode: Int,
    body: String,
    fallback: String = "HTTP $statusCode",
): ApiException {
    val obj = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull()
    val code = obj?.get("code")?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
    val message = obj?.get("error")?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        ?: obj?.get("message")?.jsonPrimitive?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        ?: fallback
    return ApiException(statusCode, code, message)
}

internal fun formatOrganizationFeatureUnavailableBanner(
    error: Throwable,
    fallbackPrefix: String = "Feature unavailable",
): String {
    if (error is ApiException) {
        val detail = error.message.trim().takeIf { it.isNotEmpty() } ?: "HTTP ${error.statusCode}"
        val code = error.code?.trim()?.takeIf { it.isNotEmpty() }
        return if (code != null && !detail.contains(code)) {
            "$fallbackPrefix: $detail ($code)"
        } else {
            "$fallbackPrefix: $detail"
        }
    }
    val detail = error.message?.trim()?.takeIf { it.isNotEmpty() } ?: "unavailable"
    return "$fallbackPrefix: $detail"
}

/** Executes a transport request with organization-level auth revocation fencing and optional factory caching. */
internal suspend fun executeCachedOrganizationTransportRequest(
    transport: RagentTransport,
    request: ApiRequest,
    hasOfflineScope: Boolean,
    requestGeneration: Long?,
    ownerGeneration: Long?,
    ownerVerified: Boolean,
    organizationId: String?,
    onAuthorizationRevoked: suspend () -> Unit,
    onCacheFactoryResponse: suspend (body: String, generation: Long, path: String) -> Unit,
): ApiResponse {
    if (transport.connectionState.value != RuntimeConnectionState.Connected) error("Offline controls are disabled")
    val response = try {
        transport.execute(request)
    } catch (error: ApiException) {
        if (hasOfflineScope && isOrganizationAuthorizationRevokedStatus(error.statusCode, error.code, request.path)) {
            onAuthorizationRevoked()
        }
        throw error
    }
    val responseErrorCode = extractApiErrorCode(response.body)
    if (hasOfflineScope && isOrganizationAuthorizationRevokedStatus(response.statusCode, responseErrorCode, request.path)) {
        onAuthorizationRevoked()
    } else if (
        hasOfflineScope &&
        ownerVerified &&
        requestGeneration == ownerGeneration &&
        request.method == "GET" &&
        response.isSuccessful &&
        organizationId != null
    ) {
        val base = "/api/organizations/${encodeOrganizationUriComponent(organizationId)}/factory/"
        val tail = request.path.removePrefix(base)
        val permitted = request.path.startsWith(base) &&
            (tail == "work-items" || tail.matches(Regex("work-items/[^/?]+")) || tail.matches(Regex("nodes/[^/?]+/messages")))
        if (permitted && requestGeneration != null) {
            onCacheFactoryResponse(response.body, requestGeneration, request.path)
        }
    }
    return normalizeOrganizationUnavailableResponse(response, request.path)
}

interface OrganizationApi {
    suspend fun getProjection(organizationId: String, version: Int = 2, sinceEventId: Long = 0L): Result<OrganizationProjectionDto>
    suspend fun getSessionOrganization(sessionId: String): Result<OrganizationProjectionDto?>
    suspend fun getSessionMembers(sessionId: String): Result<UnifiedMembersPageDto> = Result.failure(UnsupportedOperationException())
    suspend fun getSessionActions(sessionId: String, afterId: Long = 0L, limit: Int = 100): Result<OrganizationActionsDto?> =
        Result.failure(UnsupportedOperationException("Organization actions unavailable"))
    suspend fun getDelegationRuns(sessionId: String): Result<DelegationRunsDto> = Result.failure(UnsupportedOperationException())
    suspend fun getDelegationEvents(sessionId: String, runId: String, afterLines: Long = 0L): Result<DelegationEventsDto> = Result.failure(UnsupportedOperationException())
    suspend fun getSwarmStatus(sessionId: String): Result<SwarmStatusDto?> = Result.failure(UnsupportedOperationException())
    suspend fun getBoard(
        sessionId: String,
        channel: String? = null,
        sinceSeq: Long = 0L,
        limit: Int = 100,
    ): Result<SwarmBoardResponseDto?> = Result.failure(UnsupportedOperationException())
    suspend fun postBoardMessage(
        sessionId: String,
        channel: String,
        bodyMarkdown: String,
        replyToSeq: Long? = null,
        idempotencyKey: String? = null,
    ): Result<PostBoardMessageResponseDto> = Result.failure(UnsupportedOperationException())
}

class RealOrganizationApi(
    private val transport: RagentTransport,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    },
) : OrganizationApi {

    override suspend fun getSessionMembers(sessionId: String): Result<UnifiedMembersPageDto> = runCatching {
        val response = transport.execute(ApiRequest("GET", "/api/sessions/${Uri.encode(sessionId)}/organization/members"))
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Failed to load members: ${response.statusCode}")
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun getDelegationRuns(sessionId: String): Result<DelegationRunsDto> = runCatching {
        val response = transport.execute(ApiRequest("GET", "/api/sessions/${Uri.encode(sessionId)}/delegation-runs"))
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Failed to load delegation runs: ${response.statusCode}")
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun getDelegationEvents(sessionId: String, runId: String, afterLines: Long): Result<DelegationEventsDto> = runCatching {
        val response = transport.execute(ApiRequest("GET", "/api/sessions/${Uri.encode(sessionId)}/delegation-runs/${Uri.encode(runId)}/events?afterLines=$afterLines"))
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Failed to load delegation events: ${response.statusCode}")
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun getSessionActions(sessionId: String, afterId: Long, limit: Int): Result<OrganizationActionsDto?> = runCatching {
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/actions?afterId=$afterId&limit=$limit"
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Failed to load organization actions: ${response.statusCode}")
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun getProjection(
        organizationId: String,
        version: Int,
        sinceEventId: Long,
    ): Result<OrganizationProjectionDto> = runCatching {
        val path = "/api/organizations/${Uri.encode(organizationId)}/projection?version=$version&sinceEventId=$sinceEventId"
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (!response.isSuccessful) {
            error("Failed to load organization projection: ${response.statusCode}")
        }
        decodeProjection(response.body)
    }

    override suspend fun getSessionOrganization(
        sessionId: String,
    ): Result<OrganizationProjectionDto?> = runCatching {
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/projection?version=2"
        val response = try {
            transport.execute(ApiRequest(method = "GET", path = path))
        } catch (error: ApiException) {
            if (error.statusCode == 404) return@runCatching null
            throw error
        }
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) {
            error("Failed to load session organization projection: ${response.statusCode}")
        }
        decodeProjection(response.body)
    }

    override suspend fun getSwarmStatus(sessionId: String): Result<SwarmStatusDto?> = runCatching {
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/swarm/status"
        val response = try {
            transport.execute(ApiRequest(method = "GET", path = path))
        } catch (error: ApiException) {
            if (error.statusCode == 404) return@runCatching null
            throw error
        }
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Failed to load swarm status: ${response.statusCode}")
        }
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun getBoard(
        sessionId: String,
        channel: String?,
        sinceSeq: Long,
        limit: Int,
    ): Result<SwarmBoardResponseDto?> = runCatching {
        val query = buildString {
            append("limit=").append(limit.coerceIn(1, 200))
            val trimmedChannel = channel?.trim()?.takeIf { it.isNotEmpty() && it != "__all__" }
            if (trimmedChannel != null) {
                append("&channel=").append(Uri.encode(trimmedChannel))
            }
            if (sinceSeq > 0L) {
                append("&sinceSeq=").append(sinceSeq)
            }
        }
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/board?$query"
        val response = try {
            transport.execute(ApiRequest(method = "GET", path = path))
        } catch (error: ApiException) {
            if (error.statusCode == 404) return@runCatching null
            throw error
        }
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Failed to load board: ${response.statusCode}")
        }
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    override suspend fun postBoardMessage(
        sessionId: String,
        channel: String,
        bodyMarkdown: String,
        replyToSeq: Long?,
        idempotencyKey: String?,
    ): Result<PostBoardMessageResponseDto> = runCatching {
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/board/messages"
        val payload = PostBoardMessageRequestDto(
            channel = channel.trim().ifEmpty { "main" },
            bodyMarkdown = bodyMarkdown,
            replyToSeq = replyToSeq,
            idempotencyKey = idempotencyKey,
        )
        val encoded = json.encodeToString(PostBoardMessageRequestDto.serializer(), payload)
        val response = transport.execute(
            ApiRequest(
                method = "POST",
                path = path,
                body = encoded,
                idempotencyKey = idempotencyKey,
                contentType = "application/json",
            )
        )
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Failed to post board message: ${response.statusCode}")
        }
        json.decodeFromJsonElement(json.parseToJsonElement(response.body))
    }

    private fun parseApiException(statusCode: Int, body: String, fallback: String): ApiException =
        parseOrganizationApiException(statusCode, body, fallback)

    private fun decodeProjection(body: String): OrganizationProjectionDto {
        val value = json.parseToJsonElement(body)
        // Current servers wrap projections; accept the older direct form too.
        val projection = value.jsonObject["projection"] ?: value
        return json.decodeFromJsonElement(projection)
    }
}
