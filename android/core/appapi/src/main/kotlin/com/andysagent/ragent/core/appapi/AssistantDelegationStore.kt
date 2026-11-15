package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.util.UUID

@Entity(tableName = "assistant_delegations")
data class AssistantDelegationEntity(
    @PrimaryKey val id: String,
    val revision: Long,
    val revoked: Boolean,
    val payload: String,
)

@Dao
interface AssistantDelegationDao {
    @Query("SELECT * FROM assistant_delegations ORDER BY id LIMIT 65")
    suspend fun list(): List<AssistantDelegationEntity>
    @Query("SELECT * FROM assistant_delegations WHERE id = :id")
    suspend fun get(id: String): AssistantDelegationEntity?
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(row: AssistantDelegationEntity)
    @Query("UPDATE assistant_delegations SET revision = :revision, revoked = :revoked, payload = :payload WHERE id = :id AND revision = :expectedRevision")
    suspend fun replace(id: String, revision: Long, revoked: Boolean, payload: String, expectedRevision: Long): Int
    @Query("UPDATE assistant_delegations SET revoked = 1 WHERE revoked = 0")
    suspend fun disableAll(): Int
    @Query("DELETE FROM assistant_delegations WHERE id = :id AND revoked = 1 AND revision = :revision")
    suspend fun deleteRevoked(id: String, revision: Long): Int
}

/** Independent policy database: no App API journal migration or task resurrection. */
@Database(entities = [AssistantDelegationEntity::class], version = 1, exportSchema = true)
abstract class AssistantDelegationDatabase : RoomDatabase() {
    abstract fun delegations(): AssistantDelegationDao
    companion object {
        fun open(context: Context): AssistantDelegationDatabase = Room.databaseBuilder(
            context.applicationContext, AssistantDelegationDatabase::class.java, "ragent-assistant-delegations.db").build()
    }
}

/** Default empty. Only the internal owner consent surface can create a bounded delegation. */
class RoomAssistantDelegationStore(
    private val database: AssistantDelegationDatabase,
    private val owner: VerifiedCaller,
    private val currentContext: suspend () -> CallerGrantContext,
    private val registry: CapabilityRegistry = CapabilityRegistry(),
    private val now: () -> Long = System::currentTimeMillis,
) : AssistantDelegationAccess {
    private val dao get() = database.delegations()
    private fun requireOwner(caller: VerifiedCaller) {
        if (caller != owner) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Only the phone owner can manage assistant delegation")
    }
    private fun AssistantDelegationEntity.decode(): AssistantDelegation = try {
        require(payload.toByteArray(Charsets.UTF_8).size <= 128 * 1024)
        AppApiJson.decodeFromString<AssistantDelegation>(payload).also {
            validateAssistantDelegation(it)
            check(it.id == id && it.revision == revision && (it.revokedAt != null) == revoked)
        }
    } catch (_: Exception) { apiFailure(ApiErrorCode.PERMISSION_DENIED, "Assistant delegation storage is inconsistent") }
    private fun AssistantDelegation.entity() = AssistantDelegationEntity(id, revision, revokedAt != null, AppApiJson.encodeToString(this))
    private suspend fun records() = dao.list().also {
        if (it.size > 64) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Clear revoked assistant delegation history")
    }.map { it.decode() }
    private suspend fun revoke(row: AssistantDelegation): AssistantDelegation {
        if (row.revokedAt != null) return row
        val time = maxOf(now(), row.updatedAt)
        val next = row.copy(revision = row.revision + 1, revokedAt = time, updatedAt = time)
        if (dao.replace(row.id, next.revision, true, AppApiJson.encodeToString(next), row.revision) != 1)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Assistant delegation changed; refresh before acting")
        return next
    }
    private suspend fun revalidated(): List<AssistantDelegation> {
        val context = currentContext().also(::validateGrantContext)
        return records().map { row ->
            if (row.revokedAt == null && (row.accountBinding != context.accountBinding ||
                !context.pairedTargetIds.containsAll(row.scope.targetIds) || now() >= row.scope.expiresAt)) revoke(row) else row
        }
    }
    override suspend fun activeDelegations(): List<AssistantDelegation> = database.withTransaction {
        revalidated().filter { it.revokedAt == null }
    }
    override suspend fun requireActive(id: String): AssistantDelegation = database.withTransaction {
        // Revalidate all records so malformed/corrupt state never becomes an empty successful policy.
        revalidated().firstOrNull { it.id == id && it.revokedAt == null }
            ?: apiFailure(ApiErrorCode.PERMISSION_DENIED, "Assistant delegation is absent, expired or revoked")
    }
    suspend fun list(caller: VerifiedCaller): List<AssistantDelegation> {
        requireOwner(caller); return database.withTransaction { revalidated() }
    }
    suspend fun reviewContext(caller: VerifiedCaller): CallerGrantContext {
        requireOwner(caller)
        return currentContext().also(::validateGrantContext).let { it.copy(pairedTargetIds = it.pairedTargetIds.toSet()) }
    }
    /** The reviewed account/pairing snapshot is mandatory. Rotation/reopening is not consent. */
    suspend fun approve(caller: VerifiedCaller, scope: AssistantDelegationScope, expectedContext: CallerGrantContext): AssistantDelegation {
        requireOwner(caller)
        val frozen = AppApiJson.decodeFromString<AssistantDelegationScope>(AppApiJson.encodeToString(scope))
        return database.withTransaction {
            val context = currentContext().also(::validateGrantContext)
            if (expectedContext != context) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Account or pairing changed; review assistant delegation again")
            val time = now()
            val row = AssistantDelegation(UUID.randomUUID().toString(), frozen, context.accountBinding, time, time)
            try { validateAssistantDelegation(row) } catch (_: IllegalArgumentException) {
                apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Assistant delegation scope or lifetime is invalid")
            }
            frozen.capabilityIds.forEach(registry::requireImplemented)
            if (!context.pairedTargetIds.containsAll(frozen.targetIds))
                apiFailure(ApiErrorCode.PERMISSION_DENIED, "Selected computer is no longer paired")
            if (records().size >= 64) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Clear revoked assistant delegation history")
            dao.insert(row.entity()); row
        }
    }
    suspend fun revoke(caller: VerifiedCaller, id: String, expectedRevision: Long): AssistantDelegation {
        requireOwner(caller)
        return database.withTransaction {
            val row = dao.get(id)?.decode() ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Assistant delegation not found")
            if (row.revision != expectedRevision) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Assistant delegation changed; refresh before revoking")
            revoke(row)
        }
    }
    suspend fun revokeForTarget(caller: VerifiedCaller, targetId: String) {
        requireOwner(caller); database.withTransaction { revokeEvenWhenInconsistent { targetId in it.scope.targetIds } }
    }
    suspend fun revokeAll(caller: VerifiedCaller) {
        requireOwner(caller); database.withTransaction { revokeEvenWhenInconsistent { true } }
    }
    private suspend fun revokeEvenWhenInconsistent(matches: (AssistantDelegation) -> Boolean) {
        val rows = try { records() } catch (failure: AppApiException) {
            if (failure.error.code !in setOf(ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.RESOURCE_LIMIT)) throw failure
            dao.disableAll(); return
        }
        rows.filter(matches).forEach { revoke(it) }
    }
    suspend fun deleteRevoked(caller: VerifiedCaller, id: String, expectedRevision: Long): Boolean {
        requireOwner(caller); return dao.deleteRevoked(id, expectedRevision) == 1
    }
}
