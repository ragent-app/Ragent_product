package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.protocol.ConnectionBootstrapContractDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapPublicKeyDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapReportAckDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapReportRequestDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapVerifier
import com.andysagent.ragent.core.protocol.ProtocolCodec
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnReleaseRequestDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnReleaseResponseDto
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class VerifiedBootstrap(
    val contract: ConnectionBootstrapContractDto,
    val publicKey: ConnectionBootstrapPublicKeyDto,
    val rawContract: String = "",
)

/**
 * Authenticated bootstrap is deliberately a separate HTTP client. It always uses the
 * configured control endpoint and never consults a selected P2P transport before
 * the signed contract has been verified.
 */
class ConnectionBootstrapClient(
    private val endpointProvider: () -> String,
    private val credentialProvider: () -> String?,
    private val client: OkHttpClient = defaultClient(),
    private val codec: ProtocolCodec = ProtocolCodec(),
) {
    suspend fun fetch(credential: String? = credentialProvider()): VerifiedBootstrap {
        val endpoint = endpointProvider().trimEnd('/').takeIf { it.isNotBlank() }
            ?: throw BootstrapException("BOOTSTRAP_ENDPOINT_MISSING", "Bootstrap endpoint is not configured")
        val keyResponse = get(endpoint, "/api/device-auth/bootstrap/public-key", credential)
        val publicKey = decode(keyResponse.body, serializer<ConnectionBootstrapPublicKeyDto>())
        val contractResponse = get(endpoint, "/api/device-auth/bootstrap", credential)
        val verified = ConnectionBootstrapVerifier.verify(contractResponse.body, publicKey)
        return VerifiedBootstrap(verified.contract, verified.publicKey, contractResponse.body)
    }

    suspend fun report(report: ConnectionBootstrapReportRequestDto): ConnectionBootstrapReportAckDto {
        val endpoint = endpointProvider().trimEnd('/').takeIf { it.isNotBlank() }
            ?: throw BootstrapException("BOOTSTRAP_ENDPOINT_MISSING", "Bootstrap endpoint is not configured")
        val body = codec.encode(serializer<ConnectionBootstrapReportRequestDto>(), report)
        val response = request(endpoint, "/api/device-auth/bootstrap/report", "POST", body)
        return decode(response.body, serializer<ConnectionBootstrapReportAckDto>())
    }

    suspend fun releaseTurn(
        connectionId: String? = null,
        reason: String? = null,
    ): ConnectionBootstrapTurnReleaseResponseDto {
        val endpoint = endpointProvider().trimEnd('/').takeIf { it.isNotBlank() }
            ?: throw BootstrapException("BOOTSTRAP_ENDPOINT_MISSING", "Bootstrap endpoint is not configured")
        val body = codec.encode(
            serializer<ConnectionBootstrapTurnReleaseRequestDto>(),
            ConnectionBootstrapTurnReleaseRequestDto(connectionId = connectionId, reason = reason),
        )
        val response = request(endpoint, "/api/device-auth/turn/release", "POST", body)
        return decode(response.body, serializer<ConnectionBootstrapTurnReleaseResponseDto>())
    }

    private suspend fun get(endpoint: String, path: String, credential: String?): ApiResponse = request(endpoint, path, "GET", null, credential)

    private suspend fun request(endpoint: String, path: String, method: String, body: String?, credential: String? = credentialProvider()): ApiResponse {
        val request = Request.Builder()
            .url("$endpoint$path")
            .apply {
                credential?.takeIf { it.isNotBlank() }?.let {
                    header("Authorization", "Bearer $it")
                }
            }
            .method(method, body?.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return try {
            suspendCancellableCoroutine { continuation ->
                val call = client.newCall(request)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, error: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }
                    override fun onResponse(call: Call, response: Response) {
                        try {
                            val result = response.use { ApiResponse(it.code, it.body?.string().orEmpty()) }
                            if (!result.isSuccessful) throw BootstrapException("BOOTSTRAP_HTTP_${result.statusCode}",
                                "Bootstrap request failed (${result.statusCode})")
                            if (continuation.isActive) continuation.resume(result)
                        } catch (error: Exception) {
                            if (continuation.isActive) continuation.resumeWithException(error)
                        }
                    }
                })
            }
        } catch (error: BootstrapException) {
            throw error
        } catch (error: IOException) {
            throw BootstrapException("BOOTSTRAP_NETWORK_ERROR", "Bootstrap request failed", error)
        }
    }

    private fun <T> decode(body: String, serializer: kotlinx.serialization.DeserializationStrategy<T>): T =
        runCatching { codec.decode(serializer, body) }
            .getOrElse { throw BootstrapException("BOOTSTRAP_PROTOCOL_ERROR", "Bootstrap response shape is invalid", it) }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private fun defaultClient(): OkHttpClient = SharedOkHttpClient.newBuilder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}

class BootstrapException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IOException(message, cause)

data class BootstrapConnectionReportDecision(
    val phase: String,
    val transport: String,
    val connectionId: String?,
    val candidateId: String?,
    val reportedSession: Any?,
)

fun nextBootstrapConnectionReport(
    transportKind: TransportKind,
    currentPlan: BootstrapConnectionPlan?,
    currentSession: P2PSession?,
    sessionCarrier: TurnCarrier?,
    lastReportedSession: Any?,
    lastReportedTransport: String?,
): BootstrapConnectionReportDecision? {
    val transportName = when (transportKind) {
        TransportKind.P2P -> "webrtc"
        TransportKind.Turn -> "turn"
        TransportKind.None -> null
    } ?: return null
    currentPlan ?: return null
    val previous = if (lastReportedSession === currentSession) lastReportedTransport else null
    if (previous == transportName) return null
    val phase = if (transportKind == TransportKind.P2P || previous != null) "migrated" else "connected"
    val connectionId = sessionCarrier?.connectionId ?: currentPlan.turnConnectionId
    val candidateId = when (transportKind) {
        TransportKind.Turn -> sessionCarrier?.candidateId ?: currentPlan.turnCarrier?.candidateId
        TransportKind.P2P -> currentPlan.contract.candidates.firstOrNull { it.kind == "webrtc" }?.id
            ?: sessionCarrier?.candidateId
        TransportKind.None -> null
    }
    return BootstrapConnectionReportDecision(
        phase = phase,
        transport = transportName,
        connectionId = connectionId,
        candidateId = candidateId,
        reportedSession = currentSession,
    )
}
