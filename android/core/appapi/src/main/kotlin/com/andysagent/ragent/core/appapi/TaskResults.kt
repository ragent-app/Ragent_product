package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
enum class TaskResultState { UNCONFIRMED, QUEUED, CHECKING, RUNNING, READY, FAILED, CANCELLED }

@Serializable
data class TaskResultArtifact(val assetId: String, val originalName: String, val mimeType: String, val sizeBytes: Long?)

/** Bounded retained publication, not a Session's latest assistant message. */
@Serializable
data class TaskResultSnapshot(
    val sessionId: String, val requestId: String, val runId: String?, val finalRunId: String?,
    val state: TaskResultState, val text: String?, val textTruncated: Boolean,
    val artifacts: List<TaskResultArtifact>, val observedAt: String, val hasAttachments: Boolean = false,
) {
    val canReplaceSelection: Boolean get() = state == TaskResultState.READY && !textTruncated &&
        !text.isNullOrBlank() && !hasAttachments && artifacts.isEmpty()
}

fun decodeTaskResult(operation: TaskOperation, body: JsonObject): TaskResultSnapshot {
    fun invalid(): Nothing = apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Retained result contract or identity differs")
    fun string(key: String): String? = (body[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun nullableString(key: String): String? = when (val value = body[key]) {
        JsonNull -> null
        is JsonPrimitive -> if (value.isString) value.content else invalid()
        else -> invalid()
    }
    if ((body["resultContractVersion"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull != 1 ||
        string("sessionId") != operation.sessionId || string("requestId") != operation.messageRequestId) invalid()
    val state = when (string("state")) {
        "unconfirmed" -> TaskResultState.UNCONFIRMED; "queued" -> TaskResultState.QUEUED
        "checking" -> TaskResultState.CHECKING; "running" -> TaskResultState.RUNNING
        "ready" -> TaskResultState.READY; "failed" -> TaskResultState.FAILED; "cancelled" -> TaskResultState.CANCELLED
        else -> invalid()
    }
    val runId = nullableString("runId")
    val finalRunId = nullableString("finalRunId")
    if (runId?.let { it.isBlank() || it.length > 256 } == true || finalRunId?.let { it.isBlank() || it.length > 256 } == true ||
        (operation.runId != null && operation.runId != runId)) invalid()
    if (state in setOf(TaskResultState.RUNNING, TaskResultState.READY, TaskResultState.FAILED, TaskResultState.CANCELLED) && runId == null) invalid()
    if (state == TaskResultState.READY && finalRunId == null) invalid()
    val truncated = (body["textTruncated"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: invalid()
    val text = nullableString("text")
    if (state == TaskResultState.READY && text == null) invalid()
    val hasAttachments = (body["hasAttachments"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: invalid()
    if (state != TaskResultState.READY && hasAttachments) invalid()
    if (text != null && text.toByteArray(Charsets.UTF_8).size > 48 * 1024) invalid()
    if (state != TaskResultState.READY && (text != null || truncated || finalRunId != null)) invalid()
    val items = body["artifacts"] as? JsonArray ?: invalid()
    if (items.size > 16 || (state != TaskResultState.READY && items.isNotEmpty())) invalid()
    val artifacts = items.map { item ->
        val value = item as? JsonObject ?: invalid()
        fun field(key: String) = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalid()
        val id = field("assetId"); val name = field("originalName"); val mime = field("mimeType")
        val size = when (val raw = value["sizeBytes"]) {
            JsonNull -> null
            is JsonPrimitive -> if (!raw.isString) raw.longOrNull ?: invalid() else invalid()
            else -> invalid()
        }
        if (!Regex("fasset_[a-f0-9]{24}").matches(id) || name.length > 255 || mime.length > 128 || (size != null && size < 0)) invalid()
        TaskResultArtifact(id, name, mime, size)
    }
    if (artifacts.map { it.assetId }.distinct().size != artifacts.size || (artifacts.isNotEmpty() && !hasAttachments)) invalid()
    val observed = string("observedAt") ?: invalid()
    if (runCatching { java.time.Instant.parse(observed) }.isFailure) invalid()
    return TaskResultSnapshot(operation.sessionId!!, operation.messageRequestId, runId, finalRunId, state, text, truncated, artifacts, observed, hasAttachments)
}
