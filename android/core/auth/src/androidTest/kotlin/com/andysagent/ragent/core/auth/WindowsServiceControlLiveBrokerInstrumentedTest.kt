package com.andysagent.ragent.core.auth

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiResponse
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in, isolated loopback fixture; it never uses the installed app's identity. */
@RunWith(AndroidJUnit4::class)
class WindowsServiceControlLiveBrokerInstrumentedTest {
    @Test fun androidKeyApprovesTheReviewedBrokerGrant() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val port = InstrumentationRegistry.getArguments().getString("ragentBrokerTestPort")?.toIntOrNull()
        assumeTrue(port != null && port in 1025..65535)
        val identity = AndroidDeviceIdentityStore(instrumentation.targetContext)
        val publicKey = identity.brokerPublicKey()
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(publicKey)
        fun request(method: String, route: String, body: String? = null): Pair<Int, String> {
            val connection = URL("http://127.0.0.1:$port$route").openConnection() as HttpURLConnection
            connection.requestMethod = method
            connection.connectTimeout = 3_000
            connection.readTimeout = 3_000
            try {
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                return status to stream.bufferedReader().use { it.readText() }
            } finally { connection.disconnect() }
        }
        val registration = JSONObject().put("deviceId", deviceId).put("publicKey", publicKey)
        assertEquals(200, request("POST", "/register", registration.toString()).first)
        val remote = BrokerApprovalRemote { apiRequest ->
            val result = request(apiRequest.method, apiRequest.path, apiRequest.body)
            ApiResponse(result.first, result.second)
        }
        val deadline = System.nanoTime() + 80_000_000_000L
        var enrollment: BrokerPendingEnrollment? = null
        while (System.nanoTime() < deadline && enrollment == null) {
            try { enrollment = remote.pendingEnrollment(deviceId) }
            catch (error: ApiException) { if (error.statusCode != 503) throw error; Thread.sleep(100) }
        }
        val pendingEnrollment = requireNotNull(enrollment) { "Timed out waiting for isolated device enrollment" }
        val enrollmentChallenge = pendingEnrollment.challenge
        assertEquals(deviceId, enrollmentChallenge.deviceId)
        assertEquals(BrokerApprovalProtocol.expectedEnrollmentCode(enrollmentChallenge), enrollmentChallenge.verificationCode)
        assertTrue(BrokerApprovalProtocol.verifyBrokerSignature(
            pendingEnrollment.brokerPublicKey, pendingEnrollment.brokerSignature,
            BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(enrollmentChallenge),
        ))
        val enrollmentSignature = identity.signBrokerBytes(BrokerApprovalProtocol.deviceEnrollmentSignatureBytes(enrollmentChallenge))
        assertEquals(deviceId, remote.completeEnrollment(enrollmentChallenge.enrollmentId, enrollmentChallenge.verificationCode, enrollmentSignature).deviceId)
        var review: WindowsServicePendingApproval? = null
        while (System.nanoTime() < deadline && review == null) {
            review = remote.pendingServiceControls(deviceId).requests.singleOrNull()
            if (review == null) Thread.sleep(100)
        }
        val result = requireNotNull(review) { "Timed out waiting for isolated broker review" }
        val grant = result.grant
        val brokerKey = result.brokerPublicKey
        assertTrue(WindowsServiceControlApproval.verifyBrokerReview(
            grant, brokerKey, result.brokerSignature, BrokerApprovalProtocol.fingerprint(brokerKey),
        ))
        assertEquals("start-service", grant.action)
        assertTrue(grant.serviceName.startsWith("Ragent-QA-Service-"))
        val signature = identity.signBrokerBytes(WindowsServiceControlApproval.ownerSigningBytes(grant))
        val decision = remote.decideServiceControl(grant.requestId, deviceId, "approve", signature)
        assertTrue(decision.status in setOf("executing", "succeeded"))
    }
}
