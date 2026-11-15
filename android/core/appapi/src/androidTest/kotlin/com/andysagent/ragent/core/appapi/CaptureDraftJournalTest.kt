package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CaptureDraftJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private val owner = VerifiedCaller("owner")
    private val other = VerifiedCaller("other")
    private fun ready(id: String = "draft-1") = CaptureDraft(id, owner.binding, 100,
        input = captureSharedText("Full source https://example.com/a https://example.com/b", "A report"),
        instruction = "Compare sources", targetInstanceId = "pc-fixed", runtime = TaskRuntime("codex"))
    private fun expectCode(code: ApiErrorCode, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: AppApiException) { assertEquals(code, error.error.code) }
    }

    @Test fun unresolvedShortcutSelectionSurvivesDatabaseReopenAndOldJsonDefaultsToOrdinaryRouting() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "shortcut-selection-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name)
            .addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        var db = open()
        val draft = ready("missing-shortcut").copy(targetInstanceId = null, runtime = null, requireTargetSelection = true)
        try {
            assertTrue(RoomCaptureDraftStore(db).insert(draft, owner))
            db.close(); db = open()
            assertEquals(draft, RoomCaptureDraftStore(db).get(draft.draftId, owner))
            val oldJson = AppApiJson.encodeToString(draft).replace(",\"requireTargetSelection\":true", "")
            assertFalse(AppApiJson.decodeFromString(CaptureDraft.serializer(), oldJson).requireTargetSelection)
            assertNull(RoomCaptureDraftStore(db).get(draft.draftId, other))
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun concurrentEditorsHaveOneWinnerAndOtherCallersCannotSeeOrDeleteDraft() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, AppApiDatabase::class.java).build()
        try {
            val store = RoomCaptureDraftStore(db)
            val initial = ready()
            assertTrue(store.insert(initial, owner))
            assertFalse(store.insert(initial, owner))
            assertNull(store.get(initial.draftId, other))
            assertTrue(store.observe(other).first().isEmpty())
            assertFalse(store.delete(initial.draftId, other, 0))
            val results = listOf("edit-a", "edit-b").map { text -> async {
                store.replace(initial.copy(instruction = text, revision = 1, updatedAt = 200), owner, 0)
            } }.awaitAll()
            assertEquals(1, results.count { it })
            assertEquals(1L, store.get(initial.draftId, owner)!!.revision)
            assertEquals(1, store.observe(owner).first().size)
        } finally { db.close() }
    }

    @Test fun operationLookupReturnsOnlyTheMatchingFrozenDraftToItsOwner() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, AppApiDatabase::class.java).build()
        try {
            val store = RoomCaptureDraftStore(db)
            val editable = ready().copy(targetInstanceId = "pc-fixed", runtime = TaskRuntime("codex"))
            assertTrue(store.insert(editable, owner))
            val frozen = editable.freezeForSubmission(200)
            assertTrue(store.replace(frozen, owner, editable.revision))
            val operationId = requireNotNull(frozen.operationId)

            assertEquals(frozen, store.getByOperationId(operationId, owner))
            assertNull(store.getByOperationId(operationId, other))
            assertNull(store.getByOperationId("missing-operation", owner))
        } finally { db.close() }
    }

    @Test fun selectedTextProvenanceColdReopensAndOlderJsonHasNoSelectionMetadata() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "selected-text-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name)
            .addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        var db = open()
        val draft = ready().copy(input = ready().input.copy(source = CaptureSource.PROCESS_TEXT, selectionReadOnly = false))
        try {
            assertTrue(RoomCaptureDraftStore(db).insert(draft, owner))
            db.close(); db = open()
            assertEquals(draft, RoomCaptureDraftStore(db).get(draft.draftId, owner))
            assertNull(RoomCaptureDraftStore(db).get(draft.draftId, other))
            val legacy = AppApiJson.encodeToString(draft).replace(",\"selectionReadOnly\":false", "")
            assertNull(AppApiJson.decodeFromString(CaptureDraft.serializer(), legacy).input.selectionReadOnly)
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun frozenDraftCannotBeRetargetedEditedUnboundOrDeleted() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, AppApiDatabase::class.java).build()
        try {
            val store = RoomCaptureDraftStore(db)
            val initial = ready()
            store.insert(initial, owner)
            val frozen = initial.freezeForSubmission(200)
            assertTrue(store.replace(frozen, owner, 0))
            for (changed in listOf(frozen.copy(targetInstanceId = "other-pc"), frozen.copy(instruction = "replace"),
                frozen.copy(operationId = null), frozen.copy(input = CaptureInput("replaced")))) {
                expectCode(ApiErrorCode.REVISION_CONFLICT) { runBlocking { store.replace(changed.copy(revision = 2), owner, 1) } }
            }
            assertFalse(store.delete(initial.draftId, owner, 1))
            val prepared = PreparedTask(frozen.operationId!!, "prep", "pc-fixed", 10_000, OperationStage.PREPARED)
            val bound = frozen.bindPreparation(prepared, 300)
            assertTrue(store.replace(bound, owner, 1))
            expectCode(ApiErrorCode.REVISION_CONFLICT) { runBlocking { store.replace(bound.copy(preparationId = null, revision = 3), owner, 2) } }
            assertEquals(bound, store.get(initial.draftId, owner))
        } finally { db.close() }
    }

    @Test fun editableDeleteRequiresCurrentRevisionAndCallerCannotForgeAnotherBinding() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, AppApiDatabase::class.java).build()
        try {
            val store = RoomCaptureDraftStore(db)
            expectCode(ApiErrorCode.PERMISSION_DENIED) { runBlocking { store.insert(ready().copy(callerBinding = other.binding), owner) } }
            assertTrue(store.insert(ready(), owner))
            assertFalse(store.delete("draft-1", owner, 1))
            assertTrue(store.delete("draft-1", owner, 0))
            assertNull(store.get("draft-1", owner))
        } finally { db.close() }
    }

    @Test fun coldRecoveryBetweenPrepareAndDraftBindingReusesOperationWithoutDispatch() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "appapi-draft-test-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name).addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        var db = open()
        var remoteCalls = 0
        fun coordinator(database: AppApiDatabase) = TaskCoordinator(RoomOperationStore(database.operations()),
            directory = { TargetDirectorySnapshot(listOf(ApiTarget("pc-fixed", "Office")), "pc-fixed") },
            authorizer = GrantAuthorizer(owner.binding, { emptyList() }),
            targetAccess = object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                    remoteCalls++; error("Prepare and reopen must not dispatch")
                }
            }, now = { 300 })
        try {
            var store = RoomCaptureDraftStore(db)
            store.insert(ready(), owner)
            val frozen = ready().freezeForSubmission(200)
            store.replace(frozen, owner, 0)
            val first = coordinator(db).prepare(frozen.toTaskRequest(), owner)
            // Simulate losing the preparation response before saving its draft link.
            db.close()
            db = open()
            store = RoomCaptureDraftStore(db)
            val restored = store.get(frozen.draftId, owner)!!
            assertNull(restored.preparationId)
            assertEquals(frozen, restored)
            val replay = coordinator(db).prepare(restored.toTaskRequest(), owner)
            assertEquals(first, replay)
            val bound = restored.bindPreparation(replay, 400)
            assertTrue(store.replace(bound, owner, restored.revision))
            assertEquals(bound, store.observe(owner).first().single())
            assertEquals("pc-fixed", RoomOperationStore(db.operations()).get(bound.operationId!!)!!.targetInstanceId)
            assertEquals(0, remoteCalls)
        } finally {
            db.close()
            assertTrue(name.startsWith("appapi-draft-test-"))
            context.deleteDatabase(name)
        }
    }

    @Test fun migrationAddsDraftsAndRetainsUnknownSubmissionIdentity() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "appapi-draft-migration-test-${UUID.randomUUID()}.db"
        val operation = TaskOperation("existing-op", owner.binding, "frozen-input", "prep-original", "pc-original",
            TaskRequest("existing-op", "Continue work", TaskRuntime("codex")), "creation-original", "message-original", 1, 1000,
            stage = OperationStage.SUBMITTING, sessionId = "session-original", revision = 7)
        migration.createDatabase(name, 1).use { old ->
            old.execSQL("INSERT INTO api_operations (operationId, preparationId, callerBinding, revision, payload) VALUES (?, ?, ?, ?, ?)",
                arrayOf(operation.operationId, operation.preparationId, operation.callerBinding, operation.revision, AppApiJson.encodeToString(operation)))
        }
        migration.runMigrationsAndValidate(name, 2, true, AppApiDatabase.MIGRATION_1_2).close()
        val db = Room.databaseBuilder(context, AppApiDatabase::class.java, name).addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        try {
            assertEquals(operation, RoomOperationStore(db.operations()).get(operation.operationId))
            val drafts = RoomCaptureDraftStore(db)
            assertTrue(drafts.insert(ready(), owner))
            assertEquals(ready(), drafts.get("draft-1", owner))
        } finally {
            db.close()
            assertTrue(name.startsWith("appapi-draft-migration-test-"))
            context.deleteDatabase(name)
        }
    }
}
