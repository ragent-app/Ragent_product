package com.andysagent.ragent.core.auth

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WindowsServiceControlApprovalTest {
    private val grant = WindowsServiceControlGrant(1, "key", "broker", 3, "request", "session", "run", "turn", "action",
        "0123456789abcdefghijklmn", "服务 示例 & one", "restart-service", "a".repeat(64), "owner", 1800000000000, 1800000060000)
    private fun bytes(value: WindowsServiceControlGrant = grant, now: Long = grant.issuedMs) =
        WindowsServiceControlApproval.ownerSigningBytes(value, now)

    @Test fun matchesBrokerAndControlPlaneVector() {
        val expected = "e0cb3610783fd33fdc745e5059474811b3dac76415ef91a283cf110df0af9bf1"
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes()).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertTrue(digest == expected)
        assertContentEquals(bytes(), bytes())
        val denial = WindowsServiceControlApproval.ownerDenialSigningBytes(grant, grant.issuedMs)
        val denialDigest = MessageDigest.getInstance("SHA-256").digest(denial).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertTrue(denialDigest == "2685876afa9faa33edcd29a2ca1dea674a646ad69cfb3143f291614bda1a7363")
        assertFalse(denial.contentEquals(bytes()))
        val review = WindowsServiceControlApproval.brokerReviewSigningBytes(grant, grant.issuedMs)
        val reviewDigest = MessageDigest.getInstance("SHA-256").digest(review).joinToString("") { "%02x".format(it.toInt() and 255) }
        assertTrue(reviewDigest == "d98b2c6f1b2def03d2fffb8eb9d8375dd031ffc42f5a7ae4d861470ae7a026b9")
    }

    @Test fun signatureIsBoundToOperationAndExpiry() {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val signature = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(bytes()); sign() }
        fun verify(value: WindowsServiceControlGrant) = Signature.getInstance("SHA256withECDSA").run {
            initVerify(keys.public); update(bytes(value)); verify(signature)
        }
        assertTrue(verify(grant))
        assertFalse(verify(grant.copy(serviceName = "另一项服务")))
        assertFalse(verify(grant.copy(action = "stop-service")))
        assertFailsWith<IllegalArgumentException> { bytes(now = grant.expiresMs) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(serviceName = "bad*")) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(serviceName = "bad\uD800")) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(authorization = "policy-auto")) }
        assertFailsWith<IllegalArgumentException> { bytes(grant.copy(expiresMs = grant.issuedMs + 600_001)) }
    }

    @Test fun reviewRequiresPinnedBrokerAndExactGrant() {
        val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val publicKey = Base64.getEncoder().encodeToString(keys.public.encoded)
        val fingerprint = BrokerApprovalProtocol.fingerprint(publicKey)
        val review = WindowsServiceControlApproval.brokerReviewSigningBytes(grant, grant.issuedMs)
        val signature = Signature.getInstance("SHA256withECDSA").run { initSign(keys.private); update(review); Base64.getEncoder().encodeToString(sign()) }
        assertTrue(WindowsServiceControlApproval.verifyBrokerReview(grant, publicKey, signature, fingerprint, grant.issuedMs))
        assertFalse(WindowsServiceControlApproval.verifyBrokerReview(grant.copy(serviceName = "different"), publicKey, signature, fingerprint, grant.issuedMs))
        assertFalse(WindowsServiceControlApproval.verifyBrokerReview(grant, publicKey, signature, "0".repeat(64), grant.issuedMs))
        assertFalse(WindowsServiceControlApproval.verifyBrokerReview(grant, publicKey, signature, fingerprint, grant.expiresMs))
    }
}
