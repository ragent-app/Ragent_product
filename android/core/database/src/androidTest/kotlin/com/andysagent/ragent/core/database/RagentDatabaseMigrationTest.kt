package com.andysagent.ragent.core.database

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RagentDatabaseMigrationTest {
    @Test fun migrates15To16WithoutDroppingMessages() {
        val name = "migration-15-16-run-duration.db"
        helper.createDatabase(name, 15).use { db ->
            db.execSQL("INSERT INTO sessions (id,title,status,latestSeq,updatedAt) VALUES ('s','Offline','completed',1,10)")
            db.execSQL("INSERT INTO messages (id,sessionId,role,content,seq,requestId,completed,updatedAt,messagePhase) VALUES ('m','s','assistant','Keep this',1,'r',1,10,'final_answer')")
        }
        helper.runMigrationsAndValidate(name, 16, true, RagentDatabase.MIGRATION_15_16).use { db ->
            db.query("SELECT content,messagePhase FROM messages WHERE id='m'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals("Keep this", row.getString(0)); assertEquals("final_answer", row.getString(1))
            }
            db.execSQL("INSERT INTO run_durations (sessionId,runId,durationMs) VALUES ('s','r',12345)")
            db.query("SELECT durationMs FROM run_durations WHERE sessionId='s' AND runId='r'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals(12345L, row.getLong(0))
            }
        }
    }
    @Test fun migrates14To15PreservingExistingMessages() {
        val name = "migration-14-15-message-phase.db"
        helper.createDatabase(name, 14).use { db ->
            db.execSQL("INSERT INTO sessions (id,title,status,latestSeq,updatedAt) VALUES ('s','Offline','completed',1,10)")
            db.execSQL("INSERT INTO messages (id,sessionId,role,content,seq,requestId,completed,updatedAt) VALUES ('m','s','assistant','Keep this',1,'r',1,10)")
        }
        helper.runMigrationsAndValidate(name, 15, true, RagentDatabase.MIGRATION_14_15).use { db ->
            db.query("SELECT content,messagePhase FROM messages WHERE id='m'").use { row ->
                assertEquals(true, row.moveToFirst())
                assertEquals("Keep this", row.getString(0))
                assertEquals(true, row.isNull(1))
            }
        }
    }
    @Test fun migrates13To14PreservingProjectsSessionsAndPendingOperations() {
        val name = "migration-13-14-pins.db"
        helper.createDatabase(name, 13).use { db ->
            db.execSQL("INSERT INTO projects (id,name,updatedAt) VALUES ('p','Project',10)")
            db.execSQL("INSERT INTO sessions (id,title,projectId,status,latestSeq,updatedAt) VALUES ('s','Offline','p','completed',10,10)")
            db.execSQL("INSERT INTO pending_operations (requestId,kind,path,payload,state,createdAt,updatedAt,method,headersJson) VALUES ('pending','send_message','/api/messages','{}','unknown',10,10,'POST','{}')")
        }
        helper.runMigrationsAndValidate(name, 14, true, RagentDatabase.MIGRATION_13_14).use { db ->
            db.query("SELECT name,pinned FROM projects WHERE id='p'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals("Project", row.getString(0)); assertEquals(0, row.getInt(1))
            }
            db.query("SELECT title,projectId,pinned FROM sessions WHERE id='s'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals("Offline", row.getString(0)); assertEquals("p", row.getString(1)); assertEquals(0, row.getInt(2))
            }
            db.query("SELECT state FROM pending_operations WHERE requestId='pending'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals("unknown", row.getString(0))
            }
        }
    }
    @Test fun migrates12To13WithoutDroppingOfflineMessagesOrPendingOperations() {
        val name = "migration-12-13-timeline.db"
        helper.createDatabase(name, 12).use { db ->
            db.execSQL("INSERT INTO sessions (id,title,status,latestSeq,updatedAt) VALUES ('s','Offline','completed',10,10)")
            db.execSQL("INSERT INTO messages (id,sessionId,role,content,seq,requestId,completed,updatedAt) VALUES ('m','s','assistant','Keep this',10,'r',1,10)")
            db.execSQL("INSERT INTO pending_operations (requestId,kind,path,payload,state,createdAt,updatedAt,method,headersJson) VALUES ('pending','send_message','/api/messages','{}','unknown',10,10,'POST','{}')")
        }
        helper.runMigrationsAndValidate(name, 13, true, RagentDatabase.MIGRATION_12_13).use { db ->
            db.query("SELECT content,lastEventSeq,messageState FROM messages WHERE id='m'").use { row ->
                assertEquals(true, row.moveToFirst())
                assertEquals("Keep this", row.getString(0))
                assertEquals(10L, row.getLong(1))
                assertEquals("completed", row.getString(2))
            }
            db.query("SELECT timelineProjectionVersion FROM sessions WHERE id='s'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals(0, row.getInt(0))
            }
            db.query("SELECT state FROM pending_operations WHERE requestId='pending'").use { row ->
                assertEquals(true, row.moveToFirst()); assertEquals("unknown", row.getString(0))
            }
        }
    }
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        RagentDatabase::class.java,
    )

    @Test
    fun migratesApprovalColumnsFromVersion4To5() {
        helper.createDatabase(TEST_DB_4_5, 4).use { database ->
            database.execSQL(
                "INSERT INTO approvals (id, sessionId, title, status, runId, batchId, kind, updatedAt) "
                    + "VALUES ('approval-1', 'session-1', 'Approve action', 'pending', 'run-1', 'batch-1', "
                    + "'approved_action_batch_request', 10)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_4_5,
            5,
            true,
            RagentDatabase.MIGRATION_4_5,
        )
        migrated.query("SELECT * FROM approvals WHERE id = 'approval-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("run-1", cursor.getString(cursor.getColumnIndexOrThrow("runId")))
            assertEquals("batch-1", cursor.getString(cursor.getColumnIndexOrThrow("batchId")))
            assertEquals("approved_action_batch_request", cursor.getString(cursor.getColumnIndexOrThrow("kind")))
            assertNotNull(cursor.getString(cursor.getColumnIndexOrThrow("approveLabel")))
            assertNotNull(cursor.getString(cursor.getColumnIndexOrThrow("denyLabel")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("detailsJson")))
        }
        migrated.close()
    }

    @Test
    fun migratesSessionEventLogAndCursorMetadataFromVersion5To6() {
        helper.createDatabase(TEST_DB_5_6, 5).use { database ->
            database.execSQL(
                "INSERT INTO sync_cursors (scope, lastAppliedSeq, lastEventId, updatedAt) "
                    + "VALUES ('session-1', 12, 'event-12', 10)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_5_6,
            6,
            true,
            RagentDatabase.MIGRATION_5_6,
        )
        migrated.query("SELECT * FROM sync_cursors WHERE scope = 'session-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(12L, cursor.getLong(cursor.getColumnIndexOrThrow("lastAppliedSeq")))
            assertEquals("event-12", cursor.getString(cursor.getColumnIndexOrThrow("lastEventId")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("lastServerCursor")))
            assertEquals(true, cursor.isNull(cursor.getColumnIndexOrThrow("lastSnapshotVersion")))
        }
        migrated.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_events'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
        }
        migrated.close()
    }

    @Test
    fun migratesPendingOperationReplayMetadataFromVersion7To8() {
        helper.createDatabase(TEST_DB_7_8, 7).use { database ->
            database.execSQL(
                "INSERT INTO pending_operations (requestId, kind, path, payload, state, createdAt, updatedAt) "
                    + "VALUES ('request-1', 'update_goal', '/api/sessions/s1', '{\"goal\":null}', 'pending', 10, 11)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_7_8,
            8,
            true,
            RagentDatabase.MIGRATION_7_8,
        )
        migrated.query("SELECT * FROM pending_operations WHERE requestId = 'request-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("POST", cursor.getString(cursor.getColumnIndexOrThrow("method")))
            assertEquals("{}", cursor.getString(cursor.getColumnIndexOrThrow("headersJson")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("idempotencyKey")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("lastError")))
        }
        migrated.close()
    }

    @Test
    fun migratesSessionAgentBindingFromVersion8To9() {
        helper.createDatabase(TEST_DB_8_9, 8).use { database ->
            database.execSQL(
                "INSERT INTO sessions (id, title, projectId, status, latestSeq, updatedAt) "
                    + "VALUES ('session-1', 'Task', NULL, 'idle', 0, 10)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_8_9,
            9,
            true,
            RagentDatabase.MIGRATION_8_9,
        )
        migrated.query("SELECT templateId FROM sessions WHERE id = 'session-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("templateId")))
        }
        migrated.close()
    }

    @Test
    fun migratesSessionQueueProjectionFromVersion9To10() {
        helper.createDatabase(TEST_DB_9_10, 9).use { database ->
            database.execSQL(
                "INSERT INTO sessions (id, title, projectId, status, latestSeq, updatedAt, templateId) "
                    + "VALUES ('session-1', 'Task', NULL, 'working', 2, 10, NULL)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_9_10,
            10,
            true,
            RagentDatabase.MIGRATION_9_10,
        )
        migrated.query("SELECT queuedMessagesJson FROM sessions WHERE id = 'session-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("queuedMessagesJson")))
        }
        migrated.close()
    }

    @Test
    fun migratesTargetRuntimeSummaryLedgerFromVersion11To12() {
        helper.createDatabase(TEST_DB_11_12, 11).use { database ->
            database.execSQL(
                "INSERT INTO sync_cursors (scope, lastAppliedSeq, lastEventId, updatedAt) "
                    + "VALUES ('session-1', 12, 'event-12', 10)",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_11_12,
            12,
            true,
            RagentDatabase.MIGRATION_11_12,
        )
        migrated.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'target_runtime_%'")
            .use { cursor ->
                var count = 0
                while (cursor.moveToNext()) count += 1
                assertEquals(3, count)
            }
        migrated.close()
    }

    @Test
    fun migratesMessageMetadataFromVersion16To17() {
        helper.createDatabase(TEST_DB_16_17, 16).use { database ->
            database.execSQL(
                "INSERT INTO messages (id, sessionId, role, content, seq, requestId, runId, completed, updatedAt, lastEventSeq, revision, messageState, messagePhase) "
                    + "VALUES ('msg-1', 'session-1', 'assistant', 'Choose environment', 4, 'req-4', 'run-1', 1, 100, 4, 1, 'completed', 'final_answer')",
            )
            database.execSQL(
                "INSERT INTO timeline_message_staging (sessionId, id, role, content, seq, lastEventSeq, revision, messageState, requestId, runId, messagePhase) "
                    + "VALUES ('session-1', 'msg-2', 'assistant', 'Next question', 5, 5, 1, 'completed', 'req-5', 'run-1', 'commentary')",
            )
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB_16_17,
            17,
            true,
            RagentDatabase.MIGRATION_16_17,
        )
        migrated.query("SELECT content, metadataJson FROM messages WHERE id = 'msg-1'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("Choose environment", cursor.getString(cursor.getColumnIndexOrThrow("content")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("metadataJson")))
        }
        migrated.query("SELECT content, metadataJson FROM timeline_message_staging WHERE id = 'msg-2'").use { cursor ->
            assertEquals(true, cursor.moveToFirst())
            assertEquals("Next question", cursor.getString(cursor.getColumnIndexOrThrow("content")))
            assertEquals(null, cursor.getString(cursor.getColumnIndexOrThrow("metadataJson")))
        }
        migrated.close()
    }

    companion object {
        private const val TEST_DB_4_5 = "migration-4-5-test.db"
        private const val TEST_DB_5_6 = "migration-5-6-test.db"
        private const val TEST_DB_7_8 = "migration-7-8-test.db"
        private const val TEST_DB_8_9 = "migration-8-9-test.db"
        private const val TEST_DB_9_10 = "migration-9-10-test.db"
        private const val TEST_DB_11_12 = "migration-11-12-test.db"
        private const val TEST_DB_16_17 = "migration-16-17-test.db"
    }
}
