package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** The real IME remains open; sheet geometry must fit its actual viewport. */
class ComposerActionImeUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lightActionsStayAboveKeyboardAndKeepDraft() = verify("light", 1f)
    @Test fun darkActionsStayAboveKeyboardAndKeepDraft() = verify("dark", 1f)
    @Test fun largeTypeActionsScrollAboveKeyboard() = verify("light", 2f)

    private fun verify(theme: String, scale: Float) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, ComposerPickerQaActivity::class.java)
            .putExtra("theme", theme).putExtra("page", "chat").putExtra("locale", "en")
            .putExtra("font_scale", scale).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            compose.onNodeWithContentDescription("Message composer").performClick()
            val editor = compose.onNodeWithTag("inline-composer-editor")
            editor.performClick().performTextInput(" IME draft")
            val draft = editor.fetchSemanticsNode().config[SemanticsProperties.EditableText]
            fun imeVisible(): Boolean {
                var visible = false
                scenario.onActivity { visible = ViewCompat.getRootWindowInsets(it.window.decorView)
                    ?.isVisible(WindowInsetsCompat.Type.ime()) == true }
                return visible
            }
            compose.waitUntil(10_000) { imeVisible() }
            compose.onNodeWithContentDescription("Add attachment").performClick()
            compose.onNodeWithTag("composer-actions-title").assertIsDisplayed()
            compose.waitForIdle()
            assertTrue("Opening actions must not dismiss the IME", imeVisible())
            var imeTop = 0
            scenario.onActivity {
                val decor = it.window.decorView
                imeTop = decor.height - requireNotNull(ViewCompat.getRootWindowInsets(decor))
                    .getInsets(WindowInsetsCompat.Type.ime()).bottom
            }
            val content = compose.onNodeWithTag("composer-actions-content")
            assertTrue("Action content entered keyboard: ${content.fetchSemanticsNode().boundsInWindow}, imeTop=$imeTop",
                content.fetchSemanticsNode().boundsInWindow.bottom <= imeTop + 1f)
            compose.onNodeWithText("/learn").performScrollTo().assertIsDisplayed()
            // Scroll back before dismissing so the real close control is reachable.
            compose.onNodeWithTag("composer-actions-title").performScrollTo().assertIsDisplayed()
            compose.onNodeWithTag("composer-actions-close").assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp).performClick()
            compose.onNodeWithTag("composer-actions-title").assertDoesNotExist()
            assertTrue("Dismissal must keep the existing input session", imeVisible())
            assertEquals(draft, editor.fetchSemanticsNode().config[SemanticsProperties.EditableText])
        }
    }
}
