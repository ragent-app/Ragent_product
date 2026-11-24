package com.andysagent.ragent.core.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.serializer
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

data class VerifiedConnectionBootstrap(
    val contract: ConnectionBootstrapContractDto,
    val publicKey: ConnectionBootstrapPublicKeyDto,
)

class ConnectionBootstrapVerificationException(message: String) : IllegalArgumentException(message)

/**
 * Verifies the exact signed contract emitted by lib/connection-bootstrap-contract.mjs.
 * The verifier accepts the raw JSON response so Kotlin serialization cannot change null,
 * number, or object-key representation before the signature digest is calculated.
 */
object ConnectionBootstrapVerifier {
    private const val DOMAIN = "ragent-connection-bootstrap-v2"
    private const val CONTRACT_VERSION = 2
    private val json = RagentProtocol.json

    /** A standby plan must be signed by the already paired instance and target the same device. */
    fun verifyHandoff(rawContract: String, pinnedKey: ConnectionBootstrapPublicKeyDto,
        instanceId: String, deviceId: String, previousConnectionId: String,
        nowMs: Long = System.currentTimeMillis()): VerifiedConnectionBootstrap {
        val verified = verify(rawContract, pinnedKey, nowMs)
        val contract = verified.contract
        val nextId = contract.turn?.connectionId.orEmpty()
        val candidateExpiry = contract.candidates.firstOrNull { it.id == contract.initialCarrier?.candidateId }?.expiresAt
        val carrierBoundsValid = listOf(contract.turn?.expiresAt, candidateExpiry).all { expiry ->
            runCatching { Instant.parse(expiry).toEpochMilli() > nowMs }.getOrDefault(false)
        }
        if (instanceId.isBlank() || deviceId.isBlank() || previousConnectionId.isBlank()
            || contract.instanceId != instanceId || contract.deviceId != deviceId
            || nextId.isBlank() || nextId == previousConnectionId || !carrierBoundsValid
            || contract.turnAuthorization?.connectionId?.let { it != nextId } == true
            || contract.turn?.authorization?.connectionId?.let { it != nextId } == true) {
            throw ConnectionBootstrapVerificationException("Handoff plan identity does not match the active carrier")
        }
        return verified
    }

    fun verify(
        rawContract: String,
        publicKey: ConnectionBootstrapPublicKeyDto,
        nowMs: Long = System.currentTimeMillis(),
    ): VerifiedConnectionBootstrap {
        if (publicKey.algorithm != "ed25519") {
            throw ConnectionBootstrapVerificationException("Unsupported bootstrap key algorithm")
        }
        val raw = runCatching { json.parseToJsonElement(rawContract).jsonObject }
            .getOrElse { throw ConnectionBootstrapVerificationException("Bootstrap contract is not valid JSON") }
        raw["allowDirectIce"]?.let { element ->
            val primitive = element as? JsonPrimitive
            if (primitive == null || primitive.isString || primitive.booleanOrNull == null) {
                throw ConnectionBootstrapVerificationException("Bootstrap allowDirectIce is invalid")
            }
        }
        val contract = runCatching {
            json.decodeFromJsonElement(serializer<ConnectionBootstrapContractDto>(), raw)
        }.getOrElse {
            throw ConnectionBootstrapVerificationException("Bootstrap contract shape is invalid")
        }
        if (contract.contractVersion != CONTRACT_VERSION) {
            throw ConnectionBootstrapVerificationException("Unsupported bootstrap contract version")
        }
        if (contract.instanceId.isBlank() || contract.deviceId.isBlank()) {
            throw ConnectionBootstrapVerificationException("Bootstrap contract identity is missing")
        }
        if (contract.enrollmentKind !in setOf("account-claim", "account-join")) {
            throw ConnectionBootstrapVerificationException("Bootstrap enrollment kind is invalid")
        }
        if (contract.connectionMode != "turn-first") {
            throw ConnectionBootstrapVerificationException("Bootstrap connection mode is invalid")
        }
        if (contract.candidates.isEmpty()) {
            throw ConnectionBootstrapVerificationException("Bootstrap candidates are empty")
        }
        if (contract.candidates.any { it.kind !in setOf("turn", "webrtc") }) {
            throw ConnectionBootstrapVerificationException("Bootstrap candidate kind is invalid")
        }
        val expiresAt = runCatching { Instant.parse(contract.expiresAt).toEpochMilli() }
            .getOrElse { throw ConnectionBootstrapVerificationException("Bootstrap expiry is invalid") }
        if (expiresAt <= nowMs) {
            throw ConnectionBootstrapVerificationException("Bootstrap contract is expired")
        }
        val turnCandidates = contract.candidates.filter { it.kind == "turn" }
        if (turnCandidates.size != 1 || contract.initialCarrier?.kind != "turn"
            || contract.initialCarrier.candidateId != turnCandidates.single().id
            || contract.fallback != null
        ) {
            throw ConnectionBootstrapVerificationException("TURN-first contract has no initial TURN carrier")
        }
        if (contract.signature.algorithm != "ed25519" ||
            contract.signature.keyId.isBlank() ||
            contract.signature.signedAt.isBlank() ||
            contract.signature.value.isBlank()
        ) {
            throw ConnectionBootstrapVerificationException("Bootstrap signature is incomplete")
        }
        if (contract.signature.keyId != publicKey.keyId) {
            throw ConnectionBootstrapVerificationException("Bootstrap signing key does not match public key metadata")
        }

        val signingPayload = buildSigningPayload(raw)
        val signature = runCatching { Base64.getUrlDecoder().decode(contract.signature.value) }
            .getOrElse { throw ConnectionBootstrapVerificationException("Bootstrap signature encoding is invalid") }
        val verified = runCatching {
            val key = EdDSAPublicKey(
                EdDSAPublicKeySpec(
                    extractRawEd25519Key(publicKey.publicKeyPem),
                    EdDSANamedCurveTable.ED_25519_CURVE_SPEC,
                ),
            )
            EdDSAEngine().apply {
                initVerify(key)
                update(signingPayload.toByteArray(Charsets.UTF_8))
            }.verify(signature)
        }.getOrElse { false }
        if (!verified) {
            throw ConnectionBootstrapVerificationException("Bootstrap signature mismatch")
        }
        return VerifiedConnectionBootstrap(contract, publicKey)
    }

    /** Visible to JVM contract tests and kept identical to the Node canonical JSON rule. */
    fun canonicalJson(value: JsonElement): String = when (value) {
        is JsonObject -> value.entries
            .sortedBy { it.key }
            .joinToString(separator = ",", prefix = "{", postfix = "}") { (key, child) ->
                "${quote(key)}:${canonicalJson(child)}"
            }
        is JsonArray -> value.joinToString(separator = ",", prefix = "[", postfix = "]", transform = ::canonicalJson)
        is JsonPrimitive -> value.toString()
        else -> value.toString()
    }

    fun buildSigningPayload(rawContract: JsonObject): String {
        val payload = JsonObject(rawContract.filterKeys { it != "signature" })
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonicalJson(payload).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        fun text(name: String): String = rawContract[name]?.let { element ->
            (element as? JsonPrimitive)?.contentOrNull.orEmpty()
        }.orEmpty()
        return listOf(
            DOMAIN,
            text("instanceId"),
            text("deviceId"),
            text("connectionMode"),
            text("issuedAt"),
            text("expiresAt"),
            digest,
        ).joinToString("\n")
    }

    private fun quote(value: String): String = buildString {
        append('"')
        value.forEach { char ->
            when (char) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (char.code < 0x20) append("\\u%04x".format(char.code)) else append(char)
            }
        }
        append('"')
    }

    private fun extractRawEd25519Key(publicKeyPem: String): ByteArray {
        val encoded = publicKeyPem
            .lineSequence()
            .filter { !it.startsWith("-----") }
            .joinToString("")
        val der = runCatching { Base64.getDecoder().decode(encoded) }
            .getOrElse { throw ConnectionBootstrapVerificationException("Bootstrap public key encoding is invalid") }
        if (der.size == 32) return der
        // SubjectPublicKeyInfo for Ed25519 is the fixed 12-byte prefix followed by A.
        val prefix = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        )
        if (der.size != prefix.size + 32 || !der.copyOfRange(0, prefix.size).contentEquals(prefix)) {
            throw ConnectionBootstrapVerificationException("Bootstrap public key is not Ed25519 SPKI")
        }
        return der.copyOfRange(prefix.size, der.size)
    }
}
