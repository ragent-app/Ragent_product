package com.andysagent.ragent.core.p2p

import kotlinx.serialization.Serializable
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.GZIPInputStream

@Serializable
internal data class P2PHttpResponseBinaryHeadFrame(
    val type: String,
    val id: String,
    val status: Int = 0,
    val headers: Map<String, String> = emptyMap(),
    val error: String? = null,
    val totalBytes: Int = 0,
    val sha256: String = "",
    val bodyEncoding: String = "identity",
)

internal data class ParsedAgr2Frame(
    val id: String,
    val index: Int,
    val payload: ByteArray,
)

/** Reassembles `http_response_binary_v2_head` + `"AGR2"` binary chunks with SHA-256 and bounded gzip gunzip. */
internal class P2PBinaryResponseAssembler {
    companion object {
        const val MAX_WIRE_BYTES = 12 * 1024 * 1024
        const val MAX_DECODED_BYTES = 24 * 1024 * 1024
        const val MAX_AGGREGATE_BYTES = 24 * 1024 * 1024
        const val CHUNK_BYTES = 24 * 1024
        private val REQUEST_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val DIGEST = Regex("^[a-f0-9]{64}$")

        fun isAgr2Frame(bytes: ByteArray): Boolean =
            bytes.size >= 10 &&
                bytes[0] == 'A'.code.toByte() &&
                bytes[1] == 'G'.code.toByte() &&
                bytes[2] == 'R'.code.toByte() &&
                bytes[3] == '2'.code.toByte()

        fun parseAgr2Frame(bytes: ByteArray): ParsedAgr2Frame {
            require(isAgr2Frame(bytes)) { "Invalid AGR2 binary frame magic" }
            val idLen = bytes[4].toInt() and 0xff
            val headerLen = 5 + idLen + 4
            require(idLen in 1..128 && bytes.size >= headerLen) { "Invalid AGR2 frame bounds" }
            val id = String(bytes, 5, idLen, Charsets.UTF_8)
            require(REQUEST_ID.matches(id)) { "Invalid AGR2 response id" }
            val index = ByteBuffer.wrap(bytes, 5 + idLen, 4).int
            require(index >= 0) { "Negative AGR2 chunk index" }
            val payload = bytes.copyOfRange(headerLen, bytes.size)
            require(payload.size <= CHUNK_BYTES) { "AGR2 chunk exceeds max chunk size" }
            return ParsedAgr2Frame(id = id, index = index, payload = payload)
        }

        private fun gunzipBounded(compressed: ByteArray): ByteArray {
            val out = ByteArrayOutputStream(minOf(compressed.size * 3, 64 * 1024))
            val buffer = ByteArray(16 * 1024)
            GZIPInputStream(ByteArrayInputStream(compressed)).use { gz ->
                while (true) {
                    val read = gz.read(buffer)
                    if (read < 0) break
                    require(out.size() + read <= MAX_DECODED_BYTES) { "Decoded gzip response exceeded max limit" }
                    out.write(buffer, 0, read)
                }
            }
            return out.toByteArray()
        }
    }

    private class Transfer(val head: P2PHttpResponseBinaryHeadFrame) {
        var nextIndex = 0
        val bytes = ByteArrayOutputStream(minOf(head.totalBytes, 64 * 1024))
    }

    private val transfers = mutableMapOf<String, Transfer>()
    private var reserved = 0

    @Synchronized
    fun begin(head: P2PHttpResponseBinaryHeadFrame): P2PHttpResponse? {
        require(head.type == "http_response_binary_v2_head" && REQUEST_ID.matches(head.id)) {
            "Invalid binary response head identity"
        }
        require(head.totalBytes in 0..MAX_WIRE_BYTES && DIGEST.matches(head.sha256)) {
            "Invalid binary response head bounds"
        }
        require(head.bodyEncoding == "identity" || head.bodyEncoding == "gzip") {
            "Unsupported binary response encoding"
        }
        if (head.totalBytes == 0) {
            val emptyDigest = MessageDigest.getInstance("SHA-256").digest(ByteArray(0)).joinToString("") { "%02x".format(it) }
            require(emptyDigest == head.sha256) { "Empty response digest mismatch" }
            return P2PHttpResponse(
                id = head.id,
                type = "http_response",
                status = head.status,
                headers = head.headers,
                error = head.error,
                rawBodyBytes = ByteArray(0),
            )
        }
        require(!transfers.containsKey(head.id) && reserved + head.totalBytes <= MAX_AGGREGATE_BYTES) {
            "Binary response stream capacity or duplicate id"
        }
        transfers[head.id] = Transfer(head)
        reserved += head.totalBytes
        return null
    }

    @Synchronized
    fun addChunk(frame: ParsedAgr2Frame): P2PHttpResponse? {
        val transfer = transfers[frame.id] ?: return null
        try {
            val head = transfer.head
            require(frame.index == transfer.nextIndex) { "AGR2 chunk order mismatch" }
            val remaining = head.totalBytes - transfer.bytes.size()
            require(frame.payload.isNotEmpty() && frame.payload.size == minOf(CHUNK_BYTES, remaining)) {
                "AGR2 chunk length invalid"
            }
            transfer.bytes.write(frame.payload)
            transfer.nextIndex++
            if (transfer.bytes.size() != head.totalBytes) return null
            val wire = transfer.bytes.toByteArray()
            discard(head.id)
            val actual = MessageDigest.getInstance("SHA-256").digest(wire).joinToString("") { "%02x".format(it) }
            require(actual == head.sha256) { "AGR2 response digest mismatch" }
            val decoded = if (head.bodyEncoding == "gzip") gunzipBounded(wire) else wire
            return P2PHttpResponse(
                id = head.id,
                type = "http_response",
                status = head.status,
                headers = head.headers,
                error = head.error,
                rawBodyBytes = decoded,
            )
        } catch (error: Exception) {
            discard(frame.id)
            throw error
        }
    }

    @Synchronized
    fun hasPending(id: String): Boolean = transfers.containsKey(id)

    @Synchronized
    fun discard(id: String) {
        transfers.remove(id)?.let { reserved -= it.head.totalBytes }
    }

    @Synchronized
    fun clear() {
        transfers.clear()
        reserved = 0
    }
}
