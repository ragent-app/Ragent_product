package com.andysagent.ragent

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Real native surface/VM/clipboard; synthetic transport and intercepted browser, no official login. */
@RunWith(AndroidJUnit4::class)
class ProviderOAuthNativeFlowTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun nativeProviderEntryShowsCodeCopiesBeforeBrowserAndWaitsForSave() {
        assumeTrue(Build.FINGERPRINT.contains("generic"))
        assumeTrue(InstrumentationRegistry.getArguments().getString("providerFixture") == "owned-emulator-20261027")
        val app = ApplicationProvider.getApplicationContext<Context>()
        val saved = AtomicBoolean(false); val posts = AtomicInteger(); val opens = AtomicInteger()
        val transport = object : RagentTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations = emptyFlow<InvalidationHint>()
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
            override suspend fun execute(request: ApiRequest): ApiResponse {
                if (request.path.startsWith("/api/native-provider-oauth/jobs")) {
                    if (request.method == "POST") posts.incrementAndGet()
                    check(request.method in setOf("GET", "POST"))
                    return ApiResponse(200, buildJsonObject { put("job", buildJsonObject {
                        put("id", "native_fixture"); put("agentType", "codex")
                        put("state", if (saved.get()) "completed" else "pending")
                        put("url", "https://auth.openai.com/codex/device")
                        put("code", if (request.method == "GET" && !saved.get()) "TEST-CODE" else "")
                        put("providerId", if (saved.get()) "fixture_provider" else "")
                    }) }.toString())
                }
                return ApiResponse(200, "{}")
            }
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val activity = AtomicReference<MainActivity>()
        instrumentation.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)) }
        try {
            compose.waitUntil(30_000) {
                instrumentation.runOnMainSync { activity.set(ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull()) }
                activity.get() != null
            }
            compose.onNodeWithText("Connect your work computer").assertIsDisplayed()
            val vm = WebParityViewModel(WebParityRepository(transport))
            instrumentation.runOnMainSync { activity.get().setContent {
                val state by vm.state.collectAsState()
                RagentTheme { CompositionLocalProvider(LocalUriHandler provides object : UriHandler {
                    override fun openUri(uri: String) {
                        assertEquals("https://auth.openai.com/codex/device", uri)
                        val clipboard = app.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        assertEquals("TEST-CODE", clipboard.primaryClip!!.getItemAt(0).coerceToText(app).toString())
                        opens.incrementAndGet()
                    }
                }) { WebParitySurface(WebParityPage.ModelProviders, state, vm::onEvent, {}) } }
            } }
            compose.onNodeWithText("Add provider").performClick()
            compose.onNodeWithText("Official OAuth").performClick()
            compose.onNodeWithText("Start login").performClick()
            compose.waitUntil(15_000) { opens.get() == 1 && vm.state.value.providerOAuthJob?.code == "TEST-CODE" }
            compose.onNodeWithText("TEST-CODE").assertIsDisplayed()
            assertEquals(1, posts.get())
            screenshot(app, "provider-oauth-native-code.png")
            saved.set(true)
            compose.waitUntil(15_000) { vm.state.value.providerOAuthJob?.state == "completed" && !vm.state.value.providerOAuthPolling }
            compose.onNodeWithText("Account saved on the connected computer.").assertIsDisplayed()
            compose.onNodeWithText("Copy device code").assertDoesNotExist()
            assertEquals(1, opens.get()); assertEquals(1, posts.get())
            screenshot(app, "provider-oauth-native-saved.png")
            compose.onNodeWithText("Close").performClick()
        } finally { instrumentation.runOnMainSync { activity.get()?.finish() } }
    }
    private fun screenshot(context: Context, name: String) {
        val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        File(context.cacheDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
