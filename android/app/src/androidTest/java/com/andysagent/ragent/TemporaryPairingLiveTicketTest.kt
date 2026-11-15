package com.andysagent.ragent

import android.content.Intent
import android.content.ComponentName
import android.os.ParcelFileDescriptor
import android.util.Base64
import android.util.Log
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.auth.AndroidTemporaryClaimJournal
import com.andysagent.ragent.core.auth.AndroidTemporaryTextOperationJournal
import com.andysagent.ragent.core.auth.TemporaryTextStage
import com.andysagent.ragent.core.auth.TemporaryPairingTicket
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith

/** Live, camera-free phone-to-PC check. A one-time ticket is read from adb's private staging area. */
@RunWith(AndroidJUnit4::class)
class TemporaryPairingLiveTicketTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test
    fun claimsTicketConnectsRunsNoOpAndReadsExactResult() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Pass -e liveTemporaryPairingTicket true only when a fresh test ticket is staged",
            args.getString("liveTemporaryPairingTicket") == "true")
        val exerciseFiles = args.getString("liveTemporaryPairingFiles") == "true"
        assertTrue("File acceptance must use the production route and native Sharesheet",
            !exerciseFiles || args.getString("liveTemporaryPairingShareRoute") == "true" &&
                args.getString("liveTemporaryPairingSystemChooser") == "true")

        val targetContext = instrumentation.targetContext
        val application = targetContext.applicationContext as RagentApplication
        val preserveClaimForManualShareRoute = args.getString("preserveTemporaryClaim") == "true"
        val ticketFile = "/data/local/tmp/ragent-temporary-pairing-ticket.json"
        val access = application.runtime.temporaryAccess
        var instanceId: String? = null
        try {
            Log.i("TemporaryPairingLiveQA", "ticket-read")
            val descriptor = instrumentation.uiAutomation.executeShellCommand("cat $ticketFile")
            val stagedBytes = ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
            val jsonStart = stagedBytes.indexOfFirst { it == '{'.code.toByte() }
            val jsonEnd = stagedBytes.indexOfLast { it == '}'.code.toByte() }
            assertTrue("Staged ticket must contain one JSON temporary pairing envelope",
                jsonStart >= 0 && jsonEnd > jsonStart)
            val ticket = String(stagedBytes, jsonStart, jsonEnd - jsonStart + 1, Charsets.UTF_8)
            val started = access.beginQr(ticket)
            Log.i("TemporaryPairingLiveQA", "claim-started")
            instanceId = requireNotNull(started.instanceId)
            assertFalse("Temporary claim must not create an Owner computer directory entry",
                application.runtime.configStore.directory.first().computers.any { it.instanceId == instanceId })

            awaitReadyWithDiagnostics(access, AndroidTemporaryClaimJournal(targetContext), instanceId!!)
            Log.i("TemporaryPairingLiveQA", "carrier-ready")
            assertTrue("Signed temporary WebRTC carrier must be open", access.available(instanceId))
            val runtimes = access.listRuntimes(instanceId)
            assertTrue("The PC temporary business API must return its runtime catalog", runtimes.isNotEmpty())
            val runtime = runtimes.firstOrNull { it.ready }
            assertNotNull("At least one PC runtime must be ready for a no-op acceptance run", runtime)
            val runtimeId = requireNotNull(runtime).id

            val exerciseShareRoute = args.getString("liveTemporaryPairingShareRoute") == "true"
            if (!exerciseShareRoute) {
                val marker = "RAGENT-LIVE-NOOP-20261015"
                val prompt = "Reply with exactly $marker and nothing else. This is a no-op connectivity acceptance test. " +
                    "Do not call tools, browse, inspect or modify files, or change settings."
                val accepted = access.submitText(prompt, runtimeId, instanceId)
                assertEquals("The PC must accept exactly one temporary operation", TemporaryTextStage.Accepted,
                    accepted.stage)
                assertNotNull("The accepted temporary operation must identify its Run", accepted.runId)

                val result = withTimeout(180_000) {
                    while (true) {
                        val snapshot = access.readTextResult(accepted.operationId, instanceId)
                        when (snapshot["state"]?.jsonPrimitive?.content) {
                            "ready" -> return@withTimeout snapshot
                            "failed", "cancelled" -> error("The PC no-op Run ended without a result")
                            else -> delay(1_500)
                        }
                    }
                    error("unreachable")
                }
                assertEquals("The phone must return the exact PC result for the submitted Run", marker,
                    result["text"]?.jsonPrimitive?.content?.trim())
            }

            if (exerciseShareRoute) {
                val shareText = "Live camera-free share route ${System.currentTimeMillis()}"
                val fileBytes = args.getString("liveTemporaryPairingFileBytes")?.toIntOrNull() ?: 0
                if (args.getString("liveTemporaryPairingSystemChooser") == "true") {
                    Log.i("TemporaryPairingLiveQA", "system-chooser-start")
                    val encoded = Base64.encodeToString(shareText.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
                    assertTrue("Large-file acceptance uses a bounded multi-chunk synthetic CSV",
                        fileBytes == 0 || fileBytes in (256 * 1024 + 1)..(5 * 1024 * 1024))
                    val filesExtra = if (exerciseFiles) " --es names first.csv,second.png" +
                        if (fileBytes > 0) " --ei fileBytes $fileBytes" else "" else ""
                    if (exerciseFiles) assertTrue("The file sender must have an independent Android UID",
                        targetContext.packageManager.getApplicationInfo(
                            "com.agentoncloud.android.sharefixture", 0).uid != targetContext.applicationInfo.uid)
                    val command = "am start -n com.agentoncloud.android.sharefixture/" +
                        "com.andysagent.ragent.sharefixture.ShareSourceFixtureActivity " +
                        "--ez chooser true --es materialBase64 $encoded$filesExtra"
                    instrumentation.uiAutomation.executeShellCommand(command).use { descriptor ->
                        ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
                    }
                    val device = UiDevice.getInstance(instrumentation)
                    if (device.currentPackageName == "com.hihonor.android.instantshare") device.pressBack()
                    val label = targetContext.packageManager.getActivityInfo(
                        ComponentName(targetContext, ShareRouterActivity::class.java), 0
                    ).loadLabel(targetContext.packageManager).toString()
                    val target = By.text(label)
                    if (!device.hasObject(target)) {
                        device.swipe((device.displayWidth * 0.5f).toInt(),
                            (device.displayHeight * 0.94f).toInt(),
                            (device.displayWidth * 0.5f).toInt(),
                            (device.displayHeight * 0.58f).toInt(), 24)
                        device.waitForIdle()
                    }
                    for (attempt in 0 until 5) {
                        if (device.hasObject(target)) break
                        val y = (device.displayHeight * 0.84f).toInt()
                        device.swipe((device.displayWidth * 0.92f).toInt(), y,
                            (device.displayWidth * 0.12f).toInt(), y, 24)
                        if (attempt < 4) device.waitForIdle()
                    }
                    assertTrue("Ragent share target '$label' missing from system Sharesheet",
                        device.wait(Until.hasObject(target), 3_000))
                    device.findObject(target).click()
                    Log.i("TemporaryPairingLiveQA", "system-chooser-target-selected")
                } else {
                    val source = Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_TEXT, shareText)
                        .setClass(targetContext, ShareRouterActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                    instrumentation.runOnMainSync { targetContext.startActivity(source) }
                }
                compose.waitUntil(15_000) {
                    compose.onAllNodesWithTag("share-route-temporary").fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithTag("share-route-temporary").performClick()
                Log.i("TemporaryPairingLiveQA", "temporary-route-selected")
                compose.waitUntil(15_000) {
                    compose.onAllNodesWithText(shareText).fetchSemanticsNodes().isNotEmpty()
                }
                compose.waitUntil(90_000) {
                    compose.onAllNodesWithText(targetContext.getString(
                        com.andysagent.ragent.feature.appapi.R.string.temporary_share_target_ready
                    )).fetchSemanticsNodes().isNotEmpty() &&
                        compose.onAllNodesWithTag("temporary-runtime-$runtimeId")
                            .fetchSemanticsNodes().isNotEmpty()
                }
                compose.onNodeWithText(shareText).assertIsDisplayed()
                compose.onNodeWithTag("temporary-runtime-$runtimeId").assertIsEnabled()
                compose.onNodeWithTag("temporary-runtime-$runtimeId").performClick()
                if (exerciseFiles) {
                    for (name in listOf("first.csv", "second.png")) {
                        compose.waitUntil(10_000) {
                            compose.onAllNodesWithText(name).fetchSemanticsNodes().isNotEmpty()
                        }
                        compose.onNodeWithText(name).performScrollTo().assertIsDisplayed()
                    }
                }
                compose.onNodeWithTag("temporary-share-submit").assertIsNotEnabled()

                val uiMarker = "RAGENT-LIVE-SHARE-UI-${System.currentTimeMillis()}"
                val expectedResult = if (exerciseFiles) "$uiMarker:3" else uiMarker
                val instruction = if (exerciseFiles) {
                    "Read only the attached first.csv. Compute the sum of columns a and b in its first numeric data row. " +
                        "Reply with exactly $uiMarker followed by a colon and that sum, and nothing else. " +
                        "Ignore the attached image. Do not inspect other files, modify files, or change settings."
                } else "Reply exactly $uiMarker and nothing else. Do not call tools or change files."
                compose.onNode(hasSetTextAction()).performTextInput(
                    instruction
                )
                assertTrue("Entering an instruction must not dispatch a task",
                    access.pendingText(instanceId).none { it.text.contains(uiMarker) })
                compose.onNodeWithTag("temporary-share-submit").performScrollTo().performClick()
                Log.i("TemporaryPairingLiveQA", "share-submit-clicked")
                compose.waitUntil(120_000) {
                    compose.onAllNodesWithText(targetContext.getString(
                        com.andysagent.ragent.feature.appapi.R.string.temporary_share_accepted
                    )).fetchSemanticsNodes().isNotEmpty()
                }
                val checkResultLabel = targetContext.getString(
                    com.andysagent.ragent.feature.appapi.R.string.temporary_share_check_result
                )
                val resultDeadline = System.currentTimeMillis() + 240_000
                while (System.currentTimeMillis() < resultDeadline &&
                    compose.onAllNodesWithText(expectedResult).fetchSemanticsNodes().isEmpty()) {
                    val checkButton = compose.onNodeWithText(checkResultLabel)
                    compose.waitUntil(15_000) {
                        runCatching { checkButton.assertIsEnabled(); true }.getOrDefault(false)
                    }
                    checkButton.performScrollTo().performClick()
                    delay(5_000)
                }
                compose.onNodeWithText(expectedResult).assertIsDisplayed()
                if (exerciseFiles) {
                    val operation = access.pendingText(instanceId).single { it.text.contains(uiMarker) }
                    assertEquals(TemporaryTextStage.Accepted, operation.stage)
                    assertEquals(instanceId, operation.instanceId)
                    assertEquals(runtimeId, operation.tool)
                    val expectedFiles = mapOf(
                        "first.csv" to syntheticCsv(fileBytes),
                        "second.png" to Base64.decode(
                            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
                            Base64.DEFAULT),
                    )
                    assertEquals(expectedFiles.keys, operation.attachments.map { it.originalName }.toSet())
                    assertEquals(2, operation.attachments.size)
                    for (attachment in operation.attachments) {
                        val bytes = expectedFiles.getValue(attachment.originalName)
                        assertTrue("Every attachment needs a confirmed PC receipt", attachment.ready)
                        assertNotNull(attachment.assetId)
                        assertEquals(bytes.size.toLong(), attachment.sizeBytes)
                        assertEquals(MessageDigest.getInstance("SHA-256").digest(bytes)
                            .joinToString("") { "%02x".format(it) }, attachment.sha256)
                    }
                    val result = access.readTextResult(operation.operationId, instanceId)
                    assertEquals(operation.sessionId, result["sessionId"]?.jsonPrimitive?.content)
                    assertEquals(operation.runId, result["runId"]?.jsonPrimitive?.content)
                    assertEquals(expectedResult, result["text"]?.jsonPrimitive?.content?.trim())
                    Log.i("TemporaryPairingLiveQA", "two-file-receipts-and-exact-run-result-verified")
                }
                Log.i("TemporaryPairingLiveQA", "result-visible")
            }
        } finally {
            runCatching {
                instrumentation.runOnMainSync {
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filter { it is TemporaryShareReceiverActivity || it is ShareRouterActivity }
                        .forEach { it.finish() }
                }
            }
            if (!preserveClaimForManualShareRoute) {
                instanceId?.let { id ->
                    val journal = AndroidTemporaryTextOperationJournal(targetContext)
                    access.pendingText(id).forEach { pending ->
                        journal.clear(id, pending.grantId, pending.operationId)
                    }
                    access.disconnect(id)
                    AndroidTemporaryClaimJournal(targetContext).clear(id)
                }
            }
            instrumentation.uiAutomation.executeShellCommand("rm -f $ticketFile").use { }
        }
    }

    @Test
    fun replacesSameInstanceClaimOnlyAfterPendingOperationIsCleared() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Stage two fresh tickets for this replacement test",
            args.getString("liveTemporaryPairingReplacement") == "true")
        val context = instrumentation.targetContext
        val application = context.applicationContext as RagentApplication
        val access = application.runtime.temporaryAccess
        val claims = AndroidTemporaryClaimJournal(context)
        val operations = AndroidTemporaryTextOperationJournal(context)
        val originalTicketPath = "/data/local/tmp/ragent-temporary-pairing-ticket.json"
        val replacementTicketPath = "/data/local/tmp/ragent-temporary-pairing-replacement-ticket.json"
        var instanceId: String? = null
        var oldGrantId: String? = null
        var operationId: String? = null
        try {
            fun readTicket(path: String): String {
                val descriptor = instrumentation.uiAutomation.executeShellCommand("cat $path")
                val bytes = ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
                val first = bytes.indexOfFirst { it == '{'.code.toByte() }
                val last = bytes.indexOfLast { it == '}'.code.toByte() }
                assertTrue("Staged ticket must contain one JSON object", first >= 0 && last > first)
                return String(bytes, first, last - first + 1, Charsets.UTF_8)
            }

            val originalTicketRaw = readTicket(originalTicketPath)
            val replacementTicketRaw = readTicket(replacementTicketPath)
            val originalTicket = kotlinx.serialization.json.Json.decodeFromString<TemporaryPairingTicket>(originalTicketRaw)
            val replacementTicket = kotlinx.serialization.json.Json.decodeFromString<TemporaryPairingTicket>(replacementTicketRaw)
            instanceId = originalTicket.envelope.invitation.instanceId
            assertEquals("Replacement ticket must name the same PC", instanceId,
                replacementTicket.envelope.invitation.instanceId)
            assertNull("Start from a clean claim on this emulator", claims.read(instanceId!!))

            val started = access.beginQr(originalTicketRaw)
            awaitReadyWithDiagnostics(access, claims, requireNotNull(started.instanceId))
            assertTrue("First temporary carrier must be ready", access.available(instanceId))
            val runtime = access.listRuntimes(instanceId).firstOrNull { it.ready }
            assertNotNull("The computer must expose a ready runtime", runtime)

            val pending = access.createText("Recovery guard probe; do not submit to the PC.",
                requireNotNull(runtime).id, instanceId = instanceId)
            operationId = pending.operationId
            oldGrantId = pending.grantId
            assertEquals("An unsubmitted operation must block claim replacement",
                TemporaryAccessRuntime.ClaimReplacementResult.BlockedByOperations(1),
                access.replaceClaimForTicket(replacementTicketRaw))
            assertNotNull("Blocked replacement must preserve the old encrypted claim", claims.read(instanceId!!))
            assertTrue("Blocked replacement must keep the old carrier available", access.available(instanceId))

            operations.clear(instanceId!!, requireNotNull(oldGrantId), requireNotNull(operationId))
            assertEquals(TemporaryAccessRuntime.ClaimReplacementResult.Released,
                access.replaceClaimForTicket(replacementTicketRaw))
            assertNull("Successful replacement clears only this instance's old claim", claims.read(instanceId!!))
            assertFalse("Successful replacement stops the old local carrier", access.available(instanceId))

            val replacementStarted = access.beginQr(replacementTicketRaw)
            awaitReadyWithDiagnostics(access, claims, requireNotNull(replacementStarted.instanceId))
            assertTrue("The replacement invitation must establish a fresh temporary carrier",
                access.available(instanceId))
            assertFalse("Neither temporary claim may create an Owner directory entry",
                application.runtime.configStore.directory.first().computers.any { it.instanceId == instanceId })
        } finally {
            instanceId?.let { id ->
                operationId?.let { op -> oldGrantId?.let { grant -> operations.clear(id, grant, op) } }
                access.disconnect(id)
                access.pendingText(id).forEach { pending -> operations.clear(id, pending.grantId, pending.operationId) }
                claims.clear(id)
            }
            instrumentation.uiAutomation.executeShellCommand("rm -f $originalTicketPath $replacementTicketPath").use { }
        }
    }

    @Test
    fun clearsPreservedTemporaryClaimWhenRequested() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue("Use only after a preserveTemporaryClaim live test",
            InstrumentationRegistry.getArguments().getString("cleanupTemporaryClaim") == "true")
        val context = instrumentation.targetContext
        val application = context.applicationContext as RagentApplication
        val access = application.runtime.temporaryAccess
        val claims = AndroidTemporaryClaimJournal(context)
        val operations = AndroidTemporaryTextOperationJournal(context)
        claims.listInstanceIds().forEach { id ->
            val pending = access.pendingText(id)
            access.disconnect(id)
            pending.forEach { operations.clear(id, it.grantId, it.operationId) }
            claims.clear(id)
        }
    }

    private fun syntheticCsv(requestedBytes: Int): ByteArray {
        val base = "a,b\n1,2\n合成分享文件\n".toByteArray(Charsets.UTF_8)
        if (requestedBytes == 0) return base
        val filler = "# synthetic padding\n".toByteArray(Charsets.UTF_8)
        return ByteArrayOutputStream(requestedBytes).apply {
            write(base)
            while (size() < requestedBytes) {
                val count = minOf(filler.size, requestedBytes - size())
                write(filler, 0, count)
            }
        }.toByteArray()
    }

    private suspend fun awaitReadyWithDiagnostics(
        access: TemporaryAccessRuntime,
        claims: AndroidTemporaryClaimJournal,
        instanceId: String,
    ) {
        try {
            withTimeout(100_000) { access.waitUntilReady(instanceId) }
        } catch (timeout: TimeoutCancellationException) {
            val claim = claims.read(instanceId)
            throw AssertionError(
                "Temporary carrier timed out: stage=${access.snapshot.value.stage}, " +
                    "claimAccepted=${claim?.claimAccepted}, completionSaved=${claim?.completion != null}, " +
                    "connectionRequested=${claim?.connectionRequestId != null}, " +
                    "connectionAccepted=${claim?.connectionAccepted}, connectionReceived=${claim?.connection != null}",
                timeout,
            )
        }
    }

    @Test
    fun clearsNamedTemporaryClaimWhenRequested() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val instanceId = InstrumentationRegistry.getArguments()
            .getString("cleanupTemporaryClaimInstanceId")
        assumeTrue("Pass one exact instance ID to clean an interrupted live-ticket test",
            !instanceId.isNullOrBlank())
        val id = requireNotNull(instanceId)
        assertTrue("Only a syntactically valid temporary instance may be cleaned",
            Regex("^inst_[A-Za-z0-9_-]{24,64}$").matches(id))
        val context = instrumentation.targetContext
        val claims = AndroidTemporaryClaimJournal(context)
        assertNotNull("The requested temporary claim must exist before targeted cleanup", claims.read(id))
        (context.applicationContext as RagentApplication).runtime.temporaryAccess.disconnect(id)
        claims.clear(id)
        assertNull("Targeted cleanup must remove only the selected claim", claims.read(id))
    }
}
