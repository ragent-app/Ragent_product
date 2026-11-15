package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PProtocol
import com.andysagent.ragent.core.protocol.TemporaryAccessProtocol
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

/** Workbench traffic over the verified control carrier, with no direct HTTP fallback. */
class TemporaryControlTransport(
    private val connector: TemporaryCarrierConnector,
    private val connection: VerifiedTemporaryConnection,
    private val grant: TemporaryControlProtocol.VerifiedGrant,
    private val identity: DeviceIdentityStore,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val recover: (suspend () -> Unit)? = null,
) : RagentTransport {
    private val events = MutableSharedFlow<InvalidationHint>()
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    private val random = SecureRandom()
    private val deadline = minOf(connection.expiresAt, grant.expiresAt)
    @Volatile private var closed = false
    private var recovery: Job? = null
    private val expiry = scope.launch {
        delay((deadline - nowMs()).coerceAtLeast(0))
        end()
    }
    override val invalidations = events.asSharedFlow()
    override val connectionState = state.asStateFlow()
    override val requiresEventPolling = true

    override suspend fun execute(request: ApiRequest): ApiResponse {
        if (closed || nowMs() >= deadline) {
            end()
            throw ApiException(410, "temporary_control_expired", "Temporary control has expired", retryable = false)
        }
        require(connection.deviceId == grant.deviceId && request.path.startsWith("/api/") && !request.path.startsWith("//"))
        val path = request.path.substringBefore('?')
        require(!path.contains('#') && !path.contains("..") && !path.contains('\\'))
        val translated = if (path == "/api/native-providers" || path.startsWith("/api/native-providers/"))
            path.replaceFirst("/api/native-providers", "/api/providers") else path
        val target = "/api/temporary-control/v1/instances/${connection.instanceId}" + translated.removePrefix("/api")
        val query = if ('?' in request.path) "?" + request.path.substringAfter('?') else ""
        val jti = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(24).also(random::nextBytes))
        val method = request.method.uppercase()
        val proof = TemporaryAccessProtocol.controlDpop(grant.accessToken, identity.publicKeyEncoded(), method,
            target, nowMs(), jti, identity::sign)
        val headers = request.headers.filterKeys { it.lowercase() !in setOf("authorization", "dpop", "cookie",
            "x-ragent-browser-principal", "x-ragent-target-grant") }.toMutableMap()
        headers["Authorization"] = "DPoP ${grant.accessToken}"; headers["DPoP"] = proof
        (request.contentType ?: if (request.body != null) "application/json" else null)?.let { headers["Content-Type"] = it }
        request.requestId?.let { headers["X-Ragent-Request-Id"] = it }
        request.idempotencyKey?.let { headers["Idempotency-Key"] = it }
        val session = connector.session(connection) ?: throw ApiException(0, "temporary_control_disconnected", "Temporary computer is disconnected", retryable = true)
        val wire = P2PHttpRequest(id = UUID.randomUUID().toString(), method = method, path = target + query,
            headers = headers, bodyBase64 = request.bodyBytes?.let(P2PProtocol::encodeBody)
                ?: request.body?.let(P2PProtocol::encodeBody) ?: "")
        val reply = session.request(wire).getOrElse { throw ApiException(0, "temporary_control_disconnected", "Temporary computer is disconnected", retryable = true) }
        reply.error?.let { throw ApiException(0, "temporary_control_carrier_error", it, retryable = false) }
        val bytes = P2PProtocol.decodeBody(reply.bodyBase64)
        val result = ApiResponse(reply.status, bytes.toString(Charsets.UTF_8), reply.headers, bytes)
        if (!result.isSuccessful) {
            val body = runCatching { Json.parseToJsonElement(result.body).jsonObject }.getOrNull()
            val code = body?.get("code")?.jsonPrimitive?.content
            if (reply.status == 410) end()
            throw ApiException(reply.status, code, body?.get("error")?.jsonPrimitive?.content ?: "Temporary request failed")
        }
        return result
    }

    override fun connectInvalidationSocket() = Unit
    @Synchronized fun carrierLost() {
        if (closed || !scope.isActive || nowMs() >= deadline || recover == null) { end(); return }
        state.value = RuntimeConnectionState.Reconnecting
        if (recovery?.isActive == true) return
        val next = scope.launch(start = CoroutineStart.LAZY) {
            var attempts = 0
            while (!closed && nowMs() < deadline) {
                try {
                    // Recovery verifies the original grant and opens its existing
                    // relay. It never resubmits the interrupted business request.
                    recover.invoke()
                    if (connector.session(connection) == null) throw ApiException(0,
                        "temporary_control_disconnected", "Temporary computer is disconnected", retryable = true)
                    synchronized(this@TemporaryControlTransport) {
                        if (closed || nowMs() >= deadline) end()
                        else state.value = RuntimeConnectionState.Connected
                    }
                    return@launch
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: ApiException) {
                    if (!error.retryable || error.statusCode == 429) { end(); return@launch }
                } catch (_: Exception) {
                    end(); return@launch
                }
                val remaining = deadline - nowMs()
                if (remaining > 0) delay(minOf(1_000L shl attempts.coerceAtMost(2), remaining))
                attempts++
            }
            end()
        }
        recovery = next
        next.invokeOnCompletion {
            synchronized(this) {
                if (recovery === next) {
                    recovery = null
                    if (!closed && scope.isActive && state.value == RuntimeConnectionState.Reconnecting) carrierLost()
                }
            }
        }
        next.start()
    }

    @Synchronized private fun end() {
        if (closed) return
        closed = true; recovery?.cancel(); connector.stop(connection.instanceId)
        state.value = RuntimeConnectionState.Disconnected
    }
    override suspend fun close() { expiry.cancel(); end() }
}
