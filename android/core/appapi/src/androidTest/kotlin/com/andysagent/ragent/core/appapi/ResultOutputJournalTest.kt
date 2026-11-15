package com.andysagent.ragent.core.appapi

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID

/** Real Room/filesystem; only the fixed PC carrier is replaced. */
@RunWith(AndroidJUnit4::class)
class ResultOutputJournalTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), AppApiDatabase::class.java)
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var db: AppApiDatabase
    private val caller = VerifiedCaller("external")
    private var timestamp = 1L
    private var granted = true
    private var paired = true
    private var bytes = ByteArray(1_100_017) { it.toByte() }
    private val requests = mutableListOf<ApiRequest>()
    private var beforeChunk: suspend (Int) -> Unit = {}
    private val exportRevision = "b".repeat(64)
    private val resourceId = "fasset_${"c".repeat(24)}"
    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).hex()
    private fun manifest() = ResultExportManifest(1, "pc-b", "session", "request", "run", "final-run",
        listOf(ResultExportResource("text", "result.txt", "text/plain", true, 0, EMPTY_OUTPUT_SHA256),
            ResultExportResource(resourceId, "手机报告.bin", "application/octet-stream", true, bytes.size.toLong(), sha(bytes))),
        bytes.size.toLong(), 65_536, "2099-01-01T00:00:00Z", exportRevision)
    private fun operation() = TaskOperation("op", caller.binding, "hash", "prep", "pc-b",
        TaskRequest("op", "Synthetic task", TaskRuntime("tool")), "create", "request", 0, 10,
        stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", resultExport = manifest())

    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        root = File(app.cacheDir, "result-output-test-${UUID.randomUUID()}").apply { mkdirs() }
        context = object : ContextWrapper(app) {
            override fun getApplicationContext() = this
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
        }
        db = open()
    }
    private fun open() = Room.databaseBuilder(context, AppApiDatabase::class.java, File(root, "journal.db").absolutePath)
        .addMigrations(AppApiDatabase.MIGRATION_1_2, AppApiDatabase.MIGRATION_2_3, AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
    @After fun teardown() {
        db.close()
        val app = ApplicationProvider.getApplicationContext<Context>()
        assertTrue(root.name.startsWith("result-output-test-"))
        assertTrue(root.canonicalPath.startsWith(app.cacheDir.canonicalPath + File.separator))
        root.deleteRecursively()
    }
    private val carrier = object : RagentTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
        override suspend fun execute(request: ApiRequest): ApiResponse {
            requests += request
            assertEquals("GET", request.method)
            val body = if (request.path == "/api/result-export-contract") buildJsonObject {
                put("version", 1); put("maxChunkBytes", 65_536); put("maxTextBytes", 26_214_400)
                put("maxFileBytes", 26_214_400); put("maxBatchBytes", 104_857_600); put("maxResources", 17); put("snapshotTtlMs", 900_000)
            } else {
                assertTrue(request.path.startsWith("/api/sessions/session/message-results/request/exports/$resourceId?"))
                val parameters = request.path.substringAfter('?').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
                assertEquals(exportRevision, parameters.getValue("revision"))
                val offset = parameters.getValue("offset").toInt(); val length = parameters.getValue("length").toInt()
                beforeChunk(offset)
                val chunk = bytes.copyOfRange(offset, minOf(offset + length, bytes.size))
                buildJsonObject {
                    put("exportContractVersion", 1); put("instanceId", "pc-b"); put("sessionId", "session"); put("requestId", "request")
                    put("runId", "run"); put("finalRunId", "final-run"); put("revision", exportRevision); put("resourceId", resourceId)
                    put("offset", offset); put("nextOffset", offset + chunk.size); put("eof", offset + chunk.size == bytes.size)
                    put("sizeBytes", bytes.size); put("sha256", sha(bytes)); put("chunkSha256", sha(chunk))
                    put("dataBase64", Base64.getEncoder().encodeToString(chunk))
                }
            }
            return ApiResponse(200, body.toString())
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = error("Not owned by download")
    }
    private fun coordinator(): TaskCoordinator {
        val access = object : TargetTaskAccess {
            override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                assertEquals("pc-b", instanceId)
                val client = ResultExportClient(instanceId, carrier, now = { timestamp })
                return block(object : TaskTarget {
                    override suspend fun createSession(operation: TaskOperation): String = error("No create during download")
                    override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt = error("No dispatch")
                    override suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt? = error("No reconcile")
                    override suspend fun streamResultExport(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
                        checkAccess: suspend () -> Unit, prefix: ResultExportPrefix?, sink: suspend (ByteArray) -> Unit) =
                        client.stream(operation, manifest, resourceId, checkAccess, prefix, sink)
                })
            }
        }
        return TaskCoordinator(RoomOperationStore(db), { TargetDirectorySnapshot(
            if (paired) listOf(ApiTarget("pc-b", "Original")) else emptyList(), "pc-a") },
            GrantAuthorizer("owner", { if (granted) listOf(CallerGrant(caller.binding,
                setOf(CapabilityRegistry.TASKS_RESULT_EXPORT), setOf("pc-b"), Long.MAX_VALUE, sessionIds = setOf("session"))) else emptyList() },
                now = { timestamp }), access, now = { timestamp })
    }
    private fun store(maximumBytes: Long = 256L * 1024 * 1024, maximumFiles: Int = 64) =
        PersistentResultOutputs(context, db, coordinator(), now = { timestamp }, maximumBytes = maximumBytes, maximumFiles = maximumFiles)
    private fun file(id: String, suffix: String) = File(context.noBackupFilesDir, "ragent-result-outputs/$id.$suffix")
    private suspend fun seed() { assertTrue(RoomOperationStore(db).insert(operation())) }
    private suspend fun download(store: PersistentResultOutputs = store(), id: String = "download") =
        store.download("op", caller, exportRevision, resourceId, id)
    private suspend fun expect(code: ApiErrorCode, block: suspend () -> Unit) {
        try { block(); fail("Expected $code") } catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
    }
    private suspend fun seedCheckpoint(id: String, state: ResultOutputState, length: Int, verified: Boolean = false) {
        val record = ResultOutput(id, "op", caller.binding, manifest(), resourceId, timestamp, timestamp, state = state,
            receivedBytes = length.toLong(), prefixSha256 = sha(bytes.copyOfRange(0, length)), verifiedAt = if (verified) timestamp else null)
        assertTrue(db.outputs().insert(record.entity()) != -1L)
        file(id, "part").parentFile!!.mkdirs(); file(id, "part").writeBytes(bytes.copyOfRange(0, length))
    }

    @Test fun fullBinarySurvivesReopenAndOfflineRetentionButNotRevokedGrant() = runBlocking {
        seed(); var store = store(); val ready = download(store)
        assertEquals(ResultOutputState.READY, ready.state); assertEquals(sha(bytes), ready.prefixSha256)
        assertEquals(bytes.size.toLong(), ready.receivedBytes); assertFalse(file("download", "part").exists())
        assertTrue(file("download", "bin").canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + File.separator))
        assertArrayEquals(bytes, file("download", "bin").readBytes())
        db.close(); db = open(); store = store(); assertEquals(ready, store.get("download", caller))
        paired = false; timestamp = java.time.Instant.parse(ready.manifest.expiresAt).toEpochMilli() + 1
        val before = requests.size; val output = ByteArrayOutputStream()
        store.copyReady("download", caller) { output.write(it) }; assertArrayEquals(bytes, output.toByteArray())
        assertEquals(ready, download(store)); assertEquals(before, requests.size)
        expect(ApiErrorCode.PERMISSION_DENIED) { store.copyReady("download", VerifiedCaller("other")) { fail("foreign bytes") } }
        granted = false
        expect(ApiErrorCode.PERMISSION_DENIED) { store.copyReady("download", caller) { fail("revoked bytes") } }
    }
    @Test fun emptyResourceHasVerifiedPrivateFileAndRemoteEof() = runBlocking {
        bytes = byteArrayOf(); seed(); val ready = download()
        assertEquals(ResultOutputState.READY, ready.state); assertEquals(EMPTY_OUTPUT_SHA256, ready.prefixSha256)
        assertEquals(0L, file("download", "bin").length()); assertEquals(1, requests.count { '?' in it.path })
    }
    @Test fun cancelledTransferResumesExactCheckpointAndDiscardsUnacknowledgedCrashTail() = runBlocking {
        seed(); beforeChunk = { if (it >= 32_768) throw CancellationException("Stop local transfer") }
        try { download(); fail("Expected cancellation") } catch (_: CancellationException) { }
        val partial = store().get("download", caller)!!
        assertEquals(ResultOutputState.PARTIAL, partial.state); assertEquals(32_768L, partial.receivedBytes)
        assertNull(partial.verifiedAt); assertFalse(file("download", "bin").exists())
        file("download", "part").appendBytes(byteArrayOf(99, 98))
        db.close(); db = open(); val repaired = store().recover("download", caller)!!
        assertEquals(32_768L, file("download", "part").length()); assertEquals(partial.prefixSha256, repaired.prefixSha256)
        beforeChunk = {}; requests.clear(); val ready = download()
        assertEquals(ResultOutputState.READY, ready.state); assertArrayEquals(bytes, file("download", "bin").readBytes())
        assertTrue(requests.first { '?' in it.path }.path.contains("offset=32768&"))
        assertTrue(requests.all { it.method == "GET" })
    }
    @Test fun fullCheckpointWithoutVerificationMarkerStillNeedsRemoteEof() = runBlocking {
        bytes = "完整报告🙂".toByteArray(); seed()
        seedCheckpoint("download", ResultOutputState.DOWNLOADING, bytes.size)
        assertEquals(ResultOutputState.PARTIAL, store().recover("download", caller)!!.state)
        assertTrue(requests.isEmpty()); assertFalse(file("download", "bin").exists())
        val ready = download(); assertEquals(ResultOutputState.READY, ready.state)
        assertEquals(1, requests.count { '?' in it.path }); assertTrue(requests.last().path.contains("offset=${bytes.size}&length=1"))
    }
    @Test fun verifiedCommitMarkerRecoversBothSidesOfRenameWithoutPcIo() = runBlocking {
        bytes = "Verified publication".toByteArray(); seed()
        for (id in listOf("before-rename", "after-rename")) {
            seedCheckpoint(id, ResultOutputState.COMMITTING, bytes.size, verified = true)
            if (id == "after-rename") assertTrue(file(id, "part").renameTo(file(id, "bin")))
        }
        db.close(); db = open(); paired = false
        for (id in listOf("before-rename", "after-rename")) {
            assertEquals(ResultOutputState.READY, store().recover(id, caller)!!.state)
            assertArrayEquals(bytes, file(id, "bin").readBytes()); assertFalse(file(id, "part").exists())
        }
        assertTrue(requests.isEmpty())
    }
    @Test fun corruptedPrefixAndVerifiedFileBecomeFailedAndNeverPublishBytes() = runBlocking {
        bytes = "Known bytes".toByteArray(); seed()
        seedCheckpoint("prefix", ResultOutputState.PARTIAL, 3); file("prefix", "part").writeBytes(byteArrayOf(0, 0, 0))
        seedCheckpoint("commit", ResultOutputState.COMMITTING, bytes.size, verified = true)
        file("commit", "part").writeBytes(ByteArray(bytes.size))
        for (id in listOf("prefix", "commit")) {
            assertEquals(ResultOutputState.FAILED, store().recover(id, caller)!!.state)
            assertFalse(file(id, "bin").exists()); assertFalse(file(id, "part").exists())
        }
        val ready = download(); file(ready.downloadId, "bin").writeBytes(ByteArray(bytes.size))
        expect(ApiErrorCode.REVISION_CONFLICT) { store().copyReady(ready.downloadId, caller) { fail("Corrupt bytes") } }
        assertEquals(ResultOutputState.FAILED, store().recover(ready.downloadId, caller)!!.state)
        assertTrue(requests.all { it.method == "GET" })
    }
    @Test fun deletionTombstoneSurvivesReopenAndQuotaNeverEvictsCompletedReports() = runBlocking {
        bytes = ByteArray(10) { it.toByte() }; seed(); val limited = store(maximumFiles = 1)
        val ready = download(limited)
        expect(ApiErrorCode.RESOURCE_LIMIT) { download(limited, "second") }
        assertTrue(file("download", "bin").exists()); assertEquals(0, limited.cleanupPartials(caller, Long.MAX_VALUE))
        assertFalse(limited.delete("download", caller, ready.revision + 1))
        assertTrue(limited.delete("download", caller, ready.revision)); assertFalse(file("download", "bin").exists())
        file("download", "bin").writeBytes(bytes) // Crash/remnant after durable tombstone.
        db.close(); db = open()
        assertEquals(ResultOutputState.DELETED, store().recover("download", caller)!!.state)
        assertFalse(file("download", "bin").exists()); assertTrue(store().list(caller).isEmpty())
        expect(ApiErrorCode.CANCELLED) { download() }
        assertEquals(ResultOutputState.READY, download(store(maximumFiles = 1), "second").state)
    }
    @Test fun byteBudgetAndChangedDownloadIdentityFailBeforeTransfer() = runBlocking {
        bytes = ByteArray(10); seed()
        expect(ApiErrorCode.RESOURCE_LIMIT) { download(store(maximumBytes = 9)) }; assertTrue(requests.isEmpty())
        seedCheckpoint("download", ResultOutputState.PARTIAL, 0)
        expect(ApiErrorCode.REVISION_CONFLICT) { store().download("op", caller, "c".repeat(64), resourceId, "download") }
        expect(ApiErrorCode.REVISION_CONFLICT) { store().download("different-op", caller, exportRevision, resourceId, "download") }
        expect(ApiErrorCode.PERMISSION_DENIED) { store().download("op", VerifiedCaller("other"), exportRevision, resourceId, "download") }
        assertTrue(requests.isEmpty()); assertEquals(0L, file("download", "part").length())
    }
    @Test fun secondStoreCannotStealActiveWriterAndReadRevocationStopsAfterFirstBlock() = runBlocking {
        seed(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        beforeChunk = { entered.complete(Unit); release.await() }
        val writer = async(Dispatchers.IO) { download() }
        try {
            withTimeout(15_000) { entered.await() }
            expect(ApiErrorCode.REVISION_CONFLICT) { download(store()) }
            assertEquals(0, store().cleanupOrphans(Long.MAX_VALUE))
        } finally { beforeChunk = {}; release.complete(Unit) }
        val ready = withTimeout(15_000) { writer.await() }
        var delivered = 0
        expect(ApiErrorCode.PERMISSION_DENIED) { store().copyReady(ready.downloadId, caller) { delivered++; granted = false } }
        assertEquals(1, delivered); granted = true
        assertEquals(ResultOutputState.READY, store().get(ready.downloadId, caller)!!.state)
    }
    @Test fun grantRevokedDuringDownloadPreservesOnlyPrivatePartialAndUnpairedResumeDoesNoIo() = runBlocking {
        seed(); beforeChunk = { if (it >= 16_384) granted = false }
        expect(ApiErrorCode.PERMISSION_DENIED) { download() }
        val partial = db.outputs().get("download")!!.decodeOutput()
        assertEquals(ResultOutputState.PARTIAL, partial.state); assertEquals(16_384L, partial.receivedBytes)
        assertNull(partial.verifiedAt); assertFalse(file("download", "bin").exists())
        granted = true; beforeChunk = {}; paired = false; val before = requests.size
        expect(ApiErrorCode.TARGET_NOT_FOUND) { download() }; assertEquals(before, requests.size)
        assertEquals(16_384L, file("download", "part").length())
        paired = true; assertEquals(ResultOutputState.READY, download().state)
    }
    @Test fun callerScopedPartialCleanupRetainsReadyOutputAndSymlinkCannotReadOtherFiles() = runBlocking {
        bytes = "Known bytes".toByteArray(); seed(); val ready = download()
        seedCheckpoint("partial", ResultOutputState.PARTIAL, 3)
        timestamp = 10
        assertEquals(1, store().cleanupPartials(caller, timestamp))
        assertEquals(ResultOutputState.READY, store().get(ready.downloadId, caller)!!.state)
        assertTrue(file(ready.downloadId, "bin").exists()); assertFalse(file("partial", "part").exists())
        seedCheckpoint("link", ResultOutputState.PARTIAL, 3)
        val unrelated = File(root, "unrelated.bin").apply { writeBytes(byteArrayOf(9, 8, 7)) }
        assertTrue(file("link", "part").delete())
        java.nio.file.Files.createSymbolicLink(file("link", "part").toPath(), unrelated.toPath())
        val before = requests.size
        expect(ApiErrorCode.REVISION_CONFLICT) { store().recover("link", caller) }
        assertArrayEquals(byteArrayOf(9, 8, 7), unrelated.readBytes()); assertEquals(before, requests.size)
    }
    @Test fun orphanMaintenanceRetainsReferencedFilesAndLockInodes() = runBlocking {
        bytes = "Synthetic report".toByteArray(); seed(); val ready = download()
        seedCheckpoint("partial", ResultOutputState.PARTIAL, 3)
        file("orphan", "part").writeBytes(byteArrayOf(1, 2)); file("orphan", "bin").writeBytes(byteArrayOf(3))
        val locks = file("download", "bin").parentFile!!.listFiles()!!.filter { it.name.endsWith(".lock") }
        assertTrue(locks.isNotEmpty()); assertEquals(2, store().cleanupOrphans(Long.MAX_VALUE))
        assertTrue(file(ready.downloadId, "bin").exists()); assertTrue(file("partial", "part").exists())
        assertTrue(locks.all { it.exists() }); assertEquals(0, store().cleanupOrphans(Long.MAX_VALUE))
    }
    @Test fun v3MigrationPreservesOperationsDraftsAndResourcePins() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<Context>(); val name = "result-migration-${UUID.randomUUID()}.db"
        val operation = operation(); val draft = CaptureDraft("legacy-draft", caller.binding, 1, input = CaptureInput("Original"))
        val resources = PersistentCaptureResources(context, db)
        val originalResource = resources.importStream("original.bin", "application/octet-stream", null, caller) {
            java.io.ByteArrayInputStream(bytes)
        }
        val legacyResource = db.resources().get(originalResource.resourceId, caller.binding)!!
        migration.createDatabase(name, 3).use { old ->
            old.execSQL("INSERT INTO api_operations VALUES (?, ?, ?, ?, ?)", arrayOf(operation.operationId, operation.preparationId,
                caller.binding, operation.revision, AppApiJson.encodeToString(operation)))
            old.execSQL("INSERT INTO capture_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?)", arrayOf(draft.draftId, caller.binding, 1, 1, 0, null, null,
                AppApiJson.encodeToString(draft)))
            old.execSQL("INSERT INTO capture_resources VALUES (?, ?, ?, ?, ?)", arrayOf(legacyResource.resourceId, caller.binding,
                legacyResource.state, legacyResource.revision, legacyResource.payload))
            old.execSQL("INSERT INTO capture_resource_bindings VALUES (?, ?, ?)", arrayOf("operation:op", legacyResource.resourceId, caller.binding))
        }
        migration.runMigrationsAndValidate(name, 4, true, AppApiDatabase.MIGRATION_3_4).close()
        val migrated = Room.databaseBuilder(app, AppApiDatabase::class.java, name).addMigrations(AppApiDatabase.MIGRATION_3_4, AppApiDatabase.MIGRATION_4_5, AppApiDatabase.MIGRATION_5_6, AppApiDatabase.MIGRATION_6_7).build()
        try {
            assertEquals(operation, RoomOperationStore(migrated).get("op"))
            assertEquals(draft, RoomCaptureDraftStore(migrated).get(draft.draftId, caller))
            assertEquals(0, migrated.outputs().liveCount())
            assertEquals(legacyResource, migrated.resources().get(originalResource.resourceId, caller.binding))
            val reopenedResources = PersistentCaptureResources(context, migrated)
            assertEquals(originalResource, reopenedResources.get(originalResource.resourceId, caller))
            assertArrayEquals(bytes, reopenedResources.read(originalResource.reference(), caller))
            migrated.openHelper.writableDatabase.query("SELECT COUNT(*) FROM capture_resource_bindings").use {
                assertTrue(it.moveToFirst()); assertEquals(1, it.getInt(0))
            }
        } finally { migrated.close(); app.deleteDatabase(name) }
    }
}
