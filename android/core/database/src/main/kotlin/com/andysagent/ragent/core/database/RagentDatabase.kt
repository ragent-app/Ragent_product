package com.andysagent.ragent.core.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ComputerEntity::class,
        ProjectEntity::class,
        SessionEntity::class,
        MessageEntity::class,
        TimelineMessageStagingEntity::class,
        RunDurationEntity::class,
        ApprovalEntity::class,
        PendingOperationEntity::class,
        SyncCursorEntity::class,
        SessionEventEntity::class,
        TargetRuntimeSummaryEntity::class,
        TargetRuntimeSummaryEventEntity::class,
        TargetRuntimeSummaryCursorEntity::class,
    ],
    version = 17,
    exportSchema = true,
)
abstract class RagentDatabase : RoomDatabase() {
    abstract fun dao(): RagentDao

    companion object {
        val MIGRATION_16_17: Migration = object : Migration(16, 17) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE messages ADD COLUMN metadataJson TEXT")
                database.execSQL("ALTER TABLE timeline_message_staging ADD COLUMN metadataJson TEXT")
            }
        }
        val MIGRATION_15_16: Migration = object : Migration(15, 16) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS run_durations (sessionId TEXT NOT NULL, runId TEXT NOT NULL, durationMs INTEGER NOT NULL, PRIMARY KEY(sessionId, runId))")
            }
        }
        val MIGRATION_14_15: Migration = object : Migration(14, 15) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE messages ADD COLUMN messagePhase TEXT")
                database.execSQL("ALTER TABLE timeline_message_staging ADD COLUMN messagePhase TEXT")
            }
        }
        val MIGRATION_13_14: Migration = object : Migration(13, 14) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
                database.execSQL("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            }
        }
        val MIGRATION_12_13: Migration = object : Migration(12, 13) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE messages ADD COLUMN lastEventSeq INTEGER NOT NULL DEFAULT 0")
                database.execSQL("ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
                database.execSQL("ALTER TABLE messages ADD COLUMN messageState TEXT NOT NULL DEFAULT 'completed'")
                database.execSQL("UPDATE messages SET lastEventSeq = COALESCE(seq, 0), messageState = CASE WHEN completed = 1 THEN 'completed' ELSE 'streaming' END")
                database.execSQL("ALTER TABLE sessions ADD COLUMN timelineProjectionVersion INTEGER NOT NULL DEFAULT 0")
                database.execSQL("""CREATE TABLE IF NOT EXISTS timeline_message_staging (
                    sessionId TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
                    seq INTEGER NOT NULL, lastEventSeq INTEGER NOT NULL, revision INTEGER NOT NULL,
                    messageState TEXT NOT NULL, requestId TEXT, runId TEXT, PRIMARY KEY(sessionId, id)
                )""".trimIndent())
            }
        }
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sessions ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0")
            }
        }

        val MIGRATION_2_3: Migration = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE pending_operations ADD COLUMN path TEXT NOT NULL DEFAULT ''")
            }
        }

        val MIGRATION_3_4: Migration = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE approvals ADD COLUMN runId TEXT")
                database.execSQL("ALTER TABLE approvals ADD COLUMN batchId TEXT")
                database.execSQL("ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval'")
            }
        }

        val MIGRATION_4_5: Migration = object : Migration(4, 5) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE approvals ADD COLUMN detailsJson TEXT")
                database.execSQL("ALTER TABLE approvals ADD COLUMN reason TEXT")
                database.execSQL("ALTER TABLE approvals ADD COLUMN saferAlternative TEXT")
                database.execSQL("ALTER TABLE approvals ADD COLUMN approveLabel TEXT NOT NULL DEFAULT 'Approve'")
                database.execSQL("ALTER TABLE approvals ADD COLUMN denyLabel TEXT NOT NULL DEFAULT 'Deny'")
            }
        }

        val MIGRATION_5_6: Migration = object : Migration(5, 6) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sync_cursors ADD COLUMN lastServerCursor TEXT")
                database.execSQL("ALTER TABLE sync_cursors ADD COLUMN lastSnapshotVersion INTEGER")
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS session_events (
                        eventId TEXT NOT NULL PRIMARY KEY,
                        sessionId TEXT NOT NULL,
                        seq INTEGER NOT NULL,
                        entityId TEXT,
                        revision INTEGER,
                        clientId TEXT,
                        type TEXT,
                        fingerprint TEXT NOT NULL,
                        appliedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
                database.execSQL("CREATE INDEX IF NOT EXISTS index_session_events_sessionId_seq ON session_events(sessionId, seq)")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_session_events_sessionId_entityId ON session_events(sessionId, entityId)")
            }
        }

        val MIGRATION_6_7: Migration = object : Migration(6, 7) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sessions ADD COLUMN lastAssistantMessageAt INTEGER")
                database.execSQL("ALTER TABLE sessions ADD COLUMN lastReviewedAt INTEGER")
                database.execSQL("ALTER TABLE sessions ADD COLUMN workflowStateChangedAt INTEGER")
                database.execSQL("ALTER TABLE sessions ADD COLUMN workflowState TEXT")
                database.execSQL("ALTER TABLE sessions ADD COLUMN waitingAction TEXT")
            }
        }

        val MIGRATION_7_8: Migration = object : Migration(7, 8) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE pending_operations ADD COLUMN method TEXT NOT NULL DEFAULT 'POST'")
                database.execSQL("ALTER TABLE pending_operations ADD COLUMN headersJson TEXT NOT NULL DEFAULT '{}'")
                database.execSQL("ALTER TABLE pending_operations ADD COLUMN idempotencyKey TEXT")
                database.execSQL("ALTER TABLE pending_operations ADD COLUMN lastError TEXT")
            }
        }

        val MIGRATION_8_9: Migration = object : Migration(8, 9) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sessions ADD COLUMN templateId TEXT")
            }
        }

        val MIGRATION_9_10: Migration = object : Migration(9, 10) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sessions ADD COLUMN queuedMessagesJson TEXT")
            }
        }

        val MIGRATION_10_11: Migration = object : Migration(10, 11) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE messages ADD COLUMN runId TEXT")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_messages_sessionId_runId ON messages(sessionId, runId)")
            }
        }

        val MIGRATION_11_12: Migration = object : Migration(11, 12) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS target_runtime_summaries (
                        targetId TEXT NOT NULL PRIMARY KEY,
                        instanceId TEXT NOT NULL,
                        revision INTEGER NOT NULL,
                        eventCursor INTEGER NOT NULL,
                        generatedAt TEXT NOT NULL,
                        payloadJson TEXT NOT NULL,
                        updatedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS target_runtime_summary_events (
                        eventKey TEXT NOT NULL PRIMARY KEY,
                        eventId TEXT NOT NULL,
                        targetId TEXT NOT NULL,
                        instanceId TEXT NOT NULL,
                        entityType TEXT NOT NULL,
                        entityId TEXT NOT NULL,
                        revision INTEGER NOT NULL,
                        type TEXT NOT NULL,
                        emittedAt TEXT NOT NULL,
                        cursor INTEGER NOT NULL,
                        summaryJson TEXT NOT NULL,
                        appliedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
                database.execSQL("CREATE INDEX IF NOT EXISTS index_target_runtime_summary_events_targetId_cursor ON target_runtime_summary_events(targetId, cursor)")
                database.execSQL(
                    """CREATE TABLE IF NOT EXISTS target_runtime_summary_cursors (
                        targetId TEXT NOT NULL PRIMARY KEY,
                        cursor INTEGER NOT NULL,
                        revision INTEGER NOT NULL,
                        updatedAt INTEGER NOT NULL
                    )""".trimIndent(),
                )
            }
        }

        fun create(context: Context, name: String = "ragent.db"): RagentDatabase = Room.databaseBuilder(
            context.applicationContext,
            RagentDatabase::class.java,
            name,
        ).addMigrations(
            MIGRATION_1_2,
            MIGRATION_2_3,
            MIGRATION_3_4,
            MIGRATION_4_5,
            MIGRATION_5_6,
            MIGRATION_6_7,
            MIGRATION_7_8,
            MIGRATION_8_9,
            MIGRATION_9_10,
            MIGRATION_10_11,
            MIGRATION_11_12,
            MIGRATION_12_13,
            MIGRATION_13_14,
            MIGRATION_14_15,
            MIGRATION_15_16,
            MIGRATION_16_17,
        ).build()
    }
}
