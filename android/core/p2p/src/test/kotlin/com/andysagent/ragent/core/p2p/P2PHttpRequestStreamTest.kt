package com.andysagent.ragent.core.p2p

import java.security.MessageDigest
import java.util.Base64
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class P2PHttpRequestStreamTest {
    @Test
    fun `small request keeps legacy single frame`() {
        val payload = "{\"id\":\"r1\",\"type\":\"http_request\"}".toByteArray()
        val frames = P2PHttpRequestStream.frames("r1", payload).toList()
        assertEquals(1, frames.size)
        assertContentEquals(payload, frames.single())
    }

    @Test
    fun `large request is chunked with exact order and whole payload digest`() {
        val payload = ByteArray(420_123) { ((it * 31) % 251).toByte() }
        val frames = P2PHttpRequestStream.frames("request_42", payload).toList()
        assertTrue(frames.size > 1)
        assertTrue(frames.all { it.size < 48 * 1024 })

        val chunks = frames.map(P2PHttpRequestStream::decodeChunk)
        assertEquals((0 until chunks.size).toList(), chunks.map { it.index })
        assertTrue(chunks.all { it.type == "http_request_stream_v1" && it.id == "request_42" })
        assertTrue(chunks.all { it.totalBytes == payload.size })
        val expectedDigest = MessageDigest.getInstance("SHA-256").digest(payload)
            .joinToString("") { "%02x".format(it) }
        assertTrue(chunks.all { it.sha256 == expectedDigest })
        assertContentEquals(payload, chunks.flatMap { Base64.getDecoder().decode(it.dataBase64).asIterable() }.toByteArray())
    }

    @Test
    fun `stream rejects invalid identifiers and payloads over hard limit`() {
        assertFailsWith<IllegalArgumentException> { P2PHttpRequestStream.frames("../bad", byteArrayOf(1)) }
        assertFailsWith<IllegalArgumentException> {
            P2PHttpRequestStream.frames("r1", ByteArray(P2PHttpRequestStream.MAX_STREAM_BYTES + 1))
        }
        assertFailsWith<IllegalArgumentException> { P2PHttpRequestStream.frames("r1", byteArrayOf()) }
    }

    @Test
    fun `large requests require explicit host stream capability`() {
        val json = Json { ignoreUnknownKeys = true }
        val current = json.decodeFromString<P2PServerReadyFrame>(
            """{"type":"server_ready","version":1,"features":["http_request_stream_v1"]}""",
        )
        val older = json.decodeFromString<P2PServerReadyFrame>(
            """{"type":"server_ready","version":1,"auth":"client_auth_v1"}""",
        )
        assertTrue("http_request_stream_v1" in current.features)
        assertTrue(older.features.isEmpty())
    }

    @Test
    fun `v2 body framing carries bounded metadata and independent binary chunks`() {
        val body = ByteArray(P2PHttpBodyStream.CHUNK_BYTES + 7) { (it % 239).toByte() }
        val sha256 = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val request = P2PHttpRequest("upload_1", method = "POST", path = "/api/temporary/upload",
            headers = mapOf("Content-Type" to "application/octet-stream", "Authorization" to "DPoP test"))
        val init = Json.decodeFromString<P2PHttpBodyStreamInit>(String(
            P2PHttpBodyStream.initFrame(request, body.size.toLong(), sha256)))
        assertEquals("http_request_stream_v2_init", init.type)
        assertEquals(body.size.toLong(), init.totalBytes)
        val capableInit = Json.decodeFromString<P2PHttpBodyStreamInit>(String(
            P2PHttpBodyStream.initFrame(request.copy(acceptResponseStream = true), body.size.toLong(), sha256)))
        assertTrue(capableInit.acceptResponseStream)
        assertEquals(sha256, init.sha256)
        assertEquals(request.headers, init.headers)

        val chunks = listOf(body.copyOfRange(0, P2PHttpBodyStream.CHUNK_BYTES),
            body.copyOfRange(P2PHttpBodyStream.CHUNK_BYTES, body.size)).mapIndexed { index, bytes ->
            Json.decodeFromString<P2PHttpBodyStreamChunk>(String(P2PHttpBodyStream.chunkFrame(request.id, index, bytes)))
        }
        assertTrue(chunks.all { it.type == "http_request_stream_v2_chunk" && it.id == request.id })
        assertContentEquals(body, chunks.flatMap { Base64.getDecoder().decode(it.dataBase64).asIterable() }.toByteArray())
        val end = Json.decodeFromString<P2PHttpBodyStreamEnd>(String(
            P2PHttpBodyStream.endFrame(request.id, chunks.size, body.size.toLong(), sha256)))
        assertEquals(chunks.size, end.chunkCount)
        assertEquals(body.size.toLong(), end.totalBytes)
        assertEquals("http_request_stream_v2_abort", Json.decodeFromString<P2PHttpBodyStreamAbort>(
            String(P2PHttpBodyStream.abortFrame(request.id))).type)
    }

    @Test
    fun `legacy peer fallback verifies and bounds materialized body`() {
        val body = ByteArray(4097) { (it % 251).toByte() }
        val sha256 = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val decoded = P2PHttpBodyStream.readVerifiedBody(java.io.ByteArrayInputStream(body), body.size.toLong(), sha256)
        assertContentEquals(body, decoded)
        assertFailsWith<IllegalArgumentException> {
            P2PHttpBodyStream.readVerifiedBody(java.io.ByteArrayInputStream(body), body.size.toLong(), "0".repeat(64))
        }
        assertFailsWith<IllegalArgumentException> {
            P2PHttpBodyStream.readVerifiedBody(java.io.ByteArrayInputStream(body), body.size.toLong() - 1, sha256)
        }
    }

    @Test
    fun `stream body reports monotonic byte progress and verifies final digest`() {
        val body = ByteArray(48_000) { (it % 251).toByte() }
        val sha256 = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
        val progress = mutableListOf<Pair<Long, Long>>()
        val decoded = P2PHttpBodyStream.readVerifiedBody(java.io.ByteArrayInputStream(body), body.size.toLong(), sha256) { sent, total ->
            progress += sent to total
        }
        assertContentEquals(body, decoded)
        assertTrue(progress.size > 1)
        assertTrue(progress.all { (sent, total) -> sent in 1L..total && total == body.size.toLong() })
        assertEquals(progress.map { it.first }.sorted(), progress.map { it.first })
        assertEquals(body.size.toLong(), progress.last().first)
    }
}
