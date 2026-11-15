package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.clickable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.FullscreenComposerModal
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Production full-screen editor, with event spies instead of network submission. */
class FullscreenComposerUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private var draft by mutableStateOf("")
    private val events = mutableListOf<String>()

    private fun label(id: Int) = compose.activity.getString(id)

    private fun show(text: String = "Draft", enabled: Boolean = true, working: Boolean = false, attachments: Boolean = false) {
        draft = text
        compose.setContent {
            var open by androidx.compose.runtime.remember { mutableStateOf(true) }
            RagentTheme(darkTheme = false) {
                if (open) FullscreenComposerModal(
                    value = draft, onValueChange = { draft = it },
                    onDismiss = { events += "dismiss"; open = false },
                    onSend = { events += "send:$draft" },
                    onStop = { events += "stop" },
                    enabled = enabled, working = working, hasAttachments = attachments,
                ) else Text("Returned draft: $draft")
            }
        }
    }

    @Test fun doneKeepsEditedDraftWithoutSending() {
        show()
        compose.onNodeWithTag("fullscreen-composer-editor").performTextInput(" revised")
        compose.onNodeWithText(label(AgentUiR.string.agentui_done)).assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText("Returned draft: Draft revised").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("dismiss"), events) }
    }

    @Test fun collapseHasNamedLargeTargetAndDoesNotSend() {
        show()
        compose.onNodeWithContentDescription(label(AgentUiR.string.agentui_return_to_composer))
            .assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp).performClick()
        compose.onNodeWithText("Returned draft: Draft").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("dismiss"), events) }
    }

    @Test fun disabledEditorCannotEditOrSend() {
        show(enabled = false)
        compose.onNodeWithTag("fullscreen-composer-editor").assertIsNotEnabled()
        compose.onNodeWithContentDescription(label(AgentUiR.string.agentui_send_message)).assertIsNotEnabled()
        compose.runOnIdle { assertEquals("Draft", draft); assertEquals(emptyList<String>(), events) }
    }

    @Test fun footerHasAnUnclippedOnScreenTouchTarget() {
        show(enabled = false)
        compose.waitForIdle()
        val automation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation
        val sendLabel = label(AgentUiR.string.agentui_send_message)
        fun find(node: android.view.accessibility.AccessibilityNodeInfo): android.view.accessibility.AccessibilityNodeInfo? {
            if (node.contentDescription?.toString() == sendLabel) return node
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { child -> find(child)?.let { return it } }
            }
            return null
        }
        var bounds: android.graphics.Rect? = null
        // Compose idle can precede the native accessibility window event.
        compose.waitUntil(5_000) {
            val send = automation.rootInActiveWindow?.let(::find)
            bounds = send?.let { android.graphics.Rect().also(it::getBoundsInScreen) }
            bounds != null
        }
        val nativeBounds = requireNotNull(bounds)
        val metrics = compose.activity.resources.displayMetrics
        val navBottom = androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)
            ?.getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars())?.bottom ?: 0
        assertTrue("native hit target is clipped: $nativeBounds", nativeBounds.height() >= (48 * metrics.density).toInt())
        assertTrue("footer overlaps system navigation: $nativeBounds", nativeBounds.bottom <= metrics.heightPixels - navBottom)
    }

    @Test fun sendEmitsOnceThenCloses() {
        show()
        compose.onNodeWithContentDescription(label(AgentUiR.string.agentui_send_message)).performClick()
        compose.onNodeWithTag("fullscreen-composer").assertDoesNotExist()
        compose.runOnIdle { assertEquals(listOf("send:Draft", "dismiss"), events) }
    }

    @Test fun workingEmptyDraftStopsWithoutClosing() {
        show(text = "", working = true)
        compose.onNodeWithContentDescription(label(AgentUiR.string.agentui_stop_generating)).performClick()
        compose.onNodeWithTag("fullscreen-composer").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf("stop"), events) }
    }

    @Test fun attachmentOnlyDraftSendsInsteadOfStopping() {
        show(text = "", working = true, attachments = true)
        compose.onNodeWithContentDescription(label(AgentUiR.string.agentui_send_message)).performClick()
        compose.runOnIdle { assertEquals(listOf("send:", "dismiss"), events) }
    }

    @Test fun blankFooterDoesNotClickTheUnderlyingPage() {
        var underlyingClicks = 0
        compose.setContent {
            RagentTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize().clickable { underlyingClicks++ })
                    FullscreenComposerModal(
                        value = "Draft", onValueChange = {}, onDismiss = {}, onSend = {}, enabled = false,
                    )
                }
            }
        }
        compose.onNodeWithTag("fullscreen-composer").performTouchInput {
            click(Offset(24.dp.toPx(), height - 24.dp.toPx()))
        }
        compose.runOnIdle { assertEquals("Tap passed through the fullscreen footer", 0, underlyingClicks) }
    }
}
