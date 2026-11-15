package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.RunDock
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.Locale

class RunDockActiveUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun workingOrOfflineWithoutApprovalOrQueueHasNoBottomStatusIsland() {
        val context = android.view.ContextThemeWrapper(rule.activity, 0).apply {
            applyOverrideConfiguration(Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.FRENCH) })
        }
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalContext provides context, LocalDensity provides Density(density.density, 2f)) {
                RagentTheme(darkTheme = true) {
                    Box(Modifier.width(320.dp)) {
                        RunDock(runStatus = AgentRunStatus.Working, approval = null,
                            isOfflineOrTransportError = true, filesChangedCount = 2,
                            onStop = {}, onOpenRunDetails = {},
                            onApprove = {}, onDeny = {}, onReviewChanges = {}, onRetryConnection = {})
                    }
                }
            }
        }
        rule.onNodeWithTag("run-dock-stop").assertDoesNotExist()
        rule.onNodeWithTag("run-dock-activity").assertDoesNotExist()
        rule.onNodeWithTag("composer-queue-rail").assertDoesNotExist()
        rule.onNodeWithText("Offline · Showing last synced work").assertDoesNotExist()
    }

    @Test fun expandedGoalIslandUsesInlineEditorAndKeepsDestructiveActionSecondary() {
        var savedGoal: String? = null
        var clearCalls = 0
        var collapseCalls = 0
        rule.setContent {
            RagentTheme(darkTheme = false) {
                Box(Modifier.width(400.dp)) {
                    RunDock(
                        runStatus = AgentRunStatus.Idle,
                        approval = null,
                        isOfflineOrTransportError = false,
                        onStop = {},
                        onOpenRunDetails = {},
                        onApprove = {},
                        onDeny = {},
                        onReviewChanges = {},
                        onRetryConnection = {},
                        goalMode = true,
                        goalText = "Original goal",
                        autoContinue = false,
                        goalExpanded = true,
                        onCollapseGoal = { collapseCalls += 1 },
                        onSaveGoal = { savedGoal = it },
                        onClearGoal = { clearCalls += 1 },
                    )
                }
            }
        }

        rule.waitUntil(timeoutMillis = 5_000) {
            rule.onAllNodesWithTag("goal-island-card").fetchSemanticsNodes().isNotEmpty()
        }
        rule.onNodeWithTag("goal-island-card").assertIsDisplayed()
        rule.onNodeWithTag("goal-island-status").assertIsDisplayed()
        rule.onNodeWithTag("goal-island-collapse").assertHasClickAction()
        rule.onNodeWithTag("goal-island-trash").assertDoesNotExist()

        rule.onNodeWithContentDescription(rule.activity.getString(WorkbenchR.string.goal_clear))
            .assertHasClickAction()
            .performClick()
        rule.runOnIdle { assertEquals(1, clearCalls) }

        rule.onNodeWithTag("goal-objective-input").performTextReplacement("Refined goal")
        rule.onNodeWithTag("goal-save-action").assertIsDisplayed().performClick()
        rule.runOnIdle {
            assertEquals("Refined goal", savedGoal)
            assertEquals(1, collapseCalls)
        }
    }
}
