package com.andysagent.ragent

import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.model.AppLanguage
import com.andysagent.ragent.core.model.AppTheme
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.encodeToString
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.util.UUID

/** Actual different-UID for-result client and production consent/management Activities. No PC work. */
class CallerAuthorizationNativeTest {
    private val automation get() = InstrumentationRegistry.getInstrumentation().uiAutomation
    private lateinit var app: RagentApplication
    private lateinit var graph: AndroidRuntimeGraph
    private lateinit var target: String
    private lateinit var token: String
    private lateinit var language: AppLanguage
    private lateinit var theme: AppTheme
    private val fixture = "com.agentoncloud.android.sharefixture"
    @Before fun setup() = runBlocking {
        app = ApplicationProvider.getApplicationContext(); graph = app.runtime
        target = "consent-test-${UUID.randomUUID()}"; token = UUID.randomUUID().toString()
        language = graph.configStore.appLanguage.first(); theme = graph.configStore.appTheme.first()
        graph.configStore.setAppLanguage(AppLanguage.SimplifiedChinese); graph.configStore.setAppTheme(AppTheme.Dark)
        graph.configStore.upsertComputer(LinkedComputer(target, "", "Consent Office"))
    }
    @After fun cleanup() = runBlocking {
        automation.setRotation(android.app.UiAutomation.ROTATION_UNFREEZE)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val monitor = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            (monitor.getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED) + monitor.getActivitiesInStage(androidx.test.runner.lifecycle.Stage.STOPPED))
                .filter { it is CallerConsentActivity || it is CallerGrantsActivity }.forEach { it.finish() }
        }
        ownedRows().forEach {
            val row = if (it.revokedAt == null) graph.appApiCallerGrants.revoke(graph.appApiOwner, it.grantId, it.revision) else it
            graph.appApiCallerGrants.deleteRevoked(graph.appApiOwner, row.grantId, row.revision)
        }
        graph.configStore.removeTarget(target)
        graph.configStore.setAppLanguage(language); graph.configStore.setAppTheme(theme)
    }
    private fun shell(cmd: String) = ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(cmd)).bufferedReader().use { it.readText() }
    private fun nodes(): List<AccessibilityNodeInfo> {
        val result = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo?) { if (node == null) return; result += node; repeat(node.childCount) { walk(node.getChild(it)) } }
        walk(automation.rootInActiveWindow); return result
    }
    private fun waitFor(message: String, condition: () -> Boolean) {
        val end = android.os.SystemClock.elapsedRealtime() + 20_000
        while (android.os.SystemClock.elapsedRealtime() < end) { if (condition()) return; Thread.sleep(100) }
        screenshot("failed"); fail("$message: ${nodes().mapNotNull { it.text?.toString() }}")
    }
    private fun click(label: String) {
        var node: AccessibilityNodeInfo? = null
        waitFor("Missing $label") {
            node = nodes().firstOrNull { it.isVisibleToUser && (it.text?.toString() == label || it.contentDescription?.toString() == label) && it.isClickable }
                ?: nodes().firstOrNull { it.isVisibleToUser && it.text?.toString() == label }
            if (node == null) nodes().firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            node != null
        }
        var button = node!!
        repeat(6) { if (!button.isClickable) button.parent?.let { button = it } }
        assertTrue("Click $label", button.performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }
    private fun screenshot(name: String) {
        val dir = File(app.getExternalFilesDir(null), "caller-access-evidence").apply { mkdirs() }
        runCatching { automation.waitForIdle(500, 3000) }
        automation.takeScreenshot()?.let { bitmap -> File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun request() = CallerConsentRequest(setOf(CapabilityRegistry.TARGETS_LIST), setOf(target), lifetimeMs = 3600000)
    private fun launch(requestJson: String = AppApiJson.encodeToString(request())) {
        app.startActivity(Intent().setComponent(ComponentName(fixture, "com.andysagent.ragent.sharefixture.CallerConsentSourceActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra("request", requestJson).putExtra("token", token))
        waitFor("New consent client did not become ready") { nodes().any { it.text?.toString() == "Consent client ready: $token" } }
        click("REQUEST RAGENT ACCESS")
    }
    private fun response(): JSONObject {
        var response: JSONObject? = null
        waitFor("Consent result missing") {
            response = runCatching { JSONObject(shell("run-as $fixture cat files/caller-consent-result.json")) }.getOrNull()
            response?.optString("token") == token
        }
        return response!!
    }
    private suspend fun ownedRows() = graph.appApiCallerGrants.list(graph.appApiOwner).filter { target in it.grant.targetIds }

    @Test fun differentUidExplicitConsentSurvivesRotationAndOwnerCanRevokeAndClear() = runBlocking {
        launch(AppApiJson.encodeToString(request().copy(targetIds = emptySet())))
        waitFor("Verified package missing") { nodes().any { it.text?.toString() == fixture } }
        assertTrue(ownedRows().isEmpty())
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<CallerConsentActivity>().single()
            assertEquals(fixture, activity.callingPackage)
            if (android.os.Build.VERSION.SDK_INT >= 34) {
                assertEquals(fixture, activity.launchedFromPackage)
                assertEquals(graph.appApiCallerIdentities.installed(fixture).uid, activity.launchedFromUid)
            }
            val properties = android.view.MotionEvent.PointerProperties().apply { id = 0; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER }
            val coords = android.view.MotionEvent.PointerCoords().apply { x = 100f; y = 100f; pressure = 1f; size = 1f }
            for (flag in listOf(android.view.MotionEvent.FLAG_WINDOW_IS_OBSCURED, android.view.MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) {
                val event = android.view.MotionEvent.obtain(0L, android.os.SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_DOWN,
                    1, arrayOf(properties), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, flag)
                try { assertTrue(activity.dispatchTouchEvent(event)) } finally { event.recycle() }
            }
        }
        screenshot("consent-initial-zh-dark")
        click("查看已配对电脑"); click("Consent Office ($target)")
        assertTrue(automation.setRotation(android.app.UiAutomation.ROTATION_FREEZE_90))
        waitFor("Recreated consent page missing") { nodes().any { it.text?.toString() == "允许应用访问" } }
        runCatching { automation.waitForIdle(1000, 5000) }
        assertTrue(ownedRows().isEmpty())
        click("允许所选权限")
        val returned = response(); assertEquals(-1, returned.getInt("resultCode")); assertNotEquals(android.os.Process.myUid(), returned.getInt("uid"))
        val receipt = JSONObject(returned.getString("receipt")); val id = receipt.getString("grantId")
        assertEquals(id, JSONObject(returned.getString("sdkReceipt")).getString("grantId"))
        assertEquals(CallerConsentContract.RECEIPT, returned.getString("extraKeys"))
        val row = ownedRows().single(); assertEquals(id, row.grantId); assertEquals(fixture, row.identity.packageName)
        assertEquals(returned.getInt("uid"), row.identity.uid)
        assertEquals(setOf(target), row.grant.targetIds); assertFalse(row.grant.mayCreateSessions)
        assertEquals(setOf(CapabilityRegistry.TARGETS_LIST), row.grant.capabilityIds)
        assertEquals(listOf(target), graph.appApi.listTargets(VerifiedCaller(row.identity.binding)).map { it.instanceId })
        File(app.getExternalFilesDir(null), "caller-access-evidence/approved.json").writeText(returned.toString())
        automation.setRotation(android.app.UiAutomation.ROTATION_UNFREEZE)
        app.startActivity(Intent(app, AppApiSettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        click("应用访问权限")
        click("撤销权限")
        waitFor("Revocation not persisted") { runBlocking { ownedRows().single().revokedAt != null } }
        screenshot("grants-revoked-zh-dark")
        assertTrue(graph.appApi.listTargets(VerifiedCaller(row.identity.binding)).isEmpty())
        click("清除已撤销记录")
        waitFor("Revoked history not cleared") { runBlocking { ownedRows().isEmpty() } }
    }
    @Test fun denyAndUnknownTargetNeverCreateGrantDespiteForgedExtras() = runBlocking {
        launch(); waitFor("Request did not load") { nodes().any { it.text?.toString() == fixture } }
        click("拒绝"); assertEquals(0, response().getInt("resultCode")); assertTrue(ownedRows().isEmpty())
        token = UUID.randomUUID().toString()
        launch("""{"capabilityIds":["ragent.targets.list"],"targetIds":["$target"],"callerBinding":"owner"}""")
        val malformed = response(); assertEquals(0, malformed.getInt("resultCode")); assertEquals("INVALID_ARGUMENT", malformed.getString("error"))
        assertTrue(ownedRows().isEmpty())
        token = UUID.randomUUID().toString()
        launch(AppApiJson.encodeToString(request().copy(targetIds = setOf("unpaired-test-target"))))
        waitFor("Unknown target error missing") { nodes().any { it.text?.toString()?.contains("TARGET_NOT_FOUND") == true } }
        click("拒绝"); assertEquals(0, response().getInt("resultCode")); assertTrue(ownedRows().isEmpty())
    }
    @Test fun directCallerWithoutResultIdentityIsRejectedAndManagementIsNotExported() = runBlocking {
        val pm = app.packageManager
        @Suppress("DEPRECATION")
        assertFalse(pm.getActivityInfo(ComponentName(app, CallerGrantsActivity::class.java), 0).exported)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val monitor = instrumentation.addMonitor(CallerConsentActivity::class.java.name, null, false)
        try {
            app.startActivity(Intent(app, CallerConsentActivity::class.java).setAction(CallerConsentContract.ACTION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(CallerConsentContract.REQUEST, AppApiJson.encodeToString(request())))
            waitFor("Unidentified consent launch was not rejected") { monitor.hits > 0 && monitor.lastActivity?.isFinishing == true }
        } finally { instrumentation.removeMonitor(monitor) }
        assertTrue(ownedRows().isEmpty())
    }
}
