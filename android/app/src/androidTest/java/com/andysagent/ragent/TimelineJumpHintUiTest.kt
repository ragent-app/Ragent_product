package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.ScrollToBottomFab
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Exercise the real LazyColumn/input adapter and the clock-driven expiry together. */
class TimelineJumpHintUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var state: MutableState<WorkbenchUiState>
    private val timeline get() = rule.onNodeWithTag("chat-timeline")
    private val hint get() = rule.onNodeWithTag("scroll-to-bottom")

    private fun show(dark: Boolean = false) {
        state = mutableStateOf(WorkbenchUiState(
            chatOpen = true, sessionId = "jump-hint-test", sessionTitle = "Transient return hint",
            connection = AgentConnectionStatus.Connected,
            timelineItems = (1..36).map { index ->
                TimelineItem.Message("hint-$index", index.toLong(),
                    if (index % 3 == 0) TimelineRole.User else TimelineRole.Agent,
                    if (index % 3 == 0) "Request $index" else
                        "Answer $index. " + "Read the retained sources and review the next step. ".repeat(20),
                    completed = true)
            },
        ))
        rule.setContent { RagentTheme(darkTheme = dark) { WorkbenchScreen(state.value, onEvent = {}) } }
        timeline.assertExists()
        rule.waitForIdle()
        hint.assertDoesNotExist()
        rule.mainClock.autoAdvance = false
        rule.mainClock.advanceTimeBy(400)
    }

    private fun scrollAndReveal() {
        timeline.performTouchInput {
            swipeDown(startY = height * 0.40f, endY = height * 0.65f, durationMillis = 600)
        }
        repeat(180) {
            rule.mainClock.advanceTimeByFrame()
            if (rule.onAllNodesWithTag("scroll-to-bottom").fetchSemanticsNodes().isNotEmpty()) {
                rule.mainClock.advanceTimeBy(128)
                hint.assertIsDisplayed()
                return
            }
        }
        fail("No hint after the user's drag/fling stopped")
    }

    private fun verifyTransient(dark: Boolean) {
        show(dark)
        timeline.performTouchInput {
            down(Offset(centerX, height * 0.4f))
            moveTo(Offset(centerX, height * 0.65f), delayMillis = 400)
        }
        rule.mainClock.advanceTimeBy(300)
        hint.assertDoesNotExist()
        timeline.performTouchInput { up() }
        scrollAndReveal()
        val disc = hint.fetchSemanticsNode().boundsInRoot
        val glyph = rule.onNodeWithTag("scroll-to-bottom-glyph", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals(disc.center.x, glyph.center.x, 1f)
        assertEquals(disc.center.y, glyph.center.y, 1f)
        val position = timeline.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value()
        rule.mainClock.advanceTimeBy(700)
        hint.assertIsDisplayed()
        rule.mainClock.advanceTimeBy(1_100)
        hint.assertDoesNotExist()
        rule.onNodeWithTag("scroll-to-bottom-exit").assertDoesNotExist()
        assertEquals("Expiry moved the reading position", position,
            timeline.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange].value(), 0.01f)
        scrollAndReveal()
        rule.mainClock.autoAdvance = true
    }

    @Test fun lightDragStopExpireAndRedisplay() = verifyTransient(false)
    @Test fun darkDragStopExpireAndRedisplay() = verifyTransient(true)

    @Test fun streamingReplyDoesNotKeepRefreshingTheHint() {
        show()
        scrollAndReveal()
        rule.mainClock.advanceTimeBy(1_900)
        hint.assertDoesNotExist()
        val original = state.value.timelineItems
        repeat(8) { chunk ->
            rule.runOnUiThread {
                state.value = state.value.copy(unseenCount = chunk + 1,
                    timelineItems = original + TimelineItem.Message(
                        "incoming-reply", 100L + chunk, TimelineRole.Agent,
                        "A new streaming answer. ".repeat(chunk + 1), completed = chunk == 7,
                        runId = "one-incoming-run"))
            }
            rule.mainClock.advanceTimeBy(300)
            if (chunk == 0) hint.assertIsDisplayed()
        }
        hint.assertDoesNotExist()
        rule.mainClock.autoAdvance = true
    }

    @Test fun closingAPickerDoesNotResurrectTheExpiredHint() {
        show()
        for (effort in listOf(true, false)) {
            scrollAndReveal()
            rule.runOnUiThread { state.value = state.value.copy(effortPickerOpen = effort, runtimePickerOpen = !effort) }
            rule.mainClock.advanceTimeBy(500)
            hint.assertDoesNotExist()
            rule.runOnUiThread { state.value = state.value.copy(effortPickerOpen = false, runtimePickerOpen = false) }
            rule.mainClock.advanceTimeBy(600)
            hint.assertDoesNotExist()
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun clickReturnsToTheRealTailWithoutShowingAnotherHint() {
        show()
        rule.mainClock.autoAdvance = true
        timeline.performScrollToNode(hasText("Request 18"))
        // Semantics scrolling is accessibility user input, not scrollToItem().
        // It legitimately creates a hint; entry/programmatic positioning is
        // covered by show() and the controller regression tests.
        rule.mainClock.autoAdvance = false
        scrollAndReveal()
        hint.performClick()
        rule.mainClock.advanceTimeBy(3_000)
        hint.assertDoesNotExist()
        rule.onNodeWithText("Request 36").assertIsDisplayed()
        rule.mainClock.advanceTimeBy(2_000)
        hint.assertDoesNotExist()
        rule.mainClock.autoAdvance = true
    }

    @Test fun manualDragInterruptsReturnWithoutForcingTheReaderBackDown() {
        show()
        rule.mainClock.autoAdvance = true
        timeline.performScrollToNode(hasText("Request 9"))
        rule.mainClock.autoAdvance = false
        scrollAndReveal()
        hint.performClick()
        rule.mainClock.advanceTimeBy(32)
        timeline.performTouchInput {
            swipeDown(startY = height * 0.4f, endY = height * 0.7f, durationMillis = 600)
        }
        rule.mainClock.advanceTimeBy(3_000)
        rule.onNodeWithText("Request 36").assertIsNotDisplayed()
        rule.mainClock.autoAdvance = true
    }

    @Test fun exitingPixelsDoNotInterceptTheTranscriptTouch() {
        val visible = mutableStateOf(true)
        var transcriptClicks = 0
        var hintClicks = 0
        rule.setContent {
            RagentTheme {
                Box(Modifier.fillMaxSize().testTag("transcript-target").clickable { transcriptClicks++ },
                    contentAlignment = Alignment.Center) {
                    ScrollToBottomFab(visible.value, onClick = { hintClicks++ })
                }
            }
        }
        hint.assertIsDisplayed()
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { visible.value = false }
        rule.mainClock.advanceTimeByFrame()
        hint.assertDoesNotExist()
        rule.onNodeWithTag("transcript-target").performTouchInput { click(center) }
        rule.runOnIdle {
            assertEquals(1, transcriptClicks)
            assertEquals(0, hintClicks)
        }
        rule.mainClock.autoAdvance = true
    }
}
