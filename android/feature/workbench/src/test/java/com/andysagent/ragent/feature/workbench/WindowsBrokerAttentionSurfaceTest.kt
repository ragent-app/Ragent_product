package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w360dp-h800dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WindowsBrokerAttentionSurfaceTest {
    @get:Rule val rule = createComposeRule()

    @Test fun activeSessionStillShowsBrokerApprovalAndBothDecisions() {
        val approval = Approval(
            id = "request-1", sessionId = "visible-session", runId = "run-1",
            title = "Start Windows service", reason = "Computer: test; service: fixture",
            status = "pending", kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
            riskLevel = "privileged", passkeyRequired = false,
            brokerTargetInstanceId = "test-computer", brokerChallengeDigest = "test-digest",
        )
        val state = AttentionReducer.reduce(
            AttentionUiState(visibleSessionId = "visible-session"),
            AttentionReducer.projectBrokerApprovals(listOf(approval)),
        ).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }

        rule.onNodeWithTag("attention-headline").assertIsDisplayed()
        rule.onNodeWithText("Approve").assertIsDisplayed().performClick()
        rule.onNodeWithText("Deny").assertIsDisplayed().performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf<AttentionEvent>(AttentionEvent.ResolveApproval(id, true), AttentionEvent.ResolveApproval(id, false)), events)
        }
    }

    @Test fun unknownOutcomeCannotBeApprovedAgain() {
        val approval = Approval(
            id = "uncertain", sessionId = "visible-session", runId = "run-1",
            title = "Outcome unknown", status = "pending", kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
            riskLevel = "privileged", passkeyRequired = false, brokerDecisionUncertain = true,
        )
        val state = AttentionReducer.reduce(
            AttentionUiState(visibleSessionId = "visible-session"),
            AttentionReducer.projectBrokerApprovals(listOf(approval)),
        ).copy(expanded = true)
        val opened = mutableListOf<String>()
        rule.setContent { RagentTheme { AttentionSurface(state, onEvent = {}, onOpenSession = opened::add) } }
        rule.onNodeWithText("Approve").assertDoesNotExist()
        rule.onNodeWithText("Deny").assertDoesNotExist()
        rule.onNodeWithText("Details").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(listOf("visible-session"), opened) }
    }
}
