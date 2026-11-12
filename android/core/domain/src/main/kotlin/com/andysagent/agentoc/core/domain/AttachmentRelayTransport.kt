package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.network.ApiRequestBodySource
import java.io.OutputStream
import java.security.MessageDigest

/** Capabilities are intentionally not a data class: they must not enter logs. */
class AttachmentRelayTicket(val id: String, val writeToken: String, val readToken: String, val sizeBytes: Long,
    val epoch: String? = null, val deadline: Long? = null)

interface AttachmentRelayTransport {
    /** Null means the server does not support the optional fast route. */
    suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket?
    /** A v2 reservation supports cancellation even when its response is lost. */
    suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket? = null
    /** Best-effort, capability-bound release; old Accounts servers may ignore it. */
    suspend fun cancel(ticket: AttachmentRelayTicket) {}
    suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
        transferId: String, onProgress: (Long) -> Unit)
}

/** Encrypt directly from the re-opened source, using bounded per-record memory. */
object AttachmentRelayPayload {
    fun wireSize(sizeBytes: Long): Long {
        require(sizeBytes > 0 && sizeBytes <= 64L * 1024 * 1024)
        val records = (sizeBytes + FileAssetRelayCrypto.RECORD_BYTES - 1) / FileAssetRelayCrypto.RECORD_BYTES
        val wire = sizeBytes + records * 36
        require(wire <= 64L * 1024 * 1024)
        return wire
    }

    fun newKey(): ByteArray = FileAssetRelayCrypto.newKey()
    fun newTransferId(): String = FileAssetRelayCrypto.newTransferId()

    fun write(source: ApiRequestBodySource, key: ByteArray, transferId: String, output: OutputStream,
        onProgress: (Long) -> Unit = {}) {
        wireSize(source.sizeBytes)
        val digest = MessageDigest.getInstance("SHA-256")
        var remaining = source.sizeBytes
        var written = 0L
        var index = 0
        source.openStream().use { input ->
            while (remaining > 0) {
                val bytes = ByteArray(minOf(remaining, FileAssetRelayCrypto.RECORD_BYTES.toLong()).toInt())
                var offset = 0
                while (offset < bytes.size) {
                    val count = input.read(bytes, offset, bytes.size - offset)
                    if (count < 0) throw java.io.EOFException("Attachment source ended early")
                    if (count == 0) continue
                    offset += count
                }
                digest.update(bytes)
                output.write(FileAssetRelayCrypto.encrypt(key, transferId, source.sizeBytes, index++, bytes))
                remaining -= bytes.size
                written += bytes.size
                onProgress(written)
            }
            check(input.read() == -1) { "Attachment source exceeds its frozen size" }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        check(hash == source.sha256) { "Attachment source differs from its frozen digest" }
    }
}
