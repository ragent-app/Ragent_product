package com.andysagent.ragent

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.room.Room
import com.andysagent.ragent.core.auth.AndroidCredentialStore
import com.andysagent.ragent.core.auth.AndroidAccountCredentialStore
import com.andysagent.ragent.core.auth.AndroidP2PSecretStore
import com.andysagent.ragent.core.auth.AndroidDeviceIdentityStore
import com.andysagent.ragent.core.auth.AndroidTemporaryClaimJournal
import com.andysagent.ragent.core.auth.AndroidTemporaryTextOperationJournal
import com.andysagent.ragent.core.auth.AndroidTemporaryAttachmentByteStore
import com.andysagent.ragent.core.auth.AccountSessionChallenge
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.auth.AccountSessionManager
import com.andysagent.ragent.core.auth.ClientConfigAccountSessionStore
import com.andysagent.ragent.core.auth.PairingAuthenticator
import com.andysagent.ragent.core.auth.PairingResult
import com.andysagent.ragent.core.auth.defaultDeviceAlias
import com.andysagent.ragent.core.auth.shouldAutoConnectQrClaim
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.datastore.ClientConfigStore
import com.andysagent.ragent.core.datastore.ComputerDirectory
import com.andysagent.ragent.core.datastore.StoredInstance
import com.andysagent.ragent.core.datastore.StoredGoogleAccountProfile
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.core.datastore.PendingGoogleBinding
import com.andysagent.ragent.core.domain.DefaultAccountsRepository
import com.andysagent.ragent.core.domain.AccountDirectoryDevice
import com.andysagent.ragent.core.protocol.AccountRendezvousTargetInstanceDto
import com.andysagent.ragent.core.domain.AccountsRepositoryException
import com.andysagent.ragent.core.domain.ActiveAccountSession
import com.andysagent.ragent.core.domain.AccountSessionStateSource
import com.andysagent.ragent.core.domain.AccountSessionVerification
import com.andysagent.ragent.core.domain.GoogleAccountIdentityStore
import com.andysagent.ragent.core.domain.GoogleAccountProfile
import com.andysagent.ragent.core.domain.RoomSessionRepository
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.domain.SwitchingSessionRepository
import com.andysagent.ragent.core.network.AndroidNetworkMonitor
import com.andysagent.ragent.core.network.BootstrapConnectionPlan
import com.andysagent.ragent.core.network.BootstrapConnectionPlanFactory
import com.andysagent.ragent.core.network.BootstrapP2PCredentials
import com.andysagent.ragent.core.network.ConnectionBootstrapClient
import com.andysagent.ragent.core.network.ConnectivitySupervisor
import com.andysagent.ragent.core.network.ConnectionStatus
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.SwitchingRagentTransport
import com.andysagent.ragent.core.network.TurnCarrier
import com.andysagent.ragent.core.network.TransportKind
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import com.andysagent.ragent.core.protocol.parsePairingUri
import com.andysagent.ragent.core.protocol.PairingUriDto
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.model.OtherDeviceProject
import com.andysagent.ragent.core.protocol.ProtocolCodec
import com.andysagent.ragent.core.protocol.TargetSummary
import com.andysagent.ragent.feature.workbench.WebHarness
import com.andysagent.ragent.feature.workbench.WebHarnessMutationResult
import com.andysagent.ragent.feature.workbench.WebHarnessOperation
import com.andysagent.ragent.feature.workbench.WebHarnessTarget
import com.andysagent.ragent.feature.workbench.WebHarnessTargetSnapshot
import com.andysagent.ragent.feature.workbench.parseWebHarnesses
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
import kotlinx.coroutines.flow.combine
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
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class RagentApplication : Application(), com.andysagent.ragent.integration.appfunctions.AssistantAppFunctionsHost {
    override val assistantAppFunctions: AssistantTaskBridge get() = runtime.assistantTasks

    val runtime: AndroidRuntimeGraph by lazy {
        check(!isDocumentExportProcess()) { "Document worker cannot initialize PC runtime" }
        android.os.Trace.beginSection("Ragent.runtime.construct")
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
        PushRegistrationSchedule.ensure(this)
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
        }, "RagentRuntimeInit").start()
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
    directory: com.andysagent.ragent.core.datastore.ComputerDirectory,
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
    private val pushRegistrationStore = PushRegistrationStore(application)
    private val startGuard = java.util.concurrent.atomic.AtomicBoolean()
    @Volatile private var stopped = false
    @Volatile private var activeInstanceId: String? = null
    @Volatile private var primaryDatabaseInstanceId: String? = null
    @Volatile private var pendingFcmToken: String? = null
    @Volatile private var foreground = false
    @Volatile private var retainUiConnections = false
    @Volatile private var foregroundSyncReady = false
    private var backgroundSyncJob: Job? = null
    private var foregroundProbeJob: Job? = null
    private var foregroundStartJob: Job? = null
    private val lifecycleGeneration = java.util.concurrent.atomic.AtomicLong()
    private val backgroundSyncLimitMs = 2 * 60_000L
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
    private val localCredentials = LocalCredentialStore(application)
    private val localAccountLinks = LocalAccountLinkStore(application)
    private val localSessionRevocations = LocalSessionRevocationOutbox(application)
    private val localAccountLinkMutex = Mutex()
    private val localAccountLoginInFlight = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val localHandoffActive = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val mutableLocalAccountLinkStates = MutableStateFlow<Map<String, String>>(emptyMap())
    val localAccountLinkStates: StateFlow<Map<String, String>> = mutableLocalAccountLinkStates.asStateFlow()
    private val mutableLocalSessionRevocationsPending = MutableStateFlow(false)
    val localSessionRevocationsPending: StateFlow<Boolean> = mutableLocalSessionRevocationsPending.asStateFlow()

    internal suspend fun localAccountLinkStatus(instanceId: String): LocalAccountLinkStatus {
        val target = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId && it.localRuntime }
            ?: throw IllegalArgumentException("Local instance is unavailable")
        return withTargetRuntime(target.instanceId) { runtime ->
            parseLocalAccountLinkStatus(runtime.transport.execute(ApiRequest("GET", "/api/local/account-link")).body, instanceId)
        }
    }

    internal suspend fun refreshLocalAccountLink(instanceId: String): LocalAccountLinkStatus {
        reconcileLocalAccountLink(instanceId)
        return localAccountLinkStatus(instanceId)
    }

    suspend fun beginLocalInstanceAccountLogin(instanceId: String): String {
        require(localSessionRevocations.ids().isEmpty()) { "Previous sign-out is still waiting for confirmation" }
        val status = localAccountLinkStatus(instanceId)
        require(status.state == "signed_out" && localAccountLinks.read(instanceId)?.let {
            it.tombstone && it.localClearCompleted && it.pendingEventId == null && it.pendingCloudToken == null &&
                it.linkId == status.linkId && it.deviceId == status.deviceId && it.accountId == status.accountId
        } == true) { "Account link is not ready for sign-in" }
        val result = withTargetRuntime(instanceId) { runtime ->
            kotlinx.serialization.json.Json.parseToJsonElement(runtime.transport.execute(
                ApiRequest("POST", "/api/auth/google/bind", "{}")).body).jsonObject
        }
        require(result["deliveryMode"]?.jsonPrimitive?.content == "instance_poll" && result["mode"]?.jsonPrimitive?.content == "accounts")
        val authUrl = android.net.Uri.parse(result.getValue("authUrl").jsonPrimitive.content)
        val accounts = android.net.Uri.parse(application.getString(R.string.accounts_directory_base_url))
        require(authUrl.scheme == "https" && authUrl.host.equals(accounts.host, ignoreCase = true) &&
            authUrl.port == accounts.port && authUrl.userInfo == null) { "Invalid account authorization address" }
        return authUrl.toString()
    }

    /** User explicitly confirmed removal of the old instance owner and its device grants. */
    suspend fun unbindLocalAccount(instanceId: String, expectedOwner: String, expectedPhone: String) {
        require(expectedOwner != expectedPhone && configStore.accountSession.first()?.accountId == expectedPhone)
        val status = localAccountLinkStatus(instanceId)
        require(status.ownerAccountId == expectedOwner && status.accountId == expectedOwner)
        localAccountLinks.invalidate(instanceId)
        localAccountLinkMutex.withLock {
            val record = localAccountLinks.read(instanceId) ?: LocalAccountLinkRecord(instanceId,
                requireNotNull(status.linkId), requireNotNull(status.deviceId), expectedOwner, status.generation, tombstone = true)
            require(record.accountId == expectedOwner && record.localClearCompleted &&
                record.linkId == status.linkId && record.deviceId == status.deviceId)
            localAccountLinks.write(record.copy(tombstone = true, unbindPending = true))
        }
        mutableLocalAccountLinkStates.update { it + (instanceId to "pending") }
        withTargetRuntime(instanceId) { runtime ->
            runtime.transport.execute(ApiRequest("POST", "/api/auth/google/unbind", "{}"))
        }
        reconcileLocalAccountLink(instanceId)
    }

    /** Invoked only after the caller displays the identities and obtains explicit consent. */
    suspend fun authorizeLocalAccountLink(instanceId: String, expectedPhoneAccount: String?, expectedOwnerAccount: String?) {
        val authorizationEpoch = localAccountLinkMutex.withLock { localAccountLinks.epoch(instanceId) }
        require(localSessionRevocations.ids().isEmpty()) { "Previous sign-out is still waiting for confirmation" }
        localAccountLinks.read(instanceId)?.let { previous ->
            require(!previous.tombstone || (previous.localClearCompleted && previous.pendingEventId == null && previous.pendingCloudToken == null)) {
                "Previous sign-out is still waiting for confirmation"
            }
        }
        val initial = localAccountLinkStatus(instanceId)
        val phone = configStore.accountSession.first()?.accountId
        require(phone == expectedPhoneAccount && initial.ownerAccountId == expectedOwnerAccount) { "Account state changed; review it again" }
        if (initial.state == "signed_out" && phone != null) {
            val existing = requireNotNull(localAccountLinks.read(instanceId))
            require(existing.tombstone && existing.localClearCompleted && existing.pendingEventId == null &&
                existing.accountId == phone && initial.accountId == phone && initial.linkId == existing.linkId &&
                initial.deviceId == existing.deviceId && initial.generation >= existing.generation)
            val target = configStore.directory.first().computers.first { it.instanceId == instanceId && it.localRuntime }
            targetPairingCommits.withTarget(instanceId) { guard ->
                withTargetRuntime(instanceId) { runtime ->
                    pairing.joinWithAccountSession(target.endpoint, accountDeviceAlias, autoConnect = false, selectTarget = false,
                        writeGuard = guard, renewExistingDeviceId = existing.deviceId, localTransport = runtime.transport,
                        expectedInstanceId = instanceId, persistDirectory = false)
                }
            }
            val after = localAccountLinkStatus(instanceId)
            require(after.state == "login_pending" && after.linkId == existing.linkId && after.deviceId == existing.deviceId &&
                after.accountId == existing.accountId && after.generation > initial.generation)
            localAccountLinkMutex.withLock {
                require(localAccountLinks.epoch(instanceId) == authorizationEpoch && localAccountLinks.read(instanceId) == existing)
                localAccountLinks.write(existing.copy(generation = after.generation))
            }
            reconcileLocalAccountLink(instanceId)
            return
        }
        require(initial.state != "signed_out") { "Sign in to the local instance again first" }
        require(initial.ownerAuthority != "unavailable") { "Account authority is unavailable" }
        require(phone != null || initial.ownerAccountId != null) { "Sign in to one side first" }
        require(phone == null || initial.ownerAccountId == null || phone == initial.ownerAccountId) { "Accounts differ; resolve the conflict first" }
        require(initial.state != "active" || localAccountLinks.read(instanceId)?.linkId == initial.linkId) {
            "This instance is already linked to another installation"
        }
        if (initial.state == "active") {
            val existing = requireNotNull(localAccountLinks.read(instanceId))
            require(!existing.tombstone && phone == existing.accountId && initial.accountId == existing.accountId &&
                initial.deviceId == existing.deviceId && initial.generation >= existing.generation) { "Account link needs conflict resolution" }
            localAccountLinkMutex.withLock {
                require(localAccountLinks.epoch(instanceId) == authorizationEpoch && localAccountLinks.read(instanceId) == existing)
                localAccountLinks.write(existing.copy(generation = initial.generation, pendingEventId = null, pendingAction = null))
            }
            return
        }
        val (invitation, invitationUri) = withTargetRuntime(instanceId) { runtime ->
            val response = runtime.transport.execute(ApiRequest("POST", "/api/device-pairing/invitations", "{}"))
            val obj = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject
            val uri = obj.getValue("invitation").jsonObject.getValue("pairingUri").jsonPrimitive.content
            parsePairingUri(uri).also { require(it.instanceId == instanceId) { "Invitation belongs to another instance" } } to uri
        }
        if (phone == null) {
            require(invitation.version == 4 && initial.ownerAccountId != null) { "This instance cannot authorize an account" }
            val recoveryId = registerLocalHandoffRecovery(instanceId, invitationUri, initial.ownerAccountId, initial.generation, initial.linkId)
            try { accountSessions.acceptDesktopAccount(invitation, accountDeviceAlias, expectedAccountId = initial.ownerAccountId,
                persistGate = { grantedAccount, _, token, persist ->
                    val remote = try { localAccountLinkStatus(instanceId) } catch (error: Exception) {
                        localSessionRevocations.replaceWithToken(recoveryId, token)
                        throw error
                    }
                    localAccountLinkMutex.withLock {
                    val current = localAccountLinks.read(instanceId)
                    val valid = grantedAccount == initial.ownerAccountId && localAccountLinks.epoch(instanceId) == authorizationEpoch &&
                        remote.generation == initial.generation && remote.state == initial.state &&
                        (current == null || (!current.tombstone && current.generation == initial.generation))
                    if (!valid) {
                        localSessionRevocations.replaceWithToken(recoveryId, token)
                        error("Account authorization was superseded by sign-out")
                    }
                    try { persist().also { localSessionRevocations.remove(recoveryId) } } catch (error: Throwable) {
                        localSessionRevocations.replaceWithToken(recoveryId, token)
                        throw error
                    }
                } }) } finally { localHandoffActive.remove(recoveryId) }
        }
        val accountId = configStore.accountSession.first()?.accountId ?: error("Account sign-in did not complete")
        require(accountId == (phone ?: initial.ownerAccountId)) { "Account changed during authorization" }
        val target = configStore.directory.first().computers.firstOrNull { it.instanceId == instanceId && it.localRuntime }
            ?: error("Local instance was removed")
        val result = targetPairingCommits.withTarget(instanceId) { guard ->
            withTargetRuntime(instanceId) { runtime ->
                pairing.joinWithAccountSession(target.endpoint, accountDeviceAlias,
                    accountClaimToken = invitation.token.takeIf { invitation.version == 3 },
                    autoConnect = false, selectTarget = false, writeGuard = guard,
                    localTransport = runtime.transport, expectedInstanceId = instanceId, persistDirectory = false)
            }
        }
        val afterJoin = localAccountLinkStatus(instanceId)
        require(afterJoin.ownerAuthority == "active" && afterJoin.ownerAccountId == accountId) { "Instance account could not be verified" }
        require(afterJoin.generation == initial.generation && afterJoin.state != "active") { "Account link changed; review it again" }
        val eventId = java.util.UUID.randomUUID().toString()
        val linkId = "lnk_" + java.util.UUID.randomUUID().toString().replace("-", "")
        val record = LocalAccountLinkRecord(instanceId, linkId, result.deviceId, accountId, afterJoin.generation,
            pendingEventId = eventId, pendingAction = "link")
        localAccountLinkMutex.withLock {
            require(localAccountLinks.epoch(instanceId) == authorizationEpoch) { "Account authorization was superseded by sign-out" }
            localAccountLinks.write(record)
        }
        val response = withTargetRuntime(instanceId) { runtime ->
            runtime.transport.execute(localAccountLinkEvent(record, "link", identityStore, eventId, System.currentTimeMillis()))
        }
        val accepted = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject
        require(accepted["instanceId"]?.jsonPrimitive?.content == instanceId &&
            accepted["linkId"]?.jsonPrimitive?.content == linkId && accepted["deviceId"]?.jsonPrimitive?.content == result.deviceId &&
            accepted["accountId"]?.jsonPrimitive?.content == accountId && accepted["eventId"]?.jsonPrimitive?.content == eventId &&
            accepted["state"]?.jsonPrimitive?.content == "active") { "Account link was not confirmed" }
        val generation = accepted["generation"]?.jsonPrimitive?.content?.toLongOrNull() ?: error("Invalid account link generation")
        require(generation > record.generation) { "Account link generation did not advance" }
        localAccountLinkMutex.withLock {
            val latest = localAccountLinks.read(instanceId)
            require(localAccountLinks.epoch(instanceId) == authorizationEpoch && latest == record) { "Account authorization was superseded by sign-out" }
            localAccountLinks.write(record.copy(generation = generation, pendingEventId = null, pendingAction = null))
        }
        mutableLocalAccountLinkStates.update { it + (instanceId to "active") }
    }

    private suspend fun reconcileLocalAccountLink(instanceId: String) {
        localAccountLinkMutex.withLock {
            var record = localAccountLinks.read(instanceId) ?: run {
                mutableLocalAccountLinkStates.update { it - instanceId }
                return
            }
            if (record.tombstone && !record.localClearCompleted) {
                // The durable fence must also be applied while the peer is offline.
                if (configStore.accountSession.first()?.accountId == record.accountId) accountSessions.clearLocalSession()
                record = record.copy(localClearCompleted = true)
                localAccountLinks.write(record)
            }
            reconcileLocalCloudLogout(record)
        }
        val status = localAccountLinkStatus(instanceId)
        localAccountLinkMutex.withLock {
        var record = localAccountLinks.read(instanceId) ?: return@withLock
        val phoneAccount = configStore.accountSession.first()?.accountId
        if (record.unbindPending) {
            if (status.state == "unlinked" && status.ownerAuthority == "unbound" &&
                record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty()) {
                localAccountLinks.clear(instanceId)
                mutableLocalAccountLinkStates.update { it - instanceId }
            } else {
                mutableLocalAccountLinkStates.update { it + (instanceId to "pending") }
            }
            return@withLock
        }
        if (record.tombstone && record.localClearCompleted && record.pendingEventId == null &&
            record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty() &&
            phoneAccount == record.accountId && status.state == "signed_out" && status.linkId == record.linkId &&
            status.deviceId == record.deviceId && status.accountId == record.accountId && status.generation >= record.generation) {
            mutableLocalAccountLinkStates.update { it + (instanceId to "pending") }
            if (localAccountLoginInFlight.add(instanceId)) scope.launch {
                try { authorizeLocalAccountLink(instanceId, phoneAccount, status.ownerAccountId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { mutableLocalAccountLinkStates.update { it + (instanceId to "pending") } }
                finally { localAccountLoginInFlight.remove(instanceId) }
            }
            return@withLock
        }
        if (record.tombstone && record.localClearCompleted && record.pendingEventId == null &&
            record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty() &&
            status.state == "login_pending" && status.linkId == record.linkId && status.deviceId == record.deviceId &&
            status.accountId == record.accountId && status.generation >= record.generation &&
            (phoneAccount == null || phoneAccount == record.accountId)) {
            record = record.copy(generation = status.generation)
            localAccountLinks.write(record)
            mutableLocalAccountLinkStates.update { it + (instanceId to "pending") }
            if (localAccountLoginInFlight.add(instanceId)) scope.launch {
                try { completeLocalInstanceLogin(instanceId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { mutableLocalAccountLinkStates.update { it + (instanceId to "pending") } }
                finally { localAccountLoginInFlight.remove(instanceId) }
            }
            return@withLock
        }
        // The initial link may have been fenced before its response arrived.
        // An unchanged unlinked generation proves there is no peer link to revoke;
        // if the link did commit, retain the logout event and revoke that link.
        if (record.tombstone && record.pendingAction == "logout" &&
            ((status.state == "unlinked" && status.generation == record.generation) ||
                (status.state == "signed_out" && status.linkId == record.linkId && status.deviceId == record.deviceId &&
                    status.accountId == record.accountId && status.generation >= record.generation))) {
            record = record.copy(generation = status.generation, pendingEventId = null, pendingAction = null)
            localAccountLinks.write(record)
            mutableLocalAccountLinkStates.update { it + (instanceId to if (record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty()) "signed_out" else "pending") }
            return@withLock
        }
        if (record.tombstone && record.pendingAction == "logout" && status.state in setOf("active", "login_pending") &&
            status.linkId == record.linkId && status.deviceId == record.deviceId && status.accountId == record.accountId &&
            status.generation > record.generation) {
            record = record.copy(generation = status.generation)
            localAccountLinks.write(record)
        }
        val pendingId = record.pendingEventId
        val action = record.pendingAction
        if (pendingId != null && action in setOf("link", "logout")) {
            if (action == "link" && (record.tombstone || phoneAccount != record.accountId ||
                    status.ownerAuthority != "active" || status.ownerAccountId != record.accountId)) {
                mutableLocalAccountLinkStates.update { it + (instanceId to "conflict") }
                return@withLock
            }
            try {
                val response = withTargetRuntime(instanceId) { runtime ->
                    runtime.transport.execute(localAccountLinkEvent(record, requireNotNull(action), identityStore, pendingId, System.currentTimeMillis()))
                }
                val value = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject
                val generation = value["generation"]?.jsonPrimitive?.content?.toLongOrNull() ?: error("Invalid link generation")
                require(value["instanceId"]?.jsonPrimitive?.content == instanceId && value["linkId"]?.jsonPrimitive?.content == record.linkId &&
                    value["deviceId"]?.jsonPrimitive?.content == record.deviceId && value["accountId"]?.jsonPrimitive?.content == record.accountId &&
                    value["eventId"]?.jsonPrimitive?.content == pendingId && generation > record.generation &&
                    value["state"]?.jsonPrimitive?.content == (if (action == "logout") "signed_out" else "active"))
                record = record.copy(generation = generation, pendingEventId = null, pendingAction = null)
                localAccountLinks.write(record)
                mutableLocalAccountLinkStates.update { it + (instanceId to if (record.pendingCloudToken != null || localSessionRevocations.ids().isNotEmpty()) "pending" else if (record.tombstone) "signed_out" else "active") }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                val conflict = (error as? com.andysagent.ragent.core.network.ApiException)?.statusCode == 409
                mutableLocalAccountLinkStates.update { it + (instanceId to if (conflict) "conflict" else "pending") }
            }
            return@withLock
        }
        if (status.linkId != record.linkId || status.deviceId != record.deviceId || status.accountId != record.accountId ||
            status.generation < record.generation) {
            mutableLocalAccountLinkStates.update { it + (instanceId to "conflict") }
            return@withLock
        }
        if (status.state == "signed_out" && status.generation > record.generation) {
            // Persist the fence before clearing account credentials. No old peer
            // state may authorize this installation again after a restart.
            val oldToken = if (phoneAccount == record.accountId) accountCredentialStore.readToken() else null
            localAccountLinks.invalidate(instanceId)
            record = record.copy(generation = status.generation, tombstone = true, pendingEventId = null, pendingAction = null,
                localClearCompleted = false, pendingCloudToken = oldToken,
                pendingCloudEventId = oldToken?.let { java.util.UUID.randomUUID().toString() })
            localAccountLinks.write(record)
            if (phoneAccount == record.accountId) accountSessions.clearLocalSession()
            record = record.copy(localClearCompleted = true)
            localAccountLinks.write(record)
            mutableLocalAccountLinkStates.update { it + (instanceId to if (record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty()) "signed_out" else "pending") }
        } else if (record.tombstone) {
            mutableLocalAccountLinkStates.update { it + (instanceId to if (record.pendingCloudToken == null && localSessionRevocations.ids().isEmpty()) "signed_out" else "pending") }
        } else if (status.state == "active" && status.generation == record.generation && phoneAccount == record.accountId) {
            mutableLocalAccountLinkStates.update { it + (instanceId to "active") }
        } else {
            mutableLocalAccountLinkStates.update { it + (instanceId to "conflict") }
        }
        }
    }

    private suspend fun completeLocalInstanceLogin(instanceId: String) {
        val (record, epoch) = localAccountLinkMutex.withLock {
            val current = requireNotNull(localAccountLinks.read(instanceId))
            require(current.tombstone && current.pendingEventId == null && localSessionRevocations.ids().isEmpty())
            current to localAccountLinks.epoch(instanceId)
        }
        val eventId = java.util.UUID.randomUUID().toString()
        val pending = record.copy(tombstone = false, pendingAction = "link", pendingEventId = eventId)
        if (configStore.accountSession.first()?.accountId == null) {
            val inviteEventId = java.util.UUID.randomUUID().toString()
            val response = withTargetRuntime(instanceId) { runtime ->
                runtime.transport.execute(localAccountLinkEvent(record, "invite", identityStore, inviteEventId, System.currentTimeMillis()))
            }
            val obj = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject
            require(obj["instanceId"]?.jsonPrimitive?.content == instanceId && obj["linkId"]?.jsonPrimitive?.content == record.linkId &&
                obj["deviceId"]?.jsonPrimitive?.content == record.deviceId && obj["accountId"]?.jsonPrimitive?.content == record.accountId &&
                obj["generation"]?.jsonPrimitive?.content?.toLongOrNull() == record.generation && obj["state"]?.jsonPrimitive?.content == "login_pending")
            val invitationUri = obj.getValue("invitation").jsonObject.getValue("pairingUri").jsonPrimitive.content
            val invitation = parsePairingUri(invitationUri)
            require(invitation.version == 4 && invitation.instanceId == instanceId)
            val recoveryId = registerLocalHandoffRecovery(instanceId, invitationUri, record.accountId, record.generation, record.linkId)
            try { accountSessions.acceptDesktopAccount(invitation, accountDeviceAlias, expectedAccountId = record.accountId,
                persistGate = { account, _, token, persist ->
                    val remote = try { localAccountLinkStatus(instanceId) } catch (error: Exception) {
                        localSessionRevocations.replaceWithToken(recoveryId, token)
                        throw error
                    }
                    localAccountLinkMutex.withLock {
                        val current = localAccountLinks.read(instanceId)
                        val valid = account == record.accountId && localAccountLinks.epoch(instanceId) == epoch && current == record &&
                            remote.state == "login_pending" && remote.generation == record.generation && remote.linkId == record.linkId
                        if (!valid) {
                            localSessionRevocations.replaceWithToken(recoveryId, token)
                            error("Account authorization was superseded by sign-out")
                        }
                        localAccountLinks.write(pending)
                        try { persist().also { localSessionRevocations.remove(recoveryId) } } catch (error: Throwable) {
                            localSessionRevocations.replaceWithToken(recoveryId, token)
                            throw error
                        }
                    }
                }) } finally { localHandoffActive.remove(recoveryId) }
        }
        localAccountLinkMutex.withLock {
            val current = localAccountLinks.read(instanceId)
            require(localAccountLinks.epoch(instanceId) == epoch && (current == record || current == pending) &&
                configStore.accountSession.first()?.accountId == record.accountId)
            if (current == record) localAccountLinks.write(pending)
        }
        val response = withTargetRuntime(instanceId) { runtime ->
            runtime.transport.execute(localAccountLinkEvent(pending, "link", identityStore, eventId, System.currentTimeMillis()))
        }
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject
        val generation = obj["generation"]?.jsonPrimitive?.content?.toLongOrNull() ?: error("Invalid generation")
        require(obj["state"]?.jsonPrimitive?.content == "active" && obj["linkId"]?.jsonPrimitive?.content == record.linkId &&
            obj["deviceId"]?.jsonPrimitive?.content == record.deviceId && obj["accountId"]?.jsonPrimitive?.content == record.accountId &&
            obj["eventId"]?.jsonPrimitive?.content == eventId && generation > record.generation)
        localAccountLinkMutex.withLock {
            require(localAccountLinks.epoch(instanceId) == epoch && localAccountLinks.read(instanceId) == pending)
            localAccountLinks.write(pending.copy(generation = generation, pendingEventId = null, pendingAction = null))
            mutableLocalAccountLinkStates.update { it + (instanceId to "active") }
        }
    }

    private fun registerLocalHandoffRecovery(instanceId: String, uri: String, accountId: String, generation: Long, linkId: String?): String {
        val handle = kotlinx.serialization.json.buildJsonObject {
            put("instanceId", instanceId); put("uri", uri); put("accountId", accountId); put("generation", generation)
            linkId?.let { put("linkId", it) }
            put("epoch", localAccountLinks.epoch(instanceId)); put("publicKey", identityStore.publicKeyEncoded())
        }.toString()
        val id = java.util.UUID.randomUUID().toString()
        localHandoffActive.add(id)
        try { return localSessionRevocations.beginRecovery(handle, id) }
        catch (error: Throwable) { localHandoffActive.remove(id); throw error }
    }

    /** Only the old session's logout endpoint may use this encrypted outbox credential. */
    private suspend fun reconcileLocalCloudLogout(record: LocalAccountLinkRecord): LocalAccountLinkRecord {
        val token = record.pendingCloudToken ?: return record
        val requestId = record.pendingCloudEventId ?: return record
        localSessionRevocations.enqueue(token, requestId)
        val updated = record.copy(pendingCloudToken = null, pendingCloudEventId = null)
        localAccountLinks.write(updated)
        return updated
    }

    private suspend fun reconcileSessionRevocations() {
        localSessionRevocations.ids().forEach { requestId ->
            val handle = localSessionRevocations.recovery(requestId)
            if (handle != null) {
                if (localHandoffActive.add(requestId)) scope.launch {
                    try { recoverLocalHandoff(requestId, handle) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Remains pending until recovery is possible. */ }
                    finally { localHandoffActive.remove(requestId) }
                }
                return@forEach
            }
            val token = localSessionRevocations.token(requestId)
            if (token == null) {
                // An interrupted enqueue is not proof of server revocation.
                // Keep the task visible until its original token is recovered.
                return@forEach
            }
            if (revokeDetachedSession(token, requestId)) localSessionRevocations.remove(requestId)
        }
    }

    private suspend fun recoverLocalHandoff(requestId: String, handle: String) {
        val value = kotlinx.serialization.json.Json.parseToJsonElement(handle).jsonObject
        require(value.getValue("publicKey").jsonPrimitive.content == identityStore.publicKeyEncoded())
        val instanceId = value.getValue("instanceId").jsonPrimitive.content
        val invitation = parsePairingUri(value.getValue("uri").jsonPrimitive.content)
        val account = value.getValue("accountId").jsonPrimitive.content
        require(invitation.version == 4 && invitation.instanceId == instanceId)
        // Recovery can only queue a revocation, even if another account is active.
        accountSessions.acceptDesktopAccount(invitation, accountDeviceAlias, expectedAccountId = account,
            persistGate = { grantedAccount, credentialId, token, _ ->
                val active = configStore.accountSession.first()
                val originalEpoch = value.getValue("epoch").jsonPrimitive.content.toLong()
                val expectedGeneration = value.getValue("generation").jsonPrimitive.content.toLong()
                val remote = try { localAccountLinkStatus(instanceId) } catch (_: Exception) { null }
                if (active?.accountId == grantedAccount && active.credentialId == credentialId && remote == null &&
                    localAccountLinks.epoch(instanceId) == originalEpoch) error("Account link status is unavailable")
                if (active?.accountId == grantedAccount && active.credentialId == credentialId &&
                    localAccountLinks.epoch(instanceId) == originalEpoch && remote != null &&
                    remote.generation == expectedGeneration && remote.state != "signed_out") {
                    localSessionRevocations.remove(requestId)
                    if (value["linkId"] == null) scope.launch {
                        try { authorizeLocalAccountLink(instanceId, grantedAccount, grantedAccount) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { mutableLocalAccountLinkStates.update { it + (instanceId to "pending") } }
                    }
                    error("Recovered authorization is already active")
                }
                localSessionRevocations.replaceWithToken(requestId, token)
                error("Recovered authorization queued for revocation")
            }, recoveryOnly = true)
    }

    private suspend fun revokeDetachedSession(token: String, requestId: String): Boolean {
        val client = okhttp3.OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).build()
        val transport = OkHttpRagentTransport(
            endpointProvider = { application.getString(R.string.accounts_directory_base_url).trimEnd('/') },
            credentialProvider = { token }, client = client,
        )
        val confirmed = try {
            val body = kotlinx.serialization.json.buildJsonObject { put("requestId", requestId) }.toString()
            val result = transport.execute(ApiRequest("POST", "/v1/owner-auth/account/session/logout", body,
                requestId = requestId, idempotencyKey = requestId, isolateCredentialFailure = true))
            kotlinx.serialization.json.Json.parseToJsonElement(result.body).jsonObject["loggedOut"]?.jsonPrimitive?.content == "true"
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: com.andysagent.ragent.core.network.ApiException) { error.statusCode in setOf(400, 401, 403) }
        catch (_: Exception) { false }
        finally { transport.close() }
        return confirmed
    }

    suspend fun importLocalPairing(text: String) {
        val pairing = LocalPairing.parse(text)
        val transport = OkHttpRagentTransport({ pairing.endpoint }, { pairing.token }, localHttpClient())
        try {
            val response = transport.execute(ApiRequest("GET", "/api/local/identity", isolateCredentialFailure = true))
            val identity = kotlinx.serialization.json.Json.parseToJsonElement(response.body).jsonObject["instanceId"]?.jsonPrimitive?.content
            require(identity == pairing.instanceId) { "Local runtime identity does not match the pairing file" }
        } finally { transport.close() }
        initialized.await()
        configurationMutex.withLock {
            connectionUses.revoke(pairing.instanceId)
            targetRuntimes.remove(pairing.instanceId)?.dispose()
        }
        localCredentials.write(pairing.instanceId, pairing.token)
        configStore.upsertLocalComputer(LinkedComputer(pairing.instanceId, pairing.endpoint, application.getString(R.string.local_runtime_title), platform = "android", localRuntime = true))
        synchronizeDirectory()
    }
    /** Account-scoped rac_ credential; separate Keystore alias and preference namespace. */
    val accountCredentialStore = AndroidAccountCredentialStore(application)
    val p2pSecretStore = AndroidP2PSecretStore(application)
    val identityStore = AndroidDeviceIdentityStore(application)
    val accountDeviceAlias: String = identityStore.defaultDeviceAlias()
    private val targetRuntimes = java.util.concurrent.ConcurrentHashMap<String, TargetRuntime>()
    // Return only the target-owned transport, never the mutable foreground facade.
    internal fun existingTargetTransport(instanceId: String): com.andysagent.ragent.core.network.RagentTransport? =
        targetRuntimes[instanceId]?.takeIf { it.instanceId == instanceId }?.transport
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
    internal val appApiOwner = VerifiedCaller("ragent:internal-owner")
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
    internal val captureDrafts by lazy { com.andysagent.ragent.core.appapi.RoomCaptureDraftStore(appApiDatabase.value) }
    internal val captureResources by lazy { com.andysagent.ragent.core.appapi.PersistentCaptureResources(application, appApiDatabase.value) }
    internal val captureImports by lazy { com.andysagent.ragent.core.appapi.DraftResourceImports(captureDrafts, captureResources) }
    internal val resultOutputs by lazy { com.andysagent.ragent.core.appapi.PersistentResultOutputs(application, appApiDatabase.value, appApi) }
    internal val resultDeliveries by lazy { com.andysagent.ragent.core.appapi.ResultDeliveryCache(application, resultOutputs) }
    internal val documentSaves by lazy { com.andysagent.ragent.core.appapi.DocumentSaveJournal(application, resultOutputs, resultDeliveries) }
    internal val resultMaintenance by lazy { ResultMaintenanceCoordinator(resultOutputs, resultDeliveries, documentSaves) }
    internal val resultDeliveryAndroid by lazy { ResultDeliveryAndroid(application, resultDeliveries, appApiOwner) }
    internal val captureShortcuts by lazy { CaptureShortcutPublisher(application) }
    internal val appApi: TaskCoordinator by lazy {
        TaskCoordinator(
            store = RoomOperationStore(appApiDatabase.value),
            executionLease = com.andysagent.ragent.core.appapi.FileTaskExecutionLease(
                java.io.File(application.noBackupFilesDir, "ragent-task-execution")),
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
        com.andysagent.ragent.core.appapi.RoomBackgroundDeliveryStore(appApiDatabase.value, appApiOwner, ::appApiGrantContext)
    }
    internal val backgroundDelivery by lazy {
        com.andysagent.ragent.core.appapi.OwnerBackgroundDelivery(backgroundDeliveryConsents, appApi, appApiOwner)
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
    private val mutableTargetTurnQuotaFailures = MutableStateFlow<Map<String, AccountSessionException>>(emptyMap())
    /** Observe existing shared carriers without starting or retaining a connection. */
    val targetConnectionStates: StateFlow<Map<String, RuntimeConnectionState>> = mutableTargetConnectionStates.asStateFlow()
    /** Quota failures from automatic carrier recovery, surfaced to the foreground UI. */
    val targetTurnQuotaFailures: StateFlow<Map<String, AccountSessionException>> = mutableTargetTurnQuotaFailures.asStateFlow()
    /** Summary-only UI observation; carriers remain owned by the shared target lease pool. */
    val backgroundTargetSummaries: StateFlow<Map<String, TargetSummary>> = mutableBackgroundTargetSummaries.asStateFlow()
    private val targetSummaryCodec = ProtocolCodec()
    private val mutableOtherDeviceProjects = MutableStateFlow<List<OtherDeviceProject>>(emptyList())
    val otherDeviceProjects: StateFlow<List<OtherDeviceProject>> = mutableOtherDeviceProjects.asStateFlow()
    /** Emits the target whose local Harness catalog changed over its WS. */
    val harnessInvalidations = MutableSharedFlow<String>(extraBufferCapacity = 32)
    // The target lease pool owns carriers; the UI facade only changes which one it observes.
    val transport = SwitchingRagentTransport(scope, closeDelegates = false)
    private val accountsAnonymousTransport = OkHttpRagentTransport(
        endpointProvider = { application.getString(R.string.accounts_directory_base_url).trimEnd('/') },
        credentialProvider = { null },
    )
    val contentReports by lazy {
        com.andysagent.ragent.core.domain.HttpContentReportsRepository(
            com.andysagent.ragent.core.network.contentReportTransport(application.getString(R.string.accounts_directory_base_url)),
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
    private data class ControlWorkbench(val instanceId: String, val transport: com.andysagent.ragent.core.auth.TemporaryControlTransport,
        val sessions: RoomSessionRepository, val database: RagentDatabase) {
        val lifetime = SessionStorageLifetime(sessions, transport::close, database::close)
    }
    @Volatile private var controlWorkbench: ControlWorkbench? = null
    private val mutableTemporaryControlActive = MutableStateFlow(false)
    val temporaryControlActive: StateFlow<Boolean> = mutableTemporaryControlActive.asStateFlow()
    fun temporaryControlInstanceId(): String? = controlWorkbench?.instanceId

    suspend fun connectTemporaryControl(raw: String) {
        if (configStore.accountSession.first() != null) throw com.andysagent.ragent.core.network.ApiException(409,
            "temporary_control_use_account_pairing", "This phone is signed in. Scan the computer's ordinary account pairing code.", retryable = false)
        configurationMutex.withLock {
            controlWorkbench?.let {
                controlWorkbench = null; mutableTemporaryControlActive.value = false
                it.sessions.stopLiveSync(); transport.switchTo(null); sessions.switchTo(null)
                it.lifetime.close()
            }
        }
        val connection = temporaryControl.connect(raw)
        val database = Room.inMemoryDatabaseBuilder(application, RagentDatabase::class.java).build()
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
    private val accountsDirectoryTransport = OkHttpRagentTransport(
        endpointProvider = { application.getString(R.string.accounts_directory_base_url).trimEnd('/') },
        credentialProvider = { accountCredentialStore.readToken() },
    )
    val accountSessions = AccountSessionManager(
        anonymousTransport = accountsAnonymousTransport,
        authenticatedTransport = accountsDirectoryTransport,
        identity = identityStore,
        credentialStore = accountCredentialStore,
        metadataStore = ClientConfigAccountSessionStore(configStore),
        pairingJournal = com.andysagent.ragent.core.auth.AndroidAccountPairingJournal(application),
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
                    android.util.Log.w("Ragent", "Account cleanup failed: " + error.javaClass.simpleName)
                }
            }
        },
        changeAccountDirectory = { change, update ->
            initialized.await()
            val previousAccount = configStore.accountSession.first()?.accountId
            val localTargets = localAccountLinks.instanceIds() + configStore.directory.first().computers.filter { it.localRuntime }.map { it.instanceId }
            if (change.nextAccountId != null) {
                require(localTargets.none { instanceId ->
                    localAccountLinks.read(instanceId)?.let { !it.tombstone && it.accountId != change.nextAccountId } == true
                }) { "A linked local instance uses another account; sign out or resolve the link first" }
            } else if (previousAccount != null) {
                // Expiry, revocation and non-UI sign-outs share the same durable
                // fence; do not let an alternate clearing path bypass it.
                val oldToken = accountCredentialStore.readToken()
                localTargets.forEach(localAccountLinks::invalidate)
                localTargets.forEach { instanceId ->
                    localAccountLinks.read(instanceId)?.takeIf { it.accountId == previousAccount }?.let { prior ->
                        prior.pendingCloudToken?.let { token ->
                            localSessionRevocations.enqueue(token, requireNotNull(prior.pendingCloudEventId))
                        }
                        localAccountLinks.fenceLogout(instanceId, oldToken)
                    }
                }
            }
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
        com.andysagent.ragent.core.auth.AccountTargetCredentialProfiles(credentialStore, p2pSecretStore)
    }
    private val accountProfileTransitions by lazy {
        com.andysagent.ragent.core.auth.AccountProfileTransitions(
            object : com.andysagent.ragent.core.auth.AccountProfileTransitionStore {
                override suspend fun read() = configStore.accountProfileTransition.first()
                override suspend fun write(value: com.andysagent.ragent.core.datastore.AccountProfileTransition) = configStore.saveAccountProfileTransition(value)
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
        com.andysagent.ragent.core.auth.ColdTurnLeaseRecovery(accountSessions,
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
        writeGuard: com.andysagent.ragent.core.auth.PairingWriteGuard,
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
        autoConnect: Boolean, selectTarget: Boolean, writeGuard: com.andysagent.ragent.core.auth.PairingWriteGuard,
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

    private suspend fun applyPairingResult(result: PairingResult, writeGuard: com.andysagent.ragent.core.auth.PairingWriteGuard) {
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
        fencePushRegistration()
        PushRegistrationSchedule.request(application)
        val localIds = localAccountLinks.instanceIds() + configStore.directory.first().computers.filter { it.localRuntime }.map { it.instanceId }
        localIds.forEach(localAccountLinks::invalidate)
        return localAccountLinkMutex.withLock {
        val account = configStore.accountSession.first()?.accountId
        val fenced = localAccountLinks.instanceIds().mapNotNull { instanceId ->
            localAccountLinks.read(instanceId)?.takeIf { it.accountId == account }
                ?.let { prior ->
                    prior.pendingCloudToken?.let { token -> localSessionRevocations.enqueue(token, requireNotNull(prior.pendingCloudEventId)) }
                    localAccountLinks.fenceLogout(instanceId, accountCredentialStore.readToken())
                }
        }
        if (fenced.isNotEmpty()) mutableLocalAccountLinkStates.update { states ->
            states + fenced.associate { it.instanceId to "pending" }
        }
        appApiCallerGrants.revokeAll(appApiOwner)
        assistantDelegations.revokeAll(appApiOwner)
        backgroundDeliveryConsents.revokeAll(appApiOwner)
        try {
            if (fenced.isEmpty()) accountSessions.logoutAccountSession()
            else {
                // Revoke remotely from the isolated outbox after the active
                // account is gone; an unavailable network never delays logout.
                withContext(NonCancellable) { accountSessions.clearLocalSession() }
                false
            }
        }
        finally { withContext(NonCancellable) {
            if (configStore.accountSession.first()?.accountId != account) fenced.forEach { prior ->
                localAccountLinks.read(prior.instanceId)?.takeIf { it.tombstone && !it.localClearCompleted }
                    ?.let { localAccountLinks.write(it.copy(localClearCompleted = true)) }
            }
            backgroundDeliveryConsents.revokeAll(appApiOwner)
            if (fenced.isNotEmpty()) scope.launch {
                fenced.forEach { prior ->
                    try { reconcileLocalAccountLink(prior.instanceId) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Durable outbox remains pending. */ }
                }
            }
        } }
        }
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

    /** Publish the current phone token and paired computers to Accounts. */
    suspend fun registerFcmToken(token: String, targetInstanceId: String? = null) {
        require(token.isNotBlank() && token.length <= 4096) { "Invalid notification token" }
        pendingFcmToken = token.trim().takeIf { it.isNotEmpty() }
        val normalizedToken = pendingFcmToken ?: return
        initialized.await()
        fcmRegistrationMutex.withLock {
            if (pendingFcmToken != normalizedToken) return@withLock
            val session = configStore.accountSession.first() ?: return@withLock
            val accountId = session.accountId
            if (pushRegistrationStore.read().optString("blockedCredentialId") == session.credentialId) return@withLock
            if (pushRegistrationStore.read().optBoolean("refreshRequired")) return@withLock
            accountSessions.ensureActiveCredential()
            val allowedResponse = accountsDirectoryTransport.execute(ApiRequest("POST", "/v1/push/instances", "{}"))
            val allowedBody = org.json.JSONObject(allowedResponse.body)
            check(allowedBody.optBoolean("ok")) { "Notification computer list was not confirmed" }
            val allowedArray = allowedBody.getJSONArray("instanceIds")
            val allowed = (0 until allowedArray.length()).map { allowedArray.getString(it) }.toSet()
            check(configStore.accountSession.first()?.credentialId == session.credentialId) { "Account changed during notification registration" }
            val instanceIds = configStore.directory.first().computers.filterNot { it.localRuntime }.map { it.instanceId }
                .filter { it in allowed }.sorted()
            val version = application.packageManager.getPackageInfo(application.packageName, 0).versionName ?: ""
            val enabled = androidx.core.app.NotificationManagerCompat.from(application).areNotificationsEnabled()
            val state = pushRegistrationStore.read()
            val previous = state.optJSONObject("current")
            val same = previous != null && previous.optString("accountId") == accountId &&
                previous.optString("token") == normalizedToken && previous.optString("appVersion") == version &&
                previous.optBoolean("notificationsEnabled") == enabled &&
                previous.optJSONArray("instanceIds")?.toString() == org.json.JSONArray(instanceIds).toString()
            val registration = if (same) previous!! else pushRegistrationStore.newRegistration(normalizedToken, instanceIds, version, enabled, accountId)
            if (!same) {
                val revoke = state.optJSONArray("revoke") ?: org.json.JSONArray()
                if (previous != null) revoke.put(org.json.JSONObject().put("registrationId", previous.getString("registrationId"))
                    .put("revokeCapability", previous.getString("revokeCapability")))
                state.put("revoke", revoke).put("current", registration).put("confirmed", false)
                pushRegistrationStore.write(state)
            }
            val body = org.json.JSONObject(registration.toString()).apply { remove("accountId") }.toString()
            val response = try {
                accountsDirectoryTransport.execute(ApiRequest("POST", "/v1/push/devices/register", body))
            } catch (error: com.andysagent.ragent.core.network.ApiException) {
                if (error.statusCode == 409 && error.code == "push_registration_conflict") {
                    val revoke = state.optJSONArray("revoke") ?: org.json.JSONArray()
                    revoke.put(org.json.JSONObject().put("registrationId", registration.getString("registrationId"))
                        .put("revokeCapability", registration.getString("revokeCapability")))
                    state.remove("current")
                    state.put("revoke", revoke).put("confirmed", false).put("refreshRequired", true)
                    pushRegistrationStore.write(state)
                    pendingFcmToken = null
                    PushRegistrationSchedule.request(application)
                }
                throw error
            }
            val receipt = org.json.JSONObject(response.body)
            check(receipt.optBoolean("ok") && receipt.optString("registrationId") == registration.getString("registrationId")) {
                "Notification registration was not confirmed"
            }
            state.put("confirmed", true).put("confirmedAt", System.currentTimeMillis())
            pushRegistrationStore.write(state)
            reconcilePushRevocationsLocked()
        }
    }

    private suspend fun reconcilePushRevocationsLocked() {
        val state = pushRegistrationStore.read()
        val pending = state.optJSONArray("revoke") ?: return
        val remaining = org.json.JSONArray()
        for (index in 0 until pending.length()) {
            val item = pending.getJSONObject(index)
            try { accountsAnonymousTransport.execute(ApiRequest("POST", "/v1/push/devices/revoke", item.toString())) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { remaining.put(item) }
        }
        state.put("revoke", remaining)
        pushRegistrationStore.write(state)
    }

    internal suspend fun retryPushRevocations() = fcmRegistrationMutex.withLock { reconcilePushRevocationsLocked() }

    internal suspend fun refreshPushTokenIfRequired() = fcmRegistrationMutex.withLock {
        val state = pushRegistrationStore.read()
        if (state.optBoolean("refreshRequired")) {
            com.google.android.gms.tasks.Tasks.await(FirebaseMessaging.getInstance().deleteToken(), 30, java.util.concurrent.TimeUnit.SECONDS)
            currentCoroutineContext().ensureActive()
            state.put("refreshRequired", false)
            pushRegistrationStore.write(state)
        }
    }

    internal suspend fun retryPushReceipts() = fcmRegistrationMutex.withLock {
        val currentAccount = configStore.accountSession.first()?.accountId
        val items = pushRegistrationStore.pendingReceipts()
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            if (currentAccount == null || item.optString("accountId") != currentAccount) {
                pushRegistrationStore.removeReceipt(item.getString("id"))
                continue
            }
            accountSessions.ensureActiveCredential()
            val body = org.json.JSONObject(item.toString()).apply { remove("id"); remove("accountId") }
            try {
                accountsDirectoryTransport.execute(ApiRequest("POST", "/v1/push/receipts", body.toString()))
                pushRegistrationStore.removeReceipt(item.getString("id"))
            } catch (error: com.andysagent.ragent.core.network.ApiException) {
                if (error.statusCode == 400 || error.statusCode == 404) pushRegistrationStore.removeReceipt(item.getString("id"))
                else throw error
            }
        }
    }

    internal suspend fun retryPendingPushMessages() {
        initialized.await()
        val items = pushRegistrationStore.pendingMessages()
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            val json = item.getJSONObject("data")
            val data = json.keys().asSequence().associateWith { json.getString(it) }
            val occurredAt = data["occurredAt"]?.toLongOrNull() ?: 0L
            val expiresAt = data["expiresAt"]?.toLongOrNull() ?: 0L
            if (occurredAt > 0 && expiresAt > occurredAt)
                publishAuthorizedPush(data, item.getString("title"), item.getString("body"), occurredAt)
            pushRegistrationStore.removeMessage(item.getString("id"))
        }
    }

    private suspend fun fencePushRegistration() = fcmRegistrationMutex.withLock {
        val state = pushRegistrationStore.read()
        configStore.accountSession.first()?.credentialId?.let { state.put("blockedCredentialId", it) }
        state.put("confirmed", false)
        runCatching { cancelSourcePushNotifications(null) }
        val current = state.optJSONObject("current")
        if (current == null) { pushRegistrationStore.write(state); return@withLock }
        val pending = state.optJSONArray("revoke") ?: org.json.JSONArray()
        pending.put(org.json.JSONObject().put("registrationId", current.getString("registrationId"))
            .put("revokeCapability", current.getString("revokeCapability")))
        state.remove("current")
        state.put("revoke", pending)
        pushRegistrationStore.write(state)
    }

    private fun cancelSourcePushNotifications(instanceId: String?) {
        val manager = application.getSystemService(android.app.NotificationManager::class.java)
        manager.activeNotifications.filter { item ->
            item.notification.channelId in setOf(RagentFirebaseMessagingService.RUN_CHANNEL_ID, RagentFirebaseMessagingService.ATTENTION_CHANNEL_ID) &&
                (instanceId == null || item.notification.extras.getString(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_INSTANCE_ID) == instanceId)
        }.forEach { androidx.core.app.NotificationManagerCompat.from(application).cancel(it.tag, it.id) }
    }

    internal suspend fun mayDisplayPush(instanceId: String?, accountId: String?): Boolean {
        initialized.await()
        val session = configStore.accountSession.first() ?: return false
        if (instanceId.isNullOrBlank() || accountId.isNullOrBlank() || session.accountId != accountId ||
            pushRegistrationStore.read().optString("blockedCredentialId") == session.credentialId) return false
        return configStore.directory.first().computers.any { it.instanceId == instanceId }
    }

    internal fun pushDiagnostics(): Triple<Boolean, List<String>, Long> {
        val state = pushRegistrationStore.read()
        val instances = state.optJSONObject("current")?.optJSONArray("instanceIds") ?: org.json.JSONArray()
        return Triple(state.optBoolean("confirmed", false), (0 until instances.length()).map { instances.getString(it) },
            state.optLong("confirmedAt", 0L))
    }

    internal suspend fun publishAuthorizedPush(data: Map<String, String>, title: String, body: String, occurredAt: Long): Boolean =
        fcmRegistrationMutex.withLock {
            val account = configStore.accountSession.first()?.accountId
            val instance = data["instanceId"].orEmpty()
            val event = data["eventId"].orEmpty()
            val kind = data["kind"].orEmpty()
            val canRecord = !account.isNullOrBlank() && account == data["accountId"] && instance.isNotBlank() && event.isNotBlank() && kind.isNotBlank()
            if (canRecord && runCatching { pushRegistrationStore.wasProcessed(account!!, instance, kind, event) }.getOrDefault(false)) return@withLock false
            if (canRecord) runCatching { pushRegistrationStore.enqueueReceipt(account!!, instance, event, kind, "received") }
            val posted = (data["expiresAt"]?.toLongOrNull() ?: 0L) > System.currentTimeMillis() &&
                mayDisplayPush(instance, data["accountId"]) &&
                RagentFirebaseMessagingService.Publisher(application).publish(data, title, body, occurredAt)
            if (canRecord) {
                runCatching { pushRegistrationStore.markProcessed(account!!, instance, kind, event, data["expiresAt"]?.toLongOrNull() ?: 0L) }
                runCatching { pushRegistrationStore.enqueueReceipt(account!!, instance, event, kind, if (posted) "posted" else "suppressed") }
                runCatching { PushRegistrationSchedule.request(application) }
            }
            posted
        }

    fun start() {
        if (!startGuard.compareAndSet(false, true)) return
        ProcessLifecycleOwner.get().lifecycle.addObserver(this)
        scope.launch {
            initialized.await()
            while (isActive && !stopped) {
                try { reconcileSessionRevocations() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* The encrypted queue is retried later. */ }
                try { fcmRegistrationMutex.withLock { reconcilePushRevocationsLocked() } }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { android.util.Log.w("RagentRuntime", "Notification revocation deferred") }
                // The queue can contain detached credentials with no reliable instance identity.
                mutableLocalSessionRevocationsPending.value = try { localSessionRevocations.ids().isNotEmpty() }
                catch (_: Exception) { false }
                val instanceIds = localAccountLinks.instanceIds() + configStore.directory.first().computers.filter { it.localRuntime }.map { it.instanceId }
                instanceIds.forEach { instanceId ->
                    try { reconcileLocalAccountLink(instanceId) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) {
                        // A failed status query does not prove that an operation is pending.
                        // Preserve durable outbox evidence and previously detected conflicts.
                        val pending = try {
                            val record = localAccountLinks.read(instanceId)
                            record != null && (record.pendingEventId != null || record.pendingCloudToken != null ||
                                record.unbindPending || !record.localClearCompleted)
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { false }
                        mutableLocalAccountLinkStates.update { states ->
                            states + (instanceId to when {
                                pending -> "pending"
                                states[instanceId] == "conflict" -> "conflict"
                                else -> "unavailable"
                            })
                        }
                    }
                }
                delay(15_000)
            }
        }
        scope.launch {
            try {
                configurationMutex.withLock { recoverAccountProfileTransitionLocked() }
                configStore.migrateLegacy()
                configStore.directory.collect { directory ->
                    synchronizeDirectory()
                    synchronizeCaptureShortcuts(directory)
                    registerFcmTokenWhenConnected("")
                }
            } catch (cancelled: CancellationException) {
                if (!initialized.isCompleted) initialized.completeExceptionally(cancelled)
                throw cancelled
            } catch (failure: Exception) {
                if (!initialized.isCompleted) initialized.completeExceptionally(failure)
                android.util.Log.e("RagentRuntime", "Computer directory initialization failed")
            }
        }
    }

    private suspend fun synchronizeCaptureShortcuts(directory: ComputerDirectory) {
        // Isolated runtime tests must not publish their synthetic PCs globally.
        if (targetFactoryOverride != null || configOverride != null) return
        try { if (!captureShortcuts.synchronize(directory)) android.util.Log.w("RagentRuntime", "Shortcut publication deferred by system") }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { android.util.Log.w("RagentRuntime", "Shortcut publication unavailable") }
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
            if (!runtime.localRuntime) {
                credentialStore.clear(id)
                p2pSecretStore.clear(id)
            }
        }
        controlWorkbench?.let { control ->
            if (foreground && foregroundSyncReady) {
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
        val uiTargets = when {
            foreground -> (listOfNotNull(recoveryPlan.primaryInstanceId) + recoveryPlan.backgroundInstanceIds).toSet()
            retainUiConnections -> setOfNotNull(recoveryPlan.primaryInstanceId)
            else -> emptySet()
        }
        connectionUses.setOwnerTargets("foreground-ui", uiTargets)
        (uiBackgroundTargetIds - previousBackgroundIds).forEach { id ->
            targetRuntimes[id]?.takeIf { it.transport.connectionState.value == RuntimeConnectionState.Connected }?.let {
                scope.launch { refreshBackgroundSummary(it) }
            }
        }
        if (foreground && foregroundSyncReady) {
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
            if (foreground && foregroundSyncReady) target?.let { targetRuntimes[it]?.sessions?.startLiveSync() }
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
                    scope.launch {
                        runCatching { registerFcmToken(pendingFcmToken ?: token, instanceId) }
                            .onFailure { PushRegistrationSchedule.request(application) }
                    }
                }
                task.addOnFailureListener { PushRegistrationSchedule.request(application) }
            }
        pendingFcmToken?.let { token ->
            scope.launch { runCatching { registerFcmToken(token, instanceId) }.onFailure { PushRegistrationSchedule.request(application) } }
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        foreground = true
        retainUiConnections = true
        val generation = lifecycleGeneration.incrementAndGet()
        val previousBackgroundSync = backgroundSyncJob
        previousBackgroundSync?.cancel()
        foregroundProbeJob?.cancel()
        foregroundStartJob?.cancel()
        foregroundSyncReady = false
        foregroundStartJob = scope.launch {
            previousBackgroundSync?.join()
            initialized.await()
            if (!foreground || lifecycleGeneration.get() != generation) return@launch
            targetRuntimes.values.toList().forEach { it.sessions.stopLiveSyncAndJoin() }
            if (!foreground || lifecycleGeneration.get() != generation) return@launch
            foregroundSyncReady = true
            synchronizeDirectory()
            configurationMutex.withLock {
                if (foreground && lifecycleGeneration.get() == generation) {
                    connectionUses.setOwnerTargets("background-runs", emptySet())
                }
            }
            if (foreground && lifecycleGeneration.get() == generation) {
                val controller = activeTargetRuntime()?.controller
                retryUnhealthyForegroundConnection(controller)
                foregroundProbeJob = scope.launch {
                    controller?.verifyForegroundCarrier { foreground && lifecycleGeneration.get() == generation }
                }
            }
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
    internal suspend fun navigateToSession(request: SessionNavigationRequest, expectedAccountId: String? = null, open: suspend (String) -> Unit) {
        request.validated()
        val target = request.targetInstanceId
            ?: throw AppApiException(ApiError(ApiErrorCode.AMBIGUOUS_TARGET, "Choose the source computer"))
        initialized.await()
        if (expectedAccountId != null && !mayDisplayPush(target, expectedAccountId)) {
            throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Notification account or computer changed"))
        }
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
                    if (failure !is com.andysagent.ragent.core.domain.SessionRepositoryException) throw failure
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
                    com.andysagent.ragent.core.model.SessionStatus.Completed,
                    com.andysagent.ragent.core.model.SessionStatus.Failed,
                    com.andysagent.ragent.core.model.SessionStatus.Cancelled,
                ) || (verifiedSession.status == com.andysagent.ragent.core.model.SessionStatus.Idle &&
                    verifiedSession.waitingAction.isNullOrBlank() &&
                    verifiedSession.workflowState?.trim()?.lowercase() !in setOf(
                        "waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input", "waiting_approval",
                    ))
                if (terminalOrInactive) {
                    RagentFirebaseMessagingService.Publisher(application)
                        .cancelAttentionNotifications(application, target, request.sessionId)
                }
                if (request.kind.lowercase() in setOf("approval", "question", "plan", "danger", "answer", "permission")) {
                    // Event IDs are delivery identities; the approval lookup uses the original awaiting key.
                    val approvalId = request.awaitingKey
                    if (approvalId.isNotBlank()) {
                        val approval = runtime.sessions.findPendingApproval(request.sessionId, approvalId)
                        if (approval?.status != "pending") {
                            RagentFirebaseMessagingService.Publisher(application).cancelAttentionNotifications(
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
                if (expectedAccountId != null && !mayDisplayPush(target, expectedAccountId)) {
                    throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Notification account or computer changed"))
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
                    if (expectedAccountId != null && !mayDisplayPush(target, expectedAccountId)) {
                        throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Notification account or computer changed"))
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
        val local = configStore.directory.first().computers.any { it.instanceId == instanceId && it.localRuntime }
        targetPairingCommits.remove(instanceId) {
            appApiCallerGrants.revokeForTarget(appApiOwner, instanceId)
            assistantDelegations.revokeForTarget(appApiOwner, instanceId)
            backgroundDeliveryConsents.revokeAll(appApiOwner, instanceId)
            try { fcmRegistrationMutex.withLock {
                configStore.removeTarget(instanceId)
                runCatching { cancelSourcePushNotifications(instanceId) }
            } }
            finally { withContext(kotlinx.coroutines.NonCancellable) {
                appApiCallerGrants.revokeForTarget(appApiOwner, instanceId)
                assistantDelegations.revokeForTarget(appApiOwner, instanceId)
                backgroundDeliveryConsents.revokeAll(appApiOwner, instanceId)
            } }
            // Existing carriers release their lease with the still-current
            // bearer; synchronizeDirectory clears it after teardown. A join
            // that has not created a runtime still needs immediate cleanup.
            if (!local && targetRuntimes[instanceId] == null) {
                credentialStore.clear(instanceId)
                p2pSecretStore.clear(instanceId)
            }
            if (local) localCredentials.clear(instanceId)
        }
        if (local) configurationMutex.withLock {
            connectionUses.revoke(instanceId)
            targetRuntimes.remove(instanceId)?.dispose()
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

    suspend fun listProviderInstances(): List<com.andysagent.ragent.feature.workbench.ProviderInstance> {
        initialized.await()
        controlWorkbench?.let { return listOf(com.andysagent.ragent.feature.workbench.ProviderInstance(it.instanceId, it.instanceId)) }
        if (configStore.accountSession.first() != null) {
            return listAccountDirectoryDevices().filter {
                it.deviceKind.equals("computer", ignoreCase = true) && it.unboundAt.isNullOrBlank()
            }.map { com.andysagent.ragent.feature.workbench.ProviderInstance(it.instanceId, it.alias.ifBlank { it.instanceId }) }
        }
        return configStore.directory.first().computers.map {
            com.andysagent.ragent.feature.workbench.ProviderInstance(it.instanceId, it.label.ifBlank { it.instanceId })
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
        val outcome = withTimeoutOrNull(connectionWaitTimeoutMs) {
            combine(targetConnectionStates, targetTurnQuotaFailures) { states, failures ->
                (states[instanceId] == RuntimeConnectionState.Connected) to failures[instanceId]
            }.first { (connected, quotaFailure) -> connected || quotaFailure != null }
        }
        when {
            outcome?.first == true -> Unit
            outcome?.second != null -> throw requireNotNull(outcome.second)
            else -> throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Computer connection timed out", retryable = true))
        }
    }

    internal fun clearTargetTurnQuotaFailure(instanceId: String) {
        mutableTargetTurnQuotaFailures.update { failures -> failures - instanceId }
    }

    private fun encodePathSegment(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    override fun onStop(owner: LifecycleOwner) {
        foreground = false
        foregroundSyncReady = false
        val generation = lifecycleGeneration.incrementAndGet()
        foregroundProbeJob?.cancel()
        foregroundStartJob?.cancel()
        val previousBackgroundSync = backgroundSyncJob
        previousBackgroundSync?.cancel()
        accountCapacityRetry.cancel()
        accountRestoreJob?.cancel()
        uiBackgroundTargetIds = emptySet()
        mutableBackgroundTargetSummaries.value = emptyMap()
        targetRuntimes.values.forEach { it.sessions.stopLiveSync() }
        backgroundSyncJob = scope.launch {
            try {
                withTimeoutOrNull(backgroundSyncLimitMs) {
                    previousBackgroundSync?.join()
                    initialized.await()
                    if (foreground || lifecycleGeneration.get() != generation) return@withTimeoutOrNull
                    targetRuntimes.values.toList().forEach { it.sessions.stopLiveSyncAndJoin() }
                    val active = configurationMutex.withLock {
                        if (foreground || lifecycleGeneration.get() != generation) return@withLock emptyMap()
                        val snapshots = targetRuntimes.values.toList().associateWith { runtime ->
                            try { runtime.sessions.activeBackgroundSessionIds() }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (_: Exception) { emptySet() }
                        }.filterValues { it.isNotEmpty() }
                        connectionUses.setOwnerTargets("background-runs", snapshots.keys.mapTo(mutableSetOf()) { it.instanceId })
                        connectionUses.setOwnerTargets("foreground-ui", setOfNotNull(activeInstanceId))
                        snapshots
                    }
                    val remainingTargets = active.keys.mapTo(mutableSetOf()) { it.instanceId }
                    coroutineScope {
                        active.forEach { (runtime, ids) -> launch {
                            try {
                                coroutineScope { ids.forEach { id -> launch {
                                    try { runtime.sessions.reconcileBackgroundSession(id) }
                                    catch (cancelled: CancellationException) { throw cancelled }
                                    catch (_: Exception) { /* Other sessions continue independently. */ }
                                } } }
                            } finally {
                                withContext(NonCancellable) {
                                    configurationMutex.withLock {
                                        if (!foreground && lifecycleGeneration.get() == generation) {
                                            remainingTargets.remove(runtime.instanceId)
                                            connectionUses.setOwnerTargets("background-runs", remainingTargets.toSet())
                                        }
                                    }
                                }
                            }
                        } }
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Keep lifecycle cleanup independent of a failed target. */ }
            finally {
                withContext(NonCancellable) {
                    configurationMutex.withLock {
                        if (!foreground && lifecycleGeneration.get() == generation) {
                            connectionUses.setOwnerTargets("background-runs", emptySet())
                            connectionUses.setOwnerTargets("foreground-ui", setOfNotNull(activeInstanceId))
                        }
                    }
                }
            }
        }
    }

    internal suspend fun awaitLifecycleUpdate() { initialized.await(); synchronizeDirectory() }

    /** Read-only diagnostics, explicitly bound to a target; no mutable supervisor is exposed. */
    internal suspend fun targetConnectivity(instanceId: String): StateFlow<com.andysagent.ragent.core.network.ConnectionState> {
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
                mutableTargetTurnQuotaFailures.update { failures -> failures - target.instanceId }
                notificationRegistrar?.invoke() ?: registerFcmTokenWhenConnected(runtime.instanceId)
            }
            if (state == RuntimeConnectionState.Connected) refreshBackgroundSummary(runtime)
            else mutableBackgroundTargetSummaries.update { it - runtime.instanceId }
            if (state == RuntimeConnectionState.Connected && foreground && activeInstanceId == runtime.instanceId) {
                retryAccountCapacity(runtime.instanceId)
                if (foregroundSyncReady) runtime.sessions.startLiveSync()
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
            val guard = com.andysagent.ragent.core.auth.PairingWriteGuard { instanceId, writes ->
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
            com.andysagent.ragent.core.auth.DeviceCredentialRenewalCoordinator(
                com.andysagent.ragent.core.auth.DeviceCredentialRenewal(identityStore, credentialStore, p2pSecretStore), pairing,
            ).renew(runtime.instanceId, runtime.baseEndpoint, accountDeviceAlias, guard)
        }

    private suspend fun renewTargetCarrierCredential(runtime: TargetRuntime, attemptedCredential: String?, deviceId: String,
        stillCurrent: () -> Boolean) = targetPairingCommits.withTarget(runtime.instanceId) { removalGuard ->
        val guard = com.andysagent.ragent.core.auth.PairingWriteGuard { instanceId, writes ->
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
        com.andysagent.ragent.core.auth.DeviceCredentialRenewal(identityStore, credentialStore, p2pSecretStore)
            .renewViaCarrier(runtime.instanceId, deviceId, runtime.transport, guard)
    }

    private fun createTargetRuntime(target: LinkedComputer, childScope: CoroutineScope): TargetRuntime {
        if (target.localRuntime) {
            val endpoint = target.endpoint.trimEnd('/')
            lateinit var controller: LocalTargetConnection
            val verified = java.util.concurrent.atomic.AtomicBoolean(false)
            val targetTransport = OkHttpRagentTransport({ endpoint }, { localCredentials.read(target.instanceId) }, localHttpClient(),
                allowRelativeStreaming = true, onDirectSocketReconnect = { controller.refresh() },
                onDirectSocketUnavailable = { verified.set(false) },
                requestAdmission = { it.path == "/api/local/identity" || verified.get() })
            val database = RagentDatabase.create(application, targetDatabaseName(target))
            val repository = RoomSessionRepository(database, targetTransport, contentResolver = application.contentResolver,
                targetId = target.instanceId)
            controller = LocalTargetConnection(target.instanceId, targetTransport, childScope, verified)
            return TargetRuntime(target.instanceId, endpoint, endpoint, targetTransport, repository, controller,
                childScope, disposeStorage = { database.close() }, localRuntime = true)
        }
        lateinit var runtime: TargetRuntime
        lateinit var controller: BoundTargetConnection
        val database = RagentDatabase.create(application, targetDatabaseName(target))
        val targetTransport = OkHttpRagentTransport(
            endpointProvider = { runtime.endpoint },
            credentialProvider = { credentialStore.readToken(target.instanceId) },
            requireVerifiedCarrier = true,
            credentialRejectionHandler = com.andysagent.ragent.core.network.CredentialRejectionHandler { credential, current, invalidate ->
                controller.rejectCredential(credential, current, invalidate)
            },
            onCarrierUnavailable = { failed -> controller.carrierRequestFailed(failed) },
        )
        val attachmentRelay = AccountAttachmentRelay(application.getString(R.string.accounts_directory_base_url),
            accountsDirectoryTransport, ensureAccount = { accountSessions.ensureActiveCredential(); Unit })
        val repository = RoomSessionRepository(database, targetTransport, contentResolver = application.contentResolver,
            targetId = target.instanceId, attachmentRelay = attachmentRelay)
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
            credentialRejectionHandler = com.andysagent.ragent.core.network.CredentialRejectionHandler { credential, current, invalidate ->
                rejectTargetCredential(runtime, credential, current, invalidate)
            },
            credentialRenewalRequired = {
                com.andysagent.ragent.core.auth.DeviceCredentialRenewal.isDue(credentialStore.read(target.instanceId))
                    || p2pSecretStore.read(target.instanceId) == null
            },
            renewCredential = { credential, current -> renewTargetCredential(runtime, credential, current) },
            renewCarrierCredential = { credential, deviceId, current ->
                renewTargetCarrierCredential(runtime, credential, deviceId, current)
            },
            onEndpointResolved = { runtime.endpoint = it },
            onTurnQuotaExceeded = { error ->
                mutableTargetTurnQuotaFailures.update { failures -> failures + (target.instanceId to error) }
            },
        )
        runtime = TargetRuntime(target.instanceId, target.endpoint.trimEnd('/'), "", targetTransport, repository, controller,
            childScope, relay = attachmentRelay,
            disposeStorage = { database.close() })
        return runtime
    }

    private fun targetDatabaseName(target: LinkedComputer): String {
        // Preserve the pre-existing database for the first directory entry;
        // every additional computer gets a deterministic independent file.
        if (target.instanceId == primaryDatabaseInstanceId) return "ragent.db"
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(target.instanceId.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "ragent-target-$digest.db"
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
