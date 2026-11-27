package com.andysagent.ragent.core.p2p

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.GZIPOutputStream
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class P2PBinaryResponseAssemblerTest {
    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun gzip(bytes: ByteArray): ByteArray = ByteArrayOutputStream().use { baos ->
        GZIPOutputStream(baos).use { gz -> gz.write(bytes) }
        baos.toByteArray()
    }

    private fun makeAgr2Frame(id: String, index: Int, payload: ByteArray): ByteArray {
        val idBytes = id.toByteArray(Charsets.UTF_8)
        val out = ByteArray(5 + idBytes.size + 4 + payload.size)
        out[0] = 'A'.code.toByte()
        out[1] = 'G'.code.toByte()
        out[2] = 'R'.code.toByte()
        out[3] = '2'.code.toByte()
        out[4] = idBytes.size.toByte()
        System.arraycopy(idBytes, 0, out, 5, idBytes.size)
        ByteBuffer.wrap(out, 5 + idBytes.size, 4).putInt(index)
        System.arraycopy(payload, 0, out, 5 + idBytes.size + 4, payload.size)
        return out
    }

    @Test
    fun `reassembles multi-chunk gzip AGR2 response and decodes original bytes`() {
        val assembler = P2PBinaryResponseAssembler()
        val pseudoRandom = ByteArray(40_000)
        java.util.Random(42L).nextBytes(pseudoRandom)
        val compressed = gzip(pseudoRandom)
        assertTrue(compressed.size > P2PBinaryResponseAssembler.CHUNK_BYTES)

        val head = P2PHttpResponseBinaryHeadFrame(
            type = "http_response_binary_v2_head",
            id = "req_gz_1",
            status = 200,
            headers = mapOf("Content-Type" to "application/octet-stream"),
            totalBytes = compressed.size,
            sha256 = sha256Hex(compressed),
            bodyEncoding = "gzip",
        )
        assertNull(assembler.begin(head))
        assertTrue(assembler.hasPending("req_gz_1"))

        var result: P2PHttpResponse? = null
        var offset = 0
        var index = 0
        while (offset < compressed.size) {
            val end = minOf(offset + P2PBinaryResponseAssembler.CHUNK_BYTES, compressed.size)
            val frameBytes = makeAgr2Frame("req_gz_1", index++, compressed.copyOfRange(offset, end))
            assertTrue(P2PBinaryResponseAssembler.isAgr2Frame(frameBytes))
            val parsed = P2PBinaryResponseAssembler.parseAgr2Frame(frameBytes)
            result = assembler.addChunk(parsed)
            offset = end
        }

        assertNotNull(result)
        assertEquals("req_gz_1", result.id)
        assertEquals(200, result.status)
        assertContentEquals(pseudoRandom, result.decodedBodyBytes())
        assertFalse(assembler.hasPending("req_gz_1"))
    }

    @Test
    fun `reassembles identity binary response without gunzip`() {
        val assembler = P2PBinaryResponseAssembler()
        val payload = ByteArray(1024) { it.toByte() }
        val head = P2PHttpResponseBinaryHeadFrame(
            type = "http_response_binary_v2_head",
            id = "req_id_1",
            status = 200,
            totalBytes = payload.size,
            sha256 = sha256Hex(payload),
            bodyEncoding = "identity",
        )
        assertNull(assembler.begin(head))
        val parsed = P2PBinaryResponseAssembler.parseAgr2Frame(makeAgr2Frame("req_id_1", 0, payload))
        val result = assembler.addChunk(parsed)
        assertNotNull(result)
        assertContentEquals(payload, result.decodedBodyBytes())
    }

    @Test
    fun `handles empty zero-byte response directly in head frame`() {
        val assembler = P2PBinaryResponseAssembler()
        val head = P2PHttpResponseBinaryHeadFrame(
            type = "http_response_binary_v2_head",
            id = "req_empty",
            status = 204,
            totalBytes = 0,
            sha256 = sha256Hex(ByteArray(0)),
            bodyEncoding = "identity",
        )
        val result = assembler.begin(head)
        assertNotNull(result)
        assertEquals(204, result.status)
        assertEquals(0, result.decodedBodyBytes().size)
        assertFalse(assembler.hasPending("req_empty"))
    }

    @Test
    fun `rejects corrupted digest and cleans pending state`() {
        val assembler = P2PBinaryResponseAssembler()
        val payload = "hello world".toByteArray(Charsets.UTF_8)
        val head = P2PHttpResponseBinaryHeadFrame(
            type = "http_response_binary_v2_head",
            id = "req_bad_hash",
            status = 200,
            totalBytes = payload.size,
            sha256 = "0".repeat(64),
            bodyEncoding = "identity",
        )
        assertNull(assembler.begin(head))
        val parsed = P2PBinaryResponseAssembler.parseAgr2Frame(makeAgr2Frame("req_bad_hash", 0, payload))
        assertFailsWith<IllegalArgumentException> { assembler.addChunk(parsed) }
        assertFalse(assembler.hasPending("req_bad_hash"))
    }

    @Test
    fun `rejects out of order chunk index and invalid magic`() {
        val assembler = P2PBinaryResponseAssembler()
        val payload = ByteArray(128) { 7 }
        val head = P2PHttpResponseBinaryHeadFrame(
            type = "http_response_binary_v2_head",
            id = "req_order",
            status = 200,
            totalBytes = payload.size,
            sha256 = sha256Hex(payload),
            bodyEncoding = "identity",
        )
        assertNull(assembler.begin(head))
        val badChunk = P2PBinaryResponseAssembler.parseAgr2Frame(makeAgr2Frame("req_order", 1, payload))
        assertFailsWith<IllegalArgumentException> { assembler.addChunk(badChunk) }
        assertFalse(assembler.hasPending("req_order"))
        assertFalse(P2PBinaryResponseAssembler.isAgr2Frame("AGR1xxxx".toByteArray()))
    }
}
