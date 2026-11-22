package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.domain.RefreshResult
import com.andysagent.ragent.core.domain.RuntimeSelection
import com.andysagent.ragent.core.domain.SessionInvalidation
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.ApprovalOption
import com.andysagent.ragent.core.model.ApprovalQuestion
import com.andysagent.ragent.core.model.AsyncQuestionReply
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.ElicitationPayload
import com.andysagent.ragent.core.model.ElicitationResponse
import com.andysagent.ragent.core.model.ElicitationSchemaProperty
import com.andysagent.ragent.core.model.Message
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.timeline.TimelineItem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
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
class CodexQuestionViewModelTest {

    private class FakeCodexRepository(
        sessions: List<Session> = emptyList(),
        approvals: List<Approval> = emptyList(),
    ) : SessionRepository {
        val sessionsFlow = MutableStateFlow(sessions)
        val approvalsFlow = MutableStateFlow(approvals)
        val messagesFlow = MutableStateFlow<List<Message>>(emptyList())
        val timelineFlow = MutableStateFlow<List<TimelineItem>>(emptyList())

        override val connectionState: StateFlow<RuntimeConnectionState> =
            MutableStateFlow(RuntimeConnectionState.Connected).asStateFlow()
        override val invalidations: Flow<SessionInvalidation> = MutableSharedFlow()

        data class StructuredCall(
            val runId: String,
            val approvalId: String,
            val decision: String,
            val emptySkip: Boolean?,
            val elicitationResponse: ElicitationResponse?,
        )

        data class AsyncReplyCall(
            val sessionId: String,
            val replies: List<AsyncQuestionReply>,
            val trailingText: String,
            val steerIfRunning: Boolean,
        )

        val structuredCalls = mutableListOf<StructuredCall>()
        val asyncReplyCalls = mutableListOf<AsyncReplyCall>()
        val retiredApprovals = mutableListOf<Pair<String, String>>()

        override fun observeComputers(): Flow<List<Computer>> = MutableStateFlow(emptyList())
        override fun observeProjects(): Flow<List<Project>> = MutableStateFlow(emptyList())
        override fun observeSessions(): Flow<List<Session>> = sessionsFlow
        override fun observeSession(sessionId: String): Flow<Session?> = MutableStateFlow(sessionsFlow.value.firstOrNull { it.id == sessionId })
        override fun observeMessages(sessionId: String): Flow<List<Message>> = messagesFlow
        override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = timelineFlow
        override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> =
            MutableStateFlow(approvalsFlow.value.filter { it.sessionId == sessionId })
        override fun observeAllPendingApprovals(): Flow<List<Approval>> = approvalsFlow
        override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? =
            approvalsFlow.value.firstOrNull { it.sessionId == sessionId && it.id == approvalId }

        override suspend fun retireStaleApproval(sessionId: String, approvalId: String) {
            retiredApprovals += sessionId to approvalId
            approvalsFlow.value = approvalsFlow.value.filterNot { it.sessionId == sessionId && it.id == approvalId }
        }

        override suspend fun createSession(name: String, tool: String): Session = Session("s1", name)
        override suspend fun createProject(name: String, rootPath: String): Project = Project("p1", name, rootPath)
        override suspend fun refreshComputers() = Unit
        override suspend fun refreshProjects() = Unit
        override suspend fun refreshSessions() = Unit
        override suspend fun refreshEvents(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0)
        override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult = RefreshResult.Applied(0, 0)
        override suspend fun sendMessage(sessionId: String, text: String, requestId: String) = Unit
        override suspend fun cancelSession(sessionId: String) = Unit
        override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) = Unit
        override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
        override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) = Unit
        override suspend fun resolveRuntimeApproval(runId: String, approvalId: String, decision: String, choices: List<String>, customAnswer: String?, requestId: String) = Unit
        override suspend fun resolveRuntimeApprovalStructured(
            runId: String,
            approvalId: String,
            decision: String,
            choices: List<String>,
            customAnswer: String?,
            customAnswers: List<String>,
            multiChoices: List<List<Int>>?,
            emptySkip: Boolean?,
            elicitationResponse: ElicitationResponse?,
            requestId: String,
        ) {
            structuredCalls += StructuredCall(runId, approvalId, decision, emptySkip, elicitationResponse)
        }

        override suspend fun sendAsyncQuestionReplies(
            sessionId: String,
            replies: List<AsyncQuestionReply>,
            trailingText: String,
            selection: RuntimeSelection?,
            steerIfRunning: Boolean,
            requestId: String,
        ): Boolean {
            asyncReplyCalls += AsyncReplyCall(sessionId, replies, trailingText, steerIfRunning)
            return steerIfRunning
        }

        override suspend fun resumePendingOperations(): Int = 0
    }

    @Test
    fun `chatViewModel maps non-blocking question extensions and handles SkipDecision`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val approval = Approval(
                id = "q-nb",
                sessionId = "s1",
                title = "Optional check",
                status = "pending",
                runId = "run-1",
                kind = "question",
                isBlocking = false,
                questions = listOf(
                    ApprovalQuestion(
                        id = "qi-1",
                        header = "Target",
                        question = "Preferred cluster?",
                        options = listOf(ApprovalOption("Dev", "dev", "Use dev cluster")),
                        isOther = false,
                        isSecret = true,
                    ),
                ),
            )
            val repo = FakeCodexRepository(
                sessions = listOf(Session("s1", "Codex", status = SessionStatus.Working)),
                approvals = listOf(approval),
            )
            val vm = ChatViewModel(repo)
            advanceUntilIdle()

            val decision = vm.state.value.activeDecision
            assertNotNull(decision)
            assertFalse(decision.isBlocking)
            assertEquals("Target", decision.header)
            assertFalse(decision.isOther)
            assertTrue(decision.isSecret)
            assertEquals("Use dev cluster", decision.questionOptions.single().description)

            vm.onEvent(ChatEvent.SkipDecision("q-nb"))
            advanceUntilIdle()

            val call = repo.structuredCalls.single()
            assertEquals("approve", call.decision)
            assertEquals(true, call.emptySkip)
            assertEquals("q-nb", call.approvalId)
            assertTrue(vm.state.value.activeDecision?.isSubmitted == true)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `chatViewModel submits async question replies with steerIfRunning and tracks optimistic answers`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val repo = FakeCodexRepository(sessions = listOf(Session("s1", "Async", status = SessionStatus.Working)))
            val vm = ChatViewModel(repo)
            advanceUntilIdle()

            val replies = listOf(
                AsyncQuestionReply(questionItemId = "aq-1", question = "Framework?", answer = "Compose"),
                AsyncQuestionReply(questionItemId = "aq-2", question = "Secret?", answer = "top-secret"),
            )
            vm.onEvent(ChatEvent.SubmitAsyncQuestionReplies(replies, trailingText = "Continue"))
            advanceUntilIdle()

            val sent = repo.asyncReplyCalls.single()
            assertEquals("s1", sent.sessionId)
            assertEquals(replies, sent.replies)
            assertEquals("Continue", sent.trailingText)
            assertTrue(sent.steerIfRunning)
            assertTrue(vm.state.value.submittingAsyncQuestionIds.isEmpty())
            assertEquals("Compose", vm.state.value.optimisticallyAnsweredAsyncQuestions["aq-1"])
            assertEquals("top-secret", vm.state.value.optimisticallyAnsweredAsyncQuestions["aq-2"])
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `chatViewModel submits elicitation response and clears active approval`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val elicitationApproval = Approval(
                id = "el-1",
                sessionId = "s1",
                title = "GitHub Auth",
                status = "pending",
                runId = "run-9",
                kind = "permissions",
                elicitation = ElicitationPayload(
                    mode = "form",
                    serverName = "github",
                    schemaProperties = listOf(ElicitationSchemaProperty("token", format = "password", required = true)),
                ),
            )
            val repo = FakeCodexRepository(
                sessions = listOf(Session("s1", "MCP", status = SessionStatus.WaitingApproval)),
                approvals = listOf(elicitationApproval),
            )
            val vm = ChatViewModel(repo)
            advanceUntilIdle()
            assertNotNull(vm.state.value.approval?.elicitation)

            vm.onEvent(ChatEvent.SubmitElicitation("el-1", "accept", """{"token":"abc"}"""))
            advanceUntilIdle()

            val call = repo.structuredCalls.single()
            assertEquals("approve", call.decision)
            assertEquals("accept", call.elicitationResponse?.action)
            assertEquals("""{"token":"abc"}""", call.elicitationResponse?.contentJson)
            assertNull(vm.state.value.resolvingApprovalId)
            assertNull(vm.state.value.approval)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `attentionCenterViewModel handles SkipQuestion and ResolveElicitation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val nbQuestion = Approval(
                id = "q-nb",
                sessionId = "s1",
                title = "Optional",
                status = "pending",
                runId = "run-1",
                kind = "question",
                isBlocking = false,
                questions = listOf(ApprovalQuestion(question = "Any notes?", isOther = true)),
            )
            val urlElicitation = Approval(
                id = "el-url",
                sessionId = "s2",
                title = "OAuth",
                status = "pending",
                runId = "run-2",
                kind = "permissions",
                elicitation = ElicitationPayload(mode = "url", url = "https://example.com/oauth"),
            )
            val repo = FakeCodexRepository(
                sessions = listOf(
                    Session("s1", "One", status = SessionStatus.Working),
                    Session("s2", "Two", status = SessionStatus.WaitingApproval),
                ),
                approvals = listOf(nbQuestion, urlElicitation),
            )
            val vm = AttentionCenterViewModel(repo)
            advanceUntilIdle()

            vm.onEvent(AttentionEvent.SkipQuestion(AttentionReducer.approvalItemId("s1", "q-nb")))
            advanceUntilIdle()
            assertEquals(true, repo.structuredCalls.first().emptySkip)
            assertEquals("q-nb", repo.structuredCalls.first().approvalId)

            vm.onEvent(AttentionEvent.ResolveElicitation(AttentionReducer.approvalItemId("s2", "el-url"), "cancel"))
            advanceUntilIdle()
            val elCall = repo.structuredCalls.last()
            assertEquals("cancel", elCall.decision)
            assertEquals("cancel", elCall.elicitationResponse?.action)
            assertNull(elCall.elicitationResponse?.contentJson)
        } finally {
            Dispatchers.resetMain()
        }
    }
}
