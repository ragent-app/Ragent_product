package com.andysagent.ragent

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Real one-time desktop invitation and normal app deep-link onboarding; not an optical camera test. */
class ReviewQrAccountLiveAcceptanceTest {
    @Test fun signedOutReviewerCanAuthorizeThroughDesktopPairingInvitation() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorQrAccount") == "ADNQ6R5716008635")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        val target = "inst_246330d82153ae12c22ffff45f6e033b"
        val input = File(app.getExternalFilesDir(null), "review-qr-invitation.json")
        val invitation = JSONObject(input.readText())
        val uri = invitation.getString("pairingUri")
        val parsed = Uri.parse(uri)
        assertEquals("ragent", parsed.scheme)
        assertEquals("pair", parsed.host)
        assertEquals("4", parsed.getQueryParameter("v"))
        assertTrue("Invitation too close to expiry", java.time.Instant.parse(invitation.getString("expiresAt")).toEpochMilli() > System.currentTimeMillis() + 60_000)
        val before = graph.ensureAccountSession()
        assertTrue(before.accountId.matches(Regex("^acct_demo_[a-f0-9]{48}$")))
        assertEquals("full", before.demoAccessMode)
        // A repair rerun may start with the generic enrollment created by the
        // failing old client. Pin the previously observed password enrollment.
        val expectedDeviceId = InstrumentationRegistry.getArguments().getString("expectedReviewDeviceId") ?: before.deviceId
        assertTrue(expectedDeviceId.matches(Regex("^adev_demo_[a-f0-9]{48}$")))
        input.delete()
        var stage = "logout"
        fun report(value: String) = instrumentation.sendStatus(2, Bundle().apply { putString("qrAccountStage", value) })
        try {
            assertTrue(withTimeout(20_000) { graph.logoutAccountSession() })
            assertNull(graph.configStore.accountSession.first())
            report("ordinary-logout-confirmed")
            stage = "desktop-account-onboarding"
            instrumentation.runOnMainSync {
                app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri), app, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            }
            withTimeout(55_000) { graph.configStore.accountSession.first { it?.accountId == before.accountId } }
            val restored = graph.ensureAccountSession()
            assertEquals("full", restored.demoAccessMode)
            assertEquals(expectedDeviceId, restored.deviceId)
            report("same-account-phone-key-and-full-presentation-restored")
            stage = "automatic-target-connection"
            withTimeout(30_000) { graph.configStore.directory.first { it.activeTargetId == target } }
            withTimeout(30_000) { graph.transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            val providers = JSONObject(graph.executeOnTarget(target, ApiRequest("GET", "/api/native-providers")).body).getJSONArray("providers")
            assertTrue((0 until providers.length()).any { providers.getJSONObject(it).optString("id") == "Review-Codex-Luna-258fa203" })
            report("automatic-full-target-carrier-and-protected-provider-confirmed")
        } catch (error: Exception) {
            throw AssertionError("Review QR acceptance failed at $stage [${error.javaClass.simpleName}]")
        } finally {
            input.delete()
            val evidence = File(app.cacheDir, "review-qr-account").apply { mkdirs() }
            UiDevice.getInstance(instrumentation).takeScreenshot(File(evidence, "final.png"))
        }
    }
}
