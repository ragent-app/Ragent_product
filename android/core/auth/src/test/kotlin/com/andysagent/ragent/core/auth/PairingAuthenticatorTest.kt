package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.protocol.RagentProtocol
import com.andysagent.ragent.core.protocol.AccountJoinIntentDto
import com.andysagent.ragent.core.protocol.CompleteAccountJoinIntentResponse
import com.andysagent.ragent.core.protocol.CreateAccountJoinIntentResponse
import com.andysagent.ragent.core.protocol.PairingCredentialDto
import com.andysagent.ragent.core.protocol.PairingInvitationDto
import com.andysagent.ragent.core.protocol.ProtocolCodec
import com.andysagent.ragent.core.protocol.RedeemPairingInvitationRequest
import com.andysagent.ragent.core.protocol.RedeemPairingInvitationResponse
import com.andysagent.ragent.core.protocol.TrustedDeviceDto
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.Base64
import java.security.Signature
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.X509EncodedKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.coroutines.CancellationException
import kotlin.test.assertTrue

class PairingAuthenticatorTest {
    private val codec = ProtocolCodec()

    @Test fun `account rendezvous reports quota denial without writing credentials`() = runBlocking {
        val credentials = FakeCredentialStore()
        val authorizer = object : AccountJoinGrantAuthorizer, AccountRendezvousAuthorizer {
            override suspend fun authorizeAccountJoin(intent: AccountJoinIntentDto, proof: AccountJoinAuthorizationProof): AccountJoinGrant =
                error("Direct authorization is not used")
            override suspend fun rendezvous(targetInstanceId: String, deviceName: String, accountClaimToken: String?,
                targetInstance: com.andysagent.ragent.core.protocol.AccountRendezvousTargetInstanceDto?, computerAlias: String) =
                AccountRendezvousHandoff("request", AccountJoinIntentDto(
                    intentId = "rji_test", instanceId = targetInstanceId, deviceId = "adev_test",
                    devicePublicKeyFingerprint = "fingerprint", nonce = "nonce",
                    issuedAt = "2026-09-28T00:00:00Z", expiresAt = "2099-09-28T00:00:00Z"),
                    buildJsonObject { put("error", buildJsonObject { put("code", "turn_connection_quota_exceeded") }) })
        }
        val authenticator = PairingAuthenticator(FakeDeviceIdentityStore(), credentials, null,
            accountJoinAuthorizer = authorizer, codec = codec)
        val failure = assertFailsWith<AccountSessionException> {
            authenticator.joinWithAccountRendezvous("inst_test", "Phone")
        }
        assertEquals(429, failure.statusCode)
        assertEquals("turn_connection_quota_exceeded", failure.code)
        assertEquals(false, failure.retryable)
        assertNull(credentials.lastToken)
    }

    @Test
    fun `QR claim auto-connects only for the first linked computer`() {
        assertTrue(shouldAutoConnectQrClaim(0))
        assertTrue(!shouldAutoConnectQrClaim(1))
        assertTrue(!shouldAutoConnectQrClaim(2))
        assertTrue(shouldAutoConnectQrClaim(2, existingTargetAutoConnect = true))
        assertTrue(!shouldAutoConnectQrClaim(2, existingTargetAutoConnect = false))
    }

    @Test
    fun `redeem with DeviceSignature challenge sends authVersion 3 and completes verify flow`() {
        val server = MockWebServer()
        server.start()
        try {
            val baseUrl = server.url("/")
            val endpoint = baseUrl.toString().trimEnd('/')
            val instanceId = "inst_test_1"
            val deviceId = "dev_test_1"
            val identity = FakeDeviceIdentityStore()
            val credentialStore = FakeCredentialStore()
            val authenticator = PairingAuthenticator(
                identity = identity,
                credentialStore = credentialStore,
                configStore = null,
                codec = codec,
            )

            // 1) Enqueue redeem response (DeviceSignature → will trigger challenge/verify)
            val redeemResponse = RedeemPairingInvitationResponse(
                instanceId = instanceId,
                endpoint = endpoint,
                device = TrustedDeviceDto(
                    id = deviceId,
                    deviceName = "TestDevice",
                    platform = "android",
                    authVersion = 3,
                    keyAlgorithm = "p256",
                ),
                credential = PairingCredentialDto(type = "DeviceSignature"),
            )
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<RedeemPairingInvitationResponse>(), redeemResponse))
                .addHeader("Content-Type", "application/json"))

            // 2) Enqueue challenge response (v3 with all fields)
            val challengeMessage = "ragent-device-auth-v3\n$instanceId\n$deviceId\nch_123\nnonce_abc\n2026-08-12T00:00:00Z\nragent-device-access"
            val challengeDto = com.andysagent.ragent.core.protocol.DeviceChallengeDto(
                challengeId = "ch_123",
                deviceId = deviceId,
                nonce = "nonce_abc",
                message = challengeMessage,
                issuedAt = "2026-08-12T00:00:00Z",
                expiresAt = "2026-08-12T00:01:00Z",
                audience = "ragent-device-access",
                instanceId = instanceId,
            )
            val challengeResponse = com.andysagent.ragent.core.protocol.CreateDeviceChallengeResponse(
                challenge = challengeDto,
            )
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<com.andysagent.ragent.core.protocol.CreateDeviceChallengeResponse>(), challengeResponse))
                .addHeader("Content-Type", "application/json"))

            // 3) Enqueue verify response with scope
            val verifyResponse = com.andysagent.ragent.core.protocol.VerifyDeviceChallengeResponse(
                verified = true,
                deviceId = deviceId,
                credential = com.andysagent.ragent.core.protocol.VerifiedDeviceCredentialDto(
                    type = "Bearer",
                    token = "rda_test_token_abc",
                    expiresAt = "2026-08-12T00:15:00Z",
                ),
            )
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<com.andysagent.ragent.core.protocol.VerifyDeviceChallengeResponse>(), verifyResponse))
                .addHeader("Content-Type", "application/json"))

            // Build pairing URI pointing at MockWebServer
            val pairingUri = buildPairingUri(
                endpoint = endpoint,
                instanceId = instanceId,
                version = 3,
            )

            val result = runBlocking {
                authenticator.redeem(pairingUri, "JVM Test Device")
            }

            assertEquals(instanceId, result.instanceId)
            assertEquals(endpoint, result.endpoint)
            assertEquals(deviceId, result.deviceId)
            assertEquals("Bearer", result.credentialType)
            assertEquals("2026-08-12T00:15:00Z", result.expiresAt)

            // Verify credential store was written with token
            assertEquals("rda_test_token_abc", credentialStore.lastToken)

            // Verify the redeem request sent authVersion=3
            val redeemRequest = server.takeRequest()
            assertEquals("POST", redeemRequest.method)
            assertEquals("/api/device-pairing/redeem", redeemRequest.requestUrl?.encodedPath)
            val redeemBody = codec.decode(
                serializer<RedeemPairingInvitationRequest>(),
                redeemRequest.body.readUtf8(),
            )
            assertEquals(3, redeemBody.authVersion)
            assertTrue(redeemBody.devicePublicKey.startsWith("-----BEGIN PUBLIC KEY-----"))
            assertTrue(redeemBody.devicePublicKey.contains("-----END PUBLIC KEY-----"))

            // Verify challenge request
            val challengeRequest = server.takeRequest()
            assertEquals("/api/device-auth/challenges", challengeRequest.requestUrl?.encodedPath)

            // Verify verify request body contains the signature over the challenge message
            val verifyRequest = server.takeRequest()
            assertEquals("/api/device-auth/verify", verifyRequest.requestUrl?.encodedPath)
            val verifyBody = codec.decode(
                serializer<com.andysagent.ragent.core.protocol.VerifyDeviceChallengeRequest>(),
                verifyRequest.body.readUtf8(),
            )
            assertEquals(deviceId, verifyBody.deviceId)
            assertEquals("ch_123", verifyBody.challengeId)
            assertEquals("nonce_abc", verifyBody.nonce)
            assertTrue(verifyBody.signature.isNotBlank())

            // Verify the signature was computed over the challenge message verbatim
            verifySignatureOverMessage(identity, challengeMessage, verifyBody.signature)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `redeem with Bearer credential skips challenge flow`() {
        val server = MockWebServer()
        server.start()
        try {
            val baseUrl = server.url("/")
            val endpoint = baseUrl.toString().trimEnd('/')
            val instanceId = "inst_bearer_test"
            val deviceId = "dev_bearer_test"
            val identity = FakeDeviceIdentityStore()
            val credentialStore = FakeCredentialStore()
            val authenticator = PairingAuthenticator(
                identity = identity,
                credentialStore = credentialStore,
                configStore = null,
                codec = codec,
            )

            // Redeem response with Bearer credential (rda_ token with scope)
            val redeemResponse = RedeemPairingInvitationResponse(
                instanceId = instanceId,
                endpoint = endpoint,
                device = TrustedDeviceDto(
                    id = deviceId,
                    deviceName = "BearerTestDevice",
                    platform = "android",
                    authVersion = 3,
                    keyAlgorithm = "p256",
                ),
                credential = PairingCredentialDto(
                    type = "Bearer",
                    token = "rda_bearer_token_xyz",
                    expiresAt = "2026-08-12T01:00:00Z",
                    scope = "device-access",
                ),
            )
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<RedeemPairingInvitationResponse>(), redeemResponse))
                .addHeader("Content-Type", "application/json"))

            val pairingUri = buildPairingUri(endpoint, instanceId, version = 3)

            val result = runBlocking {
                authenticator.redeem(pairingUri, "Bearer Test Device")
            }

            assertEquals(instanceId, result.instanceId)
            assertEquals("Bearer", result.credentialType)
            assertEquals("rda_bearer_token_xyz", credentialStore.lastToken)
            assertEquals("device-access", credentialStore.lastScope)
            assertEquals("device-access", result.credentialScope)

            // Only one request (redeem) — no challenge/verify
            assertEquals(1, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `account session grant creates and completes a signed account intent without exposing rac`() {
        verifyAccountJoinWriteGuard(rejectCredentialWrite = false)
    }

    @Test
    fun `a removed target guard rejects the final credential without persisting it`() {
        verifyAccountJoinWriteGuard(rejectCredentialWrite = true)
    }

    @Test
    fun `an automatic authority upgrade keeps the enrollment and publishes no directory or credential`() {
        verifyAccountJoinWriteGuard(rejectCredentialWrite = false, renewalOnly = true)
    }

    private fun verifyAccountJoinWriteGuard(rejectCredentialWrite: Boolean, renewalOnly: Boolean = false) {
        val server = MockWebServer()
        server.start()
        try {
            val endpoint = server.url("/").toString().trimEnd('/')
            val identity = FakeDeviceIdentityStore()
            val credentialStore = FakeCredentialStore()
            val fingerprint = devicePublicKeyFingerprint(identity.publicKeyEncoded())
            var authorizationProof: AccountJoinAuthorizationProof? = null
            val authorizer = object : AccountJoinGrantAuthorizer {
                override suspend fun authorizeAccountJoin(
                    intent: AccountJoinIntentDto,
                    proof: AccountJoinAuthorizationProof,
                ): AccountJoinGrant {
                    authorizationProof = proof
                    return AccountJoinGrant(
                        accountJoinGrant = "raj_one_time_grant",
                        expiresAt = "2099-08-14T00:01:00Z",
                        intentId = intent.intentId,
                        instanceId = intent.instanceId,
                        deviceId = intent.deviceId,
                    )
                }
            }
            val authenticator = PairingAuthenticator(
                identity = identity,
                credentialStore = credentialStore,
                configStore = null,
                accountJoinAuthorizer = authorizer,
                codec = codec,
            )

            val intent = AccountJoinIntentDto(
                intentId = "rji_join_test",
                instanceId = "rli_join_test",
                deviceId = "rdev_join_test",
                devicePublicKeyFingerprint = fingerprint,
                nonce = "join_nonce",
                issuedAt = "2026-08-14T00:00:00Z",
                expiresAt = "2099-08-14T00:02:00Z",
                instanceSignature = "instance-proof",
            )
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<CreateAccountJoinIntentResponse>(), CreateAccountJoinIntentResponse(intent)))
                .addHeader("Content-Type", "application/json"))
            server.enqueue(MockResponse()
                .setBody(codec.encode(serializer<CompleteAccountJoinIntentResponse>(), CompleteAccountJoinIntentResponse(
                    ok = true,
                    bound = true,
                    mode = "accounts",
                    intentId = intent.intentId,
                    deviceState = "bound",
                    deviceId = intent.deviceId,
                    credential = PairingCredentialDto(
                        type = "Bearer",
                        token = "rda_join_test",
                        expiresAt = "2099-08-14T00:15:00Z",
                        scope = "device-access",
                    ),
                )))
                .addHeader("Content-Type", "application/json"))

            var writeStages = 0
            val outcome = runCatching { runBlocking {
                authenticator.joinWithAccountSession(
                    endpoint,
                    "Pixel Join Test",
                    accountClaimToken = "rpi_scanned_account_claim",
                    writeGuard = PairingWriteGuard { actualId, writes ->
                        assertEquals(intent.instanceId, actualId)
                        writeStages++
                        if (rejectCredentialWrite && writeStages == 2) throw CancellationException("Target removed after authorization")
                        writes()
                    },
                    renewExistingDeviceId = if (renewalOnly) intent.deviceId else null,
                )
            } }
            if (rejectCredentialWrite) {
                assertTrue(outcome.exceptionOrNull() is CancellationException)
                assertEquals(2, writeStages)
                assertNull(credentialStore.lastToken)
                assertEquals(2, server.requestCount)
                return
            }
            val result = outcome.getOrThrow()

            assertEquals(intent.instanceId, result.instanceId)
            assertEquals(intent.deviceId, result.deviceId)
            assertEquals(if (renewalOnly) null else "rda_join_test", credentialStore.lastToken)
            assertEquals(2, server.requestCount)

            val createRequest = server.takeRequest()
            assertEquals("POST", createRequest.method)
            assertEquals("/api/device-pairing/account-intents", createRequest.requestUrl?.encodedPath)
            val createBody = codec.decode(
                serializer<com.andysagent.ragent.core.protocol.CreateAccountJoinIntentRequest>(),
                createRequest.body.readUtf8(),
            )
            assertEquals(identity.publicKeyEncoded(), createBody.devicePublicKey)
            assertEquals("rpi_scanned_account_claim", createBody.accountClaimToken)
            assertEquals(if (renewalOnly) intent.deviceId else null, createBody.renewExistingDeviceId)

            val completeRequest = server.takeRequest()
            assertEquals("POST", completeRequest.method)
            assertEquals("/api/device-pairing/account-intents/${intent.intentId}/complete", completeRequest.requestUrl?.encodedPath)
            assertTrue(completeRequest.getHeader("Idempotency-Key")?.isNotBlank() == true)
            val completeBody = codec.decode(
                serializer<com.andysagent.ragent.core.protocol.CompleteAccountJoinIntentRequest>(),
                completeRequest.body.readUtf8(),
            )
            assertEquals("raj_one_time_grant", completeBody.accountJoinGrant)
            assertEquals(intent.nonce, completeBody.nonce)
            assertTrue(completeBody.deviceSignature.isNotBlank())
            assertEquals(intent.nonce, authorizationProof?.nonce)
            assertEquals(intent.issuedAt, authorizationProof?.issuedAt)
            assertEquals(completeBody.deviceSignature, authorizationProof?.deviceSignature)
            verifySignatureOverMessage(
                identity,
                com.andysagent.ragent.core.protocol.buildAccountJoinIntentMessage(
                    instanceId = intent.instanceId,
                    intentId = intent.intentId,
                    deviceId = intent.deviceId,
                    devicePublicKeyFingerprint = intent.devicePublicKeyFingerprint,
                    nonce = intent.nonce,
                    issuedAt = intent.issuedAt,
                ),
                completeBody.deviceSignature,
            )
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `pairing URI v3 is accepted`() {
        val pairing = com.andysagent.ragent.core.protocol.parsePairingUri(
            "ragent://pair?v=3&instance=i3&endpoint=https%3A%2F%2Fexample.test%2F&token=rpi_fixture&expires=2099-01-01T00%3A00%3A00Z",
        )
        assertEquals(3, pairing.version)
        assertEquals("https://example.test/", pairing.endpoint)
    }

    private fun buildPairingUri(endpoint: String, instanceId: String, version: Int): String {
        val encodedEndpoint = java.net.URLEncoder.encode(endpoint, "UTF-8")
        return "ragent://pair?v=$version&instance=$instanceId&endpoint=$encodedEndpoint&token=rpi_test_token_123&expires=2099-01-01T00%3A00%3A00Z"
    }

    private fun verifySignatureOverMessage(identity: FakeDeviceIdentityStore, message: String, signatureBase64: String) {
        // Re-derive the public key from the PEM and verify the signature
        val pem = identity.publicKeyEncoded()
        val base64der = pem
            .removePrefix("-----BEGIN PUBLIC KEY-----")
            .removeSuffix("-----END PUBLIC KEY-----")
            .replace("\n", "")
            .replace("\r", "")
            .trim()
        val der = Base64.getDecoder().decode(base64der)
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(message.toByteArray(Charsets.UTF_8))
        val sig = Base64.getUrlDecoder().decode(signatureBase64)
        assertTrue(verifier.verify(sig), "Signature must verify against the challenge message")
    }

    private fun devicePublicKeyFingerprint(publicKey: String): String {
        val base64der = publicKey
            .lineSequence()
            .filterNot { it.startsWith("-----") }
            .joinToString("")
        val der = Base64.getDecoder().decode(base64der)
        return MessageDigest.getInstance("SHA-256").digest(der).joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        }
    }
}
