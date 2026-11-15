package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.feature.workbench.*
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class UserJourneyHomeSettingsUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun text(id: Int) = context.getString(id)

    private fun capture(name: String) {
        compose.waitForIdle()
        android.os.SystemClock.sleep(400)
        val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        val directory = java.io.File(context.getExternalFilesDir(null), "journey-evidence").apply { mkdirs() }
        java.io.File(directory, "$name.png").outputStream().use {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    @Test fun emptyHomeOffersSetupBeforeProjectCreation() {
        val state = mutableStateOf(WorkbenchUiState(connection = AgentConnectionStatus.Connected))
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { HomeSurface(state.value, events::add, AgentoWindowSizeClass.Compact) } }
        compose.onNodeWithText(text(WorkbenchR.string.journey_setup_computer)).performClick()
        compose.runOnIdle { assertEquals(listOf(WorkbenchEvent.OpenComputerSetup), events); events.clear()
            state.value = state.value.copy(activeRemoteTargetId = "pc") }
        compose.onNodeWithText(text(WorkbenchR.string.home_create_project)).performClick()
        compose.runOnIdle { assertEquals(listOf(WorkbenchEvent.SelectDestination(AgentoDestination.Sessions),
            WorkbenchEvent.OpenProjectDialog), events) }
    }

    @Test fun stoppingRemainsPendingUntilTheComputerConfirmsAndRecoveryOnlyRefreshes() {
        val state = mutableStateOf(WorkbenchUiState(chatOpen = true, sessionId = "task",
            connection = AgentConnectionStatus.Connected, runStatus = AgentRunStatus.Working,
            runtimeModel = "test-model", stopRequest = StopRequestState.AwaitingConfirmation))
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { WorkbenchScreen(state.value, onEvent = events::add) } }
        compose.onNodeWithText(text(WorkbenchR.string.journey_stop_waiting)).assertIsDisplayed()
        compose.onNodeWithTag("composer-send-action").assertIsNotEnabled()
        capture("stop-awaiting")
        compose.runOnIdle { state.value = state.value.copy(stopRequest = StopRequestState.OutcomeUnknown) }
        compose.onNodeWithText(text(WorkbenchR.string.journey_stop_unknown)).assertIsDisplayed()
        compose.onNodeWithText(text(WorkbenchR.string.workbench_reconnect)).performClick()
        compose.runOnIdle { assertEquals(listOf(WorkbenchEvent.Retry), events) }
        capture("stop-unknown")
        compose.runOnIdle { state.value = state.value.copy(runStatus = AgentRunStatus.Cancelled,
            stopRequest = StopRequestState.None) }
        compose.onNodeWithTag("journey-run-feedback").assertDoesNotExist()
    }

    @Test fun pendingActionsExpandInHomeAndOpenTheExactTask() {
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { HomeSurface(
            state = WorkbenchUiState(connection = AgentConnectionStatus.Connected,
                sessions = (1..3).map { Session("task-$it", "Approval $it", status = SessionStatus.WaitingApproval,
                    updatedAt = it.toLong(), lastReviewedAt = 10L) }),
            onEvent = events::add, windowSizeClass = AgentoWindowSizeClass.Compact) } }
        compose.onNodeWithText("Approval 1").assertDoesNotExist()
        compose.onNodeWithText(text(WorkbenchR.string.journey_show_all_actions)).performScrollTo().performClick()
        capture("home-pending-expanded")
        compose.onNodeWithText("Approval 1").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(WorkbenchEvent.SelectSession("task-1"), events.last()) }
        compose.onNodeWithContentDescription(text(WorkbenchR.string.home_mark_read)).assertDoesNotExist()
    }

    @Test fun quietHomeOffersTheLatestWorkWithoutChangingTheConversationDirectory() {
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { HomeSurface(
            state = WorkbenchUiState(connection = AgentConnectionStatus.Connected,
                sessions = listOf(Session("old", "Older task", status = SessionStatus.Completed, latestSeq = 100, updatedAt = 1),
                    Session("new", "Latest task", status = SessionStatus.Completed, latestSeq = 1, updatedAt = 2))),
            onEvent = events::add, windowSizeClass = AgentoWindowSizeClass.Compact) } }
        compose.onNodeWithTag("home-quiet").assertIsDisplayed()
        capture("home-quiet")
        compose.onNodeWithTag("home-continue-work").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(WorkbenchEvent.SelectSession("new"), events.last()) }
    }

    @Test fun disconnectedHomeExplainsUncertaintyAndReconnectDoesNotSendWork() {
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { HomeSurface(
            state = WorkbenchUiState(connection = AgentConnectionStatus.Disconnected, activeRemoteTargetId = "pc",
                projects = listOf(Project("p", "Project"))),
            onEvent = events::add, windowSizeClass = AgentoWindowSizeClass.Compact) } }
        compose.onNodeWithText(text(WorkbenchR.string.journey_connection_uncertain)).assertIsDisplayed()
        compose.onNodeWithContentDescription(text(WorkbenchR.string.workbench_reconnect)).performClick()
        compose.runOnIdle { assertEquals(listOf(WorkbenchEvent.Retry), events) }
    }

    @Test fun settingsNameTheComputerAndKeepHelpAvailableOffline() {
        val state = mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Settings,
            connection = AgentConnectionStatus.Disconnected, activeRemoteTargetId = "a",
            remoteTargets = listOf(RemoteTarget("a", "Office PC", ""), RemoteTarget("b", "Studio PC", ""))))
        val events = mutableListOf<WorkbenchEvent>()
        compose.setContent { RagentTheme { WorkbenchScreen(state.value, onEvent = { event ->
            events.add(event)
            when (event) {
                is WorkbenchEvent.OpenSettingsPage -> state.value = state.value.copy(settingsPage = event.page)
                WorkbenchEvent.CloseSettingsPage -> state.value = state.value.copy(settingsPage = SettingsPage.Overview)
                else -> Unit
            }
        }) } }
        compose.onNodeWithText(context.getString(WorkbenchR.string.settings_computer_summary, "Office PC", text(WorkbenchR.string.settings_computer_offline))).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("settings-computer-configuration").performClick()
        compose.onNodeWithTag("settings-offline-explanation").performScrollTo().assertIsDisplayed()
        capture("settings-offline")
        compose.runOnIdle { state.value = state.value.copy(activeRemoteTargetId = "b") }
        compose.onNodeWithText(context.getString(WorkbenchR.string.settings_computer_summary, "Studio PC", text(WorkbenchR.string.settings_computer_offline))).assertIsDisplayed()
        compose.onNodeWithText(context.getString(WorkbenchR.string.settings_computer_summary, "Office PC", text(WorkbenchR.string.settings_computer_offline))).assertDoesNotExist()
        compose.onNodeWithTag("settings-back").performClick()
        compose.onNodeWithTag("settings-connection-help").performScrollTo()
        // Scroll beyond minimal visibility so the floating navigation dock
        // cannot intercept the row's native click at the viewport bottom.
        compose.onNode(hasScrollToNodeAction()).performTouchInput { swipeUp() }
        capture("settings-connection-help")
        compose.onNodeWithTag("settings-connection-help").assertIsDisplayed().performClick()
        compose.runOnIdle { assertTrue("Expected setup event, received $events", events.contains(WorkbenchEvent.OpenComputerSetup)) }
    }
}
