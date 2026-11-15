package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class TemporaryPairingClientTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/fixtures/temporary-access-signed.json")!!.readText()).jsonObject
    private val envelope = fixture.getValue("envelope").jsonObject
    private val invitation = envelope.getValue("invitation").jsonObject
    private val claim = fixture.getValue("claim").jsonObject
    private val completion = fixture.getValue("completion").jsonObject
    private val now = fixture.getValue("now").jsonPrimitive.content.toLong()
    private val instanceId = invitation.getValue("instanceId").jsonPrimitive.content
    private val ticket = JsonObject(mapOf("version" to JsonPrimitive(1), "envelope" to envelope,
        "token" to claim.getValue("token"))).toString()
    private val requestIdBytes = Base64.getUrlDecoder().decode(claim.getValue("requestId").jsonPrimitive.content.removePrefix("rtr_"))

    private val device = object : DeviceIdentityStore {
        private val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(
            Base64.getDecoder().decode(fixture.getValue("testOnlyDevicePrivateKeyPkcs8").jsonPrimitive.content)))
        override fun publicKeyEncoded() = claim.getValue("devicePublicKey").jsonPrimitive.content
        override fun sign(message: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
            Signature.getInstance("SHA256withECDSA").apply {
                initSign(key); update(message.toByteArray())
            }.sign())
        override fun clear() = Unit
    }

    private class MemoryJournal : TemporaryClaimJournal {
        var saved: TemporaryClaimRecord? = null
        var writes = 0
        override fun read(instanceId: String) = saved
        override fun listInstanceIds(): List<String> = listOfNotNull(saved?.claim?.instanceId)
        override fun write(instanceId: String, record: TemporaryClaimRecord) { saved = record; writes++ }
        override fun clear(instanceId: String) { saved = null }
    }

    private class Broker(private val completion: JsonObject, private val connection: JsonObject? = null) : RagentTransport {
        override val invalidations: Flow<InvalidationHint> = emptyFlow()
        override val connectionState: StateFlow<RuntimeConnectionState> = MutableStateFlow(RuntimeConnectionState.Connected)
        var claims = 0
        var polls = 0
        var connections = 0
        var connectionPolls = 0
        var failConnectOnce = false
        var failClaimOnce = false
        override suspend fun execute(request: ApiRequest): ApiResponse {
            assertEquals("POST", request.method)
            assertEquals(null, request.headers["Authorization"])
            return when (request.path) {
                "/v1/temporary-pairing/claim" -> {
                    claims++
                    if (failClaimOnce) { failClaimOnce = false; error("lost claim response") }
                    ApiResponse(200, "{\"status\":\"CLAIMED\"}")
                }
                "/v1/temporary-pairing/result" -> {
                    polls++
                    val proof = Json.parseToJsonElement(request.body!!).jsonObject
                    assertEquals(completion.getValue("payload").jsonObject.getValue("result").jsonObject
                        .getValue("requestId").jsonPrimitive.content, proof.getValue("requestId").jsonPrimitive.content)
                    ApiResponse(200, JsonObject(mapOf("completion" to completion)).toString())
                }
                "/v1/temporary-pairing/connect" -> {
                    connections++
                    if (failConnectOnce) { failConnectOnce = false; error("lost connection response") }
                    val payload = Json.parseToJsonElement(request.body!!).jsonObject.getValue("payload").jsonObject
                    ApiResponse(200, JsonObject(mapOf("connectionRequestId" to payload.getValue("connectionRequestId"),
                        "connectionStatus" to JsonPrimitive("PENDING"))).toString())
                }
                "/v1/temporary-pairing/connection-result" -> {
                    connectionPolls++
                    ApiResponse(200, JsonObject(mapOf("connection" to (connection ?: error("no connection fixture")))).toString())
                }
                else -> error("unexpected broker route")
            }
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }

    @Test fun `lost claim response resumes original claim and verifies original PC completion`() = runBlocking {
        val journal = MemoryJournal()
        val broker = Broker(completion).apply { failClaimOnce = true }
        val client = TemporaryPairingClient(broker, device, journal, { now }, { dst -> requestIdBytes.copyInto(dst) })
        assertFailsWith<IllegalStateException> { client.claimFromQr(ticket) }
        val pending = assertNotNull(journal.saved)
        assertEquals(claim.getValue("requestId").jsonPrimitive.content, pending.claim.requestId)
        assertEquals(false, pending.claimAccepted)
        val accepted = client.resume(instanceId)
        assertEquals(completion.getValue("payload").jsonObject.getValue("result").jsonObject
            .getValue("grantId").jsonPrimitive.content, assertNotNull(accepted).grant.grantId)
        assertEquals(2, broker.claims)
        assertEquals(1, broker.polls)
        assertNotNull(journal.saved?.completion)
        assertNotNull(client.resume(instanceId))
        assertEquals(1, broker.polls)
    }

    @Test fun `invalid QR never consumes or publishes a claim`() = runBlocking {
        val journal = MemoryJournal()
        val broker = Broker(completion)
        val client = TemporaryPairingClient(broker, device, journal, { now }, { dst -> requestIdBytes.copyInto(dst) })
        val badTicket = Json.parseToJsonElement(ticket).jsonObject
        assertFailsWith<IllegalArgumentException> {
            client.claimFromQr(JsonObject(badTicket + ("token" to JsonPrimitive("rtt_${"a".repeat(32)}"))).toString())
        }
        assertNull(journal.saved)
        assertEquals(0, broker.claims)
    }

    @Test fun `expired journal cannot resume and removes its secret`() = runBlocking {
        val journal = MemoryJournal()
        val broker = Broker(completion)
        val client = TemporaryPairingClient(broker, device, journal, { now }, { dst -> requestIdBytes.copyInto(dst) })
        client.claimFromQr(ticket)
        val expired = TemporaryPairingClient(broker, device, journal,
            { invitation.getValue("accessExpiresAt").jsonPrimitive.content.toLong() },
            { dst -> requestIdBytes.copyInto(dst) })
        assertNull(expired.resume(instanceId))
        assertNull(journal.saved)
        assertEquals(0, broker.polls)
    }

    @Test fun `lost connection response uses one durable connection request and signed delivery`() = runBlocking {
        val delivery = fixture.getValue("delivery").jsonObject
        val connectionId = fixture.getValue("connectionRequestId").jsonPrimitive.content
        val connectionBytes = Base64.getUrlDecoder().decode(connectionId.removePrefix("rtr_"))
        var randomCalls = 0
        val random: (ByteArray) -> Unit = { dst ->
            randomCalls++
            (if (randomCalls == 3) connectionBytes else requestIdBytes).copyInto(dst)
        }
        val journal = MemoryJournal()
        val broker = Broker(completion, delivery).apply { failConnectOnce = true }
        var current = now
        val client = TemporaryPairingClient(broker, device, journal, { current }, random)
        client.claimFromQr(ticket)
        assertNotNull(client.resume(instanceId))
        assertFailsWith<IllegalStateException> { client.startConnection(instanceId) }
        assertEquals(connectionId, journal.saved?.connectionRequestId)
        assertEquals(false, journal.saved?.connectionAccepted)
        current = now + 22_000
        val connected = assertNotNull(client.resumeConnection(instanceId))
        assertEquals(connectionId, connected.connectionRequestId)
        assertEquals(2, broker.connections)
        assertEquals(1, broker.connectionPolls)
        assertNotNull(client.resumeConnection(instanceId))
        assertEquals(1, broker.connectionPolls)
    }
}
