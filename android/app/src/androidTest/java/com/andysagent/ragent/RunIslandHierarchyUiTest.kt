package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.timeline.RunActionUiState
import com.andysagent.ragent.feature.workbench.DecisionQuestionUiState
import com.andysagent.ragent.feature.workbench.RunMetricsUiState
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Normal-size information order; native motion/visual review remains separate. */
class RunIslandHierarchyUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private fun text(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)
    private fun layout(node: SemanticsNodeInteraction): TextLayoutResult {
        val results = mutableListOf<TextLayoutResult>()
        node.performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(results) }
        return results.single()
    }

    private fun requestOrder(dark: Boolean) {
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.None) {
                WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "hierarchy-local",
                    sessionTitle = "Run hierarchy", activeDecision = DecisionQuestionUiState(
                        "question-local", "Which sources should the report include?", listOf("Reviewed sources", "All sources"))),
                    onEvent = {})
            }
        }
        rule.onNodeWithText("Run hierarchy").performClick()
        val status = rule.onNodeWithTag("run-island-status-label", true)
        val summary = rule.onNodeWithTag("run-island-summary", true)
        val action = rule.onNodeWithTag("run-island-request")
        summary.assertTextEquals("Which sources should the report include?")
        assertTrue(layout(summary).layoutInput.style.fontSize.value > layout(status).layoutInput.style.fontSize.value)
        assertTrue(status.getUnclippedBoundsInRoot().bottom <= summary.getUnclippedBoundsInRoot().top)
        assertTrue(summary.getUnclippedBoundsInRoot().bottom <= action.getUnclippedBoundsInRoot().top)
        rule.onNodeWithTag("run-metrics-group").assertDoesNotExist()
        rule.onNodeWithContentDescription(text(WorkbenchR.string.workbench_session_run_details)).performClick()
        val tabs = rule.onNodeWithTag("run-details-tab-Metrics")
        action.assertIsDisplayed()
        assertTrue("Optional details precede the required decision",
            action.getUnclippedBoundsInRoot().bottom <= tabs.getUnclippedBoundsInRoot().top)
    }

    @Test fun lightRequestExplanationAndActionLeadTheDetails() = requestOrder(false)
    @Test fun darkRequestExplanationAndActionLeadTheDetails() = requestOrder(true)

    @Test fun primarySummaryUsesTheActualActionAndFailureWithoutExposingTechnicalFieldsInCompact() {
        val state = mutableStateOf(WorkbenchUiState(chatOpen = true, sessionId = "live-summary",
            sessionTitle = "Live summary", runStatus = AgentRunStatus.Working,
            currentAction = RunActionUiState("local", "Checking the report against its sources"),
            runMetrics = RunMetricsUiState(status = AgentRunStatus.Working, runId = "run-local", model = "Local model")))
        rule.setContent { RagentTheme(motionPreference = MotionPreference.None) {
            WorkbenchScreen(state.value, onEvent = {})
        } }
        rule.onNodeWithText("Live summary").performClick()
        val summary = rule.onNodeWithTag("run-island-summary", true)
        summary.assertTextEquals("Checking the report against its sources")
        rule.onNodeWithTag("run-context").assertDoesNotExist()
        rule.runOnIdle { state.value = state.value.copy(runStatus = AgentRunStatus.Failed,
            runMetrics = state.value.runMetrics.copy(status = AgentRunStatus.Failed, failureReason = "A source file is missing")) }
        summary.assertTextEquals("A source file is missing")
        rule.onNodeWithText("Checking the report against its sources").assertDoesNotExist()
        rule.onNodeWithContentDescription(text(WorkbenchR.string.workbench_session_run_details)).performClick()
        rule.onNodeWithTag("run-context-primary").assertTextEquals("Local model")
        rule.onNodeWithTag("run-context-metadata").assertTextContains("run-local", substring = true)
    }
}
