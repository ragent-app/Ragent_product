package com.andysagent.ragent.core.appapi

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Public operation projection excludes preparation token, caller identity, input and replay keys. */
fun TaskOperation.receiptEnvelope(): ApiEnvelope {
    val resources = buildList {
        sessionId?.takeIf { messageProtocolVersion == 0 || originalScope?.sessionId == it }
            ?.let { add(ResourceRef(targetInstanceId, "session", it)) }
        runId?.let { add(ResourceRef(targetInstanceId, "run", it)) }
    }
    val error = lastError ?: when (stage) {
        OperationStage.CANCELLED -> ApiError(ApiErrorCode.CANCELLED, "Submission was cancelled")
        OperationStage.EXPIRED -> ApiError(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
        else -> null
    }
    val status = when {
        stage == OperationStage.ACCEPTED -> ApiResultStatus.ACCEPTED
        error != null -> when (error.code) {
            ApiErrorCode.TARGET_OFFLINE, ApiErrorCode.RESULT_UNKNOWN, ApiErrorCode.AUTHENTICATION_REQUIRED -> ApiResultStatus.UNAVAILABLE
            else -> ApiResultStatus.FAILED
        }
        else -> ApiResultStatus.COMPLETED // Local preparation/query action, never remote AI completion.
    }
    return ApiEnvelope(status = status, operationId = operationId, resources = resources, error = error, data = buildJsonObject {
        put("targetInstanceId", targetInstanceId)
        put("stage", stage.name)
        put("queued", queued)
        put("duplicate", duplicate)
        put("deadlineAt", deadlineAt)
        commitReceipt?.let {
            put("pcState", it.state)
            put("pcUpdatedAt", it.updatedAt)
            put("dispatched", it.dispatched)
            it.launchAdmittedAt?.let { time -> put("launchAdmittedAt", time) }
            it.failureCode?.let { code -> put("failureCode", code) }
        }
    })
}
