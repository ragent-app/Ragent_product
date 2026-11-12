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
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class AccountAttachmentRelay(
    private val baseUrl: String,
    private val accounts: AgentoCTransport,
    private val ensureAccount: suspend () -> Unit,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build(),
) : AttachmentRelayTransport {
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
