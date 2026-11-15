package com.andysagent.ragent.core.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.security.MessageDigest
import java.util.Base64

/**
 * The phone-side parser for the owner-confirmed, ten-minute control QR.
 * This deliberately has no shared serializable model with temporary sharing:
 * a v1 share QR cannot be mistaken for a full-workbench authority.
 */
@Serializable
data class TemporaryControlInvitation(
    val version: Int,
    val invitationId: String,
    val instanceId: String,
    val instanceKeyFingerprint: String,
    val secretHash: String,
    val createdAt: Long,
    val claimExpiresAt: Long,
    val accessDurationMs: Long,
    val capabilities: List<String>,
    val sessionScope: String,
)

@Serializable
data class TemporaryControlEnvelope(
    val invitation: TemporaryControlInvitation,
    val publicKey: String,
    val signature: String,
)

@Serializable
data class TemporaryControlTicket(
    val kind: String,
    val version: Int,
    val envelope: TemporaryControlEnvelope,
    val token: String,
)

object TemporaryControlProtocol {
    const val QR_KIND = "ragent-temporary-control-v1"
    const val ACCESS_DURATION_MS = 10L * 60L * 1000L
    private const val CLAIM_MAX_MS = 2L * 60L * 1000L
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val json = Json { ignoreUnknownKeys = false }
    private val ids = Regex("^(inst|rti|rtr|rtn|rtg|rdev)_[A-Za-z0-9_-]{24,64}$")
    private val hash = Regex("^[a-f0-9]{64}$")
    private val signature = Regex("^[A-Za-z0-9_-]{80,128}$")
    private val token = Regex("^rtt_[A-Za-z0-9_-]{24,64}$")
    private val keyPrefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
    private val capabilities = listOf(
        "project.read", "project.create", "project.update", "project.delete",
        "session.read", "session.create", "session.update", "session.delete",
        "message.submit", "run.read", "run.cancel", "approval.read", "approval.resolve", "approval.privileged.resolve",
        "file.upload", "file.download", "harness.read", "harness.install", "harness.upgrade", "harness.uninstall",
        "provider.read", "provider.create", "provider.update", "provider.delete", "provider.oauth",
        "provider.quota.refresh", "provider.rotation.update",
    )

    /** Returns null for every non-control QR, letting the caller route legacy and account QR types normally. */
    fun parseIfControl(raw: String, nowMs: Long): TemporaryControlTicket? {
        if (raw.length !in 2..20_000 || !raw.trimStart().startsWith("{")) return null
        val kind = runCatching { json.parseToJsonElement(raw).jsonObject["kind"]?.jsonPrimitive?.content }.getOrNull()
        if (kind != QR_KIND) return null
        val ticket = json.decodeFromString<TemporaryControlTicket>(raw)
        require(ticket.version == 1 && token.matches(ticket.token))
        val invitation = verifyEnvelope(ticket.envelope, nowMs)
        require(sha(ticket.token.toByteArray()) == invitation.secretHash) { "Temporary control QR secret mismatch" }
        return ticket
    }

    fun verifyEnvelope(envelope: TemporaryControlEnvelope, nowMs: Long): TemporaryControlInvitation {
        val invitation = envelope.invitation
        require(invitation.version == 1 && invitation.sessionScope == "all-workbench") { "Unsupported temporary control invitation" }
        id(invitation.invitationId, "rti"); id(invitation.instanceId, "inst")
        require(hash.matches(invitation.instanceKeyFingerprint) && hash.matches(invitation.secretHash))
        require(invitation.createdAt in 0..MAX_SAFE_INTEGER && invitation.claimExpiresAt in 0..MAX_SAFE_INTEGER && invitation.claimExpiresAt > invitation.createdAt
            && invitation.claimExpiresAt - invitation.createdAt <= CLAIM_MAX_MS)
        require(invitation.accessDurationMs == ACCESS_DURATION_MS)
        require(invitation.capabilities == capabilities)
        require(nowMs in invitation.createdAt until invitation.claimExpiresAt) { "Temporary control QR has expired" }
        val der = publicKeyDer(envelope.publicKey)
        require(der.size == 44 && der.copyOfRange(0, 12).contentEquals(keyPrefix)) { "Expected Ed25519 desktop key" }
        require(sha(der) == invitation.instanceKeyFingerprint) { "Temporary control desktop key mismatch" }
        require(signature.matches(envelope.signature))
        val bytes = Base64.getUrlDecoder().decode(envelope.signature)
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes) == envelope.signature)
        val key = EdDSAPublicKey(EdDSAPublicKeySpec(der.copyOfRange(12, 44), EdDSANamedCurveTable.ED_25519_CURVE_SPEC))
        val engine = EdDSAEngine().apply { initVerify(key); update(invitationMessage(invitation).toByteArray(Charsets.UTF_8)) }
        require(engine.verify(bytes)) { "Temporary control invitation signature mismatch" }
        return invitation
    }

    fun invitationMessage(invitation: TemporaryControlInvitation): String {
        require(invitation.version == 1 && invitation.sessionScope == "all-workbench")
        id(invitation.invitationId, "rti"); id(invitation.instanceId, "inst")
        require(hash.matches(invitation.instanceKeyFingerprint) && hash.matches(invitation.secretHash))
        require(invitation.createdAt in 0..MAX_SAFE_INTEGER && invitation.claimExpiresAt in 0..MAX_SAFE_INTEGER &&
            invitation.claimExpiresAt > invitation.createdAt && invitation.claimExpiresAt - invitation.createdAt <= CLAIM_MAX_MS)
        require(invitation.accessDurationMs == ACCESS_DURATION_MS && invitation.capabilities == capabilities)
        return JsonArray(listOf(JsonPrimitive("ragent-temporary-control-invitation-v1"), JsonPrimitive(invitation.invitationId),
            JsonPrimitive(invitation.instanceId), JsonPrimitive(invitation.instanceKeyFingerprint), JsonPrimitive(invitation.secretHash),
            JsonPrimitive(invitation.createdAt), JsonPrimitive(invitation.claimExpiresAt), JsonPrimitive(invitation.accessDurationMs),
            JsonArray(capabilities.map(::JsonPrimitive)), JsonPrimitive(invitation.sessionScope))).toString()
    }

    fun invitationDigest(invitation: TemporaryControlInvitation): String = sha(invitationMessage(invitation).toByteArray())

    fun claimMessage(invitation: TemporaryControlInvitation, requestId: String, deviceKeyFingerprint: String): String {
        id(requestId, "rtr"); require(hash.matches(deviceKeyFingerprint))
        return JsonArray(listOf(JsonPrimitive("ragent-temporary-control-claim-v1"), JsonPrimitive(invitation.instanceId),
            JsonPrimitive(invitation.invitationId), JsonPrimitive(invitationDigest(invitation)), JsonPrimitive(requestId),
            JsonPrimitive(deviceKeyFingerprint))).toString()
    }

    data class VerifiedGrant(val grantId: String, val deviceId: String, val accessToken: String, val expiresAt: Long, val grantedAt: Long)

    /** The broker is a rendezvous only. Verify the desktop-signed token and its exact device binding. */
    fun verifyCompletion(raw: String, ticket: TemporaryControlTicket, devicePublicKey: String, nowMs: Long): VerifiedGrant {
        require(raw.length <= 16_384)
        val invitation = verifyEnvelope(ticket.envelope, ticket.envelope.invitation.createdAt)
        require(sha(ticket.token.toByteArray()) == invitation.secretHash)
        val completion = json.parseToJsonElement(raw).jsonObject
        require(completion.keys == setOf("grant", "accessCredential"))
        val grant = completion.getValue("grant").jsonObject
        require(grant.keys == setOf("grantId", "deviceId", "grantedAt"))
        val grantId = grant.getValue("grantId").jsonPrimitive.content
        val deviceId = grant.getValue("deviceId").jsonPrimitive.content
        val grantedAt = grant.getValue("grantedAt").jsonPrimitive.long
        id(grantId, "rtg"); id(deviceId, "rdev")
        require(grantedAt in invitation.createdAt until invitation.claimExpiresAt && grantedAt <= nowMs)
        val expiry = (grantedAt + ACCESS_DURATION_MS) / 1000 * 1000
        require(nowMs < expiry)
        val credential = completion.getValue("accessCredential").jsonObject
        require(credential.keys == setOf("token_type", "access_token", "expires_at"))
        require(credential.getValue("token_type").jsonPrimitive.content == "DPoP" &&
            credential.getValue("expires_at").jsonPrimitive.long == expiry)
        val token = credential.getValue("access_token").jsonPrimitive.content
        require(token.length <= 8192)
        val parts = token.split('.')
        require(parts.size == 3)
        fun decode(value: String): ByteArray {
            require(value.matches(Regex("^[A-Za-z0-9_-]+$")))
            return Base64.getUrlDecoder().decode(value).also {
                require(Base64.getUrlEncoder().withoutPadding().encodeToString(it) == value)
            }
        }
        val header = json.parseToJsonElement(String(decode(parts[0]), Charsets.UTF_8)).jsonObject
        require(header.keys == setOf("typ", "alg", "kid") &&
            header.getValue("typ").jsonPrimitive.content == "ragent-temporary-control-access+jwt" &&
            header.getValue("alg").jsonPrimitive.content == "EdDSA" &&
            header.getValue("kid").jsonPrimitive.content == invitation.instanceKeyFingerprint)
        val claims = json.parseToJsonElement(String(decode(parts[1]), Charsets.UTF_8)).jsonObject
        require(claims.keys == setOf("iss", "aud", "sub", "jti", "invitationId", "deviceKeyFingerprint", "scope", "sessionScope", "iat", "exp", "cnf"))
        require(claims.getValue("iss").jsonPrimitive.content == invitation.instanceId &&
            claims.getValue("aud").jsonPrimitive.content == "ragent-temporary-control-access" &&
            claims.getValue("sub").jsonPrimitive.content == deviceId && claims.getValue("jti").jsonPrimitive.content == grantId &&
            claims.getValue("invitationId").jsonPrimitive.content == invitation.invitationId &&
            claims.getValue("deviceKeyFingerprint").jsonPrimitive.content == TemporaryPairingProtocol.deviceKeyFingerprint(devicePublicKey) &&
            claims.getValue("scope").jsonPrimitive.content == capabilities.joinToString(" ") &&
            claims.getValue("sessionScope").jsonPrimitive.content == invitation.sessionScope &&
            claims.getValue("iat").jsonPrimitive.long == grantedAt / 1000 && claims.getValue("exp").jsonPrimitive.long == expiry / 1000)
        val cnf = claims.getValue("cnf").jsonObject
        require(cnf.keys == setOf("jkt") && cnf.getValue("jkt").jsonPrimitive.content == TemporaryAccessProtocol.deviceJwkThumbprint(devicePublicKey))
        TemporaryAccessProtocol.verifyEd25519(ticket.envelope.publicKey, "${parts[0]}.${parts[1]}", parts[2])
        return VerifiedGrant(grantId, deviceId, token, expiry, grantedAt)
    }

    private fun publicKeyDer(value: String): ByteArray {
        require(value.length <= 4096)
        val encoded = value.removePrefix("-----BEGIN PUBLIC KEY-----").trimEnd()
            .removeSuffix("-----END PUBLIC KEY-----").filterNot(Char::isWhitespace)
        require(Regex("^[A-Za-z0-9+/]+={0,2}$").matches(encoded))
        return Base64.getDecoder().decode(encoded).also { require(Base64.getEncoder().encodeToString(it) == encoded) }
    }
    private fun id(value: String, prefix: String) { require(ids.matches(value) && value.startsWith("${prefix}_")) }
    private fun sha(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
