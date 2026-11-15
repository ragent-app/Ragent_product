package com.andysagent.ragent.core.p2p

import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64

@Serializable
internal data class P2PHttpResponseStreamFrame(
    val type: String,
    val id: String,
    val index: Int,
    val totalBytes: Int,
    val sha256: String,
    val dataBase64: String,
)

/** Reassembles only ordered, bounded, digest-checked responses for pending calls. */
internal class P2PHttpResponseAssembler {
    companion object {
        const val MAX_STREAM_BYTES = 12 * 1024 * 1024
        const val MAX_AGGREGATE_BYTES = 24 * 1024 * 1024
        const val CHUNK_BYTES = 24 * 1024
        private val REQUEST_ID = Regex("^[A-Za-z0-9_-]{1,128}$")
        private val DIGEST = Regex("^[a-f0-9]{64}$")
    }
    private class Transfer(val total: Int, val digest: String) {
        var index = 0
        val bytes = ByteArrayOutputStream(CHUNK_BYTES)
    }
    private val transfers = mutableMapOf<String, Transfer>()
    private var reserved = 0

    @Synchronized fun add(frame: P2PHttpResponseStreamFrame): ByteArray? {
        try {
            require(frame.type == "http_response_stream_v1" && REQUEST_ID.matches(frame.id)) { "Invalid response stream identity" }
            require(frame.totalBytes in 1..MAX_STREAM_BYTES && frame.index >= 0 && DIGEST.matches(frame.sha256)) { "Invalid response stream metadata" }
            require(frame.dataBase64.length <= ((CHUNK_BYTES + 2) / 3) * 4) { "Response stream chunk encoding too large" }
            val chunk = Base64.getDecoder().decode(frame.dataBase64)
            require(chunk.isNotEmpty() && chunk.size <= CHUNK_BYTES) { "Invalid response stream chunk" }
            val transfer = transfers[frame.id] ?: run {
                require(frame.index == 0 && reserved + frame.totalBytes <= MAX_AGGREGATE_BYTES) { "Response stream capacity or order invalid" }
                Transfer(frame.totalBytes, frame.sha256).also { transfers[frame.id] = it; reserved += frame.totalBytes }
            }
            require(transfer.total == frame.totalBytes && transfer.digest == frame.sha256 && transfer.index == frame.index) { "Response stream metadata or order changed" }
            val remaining = transfer.total - transfer.bytes.size()
            require(remaining > 0 && chunk.size == minOf(CHUNK_BYTES, remaining)) { "Response stream chunk length invalid" }
            transfer.bytes.write(chunk)
            transfer.index++
            if (transfer.bytes.size() != transfer.total) return null
            val payload = transfer.bytes.toByteArray()
            discard(frame.id)
            val actual = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
            require(actual == frame.sha256) { "Response stream digest mismatch" }
            return payload
        } catch (error: Exception) {
            discard(frame.id)
            throw error
        }
    }

    @Synchronized fun discard(id: String) { transfers.remove(id)?.let { reserved -= it.total } }
    @Synchronized fun clear() { transfers.clear(); reserved = 0 }
}
