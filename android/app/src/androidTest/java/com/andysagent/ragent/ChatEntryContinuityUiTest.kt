package com.andysagent.ragent

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Entry-frame contracts, plus native video review; this is not an FPS claim. */
class ChatEntryContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var state: MutableState<WorkbenchUiState>
    private fun messages() = (1..36).map { index ->
        TimelineItem.Message(id = "entry-$index", seq = index.toLong(), completed = true,
            role = if (index % 3 == 0) TimelineRole.User else TimelineRole.Agent,
            text = if (index % 3 == 0) "Request $index" else
                "### Entry $index\n\n" + "A complete reviewed answer with retained sources. ".repeat(14) +
                    "\n\n- Keep originals\n- Review output\n\n```kotlin\nprintln($index)\n```")
    }
    private fun show(dark: Boolean) {
        state = mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Sessions,
            connection = AgentConnectionStatus.Connected, sessionId = "entry-session",
            sessionTitle = "Entry continuity", chatOpen = false, timelineItems = messages()))
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.Full) {
                WorkbenchScreen(state.value, onEvent = {})
            }
        }
        rule.waitForIdle()
    }
    private fun checkEntryFrames() {
        var published = 0
        var previous: Float? = null
        rule.mainClock.autoAdvance = false
        try {
            repeat(80) { frame ->
                rule.mainClock.advanceTimeByFrame()
                SystemClock.sleep(10) // Allow the real Default-dispatcher parse, not a mocked result.
                val nodes = rule.onAllNodesWithTag("chat-timeline").fetchSemanticsNodes()
                nodes.forEach { node ->
                    val position = node.config[SemanticsProperties.VerticalScrollAxisRange].value()
                    assertTrue("Visible entry exposed item zero at frame $frame", position >= 1f)
                    previous?.let { assertEquals("Published viewport changed at frame $frame", it, position, 0.01f) }
                    previous = position
                    published++
                }
                rule.onAllNodesWithText("### Entry", substring = true).assertCountEquals(0)
                rule.onAllNodesWithText("```kotlin", substring = true).assertCountEquals(0)
            }
            assertTrue("Prepared entry never became readable", published > 0)
        } finally { rule.mainClock.autoAdvance = true }
        rule.waitForIdle()
        rule.onNodeWithText("Entry 34").assertIsDisplayed()
    }
    private fun entry(dark: Boolean, delayed: Boolean) {
        show(dark)
        rule.runOnIdle { state.value = state.value.copy(chatOpen = true,
            historyLoading = delayed, timelineItems = if (delayed) emptyList() else messages(),
            timelineSessionId = "entry-session") }
        if (delayed) {
            rule.runOnIdle { state.value = state.value.copy(historyLoading = false, timelineItems = messages()) }
        }
        checkEntryFrames()
    }
    @Test fun availableHistoryDoesNotPublishAnEarlierViewportLight() = entry(false, false)
    @Test fun availableHistoryDoesNotPublishAnEarlierViewportDark() = entry(true, false)
    @Test fun asynchronouslyArrivingHistoryUsesTheSameEntryTransaction() = entry(false, true)

    @Test fun shortExchangeRemainsWholeAboveTheComposer() {
        show(false)
        rule.runOnIdle { state.value = state.value.copy(chatOpen = true, timelineItems = listOf(
            TimelineItem.Message("short-user", seq = 1, role = TimelineRole.User, text = "Keep the originals", completed = true),
            TimelineItem.Message("short-answer", seq = 2, role = TimelineRole.Agent, text = "## Done\n\nOriginals were preserved.", completed = true))) }
        rule.onNodeWithText("Keep the originals").assertIsDisplayed()
        rule.onNodeWithText("Done").assertIsDisplayed()
        val answer = rule.onNodeWithText("Originals were preserved.").getUnclippedBoundsInRoot()
        val composer = rule.onNodeWithTag("agent-composer").getUnclippedBoundsInRoot()
        assertTrue(answer.bottom < composer.top)
    }

    @Test fun reversingACloseKeepsTheReaderViewport() {
        show(false)
        rule.runOnIdle { state.value = state.value.copy(chatOpen = true) }
        rule.onNodeWithTag("chat-timeline").performScrollToNode(hasText("Entry 10"))
        fun position() = rule.onNodeWithTag("chat-timeline").fetchSemanticsNode()
            .config[SemanticsProperties.VerticalScrollAxisRange].value()
        val before = position()
        rule.mainClock.autoAdvance = false
        try {
            rule.runOnIdle { state.value = state.value.copy(chatOpen = false) }
            rule.mainClock.advanceTimeBy(48)
            assertEquals(before, position(), 0.01f)
            rule.runOnIdle { state.value = state.value.copy(chatOpen = true) }
            repeat(30) {
                rule.mainClock.advanceTimeByFrame()
                assertEquals("Close reversal reset the retained transcript", before, position(), 0.01f)
            }
        } finally { rule.mainClock.autoAdvance = true }
    }
}
