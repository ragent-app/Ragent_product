package com.andysagent.ragent.core.appapi

import androidx.room.*
import java.util.UUID

/** Owner-only consent, separate from task execution so stopping never waits for a network lease. */
@Entity(tableName = "api_background_deliveries",
    indices = [Index(value = ["consentId"], unique = true)],
    foreignKeys = [ForeignKey(entity = ApiOperationEntity::class, parentColumns = ["operationId"],
        childColumns = ["operationId"], onDelete = ForeignKey.RESTRICT)])
data class BackgroundDeliveryConsent(
    @PrimaryKey val operationId: String,
    val consentId: String,
    val callerBinding: String,
    val accountBinding: String,
    val targetInstanceId: String,
    val preparationId: String,
    val originalFingerprint: String,
    val deadlineAt: Long,
    val approvedAt: Long,
    val revision: Long,
    val state: String = AUTHORIZED,
) {
    companion object {
        const val AUTHORIZED = "AUTHORIZED"
        const val REVOKED = "REVOKED"
        const val EXPIRED = "EXPIRED"
        const val FINISHED = "FINISHED"
        const val DISMISSED = "DISMISSED"
    }
}

/** Review snapshot is local data; only the trusted owner consent adapter can approve it. */
data class BackgroundDeliveryReview(val operation: TaskOperation, val context: CallerGrantContext, val revision: Long?)

@Dao
interface BackgroundDeliveryDao {
    @Query("SELECT * FROM api_background_deliveries WHERE operationId = :operationId")
    suspend fun get(operationId: String): BackgroundDeliveryConsent?
    @Query("SELECT * FROM api_background_deliveries WHERE consentId = :consentId")
    suspend fun byConsent(consentId: String): BackgroundDeliveryConsent?
    @Query("SELECT * FROM api_background_deliveries WHERE state != 'DISMISSED' ORDER BY approvedAt DESC LIMIT 257")
    suspend fun list(): List<BackgroundDeliveryConsent>
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(record: BackgroundDeliveryConsent)
    @Update
    suspend fun update(record: BackgroundDeliveryConsent)
    @Query("UPDATE api_background_deliveries SET state = 'REVOKED', revision = revision + 1 WHERE state = 'AUTHORIZED' AND (:targetId IS NULL OR targetInstanceId = :targetId)")
    suspend fun revokeActive(targetId: String?)
    // Retain a non-executable revision tombstone until the parent operation itself is removed.
    @Query("UPDATE api_background_deliveries SET state = 'DISMISSED', revision = revision + 1 WHERE state NOT IN ('AUTHORIZED', 'DISMISSED')")
    suspend fun clearStopped()
}

class RoomBackgroundDeliveryStore(
    private val database: AppApiDatabase,
    private val owner: VerifiedCaller,
    private val currentContext: suspend () -> CallerGrantContext,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val dao get() = database.backgroundDeliveries()
    private val operations = RoomOperationStore(database)

    suspend fun review(operationId: String, caller: VerifiedCaller): BackgroundDeliveryReview {
        requireOwner(caller)
        return database.withTransaction {
            val operation = operation(operationId)
            val context = currentContext().also(::validateGrantContext)
            requireEligible(operation, context)
            BackgroundDeliveryReview(operation, context.copy(pairedTargetIds = context.pairedTargetIds.toSet()), dao.get(operationId)?.revision)
        }
    }

    /** Explicit consent only. Repeating a stale review cannot revive or replace a stopped ticket. */
    suspend fun approve(review: BackgroundDeliveryReview, caller: VerifiedCaller): BackgroundDeliveryConsent {
        requireOwner(caller)
        return database.withTransaction {
            val operation = operation(review.operation.operationId)
            val context = currentContext().also(::validateGrantContext)
            val previous = dao.get(operation.operationId)
            if (operation != review.operation || context != review.context || previous?.revision != review.revision)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Task or authority changed; review background delivery again")
            requireEligible(operation, context)
            if ((previous == null || previous.state == BackgroundDeliveryConsent.DISMISSED) && dao.list().size >= 256)
                apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Clear stopped background delivery history first")
            val record = BackgroundDeliveryConsent(operation.operationId, UUID.randomUUID().toString(), owner.binding,
                context.accountBinding, operation.targetInstanceId, operation.preparationId, operation.originalFingerprint,
                operation.deadlineAt, now(), (previous?.revision ?: -1) + 1)
            if (previous == null) dao.insert(record) else dao.update(record)
            record
        }
    }

    suspend fun list(caller: VerifiedCaller): List<BackgroundDeliveryConsent> {
        requireOwner(caller)
        return database.withTransaction { dao.list().map { refresh(it) } }
    }

    /** Read the current ticket for a frozen operation without creating or renewing consent. */
    suspend fun forOperation(operationId: String, caller: VerifiedCaller): BackgroundDeliveryConsent? {
        requireOwner(caller)
        return database.withTransaction { dao.get(operationId)?.let { refresh(it) } }
    }

    suspend fun requireActive(consentId: String, operation: TaskOperation, caller: VerifiedCaller): BackgroundDeliveryConsent {
        requireOwner(caller)
        // Throw outside the transaction: expiry/revocation must remain durable after rejection.
        val row = database.withTransaction {
            val record = dao.byConsent(consentId) ?: apiFailure(ApiErrorCode.PERMISSION_DENIED, "Background consent is unavailable")
            refresh(record)
        }
        if (row.state != BackgroundDeliveryConsent.AUTHORIZED)
            apiFailure(if (row.state == BackgroundDeliveryConsent.EXPIRED) ApiErrorCode.REQUEST_EXPIRED else ApiErrorCode.PERMISSION_DENIED,
                "Background delivery is no longer authorized")
        if (!matches(row, operation)) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Background operation identity differs")
        return row
    }

    suspend fun load(consentId: String, caller: VerifiedCaller): BackgroundDeliveryConsent {
        requireOwner(caller)
        val row = dao.byConsent(consentId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Background consent not found")
        return requireActive(consentId, operation(row.operationId), caller)
    }

    /** Does not acquire TaskExecutionLease and never claims to cancel an already accepted remote Run. */
    suspend fun revoke(consentId: String, caller: VerifiedCaller) {
        requireOwner(caller)
        database.withTransaction {
            val row = dao.byConsent(consentId) ?: return@withTransaction
            if (row.state == BackgroundDeliveryConsent.AUTHORIZED)
                dao.update(row.copy(state = BackgroundDeliveryConsent.REVOKED, revision = row.revision + 1))
        }
    }

    suspend fun revokeAll(caller: VerifiedCaller, targetId: String? = null) {
        requireOwner(caller)
        database.withTransaction { dao.revokeActive(targetId) }
    }

    suspend fun finish(consentId: String, caller: VerifiedCaller) {
        requireOwner(caller)
        database.withTransaction {
            val row = dao.byConsent(consentId) ?: return@withTransaction
            val operation = operation(row.operationId)
            if (row.state == BackgroundDeliveryConsent.AUTHORIZED && matches(row, operation) &&
                operation.stage in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED))
                dao.update(row.copy(state = BackgroundDeliveryConsent.FINISHED, revision = row.revision + 1))
        }
    }

    suspend fun clearStopped(caller: VerifiedCaller) {
        requireOwner(caller)
        database.withTransaction { dao.list().forEach { refresh(it) }; dao.clearStopped() }
    }

    private suspend fun refresh(row: BackgroundDeliveryConsent): BackgroundDeliveryConsent {
        if (row.state != BackgroundDeliveryConsent.AUTHORIZED) return row
        val context = currentContext().also(::validateGrantContext)
        val saved = operations.get(row.operationId)
        val state = when {
            row.callerBinding != owner.binding || row.accountBinding != context.accountBinding ||
                row.targetInstanceId !in context.pairedTargetIds || saved == null || !matches(row, saved) -> BackgroundDeliveryConsent.REVOKED
            saved.stage in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED) -> BackgroundDeliveryConsent.FINISHED
            now() >= row.deadlineAt -> BackgroundDeliveryConsent.EXPIRED
            else -> row.state
        }
        if (state == row.state) return row
        return row.copy(state = state, revision = row.revision + 1).also { dao.update(it) }
    }

    private fun matches(row: BackgroundDeliveryConsent, operation: TaskOperation): Boolean =
        operation.messageProtocolVersion == 1 && row.operationId == operation.operationId &&
            row.callerBinding == operation.callerBinding && row.targetInstanceId == operation.targetInstanceId &&
            row.preparationId == operation.preparationId && row.originalFingerprint == operation.originalFingerprint &&
            row.deadlineAt == operation.deadlineAt

    private fun requireEligible(operation: TaskOperation, context: CallerGrantContext) {
        if (operation.targetInstanceId !in context.pairedTargetIds) apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Computer is no longer paired")
        if (operation.messageProtocolVersion != 1) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Legacy operation is read-only")
        if (operation.stage in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Task no longer needs background submission")
        if (now() >= operation.deadlineAt) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Original task deadline has passed")
    }
    private suspend fun operation(id: String): TaskOperation = (operations.get(id)
        ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Task not found")).also {
        if (it.callerBinding != owner.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Only owner tasks support this consent")
    }
    private fun requireOwner(caller: VerifiedCaller) {
        if (caller != owner) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Owner consent required")
    }
}

/** Internal execution adapter; construction or loading records never schedules or submits a task. */
class OwnerBackgroundDelivery(
    private val store: RoomBackgroundDeliveryStore,
    private val tasks: TaskCoordinator,
    private val owner: VerifiedCaller,
) {
    suspend fun execute(consentId: String, onUploadProgress: (TaskUploadProgress) -> Unit = {}): TaskOperation {
        val consent = store.load(consentId, owner)
        val result = tasks.commitWithGuard(consent.preparationId, owner, onUploadProgress) {
            store.requireActive(consentId, it, owner)
        }
        store.finish(consentId, owner)
        return result
    }
}
