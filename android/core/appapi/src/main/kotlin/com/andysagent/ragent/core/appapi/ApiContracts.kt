package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

val AppApiJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }

@Serializable
enum class ApiErrorCode {
    INVALID_ARGUMENT, AMBIGUOUS_TARGET, TARGET_NOT_FOUND, TARGET_OFFLINE,
    AUTHENTICATION_REQUIRED, PERMISSION_DENIED, CAPABILITY_UNSUPPORTED,
    RESOURCE_NOT_FOUND, REVISION_CONFLICT, REQUEST_EXPIRED, RESULT_UNKNOWN,
    RATE_LIMITED, RESOURCE_LIMIT, CANCELLED, INTERNAL_ERROR,
}

@Serializable
data class ApiError(val code: ApiErrorCode, val message: String, val retryable: Boolean = false)

class AppApiException(val error: ApiError) : RuntimeException(error.message)

internal fun apiFailure(code: ApiErrorCode, message: String): Nothing = throw AppApiException(ApiError(code, message))

@Serializable
enum class ApiResultStatus { COMPLETED, ACCEPTED, NEEDS_INPUT, REQUIRES_INTERACTION, UNAVAILABLE, FAILED }

@Serializable
data class ResourceRef(val targetInstanceId: String, val resourceType: String, val resourceId: String, val revision: String? = null)

@Serializable
data class ApiEnvelope(
    val apiVersion: Int = 1,
    val status: ApiResultStatus,
    val operationId: String? = null,
    val data: JsonObject? = null,
    val resources: List<ResourceRef> = emptyList(),
    val error: ApiError? = null,
)

@Serializable
data class TaskRuntime(
    val tool: String,
    val providerProfile: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String = "standard",
    val interactionMode: String = "agent",
)

@Serializable
data class TaskRequest(
    val operationId: String,
    val instruction: String,
    val runtime: TaskRuntime,
    val apiVersion: Int = 1,
    val targetInstanceId: String? = null,
    val targetAlias: String? = null,
    val existingSessionId: String? = null,
    val projectId: String? = null,
    val agentId: String? = null,
    val title: String? = null,
    val sharedText: String? = null,
    val sourceUrls: List<String> = emptyList(),
    val deadlineAt: Long? = null,
    val allowDeferredSubmission: Boolean = false,
    val resources: List<CaptureResourceRef> = emptyList(),
)

@Serializable
data class PreparedTask(
    val operationId: String,
    val preparationId: String,
    val targetInstanceId: String,
    val deadlineAt: Long,
    val stage: OperationStage,
)

@Serializable
enum class OperationStage { PREPARED, CONNECTING, CREATING_SESSION, SESSION_READY, UPLOADING, MESSAGE_PREPARING, SUBMITTING, ACCEPTED, CANCELLED, EXPIRED }

@Serializable
data class ResourceUploadReceipt(val resourceId: String, val targetInstanceId: String, val sessionId: String,
    val assetId: String, val originalName: String, val mimeType: String, val sizeBytes: Long, val sha256: String,
    val renderAsFile: Boolean, val scopeContractVersion: Int? = null)

/** Internal journal. Caller bindings/tokens are never returned as public metadata. */
@Serializable
data class TaskOperation(
    val operationId: String,
    val callerBinding: String,
    val originalFingerprint: String,
    val preparationId: String,
    val targetInstanceId: String,
    val request: TaskRequest,
    val creationKey: String,
    val messageRequestId: String,
    val createdAt: Long,
    val deadlineAt: Long,
    val stage: OperationStage = OperationStage.PREPARED,
    val sessionId: String? = null,
    val runId: String? = null,
    val queued: Boolean = false,
    val duplicate: Boolean = false,
    val lastError: ApiError? = null,
    val revision: Long = 0,
    val uploads: List<ResourceUploadReceipt> = emptyList(),
    val result: TaskResultSnapshot? = null,
    val resultExport: ResultExportManifest? = null,
    // Missing version decodes as a legacy journal; it must never be silently resubmitted.
    val messageProtocolVersion: Int = 0,
    val originalScope: com.andysagent.ragent.core.domain.SessionScopeCondition? = null,
    val pcPreparationId: String? = null,
    val commitReceipt: com.andysagent.ragent.core.domain.ScopedMessageCommitReceipt? = null,
) {
    fun preparation() = PreparedTask(operationId, preparationId, targetInstanceId, deadlineAt, stage)
}
