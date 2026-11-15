package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.withTimeout

/**
 * OkHttp WebSocket signaling client for the Ragent P2P protocol.
 *
 * Connects to the signalling server at `signalingBaseUrl + "/signal"`,
 * joins the room as role `"mobile"`, and exchanges signed signal
 * envelopes.  Automatically reconnects with exponential backoff on
 * unexpected close or failure.
 *
 * The client is **thread-safe**: [sendSignal] may be called from any
 * thread (it posts the send on the OkHttp dispatcher).
 *
 * ## Protocol (replicates ragent-p2p-client.js)
 *
 * 1. WS connect to `${signalingUrl}/signal` (https→wss, http→ws; path `/`→`/signal`)
 * 2. Send `{ type: 'join', roomId, role: 'mobile' }`.
 * 3. On WS message: if `type !== 'signal'` skip; verify envelope MAC;
 *    skip if `seq <= incomingSeq`; else `incomingSeq = seq`; dispatch.
 * 4. [sendSignal] signs with `++seq` and sends.
 *
 * @param signalingBaseUrl  e.g. `https://signaling.example.com` — the scheme and
 *                          optional path will be rewritten to `wss://` or `ws://`.
 * @param roomId            the P2P room ID (first 40 hex chars of `createP2PRoomId`)
 * @param secret            room pre-shared secret for HMAC
 * @param callback          receives parsed and verified signalling payloads
 * @param scope             coroutine scope for reconnect scheduling
 */
class P2PSignalingClient(
    private val signalingBaseUrl: String,
    private val roomId: String,
    private val secret: String,
    private val callback: SignalingCallback,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO),
) {
    companion object {
        private const val RECONNECT_BASE_MS = 2_000L
        private const val RECONNECT_MAX_MS = 30_000L
    }

    /** Callers interested in verified signalling payloads. */
    interface SignalingCallback {
        fun onAnswer(sdp: String)
        fun onIceCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int)
        fun onError(error: String)
        fun onCarrierHandoffRequested(timeoutMs: Long, handoffId: String) = Unit
    }

    // ── State ─────────────────────────────────────────────────────────

    private val okHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS) // keep-alive through NAT/proxies
        .build()

    private val wsUrl: String = P2PProtocol.signalingUrl(signalingBaseUrl)

    @Volatile internal var outgoingSeq = 0
    @Volatile private var incomingSeq = 0
    @Volatile private var incomingJoinId = 0
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var stopped = false

    private val sendLock = Any()
    private var reconnectAttempts = 0
    private var reconnectJob: Job? = null
    private val reconnectLock = Any()
    @Volatile private var joined = false

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Open the WebSocket, send `join`, and wait for the server to accept.
     * Suspends until the socket is open (or throws on failure).
     */
    suspend fun connect() {
        val priorReconnect = synchronized(reconnectLock) { reconnectJob.also { reconnectJob = null } }
        priorReconnect?.cancel()
        try {
            webSocket?.close(1000, "reconnecting")
        } catch (_: Exception) {
            // A failed/closed socket cannot block a new signaling attempt.
        }
        webSocket = null
        joined = false
        stopped = false
        reconnectAttempts = 0
        outgoingSeq = 0
        incomingSeq = 0
        incomingJoinId = 0
        openSocket()
    }

    /**
     * Sign [payloadJson] and send it as a `{ type: "signal", ... }` message.
     * Thread-safe: may be called from WebRTC ICE-candidate callbacks.
     *
     * @param payloadJson  pre-serialized signal payload, e.g.
     *                     `{"type":"offer","sdp":"v=0..."}`.
     */
    fun sendSignal(payloadJson: String): Boolean = synchronized(sendLock) {
        if (!joined) return false
        val socket = webSocket ?: return false
        val seq = ++outgoingSeq
        val timestamp = System.currentTimeMillis()
        val mac = P2PProtocol.sign(roomId, secret, seq, payloadJson, timestamp)

        val envelope = JSONObject()
        envelope.put("v", 1)
        envelope.put("roomId", roomId)
        envelope.put("seq", seq)
        envelope.put("timestamp", timestamp)
        envelope.put("payload", JSONObject(payloadJson))
        envelope.put("mac", mac)

        val message = JSONObject()
        message.put("type", "signal")
        message.put("roomId", roomId)
        message.put("envelope", envelope)

        socket.send(message.toString())
    }

    /** Graceful shutdown: cancel reconnect, close socket. */
    fun close() {
        stopped = true
        val priorReconnect = synchronized(reconnectLock) { reconnectJob.also { reconnectJob = null } }
        priorReconnect?.cancel()
        try {
            webSocket?.close(1000, "bye")
        } catch (_: Exception) {
            // Socket may already be closed / dead.
        }
        webSocket = null
        joined = false
    }

    // ── Internals ─────────────────────────────────────────────────────

    private suspend fun openSocket() {
        withTimeout(5_000L) { suspendCancellableCoroutine<Unit> { cont ->
            var openingSocket: WebSocket? = null
            joined = false
            val request = Request.Builder().url(wsUrl).build()

            val listener = object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (stopped || this@P2PSignalingClient.webSocket !== webSocket) {
                        webSocket.close(1000, "stale signaling socket")
                        return
                    }

                    // Send join.
                    val join = JSONObject()
                    join.put("type", "join")
                    join.put("roomId", roomId)
                    join.put("role", "mobile")
                    if (!webSocket.send(join.toString()) && cont.isActive) {
                        webSocket.close(1000, "join send failed")
                        cont.resumeWithException(IllegalStateException("Signaling join could not be sent"))
                    }

                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (this@P2PSignalingClient.webSocket !== webSocket) return
                    try {
                        val message = JSONObject(text)
                        if (message.optString("type") == "joined" && message.optString("roomId") == roomId && message.optString("role") == "mobile") {
                            joined = true
                            if (cont.isActive) cont.resume(Unit)
                            return
                        }
                    } catch (_: Exception) { }
                    handleMessage(text)
                }

                override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                ) {
                    if (this@P2PSignalingClient.webSocket !== webSocket) return
                    this@P2PSignalingClient.webSocket = null
                    joined = false
                    val error = "Signaling socket failed: ${t.message ?: t.javaClass.simpleName}"
                    if (cont.isActive) {
                        cont.resumeWithException(IllegalStateException(error, t))
                    } else {
                        callback.onError(error)
                        scheduleReconnect()
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // A peer can omit its close status (reported as 1005,
                    // which is forbidden in an outgoing close frame).
                    if (this@P2PSignalingClient.webSocket === webSocket) webSocket.close(1000, "")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (this@P2PSignalingClient.webSocket !== webSocket) return
                    this@P2PSignalingClient.webSocket = null
                    joined = false
                    val error = "Signaling socket closed ($code): ${reason.ifBlank { "no reason" }}"
                    if (cont.isActive) {
                        cont.resumeWithException(IllegalStateException(error))
                    } else {
                        callback.onError(error)
                        scheduleReconnect()
                    }
                }
            }

            openingSocket = okHttpClient.newWebSocket(request, listener)
            this@P2PSignalingClient.webSocket = openingSocket
            if (!cont.isActive) {
                val socket = openingSocket
                if (this@P2PSignalingClient.webSocket === socket) {
                    this@P2PSignalingClient.webSocket = null
                    try { socket?.cancel() } catch (_: Exception) {}
                }
            }

            cont.invokeOnCancellation {
                val socket = openingSocket
                if (this@P2PSignalingClient.webSocket === socket) {
                    this@P2PSignalingClient.webSocket = null
                    try { socket?.close(1000, "cancelled") } catch (_: Exception) {}
                }
            }
        } }

        reconnectAttempts = 0
    }

    internal fun handleMessage(raw: String) {
        try {
            val msg = JSONObject(raw)

            if (msg.optString("type") != "signal") return

            val envelope = msg.optJSONObject("envelope") ?: return
            val envRoomId = envelope.optString("roomId", "")
            val envSeq = envelope.optInt("seq", 0)
            val envTimestamp = envelope.optLong("timestamp", 0L)
            val envMac = envelope.optString("mac", "")
            val envPayload = envelope.opt("payload")

            if (envRoomId != roomId) {
                diagnostic("drop: room mismatch")
                return
            }
            if (envMac.isEmpty()) {
                diagnostic("drop: empty mac seq=$envSeq")
                return
            }

            // Re-serialize the payload to a JSON string for canonical verification.
            val payloadStr: String = when (envPayload) {
                null, JSONObject.NULL -> "null"
                is JSONObject -> envPayload.toString()
                else -> envPayload.toString()
            }

            if (!P2PProtocol.verify(envRoomId, secret, envSeq, envTimestamp, payloadStr, envMac)) {
                diagnostic("drop: verify failed seq=$envSeq payloadBytes=${payloadStr.length}")
                return
            }

            val senderJoinId = msg.optInt("joinId", 0)
            if (senderJoinId > 0 && senderJoinId != incomingJoinId) {
                incomingJoinId = senderJoinId
                incomingSeq = 0
            }

            if (envSeq <= incomingSeq) {
                diagnostic("drop: replay seq=$envSeq <= $incomingSeq")
                return
            }
            incomingSeq = envSeq

            // Dispatch to callback.
            if (envPayload is JSONObject) {
                when (envPayload.optString("type")) {
                    "carrier_handoff_requested" -> {
                        val timeout = envPayload.optLong("timeoutMs", 0L)
                        val handoffId = envPayload.optString("handoffId", "")
                        if (envPayload.optInt("version", 0) == 1 && timeout in 5_001L..20_000L && handoffId.matches(Regex("[a-f0-9]{32}"))) {
                            callback.onCarrierHandoffRequested(timeout, handoffId)
                        }
                    }
                    "answer" -> {
                        val sdp = envPayload.optString("sdp", "")
                        if (sdp.isNotEmpty()) callback.onAnswer(sdp)
                    }
                    "candidate" -> {
                        val candidate = envPayload.optString("candidate", "")
                        val sdpMid = envPayload.optString("sdpMid")
                            .takeIf { it.isNotEmpty() }
                        val sdpMLineIndex = envPayload.optInt("sdpMLineIndex", 0)
                        if (candidate.isNotEmpty()) {
                            diagnostic("remote candidate verified seq=$envSeq")
                            callback.onIceCandidate(candidate, sdpMid, sdpMLineIndex)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            diagnostic("malformed signal: ${e.javaClass.simpleName}")
            // Malformed JSON — silently drop per the reference client.
        }
    }

    private fun diagnostic(message: String) {
        // Logging must never change protocol delivery/drop semantics, including
        // when the Android logger is unavailable in a plain-JVM test host.
        runCatching { android.util.Log.i("Ragent.P2PSignal", message) }
    }

    private fun scheduleReconnect() {
        synchronized(reconnectLock) {
            if (stopped || reconnectJob?.isActive == true) return
            val job = scope.launch(start = CoroutineStart.LAZY) {
                while (isActive && !stopped) {
                    val delayMs = minOf(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (1L shl reconnectAttempts.coerceAtMost(4)))
                    reconnectAttempts++
                    delay(delayMs)
                    if (!isActive || stopped) return@launch
                    incomingSeq = 0
                    incomingJoinId = 0
                    try {
                        openSocket()
                        return@launch
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // Continue in this job: scheduling recursively while it
                        // is active would suppress every retry after the first.
                    }
                }
            }
            reconnectJob = job
            job.invokeOnCompletion {
                val retry = synchronized(reconnectLock) {
                    if (reconnectJob !== job) false else {
                        reconnectJob = null
                        !stopped && !joined && scope.isActive
                    }
                }
                // A freshly joined socket can close before the job finishes.
                if (retry) scheduleReconnect()
            }
            job.start()
        }
    }
}
