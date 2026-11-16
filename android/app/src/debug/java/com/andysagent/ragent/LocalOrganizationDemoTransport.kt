package com.andysagent.ragent

import android.net.Uri
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.ui.organizationDemoProjection
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import org.json.JSONObject

/** Debug-only, in-memory inputs for the existing chat and organization rendering. */
internal class LocalOrganizationDemoTransport(private val sessionId: String) : RagentTransport {
    override val invalidations = MutableSharedFlow<InvalidationHint>()
    private val connection = MutableStateFlow(RuntimeConnectionState.Connected)
    override val connectionState: StateFlow<RuntimeConnectionState> = connection
    private var membersVisible = false

    suspend fun showMembers(visible: Boolean) {
        membersVisible = visible
        // Re-enter the existing projection loading path without touching a network or cache.
        connection.value = RuntimeConnectionState.Disconnected
        delay(100)
        connection.value = RuntimeConnectionState.Connected
    }

    override suspend fun execute(request: ApiRequest): ApiResponse {
        if (request.method != "GET") return ApiResponse(403, "{}")
        val path = Uri.parse(request.path).path.orEmpty()
        val prefix = "/api/sessions/${Uri.encode(sessionId)}"
        return when (path) {
            "$prefix/organization/projection" -> if (membersVisible) {
                val projection = organizationDemoProjection(sessionId)
                ApiResponse(200, Json.encodeToString(OrganizationProjectionDto.serializer(), projection))
            } else ApiResponse(404, JSONObject().put("code", "ORGANIZATION_NOT_FOUND").toString())
            "$prefix/delegation-runs" -> ApiResponse(200, JSONObject().put("sessionId", sessionId).put("runs", org.json.JSONArray()).toString())
            "$prefix/organization/actions" -> ApiResponse(404, "{}")
            else -> ApiResponse(404, "{}")
        }
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
