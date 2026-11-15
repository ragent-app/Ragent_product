package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import kotlin.test.*

class DeviceCredentialRenewalTest {
    private val codec = ProtocolCodec()
    private val now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
    private fun challenge(instanceId: String = "pc-fixed") = DeviceChallengeDto(
        challengeId = "rdac_test", deviceId = "rdev_phone", nonce = "nonce_test",
        issuedAt = now.toString(), expiresAt = now.plusSeconds(60).toString(),
        audience = "ragent-device-access", instanceId = instanceId,
        message = listOf("ragent-device-auth-v3", instanceId, "rdev_phone", "rdac_test", "nonce_test",
            now.toString(), "ragent-device-access").joinToString("\n"),
    )
    private fun MockWebServer.challengeResponse(challenge: DeviceChallengeDto) = enqueue(MockResponse().setBody(
        codec.encode(CreateDeviceChallengeResponse.serializer(), CreateDeviceChallengeResponse(challenge))))
    private fun MockWebServer.credentialResponse(deviceId: String = "rdev_phone", p2p: DeviceP2PDto? = null) = enqueue(MockResponse().setBody(
        codec.encode(VerifyDeviceChallengeResponse.serializer(), VerifyDeviceChallengeResponse(true, deviceId,
            VerifiedDeviceCredentialDto("Bearer", "rda_renewed", now.plusSeconds(900).toString()), deviceP2P = p2p))))

    @Test fun `carrier renewal checks the same device and leaves the shared transport open`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore(); store.write("rda_old")
        val transport = OkHttpRagentTransport({ server.url("/").toString().trimEnd('/') }, { "rda_old" })
        try {
            server.challengeResponse(challenge()); server.credentialResponse(); server.enqueue(MockResponse().setBody("ok"))
            DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                .renewViaCarrier("pc-fixed", "rdev_phone", transport, PairingWriteGuard.Direct)
            assertEquals("rda_renewed", store.lastToken)
            assertEquals("ok", transport.execute(ApiRequest("GET", "/still-open")).body)
            server.challengeResponse(challenge())
            assertFailsWith<IllegalArgumentException> {
                DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                    .renewViaCarrier("pc-fixed", "rdev_other", transport, PairingWriteGuard.Direct)
            }
            assertEquals("rda_renewed", store.lastToken)
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun `challenge denial does not invalidate an existing bearer`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore(); store.write("rda_old")
        var rejected = 0
        val transport = OkHttpRagentTransport({ server.url("/").toString().trimEnd('/') }, { "rda_old" },
            onAuthenticationRequired = { rejected++ })
        try {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"DEVICE_REVOKED"}"""))
            assertFailsWith<ApiException> { DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                .renewViaCarrier("pc-fixed", "rdev_phone", transport, PairingWriteGuard.Direct) }
            assertEquals(0, rejected); assertEquals("rda_old", store.lastToken)
        } finally { transport.close(); server.shutdown() }
    }

    @Test fun `renewal signs the fixed target transcript without sending either bearer`() = runBlocking {
        val server = MockWebServer(); server.start()
        val identity = FakeDeviceIdentityStore(); val store = FakeCredentialStore()
        store.write(token = "rda_old", expiresAt = now.plusSeconds(600).toString(), scope = "device-access")
        try {
            val challenge = challenge(); server.challengeResponse(challenge); server.credentialResponse()
            var guardedTarget = ""
            DeviceCredentialRenewal(identity, store, now = { now }).renew("pc-fixed", server.url("/").toString(),
                PairingWriteGuard { id, writes -> guardedTarget = id; writes() })
            assertEquals("pc-fixed", guardedTarget); assertEquals("rda_renewed", store.lastToken)
            assertEquals("device-access", store.lastScope)
            val create = server.takeRequest(); val verify = server.takeRequest()
            assertNull(create.getHeader("Authorization")); assertNull(verify.getHeader("Authorization"))
            val createBody = codec.decode(CreateDeviceChallengeRequest.serializer(), create.body.readUtf8())
            assertEquals(identity.publicKeyEncoded(), createBody.devicePublicKey)
            val proof = codec.decode(VerifyDeviceChallengeRequest.serializer(), verify.body.readUtf8())
            val encoded = identity.publicKeyEncoded().lineSequence().filterNot { it.startsWith("-----") }.joinToString("")
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(encoded)))
            assertTrue(Signature.getInstance("SHA256withECDSA").run {
                initVerify(key); update(challenge.message.toByteArray()); verify(Base64.getUrlDecoder().decode(proof.signature))
            })
        } finally { server.shutdown() }
    }

    @Test fun `foreign malformed and expired challenges never reach the signing key`() = runBlocking {
        for (challenge in listOf(challenge("other-pc"), challenge().copy(message = "sign arbitrary bytes"),
            challenge().copy(expiresAt = now.toString()), challenge().copy(audience = "other-purpose"),
            challenge().copy(expiresAt = now.plusSeconds(61).toString()))) {
            val server = MockWebServer(); server.start(); val real = FakeDeviceIdentityStore(); var signed = false
            val identity = object : DeviceIdentityStore by real {
                override fun sign(message: String): String { signed = true; return real.sign(message) }
            }
            val store = FakeCredentialStore(); store.write("rda_current")
            try {
                server.challengeResponse(challenge)
                assertFailsWith<IllegalArgumentException> {
                    DeviceCredentialRenewal(identity, store, now = { now }).renew("pc-fixed", server.url("/").toString(), PairingWriteGuard.Direct)
                }
                assertFalse(signed); assertEquals(1, server.requestCount); assertEquals("rda_current", store.lastToken)
            } finally { server.shutdown() }
        }
    }

    @Test fun `revoked enrollment and ordinary denial cannot authorize an account upgrade`() = runBlocking {
        for ((status, code) in listOf(404 to "DEVICE_REVOKED", 401 to "owner_auth_authority_required",
            401 to "owner_auth_authority_upgrade_required", 401 to "owner_auth_authority_superseded")) {
            val server = MockWebServer(); server.start(); val store = FakeCredentialStore()
            try {
                server.challengeResponse(challenge())
                server.enqueue(MockResponse().setResponseCode(status).setBody("""{"code":"$code","error":"denied"}"""))
                val error = assertFailsWith<RuntimeException> {
                    DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                        .renew("pc-fixed", server.url("/").toString(), PairingWriteGuard.Direct)
                }
                assertEquals(code in setOf("owner_auth_authority_upgrade_required", "owner_auth_authority_superseded"),
                    DeviceCredentialRenewal.requiresAccountUpgrade(error))
                if (error is DeviceAuthorityUpgradeRequired) assertEquals("rdev_phone", error.deviceId)
                assertNull(store.lastToken)
            } finally { server.shutdown() }
        }
        assertFalse(DeviceCredentialRenewal.requiresAccountUpgrade(ApiException(503, "owner_auth_authority_upgrade_required", "old server")))
    }

    @Test fun `removed target cannot publish a successful renewal`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore()
        try {
            server.challengeResponse(challenge()); server.credentialResponse()
            assertFailsWith<CancellationException> {
                DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now }).renew("pc-fixed", server.url("/").toString(),
                    PairingWriteGuard { _, _ -> throw CancellationException("unpaired") })
            }
            assertNull(store.lastToken)
        } finally { server.shutdown() }
    }

    @Test fun `a credential issued for another device is never stored`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore()
        try {
            server.challengeResponse(challenge()); server.credentialResponse("rdev_other")
            assertFailsWith<IllegalArgumentException> {
                DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                    .renew("pc-fixed", server.url("/").toString(), PairingWriteGuard.Direct)
            }
            assertNull(store.lastToken)
        } finally { server.shutdown() }
    }

    @Test fun `renewal becomes due before expiry without extending the stored deadline`() {
        assertTrue(DeviceCredentialRenewal.isDue(null, now))
        assertTrue(DeviceCredentialRenewal.isDue(StoredCredential(now.plusSeconds(60).toString()), now))
        assertFalse(DeviceCredentialRenewal.isDue(StoredCredential(now.plusSeconds(61).toString()), now))
        assertFalse(DeviceCredentialRenewal.isDue(StoredCredential(), now))
        assertTrue(DeviceCredentialRenewal.isDue(StoredCredential("invalid"), now))
    }

    @Test fun `fresh signature restores cleared carrier material in the same guarded publication`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore()
        var stored: StoredP2PConfig? = null
        val secrets = object : P2PSecretStore {
            override fun read() = stored
            override fun write(config: StoredP2PConfig) { stored = config }
            override fun clear() { stored = null }
        }
        val material = DeviceP2PDto("room-fresh", "a".repeat(64), "https://signal.fixture.invalid")
        try {
            server.challengeResponse(challenge()); server.credentialResponse(p2p = material)
            var commits = 0
            DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, secrets, now = { now })
                .renew("pc-fixed", server.url("/").toString(), PairingWriteGuard { _, writes -> commits++; writes() })
            assertEquals(1, commits); assertEquals("rda_renewed", store.lastToken)
            assertEquals(StoredP2PConfig(material.signalingEndpoint, material.roomId, material.secret), stored)
        } finally { server.shutdown() }
    }

    @Test fun `invalid carrier material cannot partially publish a credential`() = runBlocking {
        val server = MockWebServer(); server.start(); val store = FakeCredentialStore()
        try {
            server.challengeResponse(challenge())
            server.credentialResponse(p2p = DeviceP2PDto("room", "bad-secret", "https://signal.fixture.invalid"))
            assertFailsWith<IllegalArgumentException> {
                DeviceCredentialRenewal(FakeDeviceIdentityStore(), store, now = { now })
                    .renew("pc-fixed", server.url("/").toString(), PairingWriteGuard.Direct)
            }
            assertNull(store.lastToken)
        } finally { server.shutdown() }
    }
}
