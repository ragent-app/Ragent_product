package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.network.ActiveCarrier
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
class ConnectionStatusAndErrorUiTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun connectedChatWithTurnErrorShowsRetryCardAndRedDotWithoutBanner() {
        val events = mutableListOf<WorkbenchEvent>()
        val state = WorkbenchUiState(
            destination = AgentoDestination.Home,
            chatOpen = true,
            sessionId = "s1",
            connection = AgentConnectionStatus.Connected,
            activeCarrier = ActiveCarrier.Turn,
            activeRemoteTargetId = "pc-a",
            error = "TURN request failed",
            runtimeModel = "gpt-5",
            timelineItems = listOf(
                TimelineItem.Message("u1", 1, TimelineRole.User, "hi", true),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    onEvent = { events += it },
                )
            }
        }

        rule.onNodeWithText("Action needs attention").assertIsDisplayed()
        rule.onNodeWithText("TURN request failed").assertIsDisplayed()
        rule.onNodeWithTag("conversation-status-indicator", useUnmergedTree = true).assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag("connection-status-banner").fetchSemanticsNodes().size)

        rule.onNodeWithText("Retry").performClick()
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.Retry))
        }
    }

    @Test
    fun reconnectingChatBannerSuppressesDuplicateRetryCardAndMatchesRedDotInvariant() {
        val error = "Session could not be refreshed: No verified TURN/P2P carrier is available"
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                chatOpen = true,
                sessionId = "s1",
                connection = AgentConnectionStatus.Reconnecting,
                activeRemoteTargetId = "pc-a",
                error = error,
                runtimeModel = "gpt-5",
                timelineItems = listOf(
                    TimelineItem.Message("u1", 1, TimelineRole.User, "hi", true),
                ),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    onEvent = {},
                )
            }
        }

        rule.onNodeWithTag("connection-status-banner").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag("connection-status-pill").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithText("Connection unavailable").fetchSemanticsNodes().size)
        rule.onNodeWithTag("conversation-status-indicator", useUnmergedTree = true).assertIsDisplayed()

        rule.runOnIdle {
            state = state.copy(error = null, listActionError = null)
        }
        assertEquals(0, rule.onAllNodesWithTag("conversation-status-indicator", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertFalse(
            hasVisibleChatErrorSurface(
                error = null,
                listActionError = null,
                chatOpen = true,
                chatConnection = AgentConnectionStatus.Reconnecting,
                activeRemoteTargetId = "pc-a",
            ),
        )
        assertNull(
            resolveDisplayedWorkbenchError(
                error = error,
                listActionError = null,
                chatOpen = true,
                chatConnection = AgentConnectionStatus.Reconnecting,
                activeRemoteTargetId = "pc-a",
            ),
        )
        assertFalse(isTransportConnectionFailure("TURN request failed"))
        assertTrue(isTransportConnectionFailure(error))
    }

    @Test
    fun optionAChatHidesPillWhenConnectedAndDisplaysCarrierInRunDetailsIsland() {
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                chatOpen = true,
                sessionId = "s1",
                connection = AgentConnectionStatus.Reconnecting,
                activeCarrier = ActiveCarrier.Turn,
                activeRemoteTargetId = "pc-a",
                runtimeModel = "gpt-5",
                timelineItems = listOf(
                    TimelineItem.Message("u1", 1, TimelineRole.User, "hi", true),
                ),
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    onEvent = {},
                )
            }
        }

        // Remote Reconnecting shows ConnectionStatusBanner and hides ConnectionStatusPill (no stacking).
        rule.onNodeWithTag("connection-status-banner").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag("connection-status-pill").fetchSemanticsNodes().size)

        // Banner-free degraded state (no active remote target) still shows the floating ConnectionStatusPill.
        rule.runOnIdle {
            state = state.copy(activeRemoteTargetId = null)
        }
        assertEquals(0, rule.onAllNodesWithTag("connection-status-banner").fetchSemanticsNodes().size)
        rule.onNodeWithTag("connection-status-pill").assertIsDisplayed()
        rule.onNodeWithText("Reconnecting").assertIsDisplayed()

        // Option A: both pill and banner are hidden in chat reading surface when Connected.
        rule.runOnIdle {
            state = state.copy(
                activeRemoteTargetId = "pc-a",
                connection = AgentConnectionStatus.Connected,
            )
        }
        assertEquals(0, rule.onAllNodesWithTag("connection-status-pill").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithTag("connection-status-banner").fetchSemanticsNodes().size)

        // Carrier remains inspectable inside the expandable RunDetailsIsland on tap.
        rule.onNodeWithTag("run-island-persistent-title").performClick()
        rule.onNodeWithTag("run-island-connection-carrier").assertIsDisplayed()
        rule.onNodeWithText("Connected · TURN").assertIsDisplayed()
    }

    @Test
    fun chatConnectionPillAndBannerAreStrictlyMutuallyExclusive() {
        for (targetId in listOf("pc-a", null)) {
            for (status in AgentConnectionStatus.entries) {
                val showBanner = shouldShowChatConnectionBanner(status, targetId)
                val showPill = shouldShowChatConnectionPill(status, targetId)
                assertFalse(
                    "Pill and banner must never both be visible for status=$status targetId=$targetId",
                    showBanner && showPill,
                )
            }
        }
        assertTrue(shouldShowChatConnectionBanner(AgentConnectionStatus.Reconnecting, "pc-a"))
        assertFalse(shouldShowChatConnectionPill(AgentConnectionStatus.Reconnecting, "pc-a"))
        assertFalse(shouldShowChatConnectionBanner(AgentConnectionStatus.Connected, "pc-a"))
        assertFalse(shouldShowChatConnectionPill(AgentConnectionStatus.Connected, "pc-a"))
    }

    @Test
    fun connectedMissingRuntimeModelSurfacesRetryHintOutsideClosedPicker() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                chatOpen = true,
                sessionId = "s1",
                connection = AgentConnectionStatus.Connected,
                activeRemoteTargetId = "pc-a",
                runtimeResolving = false,
                runtimeModel = null,
                runtimeModelsError = null,
            ),
        )
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.None) {
                WorkbenchScreen(
                    state = state,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    onEvent = { events += it },
                )
            }
        }

        rule.onNodeWithTag("composer-runtime-retry").assertIsDisplayed()
        rule.onNodeWithText("No model loaded · Retry").assertIsDisplayed().performClick()
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.Retry))
        }

        rule.runOnIdle {
            state = state.copy(runtimeModelsError = "Models could not be loaded")
        }
        rule.onNodeWithText("Model list failed · Retry").assertIsDisplayed()

        // Hidden while runtime picker is open, resolving, or approval blocks input.
        rule.runOnIdle { state = state.copy(runtimePickerOpen = true) }
        assertEquals(0, rule.onAllNodesWithTag("composer-runtime-retry").fetchSemanticsNodes().size)

        rule.runOnIdle { state = state.copy(runtimePickerOpen = false, runtimeResolving = true) }
        assertEquals(0, rule.onAllNodesWithTag("composer-runtime-retry").fetchSemanticsNodes().size)

        rule.runOnIdle {
            state = state.copy(
                runtimeResolving = false,
                approval = PermissionRequestUiState(id = "app-1", title = "Approve", reason = "Allow tool"),
            )
        }
        assertEquals(0, rule.onAllNodesWithTag("composer-runtime-retry").fetchSemanticsNodes().size)
    }
}
