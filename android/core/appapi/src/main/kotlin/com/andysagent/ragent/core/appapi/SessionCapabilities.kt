package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.SessionMetadataSnapshot
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.domain.SessionRepositoryException
import com.andysagent.ragent.core.domain.SwitchingSessionRepository
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** Contribution of implemented read handlers; mutations have their own durable delivery gate. */
object SessionCapabilities {
    const val LIST = "ragent.sessions.list"
    const val SEARCH = "ragent.sessions.search"
    const val GET = "ragent.sessions.get"
    val descriptors = listOf(
        CapabilityDescriptor(LIST, description = "List authorized Session metadata on one exact computer", mutates = false, targetRequired = true, implemented = true),
        CapabilityDescriptor(SEARCH, description = "Search authorized Session titles and identities on one exact computer", mutates = false, targetRequired = true, implemented = true),
        CapabilityDescriptor(GET, description = "Read fresh authorized Session metadata without history or filesystem paths", mutates = false, targetRequired = true, implemented = true),
    )
}

data class SessionScope(val sessionId: String, val projectId: String?)

@Serializable
data class SessionApiItem(val targetInstanceId: String, val sessionId: String, val title: String,
    val projectId: String?, val state: String, val updatedAt: String?, val titleTruncated: Boolean)

data class SessionQuery(val targetInstanceId: String, val limit: Int = 16, val cursor: String? = null,
    val query: String? = null, val projectId: String? = null) {
    fun validate(search: Boolean) {
        requireApiIdentifier(targetInstanceId)
        projectId?.let(::requireApiIdentifier)
        if (limit !in 1..32 || (cursor != null && !Regex("[a-f0-9]{64}:[0-9]{1,5}").matches(cursor)))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid Session page")
        if (search) {
            if (query.isNullOrBlank() || query.length > 256 || query.any(Char::isISOControl))
                apiFailure(ApiErrorCode.INVALID_ARGUMENT, "A bounded search query is required")
        } else if (query != null) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "List does not accept search text")
    }
}

data class SessionApiPage(val items: List<SessionApiItem>, val nextCursor: String?, val observedAt: Long, val revision: String)

interface SessionReadTarget {
    suspend fun list(): List<SessionMetadataSnapshot>
    suspend fun get(sessionId: String): SessionMetadataSnapshot?
}
interface TargetSessionAccess {
    suspend fun <T> withTarget(instanceId: String, block: suspend (SessionReadTarget) -> T): T
}
class RepositorySessionReadTarget(private val repository: SessionRepository) : SessionReadTarget {
    init { require(repository !is SwitchingSessionRepository) { "Session API requires a fixed repository" } }
    private suspend fun <T> read(block: suspend () -> T): T = try { block() }
    catch (error: SessionRepositoryException) {
        val code = when (error.statusCode) {
            401 -> ApiErrorCode.AUTHENTICATION_REQUIRED
            403 -> ApiErrorCode.PERMISSION_DENIED
            404 -> ApiErrorCode.RESOURCE_NOT_FOUND
            413 -> ApiErrorCode.RESOURCE_LIMIT
            501 -> ApiErrorCode.CAPABILITY_UNSUPPORTED
            502 -> ApiErrorCode.RESULT_UNKNOWN
            else -> if (error.retryable) ApiErrorCode.TARGET_OFFLINE else ApiErrorCode.INTERNAL_ERROR
        }
        throw AppApiException(ApiError(code, "Session metadata cannot be read", error.retryable))
    } catch (_: kotlinx.serialization.SerializationException) {
        apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Invalid Session response")
    }
    override suspend fun list() = read { repository.readSessionMetadataList() }
    override suspend fun get(sessionId: String) = read { repository.readSessionMetadata(sessionId) }
}

/** Read-only and cache independent. A list grant never implies creation or unrestricted detail access. */
class SessionApiCoordinator(
    private val directory: suspend () -> TargetDirectorySnapshot,
    private val authorizer: CallerAuthorizer,
    private val access: TargetSessionAccess,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private suspend fun requireTarget(caller: VerifiedCaller, capability: String, target: String) {
        val paired = directory().targets.singleOrNull { it.instanceId == target }
            ?: apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Computer is not paired")
        if (authorizer.authorizedTargets(caller, capability, listOf(paired)).isEmpty())
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Session access is not granted")
    }

    suspend fun checkAccess(caller: VerifiedCaller, capability: String, target: String, items: List<SessionApiItem>) {
        requireTarget(caller, capability, target)
        val scopes = items.map { SessionScope(it.sessionId, it.projectId) }
        if (authorizer.authorizedSessions(caller, capability, target, scopes).toSet() != scopes.toSet())
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Session access changed")
        requireTarget(caller, capability, target)
    }

    suspend fun list(request: SessionQuery, caller: VerifiedCaller, search: Boolean = false): SessionApiPage {
        request.validate(search)
        val capability = if (search) SessionCapabilities.SEARCH else SessionCapabilities.LIST
        requireTarget(caller, capability, request.targetInstanceId)
        val rows = access.withTarget(request.targetInstanceId) { target ->
            requireTarget(caller, capability, request.targetInstanceId)
            target.list()
        }
        if (rows.size > MAX_SNAPSHOT_ITEMS || rows.map { it.sessionId }.toSet().size != rows.size)
            apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Session snapshot is oversized or ambiguous")
        requireTarget(caller, capability, request.targetInstanceId)
        val scopes = authorizer.authorizedSessions(caller, capability, request.targetInstanceId,
            rows.map { SessionScope(it.sessionId, it.projectId) }).toSet()
        val items = rows.filter { SessionScope(it.sessionId, it.projectId) in scopes }
            .filter { request.projectId == null || it.projectId == request.projectId }
            .filter { !search || it.title.contains(request.query!!.trim(), ignoreCase = true) ||
                it.sessionId.contains(request.query.trim(), ignoreCase = true) }
            .sortedBy { it.sessionId }.map { it.project(request.targetInstanceId) }
        // The cursor contains no caller identity. It binds the exact authorized projection,
        // computer, query and capability; fresh grants are read on every continuation.
        val revision = MessageDigest.getInstance("SHA-256").digest(AppApiJson.encodeToString(
            listOf(caller.binding, capability, request.targetInstanceId, request.query.orEmpty(),
                request.projectId.orEmpty(), AppApiJson.encodeToString(items))).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        val offset = request.cursor?.let {
            val parts = it.split(':')
            if (parts.size != 2 || !Regex("[a-f0-9]{64}").matches(parts[0]) || !Regex("[0-9]{1,5}").matches(parts[1]))
                apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid Session cursor")
            if (parts[0] != revision) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session projection changed; refresh")
            parts[1].toInt().also { value ->
                if (value !in 0..items.size) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session cursor no longer applies")
            }
        } ?: 0
        val end = minOf(offset + request.limit, items.size)
        val page = items.subList(offset, end).toList()
        checkAccess(caller, capability, request.targetInstanceId, page)
        return SessionApiPage(page, if (end < items.size) "$revision:$end" else null, now(), revision)
    }

    suspend fun get(targetInstanceId: String, sessionId: String, caller: VerifiedCaller): SessionApiItem {
        requireApiIdentifier(targetInstanceId); requireApiIdentifier(sessionId)
        requireTarget(caller, SessionCapabilities.GET, targetInstanceId)
        authorizer.requireSessionCandidate(caller, SessionCapabilities.GET, targetInstanceId, sessionId)
        val row = access.withTarget(targetInstanceId) { target ->
            requireTarget(caller, SessionCapabilities.GET, targetInstanceId)
            authorizer.requireSessionCandidate(caller, SessionCapabilities.GET, targetInstanceId, sessionId)
            target.get(sessionId)
        } ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Session is unavailable")
        if (row.sessionId != sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Session response identity differs")
        val item = row.project(targetInstanceId)
        checkAccess(caller, SessionCapabilities.GET, targetInstanceId, listOf(item))
        return item
    }

    private fun SessionMetadataSnapshot.project(target: String): SessionApiItem {
        requireApiIdentifier(sessionId); projectId?.let(::requireApiIdentifier)
        val timestamp = updatedAt
        if (state.length > 64 || state.any(Char::isISOControl) || (timestamp != null && timestamp.length > 64))
            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Invalid Session metadata")
        val bounded = title.take(512).let { if (it.lastOrNull()?.isHighSurrogate() == true) it.dropLast(1) else it }
        return SessionApiItem(target, sessionId, bounded, projectId, state, timestamp, title.length > bounded.length)
    }
    companion object { const val MAX_SNAPSHOT_ITEMS = 2048 }
}

private fun requireApiIdentifier(value: String) {
    if (value.isBlank() || value.length > 256 || value.any(Char::isISOControl))
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid Session identity")
}
