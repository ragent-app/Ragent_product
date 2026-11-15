package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.Serializable
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** Independent temporary-device wire contract. It never authorizes an account or Owner route. */
object TemporaryAccessProtocol {
    private val json = Json { ignoreUnknownKeys = false }
    private val ids = Regex("^(inst|rti|rtr|rtn|rtg|rdev)_[A-Za-z0-9_-]{24,64}$")
    private val url = Base64.getUrlEncoder().withoutPadding()
    private val edPrefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
    const val LOGICAL_ORIGIN = "https://temporary.ragent.invalid"

    @Serializable
    data class Claim(val instanceId: String, val invitationId: String, val invitationDigest: String,
        val requestId: String, val devicePublicKey: String, val token: String, val signature: String)

    data class Grant(val grantId: String, val deviceId: String, val requestId: String,
        val deviceKeyFingerprint: String, val grantedAt: Long, val accessExpiresAt: Long)

    data class Credential(val accessToken: String, val expiresAt: Long)

    data class Completion(val grant: Grant, val credential: Credential)

    /** Every result/connect poll gets a new nonce and signature; requestId stays the original claim ID. */
    fun brokerProof(action: String, invitation: TemporaryPairingInvitation, requestId: String,
        issuedAt: Long, nonce: String, payload: JsonObject, signDer: (String) -> String): JsonObject {
        require(action in setOf("result", "connect", "connection-result"))
        require(issuedAt in 0..9_007_199_254_740_991L)
        checkedId(requestId, "rtr"); checkedId(nonce, "rtn")
        val message = JsonArray(listOf(JsonPrimitive("ragent-temporary-broker-v1"), JsonPrimitive(action),
            JsonPrimitive(invitation.instanceId), JsonPrimitive(invitation.invitationId), JsonPrimitive(requestId),
            JsonPrimitive(issuedAt), JsonPrimitive(nonce), JsonPrimitive(hex(sha(canonical(payload).toByteArray()))))).toString()
        return JsonObject(mapOf("instanceId" to JsonPrimitive(invitation.instanceId),
            "invitationId" to JsonPrimitive(invitation.invitationId), "requestId" to JsonPrimitive(requestId),
            "issuedAt" to JsonPrimitive(issuedAt), "nonce" to JsonPrimitive(nonce), "payload" to payload,
            "signature" to JsonPrimitive(signDer(message))))
    }

    /** Verify the PC-signed saved completion and its device-bound access token before use. */
    fun verifyCompletion(raw: String, envelope: TemporaryPairingEnvelope, claim: Claim,
        expectedInstanceId: String, expectedFingerprint: String, nowMs: Long): Completion {
        require(raw.length <= 32_768)
        val c = json.parseToJsonElement(raw).jsonObject
        exact(c, "instanceId", "invitationId", "requestId", "issuedAt", "nonce", "payload", "signature")
        val i = envelope.invitation
        val signedInvitation = TemporaryPairingProtocol.invitationMessage(i)
        val instanceDer = Base64.getDecoder().decode(envelope.publicKey.removePrefix("-----BEGIN PUBLIC KEY-----")
            .trimEnd().removeSuffix("-----END PUBLIC KEY-----").filterNot(Char::isWhitespace))
        require(i.instanceId == expectedInstanceId && i.instanceKeyFingerprint == expectedFingerprint &&
            hex(sha(instanceDer)) == expectedFingerprint)
        verifyEd25519(envelope.publicKey, signedInvitation, envelope.signature)
        require(nowMs >= i.createdAt && nowMs < i.accessExpiresAt)
        require(c.string("instanceId") == i.instanceId && c.string("invitationId") == i.invitationId)
        require(claim.instanceId == i.instanceId && claim.invitationId == i.invitationId &&
            claim.invitationDigest == TemporaryPairingProtocol.invitationDigest(i))
        val payload = c.getValue("payload").jsonObject
        exact(payload, "result", "accessCredential")
        val r = payload.getValue("result").jsonObject
        exact(r, "grantId", "deviceId", "requestId", "deviceKeyFingerprint", "grantedAt", "accessExpiresAt")
        val grant = Grant(r.string("grantId"), r.string("deviceId"), r.string("requestId"),
            r.string("deviceKeyFingerprint"), r.long("grantedAt"), r.long("accessExpiresAt"))
        checkedId(grant.grantId, "rtg"); checkedId(grant.deviceId, "rdev")
        require(grant.requestId == claim.requestId && grant.deviceKeyFingerprint ==
            TemporaryPairingProtocol.deviceKeyFingerprint(claim.devicePublicKey))
        require(grant.accessExpiresAt == i.accessExpiresAt && grant.grantedAt in i.createdAt until i.claimExpiresAt)
        val issuedAt = c.long("issuedAt")
        require(issuedAt in grant.grantedAt..nowMs && issuedAt < i.accessExpiresAt)
        val brokerMessage = JsonArray(listOf(JsonPrimitive("ragent-temporary-broker-v1"), JsonPrimitive("complete"),
            JsonPrimitive(i.instanceId), JsonPrimitive(i.invitationId), JsonPrimitive(c.string("requestId")),
            JsonPrimitive(issuedAt), JsonPrimitive(c.string("nonce")),
            JsonPrimitive(hex(sha(canonical(payload).toByteArray()))))).toString()
        checkedId(c.string("requestId"), "rtr"); checkedId(c.string("nonce"), "rtn")
        verifyEd25519(envelope.publicKey, brokerMessage, c.string("signature"))
        return Completion(grant, verifyCredential(payload.getValue("accessCredential").jsonObject, envelope, claim, grant, nowMs))
    }

    private fun verifyCredential(raw: JsonObject, envelope: TemporaryPairingEnvelope, claim: Claim,
        grant: Grant, nowMs: Long): Credential {
        exact(raw, "token_type", "access_token", "expires_at")
        require(raw.string("token_type") == "DPoP")
        val token = raw.string("access_token")
        require(token.length <= 8192)
        val parts = token.split('.')
        require(parts.size == 3)
        val header = json.parseToJsonElement(String(decode(parts[0]), Charsets.UTF_8)).jsonObject
        exact(header, "typ", "alg", "kid")
        require(header.string("typ") == "ragent-temporary-access+jwt" && header.string("alg") == "EdDSA" &&
            header.string("kid") == envelope.invitation.instanceKeyFingerprint)
        val claims = json.parseToJsonElement(String(decode(parts[1]), Charsets.UTF_8)).jsonObject
        exact(claims, "iss", "aud", "sub", "jti", "invitationId", "requestId", "deviceKeyFingerprint",
            "scope", "sessionScope", "iat", "exp", "cnf")
        val i = envelope.invitation
        val expiry = i.accessExpiresAt / 1000 * 1000
        require(claims.string("iss") == i.instanceId && claims.string("aud") == "ragent-temporary-device-access" &&
            claims.string("sub") == grant.deviceId && claims.string("jti") == grant.grantId &&
            claims.string("invitationId") == i.invitationId && claims.string("requestId") == claim.requestId &&
            claims.string("deviceKeyFingerprint") == grant.deviceKeyFingerprint &&
            claims.string("scope") == i.capabilities.sorted().joinToString(" ") &&
            claims.string("sessionScope") == i.sessionScope && claims.long("iat") == grant.grantedAt / 1000 &&
            claims.long("exp") == i.accessExpiresAt / 1000 && raw.long("expires_at") == expiry && nowMs < expiry)
        val cnf = claims.getValue("cnf").jsonObject
        exact(cnf, "jkt")
        require(cnf.string("jkt") == deviceJwkThumbprint(claim.devicePublicKey))
        verifyEd25519(envelope.publicKey, "${parts[0]}.${parts[1]}", parts[2])
        return Credential(token, expiry)
    }

    /** RFC 9449 proof for the finite private P2P route table; signDer returns Keystore ECDSA DER. */
    fun dpop(accessToken: String, devicePublicKey: String, method: String, pathname: String,
        issuedAtMs: Long, jti: String, signDer: (String) -> String): String =
        dpopForOrigin(accessToken, devicePublicKey, method, pathname, issuedAtMs, jti, signDer,
            LOGICAL_ORIGIN, "/api/temporary/v1/instances/")

    fun controlDpop(accessToken: String, devicePublicKey: String, method: String, pathname: String,
        issuedAtMs: Long, jti: String, signDer: (String) -> String): String =
        dpopForOrigin(accessToken, devicePublicKey, method, pathname, issuedAtMs, jti, signDer,
            "https://temporary-control.ragent.invalid", "/api/temporary-control/v1/instances/")

    private fun dpopForOrigin(accessToken: String, devicePublicKey: String, method: String, pathname: String,
        issuedAtMs: Long, jti: String, signDer: (String) -> String, origin: String, prefix: String): String {
        require(method.matches(Regex("^[A-Z]{3,12}$")))
        require(pathname.startsWith(prefix) && !pathname.contains('?') &&
            !pathname.contains('#') && !pathname.contains(".."))
        require(jti.matches(Regex("^[A-Za-z0-9_-]{24,128}$")))
        val jwk = deviceJwk(devicePublicKey)
        val header = JsonObject(mapOf("typ" to JsonPrimitive("dpop+jwt"), "alg" to JsonPrimitive("ES256"), "jwk" to jwk))
        val claims = JsonObject(mapOf("jti" to JsonPrimitive(jti), "htm" to JsonPrimitive(method),
            "htu" to JsonPrimitive(origin + pathname), "iat" to JsonPrimitive(issuedAtMs / 1000),
            "ath" to JsonPrimitive(url.encodeToString(sha(accessToken.toByteArray())))))
        val input = "${url.encodeToString(header.toString().toByteArray())}.${url.encodeToString(claims.toString().toByteArray())}"
        return "$input.${url.encodeToString(derToP1363(decode(signDer(input))))}"
    }

    fun deviceJwkThumbprint(publicKey: String): String = url.encodeToString(sha(canonical(deviceJwk(publicKey)).toByteArray()))

    private fun deviceJwk(publicKey: String): JsonObject {
        val encoded = publicKey.removePrefix("-----BEGIN PUBLIC KEY-----").trimEnd()
            .removeSuffix("-----END PUBLIC KEY-----").filterNot(Char::isWhitespace)
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(encoded))) as ECPublicKey
        TemporaryPairingProtocol.deviceKeyFingerprint(publicKey)
        fun coordinate(value: BigInteger): String {
            val raw = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            require(raw.size <= 32)
            return url.encodeToString(ByteArray(32 - raw.size) + raw)
        }
        return JsonObject(mapOf("crv" to JsonPrimitive("P-256"), "kty" to JsonPrimitive("EC"),
            "x" to JsonPrimitive(coordinate(key.w.affineX)), "y" to JsonPrimitive(coordinate(key.w.affineY))))
    }

    private fun derToP1363(der: ByteArray): ByteArray {
        require(der.size in 8..73 && der[0] == 0x30.toByte() && (der[1].toInt() and 0xff) == der.size - 2)
        var offset = 2
        fun integer(): ByteArray {
            require(der[offset++] == 0x02.toByte())
            val length = der[offset++].toInt() and 0xff
            require(length in 1..33 && offset + length <= der.size)
            val bytes = der.copyOfRange(offset, offset + length)
            offset += length
            require(bytes[0] >= 0 && (length == 1 || bytes[0] != 0.toByte() || bytes[1] < 0))
            val unsigned = if (bytes[0] == 0.toByte()) bytes.copyOfRange(1, bytes.size) else bytes
            require(unsigned.size <= 32)
            return ByteArray(32 - unsigned.size) + unsigned
        }
        val result = integer() + integer()
        require(offset == der.size)
        return result
    }

    internal fun verifyEd25519(publicKey: String, message: String, signature: String) {
        val encoded = publicKey.removePrefix("-----BEGIN PUBLIC KEY-----").trimEnd()
            .removeSuffix("-----END PUBLIC KEY-----").filterNot(Char::isWhitespace)
        val der = Base64.getDecoder().decode(encoded)
        require(der.size == 44 && der.copyOfRange(0, 12).contentEquals(edPrefix))
        val key = EdDSAPublicKey(EdDSAPublicKeySpec(der.copyOfRange(12, 44), EdDSANamedCurveTable.ED_25519_CURVE_SPEC))
        val engine = EdDSAEngine().apply { initVerify(key); update(message.toByteArray()) }
        require(engine.verify(decode(signature)))
    }

    internal fun canonical(value: JsonElement): String = when (value) {
        is JsonObject -> value.keys.sorted().joinToString(",", "{", "}") { "${JsonPrimitive(it)}:${canonical(value.getValue(it))}" }
        is JsonArray -> value.joinToString(",", "[", "]") { canonical(it) }
        is JsonPrimitive -> value.toString()
        else -> error("Unsupported broker payload")
    }
    private fun exact(value: JsonObject, vararg keys: String) { require(value.keys == keys.toSet()) }
    private fun checkedId(value: String, prefix: String) { require(ids.matches(value) && value.startsWith("${prefix}_")) }
    private fun JsonObject.string(key: String): String = getValue(key).jsonPrimitive.content
    private fun JsonObject.long(key: String): Long = getValue(key).jsonPrimitive.long
    private fun decode(value: String): ByteArray {
        require(value.matches(Regex("^[A-Za-z0-9_-]+$")))
        return Base64.getUrlDecoder().decode(value).also { require(url.encodeToString(it) == value) }
    }
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
