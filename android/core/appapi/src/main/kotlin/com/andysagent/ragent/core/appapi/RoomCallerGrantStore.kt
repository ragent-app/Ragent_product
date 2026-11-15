package com.andysagent.ragent.core.appapi

import androidx.room.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.UUID

@Entity(tableName = "api_caller_grants", indices = [Index(value = ["callerBinding", "revoked", "expiresAt"])])
data class CallerGrantEntity(
    @PrimaryKey val grantId: String,
    val callerBinding: String,
    val revision: Long,
    val revoked: Boolean,
    val expiresAt: Long,
    val payload: String,
)

@Dao
interface CallerGrantDao {
    @Query("SELECT * FROM api_caller_grants ORDER BY grantId LIMIT 257")
    suspend fun list(): List<CallerGrantEntity>
    @Query("SELECT * FROM api_caller_grants WHERE grantId = :id")
    suspend fun get(id: String): CallerGrantEntity?
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: CallerGrantEntity)
    @Query("UPDATE api_caller_grants SET revision = :revision, revoked = :revoked, payload = :payload WHERE grantId = :id AND callerBinding = :binding AND revision = :expectedRevision")
    suspend fun replace(id: String, binding: String, revision: Long, revoked: Boolean, payload: String, expectedRevision: Long): Int
    @Query("DELETE FROM api_caller_grants WHERE grantId = :id AND revoked = 1 AND revision = :revision")
    suspend fun deleteRevoked(id: String, revision: Long): Int
    @Query("UPDATE api_caller_grants SET revoked = 1 WHERE revoked = 0")
    suspend fun disableAll(): Int
}

/** Owner management only. Each execution reads fresh persisted state and reattests installations. */
class RoomCallerGrantStore(
    private val database: AppApiDatabase,
    private val owner: VerifiedCaller,
    private val currentContext: suspend () -> CallerGrantContext,
    private val identityIsCurrent: suspend (InstalledCallerIdentity) -> Boolean,
    private val registry: CapabilityRegistry = CapabilityRegistry(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val dao get() = database.callerGrants()
    private fun requireOwner(caller: VerifiedCaller) {
        if (caller != owner) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Only the phone owner can manage caller grants")
    }
    private suspend fun records(): List<PersistedCallerGrant> = dao.list().also {
        if (it.size > 256) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Caller grant storage exceeds its bound")
    }.map { it.decode() }
    private fun CallerGrantEntity.decode(): PersistedCallerGrant = try {
        AppApiJson.decodeFromString<PersistedCallerGrant>(payload).also {
            validateGrantRecord(it)
            check(it.grantId == grantId && it.grant.callerBinding == callerBinding && it.revision == revision &&
                (it.revokedAt != null) == revoked && it.grant.expiresAt == expiresAt)
        }
    } catch (_: Exception) { apiFailure(ApiErrorCode.PERMISSION_DENIED, "Caller grant storage is inconsistent") }
    private fun PersistedCallerGrant.entity() = CallerGrantEntity(grantId, grant.callerBinding, revision,
        revokedAt != null, grant.expiresAt, AppApiJson.encodeToString(this))
    private suspend fun revoke(row: PersistedCallerGrant): PersistedCallerGrant {
        if (row.revokedAt != null) return row
        val time = maxOf(now(), row.updatedAt)
        val next = row.copy(revision = row.revision + 1, revokedAt = time, updatedAt = time)
        if (dao.replace(row.grantId, row.grant.callerBinding, next.revision, true, AppApiJson.encodeToString(next), row.revision) != 1)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Caller grant changed concurrently")
        return next
    }
    private suspend fun revalidated(): List<PersistedCallerGrant> {
        val context = currentContext().also(::validateGrantContext)
        return records().map { row ->
            if (row.revokedAt == null && (row.accountBinding != context.accountBinding ||
                    !context.pairedTargetIds.containsAll(row.grant.targetIds) || now() >= row.grant.expiresAt ||
                    !identityIsCurrent(row.identity))) revoke(row) else row
        }
    }
    suspend fun activeGrants(): List<CallerGrant> = database.withTransaction {
        revalidated().filter { it.revokedAt == null }.map { it.grant }
    }
    suspend fun list(caller: VerifiedCaller): List<PersistedCallerGrant> {
        requireOwner(caller)
        return database.withTransaction { revalidated() }
    }
    /** Only an actual owner consent adapter may call this; a prepare token is not consent. */
    suspend fun reviewContext(caller: VerifiedCaller): CallerGrantContext {
        requireOwner(caller)
        return currentContext().also(::validateGrantContext).let { it.copy(pairedTargetIds = it.pairedTargetIds.toSet()) }
    }
    suspend fun approve(caller: VerifiedCaller, identity: InstalledCallerIdentity, grant: CallerGrant,
        expectedContext: CallerGrantContext? = null): PersistedCallerGrant {
        requireOwner(caller)
        val pinnedIdentity = identity.copy(currentSignerSha256 = identity.currentSignerSha256.toSet())
        val scope = grant.copy(capabilityIds = grant.capabilityIds.toSet(), targetIds = grant.targetIds.toSet(),
            sessionIds = grant.sessionIds?.toSet(), projectIds = grant.projectIds?.toSet())
        return database.withTransaction {
            val context = currentContext().also(::validateGrantContext)
            if (expectedContext != null && expectedContext != context)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Account or pairing changed; review the request again")
            val time = now()
            val row = PersistedCallerGrant(UUID.randomUUID().toString(), pinnedIdentity, scope, context.accountBinding, time, time)
            try { validateGrantRecord(row) } catch (_: IllegalArgumentException) {
                apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Caller grant scope or lifetime is invalid")
            }
            scope.capabilityIds.forEach(registry::requireImplemented)
            if (!context.pairedTargetIds.containsAll(scope.targetIds) || !identityIsCurrent(pinnedIdentity))
                apiFailure(ApiErrorCode.PERMISSION_DENIED, "Caller installation or paired target changed")
            if (records().size >= 256) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Clear revoked caller grant history before adding more")
            dao.insert(row.entity()); row
        }
    }
    suspend fun revoke(caller: VerifiedCaller, id: String, expectedRevision: Long): PersistedCallerGrant {
        requireOwner(caller)
        return database.withTransaction {
            val row = dao.get(id)?.decode() ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Caller grant not found")
            if (row.revision != expectedRevision) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Caller grant changed; refresh before revoking")
            revoke(row)
        }
    }
    /** Durable before unpair/logout, so re-pair or login cannot revive the old grant. */
    suspend fun revokeForTarget(caller: VerifiedCaller, targetId: String) {
        requireOwner(caller)
        database.withTransaction { revokeEvenWhenInconsistent { targetId in it.grant.targetIds } }
    }
    suspend fun revokeAll(caller: VerifiedCaller) {
        requireOwner(caller)
        database.withTransaction { revokeEvenWhenInconsistent { true } }
    }
    private suspend fun revokeEvenWhenInconsistent(matches: (PersistedCallerGrant) -> Boolean) {
        val rows = try { records() } catch (error: AppApiException) {
            if (error.error.code !in setOf(ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.RESOURCE_LIMIT)) throw error
            // Preserve the corrupt payload for diagnosis; never convert it to healthy empty storage.
            // Owner unpair/logout must still disable every grant before changing local authority.
            dao.disableAll(); return
        }
        rows.filter(matches).forEach { revoke(it) }
    }
    suspend fun deleteRevoked(caller: VerifiedCaller, id: String, expectedRevision: Long): Boolean {
        requireOwner(caller)
        return dao.deleteRevoked(id, expectedRevision) == 1
    }
}
