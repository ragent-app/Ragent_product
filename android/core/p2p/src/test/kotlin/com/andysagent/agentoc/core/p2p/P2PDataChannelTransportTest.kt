package com.andysagent.agentoc.core.p2p

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Tests for the [P2PSession] contract using a fake session implementation.
 * Real WebRTC PeerConnection is NOT instantiated in JVM unit tests.
 */
class P2PDataChannelTransportTest {

    @Test fun `binary body frame preserves arbitrary bytes and ordered index`() {
        val bytes = byteArrayOf(0, 1, -1, -128, 127)
        val frame = P2PHttpBodyStream.binaryChunkFrame("binary-test", 7, bytes)
        val input = java.nio.ByteBuffer.wrap(frame)
        val magic = ByteArray(4).also(input::get)
        assertEquals("AGB3", String(magic, Charsets.US_ASCII))
        val id = ByteArray(input.get().toInt() and 0xff).also(input::get)
        assertEquals("binary-test", String(id, Charsets.US_ASCII))
        assertEquals(7, input.int)
        assertTrue(ByteArray(input.remaining()).also(input::get).contentEquals(bytes))
    }

    @Test
    fun `bulk recovery attempts share a cooldown across concurrent callers`() {
        val gate = BulkChannelRetryGate(cooldownMs = 5_000)
        val start = java.util.concurrent.CountDownLatch(1)
        val successes = java.util.concurrent.atomic.AtomicInteger()
        val workers = List(16) {
            Thread {
                start.await()
                if (gate.tryAcquire(1_000)) successes.incrementAndGet()
            }.apply { start() }
        }
        start.countDown()
        workers.forEach { it.join() }
        assertEquals(1, successes.get())
        assertFalse(gate.tryAcquire(5_999))
        assertTrue(gate.tryAcquire(6_000))
    }

    @Test
    fun `only durable history GET requests use the optional bulk channel`() {
        fun request(path: String, method: String = "GET") = P2PHttpRequest(id = "x", method = method, path = path)
        assertTrue(isBulkReadRequest(request("/api/sessions/s/events?filter=all&limit=200")))
        assertTrue(isBulkReadRequest(request("/api/sessions/s/events/wait?afterSeq=4&filter=all")))
        assertTrue(isBulkReadRequest(request("/api/workspace-files/content?sessionId=s&path=report.pdf")))
        assertFalse(isBulkReadRequest(request("/api/workspace-files/content?path=report.pdf", "POST")))
        assertFalse(isBulkReadRequest(request("/api/workspace-files/content-other?path=report.pdf")))
        assertFalse(isBulkReadRequest(request("/api/sessions/s/events?filter=visible")))
        assertFalse(isBulkReadRequest(request("/api/sessions/s/events/wait?filter=all&liveOnly=1")))
        assertFalse(isBulkReadRequest(request("/api/sessions/s/events?filter=all", "POST")))
        assertFalse(isBulkReadRequest(request("/api/projects?filter=all")))
    }

    @Test
    fun `closed history channel retries once on primary with a fresh wire id`() = kotlinx.coroutines.test.runTest {
        val original = P2PHttpRequest(id = "original", method = "GET", path = "/api/sessions/s/events?filter=all")
        val attempts = mutableListOf<Pair<P2PHttpRequest, Boolean>>()
        val result = requestWithBulkFallback(original) { request, allowBulk ->
            attempts += request to allowBulk
            if (allowBulk) Result.failure(BulkChannelClosedException())
            else Result.success(P2PHttpResponse(id = request.id, status = 200))
        }
        assertEquals(2, attempts.size)
        assertTrue(attempts[0].second)
        assertFalse(attempts[1].second)
        assertNotEquals(original.id, attempts[1].first.id)
        assertEquals(original.path, attempts[1].first.path)
        assertEquals(original.id, result.getOrThrow().id)
    }

    @Test
    fun `closed bulk channel retries file preview once on primary`() = kotlinx.coroutines.test.runTest {
        val original = P2PHttpRequest(id = "file", method = "GET", path = "/api/workspace-files/content?path=report.pdf")
        val attempts = mutableListOf<Pair<P2PHttpRequest, Boolean>>()
        val result = requestWithBulkFallback(original) { request, allowBulk ->
            attempts += request to allowBulk
            if (allowBulk) Result.failure(BulkChannelClosedException())
            else Result.success(P2PHttpResponse(id = request.id, status = 200))
        }
        assertEquals(2, attempts.size)
        assertFalse(attempts[1].second)
        assertNotEquals(original.id, attempts[1].first.id)
        assertEquals(original.id, result.getOrThrow().id)
    }

    @Test
    fun `unrelated failures and non-history requests are never retried`() = kotlinx.coroutines.test.runTest {
        var attempts = 0
        val history = P2PHttpRequest(id = "history", method = "GET", path = "/api/sessions/s/events?filter=all")
        val error = IllegalStateException("other")
        assertEquals(error, requestWithBulkFallback(history) { _, _ -> attempts++; Result.failure(error) }.exceptionOrNull())
        assertEquals(1, attempts)
        val interactive = history.copy(path = "/api/projects")
        assertTrue(requestWithBulkFallback(interactive) { _, _ -> attempts++; Result.failure(BulkChannelClosedException()) }.isFailure)
        assertEquals(2, attempts)
    }

    // ── Contract: connect → isOpen ────────────────────────────────────

    @Test
    fun `fake session connect sets isOpen`() = kotlinx.coroutines.test.runTest {
        val session = FakeP2PSession()
        assertFalse(session.isOpen)

        val result = session.connect()
        assertTrue(result.isSuccess)
        assertTrue(session.isOpen)
    }

    @Test
    fun `fake session connect fails on error flag`() = kotlinx.coroutines.test.runTest {
        val session = FakeP2PSession(connectFails = true)
        val result = session.connect()
        assertTrue(result.isFailure)
        assertFalse(session.isOpen)
    }

    // ── Contract: request ─────────────────────────────────────────────

    @Test
    fun `fake session request returns preconfigured response`() = kotlinx.coroutines.test.runTest {
        val expectedResponse = P2PHttpResponse(
            id = "r1", status = 200,
            headers = mapOf("X-P2P" to "ok"),
            bodyBase64 = "aGVsbG8=",
        )
        val session = FakeP2PSession(nextResponse = expectedResponse)
        session.connect()

        val request = P2PHttpRequest(id = "r1", method = "GET", path = "/api/test")
        val result = session.request(request)

        assertTrue(result.isSuccess)
        assertEquals("r1", result.getOrThrow().id)
        assertEquals(200, result.getOrThrow().status)
        assertEquals("aGVsbG8=", result.getOrThrow().bodyBase64)
    }

    @Test
    fun `request fails when session is not open`() = kotlinx.coroutines.test.runTest {
        val session = FakeP2PSession()
        val request = P2PHttpRequest(id = "r1", method = "GET", path = "/api/test")
        val result = session.request(request)
        assertTrue(result.isFailure)
    }

    @Test
    fun `request fails when session is closed`() = kotlinx.coroutines.test.runTest {
        val session = FakeP2PSession()
        session.connect()
        session.close()
        val request = P2PHttpRequest(id = "r1", method = "GET", path = "/api/test")
        val result = session.request(request)
        assertTrue(result.isFailure)
    }

    @Test
    fun `remote error is a response rather than a broken carrier`() = kotlinx.coroutines.test.runTest {
        val errorResponse = P2PHttpResponse(
            id = "e1", status = 0, error = "gateway blocked",
        )
        val session = FakeP2PSession(nextResponse = errorResponse)
        session.connect()

        val result = session.request(P2PHttpRequest(id = "e1", method = "POST", path = "/blocked"))
        assertEquals("gateway blocked", result.getOrThrow().error)
        assertTrue(session.isOpen)
    }

    // ── Contract: factory ─────────────────────────────────────────────

    @Test
    fun `P2PSessionFactory creates session with candidate`() = kotlinx.coroutines.test.runTest {
        val candidate = P2PCandidate(
            signalingUrl = "https://signaling.example.com",
            roomId = "room-123",
            secret = "s3cret",
        )
        val factory = P2PSessionFactory { _ -> FakeP2PSession() }
        val session = factory.create(candidate)
        assertFalse(session.isOpen)
        session.connect()
        assertTrue(session.isOpen)
    }

    // ── Contract: close is idempotent ─────────────────────────────────

    @Test
    fun `close is idempotent`() {
        val session = FakeP2PSession()
        session.close()
        session.close() // must not throw
        assertFalse(session.isOpen)
    }
}

// ── Fake P2PSession for JVM tests ─────────────────────────────────────

/**
 * In-memory [P2PSession] used by unit tests.
 *
 * Configurable to simulate connect failures and to return a
 * pre-determined response on [request].
 */
class FakeP2PSession(
    private val connectFails: Boolean = false,
    private var nextResponse: P2PHttpResponse = P2PHttpResponse(
        id = "resp", status = 200, bodyBase64 = "",
    ),
    private var requestFails: Boolean = false,
) : P2PSession {

    @Volatile override var isOpen: Boolean = false
        private set

    override suspend fun connect(): Result<Unit> {
        if (connectFails) {
            return Result.failure(Exception("fake connect failure"))
        }
        isOpen = true
        return Result.success(Unit)
    }

    override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
        if (!isOpen) {
            return Result.failure(IllegalStateException("session not open"))
        }
        if (requestFails) {
            return Result.failure(Exception("fake request failure"))
        }
        val resp = nextResponse
        return Result.success(resp.copy(id = request.id))
    }

    override fun close() {
        isOpen = false
    }
}
