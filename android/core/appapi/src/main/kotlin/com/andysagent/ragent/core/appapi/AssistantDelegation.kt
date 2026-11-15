package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.util.UUID

/** All platform-certified AppFunctions callers share this explicitly reviewed trust boundary. */
@Serializable
enum class AssistantCallerGroup { ANDROID_TRUSTED }

/** Owner input only. An assistant request cannot install or extend this delegation. */
@Serializable
data class AssistantDelegationScope(
    val capabilityIds: Set<String>,
    val targetIds: Set<String>,
    val expiresAt: Long,
    val sessionIds: Set<String>? = null,
    val projectIds: Set<String>? = null,
    val mayCreateSessions: Boolean = false,
)

@Serializable
data class AssistantDelegation(
    val id: String,
    val scope: AssistantDelegationScope,
    val accountBinding: String,
    val createdAt: Long,
    val updatedAt: Long,
    val revision: Long = 0,
    val revokedAt: Long? = null,
    val group: AssistantCallerGroup = AssistantCallerGroup.ANDROID_TRUSTED,
    val version: Int = 1,
) {
    // Every new consent has a new operation namespace. Reconsent cannot resurrect old tasks.
    val caller: VerifiedCaller get() = VerifiedCaller("android-appfunctions:trusted:$id")
    fun grant() = CallerGrant(caller.binding, scope.capabilityIds, scope.targetIds, scope.expiresAt,
        scope.sessionIds, scope.projectIds, scope.mayCreateSessions)
}

object AssistantTaskCapabilities {
    val ids: Set<String> = setOf(CapabilityRegistry.TARGETS_LIST, CapabilityRegistry.TASKS_PREPARE,
        CapabilityRegistry.TASKS_COMMIT, CapabilityRegistry.TASKS_GET, CapabilityRegistry.TASKS_RECONCILE,
        CapabilityRegistry.TASKS_CANCEL, CapabilityRegistry.TASKS_RESULT)
}

internal fun validateAssistantDelegation(row: AssistantDelegation) {
    require(row.version == 1 && UUID.fromString(row.id).toString() == row.id)
    require(row.accountBinding.length in 1..256 && row.createdAt >= 0 && row.updatedAt >= row.createdAt)
    require(row.revision >= 0 && (row.revokedAt == null || row.revokedAt in row.createdAt..row.updatedAt))
    require(row.scope.expiresAt > row.createdAt && row.scope.expiresAt - row.createdAt <= CALLER_GRANT_MAX_LIFETIME_MS)
    fun identifiers(ids: Set<String>?, bound: Int) = ids == null ||
        (ids.size <= bound && ids.all { it.isNotBlank() && it.length <= 256 && it.none(Char::isISOControl) &&
            Charsets.UTF_8.newEncoder().canEncode(it) })
    require(row.scope.capabilityIds.isNotEmpty() && identifiers(row.scope.capabilityIds, 128))
    require(AssistantTaskCapabilities.ids.containsAll(row.scope.capabilityIds))
    require(row.scope.targetIds.isNotEmpty() && identifiers(row.scope.targetIds, 256))
    require(identifiers(row.scope.sessionIds, 256) && identifiers(row.scope.projectIds, 256))
    // An empty restriction is no access, never an alias for unrestricted access.
    require(row.scope.sessionIds == null || row.scope.sessionIds.isNotEmpty())
    require(row.scope.projectIds == null || row.scope.projectIds.isNotEmpty())
    require(AppApiJson.encodeToString(row).toByteArray(Charsets.UTF_8).size <= 128 * 1024)
}

/** A trusted AppFunctions adapter uses this only after platform access-level enforcement. */
interface AssistantDelegationAccess {
    suspend fun activeDelegations(): List<AssistantDelegation>
    suspend fun requireActive(id: String): AssistantDelegation
}
