package com.andysagent.ragent.core.appapi

import java.net.URI

/** Shared by preparation and draft freezing so invalid input remains editable. */
internal fun validateTaskRequest(request: TaskRequest) {
    validateResourceRefs(request.resources)
    if (request.apiVersion != 1) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unsupported App API version")
    if (request.allowDeferredSubmission) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Deferred submission worker is not connected yet")
    if (!Regex("[A-Za-z0-9_-]{1,128}").matches(request.operationId)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid operation identity")
    if (request.instruction.isBlank() || request.runtime.tool.isBlank()) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Instruction and runtime tool are required")
    val rendered = renderTaskInput(request)
    if ('\u0000' in rendered || String(rendered.toByteArray(Charsets.UTF_8), Charsets.UTF_8) != rendered)
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Input contains invalid Unicode or NUL")
    if (request.targetInstanceId != null && request.targetAlias != null) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Specify a computer identity or alias")
    if (listOf(request.targetInstanceId, request.targetAlias, request.existingSessionId, request.projectId, request.agentId,
            request.runtime.providerProfile, request.runtime.model, request.runtime.effort).any { it != null &&
                (it.isBlank() || it.length > 256 || it != it.trim() || it.any { c -> c.code < 32 || c.code == 127 } ||
                    String(it.toByteArray(Charsets.UTF_8), Charsets.UTF_8) != it) }
        || request.runtime.tool.length > 128 || request.runtime.tool != request.runtime.tool.trim() ||
        request.runtime.tool.any { it.code < 32 || it.code == 127 } || (request.title?.length ?: 0) > 512) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid resource identity or runtime field")
    }
    if (request.runtime.interactionMode !in setOf("agent", "plan") || request.runtime.serviceTier !in setOf("standard", "fast")) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid runtime selection")
    }
    if (request.sourceUrls.size > 16 || request.sourceUrls.any { !isCaptureSourceUrl(it) }
        || renderTaskInput(request).toByteArray(Charsets.UTF_8).size > 48 * 1024) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Input exceeds limits or has an invalid source URL")
    }
    // JSON escaping can exceed the PC body bound even when raw text fits 48 KiB.
    // Asset IDs have fixed width; validate the largest possible replay key before any PC effect.
    try {
        com.andysagent.ragent.core.domain.ScopedMessageRequest("x".repeat(200), rendered,
            request.resources.mapIndexed { index, ref -> com.andysagent.ragent.core.domain.PreparedMessageAsset(
                "fasset_" + index.toString(16).padStart(24, '0'), ref.sha256, ref.sizeBytes, "file".takeIf { ref.renderAsFile }) },
            scopedMessageOptions(request), "1970-01-01T00:00:00.000Z").validate()
    } catch (invalid: IllegalArgumentException) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Input cannot fit the conditional PC message contract")
    }
}

internal fun isCaptureSourceUrl(value: String): Boolean {
    val uri = runCatching { URI(value) }.getOrNull() ?: return false
    return uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && value.length <= 4096
}
