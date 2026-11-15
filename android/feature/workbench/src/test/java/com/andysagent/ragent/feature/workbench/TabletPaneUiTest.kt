package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w1000dp-h700dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TabletPaneUiTest {
    @get:Rule val rule = createComposeRule()

    @Test fun projectDetailOffersNewSessionForThatProject() {
        val events = mutableListOf<WorkbenchEvent>()
        val state = WorkbenchUiState(destination = AgentoDestination.Sessions,
            projects = listOf(Project("project-a", "Project A")),
            projectSessionsOpen = true, browsingProjectId = "project-a")
        rule.setContent { RagentTheme(motionPreference = MotionPreference.None) {
            WorkbenchScreen(state, windowSizeClass = AgentoWindowSizeClass.Expanded, onEvent = events::add)
        } }
        rule.onNodeWithTag("tablet-project-new-session").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenNewSession("project-a"), events.last()) }
    }

    @Test fun chatRemainsVisibleWhenTheLeftDestinationAndComputerChange() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Sessions,
            chatOpen = true, sessionId = "shared-id", sessionTitle = "Computer A conversation",
            chatTargetId = "a", activeRemoteTargetId = "a"))
        rule.setContent { RagentTheme(motionPreference = MotionPreference.None) {
            WorkbenchScreen(state, windowSizeClass = AgentoWindowSizeClass.Expanded)
        } }
        rule.onNodeWithText("Computer A conversation").assertExists()
        rule.runOnIdle { state = state.copy(destination = AgentoDestination.Settings, activeRemoteTargetId = "b") }
        rule.onNodeWithText("Computer A conversation").assertExists()
    }
}
