package com.andysagent.ragent.feature.organization.data

import android.net.Uri
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.decodeFromJsonElement

interface OrganizationApi {
    suspend fun getProjection(organizationId: String, version: Int = 2, sinceEventId: Long = 0L): Result<OrganizationProjectionDto>
    suspend fun getSessionOrganization(sessionId: String): Result<OrganizationProjectionDto?>
    suspend fun getSessionMembers(sessionId: String): Result<UnifiedMembersPageDto> = Result.failure(UnsupportedOperationException())
    suspend fun getSessionActions(sessionId: String, afterId: Long = 0L, limit: Int = 100): Result<OrganizationActionsDto?> =
        Result.failure(UnsupportedOperationException("Organization actions unavailable"))
    suspend fun getDelegationRuns(sessionId: String): Result<DelegationRunsDto> = Result.failure(UnsupportedOperationException())
    suspend fun getDelegationEvents(sessionId: String, runId: String, afterLines: Long = 0L): Result<DelegationEventsDto> = Result.failure(UnsupportedOperationException())
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
        val path = "/api/sessions/${Uri.encode(sessionId)}/organization/projection"
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (response.statusCode == 404) return@runCatching null
        if (!response.isSuccessful) {
            error("Failed to load session organization projection: ${response.statusCode}")
        }
        decodeProjection(response.body)
    }

    private fun decodeProjection(body: String): OrganizationProjectionDto {
        val value = json.parseToJsonElement(body)
        // Current servers wrap projections; accept the older direct form too.
        val projection = value.jsonObject["projection"] ?: value
        return json.decodeFromJsonElement(projection)
    }
}
