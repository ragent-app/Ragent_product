package com.andysagent.agentoc.feature.workbench

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.longClick
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineRole
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h720dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ExecutionTimelineUiTest {
    @get:Rule val rule = createComposeRule()

    @Test fun completedRunKeepsFinalAnswerVisibleWhileProcessToggles() {
        val entries = listOf(
            TimelineItem.Message("progress", 1, TimelineRole.Agent, "Checking source", true, messagePhase = "commentary"),
            TimelineItem.Operation("thought", 2, TimelineOperationKind.Tool, "Thinking", "Reasoning", TimelineOperationStatus.Completed, isReasoning = true),
            TimelineItem.Message("answer", 3, TimelineRole.Agent, "Final result", true, messagePhase = "final_answer"),
        )
        val turn = TurnGroupProjector().project(entries).single()
        rule.setContent { AgentocTheme { TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}) } }
        rule.onNodeWithText("Final result").assertIsDisplayed()
        rule.onNodeWithText("Checking source").assertDoesNotExist()
        rule.onNodeWithTag("turn-process-toggle").performClick()
        rule.onNodeWithText("Checking source").assertIsDisplayed()
        rule.onNodeWithTag("thinking-row").assertIsDisplayed()
        rule.onNodeWithText("Final result").assertIsDisplayed()
    }

    @Test fun terminalCompletedCommentaryIsShownAsReplyWhenFinalPhaseIsMissing() {
        val entries = listOf(
            TimelineItem.Operation("tool", 1, TimelineOperationKind.Tool, "Fetched video transcript", "", TimelineOperationStatus.Completed),
            TimelineItem.Message("answer", 2, TimelineRole.Agent, "The finished answer is visible", true, messagePhase = "commentary"),
        )
        val turn = TurnGroupProjector().project(entries).single()
        rule.setContent { AgentocTheme { TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}) } }

        rule.onNodeWithText("The finished answer is visible").assertIsDisplayed()
        rule.onNodeWithTag("process-operation").assertDoesNotExist()
        rule.onNodeWithTag("turn-process-toggle").performClick()
        rule.onNodeWithTag("process-operation").assertIsDisplayed()
        rule.onNodeWithText("The finished answer is visible").assertIsDisplayed()
    }

    @Test fun userMessageBranchCopiesThroughTheSelectedPrompt() {
        var branch: Pair<Long, String>? = null
        val turn = TurnGroup(id = "turn", userPrompt = TurnUserPrompt(id = "prompt", text = "Original prompt", seq = 8))
        rule.setContent { AgentocTheme {
            TurnTimelineView(turn, true, { seq, mode -> branch = seq to mode }, null, {}, { _, _ -> }, {}, {})
        } }
        rule.onNodeWithText("Original prompt").performTouchInput { longClick() }
        rule.onNodeWithText("Branch").performClick()
        assertEquals(8L to "user-continue", branch)
    }

    @Test fun assistantMessageBranchIncludesTheSelectedReply() {
        var branch: Pair<Long, String>? = null
        val reply = TimelineItem.Message("answer", 9, TimelineRole.Agent, "Original answer", true,
            requestId = "request", lastEventSeq = 10)
        val turn = TurnGroup(id = "turn", userPrompt = TurnUserPrompt(id = "prompt", text = "Question", seq = 8),
            agentMessages = listOf(reply), finalAnswer = reply)
        rule.setContent { AgentocTheme {
            TurnTimelineView(turn, true, { seq, mode -> branch = seq to mode }, null, {}, { _, _ -> }, {}, {})
        } }
        rule.onNodeWithContentDescription("Branch from this message").performClick()
        assertEquals(10L to "assistant-continue", branch)
    }

    @Test fun actionsFollowRunAndTransitionStates() {
        assertFalse(canShowMessageActions(AgentRunStatus.Working, false, null))
        assertFalse(canShowMessageActions(AgentRunStatus.WaitingApproval, false, null))
        assertFalse(canShowMessageActions(AgentRunStatus.Completed, true, null))
        assertFalse(canShowMessageActions(AgentRunStatus.Idle, false, null, hasAcceptedTurn = true))
        assertTrue(canShowMessageActions(AgentRunStatus.Completed, false, null))
        assertTrue(canShowMessageActions(AgentRunStatus.Failed, false, null))
        assertTrue(canShowMessageActions(AgentRunStatus.Cancelled, false, null))
    }

    @Test fun completedReplyAndItsActionsNeverRenderSessionMetadata() {
        val reply = TimelineItem.Message("answer", 2, TimelineRole.Agent,
            "Visible answer\n<agentoc-session-labels>{\"title\":\"Internal index\"}</agentoc-session-labels>", true, requestId = "a")
        val turn = TurnGroup(id = "a", requestId = "a", agentMessages = listOf(reply), finalAnswer = reply)
        rule.setContent { AgentocTheme {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, onReport = {})
        } }
        rule.onNodeWithText("Visible answer", substring = true).assertIsDisplayed()
        rule.onAllNodesWithText("agentoc-session-labels", substring = true).assertCountEquals(0)
        rule.onAllNodesWithText("Internal index", substring = true).assertCountEquals(0)
    }

    @Test fun completedMessageActionsStayHiddenUntilTheRunSettles() {
        val showActions = mutableStateOf(false)
        val reply = TimelineItem.Message("answer", 2, TimelineRole.Agent, "Earlier completed commentary", true, requestId = "a")
        val turn = TurnGroup(id = "a", requestId = "a", agentMessages = listOf(reply), finalAnswer = reply)
        rule.setContent { AgentocTheme {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, onReport = {}, showMessageActions = showActions.value)
        } }
        rule.onNodeWithText("Earlier completed commentary").assertIsDisplayed()
        rule.onAllNodesWithText("Report", substring = true).assertCountEquals(0)
        rule.onAllNodesWithContentDescription("Copy message").assertCountEquals(0)
        rule.runOnIdle { showActions.value = true }
        rule.onNodeWithContentDescription("Copy message").assertIsDisplayed()
        rule.onAllNodesWithContentDescription("Branch from this message").assertCountEquals(0)
    }

    @Test fun queueActionsUseTheSelectedEntryAndServerRemovalUpdatesTheCount() {
        val messages = mutableStateOf(listOf(QueuedMessageUiState("a", "First follow-up"), QueuedMessageUiState("b", "Second follow-up")))
        var edited: String? = null
        rule.setContent { AgentocTheme {
            RunDock(AgentRunStatus.Working, null, false, {}, {}, {}, {}, {}, {},
                queuedMessages = messages.value, queueExpanded = true,
                onEditQueuedMessage = { edited = it.id },
                onRemoveQueuedMessage = { removed -> messages.value = messages.value.filterNot { it.id == removed.id } })
        } }
        rule.onNodeWithText("2 messages queued").assertIsDisplayed()
        rule.onNodeWithText("First follow-up").assertIsDisplayed()
        rule.onNodeWithText("Second follow-up").assertIsDisplayed()
        rule.onNodeWithContentDescription("Edit and resend queued message 2").performClick()
        assertEquals("b", edited)
        rule.onNodeWithContentDescription("Remove queued message 2").performClick()
        rule.onNodeWithText("1 message queued").assertIsDisplayed()
        rule.onAllNodesWithText("Second follow-up").assertCountEquals(0)
    }
}
