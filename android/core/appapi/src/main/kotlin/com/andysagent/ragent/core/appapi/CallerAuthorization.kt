package com.andysagent.ragent.core.appapi

/** Supplied by a trusted adapter after platform UID/certificate verification. */
data class VerifiedCaller(val binding: String)

@kotlinx.serialization.Serializable
data class CallerGrant(
    val callerBinding: String,
    val capabilityIds: Set<String>,
    val targetIds: Set<String>,
    val expiresAt: Long,
    val sessionIds: Set<String>? = null,
    val projectIds: Set<String>? = null,
    val mayCreateSessions: Boolean = false,
)

interface CallerAuthorizer {
    suspend fun authorizedTargets(caller: VerifiedCaller, capabilityId: String, targets: List<ApiTarget>): List<ApiTarget>
    suspend fun require(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String?, projectId: String?)
    suspend fun requireSessionCandidate(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String) =
        require(caller, capabilityId, targetId, sessionId, null)
    suspend fun authorizedSessions(caller: VerifiedCaller, capabilityId: String, targetId: String, sessions: List<SessionScope>): List<SessionScope> =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Session scope filtering is unavailable")
    /** Restricted project grants require authoritative PC context, never a caller's assertion. */
    suspend fun requiresProjectVerification(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String?, declaredProjectId: String?): Boolean = true
}

/** The installed owner binding comes from the app graph, never a request parameter. */
class GrantAuthorizer(
    private val ownerBinding: String,
    private val grants: suspend () -> List<CallerGrant>,
    private val now: () -> Long = System::currentTimeMillis,
) : CallerAuthorizer {
    private suspend fun matching(caller: VerifiedCaller, capabilityId: String): List<CallerGrant> = grants().filter {
        it.callerBinding == caller.binding && now() < it.expiresAt && capabilityId in it.capabilityIds
    }

    override suspend fun authorizedTargets(caller: VerifiedCaller, capabilityId: String, targets: List<ApiTarget>): List<ApiTarget> {
        if (caller.binding == ownerBinding) return targets.toList()
        val allowedIds = matching(caller, capabilityId).flatMap { it.targetIds }.toSet()
        return targets.filter { it.instanceId in allowedIds }
    }

    override suspend fun require(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String?, projectId: String?) {
        if (caller.binding == ownerBinding) return
        val allowed = matching(caller, capabilityId).any {
            targetId in it.targetIds &&
                (sessionId?.let { id -> it.sessionIds == null || id in it.sessionIds } ?: it.mayCreateSessions) &&
                (it.projectIds == null || (projectId != null && projectId in it.projectIds))
        }
        if (!allowed) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Caller grant does not permit this operation and resource")
    }

    override suspend fun requireSessionCandidate(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String) {
        if (caller.binding == ownerBinding) return
        if (matching(caller, capabilityId).none { targetId in it.targetIds && (it.sessionIds == null || sessionId in it.sessionIds) })
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Session access is not granted")
    }
    override suspend fun authorizedSessions(caller: VerifiedCaller, capabilityId: String, targetId: String, sessions: List<SessionScope>): List<SessionScope> {
        if (caller.binding == ownerBinding) return sessions.toList()
        val available = matching(caller, capabilityId) // Storage failures propagate; never pretend the list is empty.
        return sessions.filter { resource -> available.any { grant ->
            targetId in grant.targetIds && (grant.sessionIds == null || resource.sessionId in grant.sessionIds) &&
                (grant.projectIds == null || (resource.projectId != null && resource.projectId in grant.projectIds))
        } }
    }

    override suspend fun requiresProjectVerification(caller: VerifiedCaller, capabilityId: String, targetId: String, sessionId: String?, declaredProjectId: String?): Boolean {
        if (caller.binding == ownerBinding) return false
        // Even an unrestricted client must not label a retained result with a false
        // project that could later satisfy a narrower grant.
        if (declaredProjectId != null) return true
        // One grant must satisfy all dimensions. Do not join session/create rights from
        // a restricted record with project rights from an unrelated record.
        return matching(caller, capabilityId).none {
            targetId in it.targetIds && it.projectIds == null &&
                (sessionId?.let { id -> it.sessionIds == null || id in it.sessionIds } ?: it.mayCreateSessions)
        }
    }
}
