package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.domain.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.encodeToString
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class SessionMutationJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private lateinit var context: Context
    private lateinit var name: String
    private lateinit var db: AppApiDatabase
    private fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name).addMigrations(
        AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4,
        AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
    private fun operation(binding: String = "foreign") = SessionMutationOperation(binding,
        SessionMutationRequest("op", "original-pc", "session", SessionMutationKind.SET_REVIEWED, flag = true),
        "fingerprint", SessionMutationCommand("request-$binding", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "project", SessionMutationKind.SET_REVIEWED, JsonPrimitive(true)), 1, 1000)
    @Before fun setup() { context = ApplicationProvider.getApplicationContext(); name = "session-mutation-test-${UUID.randomUUID()}.db"; db = open() }
    @After fun cleanup() { db.close(); assertTrue(name.startsWith("session-mutation-test-")); context.deleteDatabase(name) }

    @Test fun unknownSubmissionColdReopenRetainsExactIdentityScopeAndBoolean() = runBlocking {
        var store = RoomSessionMutationStore(db); val original = operation()
        assertTrue(store.insert(original)); assertFalse(store.insert(original))
        val unknown = original.copy(stage = SessionMutationStage.SUBMITTING, revision = 2)
        assertTrue(store.replace(unknown, 1)); db.close(); db = open(); store = RoomSessionMutationStore(db)
        assertEquals(unknown, store.get("foreign", "op")); assertNull(store.get("other", "op"))
        val receipt = SessionMutationReceipt(1, original.command.requestId, "session", SessionMutationKind.SET_REVIEWED,
            true, "cccccccc-cccc-cccc-cccc-cccccccccccc", original.command.expectedScopeRevision,
            "2026-10-11T00:00:00Z", "project", false)
        val applied = unknown.copy(stage = SessionMutationStage.APPLIED, revision = 3, receipt = receipt)
        assertTrue(store.replace(applied, 2)); db.close(); db = open()
        assertEquals(applied, RoomSessionMutationStore(db).get("foreign", "op"))
    }
    @Test fun staleRevisionAndImmutablePreparationCannotBeOverwritten() = runBlocking {
        val store = RoomSessionMutationStore(db); val original = operation(); assertTrue(store.insert(original))
        val next = original.copy(stage = SessionMutationStage.SUBMITTING, revision = 2)
        assertTrue(store.replace(next, 1)); assertFalse(store.replace(next, 1))
        try {
            store.replace(next.copy(command = next.command.copy(expectedProjectId = "other"), revision = 3), 2)
            fail("Immutable context must be rejected")
        } catch (_: IllegalArgumentException) { }
        assertEquals(next, store.get("foreign", "op"))
        assertTrue(store.insert(operation("other"))); assertEquals(2, db.openHelper.readableDatabase.query("SELECT * FROM api_session_mutations").use { it.count })
    }
    @Test fun corruptRowCannotBeDecodedAsAnotherCallersOperation() = runBlocking {
        val store = RoomSessionMutationStore(db); assertTrue(store.insert(operation()))
        db.openHelper.writableDatabase.execSQL("UPDATE api_session_mutations SET requestId = ?", arrayOf("corrupt-request"))
        try { store.get("foreign", "op"); fail("Corrupt row must fail closed") } catch (_: IllegalStateException) { }
    }
    @Test fun inconsistentAcceptedReceiptCannotBeDelivered() = runBlocking {
        val original = operation(); val store = RoomSessionMutationStore(db); assertTrue(store.insert(original))
        val forged = original.copy(stage = SessionMutationStage.APPLIED, receipt = SessionMutationReceipt(1,
            "unrelated-request", "session", SessionMutationKind.SET_REVIEWED, true,
            "cccccccc-cccc-cccc-cccc-cccccccccccc", original.command.expectedScopeRevision,
            "2026-10-11T00:00:00Z", "project", false))
        db.openHelper.writableDatabase.execSQL("UPDATE api_session_mutations SET payload = ?", arrayOf(AppApiJson.encodeToString(forged)))
        try { store.get("foreign", "op"); fail("Unrelated receipt must fail closed") } catch (_: IllegalStateException) { }
    }
    @Test fun migrationFiveToSixPreservesPreviousOperationsAndGrants() = runBlocking {
        db.close()
        migration.createDatabase(name, 5).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES ('old-operation', 'old-preparation', 'owner', 7, 'original-operation')")
            old.execSQL("INSERT INTO api_caller_grants VALUES ('old-grant', 'foreign', 9, 0, 10000, 'original-grant')")
        }
        migration.runMigrationsAndValidate(name, 6, true, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).close()
        db = open()
        assertEquals("original-operation", db.operations().get("old-operation")!!.payload)
        assertEquals("original-grant", db.openHelper.readableDatabase.query("SELECT payload FROM api_caller_grants WHERE grantId = 'old-grant'").use { it.moveToFirst(); it.getString(0) })
        assertTrue(RoomSessionMutationStore(db).insert(operation()))
    }
    @Test fun fullMigrationChainPreservesVersionOneOperation() = runBlocking {
        db.close()
        migration.createDatabase(name, 1).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES ('old-operation', 'old-preparation', 'owner', 7, 'original-operation')")
        }
        migration.runMigrationsAndValidate(name, 6, true, AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3,
            AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).close()
        db = open()
        assertEquals("original-operation", db.operations().get("old-operation")!!.payload)
        assertTrue(RoomSessionMutationStore(db).insert(operation()))
    }
}
