package com.andysagent.ragent.feature.workbench

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.core.timeline.IncrementalTimelineProjector
import com.andysagent.ragent.core.timeline.TimelineEvent
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import androidx.test.platform.app.InstrumentationRegistry
import android.graphics.Bitmap
import android.content.res.Configuration
import androidx.compose.ui.platform.LocalContext
import java.io.File
import java.util.Locale

class SessionActionsUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Composable private fun EnglishTheme(content: @Composable () -> Unit) {
        val context = LocalContext.current
        val english = remember(context) {
            context.createConfigurationContext(Configuration(context.resources.configuration).apply { setLocale(Locale.ENGLISH) })
        }
        CompositionLocalProvider(LocalContext provides english) { RagentTheme(content = content) }
    }

    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        rule.waitForIdle()
        android.os.SystemClock.sleep(350)
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: return
        val folder = instrumentation.targetContext.getExternalFilesDir(null) ?: return
        File(folder, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun liveThinkingRemainsAboveTheDurableAnswer() {
        val projection = IncrementalTimelineProjector()
        val start = TimelineEvent("start", 3, "text_delta", entityId = "reply", revision = 1,
            text = "", role = TimelineRole.Agent, runId = "run-a", messageState = "streaming")
        val thinking = TimelineEvent("thinking", 4, "reasoning", entityId = "thinking:run-a", revision = 2,
            text = "Working", operationKind = TimelineOperationKind.Tool, operationTitle = "Thinking", runId = "run-a")
        projection.project(emptyList(), listOf(start, thinking))
        projection.project(emptyList(), listOf(start.copy(id = "text", revision = 3, text = "The answer"), thinking))
        val answer = com.andysagent.ragent.core.model.Message("reply", "session", "assistant", "The answer",
            seq = 3, completed = true, runId = "run-a")
        val turn = TurnGroupProjector().project(projection.project(listOf(answer), listOf(thinking.copy(seq = 5)))).single()
        rule.setContent { EnglishTheme {
            TurnTimelineView(turn, true, null, null, {}, { _, _ -> }, {}, {}, showMessageActions = false)
        } }
        val thought = rule.onNodeWithText("Thinking").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val reply = rule.onNodeWithText("The answer").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Thinking should stay above the reply after durable synchronization", thought.bottom <= reply.top)
    }

    @Test fun bothListLevelsOpenTheTargetMenuWithoutOpeningChat() {
        val events = mutableListOf<WorkbenchEvent>()
        var state by mutableStateOf(WorkbenchUiState(
            destination = AgentoDestination.Sessions, connection = AgentConnectionStatus.Connected,
            activeRemoteTargetId = "device-a", projects = listOf(Project("p", "Project")),
            sessions = listOf(Session("a", "First chat", "p", SessionStatus.Completed), Session("b", "Second chat", "p", SessionStatus.Completed)),
        ))
        rule.setContent { EnglishTheme {
            SessionsSurface(state, { event ->
                events += event
                if (event is WorkbenchEvent.OpenProjectSessions) state = state.copy(projectSessionsOpen = true, browsingProjectId = event.projectId)
            }, AgentoWindowSizeClass.Compact)
        } }
        rule.onNodeWithTag("project-preview-a").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-menu").assertIsDisplayed()
        rule.runOnIdle { state = state.copy(activeRemoteTargetId = "device-b") }
        rule.onNodeWithTag("session-list-menu").assertDoesNotExist()
        rule.runOnIdle { state = state.copy(activeRemoteTargetId = "device-a") }
        rule.onNodeWithTag("project-preview-a").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-menu").assertIsDisplayed()
        rule.onNodeWithTag("session-list-dismiss").performClick()
        rule.onNodeWithContentDescription("Open project: Project").performClick()
        rule.onNodeWithTag("project-conversation-b").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-menu").assertIsDisplayed()
        screenshot("session-menu.png")
        rule.onNodeWithTag("session-list-delete").performClick()
        rule.onNodeWithTag("session-list-delete-confirmation").assertIsDisplayed()
        rule.onNodeWithText("Delete", substring = false).performClick()
        rule.runOnIdle {
            assertFalse(events.any { it is WorkbenchEvent.SelectSession })
            assertTrue(events.contains(WorkbenchEvent.PrepareListedSessionAction("device-a", "a")))
            assertTrue(events.contains(WorkbenchEvent.DeleteListedSession("device-a", "b")))
        }
    }

    @Test fun completedCommentaryHasNoActionsWhileTheRunIsActive() {
        var actions by mutableStateOf(false)
        var allowBranch by mutableStateOf(false)
        val reply = TimelineItem.Message("m", 1, TimelineRole.Agent, "Readable commentary", true, requestId = "r")
        val turn = TurnGroup(id = "r", requestId = "r", agentMessages = listOf(reply), finalAnswer = reply)
        rule.setContent { EnglishTheme {
            TurnTimelineView(turn, true, if (allowBranch) ({ _, _ -> }) else null, {}, {}, { _, _ -> }, {}, {}, onReport = {}, showMessageActions = actions)
        } }
        rule.onNodeWithText("Readable commentary").assertIsDisplayed()
        rule.onAllNodesWithContentDescription("Copy message").assertCountEquals(0)
        rule.onAllNodesWithTag("report-ai-content").assertCountEquals(0)
        rule.runOnIdle { actions = true }
        rule.onNodeWithContentDescription("Copy message").assertIsDisplayed()
        rule.onNodeWithTag("report-ai-content").assertIsDisplayed()
        rule.onAllNodesWithContentDescription("Branch from this message").assertCountEquals(0)
        rule.runOnIdle { allowBranch = true }
        screenshot("message-actions.png")
    }

    @Test fun projectAndSessionMenusExposePinAndExplicitProjectDeletionChoices() {
        val events = mutableListOf<WorkbenchEvent>()
        val state = WorkbenchUiState(
            destination = AgentoDestination.Sessions, connection = AgentConnectionStatus.Connected,
            activeRemoteTargetId = "device-a", projects = listOf(Project("p", "Project")),
            sessions = listOf(Session("a", "First chat", "p", SessionStatus.Completed)),
        )
        rule.setContent { EnglishTheme { SessionsSurface(state, { events += it }, AgentoWindowSizeClass.Compact) } }
        rule.onNodeWithTag("project-header-p").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-menu").assertIsDisplayed()
        rule.onNodeWithTag("project-list-pin").performClick()
        rule.onNodeWithTag("project-header-p").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-delete").performClick()
        rule.onNodeWithTag("project-delete-keep").assertIsDisplayed().performClick()
        rule.onNodeWithTag("project-header-p").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-delete").performClick()
        rule.onNodeWithTag("project-delete-all").assertIsDisplayed().performClick()
        rule.onNodeWithTag("project-preview-a").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-pin").performClick()
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.PinListedProject("device-a", "p", true)))
            assertTrue(events.contains(WorkbenchEvent.DeleteListedProject("device-a", "p", false)))
            assertTrue(events.contains(WorkbenchEvent.DeleteListedProject("device-a", "p", true)))
            assertTrue(events.contains(WorkbenchEvent.PinListedSession("device-a", "a", true)))
            assertFalse(events.any { it is WorkbenchEvent.SelectSession || it is WorkbenchEvent.OpenProjectSessions })
        }
    }

    @Test fun longPressRenamesTheSelectedProjectAndSession() {
        val events = mutableListOf<WorkbenchEvent>()
        val state = WorkbenchUiState(
            destination = AgentoDestination.Sessions, connection = AgentConnectionStatus.Connected,
            activeRemoteTargetId = "device-a", projects = listOf(Project("p", "Project")),
            sessions = listOf(Session("a", "First chat", "p", SessionStatus.Completed)),
        )
        rule.setContent { EnglishTheme { SessionsSurface(state, { events += it }, AgentoWindowSizeClass.Compact) } }
        rule.onNodeWithTag("project-header-p").performTouchInput { longClick() }
        rule.onNodeWithTag("project-list-rename").performClick()
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("project-list-name")), useUnmergedTree = true).performTextClearance()
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("project-list-name")), useUnmergedTree = true).performTextInput("New project")
        rule.onNodeWithText("Save").performClick()
        rule.onNodeWithTag("project-preview-a").performTouchInput { longClick() }
        rule.onNodeWithTag("session-list-rename").performClick()
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("session-list-name")), useUnmergedTree = true).performTextClearance()
        rule.onNode(hasSetTextAction() and hasAnyAncestor(hasTestTag("session-list-name")), useUnmergedTree = true).performTextInput("New chat")
        rule.onNodeWithText("Save").performClick()
        rule.runOnIdle {
            assertTrue(events.contains(WorkbenchEvent.RenameListedProject("device-a", "p", "New project")))
            assertTrue(events.contains(WorkbenchEvent.RenameListedSession("device-a", "a", "New chat")))
        }
    }
}
