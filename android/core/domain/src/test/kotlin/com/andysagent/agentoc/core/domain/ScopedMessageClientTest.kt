package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import kotlin.test.*

internal fun scopeContractFixture(): String = buildJsonObject {
    put("version", 1); put("header", SessionScopeCondition.HEADER); put("encoding", "base64url-utf8-json")
    put("maxHeaderBytes", 4096); put("maxDecodedBytes", 2048)
    put("contextPath", "/api/sessions/{sessionId}/app-api-context")
    put("fields", JsonArray(listOf("version", "sessionId", "expectedScopeRevision", "expectedProjectId").map(::JsonPrimitive)))
    val effects = listOf(
        Triple("message.prepare", "POST", ScopedMessageClient.PREPARE_PATH),
        Triple("message.preparation.receipt", "GET", ScopedMessageClient.RECEIPT_PATH),
        Triple("message.commit", "POST", ScopedMessageClient.COMMIT_PATH),
        Triple("message.commit.receipt", "GET", ScopedMessageClient.COMMIT_PATH),
        Triple("asset.upload.intent", "POST", "/api/assets/upload-intents"),
        Triple("asset.upload.body", "POST", "/api/assets/{assetId}/upload"),
        Triple("asset.upload.chunk", "PATCH", "/api/assets/{assetId}/upload"),
        Triple("asset.upload.checkpoint", "GET", "/api/assets/{assetId}/upload-checkpoint"),
        Triple("asset.upload.finalize", "POST", "/api/assets/{assetId}/finalize"),
        Triple("asset.upload.receipt", "GET", "/api/assets/upload-intents?sessionId={sessionId}&requestId={requestId}"),
    )
    put("effects", JsonArray(effects.map { (id, method, path) -> buildJsonObject {
        put("id", id); put("method", method); put("path", path)
        if (method == "GET") put("readonly", true)
        if (id == "message.prepare") put("startsRun", false)
        if (id == "message.commit") put("durableQueue", true)
        if (id == "asset.upload.body") put("stagedBeforeGuard", true)
        if (id == "asset.upload.finalize") put("verifiedBeforeGuard", true)
    } }))
}.toString()

class ScopedMessageClientTest {
    private val scope = SessionScopeCondition("session /一", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null)
    private val request = ScopedMessageRequest("request/one", "分析这个文档", emptyList(),
        buildJsonObject { put("tool", "codex"); put("interactionMode", "agent") }, "2026-10-12T00:10:00.000Z")
    private val preparationId = "mprep_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    private val runId = "run_appapi_${"a".repeat(32)}"
    private val prepared = ScopedMessagePreparation(1, scope.sessionId, request.requestId, preparationId,
        "prepared", false, "2026-10-12T00:00:00.000Z", request.expiresAt, false, false)
    private val accepted = ScopedMessageCommitReceipt(1, scope.sessionId, request.requestId, preparationId,
        runId, "queued", true, true, false, request.expiresAt, prepared.createdAt, prepared.createdAt, null, false, null)

    private inner class Fixture : AgentoCTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Connected)
        val calls = mutableListOf<ApiRequest>()
        var scopeContract = scopeContractFixture()
        var unknownCode = "RESOURCE_NOT_FOUND"
        var stored = false
        var losePrepare = false
        var loseCommit = false
        var committed = false
        var transform: (String, JsonObject) -> JsonObject = { _, json -> json }
        override suspend fun execute(request: ApiRequest): ApiResponse {
            calls += request
            val json = when {
                request.path == "/api/session-scope-contract" -> scopeContract
                request.path == "/api/message-preparation-contract" -> buildJsonObject {
                    put("version", 1); put("preparesOnly", true); put("startsRun", false); put("commitSupported", true)
                    put("commitBodyBytes", 4096); put("scopeHeader", SessionScopeCondition.HEADER)
                    put("scopeContractPath", "/api/session-scope-contract"); put("maxBodyBytes", 131072)
                    put("maxTextBytes", 65536); put("maxAttachments", 16); put("maxLifetimeSeconds", 86400)
                    put("attachmentOptionKeys", JsonArray(listOf(JsonPrimitive("renderAs"))))
                    put("preparePath", ScopedMessageClient.PREPARE_PATH); put("receiptPath", ScopedMessageClient.RECEIPT_PATH)
                    put("commitPath", ScopedMessageClient.COMMIT_PATH); put("commitReceiptPath", ScopedMessageClient.COMMIT_PATH)
                    put("runOptionKeys", JsonArray(ScopedMessageRequest.OPTION_KEYS.map(::JsonPrimitive)))
                }.toString()
                request.path.endsWith("/app-api-context") -> SessionMutationJson.encodeToString(SessionMutationContext(
                    1, scope.sessionId, null, scope.expectedScopeRevision, scope.expectedScopeRevision, "", false, false, false, null, 64))
                request.path.endsWith("/commit") -> {
                    if (!stored) return ApiResponse(404, """{"code":"$unknownCode"}""")
                    if (request.method == "POST") {
                        committed = true
                        if (loseCommit) { loseCommit = false; throw IOException("Commit acknowledgement lost") }
                    }
                    SessionMutationJson.encodeToString(if (committed) accepted else accepted.copy(runId = null,
                        state = "unconfirmed", accepted = false, queued = false, acceptedAt = null))
                }
                request.method == "POST" -> {
                    stored = true
                    if (losePrepare) { losePrepare = false; throw IOException("Preparation acknowledgement lost") }
                    SessionMutationJson.encodeToString(prepared)
                }
                !stored -> return ApiResponse(404, """{"code":"$unknownCode"}""")
                else -> SessionMutationJson.encodeToString(prepared)
            }
            return ApiResponse(200, transform(request.path, Json.parseToJsonElement(json).jsonObject).toString())
        }
        override fun connectInvalidationSocket() {}
        override suspend fun close() {}
    }

    @Test fun originalScopeHeaderHasCanonicalEncodingAndExplicitNullProject() {
        val header = scope.headers().getValue(SessionScopeCondition.HEADER)
        assertFalse('=' in header)
        val json = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(header), Charsets.UTF_8)).jsonObject
        assertEquals(JsonNull, json["expectedProjectId"])
        assertEquals(scope.sessionId, json["sessionId"]!!.jsonPrimitive.content)
        assertEquals(header, scope.copy().headers().getValue(SessionScopeCondition.HEADER))
        assertFailsWith<IllegalArgumentException> { scope.copy(expectedScopeRevision = scope.expectedScopeRevision.uppercase()).headers() }
        assertFailsWith<IllegalArgumentException> { scope.copy(sessionId = " s ").headers() }
    }

    @Test fun attachmentRenderingIsPreservedAndAbsentOptionDoesNotBecomeJsonNull() {
        val ordinary = PreparedMessageAsset("fasset_${"a".repeat(24)}", "b".repeat(64), 1)
        val encoded = Json.parseToJsonElement(SessionMutationJson.encodeToString(ordinary)).jsonObject
        assertFalse("renderAs" in encoded)
        val file = Json.parseToJsonElement(SessionMutationJson.encodeToString(ordinary.copy(renderAs = "file"))).jsonObject
        assertEquals(JsonPrimitive("file"), file["renderAs"])
        request.copy(attachments = listOf(ordinary.copy(renderAs = "file"))).validate()
        assertFailsWith<IllegalArgumentException> { request.copy(attachments = listOf(ordinary.copy(renderAs = "image"))).validate() }
    }

    @Test fun negotiateReadPrepareAndCommitUseExactSeparateEndpoints() = runTest {
        val wire = Fixture(); val client = ScopedMessageClient("pc-one", wire)
        client.requireSupport(); assertEquals(scope, client.readScope(scope.sessionId))
        assertFalse(client.prepare(scope, request).accepted)
        val receipt = client.commit(scope, request, preparationId)
        assertTrue(receipt.accepted); assertTrue(receipt.queued); assertEquals(runId, receipt.runId)
        val posts = wire.calls.filter { it.method == "POST" }
        assertEquals(2, posts.size)
        assertTrue(posts.first().path.contains("session%20%2F%E4%B8%80"))
        assertTrue(posts.last().path.endsWith("/request%2Fone/commit"))
        assertEquals(setOf("version", "preparationId"), Json.parseToJsonElement(posts.last().body!!).jsonObject.keys)
        posts.forEach { assertEquals(scope.headers(), it.headers); assertEquals("application/json", it.contentType) }
        assertFalse(wire.calls.any { it.path.endsWith("/messages") })
    }

    @Test fun unsupportedOrDowngradedDiscoveryDoesNotWrite() = runTest {
        for (replacement in listOf(scopeContractFixture().replace("durableQueue\":true", "durableQueue\":false"), """{"version":0}""")) {
            val wire = Fixture().apply { scopeContract = replacement }
            assertFailsWith<ApiException> { ScopedMessageClient("pc", wire).requireSupport() }
            assertTrue(wire.calls.all { it.method == "GET" })
        }
    }

    @Test fun preparationAndCommitReplyLossRecoverByReadonlyOriginalIdentity() = runTest {
        val wire = Fixture().apply { losePrepare = true }; val client = ScopedMessageClient("pc", wire)
        assertFailsWith<IOException> { client.prepare(scope, request) }
        assertEquals(preparationId, client.findPreparation(scope, request)?.preparationId)
        assertEquals(1, wire.calls.count { it.method == "POST" })
        wire.loseCommit = true
        assertFailsWith<IOException> { client.commit(scope, request, preparationId) }
        assertEquals(runId, client.findCommit(scope, request, preparationId)?.runId)
        assertEquals(2, wire.calls.count { it.method == "POST" })
        assertEquals(scope.headers(), wire.calls.last().headers)
    }

    @Test fun onlyExactNotFoundCodeMeansNoRetainedReceipt() = runTest {
        val wire = Fixture(); val client = ScopedMessageClient("pc", wire)
        assertNull(client.findPreparation(scope, request))
        wire.unknownCode = "SOMETHING_ELSE"
        assertFailsWith<ApiException> { client.findPreparation(scope, request) }
        assertTrue(wire.calls.all { it.method == "GET" })
    }

    @Test fun retainedPreparationDoesNotMeanAcceptedOrStarted() = runTest {
        val wire = Fixture(); val client = ScopedMessageClient("pc", wire)
        client.prepare(scope, request)
        val receipt = client.findCommit(scope, request, preparationId)!!
        assertFalse(receipt.accepted); assertFalse(receipt.dispatched); assertNull(receipt.runId)
        assertEquals(1, wire.calls.count { it.method == "POST" })
    }

    @Test fun foreignExpiredOrDispatchingPreparationCannotBeAdopted() = runTest {
        for ((key, value) in listOf("sessionId" to JsonPrimitive("other"), "requestId" to JsonPrimitive("other"),
            "preparationId" to JsonPrimitive("bad"), "expiresAt" to JsonPrimitive("2026-10-13T00:00:00.000Z"),
            "accepted" to JsonPrimitive(true), "dispatched" to JsonPrimitive(true))) {
            val wire = Fixture().apply { stored = true; transform = { _, json -> JsonObject(json + (key to value)) } }
            assertFailsWith<IllegalStateException> { ScopedMessageClient("pc", wire).findPreparation(scope, request) }
            assertTrue(wire.calls.all { it.method == "GET" })
        }
    }

    @Test fun invalidCommitEvidenceCannotReportAcceptance() = runTest {
        for ((key, value) in listOf("runId" to JsonNull, "preparationId" to JsonPrimitive("other"),
            "queued" to JsonPrimitive(false), "acceptedAt" to JsonNull, "runId" to JsonPrimitive("legacy-run"),
            "state" to JsonPrimitive("x".repeat(65)), "state" to JsonPrimitive(" running"))) {
            val wire = Fixture().apply { stored = true; committed = true; transform = { _, json ->
                JsonObject(json + (key to value) + if (key == "state") mapOf("queued" to JsonPrimitive(false)) else emptyMap())
            } }
            assertFailsWith<IllegalStateException> { ScopedMessageClient("pc", wire).findCommit(scope, request, preparationId) }
        }
    }

    @Test fun invalidFrozenInputsFailBeforeAnyNetworkRequest() = runTest {
        val wire = Fixture(); val client = ScopedMessageClient("pc", wire)
        for (invalid in listOf(request.copy(text = "bad\u0000"), request.copy(text = "\uD800"),
            request.copy(expiresAt = "2026-10-12T00:10:00Z"), request.copy(requestId = " id "),
            request.copy(runOptions = buildJsonObject { put("freshThread", "true") }),
            request.copy(runOptions = buildJsonObject { put("shell", "echo hello") }))) {
            assertFailsWith<IllegalArgumentException> { client.prepare(scope, invalid) }
        }
        assertTrue(wire.calls.isEmpty())
        assertEquals("1970-01-01T00:00:01.000Z", ScopedMessageRequest.expiry(1000))
    }
}
