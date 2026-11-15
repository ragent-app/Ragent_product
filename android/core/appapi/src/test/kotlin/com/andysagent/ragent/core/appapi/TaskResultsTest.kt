package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class TaskResultsTest {
    private val owner = VerifiedCaller("owner")
    private fun operation() = TaskOperation("op", "owner", "hash", "prep", "pc-b",
        TaskRequest("op", "Instruction", TaskRuntime("tool")), "create", "request", 0, 10,
        stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run")
    private fun body(state: String = "ready") = buildJsonObject {
        put("resultContractVersion", 1); put("sessionId", "session"); put("requestId", "request")
        put("state", state); put("runId", "run"); put("finalRunId", if (state == "ready") JsonPrimitive("run") else JsonNull)
        put("text", if (state == "ready") JsonPrimitive("Final result") else JsonNull)
        put("textTruncated", false); put("hasAttachments", false); put("artifacts", JsonArray(emptyList()))
        put("observedAt", "2026-10-11T00:00:00Z")
    }
    @Test fun finalReplacementRequiresExactReadyCompletePlainText() {
        assertTrue(decodeTaskResult(operation(), body()).canReplaceSelection)
        for (state in listOf("running", "checking", "failed", "cancelled")) assertFalse(decodeTaskResult(operation(), body(state)).canReplaceSelection)
        for (field in listOf("textTruncated", "hasAttachments")) {
            assertFalse(decodeTaskResult(operation(), JsonObject(body() + (field to JsonPrimitive(true)))).canReplaceSelection)
        }
        assertFalse(decodeTaskResult(operation(), JsonObject(body() + ("text" to JsonPrimitive("")))).canReplaceSelection)
    }
    @Test fun malformedOrDifferentSubmissionResultsAreRejected() {
        for ((key, value) in listOf("sessionId" to JsonPrimitive("other"), "requestId" to JsonPrimitive("later-message"),
            "runId" to JsonPrimitive("later-run"), "resultContractVersion" to JsonPrimitive(2), "state" to JsonPrimitive("new-state"),
            "resultContractVersion" to JsonPrimitive("1"), "textTruncated" to JsonPrimitive("false"), "hasAttachments" to JsonPrimitive("false"),
            "text" to JsonPrimitive("x".repeat(48 * 1024 + 1)), "text" to JsonPrimitive(17),
            "observedAt" to JsonPrimitive("invalid"), "finalRunId" to JsonNull)) {
            assertEquals(ApiErrorCode.RESULT_UNKNOWN, assertFailsWith<AppApiException> {
                decodeTaskResult(operation(), JsonObject(body() + (key to value)))
            }.error.code)
        }
    }
    private class Store(var row: TaskOperation) : OperationStore {
        override suspend fun get(operationId: String) = row.takeIf { it.operationId == operationId }
        override suspend fun getByPreparation(preparationId: String) = row.takeIf { it.preparationId == preparationId }
        override suspend fun insert(operation: TaskOperation) = false
        override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
            if (row.revision != expectedRevision) return false
            row = operation; return true
        }
    }
    @Test fun pairingAndGrantAreRecheckedAfterWaitingForResult() = runTest {
        val caller = VerifiedCaller("third-party")
        val store = Store(operation().copy(callerBinding = caller.binding))
        var paired = true; var granted = true
        var revoke = false; var unpair = false
        val access = object : TargetTaskAccess {
            override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T = block(object : TaskTarget {
                override suspend fun createSession(operation: TaskOperation): String = error("must not create")
                override suspend fun submitMessage(operation: TaskOperation, sessionId: String): com.andysagent.ragent.core.domain.MessageSubmissionReceipt = error("must not send")
                override suspend fun findReceipt(operation: TaskOperation, sessionId: String): com.andysagent.ragent.core.domain.MessageSubmissionReceipt? = error("must not look up receipt")
                override suspend fun readResult(operation: TaskOperation): TaskResultSnapshot {
                    if (revoke) granted = false
                    if (unpair) paired = false
                    return decodeTaskResult(operation, body())
                }
            })
        }
        val grant = CallerGrant(caller.binding, setOf(CapabilityRegistry.TASKS_RESULT), setOf("pc-b"), Long.MAX_VALUE, mayCreateSessions = true)
        val coordinator = TaskCoordinator(store, { TargetDirectorySnapshot(if (paired) listOf(ApiTarget("pc-b", "Original")) else emptyList()) },
            GrantAuthorizer("owner", { if (granted) listOf(grant) else emptyList() }), access)
        revoke = true
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { coordinator.readResult("op", caller) }.error.code)
        assertNull(store.row.result)
        revoke = false; granted = true; unpair = true
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> { coordinator.readResult("op", caller) }.error.code)
        assertNull(store.row.result)
    }

    @Test fun resultReadPinsTargetAndPersistsWithoutCreatingOrSending() = runTest {
        val store = Store(operation().copy(runId = null, queued = true)); val accessed = mutableListOf<String>()
        var reads = 0
        val access = object : TargetTaskAccess {
            override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                accessed += instanceId
                return block(object : TaskTarget {
                    override suspend fun createSession(operation: TaskOperation): String = error("must not create")
                    override suspend fun submitMessage(operation: TaskOperation, sessionId: String): com.andysagent.ragent.core.domain.MessageSubmissionReceipt = error("must not send")
                    override suspend fun findReceipt(operation: TaskOperation, sessionId: String): com.andysagent.ragent.core.domain.MessageSubmissionReceipt? = error("result path is independent")
                    override suspend fun readResult(operation: TaskOperation): TaskResultSnapshot { reads++; return decodeTaskResult(operation, body()) }
                })
            }
        }
        fun coordinator() = TaskCoordinator(store, { TargetDirectorySnapshot(listOf(ApiTarget("pc-a", "UI"), ApiTarget("pc-b", "Original")), "pc-a") },
            GrantAuthorizer("owner", { emptyList() }), access, now = { 99_000 })
        val result = coordinator().readResult("op", owner) // Submission deadline does not prohibit reads.
        assertEquals("pc-b", result.targetInstanceId); assertEquals(listOf("pc-b"), accessed)
        assertEquals("run", result.runId); assertEquals("Final result", result.result!!.text); assertFalse(result.queued)
        assertEquals(result, coordinator().get("op", owner)); assertEquals(1, reads)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { coordinator().readResult("op", VerifiedCaller("forged")) }.error.code)
        assertEquals(1, reads)
    }
}
