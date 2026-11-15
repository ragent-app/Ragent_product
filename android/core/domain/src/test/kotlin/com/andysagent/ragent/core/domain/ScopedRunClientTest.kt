package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import java.io.IOException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.test.*

class ScopedRunClientTest {
    private val scope = SessionScopeCondition("会话 一", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null)
    private val stamp = "2026-10-12T00:00:00.000Z"
    private val id = "run_example"
    private val run = RunApiRun(1, scope.sessionId, id, "running", false, stamp, stamp, null, null, false, null, null, false, "a".repeat(64))
    private fun contract() = buildJsonObject {
        put("version", 1); put("scopeHeader", SessionScopeCondition.HEADER)
        put("scopeContextPath", "/api/sessions/{sessionId}/app-api-context")
        put("readsDispatch", false); put("cancellationDeadline", true); put("cancellationRequestedIsTerminal", false)
        put("cancellationReceipt", false); put("maxResponseBytes", 131072); put("listLimit", 32)
        put("eventScanLimit", 128); put("eventTextBytes", 8192); put("maxWaitMs", 30000)
        val operations = mapOf("runs.list" to ("GET" to ScopedRunClient.LIST_PATH), "runs.get" to ("GET" to ScopedRunClient.ITEM_PATH),
            "runs.events" to ("GET" to "${ScopedRunClient.ITEM_PATH}/events"), "runs.result" to ("GET" to "${ScopedRunClient.ITEM_PATH}/result"),
            "runs.wait" to ("GET" to "${ScopedRunClient.ITEM_PATH}/wait"), "runs.cancel" to ("POST" to "${ScopedRunClient.ITEM_PATH}/cancel"))
        put("operations", JsonArray(operations.map { (key, value) -> buildJsonObject {
            put("id", key); put("method", value.first); put("path", value.second); put("readonly", value.first == "GET")
        } }))
    }
    private inner class Fixture : RagentTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Connected)
        val calls = mutableListOf<ApiRequest>()
        var discovery = contract()
        var response = SessionMutationJson.encodeToString(RunApiRunReply(1, run, stamp))
        var status = 200
        var loseResponse = false
        override suspend fun execute(request: ApiRequest): ApiResponse {
            calls += request
            if (loseResponse) throw IOException("Response lost")
            return ApiResponse(status, if (request.path == "/api/run-api-contract") discovery.toString() else response)
        }
        override fun connectInvalidationSocket() {}
        override suspend fun close() {}
    }
    @Test fun negotiationRequiresExactConditionalRunOperations() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f); client.requireSupport()
        assertEquals("GET", f.calls.single().method)
        for ((key, bad) in mapOf("version" to JsonPrimitive(2), "readsDispatch" to JsonPrimitive(true),
            "scopeHeader" to JsonPrimitive("other"), "cancellationDeadline" to JsonPrimitive(false),
            "cancellationRequestedIsTerminal" to JsonPrimitive(true), "eventScanLimit" to JsonPrimitive(999), "operations" to JsonArray(emptyList()))) {
            f.discovery = JsonObject(contract() + (key to bad))
            assertEquals("CAPABILITY_UNSUPPORTED", assertFailsWith<ApiException> { client.requireSupport() }.code)
        }
        assertTrue(f.calls.all { it.method == "GET" })
    }
    @Test fun getUsesExactFixedPcScopeAndEncodedIdentity() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        assertEquals(run, client.get(scope, id).run)
        val request = f.calls.single()
        assertEquals("/api/sessions/%E4%BC%9A%E8%AF%9D%20%E4%B8%80/app-api-runs/run_example", request.path)
        assertEquals(scope.headers(), request.headers); assertNull(request.body); assertNull(request.idempotencyKey)
    }
    @Test fun responseIdentityAndTerminalSemanticsCannotDrift() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        for (bad in listOf(run.copy(sessionId = "other"), run.copy(runId = "other"), run.copy(version = 2),
            run.copy(terminal = true), run.copy(state = "completed"), run.copy(revision = "bad"), run.copy(createdAt = "bad"))) {
            f.response = SessionMutationJson.encodeToString(RunApiRunReply(1, bad, stamp))
            assertFailsWith<IllegalStateException> { client.get(scope, id) }
        }
    }
    @Test fun invalidResourceAndOversizeResponseAreRejected() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        for (bad in listOf("..", "../other", "run/other", "run\\other", " run", "x".repeat(257)))
            assertFailsWith<IllegalArgumentException> { client.get(scope, bad) }
        assertTrue(f.calls.isEmpty())
        f.response = "x".repeat(131073)
        assertFailsWith<IllegalArgumentException> { client.get(scope, id) }
    }
    @Test fun listChecksUniqueResourcesAndOpaqueCursorShape() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        f.response = SessionMutationJson.encodeToString(RunApiList(1, scope.sessionId, listOf(run), null, stamp))
        assertEquals(id, client.list(scope, 1).runs.single().runId)
        f.response = SessionMutationJson.encodeToString(RunApiList(1, scope.sessionId, listOf(run, run), null, stamp))
        assertFailsWith<IllegalStateException> { client.list(scope) }
        assertFailsWith<IllegalArgumentException> { client.list(scope, cursor = "wrong") }
        assertFailsWith<IllegalArgumentException> { client.list(scope, 33) }
    }
    private fun events() = RunApiEvents(1, scope.sessionId, id, 0, listOf(RunApiEvent(1, id, "message", "assistant", stamp, "回复🙂", false, null)), 2, 2, false, stamp)
    @Test fun eventPageChecksSequenceIdentityAndCommittedBoundary() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f); val page = events()
        f.response = SessionMutationJson.encodeToString(page)
        assertEquals("回复🙂", client.events(scope, id).events.single().text)
        for (bad in listOf(page.copy(runId = "other"), page.copy(historyRevision = -1), page.copy(scannedThrough = 999),
            page.copy(hasMore = true), page.copy(events = listOf(page.events.single().copy(runId = "other"))),
            page.copy(events = listOf(page.events.single().copy(seq = 3))), page.copy(events = page.events + page.events))) {
            f.response = SessionMutationJson.encodeToString(bad)
            assertFailsWith<IllegalStateException> { client.events(scope, id) }
        }
    }
    @Test fun continuedEventsRequireRevisionAndBoundedText() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        assertFailsWith<IllegalArgumentException> { client.events(scope, id, afterSeq = 1) }
        f.response = SessionMutationJson.encodeToString(events().copy(events = listOf(events().events.single().copy(text = "🙂".repeat(3000)))))
        assertFailsWith<IllegalStateException> { client.events(scope, id) }
        assertFailsWith<IllegalArgumentException> { client.events(scope, id, limit = 33) }
    }
    private fun result() = RunApiResult(1, 1, scope.sessionId, id, id, "ready", "完成", false, emptyList(), false, stamp)
    @Test fun resultRequiresExactRunAndOnlyReadyResultsCarryContent() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f); val value = result()
        f.response = SessionMutationJson.encodeToString(value)
        assertEquals("完成", client.result(scope, id).text)
        for (bad in listOf(value.copy(runId = "other"), value.copy(sessionId = "other"), value.copy(state = "running"),
            value.copy(finalRunId = null), value.copy(text = null), value.copy(text = "x".repeat(49153)))) {
            f.response = SessionMutationJson.encodeToString(bad)
            assertFailsWith<IllegalStateException> { client.result(scope, id) }
        }
    }
    @Test fun resultArtifactReferencesCannotCarryMalformedOrDuplicateIdentities() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        val item = RunApiArtifact("fasset_${"a".repeat(24)}", "报告.txt", "text/plain", 1)
        f.response = SessionMutationJson.encodeToString(result().copy(artifacts = listOf(item), hasAttachments = true))
        assertEquals(item, client.result(scope, id).artifacts.single())
        for (items in listOf(listOf(item, item), listOf(item.copy(assetId = "other")), listOf(item.copy(sizeBytes = -1)))) {
            f.response = SessionMutationJson.encodeToString(result().copy(artifacts = items))
            assertFailsWith<IllegalStateException> { client.result(scope, id) }
        }
    }
    @Test fun waitChecksObservationAndTimeoutSemantics() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        val value = RunApiWait(1, scope.sessionId, id, run, false, true, stamp)
        f.response = SessionMutationJson.encodeToString(value)
        assertTrue(client.wait(scope, id, run.revision, 0).timedOut)
        f.response = SessionMutationJson.encodeToString(value.copy(changed = true))
        assertFailsWith<IllegalStateException> { client.wait(scope, id, run.revision, 0) }
        assertFailsWith<IllegalArgumentException> { client.wait(scope, id, timeoutMs = 30001) }
    }
    @Test fun cancellationIsExplicitConditionalDeadlinePostAndKeepsRequestedDistinctFromTerminal() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        f.response = SessionMutationJson.encodeToString(RunApiCancellation(1, run.copy(cancelRequested = true), "cancellation_requested", stamp))
        val receipt = client.cancel(scope, id, stamp)
        assertTrue(receipt.run.cancelRequested); assertFalse(receipt.run.terminal)
        val request = f.calls.single(); assertEquals("POST", request.method); assertTrue(request.path.endsWith("/cancel"))
        assertEquals(scope.headers(), request.headers); assertEquals("application/json", request.contentType)
        assertEquals(setOf("version", "expiresAt"), Json.parseToJsonElement(request.body!!).jsonObject.keys)
    }
    @Test fun cancellationRejectsFalseSuccessAndNeverReplaysUnknownResponse() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f)
        for (value in listOf(RunApiCancellation(1, run, "cancellation_requested", stamp), RunApiCancellation(1, run, "already_terminal", stamp))) {
            f.response = SessionMutationJson.encodeToString(value)
            assertFailsWith<IllegalStateException> { client.cancel(scope, id, stamp) }
        }
        f.calls.clear(); f.loseResponse = true
        assertFailsWith<IOException> { client.cancel(scope, id, stamp) }
        assertEquals(1, f.calls.size)
    }
    @Test fun typedServerErrorsRemainErrorsWithoutLegacyFallback() = runTest {
        val f = Fixture(); val client = ScopedRunClient("pc_a", f); f.status = 409; f.response = """{"code":"REVISION_CONFLICT","error":"PRIVATE"}"""
        val error = assertFailsWith<ApiException> { client.get(scope, id) }
        assertEquals("REVISION_CONFLICT", error.code); assertFalse(error.message.contains("PRIVATE"))
        assertEquals(1, f.calls.size)
    }
}
