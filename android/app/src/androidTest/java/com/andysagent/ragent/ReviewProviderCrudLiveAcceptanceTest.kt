package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Uses the real phone's account grant, only on the named isolated reviewer. */
class ReviewProviderCrudLiveAcceptanceTest {
    @Test fun fullPhoneGrantCanCreateEditAndRemoveItsOwnSyntheticProvider() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorProviderCrud") == "ADNQ6R5716008635")
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
        suspend fun api(method: String, path: String, body: JSONObject? = null): JSONObject =
            JSONObject(graph.executeOnTarget(target, ApiRequest(method, path, body?.toString())).body)
        val marker = "QA disposable provider " + java.util.UUID.randomUUID().toString()
        var createdId: String? = null
        try {
            val created = api("POST", "/api/native-providers", JSONObject().put("agentType", "codex")
                .put("displayName", marker).put("protocol", "responses").put("baseUrl", "https://invalid.example/v1")
                .put("apiKey", "qa-placeholder-not-a-real-secret").put("defaultModel", "qa-only")
                .put("discoverModels", false)).getJSONObject("provider")
            createdId = created.getString("id")
            assertEquals(marker, created.getString("displayName"))
            val changed = api("PATCH", "/api/native-providers/$createdId", JSONObject()
                .put("displayName", "$marker edited").put("enabled", false)).getJSONObject("provider")
            assertEquals("$marker edited", changed.getString("displayName"))
            assertFalse(changed.getBoolean("enabled"))
            instrumentation.sendStatus(2, Bundle().apply { putString("providerCrud", "created-edited-disabled-with-real-phone-grant") })
        } finally {
            val beforeCleanup = api("GET", "/api/native-providers").getJSONArray("providers")
            val ownedIds = (0 until beforeCleanup.length()).map { beforeCleanup.getJSONObject(it) }
                .filter { it.optString("displayName") == marker || it.optString("displayName") == "$marker edited" }
                .map { it.getString("id") }.toMutableSet()
            createdId?.let(ownedIds::add)
            ownedIds.forEach { id ->
                require(id.matches(Regex("^[A-Za-z0-9_-]+$")))
                check(api("DELETE", "/api/native-providers/$id").optBoolean("ok")) { "Synthetic Provider cleanup failed" }
            }
            if (ownedIds.isNotEmpty()) {
                val rows = api("GET", "/api/native-providers").getJSONArray("providers")
                assertTrue((0 until rows.length()).none { rows.getJSONObject(it).getString("id") in ownedIds })
                assertTrue((0 until rows.length()).any { rows.getJSONObject(it).getString("id") == "Review-Codex-Luna-258fa203" })
                instrumentation.sendStatus(2, Bundle().apply { putString("providerCrudCleanup", "synthetic-provider-removed-supplied-luna-preserved") })
            }
        }
    }
}