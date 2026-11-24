package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeRight
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.network.ActiveCarrier
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ProjectDeleteUiTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun l1ShowsListActionTransportErrorWithoutShadowingOrSuppression() {
        val events = mutableListOf<WorkbenchEvent>()
        val deleteError = "Project could not be deleted: No verified TURN/P2P carrier is available"
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                chatOpen = false,
                connection = AgentConnectionStatus.Connected,
                error = "Stale chat failure",
                listActionError = deleteError,
                projects = listOf(Project("p1", "Demo")),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    onEvent = { event ->
                        events += event
                        if (event is WorkbenchEvent.DismissError || event is WorkbenchEvent.Retry) {
                            state = state.copy(error = null, listActionError = null)
                        }
                    },
                )
            }
        }

        rule.onNodeWithText(deleteError).assertIsDisplayed()
        rule.onNodeWithText("Stale chat failure").assertDoesNotExist()
        rule.onNodeWithText("Reconnect").performClick()
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.Retry))
        }

        rule.runOnIdle {
            state = state.copy(listActionError = deleteError, error = "Stale chat failure")
        }
        rule.onNodeWithText(deleteError).assertIsDisplayed().performTouchInput { swipeRight() }
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.DismissError))
            assertEquals(null, state.listActionError)
        }
    }

    @Test
    fun l1DeleteShowsPendingIndicatorAndBlocksDuplicateDeleteAndMenuInteractions() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                connection = AgentConnectionStatus.Connected,
                activeRemoteTargetId = "pc-a",
                projects = listOf(Project("p1", "Demo")),
                sessions = listOf(Session("s1", "Task", "p1", SessionStatus.Completed)),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                SessionsSurface(
                    state = state,
                    onEvent = { events += it },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        rule.onNodeWithTag("project-header-p1").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-menu").assertIsDisplayed()
        rule.onNodeWithTag("project-list-delete").performClick()
        rule.onNodeWithTag("project-delete-keep").assertIsDisplayed()
        rule.onNodeWithTag("project-delete-all").assertIsDisplayed().performClick()

        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.DeleteListedProject("pc-a", "p1", true)))
            state = state.copy(pendingProjectActionId = "p1")
        }

        rule.onNodeWithTag("project-action-progress-p1").assertIsDisplayed()
        val beforeCount = events.size
        rule.onNodeWithTag("project-header-p1").performTouchInput { longClick() }
        rule.onNodeWithTag("project-header-p1").performClick()
        rule.runOnIdle {
            assertEquals(beforeCount, events.size)
            assertFalse(events.any { it is WorkbenchEvent.OpenProjectSessions })
        }
        assertEquals(0, rule.onAllNodesWithTag("project-list-menu").fetchSemanticsNodes().size)

        rule.runOnIdle { state = state.copy(pendingProjectActionId = null) }
        assertEquals(0, rule.onAllNodesWithTag("project-action-progress-p1").fetchSemanticsNodes().size)
    }

    @Test
    fun deleteDialogDisablesButtonsWhileProjectActionIsPending() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                connection = AgentConnectionStatus.Connected,
                activeRemoteTargetId = "pc-a",
                projects = listOf(Project("p1", "Demo")),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                SessionsSurface(
                    state = state,
                    onEvent = { events += it },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        rule.onNodeWithTag("project-header-p1").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-delete").performClick()
        rule.runOnIdle { state = state.copy(pendingProjectActionId = "p1") }

        rule.onNodeWithTag("project-delete-progress").assertIsDisplayed()
        rule.onNodeWithTag("project-delete-keep").assertIsNotEnabled()
        rule.onNodeWithTag("project-delete-all").assertIsNotEnabled()
    }

    @Test
    fun l1AndL2RenderConnectionStatusPillForCarriersAndStates() {
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                connection = AgentConnectionStatus.Connected,
                activeCarrier = ActiveCarrier.P2P,
                activeRemoteTargetId = "pc-a",
                projects = listOf(Project("p1", "Demo")),
                sessions = listOf(Session("s1", "First", projectId = "p1", status = SessionStatus.Idle, latestSeq = 1)),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                SessionsSurface(
                    state = state,
                    onEvent = {},
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        // L1 checks across carriers and degraded states.
        rule.onNodeWithTag("connection-status-pill").assertIsDisplayed()
        rule.onNodeWithText("P2P").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(activeCarrier = ActiveCarrier.Turn) }
        rule.onNodeWithText("TURN").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(activeCarrier = ActiveCarrier.Direct) }
        rule.onNodeWithText("Direct").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.Connecting) }
        rule.onNodeWithText("Connecting").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.Reconnecting) }
        rule.onNodeWithText("Reconnecting").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.AuthenticationRequired) }
        rule.onNodeWithText("Auth Required").assertIsDisplayed()

        rule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.Disconnected) }
        rule.onNodeWithText("Offline").assertIsDisplayed()

        // L2 checks.
        rule.runOnIdle {
            state = state.copy(
                projectSessionsOpen = true,
                browsingProjectId = "p1",
                connection = AgentConnectionStatus.Connected,
                activeCarrier = ActiveCarrier.Turn,
            )
        }
        rule.onNodeWithTag("connection-status-pill").assertIsDisplayed()
        rule.onNodeWithText("TURN").assertIsDisplayed()
    }

    @Test
    fun l1AndL2ConnectionStatusBannerShowsReconnectAndDispatchesRetry() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                connection = AgentConnectionStatus.Connected,
                activeCarrier = ActiveCarrier.Direct,
                activeRemoteTargetId = "pc-a",
                projects = listOf(Project("p1", "Demo")),
                sessions = listOf(Session("s1", "First", projectId = "p1", status = SessionStatus.Idle, latestSeq = 1)),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                SessionsSurface(
                    state = state,
                    onEvent = { events += it },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        assertEquals(0, rule.onAllNodesWithTag("connection-status-banner").fetchSemanticsNodes().size)

        rule.runOnIdle { state = state.copy(connection = AgentConnectionStatus.Disconnected) }
        rule.onNodeWithTag("connection-status-banner").assertIsDisplayed()
        rule.onNodeWithTag("connection-status-reconnect").performClick()
        assertEquals(listOf(WorkbenchEvent.Retry), events)

        // Banner is hidden when activeRemoteTargetId is null.
        rule.runOnIdle { state = state.copy(activeRemoteTargetId = null) }
        assertEquals(0, rule.onAllNodesWithTag("connection-status-banner").fetchSemanticsNodes().size)

        // L2 also displays banner and fires Retry on click.
        events.clear()
        rule.runOnIdle {
            state = state.copy(
                activeRemoteTargetId = "pc-a",
                projectSessionsOpen = true,
                browsingProjectId = "p1",
                connection = AgentConnectionStatus.Reconnecting,
            )
        }
        rule.onNodeWithTag("connection-status-banner").assertIsDisplayed()
        rule.onNodeWithTag("connection-status-reconnect").performClick()
        assertEquals(listOf(WorkbenchEvent.Retry), events)
    }

    @Test
    fun l1AndL2PullRefreshDispatchesRefreshCatalog() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Sessions,
                connection = AgentConnectionStatus.Connected,
                activeCarrier = ActiveCarrier.P2P,
                activeRemoteTargetId = "pc-a",
                projects = listOf(Project("p1", "Demo")),
                sessions = listOf(Session("s1", "First", projectId = "p1", status = SessionStatus.Idle, latestSeq = 1)),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                SessionsSurface(
                    state = state,
                    onEvent = { events += it },
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                )
            }
        }

        rule.onNodeWithTag("projects-index-list").performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertTrue(events.contains(WorkbenchEvent.RefreshCatalog))

        events.clear()
        rule.runOnIdle {
            state = state.copy(
                projectSessionsOpen = true,
                browsingProjectId = "p1",
            )
        }
        rule.onNodeWithTag("project-conversations-list").performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertTrue(events.contains(WorkbenchEvent.RefreshCatalog))
    }
}
