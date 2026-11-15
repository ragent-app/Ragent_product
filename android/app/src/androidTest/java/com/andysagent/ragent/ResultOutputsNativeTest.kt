package com.andysagent.ragent

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Process
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Production Activity + real Android chooser/DocumentsUI. Only the private source is synthetic. */
class ResultOutputsNativeTest {
    private lateinit var context: Context
    private lateinit var graph: AndroidRuntimeGraph
    private lateinit var db: AppApiDatabase
    private lateinit var opId: String
    private lateinit var downloadId: String
    private lateinit var name: String
    private lateinit var source: File
    private val data = "Native Android output 测试🙂\n".repeat(3000).toByteArray()
    private val automation get() = InstrumentationRegistry.getInstrumentation().uiAutomation
    private val observations = mutableListOf<Uri>()
    private val drafts = mutableListOf<String>()
    private val fixture = "com.agentoncloud.android.sharefixture"
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    @Before fun setup() = runBlocking {
        context = ApplicationProvider.getApplicationContext()
        graph = (context as RagentApplication).runtime
        db = AppApiDatabase.open(context)
        val id = UUID.randomUUID().toString()
        opId = "capture_native-draft-$id"; downloadId = "native-$id"; name = "ragent-native-$id.txt"
        val manifest = ResultExportManifest(1, "synthetic-pc-$id", "session-$id", "request-$id", "run-$id", "final-$id",
            listOf(ResultExportResource("text", name, "text/plain", true, data.size.toLong(), sha(data))),
            data.size.toLong(), 65536, "2099-01-01T00:00:00Z", "c".repeat(64))
        val operation = TaskOperation(opId, graph.appApiOwner.binding, "hash", "prep-$id", manifest.instanceId,
            TaskRequest(opId, "Native chooser test", TaskRuntime("tool")), "create-$id", manifest.requestId, 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = manifest.sessionId, runId = manifest.runId, resultExport = manifest)
        assertTrue(RoomOperationStore(db).insert(operation))
        val output = ResultOutput(downloadId, opId, graph.appApiOwner.binding, manifest, "text", 1, 1,
            state = ResultOutputState.READY, receivedBytes = data.size.toLong(), prefixSha256 = sha(data), verifiedAt = 1)
        assertTrue(db.outputs().insert(ResultOutputEntity(downloadId, opId, graph.appApiOwner.binding, "READY", 0,
            data.size.toLong(), 1, AppApiJson.encodeToString(output))) != -1L)
        source = File(context.noBackupFilesDir, "ragent-result-outputs/$downloadId.bin")
        source.parentFile!!.mkdirs(); source.writeBytes(data)
    }
    @After fun cleanup() = runBlocking {
        automation.setRotation(android.app.UiAutomation.ROTATION_UNFREEZE)
        graph.documentSaves.clearFinished(opId, graph.appApiOwner)
        graph.documentSaves.list(opId, graph.appApiOwner).filter { it.state == DocumentSaveState.WAITING_SELECTION }.forEach {
            // Exact synthetic test ticket, after its ActivityScenario has closed. No copy lease is active.
            File(context.noBackupFilesDir, "ragent-document-saves/${it.ticketId}.json").delete()
        }
        graph.resultDeliveryAndroid.revokeForOutput(downloadId)
        observations.forEach { context.contentResolver.delete(it, null, null) }
        // Exact synthetic ASCII name, verified before shell cleanup; never a directory or wildcard.
        if (Regex("ragent-native-[a-f0-9-]{36}\\.txt").matches(name)) shell("rm -f /sdcard/Download/$name")
        withContext(Dispatchers.IO) {
            drafts.forEach { db.openHelper.writableDatabase.execSQL("DELETE FROM capture_drafts WHERE draftId = ?", arrayOf(it)) }
            db.openHelper.writableDatabase.execSQL("DELETE FROM result_outputs WHERE downloadId = ?", arrayOf(downloadId))
            db.openHelper.writableDatabase.execSQL("DELETE FROM api_operations WHERE operationId = ?", arrayOf(opId))
        }
        source.delete(); db.close()
    }
    private fun shell(command: String) = android.os.ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command))
        .bufferedReader().use { it.readText() }
    private fun nodes(): List<AccessibilityNodeInfo> {
        val root = automation.rootInActiveWindow ?: return emptyList()
        val result = mutableListOf<AccessibilityNodeInfo>(); val pending = java.util.ArrayDeque<AccessibilityNodeInfo>()
        pending.add(root)
        while (pending.isNotEmpty()) {
            val node = pending.removeFirst(); result += node
            repeat(node.childCount) { node.getChild(it)?.let(pending::add) }
        }
        return result
    }
    private fun waitUntil(message: String, timeout: Long = 20_000, condition: () -> Boolean) {
        val end = android.os.SystemClock.elapsedRealtime() + timeout
        while (android.os.SystemClock.elapsedRealtime() < end) { if (condition()) return; Thread.sleep(100) }
        screenshot("failed"); fail("$message; active nodes=${nodes().mapNotNull { it.text?.toString() }}")
    }
    private fun click(vararg labels: String) {
        var matched: AccessibilityNodeInfo? = null
        waitUntil("Missing ${labels.toList()}") {
            matched = nodes().firstOrNull { it.isVisibleToUser && labels.any { label -> it.text?.toString().equals(label, ignoreCase = true) } }
            if (matched == null) nodes().firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            matched != null
        }
        var target = matched!!
        repeat(6) { if (!target.isClickable) target.parent?.let { target = it } }
        assertTrue("Native action failed for ${labels.toList()}", target.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun screenshot(label: String) {
        val folder = File(context.getExternalFilesDir(null), "result-outputs-evidence").apply { mkdirs() }
        runCatching { automation.waitForIdle(500, 3_000) }
        automation.takeScreenshot()?.let { bitmap -> File(folder, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun returnToPageTop() {
        waitUntil("Result page did not return") {
            val current = nodes()
            if (current.none { it.packageName == context.packageName }) return@waitUntil false
            val scroller = current.firstOrNull { it.isScrollable }
            if (scroller?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD) == true) false
            else current.any { it.isVisibleToUser && it.text?.toString() in listOf("Task files", "任务文件") }
        }
    }
    private fun scrollForwardSmall(current: List<AccessibilityNodeInfo>) {
        val scroll = current.firstOrNull { it.isScrollable } ?: return
        val bounds = android.graphics.Rect().also(scroll::getBoundsInScreen)
        if (bounds.height() < 80 || bounds.width() < 40) return
        val x = bounds.centerX()
        val from = bounds.top + bounds.height() * 3 / 4
        val to = bounds.top + bounds.height() / 2
        shell("input swipe $x $from $x $to 250")
        Thread.sleep(350)
    }
    private fun launch() = ActivityScenario.launch<ResultOutputsActivity>(Intent(context, ResultOutputsActivity::class.java)
        .putExtra(ResultOutputsActivity.EXTRA_OPERATION_ID, opId))
    @Test fun nativeSharesheetSelectedDifferentUidReceiverGetsExactFile() = runBlocking {
        launch().use {
            click("Share file", "分享文件")
            screenshot("sharesheet")
            click("Ragent Result Receiver QA")
            val ticket = withTimeout(10_000) {
                while (true) {
                    graph.resultDeliveries.list(opId, graph.appApiOwner).singleOrNull()?.let { return@withTimeout it }
                    delay(100)
                }
                error("Unreachable")
            }
            val observation = Uri.parse("content://$fixture.result-probe/${ticket.id}"); observations += observation
            var response: JSONObject? = null
            waitUntil("Receiving fixture did not read shared bytes") {
                context.contentResolver.query(observation, null, null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) response = JSONObject(cursor.getString(0))
                }
                response != null
            }
            assertNotEquals(Process.myUid(), response!!.getInt("uid"))
            assertTrue(response!!.getBoolean("read")); assertEquals(data.size.toLong(), response!!.getLong("bytes"))
            assertEquals(sha(data), response!!.getString("sha256")); assertEquals("text/plain", response!!.getString("mimeType"))
            assertTrue(response!!.getBoolean("writeDenied")); assertTrue(response!!.getBoolean("siblingDenied"))
            assertTrue(graph.documentSaves.list(opId, graph.appApiOwner).isEmpty())
            File(context.getExternalFilesDir(null), "result-outputs-evidence/native-receiver.json").writeText(response.toString())
            screenshot("receiver")
            assertArrayEquals(data, source.readBytes())
        }
    }
    @Test fun documentsUiSaveReturnsAfterActivityRecreationAndWritesExactDownloadsBytes() {
        launch().use { scenario ->
            var original: ResultOutputsActivity? = null
            scenario.onActivity { original = it }
            click("Save as document", "另存为文档")
            waitUntil("DocumentsUI missing") { nodes().any { it.packageName?.toString()?.contains("documentsui") == true } }
            screenshot("documents-before-recreate")
            assertTrue(automation.setRotation(android.app.UiAutomation.ROTATION_FREEZE_90))
            waitUntil("DocumentsUI did not finish rotation") {
                val root = automation.rootInActiveWindow ?: return@waitUntil false
                val bounds = android.graphics.Rect().also(root::getBoundsInScreen)
                root.packageName?.toString()?.contains("documentsui") == true && bounds.width() > bounds.height()
            }
            // A successful action on a pre-rotation node can be lost during picker recreation.
            automation.waitForIdle(500, 5_000)
            click("SAVE", "保存")
            returnToPageTop()
            waitUntil("Save did not complete") { nodes().any { it.text?.toString() in listOf("Document copy completed.", "文档复制已完成。") } }
            scenario.onActivity { assertNotSame("System rotation must recreate the owner Activity", original, it) }
            val digest = shell("sha256sum /sdcard/Download/$name")
            assertTrue("Real Downloads bytes differ: $digest", digest.startsWith(sha(data)))
            assertArrayEquals(data, source.readBytes())
            scenario.recreate()
            returnToPageTop()
            waitUntil("Local file name did not restore") {
                val current = nodes()
                if (current.any { it.isVisibleToUser && it.text?.toString() == name }) true
                else { scrollForwardSmall(current); false }
            }
            waitUntil("Verified local copy status did not restore") {
                val current = nodes()
                if (current.any { it.isVisibleToUser && it.text?.toString() in listOf("Verified local copy", "已校验本地副本") }) true
                else { scrollForwardSmall(current); false }
            }
            assertFalse(nodes().any { it.packageName?.toString()?.contains("documentsui") == true })
            runBlocking { assertEquals(ResultOutputState.READY, graph.resultOutputs.get(downloadId, graph.appApiOwner)!!.state) }
            runBlocking { assertEquals(DocumentSaveState.SAVED, graph.documentSaves.list(opId, graph.appApiOwner, true).single().state) }
            screenshot("saved-reopened")
            File(context.getExternalFilesDir(null), "result-outputs-evidence/native-document-sha.txt").writeText(digest)
        }
    }
    @Test fun documentsUiCancellationRetainsSourceAndDoesNotClaimSaved() {
        launch().use {
            click("Save as document", "另存为文档")
            waitUntil("DocumentsUI missing") { nodes().any { it.packageName?.toString()?.contains("documentsui") == true } }
            shell("input keyevent 4")
            returnToPageTop()
            waitUntil("Cancellation result missing") { nodes().any { it.text?.toString() in listOf("Document selection cancelled; private files retained.", "已取消文档选择；保留私有文件。") } }
            assertArrayEquals(data, source.readBytes())
            assertFalse(shell("ls /sdcard/Download/$name").contains(name))
            runBlocking { assertEquals(DocumentSaveState.CANCELLED, graph.documentSaves.list(opId, graph.appApiOwner, true).single().state) }
            screenshot("save-cancelled")
        }
    }
    @Test fun adapterRejectsAnotherOperationsOutputAndTicket() = runBlocking {
        val port = OwnerResultOutputsPort(graph)
        val ticket = graph.resultDeliveryAndroid.stage(downloadId)
        val unrelatedId = "other-${UUID.randomUUID()}"
        val operation = RoomOperationStore(db).get(opId)!!
        assertTrue(RoomOperationStore(db).insert(operation.copy(operationId = unrelatedId,
            preparationId = "prep-$unrelatedId", request = operation.request.copy(operationId = unrelatedId))))
        try {
            assertTrue(runCatching { port.stage(unrelatedId, downloadId) }.isFailure)
            assertTrue(runCatching { port.saveDocument(unrelatedId, ticket.id, "content://any/document") }.isFailure)
        } finally {
            withContext(Dispatchers.IO) {
                db.openHelper.writableDatabase.execSQL("DELETE FROM api_operations WHERE operationId = ?", arrayOf(unrelatedId))
            }
        }
        assertArrayEquals(data, source.readBytes())
    }
    @Test fun savedOwnerDraftNavigatesToOriginalResultsWithoutSubmittingAgain() = runBlocking<Unit> {
        val operation = RoomOperationStore(db).get(opId)!!
        val draftId = opId.removePrefix("capture_"); drafts += draftId
        val draft = CaptureDraft(draftId, graph.appApiOwner.binding, 1,
            input = CaptureInput("Synthetic saved material"), instruction = operation.request.instruction,
            runtime = operation.request.runtime, targetInstanceId = operation.targetInstanceId,
            operationId = opId, preparationId = operation.preparationId)
        // Trusted fixture models a previously accepted task; public draft insertion remains editable-only.
        assertTrue(db.drafts().insert(CaptureDraftEntity(draftId, graph.appApiOwner.binding, 1, 1, 0,
            opId, operation.preparationId, AppApiJson.encodeToString(draft))) != -1L)
        ActivityScenario.launch<ShareDraftActivity>(Intent(context, ShareDraftActivity::class.java)
            .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draftId)).use {
            click("Task files", "任务文件")
            waitUntil("Saved draft did not open output page") {
                nodes().any { it.isVisibleToUser && it.text?.toString() in listOf("Query PC outputs", "查询电脑产物") }
            }
            assertEquals(0L, RoomOperationStore(db).get(opId)!!.revision)
            assertArrayEquals(data, source.readBytes())
            screenshot("saved-draft-navigation")
            shell("input keyevent 4")
        }
    }
}
