package com.andysagent.agentoc

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.room.Room
import com.andysagent.agentoc.core.auth.AndroidCredentialStore
import com.andysagent.agentoc.core.auth.AndroidAccountCredentialStore
import com.andysagent.agentoc.core.auth.AndroidP2PSecretStore
import com.andysagent.agentoc.core.auth.AndroidDeviceIdentityStore
import com.andysagent.agentoc.core.auth.AndroidTemporaryClaimJournal
import com.andysagent.agentoc.core.auth.AndroidTemporaryTextOperationJournal
import com.andysagent.agentoc.core.auth.AndroidTemporaryAttachmentByteStore
import com.andysagent.agentoc.core.auth.AccountSessionChallenge
import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.auth.AccountSessionManager
import com.andysagent.agentoc.core.auth.ClientConfigAccountSessionStore
import com.andysagent.agentoc.core.auth.PairingAuthenticator
import com.andysagent.agentoc.core.auth.PairingResult
import com.andysagent.agentoc.core.auth.defaultDeviceAlias
import com.andysagent.agentoc.core.auth.shouldAutoConnectQrClaim
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.datastore.ClientConfigStore
import com.andysagent.agentoc.core.datastore.ComputerDirectory
import com.andysagent.agentoc.core.datastore.StoredInstance
import com.andysagent.agentoc.core.datastore.StoredGoogleAccountProfile
import com.andysagent.agentoc.core.datastore.LinkedComputer
import com.andysagent.agentoc.core.datastore.PendingGoogleBinding
import com.andysagent.agentoc.core.domain.DefaultAccountsRepository
import com.andysagent.agentoc.core.domain.AccountDirectoryDevice
import com.andysagent.agentoc.core.protocol.AccountRendezvousTargetInstanceDto
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.core.domain.ActiveAccountSession
import com.andysagent.agentoc.core.domain.AccountSessionStateSource
import com.andysagent.agentoc.core.domain.AccountSessionVerification
import com.andysagent.agentoc.core.domain.GoogleAccountIdentityStore
import com.andysagent.agentoc.core.domain.GoogleAccountProfile
import com.andysagent.agentoc.core.domain.RoomSessionRepository
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SwitchingSessionRepository
import com.andysagent.agentoc.core.network.AndroidNetworkMonitor
import com.andysagent.agentoc.core.network.BootstrapConnectionPlan
import com.andysagent.agentoc.core.network.BootstrapConnectionPlanFactory
import com.andysagent.agentoc.core.network.BootstrapP2PCredentials
import com.andysagent.agentoc.core.network.ConnectionBootstrapClient
import com.andysagent.agentoc.core.network.ConnectivitySupervisor
import com.andysagent.agentoc.core.network.ConnectionStatus
import com.andysagent.agentoc.core.network.OkHttpAgentoCTransport
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.SwitchingAgentoCTransport
import com.andysagent.agentoc.core.network.TurnCarrier
import com.andysagent.agentoc.core.network.TransportKind
import com.andysagent.agentoc.core.p2p.P2PSessionFactory
import com.andysagent.agentoc.core.p2p.WebRTCDataChannelTransport
import com.andysagent.agentoc.core.protocol.parsePairingUri
import com.andysagent.agentoc.core.protocol.PairingUriDto
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.OtherDeviceProject
import com.andysagent.agentoc.core.protocol.ProtocolCodec
import com.andysagent.agentoc.core.protocol.TargetSummary
import com.andysagent.agentoc.feature.workbench.WebHarness
import com.andysagent.agentoc.feature.workbench.WebHarnessMutationResult
import com.andysagent.agentoc.feature.workbench.WebHarnessOperation
import com.andysagent.agentoc.feature.workbench.WebHarnessTarget
import com.andysagent.agentoc.feature.workbench.WebHarnessTargetSnapshot
import com.andysagent.agentoc.feature.workbench.parseWebHarnesses
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest
import java.util.UUID
import com.andysagent.agentoc.core.appapi.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class AgentoCApplication : Application(), com.andysagent.agentoc.integration.appfunctions.AssistantAppFunctionsHost {
    override val assistantAppFunctions: AssistantTaskBridge get() = runtime.assistantTasks

    val runtime: AndroidRuntimeGraph by lazy {
        check(!isDocumentExportProcess()) { "Document worker cannot initialize PC runtime" }
        android.os.Trace.beginSection("AgentoC.runtime.construct")
        try { AndroidRuntimeGraph(this) } finally { android.os.Trace.endSection() }
    }

    override fun onCreate() {
        super.onCreate()
        val oldHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            android.util.Log.e("APP_CRASH", "FATAL APP CRASH", e)
            oldHandler?.uncaughtException(t, e)
        }
        if (isDocumentExportProcess()) return
        // Background API/notification delivery must not spend Android's process
        // bind/start timeout loading the entire runtime on the main thread.
        // Lazy remains the single instance; only lifecycle registration is Main.
        Thread({
            runCatching { removeRetiredPhoneWhisperModels() }
                .onFailure { android.util.Log.w("VoiceSettingsMigration", "Could not remove retired phone Whisper files", it) }
            runCatching { ResultMaintenanceSchedule.ensureScheduled(this) }
                .onFailure { android.util.Log.w("ResultMaintenance", "Local maintenance registration requires retry") }
            val graph = runtime
            runCatching {
                kotlinx.coroutines.runBlocking { graph.configStore.clearRetiredPhoneVoicePreferences() }
            }.onFailure { android.util.Log.w("VoiceSettingsMigration", "Could not clear retired phone voice preferences", it) }
            android.os.Handler(android.os.Looper.getMainLooper()).post { graph.start() }
        }, "AgentoCRuntimeInit").start()
    }

    /** Remove only model files previously downloaded by the retired phone-Whisper feature. */
    private fun removeRetiredPhoneWhisperModels() {
        val modelDirectory = java.io.File(filesDir, "voice-models")
        listOf("ggml-tiny-q5_1.bin", "ggml-base-q5_1.bin").forEach { modelName ->
            modelDirectory.resolve(modelName).delete()
            modelDirectory.resolve("$modelName.partial").delete()
        }
        if (modelDirectory.isDirectory && modelDirectory.list()?.isEmpty() == true) modelDirectory.delete()
    }

    private fun isDocumentExportProcess(): Boolean {
        val name = if (android.os.Build.VERSION.SDK_INT >= 28) getProcessName()
            else java.io.File("/proc/self/cmdline").readText().substringBefore('\u0000')
        return name == "$packageName:document_export"
    }
}

internal const val BOOTSTRAP_RETRY_BASE_MS = 1_000L
internal const val BOOTSTRAP_RETRY_MAX_MS = 30_000L

/**
 * Account-rendezvous targets intentionally have no reusable target endpoint:
 * every carrier must start from a fresh account-authorized contract.  Keep the
 * last selected one warm when the app returns to the foreground, provided the
 * user has not opted that device out of automatic reconnection.
 */
internal fun shouldRenewAccountRendezvousOnForeground(
    target: LinkedComputer?,
    activeInstanceId: String?,
    foreground: Boolean,
): Boolean = foreground &&
    target != null &&
    target.instanceId == activeInstanceId &&
    target.autoConnect &&
    target.endpoint.isBlank()

/**
 * Durable connection roles to restore when the process is created again.  The
 * directory is the source of truth here rather than an in-memory carrier: on
 * a cold start the latter has not been populated yet.
 */
internal data class AutomaticConnectionRecoveryPlan(
    val primaryInstanceId: String?,
    val backgroundInstanceIds: List<String>,
)

internal suspend fun awaitConnectedComputer(
    states: StateFlow<Map<String, RuntimeConnectionState>>,
    instanceId: String,
    timeoutMs: Long,
): Boolean = withTimeoutOrNull(timeoutMs) {
    states.first { it[instanceId] == RuntimeConnectionState.Connected }
} != null

/**
 * Select the automatically restored background carriers under the
 * account-authoritative concurrent-computer allowance. The primary computer
 * reserves one slot; background order remains the owner's stored order.
 */
internal fun automaticBackgroundTargetIds(
    computers: List<LinkedComputer>,
    activeInstanceId: String?,
    maximumConcurrentConnections: Int,
): List<String> = computers
    .asSequence()
    .filter { it.autoConnect && it.instanceId != activeInstanceId }
    .take((maximumConcurrentConnections.coerceAtLeast(1) - 1).coerceAtLeast(0))
    .map { it.instanceId }
    .toList()

/**
 * Resolve all durable roles before any carrier has been recreated.  This
 * prevents the persisted primary from being briefly treated as a background
 * computer during app relaunch.
 */
internal fun automaticConnectionRecoveryPlan(
    directory: com.andysagent.agentoc.core.datastore.ComputerDirectory,
    maximumConcurrentConnections: Int,
): AutomaticConnectionRecoveryPlan {
    // autoConnect controls background retention; the durable selected primary
    // has always been restored even in legacy directories where it is false.
    val primaryInstanceId = directory.activeTarget?.instanceId
    return AutomaticConnectionRecoveryPlan(
        primaryInstanceId = primaryInstanceId,
        backgroundInstanceIds = automaticBackgroundTargetIds(
            computers = directory.computers,
            activeInstanceId = primaryInstanceId,
            maximumConcurrentConnections = maximumConcurrentConnections,
        ),
    )
}

private class AccountTargetUnavailable(instanceId: String) : IllegalStateException(
    "The selected computer ($instanceId) is no longer available.",
)

/** Preserve the v3 QR's authenticated target identity for endpoint-less joins. */
internal fun pairingTargetFromInvitation(
    invitation: PairingUriDto,
): AccountRendezvousTargetInstanceDto? = if (invitation.endpoint.isBlank()) {
    AccountRendezvousTargetInstanceDto(
        instanceId = invitation.instanceId,
        publicKey = invitation.instancePublicKey.orEmpty(),
        keyFingerprint = invitation.instanceKeyFingerprint.orEmpty(),
    )
} else {
    null
}

class AndroidRuntimeGraph internal constructor(
    private val application: Application,
    private val targetFactoryOverride: TargetRuntimeFactory? = null,
    private val configOverride: ClientConfigStore? = null,
    private val notificationRegistrar: (() -> Unit)? = null,
    private val connectionWaitTimeoutMs: Long = 30_000L,
) : DefaultLifecycleObserver {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val initialized = CompletableDeferred<Unit>()
    private val configurationMutex = Mutex()
    // Protected by configurationMutex; prevents a stale request from crossing
    // an account or active-computer transition even if an ID is reused.
    private var otherDeviceProjectionEpoch = 0L
    private val accountCapacityMutex = Mutex()
    private val fcmRegistrationMutex = Mutex()
    private val startGuard = java.util.concurrent.atomic.AtomicBoolean()
    @Volatile private var stopped = false
    @Volatile private var activeInstanceId: String? = null
    @Volatile private var primaryDatabaseInstanceId: String? = null
    @Volatile private var pendingFcmToken: String? = null
    @Volatile private var foreground = false
    @Volatile private var retainUiConnections = false
    @Volatile private var maximumConcurrentAccountConnections = 1
    @Volatile private var accountCapacityRefreshNeeded = true
    @Volatile private var accountCapacityLastSuccessMs: Long? = null
    @Volatile private var accountCapacityRetrySuppressed = false
    @Volatile private var accountCapacityRetryFloorMs = 0L
    @Volatile private var uiBackgroundTargetIds: Set<String> = emptySet()
    private val accountCapacityRetry by lazy { TargetCapacityRetry(scope,
        eligible = { id -> foreground && !stopped && activeInstanceId == id && accountCapacityRefreshNeeded && !accountCapacityRetrySuppressed &&
            !accountCredentialStore.readToken().isNullOrBlank() },
        minimumDelayMs = { accountCapacityRetryFloorMs },
        attempt = { id ->
            if (!refreshAccountConnectionCapacity(onlyIfNeeded = true)) false
            else {
                try {
                    if (foreground && !stopped && activeInstanceId == id) synchronizeDirectory()
                    true
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { accountCapacityRefreshNeeded = true; false }
            }
        }) }
    private val accountRendezvous = TargetRendezvousCoordinator()
    private data class SharedRendezvous(val result: PairingResult, val label: String, val credentialFingerprint: String)
    private val accountRendezvousSingleFlight = AccountRendezvousSingleFlight<SharedRendezvous>()
    private val targetPairingCommits = TargetPairingCommits(configurationMutex)
    private val backgroundConnectMutex = Mutex()
    private var accountRestoreJob: Job? = null
    val configStore = configOverride ?: ClientConfigStore(application)
    val accountIdentityStore: GoogleAccountIdentityStore = object : GoogleAccountIdentityStore {
        override val profile = configStore.googleAccountProfile.map { stored ->
            stored?.let {
                GoogleAccountProfile(
                    displayName = it.displayName,
                    email = it.email,
                    photoUrl = it.photoUrl,
                )
            }
        }

        override suspend fun save(profile: GoogleAccountProfile) {
            configStore.saveGoogleAccountProfile(
                StoredGoogleAccountProfile(
                    displayName = profile.displayName,
                    email = profile.email,
                    photoUrl = profile.photoUrl,
                ),
            )
        }

        override suspend fun clearSelectedAccount() {
            configStore.clearGoogleAccountProfile()
        }
    }
    /** Target-scoped rda_ credentials; never used for Accounts directory calls. */
    val credentialStore = AndroidCredentialStore(application)
    /** Account-scoped rac_ credential; separate Keystore alias and preference namespace. */
    val accountCredentialStore = AndroidAccountCredentialStore(application)
    val p2pSecretStore = AndroidP2PSecretStore(application)
    val identityStore = AndroidDeviceIdentityStore(application)
    val accountDeviceAlias: String = identityStore.defaultDeviceAlias()
    private val targetRuntimes = java.util.concurrent.ConcurrentHashMap<String, TargetRuntime>()
    @Volatile private var tabletChatTargetId: String? = null
    private val connectionUses = TargetConnectionLeases<TargetRuntime> { instanceId ->
        val target = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId }
            ?: throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
        // Direct bootstrap can reserve immediately. Endpoint-less rendezvous
        // instead waits at its grant boundary, after harmless intent creation.
        if (target.endpoint.isNotBlank()) awaitColdTurnRecovery()
        ensureTargetRuntime(target)
    }
    private val appApiDatabase = lazy { AppApiDatabase.open(application) }
    internal val appApiOwner = VerifiedCaller("agentoc:internal-owner")
    internal val appApiCallerIdentities by lazy { AndroidCallerIdentityVerifier(application) }
    private val assistantDelegationDatabase = lazy { AssistantDelegationDatabase.open(application) }
    internal suspend fun appApiGrantContext(): CallerGrantContext {
        initialized.await()
        val account = configStore.accountSession.first()
        val material = account?.let { "${it.accountId.length}:${it.accountId}${it.deviceId.length}:${it.deviceId}${it.credentialId.length}:${it.credentialId}" } ?: "local-owner"
        val binding = MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        return CallerGrantContext(binding, configStore.directory.first().computers.map { it.instanceId }.toSet())
    }
    internal val assistantDelegations by lazy {
        RoomAssistantDelegationStore(assistantDelegationDatabase.value, appApiOwner, ::appApiGrantContext)
    }
    internal val assistantTasks by lazy { AssistantTaskBridge(assistantDelegations, appApi) }
    internal val appApiCallerGrants by lazy {
        RoomCallerGrantStore(appApiDatabase.value, appApiOwner,
            currentContext = ::appApiGrantContext, identityIsCurrent = { appApiCallerIdentities.isCurrent(it) })
    }
    internal val captureDrafts by lazy { com.andysagent.agentoc.core.appapi.RoomCaptureDraftStore(appApiDatabase.value) }
    internal val captureResources by lazy { com.andysagent.agentoc.core.appapi.PersistentCaptureResources(application, appApiDatabase.value) }
    internal val captureImports by lazy { com.andysagent.agentoc.core.appapi.DraftResourceImports(captureDrafts, captureResources) }
    internal val resultOutputs by lazy { com.andysagent.agentoc.core.appapi.PersistentResultOutputs(application, appApiDatabase.value, appApi) }
    internal val resultDeliveries by lazy { com.andysagent.agentoc.core.appapi.ResultDeliveryCache(application, resultOutputs) }
    internal val documentSaves by lazy { com.andysagent.agentoc.core.appapi.DocumentSaveJournal(application, resultOutputs, resultDeliveries) }
    internal val resultMaintenance by lazy { ResultMaintenanceCoordinator(resultOutputs, resultDeliveries, documentSaves) }
    internal val resultDeliveryAndroid by lazy { ResultDeliveryAndroid(application, resultDeliveries, appApiOwner) }
    internal val captureShortcuts by lazy { CaptureShortcutPublisher(application) }
    internal val appApi: TaskCoordinator by lazy {
        TaskCoordinator(
            store = RoomOperationStore(appApiDatabase.value),
            executionLease = com.andysagent.agentoc.core.appapi.FileTaskExecutionLease(
                java.io.File(application.noBackupFilesDir, "agentoc-task-execution")),
            resources = captureResources,
            directory = {
                initialized.await()
                val directory = configStore.directory.first()
                val routing = directory.appApiRouting
                if (!routing.readable) throw AppApiException(ApiError(ApiErrorCode.INTERNAL_ERROR, "Sharing routing settings require an explicit reset"))
                TargetDirectorySnapshot(directory.computers.map {
                    ApiTarget(it.instanceId, it.label.ifBlank { it.instanceId }, routing.aliasesByTarget[it.instanceId].orEmpty())
                }, routing.defaultShareTargetId)
            },
            authorizer = GrantAuthorizer(appApiOwner.binding, {
                appApiCallerGrants.activeGrants() + assistantDelegations.activeDelegations().map { it.grant() }
            }),
            targetAccess = object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T =
                    withTargetRuntime(instanceId) { runtime -> block(RepositoryTaskTarget(instanceId, runtime.sessions, runtime.assets, runtime.exports, runtime.messages)) }
            },
        )
    }
    internal val backgroundDeliveryConsents by lazy {
        com.andysagent.agentoc.core.appapi.RoomBackgroundDeliveryStore(appApiDatabase.value, appApiOwner, ::appApiGrantContext)
    }
    internal val backgroundDelivery by lazy {
        com.andysagent.agentoc.core.appapi.OwnerBackgroundDelivery(backgroundDeliveryConsents, appApi, appApiOwner)
    }
    internal val appApiSessions by lazy {
        SessionApiCoordinator(
            directory = {
                initialized.await()
                TargetDirectorySnapshot(configStore.directory.first().computers.map { ApiTarget(it.instanceId, it.label) })
            },
            authorizer = GrantAuthorizer(appApiOwner.binding, { appApiCallerGrants.activeGrants() }),
            access = object : TargetSessionAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (SessionReadTarget) -> T): T =
                    withTargetRuntime(instanceId) { runtime -> block(RepositorySessionReadTarget(runtime.sessions)) }
            },
        )
    }
    internal val appApiSessionMutations by lazy {
        SessionMutationCoordinator(
            store = RoomSessionMutationStore(appApiDatabase.value),
            directory = {
                initialized.await()
                TargetDirectorySnapshot(configStore.directory.first().computers.map { ApiTarget(it.instanceId, it.label) })
            },
            authorizer = GrantAuthorizer(appApiOwner.binding, { appApiCallerGrants.activeGrants() }),
            access = object : TargetSessionMutationAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (SessionMutationTarget) -> T): T =
                    withTargetRuntime(instanceId) { runtime -> block(RepositorySessionMutationTarget(runtime.sessions)) }
            },
        )
    }
    private val mutableBackgroundTargetSummaries = MutableStateFlow<Map<String, TargetSummary>>(emptyMap())
    private val mutableTargetConnectionStates = MutableStateFlow<Map<String, RuntimeConnectionState>>(emptyMap())
    /** Observe existing shared carriers without starting or retaining a connection. */
    val targetConnectionStates: StateFlow<Map<String, RuntimeConnectionState>> = mutableTargetConnectionStates.asStateFlow()
    /** Summary-only UI observation; carriers remain owned by the shared target lease pool. */
    val backgroundTargetSummaries: StateFlow<Map<String, TargetSummary>> = mutableBackgroundTargetSummaries.asStateFlow()
    private val targetSummaryCodec = ProtocolCodec()
    private val mutableOtherDeviceProjects = MutableStateFlow<List<OtherDeviceProject>>(emptyList())
    val otherDeviceProjects: StateFlow<List<OtherDeviceProject>> = mutableOtherDeviceProjects.asStateFlow()
    /** Emits the target whose local Harness catalog changed over its WS. */
    val harnessInvalidations = MutableSharedFlow<String>(extraBufferCapacity = 32)
    // The target lease pool owns carriers; the UI facade only changes which one it observes.
    val transport = SwitchingAgentoCTransport(scope, closeDelegates = false)
    private val accountsAnonymousTransport = OkHttpAgentoCTransport(
        endpointProvider = { application.getString(R.string.accounts_directory_base_url).trimEnd('/') },
        credentialProvider = { null },
    )
    val contentReports by lazy {
        com.andysagent.agentoc.core.domain.HttpContentReportsRepository(
            com.andysagent.agentoc.core.network.contentReportTransport(application.getString(R.string.accounts_directory_base_url)),
            AndroidContentReportJournal(application),
            application.packageManager.getPackageInfo(application.packageName, 0).versionName.orEmpty().take(64),
        )
    }
    internal val temporaryAccess by lazy {
        TemporaryAccessRuntime(application, accountsAnonymousTransport, identityStore,
            AndroidTemporaryClaimJournal(application), AndroidTemporaryTextOperationJournal(application),
            AndroidTemporaryAttachmentByteStore(application), scope)
    }
    private val temporaryControl by lazy { TemporaryControlRuntime(application, accountsAnonymousTransport, identityStore, scope) }
    private data class ControlWorkbench(val instanceId: String, val transport: com.andysagent.agentoc.core.auth.TemporaryControlTransport,
        val sessions: RoomSessionRepository, val database: AgentoCDatabase) {
        val lifetime = SessionStorageLifetime(sessions, transport::close, database::close)
    }
    @Volatile private var controlWorkbench: ControlWorkbench? = null
    private val mutableTemporaryControlActive = MutableStateFlow(false)
    val temporaryControlActive: StateFlow<Boolean> = mutableTemporaryControlActive.asStateFlow()
    fun temporaryControlInstanceId(): String? = controlWorkbench?.instanceId

    suspend fun connectTemporaryControl(raw: String) {
        if (configStore.accountSession.first() != null) throw com.andysagent.agentoc.core.network.ApiException(409,
            "temporary_control_use_account_pairing", "This phone is signed in. Scan the computer's ordinary account pairing code.", retryable = false)
        configurationMutex.withLock {
            controlWorkbench?.let {
                controlWorkbench = null; mutableTemporaryControlActive.value = false
                it.sessions.stopLiveSync(); transport.switchTo(null); sessions.switchTo(null)
                it.lifetime.close()
            }
        }
        val connection = temporaryControl.connect(raw)
        val database = Room.inMemoryDatabaseBuilder(application, AgentoCDatabase::class.java).build()
        val repository = RoomSessionRepository(database, connection.transport, contentResolver = application.contentResolver,
            targetId = connection.instanceId)
        val workbench = ControlWorkbench(connection.instanceId, connection.transport, repository, database)
        try {
            configurationMutex.withLock {
                check(!stopped)
                activeTargetRuntime()?.sessions?.stopLiveSync()
                controlWorkbench = workbench
                transport.switchTo(workbench.transport); sessions.switchTo(workbench.sessions)
                mutableTemporaryControlActive.value = true
                if (foreground) {
                    workbench.sessions.startLiveSync()
                }
            }
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                configurationMutex.withLock {
                    if (controlWorkbench === workbench) {
                        controlWorkbench = null; mutableTemporaryControlActive.value = false
                        transport.switchTo(null); sessions.switchTo(null)
                    }
                    workbench.lifetime.close()
                }
            }
            throw error
        }
        scope.launch {
            workbench.transport.connectionState.first { it == RuntimeConnectionState.Disconnected }
            val removed = configurationMutex.withLock {
                if (controlWorkbench !== workbench) false else {
                    controlWorkbench = null; mutableTemporaryControlActive.value = false
                    workbench.sessions.stopLiveSync(); transport.switchTo(null); sessions.switchTo(null)
                    workbench.lifetime.close(); true
                }
            }
            if (removed && !stopped) synchronizeDirectory()
        }
    }
    private val accountsDirectoryTransport = OkHttpAgentoCTransport(
        endpointProvider = { application.getString(R.string.accounts_directory_base_url).trimEnd('/') },
        credentialProvider = { accountCredentialStore.readToken() },
    )
    val accountSessions = AccountSessionManager(
        anonymousTransport = accountsAnonymousTransport,
        authenticatedTransport = accountsDirectoryTransport,
        identity = identityStore,
        credentialStore = accountCredentialStore,
        metadataStore = ClientConfigAccountSessionStore(configStore),
        pairingJournal = com.andysagent.agentoc.core.auth.AndroidAccountPairingJournal(application),
        rendezvousTrace = { target, event -> connectionDebugTrace(application, target, event) },
        beforeRendezvousGrant = { awaitColdTurnRecovery() },
        beforeDemoSignIn = {
            if (mutableTemporaryControlActive.value) {
                throw AccountSessionException(409, "demo_existing_connections", "End temporary control before signing in.")
            }
        },
        dispatchSessionInvalidation = { cleanup ->
            scope.launch {
                try { cleanup() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    android.util.Log.w("AgentoC", "Account cleanup failed: " + error.javaClass.simpleName)
                }
            }
        },
        changeAccountDirectory = { change, update ->
            initialized.await()
            val initiator = targetPairingCommits.initiatingJob()
            if (targetRuntimes.values.any { it.ownsJob(initiator) }) throw AccountSessionException(401,
                "account_session_foreground_reauthorization", "Account authorization expired. Sign out and sign in again.")
            if (mutableTemporaryControlActive.value) throw AccountSessionException(409,
                "account_temporary_control_active", "End temporary control before changing accounts.")
            targetPairingCommits.switchAccount(preserveCaller = change.preserveCaller) {
                recoverAccountProfileTransitionLocked()
                val transition = accountProfileTransitions.begin(change)
                try {
                    stopAccountProfileRuntimesLocked()
                    accountProfileCredentials.clearActive(transition.previousTargets)
                    update()
                    accountProfileTransitions.recover()
                } catch (error: Throwable) {
                    withContext(NonCancellable) {
                        try { recoverAccountProfileTransitionLocked() }
                        catch (repair: Throwable) { error.addSuppressed(repair) }
                    }
                    throw error
                }
            }
            synchronizeDirectory()
        },
    )
    private val accountProfileCredentials by lazy {
        com.andysagent.agentoc.core.auth.AccountTargetCredentialProfiles(credentialStore, p2pSecretStore)
    }
    private val accountProfileTransitions by lazy {
        com.andysagent.agentoc.core.auth.AccountProfileTransitions(
            object : com.andysagent.agentoc.core.auth.AccountProfileTransitionStore {
                override suspend fun read() = configStore.accountProfileTransition.first()
                override suspend fun write(value: com.andysagent.agentoc.core.datastore.AccountProfileTransition) = configStore.saveAccountProfileTransition(value)
                override suspend fun clear(id: String) = configStore.clearAccountProfileTransition(id)
                override suspend fun state() = configStore.accountProfileState.first()
                override suspend fun clearAccountSession() = configStore.clearAccountSession()
            }, accountCredentialStore, accountProfileCredentials)
    }

    private suspend fun stopAccountProfileRuntimesLocked() {
        otherDeviceProjectionEpoch++
        accountCapacityRetry.cancel()
        appApiCallerGrants.revokeAll(appApiOwner)
        assistantDelegations.revokeAll(appApiOwner)
        backgroundDeliveryConsents.revokeAll(appApiOwner)
        targetRuntimes.entries.toList().forEach { (id, runtime) ->
            connectionUses.revoke(id)
            targetRuntimes.remove(id, runtime)
            runtime.dispose()
        }
        mutableTargetConnectionStates.value = emptyMap()
        mutableOtherDeviceProjects.value = emptyList()
        maximumConcurrentAccountConnections = 1
        accountCapacityRefreshNeeded = true
        accountCapacityRetrySuppressed = false
        accountCapacityRetryFloorMs = 0L
        activeInstanceId = null
        uiBackgroundTargetIds = emptySet()
        transport.switchTo(null)
        sessions.switchTo(null)
    }

    /** Called under the configuration lock before any new target runtime can start. */
    private suspend fun recoverAccountProfileTransitionLocked() {
        if (!accountProfileTransitions.pending()) return
        val initiator = targetPairingCommits.initiatingJob()
        if (targetRuntimes.values.any { it.ownsJob(initiator) }) throw AccountSessionException(401,
            "account_profile_recovery_pending", "Account recovery is pending.")
        stopAccountProfileRuntimesLocked()
        accountProfileTransitions.recover()
    }

    private val coldTurnRecovery by lazy {
        com.andysagent.agentoc.core.auth.ColdTurnLeaseRecovery(accountSessions,
            enabled = { !accountCredentialStore.readToken().isNullOrBlank() })
    }
    private suspend fun awaitColdTurnRecovery() {
        // Replacement/test graphs must never inspect or retire real leases.
        if (targetFactoryOverride == null && configOverride == null) coldTurnRecovery.beforeNewReservations()
    }
    val sessions = SwitchingSessionRepository(scope)
    val accounts = DefaultAccountsRepository(
        transport = transport,
                credentialWriter = { token, expiresAt, scope ->
        activeInstanceId?.let { credentialStore.write(it, token, expiresAt, scope) }
        },
        discoveryTransport = accountsDirectoryTransport,
    )
    val pairing = PairingAuthenticator(
        identity = identityStore,
        credentialStore = credentialStore,
        configStore = configStore,
        p2pSecretStore = p2pSecretStore,
        accountJoinAuthorizer = accountSessions,
    )

    /**
     * A QR invitation supplies the intended target identity, while the v3
     * claim itself still uses the Accounts grant path. This makes a newly
     * scanned computer appear in the account directory and keeps Google/rac_
     * away from the target computer.
     */
    suspend fun pairFromInvitation(
        pairingUri: String,
        deviceName: String,
        computerAlias: String = "",
    ): PairingResult {
        val invitation = parsePairingUri(pairingUri)
        awaitColdTurnRecovery()
        return targetPairingCommits.withTarget(invitation.instanceId) { writeGuard ->
            accountRendezvous.withTarget(invitation.instanceId) {
                writeGuard.persist(invitation.instanceId) { }
                if (invitation.version == 4 && configStore.accountSession.first() == null) {
                    val establishment = accountSessions.acceptDesktopAccount(invitation, deviceName)
                    accountIdentityStore.save(GoogleAccountProfile(
                        displayName = establishment.email?.substringBefore('@'), email = establishment.email, photoUrl = null))
                }
                // The first QR claim establishes the phone's initial active target.
                // Later QR claims are account bindings only; they must not silently
                // switch the active computer or start a background carrier.
                val directory = configStore.directory.first()
                val autoConnect = shouldAutoConnectQrClaim(directory.computers.size,
                    directory.computers.firstOrNull { it.instanceId == invitation.instanceId }?.autoConnect == true)
                val selectTarget = directory.computers.isEmpty()
                // The QR is an explicit one-time account-claim challenge. Its token is
                // sent only while creating the target intent; the long-lived account
                // join still gives Accounts the phone's rac_ and never gives rac_ or a
                // Google credential to the computer.
                val result = if (invitation.endpoint.isBlank()) {
                    pairing.joinWithAccountRendezvous(
                        targetInstanceId = invitation.instanceId,
                        deviceName = deviceName,
                        accountClaimToken = invitation.token.takeUnless { invitation.version == 4 },
                        targetInstance = pairingTargetFromInvitation(invitation),
                        autoConnect = autoConnect,
                        selectTarget = selectTarget,
                        computerAlias = computerAlias,
                        persistDirectory = false,
                        writeGuard = writeGuard,
                    )
                } else {
                    pairing.joinWithAccountSession(
                        targetEndpoint = invitation.endpoint,
                        deviceName = deviceName,
                        accountClaimToken = invitation.token,
                        computerAlias = computerAlias,
                        autoConnect = autoConnect,
                        selectTarget = selectTarget,
                        writeGuard = writeGuard,
                    )
                }
                if (invitation.endpoint.isBlank()) persistRendezvousResult(result,
                    label = computerAlias.ifBlank {
                        directory.computers.firstOrNull { it.instanceId == invitation.instanceId }?.label
                            ?: invitation.instanceId
                    }, autoConnect = autoConnect, selectTarget = selectTarget, writeGuard = writeGuard)
                else {
                    writeGuard.persist(result.instanceId) { configStore.allowAutomaticAccountRestore() }
                    if (autoConnect) applyPairingResult(result, writeGuard)
                }
                result
            }
        }
    }

    suspend fun pairFromAccountComputer(instanceId: String, deviceName: String): PairingResult {
        val result = renewAccountRendezvous(instanceId, deviceName, selectTarget = true)
        return result
    }

    /** Connect a summary-only computer without switching the visible Projects/chat target. */
    suspend fun connectAccountComputerInBackground(instanceId: String, deviceName: String): PairingResult =
        targetPairingCommits.withTarget(instanceId) { writeGuard ->
          backgroundConnectMutex.withLock {
            writeGuard.persist(instanceId) { }
            if (instanceId == configStore.directory.first().activeTarget?.instanceId) {
                return@withLock renewAccountRendezvousGuarded(instanceId, deviceName, selectTarget = true,
                    writeGuard = writeGuard)
            }
            val capacityFresh = refreshAccountConnectionCapacity(onlyIfNeeded =
                canReuseAccountCapacity(accountCapacityLastSuccessMs, android.os.SystemClock.elapsedRealtime()))
            val directory = configStore.directory.first()
            val backgrounds = automaticBackgroundTargetIds(directory.computers, directory.activeTarget?.instanceId, Int.MAX_VALUE)
            checkBackgroundConnectionCapacity(capacityFresh, instanceId in uiBackgroundTargetIds,
                backgrounds.size + (if (directory.activeTarget == null) 0 else 1),
                maximumConcurrentAccountConnections, accountCapacityRetry.remainingCooldownMs())
            // A background read can temporarily own this target while the
            // explicit join is still waiting on Accounts. Keep the existing
            // target alive until its verified result is persisted and the UI
            // owner has been synchronized, even if that read times out.
            // A first-time join has no stored target to lease yet.
            val lease = if (directory.computers.any { it.instanceId == instanceId })
                connectionUses.acquire(instanceId) else null
            try {
                val result = renewAccountRendezvousGuarded(instanceId, deviceName, selectTarget = false,
                    writeGuard = writeGuard)
                synchronizeDirectory()
                result
            } finally {
                lease?.close()
            }
          }
        }

    /** Each fixed target obtains a fresh signed, Accounts-authorized connection contract. */
    private suspend fun renewAccountRendezvous(
        instanceId: String,
        deviceName: String,
        selectTarget: Boolean = false,
        persistDirectory: Boolean = true,
        requirePaired: Boolean = false,
    ): PairingResult = targetPairingCommits.withTarget(instanceId) { writeGuard ->
        renewAccountRendezvousGuarded(instanceId, deviceName, selectTarget, persistDirectory, requirePaired, writeGuard)
    }

    private suspend fun renewAccountRendezvousGuarded(
        instanceId: String,
        deviceName: String,
        selectTarget: Boolean = false,
        persistDirectory: Boolean = true,
        requirePaired: Boolean = false,
        writeGuard: com.andysagent.agentoc.core.auth.PairingWriteGuard,
    ): PairingResult {
        val joinMode = if (persistDirectory) "explicit" else "recovery"
        connectionDebugTrace(application, instanceId, "rendezvous-$joinMode-queued")
        writeGuard.persist(instanceId) { }
        if (requirePaired && configStore.directory.first().computers.none { it.instanceId == instanceId }) {
            throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
        }
        val shared = accountRendezvousSingleFlight.run(instanceId, deviceName) {
          accountRendezvous.withTarget(instanceId) rendezvous@ {
          connectionDebugTrace(application, instanceId, "rendezvous-$joinMode-entered")
          try {
            writeGuard.persist(instanceId) { }
            // An existing target's reconnect can go straight to the authoritative
            // broker. It resolves the current binding/key and rejects revoked or
            // foreign targets; a second account-directory request adds no authority.
            val retained = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId }
            if (requirePaired && retained == null) throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
            if (retained != null) {
                val label = retained.label.ifBlank { instanceId }
                val result = pairing.joinWithAccountRendezvous(
                    targetInstanceId = instanceId, deviceName = deviceName,
                    selectTarget = false, persistDirectory = false,
                    targetLabel = label, writeGuard = writeGuard,
                )
                return@rendezvous SharedRendezvous(result, label, requireNotNull(targetCredentialFingerprint(instanceId)))
            }
            val target = listAccountDirectoryDevices().firstOrNull { it.instanceId == instanceId }
                ?: throw AccountTargetUnavailable(instanceId)
            val result = pairing.joinWithAccountRendezvous(
                targetInstanceId = instanceId,
                deviceName = deviceName,
                targetInstance = AccountRendezvousTargetInstanceDto(
                    instanceId = target.instanceId,
                    publicKey = target.instancePublicKey.orEmpty(),
                    keyFingerprint = target.instanceKeyFingerprint.orEmpty(),
                ),
                selectTarget = selectTarget,
                persistDirectory = false,
                targetLabel = target.alias.ifBlank { target.instanceId },
                writeGuard = writeGuard,
            )
            SharedRendezvous(result, target.alias.ifBlank { instanceId }, requireNotNull(targetCredentialFingerprint(instanceId)))
          } finally { connectionDebugTrace(application, instanceId, "rendezvous-$joinMode-finished") }
          }
        }
        writeGuard.persist(instanceId) {
            if (targetCredentialFingerprint(instanceId) != shared.credentialFingerprint) {
                throw CancellationException("Rendezvous credential was superseded")
            }
        }
        if (requirePaired && configStore.directory.first().computers.none { it.instanceId == instanceId }) {
            throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
        }
        if (persistDirectory) persistRendezvousResult(shared.result, shared.label,
            autoConnect = true, selectTarget = selectTarget, writeGuard = writeGuard,
            expectedCredentialFingerprint = shared.credentialFingerprint)
        return shared.result
    }

    private fun targetCredentialFingerprint(instanceId: String): String? =
        credentialStore.readToken(instanceId)?.takeIf { it.isNotBlank() }?.let { token ->
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it.toInt() and 255) }
        }

    /** Directory observation cannot start a second join before its signed plan is seeded. */
    private suspend fun persistRendezvousResult(result: PairingResult, label: String,
        autoConnect: Boolean, selectTarget: Boolean, writeGuard: com.andysagent.agentoc.core.auth.PairingWriteGuard,
        expectedCredentialFingerprint: String? = null) {
        val plan = BootstrapConnectionPlanFactory.create(
            result.verifiedBootstrap ?: error("Verified bootstrap is missing"), result.endpoint,
            result.p2p?.let { BootstrapP2PCredentials(it.secret) })
        initialized.await()
        writeGuard.persist(result.instanceId) {
            check(!stopped)
            currentCoroutineContext().ensureActive()
            if (expectedCredentialFingerprint != null &&
                targetCredentialFingerprint(result.instanceId) != expectedCredentialFingerprint) {
                throw CancellationException("Rendezvous credential was superseded")
            }
            configStore.save(StoredInstance(endpoint = result.endpoint, instanceId = result.instanceId,
                label = label, autoConnect = autoConnect), select = selectTarget)
            configStore.allowAutomaticAccountRestore()
            establishPrimaryBinding()
            val target = configStore.directory.first().computers.first { it.instanceId == result.instanceId }
            ensureTargetRuntime(target).controller.applyVerifiedBootstrap(plan)
        }
    }

    private suspend fun applyPairingResult(result: PairingResult, writeGuard: com.andysagent.agentoc.core.auth.PairingWriteGuard) {
        val verified = result.verifiedBootstrap ?: return
        initialized.await()
        writeGuard.persist(result.instanceId) apply@ {
            val directory = configStore.directory.first()
            establishPrimaryBinding()
            val target = directory.computers.firstOrNull { it.instanceId == result.instanceId }
                ?: return@apply
            val plan = BootstrapConnectionPlanFactory.create(verified, result.endpoint,
                result.p2p?.let { BootstrapP2PCredentials(it.secret) })
            ensureTargetRuntime(target).controller.applyVerifiedBootstrap(plan)
        }
    }

    suspend fun createAccountGoogleChallenge(deviceName: String): AccountSessionChallenge =
        accountSessions.createGoogleChallenge(alias = deviceName)

    suspend fun completeAccountGoogleChallenge(
        challenge: AccountSessionChallenge,
        idToken: String,
        profile: GoogleAccountProfile,
    ) {
        accountSessions.completeGoogleChallenge(challenge, idToken)
        accountIdentityStore.save(profile)
    }

    /**
     * Completes a browser-verified challenge (non-GMS handoff) and stores the
     * identity derived from the verified email; the browser never hands the
     * app a Google token.
     */
    suspend fun completeBrowserAccountSession(challenge: AccountSessionChallenge): GoogleAccountProfile {
        val establishment = accountSessions.completeBrowserVerifiedChallenge(challenge)
        val email = establishment.email
        val profile = GoogleAccountProfile(
            displayName = email?.substringBefore('@'),
            email = email,
            photoUrl = null,
        )
        accountIdentityStore.save(profile)
        return profile
    }

    suspend fun ensureAccountSession() = accountSessions.ensureActiveCredential()

    suspend fun signInDemoAccount(username: String, password: String): GoogleAccountProfile {
        accountSessions.signInDemoAccount(username, password, accountDeviceAlias)
        return GoogleAccountProfile(displayName = "Demo workspace", email = null, photoUrl = null).also {
            accountIdentityStore.save(it)
        }
    }

    suspend fun logoutAccountSession(): Boolean {
        appApiCallerGrants.revokeAll(appApiOwner)
        assistantDelegations.revokeAll(appApiOwner)
        backgroundDeliveryConsents.revokeAll(appApiOwner)
        return try { accountSessions.logoutAccountSession() }
        finally { withContext(kotlinx.coroutines.NonCancellable) { backgroundDeliveryConsents.revokeAll(appApiOwner) } }
    }

    private suspend fun <T> accountAuthorityOperation(operation: suspend () -> T): T =
        accountSessions.withActiveAuthority(rejectionStatus = { error ->
            when (error) {
                is AccountSessionException -> error.statusCode
                is AccountsRepositoryException -> error.statusCode
                else -> null
            }
        }) { operation() }

    suspend fun revokeAccountDevice(deviceId: String) = accountAuthorityOperation {
        accountSessions.revokeAccountDevice(deviceId)
        // Central revocation must also release this phone's local uses and
        // credentials, so a persisted autoConnect entry cannot revive it.
        withContext(kotlinx.coroutines.NonCancellable) {
            if (configStore.directory.first().computers.any { it.instanceId == deviceId } || targetPairingCommits.hasPending(deviceId)) disconnectTarget(deviceId)
        }
        true
    }

    suspend fun renameAccountDevice(deviceId: String, alias: String) = accountAuthorityOperation {
        accountSessions.renameAccountDevice(deviceId, alias)
    }

    /**
     * The only account-login projection consumed by Compose. It deliberately
     * returns non-secret evidence instead of the `rac_` bearer, and clears a
     * stale Google profile together with a rejected/malformed session.
     */
    val accountSessionStateSource: AccountSessionStateSource = object : AccountSessionStateSource {
        override suspend fun verify(): AccountSessionVerification = try {
            accountSessions.ensureActiveCredential().let { credential ->
                AccountSessionVerification.Active(
                    ActiveAccountSession(
                        accountId = credential.accountId,
                        deviceId = credential.deviceId,
                        credentialId = credential.credentialId,
                        scope = credential.scope,
                        expiresAt = credential.expiresAt,
                        demoAccessMode = credential.demoAccessMode,
                    ),
                )
            }
        } catch (error: AccountSessionException) {
            when (error.statusCode) {
                400, 401, 403 -> {
                    // ensureActiveCredential has queued generation-bound invalidation.
                    AccountSessionVerification.ReauthorizationRequired
                }
                else -> AccountSessionVerification.Unavailable()
            }
        } catch (_: Throwable) {
            AccountSessionVerification.Unavailable()
        }

        override suspend fun clear() {
            clearAccountSession()
        }
    }

    suspend fun discoverAccountComputers() = accountAuthorityOperation {
        accounts.discoverComputers(UUID.randomUUID().toString())
    }

    /** The signed-in account's real device directory; never a local fallback. */
    suspend fun listAccountDirectoryDevices(): List<AccountDirectoryDevice> = accountAuthorityOperation {
        accounts.listAccountDevices().also { devices ->
            configStore.refreshComputerLabels(devices
                .filter { it.deviceKind.equals("computer", ignoreCase = true) && it.unboundAt.isNullOrBlank() }
                .associate { it.instanceId to it.alias.ifBlank { it.instanceId } })
        }
    }

    private suspend fun refreshAccountConnectionCapacity(onlyIfNeeded: Boolean = false): Boolean = accountCapacityMutex.withLock {
        if (onlyIfNeeded && !accountCapacityRefreshNeeded) return@withLock true
        if (accountCapacityRetry.remainingCooldownMs() > 0L) return@withLock false
        val accountId = configStore.accountSession.first()?.accountId
        try {
            val maximum = try {
                accountSessions.getAccountUsage().turn.limits.computers
            } catch (error: AccountSessionException) {
                // Compatibility with Accounts releases before the dedicated
                // usage API. Authentication and protocol failures never fall back.
                if (error.statusCode != 404) throw error
                discoverAccountComputers().firstOrNull()?.maximumConcurrentConnections
                    ?: throw IllegalStateException("Account connection capacity is unavailable")
            }
            if (accountId != configStore.accountSession.first()?.accountId) {
                accountCapacityRefreshNeeded = true
                return@withLock false
            }
            maximumConcurrentAccountConnections = maximum
            accountCapacityLastSuccessMs = android.os.SystemClock.elapsedRealtime()
            accountCapacityRefreshNeeded = false
            accountCapacityRetrySuppressed = false
            accountCapacityRetryFloorMs = 0L
            true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            val status = when (error) {
                is AccountSessionException -> error.statusCode
                is AccountsRepositoryException -> error.statusCode
                else -> 0
            }
            accountCapacityRetrySuppressed = status in setOf(401, 403, 410)
            accountCapacityRetryFloorMs = if (status == 429) {
                capacityRateLimitDelayMs(error)
            } else 0L
            if (status == 429) accountCapacityRetry.deferFor(accountCapacityRetryFloorMs)
            // Preserve the last ceiling while retryable failures recover.
            accountCapacityRefreshNeeded = true
            false
        }
    }

    private fun retryAccountCapacity(instanceId: String, expedite: Boolean = false) {
        if (!foreground || stopped || activeInstanceId != instanceId || !accountCapacityRefreshNeeded || accountCapacityRetrySuppressed) return
        accountCapacityRetry.request(instanceId, expedite = expedite)
    }

    /** Restore a sole account computer only when no local choice/opt-out would be overwritten. */
    private suspend fun restoreSingleAccountComputerIfNeeded() {
        if (!foreground || configStore.directory.first().let { it.computers.isNotEmpty() || !it.automaticAccountRestoreAllowed }) return
        // The verified demo flow owns discovery/entry. Running the generic
        // restore concurrently would create a second rendezvous/lease.
        if (configStore.accountSession.first()?.accountId?.matches(Regex("^acct_demo_[a-f0-9]{48}$")) == true) return
        val computers = listAccountDirectoryDevices().filter {
            it.deviceKind.equals("computer", ignoreCase = true) && it.unboundAt.isNullOrBlank()
        }
        val onlyComputer = computers.singleOrNull() ?: return
        val result = renewAccountRendezvous(onlyComputer.instanceId, accountDeviceAlias, persistDirectory = false)
        configurationMutex.withLock {
            if (!foreground || stopped || configStore.directory.first().let { it.computers.isNotEmpty() || !it.automaticAccountRestoreAllowed }) return@withLock
            configStore.save(StoredInstance(
                endpoint = "", instanceId = result.instanceId,
                label = onlyComputer.alias.ifBlank { result.instanceId }, autoConnect = true,
            ), select = true)
            establishPrimaryBinding()
            val target = configStore.directory.first().computers.first { it.instanceId == result.instanceId }
            val plan = BootstrapConnectionPlanFactory.create(result.verifiedBootstrap ?: error("Verified bootstrap is missing"),
                result.endpoint, result.p2p?.let { BootstrapP2PCredentials(it.secret) })
            ensureTargetRuntime(target).controller.applyVerifiedBootstrap(plan)
        }
        synchronizeDirectory()
    }

    suspend fun clearAccountSession() {
        appApiCallerGrants.revokeAll(appApiOwner)
        assistantDelegations.revokeAll(appApiOwner)
        backgroundDeliveryConsents.revokeAll(appApiOwner)
        try {
            accountSessions.clearLocalSession()
            accountIdentityStore.clearSelectedAccount()
        } finally { withContext(kotlinx.coroutines.NonCancellable) { backgroundDeliveryConsents.revokeAll(appApiOwner) } }
    }

    /** Register with already connected paired PCs, each through its fixed authenticated carrier. */
    suspend fun registerFcmToken(token: String, targetInstanceId: String? = null) {
        require(token.isNotBlank() && token.length <= 4096) { "Invalid notification token" }
        pendingFcmToken = token.trim().takeIf { it.isNotEmpty() }
        val normalizedToken = pendingFcmToken ?: return
        val body = org.json.JSONObject()
            .put("token", normalizedToken)
            .put("deviceId", com.andysagent.agentoc.core.auth.devicePublicKeyFingerprint(identityStore.publicKeyEncoded()))
            .put("appVersion", application.packageManager.getPackageInfo(application.packageName, 0).versionName ?: "")
            .toString()
        initialized.await()
        fcmRegistrationMutex.withLock {
            if (pendingFcmToken != normalizedToken) return@withLock
            val paired = configStore.directory.first().computers.map { it.instanceId }.toSet()
            val connected = targetRuntimes.values.toList().filter {
                it.instanceId in paired && (targetInstanceId == null || it.instanceId == targetInstanceId) &&
                    it.transport.connectionState.value == RuntimeConnectionState.Connected
            }
            // Registration does not force otherwise disconnected PCs to connect. Keep
            // the latest token so a later connection can register the same phone.
            connected.forEach { runtime ->
                if (pendingFcmToken != normalizedToken) return@forEach
                try {
                    withTargetRuntime(runtime.instanceId) { bound ->
                        bound.transport.execute(ApiRequest("POST", "/api/push/fcm/register", body))
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { android.util.Log.w("AgentoCRuntime", "Notification registration deferred") }
            }
        }
    }

    fun start() {
        if (!startGuard.compareAndSet(false, true)) return
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        scope.launch {
            try {
                configurationMutex.withLock { recoverAccountProfileTransitionLocked() }
                configStore.migrateLegacy()
                configStore.directory.collect { directory ->
                    synchronizeDirectory()
                    synchronizeCaptureShortcuts(directory)
                }
            } catch (cancelled: CancellationException) {
                if (!initialized.isCompleted) initialized.completeExceptionally(cancelled)
                throw cancelled
            } catch (failure: Exception) {
                if (!initialized.isCompleted) initialized.completeExceptionally(failure)
                android.util.Log.e("AgentoCRuntime", "Computer directory initialization failed")
            }
        }
    }

    private suspend fun synchronizeCaptureShortcuts(directory: ComputerDirectory) {
        // Isolated runtime tests must not publish their synthetic PCs globally.
        if (targetFactoryOverride != null || configOverride != null) return
        try { if (!captureShortcuts.synchronize(directory)) android.util.Log.w("AgentoCRuntime", "Shortcut publication deferred by system") }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { android.util.Log.w("AgentoCRuntime", "Shortcut publication unavailable") }
    }

    private suspend fun synchronizeDirectory() = configurationMutex.withLock {
        if (stopped) return@withLock
        recoverAccountProfileTransitionLocked()
        val directory = configStore.directory.first()
        val retained = directory.computers.map { it.instanceId }.toSet()
        val selected = directory.activeTarget
        if (activeInstanceId != selected?.instanceId) {
            otherDeviceProjectionEpoch++
            mutableOtherDeviceProjects.value = emptyList()
        } else {
            mutableOtherDeviceProjects.update { rows -> rows.filter { it.targetId in retained && it.targetId != selected?.instanceId } }
        }
        establishPrimaryBinding()
        // Gate headless access until the legacy database's target binding is established.
        if (!initialized.isCompleted) initialized.complete(Unit)
        targetRuntimes.entries.toList().filter { it.key !in retained }.forEach { (id, runtime) ->
            connectionUses.revoke(id)
            targetRuntimes.remove(id, runtime)
            mutableTargetConnectionStates.update { current ->
                if (targetRuntimes[id] == null) current - id else current
            }
            runtime.dispose()
            credentialStore.clear(id)
            p2pSecretStore.clear(id)
        }
        controlWorkbench?.let { control ->
            if (foreground) {
                control.sessions.startLiveSync()
            } else control.sessions.stopLiveSync()
            return@withLock
        }
        if (activeInstanceId != selected?.instanceId && activeInstanceId != tabletChatTargetId) {
            activeTargetRuntime()?.sessions?.stopLiveSync()
        }
        activeInstanceId = selected?.instanceId
        val runtime = selected?.let(::ensureTargetRuntime)
        transport.switchTo(runtime?.transport)
        sessions.switchTo(runtime?.sessions)
        val maximum = if (accountCredentialStore.readToken().isNullOrBlank()) Int.MAX_VALUE else maximumConcurrentAccountConnections
        val previousBackgroundIds = uiBackgroundTargetIds
        val recoveryPlan = automaticConnectionRecoveryPlan(directory, maximum)
        uiBackgroundTargetIds = if (foreground) recoveryPlan.backgroundInstanceIds.toSet() else emptySet()
        mutableBackgroundTargetSummaries.update { summaries ->
            summaries.filterKeys { it in uiBackgroundTargetIds }
        }
        val uiTargets = if (foreground || retainUiConnections) (listOfNotNull(recoveryPlan.primaryInstanceId) +
            recoveryPlan.backgroundInstanceIds).toSet() else emptySet()
        connectionUses.setOwnerTargets("foreground-ui", uiTargets)
        (uiBackgroundTargetIds - previousBackgroundIds).forEach { id ->
            targetRuntimes[id]?.takeIf { it.transport.connectionState.value == RuntimeConnectionState.Connected }?.let {
                scope.launch { refreshBackgroundSummary(it) }
            }
        }
        if (foreground) {
            runtime?.sessions?.startLiveSync()
            tabletChatTargetId?.let { targetRuntimes[it]?.sessions?.startLiveSync() }
        } else targetRuntimes.values.forEach { it.sessions.stopLiveSync() }
    }

    /** Retain the detail computer independently while the left pane switches. */
    internal suspend fun retainTabletChatTarget(instanceId: String?) {
        initialized.await()
        configurationMutex.withLock {
            val previous = tabletChatTargetId
            val target = instanceId?.takeIf { id -> configStore.directory.first().computers.any { it.instanceId == id } }
            connectionUses.setOwnerTargets("tablet-chat", setOfNotNull(target))
            tabletChatTargetId = target
            if (previous != null && previous != target && previous != activeInstanceId) {
                targetRuntimes[previous]?.sessions?.stopLiveSync()
            }
            if (foreground) target?.let { targetRuntimes[it]?.sessions?.startLiveSync() }
        }
    }

    internal fun retryComputerConnection(instanceId: String?) {
        if (instanceId == null) return
        scope.launch {
            initialized.await()
            targetRuntimes[instanceId]?.controller?.refresh()
        }
    }

    private suspend fun establishPrimaryBinding() {
        if (primaryDatabaseInstanceId == null) primaryDatabaseInstanceId = configStore.ensurePrimaryDatabaseBinding()
        primaryDatabaseInstanceId?.let { primaryId ->
            credentialStore.migrateLegacyTo(primaryId)
            p2pSecretStore.migrateLegacyTo(primaryId)
        }
    }

    private fun registerFcmTokenWhenConnected(instanceId: String) {
        runCatching { FirebaseMessaging.getInstance().token }
            .onSuccess { task ->
                task.addOnSuccessListener { token ->
                    scope.launch { runCatching { registerFcmToken(pendingFcmToken ?: token, instanceId) } }
                }
            }
        pendingFcmToken?.let { token ->
            scope.launch { runCatching { registerFcmToken(token, instanceId) } }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
        retainUiConnections = true
        scope.launch {
            initialized.await()
            if (foreground) retryUnhealthyForegroundConnection(activeTargetRuntime()?.controller)
            synchronizeDirectory()
            // Foregrounding can lift shortcut throttling. Retry deferred publication;
            // an already published directory is a no-op inside the publisher.
            synchronizeCaptureShortcuts(configStore.directory.first())
        }
        accountRestoreJob?.cancel()
        // Test/replacement graphs must not contact the real Accounts service.
        if (targetFactoryOverride == null && configOverride == null && !accountCredentialStore.readToken().isNullOrBlank()) {
            accountRestoreJob = scope.launch {
                initialized.await()
                refreshAccountConnectionCapacity()
                synchronizeDirectory()
                try { restoreSingleAccountComputerIfNeeded() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* The next foreground transition can retry discovery. */ }
            }
        }
    }

    /** Uses the existing target lease/controller; does not create a parallel demo carrier. */
    suspend fun ensureDemoComputerConnection(verifiedAccountId: String, instanceId: String, forceRefresh: Boolean = false) {
        initialized.await()
        require(verifiedAccountId.matches(Regex("^acct_demo_[a-f0-9]{48}$")))
        check(configStore.accountSession.first()?.accountId == verifiedAccountId) { "Demo account changed" }
        val existing = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId }
        if (existing == null) {
            pairFromAccountComputer(instanceId, accountDeviceAlias)
        } else {
            configStore.selectTarget(instanceId)
            synchronizeDirectory()
            val runtime = targetRuntimes[instanceId] ?: return
            val state = runtime.transport.connectionState.value
            // The foreground lease already starts and retries the controller.
            // Its initial Disconnected state can be observed while bootstrap is
            // in flight; restarting it here cancels a valid rendezvous.
            if (forceRefresh && state != RuntimeConnectionState.Connected) {
                runtime.controller.refresh()
            }
        }
    }

    fun retryActiveConnection() {
        // Freeze the computer at the user's tap; a later navigation must not
        // redirect this retry to another target.
        val targetId = activeInstanceId ?: return
        scope.launch {
            initialized.await()
            synchronizeDirectory()
            targetRuntimes[targetId]?.controller?.refresh()
        }
    }

    suspend fun selectTarget(instanceId: String) {
        require(instanceId.isNotBlank()) { "Computer target id must not be blank" }
        configStore.selectTarget(instanceId)
    }

    /** Owner UI navigation: verify against the fixed PC before changing any visible target. */
    internal suspend fun navigateToSession(request: SessionNavigationRequest, open: suspend (String) -> Unit) {
        request.validated()
        val target = request.targetInstanceId
            ?: throw AppApiException(ApiError(ApiErrorCode.AMBIGUOUS_TARGET, "Choose the source computer"))
        initialized.await()
        if (configStore.directory.first().computers.none { it.instanceId == target }) {
            throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Source computer is not paired"))
        }
        try {
            withTargetRuntime(target) { runtime ->
                val session = try { runtime.sessions.refreshSessionDetail(request.sessionId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    if (configStore.directory.first().computers.none { it.instanceId == target }) {
                        throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
                    }
                    if (failure !is com.andysagent.agentoc.core.domain.SessionRepositoryException) throw failure
                    val code = when (failure.statusCode) {
                        404 -> ApiErrorCode.RESOURCE_NOT_FOUND
                        401 -> ApiErrorCode.AUTHENTICATION_REQUIRED
                        403 -> ApiErrorCode.PERMISSION_DENIED
                        else -> ApiErrorCode.TARGET_OFFLINE
                    }
                    throw AppApiException(ApiError(code, "Source session could not be verified", failure.retryable))
                }
                val verifiedSession = session?.takeIf { it.id == request.sessionId }
                    ?: throw AppApiException(ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "Session was not found on this computer"))
                val terminalOrInactive = verifiedSession.status in setOf(
                    com.andysagent.agentoc.core.model.SessionStatus.Completed,
                    com.andysagent.agentoc.core.model.SessionStatus.Failed,
                    com.andysagent.agentoc.core.model.SessionStatus.Cancelled,
                ) || (verifiedSession.status == com.andysagent.agentoc.core.model.SessionStatus.Idle &&
                    verifiedSession.waitingAction.isNullOrBlank() &&
                    verifiedSession.workflowState?.trim()?.lowercase() !in setOf(
                        "waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input", "waiting_approval",
                    ))
                if (terminalOrInactive) {
                    AgentoCFirebaseMessagingService.Publisher(application)
                        .cancelAttentionNotifications(application, target, request.sessionId)
                }
                if (request.kind.lowercase() in setOf("approval", "question", "plan", "danger", "answer", "permission")) {
                    val approvalId = request.eventId.ifBlank { request.awaitingKey }
                    if (approvalId.isNotBlank()) {
                        val approval = runtime.sessions.findPendingApproval(request.sessionId, approvalId)
                        if (approval?.status != "pending") {
                            AgentoCFirebaseMessagingService.Publisher(application).cancelAttentionNotifications(
                                application,
                                target,
                                request.sessionId,
                                approval?.runId,
                                approvalId,
                                request.identity(),
                            )
                        }
                    }
                }
                if (configStore.directory.first().computers.none { it.instanceId == target }) {
                    throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
                }
                try { configStore.selectTarget(target) }
                catch (failure: IllegalArgumentException) {
                    if (configStore.directory.first().computers.none { it.instanceId == target }) {
                        throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
                    }
                    throw failure
                }
                synchronizeDirectory()
                withContext(Dispatchers.Main.immediate) {
                    if (configStore.directory.first().activeTargetId != target || sessions.delegate.value !== runtime.sessions) {
                        throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Selected computer changed during navigation"))
                    }
                    open(request.sessionId)
                }
            }
        } catch (cancelled: CancellationException) {
            // Target teardown cancels its repository job. Classify that only after
            // returning to the caller context, preserving real caller cancellation.
            currentCoroutineContext().ensureActive()
            if (configStore.directory.first().computers.none { it.instanceId == target }) {
                throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
            }
            throw cancelled
        }
    }

    suspend fun disconnectTarget(instanceId: String) = withContext(NonCancellable) {
        require(instanceId.isNotBlank()) { "Computer target id must not be blank" }
        accountRestoreJob?.cancelAndJoin()
        targetPairingCommits.remove(instanceId) {
            appApiCallerGrants.revokeForTarget(appApiOwner, instanceId)
            assistantDelegations.revokeForTarget(appApiOwner, instanceId)
            backgroundDeliveryConsents.revokeAll(appApiOwner, instanceId)
            try { configStore.removeTarget(instanceId) }
            finally { withContext(kotlinx.coroutines.NonCancellable) {
                appApiCallerGrants.revokeForTarget(appApiOwner, instanceId)
                assistantDelegations.revokeForTarget(appApiOwner, instanceId)
                backgroundDeliveryConsents.revokeAll(appApiOwner, instanceId)
            } }
            // Existing carriers release their lease with the still-current
            // bearer; synchronizeDirectory clears it after teardown. A join
            // that has not created a runtime still needs immediate cleanup.
            if (targetRuntimes[instanceId] == null) {
                credentialStore.clear(instanceId)
                p2pSecretStore.clear(instanceId)
            }
        }
        // Await revocation instead of waiting for the asynchronous directory observer.
        synchronizeDirectory()
    }

    /**
     * Execute a control-plane request against a bound computer without
     * changing the foreground chat target. Harness installation is local to
     * the selected computer, so every target gets its own authenticated
     * request and carrier.
     */
    suspend fun executeOnTarget(instanceId: String, request: ApiRequest): ApiResponse =
        withTargetRuntime(instanceId) { it.transport.execute(request) }

    internal suspend fun <T> withTargetRuntime(instanceId: String, block: suspend (TargetRuntime) -> T): T {
        initialized.await()
        check(!stopped) { "Runtime is closed" }
        // A first pairing may have been persisted after initial empty-directory startup.
        synchronizeDirectory()
        return connectionUses.withTarget(instanceId) { runtime ->
            awaitTargetConnected(runtime)
            if (configStore.directory.first().computers.none { it.instanceId == instanceId }) {
                throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
            }
            block(runtime)
        }
    }

    suspend fun refreshOtherDeviceProjects(): List<OtherDeviceProject> {
        val context = configurationMutex.withLock {
            val directory = configStore.directory.first()
            if (directory.activeTarget == null) mutableOtherDeviceProjects.value = emptyList()
            directory to otherDeviceProjectionEpoch
        }
        val directory = context.first
        val activeTargetId = directory.activeTarget?.instanceId
        if (activeTargetId.isNullOrBlank()) {
            return emptyList()
        }
        val backgroundTargets = directory.computers
            .asSequence()
            .filter { it.instanceId != activeTargetId }
            .sortedWith(
                compareByDescending<LinkedComputer> { it.lastSeenAt ?: Long.MIN_VALUE }
                    .thenBy { it.label.lowercase() },
            )
            .toList()
        val results = coroutineScope {
            backgroundTargets.map { target ->
                async {
                    val rows: List<OtherDeviceProject>? = try {
                        val response = transport.execute(
                            ApiRequest(
                                "GET",
                                "/api/target-runtime/summary?targetId=${encodePathSegment(target.instanceId)}",
                            ),
                        )
                        val summary = targetSummaryCodec
                            .decode(TargetSummary.serializer(), response.body)
                            .validate()
                        summary.recentProjects.map { project ->
                            OtherDeviceProject(
                                targetId = target.instanceId,
                                targetLabel = target.label.ifBlank { target.instanceId },
                                targetLastSeenAt = target.lastSeenAt ?: 0L,
                                projectId = project.id,
                                projectName = project.name,
                                updatedAt = project.updatedAt.toEpochMillisOrZero(),
                                pendingApprovals = summary.approvals.pending,
                            )
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: ApiException) {
                        if (error.statusCode == 401 || error.statusCode == 403) emptyList() else null
                    } catch (_: Exception) {
                        null
                    }
                    target.instanceId to rows
                }
            }.awaitAll().toMap()
        }
        return configurationMutex.withLock {
            val current = configStore.directory.first()
            if (otherDeviceProjectionEpoch != context.second || activeInstanceId != activeTargetId ||
                current.activeTarget?.instanceId != activeTargetId) return@withLock mutableOtherDeviceProjects.value
            val allowed = current.computers.map { it.instanceId }.filter { it != activeTargetId }.toSet()
            mergeOtherDeviceProjects(mutableOtherDeviceProjects.value, results, allowed).also {
                mutableOtherDeviceProjects.value = it
            }
        }
    }

    suspend fun listProviderInstances(): List<com.andysagent.agentoc.feature.workbench.ProviderInstance> {
        initialized.await()
        controlWorkbench?.let { return listOf(com.andysagent.agentoc.feature.workbench.ProviderInstance(it.instanceId, it.instanceId)) }
        if (configStore.accountSession.first() != null) {
            return listAccountDirectoryDevices().filter {
                it.deviceKind.equals("computer", ignoreCase = true) && it.unboundAt.isNullOrBlank()
            }.map { com.andysagent.agentoc.feature.workbench.ProviderInstance(it.instanceId, it.alias.ifBlank { it.instanceId }) }
        }
        return configStore.directory.first().computers.map {
            com.andysagent.agentoc.feature.workbench.ProviderInstance(it.instanceId, it.label.ifBlank { it.instanceId })
        }
    }

    suspend fun executeProviderOnInstance(instanceId: String, request: ApiRequest): ApiResponse {
        controlWorkbench?.let { control ->
            require(instanceId == control.instanceId) { "Provider target differs from temporary computer" }
            return control.transport.execute(request)
        }
        if (configStore.directory.first().computers.none { it.instanceId == instanceId }) {
            // Account authorization establishes a background binding, never selecting it for chat.
            renewAccountRendezvous(instanceId, accountDeviceAlias, selectTarget = false)
        }
        return executeOnTarget(instanceId, request)
    }

    suspend fun loadHarnessTargetSnapshots(): List<WebHarnessTargetSnapshot> = coroutineScope {
        controlWorkbench?.let { control ->
            val harnesses = parseWebHarnesses(control.transport.execute(ApiRequest("GET", "/api/harnesses")).body)
            return@coroutineScope listOf(WebHarnessTargetSnapshot(
                target = WebHarnessTarget(instanceId = control.instanceId, label = control.instanceId,
                    available = true, detail = "Temporary control", installedHarnessIds =
                    harnesses.filter { it.installed }.mapTo(mutableSetOf()) { it.id },
                    supportedHarnessIds = harnesses.filter { it.supportedOnPlatform }.mapTo(mutableSetOf()) { it.id }), harnesses = harnesses))
        }
        val computers = configStore.directory.first().computers
        computers.map { target ->
            async {
                val baseTarget = WebHarnessTarget(
                    instanceId = target.instanceId,
                    label = target.label.ifBlank { target.instanceId },
                    available = false,
                    detail = "Not connected",
                )
                runCatching {
                    val response = executeOnTarget(
                        target.instanceId,
                        ApiRequest("GET", "/api/harnesses"),
                    )
                    val harnesses = parseWebHarnesses(response.body)
                    WebHarnessTargetSnapshot(
                        target = WebHarnessTarget(
                            instanceId = target.instanceId,
                            label = target.label.ifBlank { target.instanceId },
                            available = true,
                            detail = "Connected",
                            installedHarnessIds = harnesses.filter { it.installed }.mapTo(mutableSetOf()) { it.id },
                            supportedHarnessIds = harnesses.filter { it.supportedOnPlatform }.mapTo(mutableSetOf()) { it.id },
                        ),
                        harnesses = harnesses,
                    )
                }.getOrElse { error ->
                    WebHarnessTargetSnapshot(
                        target = baseTarget.copy(detail = error.message ?: "Unavailable"),
                    )
                }
            }
        }.awaitAll()
    }

    suspend fun mutateHarnessOnTargets(
        id: String,
        operation: WebHarnessOperation,
        targetIds: List<String>,
    ): List<WebHarnessMutationResult> = coroutineScope {
        controlWorkbench?.let { control ->
            val requested = targetIds.map(String::trim).filter(String::isNotEmpty).distinct()
            require(requested.all { it == control.instanceId }) { "Harness target differs from temporary computer" }
            val operationPath = when (operation) {
                WebHarnessOperation.Install -> "install"
                WebHarnessOperation.Upgrade -> "upgrade"
                WebHarnessOperation.Uninstall -> "uninstall"
            }
            val result = runCatching { control.transport.execute(ApiRequest("POST", "/api/harnesses/${encodePathSegment(id)}/$operationPath", "{}")) }
            return@coroutineScope listOf(WebHarnessMutationResult(instanceId = control.instanceId, label = control.instanceId,
                success = result.isSuccess, error = result.exceptionOrNull()?.message))
        }
        val directory = configStore.directory.first()
        val activeId = directory.activeTarget?.instanceId
        val requestedIds = targetIds.map(String::trim).filter(String::isNotEmpty).distinct()
        val selectedIds = (requestedIds.ifEmpty { listOfNotNull(activeId) })
        require(selectedIds.isNotEmpty()) { "No computer target is selected" }
        val boundIds = directory.computers.mapTo(hashSetOf()) { it.instanceId }
        require(selectedIds.all { it in boundIds }) { "Harness target is not a bound computer" }
        selectedIds.map { instanceId ->
            async {
                val target = directory.computers.first { it.instanceId == instanceId }
                runCatching {
                    val operationPath = when (operation) {
                        WebHarnessOperation.Install -> "install"
                        WebHarnessOperation.Upgrade -> "upgrade"
                        WebHarnessOperation.Uninstall -> "uninstall"
                    }
                    executeOnTarget(
                        instanceId,
                        ApiRequest(
                            "POST",
                            "/api/harnesses/${encodePathSegment(id)}/$operationPath",
                            "{}",
                        ),
                    )
                    WebHarnessMutationResult(
                        instanceId = instanceId,
                        label = target.label.ifBlank { instanceId },
                        success = true,
                    )
                }.getOrElse { error ->
                    WebHarnessMutationResult(
                        instanceId = instanceId,
                        label = target.label.ifBlank { instanceId },
                        success = false,
                        error = error.message ?: "Harness operation failed",
                    )
                }
            }
        }.awaitAll()
    }

    private suspend fun awaitTargetConnected(runtime: TargetRuntime) {
        // An internal connection budget is an unavailable target, not caller
        // cancellation. Parent coroutine cancellation still propagates.
        val state = withTimeoutOrNull(connectionWaitTimeoutMs) {
            runtime.transport.connectionState.first {
                it == RuntimeConnectionState.Connected || it == RuntimeConnectionState.AuthenticationRequired
            }
        } ?: throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Computer connection timed out", retryable = true))
        if (state == RuntimeConnectionState.AuthenticationRequired) {
            throw AppApiException(ApiError(ApiErrorCode.AUTHENTICATION_REQUIRED, "Computer authentication is required"))
        }
    }

    /** Wait for this specific background computer, without selecting or restarting it. */
    internal suspend fun awaitBackgroundComputerConnected(instanceId: String) {
        if (!awaitConnectedComputer(targetConnectionStates, instanceId, connectionWaitTimeoutMs)) {
            throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Computer connection timed out", retryable = true))
        }
    }

    private fun encodePathSegment(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
        accountCapacityRetry.cancel()
        accountRestoreJob?.cancel()
        uiBackgroundTargetIds = emptySet()
        mutableBackgroundTargetSummaries.value = emptyMap()
        targetRuntimes.values.forEach { it.sessions.stopLiveSync() }
        // Keep the selected carriers leased while the process is alive. A
        // background transition must not disconnect an ongoing connection.
    }

    internal suspend fun awaitLifecycleUpdate() { initialized.await(); synchronizeDirectory() }

    /** Read-only diagnostics, explicitly bound to a target; no mutable supervisor is exposed. */
    internal suspend fun targetConnectivity(instanceId: String): StateFlow<com.andysagent.agentoc.core.network.ConnectionState> {
        initialized.await()
        synchronizeDirectory()
        val target = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId }
            ?: error("Unknown computer target")
        return ensureTargetRuntime(target).controller.connectivityState ?: error("Connection diagnostics unavailable")
    }

    private fun activeTargetRuntime(): TargetRuntime? = activeInstanceId?.let { targetRuntimes[it] }

    private fun ensureTargetRuntime(target: LinkedComputer): TargetRuntime = synchronized(targetRuntimes) {
        targetRuntimes[target.instanceId]?.let { runtime ->
            val endpoint = target.endpoint.trimEnd('/')
            if (runtime.baseEndpoint != endpoint) {
                runtime.baseEndpoint = endpoint
                runtime.controller.refresh()
            }
            return@synchronized runtime
        }
        val childScope = CoroutineScope(SupervisorJob(scope.coroutineContext[Job]) + Dispatchers.Default)
        val runtime = targetFactoryOverride?.create(target, targetDatabaseName(target), childScope)
            ?: createTargetRuntime(target, childScope)
        require(runtime.instanceId == target.instanceId) { "Runtime target binding differs" }
        targetRuntimes[target.instanceId] = runtime
        runtime.transport.invalidations.onEach { hint ->
            if (hint.type == "harnesses_invalidated" || hint.type == "harness_invalidated") harnessInvalidations.emit(target.instanceId)
            if (hint.type == "target_runtime_summary_invalidated") refreshBackgroundSummary(runtime)
        }.launchIn(childScope)
        runtime.sessions.observeTargetSummary().onEach { summary ->
            mutableBackgroundTargetSummaries.update { current ->
                if (summary != null && summary.targetId == target.instanceId &&
                    target.instanceId in uiBackgroundTargetIds &&
                    runtime.transport.connectionState.value == RuntimeConnectionState.Connected) {
                    current + (target.instanceId to summary)
                } else current - target.instanceId
            }
        }.launchIn(childScope)
        runtime.transport.connectionState.onEach { state ->
            // A disposed runtime's delayed callback must not overwrite its
            // replacement after an explicit unpair/re-pair of the same ID.
            mutableTargetConnectionStates.update { current ->
                if (targetRuntimes[target.instanceId] === runtime) current + (target.instanceId to state)
                else current
            }
            if (state == RuntimeConnectionState.Connected) {
                notificationRegistrar?.invoke() ?: registerFcmTokenWhenConnected(runtime.instanceId)
            }
            if (state == RuntimeConnectionState.Connected) refreshBackgroundSummary(runtime)
            else mutableBackgroundTargetSummaries.update { it - runtime.instanceId }
            if (state == RuntimeConnectionState.Connected && foreground && activeInstanceId == runtime.instanceId) {
                retryAccountCapacity(runtime.instanceId)
                runtime.sessions.startLiveSync()
                runCatching { runtime.sessions.resumePendingOperations() }
            }
        }.launchIn(childScope)
        runtime
    }

    private suspend fun refreshBackgroundSummary(runtime: TargetRuntime) {
        if (!foreground || runtime.instanceId !in uiBackgroundTargetIds ||
            runtime.transport.connectionState.value != RuntimeConnectionState.Connected) return
        try { runtime.sessions.refreshTargetSummary() }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Summary unavailability never switches/hydrates foreground data. */ }
    }

    internal suspend fun rejectTargetCredential(runtime: TargetRuntime, attemptedCredential: String?, stillCurrent: () -> Boolean, invalidate: () -> Unit) {
        configurationMutex.withLock {
            currentCoroutineContext().ensureActive()
            if (targetRuntimes[runtime.instanceId] !== runtime ||
                configStore.directory.first().computers.none { it.instanceId == runtime.instanceId }) return@withLock
            currentCoroutineContext().ensureActive()
            if (!stillCurrent() || credentialStore.readToken(runtime.instanceId) != attemptedCredential) return@withLock
            credentialStore.clear(runtime.instanceId)
            p2pSecretStore.clear(runtime.instanceId)
            invalidate()
        }
    }

    private suspend fun renewTargetCredential(runtime: TargetRuntime, attemptedCredential: String?, stillCurrent: () -> Boolean) =
        targetPairingCommits.withTarget(runtime.instanceId) { removalGuard ->
            val guard = com.andysagent.agentoc.core.auth.PairingWriteGuard { instanceId, writes ->
                removalGuard.persist(instanceId) {
                    currentCoroutineContext().ensureActive()
                    if (stopped || targetRuntimes[instanceId] !== runtime || !stillCurrent()
                        || configStore.directory.first().computers.none { it.instanceId == instanceId }
                        || credentialStore.readToken(instanceId) != attemptedCredential) {
                        throw CancellationException("Credential renewal was superseded")
                    }
                    writes()
                }
            }
            guard.persist(runtime.instanceId) { }
            com.andysagent.agentoc.core.auth.DeviceCredentialRenewalCoordinator(
                com.andysagent.agentoc.core.auth.DeviceCredentialRenewal(identityStore, credentialStore, p2pSecretStore), pairing,
            ).renew(runtime.instanceId, runtime.baseEndpoint, accountDeviceAlias, guard)
        }

    private suspend fun renewTargetCarrierCredential(runtime: TargetRuntime, attemptedCredential: String?, deviceId: String,
        stillCurrent: () -> Boolean) = targetPairingCommits.withTarget(runtime.instanceId) { removalGuard ->
        val guard = com.andysagent.agentoc.core.auth.PairingWriteGuard { instanceId, writes ->
            removalGuard.persist(instanceId) {
                currentCoroutineContext().ensureActive()
                if (stopped || targetRuntimes[instanceId] !== runtime || !stillCurrent()
                    || configStore.directory.first().computers.none { it.instanceId == instanceId }
                    || credentialStore.readToken(instanceId) != attemptedCredential) {
                    throw CancellationException("Carrier credential renewal was superseded")
                }
                writes()
            }
        }
        guard.persist(runtime.instanceId) { }
        com.andysagent.agentoc.core.auth.DeviceCredentialRenewal(identityStore, credentialStore, p2pSecretStore)
            .renewViaCarrier(runtime.instanceId, deviceId, runtime.transport, guard)
    }

    private fun createTargetRuntime(target: LinkedComputer, childScope: CoroutineScope): TargetRuntime {
        lateinit var runtime: TargetRuntime
        lateinit var controller: BoundTargetConnection
        val database = AgentoCDatabase.create(application, targetDatabaseName(target))
        val targetTransport = OkHttpAgentoCTransport(
            endpointProvider = { runtime.endpoint },
            credentialProvider = { credentialStore.readToken(target.instanceId) },
            requireVerifiedCarrier = true,
            credentialRejectionHandler = com.andysagent.agentoc.core.network.CredentialRejectionHandler { credential, current, invalidate ->
                controller.rejectCredential(credential, current, invalidate)
            },
            onCarrierUnavailable = { failed -> controller.carrierRequestFailed(failed) },
        )
        val repository = RoomSessionRepository(database, targetTransport, contentResolver = application.contentResolver, targetId = target.instanceId)
        controller = BoundTargetConnection(
            instanceId = target.instanceId, application = application,
            onNetworkRestored = { retryAccountCapacity(target.instanceId, expedite = true) },
            endpointProvider = { runtime.baseEndpoint },
            credentialProvider = { credentialStore.readToken(target.instanceId) },
            p2pCredentialsProvider = { p2pSecretStore.read(target.instanceId)?.let { BootstrapP2PCredentials(it.secret) } },
            transport = targetTransport, scope = childScope, reportingScope = scope,
            releaseAccountReservation = { id -> accountSessions.releaseOwnTurnConnections(listOf(id), "client-release"); Unit },
            endpointlessBootstrap = {
                val stillPaired = configStore.directory.first().computers.firstOrNull { it.instanceId == target.instanceId }
                    ?: throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Computer was unpaired"))
                // Lease ownership supplies the desired lifetime; reconnect must not
                // rewrite DataStore selection/autoConnect or start an independent controller.
                val result = renewAccountRendezvous(stillPaired.instanceId, accountDeviceAlias,
                    selectTarget = false, persistDirectory = false, requirePaired = true)
                BootstrapConnectionPlanFactory.create(result.verifiedBootstrap ?: error("Verified bootstrap is missing"), "",
                    result.p2p?.let { BootstrapP2PCredentials(it.secret) })
            },
            onAuthenticationRequired = {},
            credentialRejectionHandler = com.andysagent.agentoc.core.network.CredentialRejectionHandler { credential, current, invalidate ->
                rejectTargetCredential(runtime, credential, current, invalidate)
            },
            credentialRenewalRequired = {
                com.andysagent.agentoc.core.auth.DeviceCredentialRenewal.isDue(credentialStore.read(target.instanceId))
                    || p2pSecretStore.read(target.instanceId) == null
            },
            renewCredential = { credential, current -> renewTargetCredential(runtime, credential, current) },
            renewCarrierCredential = { credential, deviceId, current ->
                renewTargetCarrierCredential(runtime, credential, deviceId, current)
            },
            onEndpointResolved = { runtime.endpoint = it },
        )
        runtime = TargetRuntime(target.instanceId, target.endpoint.trimEnd('/'), "", targetTransport, repository, controller,
            childScope, disposeStorage = { database.close() })
        return runtime
    }

    private fun targetDatabaseName(target: LinkedComputer): String {
        // Preserve the pre-existing database for the first directory entry;
        // every additional computer gets a deterministic independent file.
        if (target.instanceId == primaryDatabaseInstanceId) return "agentoc.db"
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(target.instanceId.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "agentoc-target-$digest.db"
    }

    /** Application shutdown/test teardown; normal UI exit only releases its owner set. */
    internal suspend fun close() {
        stopped = true
        targetPairingCommits.close()
        accountRestoreJob?.cancel()
        withContext(Dispatchers.Main) { ProcessLifecycleOwner.get().lifecycle.removeObserver(this@AndroidRuntimeGraph) }
        scope.cancel()
        withContext(NonCancellable) {
            configurationMutex.withLock {
                controlWorkbench?.let { it.lifetime.close() }
                controlWorkbench = null; mutableTemporaryControlActive.value = false
                targetRuntimes.entries.toList().forEach { (id, runtime) ->
                    connectionUses.revoke(id)
                    runtime.dispose()
                }
                targetRuntimes.clear()
                mutableTargetConnectionStates.value = emptyMap()
                if (appApiDatabase.isInitialized()) appApiDatabase.value.close()
                if (assistantDelegationDatabase.isInitialized()) assistantDelegationDatabase.value.close()
            }
        }
    }

}

internal fun bootstrapRetryDelayMs(attempt: Int): Long = minOf(
    BOOTSTRAP_RETRY_MAX_MS,
    BOOTSTRAP_RETRY_BASE_MS * (1L shl attempt.coerceAtLeast(0).coerceAtMost(5)),
)

internal fun String.toEpochMillisOrZero(): Long = runCatching {
    java.time.Instant.parse(trim()).toEpochMilli()
}.getOrDefault(0L)

internal fun pendingGoogleBindingMatches(pairingUri: String, pending: PendingGoogleBinding): Boolean =
    runCatching { parsePairingUri(pairingUri) }.getOrNull()?.let { invitation ->
        invitation.endpoint.trimEnd('/') == pending.endpoint.trimEnd('/') &&
            invitation.instanceId == pending.instanceId
    } == true
