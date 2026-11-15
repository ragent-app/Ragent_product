package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.protocol.*
import java.time.Instant

class DeviceAuthorityUpgradeRequired(val deviceId: String, cause: ApiException) : RuntimeException(cause)

internal fun isRenewableEnrollmentId(value: String): Boolean =
    Regex("^(?:rdev_[A-Za-z0-9_-]+|adev_[A-Za-z0-9_-]{4,156})$").matches(value)

/** Renews an existing enrollment. It never redeems a QR or submits business work. */
class DeviceCredentialRenewal(
    private val identity: DeviceIdentityStore,
    private val credentials: CredentialStore,
    private val p2pSecrets: P2PSecretStore? = null,
    private val codec: ProtocolCodec = ProtocolCodec(),
    private val now: () -> Instant = Instant::now,
) {
    suspend fun renew(instanceId: String, endpoint: String, writeGuard: PairingWriteGuard) {
        require(instanceId.isNotBlank() && endpoint.isNotBlank())
        // These two public authentication calls carry no RAC or old PC bearer.
        // The caller supplies the persisted, fixed target bootstrap endpoint.
        val transport = OkHttpRagentTransport({ endpoint.trimEnd('/') }, { null })
        try { renewUsing(instanceId, null, transport, writeGuard) } finally { transport.close() }
    }

    /** Uses an already verified, target-bound carrier without owning or closing it. */
    suspend fun renewViaCarrier(instanceId: String, deviceId: String, transport: RagentTransport, writeGuard: PairingWriteGuard) {
        require(instanceId.isNotBlank() && isRenewableEnrollmentId(deviceId))
        renewUsing(instanceId, deviceId, transport, writeGuard)
    }

    private suspend fun renewUsing(instanceId: String, expectedDeviceId: String?, transport: RagentTransport, writeGuard: PairingWriteGuard) {
        val scope = credentials.read(instanceId)?.scope
        val challenge = codec.decode(CreateDeviceChallengeResponse.serializer(), transport.execute(ApiRequest(
            "POST", "/api/device-auth/challenges", codec.encode(CreateDeviceChallengeRequest.serializer(),
                CreateDeviceChallengeRequest(devicePublicKey = identity.publicKeyEncoded(), audience = AUDIENCE)),
            isolateCredentialFailure = true,
        )).body).challenge
        val issued = Instant.parse(challenge.issuedAt)
        val expires = Instant.parse(challenge.expiresAt)
        val current = now()
        require(challenge.instanceId == instanceId && isRenewableEnrollmentId(challenge.deviceId)
            && (expectedDeviceId == null || challenge.deviceId == expectedDeviceId)) {
            "Device challenge target differs"
        }
        require(challenge.audience == AUDIENCE && challenge.challengeId.isNotBlank() && challenge.nonce.isNotBlank())
        require(!issued.isAfter(current.plusSeconds(30)) && expires.isAfter(current)
            && expires.isAfter(issued) && !expires.isAfter(issued.plusSeconds(60))) { "Device challenge expired or invalid" }
        val transcript = listOf("ragent-device-auth-v3", instanceId, challenge.deviceId,
            challenge.challengeId, challenge.nonce, challenge.issuedAt, AUDIENCE).joinToString("\n")
        require(challenge.message == transcript) { "Device challenge transcript differs" }
        val verifyResponse = try {
            transport.execute(ApiRequest("POST", "/api/device-auth/verify", codec.encode(VerifyDeviceChallengeRequest.serializer(),
                VerifyDeviceChallengeRequest(challenge.deviceId, challenge.challengeId, challenge.nonce, identity.sign(transcript))),
                isolateCredentialFailure = true))
        } catch (error: ApiException) {
            if (error.statusCode == 401 && error.code in UPGRADE_CODES) throw DeviceAuthorityUpgradeRequired(challenge.deviceId, error)
            throw error
        }
        val result = codec.decode(VerifyDeviceChallengeResponse.serializer(), verifyResponse.body)
        val credential = result.credential
        val deadline = Instant.parse(credential.expiresAt)
        require(result.verified && result.deviceId == challenge.deviceId && credential.type == "Bearer"
            && credential.token.startsWith("rda_") && deadline.isAfter(now())
            && !deadline.isAfter(current.plusSeconds(15 * 60 + 30))) { "Invalid renewed device credential" }
        val p2p = result.deviceP2P?.let {
            val signaling = java.net.URI(it.signalingEndpoint)
            require(signaling.scheme in setOf("http", "https") && !signaling.host.isNullOrBlank()
                && signaling.userInfo == null && it.roomId.isNotBlank() && it.secret.matches(Regex("^[a-f0-9]{64}$"))) {
                "Invalid renewed carrier credentials"
            }
            StoredP2PConfig(it.signalingEndpoint, it.roomId, it.secret)
        }
        writeGuard.persist(instanceId) {
            credentials.write(instanceId, credential.token, credential.expiresAt, scope)
            p2pSecrets?.let { if (p2p == null) it.clear(instanceId) else it.write(instanceId, p2p) }
        }
    }

    companion object {
        private const val AUDIENCE = "ragent-device-access"
        private val UPGRADE_CODES = setOf("owner_auth_authority_upgrade_required", "owner_auth_authority_superseded")
        /** Generic denial, missing/revoked enrollment and transport errors never permit re-enrollment. */
        fun requiresAccountUpgrade(error: Throwable): Boolean = error is DeviceAuthorityUpgradeRequired

        fun isDue(credential: StoredCredential?, now: Instant = Instant.now()): Boolean = credential == null
            || credential.expiresAt?.let { runCatching { !Instant.parse(it).isAfter(now.plusSeconds(60)) }.getOrDefault(true) } == true
    }
}
