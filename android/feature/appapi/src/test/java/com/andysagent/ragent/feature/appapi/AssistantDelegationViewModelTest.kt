package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class AssistantDelegationViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private class Port : AssistantDelegationPort {
        val approved = mutableListOf<AssistantDelegationScope>()
        var gate: CompletableDeferred<Unit>? = null
        var failure: Exception? = null
        var reviews = 0
        override suspend fun review(): AssistantDelegationReview {
            reviews++; return AssistantDelegationReview(CallerGrantContext("account", setOf("pc-b")), mapOf("pc-b" to "Home"), emptyList(), 100)
        }
        override suspend fun approve(review: AssistantDelegationReview, scope: AssistantDelegationScope) {
            approved += scope; gate?.await(); failure?.let { throw it }
        }
        override suspend fun revoke(row: AssistantDelegation) = error("No records selected")
        override suspend fun deleteRevoked(row: AssistantDelegation) = error("No records selected")
        override fun now() = 1000L
    }
    private fun select(model: AssistantDelegationViewModel) {
        model.onEvent(AssistantDelegationEvent.Capability(CapabilityRegistry.TASKS_PREPARE, true))
        model.onEvent(AssistantDelegationEvent.Target("pc-b", true))
    }
    @Test fun openingAndReloadingNeverInferSelectionOrConsent() = runTest(dispatcher) {
        val port = Port(); val model = AssistantDelegationViewModel(port); runCurrent()
        assertFalse(model.state.value.canApprove); assertTrue(model.state.value.targets.isEmpty())
        assertTrue(model.state.value.capabilities.isEmpty()); assertFalse(model.state.value.acknowledgedGroup)
        model.onEvent(AssistantDelegationEvent.Approve); runCurrent(); assertTrue(port.approved.isEmpty())
        select(model); model.onEvent(AssistantDelegationEvent.Acknowledge(true))
        assertTrue(model.state.value.canApprove)
        model.onEvent(AssistantDelegationEvent.Refresh); runCurrent()
        assertFalse(model.state.value.canApprove); assertTrue(port.approved.isEmpty())
    }
    @Test fun groupAcknowledgementIsRequiredAfterExplicitSelection() = runTest(dispatcher) {
        val port = Port(); val model = AssistantDelegationViewModel(port); runCurrent(); select(model)
        model.onEvent(AssistantDelegationEvent.Approve); runCurrent(); assertTrue(port.approved.isEmpty())
        model.onEvent(AssistantDelegationEvent.Acknowledge(true)); model.onEvent(AssistantDelegationEvent.Approve); runCurrent()
        assertEquals(1, port.approved.size); assertEquals(setOf("pc-b"), port.approved.single().targetIds)
        assertFalse(port.approved.single().mayCreateSessions)
    }
    @Test fun doubleTapAndConcurrentEditsCannotWidenFrozenConsent() = runTest(dispatcher) {
        val port = Port(); port.gate = CompletableDeferred()
        val model = AssistantDelegationViewModel(port); runCurrent(); select(model)
        model.onEvent(AssistantDelegationEvent.Acknowledge(true)); model.onEvent(AssistantDelegationEvent.Approve)
        model.onEvent(AssistantDelegationEvent.Creation(true)); model.onEvent(AssistantDelegationEvent.Approve); runCurrent()
        assertEquals(1, port.approved.size); assertFalse(port.approved.single().mayCreateSessions); assertTrue(model.state.value.busy)
        port.gate!!.complete(Unit); runCurrent()
        assertFalse(model.state.value.busy); assertFalse(model.state.value.canApprove)
    }
    @Test fun exactProjectSessionRestrictionsAndLifetimeArePreserved() = runTest(dispatcher) {
        val port = Port(); val model = AssistantDelegationViewModel(port); runCurrent(); select(model)
        model.onEvent(AssistantDelegationEvent.Sessions(" session-a,session-b\nsession-a "))
        model.onEvent(AssistantDelegationEvent.Projects(" project-a "))
        model.onEvent(AssistantDelegationEvent.Creation(true)); model.onEvent(AssistantDelegationEvent.Lifetime(86_400_000))
        model.onEvent(AssistantDelegationEvent.Acknowledge(true)); model.onEvent(AssistantDelegationEvent.Approve); runCurrent()
        val scope = port.approved.single()
        assertEquals(setOf("session-a", "session-b"), scope.sessionIds); assertEquals(setOf("project-a"), scope.projectIds)
        assertEquals(86_401_000L, scope.expiresAt); assertTrue(scope.mayCreateSessions)
    }
    @Test fun emptyCommaElementDoesNotBecomeUnrestrictedAccess() = runTest(dispatcher) {
        val port = Port(); val model = AssistantDelegationViewModel(port); runCurrent(); select(model)
        model.onEvent(AssistantDelegationEvent.Projects("project-a,")); model.onEvent(AssistantDelegationEvent.Acknowledge(true))
        model.onEvent(AssistantDelegationEvent.Approve); runCurrent()
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, model.state.value.error); assertTrue(port.approved.isEmpty())
    }
    @Test fun changedReviewFailureRequiresFreshReviewAndDoesNotAutomaticallyRetry() = runTest(dispatcher) {
        val port = Port(); port.failure = AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Account changed"))
        val model = AssistantDelegationViewModel(port); runCurrent(); select(model)
        model.onEvent(AssistantDelegationEvent.Acknowledge(true)); model.onEvent(AssistantDelegationEvent.Approve); runCurrent()
        assertEquals(ApiErrorCode.REVISION_CONFLICT, model.state.value.error)
        model.onEvent(AssistantDelegationEvent.Approve); runCurrent(); assertEquals(1, port.approved.size)
        model.onEvent(AssistantDelegationEvent.Refresh); runCurrent(); assertFalse(model.state.value.canApprove)
    }
    @Test fun unknownTargetCapabilityAndLifetimeCannotEnterConsent() = runTest(dispatcher) {
        val model = AssistantDelegationViewModel(Port()); runCurrent()
        model.onEvent(AssistantDelegationEvent.Target("pc-a", true)); model.onEvent(AssistantDelegationEvent.Capability("all", true))
        model.onEvent(AssistantDelegationEvent.Lifetime(Long.MAX_VALUE))
        assertTrue(model.state.value.targets.isEmpty()); assertTrue(model.state.value.capabilities.isEmpty())
        assertEquals(3_600_000L, model.state.value.lifetimeMs)
    }
}
