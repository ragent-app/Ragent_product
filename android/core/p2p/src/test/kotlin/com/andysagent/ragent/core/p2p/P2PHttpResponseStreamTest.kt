package com.andysagent.ragent.core.p2p

import java.security.MessageDigest
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class P2PHttpResponseStreamTest {
    private fun frames(id: String, payload: ByteArray): List<P2PHttpResponseStreamFrame> {
        val digest = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
        return payload.toList().chunked(P2PHttpResponseAssembler.CHUNK_BYTES).mapIndexed { index, chunk ->
            P2PHttpResponseStreamFrame("http_response_stream_v1", id, index, payload.size, digest,
                Base64.getEncoder().encodeToString(chunk.toByteArray()))
        }
    }

    @Test fun `large responses reassemble with interleaved request identities`() {
        val first = ByteArray(300_123) { (it % 251).toByte() }
        val second = ByteArray(70_000) { (it % 239).toByte() }
        val a = frames("first", first); val b = frames("second", second)
        val assembler = P2PHttpResponseAssembler()
        var firstResult: ByteArray? = null; var secondResult: ByteArray? = null
        repeat(maxOf(a.size, b.size)) { index ->
            if (index < a.size) firstResult = assembler.add(a[index]) ?: firstResult
            if (index < b.size) secondResult = assembler.add(b[index]) ?: secondResult
        }
        assertContentEquals(first, firstResult)
        assertContentEquals(second, secondResult)
    }

    @Test fun `out of order and corrupted streams fail and release their reservation`() {
        val payload = ByteArray(70_000) { (it % 251).toByte() }
        val parts = frames("request", payload)
        val assembler = P2PHttpResponseAssembler()
        assertFailsWith<IllegalArgumentException> { assembler.add(parts[1]) }
        assertNull(assembler.add(parts[0]))
        assertFailsWith<IllegalArgumentException> { assembler.add(parts[0]) }
        assertNull(assembler.add(parts[0]))
        assertNull(assembler.add(parts[1]))
        assertFailsWith<IllegalArgumentException> { assembler.add(parts[2].copy(sha256 = "0".repeat(64))) }
        assertNull(assembler.add(parts[0]))
        assembler.discard("request")
        assertFailsWith<IllegalArgumentException> { assembler.add(parts[1]) }
        assertNull(assembler.add(parts[0])); assertNull(assembler.add(parts[1]))
        val last = Base64.getDecoder().decode(parts[2].dataBase64).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertFailsWith<IllegalArgumentException> { assembler.add(parts[2].copy(dataBase64 = Base64.getEncoder().encodeToString(last))) }
    }

    @Test fun `aggregate budget and invalid chunk encodings are bounded`() {
        val assembler = P2PHttpResponseAssembler()
        val chunk = Base64.getEncoder().encodeToString(ByteArray(P2PHttpResponseAssembler.CHUNK_BYTES))
        fun start(id: String) = P2PHttpResponseStreamFrame("http_response_stream_v1", id, 0,
            P2PHttpResponseAssembler.MAX_STREAM_BYTES, "0".repeat(64), chunk)
        assertNull(assembler.add(start("a"))); assertNull(assembler.add(start("b")))
        assertFailsWith<IllegalArgumentException> { assembler.add(start("c")) }
        assembler.discard("a"); assertNull(assembler.add(start("c")))
        assembler.clear(); assertNull(assembler.add(start("a")))
        assertFailsWith<IllegalArgumentException> { assembler.add(start("bad").copy(dataBase64 = "!")) }
        assertFailsWith<IllegalArgumentException> { assembler.add(start("bad").copy(totalBytes = P2PHttpResponseAssembler.MAX_STREAM_BYTES + 1)) }
    }
}
