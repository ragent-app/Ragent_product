package com.andysagent.ragent.core.protocol

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonArray
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class TemporaryControlProtocolTest {
    private val now = 1_800_000_000_000L
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val publicKey = pair.public.encoded
    private val publicKeyPem = "-----BEGIN PUBLIC KEY-----\n${Base64.getEncoder().encodeToString(publicKey).chunked(64).joinToString("\n")}\n-----END PUBLIC KEY-----\n"
    private val fingerprint = sha(publicKey)
    private val invitation = TemporaryControlInvitation(
        version = 1,
        invitationId = "rti_${"a".repeat(24)}",
        instanceId = "inst_${"b".repeat(24)}",
        instanceKeyFingerprint = fingerprint,
        secretHash = sha("rtt_${"c".repeat(24)}".toByteArray()),
        createdAt = now,
        claimExpiresAt = now + 120_000,
        accessDurationMs = TemporaryControlProtocol.ACCESS_DURATION_MS,
        capabilities = listOf(
            "project.read", "project.create", "project.update", "project.delete",
            "session.read", "session.create", "session.update", "session.delete", "message.submit", "run.read", "run.cancel",
            "approval.read", "approval.resolve", "approval.privileged.resolve", "file.upload", "file.download",
            "harness.read", "harness.install", "harness.upgrade", "harness.uninstall", "provider.read", "provider.create",
            "provider.update", "provider.delete", "provider.oauth", "provider.quota.refresh", "provider.rotation.update",
        ),
        sessionScope = "all-workbench",
    )
    private fun ticket(invitation: TemporaryControlInvitation = this.invitation): TemporaryControlTicket {
        val signature = Signature.getInstance("Ed25519").run {
            initSign(pair.private); update(TemporaryControlProtocol.invitationMessage(invitation).toByteArray());
            Base64.getUrlEncoder().withoutPadding().encodeToString(sign())
        }
        return TemporaryControlTicket(TemporaryControlProtocol.QR_KIND, 1,
            TemporaryControlEnvelope(invitation, publicKeyPem, signature), "rtt_${"c".repeat(24)}")
    }

    @Test fun `control QR verifies an owner signature and exact fixed authority`() {
        val raw = Json.encodeToString(TemporaryControlTicket.serializer(), ticket())
        val parsed = requireNotNull(TemporaryControlProtocol.parseIfControl(raw, now + 1))
        assertEquals("all-workbench", parsed.envelope.invitation.sessionScope)
        assertEquals(now + 120_000, parsed.envelope.invitation.claimExpiresAt)
        assertEquals(TemporaryControlProtocol.ACCESS_DURATION_MS, parsed.envelope.invitation.accessDurationMs)
        assertEquals(TemporaryControlProtocol.invitationMessage(invitation),
            TemporaryControlProtocol.invitationMessage(parsed.envelope.invitation))
    }

    @Test fun `legacy or unrelated JSON is not routed into the control parser`() {
        assertNull(TemporaryControlProtocol.parseIfControl("{\"version\":1}", now))
        assertNull(TemporaryControlProtocol.parseIfControl("not-json", now))
    }

    @Test fun `scope duration capabilities and signature changes are rejected`() {
        for (changed in listOf(
            invitation.copy(sessionScope = "created-sessions"),
            invitation.copy(accessDurationMs = 599_999),
            invitation.copy(capabilities = invitation.capabilities.drop(1)),
            invitation.copy(claimExpiresAt = now + 120_001),
        )) assertFailsWith<IllegalArgumentException> { TemporaryControlProtocol.invitationMessage(changed) }
        val raw = Json.encodeToString(TemporaryControlTicket.serializer(), ticket())
        assertFailsWith<IllegalArgumentException> { TemporaryControlProtocol.parseIfControl(raw, now + 120_000) }
    }

    @Test fun `completion requires the original desktop signature and device binding`() {
        val device = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        val deviceKey = Base64.getEncoder().encodeToString(device.public.encoded)
        val grantedAt = now + 10_000
        val grantId = "rtg_${"d".repeat(24)}"
        val deviceId = "rdev_${"e".repeat(24)}"
        fun encode(value: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(value.toByteArray())
        val header = JsonObject(mapOf("typ" to JsonPrimitive("ragent-temporary-control-access+jwt"),
            "alg" to JsonPrimitive("EdDSA"), "kid" to JsonPrimitive(fingerprint)))
        val claims = JsonObject(mapOf("iss" to JsonPrimitive(invitation.instanceId),
            "aud" to JsonPrimitive("ragent-temporary-control-access"), "sub" to JsonPrimitive(deviceId),
            "jti" to JsonPrimitive(grantId), "invitationId" to JsonPrimitive(invitation.invitationId),
            "deviceKeyFingerprint" to JsonPrimitive(TemporaryPairingProtocol.deviceKeyFingerprint(deviceKey)),
            "scope" to JsonPrimitive(invitation.capabilities.joinToString(" ")), "sessionScope" to JsonPrimitive("all-workbench"),
            "iat" to JsonPrimitive(grantedAt / 1000), "exp" to JsonPrimitive((grantedAt + 600_000) / 1000),
            "cnf" to JsonObject(mapOf("jkt" to JsonPrimitive(TemporaryAccessProtocol.deviceJwkThumbprint(deviceKey))))))
        val input = "${encode(header.toString())}.${encode(claims.toString())}"
        val signed = Signature.getInstance("Ed25519").run {
            initSign(pair.private); update(input.toByteArray()); Base64.getUrlEncoder().withoutPadding().encodeToString(sign())
        }
        val completion = JsonObject(mapOf(
            "grant" to JsonObject(mapOf("grantId" to JsonPrimitive(grantId), "deviceId" to JsonPrimitive(deviceId),
                "grantedAt" to JsonPrimitive(grantedAt))),
            "accessCredential" to JsonObject(mapOf("token_type" to JsonPrimitive("DPoP"),
                "access_token" to JsonPrimitive("$input.$signed"), "expires_at" to JsonPrimitive(grantedAt + 600_000))),
        ))
        val verified = TemporaryControlProtocol.verifyCompletion(completion.toString(), ticket(), deviceKey, grantedAt)
        assertEquals(grantId, verified.grantId)
        assertEquals(grantedAt + 600_000, verified.expiresAt)
        val other = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
        assertFailsWith<IllegalArgumentException> {
            TemporaryControlProtocol.verifyCompletion(completion.toString(), ticket(), Base64.getEncoder().encodeToString(other.public.encoded), grantedAt)
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryControlProtocol.verifyCompletion(completion.toString(), ticket(), deviceKey, grantedAt + 600_000)
        }
    }

    @Test fun `carrier delivery is signed by original desktop and bound to grant and request`() {
        val grantedAt = now + 10_000
        val grant = TemporaryControlProtocol.VerifiedGrant("rtg_${"d".repeat(24)}", "rdev_${"e".repeat(24)}",
            "token", grantedAt + 600_000, grantedAt)
        val requestId = "rtr_${"f".repeat(24)}"; val nonce = "rtn_${"g".repeat(24)}"
        val secret = "a".repeat(64)
        val room = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(secret.toByteArray(), "HmacSHA256")) }
            .doFinal("ragent-p2p-room-v1".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) }.take(40)
        val connection = JsonObject(mapOf("version" to JsonPrimitive(1), "instanceId" to JsonPrimitive(invitation.instanceId),
            "invitationId" to JsonPrimitive(invitation.invitationId), "grantId" to JsonPrimitive(grant.grantId),
            "deviceId" to JsonPrimitive(grant.deviceId), "connectionId" to JsonPrimitive("connection_123456"),
            "connectionRequestId" to JsonPrimitive(requestId), "issuedAt" to JsonPrimitive(grantedAt),
            "expiresAt" to JsonPrimitive(grant.expiresAt), "signalingEndpoint" to JsonPrimitive("https://signal.example/"),
            "roomId" to JsonPrimitive(room), "secret" to JsonPrimitive(secret), "iceServers" to JsonArray(listOf(
                JsonObject(mapOf("urls" to JsonPrimitive("turn:turn.example:3478"), "username" to JsonPrimitive("u"),
                    "password" to JsonPrimitive("p")))))))
        val payload = JsonObject(mapOf("connectionRequestId" to JsonPrimitive(requestId), "connection" to connection))
        val message = TemporaryControlConnectionProtocol.brokerMessage("connection-publish", invitation.instanceId,
            invitation.invitationId, requestId, grantedAt, nonce, payload)
        val sig = Signature.getInstance("Ed25519").run { initSign(pair.private); update(message.toByteArray());
            Base64.getUrlEncoder().withoutPadding().encodeToString(sign()) }
        val delivery = JsonObject(mapOf("instanceId" to JsonPrimitive(invitation.instanceId),
            "invitationId" to JsonPrimitive(invitation.invitationId), "requestId" to JsonPrimitive(requestId),
            "issuedAt" to JsonPrimitive(grantedAt), "nonce" to JsonPrimitive(nonce), "payload" to payload, "signature" to JsonPrimitive(sig)))
        val result = TemporaryControlConnectionProtocol.verify(delivery.toString(), ticket(), grant, requestId, grantedAt)
        assertEquals(room, result.roomId)
        assertFailsWith<IllegalArgumentException> {
            TemporaryControlConnectionProtocol.verify(delivery.toString(), ticket(), grant.copy(deviceId = "rdev_${"x".repeat(24)}"), requestId, grantedAt)
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryControlConnectionProtocol.verify(delivery.toString().replace("turn.example", "evil.example"), ticket(), grant, requestId, grantedAt)
        }
        assertFailsWith<IllegalArgumentException> {
            TemporaryControlConnectionProtocol.verify(delivery.toString(), ticket(), grant, requestId, grant.expiresAt)
        }
    }

    private fun sha(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
