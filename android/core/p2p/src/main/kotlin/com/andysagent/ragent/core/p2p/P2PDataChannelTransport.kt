package com.andysagent.ragent.core.p2p

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.resume

// ── Public abstraction (injectable / fake-able) ───────────────────────

/** The individual request expired; this alone does not prove the carrier is dead. */
class P2PRequestTimeoutException : IllegalStateException("P2P request timed out")

/** A P2P transport session that can tunnel HTTP requests over a DataChannel. */
interface P2PSession {
    val isOpen: Boolean

    /** Monotonic count of successful responses received on this session. */
    val successfulResponseGeneration: Long get() = 0L

    /** Milliseconds elapsed since the last inbound DataChannel frame/chunk, or [Long.MAX_VALUE] if none. */
    val lastInboundFrameElapsedMs: Long get() = Long.MAX_VALUE

    /** Monotonic count of inbound DataChannel frames/chunks observed on this session. */
    val inboundFrameGeneration: Long get() = 0L

    /** True when `dc_keepalive_v1` has been negotiated and [probeLiveness] should be preferred over `/api/auth/me`. */
    val supportsKeepaliveProbe: Boolean get() = false

    /** Serialized JSON invalidation payloads pushed by the peer over the DataChannel. */
    val invalidations: Flow<String> get() = emptyFlow()

    /** True when `dc_push_invalidation_v1` has been negotiated with the peer. */
    val supportsPushInvalidations: Boolean get() = false

    /**
     * Receives unexpected transport loss. Explicit [close] calls do not invoke
     * this listener; the connectivity owner decides when to reconnect.
     */
    fun setUnexpectedCloseListener(listener: ((String) -> Unit)?) {}

    /** Receives a non-destructive suspect signal (e.g. ICE entered DISCONNECTED while open). */
    fun setCarrierSuspectListener(listener: (() -> Unit)?) {}

    /**
     * Probe carrier liveness within [timeoutMs].
     * Uses `dc_ping`/`dc_pong` when `dc_keepalive_v1` is negotiated; otherwise falls back to `GET /api/auth/me`.
     */
    suspend fun probeLiveness(timeoutMs: Long): Boolean = withTimeoutOrNull(timeoutMs) {
        request(
            P2PHttpRequest(
                id = java.util.UUID.randomUUID().toString(),
                method = "GET",
                path = "/api/auth/me",
            ),
        ).getOrNull()?.let { it.error == null && it.status > 0 } == true
    } ?: false

    /** A verified peer requests a new carrier while this session stays usable. */
    fun setCarrierHandoffListener(listener: ((Long, String) -> Unit)?) {}

    /** Bind a replacement offer to the standby that requested the handoff. */
    fun configureHandoffOffer(handoffId: String): Boolean = false

    /** Release/reacquire signaling without intentionally closing the carrier. */
    fun suspendSignalingForHandoff(): Boolean = false
    suspend fun resumeSignalingAfterHandoff(): Boolean = false

    /**
     * Establish the signalling + WebRTC connection.
     * Returns [Result.success] once the DataChannel reports OPEN,
     * or [Result.failure] on timeout / error.
     */
    suspend fun connect(): Result<Unit>

    /**
     * Send an HTTP request and wait for the corresponding response.
     * Responses are correlated by [P2PHttpRequest.id].
     */
    suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse>

    /** Send an HTTP request with an explicit timeout override in milliseconds. */
    suspend fun request(request: P2PHttpRequest, timeoutMs: Long?): Result<P2PHttpResponse> =
        if (timeoutMs == null || timeoutMs <= 0L) request(request)
        else withTimeoutOrNull(timeoutMs) { request(request) } ?: Result.failure(P2PRequestTimeoutException())

    /** Streams a bounded binary HTTP body without materializing or Base64-encoding the full body. */
    suspend fun requestStream(request: P2PHttpRequest, totalBytes: Long, sha256: String,
        openBody: () -> java.io.InputStream, onProgress: (sentBytes: Long, totalBytes: Long) -> Unit = { _, _ -> }): Result<P2PHttpResponse> =
        Result.failure(UnsupportedOperationException("P2P streaming request bodies are unsupported"))

    /** Release all resources (DataChannel, PeerConnection, signalling socket). */
    fun close()
}

/** Injectable factory so ConnectivitySupervisor can remain testable. */
fun interface P2PSessionFactory {
    suspend fun create(candidate: P2PCandidate): P2PSession
}

/** Large, read-only responses use the bulk channel; live events stay interactive. */
internal fun isBulkReadRequest(request: P2PHttpRequest): Boolean {
    if (request.method != "GET") return false
    val path = request.path.substringBefore('?')
    if (path == "/api/workspace-files/content") return true
    if (!path.startsWith("/api/sessions/") || !(path.endsWith("/events") || path.endsWith("/events/wait"))) return false
    val query = request.path.substringAfter('?', "").split('&').toSet()
    return "filter=all" in query && "liveOnly=1" !in query
}

/** Background polls and long-polls use the dedicated background channel when available. */
internal fun isBackgroundReadRequest(request: P2PHttpRequest): Boolean {
    if (request.method != "GET") return false
    val path = request.path.substringBefore('?')
    if (path == "/api/sessions") return true
    if (path == "/api/runtime/summary" || path.startsWith("/api/runtime/summary/")) return true
    if (path == "/api/windows-broker" || path.startsWith("/api/windows-broker/")) return true
    if (path.startsWith("/api/sessions/") && path.endsWith("/events/wait")) {
        val query = request.path.substringAfter('?', "").split('&').filter { it.isNotEmpty() }.toSet()
        return "liveOnly=1" in query
    }
    return false
}

internal enum class PrimarySendLane {
    HIGH,
    NORMAL,
}

internal fun primaryLaneForRequest(request: P2PHttpRequest): PrimarySendLane =
    when (request.method.uppercase()) {
        "POST", "PATCH", "DELETE", "PUT" -> PrimarySendLane.HIGH
        else -> PrimarySendLane.NORMAL
    }

/** Two-lane priority gate on the primary DataChannel so interactive mutations jump ahead of reads. */
internal class PrimaryLaneGate {
    private val lock = Any()
    private var holder: Waiter? = null
    private val lane0 = ArrayDeque<Waiter>()
    private val lane1 = ArrayDeque<Waiter>()

    private class Waiter {
        val ready = CompletableDeferred<Unit>()
        var cancelled = false
    }

    suspend fun <T> withLane(lane: PrimarySendLane, block: suspend () -> T): T {
        val waiter = acquire(lane)
        try {
            return block()
        } finally {
            release(waiter)
        }
    }

    private suspend fun acquire(lane: PrimarySendLane): Waiter {
        val waiter = synchronized(lock) {
            val w = Waiter()
            if (holder == null && lane0.isEmpty() && lane1.isEmpty()) {
                holder = w
                return w
            }
            if (lane == PrimarySendLane.HIGH) lane0.addLast(w) else lane1.addLast(w)
            w
        }
        try {
            waiter.ready.await()
            return waiter
        } catch (e: Throwable) {
            val mustRelease = synchronized(lock) {
                waiter.cancelled = true
                lane0.remove(waiter)
                lane1.remove(waiter)
                holder === waiter
            }
            if (mustRelease) release(waiter)
            throw e
        }
    }

    private fun release(waiter: Waiter) {
        var nextToResume: Waiter? = null
        synchronized(lock) {
            if (holder !== waiter) return
            holder = null
            while (true) {
                val candidate = if (lane0.isNotEmpty()) lane0.removeFirst()
                else if (lane1.isNotEmpty()) lane1.removeFirst()
                else break
                if (candidate.cancelled) continue
                holder = candidate
                nextToResume = candidate
                break
            }
        }
        nextToResume?.ready?.complete(Unit)
    }
}

internal class BulkChannelClosedException : IllegalStateException("P2P bulk channel closed")
internal class BgChannelClosedException : IllegalStateException("P2P background channel closed")

internal suspend fun requestWithBulkFallback(
    request: P2PHttpRequest,
    attempt: suspend (P2PHttpRequest, Boolean) -> Result<P2PHttpResponse>,
): Result<P2PHttpResponse> {
    val result = attempt(request, true)
    if (!isBulkReadRequest(request) || result.exceptionOrNull() !is BulkChannelClosedException) return result
    // The retry uses a fresh wire ID so a late response from the closed
    // channel cannot be mistaken for the response on the primary channel.
    return attempt(request.copy(id = java.util.UUID.randomUUID().toString()), false)
        .map { it.copy(id = request.id) }
}

internal suspend fun requestWithSecondaryFallback(
    request: P2PHttpRequest,
    attempt: suspend (P2PHttpRequest, Boolean) -> Result<P2PHttpResponse>,
): Result<P2PHttpResponse> {
    val result = attempt(request, true)
    val failure = result.exceptionOrNull()
    val secondaryEligible = isBulkReadRequest(request) || isBackgroundReadRequest(request)
    if (!secondaryEligible || (failure !is BulkChannelClosedException && failure !is BgChannelClosedException)) {
        return result
    }
    return attempt(request.copy(id = java.util.UUID.randomUUID().toString()), false)
        .map { it.copy(id = request.id) }
}

// ── Real WebRTC implementation ────────────────────────────────────────

/**
 * Android WebRTC DataChannel transport that replicates the protocol of
 * [static/p2p/ragent-p2p-client.js] exactly.
 *
 * * DataChannel label `ragent-http`, ordered delivery.
 * * Offer/answer exchange + ICE candidates via [P2PSignalingClient].
 * * HTTP request/response framing matches the Go sidecar DTOs.
 * * Per-request timeout and id-based response correlation.
 *
 * Instantiate this on a thread with an active Android [Context].
 * For pure-JVM tests use a fake [P2PSession] — do NOT instantiate
 * real `PeerConnection` in unit tests.
 */
class WebRTCDataChannelTransport(
    private val candidate: P2PCandidate,
    private val appContext: Context,
    private val connectTimeoutMs: Long = 15_000L,
    private val requestTimeoutMs: Long = 60_000L,
) : P2PSession {

    private companion object {
        const val TAG = "Ragent.P2P"
        private const val LARGE_REQUEST_TIMEOUT_MS = 180_000L
        private const val BULK_OPEN_TIMEOUT_MS = 10_000L
        private val debugCarrierSequence = java.util.concurrent.atomic.AtomicLong()

        // The factory owns native threads (notably the signaling thread) and
        // WebRTC allows one initialize per process. Disposing it while a
        // PeerConnection.close() is still draining aborts with
        // "pthread_mutex_lock called on a destroyed mutex" on the signaling
        // thread (observed as a deterministic SIGABRT on connection close).
        // Share one process-lifetime factory instead; only the
        // PeerConnection and DataChannel are per-session resources.
        @Volatile
        private var sharedFactory: PeerConnectionFactory? = null

        fun obtainSharedFactory(appContext: Context): PeerConnectionFactory {
            sharedFactory?.let { return it }
            synchronized(this) {
                sharedFactory?.let { return it }
                val options = PeerConnectionFactory.InitializationOptions
                    .builder(appContext.applicationContext)
                    .createInitializationOptions()
                PeerConnectionFactory.initialize(options)
                val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
                    ?: error("PeerConnectionFactory builder returned null")
                sharedFactory = factory
                return factory
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private class UploadSendTelemetry {
        var blockedNanos = 0L
        var peakBufferedBytes = 0L
        var blockedPolls = 0L
    }

    /** Opt-in diagnostics contain no candidate addresses, credentials, or file data. */
    private fun traceUploadRtcStats() {
        if (!debuggable || !Log.isLoggable("Ragent.Upload", Log.DEBUG)) return
        runCatching {
            peerConnection?.getStats { report ->
                runCatching {
                    val entries = report.statsMap
                    val pairId = entries.values.firstOrNull { it.type == "transport" &&
                        it.members["selectedCandidatePairId"] is String }?.members?.get("selectedCandidatePairId") as? String
                    val pair = pairId?.let { entries[it] } ?: entries.values.firstOrNull { it.type == "candidate-pair" &&
                        it.members["nominated"] == true && it.members["state"] == "succeeded" }
                    val local = (pair?.members?.get("localCandidateId") as? String)?.let { entries[it] }
                    val remote = (pair?.members?.get("remoteCandidateId") as? String)?.let { entries[it] }
                    Log.d("Ragent.Upload", "stage=rtc_stats localType=${local?.members?.get("candidateType")}" +
                        " localProtocol=${local?.members?.get("protocol")} relayProtocol=${local?.members?.get("relayProtocol")}" +
                        " remoteType=${remote?.members?.get("candidateType")} remoteProtocol=${remote?.members?.get("protocol")}" +
                        " rttSeconds=${pair?.members?.get("currentRoundTripTime")} outgoingBps=${pair?.members?.get("availableOutgoingBitrate")}")
                }
            }
        }
    }
    /** Selected ICE path diagnostics deliberately exclude candidate addresses and identifiers. */
    private fun traceIceRtcStats(stage: String) {
        if (!debuggable || !Log.isLoggable("Ragent.Ice", Log.DEBUG)) return
        runCatching {
            peerConnection?.getStats { report ->
                runCatching {
                    val entries = report.statsMap
                    val pairId = entries.values.firstOrNull { it.type == "transport" &&
                        it.members["selectedCandidatePairId"] is String }?.members?.get("selectedCandidatePairId") as? String
                    val pair = pairId?.let { entries[it] } ?: entries.values.firstOrNull { it.type == "candidate-pair" &&
                        it.members["nominated"] == true && it.members["state"] == "succeeded" }
                    val local = (pair?.members?.get("localCandidateId") as? String)?.let { entries[it] }
                    val remote = (pair?.members?.get("remoteCandidateId") as? String)?.let { entries[it] }
                    fun category(value: Any?, allowed: Set<String>): String =
                        (value as? String)?.lowercase()?.takeIf { it in allowed } ?: "unknown"
                    val types = setOf("host", "srflx", "prflx", "relay")
                    val protocols = setOf("udp", "tcp", "tls")
                    val rtt = (pair?.members?.get("currentRoundTripTime") as? Number)?.toDouble()
                        ?.takeIf { it.isFinite() && it >= 0.0 && it <= 3600.0 }
                    Log.d("Ragent.Ice", "channel=$debugCarrierId stage=$stage" +
                        " localType=${category(local?.members?.get("candidateType"), types)}" +
                        " localProtocol=${category(local?.members?.get("protocol"), protocols)}" +
                        " relayProtocol=${category(local?.members?.get("relayProtocol"), protocols)}" +
                        " remoteType=${category(remote?.members?.get("candidateType"), types)}" +
                        " remoteProtocol=${category(remote?.members?.get("protocol"), protocols)} rttSeconds=$rtt")
                }
            }
        }
    }

    private val debugCarrierId = debugCarrierSequence.incrementAndGet()
    private val debuggable = runCatching {
        appContext.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
    }.getOrDefault(false)
    private fun traceConnect(stage: String) {
        if (debuggable) runCatching { Log.d(TAG, "connect_trace channel=$debugCarrierId stage=$stage") }
    }
    @Volatile private var iceDisconnected = false
    @Volatile private var carrierSuspectListener: (() -> Unit)? = null
    private val iceDisconnectWatchdog = IceDisconnectWatchdog(
        scope = scope,
        onDisconnectStarted = {
            if (isOpen && !closeNotified) {
                carrierSuspectListener?.invoke() ?: scope.launch { probeLiveness(2_500L) }
            }
        },
        onPersistentDisconnect = {
            if (isOpen && iceDisconnected) failConnection("ICE connection remained disconnected")
        },
    )
    private val primaryLaneGate = PrimaryLaneGate()
    private val bulkOutboundFrameMutex = Mutex()
    private val bgOutboundFrameMutex = Mutex()
    private val connectionStateWakeup = ConnectionStateWakeup()
    private val serverReady = CompletableDeferred<Set<String>>()
    @Volatile private var serverReadyFeatures: Set<String>? = null
    private val json = Json {
        ignoreUnknownKeys = true
        // The host contract requires discriminator/default fields such as
        // `type: "http_request"` to be present on the wire.
        encodeDefaults = true
    }

    // WebRTC objects
    private var factory: PeerConnectionFactory? = null
    @Volatile private var peerConnection: PeerConnection? = null
    private var dataChannel: DataChannel? = null
    @Volatile private var bulkChannel: DataChannel? = null
    @Volatile private var bulkChannelSupported = false
    private val bulkRetryGate = BulkChannelRetryGate()
    private val bulkPending = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var bgChannel: DataChannel? = null
    @Volatile private var bgChannelSupported = false
    private val bgRetryGate = BulkChannelRetryGate()
    private val bgPending = ConcurrentHashMap.newKeySet<String>()

    // Signalling
    private var signaling: P2PSignalingClient? = null
    @Volatile private var carrierHandoffListener: ((Long, String) -> Unit)? = null
    @Volatile private var handoffOfferId: String? = null

    @Volatile override var isOpen: Boolean = false
        private set

    private var unexpectedCloseListener: ((String) -> Unit)? = null
    @Volatile private var closeNotified = false

    // Pending HTTP requests keyed by request id.
    private val pending = ConcurrentHashMap<String, PendingRequest>()
    private val pendingRegistrationLock = Any()
    private val debugTrackedRequests = ConcurrentHashMap.newKeySet<String>()
    // Bounded debug-only metadata lets late frames retain their coarse type
    // after the corresponding request has timed out. Never retain paths or bodies.
    private val debugRequestCategories = java.util.Collections.synchronizedMap(
        object : LinkedHashMap<String, String>(128, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 512
        },
    )
    private val successfulResponses = java.util.concurrent.atomic.AtomicLong()
    override val successfulResponseGeneration: Long get() = successfulResponses.get()
    @Volatile internal var nanoClock: () -> Long = System::nanoTime
    private val lastInboundFrameNanos = java.util.concurrent.atomic.AtomicLong(0L)
    private val inboundFrames = java.util.concurrent.atomic.AtomicLong(0L)
    override val lastInboundFrameElapsedMs: Long
        get() {
            if (inboundFrames.get() == 0L) return Long.MAX_VALUE
            val last = lastInboundFrameNanos.get()
            return ((nanoClock() - last).coerceAtLeast(0L)) / 1_000_000L
        }
    override val inboundFrameGeneration: Long get() = inboundFrames.get()
    override val supportsKeepaliveProbe: Boolean
        get() = serverReadyFeatures?.contains("dc_keepalive_v1") == true
    private val invalidationEvents = MutableSharedFlow<String>(
        extraBufferCapacity = 64,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val invalidations: Flow<String> = invalidationEvents.asSharedFlow()
    @Volatile override var supportsPushInvalidations: Boolean = false
        private set
    private val pendingPongs = ConcurrentHashMap<String, CompletableDeferred<Boolean>>()
    private val responseStreams = P2PHttpResponseAssembler()

    // ICE gathering can produce candidates before createOfferSuspend() returns.
    // Keep them behind the offer so the signaling sequence cannot deliver
    // candidate(seq=2) before offer(seq=1), which the host-side monotonic
    // sequence guard must reject.
    private val pendingLocalCandidates = ConcurrentLinkedQueue<String>()
    private val pendingRemoteCandidates = ConcurrentLinkedQueue<IceCandidate>()
    private val localCandidateLock = Any()
    private val remoteCandidateLock = Any()
    @Volatile private var offerSignalSent = false
    @Volatile private var connectFailure: String? = null
    @Volatile private var remoteDescriptionSetting = false
    @Volatile private var remoteDescriptionSet = false

    // ── Lazy observers (created after peerConnection / dataChannel exist) ──

    private val peerObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(ice: IceCandidate?) {
            if (ice != null) {
                Log.i(TAG, "local_candidate type=" + ice.sdp.substringAfter(" typ ", "unknown").substringBefore(' '))
                val payload = P2PProtocol.candidatePayloadJson(
                    candidate = ice.sdp,
                    sdpMid = ice.sdpMid,
                    sdpMLineIndex = ice.sdpMLineIndex,
                )
                val sendImmediately = synchronized(localCandidateLock) {
                    if (offerSignalSent) true else {
                        pendingLocalCandidates.add(payload)
                        false
                    }
                }
                if (sendImmediately && signaling?.sendSignal(payload) != true) {
                    failConnection("Unable to send local ICE candidate")
                }
            }
        }

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            connectionStateWakeup.signal()
            runCatching { Log.i(TAG, "ice_connection_state=$state channel=$debugCarrierId") }
            when (state) {
                PeerConnection.IceConnectionState.DISCONNECTED -> {
                    traceIceRtcStats("disconnected")
                    iceDisconnected = true
                    if (isOpen) iceDisconnectWatchdog.disconnected()
                }
                PeerConnection.IceConnectionState.CONNECTED,
                PeerConnection.IceConnectionState.COMPLETED -> {
                    if (state == PeerConnection.IceConnectionState.CONNECTED) traceIceRtcStats("connected")
                    traceConnect("ice_connected")
                    iceDisconnected = false
                    iceDisconnectWatchdog.recovered()
                }
                PeerConnection.IceConnectionState.FAILED,
                PeerConnection.IceConnectionState.CLOSED -> {
                    iceDisconnected = false
                    iceDisconnectWatchdog.recovered()
                    if (!closeNotified) failConnection("ICE connection entered $state")
                }
                else -> Unit
            }
        }
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) { Log.i(TAG, "ice_gathering_state=" + state) }
        override fun onAddStream(stream: org.webrtc.MediaStream?) {}
        override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
        override fun onDataChannel(channel: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(
            receiver: org.webrtc.RtpReceiver?,
            streams: Array<out org.webrtc.MediaStream>?,
        ) {}
    }

    private val dataChannelObserver = object : DataChannel.Observer {
        override fun onStateChange() {
            when (dataChannel?.state()) {
                DataChannel.State.OPEN -> {
                    val accepted = synchronized(pendingRegistrationLock) {
                        if (closeNotified) false else { isOpen = true; true }
                    }
                    if (!accepted) return
                    // ICE may have entered DISCONNECTED before the channel
                    // opened. Start the same bounded recovery in that order.
                    iceDisconnectWatchdog.channelOpened(iceDisconnected)
                    traceConnect("channel_open")
                    runCatching { Log.i(TAG, "datachannel_open channel=$debugCarrierId") }
                }
                DataChannel.State.CLOSING, DataChannel.State.CLOSED -> {
                    failConnection("DataChannel entered ${dataChannel?.state()}")
                }
                else -> Unit
            }
            connectionStateWakeup.signal()
        }

        override fun onMessage(buffer: DataChannel.Buffer) {
            receiveFrame(buffer)
        }

        override fun onBufferedAmountChange(previousAmount: Long) {
            // The Java WebRTC artifact in use reports buffered-amount changes
            // but does not expose a configurable low-water threshold. The
            // sender polls only while the channel is above its high-water mark.
        }
    }

    private fun recordInboundFrame() {
        lastInboundFrameNanos.set(nanoClock())
        inboundFrames.incrementAndGet()
    }

    internal fun attachDataChannelForTest(channel: DataChannel): DataChannel.Observer {
        dataChannel = channel
        isOpen = true
        closeNotified = false
        channel.registerObserver(dataChannelObserver)
        return dataChannelObserver
    }

    internal fun attachPeerConnectionForTest(connection: PeerConnection) {
        peerConnection = connection
    }

    private fun receiveFrame(buffer: DataChannel.Buffer) {
        val data = buffer.data
        if (data !is java.nio.ByteBuffer) return
        val bytes = ByteArray(data.remaining())
        data.get(bytes)
        recordInboundFrame()
        runCatching { Log.i(TAG, "datachannel_response_frame bytes=${bytes.size}") }
        if (debuggable) runCatching { Log.d(TAG, "projects_carrier_frame channel=$debugCarrierId bytes=${bytes.size}") }
        dispatchResponse(String(bytes, Charsets.UTF_8), alreadyRecorded = true)
    }

    private fun startBulkChannel() {
        synchronized(pendingRegistrationLock) {
            if (closeNotified || bulkChannel != null || dataChannel?.state() != DataChannel.State.OPEN) return
            val connection = peerConnection ?: return
            val channel = connection.createDataChannel("ragent-http-bulk", DataChannel.Init().apply { ordered = true }) ?: return
            bulkChannel = channel
            channel.registerObserver(object : DataChannel.Observer {
                override fun onStateChange() {
                    if (channel.state() == DataChannel.State.OPEN) traceConnect("bulk_open")
                    if (channel.state() == DataChannel.State.CLOSED || channel.state() == DataChannel.State.CLOSING) {
                        traceConnect("bulk_closed")
                        failBulkRequests(channel)
                    }
                }
                override fun onMessage(buffer: DataChannel.Buffer) = receiveFrame(buffer)
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
            })
            scope.launch {
                delay(BULK_OPEN_TIMEOUT_MS)
                if (bulkChannel === channel && channel.state() != DataChannel.State.OPEN) {
                    runCatching { channel.close() }
                    failBulkRequests(channel)
                }
            }
        }
    }

    private fun requestBulkChannel() {
        if (!bulkChannelSupported || closeNotified || bulkChannel != null) return
        if (!bulkRetryGate.tryAcquire(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()))) return
        scope.launch { runCatching { startBulkChannel() } }
    }

    private fun failBulkRequests(channel: DataChannel) {
        val abandoned = synchronized(pendingRegistrationLock) {
            if (bulkChannel !== channel) return
            bulkChannel = null
            bulkPending.toList().mapNotNull { id ->
                bulkPending.remove(id)
                pending.remove(id)?.also { responseStreams.discard(id) }
            }
        }
        abandoned.forEach { it.onError(BulkChannelClosedException()) }
    }

    private fun startBgChannel() {
        synchronized(pendingRegistrationLock) {
            if (closeNotified || bgChannel != null || dataChannel?.state() != DataChannel.State.OPEN) return
            val connection = peerConnection ?: return
            val channel = connection.createDataChannel("ragent-http-bg", DataChannel.Init().apply { ordered = true }) ?: return
            bgChannel = channel
            channel.registerObserver(object : DataChannel.Observer {
                override fun onStateChange() {
                    if (channel.state() == DataChannel.State.OPEN) traceConnect("bg_open")
                    if (channel.state() == DataChannel.State.CLOSED || channel.state() == DataChannel.State.CLOSING) {
                        traceConnect("bg_closed")
                        failBgRequests(channel)
                    }
                }
                override fun onMessage(buffer: DataChannel.Buffer) = receiveFrame(buffer)
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
            })
            scope.launch {
                delay(BULK_OPEN_TIMEOUT_MS)
                if (bgChannel === channel && channel.state() != DataChannel.State.OPEN) {
                    runCatching { channel.close() }
                    failBgRequests(channel)
                }
            }
        }
    }

    private fun requestBgChannel() {
        if (!bgChannelSupported || closeNotified || bgChannel != null) return
        if (!bgRetryGate.tryAcquire(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(nanoClock()))) return
        scope.launch { runCatching { startBgChannel() } }
    }

    private fun failBgRequests(channel: DataChannel) {
        val abandoned = synchronized(pendingRegistrationLock) {
            if (bgChannel !== channel) return
            bgChannel = null
            bgPending.toList().mapNotNull { id ->
                bgPending.remove(id)
                pending.remove(id)?.also { responseStreams.discard(id) }
            }
        }
        abandoned.forEach { it.onError(BgChannelClosedException()) }
    }

    // ── Signalling callback ───────────────────────────────────────────

    private val signalingCallback = object : P2PSignalingClient.SignalingCallback {
        override fun onCarrierHandoffRequested(timeoutMs: Long, handoffId: String) {
            if (isOpen && !closeNotified) carrierHandoffListener?.invoke(timeoutMs, handoffId)
        }
        override fun onAnswer(sdp: String) {
            traceConnect("answer_received")
            Log.i(TAG, "signaling_answer_received sdpBytes=" + sdp.length)
            if (remoteDescriptionSet || remoteDescriptionSetting) return
            val connection = peerConnection
                ?: run {
                    failConnection("Received answer without a PeerConnection")
                    return
                }
            remoteDescriptionSetting = true
            connection.setRemoteDescription(
                object : SdpObserver {
                    override fun onSetSuccess() {
                        remoteDescriptionSetting = false
                        synchronized(remoteCandidateLock) {
                            remoteDescriptionSet = true
                        }
                        Log.i(TAG, "remote_sdp_set_success")
                        traceConnect("remote_description_set")
                        drainRemoteCandidates()
                    }
                    override fun onSetFailure(reason: String?) {
                        remoteDescriptionSetting = false
                        failConnection("setRemoteDescription failed: $reason")
                    }
                    override fun onCreateSuccess(sdp: SessionDescription?) {}
                    override fun onCreateFailure(reason: String?) {}
                },
                SessionDescription(SessionDescription.Type.ANSWER, sdp),
            )
        }

        override fun onIceCandidate(
            candidate: String,
            sdpMid: String?,
            sdpMLineIndex: Int,
        ) {
            val ice = IceCandidate(sdpMid, sdpMLineIndex, candidate)
            val addImmediately = synchronized(remoteCandidateLock) {
                if (remoteDescriptionSet) true else {
                    pendingRemoteCandidates.add(ice)
                    false
                }
            }
            if (addImmediately) addRemoteCandidate(ice)
        }

        override fun onError(error: String) {
            Log.e(TAG, "signaling_error=$error channel=$debugCarrierId")
            if (!isOpen) failConnection(error)
        }
    }

    // ── connect() ─────────────────────────────────────────────────────

    override fun setUnexpectedCloseListener(listener: ((String) -> Unit)?) {
        unexpectedCloseListener = listener
    }

    override fun setCarrierSuspectListener(listener: (() -> Unit)?) {
        carrierSuspectListener = listener
    }

    override fun setCarrierHandoffListener(listener: ((Long, String) -> Unit)?) {
        carrierHandoffListener = listener
    }

    override fun configureHandoffOffer(handoffId: String): Boolean {
        if (!handoffId.matches(Regex("[a-f0-9]{32}")) || isOpen || closeNotified) return false
        handoffOfferId = handoffId
        return true
    }

    override fun suspendSignalingForHandoff(): Boolean {
        if (!isOpen || closeNotified) return false
        val current = signaling ?: return false
        current.close()
        return isOpen && !closeNotified
    }

    override suspend fun resumeSignalingAfterHandoff(): Boolean {
        if (!isOpen || closeNotified) return false
        val current = signaling ?: return false
        return try {
            current.connect()
            if (!isOpen || closeNotified) { current.close(); false } else true
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) { false }
    }

    override suspend fun connect(): Result<Unit> {
        return try {
            traceConnect("start")
            closeNotified = false
            inboundFrames.set(0L)
            lastInboundFrameNanos.set(0L)
            pendingPongs.clear()
            bulkChannelSupported = false
            bgChannelSupported = false
            supportsPushInvalidations = false
            bulkPending.clear()
            bgPending.clear()
            serverReadyFeatures = null
            synchronized(localCandidateLock) {
                offerSignalSent = false
                pendingLocalCandidates.clear()
            }
            connectFailure = null
            synchronized(remoteCandidateLock) {
                pendingRemoteCandidates.clear()
                remoteDescriptionSet = false
            }
            remoteDescriptionSetting = false

            // 1. Reuse the process-lifetime PeerConnectionFactory (see the
            //    companion note; never initialize or dispose per session).
            factory = obtainSharedFactory(appContext)

            // 2. Create PeerConnection (before signalling to avoid missing
            //    early ICE candidates generated during offer creation).
            val iceServers = candidate.iceServers.map { server ->
                PeerConnection.IceServer.builder(server.url).apply {
                    server.username?.let(::setUsername)
                    server.password?.let(::setPassword)
                }.createIceServer()
            }
            val config = PeerConnection.RTCConfiguration(iceServers)
            if (candidate.turnOnly) {
                config.iceTransportsType = PeerConnection.IceTransportsType.RELAY
            }
            peerConnection = factory!!.createPeerConnection(config, peerObserver)
                ?: throw IllegalStateException("createPeerConnection returned null")

            // 3. Create DataChannel BEFORE creating the offer (offer-side rule).
            val init = DataChannel.Init()
            init.ordered = true
            dataChannel = peerConnection!!.createDataChannel("ragent-http", init)
            dataChannel!!.registerObserver(dataChannelObserver)

            // 4. Open signalling while preparing the local offer. Local ICE
            // candidates stay queued until the joined socket sends the offer.
            signaling = P2PSignalingClient(
                signalingBaseUrl = candidate.signalingUrl,
                roomId = candidate.roomId,
                secret = candidate.secret,
                callback = signalingCallback,
                scope = scope,
            )
            val sdp = prepareOfferAndSignaling(
                openSignaling = { signaling!!.connect() },
                createOffer = { createOfferSuspend() },
            )
            traceConnect("signaling_and_offer_ready")

            // 5. Send the offer only after the signaling room is joined.
            synchronized(localCandidateLock) {
                if (!signaling!!.sendSignal(P2PProtocol.offerPayloadJson(sdp, handoffOfferId))) {
                    throw IllegalStateException("Unable to send WebRTC offer after signaling join")
                }
                offerSignalSent = true
                while (true) {
                    val candidate = pendingLocalCandidates.poll() ?: break
                    if (!signaling!!.sendSignal(candidate)) {
                        throw IllegalStateException("Unable to send local ICE candidate after WebRTC offer")
                    }
                }
            }
            traceConnect("offer_sent")

            // 6. Wait for the DataChannel to reach OPEN.
            waitForDataChannelOpen()
            traceConnect("ready")

            val established = synchronized(pendingRegistrationLock) {
                if (closeNotified || connectFailure != null || dataChannel?.state() != DataChannel.State.OPEN) false
                else { isOpen = true; true }
            }
            check(established) { "WebRTC connection closed during setup" }
            Result.success(Unit)
        } catch (e: CancellationException) {
            close()
            throw e
        } catch (e: Exception) {
            close()
            Result.failure(e)
        }
    }

    // ── request() & liveness ──────────────────────────────────────────

    override suspend fun probeLiveness(timeoutMs: Long): Boolean {
        if (timeoutMs <= 0L || closeNotified || !isOpen) return false
        val primary = dataChannel ?: return false
        if (primary.state() != DataChannel.State.OPEN) return false
        val startNanos = nanoClock()
        val features = serverReadyFeatures ?: withTimeoutOrNull(minOf(timeoutMs / 4L, 100L).coerceAtLeast(1L)) {
            serverReady.await()
        }.orEmpty()
        val elapsedMs = ((nanoClock() - startNanos).coerceAtLeast(0L)) / 1_000_000L
        val remainingMs = (timeoutMs - elapsedMs).coerceAtLeast(0L)
        if (remainingMs <= 0L || closeNotified || !isOpen || primary.state() != DataChannel.State.OPEN) return false

        if ("dc_keepalive_v1" in features) {
            val pingId = "ping_${java.util.UUID.randomUUID()}"
            val pongDeferred = CompletableDeferred<Boolean>()
            val registered = synchronized(pendingRegistrationLock) {
                if (closeNotified || !isOpen || primary.state() != DataChannel.State.OPEN) false
                else {
                    pendingPongs[pingId] = pongDeferred
                    true
                }
            }
            if (!registered) return false
            val frame = json.encodeToString(P2PKeepalivePingFrame.serializer(), P2PKeepalivePingFrame(id = pingId))
                .toByteArray(Charsets.UTF_8)
            return try {
                withTimeoutOrNull(remainingMs) {
                    sendDataChannelFrame(primary, frame, lane = PrimarySendLane.HIGH, maxSendDeadlineMs = remainingMs)
                    pongDeferred.await()
                } ?: false
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            } finally {
                pendingPongs.remove(pingId, pongDeferred)
            }
        }

        val response = try {
            withTimeoutOrNull(remainingMs) {
                request(
                    P2PHttpRequest(
                        id = java.util.UUID.randomUUID().toString(),
                        method = "GET",
                        path = "/api/auth/me",
                    ),
                ).getOrNull()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
        return response != null && response.error == null && response.status > 0
    }

    override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> =
        request(request, timeoutMs = requestTimeoutMs)

    override suspend fun request(request: P2PHttpRequest, timeoutMs: Long?): Result<P2PHttpResponse> =
        requestWithSecondaryFallback(request) { attemptRequest, allowSecondary ->
            requestOnChannel(attemptRequest, allowSecondary, timeoutMs ?: requestTimeoutMs)
        }

    private suspend fun requestOnChannel(
        request: P2PHttpRequest,
        allowSecondary: Boolean,
        requestedTimeoutMs: Long = requestTimeoutMs,
    ): Result<P2PHttpResponse> {
        val primary = dataChannel
            ?: return Result.failure(IllegalStateException("DataChannel is null"))
        if (primary.state() != DataChannel.State.OPEN) {
            return Result.failure(IllegalStateException("DataChannel is not open"))
        }
        val bgRequest = allowSecondary && isBackgroundReadRequest(request)
        val bulkRequest = allowSecondary && !bgRequest && isBulkReadRequest(request)
        if (bgRequest && bgChannel == null) requestBgChannel()
        if (bulkRequest && bulkChannel == null) requestBulkChannel()
        val channel = when {
            bgRequest -> bgChannel?.takeIf { it.state() == DataChannel.State.OPEN }
                ?: bulkChannel?.takeIf { it.state() == DataChannel.State.OPEN }
                ?: primary
            bulkRequest -> bulkChannel?.takeIf { it.state() == DataChannel.State.OPEN } ?: primary
            else -> primary
        }
        if (channel === bgChannel) traceConnect("bg_read_routed")
        else if (channel === bulkChannel) traceConnect("bulk_read_routed")
        val lane = if (channel === primary) primaryLaneForRequest(request) else PrimarySendLane.NORMAL

        val id = request.id
        val trace = debuggable && request.method == "GET" && request.path == "/api/projects"
        val debugCategory = if (debuggable) when {
            request.path.startsWith("/api/runtime/summary/events") -> "summary_events"
            request.path == "/api/runtime/summary" -> "summary"
            request.path == "/api/projects" -> "projects"
            request.path.startsWith("/api/sessions/") && request.path.contains("/events") -> "session_events"
            request.path.substringBefore('?') == "/api/sessions" -> "sessions_list"
            request.path.startsWith("/api/sessions/") -> "session_item"
            request.path.substringBefore('?') == "/api/tools" -> "tools"
            request.path.startsWith("/api/models") -> "models"
            request.path.startsWith("/api/native-providers") -> "providers"
            request.path.startsWith("/api/auth/") -> "auth"
            else -> "other"
        } else null
        if (debugCategory != null) debugRequestCategories.putIfAbsent(id, debugCategory)
        if (trace) {
            debugTrackedRequests.add(id)
            Log.w(TAG, "projects_trace id=$id stage=start channel=$debugCarrierId")
        }
        return try {
            val payload = json.encodeToString(P2PHttpRequest.serializer(), request.copy(acceptResponseStream = true))
                .toByteArray(Charsets.UTF_8)
            val baseTimeoutMs = requestedTimeoutMs.coerceAtLeast(1L)
            val effectiveTimeoutMs = if (requestedTimeoutMs == requestTimeoutMs && payload.size > P2PHttpRequestStream.MAX_SINGLE_FRAME_BYTES) {
                maxOf(baseTimeoutMs, LARGE_REQUEST_TIMEOUT_MS)
            } else baseTimeoutMs
            if (payload.size > P2PHttpRequestStream.MAX_SINGLE_FRAME_BYTES) {
                val features = withTimeoutOrNull(5_000L) { serverReady.await() }.orEmpty()
                if ("http_request_stream_v1" !in features) {
                    return Result.failure(IllegalStateException(
                        "Remote P2P host does not support chunked request framing",
                    ))
                }
            }
            withTimeoutOrNull(effectiveTimeoutMs) {
                suspendCancellableCoroutine<Result<P2PHttpResponse>> { cont ->
                    val pendingRequest = PendingRequest(
                        onResponse = { response ->
                            bulkPending.remove(id)
                            bgPending.remove(id)
                            if (trace) Log.w(TAG, "projects_trace id=$id stage=response")
                            cont.resume(Result.success(response))
                        },
                        onError = { error ->
                            bulkPending.remove(id)
                            bgPending.remove(id)
                            if (trace) Log.w(TAG, "projects_trace id=$id stage=error")
                            cont.resume(Result.failure(error))
                        },
                    )

                    val registrationError = registerPending(id, pendingRequest, channel)
                    if (registrationError != null) {
                        pendingRequest.onError(registrationError)
                        return@suspendCancellableCoroutine
                    }

                    val sendJob = scope.launch {
                        try {
                            for (frame in P2PHttpRequestStream.frames(id, payload)) {
                                sendDataChannelFrame(channel, frame, lane = lane, maxSendDeadlineMs = effectiveTimeoutMs)
                            }
                            if (trace) runCatching { Log.w(TAG, "projects_trace id=$id stage=sent") }
                            runCatching { Log.i(TAG, "datachannel_request_sent id=$id wireBytes=${payload.size} channel=$debugCarrierId") }
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            if (channel !== primary && error is P2PSendTimeoutException) {
                                runCatching { channel.close() }
                                if (channel === bgChannel) failBgRequests(channel) else failBulkRequests(channel)
                            }
                            if (pending.remove(id, pendingRequest)) {
                                pendingRequest.onError(
                                    if (channel !== primary && (error is P2PSendTimeoutException || channel.state() != DataChannel.State.OPEN)) {
                                        if (channel === bgChannel) BgChannelClosedException() else BulkChannelClosedException()
                                    } else error,
                                )
                            }
                        }
                    }
                    cont.invokeOnCancellation {
                        if (trace) Log.w(TAG, "projects_trace id=$id stage=cancelled")
                        pending.remove(id, pendingRequest)
                        bulkPending.remove(id)
                        bgPending.remove(id)
                        pendingRequest.cancel()
                        responseStreams.discard(id)
                        sendJob.cancel()
                    }
                }
            } ?: Result.failure(P2PRequestTimeoutException())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            if (trace) debugTrackedRequests.remove(id)
        }
    }

    override suspend fun requestStream(request: P2PHttpRequest, totalBytes: Long, sha256: String,
        openBody: () -> java.io.InputStream, onProgress: (sentBytes: Long, totalBytes: Long) -> Unit): Result<P2PHttpResponse> {
        val primary = dataChannel
            ?: return Result.failure(IllegalStateException("DataChannel is null"))
        if (primary.state() != DataChannel.State.OPEN) {
            return Result.failure(IllegalStateException("DataChannel is not open"))
        }
        if (request.bodyBase64.isNotEmpty() || totalBytes !in 1..P2PHttpBodyStream.MAX_BODY_BYTES ||
            !sha256.matches(Regex("^[a-f0-9]{64}$"))) {
            return Result.failure(IllegalArgumentException("Invalid streamed P2P request body"))
        }
        val features = withTimeoutOrNull(5_000L) { serverReady.await() }.orEmpty()
        if ("http_request_stream_v2" !in features) {
            return try {
                val bytes = withContext(Dispatchers.IO) {
                    openBody().use { input -> P2PHttpBodyStream.readVerifiedBody(input, totalBytes, sha256) }
                }
                Log.w(TAG, "datachannel_stream_fallback id=${request.id} reason=peer_without_v2 bodyBytes=${bytes.size}")
                request(request.copy(bodyBase64 = P2PProtocol.encodeBody(bytes))).also { result ->
                    if (result.isSuccess) runCatching { onProgress(totalBytes, totalBytes) }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                Result.failure(error)
            }
        }
        // Upload traffic is isolated from interactive requests when the peer
        // offers the optional bulk channel. If it is unavailable, use primary.
        val isAssetChunk = request.method == "PATCH" &&
            request.path.substringBefore('?').matches(Regex("^/api/assets/fasset_[a-f0-9]{24}/upload$"))
        if (isAssetChunk && bulkChannel == null) requestBulkChannel()
        val channel = bulkChannel?.takeIf { isAssetChunk && it.state() == DataChannel.State.OPEN } ?: primary
        val binaryChunks = "http_request_binary_chunks_v3" in features
        val id = request.id
        return try {
            // Larger negotiated batches may take longer on a slow relay. The
            // timeout remains bounded and ordinary requests keep their limit.
            val timeoutMs = if (isAssetChunk) maxOf(LARGE_REQUEST_TIMEOUT_MS,
                minOf(900_000L, totalBytes * 600_000L / (1024 * 1024))) else LARGE_REQUEST_TIMEOUT_MS
            withTimeoutOrNull(timeoutMs) {
                suspendCancellableCoroutine<Result<P2PHttpResponse>> { cont ->
                    val pendingRequest = PendingRequest(
                        onResponse = { response -> bulkPending.remove(id); cont.resume(Result.success(response)) },
                        onError = { error -> bulkPending.remove(id); cont.resume(Result.failure(error)) },
                    )
                    val registrationError = registerPending(id, pendingRequest, channel)
                    if (registrationError != null) {
                        pendingRequest.onError(registrationError)
                        return@suspendCancellableCoroutine
                    }
                    val sendJob = scope.launch {
                        var input: java.io.InputStream? = null
                        var sentBytes = 0L
                        var chunkCount = 0
                        val telemetry = if (isAssetChunk && debuggable && Log.isLoggable("Ragent.Upload", Log.DEBUG)) UploadSendTelemetry() else null
                        val enqueueStartedAt = System.nanoTime()
                        val digest = java.security.MessageDigest.getInstance("SHA-256")
                        try {
                            sendDataChannelFrame(channel, P2PHttpBodyStream.initFrame(request.copy(acceptResponseStream = true), totalBytes, sha256))
                            input = openBody()
                            val buffer = ByteArray(P2PHttpBodyStream.CHUNK_BYTES)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                if (count == 0) continue
                                require(sentBytes + count <= totalBytes) { "Streamed request body exceeded its declared length" }
                                digest.update(buffer, 0, count)
                                val chunk = buffer.copyOf(count)
                                val frame = if (binaryChunks) P2PHttpBodyStream.binaryChunkFrame(id, chunkCount, chunk)
                                    else P2PHttpBodyStream.chunkFrame(id, chunkCount, chunk)
                                sendDataChannelFrame(channel, frame, binary = binaryChunks, telemetry = telemetry)
                                sentBytes += count
                                chunkCount++
                                runCatching { onProgress(sentBytes, totalBytes) }
                            }
                            require(sentBytes == totalBytes && digest.digest().joinToString("") { "%02x".format(it) } == sha256) {
                                "Streamed request body does not match its declared digest"
                            }
                            sendDataChannelFrame(channel, P2PHttpBodyStream.endFrame(id, chunkCount, totalBytes, sha256))
                            Log.i(TAG, "datachannel_stream_request_sent id=$id bodyBytes=$sentBytes chunks=$chunkCount")
                            telemetry?.let {
                                Log.d("Ragent.Upload", "stage=enqueue bytes=$sentBytes binary=$binaryChunks bulk=${channel !== primary}" +
                                    " elapsedMs=${(System.nanoTime() - enqueueStartedAt) / 1_000_000}" +
                                    " blockedMs=${it.blockedNanos / 1_000_000} blockedPolls=${it.blockedPolls} peakBufferedBytes=${it.peakBufferedBytes}")
                                traceUploadRtcStats()
                            }
                        } catch (cancelled: CancellationException) {
                            withContext(NonCancellable) {
                                sendAbortBestEffort(channel, id)
                            }
                            throw cancelled
                        } catch (error: Exception) {
                            sendAbortBestEffort(channel, id)
                            if (channel !== primary && (error is P2PSendTimeoutException || channel.state() != DataChannel.State.OPEN)) {
                                runCatching { channel.close() }
                                failBulkRequests(channel)
                            }
                            if (pending.remove(id, pendingRequest)) pendingRequest.onError(error)
                        } finally {
                            runCatching { input?.close() }
                        }
                    }
                    cont.invokeOnCancellation {
                        pending.remove(id, pendingRequest)
                        bulkPending.remove(id)
                        pendingRequest.cancel()
                        responseStreams.discard(id)
                        sendJob.cancel()
                    }
                }
            } ?: Result.failure(P2PRequestTimeoutException())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    private suspend fun sendDataChannelFrame(
        channel: DataChannel,
        frame: ByteArray,
        binary: Boolean = false,
        telemetry: UploadSendTelemetry? = null,
        lane: PrimarySendLane = PrimarySendLane.NORMAL,
        maxSendDeadlineMs: Long = Long.MAX_VALUE,
    ) {
        val isPrimary = channel === dataChannel
        val isBg = channel === bgChannel
        val isBulk = !isPrimary && !isBg
        // Keep the bulk channel's queued data small enough for interactive
        // traffic to share the underlying SCTP association. Slow relays need
        // longer to drain that bounded buffer than the interactive channel.
        // Diagnostic-only A/B switch. Release builds and ordinary debug runs
        // retain the conservative default until real relay evidence is gathered.
        val highWaterBytes = when {
            isBulk && debuggable && Log.isLoggable("Ragent.FastBulk", Log.DEBUG) -> 2L * 1024 * 1024
            isBulk -> 64L * 1024
            isBg -> 64L * 1024
            else -> 512L * 1024
        }
        val baseDeadlineMs = if (isBulk) 60_000L else 15_000L
        val sendDeadlineMs = minOf(baseDeadlineMs, maxSendDeadlineMs).coerceAtLeast(1L)
        withP2PSendDeadline(sendDeadlineMs) {
            val sendBlock: suspend () -> Unit = {
                while (true) {
                    if (channel.state() != DataChannel.State.OPEN) {
                        throw IllegalStateException("DataChannel closed while sending request")
                    }
                    val buffered = channel.bufferedAmount()
                    telemetry?.let { it.peakBufferedBytes = maxOf(it.peakBufferedBytes, buffered) }
                    if (buffered > highWaterBytes) {
                        val blockedAt = if (telemetry != null) System.nanoTime() else 0L
                        delay(10)
                        telemetry?.let { it.blockedNanos += System.nanoTime() - blockedAt; it.blockedPolls++ }
                        continue
                    }
                    val sent = channel.send(DataChannel.Buffer(
                        java.nio.ByteBuffer.wrap(frame),
                        binary,
                    ))
                    if (sent) break
                    delay(10)
                }
            }
            when {
                isPrimary -> primaryLaneGate.withLane(lane, sendBlock)
                isBg -> bgOutboundFrameMutex.withLock { sendBlock() }
                else -> bulkOutboundFrameMutex.withLock { sendBlock() }
            }
        }
    }

    private suspend fun sendAbortBestEffort(channel: DataChannel, id: String) {
        try {
            withTimeoutOrNull(500L) {
                sendDataChannelFrame(channel, P2PHttpBodyStream.abortFrame(id), lane = PrimarySendLane.HIGH)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The peer can also clean up incomplete streams after their expiry.
        }
    }

    // ── close() ───────────────────────────────────────────────────────

    private fun registerPending(id: String, request: PendingRequest, channel: DataChannel? = null): Exception? = synchronized(pendingRegistrationLock) {
        when {
            closeNotified -> Exception("P2P transport closed")
            channel != null && channel !== dataChannel &&
                !((channel === bulkChannel || channel === bgChannel) && channel.state() == DataChannel.State.OPEN) ->
                if (channel === bgChannel) BgChannelClosedException() else BulkChannelClosedException()
            pending.putIfAbsent(id, request) != null -> IllegalStateException("Duplicate P2P request id")
            else -> {
                if (channel === bulkChannel) bulkPending.add(id)
                else if (channel === bgChannel) bgPending.add(id)
                null
            }
        }
    }

    override fun close() {
        carrierSuspectListener = null
        val (abandonedPongs, abandoned) = synchronized(pendingRegistrationLock) {
            closeNotified = true
            isOpen = false
            bulkPending.clear()
            bgPending.clear()
            val pongs = pendingPongs.entries.mapNotNull { (id, deferred) ->
                if (pendingPongs.remove(id, deferred)) deferred else null
            }
            val requests = pending.entries.mapNotNull { (id, request) ->
                if (pending.remove(id, request)) request else null
            }
            pongs to requests
        }
        for (pong in abandonedPongs) pong.complete(false)
        connectionStateWakeup.signal()
        iceDisconnected = false
        iceDisconnectWatchdog.recovered()
        supportsPushInvalidations = false
        if (serverReady.complete(emptySet())) serverReadyFeatures = emptySet()

        // Fail all pending requests.
        for (req in abandoned) req.onError(Exception("P2P transport closed"))
        responseStreams.clear()
        synchronized(localCandidateLock) {
            pendingLocalCandidates.clear()
            offerSignalSent = false
        }
        synchronized(remoteCandidateLock) {
            pendingRemoteCandidates.clear()
            remoteDescriptionSet = false
        }
        remoteDescriptionSetting = false

        bgChannel?.close()
        bgChannel = null
        bulkChannel?.close()
        bulkChannel = null
        dataChannel?.close()
        dataChannel = null

        peerConnection?.close()
        peerConnection = null

        // Never dispose the shared factory here: its signaling thread is
        // still draining the PeerConnection.close() above (see the
        // companion note).

        signaling?.close()
        signaling = null

        scope.cancel()
    }

    private fun failConnection(reason: String) {
        if (connectFailure == null) connectFailure = reason
        connectionStateWakeup.signal()
        notifyUnexpectedClose(reason)
    }

    private fun notifyUnexpectedClose(reason: String) {
        val notify = synchronized(pendingRegistrationLock) {
            if (closeNotified) false else {
                closeNotified = true
                isOpen = false
                true
            }
        }
        if (!notify) return
        unexpectedCloseListener?.invoke(reason)
        close()
    }

    private fun drainRemoteCandidates() {
        while (!closeNotified) {
            val candidate = synchronized(remoteCandidateLock) {
                if (!remoteDescriptionSet || closeNotified) return
                pendingRemoteCandidates.poll()
            } ?: return
            addRemoteCandidate(candidate)
        }
    }

    private fun addRemoteCandidate(candidate: IceCandidate) {
        val connection = peerConnection
            ?: run {
                failConnection("Received ICE candidate without a PeerConnection")
                return
            }
        try {
            Log.i(TAG, "remote_candidate_add type=" + candidate.sdp.substringAfter(" typ ", "unknown").substringBefore(' '))
            if (!connection.addIceCandidate(candidate)) {
                failConnection("addIceCandidate was rejected")
            }
        } catch (error: Exception) {
            failConnection("addIceCandidate failed: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────

    private suspend fun createOfferSuspend(): String = withContext(Dispatchers.IO) {
        val connection = peerConnection ?: throw IllegalStateException("WebRTC connection was closed")
        createWebRtcOffer(connection) { !closeNotified && peerConnection === connection }
    }

    private suspend fun waitForDataChannelOpen() {
        connectionStateWakeup.await(connectTimeoutMs) {
            if (connectionChannelReady(connectFailure, closeNotified, dataChannel?.state() == DataChannel.State.OPEN)) true else {
                // Check for close — if the connection died, fail.
                val pcState = peerConnection?.connectionState()
                if (pcState == PeerConnection.PeerConnectionState.FAILED ||
                    pcState == PeerConnection.PeerConnectionState.CLOSED
                ) {
                    throw Exception("PeerConnection entered $pcState")
                }
                false
            }
        }
    }

    private fun sendClientReady(features: List<String>) {
        val primary = dataChannel ?: return
        if (closeNotified || primary.state() != DataChannel.State.OPEN) return
        val frame = json.encodeToString(
            P2PClientReadyFrame.serializer(),
            P2PClientReadyFrame(version = 1, features = features),
        ).toByteArray(Charsets.UTF_8)
        scope.launch {
            try {
                withTimeoutOrNull(5_000L) {
                    sendDataChannelFrame(primary, frame, lane = PrimarySendLane.HIGH, maxSendDeadlineMs = 5_000L)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best-effort capability handshake; carrier close handles failure.
            }
        }
    }

    /** Dispatch a JSON message received on the DataChannel. */
    internal fun dispatchResponse(raw: String, alreadyRecorded: Boolean = false) {
        if (!alreadyRecorded) recordInboundFrame()
        if (raw.contains("\"dc_pong\"")) {
            val pong = try { json.decodeFromString(P2PKeepalivePongFrame.serializer(), raw) } catch (_: Exception) { null }
            if (pong != null && pong.type == "dc_pong" && pong.id.isNotEmpty()) {
                pendingPongs.remove(pong.id)?.complete(true)
                return
            }
        }
        if (raw.contains("\"dc_push_v1\"")) {
            val push = try { json.decodeFromString(P2PPushInvalidationFrame.serializer(), raw) } catch (_: Exception) { null }
            if (push != null && push.type == "dc_push_v1") {
                val payload = push.payload
                if (payload != null && payload !is JsonNull) {
                    val serialized = if (payload is JsonPrimitive && payload.isString) {
                        payload.content
                    } else {
                        json.encodeToString(JsonElement.serializer(), payload)
                    }
                    invalidationEvents.tryEmit(serialized)
                }
                return
            }
        }
        // Go's response frame puts type first. Avoid parsing every large legacy
        // response twice, while keeping chunk assembly scoped to pending calls.
        if (raw.startsWith("{\"type\":\"http_response_stream_v1\",")) {
            val frame = try { json.decodeFromString(P2PHttpResponseStreamFrame.serializer(), raw) } catch (_: Exception) { return }
            if (debuggable) Log.d(TAG, "projects_carrier_chunk channel=$debugCarrierId tracked=${frame.id in debugTrackedRequests} category=${debugRequestCategories[frame.id] ?: "untracked"}")
            if (!pending.containsKey(frame.id)) return
            if (frame.id in debugTrackedRequests && (frame.index == 0 || frame.index % 8 == 0)) {
                Log.w(TAG, "projects_trace id=${frame.id} stage=chunk index=${frame.index}")
            }
            try {
                val payload = responseStreams.add(frame)
                // Cancellation can remove the request and discard its partial
                // transfer after the first pending check but before add().
                // Do not leave a newly created transfer reserved in that race.
                if (!pending.containsKey(frame.id)) {
                    responseStreams.discard(frame.id)
                    return
                }
                if (payload == null) return
                val response = json.decodeFromString(P2PHttpResponse.serializer(), String(payload, Charsets.UTF_8))
                require(response.id == frame.id && response.type == "http_response") { "Response stream identity mismatch" }
                val request = pending.remove(frame.id) ?: return
                if (response.error == null && response.status in 200..299) successfulResponses.incrementAndGet()
                request.onResponse(response)
            } catch (_: Exception) {
                responseStreams.discard(frame.id)
                pending.remove(frame.id)?.onError(Exception("Invalid P2P response stream"))
            }
            return
        }
        try {
            val ready = json.decodeFromString(P2PServerReadyFrame.serializer(), raw)
            if (ready.type == "server_ready") {
                val features = if (ready.version == 1) ready.features.toSet() else emptySet()
                if (serverReady.complete(features)) {
                    serverReadyFeatures = features
                    if ("http_bulk_channel_v1" in features) {
                        bulkChannelSupported = true
                        requestBulkChannel()
                    }
                    if ("http_bg_channel_v1" in features) {
                        bgChannelSupported = true
                    }
                    if ("dc_push_invalidation_v1" in features) {
                        supportsPushInvalidations = true
                        sendClientReady(listOf("dc_push_invalidation_v1"))
                    }
                }
                return
            }
        } catch (_: Exception) {
            // A regular HTTP response has required fields not present in server_ready.
        }
        try {
            val response = json.decodeFromString(P2PHttpResponse.serializer(), raw)
            val pendingRequest = pending.remove(response.id) ?: return
            responseStreams.discard(response.id)
            runCatching { Log.i(TAG, "datachannel_response id=${response.id} status=${response.status} error=${response.error != null} channel=$debugCarrierId") }
            if (response.error == null && response.status in 200..299) successfulResponses.incrementAndGet()
            pendingRequest.onResponse(response)
        } catch (_: Exception) {
            // Drop malformed messages silently (protocol-level resilience).
        }
    }
}

// ── Internal types ────────────────────────────────────────────────────

/** Tracks a pending HTTP request on the DataChannel. */
internal class PendingRequest(
    onResponse: (P2PHttpResponse) -> Unit,
    onError: (Exception) -> Unit,
) {
    private val response = onResponse
    private val error = onError
    private val completed = java.util.concurrent.atomic.AtomicBoolean(false)
    fun onResponse(value: P2PHttpResponse) { if (completed.compareAndSet(false, true)) response(value) }
    fun onError(value: Exception) { if (completed.compareAndSet(false, true)) error(value) }
    fun cancel() { completed.compareAndSet(false, true) }
}
