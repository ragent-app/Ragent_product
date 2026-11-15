package com.andysagent.ragent.core.domain

import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** PC metadata-only v1, independent of UI caches and the legacy pending queue. */
val SessionMutationJson = Json { encodeDefaults = true; ignoreUnknownKeys = false }

@Serializable
enum class SessionMutationKind {
    @SerialName("rename") RENAME,
    @SerialName("setPinned") SET_PINNED,
    @SerialName("setArchived") SET_ARCHIVED,
    @SerialName("setReviewed") SET_REVIEWED,
}

@Serializable
data class SessionMutationProtocol(
    val version: Int, val kinds: List<SessionMutationKind>, val maxBodyBytes: Int,
    val maxRequestIdLength: Int, val maxSessionIdLength: Int, val maxTitleLength: Int,
    val retainedReceiptsPerSession: Int, val conditionalMetadataOnly: Boolean,
    val contextPath: String, val mutationPath: String, val receiptPath: String,
) {
    fun supports(kind: SessionMutationKind): Boolean = version == 1 && conditionalMetadataOnly &&
        kind in kinds && kinds.distinct().size == kinds.size && maxBodyBytes >= 8192 &&
        maxRequestIdLength >= 200 && maxSessionIdLength >= 256 && maxTitleLength >= 256 &&
        retainedReceiptsPerSession in 1..4096 &&
        contextPath == "/api/sessions/{sessionId}/app-api-context" &&
        mutationPath == "/api/sessions/{sessionId}/app-api-mutations" &&
        receiptPath == "/api/sessions/{sessionId}/app-api-mutations/{requestId}"
}

@Serializable
data class SessionMutationContext(
    val version: Int, val sessionId: String, val projectId: String?,
    val revision: String, val scopeRevision: String, val title: String,
    val titleTruncated: Boolean, val pinned: Boolean, val archived: Boolean,
    val lastReviewedAt: String?, val remainingMutationReceipts: Int,
) {
    fun validate(): SessionMutationContext = apply {
        require(version == 1 && sessionMutationIdentifier(sessionId, 256))
        require(projectId == null || sessionMutationIdentifier(projectId, 256))
        require(sessionMutationRevision(revision) && sessionMutationRevision(scopeRevision))
        require(title.length <= 256 && validUnicode(title) && remainingMutationReceipts in 0..4096)
        require(lastReviewedAt == null || sessionMutationTimestamp(lastReviewedAt))
    }
}

@Serializable
data class SessionMutationCommand(
    val requestId: String, val expectedRevision: String, val expectedScopeRevision: String,
    val expectedProjectId: String?, val kind: SessionMutationKind, val value: JsonElement,
    val version: Int = 1,
) {
    fun validate(): SessionMutationCommand = apply {
        require(version == 1 && sessionMutationIdentifier(requestId, 200))
        require(sessionMutationRevision(expectedRevision) && sessionMutationRevision(expectedScopeRevision))
        require(expectedProjectId == null || sessionMutationIdentifier(expectedProjectId, 256))
        val primitive = value as? JsonPrimitive ?: error("Invalid metadata value")
        if (kind == SessionMutationKind.RENAME) require(primitive.isString &&
            sessionMutationIdentifier(primitive.content, 256) && validUnicode(primitive.content))
        else require(!primitive.isString && primitive.booleanOrNull != null)
    }
}

@Serializable
data class SessionMutationReceipt(
    val version: Int, val requestId: String, val sessionId: String, val kind: SessionMutationKind,
    val changed: Boolean, val revision: String, val scopeRevision: String,
    val observedAt: String, val projectId: String?, val duplicate: Boolean,
) {
    fun validate(): SessionMutationReceipt = apply {
        require(version == 1 && sessionMutationIdentifier(requestId, 200) && sessionMutationIdentifier(sessionId, 256))
        require(sessionMutationRevision(revision) && sessionMutationRevision(scopeRevision))
        require(sessionMutationTimestamp(observedAt) && (projectId == null || sessionMutationIdentifier(projectId, 256)))
    }
}

fun sessionMutationIdentifier(value: String, max: Int) = value.isNotBlank() && value.length <= max &&
    value.none { it.code < 32 || it.code == 127 }
fun sessionMutationRevision(value: String) = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(value)
private fun sessionMutationTimestamp(value: String): Boolean = value.length <= 64 &&
    runCatching { Instant.parse(value) }.isSuccess
private fun validUnicode(value: String): Boolean {
    var index = 0
    while (index < value.length) {
        val unit = value[index++]
        if (unit.isHighSurrogate()) {
            if (index == value.length || !value[index++].isLowSurrogate()) return false
        } else if (unit.isLowSurrogate()) return false
    }
    return true
}
