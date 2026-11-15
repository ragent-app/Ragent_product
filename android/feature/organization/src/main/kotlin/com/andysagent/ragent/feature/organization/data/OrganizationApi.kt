package com.andysagent.ragent.feature.organization.data

import android.net.Uri
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.decodeFromJsonElement

interface OrganizationApi {
    suspend fun getProjection(organizationId: String, version: Int = 2, sinceEventId: Long = 0L): Result<OrganizationProjectionDto>
    suspend fun getSessionOrganization(sessionId: String): Result<OrganizationProjectionDto?>
}

class RealOrganizationApi(
    private val transport: RagentTransport,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
    },
) : OrganizationApi {

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
