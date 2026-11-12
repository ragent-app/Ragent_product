package com.andysagent.agentoc

import com.andysagent.agentoc.core.domain.AttachmentRelayPayload
import com.andysagent.agentoc.core.domain.AttachmentRelayTicket
import com.andysagent.agentoc.core.domain.AttachmentRelayTransport
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiRequestBodySource
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.*
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import java.security.SecureRandom
import java.util.Base64
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class AccountAttachmentRelay(
    private val baseUrl: String,
    private val accounts: AgentoCTransport,
    private val ensureAccount: suspend () -> Unit,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build(),
) : AttachmentRelayTransport {
    private data class Capabilities(val epoch: String, val maxLifetimeMs: Long, val cachedAt: Long)
    @Volatile private var cachedCapabilities: Capabilities? = null
    @Volatile private var capabilitiesAbsentAt: Long? = null
    private val random = SecureRandom()
    private val base: String = URI(baseUrl).let {
        require(it.scheme == "https" && !it.host.isNullOrBlank() && it.userInfo == null && it.query == null && it.fragment == null)
        baseUrl.trimEnd('/')
    }

    override suspend fun reserve(sizeBytes: Long): AttachmentRelayTicket? {
        ensureAccount()
        val response = accounts.execute(ApiRequest("POST", "/v1/owner-auth/account/attachment-relay/reservations",
            buildJsonObject { put("sizeBytes", sizeBytes) }.toString(), contentType = "application/json"))
        if (response.statusCode == 404 || response.statusCode == 501) return null
        if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Attachment relay reservation failed")
        val body = AgentocProtocol.json.parseToJsonElement(response.body).jsonObject
        fun field(name: String) = body[name]?.jsonPrimitive?.contentOrNull ?: error("Invalid relay reservation")
        return AttachmentRelayTicket(field("id"), field("writeToken"), field("readToken"),
            body["size"]?.jsonPrimitive?.longOrNull ?: error("Invalid relay reservation"))
    }

    override suspend fun reserveSpeculative(sizeBytes: Long): AttachmentRelayTicket? {
        ensureAccount()
        if (capabilitiesAbsentAt?.let { System.nanoTime() - it < TimeUnit.SECONDS.toNanos(60) } == true) return null
        var caps = cachedCapabilities?.takeIf { System.nanoTime() - it.cachedAt < TimeUnit.SECONDS.toNanos(60) }
        if (caps == null) {
            val response = accounts.execute(ApiRequest("GET", "/v1/owner-auth/account/attachment-relay/capabilities"))
            if (response.statusCode == 404 || response.statusCode == 501) {
                capabilitiesAbsentAt = System.nanoTime()
                return null
            }
            if (!response.isSuccessful) throw ApiException(response.statusCode, null, "Attachment relay capabilities unavailable")
            val body = AgentocProtocol.json.parseToJsonElement(response.body).jsonObject
            val epoch = body["epoch"]?.jsonPrimitive?.contentOrNull.orEmpty()
            val lifetime = body["maxLifetimeMs"]?.jsonPrimitive?.longOrNull ?: 0
            if (body["version"]?.jsonPrimitive?.intOrNull != 2 || !epoch.matches(Regex("[a-f0-9]{32}")) || lifetime !in 10_000L..300_000L) return null
            caps = Capabilities(epoch, lifetime, System.nanoTime())
            cachedCapabilities = caps
        }
        val capabilities = caps ?: return null
        fun token(): String = ByteArray(32).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        val id = ByteArray(16).also(random::nextBytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val ticket = AttachmentRelayTicket(id, token(), token(), sizeBytes, capabilities.epoch,
            System.currentTimeMillis() + minOf(120_000L, capabilities.maxLifetimeMs - 5_000L))
        val body = buildJsonObject {
            put("id", ticket.id); put("epoch", capabilities.epoch); put("deadline", ticket.deadline!!)
            put("sizeBytes", sizeBytes); put("writeToken", ticket.writeToken); put("readToken", ticket.readToken)
        }.toString()
        try {
            val response = accounts.execute(ApiRequest("POST", "/v1/owner-auth/account/attachment-relay/reservations-v2",
                body, contentType = "application/json"))
            if (response.statusCode == 404 || response.statusCode == 501) {
                cachedCapabilities = null
                capabilitiesAbsentAt = System.nanoTime()
                withContext(NonCancellable) { withTimeoutOrNull(5_000) { runCatching { cancel(ticket) } } }
                return null
            }
            if (!response.isSuccessful) {
                if (response.statusCode == 409) cachedCapabilities = null
                throw ApiException(response.statusCode, null, "Attachment relay preflight unavailable")
            }
            val receipt = AgentocProtocol.json.parseToJsonElement(response.body).jsonObject
            check(receipt["id"]?.jsonPrimitive?.contentOrNull == ticket.id &&
                receipt["epoch"]?.jsonPrimitive?.contentOrNull == capabilities.epoch &&
                receipt["deadline"]?.jsonPrimitive?.longOrNull == ticket.deadline &&
                receipt["size"]?.jsonPrimitive?.longOrNull == sizeBytes) { "Invalid relay preflight receipt" }
            return ticket
        } catch (error: Throwable) {
            // The response may have been lost after reservation. The v2 fence
            // also covers a cancellation that reaches Accounts first.
            withContext(NonCancellable) { withTimeoutOrNull(5_000) { runCatching { cancel(ticket) } } }
            throw error
        }
    }

    override suspend fun cancel(ticket: AttachmentRelayTicket) {
        require(ticket.id.matches(Regex("[a-f0-9]{32}")) && ticket.writeToken.matches(Regex("[A-Za-z0-9_-]{43}")))
        if (ticket.epoch != null && ticket.deadline != null) {
            val body = buildJsonObject { put("id", ticket.id); put("epoch", ticket.epoch)
                put("deadline", ticket.deadline); put("writeToken", ticket.writeToken) }.toString()
            val response = accounts.execute(ApiRequest("POST", "/v1/owner-auth/account/attachment-relay/reservations-v2/cancel",
                body, contentType = "application/json"))
            if (response.statusCode !in setOf(204, 404, 409)) throw IOException("Attachment relay cancellation failed")
            return
        }
        val request = Request.Builder().url("$base/v1/owner-auth/account/attachment-relay/reservations/${ticket.id}")
            .header("Authorization", "Bearer ${ticket.writeToken}").delete().build()
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(IOException("Attachment relay cancellation failed", e))
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!continuation.isActive) return
                        if (it.code == 204 || it.code == 404) continuation.resume(Unit)
                        else continuation.resumeWithException(IOException("Attachment relay cancellation rejected (${it.code})"))
                    }
                }
            })
        }
    }

    override suspend fun send(ticket: AttachmentRelayTicket, source: ApiRequestBodySource, key: ByteArray,
        transferId: String, onProgress: (Long) -> Unit) {
        require(ticket.id.matches(Regex("[a-f0-9]{32}")) && ticket.writeToken.matches(Regex("[A-Za-z0-9_-]{43}")) &&
            ticket.sizeBytes == AttachmentRelayPayload.wireSize(source.sizeBytes))
        val body = object : RequestBody() {
            override fun contentType() = "application/vnd.agentoc.attachment-relay".toMediaType()
            override fun contentLength() = ticket.sizeBytes
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                AttachmentRelayPayload.write(source, key, transferId, sink.outputStream(), onProgress)
            }
        }
        val request = Request.Builder().url("$base/v1/owner-auth/account/attachment-relay/${ticket.id}/content")
            .header("Authorization", "Bearer ${ticket.writeToken}").put(body).build()
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(IOException("Attachment relay upload failed", e))
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        if (!continuation.isActive) return
                        if (it.code == 204) continuation.resume(Unit)
                        else continuation.resumeWithException(IOException("Attachment relay upload rejected (${it.code})"))
                    }
                }
            })
        }
    }
}
