package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.RuntimeModelOption
import com.andysagent.agentoc.core.model.RuntimeProviderOption
import com.andysagent.agentoc.core.model.RuntimeToolOption
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.domain.RefreshResult
import com.andysagent.agentoc.core.domain.OutboundAttachment
import com.andysagent.agentoc.core.domain.HarnessCapabilityCatalog
import com.andysagent.agentoc.core.domain.HarnessCapabilityItem
import com.andysagent.agentoc.core.domain.ProjectFolder
import com.andysagent.agentoc.core.domain.ProjectFolderBrowser
import com.andysagent.agentoc.core.domain.RuntimeSelection
import com.andysagent.agentoc.core.domain.SessionInvalidation
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SessionRepositoryException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class WorkbenchViewModelTest {
    @Test fun `permission denial preserves connection while revoked device asks to pair`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            for ((error, expected) in listOf(
                SessionRepositoryException(403, "OWNER_REQUIRED", "Owner permission required", false) to com.andysagent.agentoc.core.agentui.AgentConnectionStatus.Connected,
                SessionRepositoryException(403, "DEVICE_REVOKED", "Device revoked", false) to com.andysagent.agentoc.core.agentui.AgentConnectionStatus.AuthenticationRequired,
                SessionRepositoryException(401, "UNAUTHORIZED", "Unauthorized", false) to com.andysagent.agentoc.core.agentui.AgentConnectionStatus.AuthenticationRequired,
            )) {
                val repo = FakeSessionRepository(sessions = listOf(Session("s", "Test")), failSessionRefresh = error)
                val model = ChatViewModel(repo)
                advanceUntilIdle()
                assertEquals(expected, model.state.value.connection)
                assertNotNull(model.state.value.error)
            }
        } finally { Dispatchers.resetMain() }
    }
    @Test
    fun `tablet shell keeps its open chat while navigating the list until explicit back`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val shell = AppShellViewModel(FakeSessionRepository())
            shell.onEvent(AppShellEvent.OpenChat)
            shell.onEvent(AppShellEvent.SelectDestination(com.andysagent.agentoc.core.navigation.AgentoDestination.Settings, keepChat = true))
            assertTrue(shell.state.value.chatOpen)
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.ComputerManagement, keepChat = true))
            assertTrue(shell.state.value.chatOpen)
            shell.onEvent(AppShellEvent.OpenProjectSessions("project-b", keepChat = true))
            assertTrue(shell.state.value.chatOpen)
            shell.onEvent(AppShellEvent.CloseChat)
            assertFalse(shell.state.value.chatOpen)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `tablet conversation remains bound to its computer while foreground and refresh change`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val a = FakeSessionRepository(sessions = listOf(Session("same", "Computer A")), targetId = "a")
            val b = FakeSessionRepository(sessions = listOf(Session("same", "Computer B")), targetId = "b")
            val foreground = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            val detail = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            foreground.switchTo(a); detail.switchTo(a)
            val chat = ChatViewModel(detail)
            chat.preserveSelectedSessionOnRefresh = true
            advanceUntilIdle()
            chat.onEvent(ChatEvent.SelectSession("same")); advanceUntilIdle()
            foreground.switchTo(b); advanceUntilIdle()
            assertEquals("Computer A", chat.state.value.sessionTitle)
            val beforeA = a.sessionRefreshCalls; val beforeB = b.sessionRefreshCalls
            chat.onEvent(ChatEvent.Retry); advanceUntilIdle()
            assertTrue(a.sessionRefreshCalls > beforeA)
            assertEquals(beforeB, b.sessionRefreshCalls)
            a.setSessions(emptyList()); advanceUntilIdle()
            assertEquals("same", chat.state.value.sessionId)
            assertEquals("Computer A", chat.state.value.sessionTitle)
            detail.switchTo(b); chat.onEvent(ChatEvent.SelectSession("same")); advanceUntilIdle()
            assertEquals("Computer B", chat.state.value.sessionTitle)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `stop waits for authoritative completion and suppresses repeated requests`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val task = Session("a", "Running", status = SessionStatus.Working)
            val repo = FakeSessionRepository(sessions = listOf(task))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            vm.onEvent(ChatEvent.CancelRun); vm.onEvent(ChatEvent.CancelRun); runCurrent()
            assertEquals(listOf("a"), repo.cancelledSessions)
            assertEquals(StopRequestState.AwaitingConfirmation, vm.state.value.stopRequest)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.Working, vm.state.value.runStatus)
            repo.setSessions(listOf(task.copy(status = SessionStatus.Cancelled))); advanceUntilIdle()
            assertEquals(StopRequestState.None, vm.state.value.stopRequest)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.Cancelled, vm.state.value.runStatus)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `stop result stays on the original computer when identical session ids are switched`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val a = FakeSessionRepository(sessions = listOf(Session("same", "A", status = SessionStatus.Working)), cancelGate = gate)
            val b = FakeSessionRepository(sessions = listOf(Session("same", "B", status = SessionStatus.Working)))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val vm = ChatViewModel(switching); advanceUntilIdle()
            vm.onEvent(ChatEvent.CancelRun); advanceUntilIdle()
            switching.switchTo(b); advanceUntilIdle()
            gate.complete(Unit); runCurrent()
            assertEquals(listOf("same"), a.cancelledSessions)
            assertTrue(b.cancelledSessions.isEmpty())
            assertEquals(StopRequestState.None, vm.state.value.stopRequest)
            switching.switchTo(a); runCurrent()
            assertEquals(StopRequestState.AwaitingConfirmation, vm.state.value.stopRequest)
            advanceUntilIdle()
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `acknowledged stop without terminal state becomes recoverable without resending`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repo = FakeSessionRepository(sessions = listOf(Session("a", "A", status = SessionStatus.Working)))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            vm.onEvent(ChatEvent.CancelRun); runCurrent()
            assertEquals(StopRequestState.AwaitingConfirmation, vm.state.value.stopRequest)
            advanceTimeBy(15_000); runCurrent()
            assertEquals(StopRequestState.OutcomeUnknown, vm.state.value.stopRequest)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.Working, vm.state.value.runStatus)
            assertEquals(1, repo.cancelledSessions.size)
            assertTrue(repo.sentTexts.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `an earlier stop timeout cannot change a later request in the same session`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val task = Session("a", "A", status = SessionStatus.Working)
            val repo = FakeSessionRepository(sessions = listOf(task))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            vm.onEvent(ChatEvent.CancelRun); runCurrent()
            repo.setSessions(listOf(task.copy(status = SessionStatus.Cancelled))); runCurrent()
            advanceTimeBy(1_000)
            repo.setSessions(listOf(task)); runCurrent()
            vm.onEvent(ChatEvent.CancelRun); runCurrent()
            advanceTimeBy(14_000); runCurrent()
            assertEquals(StopRequestState.AwaitingConfirmation, vm.state.value.stopRequest)
            advanceTimeBy(1_000); runCurrent()
            assertEquals(StopRequestState.OutcomeUnknown, vm.state.value.stopRequest)
            assertEquals(2, repo.cancelledSessions.size)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `lost stop response is unknown rather than a stopped task`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repo = FakeSessionRepository(sessions = listOf(Session("a", "A", status = SessionStatus.Working)),
                cancelFailure = java.io.IOException("Lost response"))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            vm.onEvent(ChatEvent.CancelRun); advanceUntilIdle()
            assertEquals(StopRequestState.OutcomeUnknown, vm.state.value.stopRequest)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.Working, vm.state.value.runStatus)
            vm.onEvent(ChatEvent.CancelRun); advanceUntilIdle()
            assertEquals(1, repo.cancelledSessions.size)
            vm.onEvent(ChatEvent.Retry); advanceUntilIdle()
            assertEquals(StopRequestState.None, vm.state.value.stopRequest)
            assertEquals(1, repo.cancelledSessions.size)
            assertTrue(repo.sentTexts.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `browsing a runtime does not select a model and cancelling restores the committed choice`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected,
                runtimeCatalog = RuntimeCatalog(tools = listOf(
                    RuntimeToolOption("codex", "Codex", models = listOf(RuntimeModelOption("a", "Model A"))),
                    RuntimeToolOption("claude", "Claude", models = listOf(RuntimeModelOption("b", "Model B"))),
                )))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.SelectRuntime("codex"))
            viewModel.onEvent(ChatEvent.SelectModel("a"))
            viewModel.onEvent(ChatEvent.OpenRuntimePicker)
            val committed = viewModel.state.value.runtimeSelectionDisplay
            assertEquals("Model A", committed?.label)
            viewModel.onEvent(ChatEvent.SelectRuntime("claude"))
            assertEquals(committed, viewModel.state.value.runtimeSelectionDisplay)
            assertEquals(null, viewModel.state.value.runtimeModel)
            assertEquals(null, viewModel.state.value.runtimeProvider)
            viewModel.onEvent(ChatEvent.CloseRuntimePicker)
            assertEquals("codex", viewModel.state.value.runtimeTool)
            assertEquals("a", viewModel.state.value.runtimeModel)
            assertEquals(committed, viewModel.state.value.runtimeSelectionDisplay)
            viewModel.onEvent(ChatEvent.OpenRuntimePicker)
            viewModel.onEvent(ChatEvent.SelectRuntime("claude"))
            viewModel.onEvent(ChatEvent.SelectModel("b"))
            viewModel.onEvent(ChatEvent.CloseRuntimePicker)
            assertEquals("claude", viewModel.state.value.runtimeTool)
            assertEquals("b", viewModel.state.value.runtimeModel)
            assertEquals("Model B", viewModel.state.value.runtimeSelectionDisplay?.label)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `model commit qualifies provider and rejects missing leaves`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected,
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex",
                    providers = listOf(RuntimeProviderOption("a", "A"), RuntimeProviderOption("b", "B")),
                    models = listOf(RuntimeModelOption("same", "Model A", "a", true), RuntimeModelOption("same", "Model B", "b")),
                ))))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.OpenRuntimePicker)
            val committed = viewModel.state.value.runtimeSelectionDisplay
            viewModel.onEvent(ChatEvent.SelectProvider("b"))
            advanceUntilIdle()
            assertEquals(committed, viewModel.state.value.runtimeSelectionDisplay)
            assertEquals(listOf("b"), viewModel.state.value.runtimeCatalog.tools.single().models.map { it.provider })
            viewModel.onEvent(ChatEvent.SelectModel("missing"))
            assertTrue(viewModel.state.value.runtimePickerOpen)
            assertEquals(null, viewModel.state.value.runtimeModel)
            viewModel.onEvent(ChatEvent.CloseRuntimePicker)
            assertEquals("a", viewModel.state.value.runtimeProvider)
            assertEquals("Model A", viewModel.state.value.runtimeSelectionDisplay?.label)
            viewModel.onEvent(ChatEvent.OpenRuntimePicker)
            viewModel.onEvent(ChatEvent.SelectProvider("b"))
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.RefreshRuntimeCatalog)
            advanceUntilIdle()
            assertEquals("b", viewModel.state.value.runtimeProvider)
            assertEquals(null, viewModel.state.value.runtimeModel)
            assertEquals(listOf("a", "b"), viewModel.state.value.runtimeCatalog.tools.single().models.map { it.provider })
            viewModel.onEvent(ChatEvent.SelectModel("same"))
            assertEquals("b", viewModel.state.value.runtimeProvider)
            assertEquals("Model B", viewModel.state.value.runtimeSelectionDisplay?.label)
            assertFalse(viewModel.state.value.runtimeSelectionDisplay!!.supportsFast)
            assertFalse(viewModel.state.value.runtimePickerOpen)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `short timeline requests older history without a scroll gesture`() {
        assertTrue(
            shouldRequestOlderTimelineForViewport(
                firstVisibleItemIndex = 0,
                lastVisibleItemIndex = 0,
                lastVisibleItemEnd = 280,
                totalItemsCount = 1,
                viewportEndOffset = 1_200,
            ),
        )
        assertTrue(
            shouldRequestOlderTimelineForViewport(
                firstVisibleItemIndex = 2,
                lastVisibleItemIndex = 4,
                lastVisibleItemEnd = 1_200,
                totalItemsCount = 5,
                viewportEndOffset = 1_200,
            ),
        )
        assertFalse(
            shouldRequestOlderTimelineForViewport(
                firstVisibleItemIndex = 2,
                lastVisibleItemIndex = 4,
                lastVisibleItemEnd = 1_201,
                totalItemsCount = 5,
                viewportEndOffset = 1_200,
            ),
        )
        assertTrue(
            shouldRequestOlderTimelineForViewport(
                firstVisibleItemIndex = 0,
                lastVisibleItemIndex = 1,
                lastVisibleItemEnd = 1_200,
                totalItemsCount = 12,
                viewportEndOffset = 1_200,
            ),
        )
    }

    @Test
    fun `shell defaults to home and opens chat on demand`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()

            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.destination)
            assertFalse(viewModel.state.value.chatOpen)

            viewModel.onEvent(AppShellEvent.OpenChat)
            assertTrue(viewModel.state.value.chatOpen)

            viewModel.onEvent(AppShellEvent.CloseChat)
            assertFalse(viewModel.state.value.chatOpen)
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.destination)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `computer settings return to their parent and switching tabs clears the stack`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val shell = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.ComputerConfiguration))
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.ModelProviders))
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.ModelProviders))
            shell.onEvent(AppShellEvent.CloseSettingsPage)
            assertEquals(SettingsPage.ComputerConfiguration, shell.state.value.settingsPage)
            shell.onEvent(AppShellEvent.CloseSettingsPage)
            assertEquals(SettingsPage.Overview, shell.state.value.settingsPage)
            assertEquals(emptyList<SettingsPage>(), shell.state.value.settingsBackStack)
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.ComputerConfiguration))
            shell.onEvent(AppShellEvent.SelectDestination(com.andysagent.agentoc.core.navigation.AgentoDestination.Home))
            shell.onEvent(AppShellEvent.OpenSettingsPage(SettingsPage.Theme))
            shell.onEvent(AppShellEvent.CloseSettingsPage)
            assertEquals(SettingsPage.Overview, shell.state.value.settingsPage)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `closing chat preserves the primary destination it opened from`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()
            viewModel.onEvent(AppShellEvent.SelectDestination(com.andysagent.agentoc.core.navigation.AgentoDestination.Home))
            viewModel.onEvent(AppShellEvent.OpenChat)
            assertTrue(viewModel.state.value.chatOpen)
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.destination)

            viewModel.onEvent(AppShellEvent.CloseChat)
            assertFalse(viewModel.state.value.chatOpen)
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.destination)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `detail layers close in reverse order and preserve their parent destination`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()

            viewModel.onEvent(AppShellEvent.OpenProjectSessions("project-1"))
            assertTrue(viewModel.state.value.projectSessionsOpen)
            assertEquals("project-1", viewModel.state.value.browsingProjectId)

            viewModel.onEvent(AppShellEvent.OpenChat)
            assertTrue(viewModel.state.value.chatOpen)
            assertTrue(viewModel.state.value.projectSessionsOpen)

            viewModel.onEvent(AppShellEvent.CloseChat)
            assertFalse(viewModel.state.value.chatOpen)
            assertTrue(viewModel.state.value.projectSessionsOpen)

            viewModel.onEvent(AppShellEvent.CloseProjectSessions)
            assertFalse(viewModel.state.value.projectSessionsOpen)
            assertEquals(null, viewModel.state.value.browsingProjectId)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `project opened from home returns home after chat and project layers close`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()

            viewModel.onEvent(AppShellEvent.SelectDestination(com.andysagent.agentoc.core.navigation.AgentoDestination.Home))
            viewModel.onEvent(AppShellEvent.OpenProjectSessions("project-1"))
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Sessions, viewModel.state.value.destination)
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.projectOrigin)

            viewModel.onEvent(AppShellEvent.OpenChat)
            viewModel.onEvent(AppShellEvent.CloseChat)
            assertTrue(viewModel.state.value.projectSessionsOpen)
            viewModel.onEvent(AppShellEvent.CloseProjectSessions)
            assertEquals(com.andysagent.agentoc.core.navigation.AgentoDestination.Home, viewModel.state.value.destination)
            assertFalse(viewModel.state.value.projectSessionsOpen)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `chat opened from agents returns to agents before project`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository())
            advanceUntilIdle()

            viewModel.onEvent(AppShellEvent.OpenProjectSessions("project-1"))
            viewModel.onEvent(AppShellEvent.OpenAgents())
            viewModel.onEvent(AppShellEvent.OpenChat)
            assertTrue(viewModel.state.value.chatOpen)
            assertTrue(viewModel.state.value.agentOpen)

            viewModel.onEvent(AppShellEvent.CloseChat)
            assertFalse(viewModel.state.value.chatOpen)
            assertTrue(viewModel.state.value.agentOpen)
            viewModel.onEvent(AppShellEvent.CloseAgents)
            assertFalse(viewModel.state.value.agentOpen)
            assertTrue(viewModel.state.value.projectSessionsOpen)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `authentication required is visible as a recovery state`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = AppShellViewModel(FakeSessionRepository(connection = RuntimeConnectionState.AuthenticationRequired))
            advanceUntilIdle()

            assertEquals(com.andysagent.agentoc.core.agentui.AgentConnectionStatus.AuthenticationRequired, viewModel.state.value.connection)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `send creates a session and refreshes it`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("  automate this  "))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals(listOf("automate this"), repository.sentTexts)
            assertTrue(repository.created)
            assertEquals(listOf(""), repository.createdNames)
            assertEquals("", viewModel.state.value.composerText)
            assertFalse(viewModel.state.value.isLoading)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `selected harness capability id is carried into the outbound message`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val capability = HarnessCapabilityItem(
                id = "agentoc:mcp:agentoc",
                kind = "mcp",
                source = "agentoc",
                title = "agentoc",
            )
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Capabilities")),
                connection = RuntimeConnectionState.Connected,
                capabilities = HarnessCapabilityCatalog(tool = "codex", items = listOf(capability)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.SelectSession("session-1"))
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("/agentoc"))
            advanceUntilIdle()
            assertEquals(listOf(capability), viewModel.state.value.harnessCapabilities)

            viewModel.onEvent(ChatEvent.AddHarnessCapability(capability))
            viewModel.onEvent(ChatEvent.ComposerChanged("Use the connected AgentoC tools."))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals(listOf("agentoc:mcp:agentoc"), repository.structuredSends.single().harnessCapabilityIds)
            assertTrue(viewModel.state.value.selectedHarnessCapabilities.isEmpty())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `sending attachment transfers it from composer to one pending turn`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected, messageSendGate = gate)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            val attachment = ComposerAttachment(id = "attachment-fixture", name = "photo.png", mimeType = "image/png", localPath = "/fixture/photo.png")
            viewModel.onEvent(ChatEvent.AddAttachment(attachment))
            viewModel.onEvent(ChatEvent.ComposerChanged("Review this"))
            assertEquals(listOf(attachment), viewModel.state.value.attachments)
            viewModel.onEvent(ChatEvent.SendMessage)
            assertTrue(viewModel.state.value.attachments.isEmpty())
            val pending = requireNotNull(viewModel.state.value.pendingTurn)
            assertEquals(listOf(attachment), pending.attachments)
            advanceUntilIdle()
            gate.complete(Unit)
            advanceUntilIdle()
            assertTrue(viewModel.state.value.attachments.isEmpty())
            assertEquals(1, viewModel.state.value.acceptedTurns.count { it.requestId == pending.requestId })
            assertEquals(listOf(attachment), viewModel.state.value.acceptedTurns.single { it.requestId == pending.requestId }.attachments)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `send shows a local turn before the repository responds`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.ComposerChanged("prepare the weekly report"))
            viewModel.onEvent(ChatEvent.SendMessage)

            val pending = viewModel.state.value.pendingTurn
            assertEquals("prepare the weekly report", pending?.text)
            assertEquals(PendingTurnState.Sending, pending?.state)
            assertEquals("", viewModel.state.value.composerText)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.Working, viewModel.state.value.runStatus)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `follow up entered during an in-flight turn sends after acknowledgement`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val sendGate = CompletableDeferred<Unit>()
            val repository = FakeSessionRepository(
                connection = RuntimeConnectionState.Connected,
                messageSendGate = sendGate,
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.ComposerChanged("first request"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.ComposerChanged("follow up"))
            viewModel.onEvent(ChatEvent.SendMessage)
            assertEquals("follow up", viewModel.state.value.composerText)
            assertTrue(viewModel.state.value.pendingTurn != null)

            sendGate.complete(Unit)
            advanceUntilIdle()

            assertEquals(listOf("first request", "follow up"), repository.sentTexts)
            assertEquals("", viewModel.state.value.composerText)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `failed local turn remains in place and can retry`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                connection = RuntimeConnectionState.Connected,
                failMessageSend = true,
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.ComposerChanged("retry this"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals(PendingTurnState.Failed, viewModel.state.value.pendingTurn?.state)
            repository.failMessageSend = false
            viewModel.onEvent(ChatEvent.RetryPendingTurn)
            assertEquals(PendingTurnState.Sending, viewModel.state.value.pendingTurn?.state)
            advanceUntilIdle()
            assertEquals(listOf("retry this"), repository.sentTexts)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun `successful send stays visible until its own durable user event arrives`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repo = FakeSessionRepository(sessions = listOf(Session("a", "A")))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            repeat(2) {
                vm.onEvent(ChatEvent.ComposerChanged("hello")); vm.onEvent(ChatEvent.SendMessage); advanceUntilIdle()
            }
            assertEquals(null, vm.state.value.pendingTurn)
            assertEquals(2, vm.state.value.acceptedTurns.size)
            val first = vm.state.value.acceptedTurns.first().requestId
            val second = vm.state.value.acceptedTurns.last().requestId
            repo.setTimeline("a", listOf(TimelineItem.Message("reply", 1,
                com.andysagent.agentoc.core.timeline.TimelineRole.Agent, "Answer", true, requestId = first)))
            advanceUntilIdle()
            assertEquals(2, vm.state.value.acceptedTurns.size, "assistant acknowledgement cannot remove the user prompt")
            repo.setTimeline("a", listOf(TimelineItem.Message("user", 1,
                com.andysagent.agentoc.core.timeline.TimelineRole.User, "hello", true, requestId = first)))
            advanceUntilIdle()
            assertEquals(listOf(second), vm.state.value.acceptedTurns.map { it.requestId })
            assertFalse(vm.state.value.historyLoading)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `queue acknowledgement replaces the accepted echo without leaking across sessions`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repo = FakeSessionRepository(sessions = listOf(Session("a", "A"), Session("b", "B")))
            val vm = ChatViewModel(repo); advanceUntilIdle()
            vm.onEvent(ChatEvent.ComposerChanged("follow up")); vm.onEvent(ChatEvent.SendMessage); advanceUntilIdle()
            val accepted = vm.state.value.acceptedTurns.single()
            vm.onEvent(ChatEvent.SelectSession("b")); advanceUntilIdle()
            assertTrue(vm.state.value.acceptedTurns.isEmpty())
            repo.setSessions(listOf(Session("a", "A", queuedMessages = listOf(
                com.andysagent.agentoc.core.model.QueuedMessage(accepted.requestId, text = "follow up"))), Session("b", "B")))
            advanceUntilIdle(); vm.onEvent(ChatEvent.SelectSession("a")); advanceUntilIdle()
            assertEquals(1, vm.state.value.queuedMessages.size)
            assertTrue(vm.state.value.acceptedTurns.isEmpty())
            assertEquals(1, repo.attemptedSessionIds.size)
            // Dequeue and durable history are independent snapshots. Keep the
            // same local request visible through the gap, without resending it.
            repo.setSessions(listOf(Session("a", "A"), Session("b", "B")))
            advanceUntilIdle()
            assertTrue(vm.state.value.queuedMessages.isEmpty())
            assertEquals(listOf(accepted.requestId), vm.state.value.acceptedTurns.map { it.requestId })
            repo.setTimeline("a", listOf(TimelineItem.Message("user", 1,
                com.andysagent.agentoc.core.timeline.TimelineRole.User, "follow up", true,
                requestId = accepted.requestId)))
            advanceUntilIdle()
            assertTrue(vm.state.value.acceptedTurns.isEmpty())
            assertEquals(1, repo.attemptedSessionIds.size)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `failed turn stays with its original session when another history fails`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "A"), Session("b", "B")),
                failMessageSend = true, sessionRefreshFailures = mapOf("b" to IllegalStateException("B history unavailable")))
            val viewModel = ChatViewModel(repository); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("Only belongs to A")); viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            val failed = requireNotNull(viewModel.state.value.pendingTurn)
            viewModel.onEvent(ChatEvent.SelectSession("b"))
            assertEquals(null, viewModel.state.value.pendingTurn)
            advanceUntilIdle()
            assertEquals("b", viewModel.state.value.sessionId)
            assertEquals(null, viewModel.state.value.pendingTurn)
            viewModel.onEvent(ChatEvent.RetryPendingTurn); advanceUntilIdle()
            assertEquals(listOf("a"), repository.attemptedSessionIds)
            viewModel.onEvent(ChatEvent.SelectSession("a")); advanceUntilIdle()
            assertEquals(failed, viewModel.state.value.pendingTurn)
            repository.failMessageSend = false
            viewModel.onEvent(ChatEvent.RetryPendingTurn); advanceUntilIdle()
            assertEquals(listOf("a", "a"), repository.attemptedSessionIds)
            assertEquals(listOf(failed.requestId, failed.requestId), repository.attemptedRequestIds)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `failed new session does not inherit the old failed message or draft`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "A")),
                failMessageSend = true, failSessionCreation = true)
            val viewModel = ChatViewModel(repository); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("A failed message")); viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle(); val failed = viewModel.state.value.pendingTurn
            viewModel.onEvent(ChatEvent.ComposerChanged("A private draft"))
            viewModel.onEvent(ChatEvent.CreateSession())
            assertEquals(null, viewModel.state.value.pendingTurn)
            assertEquals("", viewModel.state.value.composerText)
            advanceUntilIdle()
            assertEquals(null, viewModel.state.value.sessionId)
            assertEquals(null, viewModel.state.value.pendingTurn)
            repository.setSessions(listOf(Session("a", "A updated"))); advanceUntilIdle()
            assertEquals(null, viewModel.state.value.sessionId, "a list refresh must not revive the old selection")
            viewModel.onEvent(ChatEvent.RetryPendingTurn); advanceUntilIdle()
            assertEquals(listOf("a"), repository.attemptedSessionIds)
            viewModel.onEvent(ChatEvent.SelectSession("a")); advanceUntilIdle()
            assertEquals(failed, viewModel.state.value.pendingTurn)
            assertEquals("A private draft", viewModel.state.value.composerText)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `late send failure cannot overwrite a failed new session`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "A")),
                messageSendGate = gate, failMessageSend = true, failSessionCreation = true)
            val viewModel = ChatViewModel(repository); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("Delayed A message")); viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle(); viewModel.onEvent(ChatEvent.CreateSession()); advanceUntilIdle()
            val creationError = viewModel.state.value.error
            gate.complete(Unit); advanceUntilIdle()
            assertEquals(null, viewModel.state.value.sessionId)
            assertEquals(null, viewModel.state.value.pendingTurn)
            assertEquals(creationError, viewModel.state.value.error)
            viewModel.onEvent(ChatEvent.SelectSession("a")); advanceUntilIdle()
            assertEquals("Delayed A message", viewModel.state.value.pendingTurn?.text)
            assertEquals(PendingTurnState.Failed, viewModel.state.value.pendingTurn?.state)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `late session creation cannot replace a newer explicit selection`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "A"), Session("b", "B")), creationGate = gate)
            val viewModel = ChatViewModel(repository); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.CreateSession()); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.SelectSession("b")); advanceUntilIdle()
            gate.complete(Unit); advanceUntilIdle()
            assertEquals("b", viewModel.state.value.sessionId)
            assertEquals(null, viewModel.state.value.pendingTurn)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `identical session ids on different computers never share a failed turn`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val a = FakeSessionRepository(sessions = listOf(Session("same", "Computer A")), failMessageSend = true)
            val b = FakeSessionRepository(sessions = listOf(Session("same", "Computer B")))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val viewModel = ChatViewModel(switching); advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("A only")); viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle(); val failed = requireNotNull(viewModel.state.value.pendingTurn)
            switching.switchTo(b); advanceUntilIdle()
            assertEquals(null, viewModel.state.value.pendingTurn)
            viewModel.onEvent(ChatEvent.RetryPendingTurn); advanceUntilIdle()
            assertTrue(b.attemptedSessionIds.isEmpty())
            switching.switchTo(a); advanceUntilIdle()
            assertEquals(failed, viewModel.state.value.pendingTurn)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `plan mode sends structured interaction and permission modes`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.SelectRuntime("claude"))
            viewModel.onEvent(ChatEvent.TogglePlanMode(true))
            viewModel.onEvent(ChatEvent.ComposerChanged("Prepare a deployment plan"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            val selection = repository.structuredSends.single().selection
            assertEquals("plan", selection.interactionMode)
            assertEquals("plan", selection.permissionMode)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `effort uses model values and falls back when switching models`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = listOf(
                    RuntimeModelOption("first", "First", effortLevels = listOf("low", "medium", "high", "xhigh", "max", "ultra"), defaultEffort = "medium"),
                    RuntimeModelOption("second", "Second", effortLevels = listOf("low", "high"), defaultEffort = "high"),
                    RuntimeModelOption("third", "Third"),
                )))),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("medium", viewModel.state.value.selectedEffort)
            viewModel.onEvent(ChatEvent.EffortChanged(1f))
            assertEquals("ultra", viewModel.state.value.selectedEffort)
            viewModel.onEvent(ChatEvent.ComposerChanged("hello"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals("ultra", repository.structuredSends.single().selection.effort)
            viewModel.onEvent(ChatEvent.SelectModel("second"))
            assertEquals("high", viewModel.state.value.selectedEffort)
            viewModel.onEvent(ChatEvent.SelectModel("third"))
            assertEquals(null, viewModel.state.value.selectedEffort)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `restores the saved session model and exact effort`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = listOf(
                    RuntimeModelOption("first", "First", effortLevels = listOf("low", "max"), defaultEffort = "low"),
                )))),
                sessionRuntime = mapOf("session-1" to RuntimeSelection("codex", model = "first", effort = "max")),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("max", viewModel.state.value.selectedEffort)
            viewModel.onEvent(ChatEvent.ComposerChanged("hello"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals("max", repository.structuredSends.single().selection.effort)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `session choice beats global choice and first provider default`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex",
                    providers = listOf(RuntimeProviderOption("p", "Provider")),
                    models = listOf(
                        RuntimeModelOption("default@p", "Default", "p", effortLevels = listOf("low", "high"), isDefault = true),
                        RuntimeModelOption("chosen@p", "Chosen", "p", effortLevels = listOf("low", "max")),
                    )))),
                sessionRuntime = mapOf("session-1" to RuntimeSelection("codex", "p", "chosen@p", "max")),
                globalRuntime = RuntimeSelection("codex", "p", "default@p", "low"),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("chosen@p", viewModel.state.value.runtimeModel)
            assertEquals("max", viewModel.state.value.selectedEffort)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `global choice wins before preferred installed harness default`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(runtimeCatalog = RuntimeCatalog(listOf(
                RuntimeToolOption("codex", "Codex", models = listOf(RuntimeModelOption("c", "C"))),
                RuntimeToolOption("claude", "Claude", models = listOf(RuntimeModelOption("m", "M", effortLevels = listOf("low", "high")))),
            )), globalRuntime = RuntimeSelection("claude", model = "m", effort = "high"))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("claude", viewModel.state.value.runtimeTool)
            assertEquals("m", viewModel.state.value.runtimeModel)
            assertEquals("high", viewModel.state.value.selectedEffort)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `missing harness shows installation prompt`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = ChatViewModel(FakeSessionRepository())
            advanceUntilIdle()
            assertEquals(true, viewModel.state.value.runtimeUnavailable)
            assertEquals(null, viewModel.state.value.runtimeModel)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `invalid remembered model falls back to codex provider default`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(runtimeCatalog = RuntimeCatalog(listOf(
                RuntimeToolOption("claude", "Claude", models = listOf(RuntimeModelOption("claude-model", "Claude"))),
                RuntimeToolOption("codex", "Codex", providers = listOf(RuntimeProviderOption("p", "P")), models = listOf(
                    RuntimeModelOption("first@p", "First", "p"),
                    RuntimeModelOption("default@p", "Default", "p", effortLevels = listOf("low", "high"), defaultEffort = "high", isDefault = true),
                )),
            )), globalRuntime = RuntimeSelection("codex", "old", "removed@old", "max"))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("codex", viewModel.state.value.runtimeTool)
            assertEquals("p", viewModel.state.value.runtimeProvider)
            assertEquals("default@p", viewModel.state.value.runtimeModel)
            assertEquals("high", viewModel.state.value.selectedEffort)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `sending with an automatic default remembers it for future sessions`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(runtimeCatalog = RuntimeCatalog(listOf(
                RuntimeToolOption("codex", "Codex", models = listOf(
                    RuntimeModelOption("default", "Default", effortLevels = listOf("low", "high"), defaultEffort = "high"),
                )),
            )))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("hello"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals("default", repository.globalRuntime?.model)
            assertEquals("high", repository.globalRuntime?.effort)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `local cache displays while loading then instance selection wins`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val repository = FakeSessionRepository(targetId = "target-a", globalGate = gate,
                globalRuntime = RuntimeSelection("codex", model = "server", effort = "high"),
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = listOf(
                    RuntimeModelOption("server", "Server", effortLevels = listOf("low", "high")),
                    RuntimeModelOption("cached", "Cached", effortLevels = listOf("low", "high")),
                )))))
            val viewModel = ChatViewModel(repository, readRuntimeCache = { target, _ ->
                if (target == "target-a") RuntimeSelection("codex", model = "cached", effort = "low") else null
            })
            testScheduler.runCurrent()
            assertEquals("cached", viewModel.state.value.runtimeModel)
            assertTrue(viewModel.state.value.runtimeResolving)
            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("server", viewModel.state.value.runtimeModel)
            assertEquals("high", viewModel.state.value.selectedEffort)
            assertFalse(viewModel.state.value.runtimeResolving)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `matching instance cache preserves the draft during validation`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val gate = CompletableDeferred<Unit>()
            val selection = RuntimeSelection("codex", model = "model", effort = "high")
            val repository = FakeSessionRepository(targetId = "target-a", globalGate = gate,
                globalRuntime = selection, runtimeCatalog = RuntimeCatalog(listOf(
                    RuntimeToolOption("codex", "Codex", models = listOf(
                        RuntimeModelOption("model", "Model", effortLevels = listOf("low", "high")),
                    )),
                )))
            val viewModel = ChatViewModel(repository, readRuntimeCache = { _, _ -> selection })
            testScheduler.runCurrent()
            viewModel.onEvent(ChatEvent.ComposerChanged("unsent draft"))
            gate.complete(Unit)
            advanceUntilIdle()
            assertEquals("model", viewModel.state.value.runtimeModel)
            assertEquals("high", viewModel.state.value.selectedEffort)
            assertEquals("unsent draft", viewModel.state.value.composerText)
            assertFalse(viewModel.state.value.runtimeResolving)
        } finally { Dispatchers.resetMain() }
    }
    @Test
    fun `clears previous session effort before sending a model without effort levels`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex", models = listOf(
                    RuntimeModelOption("plain", "Plain"),
                )))),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("hello"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals(listOf<String?>(null), repository.runtimeEffortUpdates)
            assertEquals(null, repository.structuredSends.single().selection.effort)
            assertTrue(repository.runtimeUpdatedBeforeSend)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `provider selection clears the old model and incompatible service tier`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                runtimeCatalog = RuntimeCatalog(
                    tools = listOf(
                        RuntimeToolOption(
                            id = "copilot",
                            label = "Copilot",
                            providers = listOf(
                                RuntimeProviderOption(id = "provider-a", label = "Provider A"),
                                RuntimeProviderOption(id = "provider-b", label = "Provider B"),
                            ),
                            models = listOf(
                                RuntimeModelOption("model-a@provider-a", "Model A", "provider-a", supportsFast = true),
                                RuntimeModelOption("model-b@provider-b", "Model B", "provider-b", supportsFast = false),
                            ),
                        ),
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.SelectRuntime("copilot"))
            viewModel.onEvent(ChatEvent.SelectProvider("provider-a"))
            viewModel.onEvent(ChatEvent.SelectServiceTier("fast"))
            viewModel.onEvent(ChatEvent.SelectProvider("provider-b"))

            assertEquals("provider-b", viewModel.state.value.runtimeProvider)
            assertEquals(null, viewModel.state.value.runtimeModel)
            assertEquals("standard", viewModel.state.value.serviceTier)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `selected agent is sent as structured binding instead of prompt text`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task", status = SessionStatus.Idle)),
                connection = RuntimeConnectionState.Connected,
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.SelectAgent("report_cleaner"))
            viewModel.onEvent(ChatEvent.ComposerChanged("clean the report"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals(1, repository.structuredSends.size)
            assertEquals("report_cleaner", repository.structuredSends.single().agentId)
            assertEquals("clean the report", repository.structuredSends.single().text)
            assertFalse(repository.structuredSends.single().text.contains("@report_cleaner"))
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `explicit new session stays provisional until the first turn`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.CreateSession())
            advanceUntilIdle()

            assertFalse(repository.created)
            assertEquals(null, viewModel.state.value.sessionId)
            assertFalse(viewModel.state.value.isLoading)

            viewModel.onEvent(ChatEvent.ComposerChanged("first message"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertTrue(repository.created)
            assertEquals(listOf(""), repository.createdNames)
            assertEquals("session-created", viewModel.state.value.sessionId)
            assertEquals(listOf("first message"), repository.sentTexts)
            assertFalse(viewModel.state.value.isLoading)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun `listed session actions target the long pressed session without selecting it`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "A"), Session("b", "B")), connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals("a", viewModel.state.value.sessionId)
            viewModel.onEvent(ChatEvent.PrepareListedSessionAction("b"))
            viewModel.onEvent(ChatEvent.RenameListedSession("b", "Renamed B"))
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.PrepareListedSessionAction("b"))
            viewModel.onEvent(ChatEvent.DeleteListedSession("b"))
            advanceUntilIdle()
            assertEquals(listOf("b" to "Renamed B"), repository.renamedSessions)
            assertEquals(listOf("b"), repository.deletedSessions)
            assertEquals("a", viewModel.state.value.sessionId)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `server title update reaches the selected conversation`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("a", "new session")), connection = RuntimeConnectionState.Connected)
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            repository.setSessions(listOf(Session("a", "Weekly report cleanup")))
            advanceUntilIdle()
            assertEquals("Weekly report cleanup", viewModel.state.value.sessionTitle)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `changing computers cannot redirect a prepared list deletion`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val first = FakeSessionRepository(sessions = listOf(Session("same", "First")), connection = RuntimeConnectionState.Connected)
            val second = FakeSessionRepository(sessions = listOf(Session("same", "Second")), connection = RuntimeConnectionState.Connected)
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(first)
            val viewModel = ChatViewModel(switching)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.PrepareListedSessionAction("same"))
            switching.switchTo(second)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.DeleteListedSession("same"))
            advanceUntilIdle()
            assertTrue(first.deletedSessions.isEmpty())
            assertTrue(second.deletedSessions.isEmpty())
            assertTrue(viewModel.state.value.error?.contains("changed") == true)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `changing computers cannot redirect prepared project actions`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val first = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val second = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(first)
            val viewModel = ChatViewModel(switching)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.PrepareListedProjectAction("same"))
            switching.switchTo(second)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.DeleteListedProject("same", true))
            advanceUntilIdle()
            assertTrue(first.deletedProjects.isEmpty())
            assertTrue(second.deletedProjects.isEmpty())
            assertTrue(viewModel.state.value.error?.contains("changed") == true)
            viewModel.onEvent(ChatEvent.PrepareListedProjectAction("same"))
            viewModel.onEvent(ChatEvent.PinListedProject("same", true))
            advanceUntilIdle()
            assertEquals(listOf("same" to true), second.pinnedProjects)
            assertTrue(first.pinnedProjects.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `failed first-turn session creation cannot reuse the previously selected session`() {
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-old", "Old session")),
                connection = RuntimeConnectionState.Connected,
                failSessionCreation = true,
            )
            val viewModel = ChatViewModel(repository)
            scheduler.advanceUntilIdle()
            assertEquals("session-old", viewModel.state.value.sessionId)

            viewModel.onEvent(ChatEvent.CreateSession())
            scheduler.advanceUntilIdle()

            assertEquals(null, viewModel.state.value.sessionId)
            assertEquals("New session", viewModel.state.value.sessionTitle)
            assertFalse(repository.created)
            assertEquals(null, viewModel.state.value.error)

            viewModel.onEvent(ChatEvent.ComposerChanged("Must not reach the old session"))
            viewModel.onEvent(ChatEvent.SendMessage)
            scheduler.advanceUntilIdle()
            assertTrue(repository.created)
            assertTrue(viewModel.state.value.error?.contains("creation failed") == true)
            assertTrue(repository.sentTexts.isEmpty())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `switching sessions clears the previous timeline while the new history loads`() {
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        try {
            val oldTimeline = listOf(
                TimelineItem.Message(
                    id = "old-message",
                    seq = 1,
                    role = com.andysagent.agentoc.core.timeline.TimelineRole.Agent,
                    text = "Old session content",
                    completed = true,
                ),
            )
            val repository = FakeSessionRepository(
                sessions = listOf(
                    Session("session-old", "Old", status = SessionStatus.Working),
                    Session("session-new", "New", status = SessionStatus.WaitingApproval),
                ),
                timelines = mapOf("session-old" to oldTimeline),
            )
            val viewModel = ChatViewModel(repository)
            scheduler.advanceUntilIdle()
            assertEquals(oldTimeline, viewModel.state.value.timelineItems)

            viewModel.onEvent(ChatEvent.SelectSession("session-new"))

            assertEquals("session-new", viewModel.state.value.sessionId)
            assertEquals("New", viewModel.state.value.sessionTitle)
            assertEquals(com.andysagent.agentoc.core.agentui.AgentRunStatus.WaitingApproval, viewModel.state.value.runStatus)
            assertTrue(viewModel.state.value.timelineItems.isEmpty())
            assertEquals(null, viewModel.state.value.timelineSessionId)
            assertTrue(viewModel.state.value.historyLoading)

            scheduler.advanceUntilIdle()

            assertTrue(viewModel.state.value.timelineItems.isEmpty())
            assertEquals(0, viewModel.state.value.messageCount)
            assertFalse(viewModel.state.value.historyLoading)
            assertEquals("session-new", viewModel.state.value.timelineSessionId)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `cancelling an old session refresh does not surface a load error on the new session`() {
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(
                    Session("session-old", "Old"),
                    Session("session-new", "New"),
                ),
                refreshGate = CompletableDeferred(),
            )
            val viewModel = ChatViewModel(repository)
            scheduler.runCurrent()

            viewModel.onEvent(ChatEvent.SelectSession("session-new"))
            scheduler.runCurrent()

            assertEquals("session-new", viewModel.state.value.sessionId)
            assertEquals(null, viewModel.state.value.error)
            assertTrue(viewModel.state.value.historyLoading)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `send while disconnected leaves draft and explains recovery`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val viewModel = ChatViewModel(FakeSessionRepository(connection = RuntimeConnectionState.Disconnected))
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.ComposerChanged("task"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals("task", viewModel.state.value.composerText)
            assertEquals("Connect a computer before sending a message.", viewModel.state.value.error)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `carrier error banner clears after the connection recovers`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Reconnect")),
                connection = RuntimeConnectionState.Disconnected,
                failSessionRefresh = java.io.IOException("No verified TURN/P2P carrier is available"),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertTrue(viewModel.state.value.error?.contains("No verified TURN/P2P carrier") == true)
            repository.failSessionRefresh = null
            repository.setConnection(RuntimeConnectionState.Connected)
            advanceUntilIdle()

            assertEquals(null, viewModel.state.value.error)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun `typed carrier errors automatically reload history after reconnect`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            for (code in listOf("CARRIER_UNAVAILABLE", "NETWORK_ERROR")) {
                val repository = FakeSessionRepository(sessions = listOf(Session("session-1", "Reconnect")),
                    connection = RuntimeConnectionState.Disconnected,
                    failSessionRefresh = com.andysagent.agentoc.core.domain.SessionRepositoryException(0, code, "The computer is reconnecting", true))
                val model = ChatViewModel(repository)
                advanceUntilIdle()
                assertTrue(model.state.value.clearErrorWhenConnected)
                assertNotNull(model.state.value.error)
                repository.failSessionRefresh = null
                repository.setConnection(RuntimeConnectionState.Connected)
                advanceUntilIdle()
                assertEquals(null, model.state.value.error)
                assertFalse(model.state.value.clearErrorWhenConnected)
                assertEquals("session-1", model.state.value.timelineSessionId)
            }
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `task errors are not cleared by carrier recovery`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("session-1", "Task")),
                connection = RuntimeConnectionState.Disconnected, failSessionRefresh = IllegalStateException("Task history is invalid"))
            val model = ChatViewModel(repository)
            advanceUntilIdle()
            val error = model.state.value.error
            assertNotNull(error)
            repository.setConnection(RuntimeConnectionState.Connected)
            advanceUntilIdle()
            assertEquals(error, model.state.value.error)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun `project and computer refresh errors clear after reconnect and successful reload`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Disconnected)
            repository.failProjectsRefresh = IllegalStateException("The computer is reconnecting")
            repository.failComputersRefresh = IllegalStateException("The computer is reconnecting")
            val projects = ProjectsViewModel(repository)
            val computers = ComputersViewModel(repository)
            projects.onEvent(ProjectsEvent.Refresh)
            computers.onEvent(ComputersEvent.Retry)
            advanceUntilIdle()
            assertNotNull(projects.state.value.error)
            assertNotNull(computers.state.value.error)
            repository.failProjectsRefresh = null
            repository.failComputersRefresh = null
            repository.setConnection(RuntimeConnectionState.Connected)
            advanceUntilIdle()
            assertEquals(null, projects.state.value.error)
            assertEquals(null, computers.state.value.error)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `pair action closes dialog after successful pairing`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            var received: Pair<String, String>? = null
            val viewModel = ComputersViewModel(
                FakeSessionRepository(connection = RuntimeConnectionState.Disconnected),
                pairAction = { uri, name -> received = uri to name },
            )
            advanceUntilIdle()
            viewModel.onEvent(ComputersEvent.OpenPairing)
            viewModel.onEvent(ComputersEvent.PairingUriChanged("agentoc://pair?..."))
            viewModel.onEvent(ComputersEvent.PairingDeviceNameChanged("Pixel"))
            viewModel.onEvent(ComputersEvent.Pair)
            advanceUntilIdle()

            assertEquals("agentoc://pair?..." to "Pixel", received)
            assertFalse(viewModel.state.value.pairingOpen)
            assertFalse(viewModel.state.value.pairingInProgress)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `question answer sends positional option index`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                approvals = listOf(Approval(
                    id = "q1", sessionId = "session-1", title = "Pick", runId = "run-1",
                    questions = listOf(ApprovalQuestion(question = "Which?", options = listOf(ApprovalOption("First"), ApprovalOption("Second")))),
                )),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.SelectDecisionOption("q1", 1))
            viewModel.onEvent(ChatEvent.SubmitDecision("q1"))
            advanceUntilIdle()
            assertEquals(listOf("1"), repository.runtimeApprovalChoices)
            assertEquals(listOf("session-1" to "q1"), repository.retiredStaleApprovalCalls)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `terminal run rejection retires stale question without retry banner`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                approvals = listOf(Approval(
                    id = "question-1",
                    sessionId = "session-1",
                    title = "Choose",
                    runId = "run-1",
                    kind = "question",
                    questions = listOf(ApprovalQuestion(question = "Choose one", options = listOf(ApprovalOption("A")))),
                )),
            ).apply {
                runtimeApprovalFailure = SessionRepositoryException(409, "RUN_TERMINAL", "Run is no longer active", false)
            }
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.SelectDecisionOption("question-1", 0))
            viewModel.onEvent(ChatEvent.SubmitDecision("question-1"))
            advanceUntilIdle()

            assertEquals(listOf("session-1" to "question-1"), repository.retiredStaleApprovalCalls)
            assertEquals(null, viewModel.state.value.activeDecision)
            assertEquals(null, viewModel.state.value.error)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `conversation question preserves distinct answers for each question`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("session-1", "Task")), approvals = listOf(
                Approval(id = "q", sessionId = "session-1", title = "Questions", runId = "run-1", kind = "question",
                    questions = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second"))),
            ))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.DecisionWriteInChanged("q", "alpha", 0))
            viewModel.onEvent(ChatEvent.DecisionWriteInChanged("q", "beta", 1))
            viewModel.onEvent(ChatEvent.SubmitDecision("q"))
            advanceUntilIdle()
            assertEquals(listOf("-1", "-1"), repository.runtimeApprovalChoices)
            assertEquals(listOf("alpha", "beta"), repository.runtimeApprovalCustomAnswers)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `conversation question can be denied`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(sessions = listOf(Session("session-1", "Task")), approvals = listOf(
                Approval(id = "q", sessionId = "session-1", title = "Question", runId = "run-1", kind = "question",
                    questions = listOf(ApprovalQuestion(question = "First"))),
            ))
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.Deny("q"))
            advanceUntilIdle()
            assertEquals("deny", repository.runtimeApprovalDecision)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `approval forwards structured decision to repository`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                approvals = listOf(
                    Approval(
                        id = "batch-1",
                        sessionId = "session-1",
                        title = "Approve actions",
                        runId = "run-1",
                        batchId = "batch-1",
                        kind = "approved_action_batch_request",
                        detailsJson = "{\"actions\":[{\"actionId\":\"action-1\"},{\"actionId\":\"action-2\"}]}",
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ChatEvent.Approve("batch-1"))
            advanceUntilIdle()

            assertEquals(
                ApprovedActionsCall("session-1", "run-1", "batch-1", approve = true),
                repository.approvedActionsCall,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `approval selection sends exact per-action decisions`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                approvals = listOf(
                    Approval(
                        id = "batch-1",
                        sessionId = "session-1",
                        title = "Approve actions",
                        runId = "run-1",
                        batchId = "batch-1",
                        kind = "approved_action_batch_request",
                        actions = listOf(
                            ApprovalAction("action-1", "Update report"),
                            ApprovalAction("action-2", "Restart service"),
                        ),
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.SelectApprovalAction("batch-1", "action-2", selected = false))
            viewModel.onEvent(ChatEvent.Approve("batch-1"))
            advanceUntilIdle()

            assertEquals(
                ApprovedActionBatchCall(
                    sessionId = "session-1",
                    runId = "run-1",
                    batchId = "batch-1",
                    decisions = listOf(
                        ApprovalActionDecision("action-1", "approve"),
                        ApprovalActionDecision("action-2", "deny"),
                    ),
                    approvalIntent = "approve",
                ),
                repository.approvedActionBatchCall,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `duplicate approval events submit only once`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(Session("session-1", "Task")),
                approvals = listOf(
                    Approval(
                        id = "batch-1",
                        sessionId = "session-1",
                        title = "Approve actions",
                        runId = "run-1",
                        batchId = "batch-1",
                        kind = "approved_action_batch_request",
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.Approve("batch-1"))
            viewModel.onEvent(ChatEvent.Approve("batch-1"))
            advanceUntilIdle()

            assertEquals(1, repository.approvedActionsCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `create project stores form result and closes dialog`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ProjectsViewModel(repository)
            advanceUntilIdle()
            viewModel.onEvent(ProjectsEvent.OpenProjectDialog)
            advanceUntilIdle()
            viewModel.onEvent(ProjectsEvent.ProjectNameChanged(" Reports "))
            viewModel.onEvent(ProjectsEvent.ProjectRootPathChanged(" /work/reports "))
            viewModel.onEvent(ProjectsEvent.CreateProject)
            advanceUntilIdle()

            assertEquals("Reports", repository.createdProject?.name)
            assertEquals("/work/reports", repository.createdProject?.folder)
            assertFalse(viewModel.state.value.projectDialogOpen)
            assertEquals(listOf("Reports"), viewModel.state.value.projects.map { it.name })
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `project picker browses remote folders and opens a created folder`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ProjectsViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ProjectsEvent.OpenProjectDialog)
            advanceUntilIdle()
            assertEquals("C:\\Workspace", viewModel.state.value.projectRootPath)
            assertEquals(listOf("Android", "Server"), viewModel.state.value.projectFolderChildren.map { it.name })
            assertEquals("Workspace", viewModel.state.value.projectName)

            viewModel.onEvent(ProjectsEvent.BrowseProjectFolder("C:\\Workspace\\Android"))
            advanceUntilIdle()
            assertEquals("C:\\Workspace\\Android", viewModel.state.value.projectRootPath)

            viewModel.onEvent(ProjectsEvent.ToggleProjectFolderCreate)
            viewModel.onEvent(ProjectsEvent.ProjectFolderNameChanged("Client"))
            viewModel.onEvent(ProjectsEvent.CreateProjectFolder)
            advanceUntilIdle()
            assertEquals("C:\\Workspace\\Android\\Client", viewModel.state.value.projectRootPath)
            assertFalse(viewModel.state.value.projectFolderCreateOpen)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `projects state combines projects and sessions and selects first project`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(
                sessions = listOf(
                    Session("session-1", "Prepare weekly report", "project-1", SessionStatus.Working, latestSeq = 4),
                    Session("session-2", "Review export", "project-1", SessionStatus.WaitingApproval, latestSeq = 2),
                    Session("session-3", "Unassigned task", null, SessionStatus.Completed, latestSeq = 1),
                ),
            )
            repository.setProjects(listOf(Project("project-1", "Operations", "/work/operations")))
            val viewModel = ProjectsViewModel(repository)
            advanceUntilIdle()

            assertEquals("project-1", viewModel.state.value.selectedProjectId)
            assertEquals(listOf("Prepare weekly report", "Review export", "Unassigned task"), viewModel.state.value.sessions.map { it.title })
            assertEquals(SessionStatus.WaitingApproval, viewModel.state.value.sessions[1].status)
            assertTrue(viewModel.state.value.hydrated)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `manual project refresh keeps cached state and reloads both catalogs`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = FakeSessionRepository(connection = RuntimeConnectionState.Connected)
            val viewModel = ProjectsViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ProjectsEvent.Refresh)

            assertTrue(viewModel.state.value.refreshing)
            advanceUntilIdle()

            assertFalse(viewModel.state.value.refreshing)
            assertEquals(1, repository.projectRefreshCalls)
            assertEquals(1, repository.sessionRefreshCalls)
        } finally {
            Dispatchers.resetMain()
        }
    }
}

private class FakeSessionRepository(
    sessions: List<Session> = emptyList(),
    private val approvals: List<Approval> = emptyList(),
    connection: RuntimeConnectionState = RuntimeConnectionState.Connected,
    private val timelines: Map<String, List<TimelineItem>> = emptyMap(),
    private val failSessionCreation: Boolean = false,
    private val creationGate: CompletableDeferred<Unit>? = null,
    private val refreshGate: CompletableDeferred<Unit>? = null,
    private val messageSendGate: CompletableDeferred<Unit>? = null,
    var failSessionRefresh: Throwable? = null,
    private val sessionRefreshFailures: Map<String, Throwable> = emptyMap(),
    var failMessageSend: Boolean = false,
    private val runtimeCatalog: RuntimeCatalog = RuntimeCatalog(),
    private val capabilities: HarnessCapabilityCatalog = HarnessCapabilityCatalog(tool = "unknown"),
    private val sessionRuntime: Map<String, RuntimeSelection> = emptyMap(),
    var globalRuntime: RuntimeSelection? = null,
    private val targetId: String? = null,
    private val globalGate: CompletableDeferred<Unit>? = null,
    private val cancelGate: CompletableDeferred<Unit>? = null,
    private val cancelFailure: Throwable? = null,
) : SessionRepository {
    override val runtimeTargetId: String? get() = targetId
    private val connectionStateValue = MutableStateFlow(connection)
    override val connectionState: StateFlow<RuntimeConnectionState> = connectionStateValue.asStateFlow()
    override val invalidations: Flow<SessionInvalidation> = MutableSharedFlow()
    private val sessionState = MutableStateFlow(sessions)
    private val computerState = MutableStateFlow<List<Computer>>(emptyList())
    private val projectState = MutableStateFlow<List<Project>>(emptyList())
    private val messageState = MutableStateFlow<List<Message>>(emptyList())
    private val timelineStates = timelines.mapValues { MutableStateFlow(it.value) }.toMutableMap()
    val sentTexts = mutableListOf<String>()
    val cancelledSessions = mutableListOf<String>()
    val structuredSends = mutableListOf<StructuredSend>()
    val runtimeEffortUpdates = mutableListOf<String?>()
    var runtimeUpdatedBeforeSend = false
    val attemptedSessionIds = mutableListOf<String>()
    val attemptedRequestIds = mutableListOf<String>()
    var created = false
    val createdNames = mutableListOf<String>()
    val deletedSessions = mutableListOf<String>()
    val renamedSessions = mutableListOf<Pair<String, String>>()
    val deletedProjects = mutableListOf<Pair<String, Boolean>>()
    val pinnedProjects = mutableListOf<Pair<String, Boolean>>()
    var approvedActionsCall: ApprovedActionsCall? = null
    var approvedActionBatchCall: ApprovedActionBatchCall? = null
    var approvedActionsCalls: Int = 0
    var runtimeApprovalChoices: List<String>? = null
    var runtimeApprovalDecision: String? = null
    var runtimeApprovalCustomAnswers: List<String>? = null
    var runtimeApprovalFailure: Throwable? = null
    val retiredStaleApprovalCalls = mutableListOf<Pair<String, String>>()
    var createdProject: Project? = null
    var projectRefreshCalls: Int = 0
    var failProjectsRefresh: Throwable? = null
    var failComputersRefresh: Throwable? = null
    var sessionRefreshCalls: Int = 0
    private val folders = mutableMapOf(
        "~" to ProjectFolderBrowser(
            path = "C:\\Workspace",
            parentPath = "C:\\",
            children = listOf(
                ProjectFolder("C:\\Workspace\\Android", "Android"),
                ProjectFolder("C:\\Workspace\\Server", "Server"),
            ),
        ),
        "C:\\Workspace\\Android" to ProjectFolderBrowser(
            path = "C:\\Workspace\\Android",
            parentPath = "C:\\Workspace",
        ),
    )

    fun setProjects(projects: List<Project>) {
        projectState.value = projects
    }

    fun setSessions(sessions: List<Session>) { sessionState.value = sessions }
    fun setTimeline(id: String, items: List<TimelineItem>) { timelineStates.getOrPut(id) { MutableStateFlow(emptyList()) }.value = items }

    fun setConnection(connection: RuntimeConnectionState) {
        connectionStateValue.value = connection
    }

    override fun observeComputers(): Flow<List<Computer>> = computerState
    override fun observeProjects(): Flow<List<Project>> = projectState
    override fun observeSessions(): Flow<List<Session>> = sessionState
    override fun observeSession(sessionId: String): Flow<Session?> = MutableStateFlow(sessionState.value.firstOrNull { it.id == sessionId })
    override fun observeMessages(sessionId: String): Flow<List<Message>> = messageState
    override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = timelineStates.getOrPut(sessionId) { MutableStateFlow(emptyList()) }
    override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = MutableStateFlow(approvals.filter { it.sessionId == sessionId })
    override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = approvals.firstOrNull { it.sessionId == sessionId && it.id == approvalId }
    override suspend fun retireStaleApproval(sessionId: String, approvalId: String) {
        retiredStaleApprovalCalls += sessionId to approvalId
    }
    override suspend fun createSession(name: String, tool: String): Session {
        created = true
        createdNames += name
        creationGate?.await()
        if (failSessionCreation) throw IllegalStateException("creation failed")
        val session = Session("session-created", name)
        sessionState.value = listOf(session) + sessionState.value.filterNot { it.id == session.id }
        return session
    }
    override suspend fun deleteSession(sessionId: String) { deletedSessions += sessionId }
    override suspend fun renameSession(sessionId: String, name: String) { renamedSessions += sessionId to name }
    override suspend fun deleteProject(projectId: String, deleteSessions: Boolean) { deletedProjects += projectId to deleteSessions }
    override suspend fun setProjectPinned(projectId: String, pinned: Boolean) { pinnedProjects += projectId to pinned }
    override suspend fun createProject(name: String, rootPath: String): Project {
        val project = Project("project-created", name.ifBlank { "Project" }, rootPath)
        createdProject = project
        projectState.value = listOf(project)
        return project
    }
    override suspend fun browseProjectFolders(path: String): ProjectFolderBrowser = folders[path]
        ?: ProjectFolderBrowser(path = path, parentPath = path.substringBeforeLast('\\', "").takeIf { it.isNotBlank() })
    override suspend fun createProjectFolder(parentPath: String, name: String): ProjectFolder {
        val path = parentPath.trimEnd('\\') + "\\" + name
        folders[path] = ProjectFolderBrowser(path = path, parentPath = parentPath)
        return ProjectFolder(path, name)
    }
    override suspend fun refreshComputers() { failComputersRefresh?.let { throw it } }
    override suspend fun refreshProjects() {
        projectRefreshCalls += 1
        failProjectsRefresh?.let { throw it }
    }
    override suspend fun refreshSessions() {
        sessionRefreshCalls += 1
    }
    override suspend fun loadRuntimeCatalog(): RuntimeCatalog = runtimeCatalog
    override suspend fun loadHarnessCapabilities(sessionId: String, tool: String?, providerProfile: String?): HarnessCapabilityCatalog = capabilities
    override suspend fun loadSessionRuntimeSelection(sessionId: String): RuntimeSelection? = sessionRuntime[sessionId]
    override suspend fun loadGlobalRuntimeSelection(): RuntimeSelection? { globalGate?.await(); return globalRuntime }
    override suspend fun saveGlobalRuntimeSelection(selection: RuntimeSelection) { globalRuntime = selection }
    override suspend fun updateRuntimeSelection(sessionId: String, tool: String, providerProfile: String?, model: String?, effort: String?, serviceTier: String) {
        runtimeEffortUpdates += effort
    }
    override suspend fun loadRuntimeModels(tool: String, providerProfile: String): List<RuntimeModelOption> =
        runtimeCatalog.tools.firstOrNull { it.id == tool }?.models.orEmpty()
            .filter { it.provider == providerProfile }
    override suspend fun refreshEvents(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0)
    override suspend fun refreshSessionDetail(sessionId: String): Session? {
        refreshGate?.await()
        failSessionRefresh?.let { throw it }
        sessionRefreshFailures[sessionId]?.let { throw it }
        return sessionState.value.firstOrNull { it.id == sessionId }
    }
    override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult = RefreshResult.Applied(events.size, 0)
    override suspend fun sendMessage(sessionId: String, text: String, requestId: String) {
        messageSendGate?.await()
        if (failMessageSend) throw IllegalStateException("send failed")
        sentTexts += text
    }
    override suspend fun sendMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String?,
        attachments: List<OutboundAttachment>,
        harnessCapabilityIds: List<String>,
    ) {
        attemptedSessionIds += sessionId
        attemptedRequestIds += requestId
        runtimeUpdatedBeforeSend = runtimeEffortUpdates.isNotEmpty()
        structuredSends += StructuredSend(text, agentId, attachments, selection, harnessCapabilityIds)
        sendMessage(sessionId, text, requestId)
    }
    override suspend fun cancelSession(sessionId: String) {
        cancelledSessions += sessionId
        cancelGate?.await()
        cancelFailure?.let { throw it }
    }
    override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) = Unit
    override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
    override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) {
        approvedActionsCalls += 1
        approvedActionsCall = ApprovedActionsCall(sessionId, runId, batchId, approve)
    }
    override suspend fun resolveApprovedActionBatch(
        sessionId: String,
        runId: String,
        batchId: String,
        decisions: List<ApprovalActionDecision>,
        approvalIntent: String,
        requestId: String,
    ) {
        if (decisions.isEmpty()) {
            // Older fixtures exercise the repository's compatibility default,
            // which delegates to the legacy all-or-nothing method.
            approvedActionsCalls += 1
            approvedActionsCall = ApprovedActionsCall(sessionId, runId, batchId, approvalIntent == "approve")
        } else {
            approvedActionBatchCall = ApprovedActionBatchCall(sessionId, runId, batchId, decisions, approvalIntent)
        }
    }
    override suspend fun resolveRuntimeApproval(runId: String, approvalId: String, decision: String, choices: List<String>, customAnswer: String?, requestId: String) {
        runtimeApprovalFailure?.let { throw it }
        runtimeApprovalChoices = choices
        runtimeApprovalDecision = decision
    }
    override suspend fun resolveRuntimeApprovalWithAnswers(runId: String, approvalId: String, choices: List<String>, customAnswers: List<String>, requestId: String) {
        runtimeApprovalChoices = choices
        runtimeApprovalCustomAnswers = customAnswers
    }
    override suspend fun resumePendingOperations(): Int = 0
}

private data class StructuredSend(
    val text: String,
    val agentId: String?,
    val attachments: List<OutboundAttachment>,
    val selection: RuntimeSelection,
    val harnessCapabilityIds: List<String>,
)

private data class ApprovedActionsCall(
    val sessionId: String,
    val runId: String,
    val batchId: String,
    val approve: Boolean,
)

private data class ApprovedActionBatchCall(
    val sessionId: String,
    val runId: String,
    val batchId: String,
    val decisions: List<ApprovalActionDecision>,
    val approvalIntent: String,
)
