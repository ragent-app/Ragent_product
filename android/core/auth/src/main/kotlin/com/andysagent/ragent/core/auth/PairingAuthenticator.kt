package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.StoredInstance
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.protocol.RagentProtocol
import com.andysagent.ragent.core.protocol.CreateDeviceChallengeRequest
import com.andysagent.ragent.core.protocol.CreateDeviceChallengeResponse
import com.andysagent.ragent.core.protocol.AccountJoinIntentDto
import com.andysagent.ragent.core.protocol.AccountRendezvousTargetInstanceDto
import com.andysagent.ragent.core.protocol.CompleteAccountJoinIntentRequest
import com.andysagent.ragent.core.protocol.CreateAccountJoinIntentRequest
import com.andysagent.ragent.core.protocol.CreateAccountJoinIntentResponse
import com.andysagent.ragent.core.protocol.ProtocolCodec
import com.andysagent.ragent.core.protocol.RedeemPairingInvitationRequest
import com.andysagent.ragent.core.protocol.RedeemPairingInvitationResponse
import com.andysagent.ragent.core.protocol.VerifyDeviceChallengeRequest
import com.andysagent.ragent.core.protocol.VerifyDeviceChallengeResponse
import com.andysagent.ragent.core.protocol.PairingCredentialDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapPublicKeyDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapVerifier
import com.andysagent.ragent.core.network.VerifiedBootstrap
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import com.andysagent.ragent.core.protocol.parsePairingUri
import kotlinx.serialization.serializer
import kotlinx.coroutines.flow.first
import java.time.Instant
import java.util.UUID

private val TARGET_DEVICE_ID_PATTERN = Regex("^rdev_[A-Za-z0-9_-]+$")

data class PairingResult(
    val instanceId: String,
    val endpoint: String,
    val deviceId: String,
    val credentialType: String,
    val expiresAt: String? = null,
    val credentialScope: String? = null,
    val p2p: StoredP2PConfig? = null,
    val verifiedBootstrap: com.andysagent.ragent.core.network.VerifiedBootstrap? = null,
)

/** New QR targets stay paired-only; reclaims retain an existing automatic role. */
fun shouldAutoConnectQrClaim(existingComputerCount: Int, existingTargetAutoConnect: Boolean = false): Boolean =
    existingComputerCount == 0 || existingTargetAutoConnect

class PairingAuthenticator(
    private val identity: DeviceIdentityStore,
    private val credentialStore: CredentialStore,
    private val configStore: ClientConfigStore? = null,
    private val p2pSecretStore: P2PSecretStore? = null,
    private val accountJoinAuthorizer: AccountJoinGrantAuthorizer? = null,
    private val codec: ProtocolCodec = ProtocolCodec(),
) {
    suspend fun redeem(pairingUri: String, deviceName: String): PairingResult {
        require(deviceName.isNotBlank()) { "Device name must not be blank" }
        val invitation = parsePairingUri(pairingUri)
        if (invitation.endpoint.isBlank()) {
            val targetPublicKey = invitation.instancePublicKey
            val targetKeyFingerprint = invitation.instanceKeyFingerprint
            return joinWithAccountRendezvous(
                targetInstanceId = invitation.instanceId,
                deviceName = deviceName,
                accountClaimToken = invitation.token,
                targetInstance = if (targetPublicKey != null && targetKeyFingerprint != null) {
                    AccountRendezvousTargetInstanceDto(
                        instanceId = invitation.instanceId,
                        publicKey = targetPublicKey,
                        keyFingerprint = targetKeyFingerprint,
                    )
                } else null,
            )
        }
        val transport = OkHttpRagentTransport({ invitation.endpoint }, { null })
        try {
            val redeemBody = codec.encode(serializer<RedeemPairingInvitationRequest>(), RedeemPairingInvitationRequest(
                token = invitation.token,
                deviceName = deviceName,
                platform = "android",
                devicePublicKey = identity.publicKeyEncoded(),
                authVersion = 3,
            ))
            val redeemed = codec.decode(
                serializer<RedeemPairingInvitationResponse>(),
                transport.execute(ApiRequest("POST", "/api/device-pairing/redeem", redeemBody)).body,
            )
            require(redeemed.instanceId == invitation.instanceId) { "Pairing instance mismatch" }
            require(redeemed.endpoint.startsWith("http://") || redeemed.endpoint.startsWith("https://")) {
                "Pairing response endpoint is invalid"
            }
            val credential = when {
                redeemed.credential.type == "Bearer" && isSupportedToken(redeemed.credential.token) -> redeemed.credential
                else -> authenticateSignature(transport, redeemed.device.id)
            }
            val token = credential.token?.takeIf(::isSupportedToken)
                ?: error("Pairing response did not contain a supported credential token")
            credentialStore.write(redeemed.instanceId, token, credential.expiresAt, credential.scope)
            val p2p = redeemed.deviceP2P?.let { candidate ->
                require(candidate.roomId.isNotBlank()) { "Pairing response P2P room is invalid" }
                require(candidate.secret.isNotBlank()) { "Pairing response P2P secret is invalid" }
                require(candidate.signalingEndpoint.startsWith("http://") || candidate.signalingEndpoint.startsWith("https://")) {
                    "Pairing response P2P signaling endpoint is invalid"
                }
                StoredP2PConfig(candidate.signalingEndpoint.trimEnd('/'), candidate.roomId, candidate.secret)
            }
            p2pSecretStore?.let { store ->
                if (p2p == null) store.clear(redeemed.instanceId) else store.write(redeemed.instanceId, p2p)
            }
            configStore?.save(StoredInstance(
                endpoint = redeemed.endpoint.trimEnd('/'),
                instanceId = redeemed.instanceId,
                label = deviceName,
            ))
            return PairingResult(
                instanceId = redeemed.instanceId,
                endpoint = redeemed.endpoint.trimEnd('/'),
                deviceId = redeemed.device.id,
                credentialType = credential.type,
                expiresAt = credential.expiresAt,
                credentialScope = credential.scope,
                p2p = p2p,
            )
        } finally {
            transport.close()
        }
    }

    /**
     * Join an explicitly selected instance through the account-intent protocol.
     * Accounts turns the phone's `rac_` into a one-time bound grant; only that
     * grant crosses to the target computer. Pending intent metadata is restart-
     * safe and contains neither an ID token nor a bearer credential.
     */
    suspend fun joinWithAccountSession(
        targetEndpoint: String,
        deviceName: String,
        accountClaimToken: String? = null,
        computerAlias: String = "",
        autoConnect: Boolean = true,
        selectTarget: Boolean = autoConnect,
        writeGuard: PairingWriteGuard = PairingWriteGuard.Direct,
        // Upgrade authority for an existing device only. The caller follows
        // with a fresh signature renewal; this branch publishes no local token
        // or directory changes and does not consume a UI's pending join.
        renewExistingDeviceId: String? = null,
        /** A previously identity-verified local transport; caller retains its lifetime. */
        localTransport: RagentTransport? = null,
        expectedInstanceId: String? = null,
        persistDirectory: Boolean = true,
    ): PairingResult {
        require(targetEndpoint.startsWith("http://") || targetEndpoint.startsWith("https://")) {
            "Account join endpoint is invalid"
        }
        require(deviceName.isNotBlank()) { "Device name must not be blank" }
        require(renewExistingDeviceId == null || isRenewableEnrollmentId(renewExistingDeviceId)) { "Existing enrollment id is invalid" }
        val authorizer = accountJoinAuthorizer
            ?: error("Account join authorization is unavailable")
        val endpoint = targetEndpoint.trimEnd('/')
        require((localTransport == null) == (expectedInstanceId == null)) { "Local transport requires a fixed instance identity" }
        val transport = localTransport ?: OkHttpRagentTransport({ endpoint }, { null })
        try {
            val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
            val pending = if (localTransport != null) null else configStore?.pendingAccountJoin?.first()?.takeIf {
                renewExistingDeviceId == null && it.endpoint == endpoint
                    && isTargetDeviceId(it.deviceId)
                    && it.devicePublicKeyFingerprint == fingerprint
                    && runCatching { Instant.parse(it.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)
            }
            val intent = if (pending == null) {
                val createBody = codec.encode(serializer<CreateAccountJoinIntentRequest>(), CreateAccountJoinIntentRequest(
                    devicePublicKey = identity.publicKeyEncoded(),
                    deviceName = deviceName,
                    platform = "android",
                    accountClaimToken = accountClaimToken?.trim()?.takeIf { it.isNotEmpty() },
                    computerAlias = normalizeComputerAlias(computerAlias),
                    renewExistingDeviceId = renewExistingDeviceId,
                ))
                val created = codec.decode(
                    serializer<CreateAccountJoinIntentResponse>(),
                    transport.execute(ApiRequest("POST", "/api/device-pairing/account-intents", createBody)).body,
                ).intent
                require(isTargetDeviceId(created.deviceId) || (renewExistingDeviceId != null && created.deviceId == renewExistingDeviceId)) { "Account join target device id is invalid" }
                require(renewExistingDeviceId == null || created.deviceId == renewExistingDeviceId) { "Renewal changed the device enrollment" }
                require(created.devicePublicKeyFingerprint == fingerprint) { "Account join device key fingerprint mismatch" }
                val requestId = UUID.randomUUID().toString()
                require(expectedInstanceId == null || created.instanceId == expectedInstanceId) { "Account intent target differs from the local instance" }
                writeGuard.persist(created.instanceId) { if (renewExistingDeviceId == null && localTransport == null) configStore?.savePendingAccountJoin(com.andysagent.ragent.core.datastore.PendingAccountJoin(
                    endpoint = endpoint,
                    intentId = created.intentId,
                    instanceId = created.instanceId,
                    deviceId = created.deviceId,
                    devicePublicKeyFingerprint = created.devicePublicKeyFingerprint,
                    nonce = created.nonce,
                    issuedAt = created.issuedAt,
                    expiresAt = created.expiresAt,
                    requestId = requestId,
                    computerAlias = normalizeComputerAlias(computerAlias),
                )) }
                created
            } else {
                AccountJoinIntentDto(
                    intentId = pending.intentId,
                    instanceId = pending.instanceId,
                    deviceId = pending.deviceId,
                    devicePublicKeyFingerprint = pending.devicePublicKeyFingerprint,
                    nonce = pending.nonce,
                    issuedAt = pending.issuedAt,
                    expiresAt = pending.expiresAt,
                    instanceSignature = "",
                    deviceName = deviceName,
                    platform = "android",
                    computerAlias = pending.computerAlias,
                )
            }
            val requestId = pending?.requestId
                ?: (if (renewExistingDeviceId == null && localTransport == null) configStore?.pendingAccountJoin?.first()?.requestId else null)
                ?: UUID.randomUUID().toString()
            require(expectedInstanceId == null || intent.instanceId == expectedInstanceId) { "Account intent target differs from the local instance" }
            val signedMessage = com.andysagent.ragent.core.protocol.buildAccountJoinIntentMessage(
                instanceId = intent.instanceId,
                intentId = intent.intentId,
                deviceId = intent.deviceId,
                devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
                nonce = intent.nonce,
                issuedAt = intent.issuedAt,
            )
            val deviceSignature = identity.sign(signedMessage)
            val authorizationProof = AccountJoinAuthorizationProof(
                    requestId = requestId,
                    nonce = intent.nonce,
                    issuedAt = intent.issuedAt,
                    deviceSignature = deviceSignature,
                )
            val grant = if (renewExistingDeviceId == null) authorizer.authorizeAccountJoin(intent, authorizationProof)
                else authorizer.authorizeExistingEnrollment(intent, authorizationProof)
            require(
                grant.accountJoinGrant.isNotBlank()
                    && grant.intentId == intent.intentId
                    && grant.instanceId == intent.instanceId
                    && grant.deviceId == intent.deviceId
                    && (isTargetDeviceId(grant.deviceId) || grant.deviceId == renewExistingDeviceId),
            ) { "Account join grant does not match the target intent" }
            val completeBody = codec.encode(serializer<CompleteAccountJoinIntentRequest>(), CompleteAccountJoinIntentRequest(
                accountJoinGrant = grant.accountJoinGrant,
                nonce = intent.nonce,
                deviceSignature = deviceSignature,
            ))
            val completed = codec.decode(
                serializer<com.andysagent.ragent.core.protocol.CompleteAccountJoinIntentResponse>(),
                transport.execute(ApiRequest(
                    method = "POST",
                    path = "/api/device-pairing/account-intents/${encodePath(intent.intentId)}/complete",
                    body = completeBody,
                    requestId = requestId,
                    idempotencyKey = requestId,
                )).body,
            )
            require(completed.ok && completed.bound && completed.deviceId == intent.deviceId
                && (isTargetDeviceId(completed.deviceId) || completed.deviceId == renewExistingDeviceId)) {
                "Account join did not bind this device"
            }
            val credential = completed.credential
            val token = credential.token?.takeIf(::isSupportedToken)
                ?: error("Account join response did not contain a supported credential token")
            writeGuard.persist(intent.instanceId) {
              if (renewExistingDeviceId == null) {
                credentialStore.write(intent.instanceId, token, credential.expiresAt, credential.scope)
                if (persistDirectory) configStore?.save(
                    StoredInstance(
                        endpoint = endpoint,
                        instanceId = intent.instanceId,
                        label = deviceName,
                        autoConnect = autoConnect,
                    ),
                    select = selectTarget,
                )
                if (localTransport == null) configStore?.clearPendingAccountJoin()
              }
            }
            return PairingResult(
                instanceId = intent.instanceId,
                endpoint = endpoint,
                deviceId = intent.deviceId,
                credentialType = credential.type,
                expiresAt = credential.expiresAt,
                credentialScope = credential.scope,
            )
        } finally {
            if (localTransport == null) transport.close()
        }
    }

    suspend fun joinWithAccountRendezvous(
        targetInstanceId: String,
        deviceName: String,
        accountClaimToken: String? = null,
        targetInstance: AccountRendezvousTargetInstanceDto? = null,
        autoConnect: Boolean = true,
        computerAlias: String = "",
        persistDirectory: Boolean = true,
        selectTarget: Boolean = autoConnect,
        targetLabel: String = targetInstanceId,
        writeGuard: PairingWriteGuard = PairingWriteGuard.Direct,
    ): PairingResult {
        require(targetInstanceId.isNotBlank()) { "Target instance id must not be blank" }
        val rendezvous = accountJoinAuthorizer as? AccountRendezvousAuthorizer
            ?: error("Account rendezvous is unavailable")
        val handoff = rendezvous.rendezvous(
            targetInstanceId = targetInstanceId,
            deviceName = deviceName,
            accountClaimToken = accountClaimToken,
            targetInstance = targetInstance,
            computerAlias = normalizeComputerAlias(computerAlias),
        )
        val result = handoff.result
        val resultError = (result["error"] as? JsonObject)?.get("code")?.jsonPrimitive?.contentOrNull
        if (resultError in setOf("turn_connection_quota_exceeded", "turn_quota_exceeded")) {
            throw AccountSessionException(429, "turn_connection_quota_exceeded",
                "The account has reached its active connection limit.", retryable = false)
        }
        val credential = codec.decode(
            serializer<PairingCredentialDto>(),
            result["credential"]?.toString() ?: error("Rendezvous credential is missing"),
        )
        val token = credential.token?.takeIf(::isSupportedToken)
            ?: error("Rendezvous response did not contain a supported credential token")
        val p2pElement = result["p2p"]?.takeIf { !it.toString().equals("null", ignoreCase = true) }?.jsonObject
        val p2p = p2pElement?.let {
            StoredP2PConfig(
                signalingEndpoint = it["signalingEndpoint"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                roomId = it["roomId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                secret = it["secret"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            ).also { config ->
                require(config.signalingEndpoint.startsWith("http://") || config.signalingEndpoint.startsWith("https://"))
                require(config.roomId.isNotBlank() && config.secret.isNotBlank())
            }
        }
        val bootstrapJson = result["bootstrap"]?.jsonObject ?: error("Rendezvous bootstrap is missing")
        val publicKey = ConnectionBootstrapPublicKeyDto(
            algorithm = "ed25519",
            keyId = handoff.intent.instanceKeyFingerprint,
            publicKeyPem = handoff.intent.instancePublicKey,
        )
        val verified = ConnectionBootstrapVerifier.verify(bootstrapJson.toString(), publicKey)
        require(verified.contract.instanceId == targetInstanceId && verified.contract.deviceId == handoff.intent.deviceId)
        writeGuard.persist(targetInstanceId) {
            credentialStore.write(targetInstanceId, token, credential.expiresAt, credential.scope)
            p2pSecretStore?.let { store ->
                if (p2p == null) store.clear(targetInstanceId) else store.write(targetInstanceId, p2p)
            }
            if (persistDirectory) configStore?.save(
                StoredInstance(
                    endpoint = "",
                    instanceId = targetInstanceId,
                    label = targetLabel.ifBlank { targetInstanceId },
                    autoConnect = autoConnect,
                ),
                select = selectTarget,
            )
        }
        return PairingResult(
            instanceId = targetInstanceId,
            endpoint = "",
            deviceId = handoff.intent.deviceId,
            credentialType = credential.type,
            expiresAt = credential.expiresAt,
            credentialScope = credential.scope,
            p2p = p2p,
            verifiedBootstrap = VerifiedBootstrap(verified.contract, verified.publicKey, bootstrapJson.toString()),
        )
    }

    private suspend fun authenticateSignature(transport: OkHttpRagentTransport, deviceId: String) = run {
        val challengeBody = codec.encode(serializer<CreateDeviceChallengeRequest>(), CreateDeviceChallengeRequest(deviceId))
        val challenge = codec.decode(
            serializer<CreateDeviceChallengeResponse>(),
            transport.execute(ApiRequest("POST", "/api/device-auth/challenges", challengeBody)).body,
        ).challenge
        val verifyBody = codec.encode(serializer<VerifyDeviceChallengeRequest>(), VerifyDeviceChallengeRequest(
            deviceId = deviceId,
            challengeId = challenge.challengeId,
            nonce = challenge.nonce,
            signature = identity.sign(challenge.message),
        ))
        val verified = codec.decode(
            serializer<VerifyDeviceChallengeResponse>(),
            transport.execute(ApiRequest("POST", "/api/device-auth/verify", verifyBody)).body,
        )
        require(verified.verified) { "Device challenge was not verified" }
        verified.credential.let {
            com.andysagent.ragent.core.protocol.PairingCredentialDto(it.type, it.token, it.expiresAt)
        }
    }

    private fun isSupportedToken(token: String?): Boolean = token?.let {
        it.startsWith("rdt_") || it.startsWith("rda_") || it.startsWith("rdp_")
    } == true

    private fun isTargetDeviceId(value: String): Boolean = TARGET_DEVICE_ID_PATTERN.matches(value)

    private fun normalizeComputerAlias(value: String): String =
        value.replace(Regex("[\\r\\n]+"), " ").trim().take(64)

    private fun encodePath(value: String): String = java.net.URLEncoder.encode(value, Charsets.UTF_8.name())
}
