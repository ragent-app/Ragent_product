package com.andysagent.ragent

import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Normal-size terminal geometry contracts; native recordings verify the motion between them. */
class ChatDockTransactionUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lightKeyboardCyclesKeepOneDraftAndReturnToTheSameDock() = verify(false)
    @Test fun darkKeyboardCyclesKeepOneDraftAndReturnToTheSameDock() = verify(true)

    /** Exercise Android key injection, not the semantics action's single text replacement. */
    @Test fun lightNativeKeyInputKeepsTheEntireDraft() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("theme", "light").putExtra("locale", "en")
            .putExtra("page", "chat").putExtra("font_scale", 1f)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            compose.onNodeWithContentDescription("Message composer").performClick()
            compose.waitUntil(10_000) {
                var visible = false
                scenario.onActivity {
                    visible = ViewCompat.getRootWindowInsets(it.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                visible && compose.onAllNodes(isFocused()).fetchSemanticsNodes().isNotEmpty()
            }
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("input text Native-draft")
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
            compose.waitForIdle()
            compose.onNodeWithText("Native-draft").assertIsDisplayed()
        }
    }

    private fun verify(dark: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("font_scale", 1f).putExtra("dark", dark)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            val composer = compose.onNodeWithTag("agent-composer")
            val initial = composer.assertIsDisplayed().getUnclippedBoundsInRoot()
            fun keyboardVisible(): Boolean {
                var visible = false
                scenario.onActivity {
                    visible = ViewCompat.getRootWindowInsets(it.window.decorView)
                        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                }
                return visible
            }
            repeat(3) { cycle ->
                compose.onNodeWithContentDescription("Message composer").performClick()
                compose.waitUntil(10_000) {
                    keyboardVisible() && composer.getUnclippedBoundsInRoot().bottom.value < initial.bottom.value - 80
                }
                if (cycle == 0) compose.onNodeWithTag("inline-composer-editor").performTextInput("Layout-draft")
                compose.onNodeWithText("Layout-draft").assertIsDisplayed()
                val raised = composer.getUnclippedBoundsInRoot()
                assertTrue("Expanded shell must be wider than its resting capsule",
                    raised.right - raised.left > initial.right - initial.left)
                val prompts = compose.onAllNodes(hasText("检查第", substring = true))
                val outsideTarget = prompts.fetchSemanticsNodes().indices.lastOrNull { index ->
                    val bounds = prompts[index].getUnclippedBoundsInRoot()
                    bounds.top > 80.dp && bounds.bottom < composer.getUnclippedBoundsInRoot().top
                }
                assertTrue("A visible transcript target above the composer must remain reachable", outsideTarget != null)
                prompts[requireNotNull(outsideTarget)].assertIsDisplayed().performTouchInput { click() }
                compose.waitUntil(10_000) {
                    !keyboardVisible() && kotlin.math.abs(composer.getUnclippedBoundsInRoot().bottom.value - initial.bottom.value) < 1
                }
                compose.waitForIdle()
                val resting = composer.getUnclippedBoundsInRoot()
                assertEquals(initial.bottom.value, resting.bottom.value, 1f)
                assertEquals((initial.right - initial.left).value, (resting.right - resting.left).value, 1f)
            }
            compose.onNodeWithContentDescription("Message composer").performClick()
            compose.onNodeWithText("Layout-draft").assertIsDisplayed()
        }
    }
}
