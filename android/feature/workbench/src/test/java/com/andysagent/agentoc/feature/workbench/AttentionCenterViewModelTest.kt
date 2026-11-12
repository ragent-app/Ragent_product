package com.andysagent.agentoc.feature.workbench

import androidx.lifecycle.ViewModelStore
import com.andysagent.agentoc.core.domain.RefreshResult
import com.andysagent.agentoc.core.domain.SessionInvalidation
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SwitchingSessionRepository
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.AttentionKind
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.protocol.WebAuthnProofResponseDto
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import com.andysagent.agentoc.core.timeline.TimelineItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class AttentionCenterViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @BeforeTest
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @AfterTest
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun approval(
        id: String,
        sessionId: String,
        status: String = "pending",
        passkeyRequired: Boolean = false,
    ) = Approval(
        id = id,
        sessionId = sessionId,
        title = "approval $id",
        status = status,
        passkeyRequired = passkeyRequired,
    )

    @Test fun `approval pushes reconcile both visible and background sessions`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session("s1", "Visible"), Session("s2", "Other")))
        val viewModel = AttentionCenterViewModel(repository)
        viewModel.onEvent(AttentionEvent.SetVisibleSession("s1"))
        runCurrent()
        repository.invalidationEvents.emit(SessionInvalidation("session_events", "s1", listOf(SessionEventDto(type = "approval_request"))))
        repository.invalidationEvents.emit(SessionInvalidation("session_events", "s2", listOf(SessionEventDto(type = "approval_response"))))
        repository.invalidationEvents.emit(SessionInvalidation("session_events", "s2", listOf(SessionEventDto(type = "reasoning"))))
        repository.invalidationEvents.emit(SessionInvalidation("session_invalidated", "s2"))
        runCurrent()
        assertEquals(listOf("s1", "s2", "s2"), repository.refreshedEvents)
    }

    @Test
    fun `queue projects sessions and approvals and filters the visible session`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(
                Session(id = "s1", title = "One", status = SessionStatus.WaitingApproval, updatedAt = 100L),
                Session(id = "s2", title = "Two"),
            ),
            approvals = listOf(approval("a1", "s1")),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        assertEquals(1, viewModel.state.value.items.size)
        assertEquals(AttentionReducer.approvalItemId("s1", "a1"), viewModel.state.value.activeItemId)

        viewModel.onEvent(AttentionEvent.SetVisibleSession("s1"))
        advanceUntilIdle()
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `dismiss hides the presentation without touching repository facts`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(approval("a1", "s1")),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        viewModel.onEvent(AttentionEvent.Dismiss(AttentionReducer.approvalItemId("s1", "a1")))
        advanceUntilIdle()
        assertTrue(viewModel.state.value.items.isEmpty())
        // The server fact is untouched; dismissal is presentation-only.
        assertTrue(repository.approvalState.value.single().status == "pending")
    }

    @Test
    fun `plain approval resolves once and drops from the queue`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(approval("a1", "s1")),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        viewModel.onEvent(AttentionEvent.ResolveApproval(AttentionReducer.approvalItemId("s1", "a1"), approve = true))
        advanceUntilIdle()
        assertEquals(1, repository.runtimeApprovalCalls)
        assertEquals("approve", repository.lastDecision)
        assertNull(viewModel.state.value.resolvingItemId)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `terminal run rejection retires a stale cross-session approval without an error banner`() = runTest(dispatcher.scheduler) {
        val stale = Approval(
            id = "stale-approval",
            sessionId = "s1",
            title = "Delete an expired QA file",
            status = "pending",
            runId = "run-finished",
            kind = "approval_request",
        )
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "Finished run")),
            approvals = listOf(stale),
        ).apply {
            resolveError = ApiException(409, "RUN_TERMINAL", "Run is no longer active", retryable = false)
        }
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()

        viewModel.onEvent(AttentionEvent.ResolveApproval(AttentionReducer.approvalItemId("s1", stale.id), approve = true))
        advanceUntilIdle()

        assertEquals("resolved", repository.approvalState.value.single().status)
        assertTrue(viewModel.state.value.items.isEmpty())
        assertNull(viewModel.state.value.error)
        assertNull(viewModel.state.value.resolvingItemId)
    }

    @Test
    fun `Windows Broker approval shares the global queue and resolves through its device signer`() = runTest(dispatcher.scheduler) {
        val approval = Approval(
            id = "broker-request-1",
            sessionId = "s1",
            title = "Restart the approved QA service",
            status = "pending",
            kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
            runId = "run-1",
            reason = "Windows Broker request details",
            riskLevel = "privileged",
            passkeyRequired = false,
        )
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "Windows run")))
        val broker = FakeBrokerApprovalController(listOf(approval))
        val viewModel = AttentionCenterViewModel(repository, broker)
        val viewModelStore = ViewModelStore().apply { put("attention", viewModel) }

        try {
            runCurrent()
            viewModel.onEvent(AttentionEvent.SetVisibleSession("s1"))
            runCurrent()

            val item = viewModel.state.value.items.single()
            assertEquals("windows-broker:unbound:broker-request-1:unbound", item.id)
            assertEquals(AttentionKind.Approval, item.kind)
            assertEquals("Restart the approved QA service", item.summary)
            assertEquals("Windows Broker request details", item.reason)
            assertTrue(!item.requiresSession)

            viewModel.onEvent(AttentionEvent.ResolveApproval(item.id, approve = true))
            runCurrent()

            assertEquals(listOf("broker-request-1" to true), broker.decisions)
            assertEquals(0, repository.runtimeApprovalCalls)
            assertTrue(viewModel.state.value.items.isEmpty())
        } finally {
            viewModelStore.clear()
        }
    }

    @Test
    fun `Broker stream shows a new request without recreating the ViewModel and clears on target switch`() = runTest(dispatcher.scheduler) {
        val broker = FakeBrokerApprovalController(emptyList())
        val viewModel = AttentionCenterViewModel(FakeRepository(), broker)
        val store = ViewModelStore().apply { put("attention", viewModel) }
        try {
            runCurrent()
            assertTrue(viewModel.state.value.items.isEmpty())
            broker.approvalState.value = listOf(
                approval("same-request", "s1").copy(
                    kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                    brokerTargetInstanceId = "computer-a",
                ),
            )
            runCurrent()
            assertEquals("windows-broker:computer-a:same-request:unbound", viewModel.state.value.items.single().id)

            broker.approvalState.value = emptyList()
            runCurrent()
            assertTrue(viewModel.state.value.items.isEmpty())
            broker.approvalState.value = listOf(
                approval("same-request", "s1").copy(
                    kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                    brokerTargetInstanceId = "computer-b",
                ),
            )
            runCurrent()
            assertEquals("windows-broker:computer-b:same-request:unbound", viewModel.state.value.items.single().id)
        } finally {
            store.clear()
        }
    }

    @Test
    fun `an uncertain Broker decision cannot be submitted again`() = runTest(dispatcher.scheduler) {
        val broker = FakeBrokerApprovalController(
            listOf(approval("request-1", "session-1").copy(
                kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                brokerTargetInstanceId = "computer-a",
                brokerDecisionUncertain = true,
            )),
        )
        val viewModel = AttentionCenterViewModel(FakeRepository(), broker)
        val store = ViewModelStore().apply { put("attention", viewModel) }
        try {
            runCurrent()
            val item = viewModel.state.value.items.single()
            viewModel.onEvent(AttentionEvent.ResolveApproval(item.id, approve = true))
            runCurrent()
            assertTrue(broker.decisions.isEmpty())
            assertEquals(item.id, viewModel.state.value.activeItemId)
        } finally {
            store.clear()
        }
    }

    @Test
    fun `unknown result makes the current Broker card non actionable immediately`() = runTest(dispatcher.scheduler) {
        val broker = FakeBrokerApprovalController(
            listOf(approval("request-1", "session-1").copy(
                kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                brokerTargetInstanceId = "computer-a",
                brokerChallengeDigest = "signed-challenge",
            )),
        )
        broker.resolveError = BrokerApprovalOutcomeUnknownException("Outcome unknown; check original request")
        val viewModel = AttentionCenterViewModel(FakeRepository(), broker)
        val store = ViewModelStore().apply { put("attention", viewModel) }
        try {
            runCurrent()
            val itemId = viewModel.state.value.items.single().id
            viewModel.onEvent(AttentionEvent.ResolveApproval(itemId, approve = true))
            runCurrent()
            assertEquals(1, broker.attempts)
            assertTrue(viewModel.state.value.items.single().approval?.brokerDecisionUncertain == true)
            assertEquals("Outcome unknown; check original request", viewModel.state.value.error)

            viewModel.onEvent(AttentionEvent.ResolveApproval(itemId, approve = true))
            runCurrent()
            assertEquals(1, broker.attempts)
        } finally {
            store.clear()
        }
    }

    @Test
    fun `question selection resolves through the attention coordinator`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(
                Approval(
                    id = "q1",
                    sessionId = "s1",
                    title = "Release choice",
                    kind = "approval_request",
                    runId = "run-1",
                    questions = listOf(
                        ApprovalQuestion(
                            question = "Which release mode should be used?",
                            options = listOf(ApprovalOption("Canary"), ApprovalOption("Full")),
                        ),
                    ),
                ),
            ),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()

        val itemId = AttentionReducer.approvalItemId("s1", "q1")
        assertEquals(AttentionKind.Question, viewModel.state.value.items.single().kind)
        viewModel.onEvent(AttentionEvent.ResolveQuestion(itemId, questionIndex = 0, optionIndex = 1))
        advanceUntilIdle()

        assertEquals(1, repository.runtimeApprovalCalls)
        assertEquals("approve", repository.lastDecision)
        assertEquals(listOf("1"), repository.lastChoices)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `multiple question event submits all choices together`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(
                Approval(
                    id = "q2",
                    sessionId = "s1",
                    title = "Release setup",
                    kind = "question",
                    runId = "run-1",
                    questions = listOf(
                        ApprovalQuestion(options = listOf(ApprovalOption("Staging"), ApprovalOption("Production"))),
                        ApprovalQuestion(options = listOf(ApprovalOption("Now"), ApprovalOption("Tonight"))),
                    ),
                ),
            ),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()

        val itemId = AttentionReducer.approvalItemId("s1", "q2")
        viewModel.onEvent(AttentionEvent.ResolveQuestions(itemId, choices = listOf(1, 0)))
        advanceUntilIdle()

        assertEquals(1, repository.runtimeApprovalCalls)
        assertEquals(listOf("1", "0"), repository.lastChoices)
        assertNull(repository.lastCustomAnswer)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `multiple custom answers are submitted independently`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(Approval(id = "q", sessionId = "s1", title = "Questions", kind = "question", runId = "r",
                questions = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second")))),
        )
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        viewModel.onEvent(AttentionEvent.ResolveQuestions(AttentionReducer.approvalItemId("s1", "q"),
            choices = listOf(-1, -1), customAnswers = listOf("alpha", "beta")))
        advanceUntilIdle()
        assertEquals(listOf("-1", "-1"), repository.lastChoices)
        assertEquals(listOf("alpha", "beta"), repository.lastCustomAnswers)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `multi-question answers use the selected computer repository`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "q", sessionId = "s1", title = "Questions", kind = "question", runId = "r",
                questions = listOf(ApprovalQuestion(question = "First"), ApprovalQuestion(question = "Second"))),
        ))
        val switching = SwitchingSessionRepository(CoroutineScope(dispatcher))
        switching.switchTo(repository)
        val viewModel = AttentionCenterViewModel(switching)
        advanceUntilIdle()
        viewModel.onEvent(AttentionEvent.ResolveQuestions(AttentionReducer.approvalItemId("s1", "q"),
            choices = listOf(-1, -1), customAnswers = listOf("first", "second")))
        advanceUntilIdle()
        assertEquals(listOf("first", "second"), repository.lastCustomAnswers)
    }

    @Test
    fun `privileged groups resolve independently with passkey for selected actions`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "privileged_batch_request", runId = "r", batchId = "b",
                passkeyRequired = true, actions = listOf(
                    ApprovalAction(id = "o", description = "Restart", category = "privileged_other"),
                    ApprovalAction(id = "d", description = "Delete", category = "destructive_delete"),
                )),
        ))
        val proof = WebAuthnProofDto("id", "raw", WebAuthnProofResponseDto("client", "auth", "sig"))
        val viewModel = AttentionCenterViewModel(repository, passkeyProvider = { proof })
        advanceUntilIdle()
        val id = AttentionReducer.approvalItemId("s1", "b")
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")))
        advanceUntilIdle()
        assertEquals(listOf("privileged_other" to listOf("o")), repository.privilegedCalls)
        assertEquals(1, repository.challengeCalls)
        assertEquals(proof, repository.lastProof)
        assertEquals("waiting_user", viewModel.state.value.items.single().approval?.actions?.single { it.id == "d" }?.state)
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "destructive_delete", emptySet()))
        advanceUntilIdle()
        assertEquals("destructive_delete" to emptyList(), repository.privilegedCalls.last())
        assertEquals(1, repository.challengeCalls)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `macOS unavailable executor prevents approval but permits denial`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "privileged_batch_request", runId = "r", batchId = "b",
                passkeyRequired = false, executorUnavailableReasonCode = "macos_administrator_unavailable",
                actions = listOf(ApprovalAction(id = "o", description = "Restart", category = "privileged_other"))),
        ))
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        val id = AttentionReducer.approvalItemId("s1", "b")
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")))
        advanceUntilIdle()
        assertTrue(repository.privilegedCalls.isEmpty())
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", emptySet()))
        advanceUntilIdle()
        assertEquals(listOf("privileged_other" to emptyList()), repository.privilegedCalls)
    }

    @Test
    fun `uncertain privileged submission stays locked until category is confirmed`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "privileged_batch_request", runId = "r", batchId = "b",
                passkeyRequired = false, actions = listOf(ApprovalAction(id = "o", description = "Restart", category = "privileged_other"))),
        ))
        repository.privilegedUncertain = true
        val viewModel = AttentionCenterViewModel(repository)
        runCurrent()
        val id = AttentionReducer.approvalItemId("s1", "b")
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")))
        runCurrent()
        assertEquals(id, viewModel.state.value.resolvingItemId)
        viewModel.onEvent(AttentionEvent.ResolvePrivilegedCategory(id, "privileged_other", setOf("o")))
        runCurrent()
        assertEquals(1, repository.privilegedCalls.size)
        repository.approvalState.value = emptyList()
        advanceTimeBy(2_000)
        runCurrent()
        assertNull(viewModel.state.value.resolvingItemId)
    }

    @Test
    fun `resolution failure keeps the item and surfaces an error`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(
            sessions = listOf(Session(id = "s1", title = "One")),
            approvals = listOf(approval("a1", "s1")),
        )
        repository.resolveError = IllegalStateException("network gone")
        val viewModel = AttentionCenterViewModel(repository)
        advanceUntilIdle()
        viewModel.onEvent(AttentionEvent.ResolveApproval(AttentionReducer.approvalItemId("s1", "a1"), approve = true))
        advanceUntilIdle()
        assertEquals("network gone", viewModel.state.value.error)
        assertEquals(1, viewModel.state.value.items.size)
        viewModel.onEvent(AttentionEvent.ClearError)
        advanceUntilIdle()
        assertNull(viewModel.state.value.error)
    }

    @Test
    fun `switching the active computer replaces the queue without mixing`() = runTest(dispatcher.scheduler) {
        val computerA = FakeRepository(
            sessions = listOf(Session(id = "a-s1", title = "A run")),
            approvals = listOf(approval("a1", "a-s1")),
        )
        val computerB = FakeRepository(
            sessions = listOf(Session(id = "b-s1", title = "B run")),
            approvals = listOf(approval("b1", "b-s1")),
        )
        val switching = SwitchingSessionRepository(CoroutineScope(dispatcher))
        switching.switchTo(computerA)
        val viewModel = AttentionCenterViewModel(switching)
        advanceUntilIdle()
        assertEquals(
            listOf(AttentionReducer.approvalItemId("a-s1", "a1")),
            viewModel.state.value.items.map { it.id },
        )
        switching.switchTo(computerB)
        advanceUntilIdle()
        assertEquals(
            listOf(AttentionReducer.approvalItemId("b-s1", "b1")),
            viewModel.state.value.items.map { it.id },
        )
        switching.switchTo(null)
        advanceUntilIdle()
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `approved action batch submits selected passkey proof and denies unselected actions`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "approved_action_batch_request", runId = "r", batchId = "b",
                actions = listOf(ApprovalAction(id = "a", needsPasskey = true), ApprovalAction(id = "b", needsPasskey = false))),
        ))
        val proof = WebAuthnProofDto("id", "raw", WebAuthnProofResponseDto("client", "auth", "sig"))
        val viewModel = AttentionCenterViewModel(repository, passkeyProvider = { proof })
        runCurrent()
        assertTrue(!viewModel.state.value.items.single().requiresSession)
        viewModel.onEvent(AttentionEvent.ResolveActionBatch(AttentionReducer.approvalItemId("s1", "b"), setOf("a")))
        runCurrent()
        assertEquals(listOf("a"), repository.actionChallengeIds)
        assertEquals(listOf(ApprovalActionDecision("a", "approve"), ApprovalActionDecision("b", "deny")), repository.actionDecisions)
        assertEquals(proof, repository.lastProof)
        assertTrue(viewModel.state.value.items.isEmpty())
    }

    @Test
    fun `uncertain approved action batch remains locked until confirmed`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "approved_action_batch_request", runId = "r", batchId = "b",
                actions = listOf(ApprovalAction(id = "a"))),
        ))
        repository.actionUncertain = true
        val viewModel = AttentionCenterViewModel(repository)
        runCurrent()
        val id = AttentionReducer.approvalItemId("s1", "b")
        viewModel.onEvent(AttentionEvent.ResolveActionBatch(id, setOf("a")))
        runCurrent()
        assertEquals(id, viewModel.state.value.resolvingItemId)
        viewModel.onEvent(AttentionEvent.ResolveActionBatch(id, setOf("a")))
        runCurrent()
        assertEquals(1, repository.actionCalls)
        repository.approvalState.value = emptyList()
        advanceTimeBy(2_000)
        runCurrent()
        assertNull(viewModel.state.value.resolvingItemId)
    }

    @Test
    fun `denying a passkey batch does not request a credential`() = runTest(dispatcher.scheduler) {
        val repository = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "approved_action_batch_request", runId = "r", batchId = "b",
                actions = listOf(ApprovalAction(id = "a", needsPasskey = true))),
        ))
        val viewModel = AttentionCenterViewModel(repository, passkeyProvider = { error("Unexpected credential request") })
        runCurrent()
        viewModel.onEvent(AttentionEvent.ResolveActionBatch(AttentionReducer.approvalItemId("s1", "b"), emptySet(), "deny"))
        runCurrent()
        assertEquals(listOf(ApprovalActionDecision("a", "deny")), repository.actionDecisions)
        assertNull(repository.lastProof)
        assertTrue(repository.actionChallengeIds.isEmpty())
    }

    @Test
    fun `switching computers while obtaining a credential cannot submit to either computer`() = runTest(dispatcher.scheduler) {
        val original = FakeRepository(sessions = listOf(Session(id = "s1", title = "One")), approvals = listOf(
            Approval(id = "b", sessionId = "s1", title = "Batch", kind = "approved_action_batch_request", runId = "r", batchId = "b",
                actions = listOf(ApprovalAction(id = "a", needsPasskey = true))),
        ))
        val other = FakeRepository()
        val switching = SwitchingSessionRepository(CoroutineScope(dispatcher)).apply { switchTo(original) }
        val proof = WebAuthnProofDto("id", "raw", WebAuthnProofResponseDto("client", "auth", "sig"))
        val viewModel = AttentionCenterViewModel(switching, passkeyProvider = { switching.switchTo(other); proof })
        runCurrent()
        viewModel.onEvent(AttentionEvent.ResolveActionBatch(AttentionReducer.approvalItemId("s1", "b"), setOf("a")))
        runCurrent()
        assertEquals(0, original.actionCalls)
        assertEquals(0, other.actionCalls)
    }

    private class FakeRepository(
        sessions: List<Session> = emptyList(),
        approvals: List<Approval> = emptyList(),
    ) : SessionRepository {
        val sessionState = MutableStateFlow(sessions)
        val approvalState = MutableStateFlow(approvals)
        var runtimeApprovalCalls = 0
        var lastDecision: String? = null
        var lastChoices: List<String> = emptyList()
        var lastCustomAnswer: String? = null
        var lastCustomAnswers: List<String> = emptyList()
        var resolveError: Throwable? = null
        var retiredApproval: Pair<String, String>? = null
        val privilegedCalls = mutableListOf<Pair<String, List<String>>>()
        var challengeCalls = 0
        var lastProof: WebAuthnProofDto? = null
        var privilegedUncertain = false
        var actionChallengeIds: List<String> = emptyList()
        var actionDecisions: List<ApprovalActionDecision> = emptyList()
        var actionCalls = 0
        var actionUncertain = false

        override val connectionState: StateFlow<RuntimeConnectionState> =
            MutableStateFlow(RuntimeConnectionState.Connected).asStateFlow()
        val invalidationEvents = MutableSharedFlow<SessionInvalidation>()
        override val invalidations: Flow<SessionInvalidation> = invalidationEvents
        val refreshedEvents = mutableListOf<String>()

        override fun observeComputers(): Flow<List<Computer>> = MutableStateFlow(emptyList())
        override fun observeProjects(): Flow<List<Project>> = MutableStateFlow(emptyList())
        override fun observeSessions(): Flow<List<Session>> = sessionState
        override fun observeSession(sessionId: String): Flow<Session?> =
            MutableStateFlow(sessionState.value.firstOrNull { it.id == sessionId })

        override fun observeMessages(sessionId: String): Flow<List<Message>> = MutableStateFlow(emptyList())
        override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = MutableStateFlow(emptyList())
        override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> =
            MutableStateFlow(approvalState.value.filter { it.sessionId == sessionId })

        override fun observeAllPendingApprovals(): Flow<List<Approval>> = approvalState

        override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? =
            approvalState.value.firstOrNull { it.sessionId == sessionId && it.id == approvalId }

        override suspend fun retireStaleApproval(sessionId: String, approvalId: String) {
            retiredApproval = sessionId to approvalId
            approvalState.value = approvalState.value.map {
                if (it.sessionId == sessionId && it.id == approvalId && it.status == "pending") it.copy(status = "resolved") else it
            }
        }

        override suspend fun createSession(name: String, tool: String): Session = Session("s-new", name)
        override suspend fun createProject(name: String, rootPath: String): Project = Project("p-new", name, rootPath)
        override suspend fun refreshComputers() = Unit
        override suspend fun refreshProjects() = Unit
        override suspend fun refreshSessions() = Unit
        override suspend fun refreshEvents(sessionId: String): RefreshResult {
            refreshedEvents += sessionId
            return RefreshResult.Applied(0, 0)
        }
        override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult =
            RefreshResult.Applied(events.size, 0)

        override suspend fun refreshSessionDetail(sessionId: String): Session? = null
        override suspend fun sendMessage(sessionId: String, text: String, requestId: String) = Unit
        override suspend fun cancelSession(sessionId: String) = Unit

        override suspend fun decideConfirmation(
            sessionId: String,
            confirmationId: String,
            decision: String,
            requestId: String,
        ) {
            resolveError?.let { throw it }
            runtimeApprovalCalls += 1
            lastDecision = decision
        }

        override suspend fun resolveRuntimeApproval(
            runId: String,
            approvalId: String,
            decision: String,
            choices: List<String>,
            customAnswer: String?,
            requestId: String,
        ) {
            resolveError?.let { throw it }
            runtimeApprovalCalls += 1
            lastDecision = decision
            lastChoices = choices
            lastCustomAnswer = customAnswer
        }

        override suspend fun resolveRuntimeApprovalWithAnswers(runId: String, approvalId: String, choices: List<String>, customAnswers: List<String>, requestId: String) {
            resolveError?.let { throw it }
            runtimeApprovalCalls += 1
            lastChoices = choices
            lastCustomAnswers = customAnswers
        }

        override suspend fun createApprovedActionWebAuthnChallenge(runId: String, batchId: String, selectedActionIds: List<String>, requestId: String): JsonObject {
            actionChallengeIds = selectedActionIds
            return buildJsonObject { }
        }

        override suspend fun resolveApprovedActionBatchWithProof(sessionId: String, runId: String, batchId: String,
            decisions: List<ApprovalActionDecision>, approvalIntent: String, webauthnProof: WebAuthnProofDto?, requestId: String) {
            actionCalls += 1
            actionDecisions = decisions
            lastProof = webauthnProof
            if (actionUncertain) error("connection lost after submission")
        }

        override suspend fun createPrivilegedCategoryWebAuthnChallenge(runId: String, batchId: String, category: String, checkedOpIds: List<String>, requestId: String): JsonObject {
            challengeCalls += 1
            return buildJsonObject { }
        }

        override suspend fun resolvePrivilegedCategory(sessionId: String, runId: String, batchId: String, category: String,
            checkedOpIds: List<String>, webauthnProof: WebAuthnProofDto?, requestId: String) {
            privilegedCalls += category to checkedOpIds
            lastProof = webauthnProof
            if (privilegedUncertain) error("connection lost after submission")
            val changed = approvalState.value.map { approval -> approval.copy(actions = approval.actions.map {
                if (it.category == category) it.copy(state = if (it.id in checkedOpIds) "approved" else "denied") else it
            }) }
            approvalState.value = changed.filter { approval -> approval.actions.any { it.state == "waiting_user" } }
        }

        override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) = Unit
        override suspend fun resolveApprovedActions(
            sessionId: String,
            runId: String,
            batchId: String,
            approve: Boolean,
            requestId: String,
        ) = Unit

        override suspend fun resumePendingOperations(): Int = 0
    }

    private class FakeBrokerApprovalController(
        approvals: List<Approval>,
    ) : BrokerApprovalController {
        val decisions = mutableListOf<Pair<String, Boolean>>()
        val approvalState = MutableStateFlow(approvals)
        var attempts = 0
        var resolveError: Throwable? = null

        override fun observePendingApprovals(): Flow<List<Approval>> = approvalState

        override suspend fun resolve(approval: Approval, approve: Boolean) {
            attempts++
            resolveError?.let { throw it }
            decisions += approval.id to approve
        }
    }
}
