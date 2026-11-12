package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import java.security.MessageDigest
import kotlin.test.*

class FileAssetConcurrentCheckpointTest {
    @Test fun advancedDurableCheckpointSkipsOnlyVerifiedSourceBytes() = runTest {
        val chunk = FileAssetUploadClient.UPLOAD_CHUNK_BYTES
        val data = ByteArray(chunk * 3 + 13) { (it % 251).toByte() }
        val sha = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
        val input = FileUploadInput("concurrent-test", "test.bin", "application/octet-stream", data.size.toLong(), sha)
        val id = "fasset_${"a".repeat(24)}"
        val offsets = mutableListOf<Long>()
        var finalized = false
        val transport = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Connected)
            fun asset(ready: Boolean) = buildJsonObject {
                put("id", id); put("sessionId", "s"); put("originalName", input.originalName)
                put("mimeType", input.mimeType); put("sizeBytes", input.sizeBytes); put("sha256", sha)
                put("status", if (ready) "ready" else "pending_upload")
            }
            fun checkpoint(offset: Long) = buildJsonObject {
                put("uploadCheckpointVersion", 1); put("assetId", id); put("offset", offset)
                put("totalBytes", input.sizeBytes); put("sha256", sha); put("chunkBytes", chunk)
                put("status", if (offset == input.sizeBytes) "uploaded" else "uploading")
            }
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.path == "/api/asset-upload-contract" -> ApiResponse(200,
                    """{"version":1,"maximumBytes":1073741824,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true}""")
                request.path.endsWith("/upload-checkpoint") -> ApiResponse(200, checkpoint(0).toString())
                request.method == "GET" -> ApiResponse(404, """{"code":"FILE_ASSET_NOT_FOUND"}""")
                request.path == "/api/assets/upload-intents" -> ApiResponse(200, buildJsonObject {
                    put("uploadContractVersion", 1); put("asset", asset(false))
                    put("resumableUpload", buildJsonObject { put("version", 1); put("chunkBytes", chunk); put("checksum", "sha256"); put("fixedChunks", true) })
                    put("upload", buildJsonObject { put("url", "/api/assets/$id/upload"); put("method", "POST"); put("headers", buildJsonObject { put("Content-Type", input.mimeType) }) })
                }.toString())
                request.method == "PATCH" -> {
                    val offset = request.headers.getValue("X-Agentoc-Upload-Offset").toLong()
                    offsets += offset
                    val body = requireNotNull(request.bodyBytes)
                    assertContentEquals(data.copyOfRange(offset.toInt(), offset.toInt() + body.size), body)
                    // The other execution has committed two complete chunks when our first receipt arrives.
                    val confirmed = if (offset == 0L) (2L * chunk) else offset + body.size
                    ApiResponse(200, checkpoint(confirmed).toString())
                }
                request.path.endsWith("/finalize") -> {
                    finalized = true
                    ApiResponse(200, buildJsonObject { put("asset", asset(true)) }.toString())
                }
                else -> error("Unexpected request ${request.method} ${request.path}")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val source = ApiRequestBodySource(input.sizeBytes, sha) { data.inputStream() }
        assertTrue(FileAssetUploadClient("pc", transport).upload("s", input, source).ready)
        assertEquals(listOf(0L, chunk * 2L, chunk * 3L), offsets)
        assertTrue(finalized)
    }
}
