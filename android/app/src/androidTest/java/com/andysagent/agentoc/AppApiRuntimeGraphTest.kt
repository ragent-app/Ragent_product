package com.andysagent.agentoc

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.content.ComponentName
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.appapi.*
import com.andysagent.agentoc.feature.appapi.CaptureEvent
import com.andysagent.agentoc.feature.appapi.CaptureConnectionStatus
import com.andysagent.agentoc.feature.appapi.CaptureViewModel
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.datastore.ClientConfigStore
import com.andysagent.agentoc.core.datastore.LinkedComputer
import com.andysagent.agentoc.core.domain.RoomSessionRepository
import com.andysagent.agentoc.core.domain.FileUploadInput
import java.io.ByteArrayOutputStream
import com.andysagent.agentoc.core.domain.SessionMutationKind
import com.andysagent.agentoc.core.domain.SessionMutationContext
import com.andysagent.agentoc.core.domain.SessionMutationCommand
import com.andysagent.agentoc.core.domain.SessionMutationProtocol
import com.andysagent.agentoc.core.domain.SessionMutationReceipt
import com.andysagent.agentoc.core.domain.SessionMutationJson
import com.andysagent.agentoc.core.domain.SessionScopeCondition
import com.andysagent.agentoc.core.domain.ScopedMessageRequest
import com.andysagent.agentoc.core.domain.ScopedMessagePreparation
import com.andysagent.agentoc.core.domain.ScopedMessageCommitReceipt
import com.andysagent.agentoc.core.domain.ScopedMessageClient
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.AppLanguage
import com.andysagent.agentoc.core.network.*
import com.andysagent.agentoc.core.p2p.IceServer
import com.andysagent.agentoc.core.p2p.P2PCandidate
import com.andysagent.agentoc.core.p2p.P2PHttpRequest
import com.andysagent.agentoc.core.p2p.P2PProtocol
import com.andysagent.agentoc.core.p2p.WebRTCDataChannelTransport
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Real graph/Room/coordinator and lifecycle, with only remote PC carriers replaced. */
@RunWith(AndroidJUnit4::class)
class AppApiRuntimeGraphTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var application: Application
    private lateinit var root: File
    private lateinit var config: ClientConfigStore
    private lateinit var storeScope: CoroutineScope
    private lateinit var preferencesStore: DataStore<Preferences>
    private val graphs = mutableListOf<AndroidRuntimeGraph>()
    private val pcs = ConcurrentHashMap<String, Pc>()
    private val carriers = ConcurrentHashMap<String, Carrier>()
    private val databaseNames = ConcurrentHashMap<String, String>()
    private val connectionStartOrder = java.util.concurrent.CopyOnWriteArrayList<String>()
    private val runtimeScopes = ConcurrentHashMap<String, CoroutineScope>()
    private val databaseCloses = ConcurrentHashMap<String, AtomicInteger>()
    private val owner = object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry.createUnsafe(this)
    }

    @Before fun setup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        root = File(context.cacheDir, "app-api-runtime-${UUID.randomUUID()}").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getNoBackupFilesDir() = File(root, "no-backup").apply { mkdirs() }
            override fun getDatabasePath(name: String) =
                (if (File(name).isAbsolute) File(name) else File(root, "databases/$name")).apply { parentFile!!.mkdirs() }
            override fun getSharedPreferences(name: String, mode: Int) = super.getSharedPreferences("${root.name}-$name", mode)
        }
        application = object : Application() { init { attachBaseContext(isolated) } }
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        preferencesStore = PreferenceDataStoreFactory.create(scope = storeScope) { File(root, "client.preferences_pb") }
        config = ClientConfigStore.withStore(application, preferencesStore)
    }

    @After fun teardown() = runBlocking {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            (ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED) +
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.STOPPED))
                .filter { it is ProcessTextQaActivity || it is SavedProcessTextQaActivity }.forEach { it.finish() }
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        ProcessTextQaActivity.port = null
        graphs.forEach { it.close() }
        storeScope.coroutineContext[Job]?.cancelAndJoin()
        // The fixture owns exactly this generated cache subtree.
        assertTrue(root.canonicalPath.startsWith(application.cacheDir.canonicalPath + File.separator))
        assertTrue(root.name.startsWith("app-api-runtime-"))
        root.deleteRecursively()
        Unit
    }

    private suspend fun graph(connectionWaitTimeoutMs: Long = 30_000L): AndroidRuntimeGraph {
        val graph = AndroidRuntimeGraph(application, TargetRuntimeFactory { target, databaseName, scope ->
            runtimeScopes[target.instanceId] = scope
            databaseNames[target.instanceId] = databaseName
            val database = AgentoCDatabase.create(application, File(root, "databases/$databaseName").absolutePath)
            val carrier = Carrier(pcs.computeIfAbsent(target.instanceId) { Pc(it) }) {
                connectionStartOrder += target.instanceId
            }
            carriers[target.instanceId] = carrier
            TargetRuntime(target.instanceId, target.endpoint, "", carrier,
                RoomSessionRepository(database, carrier, targetId = target.instanceId), carrier, scope, disposeStorage = {
                    database.close(); databaseCloses.computeIfAbsent(target.instanceId) { AtomicInteger() }.incrementAndGet()
                })
        }, config, notificationRegistrar = {}, connectionWaitTimeoutMs = connectionWaitTimeoutMs)
        graphs += graph
        withContext(Dispatchers.Main) { graph.start(); graph.onStop(owner) }
        graph.appApi.listTargets(graph.appApiOwner) // Wait for initialization gate.
        return graph
    }

    private suspend fun computers() {
        config.upsertComputer(LinkedComputer("pc-a", "", "Office", autoConnect = false), select = true)
        config.upsertComputer(LinkedComputer("pc-b", "", "Home", autoConnect = false))
    }

    /** Uses the real app controller and runtime graph against an isolated live Broker fixture. */
    @Test fun liveWindowsBrokerDecisionThroughAppController() = runBlocking {
        val port = InstrumentationRegistry.getArguments().getString("agentocBrokerTestPort")?.toIntOrNull()
        assumeTrue(port != null && port in 1025..65535)
        val fixturePort = requireNotNull(port)
        val pc = Pc("pc-a").apply { brokerPort = fixturePort }
        val args = InstrumentationRegistry.getArguments()
        val p2pUrl = args.getString("p2pSignalingUrl")
        if (!p2pUrl.isNullOrBlank()) {
            val p2pRoom = requireNotNull(args.getString("p2pRoomId"))
            val p2pSecret = requireNotNull(args.getString("p2pSecret"))
            val stunUrl = args.getString("p2pStunUrl")?.takeIf { it.startsWith("stun:") }
            val p2p = WebRTCDataChannelTransport(P2PCandidate(p2pUrl, p2pRoom, p2pSecret,
                stunUrl?.let { listOf(IceServer(it)) } ?: emptyList()), application,
                connectTimeoutMs = 30_000L, requestTimeoutMs = 15_000L)
            pc.brokerP2p = p2p
            try { p2p.connect().getOrThrow() } catch (error: Throwable) { p2p.close(); throw error }
        }
        pcs[pc.id] = pc
        config.upsertComputer(LinkedComputer(pc.id, "", "Isolated Windows fixture", autoConnect = false), select = true)
        val graph = graph()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers[pc.id]?.connectionState?.value == RuntimeConnectionState.Connected }

        val controller = WindowsBrokerApprovalController(application, graph)
        val material = controller.enrollmentMaterial()
        val register = JSONObject().put("deviceId", material.deviceId).put("publicKey", material.publicKeyBase64).toString()
        assertEquals(200, fixtureRequest(fixturePort, ApiRequest("POST", "/register", register)).statusCode)
        val pendingEnrollment = withTimeout(80_000) {
            while (true) {
                try { return@withTimeout controller.enrollmentChallenge(pc.id) }
                catch (error: ApiException) { if (error.statusCode != 503) throw error; delay(100) }
            }
            error("unreachable")
        }
        controller.completeEnrollment(pc.id, pendingEnrollment.challenge.enrollmentId, pendingEnrollment.challenge.verificationCode)

        val viewModel = withContext(Dispatchers.Main) {
            com.andysagent.agentoc.feature.workbench.AttentionCenterViewModel(graph.sessions, controller)
        }
        val itemId = withTimeout(80_000) {
            while (viewModel.state.value.activeItemId == null) {
                carriers[pc.id]?.invalidations?.tryEmit(InvalidationHint("windows_broker_approvals_invalidated"))
                delay(250)
            }
            requireNotNull(viewModel.state.value.activeItemId)
        }
        val scenario = ActivityScenario.launch(ComponentActivity::class.java)
        try {
            scenario.onActivity { activity ->
                activity.setContent {
                    val state by viewModel.state.collectAsState()
                    com.andysagent.agentoc.core.designsystem.AgentocTheme {
                        com.andysagent.agentoc.feature.workbench.AttentionSurface(state, viewModel::onEvent, onOpenSession = {})
                    }
                }
            }
            withContext(Dispatchers.Main) {
                viewModel.onEvent(com.andysagent.agentoc.feature.workbench.AttentionEvent.SetExpanded(itemId, true))
            }
            val approve = application.getString(com.andysagent.agentoc.feature.workbench.R.string.attention_approve)
            compose.onNodeWithText(approve).assertIsDisplayed().performClick()
            withTimeout(30_000) {
                while (viewModel.state.value.items.any { it.id == itemId }) {
                    viewModel.state.value.error?.let { error(it) }
                    delay(100)
                }
            }
            assertNull(viewModel.state.value.error)
        } finally {
            scenario.close()
        }
    }

    private suspend fun fixtureRequest(port: Int, request: ApiRequest): ApiResponse = withContext(Dispatchers.IO) {
        val connection = URL("http://127.0.0.1:$port${request.path}").openConnection() as HttpURLConnection
        connection.requestMethod = request.method
        connection.connectTimeout = 3_000
        connection.readTimeout = 3_000
        try {
            request.body?.let {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { output -> output.write(it.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val input = if (status >= 400) connection.errorStream else connection.inputStream
            ApiResponse(status, input?.bufferedReader()?.use { it.readText() }.orEmpty())
        } finally { connection.disconnect() }
    }
    private suspend fun until(predicate: () -> Boolean) = withTimeout(5_000) { while (!predicate()) delay(10) }
    private suspend fun deniedBy(code: ApiErrorCode, block: suspend () -> Unit) {
        try { block(); fail("Expected $code") }
        catch (error: AppApiException) { assertEquals(code, error.error.code) }
    }

    @Test fun backgroundKeepsCarrierBeyondPreviousReleaseTimeout() = runBlocking {
        computers()
        val graph = graph()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"]?.starts?.get() == 1 }
        val carrier = requireNotNull(carriers["pc-a"])
        withContext(Dispatchers.Main) { graph.onStop(owner) }
        delay(1_000)
        // Directory changes may independently trigger synchronization while
        // the app is briefly backgrounded.
        graph.awaitLifecycleUpdate()
        assertEquals(0, carrier.closes.get())
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        delay(5_250)
        graph.awaitLifecycleUpdate()
        assertEquals(1, carrier.starts.get())
        assertEquals(0, carrier.closes.get())
        withContext(Dispatchers.Main) { graph.onStop(owner) }
        delay(5_250)
        graph.awaitLifecycleUpdate()
        assertEquals(1, carrier.starts.get())
        assertEquals(0, carrier.closes.get())
    }

    @Test fun demoAutoConnectDoesNotRestartAnExistingControllerButExplicitRetryDoes() = runBlocking {
        val account = "acct_demo_" + "a".repeat(48)
        config.saveAccountSession(com.andysagent.agentoc.core.datastore.AccountSessionMetadata(
            account, "adev_qa_device", "credential-a", "account-directory", "2099-01-01T00:00:00Z"))
        computers()
        val graph = graph()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"]?.starts?.get() == 1 }
        val carrier = requireNotNull(carriers["pc-a"])
        // The controller can transiently publish Disconnected while its
        // initial signed rendezvous is still in flight.
        carrier.connectionState.value = RuntimeConnectionState.Disconnected
        graph.ensureDemoComputerConnection(account, "pc-a")
        assertEquals(1, carrier.starts.get())
        assertEquals(0, carrier.refreshes.get())
        graph.ensureDemoComputerConnection(account, "pc-a", forceRefresh = true)
        assertEquals(1, carrier.refreshes.get())
    }

    @Test fun disconnectCancelsBackgroundTapWaitingInTheGlobalQueue() = runBlocking {
        computers(); val graph = graph()
        val queue = AndroidRuntimeGraph::class.java.getDeclaredField("backgroundConnectMutex").let {
            it.isAccessible = true; it.get(graph) as Mutex
        }
        queue.withLock {
            val tap = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { graph.connectAccountComputerInBackground("pc-b", "QA phone") }
            }
            try {
                graph.disconnectTarget("pc-b")
                val error = withTimeout(5_000) { tap.await() }.exceptionOrNull()
                assertTrue("Disconnect must cancel a tap queued before account capacity lookup", error is CancellationException)
                assertTrue(currentCoroutineContext().isActive)
                assertEquals(listOf("pc-a"), config.directory.first().computers.map { it.instanceId })
                assertEquals("pc-a", config.directory.first().activeTargetId)
            } finally { tap.cancelAndJoin() }
        }
        graph.close(); graphs.remove(graph)
        graph()
        assertEquals(listOf("pc-a"), config.directory.first().computers.map { it.instanceId })
    }

    @Test fun delayedCredentialRejectionSharesThePairingWriteLockAndPreservesOtherTargets() = runBlocking {
        computers(); val graph = graph()
        val lock = AndroidRuntimeGraph::class.java.getDeclaredField("configurationMutex").let { it.isAccessible = true; it.get(graph) as Mutex }
        graph.credentialStore.write("pc-a", "rda_other", "2099-01-01T00:00:00Z", "device-access")
        val otherSecret = com.andysagent.agentoc.core.auth.StoredP2PConfig("https://signal.invalid", "other-room", "other-secret")
        val freshSecret = otherSecret.copy(roomId = "fresh-room", secret = "fresh-secret")
        graph.p2pSecretStore.write("pc-a", otherSecret)
        graph.withTargetRuntime("pc-b") { runtime ->
            graph.credentialStore.write("pc-b", "rda_old", "2099-01-01T00:00:00Z", "device-access")
            var invalidations = 0
            val pending: Deferred<Unit>
            lock.withLock {
                pending = async(start = CoroutineStart.UNDISPATCHED) { graph.rejectTargetCredential(runtime, "rda_old", { true }) { invalidations++ } }
                assertFalse(pending.isCompleted)
                graph.credentialStore.write("pc-b", "rda_fresh", "2099-01-01T00:00:00Z", "device-access")
                graph.p2pSecretStore.write("pc-b", freshSecret)
            }
            withTimeout(5_000) { pending.await() }
            assertEquals(0, invalidations); assertEquals("rda_fresh", graph.credentialStore.readToken("pc-b"))
            assertEquals(freshSecret, graph.p2pSecretStore.read("pc-b"))
            graph.rejectTargetCredential(runtime, "rda_fresh", { true }) { invalidations++ }
            assertEquals(1, invalidations); assertNull(graph.credentialStore.readToken("pc-b")); assertNull(graph.p2pSecretStore.read("pc-b"))
            assertEquals("rda_other", graph.credentialStore.readToken("pc-a")); assertEquals(otherSecret, graph.p2pSecretStore.read("pc-a"))
        }
    }

    @Test fun disposedRuntimeAndSupersededAttemptCannotClearTheReplacementCredential() = runBlocking {
        computers(); val graph = graph()
        val old = graph.withTargetRuntime("pc-b") { it }
        graph.disconnectTarget("pc-b")
        config.upsertComputer(LinkedComputer("pc-b", "", "Home", autoConnect = false))
        graph.withTargetRuntime("pc-b") { replacement ->
            assertNotSame(old, replacement)
            graph.credentialStore.write("pc-b", "rda_fresh", "2099-01-01T00:00:00Z", "device-access")
            var invalidations = 0
            graph.rejectTargetCredential(old, "rda_fresh", { true }) { invalidations++ }
            graph.rejectTargetCredential(replacement, "rda_fresh", { false }) { invalidations++ }
            assertEquals(0, invalidations); assertEquals("rda_fresh", graph.credentialStore.readToken("pc-b"))
        }
    }

    @Test fun productionGraphControllerAndTransportFenceAnActualLatePeerRejection() = runBlocking {
        computers()
        val graph = AndroidRuntimeGraph(application, configOverride = config, notificationRegistrar = {})
        graphs += graph
        withContext(Dispatchers.Main) { graph.start(); graph.onStop(owner) }
        graph.appApi.listTargets(graph.appApiOwner)
        // Drain the real directory/foreground-owner transition before starting
        // this fixture's controller explicitly. No additional API is shipped.
        graph.awaitLifecycleUpdate()
        val lock = AndroidRuntimeGraph::class.java.getDeclaredField("configurationMutex").let { it.isAccessible = true; it.get(graph) as Mutex }
        @Suppress("UNCHECKED_CAST")
        val runtimes = AndroidRuntimeGraph::class.java.getDeclaredField("targetRuntimes").let {
            it.isAccessible = true; it.get(graph) as ConcurrentHashMap<String, TargetRuntime>
        }
        val runtime = runtimes.getValue("pc-a")
        val controller = runtime.controller as BoundTargetConnection
        val transport = runtime.transport as OkHttpAgentoCTransport
        val entered = CompletableDeferred<Unit>(); val calls = AtomicInteger()
        val authorizations = java.util.concurrent.CopyOnWriteArrayList<String>()
        val peer = object : com.andysagent.agentoc.core.p2p.P2PSession {
            override val isOpen = true
            override suspend fun connect() = Result.success(Unit)
            override fun close() = Unit
            override suspend fun request(request: com.andysagent.agentoc.core.p2p.P2PHttpRequest): Result<com.andysagent.agentoc.core.p2p.P2PHttpResponse> {
                authorizations += request.headers["Authorization"].orEmpty(); calls.incrementAndGet(); entered.complete(Unit)
                return Result.success(com.andysagent.agentoc.core.p2p.P2PHttpResponse(id = request.id, status = 401))
            }
        }
        val pending: Deferred<Result<ApiResponse>>
        lock.withLock {
            graph.credentialStore.write("pc-a", "rda_wire_old", "2099-01-01T00:00:00Z", "device-access")
            controller.start()
            // This fixture replaces only the peer. Cancel account setup while
            // it is queued on this same lock, before any real broker request.
            val bootstrap = BoundTargetConnection::class.java.getDeclaredField("refreshJob").let { it.isAccessible = true; it.get(controller) as Job? }
            BoundTargetConnection::class.java.getDeclaredMethod("cancelRefresh").let { it.isAccessible = true; it.invoke(controller) }
            withTimeout(5_000) { bootstrap?.join() }
            transport.setTurnSession(peer)
            pending = async(Dispatchers.Default) { runCatching { transport.execute(ApiRequest("POST", "/unknown-write", "{}")) } }
            withTimeout(5_000) { entered.await() }
            graph.credentialStore.write("pc-a", "rda_wire_new", "2099-01-01T00:00:00Z", "device-access")
        }
        assertEquals(401, (withTimeout(5_000) { pending.await() }.exceptionOrNull() as ApiException).statusCode)
        assertEquals("rda_wire_new", graph.credentialStore.readToken("pc-a")); assertEquals(1, calls.get())
        assertEquals(listOf("Bearer rda_wire_old"), authorizations.toList())
        assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        val currentFailure = runCatching { transport.execute(ApiRequest("GET", "/api/auth/me")) }.exceptionOrNull()
        assertEquals(401, (currentFailure as ApiException).statusCode)
        assertNull(graph.credentialStore.readToken("pc-a")); assertEquals(2, calls.get())
        delay(100); assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
    }

    @Test fun backgroundDeliveryCompletesOriginalOperationOnceAfterColdReopen() = runBlocking {
        computers(); var graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("background-complete", "Synthetic authorized task",
            TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val consent = graph.backgroundDeliveryConsents.approve(
            graph.backgroundDeliveryConsents.review(prepared.operationId, graph.appApiOwner), graph.appApiOwner)
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(0, pcs["pc-b"]?.messageCalls?.get() ?: 0)
        val accepted = graph.backgroundDelivery.execute(consent.consentId)
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals(prepared.operationId, accepted.operationId)
        assertEquals("pc-b", accepted.targetInstanceId)
        assertEquals(prepared.deadlineAt, accepted.deadlineAt)
        assertEquals(BackgroundDeliveryConsent.FINISHED, graph.backgroundDeliveryConsents.list(graph.appApiOwner).single().state)
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.backgroundDelivery.execute(consent.consentId) }
        assertEquals(1, pcs.getValue("pc-b").messageCalls.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun stoppingBackgroundConsentDoesNotWaitForTheExecutingTaskLease() = runBlocking {
        computers(); val graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("background-stop", "Synthetic stopped task",
            TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val store = graph.backgroundDeliveryConsents
        val consent = store.approve(store.review(prepared.operationId, graph.appApiOwner), graph.appApiOwner)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        assertEquals(0, pc.messageCalls.get())
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        pc.afterPrepare = { entered.complete(Unit); release.await() }
        val worker = async { runCatching { graph.backgroundDelivery.execute(consent.consentId) } }
        try {
            withTimeout(5_000) { entered.await() }
            withTimeout(2_000) { store.revoke(consent.consentId, graph.appApiOwner) }
            assertEquals(BackgroundDeliveryConsent.REVOKED, store.list(graph.appApiOwner).single().state)
        } finally { release.complete(Unit) }
        val failure = withTimeout(5_000) { worker.await() }.exceptionOrNull() as AppApiException
        assertEquals(ApiErrorCode.PERMISSION_DENIED, failure.error.code)
        assertEquals(0, pc.messageCalls.get())
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.backgroundDelivery.execute(consent.consentId) }
        assertEquals(0, pc.messageCalls.get())
    }

    @Test fun acceptedReceiptAfterBackgroundStopRemainsAcceptedAndConsentRemainsRevoked() = runBlocking {
        computers(); val graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("background-late", "Synthetic late receipt",
            TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val store = graph.backgroundDeliveryConsents
        val consent = store.approve(store.review(prepared.operationId, graph.appApiOwner), graph.appApiOwner)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        pc.afterCommit = { entered.complete(Unit); release.await() }
        val worker = async { graph.backgroundDelivery.execute(consent.consentId) }
        try {
            withTimeout(5_000) { entered.await() }
            store.revoke(consent.consentId, graph.appApiOwner)
        } finally { release.complete(Unit) }
        assertEquals(OperationStage.ACCEPTED, withTimeout(5_000) { worker.await() }.stage)
        assertEquals(BackgroundDeliveryConsent.REVOKED, store.list(graph.appApiOwner).single().state)
        assertEquals(1, pc.messageCalls.get())
        assertEquals(OperationStage.ACCEPTED, graph.appApi.get(prepared.operationId, graph.appApiOwner).stage)
    }

    @Test fun backgroundConsentColdReopenDoesNotDispatchAndUnpairPermanentlyRevokes() = runBlocking {
        computers(); var graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("background-cold", "Synthetic background consent",
            TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val consent = graph.backgroundDeliveryConsents.approve(
            graph.backgroundDeliveryConsents.review(prepared.operationId, graph.appApiOwner), graph.appApiOwner)
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(consent, graph.backgroundDeliveryConsents.load(consent.consentId, graph.appApiOwner))
        assertEquals(0, pcs["pc-b"]?.messageCalls?.get() ?: 0)
        graph.disconnectTarget("pc-b")
        config.upsertComputer(LinkedComputer("pc-b", "", "Home", autoConnect = false))
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.backgroundDelivery.execute(consent.consentId) }
        assertEquals(0, pcs["pc-b"]?.messageCalls?.get() ?: 0)
    }

    @Test fun twoGraphsCannotCommitOrCancelTheSameOperationDuringPcPreparation() = runBlocking {
        computers(); val first = graph(); val second = graph()
        val prepared = first.appApi.prepare(TaskRequest("shared-journal-lease", "Synthetic lease regression",
            TaskRuntime("codex"), targetInstanceId = "pc-b"), first.appApiOwner)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.afterPrepare = { entered.complete(Unit); release.await() }
        val running = async { first.appApi.commit(prepared.preparationId, first.appApiOwner) }
        try {
            withTimeout(5_000) { entered.await() }
            deniedBy(ApiErrorCode.RATE_LIMITED) { second.appApi.commit(prepared.preparationId, second.appApiOwner) }
            deniedBy(ApiErrorCode.RATE_LIMITED) { second.appApi.cancelSubmission(prepared.operationId, second.appApiOwner) }
            deniedBy(ApiErrorCode.RATE_LIMITED) { second.appApi.reconcile(prepared.operationId, second.appApiOwner) }
            assertEquals(0, pc.messageCalls.get())
        } finally { release.complete(Unit) }
        val accepted = withTimeout(5_000) { running.await() }
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals(accepted, second.appApi.commit(prepared.preparationId, second.appApiOwner))
        assertEquals(1, pc.messageCalls.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    private fun foreignCaller(graph: AndroidRuntimeGraph): InstalledCallerIdentity =
        graph.appApiCallerIdentities.installed("com.agentoncloud.android.sharefixture").also {
            assertNotEquals(android.os.Process.myUid(), it.uid)
        }
    private suspend fun approveExternal(graph: AndroidRuntimeGraph, identity: InstalledCallerIdentity) =
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf("pc-b"),
            System.currentTimeMillis() + 60_000, mayCreateSessions = true))

    private suspend fun approveSessionReads(graph: AndroidRuntimeGraph, identity: InstalledCallerIdentity) =
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            SessionCapabilities.descriptors.map { it.id }.toSet(), setOf("pc-b"), System.currentTimeMillis() + 60_000,
            projectIds = setOf("project-a")))

    private suspend fun approveSessionMutations(graph: AndroidRuntimeGraph, identity: InstalledCallerIdentity) =
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            SessionMutationCapabilities.descriptors.map { it.id }.toSet(), setOf("pc-b"), System.currentTimeMillis() + 60_000,
            sessionIds = setOf("shared-session"), projectIds = setOf("project-a")))

    @Test fun assistantDelegationUsesFixedPcAndColdJournalAfterLostResponse() = runBlocking {
        computers(); var graph = graph()
        assertTrue(graph.assistantTasks.listComputers().items.isEmpty())
        val scope = AssistantDelegationScope(AssistantTaskCapabilities.ids, setOf("pc-b"), System.currentTimeMillis() + 60_000,
            mayCreateSessions = true)
        val delegation = graph.assistantDelegations.approve(graph.appApiOwner, scope, graph.assistantDelegations.reviewContext(graph.appApiOwner))
        assertEquals(listOf("pc-b"), graph.assistantTasks.listComputers().items.map { it.instanceId })
        val prepared = graph.assistantTasks.prepare(delegation.id, TaskRequest("assistant-request", "Synthetic assistant task",
            TaskRuntime("test-tool", model = "test-model"), targetInstanceId = "pc-b"))
        pcs.computeIfAbsent("pc-b") { Pc(it) }.loseResponse = true
        val unknown = graph.assistantTasks.commit(delegation.id, prepared.preparationId)
        assertEquals("SUBMITTING", unknown.submissionStage)
        graph.close(); graph = graph()
        val restored = graph.assistantTasks.reconcile(delegation.id, prepared.operationId)
        assertEquals("ACCEPTED", restored.submissionStage)
        assertEquals(1, pcs.getValue("pc-b").posts.get())
        assertEquals(1, pcs.getValue("pc-b").messageCalls.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
        pcs.getValue("pc-b").resultState = "ready"
        val result = graph.assistantTasks.readResult(delegation.id, prepared.operationId)
        assertEquals("READY", result.resultState)
        assertEquals("Exact synthetic result on pc-b", result.text)
        assertFalse(result.cached)
        graph.assistantDelegations.revoke(graph.appApiOwner, delegation.id, delegation.revision)
        try { graph.assistantTasks.get(delegation.id, prepared.operationId); fail("Revoked delegation must not read") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
        assertEquals(1, pcs.getValue("pc-b").posts.get())
    }

    @Test fun graphUnpairAndReconsentDoNotReviveAssistantOperation() = runBlocking {
        computers(); val graph = graph()
        val scope = AssistantDelegationScope(AssistantTaskCapabilities.ids, setOf("pc-b"), System.currentTimeMillis() + 60_000,
            mayCreateSessions = true)
        val old = graph.assistantDelegations.approve(graph.appApiOwner, scope, graph.assistantDelegations.reviewContext(graph.appApiOwner))
        val p = graph.assistantTasks.prepare(old.id, TaskRequest("assistant-request", "Synthetic assistant task", TaskRuntime("test-tool"), targetInstanceId = "pc-b"))
        graph.disconnectTarget("pc-b")
        config.upsertComputer(LinkedComputer("pc-b", "", "Home", autoConnect = false))
        val fresh = graph.assistantDelegations.approve(graph.appApiOwner, scope, graph.assistantDelegations.reviewContext(graph.appApiOwner))
        assertNotEquals(old.caller, fresh.caller)
        try { graph.assistantTasks.commit(fresh.id, p.preparationId); fail("New delegation must not dispatch old preparation") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
        assertEquals(0, pcs.values.sumOf { it.posts.get() })
    }

    @Test fun sessionMutationUsesOriginalPcAndColdJournalAfterLostResponse() = runBlocking {
        computers(); var graph = graph(); val identity = foreignCaller(graph); approveSessionMutations(graph, identity)
        val caller = VerifiedCaller(identity.binding); val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val request = SessionMutationRequest("mutation-test", "pc-b", "shared-session", SessionMutationKind.SET_REVIEWED, flag = true)
        val prepared = graph.appApiSessionMutations.prepare(request, caller)
        assertEquals(0, pc.mutationPosts.get()); assertEquals("pc-a", config.directory.first().activeTargetId)
        pc.loseMutationResponse = true
        try { graph.appApiSessionMutations.commit(request.operationId, caller); fail("Lost response must be unknown") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.RESULT_UNKNOWN, error.error.code) }
        graph.close(); graphs.remove(graph); graph = graph()
        val recovered = graph.appApiSessionMutations.reconcile(request.operationId, caller)
        assertEquals(SessionMutationStage.APPLIED, recovered.stage)
        assertEquals(prepared.command, recovered.command); assertEquals(1, pc.mutationPosts.get()); assertEquals(1, pc.mutationLookups.get())
        assertEquals(0, pc.posts.get()); assertEquals(0, pc.creationCalls.get()); assertEquals(0, pc.messageCalls.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertEquals(0, pcs["pc-a"]?.mutationPosts?.get() ?: 0)
    }
    @Test fun sessionMutationRejectsMovedScopeEvenWhenProjectReturns() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); approveSessionMutations(graph, identity)
        val caller = VerifiedCaller(identity.binding); val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val request = SessionMutationRequest("mutation-test", "pc-b", "shared-session", SessionMutationKind.RENAME, title = "After")
        graph.appApiSessionMutations.prepare(request, caller)
        pc.mutationContext = pc.mutationContext.copy(scopeRevision = UUID.randomUUID().toString())
        try { graph.appApiSessionMutations.commit(request.operationId, caller); fail("Moved scope must conflict") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.REVISION_CONFLICT, error.error.code) }
        assertEquals(0, pc.mutationPosts.get())
    }

    @Test fun publicSessionReadsUseActualProjectAndFixedPcWithoutDispatchOrUiSwitch() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); approveSessionReads(graph, identity)
        val caller = VerifiedCaller(identity.binding); val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val allowed = JSONObject().put("id", "shared-session").put("name", "中文 report").put("projectId", "project-a")
            .put("status", "idle").put("folder", "PRIVATE PATH").put("messages", org.json.JSONArray().put("PRIVATE HISTORY"))
        pc.metadataRows = org.json.JSONArray().put(allowed).put(JSONObject().put("id", "secret").put("name", "secret report").put("projectId", "project-b"))
        pc.metadataSummary = allowed
        val page = graph.appApiSessions.list(SessionQuery("pc-b"), caller)
        assertEquals(listOf("shared-session"), page.items.map { it.sessionId })
        assertEquals(listOf("shared-session"), graph.appApiSessions.list(SessionQuery("pc-b", query = "REPORT"), caller, true).items.map { it.sessionId })
        assertEquals("project-a", graph.appApiSessions.get("pc-b", "shared-session", caller).projectId)
        assertEquals(3, pc.metadataReads.get()); assertEquals(0, pc.posts.get())
        assertEquals(0, pcs["pc-a"]?.metadataReads?.get() ?: 0)
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun sessionApiNeverInheritsDisplayCacheProjectForNullOrMissingScope() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); approveSessionReads(graph, identity)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; pc.navigationProjectId = "project-a"
        graph.withTargetRuntime("pc-b") { assertEquals("project-a", it.sessions.refreshSessionDetail("shared-session")?.projectId) }
        for (explicitNull in listOf(false, true)) {
            val item = JSONObject().put("id", "shared-session").put("name", "Fresh title")
            if (explicitNull) item.put("projectId", JSONObject.NULL)
            pc.metadataRows = org.json.JSONArray().put(item); pc.metadataSummary = item
            assertTrue(graph.appApiSessions.list(SessionQuery("pc-b"), VerifiedCaller(identity.binding)).items.isEmpty())
            try { graph.appApiSessions.get("pc-b", "shared-session", VerifiedCaller(identity.binding)); fail("Null scope was granted") }
            catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
            graph.withTargetRuntime("pc-b") { assertEquals("project-a", it.sessions.observeSession("shared-session").first()?.projectId) }
        }
        assertEquals(0, pc.posts.get())
    }

    @Test fun sessionApiRejectsMalformedMetadataAndWrongResourceIdentity() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); approveSessionReads(graph, identity)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; val caller = VerifiedCaller(identity.binding)
        for (invalid in listOf<Any>(42, true, "", JSONObject())) {
            pc.metadataRows = org.json.JSONArray().put(JSONObject().put("id", "shared-session").put("projectId", invalid))
            try { graph.appApiSessions.list(SessionQuery("pc-b"), caller); fail("Invalid project was accepted") }
            catch (error: AppApiException) { assertEquals(ApiErrorCode.RESULT_UNKNOWN, error.error.code) }
        }
        pc.metadataSummary = JSONObject().put("id", "another-session").put("projectId", "project-a")
        try { graph.appApiSessions.get("pc-b", "shared-session", caller); fail("Wrong identity was accepted") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.RESULT_UNKNOWN, error.error.code) }
        assertEquals(0, pc.posts.get())
    }

    @Test fun sessionApiRevocationDuringRealRoomReadIsNotEmptySuccess() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val granted = approveSessionReads(graph, identity)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.metadataRows = org.json.JSONArray().put(JSONObject().put("id", "shared-session").put("projectId", "project-a"))
        pc.afterMetadataRead = { graph.appApiCallerGrants.revoke(graph.appApiOwner, granted.grantId, granted.revision) }
        try { graph.appApiSessions.list(SessionQuery("pc-b"), VerifiedCaller(identity.binding)); fail("Revocation was accepted") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
        assertEquals(1, pc.metadataReads.get()); assertEquals(0, pc.posts.get())
    }

    @Test fun restrictedProjectUsesFixedPcSessionDetailAndRejectsSpoofedRequestProject() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf("pc-b"),
            System.currentTimeMillis() + 60_000, projectIds = setOf("project-a")))
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.mutationContext = pc.mutationContext.copy(projectId = "project-b", scopeRevision = UUID.randomUUID().toString())
        val request = TaskRequest("scoped-project", "Synthetic project scope", TaskRuntime("codex"),
            targetInstanceId = "pc-b", existingSessionId = "shared-session", projectId = "project-a")
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.appApi.prepare(request, caller) }
        assertEquals(1, pc.scopeReads.get()); assertEquals(0, pc.posts.get()); assertEquals(0, pc.creationCalls.get())
        pc.mutationContext = pc.mutationContext.copy(projectId = "project-a", scopeRevision = UUID.randomUUID().toString())
        val prepared = graph.appApi.prepare(request, caller)
        assertEquals(OperationStage.ACCEPTED, graph.appApi.commit(prepared.preparationId, caller).stage)
        assertTrue(pc.scopeReads.get() >= 3); assertEquals(1, pc.posts.get()); assertEquals(0, pc.creationCalls.get())
        assertEquals(0, pcs["pc-a"]?.posts?.get() ?: 0)
        assertEquals(0, pcs["pc-a"]?.navigationReads?.get() ?: 0)
    }

    @Test fun missingOrNullPcProjectCannotInheritCachedProjectAuthority() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf("pc-b"),
            System.currentTimeMillis() + 60_000, projectIds = setOf("project-a")))
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; pc.navigationProjectId = "project-a"
        graph.withTargetRuntime("pc-b") { assertEquals("project-a", it.sessions.refreshSessionDetail("shared-session")?.projectId) }
        pc.navigationProjectId = null
        pc.mutationContext = pc.mutationContext.copy(projectId = null, scopeRevision = UUID.randomUUID().toString())
        for (explicitNull in listOf(false, true)) {
            pc.navigationProjectExplicitNull = explicitNull
            pc.missingScopeProject = !explicitNull
            deniedBy(if (explicitNull) ApiErrorCode.PERMISSION_DENIED else ApiErrorCode.RESULT_UNKNOWN) {
                graph.appApi.prepare(TaskRequest("missing-project-$explicitNull", "Synthetic missing scope", TaskRuntime("codex"),
                    targetInstanceId = "pc-b", existingSessionId = "shared-session", projectId = "project-a"), caller)
            }
            graph.withTargetRuntime("pc-b") { assertEquals("project-a", it.sessions.observeSession("shared-session").first()?.projectId) }
        }
        assertEquals(1, pc.navigationReads.get()); assertEquals(2, pc.scopeReads.get()); assertEquals(0, pc.posts.get()); assertEquals(0, pc.creationCalls.get())
    }

    @Test fun malformedPcProjectScopeCannotAuthorizeOrDispatch() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf("pc-b"),
            System.currentTimeMillis() + 60_000, projectIds = setOf("project-a")))
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        listOf(42, true, "", JSONObject().put("id", "project-a")).forEachIndexed { index, invalid ->
            pc.navigationProjectInvalid = invalid
            deniedBy(ApiErrorCode.RESULT_UNKNOWN) {
                graph.appApi.prepare(TaskRequest("invalid-scope-$index", "Synthetic invalid scope", TaskRuntime("codex"),
                    targetInstanceId = "pc-b", existingSessionId = "shared-session", projectId = "project-a"), caller)
            }
        }
        assertEquals(4, pc.scopeReads.get()); assertEquals(0, pc.posts.get()); assertEquals(0, pc.creationCalls.get())
    }

    @Test fun scopedContextLookupRechecksActualPersistedGrantAfterPcResponse() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        val grant = graph.appApiCallerGrants.approve(graph.appApiOwner, identity, CallerGrant(identity.binding,
            CapabilityRegistry.coreCapabilities.map { it.id }.toSet(), setOf("pc-b"),
            System.currentTimeMillis() + 60_000, projectIds = setOf("project-a")))
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; pc.navigationProjectId = "project-a"
        pc.afterNavigationRead = { graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision) }
        deniedBy(ApiErrorCode.PERMISSION_DENIED) {
            graph.appApi.prepare(TaskRequest("scoped-revocation", "Synthetic project revocation", TaskRuntime("codex"),
                targetInstanceId = "pc-b", existingSessionId = "shared-session", projectId = "project-a"), caller)
        }
        assertEquals(1, pc.scopeReads.get()); assertEquals(0, pc.posts.get()); assertEquals(0, pc.creationCalls.get())
    }

    @Test fun persistedExternalGrantUsesRealGraphAndFixedTargetThenRevokesAfterReopen() = runBlocking {
        computers(); var graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        assertTrue(graph.appApi.listTargets(caller).isEmpty())
        val grant = approveExternal(graph, identity)
        assertEquals(listOf("pc-b"), graph.appApi.listTargets(caller).map { it.instanceId })
        val prepared = graph.appApi.prepare(TaskRequest("external-granted", "Synthetic grant task", TaskRuntime("codex"), targetInstanceId = "pc-b"), caller)
        val accepted = graph.appApi.commit(prepared.preparationId, caller)
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals("pc-b", accepted.targetInstanceId); assertEquals(1, pcs.getValue("pc-b").posts.get())
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(accepted, graph.appApi.get(prepared.operationId, caller))
        graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, 0)
        assertTrue(graph.appApi.listTargets(caller).isEmpty())
        try { graph.appApi.get(prepared.operationId, caller); fail("Revoked grant was accepted") }
        catch (error: AppApiException) { assertEquals(ApiErrorCode.PERMISSION_DENIED, error.error.code) }
        assertEquals(1, pcs.getValue("pc-b").posts.get())
    }
    @Test fun actualGraphUnpairAndRepairNeverReviveExternalScope() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        approveExternal(graph, identity)
        graph.disconnectTarget("pc-b")
        config.upsertComputer(LinkedComputer("pc-b", "", "Repaired", autoConnect = false))
        assertTrue(graph.appApi.listTargets(caller).isEmpty())
        assertNotNull(graph.appApiCallerGrants.list(graph.appApiOwner).single().revokedAt)
        assertTrue(pcs.values.all { it.posts.get() == 0 })
    }
    @Test fun accountCredentialChangeAndExplicitClearPersistGrantInvalidation() = runBlocking {
        computers(); val graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        val account = com.andysagent.agentoc.core.datastore.AccountSessionMetadata("synthetic-account", "adev_qa_device", "credential-a", "account-directory", "2099-01-01T00:00:00Z")
        config.saveAccountSession(account); approveExternal(graph, identity)
        config.saveAccountSession(account.copy(credentialId = "credential-b"))
        assertTrue(graph.appApi.listTargets(caller).isEmpty())
        config.saveAccountSession(account); assertTrue(graph.appApi.listTargets(caller).isEmpty())
        approveExternal(graph, identity); graph.clearAccountSession()
        config.saveAccountSession(account); assertTrue(graph.appApi.listTargets(caller).isEmpty())
        assertTrue(pcs.values.all { it.posts.get() == 0 })
    }

    @Test fun fcmTokenRegistersEveryConnectedFixedPcRegardlessOfUiSelection() = runBlocking {
        computers(); val graph = graph(); val release = CompletableDeferred<Unit>()
        val ready = listOf(CompletableDeferred<Unit>(), CompletableDeferred<Unit>())
        val held = listOf("pc-a", "pc-b").mapIndexed { index, target ->
            launch { graph.withTargetRuntime(target) { ready[index].complete(Unit); release.await() } }
        }
        try {
            ready.forEach { it.await() }
            graph.registerFcmToken("synthetic-fcm-token")
            assertEquals(listOf("synthetic-fcm-token"), pcs["pc-a"]!!.registeredTokens.toList())
            assertEquals(listOf("synthetic-fcm-token"), pcs["pc-b"]!!.registeredTokens.toList())
            config.selectTarget("pc-b")
            graph.registerFcmToken("replacement-fcm-token", "pc-a")
            assertEquals(listOf("synthetic-fcm-token", "replacement-fcm-token"), pcs["pc-a"]!!.registeredTokens.toList())
            assertEquals(listOf("synthetic-fcm-token"), pcs["pc-b"]!!.registeredTokens.toList())
            assertEquals(0, pcs.values.sumOf { it.posts.get() })
        } finally { release.complete(Unit); held.forEach { it.join() } }
    }

    @Test fun navigationReadsExactSourceBeforeSwitchingUiWithDuplicateSessionIds() = runBlocking {
        computers(); val graph = graph()
        val a = pcs.computeIfAbsent("pc-a") { Pc(it) }; val b = pcs.computeIfAbsent("pc-b") { Pc(it) }
        var opened: String? = null
        graph.navigateToSession(SessionNavigationRequest("shared-session", "pc-b")) { id ->
            assertEquals("pc-b", runBlocking { config.directory.first().activeTargetId })
            assertEquals("From pc-b", runBlocking { graph.sessions.observeSession(id).first() }!!.title)
            opened = id
        }
        assertEquals("shared-session", opened)
        assertEquals(0, a.navigationReads.get()); assertEquals(1, b.navigationReads.get())
        assertEquals(0, a.posts.get()); assertEquals(0, b.posts.get())
    }
    @Test fun navigationNeverDefaultsUnknownOrLegacyTargetsToCurrentComputer() = runBlocking {
        computers(); val graph = graph()
        for ((request, code) in listOf(SessionNavigationRequest("shared-session", "missing") to ApiErrorCode.TARGET_NOT_FOUND,
            SessionNavigationRequest("shared-session") to ApiErrorCode.AMBIGUOUS_TARGET)) {
            try { graph.navigateToSession(request) { fail("Must not open") }; fail("Must reject") }
            catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
        }
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertEquals(0, pcs.values.sumOf { it.navigationReads.get() })
    }
    @Test fun navigationDoesNotSwitchWhenSessionMissingOrPcResponseNamesOtherSession() = runBlocking {
        computers(); val graph = graph(); val b = pcs.computeIfAbsent("pc-b") { Pc(it) }
        for (returned in listOf(null, "other-session")) {
            b.navigationSessionId = returned
            try { graph.navigateToSession(SessionNavigationRequest("shared-session", "pc-b")) { fail("Must not open") }; fail("Must reject") }
            catch (failure: AppApiException) { assertEquals(ApiErrorCode.RESOURCE_NOT_FOUND, failure.error.code) }
            assertEquals("pc-a", config.directory.first().activeTargetId)
        }
    }
    @Test fun unpairedDuringVerificationCannotOpenOrSelectAnotherPc() = runBlocking {
        computers(); val graph = graph(); val b = pcs.computeIfAbsent("pc-b") { Pc(it) }
        b.afterNavigationRead = { config.removeTarget("pc-b") }
        try { graph.navigateToSession(SessionNavigationRequest("shared-session", "pc-b")) { fail("Must not open") }; fail("Must reject") }
        catch (failure: AppApiException) { assertEquals(ApiErrorCode.TARGET_NOT_FOUND, failure.error.code) }
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun pairedNavigationPreservesRepositoryCancellationWithoutSwitchingUi() = runBlocking {
        computers(); val graph = graph(); val b = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val cancelled = CancellationException("Synthetic repository cancellation")
        b.afterNavigationRead = { throw cancelled }
        try { graph.navigateToSession(SessionNavigationRequest("shared-session", "pc-b")) { fail("Must not open") }; fail("Must cancel") }
        catch (failure: CancellationException) { assertSame(cancelled, failure) }
        assertTrue(config.directory.first().computers.any { it.instanceId == "pc-b" })
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun callerCancellationRemainsCancellationEvenWhenComputerIsUnpaired() = runBlocking {
        computers(); val graph = graph(); val b = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val observed = CompletableDeferred<Throwable>()
        b.afterNavigationRead = { entered.complete(Unit); release.await() }
        val navigation = launch {
            try { graph.navigateToSession(SessionNavigationRequest("shared-session", "pc-b")) { fail("Must not open") }; fail("Must cancel") }
            catch (failure: Throwable) { observed.complete(failure) }
        }
        try {
            withTimeout(10_000) { entered.await() }
            navigation.cancel(CancellationException("Caller cancelled navigation"))
            config.removeTarget("pc-b")
        } finally { release.complete(Unit); navigation.cancelAndJoin() }
        assertTrue(withTimeout(10_000) { observed.await() } is CancellationException)
        assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun selectedTextNativeCallbackUsesRealOwnerGraphAndReturnsOnlyExplicitCompleteText() = runBlocking {
        selectionRoundTrip(readOnly = false, resultState = "ready")
    }
    @Test fun readonlyNativeCallbackSavesTaskAndDoesNotChangeSourceSelection() = runBlocking {
        selectionRoundTrip(readOnly = true, resultState = "ready")
    }
    @Test fun longSelectedTaskReleasesSourceAtBudgetAndSavedViewDoesNotResubmit() = runBlocking {
        selectionRoundTrip(readOnly = false, resultState = "running")
    }
    @Test fun truncatedNativeResultKeepsOriginalSourceAndSavedOperation() = runBlocking {
        selectionRoundTrip(readOnly = false, resultState = "ready", truncated = true)
    }
    private suspend fun selectionRoundTrip(readOnly: Boolean, resultState: String, truncated: Boolean = false) {
        computers(); config.setDefaultShareTarget("pc-b")
        val graph = graph()
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }.apply { this.resultState = resultState; resultTruncated = truncated }
        val app = ApplicationProvider.getApplicationContext<AgentoCApplication>()
        val oldLanguage = app.runtime.configStore.appLanguage.first()
        val token = UUID.randomUUID().toString()
        val material = "Synthetic native selection $token"
        val shouldReplace = !readOnly && resultState == "ready" && !truncated
        try {
            app.runtime.configStore.setAppLanguage(AppLanguage.English)
            ProcessTextQaActivity.port = OwnerCaptureWorkflow(graph)
            app.startActivity(Intent().setComponent(ComponentName("com.agentoncloud.android.sharefixture",
                "com.andysagent.agentoc.sharefixture.ProcessTextSourceActivity")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                .putExtra("token", token).putExtra("material", material).putExtra("qa", true).putExtra("readOnly", readOnly))
            compose.waitUntil(10_000) { runBlocking { graph.captureDrafts.observe(graph.appApiOwner).first().any { it.input.sharedText == material } } }
            compose.onNodeWithContentDescription("What should the Agent do?").performTextReplacement("Rewrite selected material")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            compose.onNodeWithText("Test execution tool").performScrollTo().performClick()
            compose.onNodeWithText("Test model").performScrollTo().performClick()
            assertEquals(0, pc.messageCalls.get())
            compose.onNodeWithText("Submit to selected computer").performScrollTo().performClick()
            if (shouldReplace) {
                compose.waitUntil(10_000) { compose.onAllNodesWithText("Replace selected text with this result").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Replace selected text with this result").performScrollTo().assertIsDisplayed()
                assertEquals(1, pc.resultReads.get())
                // Retained VM preserves one wait across ordinary Activity recreation.
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<ProcessTextQaActivity>().single().recreate()
                }
                compose.onNodeWithText("Replace selected text with this result").performScrollTo().performClick()
            }
            var returned: JSONObject? = null
            compose.waitUntil(15_000) { readSelectionReturn(token)?.also { returned = it } != null }
            assertNotEquals(android.os.Process.myUid(), returned!!.getInt("senderUid"))
            assertEquals(if (shouldReplace) android.app.Activity.RESULT_OK else android.app.Activity.RESULT_CANCELED, returned!!.getInt("resultCode"))
            assertEquals("Before: ${if (shouldReplace) "Exact synthetic result on pc-b" else material} :After", returned!!.getString("sourceText"))
            assertEquals(if (shouldReplace) Intent.EXTRA_PROCESS_TEXT else "", returned!!.getString("extraKeys"))
            val draft = graph.captureDrafts.observe(graph.appApiOwner).first().single { it.input.sharedText == material }
            assertNotEquals("forged", draft.draftId); assertEquals(CaptureSource.PROCESS_TEXT, draft.input.source)
            assertEquals(readOnly, draft.input.selectionReadOnly); assertEquals("pc-b", draft.targetInstanceId)
            val saved = graph.appApi.get(draft.operationId!!, graph.appApiOwner)
            assertEquals(OperationStage.ACCEPTED, saved.stage)
            assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
            assertEquals(0, pcs.getValue("pc-a").messageCalls.get())
            if (readOnly) assertEquals(0, pc.resultReads.get())
            else assertEquals(saved.messageRequestId, pc.resultRequestId)
            if (!shouldReplace) {
                // The source must receive cancellation before navigation can cover it.
                // Now exercise the same private saved-task destination explicitly.
                app.startActivity(Intent(app, SavedProcessTextQaActivity::class.java)
                    .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draft.draftId)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK))
                compose.waitUntil(5_000) { compose.onAllNodesWithText("Computer: pc-b").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithText("Computer: pc-b").performScrollTo().assertIsDisplayed()
                compose.onNodeWithText("Operation: ${draft.operationId}").performScrollTo().assertIsDisplayed()
                assertEquals(1, pc.messageCalls.get())
            }
        } finally {
            graph.captureDrafts.observe(graph.appApiOwner).first().filter { it.input.sharedText == material }.forEach {
                app.getSystemService(android.app.NotificationManager::class.java).cancel("capture-${it.draftId}", 1)
            }
            app.runtime.configStore.setAppLanguage(oldLanguage)
        }
    }
    private fun readSelectionReturn(token: String): JSONObject? = runCatching {
        val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
            "run-as com.agentoncloud.android.sharefixture cat files/selection-result.json")
        val body = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
        JSONObject(body).takeIf { it.optString("token") == token }
    }.getOrNull()

    @Test fun shareConnectionCheckUsesFixedLeaseWithoutSelectingOrDispatching() = runBlocking {
        computers(); val graph = graph()
        val port = OwnerCaptureWorkflow(graph)
        val before = config.directory.first()
        assertEquals(CaptureConnectionStatus.AVAILABLE, port.checkConnection("pc-b"))
        assertEquals(before, config.directory.first())
        assertEquals(1, carriers.getValue("pc-b").starts.get())
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        assertEquals(0, pcs.getValue("pc-b").posts.get())
        assertEquals(1, pcs.getValue("pc-b").healthReads.get())
        assertEquals(CaptureConnectionStatus.UNPAIRED, port.checkConnection("unknown-pc"))
        assertEquals(before, config.directory.first())
    }

    @Test fun shareRuntimePreferencesSurviveStoreReopenAndUnpairCannotResurrectThem() = runBlocking {
        computers()
        val a = com.andysagent.agentoc.core.datastore.ShareRuntimeSelection("codex", "provider-a", "model-a")
        val b = com.andysagent.agentoc.core.datastore.ShareRuntimeSelection("other", model = "model-b")
        val before = config.directory.first()
        config.rememberShareRuntime("pc-a", a); config.rememberShareRuntime("pc-b", b)
        storeScope.cancel(); storeScope.coroutineContext[Job]!!.join()
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        preferencesStore = PreferenceDataStoreFactory.create(scope = storeScope) { File(root, "client.preferences_pb") }
        config = ClientConfigStore.withStore(application, preferencesStore)
        val reopened = config.directory.first()
        assertEquals(mapOf("pc-a" to a, "pc-b" to b), reopened.shareRuntimeSelections)
        assertEquals(before.activeTargetId, reopened.activeTargetId)
        assertEquals(before.appApiRouting, reopened.appApiRouting)
        config.removeTarget("pc-b")
        try { config.rememberShareRuntime("pc-b", b); fail("Unpaired preference write must fail") }
        catch (_: IllegalArgumentException) { }
        config.upsertComputer(before.computers.single { it.instanceId == "pc-b" })
        assertEquals(mapOf("pc-a" to a), config.directory.first().shareRuntimeSelections)
        config.clearAccountSession()
        assertTrue(config.directory.first().shareRuntimeSelections.isEmpty())
    }

    @Test fun ownerShareRuntimePreferenceDoesNotConnectSelectOrDispatchAndBadCacheDoesNotBreakRouting() = runBlocking {
        computers(); val graph = graph(); val before = config.directory.first()
        val port = OwnerCaptureWorkflow(graph)
        port.rememberRuntime("pc-b", TaskRuntime("codex", "profile", "model"))
        val after = config.directory.first()
        assertEquals(before.activeTargetId, after.activeTargetId)
        assertEquals(before.appApiRouting, after.appApiRouting)
        assertEquals("profile", after.shareRuntimeSelections.getValue("pc-b").providerProfile)
        assertTrue(carriers.values.all { it.starts.get() == 0 })
        assertTrue(pcs.values.all { it.posts.get() == 0 })
        preferencesStore.edit { it[stringPreferencesKey("share_runtime_selections")] = "{\"version\":2}" }
        assertTrue(config.directory.first().shareRuntimeSelections.isEmpty())
        assertEquals(before.appApiRouting, config.directory.first().appApiRouting)
        port.rememberRuntime("pc-b", TaskRuntime("codex", model = "new-model"))
        assertEquals("new-model", config.directory.first().shareRuntimeSelections.getValue("pc-b").model)
    }

    @Test fun shareConnectionCheckCannotCloseAnotherCallLease() = runBlocking {
        computers(); val graph = graph()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val otherCall = async { graph.withTargetRuntime("pc-b") { entered.complete(Unit); release.await() } }
        try {
            withTimeout(5_000) { entered.await() }
            assertEquals(CaptureConnectionStatus.AVAILABLE, OwnerCaptureWorkflow(graph).checkConnection("pc-b"))
            assertEquals(1, carriers.getValue("pc-b").starts.get())
            assertEquals(0, carriers.getValue("pc-b").closes.get())
            assertEquals(RuntimeConnectionState.Connected, carriers.getValue("pc-b").connectionState.value)
        } finally { release.complete(Unit) }
        withTimeout(5_000) { otherCall.await() }
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        assertEquals(0, pcs.getValue("pc-b").posts.get())
    }

    @Test fun shareConnectionCheckDistinguishesUnavailableAndAuthenticationRequired() = runBlocking {
        computers()
        pcs.computeIfAbsent("pc-b") { Pc(it) }.connects = false
        val graph = graph(connectionWaitTimeoutMs = 500)
        val port = OwnerCaptureWorkflow(graph)
        assertEquals(CaptureConnectionStatus.UNREACHABLE, port.checkConnection("pc-b"))
        val checking = async { port.checkConnection("pc-b") }
        until { carriers.getValue("pc-b").starts.get() == 2 }
        carriers.getValue("pc-b").connectionState.value = RuntimeConnectionState.AuthenticationRequired
        assertEquals(CaptureConnectionStatus.AUTHENTICATION_REQUIRED, checking.await())
        assertEquals(2, carriers.getValue("pc-b").closes.get())
        assertEquals(0, pcs.getValue("pc-b").posts.get())
    }

    @Test fun shareConnectionCheckRequiresFreshValidHealthAndRejectsLostCarrier() = runBlocking {
        computers(); val graph = graph(); val port = OwnerCaptureWorkflow(graph)
        assertEquals(CaptureConnectionStatus.AVAILABLE, port.checkConnection("pc-b"))
        val pc = pcs.getValue("pc-b")
        pc.healthCode = 503
        assertEquals(CaptureConnectionStatus.SERVICE_UNAVAILABLE, port.checkConnection("pc-b"))
        pc.healthCode = 401
        assertEquals(CaptureConnectionStatus.AUTHENTICATION_REQUIRED, port.checkConnection("pc-b"))
        pc.healthCode = 200; pc.healthBody = """{"ok":"true","status":"ready"}"""
        assertEquals(CaptureConnectionStatus.UNKNOWN, port.checkConnection("pc-b"))
        pc.healthBody = "not json"
        assertEquals(CaptureConnectionStatus.UNKNOWN, port.checkConnection("pc-b"))
        pc.healthBody = """{"ok":true,"status":"ready"}"""
        pc.afterHealth = { carriers.getValue("pc-b").connectionState.value = RuntimeConnectionState.Disconnected }
        assertEquals(CaptureConnectionStatus.UNKNOWN, port.checkConnection("pc-b"))
        assertEquals(6, pc.healthReads.get())
        assertEquals(0, pc.posts.get())
    }

    @Test fun headlessAppApiUsesFixedRepositoryAndReleasesItsConnection() = runBlocking {
        computers(); val graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("headless", "Clean data", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        until { carriers.containsKey("pc-a") }
        assertEquals(0, carriers["pc-a"]?.starts?.get())
        val operation = graph.appApi.commit(prepared.preparationId, graph.appApiOwner)
        assertEquals(OperationStage.ACCEPTED, operation.stage)
        assertEquals("session-pc-b", operation.sessionId)
        assertEquals(1, pcs.getValue("pc-b").posts.get())
        assertEquals(1, carriers.getValue("pc-b").starts.get())
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        assertEquals("agentoc.db", databaseNames["pc-a"])
        assertNotEquals("agentoc.db", databaseNames["pc-b"])
        assertTrue(graph.appApi.get("headless", graph.appApiOwner).queued)
    }

    @Test fun resultReadAndColdReopenKeepExactPcRequestAndDoNotResubmit() = runBlocking {
        computers(); var graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("result-read", "Synthetic result task", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val submitted = graph.appApi.commit(prepared.preparationId, graph.appApiOwner)
        val pc = pcs.getValue("pc-b")
        assertTrue(submitted.queued); assertNotNull(submitted.runId)
        val first = graph.appApi.readResult(submitted.operationId, graph.appApiOwner)
        assertEquals(TaskResultState.RUNNING, first.result!!.state); assertNull(first.result!!.text)
        pc.resultState = "ready"
        val ready = graph.appApi.readResult(submitted.operationId, graph.appApiOwner)
        assertEquals("Exact synthetic result on pc-b", ready.result!!.text)
        assertTrue(ready.result!!.canReplaceSelection)
        assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
        assertEquals(0, pcs.getValue("pc-a").resultReads.get())
        assertEquals(submitted.messageRequestId, pc.resultRequestId)
        assertEquals(2, pc.resultReads.get())
        graph.close(); graphs.remove(graph); graph = graph()
        val restored = OwnerCaptureWorkflow(graph).operation(submitted.operationId)
        assertEquals(ready, restored); assertEquals(2, pc.resultReads.get())
        pc.badResultIdentity = true
        val bad = graph.appApi.readResult(submitted.operationId, graph.appApiOwner)
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, bad.lastError!!.code)
        assertEquals(ready.result, bad.result)
        assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
    }

    @Test fun resultExportStreamsCompleteTextAndBinaryFromOriginalComputerAfterColdReopen() = runBlocking {
        computers(); var graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("result-export", "Synthetic export task", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val submitted = graph.appApi.commit(prepared.preparationId, graph.appApiOwner)
        val pc = pcs.getValue("pc-b")
        val queried = graph.appApi.readResultExport(submitted.operationId, graph.appApiOwner)
        assertEquals("pc-b", queried.resultExport!!.instanceId)
        assertEquals(submitted.messageRequestId, queried.resultExport!!.requestId)
        val requestsBeforeReopen = pc.exportReads.get()
        graph.close(); graphs.remove(graph); graph = graph()
        val restored = graph.appApi.get(submitted.operationId, graph.appApiOwner)
        assertEquals(queried, restored); assertEquals(requestsBeforeReopen, pc.exportReads.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
        for (resource in restored.resultExport!!.resources) {
            val expected = if (resource.resourceId == "text") pc.exportText else pc.exportBinary
            val output = java.io.ByteArrayOutputStream(); var blocks = 0
            val receipt = graph.appApi.streamResultExport(restored.operationId, graph.appApiOwner, restored.resultExport!!.revision, resource.resourceId) {
                assertTrue(it.size <= 65_536); output.write(it); blocks++
                assertEquals(RuntimeConnectionState.Connected, carriers.getValue("pc-b").connectionState.value)
            }
            assertArrayEquals(expected, output.toByteArray()); assertEquals(expected.size.toLong(), receipt.sizeBytes)
            assertTrue(blocks >= 3)
            val saved = graph.resultOutputs.download(restored.operationId, graph.appApiOwner,
                restored.resultExport!!.revision, resource.resourceId, "private_${resource.resourceId}")
            assertEquals(ResultOutputState.READY, saved.state)
            val privateCopy = java.io.ByteArrayOutputStream()
            graph.resultOutputs.copyReady(saved.downloadId, graph.appApiOwner) { privateCopy.write(it) }
            assertArrayEquals(expected, privateCopy.toByteArray())
        }
        val readsBeforePrivateReopen = pc.exportReads.get()
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(restored.resultExport!!.resources.size, graph.resultOutputs.list(graph.appApiOwner).size)
        for (resource in restored.resultExport!!.resources) {
            val expected = if (resource.resourceId == "text") pc.exportText else pc.exportBinary
            val privateCopy = java.io.ByteArrayOutputStream()
            graph.resultOutputs.copyReady("private_${resource.resourceId}", graph.appApiOwner) { privateCopy.write(it) }
            assertArrayEquals(expected, privateCopy.toByteArray())
        }
        assertEquals(readsBeforePrivateReopen, pc.exportReads.get())
        assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
        assertEquals(0, pcs.getValue("pc-a").exportReads.get()); assertEquals(queried, graph.appApi.get(submitted.operationId, graph.appApiOwner))
        pc.badExportIdentity = true
        var received = 0
        val failure = try {
            graph.appApi.streamResultExport(restored.operationId, graph.appApiOwner, restored.resultExport!!.revision, "text") { received++ }
            error("Wrong source identity must fail")
        } catch (error: AppApiException) { error.error }
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, failure.code); assertEquals(0, received)
        assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
    }

    @Test fun uploadReplyLossAndGraphReopenKeepOriginalPcAndUseReadOnlyRecovery() = runBlocking {
        computers(); var graph = graph()
        val bytes = "Synthetic attachment".toByteArray()
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val input = FileUploadInput("capture:resource", "sample.txt", "text/plain", bytes.size.toLong(), digest)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.taskScopes["session-pc-b"] = pc.mutationContext.copy(sessionId = "session-pc-b")
        var originalScope: SessionScopeCondition? = null
        pc.loseUploadFinalizeResponse = true
        var lost = false
        try { graph.withTargetRuntime("pc-b") {
            originalScope = it.messages.readScope("session-pc-b")
            it.assets.upload("session-pc-b", input, bytes, originalScope)
        } }
        catch (_: java.io.IOException) { lost = true }
        assertTrue(lost)
        assertEquals(1, pc.uploadIntents.get()); assertEquals(1, pc.uploadBodies.get()); assertEquals(1, pc.uploadFinalizes.get())
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        graph.close(); graphs.remove(graph); graph = graph()
        val recovered = graph.withTargetRuntime("pc-b") { it.assets.findReceipt("session-pc-b", input, originalScope) }!!
        assertTrue(recovered.ready); assertEquals("pc-b", recovered.instanceId)
        val resumed = graph.withTargetRuntime("pc-b") { it.assets.upload("session-pc-b", input, bytes, originalScope) }
        assertEquals(recovered, resumed)
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertEquals(1, pc.uploadIntents.get()); assertEquals(1, pc.uploadBodies.get()); assertEquals(1, pc.uploadFinalizes.get())
        assertEquals(3, pc.uploadLookups.get())
        assertEquals(2, carriers.getValue("pc-b").closes.get())
        assertTrue(pcs.values.all { it.posts.get() == 0 && it.creationCalls.get() == 0 })
        assertEquals(0, pcs.getValue("pc-a").uploadIntents.get())
    }

    @Test fun savedFileConfirmationIsRestoredAfterColdGraphReopenWithoutAnotherUpload() = runBlocking {
        computers(); var graph = graph()
        val bytes = "Synthetic recovery CSV\na,b\n1,2\n".toByteArray()
        val resource = graph.captureResources.importStream("recovery.csv", "text/csv", null, graph.appApiOwner) {
            java.io.ByteArrayInputStream(bytes)
        }
        val prepared = graph.appApi.prepare(TaskRequest("resume-confirmed", "Read the CSV", TaskRuntime("codex"),
            targetInstanceId = "pc-b", resources = listOf(resource.reference())), graph.appApiOwner)
        try {
            graph.appApi.commit(prepared.preparationId, graph.appApiOwner) {
                if (it.phase == TaskUploadPhase.CONFIRMED) throw CancellationException("Stop waiting after saved receipt")
            }
            fail("Expected interruption before message preparation")
        } catch (_: CancellationException) { }
        val original = graph.appApi.get(prepared.operationId, graph.appApiOwner)
        assertEquals(OperationStage.UPLOADING, original.stage)
        assertEquals(1, original.uploads.size)
        val pc = pcs.getValue("pc-b")
        assertEquals(0, pc.messageCalls.get()); assertEquals(1, pc.uploadBodies.get())
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(original, graph.appApi.get(prepared.operationId, graph.appApiOwner))
        val snapshots = mutableListOf<TaskUploadProgress>()
        val accepted = graph.appApi.commit(prepared.preparationId, graph.appApiOwner) {
            assertEquals(0, pc.messageCalls.get()); snapshots += it
        }
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        val snapshot = snapshots.single()
        assertEquals("pc-b", snapshot.targetInstanceId); assertEquals(prepared.operationId, snapshot.operationId)
        assertEquals(TaskUploadPhase.CONFIRMED, snapshot.phase)
        assertEquals(1, snapshot.confirmedFiles); assertEquals(bytes.size.toLong(), snapshot.confirmedBytes)
        assertNull(snapshot.writtenBytes)
        assertEquals(1, pc.uploadBodies.get()); assertEquals(1, pc.uploadFinalizes.get()); assertEquals(1, pc.uploadIntents.get())
        assertEquals(1, pc.messageCalls.get()); assertEquals("pc-a", config.directory.first().activeTargetId)
    }

    @Test fun privateResourceDraftUploadJournalAndMessageReceiptSurviveTwoColdGraphReopens() = runBlocking {
        computers(); config.setDefaultShareTarget("pc-b")
        var graph = graph()
        val original = "Synthetic captured CSV\na,b\n1,2\n".toByteArray()
        val source = original.copyOf()
        val resource = graph.captureResources.importStream("sample.csv", "text/csv", null, graph.appApiOwner) {
            java.io.ByteArrayInputStream(source)
        }
        source.fill(0)
        val draft = CaptureDraft("file-draft", graph.appApiOwner.binding, System.currentTimeMillis(),
            input = CaptureInput(resources = listOf(resource.reference())), instruction = "Analyze the captured sample",
            targetInstanceId = "pc-b", runtime = TaskRuntime("codex"))
        assertTrue(graph.captureDrafts.insert(draft, graph.appApiOwner))
        val frozen = draft.freezeForSubmission(System.currentTimeMillis())
        assertTrue(graph.captureDrafts.replace(frozen, graph.appApiOwner, draft.revision))
        assertFalse(graph.captureResources.delete(resource.resourceId, graph.appApiOwner, resource.revision))
        val preparation = graph.appApi.prepare(frozen.toTaskRequest(), graph.appApiOwner)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; pc.loseUploadFinalizeResponse = true
        val first = graph.appApi.commit(preparation.preparationId, graph.appApiOwner)
        assertEquals(OperationStage.UPLOADING, first.stage)
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, first.lastError!!.code)
        assertTrue(first.uploads.isEmpty()); assertEquals(0, pc.messageCalls.get())
        assertArrayEquals(original, pc.uploadBody)
        val uploadKey = pc.uploadAsset!!.getString("requestId")
        graph.close(); graphs.remove(graph); graph = graph()
        assertEquals(first, graph.appApi.get(first.operationId, graph.appApiOwner))
        assertEquals(frozen, graph.captureDrafts.get(frozen.draftId, graph.appApiOwner))
        assertArrayEquals(original, graph.captureResources.read(resource.reference(), graph.appApiOwner))
        assertEquals(0, pc.messageCalls.get())
        pc.loseResponse = true
        val unknown = graph.appApi.commit(preparation.preparationId, graph.appApiOwner)
        assertEquals(OperationStage.SUBMITTING, unknown.stage)
        assertEquals(1, unknown.uploads.size)
        assertEquals("pc-b", unknown.uploads.single().targetInstanceId)
        assertEquals(uploadKey, pc.uploadAsset!!.getString("requestId"))
        assertEquals(1, pc.uploadIntents.get()); assertEquals(1, pc.uploadBodies.get()); assertEquals(1, pc.uploadFinalizes.get())
        assertEquals(1, pc.creationCalls.get()); assertEquals(1, pc.messageCalls.get())
        val attachment = pc.lastMessage!!.getJSONArray("attachments").getJSONObject(0)
        assertEquals(pc.uploadAsset!!.getString("id"), attachment.getString("assetId"))
        assertEquals("sample.csv", pc.uploadAsset!!.getString("originalName"))
        assertFalse(attachment.has("originalName")) // Metadata stays in the verified asset receipt.
        assertEquals("file", attachment.getString("renderAs"))
        assertFalse(pc.lastMessage.toString().contains("content://"))
        graph.close(); graphs.remove(graph); graph = graph()
        val restored = graph.appApi.get(first.operationId, graph.appApiOwner)
        assertEquals(unknown, restored)
        assertEquals(OperationStage.ACCEPTED, graph.appApi.reconcile(restored.operationId, graph.appApiOwner).stage)
        assertEquals(1, pc.messageCalls.get()); assertEquals(1, pc.uploadBodies.get())
        assertEquals(1, pc.uploadFinalizes.get()); assertEquals(1, pc.uploadIntents.get())
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertEquals(0, pcs.getValue("pc-a").messageCalls.get())
        assertEquals(0, pcs.getValue("pc-a").uploadIntents.get())
        assertFalse(graph.captureResources.delete(resource.resourceId, graph.appApiOwner, resource.revision))
    }

    @Test fun directShortcutUsesExactPcDespiteDifferentDefaultAndUiTarget() = runBlocking {
        computers(); config.setDefaultShareTarget("pc-a")
        val graph = graph(); val models = ViewModelStore()
        try {
            val editor = withContext(Dispatchers.Main) {
                ViewModelProvider(models, object : ViewModelProvider.Factory {
                    override fun <T : ViewModel> create(modelClass: Class<T>): T {
                        @Suppress("UNCHECKED_CAST") return CaptureViewModel(OwnerCaptureWorkflow(graph,
                            shortcutId = CaptureShortcutIds.forTarget("pc-b")), "direct-share",
                            CaptureInput("Synthetic direct share")) as T
                    }
                })[CaptureViewModel::class.java]
            }
            until { !editor.state.value.loading && editor.state.value.catalog.tools.isNotEmpty() }
            assertEquals("pc-b", editor.state.value.draft!!.targetInstanceId)
            assertEquals("pc-a", config.directory.first().activeTargetId)
            assertEquals("pc-a", config.directory.first().appApiRouting.defaultShareTargetId)
            assertEquals(0, pcs.getValue("pc-b").posts.get())
            withContext(Dispatchers.Main) {
                editor.onEvent(CaptureEvent.Instruction("Analyze this material"))
                editor.onEvent(CaptureEvent.Tool("test-tool")); editor.onEvent(CaptureEvent.Model("test-model"))
                editor.onEvent(CaptureEvent.Submit)
            }
            until { editor.state.value.operation?.stage == OperationStage.ACCEPTED }
            assertEquals("pc-b", editor.state.value.operation!!.targetInstanceId)
            assertEquals(1, pcs.getValue("pc-b").creationCalls.get())
            assertEquals(1, pcs.getValue("pc-b").messageCalls.get())
            assertEquals(0, pcs.getValue("pc-a").posts.get())
        } finally { withContext(Dispatchers.Main) { models.clear() } }
    }

    @Test fun ownerShareWorkflowUsesActualCatalogJournalAndReadOnlyRecoveryAfterGraphReopen() = runBlocking {
        computers(); config.setDefaultShareTarget("pc-b")
        var graph = graph()
        var models = ViewModelStore()
        suspend fun newEditor(input: CaptureInput? = null): CaptureViewModel = withContext(Dispatchers.Main) {
            ViewModelProvider(models, object : ViewModelProvider.Factory {
                override fun <T : ViewModel> create(modelClass: Class<T>): T {
                    @Suppress("UNCHECKED_CAST") return CaptureViewModel(OwnerCaptureWorkflow(graph), "owner-share", input) as T
                }
            })[CaptureViewModel::class.java]
        }
        try {
            var editor = newEditor(CaptureInput("Reference https://example.com", listOf("https://example.com")))
            until { !editor.state.value.loading && editor.state.value.catalog.tools.isNotEmpty() }
            assertEquals("pc-b", editor.state.value.draft!!.targetInstanceId)
            assertEquals("pc-a", config.directory.first().activeTargetId)
            assertEquals(0, pcs.getValue("pc-b").posts.get())
            withContext(Dispatchers.Main) {
                editor.onEvent(CaptureEvent.Instruction("Analyze this reference"))
                editor.onEvent(CaptureEvent.Tool("test-tool"))
                editor.onEvent(CaptureEvent.Model("test-model"))
            }
            assertTrue(editor.state.value.canSubmit)
            pcs.getValue("pc-b").loseResponse = true
            withContext(Dispatchers.Main) { editor.onEvent(CaptureEvent.Submit); editor.onEvent(CaptureEvent.Submit) }
            until { !editor.state.value.busy && editor.state.value.operation != null }
            assertEquals(OperationStage.SUBMITTING, editor.state.value.operation!!.stage)
            assertEquals(ApiErrorCode.RESULT_UNKNOWN, editor.state.value.operation!!.lastError!!.code)
            val frozen = graph.captureDrafts.get("owner-share", graph.appApiOwner)!!
            assertEquals("capture_owner-share", frozen.operationId)
            assertNotNull(frozen.preparationId)
            assertEquals(1, pcs.getValue("pc-b").posts.get())
            withContext(Dispatchers.Main) { models.clear() }
            graph.close(); graphs.remove(graph)
            graph = graph(); models = ViewModelStore()
            editor = newEditor()
            until { !editor.state.value.loading && editor.state.value.operation != null }
            assertFalse(editor.state.value.canSubmit)
            assertEquals(frozen, editor.state.value.draft)
            assertEquals(1, pcs.getValue("pc-b").posts.get())
            assertEquals(0, pcs.getValue("pc-b").lookups.get())
            withContext(Dispatchers.Main) { editor.onEvent(CaptureEvent.CheckReceipt) }
            until { !editor.state.value.busy && editor.state.value.operation?.stage == OperationStage.ACCEPTED }
            assertTrue(editor.state.value.operation!!.queued)
            assertEquals(1, pcs.getValue("pc-b").lookups.get())
            assertEquals(1, pcs.getValue("pc-b").posts.get())
            assertEquals("Receipt recovery must not resend even the same request key", 1, pcs.getValue("pc-b").messageCalls.get())
            assertEquals("Graph reopen must not create another session", 1, pcs.getValue("pc-b").creationCalls.get())
            assertEquals(0, pcs.getValue("pc-a").posts.get())
            assertEquals("Reopening verifies original scope; receipt lookup owns another released lease", 2,
                carriers.getValue("pc-b").closes.get())
        } finally { withContext(Dispatchers.Main) { models.clear() } }
    }

    @Test fun targetDisposalJoinsItsCancelledObserversBeforeClosingRoom() = runBlocking {
        computers(); val graph = graph()
        val cancelled = CompletableDeferred<Unit>(); val finishObserver = CompletableDeferred<Unit>()
        runtimeScopes.getValue("pc-a").launch(start = CoroutineStart.UNDISPATCHED) {
            try { awaitCancellation() }
            finally { withContext(NonCancellable) { cancelled.complete(Unit); finishObserver.await() } }
        }
        val closing = async(Dispatchers.Default) { graph.close() }
        try {
            withTimeout(5_000) { cancelled.await() }
            assertFalse(closing.isCompleted)
            assertEquals(0, databaseCloses["pc-a"]?.get() ?: 0)
        } finally {
            finishObserver.complete(Unit)
            withTimeout(5_000) { closing.await() }
            graphs.remove(graph)
        }
        assertEquals(1, databaseCloses.getValue("pc-a").get())
    }

    @Test fun reopeningGraphRestoresPrimaryBeforeBackgroundAndLeavesPairedOnlyIdle() = runBlocking {
        config.upsertComputer(LinkedComputer("pc-a", "", "Primary", autoConnect = false), select = true)
        config.upsertComputer(LinkedComputer("pc-b", "", "Background", autoConnect = true))
        config.upsertComputer(LinkedComputer("pc-c", "", "Paired only", autoConnect = false))
        var graph = graph()
        connectionStartOrder.clear()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"]?.starts?.get() == 1 && carriers["pc-b"]?.starts?.get() == 1 }
        assertEquals(listOf("pc-a", "pc-b"), connectionStartOrder.toList())
        until { graph.targetConnectionStates.value == mapOf("pc-a" to RuntimeConnectionState.Connected,
            "pc-b" to RuntimeConnectionState.Connected) }
        assertNull(carriers["pc-c"])
        assertEquals("pc-a", config.directory.first().activeTargetId)
        val previousA = carriers.getValue("pc-a"); val previousB = carriers.getValue("pc-b")
        graph.close(); graphs.remove(graph)
        assertTrue(graph.targetConnectionStates.value.isEmpty())
        assertEquals(1, previousA.closes.get()); assertEquals(1, previousB.closes.get())
        connectionStartOrder.clear()
        graph = graph()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"] !== previousA && carriers["pc-a"]?.starts?.get() == 1 &&
            carriers["pc-b"] !== previousB && carriers["pc-b"]?.starts?.get() == 1 }
        assertEquals(listOf("pc-a", "pc-b"), connectionStartOrder.toList())
        until { graph.targetConnectionStates.value == mapOf("pc-a" to RuntimeConnectionState.Connected,
            "pc-b" to RuntimeConnectionState.Connected) }
        assertNull(carriers["pc-c"])
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertEquals(0, pcs.values.sumOf { it.posts.get() })
    }

    @Test fun foregroundSwitchAndStopDoNotCloseConnectionHeldBySubmission() = runBlocking {
        computers(); val graph = graph(); val pc = pcs.computeIfAbsent("pc-a") { Pc(it) }
        pc.blockSubmission = CompletableDeferred()
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"]?.starts?.get() == 1 }
        val prepared = graph.appApi.prepare(TaskRequest("held", "Task", TaskRuntime("codex"), targetInstanceId = "pc-a"), graph.appApiOwner)
        val submit = async { graph.appApi.commit(prepared.preparationId, graph.appApiOwner) }
        pc.messageEntered.await()
        assertFalse("Submission must still hold its target lease", submit.isCompleted)
        config.upsertComputer(LinkedComputer("pc-b", "", "Home", autoConnect = false), select = true)
        until { carriers["pc-b"]?.starts?.get() == 1 }
        withContext(Dispatchers.Main) { graph.onStop(owner) }
        until { carriers.getValue("pc-b").closes.get() == 1 }
        assertEquals(0, carriers.getValue("pc-a").closes.get())
        pc.blockSubmission!!.complete(Unit)
        assertEquals(OperationStage.ACCEPTED, submit.await().stage)
        assertEquals(1, carriers.getValue("pc-a").closes.get())
        assertEquals(1, pc.posts.get()); assertEquals(0, pcs.getValue("pc-b").posts.get())
    }

    @Test fun responseLossReconcilesAfterGraphAndRoomReopenWithoutAnotherPost() = runBlocking {
        computers(); var graph = graph()
        val prepared = graph.appApi.prepare(TaskRequest("recover", "Task", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }; pc.loseResponse = true
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, graph.appApi.commit(prepared.preparationId, graph.appApiOwner).lastError!!.code)
        graph.close(); graphs.remove(graph)
        graph = graph()
        val confirmed = graph.appApi.reconcile("recover", graph.appApiOwner)
        assertEquals(OperationStage.ACCEPTED, confirmed.stage)
        assertTrue(confirmed.queued)
        assertEquals(1, pc.posts.get()); assertEquals(1, pc.lookups.get())
    }

    @Test fun scopedJournalColdRoomReopenRejectsAtoBtoAWithoutNewPreparation() = runBlocking {
        computers(); var graph = graph()
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val prepared = graph.appApi.prepare(TaskRequest("scoped-cold", "Synthetic frozen scope", TaskRuntime("codex"),
            targetInstanceId = "pc-b", existingSessionId = "shared-session"), graph.appApiOwner)
        val original = graph.appApi.get(prepared.operationId, graph.appApiOwner).originalScope!!
        graph.close(); graphs.remove(graph)
        pc.mutationContext = pc.mutationContext.copy(projectId = "project-b", scopeRevision = UUID.randomUUID().toString())
        pc.mutationContext = pc.mutationContext.copy(projectId = "project-a", scopeRevision = UUID.randomUUID().toString())
        graph = graph()
        deniedBy(ApiErrorCode.REVISION_CONFLICT) { graph.appApi.commit(prepared.preparationId, graph.appApiOwner) }
        val db = AppApiDatabase.open(application)
        try {
            val retained = RoomOperationStore(db).get(prepared.operationId)!!
            assertEquals(1, retained.messageProtocolVersion); assertEquals(original, retained.originalScope)
            assertNull(retained.pcPreparationId); assertEquals(0, pc.posts.get()); assertTrue(pc.preparations.isEmpty())
        } finally { db.close() }
    }

    @Test fun knownScopedAcceptanceIsJournaledBeforeRevokedCallerDelivery() = runBlocking {
        computers(); var graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        val grant = approveExternal(graph, identity)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val prepared = graph.appApi.prepare(TaskRequest("accepted-revoke", "Synthetic accepted task", TaskRuntime("codex"),
            targetInstanceId = "pc-b"), caller)
        pc.afterCommit = { graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision) }
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.appApi.commit(prepared.preparationId, caller) }
        graph.close(); graphs.remove(graph); graph = graph()
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.appApi.get(prepared.operationId, caller) }
        val db = AppApiDatabase.open(application)
        try {
            val retained = RoomOperationStore(db).get(prepared.operationId)!!
            assertEquals(OperationStage.ACCEPTED, retained.stage); assertNotNull(retained.pcPreparationId)
            assertTrue(retained.commitReceipt!!.accepted); assertEquals(retained.runId, retained.commitReceipt!!.runId)
            assertEquals(ApiErrorCode.PERMISSION_DENIED, retained.lastError!!.code); assertEquals(1, pc.posts.get())
        } finally { db.close() }
    }

    @Test fun preparationReplyAfterRevocationStaysPrivateAndCannotCommit() = runBlocking {
        computers(); var graph = graph(); val identity = foreignCaller(graph); val caller = VerifiedCaller(identity.binding)
        val grant = approveExternal(graph, identity)
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        val prepared = graph.appApi.prepare(TaskRequest("prepared-revoke", "Synthetic prepared task", TaskRuntime("codex"),
            targetInstanceId = "pc-b"), caller)
        pc.afterPrepare = { graph.appApiCallerGrants.revoke(graph.appApiOwner, grant.grantId, grant.revision) }
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.appApi.commit(prepared.preparationId, caller) }
        graph.close(); graphs.remove(graph); graph = graph()
        deniedBy(ApiErrorCode.PERMISSION_DENIED) { graph.appApi.get(prepared.operationId, caller) }
        val db = AppApiDatabase.open(application)
        try {
            val retained = RoomOperationStore(db).get(prepared.operationId)!!
            assertEquals(OperationStage.MESSAGE_PREPARING, retained.stage); assertNotNull(retained.originalScope)
            assertNotNull(retained.pcPreparationId); assertNull(retained.runId); assertNull(retained.commitReceipt)
            assertEquals(ApiErrorCode.PERMISSION_DENIED, retained.lastError!!.code)
            assertEquals(1, pc.preparations.size); assertEquals(0, pc.posts.get())
        } finally { db.close() }
    }

    @Test fun unsupportedScopedProtocolCannotCreateSessionOrFallBackToLegacyMessage() = runBlocking {
        computers(); val graph = graph(); val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.scopedProtocolSupported = false
        val prepared = graph.appApi.prepare(TaskRequest("unsupported-scoped", "Synthetic unsupported task", TaskRuntime("codex"),
            targetInstanceId = "pc-b"), graph.appApiOwner)
        assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, graph.appApi.commit(prepared.preparationId, graph.appApiOwner).lastError!!.code)
        assertEquals(0, pc.creationCalls.get()); assertEquals(0, pc.messageCalls.get()); assertTrue(pc.preparations.isEmpty())
    }

    @Test fun cancellationAndUnpairingRevokeUseWithoutRedirectingToAnotherPc() = runBlocking {
        computers(); val graph = graph(); val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.blockSubmission = CompletableDeferred()
        val prepared = graph.appApi.prepare(TaskRequest("cancelled", "Task", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val submit = launch { graph.appApi.commit(prepared.preparationId, graph.appApiOwner) }
        pc.messageEntered.await(); submit.cancelAndJoin()
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, graph.appApi.get(prepared.operationId, graph.appApiOwner).lastError!!.code)
        graph.disconnectTarget("pc-b")
        deniedBy(ApiErrorCode.TARGET_NOT_FOUND) { graph.appApi.commit(prepared.preparationId, graph.appApiOwner) }
        assertEquals(1, pc.posts.get()); assertEquals(0, pcs.getValue("pc-a").posts.get())
    }

    @Test fun legacyDatabaseBindingSurvivesFirstComputerRemovalAndConfigurationReset() = runBlocking {
        computers(); var graph = graph()
        until { databaseNames.containsKey("pc-a") }
        assertEquals("agentoc.db", databaseNames["pc-a"])
        graph.disconnectTarget("pc-a")
        graph.close(); graphs.remove(graph)
        carriers.clear(); databaseNames.clear()
        graph = graph()
        graph.executeOnTarget("pc-b", ApiRequest("GET", "/api/session-creation-contract"))
        assertNotEquals("agentoc.db", databaseNames["pc-b"])
        graph.close(); graphs.remove(graph)
        config.clear()
        config.upsertComputer(LinkedComputer("pc-c", "", "New", autoConnect = false), select = true)
        graph = graph()
        graph.executeOnTarget("pc-c", ApiRequest("GET", "/api/session-creation-contract"))
        assertNotEquals("agentoc.db", databaseNames["pc-c"])
    }

    @Test fun firstPairingAfterEmptyStartupEstablishesLegacyBindingBeforeHeadlessAccess() = runBlocking {
        val graph = graph()
        assertTrue(graph.appApi.listTargets(graph.appApiOwner).isEmpty())
        config.upsertComputer(LinkedComputer("first-pc", "", "First", autoConnect = false), select = true)
        val prepared = graph.appApi.prepare(TaskRequest("first-task", "Task", TaskRuntime("codex")), graph.appApiOwner)
        assertEquals(OperationStage.ACCEPTED, graph.appApi.commit(prepared.preparationId, graph.appApiOwner).stage)
        assertEquals("agentoc.db", databaseNames["first-pc"])
        assertEquals(1, carriers.getValue("first-pc").closes.get())
    }

    @Test fun sharingDefaultAndAliasesSurviveStorageReopenWithoutFollowingUiSelection() = runBlocking {
        computers()
        config.setDefaultShareTarget("pc-b")
        config.setTargetAliases("pc-b", listOf(" 主力电脑 ", "Gaming", "gaming"))
        var graph = graph()
        val request = TaskRequest("default-before", "Task", TaskRuntime("codex"))
        assertEquals("pc-b", graph.appApi.prepare(request, graph.appApiOwner).targetInstanceId)
        assertEquals("pc-a", config.directory.first().activeTargetId)
        graphs.forEach { it.close() }; graphs.clear()
        storeScope.coroutineContext[Job]?.cancelAndJoin()
        storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        preferencesStore = PreferenceDataStoreFactory.create(scope = storeScope) { File(root, "client.preferences_pb") }
        config = ClientConfigStore.withStore(application, preferencesStore)
        graph = graph()
        assertEquals("pc-b", graph.appApi.prepare(request.copy(operationId = "default-after"), graph.appApiOwner).targetInstanceId)
        assertEquals("pc-b", graph.appApi.prepare(request.copy(operationId = "alias-after", targetAlias = "主力电脑"), graph.appApiOwner).targetInstanceId)
        val b = graph.appApi.listTargets(graph.appApiOwner).first { it.instanceId == "pc-b" }
        assertEquals(setOf("主力电脑", "Gaming"), b.aliases)
        assertTrue(pcs.values.all { it.posts.get() == 0 })
    }

    @Test fun removedDefaultAndDuplicateAliasesNeverRedirectToRemainingComputer() = runBlocking {
        computers(); val graph = graph()
        config.setDefaultShareTarget("pc-b")
        config.setTargetAliases("pc-a", listOf("Shared"))
        config.setTargetAliases("pc-b", listOf("shared"))
        val request = TaskRequest("ambiguous", "Task", TaskRuntime("codex"), targetAlias = "SHARED")
        val ambiguous = try { graph.appApi.prepare(request, graph.appApiOwner); error("Alias must be ambiguous") }
            catch (error: AppApiException) { error.error }
        assertEquals(ApiErrorCode.AMBIGUOUS_TARGET, ambiguous.code)
        graph.disconnectTarget("pc-b")
        val missing = try { graph.appApi.prepare(request.copy(operationId = "missing", targetAlias = null), graph.appApiOwner); error("Default must be missing") }
            catch (error: AppApiException) { error.error }
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, missing.code)
        assertEquals("pc-b", config.directory.first().appApiRouting.defaultShareTargetId)
        assertFalse(config.directory.first().appApiRouting.aliasesByTarget.containsKey("pc-b"))
        config.setDefaultShareTarget(null)
        assertEquals("pc-a", graph.appApi.prepare(request.copy(operationId = "explicit-clear", targetAlias = null), graph.appApiOwner).targetInstanceId)
        assertTrue(pcs.values.all { it.posts.get() == 0 })
    }

    @Test fun unpairingLastMigratedComputerDoesNotResurrectLegacyConfiguration() = runBlocking {
        preferencesStore.edit {
            it[stringPreferencesKey("endpoint")] = "https://old.invalid"
            it[stringPreferencesKey("instance_id")] = "legacy-pc"
            it[stringPreferencesKey("label")] = "Old"
        }
        config.migrateLegacy()
        config.setDefaultShareTarget("legacy-pc")
        assertTrue(config.directory.first().automaticAccountRestoreAllowed)
        val graph = graph()
        graph.disconnectTarget("legacy-pc")
        assertTrue(config.directory.first().computers.isEmpty())
        assertFalse(config.directory.first().automaticAccountRestoreAllowed)
        config.migrateLegacy()
        assertTrue(config.directory.first().computers.isEmpty())
        assertTrue(graph.appApi.listTargets(graph.appApiOwner).isEmpty())
        assertEquals("legacy-pc", config.directory.first().appApiRouting.defaultShareTargetId)
        val reopened = ClientConfigStore.withStore(application, preferencesStore)
        reopened.migrateLegacy()
        assertTrue(reopened.directory.first().computers.isEmpty())
        assertFalse(reopened.directory.first().automaticAccountRestoreAllowed)
        reopened.allowAutomaticAccountRestore()
        assertTrue(reopened.directory.first().automaticAccountRestoreAllowed)
        assertTrue(reopened.directory.first().computers.isEmpty())
    }

    @Test fun disconnectReleasesTheCarrierBeforeClearingItsCredential() = runBlocking {
        config.upsertComputer(LinkedComputer("pc-a", "", "Office", autoConnect = true), select = true)
        val graph = graph()
        graph.credentialStore.write("pc-a", "rda_synthetic_release_order", "2099-01-01T00:00:00Z", "device-access")
        withContext(Dispatchers.Main) { graph.onStart(owner) }
        until { carriers["pc-a"]?.connectionState?.value == RuntimeConnectionState.Connected }
        var authenticatedAtStop = false
        carriers.getValue("pc-a").beforeStop = { authenticatedAtStop = !graph.credentialStore.readToken("pc-a").isNullOrBlank() }
        graph.disconnectTarget("pc-a")
        assertTrue("Lease teardown must retain its bearer until stop", authenticatedAtStop)
        assertTrue(graph.credentialStore.readToken("pc-a").isNullOrBlank())
        assertTrue(config.directory.first().computers.isEmpty())
    }

    @Test fun unreadableRoutingBlocksHeadlessCallsUntilOwnerResetButKeepsUiDirectory() = runBlocking {
        computers(); val graph = graph()
        preferencesStore.edit { it[stringPreferencesKey("app_api_routing")] = "{\"version\":2}" }
        val directory = config.directory.first()
        assertFalse(directory.appApiRouting.readable)
        assertEquals(2, directory.computers.size)
        assertEquals("pc-a", directory.activeTargetId)
        val request = TaskRequest("bad-routing", "Task", TaskRuntime("codex"), targetInstanceId = "pc-b")
        val failure = try { graph.appApi.prepare(request, graph.appApiOwner); error("Unreadable settings must block routing") }
            catch (error: AppApiException) { error.error }
        assertEquals(ApiErrorCode.INTERNAL_ERROR, failure.code)
        config.resetAppApiRouting()
        assertEquals("pc-b", graph.appApi.prepare(request, graph.appApiOwner).targetInstanceId)
        assertEquals("pc-a", config.directory.first().activeTargetId)
        assertTrue(pcs.values.all { it.posts.get() == 0 })
    }

    @Test fun invalidRoutingEditsLeavePreviousSettingsIntact() = runBlocking {
        computers()
        config.setDefaultShareTarget("pc-b")
        config.setTargetAliases("pc-b", listOf("Gaming"))
        val before = config.directory.first().appApiRouting
        val invalidEdits: List<suspend () -> Unit> = listOf(
            { config.setDefaultShareTarget("unknown") },
            { config.setTargetAliases("unknown", listOf("Name")) },
            { config.setTargetAliases("pc-b", listOf("bad\nalias")) },
            { config.setTargetAliases("pc-b", (1..9).map { "Alias $it" }) },
        )
        for (edit in invalidEdits) {
            var rejected = false
            try { edit() } catch (_: IllegalArgumentException) { rejected = true }
            assertTrue("Invalid edit must fail", rejected)
            assertEquals(before, config.directory.first().appApiRouting)
        }
    }

    @Test fun connectionBudgetReturnsOfflineReceiptAndCanRetrySamePreparation() = runBlocking {
        computers()
        val pc = pcs.computeIfAbsent("pc-b") { Pc(it) }
        pc.connects = false
        val graph = graph(connectionWaitTimeoutMs = 100)
        val prepared = graph.appApi.prepare(TaskRequest("offline", "Task", TaskRuntime("codex"), targetInstanceId = "pc-b"), graph.appApiOwner)
        val offline = graph.appApi.commit(prepared.preparationId, graph.appApiOwner)
        assertEquals(ApiErrorCode.TARGET_OFFLINE, offline.lastError!!.code)
        assertTrue(offline.lastError!!.retryable)
        assertEquals(OperationStage.CONNECTING, offline.stage)
        assertEquals(0, pc.posts.get())
        assertEquals(1, carriers.getValue("pc-b").closes.get())
        pc.connects = true
        assertEquals(OperationStage.ACCEPTED, graph.appApi.commit(prepared.preparationId, graph.appApiOwner).stage)
        assertEquals(1, pc.posts.get())
        assertEquals(2, carriers.getValue("pc-b").closes.get())
    }

    private class Pc(val id: String) {
        var brokerPort: Int = 0
        var brokerP2p: WebRTCDataChannelTransport? = null
        val healthReads = AtomicInteger()
        var healthCode = 200
        var healthBody = """{"ok":true,"status":"ready"}"""
        var afterHealth: () -> Unit = {}
        val taskScopes = ConcurrentHashMap<String, SessionMutationContext>()
        val preparations = ConcurrentHashMap<String, ScopedMessageRequest>()
        val scopeReads = AtomicInteger()
        var missingScopeProject = false
        var scopedProtocolSupported = true
        var afterCommit: (suspend () -> Unit)? = null
        var afterPrepare: (suspend () -> Unit)? = null
        fun runId(key: String) = "run_appapi_" + UUID.nameUUIDFromBytes(key.toByteArray()).toString().replace("-", "")
        fun preparationId(key: String) = "mprep_" + UUID.nameUUIDFromBytes(key.toByteArray())
        var mutationContext = SessionMutationContext(1, "shared-session", "project-a", UUID.randomUUID().toString(),
            UUID.randomUUID().toString(), "Before", false, false, false, null, 64)
        val mutationPosts = AtomicInteger(); val mutationLookups = AtomicInteger()
        val mutationReceipts = ConcurrentHashMap<String, SessionMutationReceipt>()
        var loseMutationResponse = false
        val registeredTokens = java.util.concurrent.CopyOnWriteArrayList<String>()
        val navigationReads = AtomicInteger()
        var navigationSessionId: String? = "shared-session"
        var navigationProjectId: String? = null
        var navigationProjectExplicitNull = false
        var navigationProjectInvalid: Any? = null
        var afterNavigationRead: (suspend () -> Unit)? = null
        var metadataRows = org.json.JSONArray()
        var metadataSummary: JSONObject? = null
        val metadataReads = AtomicInteger()
        var afterMetadataRead: (suspend () -> Unit)? = null
        val posts = AtomicInteger(); val lookups = AtomicInteger()
        val messageCalls = AtomicInteger(); val creationCalls = AtomicInteger()
        val requests = ConcurrentHashMap<String, String>()
        val messageEntered = CompletableDeferred<Unit>()
        var blockSubmission: CompletableDeferred<Unit>? = null
        var loseResponse = false
        var connects = true
        val uploadIntents = AtomicInteger(); val uploadBodies = AtomicInteger()
        val uploadFinalizes = AtomicInteger(); val uploadLookups = AtomicInteger()
        var uploadAsset: JSONObject? = null
        var uploadBody: ByteArray? = null
        var uploadCheckpointOffset = 0L
        val uploadBuffer = ByteArrayOutputStream()
        var loseUploadFinalizeResponse = false
        var lastMessage: JSONObject? = null
        val resultReads = AtomicInteger()
        var resultState = "running"
        var resultTruncated = false
        var resultRequestId: String? = null
        var badResultIdentity = false
        val exportReads = AtomicInteger()
        val exportText = ("Complete synthetic result 中文🙂\n".repeat(6_000) + "END").toByteArray(Charsets.UTF_8)
        val exportBinary = ByteArray(180_000) { it.toByte() }
        var badExportIdentity = false
    }
    private inner class Carrier(private val pc: Pc, private val onStart: () -> Unit = {}) : AgentoCTransport, TargetConnectionController {
        var beforeStop: (() -> Unit)? = null
        val starts = AtomicInteger(); val closes = AtomicInteger(); val refreshes = AtomicInteger()
        override val invalidations = MutableSharedFlow<InvalidationHint>(extraBufferCapacity = 1)
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
        override fun start() { starts.incrementAndGet(); onStart(); connectionState.value = if (pc.connects) RuntimeConnectionState.Connected else RuntimeConnectionState.Connecting }
        override suspend fun stop() { beforeStop?.invoke() }
        override suspend fun close() { closes.incrementAndGet(); pc.brokerP2p?.close(); connectionState.value = RuntimeConnectionState.Disconnected }
        override fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan) { require(plan.contract.instanceId == pc.id) }
        override fun refresh() { refreshes.incrementAndGet() }
        override fun connectInvalidationSocket() {}
        private fun scopeContract(): String {
            val effects = org.json.JSONArray()
            for ((id, method, path) in listOf(
                Triple("message.prepare", "POST", ScopedMessageClient.PREPARE_PATH),
                Triple("message.preparation.receipt", "GET", ScopedMessageClient.RECEIPT_PATH),
                Triple("message.commit", "POST", ScopedMessageClient.COMMIT_PATH),
                Triple("message.commit.receipt", "GET", ScopedMessageClient.COMMIT_PATH),
                Triple("asset.upload.intent", "POST", "/api/assets/upload-intents"),
                Triple("asset.upload.body", "POST", "/api/assets/{assetId}/upload"),
                Triple("asset.upload.chunk", "PATCH", "/api/assets/{assetId}/upload"),
                Triple("asset.upload.checkpoint", "GET", "/api/assets/{assetId}/upload-checkpoint"),
                Triple("asset.upload.finalize", "POST", "/api/assets/{assetId}/finalize"),
                Triple("asset.upload.receipt", "GET", "/api/assets/upload-intents?sessionId={sessionId}&requestId={requestId}"))) {
                effects.put(JSONObject().put("id", id).put("method", method).put("path", path).apply {
                    if (method == "GET") put("readonly", true)
                    if (id == "message.prepare") put("startsRun", false)
                    if (id == "message.commit") put("durableQueue", true)
                    if (id == "asset.upload.body") put("stagedBeforeGuard", true)
                    if (id == "asset.upload.finalize") put("verifiedBeforeGuard", true)
                })
            }
            return JSONObject().put("version", 1).put("header", SessionScopeCondition.HEADER)
                .put("encoding", "base64url-utf8-json").put("maxHeaderBytes", 4096).put("maxDecodedBytes", 2048)
                .put("contextPath", "/api/sessions/{sessionId}/app-api-context")
                .put("fields", org.json.JSONArray(listOf("version", "sessionId", "expectedScopeRevision", "expectedProjectId")))
                .put("effects", effects).toString()
        }
        private fun requireScope(request: ApiRequest, sessionId: String) {
            val header = request.headers[SessionScopeCondition.HEADER] ?: error("Scoped API request has no condition")
            val supplied = SessionMutationJson.decodeFromString(SessionScopeCondition.serializer(),
                String(java.util.Base64.getUrlDecoder().decode(header), Charsets.UTF_8)).validate()
            val context = pc.taskScopes[sessionId] ?: pc.mutationContext
            check(context.sessionId == sessionId)
            if (supplied.sessionId != sessionId || supplied.expectedScopeRevision != context.scopeRevision || supplied.expectedProjectId != context.projectId)
                throw ApiException(409, "REVISION_CONFLICT", "Original scope changed", false)
        }
        override suspend fun execute(request: ApiRequest): ApiResponse {
            check(connectionState.value == RuntimeConnectionState.Connected)
            if (pc.brokerPort != 0 && request.path.startsWith("/api/windows-privileged-broker/")) {
                pc.brokerP2p?.let { p2p ->
                    val headers = request.headers + mapOf("Authorization" to "Bearer rdt_${"a".repeat(64)}", "Content-Type" to "application/json")
                    val response = p2p.request(P2PHttpRequest(id = UUID.randomUUID().toString(), method = request.method,
                        path = request.path, headers = headers, bodyBase64 = request.body?.let(P2PProtocol::encodeBody) ?: "")).getOrThrow()
                    return ApiResponse(response.status, P2PProtocol.decodeBodyToString(response.bodyBase64), response.headers)
                }
                return fixtureRequest(pc.brokerPort, request)
            }
            if (request.path == "/healthz") {
                check(request.method == "GET")
                pc.healthReads.incrementAndGet()
                pc.afterHealth()
                if (pc.healthCode != 200) throw ApiException(pc.healthCode, null, "Synthetic health response")
                return ApiResponse(200, pc.healthBody)
            }
            if (request.path == "/api/session-scope-contract") return ApiResponse(200,
                if (pc.scopedProtocolSupported) scopeContract() else """{"version":0}""")
            if (request.path == "/api/message-preparation-contract") return ApiResponse(200, JSONObject()
                .put("version", 1).put("preparesOnly", true).put("startsRun", false).put("commitSupported", true)
                .put("scopeHeader", SessionScopeCondition.HEADER).put("scopeContractPath", "/api/session-scope-contract")
                .put("maxBodyBytes", 131072).put("maxTextBytes", 65536).put("commitBodyBytes", 4096)
                .put("maxAttachments", 16).put("maxLifetimeSeconds", 86400)
                .put("attachmentOptionKeys", org.json.JSONArray(listOf("renderAs")))
                .put("runOptionKeys", org.json.JSONArray(ScopedMessageRequest.OPTION_KEYS.toList()))
                .put("preparePath", ScopedMessageClient.PREPARE_PATH).put("receiptPath", ScopedMessageClient.RECEIPT_PATH)
                .put("commitPath", ScopedMessageClient.COMMIT_PATH).put("commitReceiptPath", ScopedMessageClient.COMMIT_PATH).toString())
            if ("/app-api-message-preparations" in request.path) {
                val parts = android.net.Uri.parse(request.path).pathSegments
                val sessionId = parts[2]; requireScope(request, sessionId)
                if (parts.size == 4) {
                    check(request.method == "POST")
                    val prepared = SessionMutationJson.decodeFromString(ScopedMessageRequest.serializer(), request.body!!).validate()
                    val old = pc.preparations.putIfAbsent(prepared.requestId, prepared)
                    check(old == null || old == prepared)
                    pc.afterPrepare?.invoke()
                    return ApiResponse(200, SessionMutationJson.encodeToString(ScopedMessagePreparation.serializer(), ScopedMessagePreparation(
                        1, sessionId, prepared.requestId, pc.preparationId(prepared.requestId), "prepared", old != null,
                        "2026-10-11T00:00:00.000Z", prepared.expiresAt, false, false)))
                }
                val key = parts[4]
                val prepared = pc.preparations[key] ?: return ApiResponse(404, """{"code":"RESOURCE_NOT_FOUND"}""")
                if (parts.size == 5) return ApiResponse(200, SessionMutationJson.encodeToString(ScopedMessagePreparation.serializer(),
                    ScopedMessagePreparation(1, sessionId, key, pc.preparationId(key), "prepared", false,
                        "2026-10-11T00:00:00.000Z", prepared.expiresAt, false, false)))
                check(parts[5] == "commit")
                if (request.method == "POST") {
                    check(JSONObject(request.body!!).getString("preparationId") == pc.preparationId(key))
                    pc.messageCalls.incrementAndGet(); pc.lastMessage = JSONObject(SessionMutationJson.encodeToString(ScopedMessageRequest.serializer(), prepared))
                    if (pc.requests.putIfAbsent(key, "accepted") == null) pc.posts.incrementAndGet()
                    pc.messageEntered.complete(Unit); pc.blockSubmission?.await()
                    pc.afterCommit?.invoke()
                    if (pc.loseResponse) { pc.loseResponse = false; throw java.io.IOException("Response lost") }
                } else { check(request.method == "GET"); pc.lookups.incrementAndGet() }
                val accepted = pc.requests.containsKey(key)
                return ApiResponse(200, SessionMutationJson.encodeToString(ScopedMessageCommitReceipt.serializer(), ScopedMessageCommitReceipt(
                    1, sessionId, key, pc.preparationId(key), if (accepted) pc.runId(key) else null,
                    if (accepted) "queued" else "unconfirmed", accepted, accepted, false, prepared.expiresAt,
                    if (accepted) "2026-10-11T00:00:00.000Z" else null, "2026-10-11T00:00:00.000Z", null, false, null)))
            }
            if (request.path == "/api/session-mutation-contract") {
                check(request.method == "GET")
                return ApiResponse(200, SessionMutationJson.encodeToString(SessionMutationProtocol.serializer(),
                    SessionMutationProtocol(1, SessionMutationKind.entries, 8192, 200, 256, 256, 64, true,
                        "/api/sessions/{sessionId}/app-api-context", "/api/sessions/{sessionId}/app-api-mutations",
                        "/api/sessions/{sessionId}/app-api-mutations/{requestId}")))
            }
            if (request.path.startsWith("/api/sessions/") && request.path.endsWith("/app-api-context")) {
                check(request.method == "GET")
                pc.scopeReads.incrementAndGet(); pc.afterNavigationRead?.invoke()
                val id = android.net.Uri.parse(request.path).pathSegments[2]
                val context = pc.taskScopes[id] ?: pc.mutationContext
                val json = JSONObject(SessionMutationJson.encodeToString(SessionMutationContext.serializer(), context))
                if (pc.missingScopeProject) json.remove("projectId")
                pc.navigationProjectInvalid?.let { json.put("projectId", it) }
                return ApiResponse(200, json.toString())
            }
            if (request.path.startsWith("/api/sessions/shared-session/app-api-mutations/")) {
                check(request.method == "GET"); pc.mutationLookups.incrementAndGet()
                val receipt = pc.mutationReceipts[request.path.substringAfterLast('/')]
                return ApiResponse(200, if (receipt == null) "null" else SessionMutationJson.encodeToString(SessionMutationReceipt.serializer(), receipt))
            }
            if (request.path == "/api/sessions/shared-session/app-api-mutations") {
                check(request.method == "POST" && request.contentType == "application/json"); pc.mutationPosts.incrementAndGet()
                val command = SessionMutationJson.decodeFromString(SessionMutationCommand.serializer(), request.body!!).validate()
                val old = pc.mutationContext
                val existing = pc.mutationReceipts[command.requestId]
                if (existing != null) return ApiResponse(200, SessionMutationJson.encodeToString(SessionMutationReceipt.serializer(), existing.copy(duplicate = true)))
                if (old.revision != command.expectedRevision || old.scopeRevision != command.expectedScopeRevision || old.projectId != command.expectedProjectId)
                    throw ApiException(409, "REVISION_CONFLICT", "Changed scope", false)
                pc.mutationContext = old.copy(revision = UUID.randomUUID().toString())
                val receipt = SessionMutationReceipt(1, command.requestId, old.sessionId, command.kind, true,
                    pc.mutationContext.revision, old.scopeRevision, "2026-10-11T00:00:00Z", old.projectId, false)
                pc.mutationReceipts[command.requestId] = receipt
                if (pc.loseMutationResponse) { pc.loseMutationResponse = false; throw java.io.IOException("Response lost") }
                return ApiResponse(200, SessionMutationJson.encodeToString(SessionMutationReceipt.serializer(), receipt))
            }
            if (request.path == "/api/push/fcm/register" && request.method == "POST") {
                pc.registeredTokens += JSONObject(request.body!!).getString("token")
                return ApiResponse(200, """{"ok":true}""")
            }
            if (request.path == "/api/sessions" && request.method == "GET") {
                pc.metadataReads.incrementAndGet(); pc.afterMetadataRead?.invoke()
                return ApiResponse(200, JSONObject().put("sessions", pc.metadataRows).toString())
            }
            if (request.path == "/api/sessions/shared-session?view=summary" && request.method == "GET") {
                pc.metadataReads.incrementAndGet(); pc.afterMetadataRead?.invoke()
                return ApiResponse(200, JSONObject().put("session", pc.metadataSummary ?: JSONObject().put("id", "shared-session").put("projectId", JSONObject.NULL)).toString())
            }
            if (request.path == "/api/sessions/shared-session" && request.method == "GET") {
                pc.navigationReads.incrementAndGet(); pc.afterNavigationRead?.invoke()
                return ApiResponse(200, JSONObject().put("session", JSONObject().apply {
                    pc.navigationSessionId?.let { put("id", it); put("name", "From ${pc.id}") }
                    pc.navigationProjectId?.let { put("projectId", it) }
                        ?: if (pc.navigationProjectExplicitNull) put("projectId", JSONObject.NULL) else Unit
                    pc.navigationProjectInvalid?.let { put("projectId", it) }
                }).toString())
            }
            if (request.path == "/api/asset-upload-contract") return ApiResponse(200,
                """{"version":1,"maximumBytes":1073741824,"requestIdMaximumLength":200,"sha256Required":true,"readonlyReceiptLookup":true}""")
            if (request.path.startsWith("/api/assets/upload-intents?") && request.method == "GET") {
                pc.uploadLookups.incrementAndGet()
                val uri = android.net.Uri.parse(request.path)
                requireScope(request, uri.getQueryParameter("sessionId")!!)
                val asset = pc.uploadAsset
                if (asset == null || asset.getString("requestId") != uri.getQueryParameter("requestId")
                    || asset.getString("sessionId") != uri.getQueryParameter("sessionId")) {
                    return ApiResponse(404, """{"code":"FILE_ASSET_NOT_FOUND"}""")
                }
                return ApiResponse(200, JSONObject().put("uploadContractVersion", 1).put("asset", asset).toString())
            }
            if (request.path == "/api/assets/upload-intents" && request.method == "POST") {
                pc.uploadIntents.incrementAndGet()
                val body = JSONObject(request.body!!)
                requireScope(request, body.getString("sessionId"))
                val asset = pc.uploadAsset ?: JSONObject(body.toString()).put("id", "fasset_${"b".repeat(24)}")
                    .put("status", "pending_upload").put("scopeContractVersion", 1).also { pc.uploadAsset = it }
                check(asset.getString("requestId") == body.getString("requestId"))
                val upload = JSONObject().put("method", "POST").put("url", "/api/assets/${asset.getString("id")}/upload")
                    .put("headers", JSONObject().put("Content-Type", body.getString("mimeType")))
                val resumable = JSONObject().put("version", 1).put("chunkBytes", 262144)
                    .put("checksum", "sha256").put("fixedChunks", true)
                return ApiResponse(200, JSONObject().put("uploadContractVersion", 1).put("asset", asset)
                    .put("resumableUpload", resumable).put("upload", upload).toString())
            }
            if (request.path.startsWith("/api/assets/") && request.path.endsWith("/upload-checkpoint")) {
                requireScope(request, pc.uploadAsset!!.getString("sessionId"))
                val checkpoint = JSONObject().put("uploadCheckpointVersion", 1).put("assetId", pc.uploadAsset!!.getString("id"))
                    .put("offset", pc.uploadCheckpointOffset).put("totalBytes", pc.uploadAsset!!.getLong("sizeBytes"))
                    .put("sha256", pc.uploadAsset!!.getString("sha256")).put("chunkBytes", 262144)
                    .put("status", if (pc.uploadCheckpointOffset == pc.uploadAsset!!.getLong("sizeBytes")) "uploaded" else "uploading")
                return ApiResponse(200, checkpoint.toString())
            }
            if (request.path.startsWith("/api/assets/") && request.path.endsWith("/upload")) {
                requireScope(request, pc.uploadAsset!!.getString("sessionId"))
                check(request.method == "PATCH" && request.contentType == "application/octet-stream")
                check(request.headers.getValue("X-Agentoc-Upload-Offset").toLong() == pc.uploadCheckpointOffset)
                val chunk = request.bodyBytes!!
                check(request.headers.getValue("X-Agentoc-Upload-Length").toInt() == chunk.size)
                pc.uploadBodies.incrementAndGet(); pc.uploadBuffer.write(chunk)
                pc.uploadCheckpointOffset += chunk.size.toLong()
                pc.uploadBody = pc.uploadBuffer.toByteArray()
                val sha = java.security.MessageDigest.getInstance("SHA-256").digest(chunk).joinToString("") { "%02x".format(it) }
                check(sha == request.headers.getValue("X-Agentoc-Upload-Sha256"))
                return ApiResponse(200, JSONObject().put("uploadCheckpointVersion", 1)
                    .put("assetId", pc.uploadAsset!!.getString("id")).put("offset", pc.uploadCheckpointOffset).toString())
            }
            if (request.path.startsWith("/api/assets/") && request.path.endsWith("/finalize")) {
                requireScope(request, pc.uploadAsset!!.getString("sessionId"))
                pc.uploadFinalizes.incrementAndGet()
                val asset = pc.uploadAsset!!
                check(pc.uploadBody!!.size.toLong() == asset.getLong("sizeBytes"))
                val sha = java.security.MessageDigest.getInstance("SHA-256").digest(pc.uploadBody!!).joinToString("") { "%02x".format(it) }
                check(sha == asset.getString("sha256")); asset.put("status", "ready")
                if (pc.loseUploadFinalizeResponse) { pc.loseUploadFinalizeResponse = false; throw java.io.IOException("Upload finalize acknowledgement lost") }
                return ApiResponse(200, JSONObject().put("asset", asset).toString())
            }
            if (request.path == "/api/tools") return ApiResponse(200, """{"tools":[{"id":"test-tool","name":"Test execution tool"}]}""")
            if (request.path.startsWith("/api/native-providers?")) return ApiResponse(200, """{"providers":[]}""")
            if (request.path.startsWith("/api/models?")) return ApiResponse(200, """{"models":[{"id":"test-model","label":"Test model"}]}""")
            if (request.path == "/api/session-creation-contract") return ApiResponse(200, """{"version":1}""")
            if (request.path == "/api/sessions" && request.method == "POST") {
                pc.creationCalls.incrementAndGet()
                val body = JSONObject(request.body!!)
                pc.taskScopes["session-${pc.id}"] = pc.mutationContext.copy(sessionId = "session-${pc.id}",
                    projectId = if (body.isNull("projectId") || !body.has("projectId")) null else body.getString("projectId"))
                return ApiResponse(201, """{"session":{"id":"session-${pc.id}"},"duplicate":false,"creationContractVersion":1}""")
            }
            if (request.path.endsWith("/messages")) {
                pc.messageCalls.incrementAndGet()
                pc.lastMessage = JSONObject(request.body!!)
                val key = JSONObject(request.body!!).getString("requestId")
                if (pc.requests.putIfAbsent(key, "accepted") == null) pc.posts.incrementAndGet()
                pc.messageEntered.complete(Unit)
                pc.blockSubmission?.await()
                if (pc.loseResponse) { pc.loseResponse = false; throw java.io.IOException("Response lost") }
                return ApiResponse(202, """{"requestId":"$key","queued":true,"duplicate":false,"run":null}""")
            }
            if (request.path == "/api/result-export-contract") return ApiResponse(200,
                """{"version":1,"maxChunkBytes":65536,"maxTextBytes":26214400,"maxFileBytes":26214400,"maxBatchBytes":104857600,"maxResources":17,"snapshotTtlMs":900000}""")
            if ("/message-results/" in request.path && "/exports" in request.path) {
                check(request.method == "GET"); pc.exportReads.incrementAndGet()
                val uri = android.net.Uri.parse(request.path)
                val key = uri.pathSegments[4]; check(pc.requests.containsKey(key))
                check(uri.pathSegments[2] == "session-${pc.id}")
                fun sha(bytes: ByteArray) = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                val json = JSONObject().put("exportContractVersion", 1).put("instanceId", if (pc.badExportIdentity) "wrong-pc" else pc.id)
                    .put("sessionId", "session-${pc.id}").put("requestId", key).put("runId", pc.runId(key))
                    .put("finalRunId", pc.runId(key)).put("revision", "b".repeat(64))
                if (uri.pathSegments.size == 6) {
                    val resources = org.json.JSONArray()
                    for ((id, bytes) in listOf("text" to pc.exportText, "fasset_${"b".repeat(24)}" to pc.exportBinary)) {
                        resources.put(JSONObject().put("resourceId", id).put("originalName", if (id == "text") "result.txt" else "report.bin")
                            .put("mimeType", if (id == "text") "text/plain" else "application/octet-stream")
                            .put("available", true).put("sizeBytes", bytes.size).put("sha256", sha(bytes)))
                    }
                    return ApiResponse(200, json.put("resources", resources).put("totalBytes", pc.exportText.size + pc.exportBinary.size)
                        .put("maxChunkBytes", 65_536).put("expiresAt", "2099-01-01T00:00:00Z").toString())
                }
                val id = uri.pathSegments[6]
                check(id == "text" || id == "fasset_${"b".repeat(24)}")
                val bytes = if (id == "text") pc.exportText else pc.exportBinary
                val offset = uri.getQueryParameter("offset")!!.toInt(); val length = uri.getQueryParameter("length")!!.toInt()
                val block = bytes.copyOfRange(offset, minOf(bytes.size, offset + length))
                return ApiResponse(200, json.put("resourceId", id).put("offset", offset).put("nextOffset", offset + block.size)
                    .put("eof", offset + block.size == bytes.size).put("sizeBytes", bytes.size).put("sha256", sha(bytes))
                    .put("chunkSha256", sha(block)).put("dataBase64", java.util.Base64.getEncoder().encodeToString(block)).toString())
            }
            if ("/message-results/" in request.path) {
                check(request.method == "GET")
                pc.resultReads.incrementAndGet()
                val key = android.net.Uri.decode(request.path.substringAfterLast('/'))
                check(pc.requests.containsKey(key)); pc.resultRequestId = key
                val ready = pc.resultState == "ready"
                val json = JSONObject().put("resultContractVersion", 1).put("sessionId", "session-${pc.id}")
                    .put("requestId", if (pc.badResultIdentity) "other-request" else key).put("state", pc.resultState)
                    .put("runId", pc.runId(key)).put("finalRunId", if (ready) pc.runId(key) else JSONObject.NULL)
                    .put("text", if (ready) "Exact synthetic result on ${pc.id}" else JSONObject.NULL)
                    .put("textTruncated", pc.resultTruncated).put("hasAttachments", false).put("artifacts", org.json.JSONArray())
                    .put("observedAt", "2026-10-11T00:00:00Z")
                return ApiResponse(200, json.toString())
            }
            if ("/message-receipts/" in request.path) {
                pc.lookups.incrementAndGet()
                val key = android.net.Uri.decode(request.path.substringAfterLast('/'))
                val state = if (pc.requests.containsKey(key)) "accepted" else "unconfirmed"
                return ApiResponse(200, """{"receiptContractVersion":1,"sessionId":"session-${pc.id}","requestId":"$key","state":"$state","queued":true,"runId":null}""")
            }
            error("Unexpected request ${request.method} ${request.path}")
        }
    }
}
