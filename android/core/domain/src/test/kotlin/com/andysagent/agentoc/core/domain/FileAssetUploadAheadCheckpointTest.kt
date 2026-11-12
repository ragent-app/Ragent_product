package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import java.io.IOException
import java.security.MessageDigest
import kotlin.test.*

class FileAssetUploadAheadCheckpointTest {
    private val chunk = FileAssetUploadClient.UPLOAD_CHUNK_BYTES
    private val data = ByteArray(chunk * 3 + 17) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    private val input = FileUploadInput("ahead-request", "fixture.bin", "application/octet-stream", data.size.toLong(), sha)
    private val assetId = "fasset_${"a".repeat(24)}"

    private inner class Fixture(val firstAck: Long = chunk.toLong() * 2, val loseFirstReply: Boolean = false) : AgentoCTransport {
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Connected)
        val offsets = mutableListOf<Long>()
        var ready = false
        var checkpointOffset = 0L
        private fun asset() = buildJsonObject {
            put("id", assetId); put("sessionId", "s"); put("originalName", input.originalName)
            put("mimeType", input.mimeType); put("sizeBytes", input.sizeBytes); put("sha256", input.sha256)
            put("status", if (ready) "ready" else "pending_upload")
        }
        private fun checkpoint(offset: Long) = buildJsonObject {
            put("uploadCheckpointVersion", 1); put("assetId", assetId); put("offset", offset)
            put("totalBytes", input.sizeBytes); put("sha256", input.sha256); put("chunkBytes", chunk)
            put("status", if (offset == input.sizeBytes) "uploaded" else "uploading")
        }.toString()
        override suspend fun execute(request: ApiRequest): ApiResponse = when {
            request.path == "/api/asset-upload-contract" -> ApiResponse(200, """{"version":1,"maximumBytes":1073741824,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true}""")
            request.path.endsWith("/upload-checkpoint") -> ApiResponse(200, checkpoint(checkpointOffset))
            request.method == "GET" -> ApiResponse(404, """{"code":"FILE_ASSET_NOT_FOUND"}""")
            request.path == "/api/assets/upload-intents" -> ApiResponse(200, buildJsonObject {
                put("uploadContractVersion", 1); put("asset", asset())
                put("resumableUpload", buildJsonObject { put("version", 1); put("chunkBytes", chunk); put("checksum", "sha256"); put("fixedChunks", true) })
                put("upload", buildJsonObject { put("url", "/api/assets/$assetId/upload"); put("method", "POST"); put("headers", buildJsonObject { put("Content-Type", input.mimeType) }) })
            }.toString())
            request.method == "PATCH" -> {
                val offset = request.headers.getValue("X-Agentoc-Upload-Offset").toLong()
                offsets += offset
                val next = if (offset == 0L) firstAck else offset + requireNotNull(request.bodyBytes).size
                checkpointOffset = next
                if (offset == 0L && loseFirstReply) throw IOException("fixture reply lost after commit")
                ApiResponse(200, checkpoint(next))
            }
            request.path.endsWith("/finalize") -> { ready = true; ApiResponse(200, buildJsonObject { put("asset", asset()) }.toString()) }
            else -> error("Unexpected request ${request.method} ${request.path}")
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }

    @Test fun lostReplyRecoversWhenAnotherSenderHasAdvancedFurther() = runTest {
        val fixture = Fixture(loseFirstReply = true)
        val source = ApiRequestBodySource(input.sizeBytes, input.sha256) { data.inputStream() }
        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", input, source).ready)
        assertEquals(listOf(0L, chunk.toLong() * 2, chunk.toLong() * 3), fixture.offsets)
    }

    @Test fun advancesToServerCheckpointAndHashesSkippedBytes() = runTest {
        val fixture = Fixture()
        val source = ApiRequestBodySource(input.sizeBytes, input.sha256) { data.inputStream() }
        assertTrue(FileAssetUploadClient("pc", fixture).upload("s", input, source).ready)
        assertEquals(listOf(0L, chunk.toLong() * 2, chunk.toLong() * 3), fixture.offsets)
    }

    @Test fun rejectsMisalignedCheckpointAndChangedSkippedSource() = runTest {
        val malformed = Fixture(firstAck = chunk.toLong() + 1)
        assertFailsWith<IllegalStateException> {
            FileAssetUploadClient("pc", malformed).upload("s", input, ApiRequestBodySource(input.sizeBytes, input.sha256) { data.inputStream() })
        }
        val changed = data.copyOf().also { it[chunk + 1] = (it[chunk + 1] + 1).toByte() }
        val fixture = Fixture()
        assertFailsWith<IllegalStateException> {
            FileAssetUploadClient("pc", fixture).upload("s", input, ApiRequestBodySource(input.sizeBytes, input.sha256) { changed.inputStream() })
        }
        assertFalse(fixture.ready)
    }
}
