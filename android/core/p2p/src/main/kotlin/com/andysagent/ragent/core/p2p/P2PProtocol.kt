package com.andysagent.ragent.core.p2p

import kotlinx.serialization.Serializable
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Core P2P signaling protocol: canonical JSON, HMAC-SHA256 sign/verify,
 * signal-payload builders, HTTP-framing DTOs, and utilities.
 *
 * Implements the exact wire format described by lib/p2p-signal-protocol.mjs
 * and used by static/p2p/ragent-p2p-client.js.
 *
 * Android org.json quirk (slash-escape):
 *   Android's JSONObject.toString() escapes '/' as '\/' (libcore JSONStringer
 *   difference from RFC 4627).  The mobile client signs with the slash-escaped
 *   canonical.  Verification accepts BOTH the slash-escaped (Android) and plain
 *   (Node JSON.stringify) forms for backward compatibility.
 */
object P2PProtocol {

    // ── Canonical JSON ────────────────────────────────────────────────

    /**
     * Build the canonical JSON string that is HMAC'd for envelope signing.
     *
     * Key order MUST be "v", "roomId", "seq", "timestamp", "payload"
     * to match the Node [canonical] reference exactly.
     *
     * @param roomId       the room identifier (always coerced to String)
     * @param seq          strictly-increasing per-connection counter
     * @param timestamp    epoch milliseconds
     * @param payloadJson  pre-serialized JSON value for the "payload" field,
     *                     e.g. '{"type":"offer","sdp":"..."}'  or "null"
     * @param slashEscape  if true, substitute every '/' with '\/'
     *                     (Android / mobile behaviour)
     */
    fun canonical(
        roomId: String,
        seq: Int,
        timestamp: Long,
        payloadJson: String?,
        slashEscape: Boolean = true,
    ): String {
        val sb = StringBuilder(256)
        sb.append("{\"v\":1")
        sb.append(",\"roomId\":\"")
        sb.append(escapeJsonString(roomId))
        sb.append("\"")
        sb.append(",\"seq\":")
        sb.append(seq)
        sb.append(",\"timestamp\":")
        sb.append(timestamp)
        sb.append(",\"payload\":")
        sb.append(payloadJson ?: "null")
        sb.append("}")

        // escapeJsonString does NOT escape '/'.  The raw canonical has
        // literal '/'.  For slashEscape=true (Android/mobile) we replace
        // '/' → '\/' globally.  For slashEscape=false (Node/plain) we
        // return the string unchanged.
        val base = sb.toString()
        return if (slashEscape) base.replace("/", "\\/") else base
    }

    /**
     * Minimal JSON-string escaping (matches JSON.stringify rules):
     *   - " → \"
     *   - \ → \\
     *   - control chars (0x00-0x1F) → \uXXXX
     *
     * NOTE: '/' is NOT escaped here — slash-escaping is controlled
     * by the [slashEscape] parameter in [canonical].
     */
    internal fun escapeJsonString(s: String): String {
        var dirty = false
        for (i in s.indices) {
            val c = s[i]
            if (c == '"' || c == '\\' || c.code < 0x20) {
                dirty = true
                break
            }
        }
        if (!dirty) return s

        val sb = StringBuilder(s.length + 16)
        for (c in s) {
            when (c) {
                '"'  -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> {
                    if (c.code < 0x20) {
                        sb.append(String.format("\\u%04x", c.code))
                    } else {
                        sb.append(c)
                    }
                }
            }
        }
        return sb.toString()
    }

    // ── HMAC helpers ──────────────────────────────────────────────────

    private fun hmacSha256(keyBytes: ByteArray, data: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(keyBytes, "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
    }

    private fun base64UrlEncode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun base64UrlDecode(s: String): ByteArray =
        Base64.getUrlDecoder().decode(s)

    // ── Sign / Verify ─────────────────────────────────────────────────

    /**
     * Produce a base64url HMAC-SHA256 over the slash-escaped canonical
     * (the Android/mobile behaviour).
     */
    fun sign(
        roomId: String,
        secret: String,
        seq: Int,
        payloadJson: String,
        timestamp: Long = System.currentTimeMillis(),
    ): String {
        val canon = canonical(roomId, seq, timestamp, payloadJson, slashEscape = true)
        val mac = hmacSha256(secret.toByteArray(Charsets.UTF_8), canon)
        return base64UrlEncode(mac)
    }

    /**
     * Verify a signal envelope MAC.
     *
     * Tries BOTH slash-escaped and plain canonical forms so that signals
     * from Android clients (slash-escaped) AND from Node/sidecar senders
     * (plain JSON.stringify) are accepted.
     */
    fun verify(
        roomId: String,
        secret: String,
        seq: Int,
        timestamp: Long,
        payloadJson: String,
        mac: String,
        maxSkewMs: Long = 10 * 60_000,
    ): Boolean {
        if (seq < 1) return false
        if (Math.abs(System.currentTimeMillis() - timestamp) > maxSkewMs) return false

        val secretBytes = secret.toByteArray(Charsets.UTF_8)

        val macBytes: ByteArray = try {
            base64UrlDecode(mac)
        } catch (_: Exception) {
            return false
        }

        val slashMac = hmacSha256(secretBytes, canonical(roomId, seq, timestamp, payloadJson, slashEscape = true))
        val plainMac = hmacSha256(secretBytes, canonical(roomId, seq, timestamp, payloadJson, slashEscape = false))

        return MessageDigest.isEqual(macBytes, slashMac) ||
               MessageDigest.isEqual(macBytes, plainMac)
    }

    // ── Room ID ───────────────────────────────────────────────────────

    /**
     * createP2PRoomId(secret) = hex(hmacSha256(secret, "ragent-p2p-room-v1"))[:40]
     */
    fun createP2PRoomId(secret: String): String {
        val mac = hmacSha256(
            secret.toByteArray(Charsets.UTF_8),
            "ragent-p2p-room-v1",
        )
        return mac.joinToString("") { "%02x".format(it) }.take(40)
    }

    // ── Signal-payload builders (key order matches JS reference) ──────

    /** {"type":"offer","sdp":"..."} */
    fun offerPayloadJson(sdp: String, handoffId: String? = null): String {
        require(handoffId == null || handoffId.matches(Regex("[a-f0-9]{32}")))
        val handoff = handoffId?.let { ",\"handoffId\":\"$it\"" }.orEmpty()
        return """{"type":"offer","sdp":"${escapeJsonString(sdp)}"$handoff}"""
    }

    /** {"type":"ice_restart_offer","sdp":"..."} */
    fun iceRestartOfferPayloadJson(sdp: String, handoffId: String? = null): String {
        require(handoffId == null || handoffId.matches(Regex("[a-f0-9]{32}")))
        val handoff = handoffId?.let { ",\"handoffId\":\"$it\"" }.orEmpty()
        return """{"type":"ice_restart_offer","sdp":"${escapeJsonString(sdp)}"$handoff}"""
    }

    /** {"type":"answer","sdp":"..."} */
    fun answerPayloadJson(sdp: String): String =
        """{"type":"answer","sdp":"${escapeJsonString(sdp)}"}"""

    /** {"type":"candidate","candidate":"...","sdpMid":"...","sdpMLineIndex":N} */
    fun candidatePayloadJson(
        candidate: String,
        sdpMid: String?,
        sdpMLineIndex: Int,
    ): String = buildString {
        append("{\"type\":\"candidate\"")
        append(",\"candidate\":\"")
        append(escapeJsonString(candidate))
        append("\"")
        if (sdpMid != null) {
            append(",\"sdpMid\":\"")
            append(escapeJsonString(sdpMid))
            append("\"")
        }
        append(",\"sdpMLineIndex\":")
        append(sdpMLineIndex)
        append("}")
    }

    // ── URL helpers ───────────────────────────────────────────────────

    /**
     * Convert an HTTP(S) base URL to the WebSocket signaling URL.
     *   https://host[:port]/path → wss://host[:port]/signal
     *   http://host[:port]/path  → ws://host[:port]/signal
     * If pathname is "/" it is replaced with "/signal".
     */
    fun signalingUrl(baseUrl: String): String {
        return try {
            val url = java.net.URI(baseUrl)
            val scheme = if (url.scheme == "https") "wss" else "ws"
            val host = url.host
            val port = if (url.port > 0) ":${url.port}" else ""
            val path = if (url.rawPath.isNullOrEmpty() || url.rawPath == "/") "/signal" else url.rawPath
            "$scheme://$host$port$path"
        } catch (_: Exception) {
            // Best-effort fallback: strip http(s)://, replace scheme.
            val s = baseUrl.trimEnd('/')
            when {
                s.startsWith("https://") -> s.replace("https://", "wss://") + "/signal"
                s.startsWith("http://")  -> s.replace("http://", "ws://") + "/signal"
                else                     -> "wss://$s/signal"
            }
        }
    }

    // ── Body codec ────────────────────────────────────────────────────

    /** Encode a byte array to standard base64. */
    fun encodeBody(bytes: ByteArray): String =
        Base64.getEncoder().encodeToString(bytes)

    /** Encode a string (UTF-8) to standard base64. */
    fun encodeBody(text: String): String =
        Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))

    /** Decode standard base64 to bytes. */
    fun decodeBody(base64: String): ByteArray =
        Base64.getDecoder().decode(base64)

    /** Decode standard base64 to UTF-8 string. */
    fun decodeBodyToString(base64: String): String =
        String(decodeBody(base64), Charsets.UTF_8)
}

// ── HTTP-framing DTOs (match p2p/cmd/ragent-p2p-host/main.go) ────────

/**
 * HTTP request sent over the DataChannel to the Go sidecar.
 *
 * JSON shape:
 *   {"id":"...","type":"http_request","method":"GET","path":"/api/...",
 *    "headers":{...},"bodyBase64":"..."}
 */
@Serializable
data class P2PHttpRequest(
    val id: String,
    val type: String = "http_request",
    val method: String,
    val path: String,
    val headers: Map<String, String> = emptyMap(),
    val bodyBase64: String = "",
    val acceptResponseStream: Boolean = false,
    val acceptBinaryResponse: Boolean = false,
)

/**
 * HTTP response received over the DataChannel from the Go sidecar.
 *
 * JSON shape:
 *   {"id":"...","type":"http_response","status":200,
 *    "headers":{...},"bodyBase64":"...","error":null}
 */
@Serializable
data class P2PHttpResponse(
    val id: String,
    val type: String = "http_response",
    val status: Int = 0,
    val headers: Map<String, String> = emptyMap(),
    val bodyBase64: String = "",
    val error: String? = null,
    @kotlinx.serialization.Transient val rawBodyBytes: ByteArray? = null,
) {
    fun decodedBodyBytes(): ByteArray =
        rawBodyBytes ?: if (bodyBase64.isEmpty()) ByteArray(0) else P2PProtocol.decodeBody(bodyBase64)
}

// ── Configuration types ───────────────────────────────────────────────

/** A single ICE server entry. */
data class IceServer(
    val url: String,
    val username: String? = null,
    val password: String? = null,
)

/**
 * Opaque P2P connection candidate produced by the host-side invitation
 * flow and consumed by [P2PSessionFactory].
 */
data class P2PCandidate(
    val signalingUrl: String,
    val roomId: String,
    val secret: String,
    val iceServers: List<IceServer> = listOf(IceServer("stun:stun.l.google.com:19302")),
    /** When true, the signed TURN candidate is the initial carrier, not just an ICE option. */
    val turnOnly: Boolean = false,
)
