package com.andysagent.ragent.feature.workbench

import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TabletPaneDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun projectDetailOffersNewSession() {
        val events = mutableListOf<WorkbenchEvent>()
        val state = WorkbenchUiState(destination = AgentoDestination.Sessions,
            projects = listOf(Project("project-a", "Project A")),
            projectSessionsOpen = true, browsingProjectId = "project-a")
        rule.setContent {
            val config = Configuration(LocalConfiguration.current).apply { screenWidthDp = 1000; screenHeightDp = 700 }
            CompositionLocalProvider(LocalConfiguration provides config, LocalDensity provides Density(1f)) {
                RagentTheme(motionPreference = MotionPreference.None) {
                    WorkbenchScreen(state, windowSizeClass = AgentoWindowSizeClass.Expanded, onEvent = events::add)
                }
            }
        }
        rule.onNodeWithTag("tablet-project-new-session").assertIsDisplayed().performClick()
        rule.runOnIdle { assertEquals(WorkbenchEvent.OpenNewSession("project-a"), events.last()) }
    }

    @Test fun changingForegroundDoesNotRemoveOpenConversation() {
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Sessions,
            chatOpen = true, sessionId = "shared-id", sessionTitle = "Computer A conversation",
            chatTargetId = "a", activeRemoteTargetId = "a"))
        rule.setContent {
            val config = Configuration(LocalConfiguration.current).apply { screenWidthDp = 1000; screenHeightDp = 700 }
            CompositionLocalProvider(LocalConfiguration provides config, LocalDensity provides Density(1f)) {
                RagentTheme(motionPreference = MotionPreference.None) {
                    WorkbenchScreen(state, windowSizeClass = AgentoWindowSizeClass.Expanded)
                }
            }
        }
        rule.onNodeWithText("Computer A conversation").assertIsDisplayed()
        rule.runOnIdle { state = state.copy(destination = AgentoDestination.Settings, activeRemoteTargetId = "b") }
        rule.onNodeWithText("Computer A conversation").assertIsDisplayed()
    }
}
