package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
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

    private inner class Target(val finalizeWaits: Boolean = false, val failFirstFinalize: Boolean = false, val supportsCombined: Boolean = false, val failCombined: Boolean = false, val failRelayStart: Boolean = false, val combinedGate: CompletableDeferred<Unit>? = null, val combinedDelayMs: Long = 0, val relayStartGate: CompletableDeferred<Unit>? = null) : AgentoCTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
        var combinedRequests = 0
        var legacyRequests = 0
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
            request.path == "/api/assets/combined-upload-intents" -> {
                combinedRequests++
                if (combinedDelayMs > 0) delay(combinedDelayMs)
                combinedGate?.await()
                if (failCombined) throw IOException("simulated lost combined response")
                if (!supportsCombined) ApiResponse(404, "{}") else ApiResponse(200, buildJsonObject {
                    put("uploadContractVersion", 1); put("asset", asset())
                    put("combinedUploadContract", Json.parseToJsonElement("""{"version":1,"maximumBytes":104857600,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true,"encryptedRelay":{"version":1,"recordBytes":262144,"finalizeWaitsForRelay":$finalizeWaits}}"""))
                    put("resumableUpload", buildJsonObject { put("version", 2); put("chunkBytes", 1048576); put("checksum", "sha256"); put("fixedChunks", true) })
                    put("upload", buildJsonObject { put("method", "POST"); put("url", "/api/assets/$assetId/upload"); put("headers", buildJsonObject { put("Content-Type", "text/plain") }) })
                }.toString())
            }
            request.path == "/api/asset-upload-contract" -> { legacyRequests++; ApiResponse(200,
                """{"version":1,"maximumBytes":104857600,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true,"encryptedRelay":{"version":1,"recordBytes":262144,"finalizeWaitsForRelay":$finalizeWaits}}""") }
            request.path.startsWith("/api/assets/upload-intents?") -> ApiResponse(404, """{"code":"FILE_ASSET_NOT_FOUND"}""")
            request.path == "/api/assets/upload-intents" -> ApiResponse(200, buildJsonObject {
                put("uploadContractVersion", 1); put("asset", asset())
                put("resumableUpload", buildJsonObject { put("version", 2); put("chunkBytes", 1048576); put("checksum", "sha256"); put("fixedChunks", true) })
                put("upload", buildJsonObject { put("method", "POST"); put("url", "/api/assets/$assetId/upload"); put("headers", buildJsonObject { put("Content-Type", "text/plain") }) })
            }.toString())
            request.method == "POST" && request.path.endsWith("/relay") -> {
                relayStartGate?.await()
                if (failRelayStart) throw IOException("simulated relay start failure")
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
      for ((finalizeWaits, failFirst, combined) in listOf(Triple(false, false, false), Triple(true, false, false), Triple(true, true, false), Triple(true, false, true))) {
        val target = Target(finalizeWaits, failFirst, combined)
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
        val result = FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes, onProgress = phases::add)
        assertEquals(1, target.combinedRequests)
        assertEquals(if (combined) 0 else 1, target.legacyRequests)
        assertTrue(result.ready); assertFalse(target.deleted) // Successful jobs are retired by target finalization.
        assertEquals(if (finalizeWaits) 0 else 1, target.statusRequests)
        assertEquals(if (failFirst) 2 else 1, target.finalizeRequests)
        assertTrue(phases.any { it.phase == FileUploadPhase.TRANSFERRING && it.writtenBytes == bytes.size.toLong() })
        assertEquals(FileUploadPhase.CONFIRMED, phases.last().phase)
      }
    }

    @Test fun `lost combined response never falls back to a second intent`() = runTest {
        val target = Target(failCombined = true)
        val instance = "pc-${java.util.UUID.randomUUID()}"
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket = error("must not reserve")
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) = error("must not send")
        }
        assertFailsWith<IOException> { FileAssetUploadClient(instance, target, relay).upload("s", input, bytes) }
        assertEquals(1, target.combinedRequests)
        assertEquals(0, target.legacyRequests)
        val next = Target(failCombined = true)
        assertFailsWith<IOException> { FileAssetUploadClient(instance, next, relay).upload("s", input, bytes) }
        assertEquals(1, next.combinedRequests, "a lost response must not mark the endpoint absent")
    }

    @Test fun `failed transfer cancels the pending finalize and relay job`() = runTest {
        val target = Target(finalizeWaits = true)
        var reservationCancelled = false
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun cancel(ticket: AttachmentRelayTicket) { reservationCancelled = true }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) {
                yield()
                assertTrue(target.finalizeStarted)
                throw IOException("simulated transfer failure")
            }
        }
        assertFailsWith<IOException> { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
        assertFalse(target.ready)
        assertTrue(target.deleted)
        assertTrue(reservationCancelled)
    }

    @Test fun `old target is not probed again for the next attachment`() = runTest {
        val target = Target()
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) { onProgress(source.sizeBytes) }
        }
        val instance = "old-${java.util.UUID.randomUUID()}"
        assertTrue(FileAssetUploadClient(instance, target, relay).upload("s", input, bytes).ready)
        assertTrue(FileAssetUploadClient(instance, target, relay).upload("s", input.copy(requestId = "second"), bytes).ready)
        assertEquals(1, target.combinedRequests)
        assertEquals(2, target.legacyRequests)
    }

    @Test fun `failed relay start releases account reservation`() = runTest {
        val target = Target(failRelayStart = true)
        var cancelled = false
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun cancel(ticket: AttachmentRelayTicket) { cancelled = true }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) = error("must not send")
        }
        assertFailsWith<IOException> { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
        assertTrue(cancelled)
        assertFalse(target.deleted)
    }

    @Test fun `encrypted writer starts while target relay request is pending`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val writerStarted = CompletableDeferred<Unit>()
        val releaseWriter = CompletableDeferred<Unit>()
        val target = Target(finalizeWaits = true, supportsCombined = true, relayStartGate = gate)
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) {
                writerStarted.complete(Unit)
                releaseWriter.await()
                onProgress(source.sizeBytes)
                target.relayCompleted.complete(Unit)
            }
        }
        val upload = async { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
        writerStarted.await()
        assertFalse(target.relayStarted)
        gate.complete(Unit)
        releaseWriter.complete(Unit)
        assertTrue(upload.await().ready)
    }

    @Test fun `failed target start cancels an already started writer and reservation`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val writerStarted = CompletableDeferred<Unit>()
        var writerCancelled = false
        var reservationCancelled = false
        val target = Target(finalizeWaits = true, supportsCombined = true, failRelayStart = true, relayStartGate = gate)
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long) = AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            override suspend fun cancel(ticket: AttachmentRelayTicket) { reservationCancelled = true }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) {
                writerStarted.complete(Unit)
                try { awaitCancellation() } finally { writerCancelled = true }
            }
        }
        kotlinx.coroutines.supervisorScope {
            val upload = async { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
            writerStarted.await()
            gate.complete(Unit)
            assertFailsWith<IOException> { upload.await() }
        }
        assertTrue(writerCancelled)
        assertTrue(reservationCancelled)
        assertFalse(target.deleted)
    }

    @Test fun `preflight overlaps intent and reuses its reservation`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val target = Target(supportsCombined = true, combinedGate = gate)
        val preflightStarted = CompletableDeferred<Unit>()
        var oldReservations = 0
        var cancellations = 0
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket? { oldReservations++; return null }
            override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket {
                preflightStarted.complete(Unit)
                return AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            }
            override suspend fun cancel(ticket: AttachmentRelayTicket) { cancellations++ }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) { onProgress(source.sizeBytes) }
        }
        val upload = async { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
        preflightStarted.await()
        assertEquals(1, target.combinedRequests)
        gate.complete(Unit)
        assertTrue(upload.await().ready)
        assertEquals(0, oldReservations)
        assertEquals(0, cancellations)
    }

    @Test fun `failed intent releases completed speculative reservation`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val target = Target(failCombined = true, combinedGate = gate)
        val preflightStarted = CompletableDeferred<Unit>()
        var cancellations = 0
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket? = error("must not reserve legacy")
            override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket {
                preflightStarted.complete(Unit)
                return AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            }
            override suspend fun cancel(ticket: AttachmentRelayTicket) { cancellations++ }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) = error("must not send")
        }
        // Supervise the expected child failure so it does not cancel runTest.
        kotlinx.coroutines.supervisorScope {
            val upload = async { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
            preflightStarted.await()
            gate.complete(Unit)
            assertFailsWith<IOException> { upload.await() }
        }
        assertEquals(1, cancellations)
    }

    @Test fun `unavailable preflight falls back to established relay`() = runTest {
        val target = Target(supportsCombined = true)
        var legacyReservations = 0
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket? = throw IOException("preflight unavailable")
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket {
                legacyReservations++
                return AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) { onProgress(source.sizeBytes) }
        }
        assertTrue(FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes).ready)
        assertEquals(1, legacyReservations)
    }

    @Test fun `caller cancellation cancels in-flight preflight`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val target = Target(supportsCombined = true, combinedGate = gate)
        val started = CompletableDeferred<Unit>()
        var cleaned = false
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket? = error("must not reserve legacy")
            override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket? {
                started.complete(Unit)
                try { awaitCancellation() } finally { cleaned = true }
            }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) = error("must not send")
        }
        val upload = async { FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes) }
        started.await()
        upload.cancelAndJoin()
        assertTrue(cleaned)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun `independent preparation delays overlap rather than add`() = runTest {
        val target = Target(supportsCombined = true, combinedDelayMs = 1000)
        val relay = object : AttachmentRelayTransport {
            override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket? = error("must use preflight")
            override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket {
                delay(1000)
                return AttachmentRelayTicket("a".repeat(32), "d".repeat(43), "c".repeat(43), sizeBytes)
            }
            override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
                transferId: String, onProgress: (Long) -> Unit) { onProgress(source.sizeBytes) }
        }
        val start = testScheduler.currentTime
        assertTrue(FileAssetUploadClient("pc-${java.util.UUID.randomUUID()}", target, relay).upload("s", input, bytes).ready)
        assertEquals(1000L, testScheduler.currentTime - start)
    }
}
