package com.andysagent.ragent

import android.content.ComponentName
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.domain.SessionScopeCondition
import com.andysagent.ragent.core.domain.ScopedMessageCommitReceipt
import com.andysagent.ragent.core.domain.ScopedMessageRequest
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.io.File
import java.util.UUID
import java.security.MessageDigest
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Production Binder/PM/Room and a separately installed different-UID SDK consumer. No PC carrier replacements. */
class AppApiServiceNativeTest {
    private val automation get() = InstrumentationRegistry.getInstrumentation().uiAutomation
    private val fixture = "com.agentoncloud.android.sharefixture"
    private lateinit var app: RagentApplication
    private lateinit var graph: AndroidRuntimeGraph
    private lateinit var target: String
    private lateinit var operation: String
    private lateinit var token: String
    private lateinit var identity: InstalledCallerIdentity
    private val issuedUris = mutableListOf<android.net.Uri>()
    private val principal get() = VerifiedCaller(identity.binding)
    @Before fun setup() = runBlocking<Unit> {
        app = ApplicationProvider.getApplicationContext(); graph = app.runtime
        target = "ipc-test-${UUID.randomUUID()}"; operation = "ipc-test-${UUID.randomUUID()}"; token = UUID.randomUUID().toString()
        graph.configStore.upsertComputer(LinkedComputer(target, "", "IPC synthetic computer"))
        identity = graph.appApiCallerIdentities.installed(fixture)
        assertNotEquals(android.os.Process.myUid(), identity.uid)
        graph.appApi.prepare(TaskRequest(operation + "-owner", "Synthetic owner local preparation", TaskRuntime("codex"), targetInstanceId = target), graph.appApiOwner)
    }
    @After fun cleanup() = runBlocking<Unit> {
        shell("am force-stop $fixture")
        issuedUris.forEach {
            app.revokeUriPermission(fixture, it, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            graph.resultDeliveries.revoke(it.pathSegments[1], principal)
        }
        runCatching { graph.resultDeliveries.list(operation, principal).forEach { graph.resultDeliveries.revoke(it.id, principal) } }
        rows().forEach { row ->
            val revoked = if (row.revokedAt == null) graph.appApiCallerGrants.revoke(graph.appApiOwner, row.grantId, row.revision) else row
            graph.appApiCallerGrants.deleteRevoked(graph.appApiOwner, revoked.grantId, revoked.revision)
        }
        graph.configStore.removeTarget(target)
        withContext(Dispatchers.IO) {
            val db = AppApiDatabase.open(app)
            try {
                db.openHelper.writableDatabase.execSQL("DELETE FROM result_outputs WHERE downloadId = ?", arrayOf(operation))
                for (id in listOf(operation, operation + "-owner"))
                    db.openHelper.writableDatabase.execSQL("DELETE FROM api_operations WHERE operationId = ?", arrayOf(id))
            } finally { db.close() }
            File(app.noBackupFilesDir, "ragent-result-outputs/$operation.bin").delete()
        }
    }
    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).bufferedReader().use { it.readText() }
    private suspend fun rows() = graph.appApiCallerGrants.list(graph.appApiOwner).filter { target in it.grant.targetIds }
    private suspend fun approve(projectIds: Set<String>? = null) = graph.appApiCallerGrants.approve(graph.appApiOwner, identity,
        CallerGrant(identity.binding, CapabilityRegistry().list().map { it.id }.toSet(), setOf(target),
            System.currentTimeMillis() + 3_600_000, projectIds = projectIds, mayCreateSessions = true))
    private fun nodes(): List<AccessibilityNodeInfo> {
        val output = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo?) { if (node != null) { output += node; repeat(node.childCount) { walk(node.getChild(it)) } } }
        walk(automation.rootInActiveWindow); return output
    }
    private fun waitFor(message: String, condition: () -> Boolean) {
        val end = android.os.SystemClock.elapsedRealtime() + 35_000
        while (android.os.SystemClock.elapsedRealtime() < end) { if (condition()) return; Thread.sleep(100) }
        fail("$message; visible=${nodes().mapNotNull { it.text?.toString() }}")
    }
    private fun launch(mode: String, uri: String? = null) {
        token = UUID.randomUUID().toString()
        app.startActivity(Intent().setComponent(ComponentName(fixture, "com.andysagent.ragent.sharefixture.AppApiClientSourceActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            .putExtra("token", token).putExtra("target", target).putExtra("operation", operation).putExtra("mode", mode).putExtra("uri", uri))
        waitFor("New SDK client not ready") { nodes().any { it.text?.toString() == "App API client ready: $token" } }
        val node = nodes().first { it.text?.toString() == "RUN APP API PROBE" }
        assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun response(stage: String = "COMPLETED"): JSONObject {
        var current: JSONObject? = null
        waitFor("SDK probe did not report $stage") {
            current = runCatching { JSONObject(shell("run-as $fixture cat files/app-api-result.json")) }.getOrNull()
            current?.optString("token") == token && current?.optString("stage") in setOf(stage, "FAILED")
        }
        assertEquals(current.toString(), stage, current!!.getString("stage"))
        assertEquals(identity.uid, current!!.getInt("uid"))
        File(app.getExternalFilesDir(null), "app-api-ipc-evidence").apply { mkdirs() }
            .resolve("$stage-$token.json").writeText(current.toString())
        return current!!
    }
    @Test fun sessionSdkRecognizesNewContractsAndRejectsUngrantableOrInvalidRequestsBeforePcAccess() = runBlocking {
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity,
            CallerGrant(identity.binding, CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf(target),
                System.currentTimeMillis() + 60_000, mayCreateSessions = true))
        launch("sessionsDenied")
        val result = response()
        for (field in listOf("sessionList", "sessionSearch", "sessionGet")) assertEquals("PERMISSION_DENIED", result.getString(field))
        for (field in listOf("emptySearch", "oversizedPage")) assertEquals("INVALID_ARGUMENT", result.getString(field))
        assertEquals("PERMISSION_DENIED", result.getString("mutationPrepare"))
        assertEquals("INVALID_ARGUMENT", result.getString("invalidMutation"))
        for (field in listOf("missingMutation", "missingMutationReceipt", "missingMutationCancel", "missingMutationRename"))
            assertEquals("RESOURCE_NOT_FOUND", result.getString(field))
        val descriptors = result.getJSONObject("capabilities").getJSONArray("items")
        val sessions = (0 until descriptors.length()).map { descriptors.getJSONObject(it) }.filter { it.getString("id").startsWith("ragent.sessions.") }
        assertEquals(11, sessions.size); sessions.forEach { assertEquals("NOT_GRANTED", it.getString("authorization")) }
    }

    @Test fun sdkPerformsAllTransportMethodsWithActualCallerBindingAndSanitizedProjection() = runBlocking {
        approve(); launch("exercise"); val result = response()
        assertTrue(result.getBoolean("preparationStable"))
        assertEquals("REVISION_CONFLICT", result.getString("changedInput"))
        assertEquals(target, result.getJSONObject("computers").getJSONArray("items").getJSONObject(0).getString("instanceId"))
        assertEquals(19, result.getJSONObject("capabilities").getJSONArray("items").length())
        assertEquals("CANCELLED", result.getJSONObject("cancelled").getString("stage"))
        assertEquals("CANCELLED", result.getString("cancelledCommit"))
        assertEquals("INVALID_ARGUMENT", result.getString("unsubmittedResult"))
        assertEquals("INVALID_ARGUMENT", result.getString("unsubmittedManifest"))
        assertEquals("PERMISSION_DENIED", result.getString("foreignOwnerOperation"))
        assertEquals("INVALID_ARGUMENT", result.getJSONObject("malformed").getJSONObject("error").getString("code"))
        assertEquals("INVALID_ARGUMENT", result.getJSONObject("oversize").getJSONObject("error").getString("code"))
        assertEquals("CAPABILITY_UNSUPPORTED", result.getString("futureVersion"))
        val projection = result.getJSONObject("operation")
        for (key in listOf("callerBinding", "creationKey", "originalFingerprint", "request", "uploads", "result", "resultExport")) assertFalse(key, projection.has(key))
        assertEquals(OperationStage.CANCELLED, graph.appApi.get(operation, principal).stage)
    }
    @Test fun withoutOwnerGrantDiscoveryIsBoundedAndPreparationCannotRun() = runBlocking {
        launch("denied"); val result = response()
        assertEquals(0, result.getJSONObject("computers").getJSONArray("items").length())
        assertTrue(result.getString("prepareError") in setOf("TARGET_NOT_FOUND", "PERMISSION_DENIED"))
        val descriptors = result.getJSONObject("capabilities").getJSONArray("items")
        repeat(descriptors.length()) { assertEquals("NOT_GRANTED", descriptors.getJSONObject(it).getString("authorization")) }
    }
    @Test fun liveWatchTerminatesOnOwnerRevocationAndNewCallsAreDenied() = runBlocking {
        val grant = approve(); launch("hold"); response("WATCH_READY")
        graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision)
        val ended = response("WATCH_FAILED")
        assertEquals("PERMISSION_DENIED", ended.getJSONObject("event").getJSONObject("error").getString("code"))
        launch("get"); val result = response()
        assertEquals("PERMISSION_DENIED", result.getString("getError"))
        assertEquals(0, result.getJSONObject("computers").getJSONArray("items").length())
    }
    @Test fun clientProcessDeathPreservesPreparationAndRebindReleasesWatchSlots() = runBlocking {
        approve(); launch("hold"); response("WATCH_READY")
        shell("am force-stop $fixture")
        waitFor("Client process still alive") { shell("pidof $fixture").trim().isEmpty() }
        assertEquals(OperationStage.PREPARED, graph.appApi.get(operation, principal).stage)
        launch("quota"); val result = response()
        assertEquals(8, result.getInt("requestAliasClosures"))
        assertEquals("RATE_LIMITED", result.getString("fifthWatch"))
        assertEquals("PREPARED", result.getJSONObject("resumedSnapshot").getJSONObject("operation").getString("stage"))
        assertEquals(OperationStage.PREPARED, graph.appApi.get(operation, principal).stage)
    }
    @Test fun foreignSdkCannotOmitProjectToEscapeActualPersistedProjectRestriction() = runBlocking {
        approve(projectIds = setOf("allowed-project")); launch("denied")
        val result = response()
        assertEquals("PERMISSION_DENIED", result.getString("prepareError"))
        assertEquals(1, result.getJSONObject("computers").getJSONArray("items").length())
        val capabilities = result.getJSONObject("capabilities").getJSONArray("items")
        repeat(capabilities.length()) { assertEquals("GRANTED", capabilities.getJSONObject(it).getString("authorization")) }
        try { graph.appApi.get(operation, principal); fail("Rejected preparation was persisted") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, error.error.code) }
    }

    @Test fun sdkDeliveryRejectsCreatedSessionOutsideGrantDespiteCreatePermission() = runBlocking {
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            setOf(CapabilityRegistry.TASKS_GET, CapabilityRegistry.TARGETS_LIST), setOf(target),
            System.currentTimeMillis() + 60_000, sessionIds = setOf("allowed-session"), mayCreateSessions = true))
        val saved = TaskOperation(operation, identity.binding, "synthetic", "prep-$operation", target,
            TaskRequest(operation, "Synthetic legacy created Session", TaskRuntime("codex"), targetInstanceId = target),
            "create-$operation", "request-$operation", 1, 10, sessionId = "outside-session")
        withContext(Dispatchers.IO) {
            val db = AppApiDatabase.open(app)
            try { assertTrue(RoomOperationStore(db).insert(saved)) } finally { db.close() }
        }
        assertEquals(saved, graph.appApi.get(operation, principal)) // The legacy initial read alone is insufficient.
        launch("get"); val result = response()
        assertEquals("PERMISSION_DENIED", result.getString("getError"))
        assertFalse(result.has("operation"))
    }

    @Test fun cachedVerifiedOutputIsDeliveredToActualUidAndRevocationBlocksProviderReads() = runBlocking {
        verifyCachedOutputDelivery()
    }

    @Test fun scopedCachedOutputWithOmittedRequestProjectUsesFrozenProjectGrant() = runBlocking {
        verifyCachedOutputDelivery("allowed-project")
    }

    private suspend fun verifyCachedOutputDelivery(projectId: String? = null) {
        val grant = approve(projectIds = projectId?.let { setOf(it) })
        val bytes = "SDK verified output 测试🙂\n".repeat(2000).toByteArray(Charsets.UTF_8)
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        val manifest = ResultExportManifest(1, target, "session-$operation", "request-$operation", "run-$operation", "final-$operation",
            listOf(ResultExportResource("text", "sdk-result.txt", "text/plain", true, bytes.size.toLong(), sha)),
            bytes.size.toLong(), 65536, "2099-01-01T00:00:00Z", "d".repeat(64))
        val legacy = TaskOperation(operation, identity.binding, "synthetic", "prep-$operation", target,
            TaskRequest(operation, "Synthetic retained output", TaskRuntime("codex"), targetInstanceId = target), "create-$operation",
            manifest.requestId, 1, 10, stage = OperationStage.ACCEPTED, sessionId = manifest.sessionId, runId = manifest.runId, resultExport = manifest)
        val pcPreparation = "mprep_${UUID.randomUUID()}"
        val saved = if (projectId == null) legacy else legacy.copy(messageProtocolVersion = 1,
            originalScope = SessionScopeCondition(manifest.sessionId, UUID.randomUUID().toString(), projectId),
            pcPreparationId = pcPreparation, commitReceipt = ScopedMessageCommitReceipt(1, manifest.sessionId,
                manifest.requestId, pcPreparation, manifest.runId, "accepted", true, false, false,
                ScopedMessageRequest.expiry(10), ScopedMessageRequest.expiry(1), ScopedMessageRequest.expiry(1),
                null, false, null))
        assertNull(saved.request.projectId)
        withContext(Dispatchers.IO) {
            val db = AppApiDatabase.open(app)
            try {
                assertTrue(RoomOperationStore(db).insert(saved))
                val output = ResultOutput(operation, operation, identity.binding, manifest, "text", 1, 1,
                    state = ResultOutputState.READY, receivedBytes = bytes.size.toLong(), prefixSha256 = sha, verifiedAt = 1)
                assertNotEquals(-1L, db.outputs().insert(ResultOutputEntity(operation, operation, identity.binding, "READY", 0,
                    bytes.size.toLong(), 1, AppApiJson.encodeToString(output))))
            } finally { db.close() }
            File(app.noBackupFilesDir, "ragent-result-outputs/$operation.bin").apply { parentFile!!.mkdirs(); writeBytes(bytes) }
        }
        launch("cachedDownload"); val result = response()
        val download = result.getJSONObject("download")
        assertEquals(bytes.size, result.getInt("receivedBytes")); assertEquals(sha, result.getString("receivedSha256"))
        assertTrue(result.getBoolean("independentDelivery"))
        val uri = android.net.Uri.parse(download.getString("uri")); issuedUris += uri
        issuedUris += android.net.Uri.parse(result.getString("secondUri"))
        assertEquals("content", uri.scheme); assertEquals("com.agentoncloud.android.result-files", uri.authority)
        assertFalse(download.has("callerBinding")); assertFalse(download.has("file"))
        graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision)
        launch("revokedUri", uri.toString()); val revoked = response()
        assertNotEquals("UNEXPECTED_SUCCESS", revoked.getString("uriRead"))
    }
}
