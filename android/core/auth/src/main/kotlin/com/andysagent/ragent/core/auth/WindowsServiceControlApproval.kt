package com.andysagent.ragent.core.auth

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest

/** An exact broker operation displayed to and approved by the device owner. */
data class WindowsServiceControlGrant(
    val version: Long,
    val keyId: String,
    val brokerInstallationId: String,
    val policyGeneration: Long,
    val requestId: String,
    val sessionId: String,
    val runId: String,
    val turnId: String,
    val actionId: String,
    val nonce: String,
    val serviceName: String,
    val action: String,
    val definitionHash: String,
    val authorization: String,
    val issuedMs: Long,
    val expiresMs: Long,
)

object WindowsServiceControlApproval {
    private const val OWNER_DOMAIN = "Ragent Windows service owner approval v1\u0000"
    private const val DENIAL_DOMAIN = "Ragent Windows service owner denial v1\u0000"
    private const val GRANT_DOMAIN = "Ragent Windows service control v1\u0000"
    private const val REVIEW_DOMAIN = "Ragent Windows service review v1\u0000"
    private val id = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val nonce = Regex("^[A-Za-z0-9_-]{24,128}$")
    private val digest = Regex("^[a-f0-9]{64}$")

    /** Validate the short-lived grant before handing bytes to the device key. */
    fun ownerSigningBytes(grant: WindowsServiceControlGrant, nowMs: Long = System.currentTimeMillis()): ByteArray {
        require(grant.version == 1L && grant.policyGeneration > 0)
        require(listOf(grant.keyId, grant.brokerInstallationId, grant.requestId, grant.sessionId,
            grant.runId, grant.turnId, grant.actionId).all(id::matches))
        require(nonce.matches(grant.nonce))
        require(grant.serviceName.isNotEmpty() && grant.serviceName == grant.serviceName.trim())
        require(grant.serviceName.toByteArray(Charsets.UTF_8).toString(Charsets.UTF_8) == grant.serviceName)
        require(grant.serviceName.codePointCount(0, grant.serviceName.length) <= 256)
        require(grant.serviceName.none { it == '\\' || it == '/' || it == '*' || it == '?' || Character.isISOControl(it) })
        require(grant.action in setOf("start-service", "stop-service", "restart-service"))
        require(digest.matches(grant.definitionHash) && grant.authorization == "owner")
        require(grant.issuedMs > 0 && grant.expiresMs > grant.issuedMs && grant.expiresMs - grant.issuedMs <= 600_000)
        require(nowMs >= grant.issuedMs && nowMs < grant.expiresMs)
        return ByteArrayOutputStream().use { output ->
            DataOutputStream(output).use { data ->
                data.write(OWNER_DOMAIN.toByteArray(Charsets.UTF_8))
                data.write(GRANT_DOMAIN.toByteArray(Charsets.UTF_8))
                fun text(value: String) { val bytes = value.toByteArray(Charsets.UTF_8); data.writeInt(bytes.size); data.write(bytes) }
                data.writeLong(grant.version)
                text(grant.keyId); text(grant.brokerInstallationId); data.writeLong(grant.policyGeneration)
                listOf(grant.requestId, grant.sessionId, grant.runId, grant.turnId, grant.actionId, grant.nonce,
                    grant.serviceName, grant.action, grant.definitionHash, grant.authorization).forEach(::text)
                data.writeLong(grant.issuedMs); data.writeLong(grant.expiresMs)
            }
            output.toByteArray()
        }
    }

    fun ownerDenialSigningBytes(grant: WindowsServiceControlGrant, nowMs: Long = System.currentTimeMillis()): ByteArray {
        val ownerBytes = ownerSigningBytes(grant, nowMs)
        return DENIAL_DOMAIN.toByteArray(Charsets.UTF_8) + ownerBytes.copyOfRange(OWNER_DOMAIN.toByteArray(Charsets.UTF_8).size, ownerBytes.size)
    }

    /** Verify this with the pinned Broker identity before presenting the grant. */
    fun brokerReviewSigningBytes(grant: WindowsServiceControlGrant, nowMs: Long = System.currentTimeMillis()): ByteArray {
        val ownerBytes = ownerSigningBytes(grant, nowMs)
        return REVIEW_DOMAIN.toByteArray(Charsets.UTF_8) + ownerBytes.copyOfRange(OWNER_DOMAIN.toByteArray(Charsets.UTF_8).size, ownerBytes.size)
    }

    fun verifyBrokerReview(grant: WindowsServiceControlGrant, publicKey: String, signature: String, pinnedFingerprint: String,
        nowMs: Long = System.currentTimeMillis()): Boolean = runCatching {
        require(digest.matches(pinnedFingerprint))
        val actual = BrokerApprovalProtocol.fingerprint(publicKey)
        require(MessageDigest.isEqual(actual.toByteArray(Charsets.US_ASCII), pinnedFingerprint.toByteArray(Charsets.US_ASCII)))
        BrokerApprovalProtocol.verifyBrokerSignature(publicKey, signature, brokerReviewSigningBytes(grant, nowMs))
    }.getOrDefault(false)
}
