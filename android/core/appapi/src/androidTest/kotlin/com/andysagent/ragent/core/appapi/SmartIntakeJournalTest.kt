package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SmartIntakeJournalTest {
    @Test fun creationDecisionAndOperationSurviveColdDatabaseReopen() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "smart-intake-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, name).build()
        val caller = VerifiedCaller("owner")
        val id = "draft_${UUID.randomUUID().toString().replace("-", "")}"
        val intakeId = "intake_$id"
        val decision = IntakeDecision(1, intakeId, "decision-1", "a".repeat(64), "pc-fixed", "create_new",
            indexRevision = "index-1", reason = "Separate sustained goal", contextComplete = true,
            newProject = IntakeProject("Study", "Long-term research", "research"))
        val original = CaptureDraft(id, caller.binding, 100, input = CaptureInput("Reference"),
            instruction = "Organize research", targetInstanceId = "pc-fixed", runtime = TaskRuntime("codex", model = "model"))
        var db = open()
        try {
            var store = RoomCaptureDraftStore(db)
            assertTrue(store.insert(original, caller))
            val prepared = original.copy(revision = 1, updatedAt = 101, intakeId = intakeId,
                intakeDecision = decision, projectCreationOperationId = "project_$intakeId")
            assertTrue(store.replace(prepared, caller, 0))
            db.close(); db = open(); store = RoomCaptureDraftStore(db)
            assertEquals(prepared, store.get(id, caller))
            assertEquals("project_$intakeId", store.get(id, caller)!!.projectCreationOperationId)
            assertFalse(store.delete(id, caller, 1))
            try {
                store.replace(prepared.copy(revision = 2, updatedAt = 102, instruction = "Redirect elsewhere"), caller, 1)
                fail("A started Project creation must not be redirected")
            } catch (error: AppApiException) {
                assertEquals(ApiErrorCode.REVISION_CONFLICT, error.error.code)
            }
            try {
                store.replace(prepared.copy(projectId = "project-1").freezeForSubmission(102), caller, 1)
                fail("The Project identity must be saved before task freeze")
            } catch (error: AppApiException) {
                assertEquals(ApiErrorCode.REVISION_CONFLICT, error.error.code)
            }
            val ensured = prepared.copy(revision = 2, updatedAt = 102, projectId = "project-1")
            assertTrue(store.replace(ensured, caller, 1))
            val frozen = ensured.freezeForSubmission(103)
            assertTrue(store.replace(frozen, caller, 2))
            db.close(); db = open(); store = RoomCaptureDraftStore(db)
            assertEquals("project-1", store.get(id, caller)!!.toTaskRequest().projectId)
            assertEquals("capture_$id", store.get(id, caller)!!.operationId)
            val oldJson = AppApiJson.encodeToString(original)
                .replace(Regex(",\\\"intakeId\\\":null|,\\\"intakeDecision\\\":null|,\\\"projectCreationOperationId\\\":null"), "")
            assertNull(AppApiJson.decodeFromString(CaptureDraft.serializer(), oldJson).intakeDecision)
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
