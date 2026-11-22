package com.andysagent.ragent.feature.organization.data

import android.net.Uri
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

internal fun isOrganizationAuthorizationRevokedStatus(statusCode: Int): Boolean =
    statusCode == 401 || statusCode == 403

internal fun isOrganizationFeatureUnavailableStatus(statusCode: Int): Boolean =
    statusCode in setOf(404, 405, 410, 501)

internal fun normalizeOrganizationUnavailableResponse(response: ApiResponse): ApiResponse {
    if (!isOrganizationFeatureUnavailableStatus(response.statusCode)) return response
    val parsed = runCatching { Json.parseToJsonElement(response.body) }.getOrNull()
    if (parsed is JsonObject) return response
    return response.copy(
        body = """{"error":"Feature or route unavailable (HTTP ${response.statusCode})","code":"ROUTE_UNAVAILABLE"}""",
        bodyBytes = null,
    )
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

    private fun parseApiException(statusCode: Int, body: String, fallback: String): ApiException {
        val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
        val code = obj?.get("code")?.jsonPrimitive?.contentOrNull
        val message = obj?.get("error")?.jsonPrimitive?.contentOrNull
            ?: obj?.get("message")?.jsonPrimitive?.contentOrNull
            ?: fallback
        return ApiException(statusCode, code, message)
    }

    private fun decodeProjection(body: String): OrganizationProjectionDto {
        val value = json.parseToJsonElement(body)
        // Current servers wrap projections; accept the older direct form too.
        val projection = value.jsonObject["projection"] ?: value
        return json.decodeFromJsonElement(projection)
    }
}
