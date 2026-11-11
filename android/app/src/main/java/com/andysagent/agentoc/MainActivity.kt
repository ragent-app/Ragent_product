package com.andysagent.agentoc

import androidx.lifecycle.viewmodel.initializer

import android.Manifest
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.content.Intent
import android.net.Uri
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.annotation.StringRes
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ExperimentalGetImage
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.agentoc.core.designsystem.AgentoAlertDialog as AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.PixelCopy
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import java.io.File
import java.io.FileOutputStream
import com.andysagent.agentoc.core.appapi.SessionNavigationRequest
import com.andysagent.agentoc.core.appapi.ApiErrorCode
import com.andysagent.agentoc.core.appapi.AppApiException
import com.andysagent.agentoc.core.appapi.AppApiJson
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.andysagent.agentoc.core.auth.BrowserSignInRecovery
import com.andysagent.agentoc.core.auth.encodeBrowserSignInRecovery
import com.andysagent.agentoc.core.auth.restoreBrowserSignInRecovery
import com.andysagent.agentoc.core.auth.AccountSessionChallenge
import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.auth.TemporaryClaimConflictException
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.core.protocol.parsePairingUri
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.AgentoDialog
import com.andysagent.agentoc.core.designsystem.AgentoDialogActionLayout
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.agentui.AgentConnectionStatus
import com.andysagent.agentoc.core.model.AppLanguage
import com.andysagent.agentoc.core.model.AppTheme
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.datastore.LinkedComputer
import com.andysagent.agentoc.core.domain.AccountDirectoryDevice
import com.andysagent.agentoc.core.domain.DiscoveredComputer
import com.andysagent.agentoc.demo.HeroDemoSessionRepository
import com.andysagent.agentoc.core.navigation.AgentoWindowSizeClass
import com.andysagent.agentoc.core.navigation.AgentoDestination
import com.andysagent.agentoc.feature.workbench.WorkbenchScreen
import com.andysagent.agentoc.feature.workbench.accounts.AccountsViewModel
import com.andysagent.agentoc.feature.workbench.accounts.AccountsViewModelFactory
import com.andysagent.agentoc.feature.workbench.accounts.AvatarImageCache
import com.andysagent.agentoc.feature.workbench.AppShellEvent
import com.andysagent.agentoc.feature.workbench.AppShellViewModel
import com.andysagent.agentoc.feature.workbench.AppShellViewModelFactory
import com.andysagent.agentoc.feature.workbench.AttentionCenterViewModel
import com.andysagent.agentoc.feature.workbench.AttentionCenterViewModelFactory
import com.andysagent.agentoc.feature.workbench.AttentionEvent
import com.andysagent.agentoc.feature.workbench.ChatEvent
import com.andysagent.agentoc.feature.workbench.ChatViewModel
import com.andysagent.agentoc.feature.workbench.ChatViewModelFactory
import com.andysagent.agentoc.feature.workbench.NativePasskeyHelper
import com.andysagent.agentoc.feature.workbench.ComputersEvent
import com.andysagent.agentoc.feature.workbench.ComputersViewModel
import com.andysagent.agentoc.feature.workbench.ComputersViewModelFactory
import com.andysagent.agentoc.feature.workbench.ProjectsEvent
import com.andysagent.agentoc.feature.workbench.ProjectsViewModel
import com.andysagent.agentoc.feature.workbench.ProjectsViewModelFactory
import com.andysagent.agentoc.feature.workbench.PairingOnboardingEvent
import com.andysagent.agentoc.feature.workbench.PairingOnboardingViewModel
import com.andysagent.agentoc.feature.workbench.PairingOnboardingViewModelFactory
import com.andysagent.agentoc.feature.workbench.TemporaryClaimReplacementOutcome
import com.andysagent.agentoc.feature.workbench.GoogleSignInRequest
import com.andysagent.agentoc.feature.workbench.PairingOnboardingStep
import com.andysagent.agentoc.feature.workbench.AccountComputerLookup
import com.andysagent.agentoc.feature.workbench.GoogleSignInSuccessAction
import com.andysagent.agentoc.feature.workbench.WorkbenchEvent
import com.andysagent.agentoc.feature.workbench.WorkbenchUiState
import com.andysagent.agentoc.feature.workbench.SettingsPage
import com.andysagent.agentoc.feature.workbench.WebParityViewModel
import com.andysagent.agentoc.feature.workbench.WebParityViewModelFactory
import com.andysagent.agentoc.feature.workbench.WebParityEvent
import com.andysagent.agentoc.feature.workbench.R as WorkbenchR
import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.RemoteTargetAccessState
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.feature.workbench.accounts.AccountsEvent
import com.andysagent.agentoc.feature.workbench.accounts.GoogleSignInHelper
import com.andysagent.agentoc.feature.workbench.accounts.GoogleSignInFailure
import com.andysagent.agentoc.feature.workbench.accounts.GoogleSignInOutcome
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountStatus
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

internal fun updateStartupAccountSessionResolved(
    directoryLoaded: Boolean,
    accountSessionResolved: Boolean,
    alreadyResolved: Boolean,
    accountSessionMetadataLoaded: Boolean = false,
): Boolean = alreadyResolved || (
    directoryLoaded &&
        (accountSessionResolved || accountSessionMetadataLoaded)
)

internal fun shouldShowWelcomeAtLaunch(
    startupOnboardingLoading: Boolean,
    hasPendingGoogleBinding: Boolean,
    welcomeSuppressedBySignIn: Boolean,
    hasLocalComputers: Boolean,
    accountStatus: GoogleAccountStatus,
    pairingOpen: Boolean,
    temporaryControlActive: Boolean = false,
): Boolean {
    // Account authentication precedes computer setup. A signed-in account's
    // authoritative directory (including offline computers) decides setup.
    val needsFirstComputer = accountStatus == GoogleAccountStatus.SignedOut ||
        (!hasLocalComputers && accountStatus == GoogleAccountStatus.SignedIn)
    return !startupOnboardingLoading &&
        !temporaryControlActive &&
        !hasPendingGoogleBinding &&
        !pairingOpen &&
        (!welcomeSuppressedBySignIn || accountStatus == GoogleAccountStatus.SignedOut) &&
        needsFirstComputer
}

internal fun pairingEntryEvent(hasVerifiedAccountSession: Boolean): PairingOnboardingEvent =
    if (hasVerifiedAccountSession) {
        PairingOnboardingEvent.OpenWelcome
    } else {
        PairingOnboardingEvent.Open
    }

/**
 * The session repository owns the device list before a local pairing directory
 * has been written. Keeping that list as a signed-out fallback makes the
 * project selector and device tab describe the same available computer.
 */
internal fun deviceSurfaceTargets(
    hasVerifiedAccountSession: Boolean,
    accountTargets: List<RemoteTarget>,
    localTargets: List<RemoteTarget>,
    sessionComputers: List<Computer>,
): List<RemoteTarget> = when {
    hasVerifiedAccountSession -> accountTargets
    localTargets.isNotEmpty() -> localTargets
    else -> sessionComputers.map { computer ->
        RemoteTarget(
            instanceId = computer.id,
            label = computer.name.ifBlank { computer.id },
            endpoint = computer.endpoint.orEmpty(),
            platform = computer.platform,
            accessState = if (computer.connected) {
                RemoteTargetAccessState.Connected
            } else {
                RemoteTargetAccessState.Offline
            },
        )
    }
}

internal fun shouldReuseStoredAccountSession(
    hasVerifiedAccountSession: Boolean,
    accountSessionMetadataLoaded: Boolean,
    hasStoredAccountSession: Boolean,
): Boolean = hasVerifiedAccountSession || (accountSessionMetadataLoaded && hasStoredAccountSession)

internal fun isValidAccountHandoffPairingUri(value: String): Boolean =
    runCatching { parsePairingUri(value).version == 4 }.getOrDefault(false)

internal fun shouldWaitForAccountSessionMetadataBeforePairing(
    pairingUri: String,
    accountSessionMetadataLoaded: Boolean,
): Boolean = !accountSessionMetadataLoaded && !isValidAccountHandoffPairingUri(pairingUri)

internal fun isAccountReauthorizationFailure(error: Throwable): Boolean = when (error) {
    is AccountSessionException -> error.statusCode in setOf(401, 403)
    is AccountsRepositoryException -> error.statusCode in setOf(401, 403)
    else -> false
}

internal data class ConnectionErrorCopy(@StringRes val textRes: Int, val retryAfterSeconds: Long? = null)

internal fun connectionErrorMessage(error: Throwable): ConnectionErrorCopy {
    val code = when (error) {
        is AccountSessionException -> error.code
        is AccountsRepositoryException -> error.code
        else -> null
    }
    if (code in setOf("turn_connection_quota_exceeded", "turn_quota_exceeded")) {
        return ConnectionErrorCopy(R.string.computer_connection_quota_reached)
    }
    val statusCode = when (error) {
        is AccountSessionException -> error.statusCode
        is AccountsRepositoryException -> error.statusCode
        else -> null
    }
    if (statusCode == 429) {
        val retryAfterMs = (error as? AccountSessionException)?.retryAfterMs
        val retryAfterSeconds = retryAfterMs?.let { (it + 999L) / 1_000L }?.takeIf { it > 0L }
        return if (retryAfterSeconds != null) {
            ConnectionErrorCopy(R.string.computer_connection_busy_retry_after, retryAfterSeconds)
        } else {
            ConnectionErrorCopy(R.string.computer_connection_busy)
        }
    }
    return when (statusCode) {
        401, 403 -> ConnectionErrorCopy(R.string.computer_connection_reauthorize)
        else -> ConnectionErrorCopy(R.string.computer_connection_unavailable)
    }
}

internal sealed interface ComputerConnectionFailureUi {
    data object ReauthorizeAccount : ComputerConnectionFailureUi
    data class ShowConnectionError(val message: ConnectionErrorCopy) : ComputerConnectionFailureUi
}

internal fun computerConnectionFailureUi(error: Throwable): ComputerConnectionFailureUi =
    if (isAccountReauthorizationFailure(error)) {
        ComputerConnectionFailureUi.ReauthorizeAccount
    } else {
        ComputerConnectionFailureUi.ShowConnectionError(connectionErrorMessage(error))
    }

@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
class MainActivity : ComponentActivity() {
    private lateinit var pairingScannerLauncher: androidx.activity.result.ActivityResultLauncher<Intent>
    private var activePairingOnboarding: PairingOnboardingViewModel? = null
    private var scannerReturnToWelcomeOnFailure = false
    private val initialContentGate = InitialContentGate()
    // 配对深链: 相机/其他 App 识别 agentoc://pair 后唤起本 App 时携带的 URI。
    private var pendingPairingUri by mutableStateOf<String?>(null)
    private var pendingGoogleSignIn by mutableStateOf<GoogleSignInRequest?>(null)
    private var googleSignInToLaunch by mutableStateOf<GoogleSignInRequest?>(null)
    private var googleSignInSuccess by mutableStateOf<GoogleSignInRequest?>(null)
    // 浏览器登录回退（无 GMS 设备）: 挑战持有后交给浏览器完成 Google 登录。
    private var browserSignInRequest by mutableStateOf<GoogleSignInRequest?>(null)
    private var browserSignInChallenge by mutableStateOf<AccountSessionChallenge?>(null)
    private var browserSignInError by mutableStateOf<String?>(null)
    private var browserSignInRetryTick by mutableIntStateOf(0)
    private var discoveredComputers by mutableStateOf<List<DiscoveredComputer>>(emptyList())
    private var accountDirectoryDevices by mutableStateOf<List<AccountDirectoryDevice>>(emptyList())
    private var accountDirectoryGeneration = 0L
    private var accountComputerLookup by mutableStateOf(AccountComputerLookup.Loading)
    private var pendingComputerConnectionId by mutableStateOf<String?>(null)
    private var pendingComputerConnectionIsPrimary by mutableStateOf(true)
    private var welcomeSuppressedBySignIn by mutableStateOf(false)
    private var subscriptionInfoOpen by mutableStateOf(false)
    private var requestError by mutableStateOf<String?>(null)
    private var pendingPairingScanFromWelcome by mutableStateOf<Boolean?>(null)
    private var computerConnectionError by mutableStateOf<ConnectionErrorCopy?>(null)
    private var pendingSessionNavigation by mutableStateOf<SessionNavigationRequest?>(null)
    private var sessionNavigationError by mutableStateOf<ApiErrorCode?>(null)
    private var navigationIntakeKey: String? = null
    private var currentPhase3RFrame by mutableIntStateOf(0)

    private fun reportComputerConnectionFailure(error: Throwable) {
        when (val failure = computerConnectionFailureUi(error)) {
            ComputerConnectionFailureUi.ReauthorizeAccount -> {
                computerConnectionError = null
                pendingGoogleSignIn = GoogleSignInRequest.ManageDevices
            }
            is ComputerConnectionFailureUi.ShowConnectionError -> {
                requestError = null
                computerConnectionError = failure.message
            }
        }
    }

    /**
     * Notification event identities already consumed by this activity instance.
     * PendingIntent redelivery must not re-trigger the same deep link twice.
     */
    private val consumedNotificationKeys = object : LinkedHashSet<String>() {
        override fun add(element: String): Boolean {
            val added = super.add(element)
            if (size > 32) remove(iterator().next())
            return added
        }
    }

    /** Single intake path for cold start and hot start: pairing deep links and notification taps. */
    private fun consumeIncomingIntent(intent: Intent?) {
        intent ?: return
        if (intent.action == Intent.ACTION_VIEW && intent.data?.scheme in setOf("agentoc", "riollant", "ragent") && intent.data?.host == "pair") {
            val accountHandoff = isValidAccountHandoffPairingUri(intent.data.toString())
            Log.i("PairingIntake", "Received pair URI; accountHandoff=$accountHandoff")
            pendingPairingUri = intent.data.toString()
        }
        try {
            val request = readSessionNavigation(intent) ?: return
            if (request.identity() in consumedNotificationKeys) return
            navigationIntakeKey = request.identity()
            pendingSessionNavigation = request
            sessionNavigationError = null
        } catch (failure: Exception) {
            pendingSessionNavigation = null
            sessionNavigationError = (failure as? AppApiException)?.error?.code ?: ApiErrorCode.INVALID_ARGUMENT
        }
    }

    @ExperimentalGetImage
    override fun onCreate(savedInstanceState: Bundle?) {
        // Keep the system splash over local initialization. Let the platform own
        // its exit instead of cross-fading two differently themed full-screen layers.
        val splash = installSplashScreen()
        // Hold only for the local snapshot needed to choose the first real UI.
        // Network verification and connection continue through their existing UI states.
        splash.setKeepOnScreenCondition { !initialContentGate.ready }
        super.onCreate(savedInstanceState)
        if (savedInstanceState?.containsKey("agentoc.setup.fromWelcome") == true) {
            pendingPairingScanFromWelcome = savedInstanceState.getBoolean("agentoc.setup.fromWelcome")
        }
        pairingScannerLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val onboarding = activePairingOnboarding ?: return@registerForActivityResult
            when (result.resultCode) {
                RESULT_OK -> result.data?.getStringExtra(PairingQrScannerActivity.EXTRA_RAW_VALUE)
                    ?.takeIf(String::isNotBlank)
                    ?.let { onboarding.onEvent(PairingOnboardingEvent.PairingUriReceived(it)) }
                    ?: onboarding.onEvent(PairingOnboardingEvent.ScannerFailed(returnToWelcome = scannerReturnToWelcomeOnFailure))
                RESULT_FIRST_USER -> onboarding.onEvent(
                    PairingOnboardingEvent.ScannerFailed(
                        message = result.data?.getStringExtra(PairingQrScannerActivity.EXTRA_ERROR),
                        returnToWelcome = scannerReturnToWelcomeOnFailure,
                    ),
                )
                // A user-initiated cancellation leaves the current onboarding page open.
            }
            activePairingOnboarding = null
        }
        System.err.println(">>> MainActivity onCreate: phase3r_export=${intent.getBooleanExtra("phase3r_export", false)}, phase3r_frame=${intent.getIntExtra("phase3r_frame", -1)}")
        val transparentSystemBar = SystemBarStyle.auto(
            lightScrim = AndroidColor.TRANSPARENT,
            darkScrim = AndroidColor.TRANSPARENT,
        )
        enableEdgeToEdge(
            statusBarStyle = transparentSystemBar,
            navigationBarStyle = transparentSystemBar,
        )
        consumedNotificationKeys.addAll(savedInstanceState?.getStringArrayList("agentoc.navigation.consumed").orEmpty().takeLast(32))
        navigationIntakeKey = savedInstanceState?.getString("agentoc.navigation.intakeKey")
        pendingSessionNavigation = savedInstanceState?.getString("agentoc.navigation.pending")?.let { payload ->
            if (payload.length > 4096) null else runCatching { AppApiJson.decodeFromString<SessionNavigationRequest>(payload).validated() }.getOrNull()
        }
        restoreBrowserSignInRecovery(savedInstanceState?.getString("agentoc.browser.signIn"))?.let { recovered ->
            GoogleSignInRequest.entries.firstOrNull { it.name == recovered.purpose }?.let { purpose ->
                browserSignInRequest = purpose
                browserSignInChallenge = recovered.challenge
                pendingComputerConnectionId = recovered.computerId
                pendingComputerConnectionIsPrimary = recovered.primaryComputer
            }
        }
        if (pendingSessionNavigation == null) consumeIncomingIntent(intent)

        setContent {
            val app = application as AgentoCApplication
            // Design-capture harness: swaps in fabricated repository data behind the
            // real UI stack. Debuggable builds launched with the explicit extra only;
            // the production repository and every visible component stay untouched.
            val heroDemo = intent.getBooleanExtra("agentoc_hero_demo", false) &&
                (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            LaunchedEffect(heroDemo) {
                if (heroDemo && app.runtime.sessions.delegate.value !is HeroDemoSessionRepository) {
                    app.runtime.sessions.switchTo(HeroDemoSessionRepository())
                }
            }
            val storedAppTheme by app.runtime.configStore.appTheme.collectAsStateWithLifecycle(initialValue = null)
            val storedAppLanguage by app.runtime.configStore.appLanguage.collectAsStateWithLifecycle(initialValue = null)
            val appTheme = storedAppTheme ?: AppTheme.System
            val appLanguage = storedAppLanguage ?: AppLanguage.System
            val appLanguageLoaded = storedAppLanguage != null
            LaunchedEffect(storedAppTheme) {
                val resolvedTheme = storedAppTheme ?: return@LaunchedEffect
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Persist the package resource mode too, so the OS-owned splash
                    // on the next cold start agrees with the user's saved palette.
                    getSystemService(UiModeManager::class.java)
                        .setApplicationNightMode(applicationNightMode(resolvedTheme))
                }
            }
            val isDark = when (appTheme) {
                AppTheme.Dark, AppTheme.Oled, AppTheme.Amber -> true
                AppTheme.Light -> false
                AppTheme.System, AppTheme.Monet -> isSystemInDarkTheme()
            }
            AgentocTheme(darkTheme = isDark, themeVariant = appTheme.value) {
                val runtimeScope = rememberCoroutineScope()
                val voiceController = remember(app) { LocalVoiceController(app, runtimeScope) }
                LaunchedEffect(appLanguage, appLanguageLoaded) {
                    if (!appLanguageLoaded) return@LaunchedEffect
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        val localeManager = getSystemService(android.app.LocaleManager::class.java)
                        val targetLocales = if (appLanguage.tag.isBlank()) {
                            android.os.LocaleList.getEmptyLocaleList()
                        } else {
                            android.os.LocaleList.forLanguageTags(appLanguage.tag)
                        }
                        if (localeManager?.applicationLocales != targetLocales) {
                            localeManager?.applicationLocales = targetLocales
                        }
                    }
                }
                val localizedContext = remember(appLanguage, appLanguageLoaded) {
                    localizedContextFor(this@MainActivity, appLanguage)
                }
                CompositionLocalProvider(LocalContext provides localizedContext) {
                val windowSizeClass = calculateWindowSizeClass(this@MainActivity)
                val googleSignInHelper = remember(app) {
                    GoogleSignInHelper(this@MainActivity, getString(R.string.google_server_client_id))
                }
                val nativePasskeyHelper = remember(this@MainActivity) {
                    NativePasskeyHelper(this@MainActivity)
                }
                val notificationPermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { }
                var notificationPermissionRequested by remember { mutableStateOf(false) }
                val shell: AppShellViewModel = viewModel(factory = AppShellViewModelFactory(app.runtime.sessions))
                val tabletChatBinding: TabletChatBinding = viewModel()
                val chat: ChatViewModel = viewModel(
                    factory = ChatViewModelFactory(
                        tabletChatBinding.sessions,
                        passkeyProvider = { publicKeyJson -> nativePasskeyHelper.getAssertion(publicKeyJson) },
                        readRuntimeCache = { targetId, sessionId ->
                            app.runtime.configStore.readChatRuntimeCache(targetId, sessionId)?.let {
                                com.andysagent.agentoc.core.domain.RuntimeSelection(it.tool, it.providerProfile, it.model, it.effort, it.serviceTier)
                            }
                        },
                        writeRuntimeCache = { targetId, sessionId, selection ->
                            selection.model?.let { model -> app.runtime.configStore.cacheChatRuntime(targetId, sessionId,
                                com.andysagent.agentoc.core.datastore.ShareRuntimeSelection(
                                    selection.tool, selection.providerProfile, model, selection.effort, selection.serviceTier,
                                )) }
                        },
                    ),
                )
                // Left-pane menus always operate on the foreground computer,
                // independently of the computer retained by the chat pane.
                val listActions: ChatViewModel = viewModel(
                    key = "foreground-list-actions",
                    factory = ChatViewModelFactory(app.runtime.sessions),
                )
                val windowsBrokerController = remember(app) {
                    WindowsBrokerApprovalController(applicationContext, app)
                }
                val attention: AttentionCenterViewModel = viewModel(
                    factory = AttentionCenterViewModelFactory(
                        app.runtime.sessions,
                        windowsBrokerController,
                        passkeyProvider = { publicKeyJson -> nativePasskeyHelper.getAssertion(publicKeyJson) },
                    ),
                )
                val attentionState by attention.state.collectAsStateWithLifecycle()
                LaunchedEffect(pendingSessionNavigation) {
                    val request = pendingSessionNavigation ?: return@LaunchedEffect
                    if (request.targetInstanceId == null) return@LaunchedEffect // Legacy input requires an explicit computer choice.
                    try {
                        app.runtime.navigateToSession(request) { sessionId ->
                            if (pendingSessionNavigation == request) {
                                tabletChatBinding.bind(app.runtime.sessions.delegate.value, request.targetInstanceId, app.runtime.transport.delegate.value)
                                if (pendingSessionNavigation == request) {
                                    shell.onEvent(AppShellEvent.OpenChat)
                                    chat.onEvent(ChatEvent.SelectSession(sessionId))
                                    consumedNotificationKeys.add(request.identity())
                                    navigationIntakeKey?.let(consumedNotificationKeys::add)
                                    pendingSessionNavigation = null
                                    sessionNavigationError = null
                                }
                            }
                        }
                    } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                    catch (failure: Exception) {
                        if (pendingSessionNavigation == request) {
                            sessionNavigationError = (failure as? AppApiException)?.error?.code ?: ApiErrorCode.TARGET_OFFLINE
                        }
                    }
                }
                val projects: ProjectsViewModel = viewModel(factory = ProjectsViewModelFactory(app.runtime.sessions))
                val computers: ComputersViewModel = viewModel(
                    factory = ComputersViewModelFactory(app.runtime.sessions) { uri, name -> app.runtime.pairFromInvitation(uri, name) },
                )
                val accounts: AccountsViewModel = viewModel(
                    factory = AccountsViewModelFactory(
                        repository = app.runtime.accounts,
                        joinWithAccountComputer = { instanceId ->
                            app.runtime.pairFromAccountComputer(
                                instanceId = instanceId,
                                deviceName = app.runtime.accountDeviceAlias,
                            )
                        },
                        logoutAccountSession = { app.runtime.logoutAccountSession() },
                        revokeAccountDevice = { deviceId -> app.runtime.revokeAccountDevice(deviceId) },
                        identityStore = app.runtime.accountIdentityStore,
                        accountSessionStateSource = app.runtime.accountSessionStateSource,
                    ),
                )
                val contentReports: com.andysagent.agentoc.feature.workbench.ContentReportViewModel = viewModel(
                    factory = androidx.lifecycle.viewmodel.viewModelFactory {
                        initializer { com.andysagent.agentoc.feature.workbench.ContentReportViewModel(app.runtime.contentReports) }
                    },
                )
                val demoSignIn: com.andysagent.agentoc.feature.workbench.accounts.DemoSignInViewModel = viewModel(
                    factory = androidx.lifecycle.viewmodel.viewModelFactory {
                        initializer { com.andysagent.agentoc.feature.workbench.accounts.DemoSignInViewModel(app.runtime::signInDemoAccount) }
                    },
                )
                val demoSignInState by demoSignIn.state.collectAsStateWithLifecycle()
                val demoConnection: com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionViewModel = viewModel(
                    factory = androidx.lifecycle.viewmodel.viewModelFactory {
                        initializer {
                            com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionViewModel(
                                discover = { expectedAccount ->
                                    check(app.runtime.configStore.accountSession.first()?.accountId == expectedAccount)
                                    app.runtime.discoverAccountComputers()
                                },
                                connect = { accountId, targetId -> app.runtime.ensureDemoComputerConnection(accountId, targetId) },
                                reconnect = { accountId, targetId -> app.runtime.ensureDemoComputerConnection(accountId, targetId, forceRefresh = true) },
                            )
                        }
                    },
                )
                val demoConnectionState by demoConnection.state.collectAsStateWithLifecycle()

                val webParity: WebParityViewModel = viewModel(
                    factory = WebParityViewModelFactory(
                        transport = app.runtime.transport,
                        accountDevicesProvider = {
                            // Once an Accounts session is verified, the central
                            // directory is authoritative. Let failures surface
                            // instead of falling back to this instance's local
                            // trusted-device cache and showing a misleading
                            // partial account directory. Signed-out users keep
                            // the ordinary instance-local Web surface.
                            if (accounts.state.value.hasVerifiedAccountSession) {
                                app.runtime.listAccountDirectoryDevices()
                            } else {
                                null
                            }
                        },
                        accountDeviceRevoker = { deviceId ->
                            app.runtime.revokeAccountDevice(deviceId)
                            // Revoking the current phone is also the end of the
                            // local Accounts session. Refresh the account VM
                            // so Settings immediately returns to the real
                            // reauthorization state instead of retaining a
                            // stale signed-in projection.
                            accounts.onEvent(AccountsEvent.Refresh)
                        },
                        accountDeviceRenamer = { deviceId, alias -> app.runtime.renameAccountDevice(deviceId, alias) },
                        providerInstancesProvider = { app.runtime.listProviderInstances() },
                        providerRepositoryFactory = { id ->
                            com.andysagent.agentoc.feature.workbench.WebParityRepository { request ->
                                app.runtime.executeProviderOnInstance(id, request)
                            }
                        },
                        harnessTargetsProvider = { app.runtime.loadHarnessTargetSnapshots() },
                        harnessMutation = { id, operation, targetIds ->
                            app.runtime.mutateHarnessOnTargets(id, operation, targetIds)
                        },
                        currentTargetIdProvider = {
                            app.runtime.temporaryControlInstanceId() ?: app.runtime.configStore.directory.first().activeTarget?.instanceId
                        },
                        onRuntimeCatalogChanged = {
                            chat.onEvent(ChatEvent.RefreshRuntimeCatalog)
                        },
                    ),
                )
                val chatWebParity: WebParityViewModel = viewModel(
                    key = "tablet-chat-parity",
                    factory = WebParityViewModelFactory(
                        transport = tabletChatBinding.transport,
                        currentTargetIdProvider = { tabletChatBinding.targetId.value },
                        onRuntimeCatalogChanged = { chat.onEvent(ChatEvent.RefreshRuntimeCatalog) },
                    ),
                )
                LaunchedEffect(webParity) {
                    app.runtime.harnessInvalidations.collect {
                        webParity.onEvent(WebParityEvent.Refresh)
                        chat.onEvent(ChatEvent.RefreshRuntimeCatalog)
                    }
                }
                val pairingOnboarding: PairingOnboardingViewModel = viewModel(
                    factory = PairingOnboardingViewModelFactory(
                        deviceName = app.runtime.accountDeviceAlias,
                        completePairing = { uri, name ->
                            app.runtime.pairFromInvitation(uri, name)
                        },
                        completePairingWithAlias = { uri, name, computerAlias ->
                            app.runtime.pairFromInvitation(uri, name, computerAlias)
                        },
                        completeTemporaryPairing = { ticket ->
                            val temporary = app.runtime.temporaryAccess
                            val started = temporary.beginQr(ticket)
                            temporary.waitUntilReady(requireNotNull(started.instanceId))
                        },
                        completeTemporaryControlPairing = { ticket ->
                            app.runtime.connectTemporaryControl(ticket)
                        },
                        resumeTemporaryPairing = { instanceId ->
                            app.runtime.temporaryAccess.waitUntilReady(instanceId)
                        },
                        isTemporaryClaimConflict = { error -> error is TemporaryClaimConflictException },
                        replaceTemporaryClaim = { ticket ->
                            when (val result = app.runtime.temporaryAccess.replaceClaimForTicket(ticket)) {
                                TemporaryAccessRuntime.ClaimReplacementResult.Released,
                                TemporaryAccessRuntime.ClaimReplacementResult.NoExistingClaim ->
                                    TemporaryClaimReplacementOutcome.ReadyToRetry
                                is TemporaryAccessRuntime.ClaimReplacementResult.BlockedByOperations ->
                                    TemporaryClaimReplacementOutcome.BlockedByOperations(result.count)
                            }
                        },
                        discoverComputers = { _ ->
                            app.runtime.discoverAccountComputers()
                        },
                        takeOverComputers = { computers, name ->
                            computers.forEachIndexed { index, computer ->
                                if (index == 0) {
                                    app.runtime.pairFromAccountComputer(computer.instanceId, name)
                                } else {
                                    app.runtime.connectAccountComputerInBackground(computer.instanceId, name)
                                }
                            }
                            // The first selected computer is the interactive
                            // target; every permitted additional computer is
                            // retained as a Home-summary background carrier.
                            computers.firstOrNull()?.let { app.runtime.selectTarget(it.instanceId) }
                        },
                    ),
                )
                LaunchedEffect(googleSignInToLaunch) {
                    val request = googleSignInToLaunch ?: return@LaunchedEffect
                    val preferAuthorizedAccount = request == GoogleSignInRequest.ManageDevices &&
                        accounts.state.value.hasVerifiedAccountSession
                    val result = completeGoogleAccountChallengeWithRetry(
                        createChallenge = { app.runtime.createAccountGoogleChallenge(app.runtime.accountDeviceAlias) },
                        requestToken = { nonce, preferAuthorized ->
                            googleSignInHelper.getIdToken(nonce = nonce, preferAuthorizedAccount = preferAuthorized)
                        },
                        complete = { challenge, idToken, profile ->
                            app.runtime.completeAccountGoogleChallenge(challenge, idToken, profile)
                        },
                        preferAuthorized = preferAuthorizedAccount,
                    )
                    when (result) {
                        is GoogleAccountChallengeResult.Success -> when (request) {
                            GoogleSignInRequest.Account -> {
                                accounts.onEvent(AccountsEvent.AccountSessionEstablished(result.profile))
                                googleSignInSuccess = request
                            }
                            GoogleSignInRequest.PairComputer,
                            GoogleSignInRequest.PairComputerFromWelcome -> {
                                accounts.onEvent(AccountsEvent.AccountSessionEstablished(result.profile))
                                if (request == GoogleSignInRequest.PairComputer) {
                                    pairingOnboarding.onEvent(PairingOnboardingEvent.AccountSessionReady)
                                }
                                googleSignInSuccess = request
                            }
                            GoogleSignInRequest.ManageDevices -> {
                                try {
                                    val targetId = pendingComputerConnectionId
                                    if (targetId == null) {
                                        refreshAccountDirectory(app)
                                    } else if (pendingComputerConnectionIsPrimary) {
                                        app.runtime.pairFromAccountComputer(targetId, app.runtime.accountDeviceAlias)
                                    } else {
                                        app.runtime.connectAccountComputerInBackground(targetId, app.runtime.accountDeviceAlias)
                                    }
                                    accounts.onEvent(AccountsEvent.AccountSessionEstablished(result.profile))
                                    pendingComputerConnectionId = null
                                    pendingComputerConnectionIsPrimary = true
                                } catch (cancelled: CancellationException) {
                                    throw cancelled
                                } catch (error: Exception) {
                                    pendingComputerConnectionId = null
                                    pendingComputerConnectionIsPrimary = true
                                    requestError = error.message ?: "Could not manage computers."
                                }
                            }
                        }
                        GoogleAccountChallengeResult.Cancelled -> when (request) {
                            GoogleSignInRequest.Account -> accounts.onEvent(AccountsEvent.SignInCancelled)
                            GoogleSignInRequest.PairComputer,
                            GoogleSignInRequest.PairComputerFromWelcome -> pairingOnboarding.onEvent(
                                PairingOnboardingEvent.GoogleSignInCancelled,
                            )
                            GoogleSignInRequest.ManageDevices -> {
                                pendingComputerConnectionId = null
                                pendingComputerConnectionIsPrimary = true
                            }
                        }
                        is GoogleAccountChallengeResult.Failed -> {
                            if (request == GoogleSignInRequest.ManageDevices) {
                                pendingComputerConnectionId = null
                                pendingComputerConnectionIsPrimary = true
                            }
                            val message = when (result.providerFailure) {
                                GoogleSignInFailure.NoGoogleAccount ->
                                    "No Google account is available on this device. Add a Google account and try again."
                                GoogleSignInFailure.GooglePlayServicesUnavailable ->
                                    "Google Play services is unavailable, disabled, or too old on this device. Update or enable it, then try again."
                                GoogleSignInFailure.ProviderError ->
                                    "Credential Manager could not start Google sign-in. Check the app signature and Google Play services, then try again."
                                null -> result.error?.message ?: "Google sign-in failed."
                            }
                            if (request == GoogleSignInRequest.Account) {
                                accounts.onEvent(AccountsEvent.SignInFailed(message))
                            } else if (request == GoogleSignInRequest.PairComputer ||
                                request == GoogleSignInRequest.PairComputerFromWelcome
                            ) {
                                pairingOnboarding.onEvent(PairingOnboardingEvent.GoogleSignInCancelled)
                            }
                            requestError = message
                        }
                    }
                    // Keep the effect key stable until Credential Manager has returned.
                    googleSignInToLaunch = null
                }
                LaunchedEffect(browserSignInRequest, browserSignInRetryTick) {
                    val request = browserSignInRequest ?: return@LaunchedEffect
                    var challenge: AccountSessionChallenge? = browserSignInChallenge
                    var challengeRecreations = 0
                    var browserSessionEstablished = false
                    while (isActive && browserSignInRequest != null) {
                        val active = challenge
                        if (active == null) {
                            challenge = app.runtime.createAccountGoogleChallenge(app.runtime.accountDeviceAlias)
                            // Save before launching Chrome; the activity may be reclaimed in the background.
                            browserSignInChallenge = challenge
                            val base = getString(R.string.accounts_directory_base_url).trimEnd('/')
                            val page = Uri.parse(base).buildUpon()
                                .appendPath("owner")
                                .appendPath("google")
                                .appendPath("native-phone")
                                .appendQueryParameter("tx", challenge.transactionId)
                                .appendQueryParameter("ticket", challenge.browserTicket)
                                .build()
                            runCatching { startActivity(Intent(Intent.ACTION_VIEW, page)) }
                                .onFailure { error ->
                                    browserSignInError = error.message ?: "No browser is available to finish sign-in."
                                    break
                                }
                        }
                        try {
                            val profile = app.runtime.completeBrowserAccountSession(challenge)
                            browserSessionEstablished = true
                            challenge = null
                            browserSignInChallenge = null
                            googleSignInSuccess = request
                            browserSignInError = null
                            when (request) {
                                GoogleSignInRequest.Account -> {
                                    accounts.onEvent(AccountsEvent.AccountSessionEstablished(profile))
                                    googleSignInSuccess = request
                                }
                                GoogleSignInRequest.PairComputer,
                                GoogleSignInRequest.PairComputerFromWelcome,
                                -> {
                                    accounts.onEvent(AccountsEvent.AccountSessionEstablished(profile))
                                    if (request == GoogleSignInRequest.PairComputer) {
                                        pairingOnboarding.onEvent(PairingOnboardingEvent.AccountSessionReady)
                                    }
                                    googleSignInSuccess = request
                                }
                                GoogleSignInRequest.ManageDevices -> {
                                    accounts.onEvent(AccountsEvent.AccountSessionEstablished(profile))
                                    runCatching {
                                        val targetId = pendingComputerConnectionId
                                        if (targetId == null) {
                                            refreshAccountDirectory(app)
                                        } else {
                                            if (pendingComputerConnectionIsPrimary) {
                                                app.runtime.pairFromAccountComputer(
                                                    targetId,
                                                    app.runtime.accountDeviceAlias,
                                                )
                                            } else {
                                                app.runtime.connectAccountComputerInBackground(
                                                    targetId,
                                                    app.runtime.accountDeviceAlias,
                                                )
                                            }
                                        }
                                    }.onSuccess {
                                        pendingComputerConnectionId = null
                                        pendingComputerConnectionIsPrimary = true
                                    }.onFailure { error ->
                                        pendingComputerConnectionId = null
                                        pendingComputerConnectionIsPrimary = true
                                        requestError = error.message ?: "Could not manage computers."
                                    }
                                }
                            }
                            break
                        } catch (error: AccountSessionException) {
                            when (error.code) {
                                // The browser leg has not finished yet; keep the
                                // waiting overlay up and check again shortly.
                                "owner_auth_account_session_browser_pending" -> delay(3_000)
                                "owner_auth_account_session_expired",
                                "owner_auth_account_session_browser_ticket_invalid",
                                -> {
                                    challenge = null
                                    browserSignInChallenge = null
                                    challengeRecreations += 1
                                    if (challengeRecreations >= 3) {
                                        browserSignInError = "Browser sign-in expired. Start again."
                                        break
                                    }
                                    delay(500)
                                }
                                "owner_auth_account_session_consumed" -> {
                                    challenge = null
                                    browserSignInChallenge = null
                                    browserSignInError =
                                        "The server completed this sign-in, but the app did not receive its session. Start sign-in again."
                                    break
                                }
                                else -> {
                                    browserSignInError = error.message ?: "Browser sign-in failed."
                                    break
                                }
                            }
                        } catch (cancelled: kotlinx.coroutines.CancellationException) {
                            throw cancelled
                        } catch (error: Throwable) {
                            browserSignInError = error.message ?: "Browser sign-in failed."
                            break
                        }
                    }
                    if (browserSessionEstablished) {
                        browserSignInChallenge = null
                        browserSignInRequest = null
                    } else {
                        // Keep an unexpired challenge so an explicit retry can resume this
                        // browser handoff instead of invalidating its already-verified nonce.
                        browserSignInChallenge = challenge
                    }
                }
                val shellState by shell.state.collectAsStateWithLifecycle()
                val chatState by chat.state.collectAsStateWithLifecycle()
                val voiceState by voiceController.state.collectAsStateWithLifecycle()
                LaunchedEffect(voiceState.message) {
                    val message = voiceState.message ?: return@LaunchedEffect
                    android.widget.Toast.makeText(this@MainActivity, message, android.widget.Toast.LENGTH_LONG).show()
                    voiceController.clearMessage()
                }
                val listActionState by listActions.state.collectAsStateWithLifecycle()
                val projectState by projects.state.collectAsStateWithLifecycle()
                val computerState by computers.state.collectAsStateWithLifecycle()
                val pairingOnboardingState by pairingOnboarding.state.collectAsStateWithLifecycle()
                val appendVoiceTranscript: (String) -> Unit = { transcript ->
                    val currentDraft = chat.state.value.composerText
                    val separator = if (currentDraft.isBlank() || currentDraft.last().isWhitespace()) "" else " "
                    chat.onEvent(ChatEvent.ComposerChanged(currentDraft + separator + transcript.trim()))
                }
                val startVoiceCapture: () -> Unit = {
                    val sessionAtStart = chat.state.value.sessionId
                    voiceController.startVoiceInput { transcript ->
                        if (chat.state.value.sessionId == sessionAtStart) appendVoiceTranscript(transcript)
                    }
                }
                var voicePermissionPending by remember { mutableStateOf(false) }
                val voicePermissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission(),
                ) { granted ->
                    voicePermissionPending = false
                    if (granted) {
                        startVoiceCapture()
                    } else {
                        voiceController.setMessage(getString(WorkbenchR.string.voice_error_microphone_permission))
                    }
                }
                LaunchedEffect(chatState.sessionId) { voiceController.loadSession(chatState.sessionId) }
                LaunchedEffect(demoSignInState.signedInProfile) {
                    val profile = demoSignInState.signedInProfile ?: return@LaunchedEffect
                    accounts.onEvent(AccountsEvent.AccountSessionEstablished(profile))
                    welcomeSuppressedBySignIn = true
                    pairingOnboarding.onEvent(PairingOnboardingEvent.Dismiss)
                    shell.onEvent(AppShellEvent.SelectDestination(AgentoDestination.Home))
                    demoSignIn.consumeSuccess()
                }
                val accountsState by accounts.state.collectAsStateWithLifecycle()
                LaunchedEffect(accountsState.isDemoAccount, accountsState.accountId, accountsState.status) {
                    if (accountsState.isDemoAccount) {
                        demoConnection.activate(requireNotNull(accountsState.accountId))
                    } else if (accountsState.status == com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountStatus.SignedOut ||
                        accountsState.hasVerifiedAccountSession) {
                        demoConnection.deactivate()
                    }
                }

                @Suppress("DEPRECATION")
                val packageInfo = remember {
                    applicationContext.packageManager.getPackageInfo(applicationContext.packageName, 0)
                }
                LaunchedEffect(accountsState.accountProfile?.photoUrl) {
                    accountsState.accountProfile?.photoUrl
                        ?.takeIf { it.startsWith("https://") }
                        ?.let { AvatarImageCache.prefetch(applicationContext, it) }
                }
                val runtimeConnectionState by app.runtime.transport.connectionState.collectAsStateWithLifecycle()
                val temporaryControlActive by app.runtime.temporaryControlActive.collectAsStateWithLifecycle()
                val temporaryControlTargetId = if (temporaryControlActive) app.runtime.temporaryControlInstanceId() else null
                val otherDeviceProjects by app.runtime.otherDeviceProjects.collectAsStateWithLifecycle()
                val backgroundTargetSummaries by app.runtime.backgroundTargetSummaries.collectAsStateWithLifecycle()
                val targetConnectionStates by app.runtime.targetConnectionStates.collectAsStateWithLifecycle()
                LaunchedEffect(runtimeConnectionState, notificationPermissionRequested) {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        runtimeConnectionState.name != "Connected" ||
                        notificationPermissionRequested
                    ) return@LaunchedEffect
                    notificationPermissionRequested = true
                    if (ContextCompat.checkSelfPermission(
                            this@MainActivity,
                            Manifest.permission.POST_NOTIFICATIONS,
                        ) != android.content.pm.PackageManager.PERMISSION_GRANTED
                    ) {
                        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                }
                // A separate first() coroutine can finish before the state collector
                // receives its value. Gate on the actual collected snapshot instead.
                val localStartupFlow = remember(app) {
                    combine(
                        app.runtime.configStore.directory,
                        app.runtime.configStore.accountSession,
                        app.runtime.configStore.pendingGoogleBinding,
                    ) { directory, account, binding -> Triple(directory, account, binding) }
                }
                val localStartup by localStartupFlow.collectAsStateWithLifecycle(initialValue = null)
                val computerDirectory = localStartup?.first ?: com.andysagent.agentoc.core.datastore.ComputerDirectory()
                val currentWorkbenchTargetId = temporaryControlTargetId ?: computerDirectory.activeTargetId
                val tabletDualPane = windowSizeClass.widthSizeClass == androidx.compose.material3.windowsizeclass.WindowWidthSizeClass.Expanded &&
                    androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp.dp -
                        com.andysagent.agentoc.core.designsystem.AgentocSizes.PhoneShell >= 320.dp
                val foregroundChatRepository by app.runtime.sessions.delegate.collectAsStateWithLifecycle()
                val foregroundChatTransport by app.runtime.transport.delegate.collectAsStateWithLifecycle()
                val detailTargetId by tabletChatBinding.targetId.collectAsStateWithLifecycle()
                LaunchedEffect(shellState.chatOpen) {
                    if (!shellState.chatOpen) chat.onEvent(ChatEvent.DiscardUnsentNewSession)
                }
                LaunchedEffect(foregroundChatRepository, foregroundChatTransport, currentWorkbenchTargetId, tabletDualPane, shellState.chatOpen) {
                    chat.preserveSelectedSessionOnRefresh = tabletDualPane && shellState.chatOpen
                    if (!tabletDualPane || !shellState.chatOpen) {
                        tabletChatBinding.bind(foregroundChatRepository, currentWorkbenchTargetId, foregroundChatTransport)
                    }
                }
                LaunchedEffect(tabletDualPane, shellState.chatOpen, detailTargetId) {
                    app.runtime.retainTabletChatTarget(detailTargetId.takeIf { tabletDualPane && shellState.chatOpen })
                }
                val pendingGoogleBinding = localStartup?.third
                val accountSessionMetadata = localStartup?.second
                val directoryLoaded = localStartup != null
                val accountSessionMetadataLoaded = localStartup != null
                LaunchedEffect(runtimeConnectionState, computerDirectory.activeTargetId) {
                    demoConnection.connectionChanged(computerDirectory.activeTargetId, runtimeConnectionState)
                }
                LaunchedEffect(accountSessionMetadataLoaded, accountSessionMetadata?.accountId) {
                    if (accountSessionMetadataLoaded && accountSessionMetadata == null) demoConnection.deactivate()
                }

                LaunchedEffect(currentWorkbenchTargetId) {
                    webParity.onEvent(com.andysagent.agentoc.feature.workbench.WebParityEvent.TargetChanged(currentWorkbenchTargetId))
                }
                LaunchedEffect(detailTargetId) {
                    chatWebParity.onEvent(com.andysagent.agentoc.feature.workbench.WebParityEvent.TargetChanged(detailTargetId))
                }
                LaunchedEffect(runtimeConnectionState, currentWorkbenchTargetId) {
                    if (runtimeConnectionState == RuntimeConnectionState.Connected) {
                        currentWorkbenchTargetId?.let { target ->
                            webParity.onEvent(com.andysagent.agentoc.feature.workbench.WebParityEvent.RefreshAfterReconnect(target))
                        }
                        app.runtime.refreshOtherDeviceProjects()
                    }
                }
                val locallyKnownSignedOut = accountSessionMetadataLoaded && accountSessionMetadata == null
                val cachedAccountStatus = when {
                    locallyKnownSignedOut -> GoogleAccountStatus.SignedOut
                    accountSessionMetadataLoaded && accountSessionMetadata != null -> GoogleAccountStatus.SignedIn
                    else -> accountsState.status
                }
                var startupAccountSessionResolved by remember { mutableStateOf(false) }
                LaunchedEffect(
                    directoryLoaded,
                    accountsState.accountSessionResolved,
                    accountSessionMetadataLoaded,
                    locallyKnownSignedOut,
                ) {
                    // This is a one-time startup gate. Account refreshes can
                    // temporarily become unresolved while the current surface
                    // remains fully usable (notably Settings).
                    startupAccountSessionResolved = updateStartupAccountSessionResolved(
                        directoryLoaded = directoryLoaded,
                        accountSessionResolved = accountsState.accountSessionResolved,
                        alreadyResolved = startupAccountSessionResolved,
                        accountSessionMetadataLoaded = accountSessionMetadataLoaded,
                    )
                }
                val startupOnboardingLoading =
                    !heroDemo && (!directoryLoaded || !startupAccountSessionResolved)
                SideEffect {
                    initialContentGate.update(
                        themeLoaded = storedAppTheme != null,
                        languageLoaded = appLanguageLoaded,
                        entryResolved = !startupOnboardingLoading,
                    )
                }
                val showWelcomeAtLaunch = shouldShowWelcomeAtLaunch(
                    startupOnboardingLoading = startupOnboardingLoading,
                    hasPendingGoogleBinding = pendingGoogleBinding != null,
                    welcomeSuppressedBySignIn = welcomeSuppressedBySignIn,
                    hasLocalComputers = if (cachedAccountStatus == GoogleAccountStatus.SignedIn) {
                        accountComputerLookup == AccountComputerLookup.Available
                    } else computerDirectory.computers.isNotEmpty(),
                    accountStatus = cachedAccountStatus,
                    pairingOpen = pairingOnboardingState.open,
                    temporaryControlActive = temporaryControlActive,
                )
                // New installs begin with the same Google -> QR flow used by the
                // explicit Pair computer action. Existing configured instances
                // are left alone; their normal reconnect state remains authoritative.
                LaunchedEffect(
                    computerDirectory,
                    pendingGoogleBinding,
                    welcomeSuppressedBySignIn,
                    temporaryControlActive,
                    startupOnboardingLoading,
                    accountsState.status,
                    pairingOnboardingState.open,
                ) {
                    if (heroDemo || startupOnboardingLoading) return@LaunchedEffect
                    if (pendingGoogleBinding != null) {
                        pairingOnboarding.onEvent(PairingOnboardingEvent.Open)
                    } else if (showWelcomeAtLaunch) {
                        pairingOnboarding.onEvent(PairingOnboardingEvent.OpenWelcome)
                    }
                }
                LaunchedEffect(pairingOnboarding) {
                    if (heroDemo) return@LaunchedEffect
                    val pending = runCatching {
                        withContext(Dispatchers.IO) { app.runtime.temporaryAccess.latestRecoverableInstanceId() }
                    }.getOrNull()
                    pending?.let { pairingOnboarding.onEvent(PairingOnboardingEvent.ResumeTemporaryPairing(it)) }
                }
                // External scanners reuse the phone's existing Accounts session.
                // The pairing operation still verifies its credential before it
                // can authorize this computer; metadata only selects the UI path.
                LaunchedEffect(pendingPairingUri, accountSessionMetadataLoaded) {
                    if (heroDemo) {
                        Log.i("PairingIntake", "Ignored pair URI in design preview")
                        return@LaunchedEffect
                    }
                    pendingPairingUri?.let { uri ->
                        // A v4 desktop account handoff establishes the phone's
                        // first Accounts session itself. Start it immediately;
                        // waiting on unrelated local startup stores can consume
                        // the QR's short validity window before the claim begins.
                        val waitForAccountSessionMetadata = shouldWaitForAccountSessionMetadataBeforePairing(
                            pairingUri = uri,
                            accountSessionMetadataLoaded = accountSessionMetadataLoaded,
                        )
                        Log.i("PairingIntake", "Pair URI effect; metadataLoaded=$accountSessionMetadataLoaded waitingForMetadata=$waitForAccountSessionMetadata")
                        if (waitForAccountSessionMetadata) {
                            Log.i("PairingIntake", "Deferred legacy pair URI until local account metadata loads")
                            return@let
                        }
                        pairingOnboarding.onEvent(PairingOnboardingEvent.Open)
                        pairingOnboarding.onEvent(PairingOnboardingEvent.PairingUriReceived(uri))
                        Log.i("PairingIntake", "Pair URI dispatched; step=${pairingOnboarding.state.value.step}")
                        if (shouldReuseStoredAccountSession(
                                accounts.state.value.hasVerifiedAccountSession,
                                accountSessionMetadataLoaded,
                                accountSessionMetadata != null,
                            )) {
                            pairingOnboarding.onEvent(PairingOnboardingEvent.AccountSessionReady)
                        }
                        pendingPairingUri = null
                    }
                }
                LaunchedEffect(accounts, currentWorkbenchTargetId, runtimeConnectionState) {
                    accounts.onEvent(
                        AccountsEvent.ConnectionChanged(
                            state = runtimeConnectionState,
                            targetSelected = currentWorkbenchTargetId != null,
                        ),
                    )
                }
                LaunchedEffect(accountsState.hasVerifiedAccountSession, accountsState.accountId, accountsState.status) {
                    if (!accountsState.hasVerifiedAccountSession) {
                        accountDirectoryGeneration++
                        accountDirectoryDevices = emptyList()
                        discoveredComputers = emptyList()
                        accountComputerLookup = if (accountsState.status == GoogleAccountStatus.VerificationUnavailable) {
                            AccountComputerLookup.Failed
                        } else AccountComputerLookup.Loading
                        return@LaunchedEffect
                    }
                    try { refreshAccountDirectory(app) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* The current request owns its failure projection. */ }
                }
                LaunchedEffect(accountComputerLookup, accountsState.hasVerifiedAccountSession,
                    pairingOnboardingState.step, pairingOnboardingState.open) {
                    if (accountsState.hasVerifiedAccountSession &&
                        accountComputerLookup == AccountComputerLookup.Available &&
                        !welcomeSuppressedBySignIn &&
                        (!pairingOnboardingState.open || pairingOnboardingState.step == PairingOnboardingStep.Welcome)) {
                        welcomeSuppressedBySignIn = true
                        pairingOnboarding.onEvent(PairingOnboardingEvent.Dismiss)
                        shell.onEvent(AppShellEvent.SelectDestination(AgentoDestination.Home))
                    }
                }
                val localRemoteTargets = computerDirectory.computers.map { computer ->
                    RemoteTarget(
                        instanceId = computer.instanceId,
                        label = computer.label.ifBlank { computer.instanceId },
                        endpoint = computer.endpoint,
                        platform = computer.platform,
                        accessState = runCatching { RemoteTargetAccessState.valueOf(computer.accessState) }
                            .getOrDefault(RemoteTargetAccessState.Unavailable),
                        lastSeenAt = computer.lastSeenAt,
                        lastSelectedAt = computer.lastSelectedAt,
                    )
                }
                val accountRemoteTargets = accountDirectoryDevices.toRemoteTargets(computerDirectory.computers)
                val visibleRemoteTargets = if (temporaryControlTargetId != null) listOf(RemoteTarget(
                    instanceId = temporaryControlTargetId, label = getString(R.string.temporary_control_computer), endpoint = "",
                    accessState = RemoteTargetAccessState.Connected,
                )) else deviceSurfaceTargets(
                    hasVerifiedAccountSession = accountsState.hasVerifiedAccountSession,
                    accountTargets = accountRemoteTargets,
                    localTargets = localRemoteTargets,
                    sessionComputers = computerState.computers,
                )
                val state = WorkbenchUiState(
                    destination = shellState.destination,
                    settingsPage = shellState.settingsPage,
                    settingsParentPage = shellState.settingsBackStack.lastOrNull() ?: SettingsPage.Overview,
                    chatOpen = shellState.chatOpen,
                    agentOpen = shellState.agentOpen,
                    sessionSearchQuery = shellState.sessionSearchQuery,
                    connection = shellState.connection,
                    chatConnection = chatState.connection,
                    chatTargetId = detailTargetId,
                    runStatus = chatState.runStatus,
                    stopRequest = chatState.stopRequest,
                    currentAction = chatState.currentAction,
                    serverRunActivity = chatState.serverRunActivity,
                    sessionTitle = chatState.sessionTitle,
                    timelineItems = chatState.timelineItems,
                    pendingTurn = chatState.pendingTurn,
                    acceptedTurns = chatState.acceptedTurns,
                    composerText = chatState.composerText,
                    harnessCapabilities = chatState.harnessCapabilities,
                    selectedHarnessCapabilities = chatState.selectedHarnessCapabilities,
                    harnessCapabilitiesLoading = chatState.harnessCapabilitiesLoading,
                    harnessCapabilitiesError = chatState.harnessCapabilitiesError,
                    messageCount = chatState.messageCount,
                    unseenCount = chatState.unseenCount,
                    sessionId = chatState.sessionId,
                    historyLoading = chatState.historyLoading,
                    timelineSessionId = chatState.timelineSessionId,
                    selectedAgentId = chatState.selectedAgentId,
                    approval = chatState.approval,
                    approvalResolving = chatState.resolvingApprovalId != null,
                    runtimeTool = chatState.runtimeTool,
                    runtimeProvider = chatState.runtimeProvider,
                    runtimeModel = chatState.runtimeModel,
                    runtimeCatalog = chatState.runtimeCatalog,
                    runtimeSelectionDisplay = chatState.runtimeSelectionDisplay,
                    runtimeModelsLoading = chatState.runtimeModelsLoading,
                    runtimeModelsError = chatState.runtimeModelsError,
                    runtimeUnavailable = chatState.runtimeUnavailable,
                    runtimeResolving = chatState.runtimeResolving,
                    serviceTier = chatState.serviceTier,
                    runtimePickerOpen = chatState.runtimePickerOpen,
                    sessionMenuOpen = chatState.sessionMenuOpen,
                    sessionActionInProgress = chatState.sessionActionInProgress,
                    thinkingEffort = chatState.thinkingEffort,
                    selectedEffort = chatState.selectedEffort,
                    effortPickerOpen = chatState.effortPickerOpen,
                    goalMode = chatState.goalMode,
                    goalText = chatState.goalText,
                    autoContinue = chatState.autoContinue,
                    runMetrics = chatState.runMetrics,
                    runDurations = chatState.runDurations,
                    stepTraces = chatState.stepTraces,
                    changedFiles = chatState.changedFiles,
                    queuedMessages = chatState.queuedMessages,
                    activeDecision = chatState.activeDecision,
                    goalDialogOpen = chatState.goalDialogOpen,
                    isLoading = chatState.isLoading,
                    loadingOlder = chatState.loadingOlder,
                    hasOlder = chatState.hasOlder,
                    error = chatState.error ?: listActionState.error ?: projectState.error ?: computerState.error,
                    computers = computerState.computers,
                    projects = projectState.projects,
                    sessions = projectState.sessions,
                    projectCatalogLoading = !projectState.hydrated,
                    projectCatalogRefreshing = projectState.refreshing,
                    selectedProjectId = projectState.selectedProjectId,
                    projectSessionsOpen = shellState.projectSessionsOpen,
                    browsingProjectId = shellState.browsingProjectId,
                    projectOrigin = shellState.projectOrigin,
                    pairingOpen = computerState.pairingOpen,
                    pairingUri = computerState.pairingUri,
                    pairingDeviceName = computerState.pairingDeviceName,
                    pairingInProgress = computerState.pairingInProgress,
                    projectDialogOpen = projectState.projectDialogOpen,
                    projectName = projectState.projectName,
                    projectRootPath = projectState.projectRootPath,
                    projectFolderParentPath = projectState.projectFolderParentPath,
                    projectFolderChildren = projectState.projectFolderChildren,
                    projectFoldersLoading = projectState.projectFoldersLoading,
                    projectFolderError = projectState.projectFolderError,
                    projectFolderCreateOpen = projectState.projectFolderCreateOpen,
                    projectFolderName = projectState.projectFolderName,
                    projectFolderCreating = projectState.projectFolderCreating,
                    projectInProgress = projectState.projectInProgress,
                    remoteTargets = visibleRemoteTargets,
                    otherDeviceProjects = otherDeviceProjects,
                    accountComputers = if (accountsState.hasVerifiedAccountSession) {
                        accountRemoteTargets
                    } else {
                        mergeAccountComputers(
                            linked = computerDirectory.computers,
                            discovered = discoveredComputers,
                        )
                    },
                    activeRemoteTargetId = currentWorkbenchTargetId,
                    remoteTargetConnectionStates = targetConnectionStates,
                    backgroundTargetSummaries = backgroundTargetSummaries
                        .filterKeys { it != computerDirectory.activeTargetId }
                        .values
                        .sortedBy { it.targetId },
                    appTheme = appTheme,
                    appLanguage = appLanguage,
                    appVersion = packageInfo.versionName ?: "Unknown",
                    appBuild = if (Build.VERSION.SDK_INT >= 28) {
                        packageInfo.longVersionCode.toString()
                    } else {
                        @Suppress("DEPRECATION")
                        packageInfo.versionCode.toString()
                    },
                    voice = voiceState,
                )
                LaunchedEffect(
                    state.chatTargetId,
                    state.accountComputers.map { it.instanceId },
                    state.remoteTargets.map { it.instanceId },
                    state.remoteTargetConnectionStates,
                ) {
                    voiceController.refreshCloudUsage()
                }
                // The session currently on screen never surfaces as a global
                // attention popup; its approvals stay in the timeline card.
                LaunchedEffect(state.chatOpen, state.sessionId, detailTargetId, currentWorkbenchTargetId, tabletDualPane) {
                    attention.onEvent(
                        AttentionEvent.SetVisibleSession(if (state.chatOpen &&
                            (!tabletDualPane || detailTargetId == currentWorkbenchTargetId)) state.sessionId else null),
                    )
                }
                val computerRecovery = remember(state.chatConnection, state.chatTargetId, currentWorkbenchTargetId) {
                    if (state.chatConnection == AgentConnectionStatus.Reconnecting) {
                        com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionUiState(
                            active = true,
                            phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Reconnecting,
                            targetId = state.chatTargetId ?: currentWorkbenchTargetId,
                        )
                    } else null
                }
                if (pendingSessionNavigation?.targetInstanceId == null && pendingSessionNavigation != null || sessionNavigationError != null) {
                    SessionNavigationDialog(
                        error = sessionNavigationError,
                        computers = computerDirectory.computers,
                        choose = { target -> pendingSessionNavigation = pendingSessionNavigation?.copy(targetInstanceId = target); sessionNavigationError = null },
                        dismiss = { pendingSessionNavigation = null; sessionNavigationError = null },
                    )
                }
                com.andysagent.agentoc.feature.workbench.DemoEnvironmentSurface(
                    restricted = accountsState.isRestrictedDemoAccount,
                    testAccount = accountsState.isDemoAccount,
                    connection = demoConnectionState,
                    onRetryConnection = demoConnection::retry,
                    computerRecovery = computerRecovery,
                    onRetryComputerRecovery = {
                        app.runtime.retryComputerConnection(computerRecovery?.targetId ?: currentWorkbenchTargetId)
                    },
                    onSignOut = {
                        runtimeScope.launch {
                            try { app.runtime.logoutAccountSession() }
                            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                            catch (_: Exception) { requestError = getString(WorkbenchR.string.demo_connection_sign_out_failed) }
                            finally { accounts.onEvent(AccountsEvent.Refresh) }
                        }
                    },
                ) {
                WorkbenchScreen(
                    state = com.andysagent.agentoc.feature.workbench.restrictDemoWorkbenchState(state, accountsState.isRestrictedDemoAccount),
                    accountsViewModel = accounts,
                    webParityViewModel = webParity,
                    chatWebParityViewModel = if (tabletDualPane) chatWebParity else webParity,
                    brokerEnrollmentController = windowsBrokerController,
                    pairingOnboardingState = pairingOnboardingState.takeIf { it.open },
                    onPairingOnboardingEvent = pairingOnboarding::onEvent,
                    subscriptionInfoOpen = subscriptionInfoOpen,
                    onCloseSubscriptionInfo = { subscriptionInfoOpen = false },
                    onRequestGoogleSignIn = { request ->
                        requestError = null
                        if (!accounts.state.value.hasVerifiedAccountSession) {
                            pendingGoogleSignIn = request
                        } else {
                            runtimeScope.launch {
                                runCatching { app.runtime.ensureAccountSession() }
                                    .onSuccess {
                                        accounts.onEvent(AccountsEvent.Refresh)
                                        when (request) {
                                            GoogleSignInRequest.PairComputer,
                                            GoogleSignInRequest.PairComputerFromWelcome -> {
                                                pairingOnboarding.onEvent(PairingOnboardingEvent.AccountSessionReady)
                                                // This route is also used by the signed-in welcome's
                                                // "Try direct connection" action. A successfully
                                                // refreshed session should continue straight into
                                                // account discovery; the success interstitial is only
                                                // useful after a fresh Google challenge.
                                            }
                                            GoogleSignInRequest.ManageDevices -> {
                                                refreshAccountDirectory(app)
                                            }
                                            GoogleSignInRequest.Account -> Unit
                                        }
                                    }
                                    .onFailure {
                                        // The authoritative source clears a rejected
                                        // session and removes any cached profile before
                                        // Google is offered again.
                                        accounts.onEvent(AccountsEvent.Refresh)
                                        // Explicitly enter the v2 challenge flow only
                                        // after signed refresh says this session cannot
                                        // be reused. Never silently pass a Google token
                                        // to a target computer.
                                        pendingGoogleSignIn = request
                                    }
                            }
                        }
                    },
                    onRequestBrowserSignIn = { request ->
                        requestError = null
                        browserSignInRequest = request
                    },
                    onRequestDemoSignIn = demoSignIn::open,
                    onRequestComputerDiscovery = {
                        requestError = null
                        runtimeScope.launch {
                            val hasStoredAccountSession = runCatching {
                                app.runtime.configStore.accountSession.first() != null
                            }.getOrElse { error ->
                                requestError = error.message ?: "Could not read the account session."
                                return@launch
                            }
                            val canReuseAccountSession = shouldReuseStoredAccountSession(
                                hasVerifiedAccountSession = accounts.state.value.hasVerifiedAccountSession,
                                // Read the DataStore flow above in this coroutine so a
                                // first-render null cannot be mistaken for sign-out.
                                accountSessionMetadataLoaded = true,
                                hasStoredAccountSession = hasStoredAccountSession,
                            )
                            if (!canReuseAccountSession) {
                                pendingGoogleSignIn = GoogleSignInRequest.ManageDevices
                                return@launch
                            }
                            runCatching {
                                app.runtime.ensureAccountSession()
                                refreshAccountDirectory(app)
                            }.onFailure { error ->
                                accounts.onEvent(AccountsEvent.Refresh)
                                if (isAccountReauthorizationFailure(error)) {
                                    pendingGoogleSignIn = GoogleSignInRequest.ManageDevices
                                } else {
                                    requestError = error.message ?: "Could not load computers."
                                }
                            }
                        }
                    },
                    googleSignInSuccess = googleSignInSuccess,
                    startupOnboardingLoading = startupOnboardingLoading,
                    showWelcomeAtLaunch = !heroDemo && showWelcomeAtLaunch,
                    welcomeSignedIn = cachedAccountStatus == GoogleAccountStatus.SignedIn,
                    welcomeComputerLookup = accountComputerLookup.takeUnless { welcomeSuppressedBySignIn },
                    connectingTargetId = pendingComputerConnectionId,
                    onSkipWelcome = {
                        welcomeSuppressedBySignIn = true
                        pairingOnboarding.onEvent(PairingOnboardingEvent.Dismiss)
                        // Launch onboarding is a transient layer. Never return a
                        // skipped user to whatever settings subpage happened to
                        // be open before it; Home is the app's stable landing page.
                        shell.onEvent(AppShellEvent.SelectDestination(AgentoDestination.Home))
                    },
                    onGoogleSignInSuccessAction = { action ->
                        when (action) {
                            GoogleSignInSuccessAction.ConnectComputer -> {
                                googleSignInSuccess = null
                                pairingOnboarding.onEvent(PairingOnboardingEvent.StartComputerConnection)
                            }
                            GoogleSignInSuccessAction.OpenSignedInWelcome,
                            GoogleSignInSuccessAction.EnterApp -> {
                                googleSignInSuccess = null
                                welcomeSuppressedBySignIn = false
                                pairingOnboarding.onEvent(PairingOnboardingEvent.OpenWelcome)
                                shell.onEvent(AppShellEvent.SelectDestination(AgentoDestination.Home))
                            }
                        }
                    },
                    onGoogleSignInSuccessBack = {
                        val completedRequest = googleSignInSuccess
                        googleSignInSuccess = null
                        if (completedRequest == GoogleSignInRequest.PairComputer ||
                            completedRequest == GoogleSignInRequest.PairComputerFromWelcome ||
                            pairingOnboardingState.step == com.andysagent.agentoc.feature.workbench.PairingOnboardingStep.GoogleRequired
                        ) {
                            pairingOnboarding.onEvent(PairingOnboardingEvent.GoogleSignInCancelled)
                        }
                    },
                    onScanPairing = {
                        startPairingScan(pairingOnboarding, returnToWelcomeOnFailure = false)
                    },
                    onScanPairingFromWelcome = {
                        startPairingScan(pairingOnboarding, returnToWelcomeOnFailure = true)
                    },
                    onSetUpComputer = {
                        pendingPairingScanFromWelcome = true
                    },
                    onOpenSubscription = {
                        subscriptionInfoOpen = true
                    },
                    windowSizeClass = when (windowSizeClass.widthSizeClass) {
                        androidx.compose.material3.windowsizeclass.WindowWidthSizeClass.Expanded -> AgentoWindowSizeClass.Expanded
                        androidx.compose.material3.windowsizeclass.WindowWidthSizeClass.Medium -> AgentoWindowSizeClass.Medium
                        else -> AgentoWindowSizeClass.Compact
                    },
                    onEvent = eventHandler@{ event ->
                        when (event) {
                            WorkbenchEvent.OpenComputerSetup -> pendingPairingScanFromWelcome = false
                            is WorkbenchEvent.SelectDestination -> shell.onEvent(AppShellEvent.SelectDestination(event.destination, keepChat = tabletDualPane))
                            is WorkbenchEvent.OpenSettingsPage -> {
                                shell.onEvent(AppShellEvent.OpenSettingsPage(event.page, keepChat = tabletDualPane))
                                if (event.page == SettingsPage.ComputerManagement && accounts.state.value.hasVerifiedAccountSession) {
                                    runtimeScope.launch { runCatching { refreshAccountDirectory(app) } }
                                }
                                if (event.page == SettingsPage.Voice) {
                                    voiceController.refreshCloudUsage()
                                }
                            }
                            WorkbenchEvent.CloseSettingsPage -> shell.onEvent(AppShellEvent.CloseSettingsPage)
                            WorkbenchEvent.OpenAppApiSettings -> startActivity(Intent(this@MainActivity, AppApiSettingsActivity::class.java))
                            WorkbenchEvent.ToggleVoiceInput -> {
                                if (voiceState.recording || voiceState.processing) {
                                    voiceController.stopVoiceInput()
                                } else if (ContextCompat.checkSelfPermission(
                                        this@MainActivity,
                                        Manifest.permission.RECORD_AUDIO,
                                    ) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                                    startVoiceCapture()
                                } else if (!voicePermissionPending) {
                                    voicePermissionPending = true
                                    voicePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                                }
                            }
                            WorkbenchEvent.CancelVoiceInput -> voiceController.cancelVoiceInput()
                            WorkbenchEvent.AcceptCloudVoiceConsent -> voiceController.acceptCloudVoiceConsent()
                            WorkbenchEvent.DeclineCloudVoiceConsent -> voiceController.declineCloudVoiceConsent()
                            WorkbenchEvent.RevokeCloudVoiceConsent -> voiceController.revokeCloudVoiceConsent()
                            is WorkbenchEvent.VoiceTranscriptionReceived -> appendVoiceTranscript(event.text)
                            is WorkbenchEvent.ReportAgentContent -> contentReports.open(event.text)
                            is WorkbenchEvent.SelectTheme -> {
                                shell.onEvent(AppShellEvent.SelectTheme(event.theme))
                                runtimeScope.launch { app.runtime.configStore.setAppTheme(event.theme) }
                            }
                            is WorkbenchEvent.SelectLanguage -> {
                                shell.onEvent(AppShellEvent.SelectLanguage(event.language))
                                runtimeScope.launch { app.runtime.configStore.setAppLanguage(event.language) }
                            }
                            is WorkbenchEvent.SelectRemoteTarget -> {
                                runtimeScope.launch {
                                    val linked = computerDirectory.computers
                                        .any { it.instanceId == event.instanceId }
                                    if (linked) {
                                        runCatching { app.runtime.selectTarget(event.instanceId) }
                                            .onFailure { error ->
                                                requestError = error.message ?: "Could not switch computers."
                                            }
                                    } else {
                                        pendingComputerConnectionId = event.instanceId
                                        pendingComputerConnectionIsPrimary = true
                                        val hasStoredAccountSession = runCatching {
                                            app.runtime.configStore.accountSession.first() != null
                                        }.getOrDefault(false)
                                        if (!hasStoredAccountSession) {
                                            pendingGoogleSignIn = GoogleSignInRequest.ManageDevices
                                        } else {
                                            runCatching {
                                                app.runtime.ensureAccountSession()
                                                app.runtime.pairFromAccountComputer(
                                                    event.instanceId,
                                                    app.runtime.accountDeviceAlias,
                                                )
                                            }.onSuccess {
                                                pendingComputerConnectionId = null
                                                accounts.onEvent(AccountsEvent.Refresh)
                                                refreshAccountDirectory(app)
                                            }.onFailure { error ->
                                                pendingComputerConnectionId = null
                                                reportComputerConnectionFailure(error)
                                            }
                                        }
                                    }
                                }
                            }
                            is WorkbenchEvent.ConnectRemoteTarget -> {
                                if (pendingComputerConnectionId != null) return@eventHandler
                                val linkedTarget = computerDirectory.computers.firstOrNull { it.instanceId == event.instanceId }
                                // A target without a reusable local connection is
                                // still an account-owned computer. Re-run the
                                // signed Accounts rendezvous instead of treating
                                // directory metadata as a target credential.
                                if (shouldUseExistingComputerTarget(
                                        linkedTarget,
                                        accountDirectoryMode = accounts.state.value.hasVerifiedAccountSession,
                                    )) {
                                    runtimeScope.launch { runCatching { app.runtime.selectTarget(event.instanceId) } }
                                } else {
                                    pendingComputerConnectionId = event.instanceId
                                    pendingComputerConnectionIsPrimary =
                                        computerDirectory.activeTarget?.instanceId == event.instanceId
                                    requestError = null
                                    computerConnectionError = null
                                    runtimeScope.launch {
                                        val hasStoredAccountSession = runCatching {
                                            app.runtime.configStore.accountSession.first() != null
                                        }.getOrElse { error ->
                                            pendingComputerConnectionId = null
                                            pendingComputerConnectionIsPrimary = true
                                            requestError = error.message ?: "Could not read the account session."
                                            return@launch
                                        }
                                        val canReuseAccountSession = shouldReuseStoredAccountSession(
                                            hasVerifiedAccountSession = accounts.state.value.hasVerifiedAccountSession,
                                            // Read the DataStore flow above in this coroutine so a
                                            // first-render null cannot be mistaken for sign-out.
                                            accountSessionMetadataLoaded = true,
                                            hasStoredAccountSession = hasStoredAccountSession,
                                        )
                                        if (!canReuseAccountSession) {
                                            // Authentication must resume the exact computer
                                            // the user chose, not silently refresh the directory.
                                            pendingGoogleSignIn = GoogleSignInRequest.ManageDevices
                                            return@launch
                                        }
                                        runCatching {
                                            // Verify the persisted rac_ before
                                            // using the account rendezvous. The
                                            // VM can still be in its first
                                            // refresh here, so a non-null local
                                            // session is the correct signal to
                                            // attempt reuse instead of showing
                                            // a false login prompt.
                                            app.runtime.ensureAccountSession()
                                            if (pendingComputerConnectionIsPrimary) {
                                                app.runtime.pairFromAccountComputer(
                                                    event.instanceId,
                                                    app.runtime.accountDeviceAlias,
                                                )
                                            } else {
                                                app.runtime.connectAccountComputerInBackground(
                                                    event.instanceId,
                                                    app.runtime.accountDeviceAlias,
                                                )
                                                // A signed rendezvous only starts the carrier. Keep the
                                                // connecting state until this exact target is usable.
                                                app.runtime.awaitBackgroundComputerConnected(event.instanceId)
                                            }
                                        }.onSuccess {
                                            pendingComputerConnectionId = null
                                            pendingComputerConnectionIsPrimary = true
                                            accounts.onEvent(AccountsEvent.Refresh)
                                            refreshAccountDirectory(app)
                                        }.onFailure { error ->
                                            pendingComputerConnectionId = null
                                            pendingComputerConnectionIsPrimary = true
                                            accounts.onEvent(AccountsEvent.Refresh)
                                            reportComputerConnectionFailure(error)
                                        }
                                    }
                                }
                            }
                            is WorkbenchEvent.DisconnectRemoteTarget -> {
                                runtimeScope.launch {
                                    runCatching { app.runtime.disconnectTarget(event.instanceId) }
                                        .onFailure { error ->
                                            requestError = error.message ?: "Could not disconnect the computer."
                                        }
                                }
                            }
                            WorkbenchEvent.OpenAgents -> shell.onEvent(AppShellEvent.OpenAgents(keepChat = tabletDualPane))
                            WorkbenchEvent.CloseAgents -> shell.onEvent(AppShellEvent.CloseAgents)
                            is WorkbenchEvent.OpenNewSession -> {
                                runtimeScope.launch {
                                    val foreground = app.runtime.sessions.delegate.value
                                    if (foreground == null || foreground.runtimeTargetId != currentWorkbenchTargetId) return@launch
                                    tabletChatBinding.bind(foreground, currentWorkbenchTargetId, app.runtime.transport.delegate.value)
                                    shell.onEvent(AppShellEvent.OpenChat)
                                    chat.onEvent(ChatEvent.CreateSession(event.projectId))
                                }
                            }
                            WorkbenchEvent.CloseChat -> {
                                chat.onEvent(ChatEvent.DiscardUnsentNewSession)
                                shell.onEvent(AppShellEvent.CloseChat)
                            }
                            is WorkbenchEvent.SessionSearchChanged -> shell.onEvent(AppShellEvent.SessionSearchChanged(event.value))
                            is WorkbenchEvent.OpenProjectSessions -> {
                                projects.onEvent(ProjectsEvent.SelectProject(event.projectId))
                                shell.onEvent(AppShellEvent.OpenProjectSessions(event.projectId, keepChat = tabletDualPane))
                            }
                            is WorkbenchEvent.OpenOtherDeviceProject -> {
                                runtimeScope.launch {
                                    runCatching { app.runtime.selectTarget(event.targetId) }
                                        .onSuccess {
                                            projects.onEvent(ProjectsEvent.SelectProject(event.projectId))
                                            shell.onEvent(AppShellEvent.OpenProjectSessions(event.projectId, keepChat = tabletDualPane))
                                        }
                                        .onFailure { error ->
                                            requestError = error.message ?: "Could not open the project."
                                        }
                                }
                            }
                            WorkbenchEvent.CloseProjectSessions -> shell.onEvent(AppShellEvent.CloseProjectSessions)
                            is WorkbenchEvent.ComposerChanged -> chat.onEvent(ChatEvent.ComposerChanged(event.text))
                            is WorkbenchEvent.AddHarnessCapability -> chat.onEvent(ChatEvent.AddHarnessCapability(event.capability))
                            is WorkbenchEvent.RemoveHarnessCapability -> chat.onEvent(ChatEvent.RemoveHarnessCapability(event.id))
                            WorkbenchEvent.SendMessage -> chat.onEvent(ChatEvent.SendMessage)
                            WorkbenchEvent.RetryPendingTurn -> chat.onEvent(ChatEvent.RetryPendingTurn)
                            is WorkbenchEvent.SelectAgent -> chat.onEvent(ChatEvent.SelectAgent(event.agentId))
                            is WorkbenchEvent.AddAttachment -> chat.onEvent(ChatEvent.AddAttachment(event.attachment))
                            WorkbenchEvent.CancelRun -> chat.onEvent(ChatEvent.CancelRun)
                            WorkbenchEvent.OpenRuntimePicker -> chat.onEvent(ChatEvent.OpenRuntimePicker)
                            WorkbenchEvent.CloseRuntimePicker -> chat.onEvent(ChatEvent.CloseRuntimePicker)
                            is WorkbenchEvent.SelectRuntime -> chat.onEvent(ChatEvent.SelectRuntime(event.tool))
                            is WorkbenchEvent.SelectProvider -> chat.onEvent(ChatEvent.SelectProvider(event.provider))
                            is WorkbenchEvent.SelectModel -> chat.onEvent(ChatEvent.SelectModel(event.model))
                            is WorkbenchEvent.SelectServiceTier -> chat.onEvent(ChatEvent.SelectServiceTier(event.tier))
                            WorkbenchEvent.OpenEffortPicker -> chat.onEvent(ChatEvent.OpenEffortPicker)
                            WorkbenchEvent.CloseEffortPicker -> chat.onEvent(ChatEvent.CloseEffortPicker)
                            is WorkbenchEvent.EffortChanged -> chat.onEvent(ChatEvent.EffortChanged(event.effort))
                            WorkbenchEvent.DismissRuntimeUnavailable -> chat.onEvent(ChatEvent.DismissRuntimeUnavailable)
                            is WorkbenchEvent.ToggleGoalMode -> chat.onEvent(ChatEvent.ToggleGoalMode(event.enabled))
                            is WorkbenchEvent.TogglePlanMode -> chat.onEvent(ChatEvent.TogglePlanMode(event.enabled))
                            is WorkbenchEvent.GoalChanged -> chat.onEvent(ChatEvent.GoalChanged(event.goal))
                            WorkbenchEvent.OpenGoalDialog -> chat.onEvent(ChatEvent.OpenGoalDialog)
                            WorkbenchEvent.CloseGoalDialog -> chat.onEvent(ChatEvent.CloseGoalDialog)
                            is WorkbenchEvent.SaveGoal -> chat.onEvent(ChatEvent.SaveGoal(event.goal))
                            WorkbenchEvent.ClearGoal -> chat.onEvent(ChatEvent.ClearGoal)
                            is WorkbenchEvent.StartAutoContinue -> chat.onEvent(ChatEvent.StartAutoContinue(event.goal))
                            WorkbenchEvent.PauseAutoContinue -> chat.onEvent(ChatEvent.PauseAutoContinue)
                            WorkbenchEvent.OpenSessionMenu -> chat.onEvent(ChatEvent.OpenSessionMenu)
                            WorkbenchEvent.CloseSessionMenu -> chat.onEvent(ChatEvent.CloseSessionMenu)
                            is WorkbenchEvent.RenameSession -> chat.onEvent(ChatEvent.RenameSession(event.name))
                            WorkbenchEvent.DeleteSession -> chat.onEvent(ChatEvent.DeleteSession)
                            is WorkbenchEvent.PrepareListedSessionAction -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.PrepareListedSessionAction(event.sessionId))
                            }
                            is WorkbenchEvent.RenameListedSession -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.RenameListedSession(event.sessionId, event.name))
                            }
                            is WorkbenchEvent.DeleteListedSession -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.DeleteListedSession(event.sessionId))
                            }
                            is WorkbenchEvent.PinListedSession -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.PinListedSession(event.sessionId, event.pinned))
                            }
                            is WorkbenchEvent.PrepareListedProjectAction -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.PrepareListedProjectAction(event.projectId))
                            }
                            is WorkbenchEvent.RenameListedProject -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.RenameListedProject(event.projectId, event.name))
                            }
                            is WorkbenchEvent.PinListedProject -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.PinListedProject(event.projectId, event.pinned))
                            }
                            is WorkbenchEvent.DeleteListedProject -> if (event.targetId == currentWorkbenchTargetId) {
                                listActions.onEvent(ChatEvent.DeleteListedProject(event.projectId, event.deleteSessions))
                            }
                            WorkbenchEvent.CompactSession -> chat.onEvent(ChatEvent.CompactSession)
                            WorkbenchEvent.DropTools -> chat.onEvent(ChatEvent.DropTools)
                            WorkbenchEvent.ForkSession -> chat.onEvent(ChatEvent.ForkSession)
                            is WorkbenchEvent.ForkFromMessage -> chat.onEvent(ChatEvent.ForkFromMessage(event.anchorSeq, event.mode))
                            is WorkbenchEvent.RegenerateMessage -> chat.onEvent(ChatEvent.RegenerateMessage(event.requestId))
                            is WorkbenchEvent.SubmitEditTurn -> chat.onEvent(ChatEvent.SubmitEditTurn(event.requestId, event.text, event.attachments))
                            is WorkbenchEvent.ResendQueuedMessage -> chat.onEvent(ChatEvent.ResendQueuedMessage(event.messageId, event.text, event.attachments))
                            is WorkbenchEvent.RemoveQueuedMessage -> chat.onEvent(ChatEvent.RemoveQueuedMessage(event.messageId))
                            is WorkbenchEvent.SteerMessage -> chat.onEvent(ChatEvent.SteerMessage(event.messageId))
                            is WorkbenchEvent.SelectDecisionOption -> chat.onEvent(ChatEvent.SelectDecisionOption(event.questionId, event.optionIndex, event.questionIndex))
                            is WorkbenchEvent.DecisionWriteInChanged -> chat.onEvent(ChatEvent.DecisionWriteInChanged(event.questionId, event.text, event.questionIndex))
                            is WorkbenchEvent.SubmitDecision -> chat.onEvent(ChatEvent.SubmitDecision(event.questionId))
                            is WorkbenchEvent.SelectApprovalAction -> chat.onEvent(ChatEvent.SelectApprovalAction(event.approvalId, event.actionId, event.selected))
                            is WorkbenchEvent.Approve -> chat.onEvent(ChatEvent.Approve(event.approvalId))
                            is WorkbenchEvent.Deny -> chat.onEvent(ChatEvent.Deny(event.approvalId))
                            is WorkbenchEvent.PlanAction -> chat.onEvent(ChatEvent.PlanAction(event.planId, event.action))
                    is WorkbenchEvent.SelectSession -> {
                                runtimeScope.launch {
                                    val foreground = app.runtime.sessions.delegate.value
                                    if (foreground == null || foreground.runtimeTargetId != currentWorkbenchTargetId) return@launch
                                    tabletChatBinding.bind(foreground, currentWorkbenchTargetId, app.runtime.transport.delegate.value)
                                    shell.onEvent(AppShellEvent.OpenChat)
                                    chat.onEvent(ChatEvent.SelectSession(event.sessionId))
                                }
                            }
                            WorkbenchEvent.LoadOlderTimeline -> chat.onEvent(ChatEvent.LoadOlderTimeline)
                            is WorkbenchEvent.MarkSessionRead -> projects.onEvent(ProjectsEvent.MarkSessionRead(event.sessionId))
                            WorkbenchEvent.RefreshHome -> {
                                projects.onEvent(ProjectsEvent.Refresh)
                                computers.onEvent(ComputersEvent.Retry)
                                runtimeScope.launch {
                                    runCatching { app.runtime.refreshOtherDeviceProjects() }
                                }
                            }
                            WorkbenchEvent.Retry -> {
                                app.runtime.retryActiveConnection()
                                if (!tabletDualPane || !shellState.chatOpen) chat.onEvent(ChatEvent.Retry)
                                projects.onEvent(ProjectsEvent.Retry)
                                computers.onEvent(ComputersEvent.Retry)
                            }
                            WorkbenchEvent.RetryChat -> {
                                app.runtime.retryComputerConnection(detailTargetId)
                                chat.onEvent(ChatEvent.Retry)
                            }
                            WorkbenchEvent.DismissError -> {
                                // Workbench renders the first error from three
                                // sources.  Dismissing the shared banner must
                                // clear all of them; otherwise the card stays
                                // composed (with only its shadow visible after
                                // a swipe) because a lower-priority source is
                                // still reporting the same failure.
                                chat.onEvent(ChatEvent.DismissError)
                                listActions.onEvent(ChatEvent.DismissError)
                                projects.onEvent(ProjectsEvent.DismissError)
                                computers.onEvent(ComputersEvent.DismissError)
                            }
                            WorkbenchEvent.OpenPairing -> pairingOnboarding.onEvent(
                                pairingEntryEvent(accounts.state.value.hasVerifiedAccountSession),
                            )
                            WorkbenchEvent.DismissPairing -> pairingOnboarding.onEvent(PairingOnboardingEvent.Dismiss)
                            is WorkbenchEvent.PairingUriChanged -> pairingOnboarding.onEvent(PairingOnboardingEvent.PairingUriReceived(event.value))
                            is WorkbenchEvent.PairingDeviceNameChanged -> computers.onEvent(ComputersEvent.PairingDeviceNameChanged(event.value))
                            WorkbenchEvent.Pair -> pairingOnboarding.onEvent(PairingOnboardingEvent.Retry)
                            WorkbenchEvent.OpenProjectDialog -> projects.onEvent(ProjectsEvent.OpenProjectDialog)
                            WorkbenchEvent.DismissProjectDialog -> projects.onEvent(ProjectsEvent.DismissProjectDialog)
                            is WorkbenchEvent.ProjectNameChanged -> projects.onEvent(ProjectsEvent.ProjectNameChanged(event.value))
                            is WorkbenchEvent.ProjectRootPathChanged -> projects.onEvent(ProjectsEvent.ProjectRootPathChanged(event.value))
                            is WorkbenchEvent.BrowseProjectFolder -> projects.onEvent(ProjectsEvent.BrowseProjectFolder(event.path))
                            WorkbenchEvent.BrowseProjectFolderParent -> projects.onEvent(ProjectsEvent.BrowseProjectFolderParent)
                            WorkbenchEvent.RetryProjectFolderBrowse -> projects.onEvent(ProjectsEvent.RetryProjectFolderBrowse)
                            WorkbenchEvent.ToggleProjectFolderCreate -> projects.onEvent(ProjectsEvent.ToggleProjectFolderCreate)
                            is WorkbenchEvent.ProjectFolderNameChanged -> projects.onEvent(ProjectsEvent.ProjectFolderNameChanged(event.value))
                            WorkbenchEvent.CreateProjectFolder -> projects.onEvent(ProjectsEvent.CreateProjectFolder)
                            WorkbenchEvent.CreateProject -> projects.onEvent(ProjectsEvent.CreateProject)
                            is WorkbenchEvent.SelectProject -> projects.onEvent(ProjectsEvent.SelectProject(event.projectId))
                        }
                    },
                    attentionState = attentionState,
                    onAttentionEvent = attention::onEvent,
                    onAttentionOpenSession = { sessionId ->
                        runtimeScope.launch {
                            tabletChatBinding.bind(app.runtime.sessions.delegate.value, currentWorkbenchTargetId, app.runtime.transport.delegate.value)
                            shell.onEvent(AppShellEvent.OpenChat)
                            chat.onEvent(ChatEvent.SelectSession(sessionId))
                        }
                    },
                )

                }

                pendingPairingScanFromWelcome?.let { fromWelcome ->
                    com.andysagent.agentoc.feature.workbench.PairingScanGuideDialog(
                        onScan = {
                            pendingPairingScanFromWelcome = null
                            startPairingScan(pairingOnboarding, returnToWelcomeOnFailure = fromWelcome)
                        },
                        onDismiss = { pendingPairingScanFromWelcome = null },
                    )
                }
                com.andysagent.agentoc.feature.workbench.ContentReportHost(contentReports)
                com.andysagent.agentoc.feature.workbench.accounts.DemoSignInDialog(
                    state = demoSignInState,
                    onUsernameChanged = demoSignIn::usernameChanged,
                    onPasswordChanged = demoSignIn::passwordChanged,
                    onSubmit = demoSignIn::submit,
                    onDismiss = demoSignIn::dismiss,
                )
                pendingGoogleSignIn?.let { request ->
                    GoogleSignInConfirmationDialog(
                        request = request,
                        onDemoSignIn = {
                            pendingGoogleSignIn = null
                            demoSignIn.open()
                        },
                        onConfirm = {
                            pendingGoogleSignIn = null
                            if (request == GoogleSignInRequest.Account) {
                                accounts.onEvent(AccountsEvent.SignIn)
                            }
                            googleSignInToLaunch = request
                        },
                        onDismiss = {
                            if (request == GoogleSignInRequest.ManageDevices) {
                                pendingComputerConnectionId = null
                                pendingComputerConnectionIsPrimary = true
                            }
                            pendingGoogleSignIn = null
                        },
                    )
                }

                if (browserSignInRequest != null) {
                    val activeBrowserRequest = browserSignInRequest
                    BrowserSignInWaitingOverlay(
                        errorText = browserSignInError,
                        canResumeChallenge = browserSignInChallenge != null,
                        onReopenBrowser = {
                            val wasRetryingCompletion = browserSignInError != null
                            browserSignInError = null
                            val challenge = browserSignInChallenge
                            val expiry = challenge?.expiresAt?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
                            if (challenge != null && expiry?.isAfter(java.time.Instant.now()) == true) {
                                if (!wasRetryingCompletion) {
                                    val base = getString(R.string.accounts_directory_base_url).trimEnd('/')
                                    val page = Uri.parse(base).buildUpon()
                                        .appendPath("owner")
                                        .appendPath("google")
                                        .appendPath("native-phone")
                                        .appendQueryParameter("tx", challenge.transactionId)
                                        .appendQueryParameter("ticket", challenge.browserTicket)
                                        .build()
                                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, page)) }
                                        .onFailure { error -> browserSignInError = error.message ?: "No browser is available to resume sign-in." }
                                }
                            } else {
                                browserSignInChallenge = null
                            }
                            browserSignInRetryTick += 1
                        },
                        onCancel = {
                            browserSignInError = null
                            when (activeBrowserRequest) {
                                GoogleSignInRequest.Account -> accounts.onEvent(AccountsEvent.SignInCancelled)
                                GoogleSignInRequest.PairComputer,
                                GoogleSignInRequest.PairComputerFromWelcome,
                                -> pairingOnboarding.onEvent(PairingOnboardingEvent.GoogleSignInCancelled)
                                GoogleSignInRequest.ManageDevices -> {
                                    pendingComputerConnectionId = null
                                    pendingComputerConnectionIsPrimary = true
                                }
                                else -> Unit
                            }
                            browserSignInChallenge = null
                            browserSignInRequest = null
                        },
                    )
                }

                requestError?.let { message ->
                    AgentoDialog(
                        title = stringResource(R.string.request_failed_title),
                        confirmLabel = "OK",
                        onConfirm = { requestError = null },
                        onDismiss = { requestError = null },
                        actionLayout = AgentoDialogActionLayout.PrimaryOnly,
                    ) {
                        Text(
                            text = message,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                            color = LocalAgentocColors.current.secondaryContent,
                        )
                    }
                }

                computerConnectionError?.let { message ->
                    val detail = if (message.retryAfterSeconds == null) {
                        stringResource(message.textRes)
                    } else {
                        stringResource(message.textRes, message.retryAfterSeconds)
                    }
                    AgentoDialog(
                        title = stringResource(R.string.computer_connection_unsuccessful),
                        confirmLabel = stringResource(R.string.computer_connection_confirm),
                        onConfirm = { computerConnectionError = null },
                        onDismiss = { computerConnectionError = null },
                        actionLayout = AgentoDialogActionLayout.PrimaryOnly,
                    ) {
                        Text(
                            text = detail,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                            color = LocalAgentocColors.current.secondaryContent,
                        )
                    }
                }

                }
            }
        }
    }

    @ExperimentalGetImage
    private fun startPairingScan(
        pairingOnboarding: PairingOnboardingViewModel,
        returnToWelcomeOnFailure: Boolean,
    ) {
        activePairingOnboarding = pairingOnboarding
        scannerReturnToWelcomeOnFailure = returnToWelcomeOnFailure
        pairingScannerLauncher.launch(Intent(this, PairingQrScannerActivity::class.java))
    }

    private suspend fun refreshAccountDirectory(app: AgentoCApplication) {
        val generation = ++accountDirectoryGeneration
        accountComputerLookup = AccountComputerLookup.Loading
        val expectedAccount = app.runtime.configStore.accountSession.first()?.accountId ?: return
        suspend fun current(): Boolean {
            currentCoroutineContext().ensureActive()
            return generation == accountDirectoryGeneration &&
                app.runtime.configStore.accountSession.first()?.accountId == expectedAccount
        }
        try {
            val devices = app.runtime.listAccountDirectoryDevices()
            if (!current()) return
            accountDirectoryDevices = devices
            discoveredComputers = devices.toDiscoverableComputers()
            accountComputerLookup = accountComputerLookupFor(devices)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            // A cancelled/replaced request cannot erase a newer verified list.
            // Genuine current failures still hide directory rows, without a
            // fallback to another account's local computer cache.
            if (current()) {
                accountDirectoryDevices = emptyList()
                discoveredComputers = emptyList()
                accountComputerLookup = AccountComputerLookup.Failed
            }
            throw error
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeIncomingIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        pendingPairingScanFromWelcome?.let { outState.putBoolean("agentoc.setup.fromWelcome", it) }
        outState.putStringArrayList("agentoc.navigation.consumed", ArrayList(consumedNotificationKeys))
        navigationIntakeKey?.let { outState.putString("agentoc.navigation.intakeKey", it) }
        pendingSessionNavigation?.let { outState.putString("agentoc.navigation.pending", AppApiJson.encodeToString(it)) }
        val browserPurpose = browserSignInRequest
        val browserChallenge = browserSignInChallenge
        if (browserPurpose != null && browserChallenge != null) {
            outState.putString("agentoc.browser.signIn", encodeBrowserSignInRecovery(BrowserSignInRecovery(
                purpose = browserPurpose.name, challenge = browserChallenge,
                computerId = pendingComputerConnectionId, primaryComputer = pendingComputerConnectionIsPrimary,
            )))
        }
        super.onSaveInstanceState(outState)
    }
}

@Composable
internal fun GoogleSignInConfirmationDialog(
    request: GoogleSignInRequest,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    onDemoSignIn: (() -> Unit)? = null,
) {
    val detail = stringResource(
        when (request) {
            GoogleSignInRequest.PairComputer,
            GoogleSignInRequest.PairComputerFromWelcome -> WorkbenchR.string.settings_google_sign_in_pairing_detail
            GoogleSignInRequest.ManageDevices -> WorkbenchR.string.settings_google_sign_in_devices_detail
            GoogleSignInRequest.Account -> WorkbenchR.string.settings_google_sign_in_account_detail
        },
    )
    AgentoDialog(
        title = stringResource(WorkbenchR.string.settings_google_sign_in_title),
        confirmLabel = stringResource(WorkbenchR.string.pairing_continue),
        dismissLabel = stringResource(WorkbenchR.string.settings_cancel),
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
    ) {
        Column {
            Text(
                text = detail,
                style = androidx.compose.material3.MaterialTheme.typography.bodyLarge,
                color = LocalAgentocColors.current.secondaryContent,
            )
            onDemoSignIn?.let { onDemo ->
                TextButton(onClick = onDemo) { Text(stringResource(WorkbenchR.string.demo_sign_in_title)) }
            }
        }
    }
}

@Composable
private fun BrowserSignInWaitingOverlay(
    errorText: String?,
    canResumeChallenge: Boolean,
    onReopenBrowser: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    AlertDialog(
        onDismissRequest = onCancel,
        modifier = modifier,
        title = { Text("Finish sign-in in your browser") },
        text = {
            Column {
                Text(
                    "Complete Google sign-in in the browser that just opened, then come back to Ragent. " +
                        "This phone finishes the connection automatically.",
                    color = colors.secondaryContent,
                )
                if (errorText != null) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        errorText,
                        color = MaterialTheme.colorScheme.error,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onReopenBrowser) {
                Text(if (errorText == null) "Reopen browser" else if (canResumeChallenge) "Try again" else "Start over")
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel) { Text("Cancel") }
        },
        titleContentColor = colors.primaryContent,
        textContentColor = colors.secondaryContent,
    )
}

private fun localizedContextFor(base: Context, language: AppLanguage): Context {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU || language.tag.isBlank()) {
        return base
    }
    val configuration = Configuration(base.resources.configuration)
    configuration.setLocale(java.util.Locale.forLanguageTag(language.tag))
    return base.createConfigurationContext(configuration)
}

private fun mergeAccountComputers(
    linked: List<LinkedComputer>,
    discovered: List<DiscoveredComputer>,
): List<RemoteTarget> {
    val linkedById = linked.associateBy { it.instanceId }
    val discoveredTargets = discovered.mapNotNull { computer ->
                            val local = linkedById[computer.instanceId]
        RemoteTarget(
            instanceId = computer.instanceId,
            label = computer.alias,
                                endpoint = computer.connectionEndpoint.orEmpty(),
            accessState = if (local != null) {
                runCatching { RemoteTargetAccessState.valueOf(local.accessState) }
                    .getOrDefault(RemoteTargetAccessState.Connected)
            } else {
                RemoteTargetAccessState.NeedsPairing
            },
            linkedToPhone = local != null,
            lastSeenAt = computer.lastSeenAt?.let {
                runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull()
            },
            lastSelectedAt = local?.lastSelectedAt ?: 0L,
        )
    }
    val discoveredIds = discoveredTargets.mapTo(mutableSetOf()) { it.instanceId }
    val linkedOnly = linked.filterNot { it.instanceId in discoveredIds }.map { computer ->
        RemoteTarget(
            instanceId = computer.instanceId,
            label = computer.label.ifBlank { computer.instanceId },
            endpoint = computer.endpoint,
            platform = computer.platform,
            accessState = runCatching { RemoteTargetAccessState.valueOf(computer.accessState) }
                .getOrDefault(RemoteTargetAccessState.Unavailable),
            linkedToPhone = true,
            lastSeenAt = computer.lastSeenAt,
            lastSelectedAt = computer.lastSelectedAt,
        )
    }
    return discoveredTargets + linkedOnly
}

internal fun List<AccountDirectoryDevice>.toDiscoverableComputers(): List<DiscoveredComputer> = mapNotNull { device ->
    if (!device.unboundAt.isNullOrBlank() || device.deviceKind != "computer") return@mapNotNull null
    // Account rendezvous addresses a computer by its signed instance identity.
    // Older directory rows may predate that identity, so they are not joinable
    // until the computer publishes its key; an endpoint alone is not a carrier.
    if (device.instancePublicKey.isNullOrBlank() || device.instanceKeyFingerprint.isNullOrBlank()) {
        return@mapNotNull null
    }
    DiscoveredComputer(
        instanceId = device.instanceId,
        alias = device.alias.ifBlank { device.instanceId },
        endpoint = device.endpoint.orEmpty(),
        boundAt = device.boundAt,
        lastSeenAt = device.lastSeenAt,
        canTakeOver = true,
        instancePublicKey = device.instancePublicKey,
        instanceKeyFingerprint = device.instanceKeyFingerprint,
    )
}

internal fun List<AccountDirectoryDevice>.toRemoteTargets(
    linked: List<LinkedComputer>,
): List<RemoteTarget> {
    val linkedById = linked.associateBy { it.instanceId }
    return filter { it.deviceKind == "computer" }.map { device ->
        val local = linkedById[device.instanceId]
        val accessState = when {
            !device.unboundAt.isNullOrBlank() -> RemoteTargetAccessState.Revoked
            local != null -> runCatching { RemoteTargetAccessState.valueOf(local.accessState) }
                .getOrDefault(RemoteTargetAccessState.Unavailable)
            device.endpoint.isNullOrBlank() -> RemoteTargetAccessState.NeedsPairing
            else -> RemoteTargetAccessState.NeedsPairing
        }
        RemoteTarget(
            instanceId = device.instanceId,
            label = device.alias.ifBlank { device.instanceId },
            endpoint = device.endpoint.orEmpty(),
            platform = device.deviceKind,
            accessState = accessState,
            linkedToPhone = local != null,
            lastSeenAt = device.lastSeenAt?.let {
                runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull()
            },
            lastSelectedAt = local?.lastSelectedAt ?: 0L,
        )
    }
}

/**
 * An Accounts directory endpoint is only display metadata. A local target that
 * is still NeedsPairing must complete account rendezvous even when that
 * metadata is present, otherwise it has no target-scoped credential or
 * bootstrap.
 */
internal fun shouldUseExistingComputerTarget(
    target: LinkedComputer?,
    accountDirectoryMode: Boolean = false,
): Boolean =
    !accountDirectoryMode
        && target != null
        && target.endpoint.isNotBlank()
        && runCatching { RemoteTargetAccessState.valueOf(target.accessState) }
            .getOrDefault(RemoteTargetAccessState.Unavailable) != RemoteTargetAccessState.NeedsPairing

/** Presence is independent of online state, rendezvous keys, or local phone pairing. */
internal fun accountComputerLookupFor(devices: List<AccountDirectoryDevice>): AccountComputerLookup =
    if (devices.any { it.deviceKind == "computer" && it.unboundAt.isNullOrBlank() }) {
        AccountComputerLookup.Available
    } else AccountComputerLookup.Empty
