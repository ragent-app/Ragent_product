package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TemporaryConnectionProtocolTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/fixtures/temporary-access-signed.json")!!.readText()).jsonObject
    private val envelope = Json.decodeFromString<TemporaryPairingEnvelope>(fixture.getValue("envelope").toString())
    private val claimJson = fixture.getValue("claim").jsonObject
    private val claim = TemporaryAccessProtocol.Claim(
        claimJson.getValue("instanceId").jsonPrimitive.content,
        claimJson.getValue("invitationId").jsonPrimitive.content,
        claimJson.getValue("invitationDigest").jsonPrimitive.content,
        claimJson.getValue("requestId").jsonPrimitive.content,
        claimJson.getValue("devicePublicKey").jsonPrimitive.content,
        claimJson.getValue("token").jsonPrimitive.content,
        claimJson.getValue("signature").jsonPrimitive.content,
    )
    private val now = fixture.getValue("now").jsonPrimitive.content.toLong()
    private val completion = TemporaryAccessProtocol.verifyCompletion(fixture.getValue("completion").toString(),
        envelope, claim, envelope.invitation.instanceId, envelope.invitation.instanceKeyFingerprint, now)
    private val requestId = fixture.getValue("connectionRequestId").jsonPrimitive.content
    private val delivery = fixture.getValue("delivery").jsonObject

    @Test fun `Node signed TURN first delivery binds original grant and room`() {
        val result = TemporaryConnectionProtocol.verifyDelivery(delivery.toString(), envelope, claim,
            completion, requestId, now + 22_000)
        assertEquals(envelope.invitation.instanceId, result.instanceId)
        assertEquals(completion.grant.deviceId, result.deviceId)
        assertTrue(result.businessAccessReady)
        assertEquals(40, result.roomId.length)
        assertEquals("turn:turn.example.test:3478?transport=udp", result.iceServers.single().urls)
    }

    @Test fun `broker cannot alter signed business readiness or P2P room`() {
        val payload = delivery.getValue("payload").jsonObject
        val room = payload.getValue("p2p").jsonObject
        for (changed in listOf(
            JsonObject(payload + ("businessAccessReady" to JsonPrimitive(false))),
            JsonObject(payload + ("p2p" to JsonObject(room + ("secret" to JsonPrimitive("0".repeat(64)))))),
        )) {
            assertFailsWith<IllegalArgumentException> {
                TemporaryConnectionProtocol.verifyDelivery(JsonObject(delivery + ("payload" to changed)).toString(),
                    envelope, claim, completion, requestId, now + 22_000)
            }
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryConnectionProtocol.verifyDelivery(delivery.toString(), envelope, claim,
                completion, "rtr_${"x".repeat(32)}", now + 22_000)
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryConnectionProtocol.verifyDelivery(delivery.toString(), envelope, claim,
                completion, requestId, now + 300_000)
        }
    }

    @Test fun `a genuinely signed unavailable delivery stays unavailable`() {
        val result = TemporaryConnectionProtocol.verifyDelivery(fixture.getValue("unavailableDelivery").toString(),
            envelope, claim, completion, requestId, now + 22_000)
        assertEquals(false, result.businessAccessReady)
    }
}
