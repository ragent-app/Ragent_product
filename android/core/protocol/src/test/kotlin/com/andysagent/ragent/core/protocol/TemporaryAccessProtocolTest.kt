package com.andysagent.ragent.core.protocol

import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TemporaryAccessProtocolTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/fixtures/temporary-access-signed.json")!!.readText()).jsonObject
    private val envelopeJson = fixture.getValue("envelope").jsonObject
    private val envelope = Json.decodeFromString<TemporaryPairingEnvelope>(envelopeJson.toString())
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
    private val completion = fixture.getValue("completion").jsonObject
    private val now = fixture.getValue("now").jsonPrimitive.content.toLong()
    private fun verify(raw: String = completion.toString(), input: TemporaryAccessProtocol.Claim = claim,
        time: Long = now): TemporaryAccessProtocol.Completion = TemporaryAccessProtocol.verifyCompletion(raw,
        envelope, input, envelope.invitation.instanceId, envelope.invitation.instanceKeyFingerprint, time)

    @Test fun `Node signed completion and access token bind original PC grant and phone`() {
        val result = verify()
        assertEquals(claim.requestId, result.grant.requestId)
        assertEquals(envelope.invitation.accessExpiresAt / 1000 * 1000, result.credential.expiresAt)
        assertEquals("DPoP", completion.getValue("payload").jsonObject.getValue("accessCredential").jsonObject
            .getValue("token_type").jsonPrimitive.content)
    }

    @Test fun `broker cannot replace signed grant deadline or access credential`() {
        val payload = completion.getValue("payload").jsonObject
        val result = payload.getValue("result").jsonObject
        val wrongDeadline = JsonObject(result + ("accessExpiresAt" to JsonPrimitive(now + 900_000)))
        assertFailsWith<IllegalArgumentException> {
            verify(JsonObject(completion +
                ("payload" to JsonObject(payload + ("result" to wrongDeadline)))).toString())
        }
        val cred = payload.getValue("accessCredential").jsonObject
        val wrongToken = JsonObject(cred + ("access_token" to JsonPrimitive(cred.getValue("access_token").jsonPrimitive.content + "x")))
        assertFailsWith<IllegalArgumentException> {
            verify(JsonObject(completion +
                ("payload" to JsonObject(payload + ("accessCredential" to wrongToken)))).toString())
        }
        assertFailsWith<IllegalArgumentException> {
            verify(input = claim.copy(devicePublicKey = envelope.publicKey))
        }
        assertFailsWith<IllegalArgumentException> {
            verify(time = result.getValue("accessExpiresAt").jsonPrimitive.content.toLong())
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryAccessProtocol.verifyCompletion(completion.toString(), envelope, claim,
                envelope.invitation.instanceId, "0".repeat(64), now)
        }
    }

    @Test fun `P256 Keystore DER becomes standards compatible ES256 DPoP`() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val publicKey = Base64.getEncoder().encodeToString(pair.public.encoded)
        val signDer: (String) -> String = { message ->
            val der = Signature.getInstance("SHA256withECDSA").apply {
                initSign(pair.private); update(message.toByteArray())
            }.sign()
            Base64.getUrlEncoder().withoutPadding().encodeToString(der)
        }
        val path = "/api/temporary/v1/instances/${envelope.invitation.instanceId}/sessions"
        val proof = TemporaryAccessProtocol.dpop("original-access-token", publicKey, "POST", path, now,
            "rtn_${"a".repeat(32)}", signDer)
        val parts = proof.split('.')
        assertEquals(3, parts.size)
        val header = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(parts[0]))).jsonObject
        val claims = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(parts[1]))).jsonObject
        assertEquals("ES256", header.getValue("alg").jsonPrimitive.content)
        assertEquals(TemporaryAccessProtocol.LOGICAL_ORIGIN + path, claims.getValue("htu").jsonPrimitive.content)
        assertEquals(TemporaryAccessProtocol.deviceJwkThumbprint(publicKey),
            Base64.getUrlEncoder().withoutPadding().encodeToString(java.security.MessageDigest.getInstance("SHA-256")
                .digest("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":${header.getValue("jwk").jsonObject.getValue("x")},\"y\":${header.getValue("jwk").jsonObject.getValue("y")}}".toByteArray())))
        val raw = Base64.getUrlDecoder().decode(parts[2])
        assertEquals(64, raw.size)
        fun derInteger(bytes: ByteArray): ByteArray {
            val unsigned = bytes.dropWhile { it == 0.toByte() }.toByteArray()
            return if (unsigned[0] < 0) byteArrayOf(0) + unsigned else unsigned
        }
        val r = derInteger(raw.copyOfRange(0, 32)); val s = derInteger(raw.copyOfRange(32, 64))
        val der = byteArrayOf(0x30, (4 + r.size + s.size).toByte(), 0x02, r.size.toByte()) + r +
            byteArrayOf(0x02, s.size.toByte()) + s
        assertTrue(Signature.getInstance("SHA256withECDSA").apply {
            initVerify(pair.public); update("${parts[0]}.${parts[1]}".toByteArray())
        }.verify(der))
        assertFailsWith<IllegalArgumentException> {
            TemporaryAccessProtocol.dpop("token", publicKey, "POST", "/api/owner", now, "rtn_${"a".repeat(32)}", signDer)
        }
    }

    @Test fun `result poll uses Node broker canonical payload and original claim ID`() {
        var signed = ""
        val proof = TemporaryAccessProtocol.brokerProof("result", envelope.invitation, claim.requestId,
            now, "rtn_${"a".repeat(32)}", JsonObject(emptyMap())) { signed = it; "signature" }
        assertEquals(fixture.getValue("resultProofMessage").jsonPrimitive.content, signed)
        assertEquals(claim.requestId, proof.getValue("requestId").jsonPrimitive.content)
        assertFailsWith<IllegalArgumentException> {
            TemporaryAccessProtocol.brokerProof("inbox", envelope.invitation, claim.requestId,
                now, "rtn_${"a".repeat(32)}", JsonObject(emptyMap())) { "signature" }
        }
    }
}
