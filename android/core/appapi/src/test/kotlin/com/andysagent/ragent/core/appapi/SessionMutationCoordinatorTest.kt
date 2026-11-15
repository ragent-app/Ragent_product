package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class SessionMutationCoordinatorTest {
    private val caller = VerifiedCaller("foreign-installation")
    private val revision = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    private val scope = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    private val acknowledged = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    private val moved = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    private val request = SessionMutationRequest("op", "pc", "session", SessionMutationKind.RENAME, title = "Title")
    private class Store : SessionMutationStore {
        val rows = mutableMapOf<Pair<String, String>, SessionMutationOperation>()
        var failInsert = false
        var failReplace = false
        override suspend fun get(callerBinding: String, operationId: String) = rows[callerBinding to operationId]
        override suspend fun insert(operation: SessionMutationOperation): Boolean {
            if (failInsert) error("disk failed")
            val key = operation.callerBinding to operation.request.operationId
            if (key in rows) return false
            rows[key] = operation; return true
        }
        override suspend fun replace(operation: SessionMutationOperation, expectedRevision: Long): Boolean {
            if (failReplace) error("disk failed")
            val key = operation.callerBinding to operation.request.operationId
            if (rows[key]?.revision != expectedRevision) return false
            check(operation.samePreparation(rows.getValue(key)))
            rows[key] = operation; return true
        }
    }
    private inner class Fixture {
        val store = Store()
        var time = 1000L
        var paired = true
        var grants = listOf(CallerGrant(caller.binding,
            setOf(SessionMutationCapabilities.PREPARE, SessionMutationCapabilities.GET,
                SessionMutationCapabilities.RECONCILE, SessionMutationCapabilities.CANCEL) +
                SessionMutationKind.entries.map(SessionMutationCapabilities::effect),
            setOf("pc"), 10_000_000, sessionIds = setOf("session"), projectIds = setOf("project")))
        var actual = SessionMutationContext(1, "session", "project", revision, scope, "Before", false, false, false, null, 64)
        var protocolSupported = true
        var protocolCalls = 0
        var reads = 0
        var posts = 0
        var effects = 0
        var lookups = 0
        var receipt: SessionMutationReceipt? = null
        var onContext: suspend () -> Unit = {}
        var onProtocol: suspend () -> Unit = {}
        var onApplied: suspend () -> Unit = {}
        var captured: SessionMutationCommand? = null
        val target = object : SessionMutationTarget {
            override suspend fun protocol(): SessionMutationProtocol {
                protocolCalls++; onProtocol()
                return SessionMutationProtocol(1, if (protocolSupported) SessionMutationKind.entries else emptyList(),
                    8192, 200, 256, 256, 64, true, "/api/sessions/{sessionId}/app-api-context",
                    "/api/sessions/{sessionId}/app-api-mutations", "/api/sessions/{sessionId}/app-api-mutations/{requestId}")
            }
            override suspend fun context(sessionId: String): SessionMutationContext { reads++; assertEquals("session", sessionId); onContext(); return actual }
            override suspend fun receipt(sessionId: String, requestId: String): SessionMutationReceipt? {
                lookups++; assertEquals("session", sessionId); assertEquals(captured?.requestId, requestId)
                return receipt
            }
            override suspend fun apply(sessionId: String, command: SessionMutationCommand): SessionMutationReceipt {
                posts++; captured = command
                assertEquals(SessionMutationStage.SUBMITTING, store.rows.values.single().stage)
                if (receipt != null) return receipt!!.copy(duplicate = true)
                assertEquals(actual.revision, command.expectedRevision); assertEquals(actual.scopeRevision, command.expectedScopeRevision)
                effects++; actual = actual.copy(revision = acknowledged)
                receipt = SessionMutationReceipt(1, command.requestId, sessionId, command.kind, true,
                    acknowledged, scope, "2026-10-11T00:00:00Z", actual.projectId, false)
                onApplied(); return receipt!!
            }
        }
        fun api() = SessionMutationCoordinator(store,
            { TargetDirectorySnapshot(if (paired) listOf(ApiTarget("pc", "Computer")) else emptyList()) },
            GrantAuthorizer("owner", { grants }, { time }), object : TargetSessionMutationAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (SessionMutationTarget) -> T): T {
                    assertEquals("pc", instanceId); return block(target)
                }
            }, { time })
    }
    private suspend fun denied(code: ApiErrorCode, block: suspend () -> Any?) {
        assertEquals(code, assertFailsWith<AppApiException> { block() }.error.code)
    }
    @Test fun preparationFreezesActualScopeWithoutStartingWork() = runTest {
        val f = Fixture(); val operation = f.api().prepare(request, caller)
        assertEquals(revision, operation.command.expectedRevision); assertEquals(scope, operation.command.expectedScopeRevision)
        assertEquals("project", operation.command.expectedProjectId); assertEquals(0, f.posts)
        assertEquals(SessionMutationStage.PREPARED, operation.stage)
        assertEquals(operation, f.api().prepare(request, caller))
    }
    @Test fun changedInputCannotReplaceOriginalPreparation() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        denied(ApiErrorCode.REVISION_CONFLICT) { api.prepare(request.copy(title = "Different"), caller) }
        denied(ApiErrorCode.REVISION_CONFLICT) { api.prepare(request.copy(deadlineAt = 10_000), caller) }
        assertEquals(revision, f.store.rows.values.single().command.expectedRevision)
    }
    @Test fun guessedOperationAndSameIdFromAnotherCallerAreIsolated() = runTest {
        val f = Fixture(); val api = f.api(); val original = api.prepare(request, caller)
        val other = VerifiedCaller("other-installation")
        denied(ApiErrorCode.RESOURCE_NOT_FOUND) { api.get("op", other) }
        f.grants += f.grants.single().copy(callerBinding = other.binding)
        val second = api.prepare(request, other)
        assertNotEquals(original.command.requestId, second.command.requestId); assertEquals(2, f.store.rows.size)
    }
    @Test fun twoGrantRecordsCannotJoinSessionAndProjectPrivileges() = runTest {
        val f = Fixture(); val grant = f.grants.single()
        f.grants = listOf(grant.copy(sessionIds = setOf("session"), projectIds = setOf("other")),
            grant.copy(sessionIds = setOf("other"), projectIds = setOf("project")))
        denied(ApiErrorCode.PERMISSION_DENIED) { f.api().prepare(request, caller) }
        assertTrue(f.store.rows.isEmpty()); assertEquals(0, f.posts)
    }
    @Test fun noGrantOrWrongComputerDoesNotReadPc() = runTest {
        val f = Fixture(); f.grants = emptyList()
        denied(ApiErrorCode.PERMISSION_DENIED) { f.api().prepare(request, caller) }
        denied(ApiErrorCode.TARGET_NOT_FOUND) { f.api().prepare(request.copy(targetInstanceId = "ui-current"), caller) }
        assertEquals(0, f.reads); assertEquals(0, f.protocolCalls)
    }
    @Test fun projectClaimsAndUnsupportedProtocolFailClosed() = runTest {
        val f = Fixture()
        denied(ApiErrorCode.PERMISSION_DENIED) { f.api().prepare(request.copy(projectId = "other"), caller) }
        f.protocolSupported = false
        denied(ApiErrorCode.CAPABILITY_UNSUPPORTED) { f.api().prepare(request, caller) }
        assertTrue(f.store.rows.isEmpty()); assertEquals(0, f.posts)
    }
    @Test fun knownSuccessIsDurableAndRepeatedCommitDoesNotPost() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        val operation = api.commit("op", caller)
        assertEquals(SessionMutationStage.APPLIED, operation.stage)
        assertEquals(acknowledged, operation.receipt!!.revision)
        assertEquals(operation, f.api().commit("op", caller)); assertEquals(1, f.effects); assertEquals(1, f.posts)
    }
    @Test fun responseLostAfterAcceptanceColdCoordinatorRecoversBeforeRevisionComparison() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        f.onApplied = { apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Lost response") }
        denied(ApiErrorCode.RESULT_UNKNOWN) { api.commit("op", caller) }
        assertEquals(SessionMutationStage.SUBMITTING, f.store.rows.values.single().stage)
        val recovered = f.api().commit("op", caller)
        assertEquals(SessionMutationStage.APPLIED, recovered.stage); assertEquals(1, f.lookups)
        assertEquals(1, f.posts); assertEquals(1, f.effects)
    }
    @Test fun reconcileNeverDispatchesAndCanRecoverAfterDeadline() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request.copy(deadlineAt = 1100), caller)
        f.onApplied = { throw CancellationException("Client died") }
        assertFailsWith<CancellationException> { api.commit("op", caller) }
        f.time = 1200
        val recovered = f.api().reconcile("op", caller)
        assertEquals(SessionMutationStage.APPLIED, recovered.stage); assertEquals(1, f.posts)
        assertEquals(1, f.effects)
    }
    @Test fun noReceiptReconcileAndExpiredRetryNeverPost() = runTest {
        val f = Fixture(); val api = f.api(); val operation = api.prepare(request.copy(deadlineAt = 1100), caller)
        f.store.rows[caller.binding to "op"] = operation.copy(stage = SessionMutationStage.SUBMITTING, revision = 2)
        f.captured = operation.command
        assertEquals(SessionMutationStage.SUBMITTING, f.api().reconcile("op", caller).stage)
        f.time = 1200
        denied(ApiErrorCode.REQUEST_EXPIRED) { f.api().commit("op", caller) }
        assertEquals(0, f.posts)
    }
    @Test fun savedScopeMoveAndReturnBlocksReplayEvenWithBroadGrant() = runTest {
        val f = Fixture(); f.grants = listOf(f.grants.single().copy(projectIds = null))
        val api = f.api(); api.prepare(request, caller)
        f.actual = f.actual.copy(scopeRevision = moved) // PC already observed A -> B -> A.
        denied(ApiErrorCode.REVISION_CONFLICT) { api.commit("op", caller) }
        denied(ApiErrorCode.REVISION_CONFLICT) { api.get("op", caller) }
        denied(ApiErrorCode.REVISION_CONFLICT) { api.reconcile("op", caller) }
        assertEquals(0, f.posts)
    }
    @Test fun changedMetadataDoesNotAcquireNewRevisions() = runTest {
        val f = Fixture(); val api = f.api(); val operation = api.prepare(request, caller)
        f.actual = f.actual.copy(revision = acknowledged)
        denied(ApiErrorCode.REVISION_CONFLICT) { api.commit("op", caller) }
        assertEquals(SessionMutationStage.CONFLICT, f.store.rows.values.single().stage)
        assertEquals(operation.command, f.store.rows.values.single().command); assertEquals(0, f.posts)
    }
    @Test fun grantRevokedDuringApplyWithholdsDeliveryButRetainsAcceptedFact() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        val grants = f.grants; f.onApplied = { f.grants = emptyList() }
        denied(ApiErrorCode.PERMISSION_DENIED) { api.commit("op", caller) }
        assertEquals(SessionMutationStage.APPLIED, f.store.rows.values.single().stage)
        denied(ApiErrorCode.PERMISSION_DENIED) { api.get("op", caller) }
        f.grants = grants
        assertEquals(SessionMutationStage.APPLIED, api.get("op", caller).stage); assertEquals(1, f.posts)
    }
    @Test fun corruptReceiptIsUnknownAndCannotPublishSuccess() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        f.onApplied = { f.receipt = f.receipt!!.copy(requestId = "someone-else") }
        denied(ApiErrorCode.RESULT_UNKNOWN) { api.commit("op", caller) }
        assertEquals(SessionMutationStage.SUBMITTING, f.store.rows.values.single().stage)
        denied(ApiErrorCode.RESULT_UNKNOWN) { api.reconcile("op", caller) }; assertEquals(1, f.posts)
    }
    @Test fun cancellationOnlyCancelsUndispatchedPreparation() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        assertEquals(SessionMutationStage.CANCELLED, api.cancel("op", caller).stage)
        denied(ApiErrorCode.CANCELLED) { api.commit("op", caller) }; assertEquals(0, f.posts)
        val g = Fixture(); g.api().prepare(request, caller); g.api().commit("op", caller)
        denied(ApiErrorCode.REVISION_CONFLICT) { g.api().cancel("op", caller) }; assertEquals(1, g.effects)
    }
    @Test fun expiredPreparationAndReceiptQuotaAreExplicit() = runTest {
        val f = Fixture()
        denied(ApiErrorCode.REQUEST_EXPIRED) { f.api().prepare(request.copy(deadlineAt = 1000), caller) }
        denied(ApiErrorCode.INVALID_ARGUMENT) { f.api().prepare(request.copy(deadlineAt = 3_601_001), caller) }
        f.actual = f.actual.copy(remainingMutationReceipts = 0)
        denied(ApiErrorCode.RATE_LIMITED) { f.api().prepare(request, caller) }; assertTrue(f.store.rows.isEmpty())
    }
    @Test fun diskFailureBeforeSubmittingPreventsPcEffect() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller); f.store.failReplace = true
        assertFailsWith<IllegalStateException> { api.commit("op", caller) }; assertEquals(0, f.posts)
        assertEquals(SessionMutationStage.PREPARED, f.store.rows.values.single().stage)
    }
    @Test fun concurrentCommitCannotProduceSecondEffect() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller); f.onApplied = { delay(10) }
        val a = async { api.commit("op", caller) }; val b = async { api.commit("op", caller) }
        assertEquals(a.await(), b.await()); assertEquals(1, f.posts); assertEquals(1, f.effects)
    }
    @Test fun allFourMetadataActionsUseTypedImmutableValues() = runTest {
        for (kind in SessionMutationKind.entries) {
            val f = Fixture(); val action = request.copy(kind = kind,
                title = if (kind == SessionMutationKind.RENAME) "Title" else null,
                flag = if (kind == SessionMutationKind.RENAME) null else false)
            val api = f.api(); val operation = api.prepare(action, caller); api.commit("op", caller)
            assertEquals(kind, f.captured!!.kind); assertEquals(operation.command, f.captured)
        }
        denied(ApiErrorCode.INVALID_ARGUMENT) { Fixture().api().prepare(request.copy(flag = true), caller) }
        denied(ApiErrorCode.INVALID_ARGUMENT) { Fixture().api().prepare(request.copy(title = "bad\nvalue"), caller) }
    }
    @Test fun wrongEffectCapabilityCannotCommitAnotherMetadataKind() = runTest {
        val f = Fixture(); val api = f.api(); api.prepare(request, caller)
        denied(ApiErrorCode.INVALID_ARGUMENT) { api.commit("op", caller, SessionMutationKind.SET_ARCHIVED) }
        assertEquals(0, f.posts); assertEquals(SessionMutationStage.PREPARED, f.store.rows.values.single().stage)
    }
}
