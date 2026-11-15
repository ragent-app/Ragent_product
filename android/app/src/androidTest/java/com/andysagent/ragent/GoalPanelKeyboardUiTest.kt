package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Real IME visibility/insets, rather than text injection without a keyboard. */
class GoalPanelKeyboardUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun focusedInputAndSaveStayAboveTheRealKeyboard() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "en").putExtra("panel", "goal")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            compose.onNodeWithContentDescription("Session goal").performClick()
            var keyboardTop = 0
            compose.waitUntil(10_000) {
                var visible = false
                scenario.onActivity {
                    val view = it.window.decorView
                    val insets = ViewCompat.getRootWindowInsets(view)
                    visible = insets?.isVisible(WindowInsetsCompat.Type.ime()) == true
                    keyboardTop = view.height - (insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0)
                }
                visible
            }
            compose.waitForIdle()
            val input = compose.onNodeWithContentDescription("Session goal")
            input.assertIsDisplayed().performTextInput("Keyboard draft")
            assertTrue("Focused input is covered by IME",
                input.fetchSemanticsNode().boundsInWindow.bottom <= keyboardTop + 1)
            val save = compose.onNodeWithText("Save goal")
            save.performScrollTo().assertIsDisplayed()
            assertTrue("Save is covered by IME",
                save.fetchSemanticsNode().boundsInWindow.bottom <= keyboardTop + 1)
            save.performClick()
            compose.onNodeWithContentDescription("Close goal panel").assertDoesNotExist()
        }
    }
}
