package com.andysagent.ragent.core.appapi

import java.net.URI
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** Parsed responsibility routing hint extracted from a validated `resp:v1:` awaitingKey. */
@Serializable
data class ResponsibilityNavigationTarget(
    val responsibilityId: String,
    val category: String = "",
    val activityType: String = "",
    val planId: String = "",
)

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

    fun responsibilityTarget(): ResponsibilityNavigationTarget? = parseResponsibilityAwaitingKey(awaitingKey)

    /** Full digest in Intent data + notification tag; never use String.hashCode identity. */
    fun identity(): String {
        validated()
        val identity = if (eventId.isNotEmpty()) copy(kind = "", awaitingKey = "") else this
        return MessageDigest.getInstance("SHA-256").digest(AppApiJson.encodeToString(identity).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

private val NAVIGATION_ID = Regex("[A-Za-z0-9_-]{1,160}")
private val RESPONSIBILITY_TOKEN = Regex("[A-Za-z0-9_-]{1,64}")

fun parseResponsibilityAwaitingKey(value: String): ResponsibilityNavigationTarget? {
    if (!value.startsWith("resp:v1:") || value.toByteArray(Charsets.UTF_8).size > 512 || value.any { it.code < 32 }) {
        return null
    }
    val fields = linkedMapOf<String, String>()
    for (part in value.removePrefix("resp:v1:").split('&')) {
        val eq = part.indexOf('=')
        if (eq <= 0) return null
        val key = part.substring(0, eq)
        val raw = part.substring(eq + 1)
        if (fields.containsKey(key)) return null
        fields[key] = raw
    }
    val responsibilityId = fields["rid"]?.takeIf { NAVIGATION_ID.matches(it) } ?: return null
    val category = fields["act"]?.also { if (!RESPONSIBILITY_TOKEN.matches(it)) return null }.orEmpty()
    val activityType = fields["raw"]?.also { if (!RESPONSIBILITY_TOKEN.matches(it)) return null }.orEmpty()
    val planId = if (fields.containsKey("pid")) {
        fields["pid"]?.takeIf { NAVIGATION_ID.matches(it) } ?: return null
    } else ""
    return ResponsibilityNavigationTarget(
        responsibilityId = responsibilityId,
        category = category,
        activityType = activityType,
        planId = planId,
    )
}

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
