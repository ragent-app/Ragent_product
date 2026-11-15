package com.andysagent.ragent

import android.content.ComponentName
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.appapi.CaptureDraft
import com.andysagent.ragent.core.appapi.CaptureSource
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

/** Public production component, actual owner journal and a separate UID source. No PC submission. */
class ProcessTextActivityTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun nativeTextSelectionMenuOpensPublicEntryAndCancelPreservesSource() = nativeMenuCase(false)
    @Test fun nativeReadOnlyTextViewMenuSuppliesReadonlyAndPreservesSource() = nativeMenuCase(true)
    private fun nativeMenuCase(readOnly: Boolean) = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.uiAutomation
        val oldServiceInfo = automation.serviceInfo
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        }
        val material = "NativeMenu${UUID.randomUUID().toString().take(8)}"
        val original = "Before: $material :After"
        val oldLanguage = graph.configStore.appLanguage.first()
        var saved: CaptureDraft? = null
        fun nodes(): List<android.view.accessibility.AccessibilityNodeInfo> {
            val all = mutableListOf<android.view.accessibility.AccessibilityNodeInfo>()
            fun visit(node: android.view.accessibility.AccessibilityNodeInfo) {
                all += node
                for (i in 0 until node.childCount) node.getChild(i)?.let(::visit)
            }
            automation.windows.mapNotNull { it.root }.forEach(::visit)
            return all
        }
        fun capture(phase: String) {
            automation.takeScreenshot()?.let { bitmap ->
                val kind = if (readOnly) "readonly" else "writable"
                java.io.File(app.cacheDir, "appapi-selection-native-$kind-$phase.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
                bitmap.recycle()
            }
        }
        fun click(node: android.view.accessibility.AccessibilityNodeInfo): Boolean {
            var button: android.view.accessibility.AccessibilityNodeInfo? = node
            while (button != null && !button.isClickable) button = button.parent
            return button?.let { it.refresh() && it.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) } ?: false
        }
        try {
            graph.configStore.setAppLanguage(AppLanguage.English)
            app.startActivity(Intent().setComponent(ComponentName("com.agentoncloud.android.sharefixture",
                "com.andysagent.ragent.sharefixture.ProcessTextSourceActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                .putExtra("nativeMenu", true).putExtra("readOnly", readOnly).putExtra("material", material))
            compose.waitUntil(10_000) { nodes().any { it.text?.toString() == original } }
            // Accessibility can expose the entering window before its system-bar
            // insets and launch animation settle. Coordinates from that frame
            // can hit the status bar instead of the editor.
            automation.waitForIdle(500, 5_000)
            val editor = nodes().single { it.viewIdResourceName?.endsWith(":id/selected_material") == true }
            assertTrue(editor.refresh())
            capture("before")
            val bounds = android.graphics.Rect().also(editor::getBoundsInScreen)
            println("Native editor stable bounds: $bounds")
            val x = (bounds.left + bounds.width() / 3).toFloat()
            val y = bounds.centerY().toFloat()
            val downAt = android.os.SystemClock.uptimeMillis()
            android.view.MotionEvent.obtain(downAt, downAt, android.view.MotionEvent.ACTION_DOWN, x, y, 0).let {
                it.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
                try { assertTrue(automation.injectInputEvent(it, true)) } finally { it.recycle() }
            }
            android.os.SystemClock.sleep(700)
            android.view.MotionEvent.obtain(downAt, android.os.SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_UP, x, y, 0).let {
                it.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
                try { assertTrue(automation.injectInputEvent(it, true)) } finally { it.recycle() }
            }
            capture("after-press")
            compose.waitUntil(5_000) { nodes().any { it.text?.toString() == "Ragent" || it.contentDescription?.toString() == "More options" } }
            if (nodes().none { it.text?.toString() == "Ragent" }) {
                assertTrue(click(nodes().first { it.contentDescription?.toString() == "More options" }))
            }
            compose.waitUntil(5_000) { nodes().any { it.text?.toString() == "Ragent" } }
            automation.waitForIdle(300, 5_000)
            capture("menu")
            assertTrue(click(nodes().first { it.text?.toString() == "Ragent" }))
            compose.waitUntil(10_000) { runBlocking { graph.captureDrafts.observe(graph.appApiOwner).first()
                .any { it.input.source == CaptureSource.PROCESS_TEXT && it.input.sharedText == material } } }
            saved = graph.captureDrafts.observe(graph.appApiOwner).first()
                .single { it.input.source == CaptureSource.PROCESS_TEXT && it.input.sharedText == material }
            assertEquals(readOnly, saved!!.input.selectionReadOnly)
            assertNull(saved!!.operationId)
            compose.onNodeWithText("Close").performScrollTo().performClick()
            compose.waitUntil(5_000) { automation.windows.any { it.isActive &&
                it.root?.packageName?.toString() == "com.agentoncloud.android.sharefixture" } }
            automation.waitForIdle(500, 5_000)
            compose.waitUntil(5_000) { nodes().any { it.viewIdResourceName?.endsWith(":id/selected_material") == true && it.text?.toString() == original } }
            capture("returned")
            assertNull(graph.captureDrafts.get(saved!!.draftId, graph.appApiOwner)!!.operationId)
        } finally {
            capture("final")
            nodes().filter { it.viewIdResourceName?.endsWith(":id/selected_material") == true }.forEach {
                println("Native selection: ${it.textSelectionStart}..${it.textSelectionEnd}; " +
                    "actions=" + it.actionList.mapNotNull { action -> action.label }.joinToString())
            }
            automation.serviceInfo = oldServiceInfo
            instrumentation.runOnMainSync { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<ProcessTextActivity>().forEach { it.finish() } }
            saved?.let { graph.captureDrafts.get(it.draftId, graph.appApiOwner)?.let { latest ->
                graph.captureDrafts.delete(latest.draftId, graph.appApiOwner, latest.revision) } }
            graph.configStore.setAppLanguage(oldLanguage)
        }
    }
    @Test fun publicSelectionIgnoresForgedIdentitySurvivesRecreationAndCloseCancelsSource() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val token = UUID.randomUUID().toString()
        val material = "Synthetic public selected text $token"
        val oldLanguage = graph.configStore.appLanguage.first()
        var saved: CaptureDraft? = null
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        try {
            graph.configStore.setAppLanguage(AppLanguage.English)
            app.startActivity(Intent().setComponent(ComponentName("com.agentoncloud.android.sharefixture",
                "com.andysagent.ragent.sharefixture.ProcessTextSourceActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK).putExtra("token", token).putExtra("material", material))
            compose.waitUntil(10_000) {
                runBlocking { graph.captureDrafts.observe(graph.appApiOwner).first().any { it.input.sharedText == material } }
            }
            saved = graph.captureDrafts.observe(graph.appApiOwner).first().single { it.input.sharedText == material }
            assertNotEquals("forged", saved!!.draftId); assertEquals(graph.appApiOwner.binding, saved!!.callerBinding)
            assertEquals(CaptureSource.PROCESS_TEXT, saved!!.input.source); assertEquals(false, saved!!.input.selectionReadOnly)
            assertNull(saved!!.operationId)
            compose.onNodeWithContentDescription("What should the Agent do?").performTextReplacement("Keep this synthetic draft")
            instrumentation.runOnMainSync { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<ProcessTextActivity>().single().recreate() }
            compose.onNodeWithContentDescription("What should the Agent do?").assertTextContains("Keep this synthetic draft")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            compose.onNodeWithText("Close").performScrollTo().performClick()
            var returned: JSONObject? = null
            compose.waitUntil(10_000) {
                returned = runCatching {
                    val descriptor = instrumentation.uiAutomation.executeShellCommand("run-as com.agentoncloud.android.sharefixture cat files/selection-result.json")
                    JSONObject(ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() })
                        .takeIf { it.optString("token") == token }
                }.getOrNull()
                returned != null
            }
            assertEquals(android.app.Activity.RESULT_CANCELED, returned!!.getInt("resultCode"))
            assertNotEquals(android.os.Process.myUid(), returned!!.getInt("senderUid"))
            assertEquals("Before: $material :After", returned!!.getString("sourceText")); assertEquals("", returned!!.getString("extraKeys"))
            val draft = graph.captureDrafts.get(saved!!.draftId, graph.appApiOwner)!!
            assertEquals("Keep this synthetic draft", draft.instruction); assertNull(draft.operationId)
        } finally {
            instrumentation.runOnMainSync { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<ProcessTextActivity>().forEach { it.finish() } }
            saved?.let { graph.captureDrafts.get(it.draftId, graph.appApiOwner)?.let { latest ->
                graph.captureDrafts.delete(latest.draftId, graph.appApiOwner, latest.revision) } }
            graph.configStore.setAppLanguage(oldLanguage)
        }
    }
}
