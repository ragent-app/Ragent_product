package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests [P2PSignalingClient] message handling, seq monotonic behaviour,
 * and signal dispatch — without requiring a real WebSocket connection.
 *
 * Message parsing and MAC verification are exercised by injecting raw
 * JSON strings via the [P2PSignalingClient.handleMessage] test hook.
 */
class P2PSignalingClientTest {

    @Test fun `handoff requests require a verified versioned signal`() = runTest {
        val room = "handoff-room"
        val secret = "handoff-secret"
        var requests = 0
        val client = P2PSignalingClient("http://127.0.0.1:1", room, secret,
            object : P2PSignalingClient.SignalingCallback {
                override fun onAnswer(sdp: String) = Unit
                override fun onIceCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int) = Unit
                override fun onError(error: String) = Unit
                override fun onCarrierHandoffRequested(timeoutMs: Long, handoffId: String) { requests++ }
            }, this)
        fun signal(seq: Int, version: Int, signingKey: String, timeout: Int = 18_000): String {
            val payload = JSONObject().put("type", "carrier_handoff_requested").put("version", version).put("timeoutMs", timeout).put("handoffId", "a".repeat(32))
            val timestamp = System.currentTimeMillis()
            val mac = P2PProtocol.sign(room, signingKey, seq, payload.toString(), timestamp)
            return JSONObject().put("type", "signal").put("roomId", room).put("envelope",
                JSONObject().put("v", 1).put("roomId", room).put("seq", seq).put("timestamp", timestamp)
                    .put("payload", payload).put("mac", mac)).toString()
        }
        client.handleMessage(signal(1, 1, "wrong-secret"))
        client.handleMessage(signal(1, 2, secret))
        client.handleMessage(signal(2, 1, secret, 20_001))
        assertEquals(0, requests)
        client.handleMessage(signal(3, 1, secret))
        client.handleMessage(signal(3, 1, secret))
        assertEquals(1, requests, "invalid and replayed handoff requests must not be delivered")
        client.close()
    }

    @Test fun `handoff signature matches the Windows host wire format`() {
        val payload = """{"type":"carrier_handoff_requested","version":1,"timeoutMs":18000,"handoffId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"""
        assertTrue(P2PProtocol.verify("handoff-room", "handoff-secret", 1, 1793934000000L,
            payload, "rHBuvmraHhkcDPw6RXYNUKfCEvacrA_hY1TQTsMiZhs", maxSkewMs = Long.MAX_VALUE))
    }

    // ── Signal dispatch: answer ───────────────────────────────────────

    @Test
    fun `verified answer signal is dispatched to callback`() = runTest {
        var dispatched = false
        var sdpValue = ""

        val client = makeClient("room-answer", "key", this,
            onAnswer = { dispatched = true; sdpValue = it })

        val raw = makeAnswerSignal("room-answer", "key", seq = 1,
            sdp = "v=0\r\no=answer-1")
        client.handleMessage(raw)

        assertTrue(dispatched, "answer callback should have been called")
        assertTrue(sdpValue.contains("v=0"), "expected SDP, got: $sdpValue")
        client.close()
    }

    // ── Signal dispatch: ICE candidate ────────────────────────────────

    @Test
    fun `verified ice candidate signal is dispatched to callback`() = runTest {
        val roomId = "room-ice"
        val secret = "ice-key"

        var dispatched = false
        var dispatchedCandidate = ""
        var dispatchedSdpMid: String? = "unchanged"
        var dispatchedSdpMLineIndex = -1

        val client = makeClient(roomId, secret, this,
            onIceCandidate = { c, m, i ->
                dispatched = true
                dispatchedCandidate = c
                dispatchedSdpMid = m
                dispatchedSdpMLineIndex = i
            })

        // Build payload with guaranteed key order (avoid JVM JSONObject reorder).
        val payloadObj = makeCandidatePayloadObj(
            candidate = "candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host",
            sdpMid = "0", sdpMLineIndex = 0,
        )
        val payloadJson = payloadObj.toString()
        val timestamp = System.currentTimeMillis()
        val mac = P2PProtocol.sign(roomId, secret, seq = 1, payloadJson = payloadJson, timestamp = timestamp)

        // Verify MAC directly — should pass.
        assertTrue(
            P2PProtocol.verify(roomId, secret, seq = 1, timestamp, payloadJson, mac),
            "MAC self-verification should pass"
        )

        // Now construct the full signal and test handleMessage.
        val envelope = JSONObject().apply {
            put("v", 1); put("roomId", roomId); put("seq", 1)
            put("timestamp", timestamp); put("payload", payloadObj); put("mac", mac)
        }
        val raw = JSONObject().apply {
            put("type", "signal"); put("roomId", roomId); put("envelope", envelope)
        }.toString()

        client.handleMessage(raw)

        assertTrue(dispatched, "ICE callback should have been called after handleMessage")
        assertTrue(dispatchedCandidate.startsWith("candidate:"),
            "expected candidate prefix, got: $dispatchedCandidate")
        assertEquals("0", dispatchedSdpMid)
        assertEquals(0, dispatchedSdpMLineIndex)
        client.close()
    }

    // ── Seq monotonic ─────────────────────────────────────────────────

    @Test
    fun `sendSignal fails before signaling join without consuming a sequence`() = runTest {
        val client = makeClient("room-seq", "secret", this)

        assertEquals(0, client.outgoingSeq)
        assertFalse(client.sendSignal(P2PProtocol.offerPayloadJson("v=0-offer-1")))
        assertEquals(0, client.outgoingSeq)
        client.close()
    }

    @Test
    fun `incoming sequence resets when the remote signaling join changes`() = runTest {
        var callCount = 0
        val client = makeClient("room-rejoin", "rejoin-key", this,
            onAnswer = { callCount++ })

        client.handleMessage(makeAnswerSignal("room-rejoin", "rejoin-key", seq = 5, sdp = "v=0", joinId = 1))
        client.handleMessage(makeAnswerSignal("room-rejoin", "rejoin-key", seq = 1, sdp = "v=0", joinId = 2))

        assertEquals(2, callCount, "a new remote join must accept a fresh sequence")
        client.close()
    }

    // ── Reject dup / lower seq ───────────────────────────────────────

    @Test
    fun `incoming signal with same seq is dropped`() = runTest {
        val roomId = "room-drop"
        val secret = "drop-key"

        var callCount = 0
        val client = makeClient(roomId, secret, this,
            onAnswer = { callCount++ })

        val raw = makeAnswerSignal(roomId, secret, seq = 1, sdp = "v=0")
        client.handleMessage(raw)
        assertEquals(1, callCount)

        // Same seq again — must be dropped.
        client.handleMessage(raw)
        assertEquals(1, callCount, "duplicate seq must be dropped")
        client.close()
    }

    @Test
    fun `incoming signal with lower seq is dropped`() = runTest {
        val roomId = "room-low"
        val secret = "low-key"

        var callCount = 0
        val client = makeClient(roomId, secret, this,
            onAnswer = { callCount++ })

        // Send seq=5, then seq=3 — second must be rejected.
        client.handleMessage(makeAnswerSignal(roomId, secret, seq = 5, sdp = "v=0"))
        assertEquals(1, callCount)

        client.handleMessage(makeAnswerSignal(roomId, secret, seq = 3, sdp = "v=0"))
        assertEquals(1, callCount, "lower seq must be dropped")
        client.close()
    }

    // ── Bad MAC / wrong room / non-signal ─────────────────────────────

    @Test
    fun `signal with wrong MAC is silently dropped`() = runTest {
        var called = false
        val client = makeClient("room-badmac", "good-key", this,
            onAnswer = { called = true })

        val payloadJson = P2PProtocol.answerPayloadJson("v=0")
        val envelope = JSONObject().apply {
            put("v", 1); put("roomId", "room-badmac"); put("seq", 1)
            put("timestamp", System.currentTimeMillis())
            put("payload", JSONObject(payloadJson))
            put("mac", "BADMACBADMACBADMACBADMACBADMACBADMA")
        }
        val raw = JSONObject().apply {
            put("type", "signal"); put("roomId", "room-badmac"); put("envelope", envelope)
        }.toString()

        client.handleMessage(raw)
        assertTrue(!called, "bad MAC must be dropped")
        client.close()
    }

    @Test
    fun `signal with wrong roomId is silently dropped`() = runTest {
        var called = false
        val client = makeClient("room-correct", "secret", this,
            onAnswer = { called = true })

        // Build a signal for a different room.
        val raw = makeAnswerSignal("room-other", "secret", seq = 1, sdp = "v=0")
        client.handleMessage(raw)
        assertTrue(!called, "wrong roomId must be dropped")
        client.close()
    }

    @Test
    fun `non-signal messages are ignored`() = runTest {
        var called = false
        val client = makeClient("room", "secret", this,
            onAnswer = { called = true })

        client.handleMessage("""{"type":"joined","roomId":"room"}""")
        assertTrue(!called, "non-signal messages must be ignored")
        client.close()
    }

    @Test
    fun `malformed JSON is silently dropped`() = runTest {
        var called = false
        val client = makeClient("room", "secret", this,
            onAnswer = { called = true })

        client.handleMessage("not json at all")
        assertTrue(!called, "malformed JSON must be dropped")
        client.close()
    }

    // ── Helpers ───────────────────────────────────────────────────────

    /**
     * Build a signal envelope payload JSONObject with known-good key order.
     * The JVM test library `org.json:json:20231013` uses `HashMap` internally
     * and scrambles key order when parsing, unlike Android's `LinkedHashMap`.
     * We therefore construct payloads manually (key by key) so that the
     * canonical JSON matches the output of [P2PProtocol.candidatePayloadJson]
     * etc.
     */
    private fun makeAnswerPayloadObj(sdp: String): JSONObject {
        val obj = JSONObject()
        obj.put("type", "answer")
        obj.put("sdp", sdp)
        return obj
    }

    private fun makeCandidatePayloadObj(
        candidate: String, sdpMid: String?, sdpMLineIndex: Int,
    ): JSONObject {
        val obj = JSONObject()
        obj.put("type", "candidate")
        obj.put("candidate", candidate)
        if (sdpMid != null) obj.put("sdpMid", sdpMid)
        obj.put("sdpMLineIndex", sdpMLineIndex)
        return obj
    }

    private fun makeAnswerSignal(
        roomId: String, secret: String, seq: Int, sdp: String, joinId: Int = 0,
    ): String {
        val payloadObj = makeAnswerPayloadObj(sdp)
        val payloadJson = payloadObj.toString()
        val timestamp = System.currentTimeMillis()
        val mac = P2PProtocol.sign(roomId, secret, seq, payloadJson, timestamp)
        val envelope = JSONObject().apply {
            put("v", 1); put("roomId", roomId); put("seq", seq)
            put("timestamp", timestamp); put("payload", payloadObj); put("mac", mac)
        }
        return JSONObject().apply {
            put("type", "signal"); put("roomId", roomId); put("envelope", envelope)
            if (joinId > 0) put("joinId", joinId)
        }.toString()
    }

    private fun makeCandidateSignal(
        roomId: String, secret: String, seq: Int,
        candidate: String, sdpMid: String?, sdpMLineIndex: Int,
    ): String {
        val payloadObj = makeCandidatePayloadObj(candidate, sdpMid, sdpMLineIndex)
        val payloadJson = payloadObj.toString()
        val timestamp = System.currentTimeMillis()
        val mac = P2PProtocol.sign(roomId, secret, seq, payloadJson, timestamp)
        val envelope = JSONObject().apply {
            put("v", 1); put("roomId", roomId); put("seq", seq)
            put("timestamp", timestamp); put("payload", payloadObj); put("mac", mac)
        }
        return JSONObject().apply {
            put("type", "signal"); put("roomId", roomId); put("envelope", envelope)
        }.toString()
    }

    private fun makeClient(
        roomId: String,
        secret: String,
        scope: kotlinx.coroutines.CoroutineScope,
        onAnswer: (String) -> Unit = {},
        onIceCandidate: (String, String?, Int) -> Unit = { _, _, _ -> },
    ): P2PSignalingClient {
        return P2PSignalingClient(
            signalingBaseUrl = "http://localhost:0",
            roomId = roomId,
            secret = secret,
            callback = object : P2PSignalingClient.SignalingCallback {
                override fun onAnswer(sdp: String) = onAnswer(sdp)
                override fun onIceCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int) =
                    onIceCandidate(candidate, sdpMid, sdpMLineIndex)
                override fun onError(error: String) {}
            },
            scope = scope,
        )
    }
}
