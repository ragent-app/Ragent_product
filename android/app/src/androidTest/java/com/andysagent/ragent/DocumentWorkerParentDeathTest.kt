package com.andysagent.ragent

import android.content.Context
import android.net.Uri
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.decodeFromString
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** External controller kills the real parent in the marked window; this is its cold-start half. */
class DocumentWorkerParentDeathTest {
    @Test fun coldRecoveryAfterActualParentKillNeverReplaysExternalWrite() = runBlocking {
        assumeTrue("Requires the controlled parent-death window",
            InstrumentationRegistry.getArguments().getString("documentWorkerDeathWindow") == "true")
        val context = ApplicationProvider.getApplicationContext<Context>()
        val graph = (context as RagentApplication).runtime
        val marker = File(context.filesDir, "qa-document-worker-window.json")
        require(marker.length() in 1..8192)
        val seed = JSONObject(marker.readText())
        val ticket = seed.getString("ticketId"); val operationId = seed.getString("operationId"); val downloadId = seed.getString("downloadId")
        require(Regex("[a-f0-9-]{36}").matches(ticket))
        require(operationId.startsWith("delivery-qa-") && downloadId.startsWith("qa-") && !downloadId.contains('/'))
        assertNotEquals("Must be a new parent process", seed.getInt("parentPid"), Process.myPid())
        assertTrue("Worker survived parent death", documentWorkerExited(seed.getInt("workerPid")))
        val metadata = File(context.noBackupFilesDir, "ragent-document-saves/$ticket.json")
        val original = AppApiJson.decodeFromString<DocumentSaveRecord>(metadata.readText())
        assertEquals(DocumentSaveState.COPYING, original.state)
        assertFalse(metadata.readText().contains("content://"))
        val db = AppApiDatabase.open(context)
        try {
            val operation = RoomOperationStore(db).get(operationId)!!
            assertEquals(seed.getString("instanceId"), operation.targetInstanceId)
            assertEquals(seed.getString("sessionId"), operation.sessionId)
            assertEquals(seed.getString("requestId"), operation.messageRequestId)
            val source = File(context.noBackupFilesDir, "ragent-result-outputs/$downloadId.bin")
            val actual = MessageDigest.getInstance("SHA-256").digest(source.readBytes()).joinToString("") { "%02x".format(it.toInt() and 255) }
            assertEquals(seed.getString("sha256"), actual); assertEquals(seed.getLong("sizeBytes"), source.length())
            assertEquals(ResultOutputState.READY, graph.resultOutputs.get(downloadId, graph.appApiOwner)!!.state)
            val recovered = graph.documentSaves.list(operationId, graph.appApiOwner, true).single()
            assertEquals(DocumentSaveState.INTERRUPTED, recovered.state); assertEquals(ApiErrorCode.RESULT_UNKNOWN, recovered.error)
            assertTrue(recovered.copyStarted)
            val document = Uri.parse("content://com.agentoncloud.android.sharefixture.result-document/block-open/${seed.getString("documentProbeId")}")
            assertEquals("Cold recovery must not restore write authority", android.content.pm.PackageManager.PERMISSION_DENIED,
                context.checkUriPermission(document, Process.myPid(), Process.myUid(), android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            val observationUri = Uri.parse("content://com.agentoncloud.android.sharefixture.result-probe/document/${seed.getString("documentProbeId")}")
            context.contentResolver.query(observationUri, null, null, null, null)!!.use {
                assertTrue(it.moveToFirst()); val observation = JSONObject(it.getString(0))
                assertEquals("blocked-open", observation.getString("phase")); assertEquals(1, observation.getInt("opens"))
                assertEquals(seed.getInt("workerPid"), observation.getInt("pid"))
            }
            println("Actual parent kill recovered: oldParent=${seed.getInt("parentPid")} newParent=${Process.myPid()} worker=${seed.getInt("workerPid")} opens=1 sha256=$actual")
            context.contentResolver.delete(observationUri, null, null)
            context.contentResolver.delete(Uri.parse("content://com.agentoncloud.android.sharefixture.result-probe/${seed.getString("documentProbeId")}"), null, null)
            graph.documentSaves.clearFinished(operationId, graph.appApiOwner)
            graph.resultDeliveryAndroid.revoke(ticket)
            db.openHelper.writableDatabase.execSQL("DELETE FROM result_outputs WHERE downloadId = ?", arrayOf(downloadId))
            db.openHelper.writableDatabase.execSQL("DELETE FROM api_operations WHERE operationId = ?", arrayOf(operationId))
            assertTrue(source.delete()); assertTrue(marker.delete())
        } finally { db.close() }
    }
}
