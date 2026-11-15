package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.DecisionQuestionUiState
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class RunIslandRequestUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun text(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)
    private val question = DecisionQuestionUiState("question-local", "Which sections should the report include?", listOf("Summary", "Details"))
    private val history = (1..24).map { index ->
        TimelineItem.Message(id = "request-$index", seq = index.toLong(), role = TimelineRole.User,
            completed = true, text = "Local offline history $index\n" + "A long transcript to verify navigation. ".repeat(8))
    }

    @Test fun questionActionNavigatesLongHistoryWithoutSubmitting() {
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(state = WorkbenchUiState(chatOpen = true, sessionId = "question",
                    sessionTitle = "Question navigation", timelineItems = history, activeDecision = question,
                    runStatus = AgentRunStatus.Working), onEvent = { events.add(it) })
            }
        }
        compose.onNodeWithText("Question navigation").performClick()
        compose.onNodeWithText(text(WorkbenchR.string.run_summary_waiting_answer)).assertIsDisplayed()
        compose.onNodeWithTag("run-island-request").performClick()
        compose.onNodeWithTag("run-island-request").assertDoesNotExist()
        compose.onNodeWithTag("active-decision-card").assertIsDisplayed()
        compose.onNodeWithText(question.question).assertIsDisplayed()
        compose.runOnIdle { assertTrue(events.none { it is WorkbenchEvent.SubmitDecision || it is WorkbenchEvent.SelectDecisionOption }) }
    }

    @Test fun submittingAndResolvedQuestionsDoNotOfferAStaleAction() {
        val state = mutableStateOf(WorkbenchUiState(chatOpen = true, sessionId = "request-state",
            sessionTitle = "Request state", activeDecision = question.copy(isSubmitting = true)))
        compose.setContent { RagentTheme(motionPreference = MotionPreference.None) { WorkbenchScreen(state.value, onEvent = {}) } }
        compose.onNodeWithText("Request state").performClick()
        compose.onNodeWithText(text(WorkbenchR.string.run_summary_request_submitting)).assertIsDisplayed()
        compose.onNodeWithTag("run-island-request").assertIsNotEnabled()
        compose.runOnIdle { state.value = state.value.copy(activeDecision = question.copy(isSubmitted = true)) }
        compose.onNodeWithTag("run-island-request").assertDoesNotExist()
        compose.onNodeWithText(text(WorkbenchR.string.run_summary_waiting_answer)).assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(activeDecision = null) }
        compose.onNodeWithTag("run-island-request").assertDoesNotExist()
    }

    @Test fun approvalActionOnlyReopensTheExistingRequest() {
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(state = WorkbenchUiState(chatOpen = true, sessionId = "approval",
                    sessionTitle = "Approval navigation", timelineItems = history,
                    approval = PermissionRequestUiState("approval-local", "Local approval preview", "No real operation.")),
                    onEvent = { events.add(it) })
            }
        }
        compose.onNodeWithText("Approval navigation").performClick()
        compose.onNodeWithText(text(WorkbenchR.string.run_summary_view_request)).assertIsDisplayed()
        compose.onNodeWithTag("run-island-request").performClick()
        compose.onNodeWithTag("run-island-request").assertDoesNotExist()
        compose.onNodeWithText("Local approval preview").assertIsDisplayed()
        compose.runOnIdle { assertTrue(events.none { it is WorkbenchEvent.Approve || it is WorkbenchEvent.Deny }) }
    }
}
