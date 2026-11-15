package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class CallerAuthorizationViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private val identity = InstalledCallerIdentity("example.agent", 10011, 1, setOf("a".repeat(64)))
    private val request = CallerConsentRequest(setOf(CapabilityRegistry.TARGETS_LIST, CapabilityRegistry.TASKS_COMMIT), setOf("pc-a", "pc-b"), mayCreateSessions = true)
    private val review = CallerConsentReview(identity, "Agent", request, mapOf("pc-a" to "Office", "pc-b" to "Home"), CallerGrantContext("account-a", request.targetIds), 1)
    private inner class Consent : CallerConsentPort {
        var writes = 0
        var gate: CompletableDeferred<Unit>? = null
        var error: ApiErrorCode? = null
        var approved: CallerGrant? = null
        override suspend fun review() = review
        override suspend fun approve(review: CallerConsentReview, capabilities: Set<String>, targets: Set<String>, createSessions: Boolean, durationMs: Long): CallerConsentReceipt {
            writes++; gate?.await()
            error?.let { throw AppApiException(ApiError(it, "test")) }
            val grant = review.request.narrow(review.identity, capabilities, targets, createSessions, durationMs, 100)
            approved = grant
            return CallerConsentReceipt("grant", grant.capabilityIds, grant.targetIds, grant.expiresAt, grant.sessionIds, grant.projectIds, grant.mayCreateSessions)
        }
    }
    private fun select(model: CallerConsentViewModel) {
        model.onEvent(CallerConsentEvent.Capability(CapabilityRegistry.TARGETS_LIST, true))
        model.onEvent(CallerConsentEvent.Target("pc-b", true))
    }
    @Test fun openingAndRecreatingNeverGrantsAndNothingIsPreselected() = runTest(dispatcher) {
        val port = Consent(); val model = CallerConsentViewModel(port); runCurrent()
        assertFalse(model.state.value.canApprove)
        model.onEvent(CallerConsentEvent.Approve); runCurrent(); assertEquals(0, port.writes)
        select(model); assertTrue(model.state.value.canApprove)
        CallerConsentViewModel(port); runCurrent(); assertEquals(0, port.writes)
    }
    @Test fun duplicateTapCannotWidenOrRepeatApprovedSelection() = runTest(dispatcher) {
        val port = Consent(); val model = CallerConsentViewModel(port); runCurrent(); select(model)
        model.onEvent(CallerConsentEvent.Target("unrequested", true))
        model.onEvent(CallerConsentEvent.Capability("unknown", true))
        port.gate = CompletableDeferred()
        model.onEvent(CallerConsentEvent.Approve)
        model.onEvent(CallerConsentEvent.Target("pc-a", true)); model.onEvent(CallerConsentEvent.Approve)
        runCurrent(); assertEquals(1, port.writes)
        port.gate!!.complete(Unit); runCurrent()
        assertEquals(setOf("pc-b"), port.approved!!.targetIds)
        assertEquals(setOf(CapabilityRegistry.TARGETS_LIST), port.approved!!.capabilityIds)
        assertFalse(port.approved!!.mayCreateSessions)
        assertNotNull(model.state.value.receipt)
        model.onEvent(CallerConsentEvent.Approve); runCurrent(); assertEquals(1, port.writes)
    }
    @Test fun staleReviewRequiresReloadAndNewSelectionBeforeRetry() = runTest(dispatcher) {
        val port = Consent(); val model = CallerConsentViewModel(port); runCurrent(); select(model)
        port.error = ApiErrorCode.REVISION_CONFLICT
        model.onEvent(CallerConsentEvent.Approve); runCurrent()
        assertEquals(ApiErrorCode.REVISION_CONFLICT, model.state.value.error)
        model.onEvent(CallerConsentEvent.Approve); runCurrent(); assertEquals(1, port.writes)
        port.error = null; model.onEvent(CallerConsentEvent.Reload); runCurrent()
        assertFalse(model.state.value.canApprove)
        select(model); model.onEvent(CallerConsentEvent.Approve); runCurrent(); assertEquals(2, port.writes)
    }
    @Test fun managementRevokesExactRevisionAndClearsOnlyRevokedRecords() = runTest(dispatcher) {
        val grant = request.narrow(identity, request.capabilityIds, request.targetIds, true, 1000, 100)
        var row = PersistedCallerGrant("grant", identity, grant, "context", 100, 100)
        var deletes = 0; val revocations = mutableListOf<Long>(); var gate: CompletableDeferred<Unit>? = CompletableDeferred()
        val port = object : CallerGrantManagementPort {
            override suspend fun list() = if (deletes == 0) listOf(row) else emptyList()
            override suspend fun revoke(grant: PersistedCallerGrant) { revocations += grant.revision; gate?.await(); row = row.copy(revision = 1, revokedAt = 200, updatedAt = 200) }
            override suspend fun deleteRevoked(grant: PersistedCallerGrant) { assertEquals(1L, grant.revision); deletes++ }
        }
        val model = CallerGrantsViewModel(port); runCurrent()
        model.onEvent(CallerGrantsEvent.DeleteRevoked("grant")); runCurrent(); assertEquals(0, deletes)
        model.onEvent(CallerGrantsEvent.Revoke("grant")); model.onEvent(CallerGrantsEvent.Revoke("grant")); runCurrent()
        assertEquals(listOf(0L), revocations); gate!!.complete(Unit); runCurrent()
        assertNotNull(model.state.value.grants.single().revokedAt)
        model.onEvent(CallerGrantsEvent.DeleteRevoked("grant")); runCurrent(); assertTrue(model.state.value.grants.isEmpty())
    }
    @Test fun corruptManagementReadIsAnErrorAndDoesNotMasqueradeAsHealthyEmptyState() = runTest(dispatcher) {
        val port = object : CallerGrantManagementPort {
            override suspend fun list(): List<PersistedCallerGrant> = throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "corrupt"))
            override suspend fun revoke(grant: PersistedCallerGrant) = error("must not write")
            override suspend fun deleteRevoked(grant: PersistedCallerGrant) = error("must not write")
        }
        val model = CallerGrantsViewModel(port); runCurrent()
        assertEquals(ApiErrorCode.PERMISSION_DENIED, model.state.value.error); assertFalse(model.state.value.loading)
    }
    @Test fun ownerChoiceIsRestrictedToTheTrustedPairedSnapshotWhenClientKnowsNoIds() = runTest(dispatcher) {
        val original = Consent()
        val port = object : CallerConsentPort by original {
            override suspend fun review() = review.copy(request = request.copy(targetIds = emptySet()))
        }
        val model = CallerConsentViewModel(port); runCurrent()
        model.onEvent(CallerConsentEvent.Target("unknown", true)); assertTrue(model.state.value.targets.isEmpty())
        select(model); model.onEvent(CallerConsentEvent.Approve); runCurrent()
        assertEquals(setOf("pc-b"), original.approved!!.targetIds)
    }
}
