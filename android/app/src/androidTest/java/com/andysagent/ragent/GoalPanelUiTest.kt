package com.andysagent.ragent

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.GoalPanelModalBottomSheet
import java.util.Locale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Production panel with event spies; no network or real goal is changed. */
class GoalPanelUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val events = mutableListOf<String>()

    private fun show(goal: String = "Original goal", running: Boolean = false) {
        val base = compose.activity
        val localized = base.createConfigurationContext(Configuration(base.resources.configuration).apply {
            setLocale(Locale.ENGLISH)
        })
        compose.setContent {
            CompositionLocalProvider(LocalContext provides localized) {
                RagentTheme(darkTheme = false) {
                    GoalPanelModalBottomSheet(
                        onDismiss = { events += "dismiss" }, goalText = goal, autoContinue = running,
                        onSaveGoal = { events += "save:$it" }, onClearGoal = { events += "clear" },
                        onStartAutoContinue = { events += "start:$it" },
                        onPauseAutoContinue = { events += "pause" },
                    )
                }
            }
        }
    }

    @Test fun draftIsNotPresentedAsSavedAndSaveTrimsOnlyAtSubmission() {
        show()
        compose.onNodeWithText("Goal saved").assertIsDisplayed()
        compose.onNodeWithContentDescription("Session goal").performTextReplacement("  New goal  ")
        compose.onNodeWithText("Unsaved changes").assertIsDisplayed()
        compose.onNodeWithText("Goal saved").assertDoesNotExist()
        compose.onNodeWithText("Save goal").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(listOf("save:New goal"), events) }
    }

    @Test fun saveIsImmediatelyAvailableAndStartUsesAccessibleIconAction() {
        show(goal = "")
        compose.onNodeWithText("Save goal").assertIsDisplayed()
        compose.onNodeWithContentDescription("Start auto-continue").assertIsDisplayed()
        compose.onNodeWithText("Start auto-continue").assertDoesNotExist()
        compose.onNodeWithContentDescription("Start auto-continue").performClick()
        compose.runOnIdle { assertEquals(listOf("start:"), events) }
    }

    @Test fun closingDoesNotCommitTheDraft() {
        show()
        compose.onNodeWithContentDescription("Session goal").performTextReplacement("Unsaved draft")
        compose.onNodeWithContentDescription("Close goal panel").performClick()
        compose.runOnIdle { assertEquals(listOf("dismiss"), events) }
    }

    @Test fun pauseDoesNotSaveChangedDraft() {
        show(running = true)
        compose.onNodeWithText("Auto-continue is on").assertIsDisplayed()
        compose.onNodeWithText("Pause auto-continue").assertDoesNotExist()
        compose.onNodeWithContentDescription("Session goal").performTextReplacement("Unsaved draft")
        compose.onNodeWithContentDescription("Pause auto-continue").performClick()
        compose.runOnIdle { assertEquals(listOf("pause"), events) }
    }

    @Test fun emptyGoalCanStartUsingTheNextMessage() {
        show(goal = "")
        compose.onNodeWithText("Leave this empty to use your next message as the goal.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Start auto-continue").performClick()
        compose.runOnIdle { assertEquals(listOf("start:"), events) }
    }

    @Test fun clearHasItsOwnEvent() {
        show()
        compose.onNodeWithText("Clear goal").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf("clear"), events) }
    }
}
