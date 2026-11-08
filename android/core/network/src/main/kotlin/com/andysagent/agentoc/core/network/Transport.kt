package com.andysagent.agentoc.core.network

import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Duration
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.io.InputStream

/** Reopenable, fixed-size request body used for uploads without a heap-sized byte array. */
data class ApiRequestBodySource(
    val sizeBytes: Long,
    val sha256: String,
    val openStream: () -> InputStream,
) {
    init {
        require(sizeBytes > 0L)
        require(sha256.matches(Regex("^[a-f0-9]{64}$")))
    }
}

data class ApiRequest(
    val method: String,
    val path: String,
    val body: String? = null,
    val requestId: String? = null,
    val idempotencyKey: String? = null,
    val headers: Map<String, String> = emptyMap(),
    /** Optional binary body for small payloads. Large uploads should use [bodySource]. */
    val bodyBytes: ByteArray? = null,
    val contentType: String? = null,
    /** Optional local body-write observation. Unsupported carriers leave it silent; never serialized. */
    val onBodyBytesWritten: ((Long) -> Unit)? = null,
    /** Public device-key challenges do not authenticate or invalidate the current bearer. */
    val isolateCredentialFailure: Boolean = false,
    /** Reopenable streaming body for direct HTTP uploads; never serialized into carrier metadata. */
    val bodySource: ApiRequestBodySource? = null,
)

data class ApiResponse(
    val statusCode: Int,
    val body: String,
    val headers: Map<String, String> = emptyMap(),
    val bodyBytes: ByteArray? = null,
) {
    val isSuccessful: Boolean get() = statusCode in 200..299
}

/** Server-specified retry delay, shared by direct HTTP and verified carrier responses. */
fun ApiResponse.retryAfterDelayMs(now: Instant = Instant.now()): Long? {
    val bodyDelay = runCatching {
        Json.parseToJsonElement(body).jsonObject["retryAfterMs"]?.jsonPrimitive?.longOrNull
    }.getOrNull()?.takeIf { it >= 0L }
    val header = headers.entries
        .firstOrNull { (name, _) -> name.equals("Retry-After", ignoreCase = true) }
        ?.value?.trim()
    val headerDelay = header?.toLongOrNull()?.takeIf { it >= 0L }
        ?.let { seconds -> seconds.coerceAtMost(Long.MAX_VALUE / 1_000L) * 1_000L }
        ?: header?.let { value -> runCatching {
            val retryAt = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()
            Duration.between(now, retryAt).toMillis().coerceAtLeast(0L)
        }.getOrNull() }
    // A proxy and the origin can both specify a cooldown. Neither limit may
    // be shortened by the other value, including an explicit zero in JSON.
    return listOfNotNull(bodyDelay, headerDelay).maxOrNull()
}

data class InvalidationHint(
    val type: String,
    val sessionId: String? = null,
    val events: List<SessionEventDto> = emptyList(),
)

class ApiException(
    val statusCode: Int,
    val code: String?,
    override val message: String,
    val retryable: Boolean = statusCode == 408 || statusCode == 409 || statusCode == 429 || statusCode >= 500,
    /** Server-provided delay for retryable responses, in milliseconds. */
    val retryAfterMs: Long? = null,
    val headers: Map<String, String> = emptyMap(),
) : RuntimeException(message)

interface AgentoCTransport {
    val invalidations: Flow<InvalidationHint>
    val connectionState: StateFlow<RuntimeConnectionState>
    /** Endpoint-less TURN/P2P carriers need durable event polling. */
    val requiresEventPolling: Boolean get() = false
    suspend fun execute(request: ApiRequest): ApiResponse
    fun connectInvalidationSocket()
    fun markAuthenticationRequired() {}
    suspend fun close()
}
