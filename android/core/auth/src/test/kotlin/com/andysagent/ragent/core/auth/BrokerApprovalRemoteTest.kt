package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.InvalidationHint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BrokerApprovalRemoteTest {
    @Test
    fun serviceApprovalPageAndDecisionUseDeviceBoundEndpoints() = runBlocking {
        val deviceId = "a".repeat(64)
        val pageTransport = RecordingTransport(ApiResponse(200,
            """{"type":"service_pending","hasMore":false,"items":[{"brokerPublicKey":"key","brokerSignature":"sig","grant":{"version":1,"keyId":"key","brokerInstallationId":"broker","policyGeneration":3,"requestId":"request","sessionId":"session","runId":"run","turnId":"turn","actionId":"action","nonce":"0123456789abcdefghijklmn","serviceName":"Example Service","action":"restart-service","definitionHash":"${"a".repeat(64)}","authorization":"owner","issuedMs":1800000000000,"expiresMs":1800000060000}}]}"""))
        val page = BrokerApprovalRemote(pageTransport).pendingServiceControls(deviceId, "cursor")
        assertEquals("Example Service", page.requests.single().grant.serviceName)
        assertEquals("/api/windows-privileged-broker/service-requests/pending?deviceId=$deviceId&cursor=cursor", pageTransport.requests.single().path)
        val decisionTransport = RecordingTransport(ApiResponse(200, """{"type":"result","requestId":"request","status":"denied"}"""))
        assertEquals("denied", BrokerApprovalRemote(decisionTransport).decideServiceControl("request", deviceId, "deny", "MEUCIQ==").status)
        assertEquals("""{"deviceId":"$deviceId","choice":"deny","deviceSignature":"MEUCIQ=="}""", decisionTransport.requests.single().body)
        assertEquals("/api/windows-privileged-broker/service-requests/request/decision", decisionTransport.requests.single().path)
    }

    @Test
    fun pendingPreservesServerRateLimitWhenAResponseIsReturnedDirectly() = runBlocking {
        val transport = RecordingTransport(ApiResponse(
            429,
            """{"code":"RATE_LIMITED","error":"wait"}""",
            headers = mapOf("Retry-After" to "9"),
        ))

        val error = assertFailsWith<ApiException> {
            BrokerApprovalRemote(transport).pending("a".repeat(64))
        }
        assertEquals(429, error.statusCode)
        assertEquals(9_000L, error.retryAfterMs)
        assertEquals("9", error.headers["Retry-After"])
    }

    @Test
    fun pendingPageUsesDeviceBoundRouteAndParsesCanonicalChallengeFields() = runBlocking {
        val transport = RecordingTransport(
            ApiResponse(
                200,
                """{"type":"pending","hasMore":false,"pendingRequests":[{"requestId":"req-1","status":"awaiting_device","brokerPublicKey":"broker-key","brokerSignature":"broker-signature","challenge":{"brokerInstallationId":"broker-1","ownerId":"owner-1","policyGeneration":7,"requestId":"req-1","operation":"service.restart","targetId":"Ragent-Broker-QA-Target","targetFingerprint":"${"a".repeat(64)}","sessionId":"session-1","runId":"run-1","turnId":"turn-1","actionId":"action-1","nonce":"nonce-1","createdAt":"2026-10-22T01:02:03.123456789Z","expiresAt":"2026-10-22T01:04:03.123456789Z"}}]}""",
            ),
        )

        val page = BrokerApprovalRemote(transport).pending("a".repeat(64), "cursor-1")

        assertEquals("GET", transport.requests.single().method)
        assertEquals(
            "/api/windows-privileged-broker/requests/pending?deviceId=${"a".repeat(64)}&cursor=cursor-1",
            transport.requests.single().path,
        )
        assertEquals("req-1", page.requests.single().requestId)
        assertEquals("Ragent-Broker-QA-Target", page.requests.single().challenge.targetId)
        assertEquals("broker-signature", page.requests.single().brokerSignature)
        assertEquals(null, page.revision, "older Hosts remain an immediate-snapshot fallback")
    }

    @Test
    fun pendingWaitKeepsTheDeviceBoundRouteAndRoundTripsTheOpaqueRevision() = runBlocking {
        val revision = "123e4567-e89b-42d3-a456-426614174000:7"
        val transport = RecordingTransport(ApiResponse(
            200,
            """{"type":"pending","hasMore":false,"pendingRequests":[],"revision":"$revision"}""",
        ))

        val page = BrokerApprovalRemote(transport).pending(
            deviceId = "b".repeat(64),
            afterRevision = revision,
            waitMs = 3_000,
        )

        assertEquals(revision, page.revision)
        assertEquals(
            "/api/windows-privileged-broker/requests/pending?deviceId=${"b".repeat(64)}" +
                "&afterRevision=${revision.replace(":", "%3A")}&waitMs=3000",
            transport.requests.single().path,
        )
        assertFailsWith<IllegalArgumentException> {
            BrokerApprovalRemote(transport).pending("b".repeat(64), afterRevision = revision, waitMs = 15_001)
        }
        val malformed = RecordingTransport(ApiResponse(
            200, """{"type":"pending","hasMore":false,"pendingRequests":[],"revision":"bad/token"}""",
        ))
        assertFailsWith<IllegalArgumentException> {
            BrokerApprovalRemote(malformed).pending("b".repeat(64))
        }
        Unit
    }

    @Test
    fun decisionRelaysOnlyTheDeviceSignatureMaterial() = runBlocking {
        val transport = RecordingTransport(ApiResponse(200, """{"type":"result","requestId":"req-1","status":"denied"}"""))

        val result = BrokerApprovalRemote(transport).decide(
            requestId = "req-1",
            deviceId = "b".repeat(64),
            choice = "deny",
            signature = "MEUCIQ==",
        )

        assertEquals("POST", transport.requests.single().method)
        assertEquals("/api/windows-privileged-broker/requests/req-1/decision", transport.requests.single().path)
        assertEquals(
            """{"deviceId":"${"b".repeat(64)}","choice":"deny","signature":"MEUCIQ=="}""",
            transport.requests.single().body,
        )
        assertEquals("denied", result.status)
    }

    @Test
    fun pendingEnrollmentUsesTheExistingDeviceIdAndParsesTheSignedChallenge() = runBlocking {
        val deviceId = "c".repeat(64)
        val transport = RecordingTransport(
            ApiResponse(
                200,
                """{"type":"enrollment_challenge","brokerPublicKey":"broker-key","brokerSignature":"broker-signature","enrollmentChallenge":{"enrollmentId":"enroll-1","brokerInstallationId":"broker-1","policyGeneration":3,"ownerId":"owner-1","deviceId":"$deviceId","publicKeyFingerprint":"$deviceId","nonce":"nonce-1","verificationCode":"12345678","createdAt":"2026-10-22T01:02:03Z","expiresAt":"2026-10-22T01:07:03Z"}}""",
            ),
        )

        val enrollment = BrokerApprovalRemote(transport).pendingEnrollment(deviceId)

        assertEquals("GET", transport.requests.single().method)
        assertEquals(
            "/api/windows-privileged-broker/enrollments/pending?deviceId=$deviceId",
            transport.requests.single().path,
        )
        assertEquals("enroll-1", enrollment.challenge.enrollmentId)
        assertEquals("12345678", enrollment.challenge.verificationCode)
        assertEquals("broker-signature", enrollment.brokerSignature)
    }

    @Test
    fun enrollmentCompletionSubmitsOnlyCodeAndDeviceSignature() = runBlocking {
        val transport = RecordingTransport(ApiResponse(200, """{"type":"result","code":"DEVICE_ENROLLED","deviceId":"${"d".repeat(64)}"}"""))

        val result = BrokerApprovalRemote(transport).completeEnrollment(
            enrollmentId = "enroll-1",
            verificationCode = "12345678",
            signature = "MEUCIQ==",
        )

        assertEquals("POST", transport.requests.single().method)
        assertEquals("/api/windows-privileged-broker/enrollments/enroll-1/complete", transport.requests.single().path)
        assertEquals(
            """{"verificationCode":"12345678","signature":"MEUCIQ=="}""",
            transport.requests.single().body,
        )
        assertEquals("${"d".repeat(64)}", result.deviceId)
    }

    private class RecordingTransport(private val response: ApiResponse) : RagentTransport {
        val requests = mutableListOf<ApiRequest>()
        override val invalidations: Flow<InvalidationHint> = kotlinx.coroutines.flow.emptyFlow()
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
        override suspend fun execute(request: ApiRequest): ApiResponse {
            requests += request
            return response
        }
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }
}
