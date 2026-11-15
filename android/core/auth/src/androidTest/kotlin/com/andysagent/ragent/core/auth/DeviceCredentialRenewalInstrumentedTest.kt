package com.andysagent.ragent.core.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Real Android installation key and encrypted stores; the PC is a loopback fixture. */
@RunWith(AndroidJUnit4::class)
class DeviceCredentialRenewalInstrumentedTest {
    @Test fun realInstallationSignatureRenewsOnlyTheFixedTargetAndPersistsFreshCarrierMaterial() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val identity = AndroidDeviceIdentityStore(context)
        val credentials = AndroidCredentialStore(context)
        val secrets = AndroidP2PSecretStore(context)
        val target = "pc-renewal-${UUID.randomUUID()}"; val other = "$target-other"
        val now = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS)
        val challenge = DeviceChallengeDto("rdac_fixture", "rdev_fixture", "nonce_fixture",
            listOf("ragent-device-auth-v3", target, "rdev_fixture", "rdac_fixture", "nonce_fixture",
                now.toString(), "ragent-device-access").joinToString("\n"), now.toString(),
            now.plusSeconds(60).toString(), "ragent-device-access", target)
        val codec = ProtocolCodec()
        val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
        val executor = Executors.newSingleThreadExecutor()
        val responseMaterial = DeviceP2PDto("room-fixture", "a".repeat(64), "https://signal.fixture.invalid")
        val fixture = executor.submit<Unit> {
            repeat(2) { index ->
                server.accept().use { socket ->
                    socket.soTimeout = 10_000
                    val reader = socket.getInputStream().bufferedReader(Charsets.UTF_8)
                    val request = reader.readLine()
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = reader.readLine() ?: error("Truncated HTTP headers")
                        if (line.isEmpty()) break
                        headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                    }
                    assertNull(headers["authorization"])
                    val body = CharArray(headers["content-length"]!!.toInt()); var offset = 0
                    while (offset < body.size) {
                        val count = reader.read(body, offset, body.size - offset); check(count > 0); offset += count
                    }
                    val response = if (index == 0) {
                        assertTrue(request.startsWith("POST /api/device-auth/challenges "))
                        val create = codec.decode(CreateDeviceChallengeRequest.serializer(), String(body))
                        assertEquals(identity.publicKeyEncoded(), create.devicePublicKey)
                        codec.encode(CreateDeviceChallengeResponse.serializer(), CreateDeviceChallengeResponse(challenge))
                    } else {
                        assertTrue(request.startsWith("POST /api/device-auth/verify "))
                        val proof = codec.decode(VerifyDeviceChallengeRequest.serializer(), String(body))
                        assertEquals(challenge.deviceId, proof.deviceId); assertEquals(challenge.nonce, proof.nonce)
                        val der = identity.publicKeyEncoded().lineSequence().filterNot { it.startsWith("-----") }.joinToString("")
                        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(der)))
                        assertTrue(Signature.getInstance("SHA256withECDSA").run {
                            initVerify(key); update(challenge.message.toByteArray()); verify(Base64.getUrlDecoder().decode(proof.signature))
                        })
                        codec.encode(VerifyDeviceChallengeResponse.serializer(), VerifyDeviceChallengeResponse(true, challenge.deviceId,
                            VerifiedDeviceCredentialDto("Bearer", "rda_fixture_renewed", now.plusSeconds(900).toString()), deviceP2P = responseMaterial))
                    }
                    val bytes = response.toByteArray()
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray())
                    socket.getOutputStream().write(bytes); socket.getOutputStream().flush()
                }
            }
        }
        try {
            credentials.write(target, "rda_fixture_old", now.plusSeconds(300).toString(), "device-access")
            credentials.write(other, "rda_fixture_other", now.plusSeconds(300).toString(), "device-access")
            secrets.clear(target)
            var publications = 0
            DeviceCredentialRenewal(identity, credentials, secrets).renew(target, "http://127.0.0.1:${server.localPort}",
                PairingWriteGuard { instanceId, writes -> assertEquals(target, instanceId); publications++; writes() })
            fixture.get(10, TimeUnit.SECONDS)
            assertEquals(1, publications)
            assertEquals("rda_fixture_renewed", AndroidCredentialStore(context).readToken(target))
            assertEquals("device-access", AndroidCredentialStore(context).read(target)?.scope)
            assertEquals("rda_fixture_other", AndroidCredentialStore(context).readToken(other))
            assertEquals(StoredP2PConfig(responseMaterial.signalingEndpoint, responseMaterial.roomId, responseMaterial.secret),
                AndroidP2PSecretStore(context).read(target))
            assertEquals(identity.publicKeyEncoded(), AndroidDeviceIdentityStore(context).publicKeyEncoded())
        } finally {
            server.close(); fixture.cancel(true); executor.shutdownNow(); executor.awaitTermination(5, TimeUnit.SECONDS)
            credentials.clear(target); credentials.clear(other); secrets.clear(target)
        }
    }
}
