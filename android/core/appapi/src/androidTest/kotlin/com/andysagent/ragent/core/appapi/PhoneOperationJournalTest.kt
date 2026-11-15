package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PhoneOperationJournalTest {
    private fun operation() = TaskOperation(
        operationId = "phone-op", callerBinding = "app:certificate", originalFingerprint = "input-fingerprint",
        preparationId = "prepare-token", targetInstanceId = "pc-original",
        request = TaskRequest("phone-op", "Use the source", TaskRuntime("codex"), sourceUrls = listOf("https://example.com")),
        creationKey = "fixed-create-key", messageRequestId = "fixed-message-key", createdAt = 100, deadlineAt = 10_000,
    )

    @Test fun coldReopenRetainsSnapshotAndOptimisticRevision() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "appapi-journal-test-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name).build()
        var database = open()
        try {
            var store = RoomOperationStore(database.operations())
            val initial = operation()
            assertTrue(store.insert(initial))
            assertFalse(store.insert(initial.copy(targetInstanceId = "wrong-pc")))
            val unknown = initial.copy(stage = OperationStage.SUBMITTING, sessionId = "known-session", revision = 1,
                lastError = ApiError(ApiErrorCode.RESULT_UNKNOWN, "Lost reply", true))
            assertTrue(store.replace(unknown, 0))
            assertFalse(store.replace(initial.copy(stage = OperationStage.CANCELLED, revision = 1), 0))
            database.close()
            database = open()
            store = RoomOperationStore(database.operations())
            assertEquals(unknown, store.get(initial.operationId))
            assertEquals(unknown, store.getByPreparation(initial.preparationId))
            val restored = store.get(initial.operationId)!!
            assertEquals("pc-original", restored.targetInstanceId)
            assertEquals("fixed-create-key", restored.creationKey)
            assertEquals("fixed-message-key", restored.messageRequestId)
            assertEquals(listOf("https://example.com"), restored.request.sourceUrls)
        } finally {
            database.close()
            // Exact test-created database only; never the shipped journal.
            assertTrue(name.startsWith("appapi-journal-test-"))
            context.deleteDatabase(name)
        }
    }

    @Test fun savedResultSurvivesColdReopenAndLegacyJsonDefaultsToNoResult() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "appapi-journal-test-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name).build()
        var db = open()
        try {
            val snapshot = TaskResultSnapshot("session", "fixed-message-key", "run", "run", TaskResultState.READY,
                "Synthetic final result", false, emptyList(), "2026-10-11T00:00:00Z")
            val manifest = ResultExportManifest(1, "pc-original", "session", "fixed-message-key", "run", "run",
                listOf(ResultExportResource("text", "result.txt", "text/plain", true, 3, "a".repeat(64))),
                3, 65_536, "2099-01-01T00:00:00Z", "b".repeat(64))
            val saved = operation().copy(stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", result = snapshot, resultExport = manifest)
            assertTrue(RoomOperationStore(db.operations()).insert(saved))
            db.close(); db = open()
            assertEquals(saved, RoomOperationStore(db.operations()).get(saved.operationId))
            val json = AppApiJson.parseToJsonElement(AppApiJson.encodeToString(TaskOperation.serializer(), saved)) as kotlinx.serialization.json.JsonObject
            val legacy = kotlinx.serialization.json.JsonObject(json.filterKeys { it !in setOf("result", "resultExport") })
            assertNull(AppApiJson.decodeFromString(TaskOperation.serializer(), legacy.toString()).result)
            assertNull(AppApiJson.decodeFromString(TaskOperation.serializer(), legacy.toString()).resultExport)
        } finally { db.close(); context.deleteDatabase(name) }
    }

    @Test fun preparationIdentityCannotBeReusedByAnotherOperation() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AppApiDatabase::class.java).build()
        try {
            val store = RoomOperationStore(database.operations())
            val initial = operation()
            assertTrue(store.insert(initial))
            assertFalse(store.insert(initial.copy(operationId = "other-op", callerBinding = "attacker")))
            assertEquals(initial, store.getByPreparation(initial.preparationId))
            assertNull(store.get("other-op"))
        } finally { database.close() }
    }
}
