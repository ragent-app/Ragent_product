package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import kotlinx.coroutines.awaitCancellation
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertSame
import org.junit.Rule
import org.junit.Test

/** Real chat host, not the standalone fullscreen preview. */
@OptIn(ExperimentalTestApi::class, ExperimentalComposeUiApi::class)
class ComposerFullscreenContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val original = "First line\nSecond line\nThird line\nFourth line\nFifth line\n**Important**: verify `healthz`"
    private var state by mutableStateOf(WorkbenchUiState())
    private val events = mutableListOf<WorkbenchEvent>()
    private var controlledIme = false
    private var inputConnection: InputConnection? = null
    private var inputSessions = 0
    private fun label(id: Int) = rule.activity.getString(id)
    private fun inline() = rule.onNodeWithTag("inline-composer-editor")
    private fun full() = rule.onNodeWithTag("fullscreen-composer-editor")
    private fun open() = rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_fullscreen_edit)).performClick()
    private fun close() = rule.onNodeWithText(label(AgentUiR.string.agentui_done)).performClick()
    private fun imeVisible() = ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
        ?.isVisible(WindowInsetsCompat.Type.ime()) == true

    private fun show() {
        state = WorkbenchUiState(chatOpen = true, sessionId = "continuity-local-test", composerText = original)
        rule.setContent {
            RagentTheme(darkTheme = false) {
                InterceptPlatformTextInput(androidx.compose.runtime.remember {
                    PlatformTextInputInterceptor { request, next ->
                        if (!controlledIme) next.startInputMethod(request)
                        val connection = request.createInputConnection(EditorInfo())
                        inputConnection = connection
                        inputSessions++
                        try { awaitCancellation() } finally {
                            connection.closeConnection()
                            inputConnection = null
                        }
                    }
                }) {
                    WorkbenchScreen(state = state, onEvent = {
                        events += it
                        if (it is WorkbenchEvent.ComposerChanged) state = state.copy(composerText = it.text)
                    })
                }
            }
        }
        rule.waitForIdle()
    }

    @Test fun expansionAndReturnKeepTheSameEditorAndSelection() {
        show()
        inline().performClick().performTextInputSelection(TextRange(3, 8))
        val before = inline().fetchSemanticsNode()
        open()
        full().assertIsDisplayed()
        assertEquals("Editor was recreated on expansion", before.id, full().fetchSemanticsNode().id)
        assertEquals(TextRange(3, 8), full().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_back)).assertDoesNotExist()
        close()
        assertEquals("Editor was recreated on return", before.id, inline().fetchSemanticsNode().id)
        assertEquals(TextRange(3, 8), inline().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        rule.runOnIdle {
            assertEquals(original, state.composerText)
            assertTrue(events.none { it == WorkbenchEvent.SendMessage })
        }
    }

    @Test fun keyboardStaysVisibleAcrossBothDirections() {
        show()
        inline().performClick()
        rule.waitUntil(10_000) { imeVisible() }
        open()
        full().assertIsFocused()
        assertTrue("IME lost on expansion", imeVisible())
        close()
        inline().assertIsFocused()
        assertTrue("IME lost on return", imeVisible())
    }

    @Test fun firstKeyboardOpeningKeepsFullscreenHeaderInsideTheSafeArea() {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            // Both MainActivity and the QA host declare adjustResize. The
            // generic Compose test activity otherwise uses the OS heuristic,
            // which can pan the entire root when the first IME opens.
            rule.activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        show()
        rule.runOnUiThread {
            androidx.core.view.WindowInsetsControllerCompat(rule.activity.window, rule.activity.window.decorView)
                .hide(WindowInsetsCompat.Type.ime())
        }
        rule.waitUntil(10_000) { !imeVisible() }
        // Do not focus the inline editor first: fullscreen and the first IME
        // animation must start together, as they do from the actual entry.
        rule.mainClock.autoAdvance = false
        open()
        var observedHeaders = 0
        repeat(40) { frame ->
            rule.mainClock.advanceTimeByFrame()
            val header = rule.onAllNodesWithText(label(AgentUiR.string.agentui_done))
                .fetchSemanticsNodes().singleOrNull()
            if (header != null && header.boundsInWindow.height > 0f) {
                observedHeaders++
                val safeTop = ViewCompat.getRootWindowInsets(rule.activity.window.decorView)
                    ?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: error("Missing status bar insets")
                val composerBounds = rule.onNodeWithTag("fullscreen-composer").fetchSemanticsNode().boundsInWindow
                assertTrue("Done entered status bar on frame $frame: ${header.boundsInWindow}, composer=$composerBounds, safeTop=$safeTop",
                    header.boundsInWindow.top >= safeTop - 1f)
            }
        }
        rule.mainClock.autoAdvance = true
        assertTrue("No fullscreen header observed", observedHeaders > 0)
        rule.waitUntil(10_000) { imeVisible() }
        full().assertIsFocused()
        rule.runOnIdle { assertEquals(original, state.composerText) }
    }

    @Test fun everyAnimationFrameRetainsTheDocumentAndEditorNode() {
        show()
        val id = inline().fetchSemanticsNode().id
        rule.mainClock.autoAdvance = false
        open()
        repeat(24) {
            rule.mainClock.advanceTimeByFrame()
            val node = full().fetchSemanticsNode()
            assertEquals("Editor replaced on frame $it", id, node.id)
            assertTrue("Document absent on frame $it", node.config[SemanticsProperties.EditableText].text.contains("healthz"))
        }
        close()
        repeat(24) {
            rule.mainClock.advanceTimeByFrame()
            val node = rule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().single()
            assertEquals("Editor replaced on closing frame $it", id, node.id)
            assertTrue("Document absent on closing frame $it", node.config[SemanticsProperties.EditableText].text.contains("healthz"))
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun fullscreenEntryHasAFullTouchTarget() {
        show()
        rule.onNodeWithContentDescription(label(AgentUiR.string.agentui_fullscreen_edit))
            .assertHeightIsAtLeast(48.dp).assertWidthIsAtLeast(48.dp)
    }

    @Test fun uncommittedCjkCompositionKeepsItsInputConnection() {
        controlledIme = true
        show()
        inline().performClick()
        rule.waitUntil(5_000) { inputConnection != null }
        val originalConnection = requireNotNull(inputConnection)
        rule.runOnIdle { originalConnection.setComposingText("中文", 1) }
        open()
        rule.runOnIdle {
            assertSame(originalConnection, inputConnection)
            assertEquals(1, inputSessions)
        }
        assertTrue(full().fetchSemanticsNode().config[SemanticsProperties.EditableText].text.contains("中文"))
        close()
        rule.runOnIdle {
            assertSame(originalConnection, inputConnection)
            assertEquals(1, inputSessions)
            originalConnection.finishComposingText()
        }
        assertTrue(inline().fetchSemanticsNode().config[SemanticsProperties.EditableText].text.contains("中文"))
    }

    @Test fun reversingTheTransitionKeepsTheDraftAndEditor() {
        show()
        val id = inline().fetchSemanticsNode().id
        rule.mainClock.autoAdvance = false
        open()
        rule.mainClock.advanceTimeBy(96)
        // Geometry is still being established: Done is not painted/live yet.
        // Reverse through the activity's real Back dispatcher at the same tick,
        // rather than clicking a retained invisible endpoint in an unmerged tree.
        rule.onNodeWithText(label(AgentUiR.string.agentui_done)).assertDoesNotExist()
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.mainClock.advanceTimeBy(48)
        open()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(id, full().fetchSemanticsNode().id)
        close()
        rule.mainClock.advanceTimeBy(500)
        assertEquals(id, inline().fetchSemanticsNode().id)
        rule.mainClock.autoAdvance = true
        rule.runOnIdle { assertEquals(original, state.composerText) }
    }

    @Test fun shorteningTheFullscreenDraftDoesNotCauseASecondHeightTransition() {
        controlledIme = true
        show()
        open()
        full().performTextReplacement("Short")
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        close()
        var settledHeight: Float? = null
        // Observe the first inline frame, rather than assuming the animation
        // began on the exact clock tick of the semantic click.
        for (frame in 0 until 32) {
            rule.mainClock.advanceTimeByFrame()
            val node = rule.onAllNodesWithTag("agent-composer").fetchSemanticsNodes().singleOrNull()
            if (node != null) {
                settledHeight = node.boundsInRoot.height
                break
            }
        }
        val firstInlineHeight = requireNotNull(settledHeight) { "Fullscreen did not settle within 32 frames" }
        rule.mainClock.advanceTimeBy(320)
        val laterHeight = rule.onNodeWithTag("agent-composer").fetchSemanticsNode().boundsInRoot.height
        assertTrue("Second size transition after fullscreen finished: $firstInlineHeight -> $laterHeight",
            kotlin.math.abs(firstInlineHeight - laterHeight) <= rule.density.density)
        rule.mainClock.autoAdvance = true
        rule.runOnIdle { assertEquals("Short", state.composerText) }
    }

    @Test fun clearingFullscreenDraftReturnsWithoutSending() {
        controlledIme = true
        show()
        open()
        full().performTextClearance()
        close()
        rule.onNodeWithTag("fullscreen-composer").assertDoesNotExist()
        rule.onNodeWithTag("agent-composer").assertIsDisplayed()
        rule.runOnIdle {
            assertEquals("", state.composerText)
            assertTrue(events.none { it == WorkbenchEvent.SendMessage })
        }
    }
}
