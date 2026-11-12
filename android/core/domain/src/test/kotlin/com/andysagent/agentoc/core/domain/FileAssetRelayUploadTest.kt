package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.yield
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.test.*

class FileAssetRelayUploadTest {
    private val bytes = "encrypted attachment".toByteArray()
    private val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private val assetId = "fasset_${"a".repeat(24)}"
    private val input = FileUploadInput("request", "test.txt", "text/plain", bytes.size.toLong(), hash)
    private val jobId = "b".repeat(32)

    private inner class Target(val finalizeWaits: Boolean = false, val failFirstFinalize: Boolean = false) : AgentoCTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
        var ready = false
        var deleted = false
        var relayStarted = false
        var statusRequests = 0
        var finalizeStarted = false
        var finalizeRequests = 0
        val relayCompleted = CompletableDeferred<Unit>()
        fun asset() = buildJsonObject {
            put("id", assetId); put("sessionId", "s"); put("originalName", input.originalName)
            put("mimeType", input.mimeType); put("sizeBytes", input.sizeBytes); put("sha256", hash)
            put("status", if (ready) "ready" else "pending_upload")
        }
        override suspend fun execute(request: ApiRequest): ApiResponse = when {
            request.path == "/api/asset-upload-contract" -> ApiResponse(200,
                """{"version":1,"maximumBytes":104857600,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true,"encryptedRelay":{"version":1,"recordBytes":262144,"finalizeWaitsForRelay":$finalizeWaits}}""")
            request.path.startsWith("/api/assets/upload-intents?") -> ApiResponse(404, """{"code":"FILE_ASSET_NOT_FOUND"}""")
            request.path == "/api/assets/upload-intents" -> ApiResponse(200, buildJsonObject {
                put("uploadContractVersion", 1); put("asset", asset())
                put("resumableUpload", buildJsonObject { put("version", 2); put("chunkBytes", 1048576); put("checksum", "sha256"); put("fixedChunks", true) })
                put("upload", buildJsonObject { put("method", "POST"); put("url", "/api/assets/$assetId/upload"); put("headers", buildJsonObject { put("Content-Type", "text/plain") }) })
            }.toString())
            request.method == "POST" && request.path.endsWith("/relay") -> {
                val body = Json.parseToJsonElement(request.body!!).jsonObject
                assertEquals("c".repeat(43), body["readToken"]!!.jsonPrimitive.content)
                assertFalse(request.body!!.contains("d".repeat(43))) // write capability stays on HTTPS
                relayStarted = true
                ApiResponse(202, """{"version":1,"jobId":"$jobId","status":"receiving"}""")
            }
            request.method == "GET" && request.path.contains("/relay?") -> { statusRequests++; ApiResponse(200,
                """{"version":1,"jobId":"$jobId","status":"received"}""") }
            request.method == "DELETE" && request.path.contains("/relay?") -> { deleted = true; ApiResponse(200, "{}") }
            request.path.endsWith("/finalize") -> {
                finalizeStarted = true
                finalizeRequests++
                if (failFirstFinalize && finalizeRequests == 1) throw IOException("simulated lost response")
                if (finalizeWaits) relayCompleted.await()
                ready = true
                ApiResponse(200, buildJsonObject { put("asset", asset()) }.toString())
            }
            else -> error("Unexpected request ${request.method} ${request.path}")
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }

    @Test fun `uploads encrypted records then waits for verified target receipt`() = runTest {
      for ((finalizeWaits, failFirst) in listOf(false to false, true to false, true to true)) {
        val target = Target(finalizeWaits, failFirst)
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) {
                assertTrue(target.relayStarted)
                val output = ByteArrayOutputStream()
                AttachmentRelayPayload.write(source, key, transferId, output, onProgress)
                assertContentEquals(bytes, FileAssetRelayCrypto.decrypt(key, transferId, source.sizeBytes, 0, output.toByteArray()))
                if (finalizeWaits) {
                    yield()
                    assertTrue(target.finalizeStarted, "finalize should overlap the transfer")
                    target.relayCompleted.complete(Unit)
                }
            }
        }
        val phases = mutableListOf<FileUploadProgress>()
        val result = FileAssetUploadClient("pc", target, relay).upload("s", input, bytes, onProgress = phases::add)
        assertTrue(result.ready); assertFalse(target.deleted) // Successful jobs are retired by target finalization.
        assertEquals(if (finalizeWaits) 0 else 1, target.statusRequests)
        assertEquals(if (failFirst) 2 else 1, target.finalizeRequests)
        assertTrue(phases.any { it.phase == FileUploadPhase.TRANSFERRING && it.writtenBytes == bytes.size.toLong() })
        assertEquals(FileUploadPhase.CONFIRMED, phases.last().phase)
      }
    }

    @Test fun `failed transfer cancels the pending finalize and relay job`() = runTest {
        val target = Target(finalizeWaits = true)
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) {
                yield()
                assertTrue(target.finalizeStarted)
                throw IOException("simulated transfer failure")
            }
        }
        assertFailsWith<IOException> { FileAssetUploadClient("pc", target, relay).upload("s", input, bytes) }
        assertFalse(target.ready)
        assertTrue(target.deleted)
    }
}
