package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.width
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentComposer
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Explicit phases expose a second header clock that normal settled tests miss. */
class ComposerHeaderPhaseUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var phase by mutableFloatStateOf(0f)
    private var target by mutableStateOf(false)
    private var draft by mutableStateOf("One\nTwo\nThree\nFour\nFive\nSix")
    private val fullscreenRequests = mutableListOf<Boolean>()
    private fun show() {
        rule.setContent {
            RagentTheme(darkTheme = false) {
                AgentComposer(value = draft, onValueChange = { draft = it },
                    onSend = {}, onStop = {}, working = false, onAddAttachment = {},
                    expanded = true, modifier = Modifier.width(390.dp),
                    fullscreen = target, fullscreenProgress = phase, fullscreenHeight = 550.dp,
                    onFullscreenChange = { fullscreenRequests += it })
            }
        }
        rule.waitForIdle()
    }
    private fun headerHeight() = rule.onNodeWithTag("composer-morph-header", useUnmergedTree = true)
        .fetchSemanticsNode().boundsInRoot.height
    private fun set(p: Float, fullscreen: Boolean) {
        rule.runOnIdle { phase = p; target = fullscreen }
        rule.waitForIdle()
    }
    @Test fun measuredHeaderFollowsTheShellPhaseInBothDirections() {
        show()
        val inline = headerHeight()
        assertEquals(48f * rule.density.density, inline, rule.density.density)
        set(1f, true)
        val full = headerHeight()
        assertEquals("Normal-size editor tools should use one compact row", inline, full, rule.density.density)
        for (fullscreen in listOf(true, false)) {
            for (p in listOf(.1f, .25f, .5f, .75f, .9f)) {
                set(p, fullscreen)
                assertEquals("Independent header clock at p=$p target=$fullscreen",
                    inline * (1f - (p / .35f).coerceIn(0f, 1f)) + full * (p / .35f).coerceIn(0f, 1f),
                    headerHeight(), rule.density.density)
            }
        }
    }
    @Test fun shortenedDocumentUsesTheCurrentReturnEndpoint() {
        show()
        set(1f, true)
        rule.runOnIdle { draft = "Short" }
        rule.waitForIdle()
        val full = headerHeight()
        set(.175f, false)
        assertEquals(full * .5f, headerHeight(), rule.density.density)
        set(0f, false)
        assertEquals(0f, headerHeight(), rule.density.density)
    }
    @Test fun fadingDoneCannotHitTheInvisibleFullscreenEntry() {
        show()
        set(.75f, false)
        rule.onNodeWithTag("composer-morph-header", useUnmergedTree = true).performTouchInput {
            click(Offset(width - 28.dp.toPx(), 24.dp.toPx()))
        }
        rule.runOnIdle { assertTrue(fullscreenRequests.isEmpty()) }
        set(.25f, false)
        rule.onNodeWithContentDescription(rule.activity.getString(
            com.andysagent.ragent.core.agentui.R.string.agentui_fullscreen_edit)).performClick()
        rule.runOnIdle { assertEquals(listOf(true), fullscreenRequests) }
    }
    @Test fun fullscreenLabelsAlwaysFitAndDoNotShareTheInlineControlPhase() {
        show()
        val title = rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_edit_message)
        val entry = rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_fullscreen_edit)
        // Include the case whose inline endpoint has zero height.
        for (text in listOf(draft, "Short")) {
            rule.runOnIdle { draft = text }
            for (p in listOf(.1f, .25f, .35f, .36f, .5f, .75f, 1f)) {
                set(p, true)
                rule.onNodeWithContentDescription(entry).assertDoesNotExist()
                if (p <= .35f) rule.onNodeWithText(title).assertDoesNotExist()
                else {
                    val header = rule.onNodeWithTag("composer-morph-header", useUnmergedTree = true)
                        .fetchSemanticsNode().boundsInRoot
                    val labels = rule.onNodeWithText(title).fetchSemanticsNode().boundsInRoot
                    val count = text.codePointCount(0, text.length)
                    val lines = text.count { it == '\n' } + 1
                    val resources = rule.activity.resources
                    val statistics = resources.getString(com.andysagent.ragent.core.agentui.R.string.agentui_draft_statistics,
                        resources.getQuantityString(com.andysagent.ragent.core.agentui.R.plurals.agentui_draft_characters, count, count),
                        resources.getQuantityString(com.andysagent.ragent.core.agentui.R.plurals.agentui_draft_lines, lines, lines))
                    val metadata = rule.onNodeWithText(statistics).fetchSemanticsNode().boundsInRoot
                    assertTrue("Title outside measured header at $p", labels.top >= header.top && labels.bottom <= header.bottom)
                    assertTrue("Statistics outside measured header at $p", metadata.top >= header.top && metadata.bottom <= header.bottom)
                }
            }
            set(.25f, false)
            rule.onNodeWithText(title).assertDoesNotExist()
        }
    }
}
