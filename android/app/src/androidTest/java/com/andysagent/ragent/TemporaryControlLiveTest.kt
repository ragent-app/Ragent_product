package com.andysagent.ragent

import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.andysagent.ragent.core.auth.devicePublicKeyFingerprint
import com.andysagent.ragent.core.auth.AndroidTemporaryControlClaimJournal
import com.andysagent.ragent.core.auth.TemporaryControlPairingClient
import com.andysagent.ragent.core.auth.TemporaryControlTransport
import com.andysagent.ragent.core.auth.TemporaryCarrierConnector
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.protocol.TemporaryControlProtocol
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in actual phone -> deployed Accounts/TURN -> installed Windows acceptance. */
@RunWith(AndroidJUnit4::class)
class TemporaryControlLiveTest {
    @Test fun signedOutControlManagesWorkbenchAndExpires(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveTemporaryControl") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val runtime = app.runtime
        assertNull("Keep existing account sessions; this test requires a signed-out phone", runtime.configStore.accountSession.first())
        val originalDirectory = runtime.configStore.directory.first()
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/ragent-temporary-control-ticket.json")
        val ticket = ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes().toString(Charsets.UTF_8) }.trim()
        val invitation = requireNotNull(TemporaryControlProtocol.parseIfControl(ticket, System.currentTimeMillis())).envelope.invitation
        instrumentation.sendStatus(1, Bundle().apply {
            putString("temporaryControlDeviceFingerprint", devicePublicKeyFingerprint(runtime.identityStore.publicKeyEncoded()))
        })
        Log.i("TemporaryControlLiveQA", "claim-starting")
        withTimeout(180_000) { runtime.connectTemporaryControl(ticket) }
        assertTrue(runtime.temporaryControlActive.value)
        val transport = requireNotNull(runtime.transport.delegate.value)
        val broker = OkHttpRagentTransport(endpointProvider = { app.getString(R.string.accounts_directory_base_url).trimEnd('/') }, credentialProvider = { null })
        val grant = requireNotNull(TemporaryControlPairingClient(broker, runtime.identityStore,
            AndroidTemporaryControlClaimJournal(app)).poll(invitation.instanceId))
        // JWT NumericDate expires on a whole second and never exceeds the
        // exact desktop-confirmation deadline carried by the registry grant.
        assertTrue(grant.expiresAt - grant.grantedAt in 599_001L..600_000L)
        Log.i("TemporaryControlLiveQA", "carrier-ready;deadline=${grant.expiresAt}")
        suspend fun api(method: String, path: String, body: String? = null): JsonObject {
            val response = transport.execute(ApiRequest(method, path, body))
            assertTrue("$method $path returned ${response.statusCode}", response.statusCode in 200..299)
            return Json.parseToJsonElement(response.body).jsonObject
        }
        val marker = "Temporary-control-QA-${System.currentTimeMillis()}"
        val root = requireNotNull(args.getString("liveProjectRoot"))
        var projectId: String? = null; var sessionId: String? = null; var providerId: String? = null
        try {
            api("GET", "/api/projects"); api("GET", "/api/sessions"); api("GET", "/api/harnesses")
            api("GET", "/api/native-providers")
            projectId = api("POST", "/api/projects", JsonObject(mapOf("name" to kotlinx.serialization.json.JsonPrimitive(marker),
                "rootPath" to kotlinx.serialization.json.JsonPrimitive(root))).toString()).getValue("project").jsonObject.getValue("id").jsonPrimitive.content
            api("PATCH", "/api/projects/$projectId", """{"name":"$marker-renamed"}""")
            assertEquals("$marker-renamed", api("GET", "/api/projects/$projectId").getValue("project").jsonObject.getValue("name").jsonPrimitive.content)
            sessionId = api("POST", "/api/sessions", """{"projectId":"$projectId","name":"$marker","tool":"codex"}""")
                .getValue("session").jsonObject.getValue("id").jsonPrimitive.content
            api("PATCH", "/api/sessions/$sessionId", """{"name":"$marker-renamed"}""")
            api("GET", "/api/sessions/$sessionId")
            providerId = api("POST", "/api/native-providers", """{"agentType":"codex","displayName":"$marker","baseUrl":"https://example.invalid/v1","apiKey":"qa-placeholder-not-a-real-secret","discoverModels":false}""")
                .getValue("provider").jsonObject.getValue("id").jsonPrimitive.content
            api("PATCH", "/api/native-providers/$providerId", """{"displayName":"$marker-renamed"}""")
            Log.i("TemporaryControlLiveQA", "project-session-provider-crud-ready;harness-catalog-ready")
            if (args.getString("liveTemporaryControlRecovery") == "true") {
                // Close the real native WebRTC carrier without changing phone
                // network settings, then exercise the production recovery path.
                val control = transport as TemporaryControlTransport
                val connectorField = TemporaryControlTransport::class.java.getDeclaredField("connector")
                    .apply { isAccessible = true }
                (connectorField.get(control) as TemporaryCarrierConnector).stop(invitation.instanceId)
                control.carrierLost()
                delay(100)
                assertTrue("Carrier recovery must retain the signed-out workbench", runtime.temporaryControlActive.value)
                withTimeout(90_000) { control.connectionState.first { it == RuntimeConnectionState.Connected } }
                assertSame(control, runtime.transport.delegate.value)
                assertNull(runtime.configStore.accountSession.first())
                api("GET", "/api/projects")
                val recovered = requireNotNull(TemporaryControlPairingClient(broker, runtime.identityStore,
                    AndroidTemporaryControlClaimJournal(app)).poll(invitation.instanceId))
                assertEquals("Recovery must retain the original deadline", grant.expiresAt, recovered.expiresAt)
                Log.i("TemporaryControlLiveQA", "real-native-carrier-recovered-with-original-deadline")
            }
            if (args.getString("liveTemporaryControlHarness") == "true") {
                val qwen = api("GET", "/api/harnesses").getValue("harnesses").jsonArray
                    .map { it.jsonObject }.single { it["id"]?.jsonPrimitive?.content == "qwen-code" }
                assertEquals("Preserve any existing Harness installation", "false", qwen.getValue("available").jsonPrimitive.content)
                var installed = false
                try {
                    val result = api("POST", "/api/harnesses/qwen-code/install", "{}").getValue("harness").jsonObject
                    installed = true
                    assertEquals("managed", result.getValue("installationSource").jsonPrimitive.content)
                    assertEquals("true", result.getValue("available").jsonPrimitive.content)
                    val upgraded = api("POST", "/api/harnesses/qwen-code/upgrade", """{"version":"0.22.3"}""")
                        .getValue("harness").jsonObject
                    assertEquals("0.22.3", upgraded.getValue("detectedVersion").jsonPrimitive.content)
                } finally {
                    if (installed) {
                        val removed = api("POST", "/api/harnesses/qwen-code/uninstall", "{}").getValue("harness").jsonObject
                        assertEquals("true", removed.getValue("filesRemoved").jsonPrimitive.content)
                    }
                }
                Log.i("TemporaryControlLiveQA", "real-managed-harness-install-upgrade-uninstall-passed")
            }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                delay(2_000); scenario.recreate(); delay(2_000)
                assertTrue("Activity recreation must retain temporary control without Google", runtime.temporaryControlActive.value)
                UiDevice.getInstance(instrumentation).takeScreenshot(java.io.File(app.getExternalFilesDir(null), "temporary-control-live.png"))
            }
        } finally {
            providerId?.let { api("DELETE", "/api/native-providers/$it") }
            sessionId?.let { api("DELETE", "/api/sessions/$it") }
            projectId?.let { api("DELETE", "/api/projects/$it") }
        }
        assertNull(runtime.configStore.accountSession.first())
        assertEquals(originalDirectory, runtime.configStore.directory.first())
        if (args.getString("liveTemporaryControlExpiry") == "true") {
            withTimeout(620_000) {
                while (System.currentTimeMillis() < grant.expiresAt - 60_000) delay(1_000)
                api("GET", "/api/projects")
                Log.i("TemporaryControlLiveQA", "nine-minute-read-still-authorized")
                while (System.currentTimeMillis() < grant.expiresAt + 500) delay(1_000)
                runtime.temporaryControlActive.first { !it }
            }
            try { transport.execute(ApiRequest("GET", "/api/projects")); fail("Expired control must reject fresh reads") }
            catch (error: ApiException) { assertEquals(410, error.statusCode) }
            Log.i("TemporaryControlLiveQA", "ten-minute-expiry-denied")
        }
        Log.i("TemporaryControlLiveQA", "acceptance-passed")
    }
}
