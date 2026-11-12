package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.RunDock
import com.andysagent.agentoc.feature.workbench.R as WorkbenchR
import org.junit.Rule
import org.junit.Test

/**
 * Instrumented Compose UI tests for the approval Dynamic Island inside
 * RunDock: a fresh request renders the expanded action card, tapping outside
 * collapses it into the pill, and the pill re-expands the card while the
 * request is still awaiting action. The dismissal barrier scaffolding
 * mirrors ChatSurface's z-order (barrier drawn under the dock). Runs on an
 * emulator via connectedDebugAndroidTest.
 */
class RunDockApprovalIslandTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val approval = PermissionRequestUiState(
        id = "approval-1",
        title = "Run shell command",
        reason = "The agent wants to execute a command on the host.",
    )

    @Test
    fun resolvingRequestKeepsLargeTargetsButCannotSubmitTwice() {
        var decisions = 0
        composeRule.setContent {
            AgentocTheme {
                RunDock(
                    runStatus = AgentRunStatus.WaitingApproval,
                    approval = approval.copy(resolving = true, approveLabel = "Allow once", denyLabel = "Reject"),
                    isOfflineOrTransportError = false,
                    onStop = {},
                    onOpenRunDetails = {},
                    onApprove = { decisions++ },
                    onDeny = { decisions++ },
                    onReviewChanges = {},
                    onRetryConnection = {},
                )
            }
        }
        listOf("Allow once", "Reject").forEach { label ->
            composeRule.onNodeWithText(label)
                .assertIsDisplayed().assertIsNotEnabled().assertHeightIsAtLeast(52.dp)
                .performTouchInput { click() }
        }
        composeRule.runOnIdle { check(decisions == 0) }
    }

    @Test
    fun freshRequestStartsExpandedAndOutsideTapCollapsesToPill() {
        val approveLabel = composeRule.activity.getString(WorkbenchR.string.attention_approve)
        val denyLabel = composeRule.activity.getString(WorkbenchR.string.attention_deny)
        var expanded by mutableStateOf(true)
        var collapseCount by mutableStateOf(0)
        composeRule.setContent {
            AgentocTheme {
                Box(Modifier.fillMaxSize()) {
                    // Mirrors ChatSurface's dismissal barrier, which is drawn
                    // below the dock so card taps reach the card first.
                    Box(
                        Modifier
                            .matchParentSize()
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = {
                                    expanded = false
                                    collapseCount += 1
                                },
                            ),
                    )
                    RunDock(
                        runStatus = AgentRunStatus.Idle,
                        approval = approval,
                        isOfflineOrTransportError = false,
                        onStop = {},
                        onOpenRunDetails = {},
                        onApprove = {},
                        onDeny = {},
                        onReviewChanges = {},
                        onRetryConnection = {},
                        approvalExpanded = expanded,
                        onExpandApproval = { expanded = true },
                        onCollapseApproval = { expanded = false },
                    )
                }
            }
        }

        // A fresh request opens expanded: decision buttons are on screen.
        composeRule.onNodeWithText(approveLabel).assertIsDisplayed()
        composeRule.onNodeWithText(denyLabel).assertIsDisplayed()
        composeRule.onAllNodesWithText("Expand approval request").assertCountEquals(0)

        // Derive a point below the top-anchored card and away from system
        // navigation. API 35's edge-to-edge root can include the bottom bar.
        val rootBounds = composeRule.onRoot().fetchSemanticsNode().boundsInRoot
        val actionsBottom = composeRule.onNodeWithText(approveLabel).fetchSemanticsNode().boundsInRoot.bottom
        val outsideY = (actionsBottom + rootBounds.bottom) / 2f - rootBounds.top
        composeRule.onRoot().performTouchInput {
            click(Offset(x = centerX, y = outsideY))
        }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText(approveLabel).assertCountEquals(0)
        composeRule.onNodeWithContentDescription("Expand approval request").assertIsDisplayed()
        composeRule.runOnIdle { check(collapseCount == 1) { "barrier should collapse exactly once" } }
    }

    @Test
    fun tapsInsideTheExpandedCardDoNotCollapseIt() {
        val approveLabel = composeRule.activity.getString(WorkbenchR.string.attention_approve)
        var expanded by mutableStateOf(true)
        var collapseCount by mutableStateOf(0)
        composeRule.setContent {
            AgentocTheme {
                Box(Modifier.fillMaxSize()) {
                    // Mirrors ChatSurface's dismissal barrier, which is drawn
                    // below the dock so card taps reach the card first.
                    Box(
                        Modifier
                            .matchParentSize()
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = {
                                    expanded = false
                                    collapseCount += 1
                                },
                            ),
                    )
                    RunDock(
                        runStatus = AgentRunStatus.Idle,
                        approval = approval,
                        isOfflineOrTransportError = false,
                        onStop = {},
                        onOpenRunDetails = {},
                        onApprove = {},
                        onDeny = {},
                        onReviewChanges = {},
                        onRetryConnection = {},
                        approvalExpanded = expanded,
                        onExpandApproval = { expanded = true },
                        onCollapseApproval = { expanded = false },
                    )
                }
            }
        }

        // Taps on inert regions inside the card (title, description, glass
        // padding) are shielded: the card must stay expanded and the
        // barrier must never fire.
        composeRule.onNodeWithText(approval.reason).performTouchInput { click() }
        composeRule.waitForIdle()
        composeRule.onNodeWithText(approveLabel).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Expand approval request").assertDoesNotExist()
        composeRule.runOnIdle { check(collapseCount == 0) { "card interior taps must not reach the barrier" } }
    }

    @Test
    fun collapsedPillTapReexpandsCardWhileAwaitingAction() {
        val approveLabel = composeRule.activity.getString(WorkbenchR.string.attention_approve)
        var expanded by mutableStateOf(false)
        composeRule.setContent {
            AgentocTheme {
                RunDock(
                    runStatus = AgentRunStatus.Idle,
                    approval = approval,
                    isOfflineOrTransportError = false,
                    onStop = {},
                    onOpenRunDetails = {},
                    onApprove = {},
                    onDeny = {},
                    onReviewChanges = {},
                    onRetryConnection = {},
                    approvalExpanded = expanded,
                    onExpandApproval = { expanded = true },
                    onCollapseApproval = { expanded = false },
                )
            }
        }

        // Resting state is the compact pill; decision buttons stay hidden.
        composeRule.onNodeWithContentDescription("Expand approval request").assertIsDisplayed()
        composeRule.onAllNodesWithText(approveLabel).assertCountEquals(0)

        // Tapping the pill re-expands the untouched request card.
        composeRule.onNodeWithContentDescription("Expand approval request").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(approveLabel).assertIsDisplayed()
        composeRule.onNodeWithText(approval.reason).assertIsDisplayed()
    }
}
