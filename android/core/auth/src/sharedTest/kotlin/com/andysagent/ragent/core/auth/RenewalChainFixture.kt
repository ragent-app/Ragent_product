package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.datastore.AccountSessionMetadata
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.protocol.*
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit

/** Actual phone auth classes and HTTP; the two remote services are deterministic fixtures. */
class RenewalChainFixture(
    val identity: DeviceIdentityStore,
    credentials: CredentialStore,
    secrets: P2PSecretStore,
    val accountCredentials: AccountCredentialStore,
    config: ClientConfigStore? = null,
    val enrollmentId: String = OWN_PHONE,
    finalStatus: Int = 200,
    initialCode: String = "owner_auth_authority_upgrade_required",
) {
    companion object {
        const val INSTANCE = "pc-chain-fixed"
        const val OWN_PHONE = "adev_chain_phone"
        const val RAC = "rac_chain_fixture"
    }
    val now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
    val pc = MockWebServer().apply { start() }
    val accounts = MockWebServer().apply { start() }
    val endpoint = pc.url("/").toString().trimEnd('/')
    private val codec = ProtocolCodec()
    private val accountMetadata = object : AccountSessionMetadataStore {
        override val accountSession = MutableStateFlow<AccountSessionMetadata?>(AccountSessionMetadata(
            "acct_chain", OWN_PHONE, "credential_chain", "account-directory", now.plusSeconds(3600).toString()))
        override suspend fun getOrCreateAccountDeviceId() = OWN_PHONE
        override suspend fun saveAccountSession(value: AccountSessionMetadata) { accountSession.value = value }
        override suspend fun clearAccountSession() { accountSession.value = null }
    }
    private val anonymous = OkHttpRagentTransport({ accounts.url("/").toString().trimEnd('/') }, { null })
    private val authenticated = OkHttpRagentTransport({ accounts.url("/").toString().trimEnd('/') }, accountCredentials::readToken)
    val accountSessions = AccountSessionManager(anonymous, authenticated, identity, accountCredentials, accountMetadata, clock = { now })
    val pairing = PairingAuthenticator(identity, credentials, config, secrets, accountSessions)
    val coordinator = DeviceCredentialRenewalCoordinator(DeviceCredentialRenewal(identity, credentials, secrets, now = { now }), pairing)
    private val first = challenge("first")
    private val last = challenge("last")
    private val intent = AccountJoinIntentDto("rji_chain_intent", INSTANCE, enrollmentId,
        devicePublicKeyFingerprint(identity.publicKeyEncoded()), "intent_nonce_chain", now.toString(), now.plusSeconds(120).toString())

    init {
        accountCredentials.writeToken(RAC)
        pc.enqueue(MockResponse().setBody(codec.encode(CreateDeviceChallengeResponse.serializer(), CreateDeviceChallengeResponse(first))))
        pc.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"authority changed","code":"$initialCode"}"""))
        pc.enqueue(MockResponse().setBody(codec.encode(CreateAccountJoinIntentResponse.serializer(), CreateAccountJoinIntentResponse(intent))))
        pc.enqueue(MockResponse().setBody(codec.encode(CompleteAccountJoinIntentResponse.serializer(), CompleteAccountJoinIntentResponse(
            true, true, "accounts", intent.intentId, "bound", enrollmentId,
            PairingCredentialDto("Bearer", "rda_intermediate_must_not_publish", now.plusSeconds(900).toString(), "device-access")))))
        pc.enqueue(MockResponse().setBody(codec.encode(CreateDeviceChallengeResponse.serializer(), CreateDeviceChallengeResponse(last))))
        if (finalStatus == 200) pc.enqueue(MockResponse().setBody(codec.encode(VerifyDeviceChallengeResponse.serializer(),
            VerifyDeviceChallengeResponse(true, enrollmentId, VerifiedDeviceCredentialDto("Bearer", "rda_chain_final", now.plusSeconds(900).toString()),
                deviceP2P = DeviceP2PDto("chain-room", "a".repeat(64), "https://signal.fixture.invalid")))))
        else pc.enqueue(MockResponse().setResponseCode(finalStatus).setBody("""{"error":"revoked","code":"DEVICE_REVOKED"}"""))
        accounts.enqueue(MockResponse().setBody("""{"accountJoinGrant":"raj_chain_once","expiresAt":"${now.plusSeconds(60)}","intentId":"${intent.intentId}","instanceId":"$INSTANCE","deviceId":"$enrollmentId"}"""))
    }

    private fun challenge(suffix: String): DeviceChallengeDto {
        val id = "rdac_$suffix"; val nonce = "nonce_$suffix"
        return DeviceChallengeDto(id, enrollmentId, nonce,
            listOf("ragent-device-auth-v3", INSTANCE, enrollmentId, id, nonce, now.toString(), "ragent-device-access").joinToString("\n"),
            now.toString(), now.plusSeconds(60).toString(), "ragent-device-access", INSTANCE)
    }

    fun verifyCompletedTraffic() {
        check(pc.requestCount == 6); check(accounts.requestCount == 1)
        val requests = List(6) { checkNotNull(pc.takeRequest(2, TimeUnit.SECONDS)) }
        for (request in requests) {
            check(request.getHeader("Authorization") == null)
            check(!request.body.clone().readUtf8().contains(RAC))
        }
        for ((index, challenge) in listOf(1 to first, 5 to last)) {
            val proof = codec.decode(VerifyDeviceChallengeRequest.serializer(), requests[index].body.readUtf8())
            check(proof.deviceId == enrollmentId); verify(challenge.message, proof.signature)
        }
        val create = codec.decode(CreateAccountJoinIntentRequest.serializer(), requests[2].body.readUtf8())
        check(create.renewExistingDeviceId == enrollmentId)
        val completion = codec.decode(CompleteAccountJoinIntentRequest.serializer(), requests[3].body.readUtf8())
        check(completion.accountJoinGrant == "raj_chain_once")
        verify(buildAccountJoinIntentMessage(INSTANCE, intent.intentId, enrollmentId, intent.devicePublicKeyFingerprint,
            intent.nonce, intent.issuedAt), completion.deviceSignature)
        val accountRequest = checkNotNull(accounts.takeRequest(2, TimeUnit.SECONDS))
        check(accountRequest.getHeader("Authorization") == "Bearer $RAC")
        check(accountRequest.path == "/v1/owner-auth/account-intents/${intent.intentId}/authorize")
    }

    private fun verify(message: String, signature: String) {
        val encoded = identity.publicKeyEncoded().lineSequence().filterNot { it.startsWith("-----") }.joinToString("")
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(encoded)))
        check(Signature.getInstance("SHA256withECDSA").run {
            initVerify(key); update(message.toByteArray()); verify(Base64.getUrlDecoder().decode(signature))
        })
    }

    suspend fun close() {
        anonymous.close(); authenticated.close(); pc.shutdown(); accounts.shutdown()
    }
}
