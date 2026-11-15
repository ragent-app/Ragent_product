package com.andysagent.ragent.core.appapi

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CaptureResourceJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private val owner = VerifiedCaller("owner")
    private val other = VerifiedCaller("other")
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var db: AppApiDatabase
    private var ids = 0
    private val bytes = "a,b\n1,2\n手机素材".toByteArray()
    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        root = File(app.cacheDir, "resource-journal-${UUID.randomUUID()}").apply { mkdirs() }
        context = object : ContextWrapper(app) {
            override fun getApplicationContext() = this
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        db = open()
    }
    private fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, File(root, "journal.db").absolutePath)
        .addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
    private fun store() = PersistentCaptureResources(context, db, newId = { "resource-${ids++}" })
    private suspend fun imported(store: PersistentCaptureResources = store()) = store.importStream("data.csv", "text/csv", null, owner) { ByteArrayInputStream(bytes) }
    private fun privateFile(id: String, suffix: String = "bin") = File(context.noBackupFilesDir, "ragent-capture-resources/$id.$suffix")

    @Test fun importProgressUsesActualBytesAndKeepsUnknownSizeIndeterminate() = runBlocking {
        val resources = store()
        val payload = ByteArray(180_000) { (it % 127).toByte() }
        for (size in listOf(null, payload.size.toLong())) {
            val observations = mutableListOf<CaptureImportProgress>()
            val ready = resources.importStream("folder/报告.bin", "application/octet-stream", size, owner,
                onProgress = { progress ->
                    observations += progress
                    assertFalse("Progress cannot expose a ready file before atomic publication", privateFile(progress.resourceId).exists())
                }) { ByteArrayInputStream(payload) }
            assertEquals(0L, observations.first().copiedBytes)
            assertEquals(CaptureImportPhase.COPYING, observations.first().phase)
            assertEquals(CaptureImportPhase.SAVING, observations.last().phase)
            assertEquals(payload.size.toLong(), observations.last().copiedBytes)
            assertTrue(observations.all { it.resourceId == ready.resourceId && it.originalName == "报告.bin" && it.totalBytes == size })
            assertTrue(observations.zipWithNext().all { (a, b) -> a.copiedBytes <= b.copiedBytes })
            assertEquals(CaptureResourceState.READY, resources.get(ready.resourceId, owner)!!.state)
            assertArrayEquals(payload, resources.read(ready.reference(), owner))
        }
    }

    @Test fun intermediateProgressArrivesBeforePrivateFileIsReady() = runBlocking {
        val resources = store()
        val payload = ByteArray(180_000) { (it % 127).toByte() }
        val observed = CompletableDeferred<CaptureImportProgress>()
        val release = java.util.concurrent.CountDownLatch(1)
        val source = object : ByteArrayInputStream(payload) {
            private var reads = 0
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (reads++ == 1) check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                return super.read(buffer, offset, length)
            }
            override fun close() { release.countDown(); super.close() }
        }
        val copying = async {
            resources.importStream("slow.bin", "application/octet-stream", payload.size.toLong(), owner,
                onProgress = { if (it.phase == CaptureImportPhase.COPYING && it.copiedBytes > 0) observed.complete(it) }) {
                delay(150) // Cross the observer throttle before the first real write.
                source
            }
        }
        try {
            val progress = withTimeout(5_000) { observed.await() }
            assertEquals(65_536L, progress.copiedBytes)
            assertEquals(payload.size.toLong(), progress.totalBytes)
            assertEquals(CaptureResourceState.IMPORTING, resources.get(progress.resourceId, owner)!!.state)
            assertFalse(privateFile(progress.resourceId).exists())
            assertEquals(progress.copiedBytes, privateFile(progress.resourceId, "tmp").length())
        } finally { release.countDown() }
        val ready = withTimeout(5_000) { copying.await() }
        assertEquals(CaptureResourceState.READY, ready.state)
        assertArrayEquals(payload, resources.read(ready.reference(), owner))
    }

    @Test fun progressDoesNotClaimSavedWhenSourceSizeIsWrongOrCopyCancelled() = runBlocking {
        val resources = store()
        val observations = mutableListOf<CaptureImportProgress>()
        try {
            resources.importStream("short.bin", "application/octet-stream", 100, owner, "short-progress",
                onProgress = { observations += it }) { ByteArrayInputStream(bytes) }
            fail("A short source must fail")
        } catch (_: AppApiException) { }
        assertTrue(observations.isNotEmpty())
        assertTrue(observations.none { it.phase == CaptureImportPhase.SAVING })
        assertEquals(CaptureResourceState.FAILED, resources.get("short-progress", owner)!!.state)
        try {
            resources.importStream("cancel.bin", "application/octet-stream", null, owner, "cancel-progress",
                onProgress = { throw CancellationException("Stop local import") }) { ByteArrayInputStream(bytes) }
            fail("Cancellation must propagate")
        } catch (_: CancellationException) { }
        assertEquals(ApiErrorCode.CANCELLED, resources.get("cancel-progress", owner)!!.error)
        assertFalse(privateFile("cancel-progress").exists())
    }

    @Test fun failedProgressObserverCannotInvalidatePrivateCopy() = runBlocking {
        val resources = store()
        val ready = resources.importStream("sample.csv", "text/csv", null, owner,
            onProgress = { throw IllegalStateException("Detached renderer") }) { ByteArrayInputStream(bytes) }
        assertEquals(CaptureResourceState.READY, ready.state)
        assertArrayEquals(bytes, resources.read(ready.reference(), owner))
    }

    @After fun teardown() {
        db.close()
        val app = ApplicationProvider.getApplicationContext<Context>()
        assertTrue(root.canonicalPath.startsWith(app.cacheDir.canonicalPath + File.separator))
        assertTrue(root.name.startsWith("resource-journal-")); root.deleteRecursively()
    }

    @Test fun importedBytesSurviveSourceLossReopenAndStayCallerBound() = runBlocking {
        var resources = store()
        val source = bytes.copyOf()
        val ready = resources.importStream("data.csv", "TEXT/CSV", null, owner) { ByteArrayInputStream(source) }
        source.fill(0)
        assertEquals(CaptureResourceState.READY, ready.state)
        assertNull(resources.get(ready.resourceId, other))
        assertArrayEquals(bytes, resources.read(ready.reference(), owner))
        try { resources.read(ready.reference(), other); fail("Foreign caller must be denied") } catch (_: AppApiException) { }
        db.close(); db = open(); resources = store()
        assertEquals(ready, resources.get(ready.resourceId, owner))
        resources.validate(listOf(ready.reference()), owner)
        assertArrayEquals(bytes, resources.read(ready.reference(), owner))
        privateFile(ready.resourceId).writeBytes(ByteArray(bytes.size))
        try { resources.validate(listOf(ready.reference()), owner); fail("Changed bytes must fail") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.REVISION_CONFLICT, error.error.code) }
    }

    @Test fun sizeLieAndCancelledBlockedInputNeverBecomeReady() = runBlocking {
        val resources = store()
        try { resources.importStream("data.csv", "text/csv", 1, owner) { ByteArrayInputStream(bytes) }; fail("Size lie must fail") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, error.error.code) }
        assertEquals(CaptureResourceState.FAILED, resources.get("resource-0", owner)!!.state)
        assertFalse(privateFile("resource-0").exists())
        val entered = CompletableDeferred<Unit>()
        val closed = java.util.concurrent.CountDownLatch(1)
        val blocking = object : InputStream() {
            override fun read(): Int { entered.complete(Unit); closed.await(); return -1 }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = read()
            override fun close() { closed.countDown() }
        }
        val job = launch { resources.importStream("blocked.txt", "text/plain", null, owner) { blocking } }
        entered.await()
        withTimeout(5000) { job.cancelAndJoin() }
        val cancelled = resources.get("resource-1", owner)!!
        assertEquals(CaptureResourceState.FAILED, cancelled.state)
        assertEquals(ApiErrorCode.CANCELLED, cancelled.error)
        assertFalse(privateFile("resource-1").exists())
    }

    @Test fun completedCopyCrashWindowRecoversButPartialCopyCannot() = runBlocking {
        fun initial(id: String) = CaptureResource(id, owner.binding, "data.csv", "text/csv", 1)
        for (id in listOf("completed", "partial")) {
            val resource = initial(id)
            db.resources().insert(CaptureResourceEntity(id, owner.binding, resource.state.name, 0, AppApiJson.encodeToString(resource)))
        }
        privateFile("completed").apply { parentFile!!.mkdirs(); writeBytes(bytes) }
        privateFile("partial", "tmp").writeBytes(bytes.copyOf(2))
        db.close(); db = open()
        val resources = store()
        assertNull(resources.recover("completed", other))
        val recovered = resources.recover("completed", owner)!!
        assertEquals(CaptureResourceState.READY, recovered.state)
        assertArrayEquals(bytes, resources.read(recovered.reference(), owner))
        assertEquals(CaptureResourceState.FAILED, resources.recover("partial", owner)!!.state)
        assertFalse(privateFile("partial", "tmp").exists())
    }

    @Test fun frozenDraftAndOperationPinsPreventDeleteAndForeignFreezeRollsBack() = runBlocking {
        val resources = store(); val ready = imported(resources); val ref = ready.reference()
        val drafts = RoomCaptureDraftStore(db)
        val draft = CaptureDraft("draft-one", owner.binding, 1, input = CaptureInput(resources = listOf(ref)),
            instruction = "Analyze", targetInstanceId = "pc-a", runtime = TaskRuntime("codex"))
        assertTrue(drafts.insert(draft, owner))
        val frozen = draft.freezeForSubmission(2)
        assertTrue(drafts.replace(frozen, owner, 0))
        assertFalse(resources.delete(ready.resourceId, owner, ready.revision))
        val operation = TaskOperation("op", owner.binding, "fingerprint", "prep", "pc-a",
            frozen.toTaskRequest().copy(operationId = "op"), "create", "message", 1, 1000)
        assertTrue(RoomOperationStore(db).insert(operation))
        assertEquals(2, db.resources().references(ready.resourceId))
        assertFalse(resources.delete(ready.resourceId, owner, ready.revision))
        val foreign = draft.copy(draftId = "foreign", callerBinding = other.binding)
        assertTrue(drafts.insert(foreign, other))
        try { drafts.replace(foreign.freezeForSubmission(2), other, 0); fail("Foreign freeze must fail") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, error.error.code) }
        assertNull(drafts.get("foreign", other)!!.operationId)
        val bad = operation.copy(operationId = "foreign-op", preparationId = "foreign-prep", callerBinding = other.binding)
        try { RoomOperationStore(db).insert(bad); fail("Foreign operation pin must fail") } catch (_: AppApiException) { }
        assertNull(RoomOperationStore(db).get("foreign-op"))
    }

    @Test fun deleteTombstoneSurvivesReopenAndCannotBeReadOrRecovered() = runBlocking {
        var resources = store(); val ready = imported(resources)
        assertFalse(resources.delete(ready.resourceId, other, ready.revision))
        assertFalse(resources.delete(ready.resourceId, owner, ready.revision + 1))
        assertTrue(resources.delete(ready.resourceId, owner, ready.revision))
        assertFalse(privateFile(ready.resourceId).exists())
        db.close(); db = open(); resources = store()
        assertEquals(CaptureResourceState.DELETED, resources.recover(ready.resourceId, owner)!!.state)
        try { resources.read(ready.reference(), owner); fail("Deleted content must not be read") } catch (_: AppApiException) { }
    }

    @Test fun v2MigrationPreservesTextDraftAndUnknownOperation() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<Context>()
        val name = "resource-migration-${UUID.randomUUID()}.db"
        val draft = CaptureDraft("old-draft", owner.binding, 1, input = CaptureInput("Original source"))
        val request = TaskRequest("old-op", "Original instruction", TaskRuntime("codex"))
        val operation = TaskOperation("old-op", owner.binding, "original-fingerprint", "original-prep", "pc-original",
            request, "original-create", "original-message", 1, 1000, stage = OperationStage.SUBMITTING, sessionId = "s", revision = 7)
        migration.createDatabase(name, 2).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES (?, ?, ?, ?, ?)", arrayOf(operation.operationId, operation.preparationId,
                owner.binding, 7, AppApiJson.encodeToString(operation).replace(",\"resources\":[]", "").replace(",\"uploads\":[]", "")))
            old.execSQL("INSERT INTO capture_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(draft.draftId, owner.binding, 1, 1, 0, null, null,
                AppApiJson.encodeToString(draft).replace(",\"resources\":[]", "").replace(",\"imports\":[]", "")
                    .replace(",\"requireTargetSelection\":false", "")))
        }
        migration.runMigrationsAndValidate(name, 3, true, AppApiDatabase.MIGRATION_2_3).close()
        val migrated = Room.databaseBuilder(app, AppApiDatabase::class.java, name).addMigrations(AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        try {
            assertEquals(operation, RoomOperationStore(migrated).get("old-op"))
            assertEquals(draft, RoomCaptureDraftStore(migrated).get("old-draft", owner))
            assertNull(migrated.resources().get("none", owner.binding))
        } finally { migrated.close(); assertTrue(name.startsWith("resource-migration-")); app.deleteDatabase(name) }
    }

    private suspend fun pendingDraft(vararg ids: String): CaptureDraft {
        val draft = CaptureDraft("import-draft", owner.binding, 1,
            input = CaptureInput("Original material", imports = ids.map { CaptureImportSlot(it) }))
        assertTrue(RoomCaptureDraftStore(db).insert(draft, owner))
        return draft
    }

    @Test fun batchAllocationsAreDurableBeforeCopyAndFailedFileCannotSilentlyFreeze() = runBlocking {
        pendingDraft("first", "second")
        val drafts = RoomCaptureDraftStore(db); val resources = store()
        val importer = DraftResourceImports(drafts, resources)
        val copied = mutableListOf<String>()
        val result = importer.consume("import-draft", owner, { id, budget ->
            assertTrue(drafts.get("import-draft", owner)!!.input.imports.any { it.resourceId == id })
            copied += id
            if (id == "second") throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Source permission lost"))
            resources.importStream("first.csv", "text/csv", null, owner, id, budget) { ByteArrayInputStream(bytes) }
        })
        assertEquals(listOf("first", "second"), copied)
        assertEquals(listOf("first"), result.input.resources.map { it.resourceId })
        assertEquals(ApiErrorCode.PERMISSION_DENIED, result.input.imports.single().error)
        val configured = result.copy(instruction = "Analyze", targetInstanceId = "pc-a", runtime = TaskRuntime("codex"))
        try { configured.freezeForSubmission(2); fail("Failed file cannot disappear during freeze") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, error.error.code) }
        val removed = configured.copy(input = configured.input.copy(imports = emptyList()))
        assertEquals(listOf("first"), removed.freezeForSubmission(2).toTaskRequest().resources.map { it.resourceId })
    }

    @Test fun crashAfterCopyBeforeDraftLinkRestoresOnlyPrivateBytesAndNoSourceIsReopened() = runBlocking {
        pendingDraft("copied", "not-copied")
        var resources = store()
        resources.importStream("sample.csv", "text/csv", null, owner, "copied") { ByteArrayInputStream(bytes) }
        db.close(); db = open(); resources = store()
        val result = DraftResourceImports(RoomCaptureDraftStore(db), resources).restore("import-draft", owner)
        assertEquals(listOf("copied"), result.input.resources.map { it.resourceId })
        assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, result.input.imports.single().error)
        assertArrayEquals(bytes, resources.read(result.input.resources.single(), owner))
        assertFalse(AppApiJson.encodeToString(result).contains("content://"))
    }

    @Test fun concurrentRestoreWaitsForSameDraftImportAndDoesNotMarkActiveCopyFailed() = runBlocking {
        pendingDraft("first")
        val drafts = RoomCaptureDraftStore(db); val resources = store()
        val importer = DraftResourceImports(drafts, resources)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val copy = async { importer.consume("import-draft", owner, { id, budget ->
            entered.complete(Unit); release.await()
            resources.importStream("first.csv", "text/csv", null, owner, id, budget) { ByteArrayInputStream(bytes) }
        }) }
        entered.await()
        val restore = async { importer.restore("import-draft", owner) }
        yield(); assertFalse(restore.isCompleted)
        release.complete(Unit)
        assertEquals(copy.await(), restore.await())
        assertTrue(restore.await().input.imports.isEmpty())
    }

    @Test fun cancelledBatchKeepsCopiedFileAndExplicitlyFailsUnstartedSlot() = runBlocking {
        pendingDraft("first", "second")
        val drafts = RoomCaptureDraftStore(db); val resources = store()
        val importer = DraftResourceImports(drafts, resources)
        val entered = CompletableDeferred<Unit>()
        val job = launch { importer.consume("import-draft", owner, { id, budget ->
            if (id == "second") { entered.complete(Unit); awaitCancellation() }
            resources.importStream("first.csv", "text/csv", null, owner, id, budget) { ByteArrayInputStream(bytes) }
        }) }
        entered.await(); withTimeout(5000) { job.cancelAndJoin() }
        val result = importer.restore("import-draft", owner)
        assertEquals(listOf("first"), result.input.resources.map { it.resourceId })
        assertEquals(ApiErrorCode.CANCELLED, result.input.imports.single().error)
        assertArrayEquals(bytes, resources.read(result.input.resources.single(), owner))
    }

    @Test fun smallerBatchByteBudgetAndForeignDraftFailBeforeAnyReadyReference() = runBlocking {
        val resources = store()
        try { resources.importStream("sample.csv", "text/csv", null, owner, "bounded", 4) { ByteArrayInputStream(bytes) }; fail("Actual body exceeds remaining budget") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.INVALID_ARGUMENT, error.error.code) }
        assertEquals(CaptureResourceState.FAILED, resources.get("bounded", owner)!!.state)
        assertFalse(privateFile("bounded").exists())
        pendingDraft("first")
        var calls = 0
        try { DraftResourceImports(RoomCaptureDraftStore(db), resources).consume("import-draft", other,
            { _, _ -> calls++; error("Must not read another caller's source") }); fail("Foreign draft denied") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, error.error.code) }
        assertEquals(0, calls)
    }
}
