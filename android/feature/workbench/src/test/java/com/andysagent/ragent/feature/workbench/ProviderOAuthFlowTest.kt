package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class ProviderOAuthFlowTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun teardown() { Dispatchers.resetMain() }

    @Test fun `waits for code then opens once and confirms actual saved state`() = runTest(dispatcher) {
        val transport = OAuthTransport()
        val vm = WebParityViewModel(WebParityRepository(transport))
        vm.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
        transport.requests.clear()
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Phone account")); runCurrent()
        assertNull(vm.state.value.externalUrl)
        assertEquals("", vm.state.value.providerOAuthJob!!.code)
        transport.code = "TEST-CODE"
        advanceTimeBy(1000); runCurrent()
        assertEquals("TEST-CODE", vm.state.value.providerOAuthJob!!.code)
        assertEquals("https://auth.openai.com/codex/device", vm.state.value.externalUrl)
        vm.onEvent(WebParityEvent.ClearExternalUrl)
        vm.onEvent(WebParityEvent.Refresh); runCurrent()
        assertEquals("login_1", vm.state.value.providerOAuthJob!!.id)
        advanceTimeBy(1000); runCurrent()
        assertNull(vm.state.value.externalUrl)
        assertFalse(vm.state.value.providerOAuthJob!!.terminal)
        transport.phase = "completed"
        advanceTimeBy(1000); runCurrent()
        assertEquals("completed", vm.state.value.providerOAuthJob!!.state)
        assertEquals("", vm.state.value.providerOAuthJob!!.code)
        assertFalse(vm.state.value.providerOAuthPolling)
        assertEquals(1, transport.requests.count { it.method == "POST" })
        assertTrue(transport.requests.any { it.path == "/api/native-providers" })
    }

    @Test fun `disconnected polling resumes same job without another login POST`() = runTest(dispatcher) {
        val transport = OAuthTransport().apply { failReads = true }
        val vm = WebParityViewModel(WebParityRepository(transport))
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Phone account")); runCurrent()
        assertFalse(vm.state.value.providerOAuthPolling)
        assertNotNull(vm.state.value.error)
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Duplicate")); runCurrent()
        assertEquals(1, transport.requests.count { it.method == "POST" })
        transport.failReads = false; transport.phase = "completed"
        vm.onEvent(WebParityEvent.CheckProviderOAuth); runCurrent()
        assertEquals("completed", vm.state.value.providerOAuthJob!!.state)
        assertEquals(1, transport.requests.count { it.method == "POST" })
    }

    @Test fun `reauthentication targets original provider and does not create another slot`() = runTest(dispatcher) {
        val transport = OAuthTransport().apply { phase = "completed" }
        val vm = WebParityViewModel(WebParityRepository(transport))
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Existing", "provider-original")); runCurrent()
        val body = Json.parseToJsonElement(transport.requests.first().body!!).jsonObject
        assertEquals("provider-original", body["providerId"]!!.jsonPrimitive.content)
        assertEquals(true, body["replaceExisting"]!!.jsonPrimitive.boolean)
    }

    @Test fun `cancel racing save reads back completed rather than claiming cancelled`() = runTest(dispatcher) {
        val transport = OAuthTransport()
        val vm = WebParityViewModel(WebParityRepository(transport))
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Phone account")); runCurrent()
        transport.phase = "completed"
        vm.onEvent(WebParityEvent.CancelProviderOAuth); runCurrent()
        assertEquals("completed", vm.state.value.providerOAuthJob!!.state)
        assertEquals(1, transport.requests.count { it.method == "DELETE" })
    }

    @Test fun `server failure remains visible and never appears saved`() = runTest(dispatcher) {
        val transport = OAuthTransport().apply { phase = "failed" }
        val vm = WebParityViewModel(WebParityRepository(transport))
        vm.onEvent(WebParityEvent.StartProviderOAuth("codex", "Phone account")); runCurrent()
        assertEquals("failed", vm.state.value.providerOAuthJob!!.state)
        assertEquals("LOGIN_FINALIZE_FAILED: synthetic fixture", vm.state.value.error)
        assertTrue(transport.requests.none { it.path == "/api/native-providers" })
        assertNull(vm.state.value.externalUrl)
    }

    @Test fun `invalid unsafe URL or mismatched job cannot open browser`() = runTest(dispatcher) {
        val transport = OAuthTransport().apply { url = "http://untrusted.invalid/"; code = "TEST-CODE"; phase = "completed" }
        val job = WebParityRepository(transport).startProviderOAuth("codex", "QA")
        assertNull(job.url)
        assertFalse(job.canOpenBrowser)
        transport.jobId = "different"
        assertFailsWith<IllegalArgumentException> { WebParityRepository(transport).loadProviderOAuthJob("login_1") }
        assertFalse(job.toString().contains("TEST-CODE"))
    }
}

private class OAuthTransport : RagentTransport {
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations = emptyFlow<InvalidationHint>()
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
    val requests = mutableListOf<ApiRequest>()
    var code = ""
    var phase = "pending"
    var jobId = "login_1"
    var url = "https://auth.openai.com/codex/device"
    var failReads = false
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        if (request.path.startsWith("/api/native-provider-oauth/jobs")) {
            if (request.method == "GET" && failReads) return ApiResponse(503, "{}");
            return ApiResponse(200, buildJsonObject { put("job", buildJsonObject {
                put("id", jobId); put("agentType", "codex"); put("state", if (request.method == "POST") "pending" else phase)
                put("url", url); put("code", code); put("requiresInput", false)
                put("providerId", if (phase == "completed") "saved-provider" else "")
                if (phase == "failed") put("error", "LOGIN_FINALIZE_FAILED: synthetic fixture")
            }) }.toString())
        }
        return ApiResponse(200, "{}")
    }
}
