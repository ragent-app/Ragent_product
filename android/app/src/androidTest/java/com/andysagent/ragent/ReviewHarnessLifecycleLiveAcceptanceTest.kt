package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.feature.workbench.WebHarnessOperation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Real managed install/uninstall, opt-in after the isolated state-volume capacity check. */
class ReviewHarnessLifecycleLiveAcceptanceTest {
    @Test fun fullPhoneCanInstallAndRemoveAnAdditionalManagedHarness() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorHarnessLifecycle") == "ADNQ6R5716008635")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        instrumentation.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        val credential = graph.ensureAccountSession()
        assertEquals("full", credential.demoAccessMode)
        val target = "inst_246330d82153ae12c22ffff45f6e033b"
        check(graph.discoverAccountComputers().any { it.instanceId == target })
        withTimeout(40_000) { graph.ensureDemoComputerConnection(credential.accountId, target) }
        withTimeout(15_000) { graph.transport.connectionState.first { it == RuntimeConnectionState.Connected } }
        suspend fun harness(id: String): JSONObject {
            val rows = JSONObject(graph.executeOnTarget(target, ApiRequest("GET", "/api/harnesses?refresh=1")).body).getJSONArray("harnesses")
            return (0 until rows.length()).map { rows.getJSONObject(it) }.single { it.getString("id") == id }
        }
        assumeTrue("Never uninstall an existing user installation", !harness("claude").optBoolean("installed"))
        check(harness("codex").optBoolean("installed"))
        var ownsInstallation = false
        try {
            ownsInstallation = true
            val install = withTimeout(180_000) { graph.mutateHarnessOnTargets("claude", WebHarnessOperation.Install, listOf(target)) }
            assertEquals(1, install.size)
            assertTrue(install.single().error ?: "Managed install failed", install.single().success)
            val installed = harness("claude")
            assertTrue(installed.optBoolean("installed"))
            assertTrue(installed.optBoolean("available"))
            instrumentation.sendStatus(2, Bundle().apply { putString("harnessLifecycle", "claude-installed-and-command-verified-through-phone-grant") })
        } finally {
            if (ownsInstallation) {
                val cleanup = withTimeout(180_000) { graph.mutateHarnessOnTargets("claude", WebHarnessOperation.Uninstall, listOf(target)) }
                assertTrue(cleanup.single().error ?: "Managed uninstall failed", cleanup.single().success)
                assertFalse(harness("claude").optBoolean("installed"))
                assertTrue(harness("codex").optBoolean("installed"))
                instrumentation.sendStatus(2, Bundle().apply { putString("harnessCleanup", "claude-uninstalled-codex-preserved") })
            }
        }
    }
}