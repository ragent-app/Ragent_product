package com.andysagent.ragent.feature.organization.data

import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.RagentTransport
import java.net.URLEncoder
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

interface ButlerRepository {
    suspend fun getButlerOverview(
        organizationId: String? = null,
        projectId: String? = null,
        limit: Int = 50,
    ): Result<ButlerOverviewResponseDto>

    suspend fun getVoiceAdapters(): Result<VoiceAdaptersResponseDto>

    suspend fun listVoiceSessions(
        responsibilityId: String? = null,
        limit: Int = 20,
    ): Result<VoiceSessionListResponseDto>

    suspend fun createVoiceSession(request: CreateVoiceSessionRequestDto): Result<VoiceSessionDetailResponseDto>

    suspend fun getVoiceSession(
        sessionId: String,
        turnLimit: Int = 50,
    ): Result<VoiceSessionDetailResponseDto>

    suspend fun submitVoiceTurn(
        sessionId: String,
        request: VoiceTurnRequestDto,
    ): Result<VoiceTurnResponseDto>

    suspend fun interruptVoiceSession(
        sessionId: String,
        request: VoiceInterruptRequestDto,
    ): Result<VoiceInterruptResponseDto>

    suspend fun handoffVoiceSession(
        sessionId: String,
        request: VoiceHandoffRequestDto,
    ): Result<VoiceHandoffResponseDto>

    suspend fun confirmVisualApproval(
        card: VoiceApprovalCardDto,
        idempotencyKey: String,
    ): Result<JsonObject>
}

class RealButlerRepository(
    private val transport: RagentTransport,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        coerceInputValues = true
        encodeDefaults = true
    },
) : ButlerRepository {

    override suspend fun getButlerOverview(
        organizationId: String?,
        projectId: String?,
        limit: Int,
    ): Result<ButlerOverviewResponseDto> = runCatching {
        val params = buildList {
            organizationId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                add("organizationId=${encodeUriComponent(it)}")
            }
            projectId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                add("projectId=${encodeUriComponent(it)}")
            }
            add("limit=${limit.coerceIn(1, 200)}")
        }
        val query = if (params.isEmpty()) "" else "?${params.joinToString("&")}"
        executeGet("/api/responsibilities/butler-overview$query", ButlerOverviewResponseDto.serializer())
    }

    override suspend fun getVoiceAdapters(): Result<VoiceAdaptersResponseDto> = runCatching {
        executeGet("/api/responsibilities/voice/adapters", VoiceAdaptersResponseDto.serializer())
    }

    override suspend fun listVoiceSessions(
        responsibilityId: String?,
        limit: Int,
    ): Result<VoiceSessionListResponseDto> = runCatching {
        val params = buildList {
            responsibilityId?.trim()?.takeIf { it.isNotEmpty() }?.let {
                add("responsibilityId=${encodeUriComponent(it)}")
            }
            add("limit=${limit.coerceIn(1, 100)}")
        }
        executeGet(
            "/api/responsibilities/voice/sessions?${params.joinToString("&")}",
            VoiceSessionListResponseDto.serializer(),
        )
    }

    override suspend fun createVoiceSession(
        request: CreateVoiceSessionRequestDto,
    ): Result<VoiceSessionDetailResponseDto> = runCatching {
        executePost(
            path = "/api/responsibilities/voice/sessions",
            body = json.encodeToString(CreateVoiceSessionRequestDto.serializer(), request),
            idempotencyKey = request.idempotencyKey,
            serializer = VoiceSessionDetailResponseDto.serializer(),
        )
    }

    override suspend fun getVoiceSession(
        sessionId: String,
        turnLimit: Int,
    ): Result<VoiceSessionDetailResponseDto> = runCatching {
        executeGet(
            "/api/responsibilities/voice/sessions/${encodeUriComponent(sessionId)}?turnLimit=${turnLimit.coerceIn(1, 200)}",
            VoiceSessionDetailResponseDto.serializer(),
        )
    }

    override suspend fun submitVoiceTurn(
        sessionId: String,
        request: VoiceTurnRequestDto,
    ): Result<VoiceTurnResponseDto> = runCatching {
        executePost(
            path = "/api/responsibilities/voice/sessions/${encodeUriComponent(sessionId)}/turn",
            body = json.encodeToString(VoiceTurnRequestDto.serializer(), request),
            idempotencyKey = request.idempotencyKey,
            serializer = VoiceTurnResponseDto.serializer(),
        )
    }

    override suspend fun interruptVoiceSession(
        sessionId: String,
        request: VoiceInterruptRequestDto,
    ): Result<VoiceInterruptResponseDto> = runCatching {
        executePost(
            path = "/api/responsibilities/voice/sessions/${encodeUriComponent(sessionId)}/interrupt",
            body = json.encodeToString(VoiceInterruptRequestDto.serializer(), request),
            idempotencyKey = null,
            serializer = VoiceInterruptResponseDto.serializer(),
        )
    }

    override suspend fun handoffVoiceSession(
        sessionId: String,
        request: VoiceHandoffRequestDto,
    ): Result<VoiceHandoffResponseDto> = runCatching {
        executePost(
            path = "/api/responsibilities/voice/sessions/${encodeUriComponent(sessionId)}/handoff",
            body = json.encodeToString(VoiceHandoffRequestDto.serializer(), request),
            idempotencyKey = request.idempotencyKey,
            serializer = VoiceHandoffResponseDto.serializer(),
        )
    }

    override suspend fun confirmVisualApproval(
        card: VoiceApprovalCardDto,
        idempotencyKey: String,
    ): Result<JsonObject> = runCatching {
        require(card.requiresExplicitConfirm && !card.executableViaVoice) {
            "Visual approval card cannot bypass explicit confirmation."
        }
        require(idempotencyKey.isNotBlank()) { "Idempotency key is required." }
        val endpoint = card.confirmationEndpoint
            ?: error("Direct visual confirmation endpoint is unavailable; open details to review.")
        val path = endpoint.path.trim()
        require(path.startsWith("/api/responsibilities/") || path.startsWith("/api/organizations/")) {
            "Rejected unexpected confirmation endpoint path."
        }
        val method = endpoint.method.trim().uppercase().ifEmpty { "POST" }
        require(method == "POST" || method == "PUT" || method == "PATCH") {
            "Unsupported confirmation method: $method"
        }
        val payload = buildJsonObject {
            endpoint.bodyTemplate?.forEach { (key, value) ->
                if (key != "idempotencyKey" && key != "confirmed") {
                    put(key, value)
                }
            }
            if (endpoint.bodyTemplate?.containsKey("expectedVersion") != true && card.expectedVersion != null) {
                put("expectedVersion", card.expectedVersion)
            }
            if (endpoint.bodyTemplate?.containsKey("proposalDigest") != true && !card.proposalDigest.isNullOrBlank()) {
                put("proposalDigest", card.proposalDigest)
            }
            if (endpoint.bodyTemplate?.containsKey("actionDigest") != true && !card.actionDigest.isNullOrBlank()) {
                put("actionDigest", card.actionDigest)
            }
            put("confirmed", true)
            put("idempotencyKey", idempotencyKey)
        }
        val response = transport.execute(
            ApiRequest(
                method = method,
                path = path,
                body = payload.toString(),
                idempotencyKey = idempotencyKey,
                contentType = "application/json",
            ),
        )
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Approval confirmation failed: HTTP ${response.statusCode}")
        }
        json.parseToJsonElement(response.body).jsonObject
    }

    private suspend fun <T> executeGet(path: String, serializer: KSerializer<T>): T {
        val response = transport.execute(ApiRequest(method = "GET", path = path))
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Request failed: HTTP ${response.statusCode}")
        }
        return json.decodeFromString(serializer, response.body)
    }

    private suspend fun <T> executePost(
        path: String,
        body: String,
        idempotencyKey: String?,
        serializer: KSerializer<T>,
    ): T {
        val response = transport.execute(
            ApiRequest(
                method = "POST",
                path = path,
                body = body,
                idempotencyKey = idempotencyKey,
                contentType = "application/json",
            ),
        )
        if (!response.isSuccessful) {
            throw parseApiException(response.statusCode, response.body, "Request failed: HTTP ${response.statusCode}")
        }
        return json.decodeFromString(serializer, response.body)
    }

    private fun parseApiException(statusCode: Int, body: String, fallback: String): ApiException {
        val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
        val code = obj?.get("code")?.jsonPrimitive?.contentOrNull
        val message = obj?.get("error")?.jsonPrimitive?.contentOrNull
            ?: obj?.get("message")?.jsonPrimitive?.contentOrNull
            ?: fallback
        // Only the server's fixed, non-secret diagnostic codes are shown.
        val reason = obj?.get("reason")?.jsonPrimitive?.contentOrNull
        val allowed = setOf("namespace_unavailable", "owner_session_unavailable", "authentication_method_unavailable", "owner_binding_unavailable", "account_binding_mismatch", "authority_unavailable")
        val detail = if (code == "RESPONSIBILITY_OWNER_UNAVAILABLE" && reason in allowed) "$message ($reason)" else message
        return ApiException(statusCode, code, detail)
    }
    private fun encodeUriComponent(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

private val DIRECT_VISUAL_CONFIRMATION_KINDS = setOf(
    "plan_approval",
    "responsibility_activation",
    "responsibility_resume",
)

fun overviewItemToApprovalCard(item: ButlerOverviewItemDto): VoiceApprovalCardDto {
    val action = item.actionTarget
    val path = action?.confirmationPath?.trim().orEmpty()
    val method = action?.confirmationMethod?.trim()?.uppercase()?.ifEmpty { "POST" } ?: "POST"
    val directAllowed = action?.kind in DIRECT_VISUAL_CONFIRMATION_KINDS && method == "POST"
    val endpoint = path.takeIf { it.isNotEmpty() && directAllowed }?.let { resolvedPath ->
        val template = buildJsonObject {
            (action?.expectedVersion ?: item.responsibilityRowVersion?.takeIf { it > 0L })?.let {
                put("expectedVersion", it)
            }
            action?.proposalDigest?.takeIf { it.isNotBlank() }?.let {
                put("proposalDigest", it)
            }
            action?.approvalId?.takeIf { it.isNotBlank() }?.let {
                put("approvalId", it)
            }
        }
        VoiceApprovalEndpointDto(method = method, path = resolvedPath, bodyTemplate = template)
    }
    return VoiceApprovalCardDto(
        approvalId = action?.approvalId?.takeIf { it.isNotBlank() } ?: item.itemId,
        kind = action?.kind?.takeIf { it.isNotBlank() } ?: item.itemType,
        title = item.title.ifBlank { item.responsibilityObjective },
        target = action?.target?.takeIf { it.isNotBlank() } ?: item.responsibilityObjective,
        impactSummary = action?.impactSummary?.takeIf { it.isNotBlank() } ?: item.summary,
        actionDigest = action?.proposalDigest ?: item.artifact?.candidateDigest,
        responsibilityId = item.resolvedResponsibilityId,
        expectedVersion = action?.expectedVersion ?: item.responsibilityRowVersion,
        planId = action?.planId,
        proposalDigest = action?.proposalDigest,
        workItemId = action?.workItemId,
        riskLevel = item.severity,
        confirmationEndpoint = endpoint,
        requiresExplicitConfirm = true,
        executableViaVoice = false,
        status = item.status.ifBlank { "pending_visual_confirmation" },
        createdAt = item.updatedAt,
    )
}
