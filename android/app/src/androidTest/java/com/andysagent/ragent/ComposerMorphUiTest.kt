package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class ComposerMorphUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var open by mutableStateOf(false)
    private var draft by mutableStateOf("")
    private val actions = mutableListOf<String>()
    private fun show(scale: Float = 1f, motion: MotionPreference = MotionPreference.Full, initial: String = "") {
        draft = initial
        open = initial.isNotEmpty()
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, scale)) {
                RagentTheme(darkTheme = false, motionPreference = motion) {
                    Box(Modifier.width(320.dp).height(500.dp), contentAlignment = Alignment.BottomCenter) {
                        AgentComposer(value = draft, onValueChange = { draft = it },
                            onSend = { actions += "send" }, onStop = {}, working = false, attachmentsEnabled = true,
                            onAddAttachment = { actions += "attachment" }, expanded = open, onExpandedChange = { open = it })
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(1500)
        rule.waitForIdle()
    }

    private fun editor() = rule.onNodeWithTag("inline-composer-editor")
    private fun verifyFrames(scale: Float, initial: String) {
        show(scale = scale, initial = initial)
        val id = editor().fetchSemanticsNode().id
        val anchor = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot().bottom
        rule.mainClock.autoAdvance = false
        for (target in listOf(false, true, false, true, false)) {
            rule.runOnIdle { open = target }
            repeat(32) { frame ->
                rule.mainClock.advanceTimeByFrame()
                rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
                val node = editor().fetchSemanticsNode()
                assertEquals("Editor replaced at $target/$frame", id, node.id)
                if (initial.isNotEmpty()) assertTrue("Document absent at $target/$frame",
                    node.config[SemanticsProperties.EditableText].text.contains("Draft"))
                val bounds = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
                assertEquals(anchor.value, bounds.bottom.value, 1f)
                assertTrue(bounds.bottom - bounds.top >= 48.dp)
            }
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun oneEditorAcrossOrdinaryEmptyMorph() = verifyFrames(1f, "")
    @Test fun oneEditorAcrossLargeDraftMorph() = verifyFrames(2f, "Draft kept")
    @Test fun oneEditorAcrossRichMultilineMorph() = verifyFrames(1f, "Draft\n**Important** `healthz`\nLast line")

    private fun verifyCompactEdgeTargets(scale: Float) {
        show(scale = scale, initial = "Draft kept")
        rule.runOnIdle { open = false }
        rule.waitForIdle()
        rule.onNodeWithTag("composer-attachment-action").performTouchInput { click() }
        rule.onNodeWithTag("composer-send-action").performTouchInput { click() }
        rule.runOnIdle { assertEquals(listOf("attachment", "send"), actions) }
    }
    @Test fun compactEditorDoesNotCoverEdgeTargets() = verifyCompactEdgeTargets(1f)
    @Test fun largeCompactEditorDoesNotCoverEdgeTargets() = verifyCompactEdgeTargets(2f)

    @Test fun quickReversalDoesNotCreateAnotherDocument() {
        show(initial = "Draft kept")
        val id = editor().fetchSemanticsNode().id
        rule.mainClock.autoAdvance = false
        repeat(8) { cycle ->
            rule.runOnIdle { open = cycle % 2 == 0 }
            repeat(4) {
                rule.mainClock.advanceTimeByFrame()
                rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
                assertEquals(id, editor().fetchSemanticsNode().id)
            }
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun selectionSurvivesCollapseAndReopen() {
        show(initial = "Draft kept")
        editor().performClick().performTextInputSelection(TextRange(2, 5))
        assertEquals("Selection precondition was not established", TextRange(2, 5),
            editor().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        val id = editor().fetchSemanticsNode().id
        rule.runOnIdle { open = false }
        rule.waitForIdle()
        rule.runOnIdle { open = true }
        rule.waitForIdle()
        assertEquals(id, editor().fetchSemanticsNode().id)
        assertEquals(TextRange(2, 5), editor().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        rule.runOnIdle { assertEquals("Draft kept", draft) }
    }

    @Test fun focusedReopeningKeepsTheMostRecentSelectionAcrossTwoCycles() {
        show(initial = "Draft kept")
        editor().performClick()
        // Establish two different ranges the field's semantics actually accepts;
        // the reversed request was normalized before collapse, not lost on reopen.
        // Reverse-direction retention is independently covered by the unit test.
        for (selection in listOf(TextRange(2, 5), TextRange(3, 7))) {
            editor().performTextInputSelection(selection)
            assertEquals(selection, editor().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
            rule.runOnIdle { open = false }
            rule.waitForIdle()
            rule.onNodeWithContentDescription(rule.activity.getString(
                com.andysagent.ragent.core.agentui.R.string.agentui_message_composer)).performClick()
            rule.waitForIdle()
            editor().assertIsFocused()
            assertEquals(selection, editor().fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange])
        }
    }

    @Test fun replacingTheInactiveDocumentCannotRestoreAnOldOutOfBoundsRange() {
        show(initial = "Draft kept")
        editor().performClick().performTextInputSelection(TextRange(2, 8))
        rule.runOnIdle { open = false }
        rule.waitForIdle()
        rule.runOnIdle { draft = "New" }
        rule.waitForIdle()
        editor().performClick()
        val node = editor().fetchSemanticsNode()
        assertEquals("New", node.config[SemanticsProperties.EditableText].text)
        val selection = node.config[SemanticsProperties.TextSelectionRange]
        assertTrue(selection.start in 0..3 && selection.end in 0..3)
    }

    @Test fun noMotionSettlesInOneFrameWithoutRetainedOutgoingEditor() {
        show(motion = MotionPreference.None)
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { open = true }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        val expanded = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
        assertEquals(320f, (expanded.right - expanded.left).value, 1f)
        assertTrue("Editor fell below its 44dp minimum: $expanded", expanded.bottom - expanded.top >= 92.dp)
        rule.mainClock.advanceTimeBy(500)
        assertEquals("No-motion geometry continued animating", expanded,
            rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot())
        rule.runOnIdle { open = false }
        rule.mainClock.advanceTimeByFrame()
        rule.mainClock.advanceTimeByFrame()
        rule.onNodeWithTag("agent-composer").assertHeightIsEqualTo(48.dp)
        rule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
        rule.mainClock.autoAdvance = true
    }

    @Test fun reducedMotionSettlesWithinShortDuration() {
        show(motion = MotionPreference.Reduced)
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { open = true }
        rule.mainClock.advanceTimeBy(160)
        val expanded = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
        assertEquals(320f, (expanded.right - expanded.left).value, 1f)
        assertTrue("Editor fell below its 44dp minimum: $expanded", expanded.bottom - expanded.top >= 92.dp)
        rule.mainClock.advanceTimeBy(500)
        assertEquals("Reduced motion did not settle at 120ms", expanded,
            rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot())
        rule.runOnIdle { open = false }
        rule.mainClock.advanceTimeBy(160)
        rule.onNodeWithTag("agent-composer").assertHeightIsEqualTo(48.dp)
        rule.mainClock.autoAdvance = true
    }
}
