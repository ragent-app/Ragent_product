package com.andysagent.agentoc.core.domain

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Independent AES-GCM records for a single attachment relay transfer. */
internal object FileAssetRelayCrypto {
    const val RECORD_BYTES = 256 * 1024
    private const val NONCE_BYTES = 12
    private const val HEADER_BYTES = 8 + NONCE_BYTES
    private const val TAG_BYTES = 16
    private val domain = "agentoc-asset-relay-v1\u0000".toByteArray(Charsets.US_ASCII)
    private val random = SecureRandom()

    fun newKey(): ByteArray = ByteArray(32).also(random::nextBytes)
    fun newTransferId(): String = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun parameters(key: ByteArray, transferId: String, totalBytes: Long, index: Int): Pair<Int, ByteArray> {
        require(key.size == 32 && transferId.matches(Regex("[a-f0-9]{32}"))) { "Invalid relay key or identity" }
        require(totalBytes > 0 && index >= 0) { "Invalid relay record position" }
        val offset = index.toLong() * RECORD_BYTES
        require(offset < totalBytes) { "Relay record exceeds transfer size" }
        val size = minOf(RECORD_BYTES.toLong(), totalBytes - offset).toInt()
        val id = ByteArray(16) { transferId.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        val aad = ByteBuffer.allocate(domain.size + id.size + 16).order(ByteOrder.BIG_ENDIAN)
            .put(domain).put(id).putInt(index).putLong(totalBytes).putInt(size).array()
        return size to aad
    }

    fun encrypt(key: ByteArray, transferId: String, totalBytes: Long, index: Int, plaintext: ByteArray,
        nonce: ByteArray = ByteArray(NONCE_BYTES).also(random::nextBytes)): ByteArray {
        val (size, aad) = parameters(key, transferId, totalBytes, index)
        require(plaintext.size == size && nonce.size == NONCE_BYTES) { "Invalid relay record input" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        val encrypted = cipher.doFinal(plaintext)
        return ByteBuffer.allocate(HEADER_BYTES + encrypted.size).order(ByteOrder.BIG_ENDIAN)
            .putInt(index).putInt(size).put(nonce).put(encrypted).array()
    }

    fun decrypt(key: ByteArray, transferId: String, totalBytes: Long, index: Int, frame: ByteArray): ByteArray {
        val (size, aad) = parameters(key, transferId, totalBytes, index)
        require(frame.size == HEADER_BYTES + size + TAG_BYTES) { "Invalid relay record length" }
        val header = ByteBuffer.wrap(frame).order(ByteOrder.BIG_ENDIAN)
        require(header.int == index && header.int == size) { "Invalid relay record header" }
        val nonce = ByteArray(NONCE_BYTES).also(header::get)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(frame, HEADER_BYTES, frame.size - HEADER_BYTES)
    }
}
