package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApprovalResolutionCoordinatorTest {

    private class FakeRepository : SessionRepository {
        val approvals = mutableListOf<Approval>()
        val runtimeApprovals = mutableListOf<Triple<String, String, String>>()
        var lastChoices: List<String> = emptyList()
        var lastCustomAnswer: String? = null
        var lastCustomAnswers: List<String> = emptyList()
        var lastMultiChoices: List<List<Int>> = emptyList()
        val confirmations = mutableListOf<Triple<String, String, String>>()
        val refreshes = mutableListOf<String>()
        var findError: Throwable? = null
        var runtimeApprovalError: Throwable? = null
        var retiredApproval: Pair<String, String>? = null

        override val connectionState: StateFlow<RuntimeConnectionState> =
            MutableStateFlow(RuntimeConnectionState.Connected).asStateFlow()
        override val invalidations: Flow<SessionInvalidation> = MutableSharedFlow()

        override fun observeComputers(): Flow<List<Computer>> = MutableStateFlow(emptyList())
        override fun observeProjects(): Flow<List<Project>> = MutableStateFlow(emptyList())
        override fun observeSessions(): Flow<List<Session>> = MutableStateFlow(emptyList())
        override fun observeSession(sessionId: String): Flow<Session?> = MutableStateFlow(null)
        override fun observeMessages(sessionId: String): Flow<List<Message>> = MutableStateFlow(emptyList())
        override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = MutableStateFlow(emptyList())
        override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> = MutableStateFlow(emptyList())
        override fun observeAllPendingApprovals(): Flow<List<Approval>> = MutableStateFlow(approvals)

        override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? {
            findError?.let { throw it }
            return approvals.firstOrNull { it.sessionId == sessionId && it.id == approvalId }
        }

        override suspend fun retireStaleApproval(sessionId: String, approvalId: String) {
            retiredApproval = sessionId to approvalId
            approvals.replaceAll { if (it.sessionId == sessionId && it.id == approvalId) it.copy(status = "resolved") else it }
        }

        override suspend fun createSession(name: String, tool: String): Session = Session("s", name)
        override suspend fun createProject(name: String, rootPath: String): Project = Project("p", name, rootPath)
        override suspend fun refreshComputers() = Unit
        override suspend fun refreshProjects() = Unit
        override suspend fun refreshSessions() = Unit
        override suspend fun refreshEvents(sessionId: String): RefreshResult = RefreshResult.Applied(0, 0)
        override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult =
            RefreshResult.Applied(events.size, 0)

        override suspend fun refreshSessionDetail(sessionId: String): Session? {
            refreshes += sessionId
            return null
        }

        override suspend fun sendMessage(sessionId: String, text: String, requestId: String) = Unit
        override suspend fun cancelSession(sessionId: String) = Unit

        override suspend fun decideConfirmation(
            sessionId: String,
            confirmationId: String,
            decision: String,
            requestId: String,
        ) {
            confirmations += Triple(sessionId, confirmationId, decision)
        }

        override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
        override suspend fun resolveApprovedActions(
            sessionId: String,
            runId: String,
            batchId: String,
            approve: Boolean,
            requestId: String,
        ) = Unit

        override suspend fun resolvePrivilegedCategory(
            sessionId: String,
            runId: String,
            batchId: String,
            category: String,
            checkedOpIds: List<String>,
            webauthnProof: WebAuthnProofDto?,
            requestId: String,
        ) = Unit

        override suspend fun resolveRuntimeApproval(
            runId: String,
            approvalId: String,
            decision: String,
            choices: List<String>,
            customAnswer: String?,
            requestId: String,
        ) {
            runtimeApprovalError?.let { throw it }
            lastChoices = choices
            lastCustomAnswer = customAnswer
            runtimeApprovals += Triple(runId, approvalId, decision)
        }

        override suspend fun resolveRuntimeApprovalWithAnswers(runId: String, approvalId: String, choices: List<String>, customAnswers: List<String>, requestId: String) {
            lastChoices = choices
            lastCustomAnswers = customAnswers
            runtimeApprovals += Triple(runId, approvalId, "approve_with_answers")
        }
        override suspend fun resolveRuntimeApprovalWithMultiChoices(runId: String, approvalId: String, multiChoices: List<List<Int>>, customAnswers: List<String>, requestId: String) {
            lastMultiChoices = multiChoices
            lastCustomAnswers = customAnswers
            runtimeApprovals += Triple(runId, approvalId, "approve_with_multi_choices")
        }

        override suspend fun resumePendingOperations(): Int = 0
    }

    @Test
    fun `plain runtime approval is validated then submitted`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "a1",
            sessionId = "s1",
            title = "t",
            status = "pending",
            runId = "run-1",
        )
        val coordinator = ApprovalResolutionCoordinator(repository)
        val outcome = coordinator.resolvePlainApproval("s1", "a1", approve = true)
        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(Triple("run-1", "a1", "approve"), repository.runtimeApprovals.single())
        assertEquals("s1" to "a1", repository.retiredApproval)
        assertEquals(listOf("s1"), repository.refreshes)
    }

    @Test
    fun `terminal run rejection retires the cached approval instead of offering retry`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "stale-approval",
            sessionId = "s1",
            title = "Delete an expired QA file",
            status = "pending",
            runId = "run-finished",
            kind = "approval_request",
        )
        repository.runtimeApprovalError = ApiException(
            statusCode = 409,
            code = "RUN_TERMINAL",
            message = "Run is no longer active",
            retryable = false,
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolvePlainApproval("s1", "stale-approval", approve = true)

        assertEquals(ApprovalResolutionCoordinator.Outcome.Stale, outcome)
        assertEquals("s1" to "stale-approval", repository.retiredApproval)
        assertEquals("resolved", repository.approvals.single().status)
        assertTrue(repository.runtimeApprovals.isEmpty())
    }

    @Test
    fun `terminal runtime rejection retires a cached question approval`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "question-1",
            sessionId = "s1",
            title = "Choose one",
            status = "pending",
            runId = "run-finished",
            kind = "question",
            questions = listOf(ApprovalQuestion(question = "Choose", options = listOf(ApprovalOption("A")))),
        )
        repository.runtimeApprovalError = ApiException(
            statusCode = 409,
            code = "RUN_TERMINAL",
            message = "Run is no longer active",
            retryable = false,
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionsApproval(
            sessionId = "s1",
            approvalId = "question-1",
            choices = listOf(0),
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Stale, outcome)
        assertEquals("s1" to "question-1", repository.retiredApproval)
        assertEquals("resolved", repository.approvals.single().status)
    }

    @Test
    fun `confirmation approvals route through decideConfirmation`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "c1",
            sessionId = "s1",
            title = "t",
            status = "pending",
            passkeyRequired = false,
        )
        val outcome = ApprovalResolutionCoordinator(repository).resolvePlainApproval("s1", "c1", approve = false)
        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(Triple("s1", "c1", "deny"), repository.confirmations.single())
        assertTrue(repository.runtimeApprovals.isEmpty())
    }

    @Test
    fun `missing or non-pending approval is stale and submits nothing`() = runTest {
        val repository = FakeRepository()
        val coordinator = ApprovalResolutionCoordinator(repository)
        assertEquals(ApprovalResolutionCoordinator.Outcome.Stale, coordinator.resolvePlainApproval("s1", "missing", true))
        repository.approvals += Approval(id = "a1", sessionId = "s1", title = "t", status = "approved", passkeyRequired = false)
        assertEquals(ApprovalResolutionCoordinator.Outcome.Stale, coordinator.resolvePlainApproval("s1", "a1", true))
        assertTrue(repository.runtimeApprovals.isEmpty())
        assertTrue(repository.confirmations.isEmpty())
    }

    @Test
    fun `batch and passkey approvals require the session card`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "b1",
            sessionId = "s1",
            title = "t",
            status = "pending",
            runId = "run-1",
            batchId = "batch-1",
            passkeyRequired = false,
        )
        val coordinator = ApprovalResolutionCoordinator(repository)
        assertEquals(ApprovalResolutionCoordinator.Outcome.RequiresSession, coordinator.resolvePlainApproval("s1", "b1", true))

        val passkeyRepository = FakeRepository()
        passkeyRepository.approvals += Approval(
            id = "p1",
            sessionId = "s1",
            title = "t",
            status = "pending",
            runId = "run-1",
            passkeyRequired = false,
            actions = listOf(ApprovalAction(id = "op1", needsPasskey = true)),
        )
        assertEquals(
            ApprovalResolutionCoordinator.Outcome.RequiresSession,
            ApprovalResolutionCoordinator(passkeyRepository).resolvePlainApproval("s1", "p1", true),
        )
        assertTrue(repository.runtimeApprovals.isEmpty())
    }

    @Test
    fun `structured question option submits positioned choices despite legacy passkey default`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q1",
            sessionId = "s1",
            title = "Release choice",
            status = "pending",
            runId = "run-1",
            kind = "approval_request",
            questions = listOf(
                ApprovalQuestion(
                    question = "Which release mode should be used?",
                    options = listOf(ApprovalOption("Canary"), ApprovalOption("Full")),
                ),
            ),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionApproval(
            sessionId = "s1",
            approvalId = "q1",
            questionIndex = 0,
            optionIndex = 1,
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(Triple("run-1", "q1", "approve"), repository.runtimeApprovals.single())
        assertEquals(listOf("1"), repository.lastChoices)
        assertEquals(null, repository.lastCustomAnswer)
        assertEquals("s1" to "q1", repository.retiredApproval)
    }

    @Test
    fun `structured question custom answer submits unanswered choice marker`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q1",
            sessionId = "s1",
            title = "Release choice",
            status = "pending",
            runId = "run-1",
            kind = "approval_request",
            questions = listOf(
                ApprovalQuestion(
                    question = "Which release mode should be used?",
                    options = listOf(ApprovalOption("Canary")),
                ),
            ),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionApproval(
            sessionId = "s1",
            approvalId = "q1",
            questionIndex = 0,
            optionIndex = null,
            customAnswer = "  use a staged rollout  ",
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(listOf("-1"), repository.lastChoices)
        assertEquals("use a staged rollout", repository.lastCustomAnswer)
    }

    @Test
    fun `multiple questions submit positional choices in one response`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q2",
            sessionId = "s1",
            title = "Release setup",
            status = "pending",
            runId = "run-1",
            kind = "question",
            questions = listOf(
                ApprovalQuestion(
                    question = "Where should it run?",
                    options = listOf(ApprovalOption("Staging"), ApprovalOption("Production")),
                ),
                ApprovalQuestion(
                    question = "When should it run?",
                    options = listOf(ApprovalOption("Now"), ApprovalOption("Tonight")),
                ),
            ),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionsApproval(
            sessionId = "s1",
            approvalId = "q2",
            choices = listOf(1, 0),
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(listOf("1", "0"), repository.lastChoices)
        assertEquals(null, repository.lastCustomAnswer)
        assertEquals(1, repository.runtimeApprovals.size)
    }

    @Test
    fun `multiple questions allow one custom answer for one unanswered slot`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q3",
            sessionId = "s1",
            title = "Release setup",
            status = "pending",
            runId = "run-1",
            kind = "question",
            questions = listOf(
                ApprovalQuestion(
                    question = "Where should it run?",
                    options = listOf(ApprovalOption("Staging"), ApprovalOption("Production")),
                ),
                ApprovalQuestion(
                    question = "What label should be used?",
                    options = listOf(ApprovalOption("Default")),
                ),
            ),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionsApproval(
            sessionId = "s1",
            approvalId = "q3",
            choices = listOf(1, -1),
            customAnswer = "  Canary rollout  ",
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(listOf("1", "-1"), repository.lastChoices)
        assertEquals("Canary rollout", repository.lastCustomAnswer)
    }

    @Test
    fun `multi select validates each question and preserves selected indexes and custom text`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(id = "q", sessionId = "s1", title = "Questions", runId = "r", kind = "question",
            questions = listOf(ApprovalQuestion(question = "First", isMultiSelect = true, options = listOf(ApprovalOption("A"), ApprovalOption("B"))),
                ApprovalQuestion(question = "Second", options = listOf(ApprovalOption("C")))))
        val coordinator = ApprovalResolutionCoordinator(repository)
        assertEquals(ApprovalResolutionCoordinator.Outcome.Failed("问题回答无效"), coordinator.resolveMultiChoiceQuestions("s1", "q", listOf(listOf(0, 2), emptyList()), listOf("", "answer")))
        assertTrue(repository.runtimeApprovals.isEmpty())
        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, coordinator.resolveMultiChoiceQuestions("s1", "q", listOf(listOf(0, 1), emptyList()), listOf(" extra ", " answer ")))
        assertEquals(listOf(listOf(0, 1), emptyList()), repository.lastMultiChoices)
        assertEquals(listOf("extra", "answer"), repository.lastCustomAnswers)
    }

    @Test
    fun `multiple custom answers retain their question positions`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(id = "q", sessionId = "s1", title = "Questions", runId = "r", kind = "question",
            questions = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second")))
        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionsApproval("s1", "q", listOf(-1, -1),
            customAnswers = listOf(" first ", " second "))
        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(listOf("-1", "-1"), repository.lastChoices)
        assertEquals(listOf("first", "second"), repository.lastCustomAnswers)
        assertEquals("approve_with_answers", repository.runtimeApprovals.single().third)
    }

    @Test
    fun `multiple unanswered questions cannot share one custom answer`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q4",
            sessionId = "s1",
            title = "Release setup",
            status = "pending",
            runId = "run-1",
            kind = "question",
            questions = listOf(
                ApprovalQuestion(options = listOf(ApprovalOption("A"))),
                ApprovalQuestion(options = listOf(ApprovalOption("B"))),
            ),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionsApproval(
            sessionId = "s1",
            approvalId = "q4",
            choices = listOf(-1, -1),
            customAnswer = "one answer",
        )

        assertEquals(
            ApprovalResolutionCoordinator.Outcome.Failed("自定义回复只能回答一个问题"),
            outcome,
        )
        assertTrue(repository.runtimeApprovals.isEmpty())
    }

    @Test
    fun `legacy flat question options are still validated and submitted`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "q1",
            sessionId = "s1",
            title = "Release choice",
            status = "pending",
            runId = "run-1",
            kind = "question",
            options = listOf("Canary", "Full"),
        )

        val outcome = ApprovalResolutionCoordinator(repository).resolveQuestionApproval(
            sessionId = "s1",
            approvalId = "q1",
            questionIndex = 0,
            optionIndex = 1,
        )

        assertEquals(ApprovalResolutionCoordinator.Outcome.Submitted, outcome)
        assertEquals(listOf("1"), repository.lastChoices)
    }

    @Test
    fun `submission failure is reported without throwing`() = runTest {
        val repository = FakeRepository()
        repository.approvals += Approval(
            id = "a1",
            sessionId = "s1",
            title = "t",
            status = "pending",
            runId = "run-1",
            passkeyRequired = false,
        )
        val coordinator = ApprovalResolutionCoordinator(repository)
        assertEquals(
            ApprovalResolutionCoordinator.Outcome.Submitted,
            coordinator.resolvePlainApproval("s1", "a1", true),
        )
        // A repository that throws surfaces a Failed outcome instead of crashing.
        val failing = FakeRepository()
        failing.approvals += Approval(id = "a1", sessionId = "s1", title = "t", status = "pending", passkeyRequired = false)
        val failingCoordinator = ApprovalResolutionCoordinator(object : SessionRepository by failing {
            override suspend fun decideConfirmation(
                sessionId: String,
                confirmationId: String,
                decision: String,
                requestId: String,
            ) {
                throw RuntimeException("network gone")
            }
        })
        val outcome = failingCoordinator.resolvePlainApproval("s1", "a1", true)
        assertEquals("network gone", (outcome as ApprovalResolutionCoordinator.Outcome.Failed).message)
    }
}
