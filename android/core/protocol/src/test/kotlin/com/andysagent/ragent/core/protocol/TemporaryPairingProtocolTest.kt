package com.andysagent.ragent.core.protocol

import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class TemporaryPairingProtocolTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/fixtures/temporary-pairing-signed.json")!!.readText()).jsonObject
    private val envelope = fixture.getValue("envelope").jsonObject
    private val invitation = envelope.getValue("invitation").jsonObject
    private val instanceId = invitation.getValue("instanceId").jsonPrimitive.content
    private val fingerprint = invitation.getValue("instanceKeyFingerprint").jsonPrimitive.content
    private val now = 1_800_000_000_000L
    private fun verify(raw: JsonObject = envelope, time: Long = now) = TemporaryPairingProtocol.verifyForClaim(raw.toString(), instanceId, fingerprint, time)

    @Test fun `Node signed invitation validates using Android API26 compatible EdDSA`() {
        val i = verify()
        assertEquals(now + 600_000, i.accessExpiresAt)
        assertEquals(listOf("file.download", "task.read"), i.capabilities)
        assertEquals(fixture.getValue("invitationMessage").jsonPrimitive.content, TemporaryPairingProtocol.invitationMessage(i))
    }

    @Test fun `phone signing bytes and fingerprint match Node shared fixture`() {
        val claim = fixture.getValue("claim").jsonObject
        val key = claim.getValue("devicePublicKey").jsonPrimitive.content
        val message = TemporaryPairingProtocol.claimMessage(verify(), claim.getValue("requestId").jsonPrimitive.content, key)
        assertEquals(fixture.getValue("claimMessage").jsonPrimitive.content, message)
        val pem = "-----BEGIN PUBLIC KEY-----\n${key.chunked(64).joinToString("\n")}\n-----END PUBLIC KEY-----"
        assertEquals(message, TemporaryPairingProtocol.claimMessage(verify(), claim.getValue("requestId").jsonPrimitive.content, pem))
        val verifier = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(key))))
            update(message.toByteArray(Charsets.UTF_8))
        }
        assertTrue(verifier.verify(Base64.getUrlDecoder().decode(claim.getValue("signature").jsonPrimitive.content)))
    }

    @Test fun `a substituted expected identity or key is rejected`() {
        assertFailsWith<IllegalArgumentException> { TemporaryPairingProtocol.verifyForClaim(envelope.toString(), "inst_${"x".repeat(32)}", fingerprint, now) }
        assertFailsWith<IllegalArgumentException> { TemporaryPairingProtocol.verifyForClaim(envelope.toString(), instanceId, "0".repeat(64), now) }
        val device = fixture.getValue("claim").jsonObject.getValue("devicePublicKey")
        assertFailsWith<IllegalArgumentException> { verify(JsonObject(envelope + ("publicKey" to device))) }
    }

    @Test fun `changed signed deadline and scope cannot be accepted`() {
        for (patch in listOf("accessExpiresAt" to JsonPrimitive(now + 599_999), "sessionScope" to JsonPrimitive("all-sessions"),
            "version" to JsonPrimitive(3), "createdAt" to JsonPrimitive(now + 1))) {
            assertFailsWith<IllegalArgumentException> { verify(JsonObject(envelope + ("invitation" to JsonObject(invitation + patch)))) }
        }
    }

    @Test fun `unknown fields cannot silently expand a version one invitation`() {
        for (patch in listOf("accountId" to JsonPrimitive("owner"), "endpoint" to JsonPrimitive("https://example.com"))) {
            assertFailsWith<IllegalArgumentException> { verify(JsonObject(envelope + ("invitation" to JsonObject(invitation + patch)))) }
        }
    }

    @Test fun `expired and not yet valid invitations cannot start a new claim`() {
        verify(time = now + 119_999)
        assertFailsWith<IllegalArgumentException> { verify(time = now + 120_000) }
        assertFailsWith<IllegalArgumentException> { verify(time = now - 1) }
    }

    @Test fun `canonical invitation rejects duplicate capabilities and invalid time ranges`() {
        val i = verify()
        for (changed in listOf(i.copy(capabilities = listOf("task.read", "task.read")), i.copy(capabilities = listOf("owner")),
            i.copy(capabilities = emptyList()), i.copy(accessExpiresAt = now + 600_001),
            i.copy(claimExpiresAt = now), i.copy(createdAt = -1), i.copy(createdAt = Long.MAX_VALUE),
            i.copy(claimExpiresAt = now + 120_001), i.copy(accessExpiresAt = now + 1))) {
            assertFailsWith<IllegalArgumentException> { TemporaryPairingProtocol.invitationMessage(changed) }
        }
    }

    @Test fun `proof identity cannot contain delimiters or use an account claim request`() {
        val i = verify(); val key = fixture.getValue("claim").jsonObject.getValue("devicePublicKey").jsonPrimitive.content
        for (requestId in listOf("rtr_${"a".repeat(32)}\nowner", "rpi_${"a".repeat(32)}", "rtr_short")) {
            assertFailsWith<IllegalArgumentException> { TemporaryPairingProtocol.claimMessage(i, requestId, key) }
        }
    }

    @Test fun `device fingerprint requires supported and canonical key material`() {
        val key = fixture.getValue("claim").jsonObject.getValue("devicePublicKey").jsonPrimitive.content
        val unsupported = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp384r1")) }.generateKeyPair()
        for (encoded in listOf(key + "junk", key + "\n", "invalid", Base64.getEncoder().encodeToString(unsupported.public.encoded))) {
            assertFailsWith<IllegalArgumentException> { TemporaryPairingProtocol.deviceKeyFingerprint(encoded) }
        }
    }

    @Test fun `signature must be unpadded canonical base64url`() {
        val signature = envelope.getValue("signature").jsonPrimitive.content
        assertFailsWith<IllegalArgumentException> { verify(JsonObject(envelope + ("signature" to JsonPrimitive(signature + "=")))) }
        assertFailsWith<IllegalArgumentException> { verify(JsonObject(envelope + ("signature" to JsonPrimitive("A".repeat(86))))) }
    }
}
