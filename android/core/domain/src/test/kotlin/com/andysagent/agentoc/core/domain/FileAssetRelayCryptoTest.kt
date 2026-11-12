package com.andysagent.agentoc.core.domain

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class FileAssetRelayCryptoTest {
    private val key = ByteArray(32) { 1 }
    private val id = "00112233445566778899aabbccddeeff"
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    @Test fun `record matches node reference and authenticates before returning bytes`() {
        val bytes = "hello".toByteArray()
        val frame = FileAssetRelayCrypto.encrypt(key, id, 5, 0, bytes, ByteArray(12) { 2 })
        assertEquals("00000000000000050202020202020202020202026fb3a52525a5efdcb24413d8812b0dc2cb4e822b73", frame.hex())
        assertArrayEquals(bytes, FileAssetRelayCrypto.decrypt(key, id, 5, 0, frame))
        frame[20] = (frame[20].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { FileAssetRelayCrypto.decrypt(key, id, 5, 0, frame) }
    }

    @Test fun `identity total and order are bound to ciphertext`() {
        val total = FileAssetRelayCrypto.RECORD_BYTES + 3L
        val frame = FileAssetRelayCrypto.encrypt(key, id, total, 1, "end".toByteArray())
        assertArrayEquals("end".toByteArray(), FileAssetRelayCrypto.decrypt(key, id, total, 1, frame))
        assertThrows(Exception::class.java) { FileAssetRelayCrypto.decrypt(key, "10112233445566778899aabbccddeeff", total, 1, frame) }
        assertThrows(Exception::class.java) { FileAssetRelayCrypto.decrypt(key, id, total + 1, 1, frame) }
        assertThrows(Exception::class.java) { FileAssetRelayCrypto.decrypt(key, id, total, 0, frame) }
    }
}
