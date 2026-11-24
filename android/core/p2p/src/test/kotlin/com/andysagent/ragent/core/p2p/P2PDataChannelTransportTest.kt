package com.andysagent.ragent.core.p2p

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.webrtc.DataChannel
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStats
import org.webrtc.RTCStatsCollectorCallback
import org.webrtc.RTCStatsReport
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Tests for the [P2PSession] contract using a fake session implementation.
 * Real WebRTC PeerConnection is NOT instantiated in JVM unit tests.
 */
@OptIn(ExperimentalCoroutinesApi::class)
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

    @Test
    fun `probeLiveness sends dc_ping and awaits matching dc_pong when dc_keepalive_v1 is supported`() = runTest {
        var nowMs = 1_000L
        val channel = RecordingDataChannel()
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-1", "secret"),
            appContext = stubContext(),
        ).apply { nanoClock = { nowMs * 1_000_000L } }
        try {
            val observer = transport.attachDataChannelForTest(channel)
            assertEquals(Long.MAX_VALUE, transport.lastInboundFrameElapsedMs)

            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["dc_keepalive_v1"]}"""))
            assertTrue(transport.supportsKeepaliveProbe)
            assertEquals(1L, transport.inboundFrameGeneration)
            assertEquals(0L, transport.lastInboundFrameElapsedMs)

            nowMs += 2_000L
            assertEquals(2_000L, transport.lastInboundFrameElapsedMs)

            val probe = async { transport.probeLiveness(2_500L) }
            runCurrent()
            withTimeout(5_000L) { channel.firstSent.await() }
            assertEquals(1, channel.sentTexts.size)
            val sentJson = Json.parseToJsonElement(channel.sentTexts[0]).jsonObject
            assertEquals("dc_ping", sentJson["type"]?.jsonPrimitive?.content)
            val pingId = sentJson["id"]?.jsonPrimitive?.content!!

            // Unrelated pong ID must not satisfy our pending probe.
            observer.onMessage(textBuffer("""{"type":"dc_pong","id":"other-id"}"""))
            runCurrent()
            assertFalse(probe.isCompleted)

            nowMs += 50L
            observer.onMessage(textBuffer("""{"type":"dc_pong","id":"$pingId"}"""))
            assertTrue(probe.await())
            assertEquals(0L, transport.lastInboundFrameElapsedMs)
            assertEquals(0L, transport.successfulResponseGeneration)
        } finally {
            transport.close()
        }
    }

    @Test
    fun `probeLiveness returns false on dc_ping timeout without dc_pong`() = runTest {
        var nowMs = 1_000L
        val channel = RecordingDataChannel()
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-1", "secret"),
            appContext = stubContext(),
        ).apply { nanoClock = { nowMs * 1_000_000L } }
        try {
            val observer = transport.attachDataChannelForTest(channel)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["dc_keepalive_v1"]}"""))

            val probe = async { transport.probeLiveness(2_500L) }
            runCurrent()
            withTimeout(5_000L) { channel.firstSent.await() }
            assertEquals(1, channel.sentTexts.size)
            advanceTimeBy(2_501L)
            assertFalse(probe.await())
        } finally {
            transport.close()
        }
    }

    @Test
    fun `probeLiveness falls back to GET auth me when dc_keepalive_v1 is not advertised`() = runBlocking {
        val channel = RecordingDataChannel()
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-1", "secret"),
            appContext = stubContext(),
        )
        try {
            val observer = transport.attachDataChannelForTest(channel)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["http_request_stream_v1"]}"""))
            assertFalse(transport.supportsKeepaliveProbe)

            val probe = async { transport.probeLiveness(2_500L) }
            withTimeout(5_000L) { channel.firstSent.await() }
            assertEquals(1, channel.sentTexts.size)
            val sentJson = Json.parseToJsonElement(channel.sentTexts[0]).jsonObject
            assertEquals("http_request", sentJson["type"]?.jsonPrimitive?.content)
            assertEquals("GET", sentJson["method"]?.jsonPrimitive?.content)
            assertEquals("/api/auth/me", sentJson["path"]?.jsonPrimitive?.content)
            val reqId = sentJson["id"]?.jsonPrimitive?.content!!

            observer.onMessage(textBuffer("""{"id":"$reqId","type":"http_response","status":200}"""))
            assertTrue(probe.await())
            assertEquals(1L, transport.successfulResponseGeneration)
        } finally {
            transport.close()
        }
    }

    @Test
    fun `background read predicate matches only non-interactive poll GET routes`() {
        fun req(path: String, method: String = "GET") = P2PHttpRequest(id = "r1", method = method, path = path)
        assertTrue(isBackgroundReadRequest(req("/api/sessions")))
        assertTrue(isBackgroundReadRequest(req("/api/sessions?filter=active")))
        assertTrue(isBackgroundReadRequest(req("/api/runtime/summary")))
        assertTrue(isBackgroundReadRequest(req("/api/runtime/summary/events?afterSeq=12")))
        assertTrue(isBackgroundReadRequest(req("/api/windows-broker")))
        assertTrue(isBackgroundReadRequest(req("/api/windows-broker/windows?limit=20")))
        assertTrue(isBackgroundReadRequest(req("/api/sessions/s1/events/wait?afterSeq=4&liveOnly=1")))
        assertFalse(isBackgroundReadRequest(req("/api/sessions/s1/events/wait?afterSeq=4")))
        assertFalse(isBackgroundReadRequest(req("/api/sessions/s1")))
        assertFalse(isBackgroundReadRequest(req("/api/sessions", method = "POST")))
        assertFalse(isBackgroundReadRequest(req("/api/projects")))
    }

    @Test
    fun `closed background channel retries once on primary with a fresh wire id`() = runTest {
        val original = P2PHttpRequest(id = "bg-1", method = "GET", path = "/api/sessions/s1/events/wait?liveOnly=1")
        val attempts = mutableListOf<Pair<P2PHttpRequest, Boolean>>()
        val result = requestWithSecondaryFallback(original) { request, allowSecondary ->
            attempts += request to allowSecondary
            if (allowSecondary) Result.failure(BgChannelClosedException())
            else Result.success(P2PHttpResponse(id = request.id, status = 200))
        }
        assertEquals(2, attempts.size)
        assertTrue(attempts[0].second)
        assertFalse(attempts[1].second)
        assertNotEquals(original.id, attempts[1].first.id)
        assertEquals(original.id, result.getOrThrow().id)
    }

    @Test
    fun `http_bg_channel_v1 lazily creates ordered ragent-http-bg and routes background reads`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        val peerConnection = RecordingPeerConnection()
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-bg", "secret"),
            appContext = stubContext(),
        )
        try {
            val observer = transport.attachDataChannelForTest(primary)
            transport.attachPeerConnectionForTest(peerConnection)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["http_bg_channel_v1"]}"""))

            // Not created eagerly before any background read arrives.
            val projects = async { transport.request(P2PHttpRequest(id = "proj-1", method = "GET", path = "/api/projects")) }
            withTimeout(5_000L) { primary.sentSignal.await() }
            assertTrue(peerConnection.created.isEmpty())
            val projWireId = Json.parseToJsonElement(primary.sentTexts.last()).jsonObject["id"]!!.jsonPrimitive.content
            observer.onMessage(textBuffer("""{"id":"$projWireId","type":"http_response","status":200}"""))
            assertEquals(200, projects.await().getOrThrow().status)

            // First background read lazily creates ordered "ragent-http-bg" and falls back cleanly on primary if not open yet.
            val firstPoll = async { transport.request(P2PHttpRequest(id = "bg-first", method = "GET", path = "/api/sessions")) }
            withTimeout(5_000L) {
                while (primary.sentTexts.size < 2) delay(10L)
            }
            val firstWireId = Json.parseToJsonElement(primary.sentTexts.last()).jsonObject["id"]!!.jsonPrimitive.content
            observer.onMessage(textBuffer("""{"id":"$firstWireId","type":"http_response","status":200}"""))
            assertEquals(200, firstPoll.await().getOrThrow().status)
            withTimeout(5_000L) { peerConnection.createdBgSignal.await() }
            val createdBg = peerConnection.created.single { it.first == "ragent-http-bg" }
            assertTrue(createdBg.second.ordered)

            // Once bg channel is open, background reads route to ragent-http-bg while mutations remain on primary.
            val bgChannel = createdBg.third
            val secondPoll = async {
                transport.request(P2PHttpRequest(id = "bg-second", method = "GET", path = "/api/sessions/s1/events/wait?liveOnly=1"))
            }
            withTimeout(5_000L) { bgChannel.sentSignal.await() }
            val bgWireId = Json.parseToJsonElement(bgChannel.sentTexts.single()).jsonObject["id"]!!.jsonPrimitive.content
            bgChannel.registeredObserver?.onMessage(textBuffer("""{"id":"$bgWireId","type":"http_response","status":200}"""))
            assertEquals(200, secondPoll.await().getOrThrow().status)

            val mutation = async { transport.request(P2PHttpRequest(id = "mut-1", method = "POST", path = "/api/projects")) }
            val beforePrimaryCount = primary.sentTexts.size
            withTimeout(5_000L) {
                while (primary.sentTexts.size <= beforePrimaryCount) delay(10L)
            }
            assertEquals(1, bgChannel.sentTexts.size)
            val mutWireId = Json.parseToJsonElement(primary.sentTexts.last()).jsonObject["id"]!!.jsonPrimitive.content
            observer.onMessage(textBuffer("""{"id":"$mutWireId","type":"http_response","status":201}"""))
            assertEquals(201, mutation.await().getOrThrow().status)
        } finally {
            transport.close()
        }
    }

    @Test
    fun `PrimaryLaneGate wakes Lane 0 HIGH waiters ahead of queued Lane 1 NORMAL waiters`() = runTest {
        val gate = PrimaryLaneGate()
        val holderStarted = CompletableDeferred<Unit>()
        val releaseHolder = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()

        val holder = launch {
            gate.withLane(PrimarySendLane.NORMAL) {
                holderStarted.complete(Unit)
                releaseHolder.await()
                order += "holder"
            }
        }
        holderStarted.await()

        val read1 = launch { gate.withLane(PrimarySendLane.NORMAL) { order += "read-1" } }
        val read2 = launch { gate.withLane(PrimarySendLane.NORMAL) { order += "read-2" } }
        val mut1 = launch { gate.withLane(PrimarySendLane.HIGH) { order += "mut-1" } }
        runCurrent()

        releaseHolder.complete(Unit)
        holder.join(); read1.join(); read2.join(); mut1.join()

        assertEquals(listOf("holder", "mut-1", "read-1", "read-2"), order)
    }

    @Test
    fun `primary channel transmits Lane 0 mutation before queued Lane 1 read when congested`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN).apply {
            currentBufferedAmount.set(1_024_000L)
        }
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-lane", "secret"),
            appContext = stubContext(),
        )
        try {
            val observer = transport.attachDataChannelForTest(primary)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":[]}"""))

            // First request holds the gate while bufferedAmount exceeds high-water.
            val holder = async { transport.request(P2PHttpRequest(id = "h1", method = "GET", path = "/api/projects"), timeoutMs = 5_000L) }
            withTimeout(5_000L) {
                while (primary.bufferedPolls.get() < 2) delay(10L)
            }

            // Enqueue a Lane 1 read first, then a Lane 0 mutation while gate is held.
            val queuedRead = async { transport.request(P2PHttpRequest(id = "r1", method = "GET", path = "/api/models"), timeoutMs = 5_000L) }
            delay(40L)
            val queuedMutation = async { transport.request(P2PHttpRequest(id = "m1", method = "DELETE", path = "/api/projects/p1"), timeoutMs = 5_000L) }
            delay(40L)

            primary.currentBufferedAmount.set(0L)
            withTimeout(5_000L) {
                while (primary.sentTexts.size < 3) delay(10L)
            }

            val sentPaths = primary.sentTexts.map {
                Json.parseToJsonElement(it).jsonObject["path"]!!.jsonPrimitive.content
            }
            assertEquals("/api/projects", sentPaths[0])
            assertEquals("/api/projects/p1", sentPaths[1])
            assertEquals("/api/models", sentPaths[2])

            primary.sentTexts.forEach { raw ->
                val id = Json.parseToJsonElement(raw).jsonObject["id"]!!.jsonPrimitive.content
                observer.onMessage(textBuffer("""{"id":"$id","type":"http_response","status":200}"""))
            }
            assertEquals(200, holder.await().getOrThrow().status)
            assertEquals(200, queuedMutation.await().getOrThrow().status)
            assertEquals(200, queuedRead.await().getOrThrow().status)
        } finally {
            transport.close()
        }
    }

    @Test
    fun `request timeoutMs bounds stalled send deadline and response timeout`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-timeout", "secret"),
            appContext = stubContext(),
            requestTimeoutMs = 60_000L,
        )
        try {
            val observer = transport.attachDataChannelForTest(primary)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":[]}"""))

            // 1. Response never arrives: fails with P2PRequestTimeoutException well under 60s default.
            val responseStartMs = System.currentTimeMillis()
            val responseTimeout = transport.request(
                P2PHttpRequest(id = "t-resp", method = "DELETE", path = "/api/projects/p1"),
                timeoutMs = 120L,
            )
            val responseElapsed = System.currentTimeMillis() - responseStartMs
            assertTrue(responseTimeout.exceptionOrNull() is P2PRequestTimeoutException)
            assertTrue(responseElapsed < 3_000L, "Expected response timeout near 120ms, was ${responseElapsed}ms")

            // 2. Stalled send buffer: bounded by minOf(baseSendDeadline, timeoutMs) without ever writing a frame.
            primary.currentBufferedAmount.set(1_024_000L)
            val sendStartMs = System.currentTimeMillis()
            val sendTimeout = transport.request(
                P2PHttpRequest(id = "t-send", method = "PATCH", path = "/api/projects/p1"),
                timeoutMs = 120L,
            )
            val sendElapsed = System.currentTimeMillis() - sendStartMs
            val sendError = sendTimeout.exceptionOrNull()
            assertTrue(
                sendError is P2PSendTimeoutException || sendError is P2PRequestTimeoutException,
                "Actual error: $sendError",
            )
            assertEquals(1, primary.sentTexts.size)
            assertTrue(sendElapsed < 3_000L, "Expected send timeout near 120ms, was ${sendElapsed}ms")
        } finally {
            transport.close()
        }
    }

    @Test
    fun `dc_push_invalidation_v1 sends client_ready on primary channel and emits dc_push_v1 payloads`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-push", "secret"),
            appContext = stubContext(),
        )
        try {
            val observer = transport.attachDataChannelForTest(primary)
            assertFalse(transport.supportsPushInvalidations)

            val received = mutableListOf<String>()
            val collectedThree = CompletableDeferred<Unit>()
            val collector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                transport.invalidations.take(3).toList(received)
                collectedThree.complete(Unit)
            }

            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["dc_keepalive_v1","dc_push_invalidation_v1"]}"""))
            assertTrue(transport.supportsPushInvalidations)

            withTimeout(5_000L) { primary.sentSignal.await() }
            assertEquals(1, primary.sentTexts.size)
            val clientReady = Json.parseToJsonElement(primary.sentTexts.single()).jsonObject
            assertEquals("client_ready", clientReady["type"]?.jsonPrimitive?.content)
            assertEquals("1", clientReady["version"]?.jsonPrimitive?.content)
            assertEquals(
                listOf("dc_push_invalidation_v1"),
                clientReady["features"]?.let { elem ->
                    (elem as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content }
                },
            )

            observer.onMessage(textBuffer("""{"type":"dc_push_v1","payload":{"type":"sessions_invalidated"}}"""))
            observer.onMessage(textBuffer("""{"type":"dc_push_v1","payload":{"type":"projects_invalidated"}}"""))
            observer.onMessage(textBuffer("""{"type":"dc_push_v1","payload":{"type":"session_invalidated","sessionId":"s-1","latestSeq":42}}"""))
            withTimeout(5_000L) { collectedThree.await() }
            collector.cancel()

            assertEquals(3, received.size)
            assertEquals("sessions_invalidated", Json.parseToJsonElement(received[0]).jsonObject["type"]?.jsonPrimitive?.content)
            assertEquals("projects_invalidated", Json.parseToJsonElement(received[1]).jsonObject["type"]?.jsonPrimitive?.content)
            val sessionPush = Json.parseToJsonElement(received[2]).jsonObject
            assertEquals("session_invalidated", sessionPush["type"]?.jsonPrimitive?.content)
            assertEquals("s-1", sessionPush["sessionId"]?.jsonPrimitive?.content)
            assertEquals("42", sessionPush["latestSeq"]?.jsonPrimitive?.content)
            assertEquals(0L, transport.successfulResponseGeneration)

            // Burst > 64 dc_push_v1 frames while collector is paused drops oldest without blocking dispatch.
            val firstHandled = CompletableDeferred<Unit>()
            val releaseCollector = CompletableDeferred<Unit>()
            val burstTypes = mutableListOf<String>()
            val slowCollector = launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
                transport.invalidations.collect { raw ->
                    burstTypes += Json.parseToJsonElement(raw).jsonObject["type"]!!.jsonPrimitive.content
                    if (burstTypes.size == 1) {
                        firstHandled.complete(Unit)
                        releaseCollector.await()
                    }
                }
            }
            observer.onMessage(textBuffer("""{"type":"dc_push_v1","payload":{"type":"burst_0"}}"""))
            withTimeout(5_000L) { firstHandled.await() }
            for (i in 1..70) {
                observer.onMessage(textBuffer("""{"type":"dc_push_v1","payload":{"type":"burst_$i"}}"""))
            }
            releaseCollector.complete(Unit)
            withTimeout(5_000L) { while (burstTypes.size < 65) delay(10L) }
            slowCollector.cancel()
            assertEquals("burst_0", burstTypes.first())
            assertEquals("burst_7", burstTypes[1])
            assertEquals("burst_70", burstTypes.last())
        } finally {
            transport.close()
        }
    }

    @Test
    fun `server_ready without dc_push_invalidation_v1 keeps push disabled and skips client_ready`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate("https://signal.example.com", "room-legacy", "secret"),
            appContext = stubContext(),
        )
        try {
            val observer = transport.attachDataChannelForTest(primary)
            observer.onMessage(textBuffer("""{"type":"server_ready","version":1,"features":["dc_keepalive_v1"]}"""))
            delay(50L)
            assertFalse(transport.supportsPushInvalidations)
            assertTrue(primary.sentTexts.isEmpty())
        } finally {
            transport.close()
        }
    }

    @Test
    fun `turnOnly false configures IceTransportsType ALL and turnOnly true configures RELAY`() = runBlocking {
        val turnServer = IceServer("turn:turn.cloudflare.com:50000?transport=udp", "user", "pass")
        val directCandidate = P2PCandidate(
            signalingUrl = "https://signal.example.com",
            roomId = "room-all",
            secret = "secret",
            iceServers = listOf(turnServer),
            turnOnly = false,
        )
        val relayCandidate = directCandidate.copy(roomId = "room-relay", turnOnly = true)

        val directTransport = WebRTCDataChannelTransport(directCandidate, stubContext())
        val relayTransport = WebRTCDataChannelTransport(relayCandidate, stubContext())
        try {
            val directConfig = directTransport.buildRtcConfiguration()
            assertEquals(PeerConnection.IceTransportsType.ALL, directConfig.iceTransportsType)
            assertEquals(listOf("turn:turn.cloudflare.com:50000?transport=udp"), directConfig.iceServers.map { it.uri })

            val relayConfig = relayTransport.buildRtcConfiguration()
            assertEquals(PeerConnection.IceTransportsType.RELAY, relayConfig.iceTransportsType)
            assertEquals(listOf("turn:turn.cloudflare.com:50000?transport=udp"), relayConfig.iceServers.map { it.uri })

            // Verify connect() passes the configured IceTransportsType to PeerConnectionFactory.createPeerConnection.
            val capturedDirect = mutableListOf<PeerConnection.RTCConfiguration>()
            val capturedRelay = mutableListOf<PeerConnection.RTCConfiguration>()
            val probeDirect = WebRTCDataChannelTransport(directCandidate, stubContext()).apply {
                peerConnectionFactoryProvider = {
                    object : PeerConnectionFactory() {
                        override fun createPeerConnection(
                            configuration: PeerConnection.RTCConfiguration,
                            observer: PeerConnection.Observer,
                        ): PeerConnection? {
                            capturedDirect += configuration
                            return null
                        }
                    }
                }
            }
            val probeRelay = WebRTCDataChannelTransport(relayCandidate, stubContext()).apply {
                peerConnectionFactoryProvider = {
                    object : PeerConnectionFactory() {
                        override fun createPeerConnection(
                            configuration: PeerConnection.RTCConfiguration,
                            observer: PeerConnection.Observer,
                        ): PeerConnection? {
                            capturedRelay += configuration
                            return null
                        }
                    }
                }
            }
            try {
                assertTrue(probeDirect.connect().isFailure)
                assertTrue(probeRelay.connect().isFailure)
                assertEquals(PeerConnection.IceTransportsType.ALL, capturedDirect.single().iceTransportsType)
                assertEquals(PeerConnection.IceTransportsType.RELAY, capturedRelay.single().iceTransportsType)
            } finally {
                probeDirect.close()
                probeRelay.close()
            }
        } finally {
            directTransport.close()
            relayTransport.close()
        }
    }

    @Test
    fun `getStats classifies non-relay candidate pair as P2P and relay pair as Turn`() = runBlocking {
        val primary = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        val peerConnection = StatsPeerConnection()
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate(
                signalingUrl = "https://signal.example.com",
                roomId = "room-stats",
                secret = "secret",
                iceServers = listOf(IceServer("turn:turn.cloudflare.com:50000?transport=udp", "u", "p")),
                turnOnly = false,
            ),
            appContext = stubContext(),
        )
        try {
            assertEquals(P2PIceCarrier.Unknown, transport.resolvedCarrier.value)
            transport.attachPeerConnectionForTest(peerConnection)
            val observer = transport.attachDataChannelForTest(primary)
            val peerObserver = transport.peerObserverForTest()

            // Incomplete stats do not falsely claim P2P.
            peerConnection.nextReport = RTCStatsReport(1L, emptyMap())
            observer.onStateChange()
            assertEquals(P2PIceCarrier.Unknown, transport.resolvedCarrier.value)

            // Relay pair at DataChannel OPEN resolves to Turn.
            peerConnection.nextReport = statsReport(localType = "relay", remoteType = "host")
            observer.onStateChange()
            assertEquals(P2PIceCarrier.Turn, transport.resolvedCarrier.value)

            // Host <-> host upgrade on ICE COMPLETED updates resolvedCarrier to P2P.
            peerConnection.nextReport = statsReport(localType = "host", remoteType = "host")
            peerObserver.onIceConnectionChange(PeerConnection.IceConnectionState.COMPLETED)
            assertEquals(P2PIceCarrier.P2P, transport.resolvedCarrier.value)

            // Remote relay classifies as Turn.
            peerConnection.nextReport = statsReport(localType = "srflx", remoteType = "relay")
            peerObserver.onIceConnectionChange(PeerConnection.IceConnectionState.CONNECTED)
            assertEquals(P2PIceCarrier.Turn, transport.resolvedCarrier.value)

            // WAN srflx <-> prflx classifies as P2P.
            peerConnection.nextReport = statsReport(localType = "srflx", remoteType = "prflx")
            peerObserver.onIceConnectionChange(PeerConnection.IceConnectionState.COMPLETED)
            assertEquals(P2PIceCarrier.P2P, transport.resolvedCarrier.value)

            transport.close()
            assertEquals(P2PIceCarrier.Unknown, transport.resolvedCarrier.value)
        } finally {
            transport.close()
        }
    }
}

private fun statsReport(localType: String, remoteType: String): RTCStatsReport = RTCStatsReport(
    1_000L,
    mapOf(
        "transport-1" to RTCStats(
            1_000L,
            "transport",
            "transport-1",
            mapOf("selectedCandidatePairId" to "pair-1"),
        ),
        "pair-1" to RTCStats(
            1_000L,
            "candidate-pair",
            "pair-1",
            mapOf(
                "state" to "succeeded",
                "nominated" to true,
                "localCandidateId" to "lc-1",
                "remoteCandidateId" to "rc-1",
            ),
        ),
        "lc-1" to RTCStats(1_000L, "local-candidate", "lc-1", mapOf("candidateType" to localType)),
        "rc-1" to RTCStats(1_000L, "remote-candidate", "rc-1", mapOf("candidateType" to remoteType)),
    ),
)

private class StatsPeerConnection : PeerConnection() {
    @Volatile var nextReport: RTCStatsReport = RTCStatsReport(0L, emptyMap())
    override fun getStats(callback: RTCStatsCollectorCallback) {
        callback.onStatsDelivered(nextReport)
    }
}

private fun textBuffer(text: String): DataChannel.Buffer =
    DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false)

private fun stubContext(): Context = android.content.ContextWrapper(null)

private class RecordingDataChannel : DataChannel() {
    val sentTexts = CopyOnWriteArrayList<String>()
    val firstSent = CompletableDeferred<Unit>()
    override fun state(): State = State.OPEN
    override fun bufferedAmount(): Long = 0L
    override fun send(buffer: Buffer): Boolean {
        val bytes = ByteArray(buffer.data.remaining())
        buffer.data.get(bytes)
        sentTexts.add(String(bytes, Charsets.UTF_8))
        firstSent.complete(Unit)
        return true
    }
}

private class ControllableDataChannel(initialState: State = State.OPEN) : DataChannel() {
    val currentBufferedAmount = AtomicLong(0L)
    val bufferedPolls = AtomicInteger(0)
    val sentTexts = CopyOnWriteArrayList<String>()
    val sentSignal = CompletableDeferred<Unit>()
    @Volatile var channelState: State = initialState
    @Volatile var registeredObserver: Observer? = null

    override fun registerObserver(observer: Observer) {
        registeredObserver = observer
    }
    override fun state(): State = channelState
    override fun bufferedAmount(): Long {
        bufferedPolls.incrementAndGet()
        return currentBufferedAmount.get()
    }
    override fun send(buffer: Buffer): Boolean {
        val bytes = ByteArray(buffer.data.remaining())
        buffer.data.get(bytes)
        sentTexts.add(String(bytes, Charsets.UTF_8))
        sentSignal.complete(Unit)
        return true
    }
    override fun close() {
        channelState = State.CLOSED
        registeredObserver?.onStateChange()
    }
}

private class RecordingPeerConnection : PeerConnection() {
    val created = CopyOnWriteArrayList<Triple<String, DataChannel.Init, ControllableDataChannel>>()
    val createdBgSignal = CompletableDeferred<Unit>()
    override fun createDataChannel(label: String, init: DataChannel.Init): DataChannel {
        val ch = ControllableDataChannel(initialState = DataChannel.State.OPEN)
        created += Triple(label, init, ch)
        if (label == "ragent-http-bg") createdBgSignal.complete(Unit)
        return ch
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
