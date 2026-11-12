package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.domain.AccountDirectoryDevice
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.InvalidationHint
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.setMain
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertNotNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalCoroutinesApi::class)
class WebParityViewModelTest {
    @Test
    fun `provider choices include account harnesses without marking them locally installed`() {
        val harness = parseWebHarnesses("""{"harnesses":[{"id":"codex","name":"Codex","installed":false,"globallyInstalled":true,"supportedOnPlatform":true,"providerProtocols":["openai-responses"]}]}""").single()
        assertEquals(false, harness.installed)
        assertTrue(harness.globallyInstalled)
        assertEquals(listOf("codex"), installedProviderHarnessChoices(listOf(harness)).map { it.id })
    }

    @Test
    fun `current session context does not request navigation to chat`() {
        val viewModel = WebParityViewModel(WebParityRepository(RecordingParityTransport()))

        viewModel.setOpenSessionId("session-current")

        assertEquals("session-current", viewModel.state.value.openSessionId)
        assertEquals(null, viewModel.state.value.pendingOpenSessionId)
    }

    @Test
    fun `account computer rename uses the account directory mutation`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var renamed: Pair<String, String>? = null
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                accountDevicesProvider = {
                    listOf(AccountDirectoryDevice("rdev_office", "instance", "Office PC", "computer"))
                },
                accountDeviceRenamer = { id, name -> renamed = id to name },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.RenameDevice("rdev_office", "Work computer"))
            advanceUntilIdle()

            assertEquals("rdev_office" to "Work computer", renamed)
            assertEquals(null, viewModel.state.value.error)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `account device directory hides phone records from manage devices`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                accountDevicesProvider = {
                    listOf(
                        AccountDirectoryDevice("rdev_office", "office", "Office PC", "computer"),
                        AccountDirectoryDevice("adev_phone", "phone", "Pixel", "phone"),
                    )
                },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()

            assertEquals(listOf("rdev_office"), viewModel.state.value.devices.map { it.id })
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `device page never falls back to target runtime when account directory is unavailable`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(transport),
                accountDevicesProvider = { null },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Devices))
            advanceUntilIdle()

            assertTrue(transport.requests.none { it.path.contains("/api/device-pairing/") })
            assertEquals(emptyList(), viewModel.state.value.devices)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `harness page falls back to an available computer catalog`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val viewModel = WebParityViewModel(
                repository = WebParityRepository(RecordingParityTransport()),
                harnessTargetsProvider = {
                    listOf(
                        WebHarnessTargetSnapshot(WebHarnessTarget("offline", "Offline", available = false)),
                        WebHarnessTargetSnapshot(
                            WebHarnessTarget("online", "Office computer"),
                            listOf(WebHarness(id = "codex", name = "Codex", installed = true)),
                        ),
                    )
                },
                currentTargetIdProvider = { "offline" },
            )

            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Harnesses))
            advanceUntilIdle()

            assertEquals(listOf("codex"), viewModel.state.value.harnesses.map { it.id })
            assertEquals(listOf("offline", "online"), viewModel.state.value.harnessTargets.map { it.instanceId })
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `agent create and edit preserve server supported profile fields`() = runTest {
        val transport = RecordingParityTransport()
        val repository = WebParityRepository(transport)

        repository.createAgent(
            name = "Report helper",
            systemPrompt = "Prepare concise reports",
            tool = "claude-bidi",
            welcomeMessage = "What should we prepare?",
            skills = listOf("reporting", "files", "reporting"),
        )
        repository.updateAgent(
            id = "agent_123",
            name = "Updated helper",
            systemPrompt = "Use the latest report",
            tool = "codex",
            welcomeMessage = "Ready",
            skills = listOf("reports"),
        )

        assertEquals(2, transport.requests.size)
        repository.addMcpServer("codex", "local", "C:\\Program Files\\mcp.exe", "account A", listOf("--project", "folder with spaces"))
        val localBody = AgentocProtocol.json.parseToJsonElement(transport.requests.last().body!!).jsonObject
        assertEquals("C:\\Program Files\\mcp.exe", localBody["command"]!!.jsonPrimitive.content)
        assertEquals(listOf("--project", "folder with spaces"), localBody["args"]!!.jsonArray.map { it.jsonPrimitive.content })
        repository.addMcpServer("codex", "remote", "https://example.test/mcp", "account A", listOf("ignored"))
        val remoteBody = AgentocProtocol.json.parseToJsonElement(transport.requests.last().body!!).jsonObject
        assertTrue("args" !in remoteBody)
        val create = AgentocProtocol.json.parseToJsonElement(transport.requests[0].body!!).jsonObject
        assertEquals("claude-bidi", create["tool"]!!.jsonPrimitive.content)
        assertEquals("What should we prepare?", create["welcomeMessage"]!!.jsonPrimitive.content)
        assertEquals(listOf("reporting", "files"), create["skills"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("PATCH", transport.requests[1].method)
        assertEquals("/api/agents/agent_123", transport.requests[1].path)
        assertNotNull(transport.requests[1].body)
    }

    @Test
    fun `schedule follow-up without a session fails before making a request`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(WebParityRepository(transport))

            viewModel.onEvent(WebParityEvent.CreateTrigger("Follow up", "Check the report", "30", null))
            advanceUntilIdle()

            assertEquals("Open a session before scheduling follow-up work", viewModel.state.value.error)
            assertTrue(transport.requests.isEmpty())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `schedule follow-up sends session and runtime selection`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport()
            val viewModel = WebParityViewModel(WebParityRepository(transport))

            viewModel.onEvent(
                WebParityEvent.CreateTrigger(
                    title = "Weekly export",
                    text = "Prepare the report",
                    delayMinutes = "7",
                    sessionId = "session-1",
                    tool = "codex",
                    model = "gpt-5.4",
                    effort = "high",
                    thinking = true,
                ),
            )
            advanceUntilIdle()

            val request = transport.requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/triggers", request.path)
            val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
            assertEquals("session-1", body["sessionId"]!!.jsonPrimitive.content)
            assertEquals("codex", body["tool"]!!.jsonPrimitive.content)
            assertEquals("gpt-5.4", body["model"]!!.jsonPrimitive.content)
            assertEquals("high", body["effort"]!!.jsonPrimitive.content)
            assertEquals("true", body["thinking"]!!.jsonPrimitive.content)
            assertEquals("true", body["enabled"]!!.jsonPrimitive.content)
            assertTrue(body["scheduledAt"]!!.jsonPrimitive.content.isNotBlank())
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `workspace file loading preserves raw bytes and response metadata`() = runTest {
        val bytes = "# Report\nready".toByteArray()
        val transport = RecordingParityTransport(
            ApiResponse(
                200,
                bytes.toString(Charsets.UTF_8),
                headers = mapOf("Content-Type" to "text/markdown; charset=utf-8", "Content-Disposition" to "inline; filename=report.md"),
                bodyBytes = bytes,
            ),
        )
        val payload = WebParityRepository(transport).loadFile("reports/report.md")

        assertEquals("report.md", payload.name)
        assertEquals("text/markdown", payload.mimeType)
        assertTrue(bytes.contentEquals(payload.bytes))
        assertEquals("/api/workspace-files/content?workspace=~&path=reports%2Freport.md", transport.requests.single().path)
    }

    @Test
    fun `project location browser loads remote drives and direct folder children`() = runTest {
        val transport = RecordingParityTransport(responder = { request ->
            when (request.path) {
                "/api/browse?roots=1" -> ApiResponse(
                    200,
                    """{"roots":[{"name":"C:\\","path":"C:\\"},{"name":"G:\\","path":"G:\\"}]}""",
                )
                "/api/browse?path=G%3A%5C&mode=directories" -> ApiResponse(
                    200,
                    """{"path":"G:\\","parent":null,"children":[{"name":"AgentoC","path":"G:\\AgentoC"}]}""",
                )
                else -> ApiResponse(404, """{"error":"Unexpected request"}""")
            }
        })
        val repository = WebParityRepository(transport)

        val roots = repository.loadProjectFolderRoots()
        val directory = repository.loadProjectFolderDirectory("G:\\")

        assertEquals(listOf("C:\\", "G:\\"), roots.map(ProjectFolderLocation::name))
        assertEquals("G:\\", directory.path)
        assertEquals(null, directory.parent)
        assertEquals(listOf("AgentoC"), directory.children.map(ProjectFolderLocation::name))
        assertEquals(
            listOf("/api/browse?roots=1", "/api/browse?path=G%3A%5C&mode=directories"),
            transport.requests.map(ApiRequest::path),
        )
    }

    @Test
    fun `Codex MCP mutations use the chosen provider scope`() = runTest {
        val transport = RecordingParityTransport()
        val repository = WebParityRepository(transport)
        repository.addMcpServer("codex", "docs", "https://example.test/mcp", "account A")
        repository.deleteMcpServer("codex", "docs", "account A")
        assertEquals(listOf("/api/providers/account%20A/codex/mcp-servers", "/api/providers/account%20A/codex/mcp-servers/docs"), transport.requests.map(ApiRequest::path))
        try {
            repository.addMcpServer("codex", "docs", "https://example.test/mcp")
            error("A Codex account must be selected")
        } catch (_: IllegalArgumentException) { }
        assertEquals(2, transport.requests.size)
    }

    @Test
    fun `Codex Skill settings use the active session and retain pending state`() = runTest {
        val transport = RecordingParityTransport(responder = { request ->
            when (request.path) {
                "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex","credentialOk":true}]}""")
                "/api/sessions/session-1/harness-capabilities?tool=codex" -> ApiResponse(200, """{"providerProfileId":"p1","items":[{"id":"codex:skill:aaaaaaaaaaaaaaaaaaaa","title":"Review","kind":"skill","source":"codex","enabled":true,"state":{"manageable":true,"desiredConfiguration":"disabled"}},{"title":"docs","kind":"mcp","source":"codex","state":{"authorization":"connected"}},{"id":"codex:app:drive","title":"Drive","kind":"app","source":"codex","state":{"runtime":"callable","configuration":"enabled","accessible":true}}]}""")
                "/api/providers/p1/codex/mcp-servers" -> ApiResponse(200, """{"servers":[{"name":"docs","transport":{"type":"http"}}]}""")
                "/api/providers/p1/codex/plugin-preference" -> ApiResponse(200, """{"desiredEnabled":true,"effectiveEnabled":null}""")
                "/api/providers/p1/codex/capability-sync" -> ApiResponse(200, """{"sync":{"status":"waiting_for_runtime"},"mode":"manual"}""")
                else -> ApiResponse(200, "{}")
            }
        })
        val repository = WebParityRepository(transport)
        val snapshot = repository.load(WebParityPage.Connectors, "session-1")
        val skills = snapshot.codexSkills
        assertEquals("connected", snapshot.mcpServers.single().authState)
        assertEquals(WebCodexApp("codex:app:drive", "p1", "Drive", "callable", "enabled", true), snapshot.codexApps.single())
        assertEquals(1, skills.size)
        assertEquals(true, skills.single().enabled)
        assertEquals(false, skills.single().desiredEnabled)
        repository.setCodexSkill("session-1", skills.single(), true)
        val request = transport.requests.last()
        assertEquals("/api/sessions/session-1/harness-capabilities/skills", request.path)
        assertTrue(request.body!!.contains("p1"))
        assertEquals(WebCodexPluginPreference("p1", true), snapshot.codexPluginPreference)
        repository.setCodexPluginPreference("p1", false)
        val pluginRequest = transport.requests.last()
        assertEquals("/api/providers/p1/codex/plugin-preference", pluginRequest.path)
        assertEquals("false", AgentocProtocol.json.parseToJsonElement(pluginRequest.body!!).jsonObject["enabled"]!!.jsonPrimitive.content)
        assertEquals(WebCodexSyncState("p1", "waiting_for_runtime", "manual"), snapshot.codexSyncState)
        repository.refreshCodexSync("p1")
        assertEquals("/api/providers/p1/codex/capability-sync", transport.requests.last().path)
        repository.setCodexSyncPolicy("p1", "disabled")
        assertEquals("/api/providers/p1/codex/capability-sync-policy", transport.requests.last().path)
        assertEquals("disabled", AgentocProtocol.json.parseToJsonElement(transport.requests.last().body!!).jsonObject["mode"]!!.jsonPrimitive.content)
    }

    @Test
    fun `Codex management selects an account without a session and never mixes session skills`() = runTest {
        val transport = RecordingParityTransport(responder = { request ->
            when (request.path) {
                "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"},{"id":"p2","agentType":"codex"}]}""")
                "/api/sessions/s1/harness-capabilities?tool=codex" -> ApiResponse(200, """{"providerProfileId":"p1","items":[{"id":"skill-1","title":"Review","kind":"skill","source":"codex","state":{"manageable":true}},{"id":"app-1","title":"Drive","kind":"app","source":"codex","state":{"runtime":"callable"}}]}""")
                "/api/providers/p2/codex/plugin-preference" -> ApiResponse(200, """{"desiredEnabled":true}""")
                "/api/providers/p2/codex/capability-sync" -> ApiResponse(200, """{"sync":{"status":"discovered"}}""")
                else -> ApiResponse(200, "{}")
            }
        })
        val repository = WebParityRepository(transport)
        val noSession = repository.load(WebParityPage.Connectors, codexProviderId = "p2")
        assertEquals("p2", noSession.codexPluginPreference?.providerId)
        val otherSession = repository.load(WebParityPage.Connectors, "s1", "p2")
        assertEquals("p2", otherSession.codexSyncState?.providerId)
        assertTrue(otherSession.codexSkills.isEmpty())
        assertTrue(otherSession.codexApps.isEmpty())
    }

    @Test
    fun `phone account selection changes management scope and opening a session follows its account`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport(responder = { request ->
                when (request.path) {
                    "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"},{"id":"p2","agentType":"codex"}]}""")
                    "/api/sessions/s1/harness-capabilities?tool=codex" -> ApiResponse(200, """{"providerProfileId":"p1","items":[]}""")
                    "/api/providers/p1/codex/plugin-preference", "/api/providers/p2/codex/plugin-preference" -> ApiResponse(200, """{"desiredEnabled":true}""")
                    "/api/providers/p1/codex/capability-sync", "/api/providers/p2/codex/capability-sync" -> ApiResponse(200, """{"sync":{"status":"discovered"}}""")
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport))
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            assertEquals("p1", viewModel.state.value.codexSyncState?.providerId)
            viewModel.onEvent(WebParityEvent.SelectCodexManagementProvider("p2"))
            advanceUntilIdle()
            assertEquals("p2", viewModel.state.value.codexSyncState?.providerId)
            viewModel.setOpenSessionId("s1")
            advanceUntilIdle()
            assertEquals("p1", viewModel.state.value.codexSyncState?.providerId)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `switching Codex accounts discards an in-flight MCP authorization`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val reply = CompletableDeferred<ApiResponse>()
            val transport = RecordingParityTransport(responder = { request ->
                when {
                    request.path == "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"},{"id":"p2","agentType":"codex"}]}""")
                    request.path == "/api/providers/p1/codex/mcp-servers/docs/oauth" -> reply.await()
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport))
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.StartMcpOAuth("p1", "docs"))
            runCurrent()
            assertTrue(viewModel.state.value.actionInProgress)
            viewModel.onEvent(WebParityEvent.SelectCodexManagementProvider("p2"))
            runCurrent()
            reply.complete(ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending"}"""))
            advanceUntilIdle()
            assertEquals("p2", viewModel.state.value.codexManagementProviderId)
            assertEquals(null, viewModel.state.value.mcpOAuthJob)
            assertEquals(false, viewModel.state.value.actionInProgress)
            assertEquals(1, transport.requests.count { it.method == "DELETE" && it.path == "/api/providers/p1/codex/mcp-servers/docs/oauth/abcd" })
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `switching sessions discards an in-flight MCP authorization`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val reply = CompletableDeferred<ApiResponse>()
            val transport = RecordingParityTransport(responder = { request ->
                when {
                    request.path == "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"}]}""")
                    request.path == "/api/providers/p1/codex/mcp-servers/docs/oauth" -> reply.await()
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport))
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.StartMcpOAuth("p1", "docs"))
            runCurrent()
            viewModel.setOpenSessionId("new-session")
            runCurrent()
            reply.complete(ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending"}"""))
            advanceUntilIdle()
            assertEquals("new-session", viewModel.state.value.openSessionId)
            assertEquals(null, viewModel.state.value.mcpOAuthJob)
            assertEquals(false, viewModel.state.value.actionInProgress)
            assertEquals(1, transport.requests.count { it.method == "DELETE" && it.path == "/api/providers/p1/codex/mcp-servers/docs/oauth/abcd" })
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `switching accounts cancels an already started MCP authorization`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = RecordingParityTransport(responder = { request ->
                when {
                    request.path == "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"},{"id":"p2","agentType":"codex"}]}""")
                    request.path == "/api/providers/p1/codex/mcp-servers/docs/oauth" -> ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending"}""")
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport))
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.StartMcpOAuth("p1", "docs"))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.SelectCodexManagementProvider("p2"))
            advanceUntilIdle()
            assertEquals(null, viewModel.state.value.mcpOAuthJob)
            assertEquals(1, transport.requests.count { it.method == "DELETE" && it.path == "/api/providers/p1/codex/mcp-servers/docs/oauth/abcd" })
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `stale MCP authorization is never cancelled on a different target`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            var target = "windows"
            val reply = CompletableDeferred<ApiResponse>()
            val transport = RecordingParityTransport(responder = { request ->
                when {
                    request.path == "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"}]}""")
                    request.path == "/api/providers/p1/codex/mcp-servers/docs/oauth" -> reply.await()
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { target })
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.StartMcpOAuth("p1", "docs"))
            runCurrent()
            target = "linux"
            reply.complete(ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending"}"""))
            advanceUntilIdle()
            assertEquals(null, viewModel.state.value.mcpOAuthJob)
            assertEquals(false, viewModel.state.value.actionInProgress)
            assertEquals(0, transport.requests.count { it.method == "DELETE" && it.path.endsWith("/oauth/abcd") })
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `MCP callback is submitted once and remains submitted while status is pending`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val reply = CompletableDeferred<ApiResponse>()
            val transport = RecordingParityTransport(responder = { request ->
                when {
                    request.path == "/api/native-providers" -> ApiResponse(200, """{"providers":[{"id":"p1","agentType":"codex"}]}""")
                    request.path == "/api/providers/p1/codex/mcp-servers/docs/oauth" -> ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending","mobileCallbackSupported":true}""")
                    request.path.endsWith("/oauth/abcd") && request.method == "POST" -> reply.await()
                    request.path.endsWith("/oauth/abcd") -> ApiResponse(200, """{"id":"abcd","state":"pending"}""")
                    else -> ApiResponse(200, "{}")
                }
            })
            val viewModel = WebParityViewModel(WebParityRepository(transport))
            viewModel.onEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.StartMcpOAuth("p1", "docs"))
            advanceUntilIdle()
            viewModel.onEvent(WebParityEvent.SubmitMcpOAuthCallback("http://127.0.0.1/callback/test?code=x&state=y"))
            viewModel.onEvent(WebParityEvent.SubmitMcpOAuthCallback("http://127.0.0.1/callback/test?code=x&state=y"))
            runCurrent()
            assertEquals(1, transport.requests.count { it.path.endsWith("/oauth/abcd") && it.method == "POST" })
            reply.complete(ApiResponse(200, """{"accepted":true}"""))
            advanceUntilIdle()
            assertEquals(true, viewModel.state.value.mcpOAuthJob?.callbackSubmitted)
            assertEquals("pending", viewModel.state.value.mcpOAuthJob?.state)
        } finally { Dispatchers.resetMain() }
    }

    @Test
    fun `MCP OAuth preserves the selected account and reports the verified status`() = runTest {
        val transport = RecordingParityTransport(responder = { request ->
            when (request.method) {
                "POST" -> ApiResponse(200, """{"id":"abcd","authorizationUrl":"https://example.test/authorize","state":"pending","mobileCallbackSupported":true}""")
                else -> ApiResponse(200, """{"id":"abcd","state":"connected"}""")
            }
        })
        val repository = WebParityRepository(transport)
        val job = repository.startMcpOAuth("account A", "docs")
        assertEquals("pending", job.state)
        assertTrue(job.mobileCallbackSupported)
        repository.submitMcpOAuthCallback(job, "http://127.0.0.1:1234/callback/test?code=test&state=state")
        assertEquals("connected", repository.checkMcpOAuth(job).state)
        assertEquals(listOf("/api/providers/account%20A/codex/mcp-servers/docs/oauth", "/api/providers/account%20A/codex/mcp-servers/docs/oauth/abcd", "/api/providers/account%20A/codex/mcp-servers/docs/oauth/abcd"), transport.requests.map(ApiRequest::path))
        assertEquals("http://127.0.0.1:1234/callback/test?code=test&state=state", AgentocProtocol.json.parseToJsonElement(transport.requests[1].body!!).jsonObject["callbackUrl"]!!.jsonPrimitive.content)
    }

    @Test
    fun `connector OAuth uses the Web authorization route and returns its URL`() = runTest {
        val transport = RecordingParityTransport(ApiResponse(200, "{\"authUrl\":\"https://github.com/login/oauth\"}"))
        val url = WebParityRepository(transport).startConnectorOAuth("github")

        assertEquals("https://github.com/login/oauth", url)
        assertEquals("POST", transport.requests.single().method)
        assertEquals("/api/connectors/github/authorize", transport.requests.single().path)
    }

    @Test
    fun `provider OAuth credential is submitted to the active job`() = runTest {
        val transport = RecordingParityTransport()
        val pasted = "https://example.test/auth?text=secret%2Bvalue&state=abc"
        WebParityRepository(transport).submitProviderOAuthCredential("job_1", pasted)

        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/native-provider-oauth/jobs/job_1/input", request.path)
        val body = Json.parseToJsonElement(request.body!!).jsonObject
        assertEquals(pasted, body["credential"]!!.jsonPrimitive.content)
    }

    @Test
    fun `provider rotation uses the server configuration endpoint`() = runTest {
        val transport = RecordingParityTransport()
        val repository = WebParityRepository(transport)
        repository.updateProviderRotation(true, listOf("agy_a", "agy_b"))

        val request = transport.requests.single()
        assertEquals("PATCH", request.method)
        assertEquals("/api/native-providers/agy/rotation", request.path)
        assertTrue(request.body!!.contains("agy_a"))
    }
}

private class RecordingParityTransport(
    private val response: ApiResponse = ApiResponse(200, "{}"),
    private val responder: (suspend (ApiRequest) -> ApiResponse)? = null,
) : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    val requests = mutableListOf<ApiRequest>()

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return responder?.invoke(request) ?: response
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
