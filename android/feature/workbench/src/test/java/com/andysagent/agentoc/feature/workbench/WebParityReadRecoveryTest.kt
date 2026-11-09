package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WebParityReadRecoveryTest {
    @Test fun providerCreationPassesTheChosenProtocolForOtherHarnesses() = runTest {
        var sent = ""
        val repository = WebParityRepository(ReadTransport { request ->
            sent = request.body.orEmpty(); ApiResponse(201, "{}")
        })
        repository.createProviderApiKey("qwen-code", "Test", "https://example.test", "fixture", "model", "anthropic")
        assertTrue(sent.contains("\"agentType\":\"qwen-code\""))
        assertTrue(sent.contains("\"protocol\":\"anthropic\""))
    }

    @Test fun rejectedProviderMutationShowsTheServerError() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = ReadTransport { request ->
                if (request.method == "POST" && request.path == "/api/native-providers")
                    ApiResponse(400, """{"error":"Provider configuration rejected"}""")
                else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport))
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
            model.onEvent(WebParityEvent.CreateProviderApiKey("codex", "Test", "https://example.test", "fixture", "model", "responses")); runCurrent()
            assertEquals("Provider configuration rejected", model.state.value.error)
            assertNull(model.state.value.statusMessage)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun samePageRefreshKeepsVisibleDataEvenWithoutATargetId() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val pending = CompletableDeferred<Unit>()
            var reads = 0
            val transport = ReadTransport { request ->
                if (request.path == "/api/native-providers") {
                    if (++reads == 2) pending.await()
                    ApiResponse(200, """{"providers":[{"id":"p","displayName":"Provider"}]}""")
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport))
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
            assertEquals("p", model.state.value.providers.single().id)
            model.onEvent(WebParityEvent.Refresh); runCurrent()
            assertFalse(model.state.value.loading)
            assertTrue(model.state.value.refreshing)
            assertEquals("p", model.state.value.providers.single().id)
            pending.complete(Unit); runCurrent()
            assertFalse(model.state.value.refreshing)
            assertEquals("p", model.state.value.providers.single().id)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun malformedProviderPoliciesDoNotBreakTheProviderList() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val transport = ReadTransport { request ->
                if (request.path == "/api/native-providers") ApiResponse(200, """{"providers":[
                    {"id":"legacy-string","modelPolicy":"legacy-model"},
                    {"id":"serialized-policy","modelPolicy":"{\"defaultModel\":\"gpt-legacy\"}"},
                    {"id":"legacy-array","modelPolicy":["legacy-model"],"enabled":{"unexpected":true}},
                    {"id":"valid-policy","modelPolicy":{"defaultModel":"gpt-5"}}
                ]}""") else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport))
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()

            assertEquals(listOf("legacy-string", "serialized-policy", "legacy-array", "valid-policy"), model.state.value.providers.map { it.id })
            assertEquals("legacy-model", model.state.value.providers[0].defaultModel)
            assertEquals("gpt-legacy", model.state.value.providers[1].defaultModel)
            assertEquals("", model.state.value.providers[2].defaultModel)
            assertEquals("gpt-5", model.state.value.providers[3].defaultModel)
            assertTrue(model.state.value.providers[2].enabled)
            assertNull(model.state.value.error)
        } finally { Dispatchers.resetMain() }
    }
    @Test fun closingAFileDoesNotReleaseAnUnrelatedProviderMutation() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val mutation = CompletableDeferred<Unit>()
            val file = CompletableDeferred<Unit>()
            val transport = ReadTransport { request ->
                when {
                    request.method == "POST" && request.path == "/api/native-providers" -> {
                        mutation.await(); ApiResponse(200, "{}")
                    }
                    request.path.startsWith("/api/workspace-files/content") -> {
                        file.await(); ApiResponse(200, "file")
                    }
                    else -> ApiResponse(200, "{}")
                }
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
            model.onEvent(WebParityEvent.CreateProviderApiKey("codex", "Name", "https://example.test", "test", "model", "responses")); runCurrent()
            assertTrue(model.state.value.actionInProgress)
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenFile("file.txt")); runCurrent()
            model.onEvent(WebParityEvent.CloseFile); runCurrent()
            assertTrue("The provider mutation is still pending", model.state.value.actionInProgress)
            mutation.complete(Unit); file.complete(Unit); runCurrent()
            assertFalse(model.state.value.actionInProgress)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun lateDirectoryResponseCannotReplaceTheUsersNewerSelection() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val old = CompletableDeferred<Unit>()
            val transport = ReadTransport { request ->
                when {
                    request.path.contains("path=alpha") -> withContext(NonCancellable) {
                        old.await(); ApiResponse(200, """{"files":[{"path":"alpha/old.txt"}]}""")
                    }
                    request.path.contains("path=beta") -> ApiResponse(200, """{"files":[{"path":"beta/new.txt"}]}""")
                    else -> ApiResponse(200, "{}")
                }
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenDirectory("alpha")); runCurrent()
            model.onEvent(WebParityEvent.OpenDirectory("beta")); runCurrent()
            old.complete(Unit); runCurrent()
            assertEquals("beta", model.state.value.fileDirectory)
            assertEquals(listOf("beta/new.txt"), model.state.value.files.map { it.path })
        } finally { Dispatchers.resetMain() }
    }

    @Test fun aClosedFileCannotBeRepopulatedByItsLateResponse() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val old = CompletableDeferred<Unit>()
            val transport = ReadTransport { request ->
                if (request.path.startsWith("/api/workspace-files/content")) withContext(NonCancellable) {
                    old.await(); ApiResponse(200, "old contents", headers = mapOf("Content-Type" to "text/plain"))
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenFile("old.txt")); runCurrent()
            model.onEvent(WebParityEvent.CloseFile)
            old.complete(Unit); runCurrent()
            assertNull(model.state.value.selectedFile)
            assertNull(model.state.value.fileContent)
            assertNull(model.state.value.filePayload)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun leavingFilesClearsTheCancelledReadProgress() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val old = CompletableDeferred<Unit>()
            val transport = ReadTransport { request ->
                if (request.path.startsWith("/api/workspace-files/content")) withContext(NonCancellable) {
                    old.await(); ApiResponse(200, "old")
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenFile("old.txt")); runCurrent()
            assertTrue(model.state.value.fileReadInProgress)
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
            assertFalse(model.state.value.fileReadInProgress)
            old.complete(Unit); runCurrent()
            assertNull(model.state.value.filePayload)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun oldComputerFileCannotAppearAfterSwitchingComputers() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val old = CompletableDeferred<Unit>()
            var target = "pc-a"
            val transport = ReadTransport { request ->
                if (request.path.startsWith("/api/workspace-files/content")) withContext(NonCancellable) {
                    old.await(); ApiResponse(200, "old computer contents", headers = mapOf("Content-Type" to "text/plain"))
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { target })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenFile("old.txt")); runCurrent()
            target = "pc-b"
            model.onEvent(WebParityEvent.TargetChanged(target))
            model.onEvent(WebParityEvent.RefreshAfterReconnect(target)); runCurrent()
            old.complete(Unit); runCurrent()
            assertNull(model.state.value.selectedFile)
            assertNull(model.state.value.fileContent)
            assertNull(model.state.value.filePayload)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun reconnectRefreshDoesNotReplaceANewlyOpenedDirectory() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val pending = CompletableDeferred<Unit>()
            var alphaReads = 0
            val transport = ReadTransport { request ->
                when {
                    request.path.contains("path=alpha") -> {
                        if (++alphaReads == 2) pending.await()
                        ApiResponse(200, """{"files":[{"path":"alpha/old.txt"}]}""")
                    }
                    request.path.contains("path=beta") -> ApiResponse(200, """{"files":[{"path":"beta/new.txt"}]}""")
                    else -> ApiResponse(200, "{}")
                }
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenDirectory("alpha")); runCurrent()
            model.onEvent(WebParityEvent.RefreshAfterReconnect("pc-a")); runCurrent()
            model.onEvent(WebParityEvent.OpenDirectory("beta")); runCurrent()
            pending.complete(Unit); runCurrent()
            assertEquals("beta", model.state.value.fileDirectory)
            assertEquals(listOf("beta/new.txt"), model.state.value.files.map { it.path })
        } finally { Dispatchers.resetMain() }
    }

    @Test fun reconnectPreservesTheOpenFileAndDirectory() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val requests = mutableListOf<String>()
            val transport = ReadTransport { request ->
                requests += request.path
                if (request.path.startsWith("/api/workspace-files/content"))
                    ApiResponse(200, "file contents", headers = mapOf("Content-Type" to "text/plain"))
                else ApiResponse(200, """{"directories":[],"files":[]}""")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.Files)); runCurrent()
            model.onEvent(WebParityEvent.OpenDirectory("folder")); runCurrent()
            model.onEvent(WebParityEvent.OpenFile("folder/example.txt")); runCurrent()
            assertEquals("file contents", model.state.value.fileContent)
            model.onEvent(WebParityEvent.RefreshAfterReconnect("pc-a")); runCurrent()
            assertEquals("folder/example.txt", model.state.value.selectedFile)
            assertEquals("folder", model.state.value.fileDirectory)
            assertEquals("file contents", model.state.value.fileContent)
            assertTrue(requests.last().contains("path=folder"))
        } finally { Dispatchers.resetMain() }
    }

    @Test fun reconnectKeepsTheSameTargetPageVisibleUntilRefreshCompletes() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val refresh = CompletableDeferred<Unit>()
            val invalidation = CompletableDeferred<Unit>()
            var reads = 0
            val transport = ReadTransport { request ->
                if (request.path == "/api/native-providers") {
                    if (++reads == 2) { refresh.await(); throw ApiException(0, "OFFLINE", "Network unavailable", true) }
                    if (reads == 3) invalidation.await()
                    ApiResponse(200, """{"providers":[{"id":"review","displayName":"Review"}]}""")
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { "pc-a" })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders))
            runCurrent()
            assertEquals("review", model.state.value.providers.single().id)
            model.onEvent(WebParityEvent.RefreshAfterReconnect("pc-a"))
            runCurrent()
            assertFalse(model.state.value.loading)
            assertEquals("review", model.state.value.providers.single().id)
            refresh.complete(Unit); runCurrent()
            assertEquals("review", model.state.value.providers.single().id)
            assertEquals("Network unavailable", model.state.value.error)
            model.onEvent(WebParityEvent.Refresh); runCurrent()
            assertFalse(model.state.value.loading)
            assertEquals("review", model.state.value.providers.single().id)
            invalidation.complete(Unit); runCurrent()
        } finally { Dispatchers.resetMain() }
    }

    @Test fun reconnectToAnotherTargetDoesNotRetainThePreviousTargetData() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val refresh = CompletableDeferred<Unit>()
            var target = "pc-a"
            var reads = 0
            val transport = ReadTransport { request ->
                if (request.path == "/api/native-providers") {
                    if (++reads == 2) refresh.await()
                    ApiResponse(200, """{"providers":[{"id":"$target","displayName":"Provider"}]}""")
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport), currentTargetIdProvider = { target })
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders)); runCurrent()
            assertEquals("pc-a", model.state.value.providers.single().id)
            target = "pc-b"
            model.onEvent(WebParityEvent.TargetChanged("pc-b"))
            assertTrue(model.state.value.providers.isEmpty())
            model.onEvent(WebParityEvent.RefreshAfterReconnect("pc-b")); runCurrent()
            assertTrue(model.state.value.loading)
            assertTrue(model.state.value.providers.isEmpty())
            refresh.complete(Unit); runCurrent()
            assertEquals("pc-b", model.state.value.providers.single().id)
        } finally { Dispatchers.resetMain() }
    }

    @Test fun retryCannotBeOverwrittenByTheRetiredCarrierFailure() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try {
            val retired = CompletableDeferred<Unit>()
            var reads = 0
            val transport = ReadTransport { request ->
                if (request.path == "/api/native-providers") {
                    if (++reads == 1) withContext(NonCancellable) {
                        retired.await()
                        throw ApiException(0, "CARRIER_UNAVAILABLE", "Retired carrier", true)
                    }
                    ApiResponse(200, """{"providers":[{"id":"review","displayName":"Review Codex Luna"}]}""")
                } else ApiResponse(200, "{}")
            }
            val model = WebParityViewModel(WebParityRepository(transport))
            model.onEvent(WebParityEvent.OpenPage(WebParityPage.ModelProviders))
            runCurrent()
            model.onEvent(WebParityEvent.Refresh)
            runCurrent()
            assertEquals("Review Codex Luna", model.state.value.providers.single().name)
            retired.complete(Unit)
            advanceUntilIdle()
            assertNull(model.state.value.error)
            assertFalse(model.state.value.loading)
            assertEquals("review", model.state.value.providers.single().id)
        } finally { Dispatchers.resetMain() }
    }
    private class ReadTransport(val respond: suspend (ApiRequest) -> ApiResponse) : AgentoCTransport {
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
        override val invalidations = emptyFlow<InvalidationHint>()
        override suspend fun execute(request: ApiRequest) = respond(request)
        override fun connectInvalidationSocket() = Unit
        override suspend fun close() = Unit
    }
}
