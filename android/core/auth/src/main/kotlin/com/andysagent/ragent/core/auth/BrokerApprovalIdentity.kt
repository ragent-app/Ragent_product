package com.andysagent.ragent.core.auth

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.security.Signature
import java.security.AlgorithmParameters
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECFieldFp
import java.security.spec.X509EncodedKeySpec
import java.time.Instant

data class BrokerEnrollmentChallenge(
    val enrollmentId: String,
    val brokerInstallationId: String,
    val policyGeneration: Long,
    val ownerId: String,
    val deviceId: String,
    val publicKeyFingerprint: String,
    val nonce: String,
    val verificationCode: String,
    val createdAt: Instant,
    val expiresAt: Instant,
)

data class BrokerApprovalChallenge(
    val brokerInstallationId: String,
    val ownerId: String,
    val policyGeneration: Long,
    val requestId: String,
    val operation: String,
    val targetId: String,
    val targetFingerprint: String,
    val sessionId: String,
    val runId: String,
    val turnId: String,
    val actionId: String,
    val nonce: String,
    val createdAt: Instant,
    val expiresAt: Instant,
)

/** Canonical byte encoding shared with native/windows-privileged-broker. */
object BrokerApprovalProtocol {
    private const val DEVICE_ENROLLMENT_DOMAIN = "Ragent Broker Device Enrollment v1\u0000"
    private const val BROKER_ENROLLMENT_DOMAIN = "Ragent Broker Signed Enrollment Challenge v1\u0000"
    private const val ENROLLMENT_CODE_DOMAIN = "Ragent Broker Enrollment Code v1\u0000"
    private const val DEVICE_DECISION_DOMAIN = "Ragent Broker Device Decision v1\u0000"
    private const val BROKER_APPROVAL_DOMAIN = "Ragent Broker Signed Approval Challenge v1\u0000"
    private const val FIRST_TARGET_ID = "Ragent-Broker-QA-Target"
    private val requestIdPattern = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val ownerIdPattern = Regex("^[A-Za-z0-9._:@-]{1,128}$")
    private val sha256Pattern = Regex("^[0-9a-f]{64}$")
    private val codePattern = Regex("^[0-9]{8}$")

    fun deviceIdForPublicKey(publicKey: String): String = sha256Hex(decodeBase64(publicKey))

    fun enrollmentCodeBytes(challenge: BrokerEnrollmentChallenge): ByteArray {
        validateEnrollment(challenge)
        return encode(
            ENROLLMENT_CODE_DOMAIN,
            challenge.brokerInstallationId,
            challenge.ownerId,
            challenge.deviceId,
            challenge.nonce,
            challenge.enrollmentId,
            challenge.policyGeneration,
            challenge.createdAt,
            challenge.expiresAt,
        )
    }

    fun expectedEnrollmentCode(challenge: BrokerEnrollmentChallenge): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(enrollmentCodeBytes(challenge))
        val value = ((digest[0].toLong() and 0xff) shl 24) or
            ((digest[1].toLong() and 0xff) shl 16) or
            ((digest[2].toLong() and 0xff) shl 8) or
            (digest[3].toLong() and 0xff)
        return (value % 100_000_000L).toString().padStart(8, '0')
    }

    fun deviceEnrollmentSignatureBytes(challenge: BrokerEnrollmentChallenge): ByteArray {
        validateEnrollment(challenge)
        return encode(
            DEVICE_ENROLLMENT_DOMAIN,
            challenge.brokerInstallationId,
            challenge.ownerId,
            challenge.deviceId,
            challenge.publicKeyFingerprint,
            challenge.nonce,
            challenge.verificationCode,
            challenge.enrollmentId,
            challenge.policyGeneration,
            challenge.createdAt,
            challenge.expiresAt,
        )
    }

    fun brokerEnrollmentSignatureBytes(challenge: BrokerEnrollmentChallenge): ByteArray {
        validateEnrollment(challenge)
        return encode(
            BROKER_ENROLLMENT_DOMAIN,
            challenge.brokerInstallationId,
            challenge.ownerId,
            challenge.deviceId,
            challenge.publicKeyFingerprint,
            challenge.nonce,
            challenge.verificationCode,
            challenge.enrollmentId,
            challenge.policyGeneration,
            challenge.createdAt,
            challenge.expiresAt,
        )
    }

    fun deviceDecisionSignatureBytes(challenge: BrokerApprovalChallenge, choice: String): ByteArray {
        validateApproval(challenge)
        require(choice == "approve" || choice == "deny") { "Decision must be approve or deny" }
        return encode(
            DEVICE_DECISION_DOMAIN,
            challenge.brokerInstallationId,
            challenge.ownerId,
            challenge.requestId,
            challenge.operation,
            challenge.targetId,
            challenge.targetFingerprint,
            challenge.sessionId,
            challenge.runId,
            challenge.turnId,
            challenge.actionId,
            challenge.nonce,
            choice,
            challenge.policyGeneration,
            challenge.createdAt,
            challenge.expiresAt,
        )
    }

    fun brokerApprovalSignatureBytes(challenge: BrokerApprovalChallenge): ByteArray {
        validateApproval(challenge)
        return encode(
            BROKER_APPROVAL_DOMAIN,
            challenge.brokerInstallationId,
            challenge.ownerId,
            challenge.requestId,
            challenge.operation,
            challenge.targetId,
            challenge.targetFingerprint,
            challenge.sessionId,
            challenge.runId,
            challenge.turnId,
            challenge.actionId,
            challenge.nonce,
            challenge.policyGeneration,
            challenge.createdAt,
            challenge.expiresAt,
        )
    }

    fun verifyBrokerSignature(publicKey: String, signature: String, message: ByteArray): Boolean = runCatching {
        val key = java.security.KeyFactory.getInstance("EC")
            .generatePublic(X509EncodedKeySpec(decodeBase64(publicKey))) as ECPublicKey
        require(isP256(key.params))
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(message)
            verify(decodeBase64(signature))
        }
    }.getOrDefault(false)

    fun fingerprint(publicKey: String): String = sha256Hex(decodeBase64(publicKey))

    private fun validateEnrollment(challenge: BrokerEnrollmentChallenge) {
        require(requestIdPattern.matches(challenge.enrollmentId))
        require(requestIdPattern.matches(challenge.brokerInstallationId))
        require(challenge.policyGeneration > 0)
        require(ownerIdPattern.matches(challenge.ownerId))
        require(sha256Pattern.matches(challenge.deviceId))
        require(sha256Pattern.matches(challenge.publicKeyFingerprint))
        require(challenge.publicKeyFingerprint == challenge.deviceId)
        require(requestIdPattern.matches(challenge.nonce))
        require(codePattern.matches(challenge.verificationCode))
        require(challenge.expiresAt.isAfter(challenge.createdAt))
        require(java.time.Duration.between(challenge.createdAt, challenge.expiresAt) <= java.time.Duration.ofMinutes(5))
    }

    private fun validateApproval(challenge: BrokerApprovalChallenge) {
        require(requestIdPattern.matches(challenge.requestId))
        require(ownerIdPattern.matches(challenge.ownerId))
        require(requestIdPattern.matches(challenge.brokerInstallationId))
        require(challenge.policyGeneration > 0)
        require(challenge.operation == "service.restart")
        require(challenge.targetId == FIRST_TARGET_ID)
        require(sha256Pattern.matches(challenge.targetFingerprint))
        require(requestIdPattern.matches(challenge.sessionId))
        require(requestIdPattern.matches(challenge.runId))
        require(requestIdPattern.matches(challenge.turnId))
        require(requestIdPattern.matches(challenge.actionId))
        require(requestIdPattern.matches(challenge.nonce))
        require(challenge.expiresAt.isAfter(challenge.createdAt))
        require(java.time.Duration.between(challenge.createdAt, challenge.expiresAt) <= java.time.Duration.ofMinutes(2))
    }

    private fun encode(domain: String, vararg fields: Any): ByteArray {
        val bytes = ByteArrayOutputStream(512)
        DataOutputStream(bytes).use { output ->
            output.write(domain.toByteArray(Charsets.UTF_8))
            fields.forEach { field ->
                when (field) {
                    is String -> {
                        val encoded = field.toByteArray(Charsets.UTF_8)
                        require(encoded.size <= 128)
                        output.writeInt(encoded.size)
                        output.write(encoded)
                    }
                    is Long -> {
                        require(field > 0)
                        output.writeLong(field)
                    }
                    is Instant -> {
                        output.writeLong(field.epochSecond)
                        output.writeInt(field.nano)
                    }
                    else -> error("Unsupported Broker signature field")
                }
            }
        }
        return bytes.toByteArray()
    }

    private fun decodeBase64(value: String): ByteArray = java.util.Base64.getDecoder().decode(value)

    private fun isP256(parameters: ECParameterSpec): Boolean {
        val expected = AlgorithmParameters.getInstance("EC").run {
            init(ECGenParameterSpec("secp256r1"))
            getParameterSpec(ECParameterSpec::class.java)
        }
        val actualField = parameters.curve.field as? ECFieldFp ?: return false
        val expectedField = expected.curve.field as? ECFieldFp ?: return false
        return actualField.p == expectedField.p && parameters.curve.a == expected.curve.a &&
            parameters.curve.b == expected.curve.b && parameters.generator == expected.generator &&
            parameters.order == expected.order && parameters.cofactor == expected.cofactor
    }

    private fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
