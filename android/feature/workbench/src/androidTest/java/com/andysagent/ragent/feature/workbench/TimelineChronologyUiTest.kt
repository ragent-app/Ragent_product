package com.andysagent.ragent.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.SemanticsProperties
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.timeline.*
import com.andysagent.ragent.core.protocol.SessionEventDto
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class TimelineChronologyUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun waitingApprovalPausesOnlyTheTextAnimationAndResumes() {
        var waiting by mutableStateOf(false)
        var answer by mutableStateOf("Checking")
        rule.setContent { RagentTheme {
            ResultBlock(TimelineItem.Message("answer", 2, TimelineRole.Agent, answer, false, runId = "run-1"),
                isLastTurn = true, onBranch = null, onRestart = null, onReport = {}, pauseStreaming = waiting)
        } }
        rule.onNodeWithTag("agent-live-text").assertExists()
        rule.runOnIdle { waiting = true }
        rule.onNodeWithTag("agent-live-text").assertDoesNotExist()
        rule.onNodeWithTag("agent-settled-text").assertExists()
        rule.onNodeWithText("Checking").assertIsDisplayed()
        rule.onNodeWithTag("report-ai-content").assertDoesNotExist()
        rule.runOnIdle { waiting = false; answer = "Checking again" }
        rule.onNodeWithTag("agent-live-text").assertExists()
        rule.onNodeWithText("Checking again").assertIsDisplayed()
    }

    @Test fun terminalRunProjectionFinishesTheVisibleReply() {
        val items = listOf(
            TimelineItem.Message("user", 1, TimelineRole.User, "Question", true, runId = "run-1"),
            TimelineItem.Message("answer", 2, TimelineRole.Agent, "Completed answer", false,
                runId = "run-1", messagePhase = "final_answer"),
        )
        var metrics by mutableStateOf(RunMetricsUiState(runId = "run-1", status = com.andysagent.ragent.core.agentui.AgentRunStatus.Working))
        rule.setContent { RagentTheme {
            val done = latestTurnHasTerminalRun(items, null, com.andysagent.ragent.core.agentui.AgentRunStatus.Idle, metrics)
            val turn = TurnGroupProjector().project(settleLatestTurnMessages(items, done)).single()
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, onReport = {})
        } }
        rule.onNodeWithTag("report-ai-content").assertDoesNotExist()
        rule.runOnIdle { metrics = metrics.copy(status = com.andysagent.ragent.core.agentui.AgentRunStatus.Completed) }
        rule.onNodeWithText("Completed answer").assertIsDisplayed()
        rule.onNodeWithTag("report-ai-content").assertExists()
    }

    @Test fun terminalProjectionSettlesReplyWhenPromptHasOnlyRequestIdentity() {
        val items = listOf(
            TimelineItem.Message("user", 1, TimelineRole.User, "Question", true, requestId = "request-1"),
            TimelineItem.Message("answer", 2, TimelineRole.Agent, "Completed answer", false,
                requestId = "request-1", runId = "run-1", messagePhase = "final_answer"),
        )
        var metrics by mutableStateOf(RunMetricsUiState(runId = "run-1", status = com.andysagent.ragent.core.agentui.AgentRunStatus.Working))
        rule.setContent { RagentTheme {
            val done = latestTurnHasTerminalRun(items, null, com.andysagent.ragent.core.agentui.AgentRunStatus.Idle, metrics)
            val turn = TurnGroupProjector().project(settleLatestTurnMessages(items, done)).single()
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, onReport = {})
        } }
        rule.onNodeWithTag("agent-live-text").assertExists()
        rule.runOnIdle { metrics = metrics.copy(status = com.andysagent.ragent.core.agentui.AgentRunStatus.Completed) }
        rule.onNodeWithText("Completed answer").assertIsDisplayed()
        rule.onNodeWithTag("agent-live-text").assertDoesNotExist()
        rule.onNodeWithTag("report-ai-content").assertExists()
    }

    @Test fun claudeFileActivityDisplaysItsFilename() {
        val op = TimelineItem.Operation("write", 2, TimelineOperationKind.Tool, "Write", "", TimelineOperationStatus.InProgress,
            toolName = "Write", inputJson = """{"file_path":"/work/internet-and-web.md"}""")
        val action = RunActionFormatter.forRun(RunActionFormatter.RunActionStatus.Working, null, listOf(op))
        rule.setContent { RagentTheme { ActiveRunActionBar(com.andysagent.ragent.core.agentui.AgentRunStatus.Working, action?.sentence) } }
        rule.onNodeWithText("Editing internet-and-web.md").assertIsDisplayed()
    }

    @Test fun liveThinkingExpandsScrollsAndCollapsesWhenFinished() {
        var op by mutableStateOf(TimelineItem.Operation("thinking", 1, TimelineOperationKind.Tool, "Thinking", "Starting", TimelineOperationStatus.InProgress, isReasoning = true))
        rule.setContent { RagentTheme { ThinkingRow(op) } }
        rule.onNodeWithText("Starting").assertIsDisplayed()
        rule.runOnIdle { op = op.copy(detail = (1..80).joinToString("\n") { "Thought line $it" }) }
        rule.waitForIdle()
        val bounds = rule.onNodeWithTag("thinking-content").getUnclippedBoundsInRoot()
        assertTrue(bounds.bottom - bounds.top <= 220.dp)
        val scroll = rule.onNodeWithTag("thinking-content").fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        assertTrue("Thinking content should scroll", scroll.maxValue() > 0f)
        rule.waitUntil(5_000) { scroll.value() >= scroll.maxValue() }
        rule.runOnIdle { op = op.copy(status = TimelineOperationStatus.Completed) }
        rule.waitForIdle()
        rule.onNodeWithTag("thinking-content").assertDoesNotExist()
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.timeline_details_show)).performClick()
        rule.onNodeWithTag("thinking-content").assertExists()
    }

    @Test fun separatedProviderPagesRenderReasoningBeforeFinalReply() {
        val thought = SessionEventDto(seq = 7, type = "thinking_block", runId = "r", providerMessageId = "m",
            providerBlockId = "thinking:0", state = "completed", content = JsonPrimitive("Page thought"))
        val user = SessionEventDto(seq = 1, type = "message", role = "user", runId = "r", content = JsonPrimitive("Question"))
        val reply = SessionEventDto(seq = 3, firstSeq = 3, type = "message", role = "assistant", runId = "r",
            providerMessageId = "m", providerContentBlockIndex = 1, messagePhase = "final_answer", content = JsonPrimitive("Page answer"))
        val firstPage = LiveTimelineProjector().projectPage(listOf(thought))
        val otherPage = LiveTimelineProjector().projectPage(listOf(user, reply))
        val turn = TurnGroupProjector().project(TimelineProjector.project(emptyList(), firstPage + otherPage)).single()
        rule.setContent { RagentTheme { Column { TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}) } } }
        rule.onNodeWithText("Page answer").assertIsDisplayed()
        rule.onNodeWithTag("thinking-row").assertDoesNotExist()
        rule.onNodeWithTag("turn-process-toggle").performClick()
        val thoughtTop = rule.onNodeWithTag("thinking-row").getUnclippedBoundsInRoot().top
        val answerTop = rule.onNodeWithText("Page answer").getUnclippedBoundsInRoot().top
        assertTrue("The provider thought should precede the reply after pages merge", thoughtTop < answerTop)
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.timeline_details_show)).performClick()
        rule.onNodeWithText("Page thought").assertIsDisplayed()
    }

    @Test fun completedLegacyTurnRetainsExpandableElapsedRow() {
        val items = listOf(
            TimelineItem.Message("u-legacy", 1, TimelineRole.User, "Question", true),
            TimelineItem.Message("progress-legacy", 2, TimelineRole.Agent, "Checking", true),
            TimelineItem.Operation("thought-legacy", 3, TimelineOperationKind.Tool, "Thinking", "Reasoning", TimelineOperationStatus.Completed, isReasoning = true),
            TimelineItem.Message("answer-legacy", 4, TimelineRole.Agent, "Final legacy answer", true),
        )
        val turn = TurnGroupProjector().project(items).single()
        rule.setContent { RagentTheme { Column {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, runDuration = { androidx.compose.material3.Text("Elapsed 3s") })
        } } }
        rule.onNodeWithText("Final legacy answer").assertIsDisplayed()
        rule.onNodeWithText("Checking").assertDoesNotExist()
        rule.onNodeWithTag("turn-process-toggle").assertHasClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(rule.activity.getString(R.string.timeline_details_show))))
            .performClick()
        rule.onNodeWithText("Checking").assertIsDisplayed()
        rule.onNodeWithTag("turn-process-toggle")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(rule.activity.getString(R.string.timeline_details_hide))))
    }

    @Test fun completedTurnCollapsesProcessAndKeepsFinalAnswerVisible() {
        val items = listOf(
            TimelineItem.Message("u", 1, TimelineRole.User, "Inspect the file", true),
            TimelineItem.Message("a", 2, TimelineRole.Agent, "First explanation", true, messagePhase = "commentary"),
            TimelineItem.Operation("op", 3, TimelineOperationKind.Command, "Check source", "done", TimelineOperationStatus.Completed),
            TimelineItem.Operation("thought", 3, TimelineOperationKind.Tool, "Thinking", "Private reasoning detail", TimelineOperationStatus.Completed, isReasoning = true),
            TimelineItem.Message("b", 4, TimelineRole.Agent, "Final conclusion", true, messagePhase = "final_answer"),
        )
        val turn = TurnGroupProjector().project(items).single()
        rule.setContent { RagentTheme { Column {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {})
        } } }
        rule.onNodeWithText("First explanation").assertDoesNotExist()
        rule.onNodeWithText("Final conclusion").assertIsDisplayed()
        rule.onNodeWithTag("turn-process-toggle").performClick()
        val first = rule.onNodeWithText("First explanation").getUnclippedBoundsInRoot().top
        rule.onNodeWithTag("process-operation").assertExists()
        rule.onNodeWithText("Private reasoning detail").assertDoesNotExist()
        val thinking = rule.onNodeWithTag("thinking-row").getUnclippedBoundsInRoot().top
        val last = rule.onNodeWithText("Final conclusion").getUnclippedBoundsInRoot().top
        assertTrue("Thinking moved ahead of commentary", first < thinking)
        assertTrue("The final answer moved ahead of thinking", thinking < last)
        rule.onNodeWithContentDescription(rule.activity.getString(R.string.timeline_details_show)).performClick()
        rule.onNodeWithText("Private reasoning detail").assertIsDisplayed()
    }

    @Test fun noticesStayInOrderInsideCompletedProcess() {
        val items = listOf(
            TimelineItem.Message("u-notice", 1, TimelineRole.User, "Question", true),
            TimelineItem.Message("a-notice", 2, TimelineRole.Agent, "Before notice", true, messagePhase = "commentary"),
            TimelineItem.Notice("notice", 3, "Process notice"),
            TimelineItem.Message("b-notice", 4, TimelineRole.Agent, "After notice", true, messagePhase = "commentary"),
            TimelineItem.Message("final-notice", 5, TimelineRole.Agent, "Final answer", true, messagePhase = "final_answer"),
        )
        val turn = TurnGroupProjector().project(items).single()
        rule.setContent { RagentTheme { Column { TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}) } } }
        rule.onNodeWithText("Process notice").assertDoesNotExist()
        rule.onNodeWithText("Final answer").assertIsDisplayed()
        rule.onNodeWithTag("turn-process-toggle").performClick()
        val before = rule.onNodeWithText("Before notice").getUnclippedBoundsInRoot().top
        val notice = rule.onNodeWithText("Process notice").getUnclippedBoundsInRoot().top
        val after = rule.onNodeWithText("After notice").getUnclippedBoundsInRoot().top
        assertTrue(before < notice && notice < after)
    }

    @Test fun terminalNoticeRemainsVisibleWhenThereIsNoFinalAnswer() {
        val items = listOf(
            TimelineItem.Message("u-error", 1, TimelineRole.User, "Question", true),
            TimelineItem.Operation("op-error", 2, TimelineOperationKind.Command, "Run", "", TimelineOperationStatus.Failed),
            TimelineItem.Notice("error", 3, "Run failed"),
        )
        val turn = TurnGroupProjector().project(items).single()
        rule.setContent { RagentTheme { Column { TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}) } } }
        rule.onNodeWithText("Run failed").assertIsDisplayed()
    }
}
