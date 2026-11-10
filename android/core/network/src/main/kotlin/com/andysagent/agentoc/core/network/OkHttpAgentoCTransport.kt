package com.andysagent.agentoc.core.network

import com.andysagent.agentoc.core.protocol.ErrorResponseDto
import com.andysagent.agentoc.core.protocol.ProtocolCodec
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.WebSocketPushDto
import com.andysagent.agentoc.core.p2p.P2PHttpRequest
import com.andysagent.agentoc.core.p2p.P2PProtocol
import com.andysagent.agentoc.core.p2p.P2PRequestTimeoutException
import com.andysagent.agentoc.core.p2p.P2PSession
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.BufferedSink
import okio.Buffer
import okio.ByteString
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only fixed categories reach logs; exception text may contain private data. */
internal fun carrierFailureCategory(error: Throwable): String = when (error.message) {
    "P2P transport closed" -> "transport_closed"
    "DataChannel is null", "DataChannel is not open", "DataChannel closed while sending request" -> "channel_unavailable"
    "P2P request timed out", "P2P stream request timed out" -> "request_timeout"
    "Invalid P2P response stream" -> "invalid_response_stream"
    else -> "other"
}

internal fun networkFailureCategory(error: Throwable): String {
    val causes = generateSequence<Throwable>(error) { it.cause }.take(8).toList()
    return when {
        causes.any { it is java.net.UnknownHostException } -> "UnknownHostException"
        causes.any { it is java.net.SocketTimeoutException } -> "SocketTimeoutException"
        causes.any { it is java.net.ConnectException } -> "ConnectException"
        causes.any { it is javax.net.ssl.SSLException } -> "SSLException"
        causes.any { it is java.net.SocketException } -> "SocketException"
        else -> "IOException"
    }
}

private fun carrierHeaders(request: ApiRequest): MutableMap<String, String> = request.headers.toMutableMap().apply {
    if (keys.none { it.equals("Content-Type", ignoreCase = true) }) {
        val type = request.contentType ?: when {
            request.bodyBytes != null -> "application/octet-stream"
            request.bodySource != null -> "application/octet-stream"
            request.body != null -> "application/json"
            else -> null
        }
        if (type != null) put("Content-Type", type)
    }
}

private fun recordCarrierFailure(kind: String, failure: Throwable, isOpen: Boolean) {
    // Android's mockable JVM jar can reject Log calls; diagnostics must never
    // change request handling on either runtime.
    runCatching { android.util.Log.w("AgentoC.Carrier", "$kind failure=${carrierFailureCategory(failure)} open=$isOpen") }
}

class OkHttpAgentoCTransport(
    private val endpointProvider: () -> String,
    private val credentialProvider: () -> String?,
    private val client: OkHttpClient = defaultClient(),
    private val codec: ProtocolCodec = ProtocolCodec(),
    private val onAuthenticationRequired: (() -> Unit)? = null,
    /** Bound computer traffic cannot fall back to direct HTTP after carrier loss. */
    private val requireVerifiedCarrier: Boolean = false,
    private val credentialRejectionHandler: CredentialRejectionHandler? = null,
    private val onCarrierUnavailable: ((P2PSession?) -> Unit)? = null,
) : AgentoCTransport {
    private val invalidationEvents = MutableSharedFlow<InvalidationHint>(extraBufferCapacity = 64)
    private val socketScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutableConnectionState = MutableStateFlow(RuntimeConnectionState.Disconnected)
    private var reconnectJob: Job? = null
    private var reconnectAttempt = 0
    @Volatile private var closeRequested = true
    private var webSocket: WebSocket? = null
    private val p2pSession = AtomicReference<P2PSession?>(null)
    private val turnSession = TurnSessionSlot()
    private val recoveryRequested = java.util.concurrent.atomic.AtomicBoolean(false)

    override val invalidations: Flow<InvalidationHint> = invalidationEvents.asSharedFlow()
    override val connectionState: StateFlow<RuntimeConnectionState> = mutableConnectionState.asStateFlow()
    override val requiresEventPolling: Boolean
        get() = requireVerifiedCarrier || hasOpenCarrier() || endpointProvider().trimEnd('/').isBlank()

    fun updateCarrierConnectionState(state: RuntimeConnectionState) {
        if (hasOpenCarrier()) closeInvalidationSocketForCarrier()
        // A queued supervisor notification cannot revive a closed carrier.
        mutableConnectionState.value = if (requireVerifiedCarrier && state == RuntimeConnectionState.Connected && !hasOpenCarrier()) {
            RuntimeConnectionState.Connecting
        } else state
    }

    fun setP2PSession(session: P2PSession) {
        p2pSession.getAndSet(session)?.takeIf { it !== session }?.close()
        recoveryRequested.set(false)
    }

    fun clearP2PSession(session: P2PSession? = null) {
        if (session == null) p2pSession.set(null) else p2pSession.compareAndSet(session, null)
    }

    fun setTurnSession(session: P2PSession) {
        turnSession.replace(session, drain = false)
        recoveryRequested.set(false)
    }

    fun handoffTurnSession(session: P2PSession) {
        turnSession.replace(session, drain = true)
        recoveryRequested.set(false)
    }

    fun clearTurnSession(session: P2PSession? = null) {
        turnSession.clear(session)
    }

    private fun hasOpenCarrier(): Boolean = p2pSession.get()?.isOpen == true || turnSession.get()?.isOpen == true

    override fun markAuthenticationRequired() {
        mutableConnectionState.value = RuntimeConnectionState.AuthenticationRequired
    }

    override suspend fun execute(request: ApiRequest): ApiResponse = withContext(Dispatchers.IO) {
        val endpoint = endpointProvider().trimEnd('/')
        // Signed asset uploads may target storage outside the AgentoC server.
        // They must use the URL and headers returned by the upload intent;
        // stripping the host and sending them over a peer/TURN control-plane
        // session would upload to the wrong origin. Relative API paths remain
        // governed by the server bootstrap -> TURN-first -> P2P upgrade lock.
        val serverRelativeRequest = !request.path.startsWith("http://") && !request.path.startsWith("https://")
        if (request.bodySource != null && serverRelativeRequest) {
            throw ApiException(0, "STREAMING_BODY_REQUIRES_HTTP", "Streaming uploads require a direct HTTP destination", retryable = false)
        }
        if (serverRelativeRequest) {
            p2pSession.get()?.takeIf { it.isOpen }?.let { return@withContext executeViaP2P(request, it) }
            turnSession.acquire()?.let { carrier ->
                try { return@withContext executeViaTurn(request, carrier) }
                finally { turnSession.release(carrier) }
            }
            if (requireVerifiedCarrier) {
                reportUnavailableCarrier(null)
                throw ApiException(0, "CARRIER_UNAVAILABLE", "The computer is reconnecting", retryable = true)
            }
        }
        if (endpoint.isBlank() && serverRelativeRequest) {
            throw IOException("No verified TURN/P2P carrier is available")
        }
        val url = if (request.path.startsWith("http://") || request.path.startsWith("https://")) request.path else "$endpoint${request.path}"
        val builder = Request.Builder().url(url)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val attemptedCredential = if (serverRelativeRequest) credentialProvider()?.takeIf { it.isNotBlank() } else null
        if (serverRelativeRequest) {
            attemptedCredential?.let { builder.header("Authorization", "Bearer $it") }
            request.requestId?.let { builder.header("X-AgentoC-Request-Id", it) }
            request.idempotencyKey?.let { builder.header("Idempotency-Key", it) }
        }
        require(listOfNotNull(request.bodyBytes, request.body, request.bodySource).size <= 1) {
            "An API request may have only one body source"
        }
        val rawBody = request.bodySource?.let { StreamingRequestBody(it, request.contentType) }
            ?: request.bodyBytes?.toRequestBody(
                (request.contentType ?: "application/octet-stream").toMediaType(),
            ) ?: request.body?.toRequestBody(request.contentType?.toMediaType() ?: JSON_MEDIA_TYPE)
        val body = if (rawBody != null && request.onBodyBytesWritten != null)
            ProgressRequestBody(rawBody, request.onBodyBytesWritten) else rawBody
        when (request.method.uppercase()) {
            "GET" -> builder.get()
            "POST" -> builder.post(body ?: EMPTY_BODY)
            "PUT" -> builder.put(body ?: EMPTY_BODY)
            "PATCH" -> builder.patch(body ?: EMPTY_BODY)
            "DELETE" -> if (body == null) builder.delete() else builder.delete(body)
            else -> builder.method(request.method.uppercase(), body)
        }
        try {
            val apiResponse = executeHttpCancellable(builder.build())
            if (!apiResponse.isSuccessful) throw apiResponse.toApiException(codec)
            apiResponse
        } catch (error: ApiException) {
            currentCoroutineContext().ensureActive()
            throw if (serverRelativeRequest && !request.isolateCredentialFailure) handleAuthenticationFailure(error, attemptedCredential) else error
        } catch (error: IOException) {
            currentCoroutineContext().ensureActive()
            // Exception messages can contain arbitrary credentials, URLs and
            // response data. Expose only a fixed, non-user-controlled category.
            val diagnostic = networkFailureCategory(error)
            throw ApiException(0, "NETWORK_ERROR", "Network request failed ($diagnostic)", retryable = true)
        }
    }

    /** Keep cancellation attached until the whole response body has been read. */
    private suspend fun executeHttpCancellable(request: Request): ApiResponse = suspendCancellableCoroutine { continuation ->
        val isUploadChunk = request.method == "PATCH"
            && request.url.encodedPath.matches(Regex("/api/assets/[^/]+/upload"))
        val isAccountAsr = request.url.encodedPath.endsWith("/v1/owner-auth/account/asr/transcriptions")
        val requestClient = when {
            isUploadChunk -> client.newBuilder()
                .readTimeout(UPLOAD_CHUNK_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .writeTimeout(UPLOAD_CHUNK_HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
            isAccountAsr -> client.newBuilder()
                .readTimeout(ACCOUNT_ASR_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .callTimeout(ACCOUNT_ASR_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build()
            else -> client
        }
        val call = requestClient.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, error: IOException) {
                continuation.resumeWithException(error)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                try {
                    val result = response.use {
                        readBoundedHttpResponse(it.code, it.headers.toMap(), it.body)
                    }
                    continuation.resume(result)
                } catch (error: Exception) {
                    continuation.resumeWithException(error)
                }
            }
        })
    }

    private suspend fun executeViaP2P(request: ApiRequest, session: P2PSession): ApiResponse {
        val path = request.path.takeIf { it.startsWith("/") } ?: runCatching {
            val uri = java.net.URI(request.path)
            buildString {
                append(uri.rawPath?.takeIf { it.isNotBlank() } ?: "/")
                uri.rawQuery?.let { append('?').append(it) }
            }
        }.getOrNull() ?: throw ApiException(0, "P2P_REQUEST_INVALID", "P2P request path is invalid", retryable = false)
        val headers = carrierHeaders(request)
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        attemptedCredential?.let { headers["Authorization"] = "Bearer $it" }
        request.requestId?.let { headers["X-AgentoC-Request-Id"] = it }
        request.idempotencyKey?.let { headers["Idempotency-Key"] = it }
        val result = session.request(P2PHttpRequest(
            // Business IDs (for example android:UUID) stay in headers/body.
            // Each carrier attempt needs an independent, frame-safe correlation ID.
            id = java.util.UUID.randomUUID().toString(),
            method = request.method.uppercase(),
            path = path,
            headers = headers,
            bodyBase64 = request.bodyBytes?.let(P2PProtocol::encodeBody)
                ?: request.body?.let(P2PProtocol::encodeBody)
                ?: "",
        )).getOrElse { failure ->
            if (failure is kotlinx.coroutines.CancellationException) throw failure
            recordCarrierFailure("p2p", failure, session.isOpen)
            reportUnavailableCarrier(session)
            throw ApiException(0, "P2P_NETWORK_ERROR", "P2P request failed", retryable = true)
        }
        val remoteError = result.error
        if (remoteError != null) {
            throw ApiException(0, "P2P_REMOTE_ERROR", remoteError, retryable = false)
        }
        val response = decodeCarrierResponse(result.status, result.bodyBase64, result.headers)
        if (!response.isSuccessful) {
            val error = response.toApiException(codec)
            throw if (request.isolateCredentialFailure) error else handleAuthenticationFailure(error, attemptedCredential)
        }
        return response
    }

    private suspend fun executeViaTurn(request: ApiRequest, session: P2PSession): ApiResponse {
        val path = request.path.takeIf { it.startsWith("/") } ?: runCatching {
            val uri = java.net.URI(request.path)
            buildString {
                append(uri.rawPath?.takeIf { it.isNotBlank() } ?: "/")
                uri.rawQuery?.let { append('?').append(it) }
            }
        }.getOrNull() ?: throw ApiException(0, "TURN_REQUEST_INVALID", "TURN request path is invalid", retryable = false)
        val headers = carrierHeaders(request)
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        attemptedCredential?.let { headers["Authorization"] = "Bearer $it" }
        request.requestId?.let { headers["X-AgentoC-Request-Id"] = it }
        request.idempotencyKey?.let { headers["Idempotency-Key"] = it }
        val result = session.request(P2PHttpRequest(
            // Business IDs (for example android:UUID) stay in headers/body.
            // Each carrier attempt needs an independent, frame-safe correlation ID.
            id = java.util.UUID.randomUUID().toString(),
            method = request.method.uppercase(),
            path = path,
            headers = headers,
            bodyBase64 = request.bodyBytes?.let(P2PProtocol::encodeBody)
                ?: request.body?.let(P2PProtocol::encodeBody)
                ?: "",
        )).getOrElse { failure ->
            if (failure is kotlinx.coroutines.CancellationException) throw failure
            recordCarrierFailure("turn", failure, session.isOpen)
            // A slow business response does not by itself prove that the TURN
            // carrier is dead. Its independent health watchdog checks that.
            if (failure !is P2PRequestTimeoutException || !session.isOpen) reportUnavailableCarrier(session)
            throw ApiException(0, "TURN_NETWORK_ERROR", "TURN request failed", retryable = true)
        }
        val remoteError = result.error
        if (remoteError != null) {
            throw ApiException(0, "TURN_REMOTE_ERROR", remoteError, retryable = false)
        }
        val response = decodeCarrierResponse(result.status, result.bodyBase64, result.headers)
        if (!response.isSuccessful) {
            val error = response.toApiException(codec)
            throw if (request.isolateCredentialFailure) error else handleAuthenticationFailure(error, attemptedCredential)
        }
        return response
    }

    private fun reportUnavailableCarrier(failed: P2PSession?) {
        if (mutableConnectionState.value == RuntimeConnectionState.AuthenticationRequired) return
        if (failed == null && hasOpenCarrier()) return
        if (failed != null && turnSession.get() !== failed && p2pSession.get() !== failed) return
        if (recoveryRequested.compareAndSet(false, true)) {
            mutableConnectionState.value = RuntimeConnectionState.Reconnecting
            onCarrierUnavailable?.invoke(failed)
        }
        // This is a recovery signal only. The failed business request is never replayed here.
    }

    override fun connectInvalidationSocket() {
        if (hasOpenCarrier()) {
            closeInvalidationSocketForCarrier()
            mutableConnectionState.value = RuntimeConnectionState.Connected
            return
        }
        if (requireVerifiedCarrier) return
        if (endpointProvider().trimEnd('/').isBlank()) return
        val endpoint = endpointProvider().trimEnd('/')
        if (endpoint.isBlank()) {
            mutableConnectionState.value = RuntimeConnectionState.Error
            return
        }
        closeRequested = false
        reconnectAttempt = 0
        reconnectJob?.cancel()
        webSocket?.cancel()
        openInvalidationSocket(endpoint)
    }

    private fun openInvalidationSocket(endpoint: String) {
        if (closeRequested) return
        val wsUrl = when {
            endpoint.startsWith("https://") -> "wss://${endpoint.removePrefix("https://")}/ws"
            endpoint.startsWith("http://") -> "ws://${endpoint.removePrefix("http://")}/ws"
            else -> {
                mutableConnectionState.value = RuntimeConnectionState.Error
                return
            }
        }
        mutableConnectionState.value = if (reconnectAttempt == 0) {
            RuntimeConnectionState.Connecting
        } else {
            RuntimeConnectionState.Reconnecting
        }
        val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
        val request = Request.Builder().url(wsUrl).apply {
            attemptedCredential?.let { header("Authorization", "Bearer $it") }
        }.build()
        val socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                reconnectAttempt = 0
                mutableConnectionState.value = RuntimeConnectionState.Connected
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket === this@OkHttpAgentoCTransport.webSocket && !hasOpenCarrier()) parseInvalidation(text)
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket === this@OkHttpAgentoCTransport.webSocket && !hasOpenCarrier()) parseInvalidation(bytes.utf8())
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                if (response != null && requiresAuthentication(response)) {
                    socketScope.launch {
                        requireAuthentication(attemptedCredential,
                            stillCurrent = { webSocket === this@OkHttpAgentoCTransport.webSocket },
                            onInvalidated = { invalidationEvents.tryEmit(InvalidationHint("authentication_required")) })
                    }
                    return
                }
                invalidationEvents.tryEmit(InvalidationHint("connection_failed"))
                scheduleReconnect(endpoint)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== this@OkHttpAgentoCTransport.webSocket) return
                invalidationEvents.tryEmit(InvalidationHint("connection_closed"))
                if (closeRequested) mutableConnectionState.value = RuntimeConnectionState.Disconnected
                else scheduleReconnect(endpoint)
            }
        })
        webSocket = socket
    }

    private fun closeInvalidationSocketForCarrier() {
        closeRequested = true
        reconnectJob?.cancel()
        reconnectJob = null
        val socket = webSocket
        webSocket = null
        socket?.cancel()
    }

    private suspend fun handleAuthenticationFailure(error: ApiException, attemptedCredential: String?): ApiException {
        currentCoroutineContext().ensureActive()
        if (!requiresAuthentication(error)) return error
        if (requireAuthentication(attemptedCredential)) return error
        // The rejected credential was replaced or the target changed while
        // this request was in flight. A stale 401 must not make the UI ask to
        // pair a newly renewed device again.
        return ApiException(0, "CARRIER_UNAVAILABLE", "The computer is reconnecting", retryable = true)
    }

    private suspend fun requireAuthentication(attemptedCredential: String?, stillCurrent: () -> Boolean = { true }, onInvalidated: () -> Unit = {}): Boolean {
        var applied = false
        val invalidate = {
            if (stillCurrent()) {
                applied = true
                mutableConnectionState.value = RuntimeConnectionState.AuthenticationRequired
                onAuthenticationRequired?.invoke()
                onInvalidated()
            }
        }
        if (credentialRejectionHandler != null) credentialRejectionHandler.reject(attemptedCredential, stillCurrent, invalidate)
        else if (credentialProvider()?.takeIf { it.isNotBlank() } == attemptedCredential) invalidate()
        return applied
    }

    private fun requiresAuthentication(error: ApiException): Boolean =
        error.statusCode == 401 || (error.statusCode == 403 && error.code == "DEVICE_REVOKED")

    private fun requiresAuthentication(response: okhttp3.Response): Boolean {
        if (response.code == 401) return true
        if (response.code != 403) return false
        val error = runCatching {
            codec.decode(serializer<ErrorResponseDto>(), response.peekBody(MAX_ERROR_BODY_BYTES).string())
        }.getOrNull()
        return error?.code == "DEVICE_REVOKED"
    }

    private fun scheduleReconnect(endpoint: String) {
        if (closeRequested || reconnectJob?.isActive == true) return
        mutableConnectionState.value = RuntimeConnectionState.Reconnecting
        val delayMs = minOf(30_000L, 1_000L shl reconnectAttempt.coerceAtMost(5))
        reconnectAttempt += 1
        reconnectJob = socketScope.launch {
            delay(delayMs)
            if (!closeRequested) openInvalidationSocket(endpoint)
        }
    }

    override suspend fun close() {
        closeRequested = true
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "client closed")
        webSocket = null
        turnSession.closeAll()
        p2pSession.getAndSet(null)?.close()
        mutableConnectionState.value = RuntimeConnectionState.Disconnected
    }

    private fun parseInvalidation(body: String) {
        runCatching {
            val value = codec.decode(serializer<WebSocketPushDto>(), body)
            val events = value.events
            invalidationEvents.tryEmit(InvalidationHint(value.type, value.sessionId, events))
        }.onFailure {
            invalidationEvents.tryEmit(InvalidationHint("protocol_error"))
        }
    }

    private fun ApiResponse.toApiException(codec: ProtocolCodec): ApiException {
        val parsed = runCatching { codec.decode(serializer<ErrorResponseDto>(), body) }.getOrNull()
        return ApiException(
            statusCode = statusCode,
            code = parsed?.code,
            message = parsed?.error?.takeIf { it.isNotBlank() } ?: "AgentoC request failed ($statusCode)",
            retryAfterMs = retryAfterDelayMs(),
            headers = headers,
        )
    }

    companion object {
        internal const val MAX_HTTP_RESPONSE_BYTES = 64L * 1024L * 1024L
        internal const val MAX_CARRIER_RESPONSE_BYTES = 24 * 1024 * 1024
        private const val UPLOAD_CHUNK_HTTP_TIMEOUT_MS = 165_000L
        private const val ACCOUNT_ASR_READ_TIMEOUT_MS = 45_000L
        private const val ACCOUNT_ASR_CALL_TIMEOUT_MS = 60_000L
        private const val MAX_ERROR_BODY_BYTES = 64L * 1024L
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_BODY = "".toRequestBody(JSON_MEDIA_TYPE)

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
}

internal fun readBoundedHttpResponse(statusCode: Int, headers: Map<String, String>, body: okhttp3.ResponseBody?): ApiResponse {
    val length = body?.contentLength() ?: 0L
    if (length > OkHttpAgentoCTransport.MAX_HTTP_RESPONSE_BYTES)
        throw IOException("HTTP response exceeded the client size limit")
    val buffer = Buffer()
    val source = body?.source()
    var total = 0L
    if (source != null) {
        while (true) {
            val read = source.read(buffer, 16 * 1024L)
            if (read < 0) break
            total += read
            if (total > OkHttpAgentoCTransport.MAX_HTTP_RESPONSE_BYTES)
                throw IOException("HTTP response exceeded the client size limit")
        }
    }
    val bytes = buffer.readByteArray()
    return if (isTextResponse(body?.contentType()?.toString()))
        ApiResponse(statusCode, bytes.toString(Charsets.UTF_8), headers)
    else ApiResponse(statusCode, "", headers, bytes)
}

private fun isTextResponse(contentType: String?): Boolean {
    val type = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return true
    return type.startsWith("text/") || type == "application/json" || type.endsWith("+json")
        || type == "application/xml" || type.endsWith("+xml") || type == "application/x-www-form-urlencoded"
}

private fun decodeCarrierResponse(status: Int, bodyBase64: String, headers: Map<String, String>): ApiResponse {
    val maximumBase64Characters = ((OkHttpAgentoCTransport.MAX_CARRIER_RESPONSE_BYTES.toLong() * 4L + 2L) / 3L)
    if (bodyBase64.length.toLong() > maximumBase64Characters) throw IOException("Carrier response exceeded the client size limit")
    val bytes = P2PProtocol.decodeBody(bodyBase64)
    if (bytes.size > OkHttpAgentoCTransport.MAX_CARRIER_RESPONSE_BYTES) throw IOException("Carrier response exceeded the client size limit")
    return if (isTextResponse(headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value))
        ApiResponse(status, bytes.toString(Charsets.UTF_8), headers)
    else ApiResponse(status, "", headers, bytes)
}

private class StreamingRequestBody(
    private val source: ApiRequestBodySource,
    private val mediaType: String?,
) : RequestBody() {
    override fun contentType() = mediaType?.toMediaType()
    override fun contentLength(): Long = source.sizeBytes
    override fun writeTo(sink: BufferedSink) {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        source.openStream().buffered(buffer.size).use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                total += read
                if (total > source.sizeBytes) throw IOException("Streaming request exceeded its declared size")
                digest.update(buffer, 0, read)
                sink.write(buffer, 0, read)
            }
        }
        val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
        if (total != source.sizeBytes || actualHash != source.sha256)
            throw IOException("Streaming request differs from its verified file descriptor")
    }
}
