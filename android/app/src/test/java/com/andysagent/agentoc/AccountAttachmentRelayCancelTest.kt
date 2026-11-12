package com.andysagent.agentoc

import com.andysagent.agentoc.core.domain.AttachmentRelayTicket
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.io.IOException
import kotlin.test.*

class AccountAttachmentRelayCancelTest {
    @Test fun cancelUsesOnlyWriterCapabilityAndAcceptsOldServers() = runBlocking {
        var status = 204
        val seen = mutableListOf<okhttp3.Request>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            seen += chain.request()
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status)
                .message("fixture").body("".toResponseBody()).build()
        }.build()
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse = error("unexpected account request")
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {}, client)
        val ticket = AttachmentRelayTicket("a".repeat(32), "b".repeat(43), "c".repeat(43), 123)
        relay.cancel(ticket)
        status = 404 // The older service has no cancellation endpoint or already consumed the ticket.
        relay.cancel(ticket)
        assertEquals(2, seen.size)
        assertTrue(seen.all { it.method == "DELETE" && it.url.encodedPath.endsWith("/reservations/${ticket.id}") })
        assertTrue(seen.all { it.header("Authorization") == "Bearer ${ticket.writeToken}" })
        assertFalse(seen.any { it.toString().contains(ticket.readToken) })
        status = 403
        assertFailsWith<IOException> { relay.cancel(ticket) }
        Unit
    }

    @Test fun lostPreflightResponseFencesTheClientGeneratedTicket() = runBlocking {
        val seen = mutableListOf<ApiRequest>()
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse {
                seen += request
                return when {
                    request.path.endsWith("/capabilities") -> ApiResponse(200, """{"version":2,"epoch":"${"a".repeat(32)}","maxLifetimeMs":300000}""")
                    request.path.endsWith("/reservations-v2") -> throw IOException("lost response")
                    request.path.endsWith("/reservations-v2/cancel") -> ApiResponse(204, "")
                    else -> error("unexpected request")
                }
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        assertFailsWith<IOException> { relay.reserveSpeculative(100) }
        val reserve = Json.parseToJsonElement(seen[1].body!!).jsonObject
        val cancel = Json.parseToJsonElement(seen[2].body!!).jsonObject
        assertEquals(reserve["id"], cancel["id"])
        assertEquals(reserve["epoch"], cancel["epoch"])
        assertEquals(reserve["deadline"], cancel["deadline"])
        assertEquals(reserve["writeToken"], cancel["writeToken"])
        assertFalse(cancel.containsKey("readToken"))
    }

    @Test fun cancelledInFlightPreflightStillSendsFence() = runBlocking {
        val started = CompletableDeferred<Unit>()
        var fenced = false
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.path.endsWith("/capabilities") -> ApiResponse(200, """{"version":2,"epoch":"${"a".repeat(32)}","maxLifetimeMs":300000}""")
                request.path.endsWith("/reservations-v2") -> { started.complete(Unit); awaitCancellation() }
                request.path.endsWith("/reservations-v2/cancel") -> { fenced = true; ApiResponse(204, "") }
                else -> error("unexpected request")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        val upload = async { relay.reserveSpeculative(100) }
        started.await()
        upload.cancelAndJoin()
        assertTrue(fenced)
    }

    @Test fun successfulPreflightUsesMatchingReceiptAndAuthenticatedFence() = runBlocking {
        var reserved: JsonObject? = null
        var cancelled: JsonObject? = null
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.path.endsWith("/capabilities") -> ApiResponse(200, """{"version":2,"epoch":"${"a".repeat(32)}","maxLifetimeMs":300000}""")
                request.path.endsWith("/reservations-v2") -> {
                    val value = Json.parseToJsonElement(request.body!!).jsonObject
                    reserved = value
                    ApiResponse(201, buildJsonObject { put("id", value["id"]!!); put("epoch", value["epoch"]!!)
                        put("deadline", value["deadline"]!!); put("size", value["sizeBytes"]!!) }.toString())
                }
                request.path.endsWith("/reservations-v2/cancel") -> {
                    cancelled = Json.parseToJsonElement(request.body!!).jsonObject; ApiResponse(204, "")
                }
                else -> error("unexpected request")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        val ticket = assertNotNull(relay.reserveSpeculative(100))
        relay.cancel(ticket)
        assertEquals(reserved!!["id"], cancelled!!["id"])
        assertEquals(reserved!!["writeToken"], cancelled!!["writeToken"])
        assertFalse(cancelled!!.containsKey("readToken"))
    }

    @Test fun oldAccountsServerDeclinesPreflightWithoutReservation() = runBlocking {
        var requests = 0
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse { requests++; return ApiResponse(404, "") }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        assertNull(relay.reserveSpeculative(100))
        assertNull(relay.reserveSpeculative(100))
        assertEquals(1, requests)
    }

    @Test fun serverRestartInvalidatesCachedEpochAndNextAttemptDiscoversNewOne() = runBlocking {
        var capabilityRequests = 0
        var attempts = 0
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.path.endsWith("/capabilities") -> {
                    capabilityRequests++
                    val epoch = if (capabilityRequests == 1) "a".repeat(32) else "b".repeat(32)
                    ApiResponse(200, """{"version":2,"epoch":"$epoch","maxLifetimeMs":300000}""")
                }
                request.path.endsWith("/reservations-v2") -> {
                    attempts++
                    val body = Json.parseToJsonElement(request.body!!).jsonObject
                    if (attempts == 1) ApiResponse(409, "") else ApiResponse(201, buildJsonObject {
                        put("id", body["id"]!!); put("epoch", body["epoch"]!!)
                        put("deadline", body["deadline"]!!); put("size", body["sizeBytes"]!!)
                    }.toString())
                }
                request.path.endsWith("/reservations-v2/cancel") -> ApiResponse(409, "")
                else -> error("unexpected request")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        assertFailsWith<ApiException> { relay.reserveSpeculative(100) }
        assertEquals("b".repeat(32), assertNotNull(relay.reserveSpeculative(100)).epoch)
        assertEquals(2, capabilityRequests)
    }

    @Test fun partialDeploymentIsFencedAndTemporarilyTreatedAsOldServer() = runBlocking {
        val paths = mutableListOf<String>()
        val accounts = object : AgentoCTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override suspend fun execute(request: ApiRequest): ApiResponse {
                paths += request.path
                return if (request.path.endsWith("/capabilities"))
                    ApiResponse(200, """{"version":2,"epoch":"${"a".repeat(32)}","maxLifetimeMs":300000}""")
                else ApiResponse(404, "")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val relay = AccountAttachmentRelay("https://accounts.example", accounts, {})
        assertNull(relay.reserveSpeculative(100))
        assertNull(relay.reserveSpeculative(100))
        assertEquals(3, paths.size)
        assertTrue(paths.last().endsWith("/reservations-v2/cancel"))
    }
}
