package com.andysagent.ragent.feature.workbench

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.auth.AndroidDeviceIdentityStore
import com.andysagent.ragent.core.auth.BrokerApprovalProtocol
import com.andysagent.ragent.core.auth.BrokerApprovalRemote
import com.andysagent.ragent.core.auth.BrokerPendingEnrollment
import com.andysagent.ragent.core.auth.WindowsServiceControlApproval
import com.andysagent.ragent.core.auth.WindowsServicePendingApproval
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiResponse
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Isolated opt-in fixture: the owner and service are test-only. */
@RunWith(AndroidJUnit4::class)
class WindowsBrokerLiveUiDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun tappingApprovalExecutesTheExactReviewedService() = runBlocking {
        val port = InstrumentationRegistry.getArguments().getString("ragentBrokerTestPort")?.toIntOrNull()
        assumeTrue(port != null && port in 1025..65535)
        val identity = AndroidDeviceIdentityStore(rule.activity)
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
        assertEquals(200, request("POST", "/register", JSONObject().put("deviceId", deviceId).put("publicKey", publicKey).toString()).first)
        val remote = BrokerApprovalRemote { api -> request(api.method, api.path, api.body).let { ApiResponse(it.first, it.second) } }
        val deadline = System.nanoTime() + 80_000_000_000L
        var enrollment: BrokerPendingEnrollment? = null
        while (System.nanoTime() < deadline && enrollment == null) {
            try { enrollment = remote.pendingEnrollment(deviceId) }
            catch (error: ApiException) { if (error.statusCode != 503) throw error; Thread.sleep(100) }
        }
        val enrolled = requireNotNull(enrollment)
        val challenge = enrolled.challenge
        assertEquals(deviceId, challenge.deviceId)
        assertEquals(BrokerApprovalProtocol.expectedEnrollmentCode(challenge), challenge.verificationCode)
        assertTrue(BrokerApprovalProtocol.verifyBrokerSignature(enrolled.brokerPublicKey, enrolled.brokerSignature,
            BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(challenge)))
        val pinnedFingerprint = BrokerApprovalProtocol.fingerprint(enrolled.brokerPublicKey)
        assertEquals(deviceId, remote.completeEnrollment(challenge.enrollmentId, challenge.verificationCode,
            identity.signBrokerBytes(BrokerApprovalProtocol.deviceEnrollmentSignatureBytes(challenge))).deviceId)

        var pending: WindowsServicePendingApproval? = null
        while (System.nanoTime() < deadline && pending == null) {
            pending = remote.pendingServiceControls(deviceId).requests.singleOrNull()
            if (pending == null) Thread.sleep(100)
        }
        val review = requireNotNull(pending)
        val grant = review.grant
        assertTrue(WindowsServiceControlApproval.verifyBrokerReview(grant, review.brokerPublicKey, review.brokerSignature, pinnedFingerprint))
        assertEquals("start-service", grant.action)
        assertTrue(grant.serviceName.startsWith("Ragent-QA-Service-"))
        val approval = Approval(id = grant.requestId, sessionId = grant.sessionId, runId = grant.runId,
            title = "Start Windows test service", reason = grant.serviceName, status = "pending",
            kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND, riskLevel = "privileged", passkeyRequired = false,
            brokerTargetInstanceId = "test-computer", brokerChallengeDigest = "test-digest")
        val state = AttentionReducer.reduce(AttentionUiState(visibleSessionId = grant.sessionId),
            AttentionReducer.projectBrokerApprovals(listOf(approval))).copy(expanded = true)
        val events = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme { AttentionSurface(state, events::add, onOpenSession = {}) } }
        rule.onNodeWithTag("attention-headline").assertIsDisplayed()
        val approve = rule.activity.getString(R.string.attention_approve)
        rule.onNodeWithText(approve).assertIsDisplayed()
        rule.waitForIdle()
        Thread.sleep(750)
        val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val output = File(requireNotNull(rule.activity.getExternalFilesDir(null)), "windows-broker-live-approval.png")
        output.outputStream().use { assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        screenshot.recycle()
        rule.onNodeWithText(approve).performClick()
        rule.runOnIdle { assertEquals(listOf<AttentionEvent>(AttentionEvent.ResolveApproval(requireNotNull(state.activeItemId), true)), events) }
        val signature = identity.signBrokerBytes(WindowsServiceControlApproval.ownerSigningBytes(grant))
        assertTrue(remote.decideServiceControl(grant.requestId, deviceId, "approve", signature).status in setOf("executing", "succeeded"))
    }
}
