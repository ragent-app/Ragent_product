package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.P2PProtocol
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.protocol.TemporaryAccessProtocol
import com.andysagent.ragent.core.protocol.TemporaryConnectionProtocol
import com.andysagent.ragent.core.protocol.TemporaryPairingEnvelope
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import java.io.ByteArrayInputStream
import java.security.MessageDigest

class TemporaryCarrierApiTest {
    private val fixture = Json.parseToJsonElement(javaClass.getResource("/fixtures/temporary-access-signed.json")!!.readText()).jsonObject
    private val envelope = Json.decodeFromString<TemporaryPairingEnvelope>(fixture.getValue("envelope").toString())
    private val claimJson = fixture.getValue("claim").jsonObject
    private val claim = TemporaryAccessProtocol.Claim(
        claimJson.getValue("instanceId").jsonPrimitive.content, claimJson.getValue("invitationId").jsonPrimitive.content,
        claimJson.getValue("invitationDigest").jsonPrimitive.content, claimJson.getValue("requestId").jsonPrimitive.content,
        claimJson.getValue("devicePublicKey").jsonPrimitive.content, claimJson.getValue("token").jsonPrimitive.content,
        claimJson.getValue("signature").jsonPrimitive.content)
    private val now = fixture.getValue("now").jsonPrimitive.content.toLong() + 22_000
    private val completion = TemporaryAccessProtocol.verifyCompletion(fixture.getValue("completion").toString(),
        envelope, claim, envelope.invitation.instanceId, envelope.invitation.instanceKeyFingerprint, now)
    private val connection = TemporaryConnectionProtocol.verifyDelivery(fixture.getValue("delivery").toString(),
        envelope, claim, completion, fixture.getValue("connectionRequestId").jsonPrimitive.content, now)
    private val device = object : DeviceIdentityStore {
        private val key = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(
            Base64.getDecoder().decode(fixture.getValue("testOnlyDevicePrivateKeyPkcs8").jsonPrimitive.content)))
        override fun publicKeyEncoded() = claim.devicePublicKey
        override fun sign(message: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
            Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(message.toByteArray()) }.sign())
        override fun clear() = Unit
    }

    private class Carrier : P2PSession {
        override var isOpen = false
        val requests = mutableListOf<P2PHttpRequest>()
        var responseBody = "{\"ok\":true}"
        override suspend fun connect(): Result<Unit> { isOpen = true; return Result.success(Unit) }
        override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
            requests += request
            return Result.success(P2PHttpResponse(request.id, status = 200,
                bodyBase64 = P2PProtocol.encodeBody(responseBody)))
        }
        override suspend fun requestStream(request: P2PHttpRequest, totalBytes: Long, sha256: String,
            openBody: () -> java.io.InputStream,
            onProgress: (sentBytes: Long, totalBytes: Long) -> Unit): Result<P2PHttpResponse> {
            requests += request
            val bytes = openBody().use { it.readBytes() }
            assertEquals(totalBytes, bytes.size.toLong())
            assertEquals(sha256, MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it) })
            onProgress(totalBytes, totalBytes)
            return Result.success(P2PHttpResponse(request.id, status = 200,
                bodyBase64 = P2PProtocol.encodeBody(responseBody)))
        }
        override fun close() { isOpen = false }
    }

    @Test fun `temporary runtime discovery is scoped to the verified computer and never carries owner auth`() = runBlocking {
        val carrier = Carrier()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { carrier }, this, { now })
        connector.connect(connection)
        carrier.responseBody = """{"version":1,"runtimes":[{"id":"claude-bidi","name":"Claude Code","ready":true,"status":"ready"}]}"""
        val api = TemporaryCarrierApi(connector, connection, completion, device, { now })
        assertEquals(listOf(TemporaryRuntimeOption("claude-bidi", "Claude Code", true, "ready")), api.listRuntimes())
        val request = carrier.requests.single()
        assertEquals("GET", request.method)
        assertEquals("/api/temporary/v1/instances/${connection.instanceId}/runtimes", request.path)
        assertEquals(null, request.headers["X-Ragent-App-Api-Scope"])
        assertEquals("DPoP ${completion.credential.accessToken}", request.headers["Authorization"])
        assertTrue(request.headers["DPoP"].orEmpty().split('.').size == 3)
        connector.stop()
    }

    @Test fun `control transport keeps workbench requests on its authenticated carrier`() = runBlocking {
        val carrier = Carrier()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { carrier }, this, { now })
        connector.connect(connection)
        val grant = TemporaryControlProtocol.VerifiedGrant(completion.grant.grantId, connection.deviceId,
            completion.credential.accessToken, connection.expiresAt, now - 1_000)
        val transport = TemporaryControlTransport(connector, connection, grant, device, this, { now })
        transport.execute(ApiRequest("GET", "/api/native-providers?tool=codex", headers = mapOf("Cookie" to "secret")))
        val request = carrier.requests.single()
        assertEquals("/api/temporary-control/v1/instances/${connection.instanceId}/providers?tool=codex", request.path)
        assertEquals(null, request.headers["Cookie"])
        assertEquals("DPoP ${grant.accessToken}", request.headers["Authorization"])
        val parts = assertNotNull(request.headers["DPoP"]).split('.')
        val claims = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(parts[1]))).jsonObject
        assertEquals("https://temporary-control.ragent.invalid" + request.path.substringBefore('?'), claims.getValue("htu").jsonPrimitive.content)
        transport.close()
        assertTrue(!carrier.isOpen)
    }

    @Test fun `temporary request travels only on original relay with fresh DPoP and scope`() = runBlocking {
        val carrier = Carrier()
        val candidates = mutableListOf<P2PCandidate>()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { candidates += it; carrier }, this, { now })
        connector.connect(connection)
        val api = TemporaryCarrierApi(connector, connection, completion, device, { now })
        val body = JsonObject(mapOf("idempotencyKey" to JsonPrimitive("idem-test"),
            "tool" to JsonPrimitive("codex")))
        assertEquals("true", api.createSession(body).getValue("ok").jsonPrimitive.content)
        val first = carrier.requests.single()
        assertTrue(candidates.single().turnOnly)
        assertEquals("POST", first.method)
        assertEquals("/api/temporary/v1/instances/${connection.instanceId}/sessions", first.path)
        assertEquals("DPoP ${completion.credential.accessToken}", first.headers["Authorization"])
        assertEquals(null, first.headers["X-Ragent-App-Api-Scope"])
        assertEquals(body, Json.parseToJsonElement(P2PProtocol.decodeBodyToString(first.bodyBase64)))
        val proof = assertNotNull(first.headers["DPoP"]).split('.')
        val claims = Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(proof[1]))).jsonObject
        assertEquals(TemporaryAccessProtocol.LOGICAL_ORIGIN + first.path, claims.getValue("htu").jsonPrimitive.content)
        val scope = TemporarySessionScope("session-test", "12345678-1234-1234-1234-123456789abc", null)
        api.runStatus(scope, "run-test")
        val second = carrier.requests.last()
        assertEquals("GET", second.method)
        assertEquals("/api/temporary/v1/instances/${connection.instanceId}/sessions/session-test/runs/run-test", second.path)
        val decodedScope = String(Base64.getUrlDecoder().decode(assertNotNull(second.headers["X-Ragent-App-Api-Scope"])))
        assertEquals(scope.sessionId, Json.parseToJsonElement(decodedScope).jsonObject.getValue("sessionId").jsonPrimitive.content)
        assertTrue(first.headers["DPoP"] != second.headers["DPoP"])
        connector.stop()
    }

    @Test fun `expired or wrong carrier never sends a business request`() = runBlocking {
        val carrier = Carrier()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { carrier }, this, { now })
        connector.connect(connection)
        val api = TemporaryCarrierApi(connector, connection, completion, device,
            { connection.expiresAt })
        assertFailsWith<IllegalArgumentException> {
            api.createSession(JsonObject(emptyMap()))
        }
        assertTrue(carrier.requests.isEmpty())
        connector.stop()
    }

    @Test fun `resumable upload methods remain on the scoped P2P route with fresh DPoP`() = runBlocking {
        val carrier = Carrier()
        val connector = TemporaryCarrierConnector(P2PSessionFactory { carrier }, this, { now })
        connector.connect(connection)
        val api = TemporaryCarrierApi(connector, connection, completion, device, { now })
        val scope = TemporarySessionScope("session-test", "12345678-1234-1234-1234-123456789abc", null)
        val assetId = "fasset_0123456789abcdef01234567"
        carrier.responseBody = """{"uploadCheckpointVersion":1,"assetId":"$assetId","offset":0,"totalBytes":5,"sha256":"${"0".repeat(64)}","status":"uploading"}"""
        api.uploadCheckpoint(scope, assetId)
        val read = carrier.requests.last()
        assertEquals("GET", read.method)
        assertEquals("/api/temporary/v1/instances/${connection.instanceId}/sessions/session-test/assets/$assetId/upload-checkpoint", read.path)
        carrier.responseBody = """{"uploadCheckpointVersion":1,"assetId":"$assetId","offset":5,"totalBytes":5,"sha256":"${"0".repeat(64)}","status":"uploaded"}"""
        val bytes = "hello".toByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        api.uploadChunk(scope, assetId, 0, TemporaryAttachmentBodySource("req", "a.txt", "text/plain", 5,
            digest, { ByteArrayInputStream(bytes) }))
        val patch = carrier.requests.last()
        assertEquals("PATCH", patch.method)
        assertEquals("0", patch.headers["X-Ragent-Upload-Offset"])
        assertEquals("5", patch.headers["X-Ragent-Upload-Length"])
        assertEquals(digest, patch.headers["X-Ragent-Upload-Sha256"])
        assertEquals(null, patch.headers["Cookie"])
        assertTrue(patch.headers["DPoP"] != read.headers["DPoP"])
        assertEquals(TemporaryAccessProtocol.LOGICAL_ORIGIN + patch.path,
            Json.parseToJsonElement(String(Base64.getUrlDecoder().decode(patch.headers.getValue("DPoP").split('.')[1])))
                .jsonObject.getValue("htu").jsonPrimitive.content)
        carrier.responseBody = """{"uploadCheckpointVersion":1,"assetId":"$assetId","offset":5,"totalBytes":5,"sha256":"$digest","status":"cancelled"}"""
        assertEquals("1", api.cancelUpload(scope, assetId).getValue("uploadCheckpointVersion").jsonPrimitive.content)
        assertEquals("DELETE", carrier.requests.last().method)
        connector.stop()
    }
}
