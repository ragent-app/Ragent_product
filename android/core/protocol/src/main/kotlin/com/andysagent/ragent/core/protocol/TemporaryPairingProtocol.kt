package com.andysagent.ragent.core.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

@Serializable
data class TemporaryPairingInvitation(
    val version: Int,
    val invitationId: String,
    val instanceId: String,
    val instanceKeyFingerprint: String,
    val secretHash: String,
    val createdAt: Long,
    val claimExpiresAt: Long,
    val accessExpiresAt: Long,
    val capabilities: List<String>,
    val sessionScope: String,
)

@Serializable
data class TemporaryPairingEnvelope(
    val invitation: TemporaryPairingInvitation,
    val publicKey: String,
    val signature: String,
)

/** Wire protocol only. This does not enroll a computer or authorize an API/carrier. */
object TemporaryPairingProtocol {
    private val json = Json { ignoreUnknownKeys = false }
    private val capabilities = setOf("task.create", "task.submit", "task.read", "task.cancel", "file.upload", "file.download")
    private val hexHash = Regex("^[a-f0-9]{64}$")
    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
    private val ed25519Prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    /** Expected identity must come from the QR/pinned computer, not the broker response. */
    fun verifyForClaim(raw: String, expectedInstanceId: String, expectedFingerprint: String, nowMs: Long): TemporaryPairingInvitation {
        require(raw.length <= 16_384) { "Temporary invitation is too large" }
        val envelope = json.decodeFromString<TemporaryPairingEnvelope>(raw)
        val invitation = envelope.invitation
        val message = invitationMessage(invitation)
        require(invitation.instanceId == expectedInstanceId && invitation.instanceKeyFingerprint == expectedFingerprint) {
            "Temporary invitation target mismatch"
        }
        val der = publicKeyDer(envelope.publicKey)
        require(der.size == 44 && der.copyOfRange(0, 12).contentEquals(ed25519Prefix)) { "Expected Ed25519 instance key" }
        require(hash(der) == expectedFingerprint) { "Temporary invitation key mismatch" }
        require(Regex("^[A-Za-z0-9_-]{86}$").matches(envelope.signature)) { "Invalid invitation signature encoding" }
        val signature = Base64.getUrlDecoder().decode(envelope.signature)
        require(Base64.getUrlEncoder().withoutPadding().encodeToString(signature) == envelope.signature)
        val key = EdDSAPublicKey(EdDSAPublicKeySpec(der.copyOfRange(12, 44), EdDSANamedCurveTable.ED_25519_CURVE_SPEC))
        val engine = EdDSAEngine().apply { initVerify(key); update(message.toByteArray(Charsets.UTF_8)) }
        require(engine.verify(signature)) { "Temporary invitation signature mismatch" }
        require(nowMs >= invitation.createdAt && nowMs < invitation.claimExpiresAt) { "Temporary invitation is not claimable now" }
        return invitation.copy(capabilities = invitation.capabilities.sorted())
    }

    fun invitationMessage(i: TemporaryPairingInvitation): String {
        require(i.version == 1 && i.sessionScope == "created-sessions") { "Unsupported temporary invitation" }
        checkedId(i.invitationId, "rti"); checkedId(i.instanceId, "inst")
        require(hexHash.matches(i.instanceKeyFingerprint) && hexHash.matches(i.secretHash))
        require(i.createdAt in 0..MAX_SAFE_INTEGER && i.claimExpiresAt in 0..MAX_SAFE_INTEGER && i.accessExpiresAt in 0..MAX_SAFE_INTEGER)
        require(i.claimExpiresAt > i.createdAt && i.claimExpiresAt - i.createdAt <= 120_000)
        require(i.accessExpiresAt >= i.claimExpiresAt && i.accessExpiresAt - i.createdAt <= 600_000)
        require(i.capabilities.isNotEmpty() && i.capabilities.size <= capabilities.size
            && i.capabilities.toSet().size == i.capabilities.size && i.capabilities.all { it in capabilities })
        return JsonArray(listOf(JsonPrimitive("ragent-temporary-invitation-v1"), JsonPrimitive(i.invitationId),
            JsonPrimitive(i.instanceId), JsonPrimitive(i.instanceKeyFingerprint), JsonPrimitive(i.secretHash),
            JsonPrimitive(i.createdAt), JsonPrimitive(i.claimExpiresAt), JsonPrimitive(i.accessExpiresAt),
            JsonArray(i.capabilities.sorted().map(::JsonPrimitive)), JsonPrimitive(i.sessionScope))).toString()
    }

    fun invitationDigest(i: TemporaryPairingInvitation): String = hash(invitationMessage(i).toByteArray(Charsets.UTF_8))

    /** Sign the result with DeviceIdentityStore.sign; the one-time token travels only in the private claim body. */
    fun claimMessage(i: TemporaryPairingInvitation, requestId: String, devicePublicKey: String): String {
        checkedId(requestId, "rtr")
        return JsonArray(listOf(JsonPrimitive("ragent-temporary-claim-v1"), JsonPrimitive(i.instanceId),
            JsonPrimitive(i.invitationId), JsonPrimitive(invitationDigest(i)), JsonPrimitive(requestId),
            JsonPrimitive(deviceKeyFingerprint(devicePublicKey)))).toString()
    }

    fun deviceKeyFingerprint(publicKey: String): String {
        val der = publicKeyDer(publicKey)
        if (der.size == 44 && der.copyOfRange(0, 12).contentEquals(ed25519Prefix)) return hash(der)
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der)) as? ECPublicKey
            ?: throw IllegalArgumentException("Expected a P-256 device key")
        require(der.contentEquals(key.encoded)) { "Expected canonical SPKI" }
        // Validate the complete named curve, not merely its field size (other 256-bit curves exist).
        val parameters = java.security.AlgorithmParameters.getInstance("EC").apply {
            init(java.security.spec.ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        require(key.params.curve == parameters.curve && key.params.generator == parameters.generator
            && key.params.order == parameters.order && key.params.cofactor == parameters.cofactor) { "Expected a P-256 device key" }
        return hash(key.encoded)
    }

    private fun publicKeyDer(value: String): ByteArray {
        require(value.length <= 4096)
        val encoded = if (value.startsWith("-----BEGIN PUBLIC KEY-----")) {
            require(value.trimEnd().endsWith("-----END PUBLIC KEY-----"))
            value.removePrefix("-----BEGIN PUBLIC KEY-----").trimEnd().removeSuffix("-----END PUBLIC KEY-----")
                .filterNot(Char::isWhitespace)
        } else value
        require(Regex("^[A-Za-z0-9+/]+={0,2}$").matches(encoded))
        val der = Base64.getDecoder().decode(encoded)
        require(Base64.getEncoder().encodeToString(der) == encoded) { "Expected canonical base64" }
        return der
    }

    private fun checkedId(value: String, prefix: String) {
        require(Regex("^${prefix}_[A-Za-z0-9_-]{24,64}$").matches(value)) { "Invalid temporary pairing identity" }
    }

    private fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
