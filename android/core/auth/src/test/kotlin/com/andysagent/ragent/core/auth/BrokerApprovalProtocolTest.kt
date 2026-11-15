package com.andysagent.ragent.core.auth

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.time.Instant
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BrokerApprovalProtocolTest {
    private val createdAt = Instant.parse("2026-10-22T01:02:03.123456789Z")
    private val enrollment = BrokerEnrollmentChallenge(
        enrollmentId = "enroll-1",
        brokerInstallationId = "broker-1",
        policyGeneration = 7,
        ownerId = "owner-1",
        deviceId = "1".repeat(64),
        publicKeyFingerprint = "1".repeat(64),
        nonce = "nonce-1",
        verificationCode = "12345678",
        createdAt = createdAt,
        expiresAt = createdAt.plusSeconds(300),
    )
    private val approval = BrokerApprovalChallenge(
        brokerInstallationId = "broker-1",
        ownerId = "owner-1",
        policyGeneration = 7,
        requestId = "req-1",
        operation = "service.restart",
        targetId = "Ragent-Broker-QA-Target",
        targetFingerprint = "a".repeat(64),
        sessionId = "session-1",
        runId = "run-1",
        turnId = "turn-1",
        actionId = "action-1",
        nonce = "nonce-1",
        createdAt = createdAt,
        expiresAt = createdAt.plusSeconds(120),
    )

    @Test
    fun canonicalBytesMatchWindowsBrokerGoldenVectors() {
        assertEquals("2be468a6428f3344c73e20fb4b4b14bcfe62a740a645793a2bc46acc3eb46f02", digest(BrokerApprovalProtocol.deviceEnrollmentSignatureBytes(enrollment)))
        assertEquals("fde25edb4f19efbf5b8aca661c5bb281b834fe44ff7f1a7c6971ae8be71aca21", digest(BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(enrollment)))
        assertEquals("f0cadff165abc5c29fdb6810274a686630959d11c7445b52e56aa4384b6401c0", digest(BrokerApprovalProtocol.enrollmentCodeBytes(enrollment)))
        assertEquals("39827441", BrokerApprovalProtocol.expectedEnrollmentCode(enrollment))
        assertEquals("d3a6add21e8c9ac5ef70004ca7245be41a1676fd25733d7a8b5a949f3e58484a", digest(BrokerApprovalProtocol.deviceDecisionSignatureBytes(approval, "approve")))
        assertEquals("305fc88793715279e22d5f619d0119bf650999f56a9d7f035fbdf59cf7fe25f5", digest(BrokerApprovalProtocol.brokerApprovalSignatureBytes(approval)))
    }

    @Test
    fun brokerSignatureVerifiesAndChallengeChangesInvalidateIt() {
        val generator = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }
        val pair = generator.generateKeyPair()
        val message = BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(enrollment)
        val signer = Signature.getInstance("SHA256withECDSA").apply {
            initSign(pair.private)
            update(message)
        }
        val publicKey = Base64.getEncoder().encodeToString(pair.public.encoded)
        val signature = Base64.getEncoder().encodeToString(signer.sign())
        assertTrue(BrokerApprovalProtocol.verifyBrokerSignature(publicKey, signature, message))
        val changed = enrollment.copy(ownerId = "other-owner")
        assertFalse(BrokerApprovalProtocol.verifyBrokerSignature(
            publicKey,
            signature,
            BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(changed),
        ))
    }

    @Test
    fun approvalRejectsAnArbitraryTarget() {
        val changed = approval.copy(targetId = "other-service")
        kotlin.test.assertFailsWith<IllegalArgumentException> {
            BrokerApprovalProtocol.brokerApprovalSignatureBytes(changed)
        }
    }

    private fun digest(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(value)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
