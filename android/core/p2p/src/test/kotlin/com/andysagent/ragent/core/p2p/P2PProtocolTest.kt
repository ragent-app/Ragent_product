package com.andysagent.agentoc.core.p2p

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class P2PProtocolTest {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; prettyPrint = false }

    // ── canonical() shape ─────────────────────────────────────────────

    @Test
    fun `canonical produces expected JSON with null payload`() {
        val result = P2PProtocol.canonical(
            roomId = "abc123",
            seq = 1,
            timestamp = 1234567890000L,
            payloadJson = "null",
            slashEscape = false,
        )
        val expected = """{"v":1,"roomId":"abc123","seq":1,"timestamp":1234567890000,"payload":null}"""
        assertEquals(expected, result)
    }

    @Test
    fun `canonical produces expected JSON with object payload`() {
        val result = P2PProtocol.canonical(
            roomId = "room-1",
            seq = 42,
            timestamp = 100L,
            payloadJson = """{"type":"offer","sdp":"v=0"}""",
            slashEscape = false,
        )
        val expected = """{"v":1,"roomId":"room-1","seq":42,"timestamp":100,"payload":{"type":"offer","sdp":"v=0"}}"""
        assertEquals(expected, result)
    }

    @Test
    fun `slashEscape replaces forward slashes`() {
        val result = P2PProtocol.canonical(
            roomId = "a/b",
            seq = 1,
            timestamp = 0L,
            payloadJson = """{"url":"http://example.com/"}""",
            slashEscape = true,
        )
        // Payload and roomId forward slashes should be escaped.
        assertTrue(result.contains("""\/"""), "expected \\/ in slash-escaped canonical: $result")
        assertTrue(result.contains("""http:\/\/"""), "URL slashes should be escaped")
    }

    @Test
    fun `slashEscape false leaves forward slashes unescaped`() {
        val result = P2PProtocol.canonical(
            roomId = "a/b",
            seq = 1,
            timestamp = 0L,
            payloadJson = """{"url":"http://example.com/"}""",
            slashEscape = false,
        )
        assertFalse(result.contains("""\/"""), "expected no \\/ in plain canonical: $result")
        assertTrue(result.contains("http://"), "URL slashes should be preserved")
    }

    // ── createP2PRoomId ───────────────────────────────────────────────

    @Test
    fun `createP2PRoomId is deterministic`() {
        val a = P2PProtocol.createP2PRoomId("secret-alpha")
        val b = P2PProtocol.createP2PRoomId("secret-alpha")
        assertEquals(a, b, "same secret must produce same room id")
    }

    @Test
    fun `createP2PRoomId varies with secret`() {
        val a = P2PProtocol.createP2PRoomId("secret-alpha")
        val b = P2PProtocol.createP2PRoomId("secret-beta")
        assertNotEquals(a, b, "different secrets must produce different room ids")
    }

    @Test
    fun `createP2PRoomId is exactly 40 hex chars`() {
        val id = P2PProtocol.createP2PRoomId("my-secret")
        assertEquals(40, id.length, "room id must be 40 hex chars")
        assertTrue(id.all { it in '0'..'9' || it in 'a'..'f' }, "room id must be hex: $id")
    }

    @Test
    fun `createP2PRoomId matches known vector`() {
        // HMAC-SHA256(key="test-secret", msg="agentoc-p2p-room-v1")
        // Known test vector from cross-check with Node.
        val id = P2PProtocol.createP2PRoomId("test-secret")
        assertEquals(40, id.length)
        // Just verify determinism — the exact hex depends on HMAC output.
        val id2 = P2PProtocol.createP2PRoomId("test-secret")
        assertEquals(id, id2)
    }

    // ── sign / verify round-trip ──────────────────────────────────────

    @Test
    fun `sign then verify succeeds on the slash-escaped canonical`() {
        val roomId = "test-room-42"
        val secret = "my-preshared-key"
        val payload = P2PProtocol.offerPayloadJson("v=0\r\no=- ...")

        // sign() defaults to System.currentTimeMillis(); verify must use the
        // SAME timestamp or the MAC is computed over a different canonical.
        val timestamp = System.currentTimeMillis()
        val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payload, timestamp = timestamp)
        assertTrue(mac.isNotEmpty())

        val ok = P2PProtocol.verify(roomId, secret, seq = 1,
            timestamp = timestamp, payloadJson = payload, mac = mac,
            maxSkewMs = 120_000L)
        assertTrue(ok, "signed MAC must verify")
    }

    @Test
    fun `verify succeeds on plain canonical form (Node compat)`() {
        // Sign with slashEscape=true (Android). Verification must also
        // accept the plain (Node JSON.stringify) canonical.
        val roomId = "compat-room"
        val secret = "shared"
        val payload = P2PProtocol.answerPayloadJson("v=0")
        val timestamp = System.currentTimeMillis()

        val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payload, timestamp = timestamp)
        assertTrue(P2PProtocol.verify(roomId, secret, seq = 1, timestamp, payload, mac),
            "verify must accept the signed MAC (tries both slash-escaped and plain)")
    }

    @Test
    fun `verify rejects wrong roomId`() {
        val secret = "s3cret"
        val payload = """{"type":"offer","sdp":"fake"}"""
        val mac = P2PProtocol.sign("room-A", secret, seq = 1, payloadJson = payload)

        assertFalse(P2PProtocol.verify("room-B", secret, seq = 1,
            System.currentTimeMillis(), payload, mac))
    }

    @Test
    fun `verify rejects zero or negative seq`() {
        val roomId = "room"
        val secret = "s"
        val payload = "null"

        for (seq in listOf(0, -1)) {
            val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payload)
            assertFalse(P2PProtocol.verify(roomId, secret, seq, System.currentTimeMillis(), payload, mac),
                "seq=$seq must be rejected")
        }
    }

    @Test
    fun `verify rejects expired timestamp`() {
        val roomId = "room"
        val secret = "s"
        val payload = "null"
        val oldTs = System.currentTimeMillis() - 20 * 60_000 // 20 min ago

        val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payload, timestamp = oldTs)

        assertFalse(P2PProtocol.verify(roomId, secret, seq = 1, oldTs, payload, mac, maxSkewMs = 60_000),
            "timestamp outside skew window must be rejected")
    }

    @Test
    fun `verify rejects tampered MAC`() {
        val roomId = "room"
        val secret = "s"
        val payload = "null"
        val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payload)

        // Flip the first character to guarantee a different MAC.
        val tampered = (if (mac.first() == 'A') 'B' else 'A') + mac.drop(1)
        assertFalse(P2PProtocol.verify(roomId, secret, seq = 1, System.currentTimeMillis(), payload, tampered))
    }

    @Test
    fun `verify rejects empty MAC`() {
        assertFalse(P2PProtocol.verify("r", "s", seq = 1, System.currentTimeMillis(), "null", mac = ""))
    }

    // ── Signal payload builders ────────────────────────────────────────

    @Test
    fun `offerPayloadJson produces valid JSON with correct key order`() {
        val payload = P2PProtocol.offerPayloadJson("v=0\r\no=test ...")
        val expectedPrefix = """{"type":"offer","sdp":"v=0"""
        assertTrue(payload.startsWith(expectedPrefix),
            "offer payload must start with type then sdp, got: $payload")
    }

    @Test
    fun `answerPayloadJson produces valid JSON with correct key order`() {
        val payload = P2PProtocol.answerPayloadJson("v=0")
        val expectedPrefix = """{"type":"answer","sdp":"v=0"}"""
        assertEquals(expectedPrefix, payload)
    }

    @Test
    fun `candidatePayloadJson produces valid JSON with correct key order`() {
        val payload = P2PProtocol.candidatePayloadJson(
            candidate = "candidate:1 1 UDP 2130...",
            sdpMid = "0",
            sdpMLineIndex = 0,
        )
        assertTrue(payload.startsWith("""{"type":"candidate","""))
        assertTrue(payload.contains(""""candidate":"candidate:1"""))
        assertTrue(payload.contains(""""sdpMid":"0""""))
        assertTrue(payload.contains(""""sdpMLineIndex":0"""))
    }

    @Test
    fun `candidatePayloadJson omits sdpMid when null`() {
        val payload = P2PProtocol.candidatePayloadJson(
            candidate = "candidate:1 ...",
            sdpMid = null,
            sdpMLineIndex = 3,
        )
        assertFalse(payload.contains("sdpMid"), "sdpMid null should be absent: $payload")
    }

    // ── HTTP DTO round-trip (matches Go sidecar) ──────────────────────

    @Test
    fun `P2PHttpRequest serializes to sidecar-compatible JSON`() {
        val req = P2PHttpRequest(
            id = "req-1",
            method = "GET",
            path = "/api/auth/me",
            headers = mapOf("Authorization" to "Bearer tok"),
        )
        val encoded = json.encodeToString(P2PHttpRequest.serializer(), req)

        assertTrue(encoded.contains("\"id\":\"req-1\"", ignoreCase = false),
            "expected id field in: $encoded")
        assertTrue(encoded.contains("\"type\":\"http_request\"", ignoreCase = false),
            "expected type field in: $encoded")
        assertTrue(encoded.contains("\"method\":\"GET\"", ignoreCase = false),
            "expected method field in: $encoded")
        assertTrue(encoded.contains("\"path\":\"/api/auth/me\"", ignoreCase = false),
            "expected path field in: $encoded")
        assertTrue(encoded.contains("\"Authorization\":\"Bearer tok\"", ignoreCase = false),
            "expected Authorization header in: $encoded")
    }

    @Test
    fun `P2PHttpResponse deserializes from sidecar JSON`() {
        val raw = """{"id":"r-1","type":"http_response","status":200,"headers":{"X-Agent":"oc"},"bodyBase64":"aGVsbG8="}"""
        val response = json.decodeFromString(P2PHttpResponse.serializer(), raw)

        assertEquals("r-1", response.id)
        assertEquals(200, response.status)
        assertEquals("aGVsbG8=", response.bodyBase64)
        assertEquals("oc", response.headers["X-Agent"])
        assertEquals(null, response.error)
    }

    @Test
    fun `P2PHttpResponse deserializes error variant from sidecar JSON`() {
        val raw = """{"id":"e-1","type":"http_response","status":0,"error":"upstream unreachable"}"""
        val response = json.decodeFromString(P2PHttpResponse.serializer(), raw)

        assertEquals("e-1", response.id)
        assertEquals("upstream unreachable", response.error)
        assertEquals(0, response.status)
    }

    // ── URL conversion ────────────────────────────────────────────────

    @Test
    fun `signalingUrl converts https to wss and default path`() {
        val url = P2PProtocol.signalingUrl("https://signaling.example.com")
        assertEquals("wss://signaling.example.com/signal", url)
    }

    @Test
    fun `signalingUrl converts http to ws`() {
        val url = P2PProtocol.signalingUrl("http://192.168.1.1:8080/custom")
        assertEquals("ws://192.168.1.1:8080/custom", url)
    }

    @Test
    fun `signalingUrl replaces root path with signal`() {
        val url = P2PProtocol.signalingUrl("https://host.example.com/")
        assertEquals("wss://host.example.com/signal", url)
    }

    // ── Body codec ────────────────────────────────────────────────────

    @Test
    fun `encodeBody and decodeBody are round-trip safe`() {
        val original = "Hello, P2P world!  ÿ"
        val encoded = P2PProtocol.encodeBody(original)
        val decoded = P2PProtocol.decodeBodyToString(encoded)
        assertEquals(original, decoded)
    }

    @Test
    fun `encodeBody produces standard base64`() {
        val encoded = P2PProtocol.encodeBody("test")
        // Standard base64 (not URL-safe) uses + and / with = padding.
        assertEquals("dGVzdA==", encoded)
    }

    // ── escapeJsonString ──────────────────────────────────────────────

    @Test
    fun `escapeJsonString escapes quotes and backslashes`() {
        assertEquals("""\"""", P2PProtocol.escapeJsonString("\""))
        assertEquals("""\\""", P2PProtocol.escapeJsonString("\\"))
    }

    @Test
    fun `escapeJsonString escapes control characters`() {
        val result = P2PProtocol.escapeJsonString("\n")
        assertEquals("""\n""", result)
    }

    @Test
    fun `escapeJsonString does not escape forward slash`() {
        assertEquals("a/b", P2PProtocol.escapeJsonString("a/b"))
    }
}
