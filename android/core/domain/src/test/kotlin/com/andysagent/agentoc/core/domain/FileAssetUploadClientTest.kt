package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.test.*

class FileAssetUploadClientTest {
    private val bytes = "手机共享附件".toByteArray()
    private val input = FileUploadInput("capture:r1", "sample.txt", "text/plain", bytes.size.toLong(),
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
    private val assetId = "fasset_${"a".repeat(24)}"

    private inner class Fixture : AgentoCTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Connected)
        val requests = mutableListOf<ApiRequest>()
        var pending = false
        var ready = false
        var lose = ""
        var unsupported = false
        var scoped = false
        var scopeMarker = true
        var unknown404 = false
        var resumable = false
        var negotiatedChunkBytes = FileAssetUploadClient.UPLOAD_CHUNK_BYTES
        var failChunksBeforePersist = 0
        var checkpointOffset = 0L
        var uploadInput = input
        val chunkBody = ByteArrayOutputStream()
        var corruptAsset: (JsonObject) -> JsonObject = { it }
        var destination = "/api/assets/$assetId/upload"
        var method = "POST"
        var uploadHeaders = mapOf("Content-Type" to "text/plain")
        var beforeLookup: () -> Unit = {}
        var postedBytes: ByteArray? = null
        var measuredBody = false
        var lost = false
        var retainPatchRequests = true
        var discardChunkBytes = false
        var patchCount = 0
        var largestPatchBytes = 0
        val patchOffsets = mutableListOf<Long>()
        fun asset() = corruptAsset(buildJsonObject {
            put("id", assetId); put("sessionId", "s"); put("originalName", uploadInput.originalName)
            put("mimeType", uploadInput.mimeType); put("sizeBytes", uploadInput.sizeBytes); put("sha256", uploadInput.sha256)
            put("status", if (ready) "ready" else "pending_upload")
            if (scoped && scopeMarker) put("scopeContractVersion", 1)
        })
        override suspend fun execute(request: ApiRequest): ApiResponse {
            if (request.method != "PATCH" || retainPatchRequests) requests += request
            val response = when {
                request.path == "/api/session-scope-contract" -> ApiResponse(200, if (scoped) scopeContractFixture() else """{"version":0}""")
                request.path == "/api/asset-upload-contract" -> if (unsupported) ApiResponse(200, """{"version":0}""")
                    else ApiResponse(200, """{"version":1,"maximumBytes":${FileAssetUploadClient.MAXIMUM_BYTES},"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true}""")
                request.path.endsWith("/upload-checkpoint") -> ApiResponse(200, checkpoint().toString())
                request.method == "PATCH" -> {
                    if (failChunksBeforePersist > 0) {
                        failChunksBeforePersist--
                        throw ApiException(503, "TEMPORARY_UNAVAILABLE", "Temporary upload failure")
                    }
                    val offset = request.headers.getValue("X-Agentoc-Upload-Offset").toLong()
                    patchOffsets += offset
                    patchCount++
                    assertEquals(checkpointOffset, offset)
                    assertEquals("application/octet-stream", request.contentType)
                    val chunk = request.bodyBytes!!
                    largestPatchBytes = maxOf(largestPatchBytes, chunk.size)
                    assertEquals(chunk.size.toString(), request.headers.getValue("X-Agentoc-Upload-Length"))
                    assertEquals(MessageDigest.getInstance("SHA-256").digest(chunk).joinToString("") { "%02x".format(it) },
                        request.headers.getValue("X-Agentoc-Upload-Sha256"))
                    if (!discardChunkBytes) chunkBody.write(chunk)
                    checkpointOffset += chunk.size.toLong()
                    ApiResponse(200, checkpoint().toString())
                }
                request.method == "GET" -> {
                    beforeLookup()
                    if (!pending) return ApiResponse(404, if (unknown404) "{}" else """{"code":"FILE_ASSET_NOT_FOUND"}""")
                    ApiResponse(200, buildJsonObject { put("uploadContractVersion", 1); put("asset", asset()) }.toString())
                }
                request.path == "/api/assets/upload-intents" -> {
                    pending = true
                    val intentBody = Json.parseToJsonElement(request.body!!).jsonObject
                    assertEquals(uploadInput.requestId, intentBody["requestId"]!!.jsonPrimitive.content)
                    assertEquals(uploadInput.quotaBatchId ?: uploadInput.requestId,
                        intentBody["quotaBatchId"]!!.jsonPrimitive.content)
                    ApiResponse(200, buildJsonObject {
                        put("uploadContractVersion", 1); put("asset", asset())
                        if (resumable) put("resumableUpload", buildJsonObject {
                            put("version", if (negotiatedChunkBytes == FileAssetUploadClient.UPLOAD_BATCH_BYTES) 2 else 1)
                            put("chunkBytes", negotiatedChunkBytes)
                            put("checksum", "sha256"); put("fixedChunks", true)
                        })
                        put("upload", buildJsonObject {
                            put("url", destination); put("method", method)
                            put("headers", buildJsonObject { uploadHeaders.forEach { (key, value) -> put(key, value) } })
                        })
                    }.toString())
                }
                request.path.endsWith("/finalize") -> {
                    ready = true
                    ApiResponse(200, buildJsonObject { put("asset", asset()) }.toString())
                }
                else -> {
                    postedBytes = request.bodyBytes
                    if (measuredBody) {
                        request.onBodyBytesWritten?.invoke(0)
                        request.onBodyBytesWritten?.invoke(bytes.size.toLong())
                    }
                    ApiResponse(200, "", mapOf("ETag" to "\"blob-etag\""))
                }
            }
            if (!lost && request.path == lose) { lost = true; throw IOException("Acknowledgement lost") }
            return response
        }
        private fun checkpoint() = buildJsonObject {
            put("uploadCheckpointVersion", 1); put("assetId", assetId); put("offset", checkpointOffset)
            put("totalBytes", uploadInput.sizeBytes); put("sha256", uploadInput.sha256)
            put("chunkBytes", negotiatedChunkBytes)
            put("status", if (checkpointOffset == uploadInput.sizeBytes) "uploaded" else "uploading")
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }

    private val scope = SessionScopeCondition("s", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "project-a")

    @Test fun progressSeparatesMeasuredWritesVerificationAndConfirmedReceipt() = runTest {
        val wire = Fixture().apply { measuredBody = true }
        val observed = mutableListOf<FileUploadProgress>()
        FileAssetUploadClient("pc", wire).upload("s", input, bytes, onProgress = {
            observed += it
            if (it.phase == FileUploadPhase.CONFIRMED) assertTrue(wire.ready)
        })
        assertEquals(listOf(FileUploadPhase.CHECKING, FileUploadPhase.PREPARING, FileUploadPhase.TRANSFERRING,
            FileUploadPhase.TRANSFERRING, FileUploadPhase.TRANSFERRING, FileUploadPhase.VERIFYING, FileUploadPhase.CONFIRMED), observed.map { it.phase })
        assertNull(observed[2].writtenBytes)
        assertEquals(listOf(0L, bytes.size.toLong(), bytes.size.toLong()), observed.mapNotNull { it.writtenBytes })
        assertTrue(observed.all { it.totalBytes == input.sizeBytes })
    }

    @Test fun reopenableSourceUsesBoundedResumableChunksAndRecoversLostChunkReply() = runTest {
        val content = ByteArray(FileAssetUploadClient.UPLOAD_CHUNK_BYTES * 2 + 19) { (it % 251).toByte() }
        val file = input.copy(requestId = "capture:large", sizeBytes = content.size.toLong(),
            sha256 = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) })
        val fixture = Fixture().apply { resumable = true; uploadInput = file; lose = "/api/assets/$assetId/upload" }
        val client = FileAssetUploadClient("pc", fixture)
        val source = com.andysagent.agentoc.core.network.ApiRequestBodySource(file.sizeBytes, file.sha256) {
            ByteArrayInputStream(content)
        }
        assertTrue(client.upload("s", file, source).ready)
        assertEquals(file.sizeBytes, fixture.checkpointOffset)
        assertTrue(fixture.requests.filter { it.method == "PATCH" }.all { it.bodyBytes!!.size <= FileAssetUploadClient.UPLOAD_CHUNK_BYTES })
        val resumedPatches = fixture.requests.filter { it.method == "PATCH" }
        assertEquals(listOf(0L, FileAssetUploadClient.UPLOAD_CHUNK_BYTES.toLong(), FileAssetUploadClient.UPLOAD_CHUNK_BYTES.toLong() * 2),
            resumedPatches.map { it.headers.getValue("X-Agentoc-Upload-Offset").toLong() })
        assertContentEquals(content, fixture.chunkBody.toByteArray())
        assertTrue(fixture.requests.any { it.path.endsWith("/upload-checkpoint") })
    }

    @Test fun negotiatedBatchRetainsDurableOffsetAfterLostReply() = runTest {
        val content = ByteArray(FileAssetUploadClient.UPLOAD_BATCH_BYTES * 2 + 19) { (it % 251).toByte() }
        val file = input.copy(sizeBytes = content.size.toLong(), sha256 = MessageDigest.getInstance("SHA-256")
            .digest(content).joinToString("") { "%02x".format(it) })
        val fixture = Fixture().apply {
            resumable = true; negotiatedChunkBytes = FileAssetUploadClient.UPLOAD_BATCH_BYTES
            uploadInput = file; lose = "/api/assets/$assetId/upload"
        }
        val source = ApiRequestBodySource(file.sizeBytes, file.sha256) { content.inputStream() }
        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", file, source).ready)
        assertEquals(listOf(0L, FileAssetUploadClient.UPLOAD_BATCH_BYTES.toLong(),
            FileAssetUploadClient.UPLOAD_BATCH_BYTES.toLong() * 2), fixture.patchOffsets)
        assertTrue(content.contentEquals(fixture.chunkBody.toByteArray()))
        assertTrue(fixture.requests.any { it.path.endsWith("/upload-checkpoint") })
    }

    @Test fun retryAfterTransientChunkFailureUsesServerCheckpointAndResendsSameChunk() = runTest {
        val fixture = Fixture().apply { resumable = true; failChunksBeforePersist = 1 }
        val progress = mutableListOf<FileUploadProgress>()
        val source = com.andysagent.agentoc.core.network.ApiRequestBodySource(input.sizeBytes, input.sha256) {
            ByteArrayInputStream(bytes)
        }
        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", input, source, onProgress = progress::add).ready)
        assertEquals(0L, progress.single { it.phase == FileUploadPhase.RETRYING }.writtenBytes)
        assertEquals(bytes.size.toLong(), fixture.checkpointOffset)
        assertEquals(listOf(0L, 0L), fixture.requests.filter { it.method == "PATCH" }
            .map { it.headers.getValue("X-Agentoc-Upload-Offset").toLong() })
        assertContentEquals(bytes, fixture.chunkBody.toByteArray())
    }

    @Test fun oneGiBBoundaryIsAcceptedWithoutAllocatingTheAttachment() = runTest {
        val fixture = Fixture()
        val maximum = input.copy(requestId = "capture:one-gib", sizeBytes = FileAssetUploadClient.MAXIMUM_BYTES,
            sha256 = "a".repeat(64))
        assertNull(FileAssetUploadClient("pc", fixture).findReceipt("s", maximum))
        assertTrue(fixture.requests.all { it.method == "GET" })
        fixture.requests.clear()
        assertFailsWith<IllegalArgumentException> {
            FileAssetUploadClient("pc", fixture).findReceipt("s", maximum.copy(sizeBytes = maximum.sizeBytes + 1))
        }
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun oneGiBStreamingTransferOnlyRetainsOneBoundedChunkAtATime() = runTest {
        val totalBytes = FileAssetUploadClient.MAXIMUM_BYTES
        val block = ByteArray(64 * 1024)
        val digest = MessageDigest.getInstance("SHA-256")
        var hashed = 0L
        while (hashed < totalBytes) {
            val count = minOf(block.size.toLong(), totalBytes - hashed).toInt()
            digest.update(block, 0, count)
            hashed += count
        }
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
        val file = input.copy(requestId = "capture:streaming-one-gib", sizeBytes = totalBytes, sha256 = sha256)
        val fixture = Fixture().apply {
            resumable = true; uploadInput = file; retainPatchRequests = false; discardChunkBytes = true
        }
        val source = com.andysagent.agentoc.core.network.ApiRequestBodySource(totalBytes, sha256) {
            ZeroInputStream(totalBytes)
        }

        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", file, source).ready)
        assertEquals(totalBytes, fixture.checkpointOffset)
        assertEquals(totalBytes / FileAssetUploadClient.UPLOAD_CHUNK_BYTES, fixture.patchCount.toLong())
        assertEquals(0L, fixture.patchOffsets.first())
        assertEquals(totalBytes - FileAssetUploadClient.UPLOAD_CHUNK_BYTES, fixture.patchOffsets.last())
        assertTrue(fixture.largestPatchBytes <= FileAssetUploadClient.UPLOAD_CHUNK_BYTES)
        assertTrue(fixture.chunkBody.size() == 0)
    }

    @Test fun carrierWithoutMeasurementStaysUnknownAndLostFinalizeDoesNotConfirmUntilLookup() = runTest {
        val wire = Fixture().apply { lose = "/api/assets/$assetId/finalize" }
        val client = FileAssetUploadClient("pc", wire)
        val observed = mutableListOf<FileUploadProgress>()
        assertFailsWith<IOException> { client.upload("s", input, bytes, onProgress = observed::add) }
        assertTrue(observed.filter { it.phase != FileUploadPhase.VERIFYING }.all { it.writtenBytes == null })
        assertEquals(bytes.size.toLong(), observed.last().writtenBytes)
        assertEquals(FileUploadPhase.VERIFYING, observed.last().phase)
        assertTrue(observed.none { it.phase == FileUploadPhase.CONFIRMED })
        observed.clear(); wire.requests.clear()
        client.upload("s", input, bytes, onProgress = observed::add)
        assertEquals(listOf(FileUploadPhase.CHECKING, FileUploadPhase.CONFIRMED), observed.map { it.phase })
        assertTrue(wire.requests.all { it.method == "GET" })
    }

    @Test fun observerFailureCannotBypassOrInvalidateVerifiedReceipt() = runTest {
        val wire = Fixture()
        assertTrue(FileAssetUploadClient("pc", wire).upload("s", input, bytes,
            onProgress = { error("Detached UI") }).ready)
        wire.corruptAsset = { JsonObject(it + ("sha256" to JsonPrimitive("b".repeat(64)))) }
        val phases = mutableListOf<FileUploadPhase>()
        assertFailsWith<IllegalStateException> {
            FileAssetUploadClient("pc", wire).upload("s", input, bytes, onProgress = { phases += it.phase })
        }
        assertFalse(FileUploadPhase.CONFIRMED in phases)
    }

    @Test fun scopedControlPlaneStagesUseOriginalCondition() = runTest {
        val wire = Fixture().apply { scoped = true }
        val asset = FileAssetUploadClient("pc", wire).upload("s", input, bytes, scope)
        assertTrue(asset.ready); assertEquals(1, asset.scopeContractVersion)
        val guarded = wire.requests.filter { it.path.startsWith("/api/assets/") }
        assertEquals(4, guarded.size)
        guarded.forEach { assertEquals(scope.headers(), it.headers.filterKeys { key -> key == SessionScopeCondition.HEADER }) }
    }

    @Test fun scopedObjectPutNeverReceivesConditionOrPcIdentity() = runTest {
        val wire = Fixture().apply { scoped = true; destination = "https://objects.example.test/signed"; method = "PUT" }
        FileAssetUploadClient("pc", wire).upload("s", input, bytes, scope)
        val put = wire.requests.single { it.method == "PUT" }
        assertEquals(mapOf("Content-Type" to input.mimeType), put.headers)
        assertNull(put.requestId); assertNull(put.idempotencyKey)
        assertEquals(scope.headers(), wire.requests.last().headers)
    }

    @Test fun scopedReadyReceiptCannotBeDowngradedToLegacy() = runTest {
        val wire = Fixture().apply { scoped = true; scopeMarker = false; pending = true; ready = true }
        assertFailsWith<IllegalStateException> { FileAssetUploadClient("pc", wire).upload("s", input, bytes, scope) }
        assertTrue(wire.requests.all { it.method == "GET" })
    }

    @Test fun lostScopedFinalizeIsRecoveredByReadonlyOriginalReceipt() = runTest {
        val wire = Fixture().apply { scoped = true; lose = "/api/assets/$assetId/finalize" }
        val client = FileAssetUploadClient("pc", wire)
        assertFailsWith<IOException> { client.upload("s", input, bytes, scope) }
        wire.requests.clear()
        assertTrue(client.findReceipt("s", input, scope)!!.ready)
        assertTrue(wire.requests.all { it.method == "GET" })
        assertEquals(scope.headers(), wire.requests.last().headers)
    }

    @Test fun revocationDuringUploadStopsBeforeFinalization() = runTest {
        val wire = Fixture().apply { scoped = true }
        assertFailsWith<IllegalStateException> {
            FileAssetUploadClient("pc", wire).upload("s", input, bytes, scope) {
                check(wire.postedBytes == null) { "Caller revoked while body was transferred" }
            }
        }
        assertFalse(wire.requests.any { it.path.endsWith("/finalize") })
    }

    @Test fun unsupportedScopedUploadCannotMintIntentOrUseLegacyFallback() = runTest {
        val wire = Fixture()
        assertFailsWith<ApiException> { FileAssetUploadClient("pc", wire).upload("s", input, bytes, scope) }
        assertEquals(listOf("/api/session-scope-contract"), wire.requests.map { it.path })
    }

    @Test fun explicitUploadUsesExactMetadataAndFixedTarget() = runTest {
        val fixture = Fixture()
        val receipt = FileAssetUploadClient("pc-b", fixture).upload("s", input, bytes)
        assertEquals("pc-b", receipt.instanceId)
        assertEquals("s", receipt.sessionId)
        assertTrue(receipt.ready)
        assertContentEquals(bytes, fixture.postedBytes)
        assertEquals(listOf("GET", "GET", "POST", "POST", "POST"), fixture.requests.map { it.method })
        assertTrue(fixture.requests.none { "/messages" in it.path || "/api/sessions" == it.path })
        assertTrue(fixture.requests[1].path.endsWith("requestId=capture%3Ar1"))
        assertEquals("\"blob-etag\"", Json.parseToJsonElement(fixture.requests.last().body!!).jsonObject["etag"]!!.jsonPrimitive.content)
    }

    @Test fun readonlyReceiptCannotCreateIntentOrUploadCredentials() = runTest {
        val fixture = Fixture().apply { pending = true }
        val client = FileAssetUploadClient("pc", fixture)
        assertFalse(client.findReceipt("s", input)!!.ready)
        assertTrue(fixture.requests.all { it.method == "GET" })
        fixture.ready = true
        val before = fixture.requests.size
        assertTrue(client.upload("s", input, bytes).ready)
        assertEquals(listOf("GET", "GET"), fixture.requests.drop(before).map { it.method })
        assertNull(fixture.postedBytes)
    }

    @Test fun finalizationReplyLossRestoresThroughOnlyReads() = runTest {
        val fixture = Fixture().apply { lose = "/api/assets/$assetId/finalize" }
        val client = FileAssetUploadClient("pc", fixture)
        assertFailsWith<IOException> { client.upload("s", input, bytes) }
        val before = fixture.requests.size
        assertTrue(client.upload("s", input, bytes).ready)
        assertEquals(listOf("GET", "GET"), fixture.requests.drop(before).map { it.method })
        assertEquals(1, fixture.requests.count { it.path.endsWith("/finalize") })
    }

    @Test fun intentReplyLossRetainsStableIdentityForExplicitRetry() = runTest {
        val fixture = Fixture().apply { lose = "/api/assets/upload-intents" }
        val client = FileAssetUploadClient("pc", fixture)
        assertFailsWith<IOException> { client.upload("s", input, bytes) }
        assertNull(fixture.postedBytes)
        assertTrue(client.upload("s", input, bytes).ready)
        val intents = fixture.requests.filter { it.path == "/api/assets/upload-intents" }
        assertEquals(2, intents.size)
        assertEquals(intents.first().body, intents.last().body)
    }

    @Test fun unsupportedOrAmbiguousTargetCannotReceiveAnyPosts() = runTest {
        val old = Fixture().apply { unsupported = true }
        assertFailsWith<IllegalStateException> { FileAssetUploadClient("pc", old).upload("s", input, bytes) }
        assertEquals(listOf("GET"), old.requests.map { it.method })
        val missing = Fixture().apply { unknown404 = true }
        assertFailsWith<ApiException> { FileAssetUploadClient("pc", missing).upload("s", input, bytes) }
        assertEquals(listOf("GET", "GET"), missing.requests.map { it.method })
        assertFailsWith<IllegalArgumentException> { FileAssetUploadClient("pc", SwitchingAgentoCTransport(backgroundScope)) }
    }

    @Test fun invalidInputOrChangedLocalBytesFailBeforeContactingPc() = runTest {
        val fixture = Fixture()
        val client = FileAssetUploadClient("pc", fixture)
        assertFailsWith<IllegalArgumentException> { client.upload("s", input, ByteArray(bytes.size)) }
        for (invalid in listOf(input.copy(requestId = ""), input.copy(originalName = "../secret"),
            input.copy(originalName = "evil\nfile"), input.copy(sizeBytes = 0), input.copy(sha256 = "bad"))) {
            assertFailsWith<IllegalArgumentException> { client.findReceipt("s", invalid) }
        }
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun receiptMismatchCannotAuthorizeAnotherAssetOrSendBytes() = runTest {
        for ((key, value) in listOf("sessionId" to "other", "id" to "asset-invalid", "originalName" to "other.txt",
            "mimeType" to "application/pdf", "sha256" to "0".repeat(64), "status" to "unknown")) {
            val fixture = Fixture().apply {
                pending = true
                corruptAsset = { JsonObject(it + (key to JsonPrimitive(value))) }
            }
            assertFailsWith<IllegalStateException> { FileAssetUploadClient("pc", fixture).upload("s", input, bytes) }
            assertTrue(fixture.requests.all { it.method == "GET" })
        }
    }

    @Test fun untrustedUploadDestinationsAndHeadersCannotReceiveBytes() = runTest {
        for ((method, path, headers) in listOf(
            Triple("POST", "/api/sessions/s/messages", mapOf("Content-Type" to "text/plain")),
            Triple("PUT", "https://user:password@example.test/blob", mapOf("Content-Type" to "text/plain")),
            Triple("PUT", "file:///storage/secret", mapOf("Content-Type" to "text/plain")),
            Triple("POST", "/api/assets/$assetId/upload", mapOf("Authorization" to "secret")),
        )) {
            val fixture = Fixture().apply { this.method = method; destination = path; uploadHeaders = headers }
            assertFailsWith<IllegalStateException> { FileAssetUploadClient("pc", fixture).upload("s", input, bytes) }
            assertNull(fixture.postedBytes)
            assertEquals(1, fixture.requests.count { it.method == "POST" })
        }
    }

    @Test fun signedPutUsesDetachedBytesAndThenBoundFinalize() = runTest {
        val mutableBytes = bytes.copyOf()
        val fixture = Fixture().apply {
            method = "PUT"; destination = "https://storage.example.test/blob?signature=opaque"
            beforeLookup = { mutableBytes.fill(0) }
        }
        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", input, mutableBytes).ready)
        assertContentEquals(bytes, fixture.postedBytes)
        val put = fixture.requests.single { it.method == "PUT" }
        assertEquals(mapOf("Content-Type" to "text/plain"), put.headers)
        assertNull(put.idempotencyKey)
        assertNull(put.requestId)
        assertEquals("/api/assets/$assetId/finalize", fixture.requests.last().path)
    }
}

private class ZeroInputStream(private var remaining: Long) : java.io.InputStream() {
    override fun read(): Int {
        if (remaining <= 0) return -1
        remaining--
        return 0
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining <= 0) return -1
        val count = minOf(length.toLong(), remaining).toInt()
        java.util.Arrays.fill(buffer, offset, offset + count, 0.toByte())
        remaining -= count
        return count
    }
}
