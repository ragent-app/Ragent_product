package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import kotlin.test.*

internal fun exportOperation() = TaskOperation("op", "owner", "hash", "prep", "pc-b",
    TaskRequest("op", "Instruction", TaskRuntime("tool")), "create", "request", 0, 10,
    stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run")

internal class ExportCarrier(val payload: ByteArray = ("完整结果🙂\n".repeat(12_000) + "END").toByteArray()) : RagentTransport {
    override val invalidations = emptyFlow<InvalidationHint>()
    override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
    val requests = mutableListOf<ApiRequest>()
    var transform: (String, JsonObject) -> JsonObject = { _, body -> body }
    var afterRequest: () -> Unit = {}
    var status = 200
    var rawBody: String? = null
    var rawBodyFor: (String) -> Boolean = { true }
    val digest = MessageDigest.getInstance("SHA-256").digest(payload).hex()
    val revision = "b".repeat(64)
    fun contract() = buildJsonObject {
        put("version", 1); put("maxChunkBytes", 65_536); put("maxTextBytes", 26_214_400)
        put("maxFileBytes", 26_214_400); put("maxBatchBytes", 104_857_600); put("maxResources", 17); put("snapshotTtlMs", 900_000)
    }
    fun manifest() = buildJsonObject {
        put("exportContractVersion", 1); put("instanceId", "pc-b"); put("sessionId", "session"); put("requestId", "request")
        put("runId", "run"); put("finalRunId", "final-run"); put("revision", revision); put("totalBytes", payload.size)
        put("maxChunkBytes", 65_536); put("expiresAt", "2099-01-01T00:00:00Z")
        put("resources", buildJsonArray {
            add(buildJsonObject { put("resourceId", "text"); put("originalName", "result.txt"); put("mimeType", "text/plain")
                put("available", true); put("sizeBytes", payload.size); put("sha256", digest) })
            add(buildJsonObject { put("resourceId", "reference_0"); put("originalName", "External reference")
                put("mimeType", "application/octet-stream"); put("available", false); put("errorCode", "CAPABILITY_UNSUPPORTED") })
        })
    }
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        val body = when {
            request.path == "/api/result-export-contract" -> contract()
            '?' !in request.path -> manifest()
            else -> {
                val parameters = request.path.substringAfter('?').split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
                val offset = parameters.getValue("offset").toInt(); val length = parameters.getValue("length").toInt()
                val bytes = payload.copyOfRange(offset, minOf(offset + length, payload.size))
                buildJsonObject {
                    put("exportContractVersion", 1); put("instanceId", "pc-b"); put("sessionId", "session"); put("requestId", "request")
                    put("runId", "run"); put("finalRunId", "final-run"); put("revision", revision); put("resourceId", "text")
                    put("offset", offset); put("nextOffset", offset + bytes.size); put("eof", offset + bytes.size == payload.size)
                    put("sizeBytes", payload.size); put("sha256", digest); put("chunkSha256", MessageDigest.getInstance("SHA-256").digest(bytes).hex())
                    put("dataBase64", Base64.getEncoder().encodeToString(bytes))
                }
            }
        }
        afterRequest()
        return ApiResponse(status, (if (rawBodyFor(request.path)) rawBody else null) ?: transform(request.path, body).toString())
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = error("client does not own the carrier")
}

class ResultExportClientTest {
    private fun client(carrier: ExportCarrier) = ResultExportClient("pc-b", carrier, now = { 1 })
    @Test fun resumeValidatesPrivatePrefixAndRequestsOnlyRemainingBytes() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier)
        val manifest = client.readManifest(exportOperation()) {}; carrier.requests.clear()
        val saved = carrier.payload.copyOfRange(0, 32_768)
        val prefix = ResultExportPrefix(saved.size.toLong(), MessageDigest.getInstance("SHA-256").digest(saved).hex()) { it(saved) }
        val remaining = ByteArrayOutputStream()
        val receipt = client.stream(exportOperation(), manifest, "text", {}, prefix) { remaining.write(it) }
        assertContentEquals(carrier.payload.copyOfRange(saved.size, carrier.payload.size), remaining.toByteArray())
        assertEquals(carrier.digest, receipt.sha256); assertEquals(carrier.payload.size.toLong(), receipt.sizeBytes)
        assertTrue(carrier.requests.first { '?' in it.path }.path.contains("offset=32768&"))
        assertTrue(carrier.requests.all { it.method == "GET" })
    }
    @Test fun fullPrefixRequiresCurrentRemoteEofBeforeReturningReceipt() = runTest {
        val carrier = ExportCarrier(ByteArray(100) { it.toByte() }); val client = client(carrier)
        val manifest = client.readManifest(exportOperation()) {}; carrier.requests.clear()
        val prefix = ResultExportPrefix(100, carrier.digest) { it(carrier.payload) }
        val receipt = client.stream(exportOperation(), manifest, "text", {}, prefix) { assertTrue(it.isEmpty()) }
        assertEquals(100L, receipt.sizeBytes)
        assertEquals(1, carrier.requests.count { '?' in it.path })
        assertTrue(carrier.requests.last().path.contains("offset=100&length=1"))
    }
    @Test fun corruptOrShortPrefixesFailBeforeAnyRemoteIo() = runTest {
        for (prefix in listOf(
            ResultExportPrefix(3, "a".repeat(64)) { it(byteArrayOf(1, 2, 3)) },
            ResultExportPrefix(3, "a".repeat(64)) { it(byteArrayOf(1, 2)) },
            ResultExportPrefix(1, "a".repeat(64)) { it(byteArrayOf(1, 2)) },
        )) {
            val carrier = ExportCarrier(); val client = client(carrier)
            val manifest = client.readManifest(exportOperation()) {}; carrier.requests.clear()
            assertEquals(ApiErrorCode.REVISION_CONFLICT, assertFailsWith<AppApiException> {
                client.stream(exportOperation(), manifest, "text", {}, prefix) { fail("No remaining bytes") }
            }.error.code)
            assertTrue(carrier.requests.isEmpty())
        }
    }
    @Test fun prefixReaderRevocationStopsBeforeContractAndChunkRequests() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier)
        val manifest = client.readManifest(exportOperation()) {}; carrier.requests.clear(); var granted = true
        val prefix = ResultExportPrefix(1, MessageDigest.getInstance("SHA-256").digest(byteArrayOf(1)).hex()) {
            granted = false; it(byteArrayOf(1))
        }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            client.stream(exportOperation(), manifest, "text", {
                if (!granted) apiFailure(ApiErrorCode.PERMISSION_DENIED, "revoked")
            }, prefix) {}
        }.error.code)
        assertTrue(carrier.requests.isEmpty())
    }
    @Test fun completeUnicodeTextUsesBoundedChunksAndSurvivesJournalSerialization() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier); var checks = 0
        val access: suspend () -> Unit = { checks++ }
        val manifest = client.readManifest(exportOperation(), access)
        val restored = AppApiJson.decodeFromString<ResultExportManifest>(AppApiJson.encodeToString(manifest))
        assertEquals(manifest, restored)
        val output = ByteArrayOutputStream(); val sizes = mutableListOf<Int>()
        val receipt = client.stream(exportOperation(), restored, "text", access) { sizes += it.size; output.write(it) }
        assertContentEquals(carrier.payload, output.toByteArray()); assertEquals(carrier.digest, receipt.sha256)
        assertEquals(carrier.payload.size.toLong(), receipt.sizeBytes); assertTrue(sizes.size > 2); assertTrue(sizes.all { it <= 16_384 })
        for (request in carrier.requests.filter { '?' in it.path }) {
            val wireBody = carrier.execute(request).body
            assertTrue(Base64.getEncoder().encodeToString(wireBody.toByteArray()).length + 1024 < 65_536)
        }
        assertTrue(checks > carrier.requests.size * 2); assertTrue(carrier.requests.all { it.method == "GET" && it.body == null })
        assertTrue(carrier.requests.drop(3).all { it.path.startsWith("/api/sessions/session/message-results/request/exports/text?") })
    }
    @Test fun emptyTextStillReadsAndVerifiesExactEof() = runTest {
        val carrier = ExportCarrier(byteArrayOf()); val client = client(carrier)
        val manifest = client.readManifest(exportOperation()) {}; var calls = 0
        val receipt = client.stream(exportOperation(), manifest, "text", {}) { assertEquals(0, it.size); calls++ }
        assertEquals(1, calls); assertEquals(0L, receipt.sizeBytes)
    }
    @Test fun expiryDuringTheFinalSinkDoesNotReturnAVerifiedReceipt() = runTest {
        val carrier = ExportCarrier(byteArrayOf(1, 2, 3)); var timestamp = 1L
        val client = ResultExportClient("pc-b", carrier, now = { timestamp })
        val manifest = client.readManifest(exportOperation()) {}; var received = 0
        assertEquals(ApiErrorCode.REQUEST_EXPIRED, assertFailsWith<AppApiException> {
            client.stream(exportOperation(), manifest, "text", {}) {
                received += it.size; timestamp = java.time.Instant.parse(manifest.expiresAt).toEpochMilli()
            }
        }.error.code)
        assertEquals(3, received)
    }
    @Test fun allBinaryValuesArePreservedWithoutTextDecoding() = runTest {
        val carrier = ExportCarrier(ByteArray(180_000) { it.toByte() }); val client = client(carrier)
        val manifest = client.readManifest(exportOperation()) {}; val output = ByteArrayOutputStream()
        client.stream(exportOperation(), manifest, "text", {}) { output.write(it) }
        assertContentEquals(carrier.payload, output.toByteArray())
    }
    @Test fun unknownVersionsAndUnsupportedTargetsNeverRequestResourceBytes() = runTest {
        for ((key, value) in listOf("version" to JsonPrimitive(2), "maxChunkBytes" to JsonPrimitive(131_072))) {
            val carrier = ExportCarrier(); carrier.transform = { _, body -> JsonObject(body + (key to value)) }
            assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, assertFailsWith<AppApiException> { client(carrier).readManifest(exportOperation()) {} }.error.code)
            assertEquals(1, carrier.requests.size)
        }
        val missing = ExportCarrier(); missing.status = 404
        assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, assertFailsWith<AppApiException> { client(missing).readManifest(exportOperation()) {} }.error.code)
        assertEquals(1, missing.requests.size)
    }
    @Test fun malformedManifestIdentitiesBudgetsAndTypesAreRejected() = runTest {
        val carrier = ExportCarrier(); val base = carrier.manifest()
        val changes = listOf("instanceId" to JsonPrimitive("pc-a"), "sessionId" to JsonPrimitive("other"), "requestId" to JsonPrimitive("later"),
            "runId" to JsonPrimitive("later-run"), "finalRunId" to JsonNull, "exportContractVersion" to JsonPrimitive("1"),
            "totalBytes" to JsonPrimitive(carrier.payload.size + 1), "totalBytes" to JsonPrimitive(-1), "maxChunkBytes" to JsonPrimitive(65_537),
            "revision" to JsonPrimitive("unsafe/identity"), "expiresAt" to JsonPrimitive("not-a-date"))
        for ((key, value) in changes) assertFailsWith<AppApiException>(key) { decodeResultExport(exportOperation(), JsonObject(base + (key to value)), 1) }
        val resources = base.getValue("resources").jsonArray
        val text = resources.first().jsonObject
        for ((key, value) in listOf("available" to JsonPrimitive("true"), "sizeBytes" to JsonPrimitive("100"),
            "sizeBytes" to JsonPrimitive(26_214_401), "originalName" to JsonPrimitive("../../report.txt"), "mimeType" to JsonPrimitive("text/plain\r\nFake: yes"),
            "sha256" to JsonPrimitive("a".repeat(63)), "extra" to JsonPrimitive("unexpected"))) {
            val body = JsonObject(base + ("resources" to JsonArray(listOf(JsonObject(text + (key to value))))))
            assertFailsWith<AppApiException>(key) { decodeResultExport(exportOperation(), body, 1) }
        }
        assertFailsWith<AppApiException> { decodeResultExport(exportOperation(), JsonObject(base + ("resources" to JsonArray(listOf(text, text)))), 1) }
        assertEquals(ApiErrorCode.REQUEST_EXPIRED, assertFailsWith<AppApiException> {
            decodeResultExport(exportOperation(), JsonObject(base + ("expiresAt" to JsonPrimitive("1970-01-01T00:00:00Z"))), 1)
        }.error.code)
    }
    @Test fun malformedChunksNeverReachTheSink() = runTest {
        val changes = listOf("instanceId" to JsonPrimitive("pc-a"), "sessionId" to JsonPrimitive("other"), "requestId" to JsonPrimitive("later"),
            "runId" to JsonPrimitive("later"), "finalRunId" to JsonPrimitive("later"), "revision" to JsonPrimitive("a".repeat(64)),
            "resourceId" to JsonPrimitive("reference_0"), "offset" to JsonPrimitive(1), "nextOffset" to JsonPrimitive(1),
            "eof" to JsonPrimitive(true), "eof" to JsonPrimitive("false"), "sizeBytes" to JsonPrimitive(1),
            "sha256" to JsonPrimitive("a".repeat(64)), "chunkSha256" to JsonPrimitive("a".repeat(64)), "dataBase64" to JsonPrimitive("!invalid"))
        for ((key, value) in changes) {
            val carrier = ExportCarrier(); val client = client(carrier); val manifest = client.readManifest(exportOperation()) {}; var received = 0
            carrier.transform = { path, body -> if ('?' in path) JsonObject(body + (key to value)) else body }
            assertFailsWith<AppApiException>(key) { client.stream(exportOperation(), manifest, "text", {}) { received++ } }
            assertEquals(0, received, key)
        }
    }
    @Test fun fullDigestIsRequiredEvenWhenEveryChunkDigestIsValid() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier)
        // The declared full digest agrees between manifest/chunks, but differs from their actual aggregate bytes.
        carrier.transform = { path, body -> if (path == "/api/result-export-contract") body else if ('?' in path || path.endsWith("exports")) {
            if ('?' in path) JsonObject(body + ("sha256" to JsonPrimitive("a".repeat(64)))) else {
                val text = body.getValue("resources").jsonArray.first().jsonObject
                JsonObject(body + ("resources" to JsonArray(listOf(JsonObject(text + ("sha256" to JsonPrimitive("a".repeat(64))))))))
            }
        } else body }
        val manifest = client.readManifest(exportOperation()) {}; var count = 0
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, assertFailsWith<AppApiException> { client.stream(exportOperation(), manifest, "text", {}) { count += it.size } }.error.code)
        assertEquals(carrier.payload.size, count) // Sink must keep this unpublished until success.
    }
    @Test fun cancellationAndRevocationStopTransferWithoutRetryOrClosingCarrier() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier); val manifest = client.readManifest(exportOperation()) {}
        var granted = true; var received = 0
        carrier.afterRequest = { if ('?' in carrier.requests.last().path) granted = false }
        val access: suspend () -> Unit = { if (!granted) throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "revoked")) }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { client.stream(exportOperation(), manifest, "text", access) { received++ } }.error.code)
        assertEquals(0, received); assertEquals(1, carrier.requests.count { '?' in it.path })
        val cancellation = ExportCarrier(); val cancellingClient = client(cancellation); val m = cancellingClient.readManifest(exportOperation()) {}
        assertFailsWith<CancellationException> { cancellingClient.stream(exportOperation(), m, "text", {}) { throw CancellationException("stop local download") } }
        assertEquals(1, cancellation.requests.count { '?' in it.path })
    }
    @Test fun oversizedResponsesAndUnavailableResourcesAreRejected() = runTest {
        val carrier = ExportCarrier(); val client = client(carrier); val manifest = client.readManifest(exportOperation()) {}
        val before = carrier.requests.size
        assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, assertFailsWith<AppApiException> { client.stream(exportOperation(), manifest, "reference_0", {}) {} }.error.code)
        assertEquals(before, carrier.requests.size)
        carrier.rawBody = "x".repeat(96 * 1024 + 1)
        carrier.rawBodyFor = { '?' in it }
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, assertFailsWith<AppApiException> { client.stream(exportOperation(), manifest, "text", {}) {} }.error.code)
        assertTrue('?' in carrier.requests.last().path)
    }
    @Test fun switchingTransportAndMismatchedOperationAreRejectedBeforeIo() = runTest {
        assertFailsWith<IllegalArgumentException> { ResultExportClient("pc-b", SwitchingRagentTransport(backgroundScope)) }
        val carrier = ExportCarrier()
        assertFailsWith<AppApiException> { client(carrier).readManifest(exportOperation().copy(targetInstanceId = "pc-a")) {} }
        assertTrue(carrier.requests.isEmpty())
    }
}
