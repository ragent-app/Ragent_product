package com.andysagent.agentoc.core.p2p

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64

/**
 * Bounded fragmentation for HTTP request JSON sent over SCTP DataChannel.
 * Small requests retain the original one-frame wire format. Large requests are
 * split into independently checked, ordered chunks so the browser/Go HTTP
 * contract remains unchanged after reassembly.
 */
internal object P2PHttpRequestStream {
    const val MAX_SINGLE_FRAME_BYTES = 48 * 1024
    const val CHUNK_BYTES = 32 * 1024
    const val MAX_STREAM_BYTES = 40 * 1024 * 1024

    private val json = Json { encodeDefaults = true }

    fun frames(requestId: String, payload: ByteArray): Sequence<ByteArray> {
        require(requestId.matches(Regex("^[A-Za-z0-9_-]{1,128}$"))) { "Invalid P2P request id" }
        require(payload.isNotEmpty()) { "P2P request frame is empty" }
        require(payload.size <= MAX_STREAM_BYTES) { "P2P request exceeds the transport limit" }
        if (payload.size <= MAX_SINGLE_FRAME_BYTES) return sequenceOf(payload)

        val digest = MessageDigest.getInstance("SHA-256").digest(payload)
            .joinToString("") { "%02x".format(it) }
        val chunks = (payload.size + CHUNK_BYTES - 1) / CHUNK_BYTES
        return sequence {
            var offset = 0
            var index = 0
            while (offset < payload.size) {
                val end = minOf(offset + CHUNK_BYTES, payload.size)
                val frame = P2PHttpRequestChunkFrame(
                    id = requestId,
                    index = index,
                    totalBytes = payload.size,
                    sha256 = digest,
                    dataBase64 = Base64.getEncoder().encodeToString(payload.copyOfRange(offset, end)),
                )
                yield(json.encodeToString(frame).toByteArray(Charsets.UTF_8))
                offset = end
                index++
            }
            check(index == chunks)
        }
    }

    fun decodeChunk(frame: ByteArray): P2PHttpRequestChunkFrame =
        json.decodeFromString(String(frame, Charsets.UTF_8))
}

@Serializable
internal data class P2PHttpRequestChunkFrame(
    val type: String = "http_request_stream_v1",
    val id: String,
    val index: Int,
    val totalBytes: Int,
    val sha256: String,
    val dataBase64: String,
)

/** v2 streams the raw HTTP entity separately from bounded request metadata. */
internal object P2PHttpBodyStream {
    const val MAX_BODY_BYTES = 25L * 1024 * 1024
    const val CHUNK_BYTES = 24 * 1024
    private val json = Json { encodeDefaults = true }

    fun initFrame(request: P2PHttpRequest, totalBytes: Long, sha256: String): ByteArray = json
        .encodeToString(P2PHttpBodyStreamInit.serializer(), P2PHttpBodyStreamInit(
            id = request.id, method = request.method, path = request.path,
            headers = request.headers, totalBytes = totalBytes, sha256 = sha256,
            acceptResponseStream = request.acceptResponseStream,
        )).toByteArray(Charsets.UTF_8)

    fun chunkFrame(id: String, index: Int, bytes: ByteArray): ByteArray = json
        .encodeToString(P2PHttpBodyStreamChunk.serializer(), P2PHttpBodyStreamChunk(
            id = id, index = index, dataBase64 = Base64.getEncoder().encodeToString(bytes),
        )).toByteArray(Charsets.UTF_8)

    /** Binary v3 frame: magic, id length, UTF-8 id, big-endian index, raw bytes. */
    fun binaryChunkFrame(id: String, index: Int, bytes: ByteArray): ByteArray {
        require(id.matches(Regex("^[A-Za-z0-9_-]{1,128}$")) && index >= 0)
        require(bytes.isNotEmpty() && bytes.size <= CHUNK_BYTES)
        val encodedId = id.toByteArray(Charsets.US_ASCII)
        return java.nio.ByteBuffer.allocate(5 + encodedId.size + 4 + bytes.size)
            .put(byteArrayOf(65, 71, 66, 51)).put(encodedId.size.toByte())
            .put(encodedId).putInt(index).put(bytes).array()
    }

    fun endFrame(id: String, chunkCount: Int, totalBytes: Long, sha256: String): ByteArray = json
        .encodeToString(P2PHttpBodyStreamEnd.serializer(), P2PHttpBodyStreamEnd(
            id = id, chunkCount = chunkCount, totalBytes = totalBytes, sha256 = sha256,
        )).toByteArray(Charsets.UTF_8)

    fun abortFrame(id: String): ByteArray = json
        .encodeToString(P2PHttpBodyStreamAbort.serializer(), P2PHttpBodyStreamAbort(id = id))
        .toByteArray(Charsets.UTF_8)

    /** Compatibility path for older peers that only understand request-frame v1. */
    fun readVerifiedBody(input: InputStream, totalBytes: Long, expectedSha256: String,
        onProgress: (sentBytes: Long, totalBytes: Long) -> Unit = { _, _ -> }): ByteArray {
        require(totalBytes in 1..MAX_BODY_BYTES)
        require(expectedSha256.matches(Regex("^[a-f0-9]{64}$")))
        val output = ByteArrayOutputStream(totalBytes.toInt())
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(CHUNK_BYTES)
        var readBytes = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            readBytes += count
            require(readBytes <= totalBytes) { "Streamed request body exceeded its declared length" }
            digest.update(buffer, 0, count)
            output.write(buffer, 0, count)
            runCatching { onProgress(readBytes, totalBytes) }
        }
        require(readBytes == totalBytes) { "Streamed request body did not match its declared length" }
        val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
        require(actualSha256 == expectedSha256) { "Streamed request body did not match its declared digest" }
        return output.toByteArray()
    }
}

@Serializable
internal data class P2PHttpBodyStreamInit(
    val type: String = "http_request_stream_v2_init",
    val id: String,
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val totalBytes: Long,
    val sha256: String,
    val acceptResponseStream: Boolean = false,
)

@Serializable
internal data class P2PHttpBodyStreamChunk(
    val type: String = "http_request_stream_v2_chunk",
    val id: String,
    val index: Int,
    val dataBase64: String,
)

@Serializable
internal data class P2PHttpBodyStreamEnd(
    val type: String = "http_request_stream_v2_end",
    val id: String,
    val chunkCount: Int,
    val totalBytes: Long,
    val sha256: String,
)

@Serializable
internal data class P2PHttpBodyStreamAbort(
    val type: String = "http_request_stream_v2_abort",
    val id: String,
)

@Serializable
internal data class P2PServerReadyFrame(
    val type: String = "",
    val version: Int = 0,
    val features: List<String> = emptyList(),
)
