package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import kotlinx.coroutines.test.runTest
import java.io.IOException
import kotlinx.serialization.encodeToString
import kotlin.test.*

class AssistantTaskBridgeTest {
    private val id = "12345678-1234-1234-1234-123456789abc"
    private val secondId = "12345678-1234-1234-1234-123456789abd"
    private class MemoryOperations : OperationStore {
        val rows = mutableMapOf<String, TaskOperation>()
        override suspend fun get(operationId: String) = rows[operationId]
        override suspend fun getByPreparation(preparationId: String) = rows.values.firstOrNull { it.preparationId == preparationId }
        override suspend fun insert(operation: TaskOperation): Boolean = if (operation.operationId in rows) false else {
            rows[operation.operationId] = operation; true
        }
        override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
            if (rows[operation.operationId]?.revision != expectedRevision) return false
            rows[operation.operationId] = operation; return true
        }
    }
    private inner class Fixture {
        val operations = MemoryOperations()
        var rows = listOf(AssistantDelegation(id, AssistantDelegationScope(AssistantTaskCapabilities.ids,
            setOf("pc-b"), 100_000, mayCreateSessions = true), "account", 1000, 1000))
        var afterDirectory: () -> Unit = {}
        var afterSubmit: () -> Unit = {}
        var loseResponse = false
        var submits = 0
        var lookups = 0
        var projectId: String? = null
        var acquired = mutableListOf<String>()
        val policy = object : AssistantDelegationAccess {
            override suspend fun activeDelegations() = rows.filter { it.revokedAt == null }
            override suspend fun requireActive(id: String) = activeDelegations().firstOrNull { it.id == id }
                ?: throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "No delegation"))
        }
        val authorizer = GrantAuthorizer("owner", { policy.activeDelegations().map { it.grant() } }, { 1000 })
        val pc = object : ScopedFixtureTaskTarget() {
            override suspend fun sessionContext(sessionId: String) = TaskSessionContext(sessionId, projectId)
            var receipt: MessageSubmissionReceipt? = null
            override suspend fun createSession(operation: TaskOperation) = "created-session"
            override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt {
                submits++
                val result = MessageSubmissionReceipt(sessionId, operation.messageRequestId, false, false, "run-1")
                receipt = result; afterSubmit()
                if (loseResponse) throw IOException("Accepted but response lost")
                return result
            }
            override suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt? {
                lookups++; return receipt
            }
            override suspend fun readResult(operation: TaskOperation) = TaskResultSnapshot(operation.sessionId!!,
                operation.messageRequestId, operation.runId, operation.runId, TaskResultState.READY, "Synthetic exact result", false,
                emptyList(), "2026-10-12T00:00:00Z")
        }
        fun coordinator() = TaskCoordinator(operations, {
            afterDirectory()
            TargetDirectorySnapshot(listOf(ApiTarget("pc-a", "Office"), ApiTarget("pc-b", "Home")), "pc-a")
        }, authorizer, object : TargetTaskAccess {
            override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                acquired += instanceId; return block(pc)
            }
        }, now = { 1000 })
        fun bridge() = AssistantTaskBridge(policy, coordinator())
        fun request(key: String = "request-1") = TaskRequest(key, "Analyze this report", TaskRuntime("codex"),
            targetInstanceId = "pc-b", deadlineAt = 10_000)
        fun revoke() { rows = rows.map { it.copy(revokedAt = 1001, updatedAt = 1001, revision = 1) } }
    }
    private suspend fun denied(action: suspend () -> Unit) {
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { action() }.error.code)
    }
    @Test fun emptyPolicyDoesNotInheritOwnerOrDefaultComputer() = runTest {
        val f = Fixture(); f.rows = emptyList()
        assertTrue(f.bridge().listComputers().items.isEmpty())
        denied { f.bridge().prepare(id, f.request()) }
        assertTrue(f.operations.rows.isEmpty()); assertTrue(f.acquired.isEmpty())
    }
    @Test fun explicitComputerIgnoresUiDefaultAndPreparationDoesNotDispatch() = runTest {
        val f = Fixture(); val bridge = f.bridge()
        assertEquals(listOf(AssistantComputer(id, "pc-b", "Home")), bridge.listComputers().items)
        val p = bridge.prepare(id, f.request())
        assertEquals("pc-b", p.targetInstanceId); assertTrue(f.acquired.isEmpty())
        assertEquals(p, bridge.prepare(id, f.request()))
        val committed = bridge.commit(id, p.preparationId)
        assertEquals("ACCEPTED", committed.submissionStage); assertTrue(committed.runId!!.startsWith("run_appapi_"))
        assertTrue(f.acquired.isNotEmpty() && f.acquired.all { it == "pc-b" }); assertEquals(1, f.submits)
    }

    @Test fun inferredProjectDeliveryUsesDelegatedPrepareAndCommitWithoutGetPermission() = runTest {
        val f = Fixture(); f.projectId = "project-b"
        f.rows = f.rows.map { it.copy(scope = it.scope.copy(
            capabilityIds = setOf(CapabilityRegistry.TASKS_PREPARE, CapabilityRegistry.TASKS_COMMIT),
            sessionIds = setOf("existing"), projectIds = setOf("project-b"), mayCreateSessions = false)) }
        val bridge = f.bridge()
        val p = bridge.prepare(id, f.request().copy(existingSessionId = "existing"))
        val accepted = bridge.commit(id, p.preparationId)
        assertEquals("ACCEPTED", accepted.submissionStage); assertEquals("existing", accepted.sessionId)
        assertNull(f.operations.rows.values.single().request.projectId)
        assertEquals("project-b", f.operations.rows.values.single().originalScope!!.expectedProjectId)
        denied { bridge.get(id, p.operationId) }
        assertEquals(1, f.submits); assertTrue(f.acquired.all { it == "pc-b" })
    }
    @Test fun absentExplicitTargetAliasAndDeferredPolicyAreRejected() = runTest {
        val f = Fixture()
        listOf(f.request().copy(targetInstanceId = null), f.request().copy(targetAlias = "Home"),
            f.request().copy(allowDeferredSubmission = true)).forEach { input ->
            assertEquals(ApiErrorCode.INVALID_ARGUMENT, assertFailsWith<AppApiException> { f.bridge().prepare(id, input) }.error.code)
        }
        assertTrue(f.operations.rows.isEmpty())
    }
    @Test fun targetAndCapabilityGrantsCannotBeJoinedOrBypassed() = runTest {
        val f = Fixture(); val bridge = f.bridge()
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> {
            bridge.prepare(id, f.request().copy(targetInstanceId = "pc-a"))
        }.error.code)
        f.rows = f.rows.map { it.copy(scope = it.scope.copy(capabilityIds = setOf(CapabilityRegistry.TARGETS_LIST))) }
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> { bridge.prepare(id, f.request()) }.error.code)
        assertTrue(f.operations.rows.isEmpty())
    }
    @Test fun reconsentCannotReadOrCommitOldTasksAndSameRequestIdsAreIsolated() = runTest {
        val f = Fixture(); val bridge = f.bridge(); val old = bridge.prepare(id, f.request())
        f.rows = f.rows.map { it.copy(id = secondId) }
        val fresh = bridge.prepare(secondId, f.request())
        assertNotEquals(old.operationId, fresh.operationId)
        denied { bridge.get(secondId, old.operationId) }
        denied { bridge.commit(secondId, old.preparationId) }
        assertEquals(0, f.submits)
    }
    @Test fun changedRequestConflictsButRetryUsesSamePreparation() = runTest {
        val f = Fixture(); val bridge = f.bridge(); val first = bridge.prepare(id, f.request())
        assertEquals(ApiErrorCode.REVISION_CONFLICT, assertFailsWith<AppApiException> {
            bridge.prepare(id, f.request().copy(instruction = "Changed"))
        }.error.code)
        assertEquals(first, bridge.prepare(id, f.request()))
        assertEquals(1, f.operations.rows.size)
    }
    @Test fun revocationDuringDirectoryReadWithholdsReferences() = runTest {
        val f = Fixture(); f.afterDirectory = { f.revoke() }
        denied { f.bridge().listComputers() }
    }
    @Test fun revokedPreparationCannotDispatchAfterColdCoordinatorRecreation() = runTest {
        val f = Fixture(); val p = f.bridge().prepare(id, f.request()); f.revoke()
        denied { f.bridge().commit(id, p.preparationId) }
        assertEquals(0, f.submits); assertEquals(OperationStage.PREPARED, f.operations.rows.values.single().stage)
    }
    @Test fun pcAcceptanceSurvivesRevocationButDeliveryIsDenied() = runTest {
        val f = Fixture(); val p = f.bridge().prepare(id, f.request()); f.afterSubmit = { f.revoke() }
        denied { f.bridge().commit(id, p.preparationId) }
        assertEquals(1, f.submits)
        assertEquals(OperationStage.ACCEPTED, f.operations.rows.values.single().stage)
        denied { f.bridge().get(id, p.operationId) }
    }
    @Test fun responseLossReconcilesOriginalReceiptWithoutResubmission() = runTest {
        val f = Fixture(); val p = f.bridge().prepare(id, f.request()); f.loseResponse = true
        val unknown = f.bridge().commit(id, p.preparationId)
        assertEquals("SUBMITTING", unknown.submissionStage); assertEquals("RESULT_UNKNOWN", unknown.errorCode)
        val restored = f.bridge().reconcile(id, p.operationId)
        assertEquals("ACCEPTED", restored.submissionStage); assertTrue(restored.runId!!.startsWith("run_appapi_"))
        assertEquals(1, f.submits); assertEquals(1, f.lookups)
    }
    @Test fun cancelOnlyPreparedSubmissionDoesNotCancelRun() = runTest {
        val f = Fixture(); val p = f.bridge().prepare(id, f.request())
        assertEquals("CANCELLED", f.bridge().cancelSubmission(id, p.operationId).submissionStage)
        assertEquals(0, f.submits)
    }
    @Test fun malformedUnicodeCannotAliasAnotherRequestIdentity() = runTest {
        val f = Fixture()
        for (key in listOf("\uD800", "\uDC00", "a\n", "x".repeat(129))) {
            assertEquals(ApiErrorCode.INVALID_ARGUMENT, assertFailsWith<AppApiException> {
                f.bridge().prepare(id, f.request(key))
            }.error.code)
        }
        assertTrue(f.operations.rows.isEmpty())
    }
    @Test fun computerPaginationBindsCursorToCurrentDirectoryAndDelegations() = runTest {
        val f = Fixture(); f.rows = f.rows + f.rows.single().copy(id = secondId)
        val bridge = f.bridge(); val first = bridge.listComputers(limit = 1)
        assertEquals(1, first.items.size); assertNotNull(first.nextCursor)
        val second = bridge.listComputers(limit = 1, cursor = first.nextCursor)
        assertEquals(secondId, second.items.single().delegationId); assertNull(second.nextCursor)
        f.rows = f.rows.filter { it.id == id }
        assertEquals(ApiErrorCode.REVISION_CONFLICT, assertFailsWith<AppApiException> {
            bridge.listComputers(limit = 1, cursor = first.nextCursor)
        }.error.code)
        assertEquals(ApiErrorCode.INVALID_ARGUMENT, assertFailsWith<AppApiException> { bridge.listComputers(limit = 33) }.error.code)
    }
    @Test fun exactResultProjectionDoesNotExposeOriginalInstructionOrPrivateRequestKeys() = runTest {
        val f = Fixture(); val bridge = f.bridge(); val p = bridge.prepare(id, f.request())
        bridge.commit(id, p.preparationId)
        val result = bridge.readResult(id, p.operationId)
        assertEquals("READY", result.resultState); assertEquals("Synthetic exact result", result.text); assertFalse(result.cached)
        val serialized = AppApiJson.encodeToString(result)
        assertFalse(serialized.contains("Analyze this report")); assertFalse(serialized.contains("appapi-message-"))
        assertFalse(serialized.contains("appapi-create-")); assertFalse(serialized.contains("callerBinding"))
    }
    @Test fun resultReadRequiresItsOwnFreshCapability() = runTest {
        val f = Fixture(); val bridge = f.bridge(); val p = bridge.prepare(id, f.request())
        bridge.commit(id, p.preparationId)
        f.rows = f.rows.map { it.copy(scope = it.scope.copy(capabilityIds = it.scope.capabilityIds - CapabilityRegistry.TASKS_RESULT)) }
        denied { bridge.readResult(id, p.operationId) }
    }
}
