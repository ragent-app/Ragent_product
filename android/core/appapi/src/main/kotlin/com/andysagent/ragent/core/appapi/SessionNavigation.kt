package com.andysagent.ragent.core.appapi

import java.net.URI
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** Navigation hints are never submission or approval authority. Null target is legacy input. */
@Serializable
data class SessionNavigationRequest(
    val sessionId: String,
    val targetInstanceId: String? = null,
    val kind: String = "",
    val awaitingKey: String = "",
    val eventId: String = "",
) {
    fun validated(): SessionNavigationRequest {
        if (!NAVIGATION_ID.matches(sessionId) || targetInstanceId?.let { !NAVIGATION_ID.matches(it) } == true ||
            kind.toByteArray(Charsets.UTF_8).size > 64 || awaitingKey.toByteArray(Charsets.UTF_8).size > 512 ||
            eventId.toByteArray(Charsets.UTF_8).size > 256 ||
            listOf(kind, awaitingKey, eventId).any { it.any { c -> c.code < 32 } }) {
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid session navigation")
        }
        return this
    }

    /** Full digest in Intent data + notification tag; never use String.hashCode identity. */
    fun identity(): String {
        validated()
        val identity = if (eventId.isNotEmpty()) copy(kind = "", awaitingKey = "") else this
        return MessageDigest.getInstance("SHA-256").digest(AppApiJson.encodeToString(identity).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

private val NAVIGATION_ID = Regex("[A-Za-z0-9_-]{1,160}")

/** Canonical session URI. No commands, credentials, fragments, duplicate or unknown parameters. */
fun sessionNavigationUri(request: SessionNavigationRequest): String {
    request.validated()
    val target = request.targetInstanceId ?: apiFailure(ApiErrorCode.AMBIGUOUS_TARGET, "Choose the source computer")
    return "ragent://session/${request.sessionId}?instanceId=$target"
}

fun parseSessionNavigationUri(value: String): SessionNavigationRequest {
    if (value.length > 1024) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Navigation link exceeds limit")
    val uri = try { URI(value) } catch (_: Exception) { apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid navigation link") }
    if (uri.scheme !in setOf("ragent", "riollant", "ragent") || uri.rawAuthority != "session" || uri.rawFragment != null ||
        !uri.rawPath.orEmpty().startsWith("/") || uri.rawQuery?.startsWith("instanceId=") != true) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid session link")
    }
    // IDs have a deliberately small alphabet; encoded separators and query injection are refused.
    return SessionNavigationRequest(uri.rawPath.removePrefix("/"), uri.rawQuery.removePrefix("instanceId=")).validated()
}
