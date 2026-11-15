package com.andysagent.ragent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Process
import android.provider.OpenableColumns
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Production runtime/provider and actual different-UID fixture; synthetic source output only. */
@RunWith(AndroidJUnit4::class)
class ResultShareProviderTest {
    private lateinit var context: Context
    private lateinit var graph: AndroidRuntimeGraph
    private lateinit var db: AppApiDatabase
    private lateinit var operationId: String
    private lateinit var downloadId: String
    private lateinit var sourceFile: File
    private var ticket: ResultDeliveryRef? = null
    private val observations = mutableListOf<Uri>()
    private val documents = mutableListOf<Uri>()
    private val fixture = "com.agentoncloud.android.sharefixture"
    private val bytes = "真实不同 UID 文件接收测试🙂\n".repeat(4000).toByteArray()
    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it.toInt() and 255) }
    @Before fun setup() = runBlocking {
        context = ApplicationProvider.getApplicationContext<Context>()
        graph = (context as RagentApplication).runtime
        db = AppApiDatabase.open(context)
        val id = UUID.randomUUID().toString(); operationId = "delivery-qa-$id"; downloadId = "qa-$id"
        val manifest = ResultExportManifest(1, "qa-pc-$id", "qa-session-$id", "qa-request-$id", "qa-run-$id", "qa-final-$id",
            // Deliberately mismatched extension: provider MIME must come from authorized metadata.
            listOf(ResultExportResource("text", "报告-$id.bin", "text/plain", true, bytes.size.toLong(), sha(bytes))),
            bytes.size.toLong(), 65_536, "2099-01-01T00:00:00Z", "b".repeat(64))
        val operation = TaskOperation(operationId, graph.appApiOwner.binding, "hash", "prep-$id", manifest.instanceId,
            TaskRequest(operationId, "Synthetic result output QA", TaskRuntime("tool")), "create-$id", manifest.requestId, 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = manifest.sessionId, runId = manifest.runId, resultExport = manifest)
        assertTrue(RoomOperationStore(db).insert(operation))
        val output = ResultOutput(downloadId, operationId, graph.appApiOwner.binding, manifest, "text", 1, 1,
            state = ResultOutputState.READY, receivedBytes = bytes.size.toLong(), prefixSha256 = sha(bytes), verifiedAt = 1)
        assertTrue(db.outputs().insert(ResultOutputEntity(downloadId, operationId, graph.appApiOwner.binding, "READY", 0,
            bytes.size.toLong(), 1, AppApiJson.encodeToString(output))) != -1L)
        sourceFile = File(context.noBackupFilesDir, "ragent-result-outputs/$downloadId.bin")
        sourceFile.parentFile!!.mkdirs(); sourceFile.writeBytes(bytes)
        ticket = graph.resultDeliveryAndroid.stage(downloadId)
    }
    @After fun cleanup() = runBlocking {
        ticket?.let { graph.resultDeliveryAndroid.revoke(it.id) }
        observations.forEach { context.contentResolver.delete(it, null, null) }
        documents.forEach { context.contentResolver.delete(it, null, null) }
        withContext(Dispatchers.IO) {
            db.openHelper.writableDatabase.execSQL("DELETE FROM result_outputs WHERE downloadId = ?", arrayOf(downloadId))
            db.openHelper.writableDatabase.execSQL("DELETE FROM api_operations WHERE operationId = ?", arrayOf(operationId))
        }
        sourceFile.delete(); db.close()
    }
    private fun uri() = graph.resultDeliveryAndroid.uri(ticket!!)
    private suspend fun probe(grant: Boolean, id: String = ticket!!.id, document: Boolean = false, failDocument: Boolean = false, documentKind: String = "ready", observationId: String? = null): JSONObject {
        val reference = graph.resultDeliveries.list(operationId, graph.appApiOwner).firstOrNull { it.id == id } ?: ticket!!
        val intent = if (grant) graph.resultDeliveryAndroid.shareIntent(id) else Intent("com.agentoncloud.android.qa.RESULT_PROBE").putExtra(Intent.EXTRA_STREAM, graph.resultDeliveryAndroid.uri(reference))
        val probeId = observationId ?: UUID.randomUUID().toString()
        val observation = Uri.parse("content://$fixture.result-probe/$probeId"); observations += observation
        if (observationId != null) context.contentResolver.delete(observation, null, null)
        intent.component = ComponentName(fixture, "com.andysagent.ragent.sharefixture.ResultReceiverFixtureActivity")
        intent.putExtra("probeId", probeId); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        intent.putExtra("grantDocument", document); intent.putExtra("failDocument", failDocument)
        if (documentKind != "ready") intent.putExtra("documentKind", documentKind)
        intent.putExtra("probeWorkerBind", true)
        ActivityScenario.launch<AppApiSettingsActivity>(Intent(context, AppApiSettingsActivity::class.java)).use {
            context.startActivity(intent)
            return withTimeout(15_000) {
                while (true) {
                    val result = context.contentResolver.query(observation, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) JSONObject(cursor.getString(0)) else null
                    }
                    if (result != null) return@withTimeout result
                    delay(100)
                }
                @Suppress("UNREACHABLE_CODE") error("No fixture result")
            }
        }
    }
    @Test fun differentUidReadsExactBytesAndMetadataButCannotWriteOrReadSibling() = runBlocking {
        val response = probe(true)
        assertTrue(response.toString(), response.getBoolean("workerBindDenied"))
        assertNotEquals(Process.myUid(), response.getInt("uid"))
        assertTrue(response.toString(), response.getBoolean("read"))
        println("Synthetic result receiver observation: $response")
        assertTrue("Fixture must exercise a MIME/extension mismatch", response.getString("name").endsWith(".bin"))
        assertEquals(sha(bytes), response.getString("sha256")); assertEquals(bytes.size.toLong(), response.getLong("bytes"))
        assertEquals(ticket!!.name, response.getString("name")); assertEquals("text/plain", response.getString("mimeType"))
        assertEquals(bytes.size.toLong(), response.getLong("size")); assertTrue(response.getBoolean("writeDenied")); assertTrue(response.getBoolean("siblingDenied"))
        assertArrayEquals(bytes, sourceFile.readBytes())
    }
    @Test fun noGrantAndRevocationDenyNewDifferentUidOpens() = runBlocking {
        val denied = probe(false); assertFalse(denied.toString(), denied.getBoolean("read")); assertTrue(denied.getBoolean("writeDenied"))
        assertTrue(probe(true).getBoolean("read"))
        graph.resultDeliveryAndroid.revoke(ticket!!.id)
        val revoked = probe(false); assertFalse(revoked.toString(), revoked.getBoolean("read"))
        assertArrayEquals(bytes, sourceFile.readBytes())
    }
    @Test fun ownerProviderChecksModeExactUriSourceDeletionAndCacheCorruption() = runBlocking {
        assertEquals("text/plain", context.contentResolver.getType(uri()))
        context.contentResolver.query(uri(), null, null, null, null)!!.use { cursor ->
            assertTrue(cursor.moveToFirst()); assertEquals(ticket!!.name, cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)))
        }
        assertTrue(runCatching { context.contentResolver.openFileDescriptor(uri(), "rw")!!.use { } }.isFailure)
        val altered = uri().buildUpon().appendQueryParameter("displayName", "forged.txt").build()
        assertTrue(runCatching { context.contentResolver.openInputStream(altered)!!.use { } }.isFailure)
        val path = File(context.cacheDir, "result-shares/${ticket!!.id}/${ticket!!.name}")
        path.writeBytes(ByteArray(bytes.size))
        assertTrue(runCatching { context.contentResolver.openInputStream(uri())!!.use { } }.isFailure)
        path.writeBytes(bytes)
        assertTrue(graph.resultOutputs.delete(downloadId, graph.appApiOwner, 0))
        assertTrue(runCatching { context.contentResolver.openInputStream(uri())!!.use { } }.isFailure)
    }
    @Test fun safAdapterRejectsUnselectedUriWithoutTruncatingOrDeletingOriginal() = runBlocking {
        assertTrue(runCatching { graph.resultDeliveryAndroid.saveToDocument(ticket!!.id, Uri.fromFile(sourceFile)) }.isFailure)
        assertTrue(runCatching { graph.resultDeliveryAndroid.saveToDocument(ticket!!.id, uri()) }.isFailure)
        assertArrayEquals(bytes, sourceFile.readBytes())
        assertEquals(ResultOutputState.READY, graph.resultOutputs.get(downloadId, graph.appApiOwner)!!.state)
    }
    @Test fun revocationDeniesNewOpensButCannotRetractAnAlreadyOpenedDescriptor() = runBlocking {
        val descriptor = context.contentResolver.openFileDescriptor(uri(), "r")!!
        android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
            graph.resultDeliveryAndroid.revoke(ticket!!.id)
            assertTrue(runCatching { context.contentResolver.openInputStream(uri())!!.use { } }.isFailure)
            assertArrayEquals(bytes, input.readBytes())
        }
        assertArrayEquals(bytes, sourceFile.readBytes())
    }
    @Test fun grantedDifferentUidDocumentReceivesExactBytesAndProviderFailureKeepsOriginal() = runBlocking {
        val response = probe(false, document = true)
        assertNotEquals(Process.myUid(), response.getInt("uid"))
        val document = Uri.parse(response.getString("documentUri")); documents += document
        assertEquals(ticket, graph.resultDeliveryAndroid.saveToDocument(ticket!!.id, document))
        context.contentResolver.openInputStream(document)!!.use { assertArrayEquals(bytes, it.readBytes()) }
        val failed = Uri.parse(probe(false, document = true, failDocument = true).getString("documentUri")); documents += failed
        assertTrue(runCatching { graph.resultDeliveryAndroid.saveToDocument(ticket!!.id, failed) }.isFailure)
        assertArrayEquals(bytes, sourceFile.readBytes())
        assertEquals(ResultOutputState.READY, graph.resultOutputs.get(downloadId, graph.appApiOwner)!!.state)
    }
    @Test fun expiryDeniesExistingForeignGrantAndMaintenanceKeepsOriginal() = runBlocking {
        assertTrue(probe(true).getBoolean("read"))
        val metadata = File(context.noBackupFilesDir, "ragent-result-deliveries/${ticket!!.id}.json")
        val saved = AppApiJson.decodeFromString<ResultDeliveryTicket>(metadata.readText())
        val timestamp = System.currentTimeMillis()
        metadata.writeText(AppApiJson.encodeToString(saved.copy(createdAt = timestamp - 120_000, expiresAt = timestamp - 60_000)))
        assertFalse(probe(false).getBoolean("read"))
        graph.resultDeliveryAndroid.cleanupExpired()
        assertFalse(metadata.exists()); assertFalse(File(context.cacheDir, "result-shares/${ticket!!.id}/${ticket!!.name}").exists())
        assertArrayEquals(bytes, sourceFile.readBytes())
        assertEquals(ResultOutputState.READY, graph.resultOutputs.get(downloadId, graph.appApiOwner)!!.state)
    }
    private suspend fun selectedDocument(kind: String): Uri {
        val response = probe(false, document = true, documentKind = kind)
        assertNotEquals(Process.myUid(), response.getInt("uid"))
        assertTrue(response.getBoolean("workerBindDenied"))
        return Uri.parse(response.getString("documentUri")).also { documents += it }
    }
    private fun observation(document: Uri): JSONObject = context.contentResolver.query(document, null, null, null, null)!!.use {
        check(it.moveToFirst()); JSONObject(it.getString(0))
    }
    private suspend fun blocked(document: Uri, phase: String): JSONObject = withTimeout(15_000) {
        while (true) {
            val row = observation(document)
            if (row.getString("phase") == phase) return@withTimeout row
            delay(100)
        }
        @Suppress("UNREACHABLE_CODE") error("No blocked document phase")
    }
    private fun workerAlive(pid: Int): Boolean = !documentWorkerExited(pid)
    private suspend fun workerLeaseFree() = DocumentWorkerLease(context).withLease(ticket!!.id, { false }) { true }
    private suspend fun awaitWorkerExit(pid: Int) = withTimeout(10_000) { while (workerAlive(pid) || !workerLeaseFree()) delay(25) }
    private suspend fun workerCopy(document: Uri, timeout: Long = 30_000, overrideDigest: String? = null): ResultDeliveryRef =
        graph.documentSaves.copy(operationId, ticket!!.id, graph.appApiOwner) {
            graph.resultDeliveries.withSharedFileChecked(ticket!!.id, graph.appApiOwner) { ref, file, digest, reauthorize ->
                DocumentExportClient(context, timeout).copy(ref, file, document, overrideDigest ?: digest, reauthorize)
            }
        }
    private suspend fun cancelBlocked(kind: String) = coroutineScope {
        val document = selectedDocument(kind)
        graph.documentSaves.prepare(operationId, ticket!!.id, graph.appApiOwner)
        val writing = launch(Dispatchers.IO) { workerCopy(document) }
        val state = blocked(document, kind.replace("block-", "blocked-"))
        val pid = state.getInt("pid")
        assertEquals(Process.myUid(), state.getInt("uid")); assertNotEquals(Process.myPid(), pid)
        assertTrue(workerAlive(pid)); assertTrue(writing.isActive)
        assertEquals(DocumentSaveState.COPYING, graph.documentSaves.list(operationId, graph.appApiOwner, true).single().state)
        val started = android.os.SystemClock.elapsedRealtime()
        writing.cancelAndJoin()
        assertTrue("Cancellation must finish before provider releases", android.os.SystemClock.elapsedRealtime() - started < 10_000)
        val pendingExit = workerAlive(pid) || !workerLeaseFree()
        val beforeRelease = graph.documentSaves.list(operationId, graph.appApiOwner, true).single()
        if (pendingExit) {
            assertEquals("Uninterruptible provider cannot be reported stopped", DocumentSaveState.COPYING, beforeRelease.state)
            assertTrue(DocumentWorkerLease(context).withLease(ticket!!.id, { true }) { false })
        } else assertEquals(DocumentSaveState.INTERRUPTED, beforeRelease.state)
        // Complete the foreign provider's already outstanding syscall, then prove actual exit and recovery.
        context.contentResolver.delete(document, null, null)
        awaitWorkerExit(pid)
        val saved = graph.documentSaves.list(operationId, graph.appApiOwner, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, saved.state); assertTrue(saved.copyStarted)
        assertEquals(if (pendingExit) ApiErrorCode.RESULT_UNKNOWN else ApiErrorCode.CANCELLED, saved.error)
        assertEquals(1, observation(document).getInt("opens"))
        assertArrayEquals(bytes, sourceFile.readBytes())
        println("Blocked document $kind: workerPid=$pid mainPid=${Process.myPid()} pendingExit=$pendingExit state=${saved.state} error=${saved.error}")
        graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
    }
    @Test fun cancelDuringDifferentUidProviderOpenTerminatesOnlyWorker() = runBlocking { cancelBlocked("block-open") }
    @Test fun cancelDuringDifferentUidProviderWriteDefersStateUntilActualWorkerExit() = runBlocking { cancelBlocked("block-write") }
    @Test fun cancelDuringDifferentUidProviderFsyncDefersStateUntilActualWorkerExit() = runBlocking { cancelBlocked("block-fsync") }
    @Test fun blockedProviderDeadlineRecordsInterruptionAndKeepsOriginal() = runBlocking {
        val document = selectedDocument("block-open")
        graph.documentSaves.prepare(operationId, ticket!!.id, graph.appApiOwner)
        val deathWindow = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("documentWorkerDeathWindow") == "true"
        val marker = File(context.filesDir, "qa-document-worker-window.json")
        if (deathWindow) marker.delete()
        val writing = async(Dispatchers.IO) { runCatching { workerCopy(document, if (deathWindow) 60_000 else 8_000) } }
        val state = blocked(document, "blocked-open")
        if (deathWindow) {
            val original = RoomOperationStore(db).get(operationId)!!
            marker.writeText(JSONObject().put("parentPid", Process.myPid()).put("workerPid", state.getInt("pid"))
                .put("operationId", operationId).put("downloadId", downloadId).put("ticketId", ticket!!.id)
                .put("documentProbeId", document.lastPathSegment).put("sha256", sha(bytes)).put("sizeBytes", bytes.size)
                .put("instanceId", original.targetInstanceId).put("sessionId", original.sessionId).put("requestId", original.messageRequestId).toString())
        }
        assertTrue(writing.await().isFailure)
        assertFalse(workerAlive(state.getInt("pid")))
        assertEquals(DocumentSaveState.INTERRUPTED, graph.documentSaves.list(operationId, graph.appApiOwner, true).single().state)
        assertArrayEquals(bytes, sourceFile.readBytes())
        graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
    }
    @Test fun revokedDocumentGrantDuringBlockedWriteRequestsStopAndDefersUnconfirmedExit() = runBlocking {
        val document = selectedDocument("block-write")
        graph.documentSaves.prepare(operationId, ticket!!.id, graph.appApiOwner)
        val writing = async(Dispatchers.IO) { runCatching { workerCopy(document) } }
        val state = blocked(document, "blocked-write")
        // Grant owner revokes without releasing its blocked write callback.
        var pendingExit = false
        try {
            context.contentResolver.delete(document, "revoke", null)
            assertTrue(withTimeout(10_000) { writing.await() }.isFailure)
            pendingExit = workerAlive(state.getInt("pid")) || !workerLeaseFree()
            val saved = graph.documentSaves.list(operationId, graph.appApiOwner, true).single()
            assertEquals(if (pendingExit) DocumentSaveState.COPYING else DocumentSaveState.INTERRUPTED, saved.state)
            if (!pendingExit) assertEquals(ApiErrorCode.PERMISSION_DENIED, saved.error)
            assertArrayEquals(bytes, sourceFile.readBytes())
        } finally {
            // Grant owner restores only the QA URI so its previously blocked callback can be released.
            val regranted = probe(false, document = true, documentKind = "block-write", observationId = document.lastPathSegment)
            assertEquals(document, Uri.parse(regranted.getString("documentUri")))
            context.contentResolver.delete(document, null, null)
        }
        awaitWorkerExit(state.getInt("pid"))
        val recovered = graph.documentSaves.list(operationId, graph.appApiOwner, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, recovered.state)
        assertEquals(if (pendingExit) ApiErrorCode.RESULT_UNKNOWN else ApiErrorCode.PERMISSION_DENIED, recovered.error)
        assertEquals(1, observation(document).getInt("opens"))
        graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
    }
    @Test fun wrongTransferredDigestIsRejectedBeforeExternalOpen() = runBlocking {
        val document = selectedDocument("ready")
        graph.documentSaves.prepare(operationId, ticket!!.id, graph.appApiOwner)
        val failure = runCatching { workerCopy(document, overrideDigest = "0".repeat(64)) }.exceptionOrNull()
        assertTrue(failure is AppApiException); assertEquals(ApiErrorCode.REVISION_CONFLICT, (failure as AppApiException).error.code)
        assertEquals(0, observation(document).getInt("opens"))
        assertEquals(DocumentSaveState.INTERRUPTED, graph.documentSaves.list(operationId, graph.appApiOwner).single().state)
        assertArrayEquals(bytes, sourceFile.readBytes())
        graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
    }
    @Test fun kernelFlagsRejectWritableSourceDescriptorsOnBothProbePaths() {
        android.os.ParcelFileDescriptor.open(sourceFile, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use {
            assertTrue(isReadonlyDocumentSource(it)); assertTrue(isReadonlyDocumentSource(it, legacyProbe = true))
        }
        android.os.ParcelFileDescriptor.open(sourceFile, android.os.ParcelFileDescriptor.MODE_READ_WRITE).use {
            assertFalse(isReadonlyDocumentSource(it)); assertFalse(isReadonlyDocumentSource(it, legacyProbe = true))
        }
        assertArrayEquals(bytes, sourceFile.readBytes())
    }
    @Test fun blockedProviderReleaseCallbackDoesNotMeanClientCloseIsBlocked() = runBlocking {
        val document = selectedDocument("block-release")
        graph.documentSaves.prepare(operationId, ticket!!.id, graph.appApiOwner)
        try {
            assertEquals(ticket, workerCopy(document))
            val state = blocked(document, "blocked-release")
            assertFalse(workerAlive(state.getInt("pid")))
            assertEquals(bytes.size.toLong(), state.getLong("written"))
            assertEquals(DocumentSaveState.SAVED, graph.documentSaves.list(operationId, graph.appApiOwner, true).single().state)
            context.contentResolver.openInputStream(document)!!.use { assertArrayEquals(bytes, it.readBytes()) }
            println("Proxy onRelease is asynchronous: worker exited; bytes=${state.getLong("written")}")
        } finally { context.contentResolver.delete(document, null, null) }
        graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
    }
}
