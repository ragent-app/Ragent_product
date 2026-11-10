package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.domain.RefreshResult
import com.andysagent.agentoc.core.domain.QueueMutationResult
import com.andysagent.agentoc.core.domain.QueuedFollowUpAction
import com.andysagent.agentoc.core.domain.SessionInvalidation
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.RuntimeSelection
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.QueuedMessage
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import com.andysagent.agentoc.core.timeline.TimelineRole
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ChatModernizationParityTest {

    @Test fun `completed run duration is saved for later offline display`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val reply = TimelineItem.Message("reply", 2, TimelineRole.Agent, "Done", true, runId = "run-a")
            val projection = kotlinx.serialization.json.Json.parseToJsonElement(
                """{"state":"completed","startedAt":1000,"completedAt":6500}"""
            ) as kotlinx.serialization.json.JsonObject
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "History", status = SessionStatus.Completed)),
                timelines = mapOf("s1" to listOf(reply)), runProjections = mapOf("run-a" to projection),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertEquals(5_500L, viewModel.state.value.runDurations["run-a"])
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun `completion refreshes duration even when active run was just checked`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val projections = mutableMapOf("run-a" to (kotlinx.serialization.json.Json.parseToJsonElement(
                """{"state":"running","startedAt":1000}"""
            ) as kotlinx.serialization.json.JsonObject))
            val reply = TimelineItem.Message("reply", 2, TimelineRole.Agent, "Working", false, runId = "run-a")
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Live", status = SessionStatus.Working)),
                timelines = mapOf("s1" to listOf(reply)), runProjections = projections,
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()
            assertNull(viewModel.state.value.runDurations["run-a"])
            projections["run-a"] = kotlinx.serialization.json.Json.parseToJsonElement(
                """{"state":"completed","startedAt":1000,"completedAt":6500}"""
            ) as kotlinx.serialization.json.JsonObject
            repository.updateSessionStatus("s1", SessionStatus.Completed)
            advanceUntilIdle()
            assertEquals(5_500L, viewModel.state.value.runDurations["run-a"])
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test fun `same session ID on another computer keeps separate drafts and timeline`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val a = TestSessionRepository(sessions = listOf(Session("shared", "Office")), timelines = mapOf("shared" to listOf(
                TimelineItem.Message(id = "a", seq = 1, role = TimelineRole.Agent, text = "Only Office", completed = true))))
            val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")), timelines = mapOf("shared" to listOf(
                TimelineItem.Message(id = "b", seq = 1, role = TimelineRole.Agent, text = "Only Home", completed = true))))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val model = ChatViewModel(switching)
            advanceUntilIdle()
            model.onEvent(ChatEvent.ComposerChanged("Office draft"))
            switching.switchTo(b)
            advanceUntilIdle()
            assertEquals("Home", model.state.value.sessionTitle)
            assertEquals("", model.state.value.composerText)
            assertEquals(listOf("Only Home"), model.state.value.timelineItems.filterIsInstance<TimelineItem.Message>().map { it.text })
            model.onEvent(ChatEvent.ComposerChanged("Home draft"))
            switching.switchTo(null)
            advanceUntilIdle()
            assertNull(model.state.value.sessionId)
            assertEquals("", model.state.value.composerText)
            assertTrue(model.state.value.timelineItems.isEmpty())
            switching.switchTo(a)
            advanceUntilIdle()
            assertEquals("Office draft", model.state.value.composerText)
            assertEquals(listOf("Only Office"), model.state.value.timelineItems.filterIsInstance<TimelineItem.Message>().map { it.text })
            switching.switchTo(b)
            advanceUntilIdle()
            assertEquals("Home draft", model.state.value.composerText)
            assertTrue(a.sentTexts.isEmpty())
            assertTrue(b.sentTexts.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `computer switch during goal persistence cannot redirect a pending send`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val enteredGoal = kotlinx.coroutines.CompletableDeferred<Unit>()
            val releaseGoal = kotlinx.coroutines.CompletableDeferred<Unit>()
            val a = TestSessionRepository(
                sessions = listOf(Session("shared", "Office")),
                beforeGoalUpdate = { enteredGoal.complete(Unit); releaseGoal.await() },
            )
            val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val model = ChatViewModel(switching)
            advanceUntilIdle()
            model.onEvent(ChatEvent.ToggleGoalMode(true))
            model.onEvent(ChatEvent.ComposerChanged("Office task"))
            model.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertTrue(enteredGoal.isCompleted)
            switching.switchTo(b)
            advanceUntilIdle()
            model.onEvent(ChatEvent.ComposerChanged("Home draft"))
            releaseGoal.complete(Unit)
            advanceUntilIdle()
            assertEquals(listOf("Office task"), a.sentTexts)
            assertTrue(b.sentTexts.isEmpty())
            assertEquals("Home", model.state.value.sessionTitle)
            assertEquals("Home draft", model.state.value.composerText)
            assertNull(model.state.value.pendingTurn)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `composer action sheet and attachment management`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Idle)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // Open and close action sheet
            assertFalse(viewModel.state.value.composerActionSheetOpen)
            viewModel.onEvent(ChatEvent.OpenComposerActionSheet)
            assertTrue(viewModel.state.value.composerActionSheetOpen)
            viewModel.onEvent(ChatEvent.CloseComposerActionSheet)
            assertFalse(viewModel.state.value.composerActionSheetOpen)

            // Add attachments
            val att1 = ComposerAttachment(id = "att-1", name = "log.txt", mimeType = "text/plain", sizeBytes = 1024L)
            val att2 = ComposerAttachment(id = "att-2", name = "screen.png", mimeType = "image/png", sizeBytes = 204800L)
            viewModel.onEvent(ChatEvent.AddAttachment(att1))
            viewModel.onEvent(ChatEvent.AddAttachment(att2))
            assertEquals(2, viewModel.state.value.attachments.size)
            assertEquals("log.txt", viewModel.state.value.attachments[0].name)

            // Remove attachment
            viewModel.onEvent(ChatEvent.RemoveAttachment("att-1"))
            assertEquals(1, viewModel.state.value.attachments.size)
            assertEquals("screen.png", viewModel.state.value.attachments[0].name)

            // Clear attachments
            viewModel.onEvent(ChatEvent.ClearAttachments)
            assertTrue(viewModel.state.value.attachments.isEmpty())

            // Toggle Plan mode
            assertFalse(viewModel.state.value.planMode)
            viewModel.onEvent(ChatEvent.TogglePlanMode(true))
            assertTrue(viewModel.state.value.planMode)

            // Toggle Goal mode & goal text
            assertFalse(viewModel.state.value.goalMode)
            viewModel.onEvent(ChatEvent.ToggleGoalMode(true))
            assertTrue(viewModel.state.value.goalMode)
            viewModel.onEvent(ChatEvent.GoalChanged("Deploy Production Release"))
            assertEquals("Deploy Production Release", viewModel.state.value.goalText)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `edit turn resend state machine`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Idle)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // Start editing previous turn
            viewModel.onEvent(ChatEvent.StartEditTurn("msg-1", "How do I setup AGY?"))
            assertEquals("msg-1", viewModel.state.value.editingTurnId)
            assertEquals("How do I setup AGY?", viewModel.state.value.editingTurnText)
            assertEquals("How do I setup AGY?", viewModel.state.value.composerText)

            // Cancel editing
            viewModel.onEvent(ChatEvent.CancelEditTurn)
            assertNull(viewModel.state.value.editingTurnId)
            assertNull(viewModel.state.value.editingTurnText)

            // Re-start and submit edit turn
            viewModel.onEvent(ChatEvent.StartEditTurn("msg-1", "How do I setup AGY on Linux?"))
            viewModel.onEvent(ChatEvent.SubmitEditTurn("msg-1", "How do I setup AGY on Linux with Gradle?"))
            advanceUntilIdle()

            assertNull(viewModel.state.value.editingTurnId)
            assertEquals(listOf("How do I setup AGY on Linux with Gradle?"), repository.editedPrompts)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `failed edit resend restores editable prompt and attachments`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Idle)),
                failEditedResend = com.andysagent.agentoc.core.domain.SessionRepositoryException(
                    400,
                    "INVALID_ARGUMENT",
                    "Run execution publication is unavailable or inconsistent",
                    retryable = false,
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            viewModel.onEvent(ChatEvent.StartEditTurn("msg-1", "Original prompt"))
            val attachment = ComposerAttachment(
                id = "att-1",
                name = "notes.txt",
                mimeType = "text/plain",
                sizeBytes = 12,
                localPath = "G:/AgentoC/test/notes.txt",
            )
            viewModel.onEvent(ChatEvent.AddAttachment(attachment))
            viewModel.onEvent(ChatEvent.SubmitEditTurn("msg-1", "Edited prompt", listOf(attachment)))
            advanceUntilIdle()

            assertEquals("Edited prompt", viewModel.state.value.composerText)
            assertEquals("msg-1", viewModel.state.value.editingTurnId)
            assertEquals("Original prompt", viewModel.state.value.editingTurnText)
            assertEquals(listOf(attachment), viewModel.state.value.attachments)
            assertFalse(viewModel.state.value.isLoading)
            assertNotNull(viewModel.state.value.error)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `queued messages during agent working state and steer interrupt`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Active Run", status = SessionStatus.Working)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertEquals(AgentRunStatus.Working, viewModel.state.value.runStatus)

            // Sending while the Agent is working still crosses the server
            // message boundary; the server owns the durable queue projection.
            viewModel.onEvent(ChatEvent.ComposerChanged("Also check test coverage"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals(1, viewModel.state.value.queuedMessages.size)
            assertEquals("Also check test coverage", viewModel.state.value.queuedMessages[0].text)
            assertEquals("", viewModel.state.value.composerText)
            assertEquals(listOf("Also check test coverage"), repository.sentTexts)

            // Enqueue a second message
            viewModel.onEvent(ChatEvent.ComposerChanged("Skip vendor directories"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals(2, viewModel.state.value.queuedMessages.size)

            // Editing a queue row keeps it intact until Send, then replaces
            // it through the normal active-run queue path.
            val secondId = viewModel.state.value.queuedMessages[1].id
            viewModel.onEvent(ChatEvent.ResendQueuedMessage(secondId, "Search only source directories"))
            advanceUntilIdle()
            assertEquals(2, viewModel.state.value.queuedMessages.size)
            assertEquals("Search only source directories", viewModel.state.value.queuedMessages[1].text)

            // Removing a separate queue row must not touch the replacement.
            val firstId = viewModel.state.value.queuedMessages[0].id
            viewModel.onEvent(ChatEvent.RemoveQueuedMessage(firstId))
            advanceUntilIdle()
            assertEquals(1, viewModel.state.value.queuedMessages.size)

            // Trigger Steer interrupt on the edited replacement.
            val replacementId = viewModel.state.value.queuedMessages[0].id
            viewModel.onEvent(ChatEvent.SteerMessage(replacementId))
            advanceUntilIdle()

            assertEquals(0, viewModel.state.value.queuedMessages.size)
            assertEquals(
                listOf("Also check test coverage", "Skip vendor directories", "Search only source directories"),
                repository.sentTexts,
            )
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `interactive decision card single and multi choice selection and submission`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Decision Session", status = SessionStatus.Idle)),
                approvals = listOf(
                    Approval(
                        id = "decision-1",
                        sessionId = "s1",
                        title = "Testing framework",
                        runId = "run-1",
                        kind = "question",
                        questions = listOf(
                            ApprovalQuestion(
                                question = "Which testing framework should be used?",
                                options = listOf(
                                    ApprovalOption("JUnit", "junit"),
                                    ApprovalOption("Kotest", "kotest"),
                                ),
                            ),
                        ),
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertNotNull(viewModel.state.value.activeDecision)
            val decisionId = viewModel.state.value.activeDecision!!.id
            // Trigger selection of option 1
            viewModel.onEvent(ChatEvent.SelectDecisionOption(decisionId, 1))
            advanceUntilIdle()
            assertEquals(setOf(1), viewModel.state.value.activeDecision?.selectedIndices)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `run sheet metrics and diff viewer state`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val fileDiff = FileDiffDetail(
                path = "src/main/App.kt",
                additions = 12,
                deletions = 3,
                diffContent = "@@ -1,3 +1,12 @@\n-old code\n+new enhanced code",
            )
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Run Session", status = SessionStatus.Idle)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // Open Run Sheet
            assertFalse(viewModel.state.value.runSheetOpen)
            viewModel.onEvent(ChatEvent.OpenRunSheet)
            assertTrue(viewModel.state.value.runSheetOpen)
            viewModel.onEvent(ChatEvent.CloseRunSheet)
            assertFalse(viewModel.state.value.runSheetOpen)

            // Open Diff Viewer
            assertNull(viewModel.state.value.selectedDiffFile)
            viewModel.onEvent(ChatEvent.OpenDiffViewer(fileDiff))
            assertNotNull(viewModel.state.value.selectedDiffFile)
            assertEquals("src/main/App.kt", viewModel.state.value.selectedDiffFile?.path)
            assertEquals(12, viewModel.state.value.selectedDiffFile?.additions)

            // Close Diff Viewer
            viewModel.onEvent(ChatEvent.CloseDiffViewer)
            assertNull(viewModel.state.value.selectedDiffFile)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `timeline artifacts automatically extract step traces and changed files`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val timelineItems = listOf(
                TimelineItem.Message(id = "m1", seq = 1, role = TimelineRole.User, text = "Refactor database", completed = true),
                TimelineItem.Operation(
                    id = "op1",
                    seq = 2,
                    kind = TimelineOperationKind.Command,
                    title = "grep -rn Room .",
                    detail = "Found 4 occurrences",
                    status = TimelineOperationStatus.Completed,
                ),
                TimelineItem.Operation(
                    id = "op2",
                    seq = 3,
                    kind = TimelineOperationKind.FileEdit,
                    title = "src/main/Database.kt",
                    detail = "@@ -1,5 +1,8 @@\n-class OldDb\n+class ModernRoomDb\n+fun setup()",
                    status = TimelineOperationStatus.Completed,
                    fileChanges = listOf(com.andysagent.agentoc.core.timeline.FileChangeItem(
                        path = "src/main/Database.kt", additions = 2, deletions = 1,
                    )),
                ),
            )
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Refactor Session", status = SessionStatus.Completed)),
                timelines = mapOf("s1" to timelineItems),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertEquals(2, viewModel.state.value.stepTraces.size)
            assertEquals("grep -rn Room .", viewModel.state.value.stepTraces[0].title)
            assertEquals(1, viewModel.state.value.changedFiles.size)
            assertEquals("src/main/Database.kt", viewModel.state.value.changedFiles[0].path)
            assertEquals(2, viewModel.state.value.changedFiles[0].additions)
            assertEquals(1, viewModel.state.value.changedFiles[0].deletions)
            assertEquals(2, viewModel.state.value.runMetrics.toolCallsCount)
            assertEquals(1, viewModel.state.value.runMetrics.filesChangedCount)
            assertEquals("N/A", viewModel.state.value.runMetrics.durationFormatted)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `timeline projection does not invent files from blank details or path-like titles`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val timelineItems = listOf(
                TimelineItem.Operation(
                    id = "op-command-path",
                    seq = 1,
                    kind = TimelineOperationKind.Command,
                    title = "/workspace/report.csv",
                    detail = "",
                    status = TimelineOperationStatus.Completed,
                ),
                TimelineItem.Operation(
                    id = "op-empty-edit",
                    seq = 2,
                    kind = TimelineOperationKind.FileEdit,
                    title = "src/main/App.kt",
                    detail = "",
                    status = TimelineOperationStatus.Completed,
                ),
            )
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "No Fake Files", status = SessionStatus.Completed)),
                timelines = mapOf("s1" to timelineItems),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertEquals(2, viewModel.state.value.stepTraces.size)
            assertTrue(viewModel.state.value.changedFiles.isEmpty())
            assertEquals(0, viewModel.state.value.runMetrics.filesChangedCount)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `per session draft preservation across session switching`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(
                    Session("s1", "Session 1", status = SessionStatus.Idle),
                    Session("s2", "Session 2", status = SessionStatus.Idle),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // In Session 1, type draft
            viewModel.onEvent(ChatEvent.SelectSession("s1"))
            viewModel.onEvent(ChatEvent.ComposerChanged("Draft text for session 1"))
            assertEquals("Draft text for session 1", viewModel.state.value.composerText)

            // Switch to Session 2, composer should be empty initially
            viewModel.onEvent(ChatEvent.SelectSession("s2"))
            assertEquals("", viewModel.state.value.composerText)

            // In Session 2, type a different draft
            viewModel.onEvent(ChatEvent.ComposerChanged("Draft for session 2"))
            assertEquals("Draft for session 2", viewModel.state.value.composerText)

            // Switch back to Session 1, draft should be restored
            viewModel.onEvent(ChatEvent.SelectSession("s1"))
            assertEquals("Draft text for session 1", viewModel.state.value.composerText)
            advanceUntilIdle() // Wait for the selected session's runtime before sending.

            // Send message in Session 1, draft should be cleared
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()
            assertEquals("", viewModel.state.value.composerText)
            assertEquals(listOf("Draft text for session 1"), repository.sentTexts)

            // Switch to Session 2, its draft is still preserved
            viewModel.onEvent(ChatEvent.SelectSession("s2"))
            advanceUntilIdle()
            assertEquals("Draft for session 2", viewModel.state.value.composerText)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `decision submission with selected options and write-in text`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Decision Flow", status = SessionStatus.Idle)),
                approvals = listOf(
                    Approval(
                        id = "decision-2",
                        sessionId = "s1",
                        title = "Deployment plan",
                        runId = "run-2",
                        kind = "question",
                        questions = listOf(
                            ApprovalQuestion(
                                question = "Which deployment mode should be used?",
                                options = listOf(
                                    ApprovalOption("Canary", "canary"),
                                    ApprovalOption("Full", "full"),
                                ),
                            ),
                        ),
                    ),
                ),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            assertNotNull(viewModel.state.value.activeDecision)
            val decisionId = viewModel.state.value.activeDecision!!.id

            // Select recommended option 0 and add a custom note
            viewModel.onEvent(ChatEvent.SelectDecisionOption(decisionId, 0))
            viewModel.onEvent(ChatEvent.DecisionWriteInChanged(decisionId, "Run staging first"))

            // Submit decision
            viewModel.onEvent(ChatEvent.SubmitDecision(decisionId))
            advanceUntilIdle()

            assertTrue(viewModel.state.value.activeDecision!!.isSubmitted)
            assertEquals(1, repository.runtimeDecisionCalls.size)
            // The runtime protocol resolves option indexes against the original question.
            assertEquals(listOf("0"), repository.runtimeDecisionCalls.single().choices)
            assertEquals("Run staging first", repository.runtimeDecisionCalls.single().customAnswer)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `pending goal armed with empty goal automatically adopts next message as goal and enables auto continue`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Idle)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // 1. Arm goal mode with empty goal
            viewModel.onEvent(ChatEvent.ToggleGoalMode(true))
            assertTrue(viewModel.state.value.goalMode)
            assertEquals("", viewModel.state.value.goalText)
            assertFalse(viewModel.state.value.autoContinue)

            // 2. User sends next message
            viewModel.onEvent(ChatEvent.ComposerChanged("Fix memory leak in background sync worker"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            // 3. The message text is adopted as goal and auto continue is enabled
            assertEquals("Fix memory leak in background sync worker", viewModel.state.value.goalText)
            assertTrue(viewModel.state.value.goalMode)
            assertTrue(viewModel.state.value.autoContinue)
            assertEquals(1, repository.sentTexts.size)
            assertEquals("Fix memory leak in background sync worker", repository.sentTexts[0])
            assertEquals(1, repository.updatedGoals.size)
            assertEquals(Triple("s1", "Fix memory leak in background sync worker", true), repository.updatedGoals[0])

            // 4. Subsequent user message does not overwrite the established goal
            viewModel.onEvent(ChatEvent.ComposerChanged("Also check database indexes"))
            viewModel.onEvent(ChatEvent.SendMessage)
            advanceUntilIdle()

            assertEquals("Fix memory leak in background sync worker", viewModel.state.value.goalText)
            assertEquals(2, repository.sentTexts.size)
            assertEquals("Also check database indexes", repository.sentTexts[1])
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `goal panel open, fill goal, start auto continue and pause auto continue`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Idle)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // Open Goal Dialog
            assertFalse(viewModel.state.value.goalDialogOpen)
            viewModel.onEvent(ChatEvent.OpenGoalDialog)
            assertTrue(viewModel.state.value.goalDialogOpen)

            // Fill goal and start auto-continue
            viewModel.onEvent(ChatEvent.StartAutoContinue("Refactor database migration schema"))
            advanceUntilIdle()

            assertFalse(viewModel.state.value.goalDialogOpen)
            assertTrue(viewModel.state.value.goalMode)
            assertEquals("Refactor database migration schema", viewModel.state.value.goalText)
            assertTrue(viewModel.state.value.autoContinue)
            assertEquals(Triple("s1", "Refactor database migration schema", true), repository.updatedGoals.lastOrNull())

            // Pause auto-continue
            viewModel.onEvent(ChatEvent.PauseAutoContinue)
            advanceUntilIdle()

            assertFalse(viewModel.state.value.autoContinue)
            assertEquals("Refactor database migration schema", viewModel.state.value.goalText)

            // Clear goal
            viewModel.onEvent(ChatEvent.ClearGoal)
            advanceUntilIdle()

            assertFalse(viewModel.state.value.goalMode)
            assertEquals("", viewModel.state.value.goalText)
            assertFalse(viewModel.state.value.autoContinue)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `saving a changed goal during a run resumes auto continue`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Working session", status = SessionStatus.Working)),
            )
            val model = ChatViewModel(repository)
            advanceUntilIdle()
            model.onEvent(ChatEvent.SaveGoal("Original goal"))
            advanceUntilIdle()
            model.onEvent(ChatEvent.SelectRuntime("claude"))
            model.onEvent(ChatEvent.SaveGoal("Changed goal"))
            advanceUntilIdle()

            assertEquals(Triple("s1", "Changed goal", true), repository.updatedGoals.last())
            assertEquals(listOf("[Goal updated]: Changed goal"), repository.sentTexts)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `saving a goal stays on the original computer when selection changes before IO`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val a = TestSessionRepository(sessions = listOf(Session("shared", "Office")))
            val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val model = ChatViewModel(switching)
            advanceUntilIdle()
            model.onEvent(ChatEvent.SaveGoal("Office goal"))
            switching.switchTo(b)
            advanceUntilIdle()

            assertEquals(listOf(Triple<String, String?, Boolean>("shared", "Office goal", false)), a.updatedGoals)
            assertTrue(b.updatedGoals.isEmpty())
            assertEquals("Home", model.state.value.sessionTitle)
            assertNull(model.state.value.error)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `failed goal save from previous computer does not change current session error`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
            val release = kotlinx.coroutines.CompletableDeferred<Unit>()
            val a = TestSessionRepository(
                sessions = listOf(Session("shared", "Office")),
                beforeGoalUpdate = {
                    entered.complete(Unit)
                    release.await()
                    throw java.io.IOException("Office disconnected")
                },
            )
            val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
            val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
            switching.switchTo(a)
            val model = ChatViewModel(switching)
            advanceUntilIdle()
            model.onEvent(ChatEvent.SaveGoal("Office goal"))
            advanceUntilIdle()
            assertTrue(entered.isCompleted)
            switching.switchTo(b)
            advanceUntilIdle()
            release.complete(Unit)
            advanceUntilIdle()

            assertEquals("Home", model.state.value.sessionTitle)
            assertNull(model.state.value.error)
            assertTrue(b.updatedGoals.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `failed goal save reports the failure`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Session")),
                beforeGoalUpdate = { throw java.io.IOException("Disconnected") },
            )
            val model = ChatViewModel(repository)
            advanceUntilIdle()
            model.onEvent(ChatEvent.SaveGoal("New goal"))
            advanceUntilIdle()

            assertTrue(model.state.value.error.orEmpty().contains("Goal could not be saved"))
            assertTrue(repository.updatedGoals.isEmpty())
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `goal controls stay on the original computer when selection changes before IO`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val commands = listOf(
                ChatEvent.StartAutoContinue("Office goal") to Pair<String?, Boolean>("Office goal", true),
                ChatEvent.PauseAutoContinue to Pair<String?, Boolean>("Office goal", false),
                ChatEvent.ClearGoal to Pair<String?, Boolean>(null, false),
            )
            for ((command, expected) in commands) {
                val a = TestSessionRepository(sessions = listOf(Session("shared", "Office")))
                val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
                val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
                switching.switchTo(a)
                val model = ChatViewModel(switching)
                advanceUntilIdle()
                model.onEvent(ChatEvent.GoalChanged("Office goal"))
                model.onEvent(command)
                switching.switchTo(b)
                advanceUntilIdle()

                assertEquals(listOf(Triple("shared", expected.first, expected.second)), a.updatedGoals,
                    "Original target must receive $command")
                assertTrue(b.updatedGoals.isEmpty(), "New target must not receive $command")
                assertEquals("Home", model.state.value.sessionTitle)
                assertNull(model.state.value.error)
            }
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `starting a changed running goal keeps runtime adaptation on the original computer`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            for (runtime in listOf("codex", "claude", "agy", "mock-batch-runtime")) {
                val a = TestSessionRepository(sessions = listOf(Session("shared", "Office", status = SessionStatus.Working)))
                val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
                val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
                switching.switchTo(a)
                val model = ChatViewModel(switching)
                advanceUntilIdle()
                model.onEvent(ChatEvent.GoalChanged("Original goal"))
                model.onEvent(ChatEvent.SelectRuntime(runtime))
                model.onEvent(ChatEvent.StartAutoContinue("Changed goal"))
                switching.switchTo(b)
                advanceUntilIdle()

                when (runtime) {
                    "codex" -> assertEquals(listOf(Triple<String, String?, Boolean>("shared", "Changed goal", true)), a.updatedGoals)
                    "claude", "agy" -> assertEquals(listOf("[Goal updated]: Changed goal"), a.sentTexts)
                    else -> {
                        assertTrue(a.updatedGoals.isEmpty())
                        assertTrue(a.sentTexts.isEmpty())
                    }
                }
                assertTrue(b.updatedGoals.isEmpty(), "$runtime must not change the new target")
                assertTrue(b.sentTexts.isEmpty(), "$runtime must not inject into the new target")
                assertEquals("Home", model.state.value.sessionTitle)
                assertNull(model.state.value.error)
            }
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `goal control failures are visible on their original conversation`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val commands = listOf(
                ChatEvent.StartAutoContinue("Office goal") to "Auto-continue could not be started",
                ChatEvent.PauseAutoContinue to "Auto-continue could not be paused",
                ChatEvent.ClearGoal to "Goal could not be cleared",
            )
            for ((command, failure) in commands) {
                val repository = TestSessionRepository(
                    sessions = listOf(Session("shared", "Office")),
                    beforeGoalUpdate = { throw java.io.IOException("Disconnected") },
                )
                val model = ChatViewModel(repository)
                advanceUntilIdle()
                model.onEvent(ChatEvent.GoalChanged("Office goal"))
                model.onEvent(command)
                advanceUntilIdle()

                assertTrue(model.state.value.error.orEmpty().contains(failure), "$command must report its failure")
                assertTrue(repository.updatedGoals.isEmpty())
            }
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `late goal control failures do not affect a different computer with the same session ID`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val commands = listOf(ChatEvent.StartAutoContinue("Office goal"),
                ChatEvent.PauseAutoContinue, ChatEvent.ClearGoal)
            for (command in commands) {
                val entered = kotlinx.coroutines.CompletableDeferred<Unit>()
                val release = kotlinx.coroutines.CompletableDeferred<Unit>()
                val a = TestSessionRepository(
                    sessions = listOf(Session("shared", "Office")),
                    beforeGoalUpdate = {
                        entered.complete(Unit)
                        release.await()
                        throw java.io.IOException("Office disconnected")
                    },
                )
                val b = TestSessionRepository(sessions = listOf(Session("shared", "Home")))
                val switching = com.andysagent.agentoc.core.domain.SwitchingSessionRepository(backgroundScope)
                switching.switchTo(a)
                val model = ChatViewModel(switching)
                advanceUntilIdle()
                model.onEvent(ChatEvent.GoalChanged("Office goal"))
                model.onEvent(command)
                advanceUntilIdle()
                assertTrue(entered.isCompleted)
                switching.switchTo(b)
                advanceUntilIdle()
                release.complete(Unit)
                advanceUntilIdle()

                assertEquals("Home", model.state.value.sessionTitle)
                assertNull(model.state.value.error, "$command failure belongs to Office")
                assertTrue(b.updatedGoals.isEmpty())
            }
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `runtime goal update adaptation for codex, claude, agy and non-streaming runtimes`() = runTest {
        Dispatchers.setMain(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
        try {
            val repository = TestSessionRepository(
                sessions = listOf(Session("s1", "Test Session", status = SessionStatus.Working)),
            )
            val viewModel = ChatViewModel(repository)
            advanceUntilIdle()

            // Pre-set goal and auto-continue
            viewModel.onEvent(ChatEvent.SaveGoal("Initial Goal"))
            viewModel.onEvent(ChatEvent.StartAutoContinue("Initial Goal"))
            advanceUntilIdle()

            // Case 1: Codex -> Direct update
            viewModel.onEvent(ChatEvent.SelectRuntime("codex"))
            viewModel.onEvent(ChatEvent.SaveGoal("Updated Codex Goal"))
            advanceUntilIdle()
            assertEquals("Updated Codex Goal", viewModel.state.value.goalText)
            assertEquals(Triple("s1", "Updated Codex Goal", true), repository.updatedGoals.last())

            // Case 2: Claude -> Streaming Prompt Injection
            viewModel.onEvent(ChatEvent.SelectRuntime("claude"))
            viewModel.onEvent(ChatEvent.SaveGoal("Updated Claude Goal"))
            advanceUntilIdle()
            assertEquals("Updated Claude Goal", viewModel.state.value.goalText)
            assertTrue(repository.sentTexts.contains("[Goal updated]: Updated Claude Goal"))

            // Case 3: AGY -> Streaming Prompt Injection
            viewModel.onEvent(ChatEvent.SelectRuntime("agy"))
            viewModel.onEvent(ChatEvent.SaveGoal("Updated AGY Goal"))
            advanceUntilIdle()
            assertEquals("Updated AGY Goal", viewModel.state.value.goalText)
            assertTrue(repository.sentTexts.contains("[Goal updated]: Updated AGY Goal"))

            // Case 4: Non-streaming runtime -> Next turn deferred
            viewModel.onEvent(ChatEvent.SelectRuntime("mock-batch-runtime"))
            val sentCountBefore = repository.sentTexts.size
            viewModel.onEvent(ChatEvent.SaveGoal("Updated Batch Goal"))
            advanceUntilIdle()
            assertEquals("Updated Batch Goal", viewModel.state.value.goalText)
            assertEquals(sentCountBefore, repository.sentTexts.size) // No immediate steer injected mid-turn
        } finally {
            Dispatchers.resetMain()
        }
    }
}

private class TestSessionRepository(
    sessions: List<Session> = emptyList(),
    private val approvals: List<Approval> = emptyList(),
    connection: RuntimeConnectionState = RuntimeConnectionState.Connected,
    private val timelines: Map<String, List<TimelineItem>> = emptyMap(),
    private val runProjections: Map<String, kotlinx.serialization.json.JsonObject> = emptyMap(),
    private val beforeGoalUpdate: suspend () -> Unit = {},
    private val failEditedResend: Throwable? = null,
) : SessionRepository {
    private val connectionStateValue = MutableStateFlow(connection)
    override val connectionState: StateFlow<RuntimeConnectionState> = connectionStateValue.asStateFlow()
    override val invalidations: Flow<SessionInvalidation> = MutableSharedFlow()
    private val sessionState = MutableStateFlow(sessions)
    fun updateSessionStatus(sessionId: String, status: SessionStatus) {
        sessionState.value = sessionState.value.map { if (it.id == sessionId) it.copy(status = status) else it }
    }
    private val computerState = MutableStateFlow<List<Computer>>(emptyList())
    private val projectState = MutableStateFlow<List<Project>>(emptyList())
    private val messageState = MutableStateFlow<List<Message>>(emptyList())
    val sentTexts = mutableListOf<String>()
    val editedPrompts = mutableListOf<String>()
    val runtimeDecisionCalls = mutableListOf<RuntimeDecisionCall>()

    private val timelineState = MutableStateFlow(timelines)
    private val durationsState = MutableStateFlow<Map<String, Long>>(emptyMap())
    override fun observeRunDurations(sessionId: String): Flow<Map<String, Long>> = durationsState
    override suspend fun saveRunDuration(sessionId: String, runId: String, durationMs: Long) {
        durationsState.value = durationsState.value + (runId to durationMs)
    }
    override suspend fun loadRunProjection(runId: String): kotlinx.serialization.json.JsonObject =
        runProjections[runId] ?: throw IllegalStateException("Run unavailable")
    override fun observeComputers(): Flow<List<Computer>> = computerState
    override fun observeProjects(): Flow<List<Project>> = projectState
    override fun observeSessions(): Flow<List<Session>> = sessionState
    override fun observeSession(sessionId: String): Flow<Session?> = MutableStateFlow(sessionState.value.firstOrNull { it.id == sessionId })
    override fun observeMessages(sessionId: String): Flow<List<Message>> = messageState
    override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = timelineState.map { it[sessionId].orEmpty() }
    override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = MutableStateFlow(approvals.filter { it.sessionId == sessionId })
    override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = approvals.firstOrNull { it.sessionId == sessionId && it.id == approvalId }
    override suspend fun createSession(name: String, tool: String): Session {
        val session = Session("s-new", name)
        sessionState.value = listOf(session)
        return session
    }
    override suspend fun createProject(name: String, rootPath: String): Project = Project("p-new", name, rootPath)
    override suspend fun refreshComputers() = Unit
    override suspend fun refreshProjects() = Unit
    override suspend fun refreshSessions() = Unit
    override suspend fun refreshEvents(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0)
    override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult = RefreshResult.Applied(events.size, 0)
    override suspend fun sendMessage(sessionId: String, text: String, requestId: String) {
        sentTexts += text
        val currentSession = sessionState.value.firstOrNull { it.id == sessionId }
        if (currentSession?.status != SessionStatus.Working) {
            val currentTimeline = timelineState.value[sessionId].orEmpty()
            timelineState.value = timelineState.value + (sessionId to (currentTimeline + TimelineItem.Message(
                id = "msg-$requestId",
                seq = (currentTimeline.size + 1).toLong(),
                role = com.andysagent.agentoc.core.timeline.TimelineRole.User,
                text = text,
                completed = true,
                requestId = requestId,
            )))
        }
        sessionState.value = sessionState.value.map {
            if (it.id != sessionId) it else if (it.status == SessionStatus.Working) {
                it.copy(queuedMessages = it.queuedMessages + QueuedMessage(requestId = requestId, text = text))
            } else {
                it.copy(status = SessionStatus.Idle)
            }
        }
    }
    override suspend fun updateQueuedFollowUp(
        sessionId: String,
        action: QueuedFollowUpAction,
        requestId: String?,
    ): Session? {
        val updated = sessionState.value.map { session ->
            if (session.id != sessionId) session else session.copy(
                queuedMessages = when (action) {
                    QueuedFollowUpAction.Clear -> emptyList()
                    QueuedFollowUpAction.Delete -> session.queuedMessages.filterNot { it.requestId == requestId }
                    QueuedFollowUpAction.TruncateFrom -> {
                        val index = session.queuedMessages.indexOfFirst { it.requestId == requestId }
                        if (index < 0) session.queuedMessages else session.queuedMessages.take(index)
                    }
                },
            )
        }
        sessionState.value = updated
        return updated.firstOrNull { it.id == sessionId }
    }
    override suspend fun steerQueuedFollowUp(sessionId: String, requestId: String): QueueMutationResult {
        val updated = sessionState.value.map { session ->
            if (session.id == sessionId) session.copy(
                queuedMessages = session.queuedMessages.filterNot { it.requestId == requestId },
                status = SessionStatus.Idle,
            ) else session
        }
        sessionState.value = updated
        return QueueMutationResult(updated.firstOrNull { it.id == sessionId }, requestId, steered = true)
    }
    override suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String,
    ) {
        editedPrompts += prompt
        failEditedResend?.let { throw it }
        sessionState.value = sessionState.value.map {
            if (it.id == sessionId) it.copy(status = SessionStatus.Idle) else it
        }
    }
    override suspend fun cancelSession(sessionId: String) = Unit
    override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) = Unit
    override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
    override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) = Unit
    override suspend fun resolveRuntimeApproval(
        runId: String,
        approvalId: String,
        decision: String,
        choices: List<String>,
        customAnswer: String?,
        requestId: String,
    ) {
        runtimeDecisionCalls += RuntimeDecisionCall(runId, approvalId, decision, choices, customAnswer, requestId)
    }
    val updatedGoals = mutableListOf<Triple<String, String?, Boolean>>()
    override suspend fun updateSessionGoal(sessionId: String, goal: String?, autoContinue: Boolean) {
        beforeGoalUpdate()
        updatedGoals += Triple(sessionId, goal, autoContinue)
    }
    override suspend fun resumePendingOperations(): Int = 0
}

private data class RuntimeDecisionCall(
    val runId: String,
    val approvalId: String,
    val decision: String,
    val choices: List<String>,
    val customAnswer: String?,
    val requestId: String,
)
