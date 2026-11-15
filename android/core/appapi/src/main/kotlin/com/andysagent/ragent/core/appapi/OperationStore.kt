package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.io.File

interface OperationStore {
    suspend fun get(operationId: String): TaskOperation?
    suspend fun getByPreparation(preparationId: String): TaskOperation?
    suspend fun insert(operation: TaskOperation): Boolean
    suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean
}

@Entity(tableName = "api_operations", indices = [Index(value = ["preparationId"], unique = true)])
data class ApiOperationEntity(
    @PrimaryKey val operationId: String,
    val preparationId: String,
    val callerBinding: String,
    val revision: Long,
    val payload: String,
)

@Dao
interface ApiOperationDao {
    @Query("SELECT * FROM api_operations WHERE operationId = :operationId")
    suspend fun get(operationId: String): ApiOperationEntity?
    @Query("SELECT * FROM api_operations WHERE preparationId = :preparationId")
    suspend fun getByPreparation(preparationId: String): ApiOperationEntity?
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: ApiOperationEntity): Long
    @Query("UPDATE api_operations SET payload = :payload, revision = :revision WHERE operationId = :operationId AND preparationId = :preparationId AND callerBinding = :callerBinding AND revision = :expectedRevision")
    suspend fun replace(operationId: String, preparationId: String, callerBinding: String, payload: String, revision: Long, expectedRevision: Long): Int
}

/** Phone-wide journal, deliberately separate from each target's pending queue/database. */
@Database(entities = [ApiOperationEntity::class, CaptureDraftEntity::class, CaptureResourceEntity::class,
    CaptureResourceBindingEntity::class, ResultOutputEntity::class, CallerGrantEntity::class,
    SessionMutationEntity::class, BackgroundDeliveryConsent::class], version = 7, exportSchema = true)
abstract class AppApiDatabase : RoomDatabase() {
    abstract fun operations(): ApiOperationDao
    abstract fun drafts(): CaptureDraftDao
    abstract fun resources(): CaptureResourceDao
    abstract fun outputs(): ResultOutputDao
    abstract fun callerGrants(): CallerGrantDao
    abstract fun sessionMutations(): SessionMutationDao
    abstract fun backgroundDeliveries(): BackgroundDeliveryDao
    companion object {
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `capture_drafts` (`draftId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `revision` INTEGER NOT NULL, `operationId` TEXT, `preparationId` TEXT, `payload` TEXT NOT NULL, PRIMARY KEY(`draftId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_capture_drafts_callerBinding_updatedAt` ON `capture_drafts` (`callerBinding`, `updatedAt`)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_capture_drafts_operationId` ON `capture_drafts` (`operationId`)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_capture_drafts_preparationId` ON `capture_drafts` (`preparationId`)")
            }
        }
        val MIGRATION_2_3: Migration = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `capture_resources` (`resourceId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, `state` TEXT NOT NULL, `revision` INTEGER NOT NULL, `payload` TEXT NOT NULL, PRIMARY KEY(`resourceId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_capture_resources_callerBinding_state` ON `capture_resources` (`callerBinding`, `state`)")
                db.execSQL("CREATE TABLE IF NOT EXISTS `capture_resource_bindings` (`bindingId` TEXT NOT NULL, `resourceId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, PRIMARY KEY(`bindingId`, `resourceId`), FOREIGN KEY(`resourceId`) REFERENCES `capture_resources`(`resourceId`) ON UPDATE NO ACTION ON DELETE RESTRICT)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_capture_resource_bindings_resourceId` ON `capture_resource_bindings` (`resourceId`)")
            }
        }
        val MIGRATION_3_4: Migration = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `result_outputs` (`downloadId` TEXT NOT NULL, `operationId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, `state` TEXT NOT NULL, `revision` INTEGER NOT NULL, `reservedBytes` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `payload` TEXT NOT NULL, PRIMARY KEY(`downloadId`), FOREIGN KEY(`operationId`) REFERENCES `api_operations`(`operationId`) ON UPDATE NO ACTION ON DELETE RESTRICT)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_result_outputs_operationId` ON `result_outputs` (`operationId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_result_outputs_callerBinding_state_updatedAt` ON `result_outputs` (`callerBinding`, `state`, `updatedAt`)")
            }
        }
        val MIGRATION_4_5: Migration = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `api_caller_grants` (`grantId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, `revision` INTEGER NOT NULL, `revoked` INTEGER NOT NULL, `expiresAt` INTEGER NOT NULL, `payload` TEXT NOT NULL, PRIMARY KEY(`grantId`))")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_api_caller_grants_callerBinding_revoked_expiresAt` ON `api_caller_grants` (`callerBinding`, `revoked`, `expiresAt`)")
            }
        }
        val MIGRATION_5_6: Migration = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `api_session_mutations` (`callerBinding` TEXT NOT NULL, `operationId` TEXT NOT NULL, `requestId` TEXT NOT NULL, `revision` INTEGER NOT NULL, `payload` TEXT NOT NULL, PRIMARY KEY(`callerBinding`, `operationId`))")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_api_session_mutations_requestId` ON `api_session_mutations` (`requestId`)")
            }
        }
        val MIGRATION_6_7: Migration = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("CREATE TABLE IF NOT EXISTS `api_background_deliveries` (`operationId` TEXT NOT NULL, `consentId` TEXT NOT NULL, `callerBinding` TEXT NOT NULL, `accountBinding` TEXT NOT NULL, `targetInstanceId` TEXT NOT NULL, `preparationId` TEXT NOT NULL, `originalFingerprint` TEXT NOT NULL, `deadlineAt` INTEGER NOT NULL, `approvedAt` INTEGER NOT NULL, `revision` INTEGER NOT NULL, `state` TEXT NOT NULL, PRIMARY KEY(`operationId`), FOREIGN KEY(`operationId`) REFERENCES `api_operations`(`operationId`) ON UPDATE NO ACTION ON DELETE RESTRICT)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_api_background_deliveries_consentId` ON `api_background_deliveries` (`consentId`)")
            }
        }
        fun open(context: Context): AppApiDatabase = Room.databaseBuilder(
            context.applicationContext, AppApiDatabase::class.java,
            File(context.noBackupFilesDir, "ragent-app-api.db").absolutePath,
        ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7).build()
    }
}

class RoomOperationStore(private val dao: ApiOperationDao, private val database: AppApiDatabase? = null) : OperationStore {
    constructor(database: AppApiDatabase) : this(database.operations(), database)
    override suspend fun get(operationId: String): TaskOperation? = dao.get(operationId)?.decode()
    override suspend fun getByPreparation(preparationId: String): TaskOperation? = dao.getByPreparation(preparationId)?.decode()
    override suspend fun insert(operation: TaskOperation): Boolean {
        operation.validateMessageJournal()
        if (operation.request.resources.isEmpty()) return dao.insert(operation.entity()) != -1L
        val db = database ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Atomic resource storage is required")
        return db.withTransaction {
            if (dao.insert(operation.entity()) == -1L) return@withTransaction false
            db.resources().pinAll("operation:${operation.operationId}", operation.callerBinding, operation.request.resources)
            true
        }
    }
    override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
        require(operation.revision == expectedRevision + 1) { "Journal revision must advance exactly once" }
        val previous = dao.get(operation.operationId)?.decode() ?: return false
        if (previous.revision != expectedRevision) return false
        validateTaskTransition(previous, operation)
        return dao.replace(operation.operationId, operation.preparationId, operation.callerBinding,
            AppApiJson.encodeToString(operation), operation.revision, expectedRevision) == 1
    }
    private fun ApiOperationEntity.decode(): TaskOperation = AppApiJson.decodeFromString<TaskOperation>(payload).also {
        check(it.operationId == operationId && it.preparationId == preparationId && it.callerBinding == callerBinding && it.revision == revision) {
            "Journal row identity is inconsistent"
        }
        it.validateMessageJournal()
    }
    private fun TaskOperation.entity() = ApiOperationEntity(operationId, preparationId, callerBinding, revision, AppApiJson.encodeToString(this))
}
