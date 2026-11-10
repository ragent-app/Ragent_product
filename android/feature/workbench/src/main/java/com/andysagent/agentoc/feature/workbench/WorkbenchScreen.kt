package com.andysagent.agentoc.feature.workbench

import androidx.compose.material3.ButtonDefaults

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.runtime.mutableLongStateOf
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.unit.toIntSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.zIndex
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import com.andysagent.agentoc.core.agentui.AgentConnectionStatus
import com.andysagent.agentoc.core.auth.BrokerEnrollmentMaterial
import com.andysagent.agentoc.core.auth.BrokerPendingEnrollment
import com.andysagent.agentoc.core.auth.BrokerApprovalProtocol
import com.andysagent.agentoc.core.agentui.AgentComposer
import com.andysagent.agentoc.core.agentui.ComposerSelectedCapability
import com.andysagent.agentoc.core.agentui.ComposerSlashSuggestion
import com.andysagent.agentoc.core.agentui.clearComposerSlashToken
import com.andysagent.agentoc.core.agentui.replaceComposerSlashToken
import com.andysagent.agentoc.core.agentui.LocalPreparedMarkdownDocuments
import com.andysagent.agentoc.core.agentui.MarkdownBlock
import com.andysagent.agentoc.core.agentui.prepareMarkdownDocuments
import com.andysagent.agentoc.core.agentui.autoCloseMarkdownSyntax
import com.andysagent.agentoc.core.agentui.FloatingTopChrome
import com.andysagent.agentoc.core.agentui.AgentOperationKind
import com.andysagent.agentoc.core.agentui.AgentOperationStatus
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.agentui.AgentStreamingMessage
import com.andysagent.agentoc.core.agentui.AgentStatus
import com.andysagent.agentoc.core.agentui.CommandCard
import com.andysagent.agentoc.core.agentui.ConnectionStatus
import com.andysagent.agentoc.core.agentui.ErrorCard
import com.andysagent.agentoc.core.agentui.FileEditCard
import com.andysagent.agentoc.core.agentui.PermissionRequestCard
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.agentui.RetryCard
import com.andysagent.agentoc.core.agentui.RetryUiState
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.agentui.FileChangeItem
import com.andysagent.agentoc.core.agentui.FileChangeType
import com.andysagent.agentoc.core.agentui.FileChangeUiState
import com.andysagent.agentoc.core.agentui.FileChangeSummaryCard
import com.andysagent.agentoc.core.agentui.ToolActivityGroupCard
import com.andysagent.agentoc.core.agentui.TaskStatusKind
import com.andysagent.agentoc.core.agentui.TaskStatusUiState
import com.andysagent.agentoc.core.agentui.TaskStatusCard
import com.andysagent.agentoc.core.agentui.ToolCallCard
import com.andysagent.agentoc.core.agentui.ToolCallUiState
import com.andysagent.agentoc.core.agentui.UserMessage
import com.andysagent.agentoc.core.agentui.UserMessageAttachment
import com.andysagent.agentoc.core.agentui.R as AgentUiR
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoMotion
import com.andysagent.agentoc.core.designsystem.AgentoCard
import com.andysagent.agentoc.core.designsystem.AgentoEmptyState
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
import com.andysagent.agentoc.core.designsystem.AgentoFloatingIconButton
import com.andysagent.agentoc.core.designsystem.AgentoCountBadge
import com.andysagent.agentoc.core.designsystem.AgentoDialog
import com.andysagent.agentoc.core.designsystem.AgentoDialogActionLayout
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenu
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenuItem
import com.andysagent.agentoc.core.designsystem.AgentoErrorText
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoFrostedMenu
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.recordToLayer
import com.andysagent.agentoc.core.designsystem.AgentoListItem
import com.andysagent.agentoc.core.designsystem.AgentoProgress
import com.andysagent.agentoc.core.designsystem.AgentoRowSurface
import com.andysagent.agentoc.core.designsystem.AgentoVerticalDivider
import com.andysagent.agentoc.core.designsystem.AgentoSearchField
import com.andysagent.agentoc.core.designsystem.AgentoSectionHeader
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoStatus
import com.andysagent.agentoc.core.designsystem.AgentoStatusTone
import com.andysagent.agentoc.core.designsystem.AgentoSurface
import com.andysagent.agentoc.core.designsystem.AgentoTextField
import com.andysagent.agentoc.core.designsystem.AgentoTopBar
import com.andysagent.agentoc.core.designsystem.AgentoToolbarIconButton
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.agentoLargeCardShadow
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.AgentocSizes
import com.andysagent.agentoc.core.designsystem.LocalAgentocExtendedColors
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.LocalAgentoBackdropRevision
import com.andysagent.agentoc.core.designsystem.LocalAgentoBackdropMotionResponse
import com.andysagent.agentoc.core.designsystem.rememberAgentoBackdropMotionResponse
import com.andysagent.agentoc.core.designsystem.agentoReadingEdges
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.MotionPreference
import com.andysagent.agentoc.core.designsystem.motionPolicy
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSettingRow
import com.andysagent.agentoc.core.designsystem.AgentoSwitch
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.agentoc.core.navigation.AgentoAdaptiveScaffold
import com.andysagent.agentoc.core.navigation.AgentoDestination
import com.andysagent.agentoc.core.navigation.AgentoWindowSizeClass
import com.andysagent.agentoc.core.domain.AccountsRepository
import com.andysagent.agentoc.core.domain.GoogleAccountStatusResult
import com.andysagent.agentoc.core.domain.GoogleTokenSubmitResult
import com.andysagent.agentoc.core.domain.ProjectFolder
import com.andysagent.agentoc.core.model.AppLanguage
import com.andysagent.agentoc.core.model.AppTheme
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.RemoteTargetAccessState
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import com.andysagent.agentoc.feature.workbench.accounts.AccountsEvent
import com.andysagent.agentoc.feature.workbench.accounts.AccountsViewModel
import com.andysagent.agentoc.feature.workbench.accounts.AccountsViewModelFactory
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountAvatar
import com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountStatus
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

private enum class WorkbenchBackLayer {
    PairingSignIn,
    GoogleSignInSuccess,
    SubscriptionInfo,
    DiffViewer,
    RunSheet,
    AgentPanel,
    ConnectorPanel,
    GoalDialog,
    ComposerActionSheet,
    Chat,
    Agent,
    ProjectSessions,
    File,
    SettingsPage,
}

private enum class ProjectLocationStep {
    Details,
    Picker,
    Drives,
    Folders,
}

internal val UnavailableProjectFolderBrowser = ProjectFolderBrowser(
    loadRoots = { error("Project location browser is unavailable") },
    loadDirectory = { error("Project location browser is unavailable") },
)

enum class GoogleSignInRequest {
    Account,
    PairComputer,
    PairComputerFromWelcome,
    ManageDevices,
}

enum class GoogleSignInSuccessAction {
    ConnectComputer,
    OpenSignedInWelcome,
    EnterApp,
}

@Composable
fun WorkbenchScreen(
    state: WorkbenchUiState,
    accountsViewModel: AccountsViewModel? = null,
    webParityViewModel: WebParityViewModel? = null,
    chatWebParityViewModel: WebParityViewModel? = null,
    pairingOnboardingState: PairingOnboardingUiState? = null,
    onPairingOnboardingEvent: (PairingOnboardingEvent) -> Unit = {},
    onScanPairing: () -> Unit = {},
    onScanPairingFromWelcome: () -> Unit = onScanPairing,
    onSetUpComputer: () -> Unit = onScanPairingFromWelcome,
    onOpenSubscription: () -> Unit = {},
    subscriptionInfoOpen: Boolean = false,
    onCloseSubscriptionInfo: () -> Unit = {},
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit = {},
    onRequestBrowserSignIn: (GoogleSignInRequest) -> Unit = {},
    onRequestDemoSignIn: () -> Unit = {},
    onRequestComputerDiscovery: () -> Unit = {},
    googleSignInSuccess: GoogleSignInRequest? = null,
    onGoogleSignInSuccessAction: (GoogleSignInSuccessAction) -> Unit = {},
    onGoogleSignInSuccessBack: () -> Unit = {},
    startupOnboardingLoading: Boolean = false,
    showWelcomeAtLaunch: Boolean = false,
    welcomeSignedIn: Boolean = false,
    welcomeComputerLookup: AccountComputerLookup? = null,
    connectingTargetId: String? = null,
    onSkipWelcome: () -> Unit = {},
    onEvent: (WorkbenchEvent) -> Unit = {},
    attentionState: AttentionUiState? = null,
    onAttentionEvent: (AttentionEvent) -> Unit = {},
    onAttentionOpenSession: (String) -> Unit = {},
    brokerEnrollmentController: BrokerEnrollmentController? = null,
    windowSizeClass: AgentoWindowSizeClass = AgentoWindowSizeClass.Compact,
    modifier: Modifier = Modifier,
) {
    if (startupOnboardingLoading) {
        WelcomeLaunchScreen(modifier = modifier)
        return
    }

    if (googleSignInSuccess == GoogleSignInRequest.Account ||
        googleSignInSuccess == GoogleSignInRequest.PairComputerFromWelcome) {
        LaunchedEffect(googleSignInSuccess) {
            onGoogleSignInSuccessAction(GoogleSignInSuccessAction.EnterApp)
        }
        AccountComputerLookupScreen(AccountComputerLookup.Loading, onRequestComputerDiscovery, modifier)
        return
    }
    if (googleSignInSuccess != null) {
        val successAccount = accountsViewModel?.state?.collectAsState()?.value
        BackHandler(onBack = onGoogleSignInSuccessBack)
        GoogleSignInSuccessScreen(
            action = when (googleSignInSuccess) {
                GoogleSignInRequest.PairComputer -> GoogleSignInSuccessAction.ConnectComputer
                GoogleSignInRequest.PairComputerFromWelcome -> GoogleSignInSuccessAction.OpenSignedInWelcome
                else -> GoogleSignInSuccessAction.EnterApp
            },
            onAction = onGoogleSignInSuccessAction,
            accountLabel = successAccount?.takeIf { it.hasVerifiedAccountSession }?.accountProfile?.let {
                it.email?.takeIf(String::isNotBlank) ?: it.displayName
            },
            modifier = modifier,
        )
        return
    }

    val fullScreenOnboarding = pairingOnboardingState?.takeIf {
        it.step == PairingOnboardingStep.Welcome ||
            it.step == PairingOnboardingStep.ConnectionMethods ||
            it.step == PairingOnboardingStep.GoogleRequired
    }
    // The scanner runs outside our window. When it cannot open, keep its
    // recovery sheet anchored to the same Welcome context instead of exposing
    // the empty workbench behind it.
    val scannerErrorReturningToWelcome = pairingOnboardingState?.let {
        it.step == PairingOnboardingStep.Error && it.scannerFailureReturnsToWelcome
    } == true
    val temporaryPairingAtWelcome = pairingOnboardingState?.temporaryPairing == true && showWelcomeAtLaunch
    if (fullScreenOnboarding != null || showWelcomeAtLaunch || scannerErrorReturningToWelcome || temporaryPairingAtWelcome) {
        if (fullScreenOnboarding?.step == PairingOnboardingStep.Welcome &&
            welcomeSignedIn && welcomeComputerLookup == null) {
            BackHandler { onPairingOnboardingEvent(PairingOnboardingEvent.Dismiss) }
        }
        if (fullScreenOnboarding?.step == PairingOnboardingStep.GoogleRequired ||
            fullScreenOnboarding?.step == PairingOnboardingStep.ConnectionMethods
        ) {
            BackHandler { onPairingOnboardingEvent(PairingOnboardingEvent.BackToWelcome) }
        }
        when (fullScreenOnboarding?.step ?: PairingOnboardingStep.Welcome) {
            PairingOnboardingStep.Welcome -> Box(modifier = modifier.fillMaxSize()) {
                if (!welcomeSignedIn) {
                    WelcomeScreen(
                        onConnectComputer = { onPairingOnboardingEvent(PairingOnboardingEvent.ContinueFromWelcome) },
                        onScanPairing = onScanPairingFromWelcome,
                        onLearnConnectionMethods = { onPairingOnboardingEvent(PairingOnboardingEvent.LearnConnectionMethods) },
                        modifier = modifier,
                    )
                } else if (welcomeComputerLookup != null && welcomeComputerLookup != AccountComputerLookup.Empty) {
                    AccountComputerLookupScreen(welcomeComputerLookup, onRequestComputerDiscovery, modifier)
                } else {
                    WelcomeScreen(onConnectComputer = onSetUpComputer,
                        onScanPairing = onScanPairingFromWelcome, onSetUpComputer = onSetUpComputer,
                        signedIn = true, modifier = modifier)
                }
                if (scannerErrorReturningToWelcome || temporaryPairingAtWelcome) {
                    PairingOnboardingDialog(
                        state = pairingOnboardingState!!,
                        onEvent = onPairingOnboardingEvent,
                        onScanPairing = onScanPairing,
                        onScanPairingFromWelcome = onScanPairingFromWelcome,
                        onOpenSubscription = onOpenSubscription,
                    )
                }
            }
            PairingOnboardingStep.ConnectionMethods -> ConnectionMethodsScreen(
                onBack = { onPairingOnboardingEvent(PairingOnboardingEvent.BackToWelcome) },
                onTryDirectConnection = { onPairingOnboardingEvent(PairingOnboardingEvent.StartComputerConnection) },
                onScanTemporary = onScanPairingFromWelcome,
                modifier = modifier,
            )
            PairingOnboardingStep.GoogleRequired -> GoogleSignInGuideScreen(
                onContinueWithDemo = onRequestDemoSignIn,
                onContinue = {
                    val request = when (fullScreenOnboarding!!.mode) {
                        PairingOnboardingMode.SignIn -> GoogleSignInRequest.Account
                        PairingOnboardingMode.ConnectComputerFromWelcome -> GoogleSignInRequest.PairComputerFromWelcome
                        PairingOnboardingMode.ConnectComputer -> GoogleSignInRequest.PairComputer
                    }
                    onRequestGoogleSignIn(request)
                },
                onContinueWithBrowser = {
                    val request = when (fullScreenOnboarding!!.mode) {
                        PairingOnboardingMode.SignIn -> GoogleSignInRequest.Account
                        PairingOnboardingMode.ConnectComputerFromWelcome -> GoogleSignInRequest.PairComputerFromWelcome
                        PairingOnboardingMode.ConnectComputer -> GoogleSignInRequest.PairComputer
                    }
                    onRequestBrowserSignIn(request)
                },
                onBack = { onPairingOnboardingEvent(PairingOnboardingEvent.BackToWelcome) },
                modifier = modifier,
            )
            else -> Unit
        }
        return
    }

    val predictiveBackProgress = remember { Animatable(0f) }
    val backProgress = predictiveBackProgress.value
    val parityState = webParityViewModel?.state?.collectAsState()?.value ?: WebParityUiState()
    val parityEvent: (WebParityEvent) -> Unit = remember(webParityViewModel) {
        { event -> webParityViewModel?.onEvent(event) }
    }
    val detailParityViewModel = chatWebParityViewModel ?: webParityViewModel
    val detailParityState = detailParityViewModel?.state?.collectAsState()?.value ?: WebParityUiState()
    val detailParityEvent: (WebParityEvent) -> Unit = remember(detailParityViewModel) {
        { event -> detailParityViewModel?.onEvent(event) }
    }
    val projectFolderBrowser = remember(webParityViewModel) {
        ProjectFolderBrowser(
            loadRoots = {
                webParityViewModel?.loadProjectFolderRoots()
                    ?: error("Project location browser is unavailable")
            },
            loadDirectory = { path ->
                webParityViewModel?.loadProjectFolderDirectory(path)
                    ?: error("Project location browser is unavailable")
            },
        )
    }
    val onEventState = rememberUpdatedState(onEvent)
    val choiceBackHandoff = remember { ComposerChoiceBackHandoff() }
    SideEffect { choiceBackHandoff.observe(state.chatOpen && state.runtimePickerOpen,
        state.chatOpen && state.effortPickerOpen) }
    val stableOnEvent: (WorkbenchEvent) -> Unit = remember {
        { event ->
            // Claim Back in the input callback, before the next composition or
            // native window focus can acknowledge this opening request.
            choiceBackHandoff.dispatch(event)
            onEventState.value(event)
        }
    }

    // Screen-side interactive states for composer, attachments, queue, steer, decision, run sheet, agent & connector panels
    var composerActionSheetOpen by remember(state.chatTargetId, state.sessionId) { mutableStateOf(false) }
    var agentPanelOpen by remember(state.chatTargetId, state.sessionId) { mutableStateOf(false) }
    var connectorPanelOpen by remember(state.chatTargetId, state.sessionId) { mutableStateOf(false) }
    var attachments by remember(state.chatTargetId, state.sessionId) { mutableStateOf<List<ComposerAttachment>>(emptyList()) }
    var editingTurnId by remember(state.chatTargetId, state.sessionId) { mutableStateOf<String?>(null) }
    var editingTurnText by remember(state.chatTargetId, state.sessionId) { mutableStateOf<String?>(null) }
    val queuedMessages = state.queuedMessages
    var activeDecision by remember(state.chatTargetId, state.sessionId) { mutableStateOf<DecisionQuestionUiState?>(null) }
    var runSheetOpen by remember(state.chatTargetId, state.sessionId) { mutableStateOf(false) }
    var selectedDiffFile by remember(state.chatTargetId, state.sessionId) { mutableStateOf<FileDiffDetail?>(null) }
    var planMode by remember(state.chatTargetId, state.sessionId, state.planMode) { mutableStateOf(state.planMode) }

    LaunchedEffect(state.chatTargetId, state.sessionId, state.activeDecision) {
        activeDecision = state.activeDecision
    }
    LaunchedEffect(state.chatTargetId, state.sessionId, state.planMode) {
        planMode = state.planMode
    }

    // Streaming changes belong to ChatSurface. Keep the retained navigation
    // layer equal while tokens arrive so L1/L2 and settings can be skipped.
    val navigationState by rememberUpdatedState(state.navigationProjection())

    LaunchedEffect(parityState.pendingOpenSessionId) {
        parityState.pendingOpenSessionId?.let { sessionId ->
            onEvent(WorkbenchEvent.SelectSession(sessionId))
            webParityViewModel?.consumePendingOpenSession()
        }
    }

    LaunchedEffect(detailParityViewModel, state.chatTargetId, state.sessionId) {
        detailParityViewModel?.setOpenSessionId(state.sessionId)
    }

    LaunchedEffect(detailParityViewModel, state.chatTargetId, state.sessionId, state.runtimeTool, state.runtimeModel, state.selectedEffort) {
        detailParityViewModel?.setTriggerRuntime(
            tool = state.runtimeTool,
            model = state.runtimeModel,
            effort = state.selectedEffort.orEmpty(),
        )
    }

    val backLayer = when {
        subscriptionInfoOpen -> WorkbenchBackLayer.SubscriptionInfo
        selectedDiffFile != null -> WorkbenchBackLayer.DiffViewer
        runSheetOpen -> WorkbenchBackLayer.RunSheet
        agentPanelOpen -> WorkbenchBackLayer.AgentPanel
        connectorPanelOpen -> WorkbenchBackLayer.ConnectorPanel
        state.goalDialogOpen -> WorkbenchBackLayer.GoalDialog
        composerActionSheetOpen -> WorkbenchBackLayer.ComposerActionSheet
        state.chatOpen -> WorkbenchBackLayer.Chat
        parityState.selectedFile != null -> WorkbenchBackLayer.File
        state.agentOpen -> WorkbenchBackLayer.Agent
        state.projectSessionsOpen -> WorkbenchBackLayer.ProjectSessions
        state.destination == AgentoDestination.Settings && state.settingsPage != SettingsPage.Overview -> WorkbenchBackLayer.SettingsPage
        else -> null
    }

    val currentColors = LocalAgentocColors.current
    val isDarkCanvas = currentColors.canvas.red < 0.5f
    val attentionBackdrop = rememberGraphicsLayer()
    var attentionRetained by remember { mutableStateOf(false) }
    val showAttention = attentionState?.takeIf { attention ->
        val active = attention.activeItem ?: return@takeIf false
        !(state.chatOpen && state.sessionId == active.sessionId &&
            (state.chatTargetId == null || state.chatTargetId == state.activeRemoteTargetId))
    }
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                brush = if (isDarkCanvas) {
                    com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasDark
                } else {
                    com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasLight
                },
            ),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .drawWithContent {
                    if (showAttention != null || attentionRetained) {
                        recordToLayer(attentionBackdrop)
                    } else {
                        this@drawWithContent.drawContent()
                    }
                },
        ) {
            val configuration = androidx.compose.ui.platform.LocalConfiguration.current
            val screenWidthDp = configuration.screenWidthDp.dp
            val minDetailWidth = 320.dp
            val isDualPane = windowSizeClass == AgentoWindowSizeClass.Expanded && (screenWidthDp - AgentocSizes.PhoneShell >= minDetailWidth)

            if (isDualPane) {
            val phoneState = if (!navigationState.chatOpen) {
                navigationState.copy(
                    agentOpen = false,
                    projectSessionsOpen = false,
                    browsingProjectId = null,
                )
            } else {
                navigationState.copy(
                    agentOpen = false,
                    // Session IDs can coincide across computers; never mark a
                    // foreground row selected for a detail owned by another PC.
                    sessionId = navigationState.sessionId.takeIf {
                        state.chatTargetId == null || state.chatTargetId == state.activeRemoteTargetId
                    },
                )
            }
            Row(Modifier.fillMaxSize()) {
                PrimaryNavigationSurface(
                    state = phoneState,
                    accountsViewModel = accountsViewModel,
                    brokerEnrollmentController = brokerEnrollmentController,
                    onRequestGoogleSignIn = onRequestGoogleSignIn,
                    onRequestComputerDiscovery = onRequestComputerDiscovery,
                    connectingTargetId = connectingTargetId,
                    parityState = parityState,
                    onParityEvent = parityEvent,
                    onEvent = stableOnEvent,
                    folderBrowser = projectFolderBrowser,
                    windowSizeClass = AgentoWindowSizeClass.Compact,
                    backProgress = 0f,
                    modifier = Modifier.width(AgentocSizes.PhoneShell).fillMaxHeight(),
                )
                AgentoVerticalDivider(Modifier.padding(vertical = AgentocSpacing.Gutter))
                TabletDetailSurface(
                    navigationState = navigationState,
                    chatState = state.copy(
                        connection = state.chatConnection ?: state.connection,
                        activeRemoteTargetId = state.chatTargetId ?: state.activeRemoteTargetId,
                        selectedProjectId = state.selectedProjectId.takeIf { state.chatTargetId == state.activeRemoteTargetId },
                    ),
                    parityState = parityState,
                    onParityEvent = parityEvent,
                    chatParityState = detailParityState,
                    onChatParityEvent = detailParityEvent,
                    onEvent = stableOnEvent,
                    modifier = Modifier.weight(1f).fillMaxHeight(),
                    backProgress = backProgress,
                    composerActionSheetOpen = composerActionSheetOpen,
                    onSetComposerActionSheetOpen = { composerActionSheetOpen = it },
                    agentPanelOpen = agentPanelOpen,
                    onSetAgentPanelOpen = { agentPanelOpen = it },
                    connectorPanelOpen = connectorPanelOpen,
                    onSetConnectorPanelOpen = { connectorPanelOpen = it },
                    attachments = attachments,
                    onSetAttachments = { attachments = it },
                    editingTurnId = editingTurnId,
                    editingTurnText = editingTurnText,
                    onSetEditingTurn = { id, text -> editingTurnId = id; editingTurnText = text },
                    queuedMessages = queuedMessages,
                    activeDecision = activeDecision,
                    onSetActiveDecision = { activeDecision = it },
                    runSheetOpen = runSheetOpen,
                    onSetRunSheetOpen = { runSheetOpen = it },
                    selectedDiffFile = selectedDiffFile,
                    onSetSelectedDiffFile = { file ->
                        selectedDiffFile = file
                        if (file == null) detailParityEvent(WebParityEvent.CloseFile)
                        else detailParityEvent(WebParityEvent.OpenFile(file.path, state.sessionId))
                    },
                    planMode = planMode,
                    onSetPlanMode = { planMode = it },
                )
            }
            } else {
            WorkbenchBackStackTransition(
                isOpen = state.chatOpen,
                backProgress = backProgress,
                modifier = Modifier.fillMaxSize(),
                parentContent = {
                    PrimaryNavigationSurface(
                        state = navigationState.copy(chatOpen = false),
                        accountsViewModel = accountsViewModel,
                        brokerEnrollmentController = brokerEnrollmentController,
                        onRequestGoogleSignIn = onRequestGoogleSignIn,
                        onRequestComputerDiscovery = onRequestComputerDiscovery,
                        connectingTargetId = connectingTargetId,
                        parityState = parityState,
                        onParityEvent = parityEvent,
                        onEvent = stableOnEvent,
                        folderBrowser = projectFolderBrowser,
                        windowSizeClass = windowSizeClass,
                        backProgress = if (state.chatOpen) 0f else backProgress,
                        modifier = Modifier.fillMaxSize(),
                    )
                },
                childContent = {
                    ChatSurface(
                        state = state,
                        parityState = detailParityState,
                        onParityEvent = detailParityEvent,
                        onEvent = stableOnEvent,
                        modifier = Modifier.fillMaxSize(),
                        composerActionSheetOpen = composerActionSheetOpen,
                        onSetComposerActionSheetOpen = { composerActionSheetOpen = it },
                        agentPanelOpen = agentPanelOpen,
                        onSetAgentPanelOpen = { agentPanelOpen = it },
                        connectorPanelOpen = connectorPanelOpen,
                        onSetConnectorPanelOpen = { connectorPanelOpen = it },
                        attachments = attachments,
                        onSetAttachments = { attachments = it },
                        editingTurnId = editingTurnId,
                        editingTurnText = editingTurnText,
                        onSetEditingTurn = { id, text -> editingTurnId = id; editingTurnText = text },
                        queuedMessages = queuedMessages,
                        activeDecision = activeDecision,
                        onSetActiveDecision = { activeDecision = it },
                        runSheetOpen = runSheetOpen,
                        onSetRunSheetOpen = { runSheetOpen = it },
                        selectedDiffFile = selectedDiffFile,
                        onSetSelectedDiffFile = { file ->
                        selectedDiffFile = file
                        if (file == null) detailParityEvent(WebParityEvent.CloseFile)
                        else detailParityEvent(WebParityEvent.OpenFile(file.path, state.sessionId))
                    },
                        planMode = planMode,
                        onSetPlanMode = { planMode = it },
                    )
                },
            )
            }
        }
        state.error?.takeUnless(::isTransportConnectionFailure)?.let { error ->
            val missingRemoteTarget = isMissingRemoteTarget(error)
            RetryCard(
                state = retryPresentation(error, isTransportFailure = false),
                onRetry = {
                    if (missingRemoteTarget) {
                        // This path is navigation, not a failed task retry.
                        // Clear the chat-owned error before switching layers so
                        // the global overlay cannot cover the device screen.
                        onEvent(WorkbenchEvent.DismissError)
                        onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerManagement))
                    } else {
                        onEvent(WorkbenchEvent.Retry)
                    }
                },
                onDismiss = { onEvent(WorkbenchEvent.DismissError) },
                compact = missingRemoteTarget,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .padding(top = if (state.chatOpen) 60.dp else 0.dp)
                    .widthIn(max = 520.dp)
                    .padding(AgentocSpacing.Gutter)
                    .zIndex(10f),
            )
        }
        // Keep the same host mounted after business dismissal so its exit can
        // paint. The callback also keeps its raw backdrop live during travel.
            AttentionSurface(
                state = showAttention ?: AttentionUiState(),
                onEvent = onAttentionEvent,
                onOpenSession = onAttentionOpenSession,
                backdropLayer = attentionBackdrop,
                onRetainedPresenceChanged = { attentionRetained = it },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = if (state.chatOpen) 56.dp else 0.dp)
                    .zIndex(30f),
            )
    }

    // Predictive back handler
    PredictiveBackHandler(enabled = backLayer != null && showAttention == null) { progress ->
        var committed = false
        try {
            val choiceDismissal = choiceBackHandoff.dismissal
            if (choiceDismissal != null) {
                // No page displacement while a pending choice owns the gesture.
                progress.collect { }
                committed = true
                stableOnEvent(choiceDismissal)
                return@PredictiveBackHandler
            }
            var observedProgress = 0f
            progress.collect { event ->
                observedProgress = maxOf(observedProgress, event.progress)
                predictiveBackProgress.snapTo(event.progress)
            }
            committed = true
            if (observedProgress > 0.001f) {
                predictiveBackProgress.animateTo(1f, animationSpec = AgentoMotion.AppleSpring)
            } else {
                predictiveBackProgress.snapTo(0f)
            }
            when (backLayer) {
                WorkbenchBackLayer.SubscriptionInfo -> onCloseSubscriptionInfo()
                WorkbenchBackLayer.GoogleSignInSuccess -> onGoogleSignInSuccessBack()
                WorkbenchBackLayer.PairingSignIn -> onPairingOnboardingEvent(PairingOnboardingEvent.BackToWelcome)
                WorkbenchBackLayer.DiffViewer -> { selectedDiffFile = null; detailParityEvent(WebParityEvent.CloseFile) }
                WorkbenchBackLayer.RunSheet -> runSheetOpen = false
                WorkbenchBackLayer.AgentPanel -> agentPanelOpen = false
                WorkbenchBackLayer.ConnectorPanel -> connectorPanelOpen = false
                WorkbenchBackLayer.GoalDialog -> onEvent(WorkbenchEvent.CloseGoalDialog)
                WorkbenchBackLayer.ComposerActionSheet -> composerActionSheetOpen = false
                WorkbenchBackLayer.Chat -> onEvent(WorkbenchEvent.CloseChat)
                WorkbenchBackLayer.Agent -> onEvent(WorkbenchEvent.CloseAgents)
                WorkbenchBackLayer.ProjectSessions -> onEvent(WorkbenchEvent.CloseProjectSessions)
                WorkbenchBackLayer.File -> parityEvent(WebParityEvent.CloseFile)
                WorkbenchBackLayer.SettingsPage -> onEvent(WorkbenchEvent.CloseSettingsPage)
                null -> Unit
            }
        } finally {
            if (!committed) {
                predictiveBackProgress.animateTo(0f, animationSpec = AgentoMotion.AppleSpring)
            } else {
                predictiveBackProgress.snapTo(0f)
            }
        }
    }

    // The native choice window does not own Back until it is attached and
    // focused. During that handoff, Back still belongs to the choice, not chat
    // navigation. Keep this later than the page's predictive handler.
    BackHandler(enabled = showAttention == null && state.chatOpen &&
        (state.runtimePickerOpen || state.effortPickerOpen)) {
        stableOnEvent(if (state.runtimePickerOpen) WorkbenchEvent.CloseRuntimePicker
            else WorkbenchEvent.CloseEffortPicker)
    }

    if (subscriptionInfoOpen) {
        SubscriptionInfoScreen(onBack = onCloseSubscriptionInfo)
    } else {
        pairingOnboardingState?.let { onboardingState ->
            when (onboardingState.step) {
                PairingOnboardingStep.Welcome,
                PairingOnboardingStep.ConnectionMethods,
                PairingOnboardingStep.GoogleRequired -> Unit
                else -> PairingOnboardingDialog(
                    state = onboardingState,
                    onEvent = onPairingOnboardingEvent,
                    onScanPairing = onScanPairing,
                    onScanPairingFromWelcome = onScanPairingFromWelcome,
                    onOpenSubscription = onOpenSubscription,
                )
            }
        }
    }
}

/**
 * Transport implementation names are useful in diagnostics, but they do not
 * help a person decide what to do in a conversation. Keep the recovery
 * affordance in chat and reserve protocol details for device diagnostics.
 */
private fun isTransportConnectionFailure(error: String): Boolean {
    val normalized = error.lowercase()
    return listOf("turn", "p2p", "webrtc", "carrier is available").any(normalized::contains)
}

/** A target-selection failure is recoverable setup work, not a retryable run failure. */
private fun isMissingRemoteTarget(error: String): Boolean =
    error.contains("no remote computer target", ignoreCase = true)

@Composable
private fun retryPresentation(error: String, isTransportFailure: Boolean): RetryUiState =
    when {
        isMissingRemoteTarget(error) -> RetryUiState(
            title = stringResource(R.string.workbench_connect_device_title),
            detail = stringResource(R.string.workbench_connect_device_detail),
            retryLabel = stringResource(R.string.workbench_connect_device_action),
        )
        isTransportFailure -> RetryUiState(
            title = stringResource(R.string.workbench_connection_unavailable_title),
            detail = stringResource(R.string.workbench_connection_unavailable_detail),
            retryLabel = stringResource(R.string.workbench_reconnect),
        )
        else -> RetryUiState("Action needs attention", error)
    }

@Composable
private fun TabletDetailSurface(
    navigationState: WorkbenchUiState,
    chatState: WorkbenchUiState,
    parityState: WebParityUiState,
    onParityEvent: (WebParityEvent) -> Unit,
    chatParityState: WebParityUiState,
    onChatParityEvent: (WebParityEvent) -> Unit,
    onEvent: (WorkbenchEvent) -> Unit,
    modifier: Modifier,
    backProgress: Float,
    composerActionSheetOpen: Boolean,
    onSetComposerActionSheetOpen: (Boolean) -> Unit,
    agentPanelOpen: Boolean = false,
    onSetAgentPanelOpen: (Boolean) -> Unit = {},
    connectorPanelOpen: Boolean = false,
    onSetConnectorPanelOpen: (Boolean) -> Unit = {},
    attachments: List<ComposerAttachment>,
    onSetAttachments: (List<ComposerAttachment>) -> Unit,
    editingTurnId: String?,
    editingTurnText: String?,
    onSetEditingTurn: (String?, String?) -> Unit,
    queuedMessages: List<QueuedMessageUiState>,
    activeDecision: DecisionQuestionUiState?,
    onSetActiveDecision: (DecisionQuestionUiState?) -> Unit,
    runSheetOpen: Boolean,
    onSetRunSheetOpen: (Boolean) -> Unit,
    selectedDiffFile: FileDiffDetail?,
    onSetSelectedDiffFile: (FileDiffDetail?) -> Unit,
    planMode: Boolean,
    onSetPlanMode: (Boolean) -> Unit,
) {
    WorkbenchBackStackTransition(
        isOpen = navigationState.chatOpen,
        backProgress = backProgress,
        modifier = modifier,
        parentContent = {
            val nestedBackProgress = if (navigationState.chatOpen) 0f else backProgress
            when {
                navigationState.agentOpen -> AgentSurface(
                    state = parityState,
                    onParityEvent = onParityEvent,
                    onEvent = onEvent,
                    currentProjectId = navigationState.browsingProjectId,
                    backProgress = if (!navigationState.chatOpen && parityState.selectedFile != null) backProgress else 0f,
                    modifier = Modifier.fillMaxSize(),
                )
                navigationState.destination == AgentoDestination.Sessions && navigationState.projectSessionsOpen -> {
                    SessionsSurface(
                        state = navigationState.copy(projectDialogOpen = false, chatOpen = false),
                        onEvent = onEvent,
                        windowSizeClass = AgentoWindowSizeClass.Compact,
                        showProjectCreateAction = true,
                        backProgress = nestedBackProgress,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                else -> TabletEmptyDetail(Modifier.fillMaxSize())
            }
        },
        childContent = {
            ChatSurface(
                state = chatState,
                parityState = chatParityState,
                onParityEvent = onChatParityEvent,
                onEvent = { event -> onEvent(if (event == WorkbenchEvent.Retry) WorkbenchEvent.RetryChat else event) },
                modifier = Modifier.fillMaxSize(),
                composerActionSheetOpen = composerActionSheetOpen,
                onSetComposerActionSheetOpen = onSetComposerActionSheetOpen,
                agentPanelOpen = agentPanelOpen,
                onSetAgentPanelOpen = onSetAgentPanelOpen,
                connectorPanelOpen = connectorPanelOpen,
                onSetConnectorPanelOpen = onSetConnectorPanelOpen,
                attachments = attachments,
                onSetAttachments = onSetAttachments,
                editingTurnId = editingTurnId,
                editingTurnText = editingTurnText,
                onSetEditingTurn = onSetEditingTurn,
                queuedMessages = queuedMessages,
                activeDecision = activeDecision,
                onSetActiveDecision = onSetActiveDecision,
                runSheetOpen = runSheetOpen,
                onSetRunSheetOpen = onSetRunSheetOpen,
                selectedDiffFile = selectedDiffFile,
                onSetSelectedDiffFile = onSetSelectedDiffFile,
                planMode = planMode,
                onSetPlanMode = onSetPlanMode,
            )
        },
    )
}

@Composable
private fun TabletEmptyDetail(modifier: Modifier) {
    AgentoSurface(modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Box(Modifier.fillMaxSize().statusBarsPadding(), contentAlignment = Alignment.Center) {
            AgentoEmptyState(
                title = "Select a project or session",
                body = "Choose from the list on the left to start.",
                modifier = Modifier.padding(16.dp),
            )
        }
    }
}

@Composable
private fun PrimaryNavigationSurface(
    state: WorkbenchUiState,
    accountsViewModel: AccountsViewModel?,
    brokerEnrollmentController: BrokerEnrollmentController?,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
    onRequestComputerDiscovery: () -> Unit,
    connectingTargetId: String?,
    parityState: WebParityUiState,
    onParityEvent: (WebParityEvent) -> Unit,
    onEvent: (WorkbenchEvent) -> Unit,
    folderBrowser: ProjectFolderBrowser,
    windowSizeClass: AgentoWindowSizeClass,
    backProgress: Float,
    modifier: Modifier,
) {
    val destinationState = rememberWorkbenchDestinationState()
    val projectPresentation = rememberProjectSessionsPresentation(state)
    val projectMotion = rememberWorkbenchBackStackMotion(
        isOpen = state.projectSessionsOpen && projectPresentation.detail != null,
        backProgress = if (state.agentOpen) 0f else backProgress,
    )
    val onCreateProjectSession = if (
        state.destination == AgentoDestination.Sessions &&
        state.projectSessionsOpen
    ) {
        state.browsingProjectId?.let { projectId ->
            { onEvent(WorkbenchEvent.OpenNewSession(projectId)) }
        }
    } else {
        null
    }

    WorkbenchBackStackTransition(
        isOpen = state.agentOpen,
        backProgress = backProgress,
        modifier = modifier.fillMaxSize(),
        parentContent = {
            val nestedBackProgress = if (state.agentOpen) 0f else backProgress
            AgentoAdaptiveScaffold(
                selected = state.destination,
                onDestinationSelected = { onEvent(WorkbenchEvent.SelectDestination(it)) },
                onCreateProject = { onEvent(WorkbenchEvent.OpenProjectDialog) },
                onCreateSession = onCreateProjectSession,
                projectActionProgress = projectMotion.presence,
                windowSizeClass = windowSizeClass,
                dockVisible = state.settingsPage == SettingsPage.Overview,
                modifier = Modifier.fillMaxSize(),
            ) { contentModifier, destination, visitId, active ->
                destinationState.Provider(destination.name, visitId, active) {
                when (destination) {
                    AgentoDestination.Sessions -> SessionsSurface(
                        state = state.copy(agentOpen = false, chatOpen = false),
                        onEvent = onEvent,
                        windowSizeClass = windowSizeClass,
                        folderBrowser = folderBrowser,
                        backProgress = nestedBackProgress,
                        modifier = contentModifier,
                        presentation = projectPresentation,
                        motion = projectMotion,
                    )
                    AgentoDestination.Home -> HomeSurface(state, onEvent, windowSizeClass, contentModifier)
                    AgentoDestination.Settings -> SettingsSurface(
                        accountsViewModel = accountsViewModel,
                        brokerEnrollmentController = brokerEnrollmentController,
                        onRequestGoogleSignIn = onRequestGoogleSignIn,
                        onRequestComputerDiscovery = onRequestComputerDiscovery,
                        connectingTargetId = connectingTargetId,
                        state = state.copy(agentOpen = false, chatOpen = false),
                        parityState = parityState,
                        onParityEvent = onParityEvent,
                        onEvent = onEvent,
                        backProgress = nestedBackProgress,
                        modifier = contentModifier,
                    )
                }
                }
            }
        },
        childContent = {
            AgentSurface(
                onEvent = onEvent,
                state = parityState,
                onParityEvent = onParityEvent,
                currentProjectId = state.browsingProjectId,
                backProgress = if (parityState.selectedFile != null) backProgress else 0f,
                modifier = Modifier.fillMaxSize(),
            )
        },
    )
}

@Immutable
private sealed interface ChatTimelineEntry {
    val id: String
    data class Single(val item: TimelineItem) : ChatTimelineEntry {
        override val id: String get() = item.id
    }
    /**
     * A tool invocation and its transient narration describe the same moment
     * in a run. They intentionally share one visual object, so a live turn
     * reads as a conversation instead of a stream of implementation logs.
     */
    data class LiveActivity(
        override val id: String,
        val operation: TimelineItem.Operation,
        val summary: String,
    ) : ChatTimelineEntry
    data class Pipeline(
        override val id: String,
        val operations: List<ToolCallUiState>,
    ) : ChatTimelineEntry
    data class FileChangeGroup(
        override val id: String,
        val state: FileChangeUiState,
    ) : ChatTimelineEntry
    data class StatusBanner(
        override val id: String,
        val state: TaskStatusUiState,
    ) : ChatTimelineEntry
    data class PendingTurn(
        override val id: String,
        val state: PendingTurnUiState,
    ) : ChatTimelineEntry
}

/**
 * Server migrations may temporarily expose two durable messages under the
 * same ID. Lazy lists need a unique render key, but a streaming message must
 * keep its ordinary ID stable while its sequence advances. Only duplicate IDs
 * therefore receive a sequence suffix.
 */
private fun uniqueTimelineRenderKeys(entries: List<ChatTimelineEntry>): List<String> {
    val counts = entries.groupingBy(ChatTimelineEntry::id).eachCount()
    return entries.mapIndexed { index, entry ->
        if (counts.getValue(entry.id) == 1) {
            entry.id
        } else {
            val suffix = (entry as? ChatTimelineEntry.Single)?.item?.seq ?: index.toLong()
            "${entry.id}-$suffix"
        }
    }
}

/**
 * Streaming updates ordinarily replace one trailing assistant item. Retain
 * the entry objects for the stable prefix so LazyColumn can skip their
 * composition rather than rebuilding operation/file grouping per token.
 */
private class ChatTimelineEntryProjector {
    private var previousItems: List<TimelineItem> = emptyList()
    private var previousEntries: List<ChatTimelineEntry> = emptyList()

    fun project(items: List<TimelineItem>, pendingTurn: PendingTurnUiState?): List<ChatTimelineEntry> {
        val stableEntries = if (canReplaceOnlyTrailingAgentMessage(items)) {
            previousEntries.dropLast(1) + ChatTimelineEntry.Single(items.last())
        } else {
            buildChatTimelineEntries(items)
        }
        previousItems = items
        previousEntries = stableEntries
        return if (pendingTurn == null) stableEntries else {
            stableEntries + ChatTimelineEntry.PendingTurn(
                id = "pending-${pendingTurn.requestId}",
                state = pendingTurn,
            )
        }
    }

    private fun canReplaceOnlyTrailingAgentMessage(items: List<TimelineItem>): Boolean {
        if (items.size != previousItems.size || items.isEmpty() || previousEntries.isEmpty()) return false
        if (items.last() !is TimelineItem.Message || previousItems.last() !is TimelineItem.Message) return false
        val currentTail = items.last() as TimelineItem.Message
        val previousTail = previousItems.last() as TimelineItem.Message
        if (currentTail.role != com.andysagent.agentoc.core.timeline.TimelineRole.Agent ||
            previousTail.role != com.andysagent.agentoc.core.timeline.TimelineRole.Agent ||
            previousEntries.lastOrNull() !is ChatTimelineEntry.Single
        ) return false
        for (index in 0 until items.lastIndex) {
            if (items[index] !== previousItems[index]) return false
        }
        return true
    }
}

private fun buildChatTimelineEntries(
    items: List<TimelineItem>,
    pendingTurn: PendingTurnUiState? = null,
): List<ChatTimelineEntry> {
    val result = mutableListOf<ChatTimelineEntry>()
    val currentCompletedGroup = mutableListOf<TimelineItem.Operation>()

    fun isFileChangeOperation(operation: TimelineItem.Operation): Boolean =
        (operation.kind == TimelineOperationKind.FileEdit || operation.kind == TimelineOperationKind.Diff) &&
            (operation.detail.isNotBlank() || operation.fileChanges.any { it.path.isNotBlank() })

    /**
     * A completed turn frequently moves between tools, file edits and commands.
     * Keep that sequence as one low-weight activity summary instead of making
     * each implementation step compete with the assistant's answer. Pure file
     * sequences still earn the richer file-change summary.
     */
    fun flushCompletedGroup() {
        if (currentCompletedGroup.size < 3) {
            currentCompletedGroup.forEach { result.add(ChatTimelineEntry.Single(it)) }
        } else if (currentCompletedGroup.all(::isFileChangeOperation)) {
            val files = currentCompletedGroup.map { op ->
                val lines = op.detail.lines()
                val additions = lines.count { it.startsWith("+") && !it.startsWith("+++") }
                val deletions = lines.count { it.startsWith("-") && !it.startsWith("---") }
                val explicitChange = op.fileChanges.firstOrNull { it.path.isNotBlank() }
                val path = explicitChange?.path ?: op.title
                FileChangeItem(
                    path = path,
                    name = path.substringAfterLast('/'),
                    type = when (explicitChange?.type?.lowercase()) {
                        "create", "created", "add", "added" -> FileChangeType.Created
                        "delete", "deleted", "remove", "removed" -> FileChangeType.Deleted
                        else -> FileChangeType.Modified
                    },
                    additions = explicitChange?.additions ?: additions,
                    deletions = explicitChange?.deletions ?: deletions,
                    diffSummary = op.detail.ifBlank { explicitChange?.diffSummary.orEmpty() },
                )
            }
            result.add(
                ChatTimelineEntry.FileChangeGroup(
                    id = "filegroup-${currentCompletedGroup.first().id}-${currentCompletedGroup.last().id}",
                    state = FileChangeUiState(
                        id = "filegroup-${currentCompletedGroup.first().id}",
                        files = files,
                    ),
                )
            )
        } else {
            val operations = currentCompletedGroup.map { op ->
                ToolCallUiState(
                    id = op.id,
                    kind = op.kind.toAgentKind(),
                    title = op.title,
                    detail = op.detail,
                    status = op.status.toAgentStatus(),
                    requiresApproval = op.requiresApproval,
                )
            }
            result.add(
                ChatTimelineEntry.Pipeline(
                    id = "pipeline-${currentCompletedGroup.first().id}-${currentCompletedGroup.last().id}",
                    operations = operations,
                )
            )
        }
        currentCompletedGroup.clear()
    }

    var itemIndex = 0
    while (itemIndex < items.size) {
        val item = items[itemIndex]
        if (item is TimelineItem.Operation && item.status == TimelineOperationStatus.Completed && !item.requiresApproval) {
            currentCompletedGroup.add(item)
        } else {
            flushCompletedGroup()
            val followingStream = items.getOrNull(itemIndex + 1) as? TimelineItem.Message
            if (
                item is TimelineItem.Operation &&
                item.status == TimelineOperationStatus.InProgress &&
                !item.requiresApproval &&
                followingStream?.role == com.andysagent.agentoc.core.timeline.TimelineRole.Agent &&
                !followingStream.completed
            ) {
                result.add(
                    ChatTimelineEntry.LiveActivity(
                        id = "live-${item.id}-${followingStream.id}",
                        operation = item,
                        summary = followingStream.text,
                    ),
                )
                itemIndex += 1
            } else {
                result.add(ChatTimelineEntry.Single(item))
            }
        }
        itemIndex += 1
    }
    flushCompletedGroup()
    pendingTurn?.let { pending -> result.add(ChatTimelineEntry.PendingTurn(id = "pending-${pending.requestId}", state = pending)) }
    return result
}

private enum class ChatScrollMode { Following, Detached, Returning }

/** 发送飞顶：新 turn 停靠视口顶的边距（对齐 web 侧 TOP_DOCK_MARGIN_PX = 24）。 */
private val TurnDockTopMargin = 24.dp

/** web launchUserMessageToTop 同款飞行曲线 cubic-bezier(0.16, 1, 0.3, 1)。 */
private val TurnFlightEasing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f)

/** 与 web launchUserMessageToTop 一致：位移不足时不播飞行。 */
private const val TurnFlightMinDeltaPx = 8

private const val TurnDockSpacerKey = "turn_dock_spacer"

/**
 * 发送飞顶的停靠目标：发送瞬间捕获 composer 顶部（root 坐标），把 pending turn
 * 停靠到视口顶；turn 高过一屏后交还 Following（filledScreen 出画是设计行为）。
 */
private data class TurnDockState(
    val sessionId: String,
    val requestId: String,
)

/**
 * 飞行动画的共享状态。Web 侧靠「echo 元素身份永不更换」（原地升级）保证飞行
 * 不因 sending→committed 换血中断；Compose 的时间行是独立组合单元，这里把进度、
 * 起点和气泡实时位置放在行外共享，pending 行与提交后的用户消息行接力读写同一份。
 */
private class TurnFlightState {
    var activeRequestId by mutableStateOf<String?>(null)
    var launchComposerTopPx by mutableIntStateOf(0)
    var bubbleTopPx by mutableIntStateOf(Int.MAX_VALUE)
    val progress = Animatable(0f)
}

/** 停靠执行器每一帧关心的原始布局量，全部取自 LazyListLayoutInfo。 */
private data class TurnDockSignal(
    val anchorIndex: Int,
    val anchorTop: Int,
    val anchorSize: Int,
    val lastContentEnd: Int,
    val viewportHeightPx: Int,
    val atAbsoluteTop: Boolean,
    val detached: Boolean,
)



private data class TimelineViewportSignal(
    val firstVisibleItemIndex: Int,
    val lastVisibleItemIndex: Int,
    val lastVisibleItemEnd: Int,
    val totalItemsCount: Int,
    val viewportEndOffset: Int,
)

private data class OlderTimelineAnchor(
    val itemId: String,
    val offset: Int,
    val keepAtBottom: Boolean = false,
)

private data class LatestViewportRequest(
    val sessionId: String,
    val animate: Boolean = false,
)

/**
 * Returns true for either the normal near-top paging trigger or a layout that
 * has no scroll range because its last item ends at or before the viewport.
 * Keeping this decision independent from Compose makes the short-history
 * boundary explicit and regression-testable.
 */
internal fun shouldRequestOlderTimelineForViewport(
    firstVisibleItemIndex: Int,
    lastVisibleItemIndex: Int,
    lastVisibleItemEnd: Int,
    totalItemsCount: Int,
    viewportEndOffset: Int,
): Boolean {
    if (totalItemsCount <= 0 || lastVisibleItemIndex < 0) return false
    if (firstVisibleItemIndex <= 1) return true
    return lastVisibleItemIndex >= totalItemsCount - 1
        && lastVisibleItemEnd <= viewportEndOffset
}

private data class PickedAttachmentMetadata(
    val name: String,
    val mimeType: String,
    val sizeBytes: Long,
)

private fun persistAttachmentReadPermission(context: android.content.Context, uri: android.net.Uri) {
    runCatching {
        context.contentResolver.takePersistableUriPermission(
            uri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
    }
}

private fun queryAttachmentMetadata(
    context: android.content.Context,
    uri: android.net.Uri,
    fallbackName: String,
    fallbackMimeType: String,
): PickedAttachmentMetadata {
    var name = fallbackName
    var sizeBytes = 0L
    runCatching {
        context.contentResolver.query(
            uri,
            arrayOf(
                android.provider.OpenableColumns.DISPLAY_NAME,
                android.provider.OpenableColumns.SIZE,
            ),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    .takeIf { it >= 0 }
                    ?.let { cursor.getString(it)?.takeIf(String::isNotBlank)?.let { value -> name = value } }
                cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                    .takeIf { it >= 0 && !cursor.isNull(it) }
                    ?.let { cursor.getLong(it).takeIf { value -> value > 0 }?.let { value -> sizeBytes = value } }
            }
        }
    }
    return PickedAttachmentMetadata(
        name = name,
        mimeType = context.contentResolver.getType(uri)?.takeIf(String::isNotBlank) ?: fallbackMimeType,
        sizeBytes = sizeBytes,
    )
}

private const val MAX_PASTED_IMAGE_BYTES = 50L * 1024L * 1024L

private fun imageFileExtension(mimeType: String): String = when (mimeType.lowercase()) {
    "image/jpeg", "image/jpg" -> "jpg"
    "image/gif" -> "gif"
    "image/webp" -> "webp"
    "image/heic" -> "heic"
    "image/heif" -> "heif"
    else -> "png"
}

private suspend fun copyClipboardImage(
    context: Context,
    uri: Uri,
): ComposerAttachment? = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri)?.takeIf { it.startsWith("image/", ignoreCase = true) }
        ?: "image/png"
    val directory = File(context.cacheDir, "shared/pasted-images").apply { mkdirs() }
    val extension = imageFileExtension(mimeType)
    val destination = runCatching {
        File.createTempFile("pasted-image-", ".$extension", directory)
    }.getOrNull() ?: return@withContext null

    val copiedBytes = runCatching {
        resolver.openInputStream(uri)?.use { input ->
            destination.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    require(total <= MAX_PASTED_IMAGE_BYTES) {
                        "Pasted image is larger than ${MAX_PASTED_IMAGE_BYTES / (1024 * 1024)} MB"
                    }
                    output.write(buffer, 0, read)
                }
                total
            }
        }
    }.getOrNull()
    if (copiedBytes == null || copiedBytes == 0L) {
        destination.delete()
        return@withContext null
    }

    val localUri = runCatching {
        FileProvider.getUriForFile(context, "${context.packageName}.files", destination)
    }.getOrElse {
        destination.delete()
        return@withContext null
    }
    ComposerAttachment(
        id = "clipboard-${destination.name}",
        name = "pasted-image.${extension}",
        mimeType = mimeType,
        sizeBytes = copiedBytes,
        localPath = localUri.toString(),
    )
}

@Composable
private fun ChatSurface(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    modifier: Modifier,
    parityState: WebParityUiState = WebParityUiState(),
    onParityEvent: (WebParityEvent) -> Unit = {},
    composerActionSheetOpen: Boolean = false,
    onSetComposerActionSheetOpen: (Boolean) -> Unit = {},
    agentPanelOpen: Boolean = false,
    onSetAgentPanelOpen: (Boolean) -> Unit = {},
    connectorPanelOpen: Boolean = false,
    onSetConnectorPanelOpen: (Boolean) -> Unit = {},
    attachments: List<ComposerAttachment> = emptyList(),
    onSetAttachments: (List<ComposerAttachment>) -> Unit = {},
    editingTurnId: String? = null,
    editingTurnText: String? = null,
    onSetEditingTurn: (String?, String?) -> Unit = { _, _ -> },
    queuedMessages: List<QueuedMessageUiState> = emptyList(),
    activeDecision: DecisionQuestionUiState? = null,
    onSetActiveDecision: (DecisionQuestionUiState?) -> Unit = {},
    runSheetOpen: Boolean = false,
    onSetRunSheetOpen: (Boolean) -> Unit = {},
    selectedDiffFile: FileDiffDetail? = null,
    onSetSelectedDiffFile: (FileDiffDetail?) -> Unit = {},
    planMode: Boolean = false,
    onSetPlanMode: (Boolean) -> Unit = {},
) {
    val turnGroupProjector = remember(state.sessionId) { TurnGroupProjector() }
    val turnGroups = remember(state.timelineItems, state.pendingTurn, state.acceptedTurns, state.runStatus, state.runMetrics) {
        val terminal = latestTurnHasTerminalRun(state.timelineItems, state.pendingTurn, state.runStatus, state.runMetrics)
        val items = com.andysagent.agentoc.core.timeline.settleLatestTurnMessages(state.timelineItems, terminal)
        turnGroupProjector.project(items, state.pendingTurn, state.acceptedTurns)
    }
    val lastAgentEntryIndex = remember(turnGroups) {
        turnGroups.indexOfLast { it.finalAnswer?.completed == true }
    }
    // An already available history must be measured at its entry anchor, not
    // painted at item zero and corrected after the page has started sliding in.
    val listState = key(state.sessionId) {
        rememberLazyListState(initialFirstVisibleItemIndex =
            if (!state.historyLoading && (state.timelineSessionId == null || state.timelineSessionId == state.sessionId))
                (lastAgentEntryIndex.takeIf { it >= 0 } ?: turnGroups.lastIndex).coerceAtLeast(0)
            else 0)
    }
    var entryDocuments by remember(state.sessionId) {
        mutableStateOf<Map<String, List<MarkdownBlock>>>(emptyMap())
    }
    var appliedEntryDocuments by remember(state.sessionId) {
        mutableStateOf<Map<String, List<MarkdownBlock>>>(emptyMap())
    }

    // 发送飞顶整链（对齐 web 57fd9d64+9c65bf5a+1ac7687c）：
    // 发送瞬间捕获 composer 顶（root 坐标），pending turn 停靠视口顶 + 气泡起飞。
    var armedSendComposerTopPx by remember { mutableStateOf<Int?>(null) }
    var turnDock by remember { mutableStateOf<TurnDockState?>(null) }
    var turnDockSpacerPx by remember { mutableIntStateOf(0) }
    // 用户滚走后的暂时脱离：停靠本体（锚点+spacer）保留，回到尾部即重新吸附。
    // 对齐 web 侧 scroll-detach 生命周期（realtime-render.js 3a50af89）：脱离是
    // 用户意图，只在回合边界清除（新发送/审批回收/换会话/FAB），节奏类复位
    // 一律不碰它。
    var turnDockDetached by remember { mutableStateOf(false) }
    var programmaticDockScroll by remember { mutableStateOf(false) }
    val dockFlight = remember { TurnFlightState() }
    val latestTurnDock = rememberUpdatedState(turnDock)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var initiallyPositionedSessionId by remember(state.sessionId) { mutableStateOf<String?>(null) }
    var sessionEntryBottomPinActive by remember { mutableStateOf(false) }
    var renameDialogOpen by remember { mutableStateOf(false) }
    var deleteDialogOpen by remember { mutableStateOf(false) }
    var voiceDevicePickerOpen by remember { mutableStateOf(false) }
    var approvalCollapsed by rememberSaveable(state.sessionId) { mutableStateOf(false) }
    var renameText by remember(state.sessionId, state.sessionTitle) { mutableStateOf(state.sessionTitle) }
    var scrollMode by remember { mutableStateOf(ChatScrollMode.Following) }
    var olderTimelineAnchor by remember(state.sessionId) { mutableStateOf<OlderTimelineAnchor?>(null) }
    val currentAttachments = rememberUpdatedState(attachments)

    fun appendClipboardImages(uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            val pasted = uris.distinct().mapNotNull { uri ->
                copyClipboardImage(context, uri)
            }
            if (pasted.isNotEmpty()) {
                onSetAttachments(currentAttachments.value + pasted)
            }
        }
    }

    val photoPickerLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        contract = androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(5),
    ) { uris ->
        if (uris.isNotEmpty()) {
            val newAttachments = uris.mapIndexed { index, uri ->
                persistAttachmentReadPermission(context, uri)
                val metadata = queryAttachmentMetadata(context, uri, "image_$index.png", "image/png")
                ComposerAttachment(
                    name = metadata.name,
                    mimeType = metadata.mimeType,
                    sizeBytes = metadata.sizeBytes,
                    localPath = uri.toString(),
                )
            }
            onSetAttachments(attachments + newAttachments)
        }
    }

    val documentPickerLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        contract = androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isNotEmpty()) {
            val newAttachments = uris.mapIndexed { index, uri ->
                persistAttachmentReadPermission(context, uri)
                val metadata = queryAttachmentMetadata(context, uri, "document_$index.txt", "application/octet-stream")
                ComposerAttachment(
                    name = metadata.name,
                    mimeType = metadata.mimeType,
                    sizeBytes = metadata.sizeBytes,
                    localPath = uri.toString(),
                )
            }
            onSetAttachments(attachments + newAttachments)
        }
    }

    val latestViewportRequests = remember {
        MutableSharedFlow<LatestViewportRequest>(
            extraBufferCapacity = 1,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )
    }
    val latestTurnGroups = rememberUpdatedState(turnGroups)
    val statusActive = state.pendingTurn?.state == PendingTurnState.Sending ||
        state.runStatus == AgentRunStatus.Working || state.runStatus == AgentRunStatus.WaitingApproval
    val activityRunId = (state.serverRunActivity?.get("runId") as? kotlinx.serialization.json.JsonPrimitive)?.content
    val activityRequestId = (state.serverRunActivity?.get("requestId") as? kotlinx.serialization.json.JsonPrimitive)?.content
    val activeTurnIndex = if (statusActive || state.connection != AgentConnectionStatus.Connected) {
        activeRunTurnIndex(turnGroups, activityRunId, activityRequestId)
    } else turnGroups.lastIndex
    val activeTurn = turnGroups.getOrNull(activeTurnIndex)
    val durationTurnKey = activeTurn?.requestId ?: activeTurn?.userPrompt?.id
    var observedActive by remember(state.sessionId, durationTurnKey) { mutableStateOf(false) }
    val terminalStatus = state.runStatus in setOf(AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled)
    LaunchedEffect(statusActive, terminalStatus, state.connection) {
        if (statusActive) observedActive = true
        else if (terminalStatus && state.connection == AgentConnectionStatus.Connected) observedActive = false
    }
    val showActiveRunAction = statusActive ||
        (observedActive && state.connection != AgentConnectionStatus.Connected)
    var runStartedElapsed by remember(state.sessionId, durationTurnKey) { mutableLongStateOf(Long.MAX_VALUE) }
    var runElapsedSeconds by remember(state.sessionId, durationTurnKey) { mutableLongStateOf(-1L) }
    val currentRunId = activeTurn?.runId ?: activityRunId?.takeIf { activityRequestId != null && activityRequestId == activeTurn?.requestId }
    val activityMatchesTurn = (currentRunId != null && activityRunId == currentRunId) ||
        (durationTurnKey != null && activityRequestId == durationTurnKey)
    val serverElapsed = (state.serverRunActivity?.get("runElapsedMs") as? kotlinx.serialization.json.JsonPrimitive)
        ?.content?.toLongOrNull()?.takeIf { it >= 0 && activityMatchesTurn }
    LaunchedEffect(state.sessionId, durationTurnKey, showActiveRunAction, serverElapsed) {
        if (!showActiveRunAction) return@LaunchedEffect
        val now = android.os.SystemClock.elapsedRealtime()
        runStartedElapsed = updateRunElapsedAnchor(runStartedElapsed, serverElapsed, now)
        if (runStartedElapsed == Long.MAX_VALUE) return@LaunchedEffect
        while (true) {
            runElapsedSeconds = runElapsedSeconds(runStartedElapsed, android.os.SystemClock.elapsedRealtime(), runElapsedSeconds)
            kotlinx.coroutines.delay(1_000)
        }
    }
    // Match the actual LazyColumn content, including a pending question but
    // excluding the artificial runway used to dock a newly submitted turn.
    val timelineContentItemCount = turnGroups.size + (if (activeDecision != null) 1 else 0) +
        (if (turnGroups.isEmpty() && state.timelineItems.isEmpty() && state.error == null) 1 else 0)
    val latestContentItemCount = rememberUpdatedState(timelineContentItemCount)
    val latestSessionId = rememberUpdatedState(state.sessionId)
    val latestChatOpen = rememberUpdatedState(state.chatOpen)
    val latestHistoryLoading = rememberUpdatedState(state.historyLoading)
    val latestEntryReady = rememberUpdatedState(turnGroups.isEmpty() || initiallyPositionedSessionId == state.sessionId)

    fun requestLatestViewport(sessionId: String, animate: Boolean = false) {
        latestViewportRequests.tryEmit(LatestViewportRequest(sessionId, animate))
    }

    // There are several legitimate reasons to follow the tail (entry, IME,
    // approval, composer clearance, and streaming). Route them through one
    // latest-value consumer so competing effects cannot perform consecutive
    // scroll transactions in the same layout window.
    LaunchedEffect(latestViewportRequests, listState) {
        latestViewportRequests.collectLatest { request ->
            withFrameNanos { }
            if (!latestChatOpen.value || latestHistoryLoading.value || latestSessionId.value != request.sessionId) return@collectLatest
            if (!latestEntryReady.value) return@collectLatest
            // 停靠期间视口由停靠执行器全权接管，其余触发不得抢滚动。
            if (latestTurnDock.value != null) return@collectLatest
            val lastContentIndex = latestContentItemCount.value - 1
            if (lastContentIndex < 0) return@collectLatest
            programmaticDockScroll = true
            try {
                listState.scrollToTimelineTail(lastContentIndex, animate = request.animate)
            } finally {
                programmaticDockScroll = false
            }
        }
    }

    // A null owner is the legacy/static preview state; once the ViewModel has
    // started observing history it always supplies the owning session id.
    val timelineBelongsToCurrentSession = state.timelineSessionId == null
        || state.timelineSessionId == state.sessionId
    val historyTransitioning = state.historyLoading || (
        state.timelineItems.isNotEmpty() && !timelineBelongsToCurrentSession
    )

    // Run Sheet data comes from the ViewModel's server-backed projection.
    // Do not infer files or elapsed time from visible message/step counts.
    val stepTraces = state.stepTraces
    val changedFiles = state.changedFiles
    val runMetrics = state.runMetrics.copy(
        status = state.runStatus,
        toolCallsCount = stepTraces.size,
        filesChangedCount = changedFiles.size,
    )

    // This presentation survives a partially reversed Back. Do not reset its
    // viewport on Close: the outgoing page must retain exactly what was read.
    // After a completed exit the child unmounts, so a fresh entry starts anew.
    LaunchedEffect(state.chatOpen, state.sessionId, state.historyLoading, state.timelineSessionId, turnGroups.size, lastAgentEntryIndex) {
        val sessionId = state.sessionId
        if (state.chatOpen && sessionId != null && !state.historyLoading &&
            timelineBelongsToCurrentSession && turnGroups.isEmpty()) {
            // An empty chat is ready for a new turn, not restored reading.
            // Mark it before the first streamed message can trigger restoration.
            initiallyPositionedSessionId = sessionId
            scrollMode = ChatScrollMode.Following
            return@LaunchedEffect
        }
        if (
            state.chatOpen &&
            sessionId != null &&
            !state.historyLoading &&
            timelineBelongsToCurrentSession &&
            initiallyPositionedSessionId != sessionId &&
            turnGroups.isNotEmpty()
        ) {
            // Start a restored conversation at the beginning of its newest
            // reply. Pinning a tall terminal reply to the bottom exposed a
            // clipped fragment of the preceding turn beneath the fixed
            // toolbar, which made the first screen feel broken. New output
            // still follows the tail after the user sends or resumes work.
            // Set the reader mode before the first layout frame so the
            // follow-tail effect cannot race this restored position.
            scrollMode = ChatScrollMode.Detached
            sessionEntryBottomPinActive = false
            val restorationTarget = lastAgentEntryIndex.takeIf { it >= 0 } ?: turnGroups.lastIndex
            // Prepare the loaded snapshot, including offscreen older replies:
            // scrolling must not shrink them to provisional loading rows and
            // then grow them back while the reader's gesture is in progress.
            // The viewport is published after real blocks have been laid out,
            // not after an arbitrary three frames.
            fun documentsAt(indices: List<Int>) = indices.flatMap { index ->
                val turn = turnGroups.getOrNull(index) ?: return@flatMap emptyList()
                turn.agentMessages.ifEmpty { listOfNotNull(turn.finalAnswer ?: turn.streamingAnswer) }
                    .map { if (it.completed) it.text else autoCloseMarkdownSyntax(it.text) }
            }.distinct()
            entryDocuments = entryDocuments + prepareMarkdownDocuments(documentsAt(turnGroups.indices.toList()))
            // A clock delay alone cannot prove that the prepared documents
            // reached the LazyColumn's composition. Wait for that actual apply
            // before forcing its anchor measurement.
            snapshotFlow { appliedEntryDocuments === entryDocuments }.first { it }
            listState.scrollToItem(restorationTarget, 0)
            // Allow the measured anchor to draw while still unpublished. Short
            // exchanges naturally clamp/backfill; tall replies retain the top.
            withFrameNanos { }
            initiallyPositionedSessionId = sessionId
        }
    }
    val entryPreparing = turnGroups.isNotEmpty() &&
        initiallyPositionedSessionId != state.sessionId
    val readingPreparing = historyTransitioning || entryPreparing
    val readingReveal by animateFloatAsState(
        targetValue = if (readingPreparing) 0f else 1f,
        animationSpec = tween(motionPolicy().duration(220), easing = FastOutSlowInEasing),
        label = "chat_preparing_to_reading",
    )

    val latestHasOlder = rememberUpdatedState(state.hasOlder)
    val latestLoadingOlder = rememberUpdatedState(state.loadingOlder)
    val latestPositionedSession = rememberUpdatedState(initiallyPositionedSessionId)
    LaunchedEffect(
        state.chatOpen,
        state.sessionId,
        initiallyPositionedSessionId,
        state.loadingOlder,
        state.hasOlder,
        olderTimelineAnchor?.itemId,
    ) {
        snapshotFlow {
            val layoutInfo = listState.layoutInfo
            val first = layoutInfo.visibleItemsInfo.firstOrNull()
            val last = layoutInfo.visibleItemsInfo.lastOrNull()
            TimelineViewportSignal(
                firstVisibleItemIndex = first?.index ?: -1,
                lastVisibleItemIndex = last?.index ?: -1,
                lastVisibleItemEnd = last?.let { it.offset + it.size } ?: 0,
                totalItemsCount = layoutInfo.totalItemsCount,
                viewportEndOffset = layoutInfo.viewportEndOffset,
            )
        }.collect { viewport ->
            val sessionId = state.sessionId
            if (
                !state.chatOpen ||
                sessionId == null ||
                latestPositionedSession.value != sessionId ||
                !latestHasOlder.value ||
                latestLoadingOlder.value ||
                olderTimelineAnchor != null ||
                !shouldRequestOlderTimelineForViewport(
                    firstVisibleItemIndex = viewport.firstVisibleItemIndex,
                    lastVisibleItemIndex = viewport.lastVisibleItemIndex,
                    lastVisibleItemEnd = viewport.lastVisibleItemEnd,
                    totalItemsCount = viewport.totalItemsCount,
                    viewportEndOffset = viewport.viewportEndOffset,
                )
            ) return@collect
            val entry = latestTurnGroups.value.getOrNull(viewport.firstVisibleItemIndex) ?: return@collect
            val visible = listState.layoutInfo.visibleItemsInfo.firstOrNull {
                it.index == viewport.firstVisibleItemIndex
            }
                ?: return@collect
            val contentUnderfillsViewport = viewport.lastVisibleItemIndex >= viewport.totalItemsCount - 1
                && viewport.lastVisibleItemEnd <= viewport.viewportEndOffset
            olderTimelineAnchor = OlderTimelineAnchor(
                itemId = entry.id,
                offset = visible.offset,
                keepAtBottom = contentUnderfillsViewport,
            )
            onEvent(WorkbenchEvent.LoadOlderTimeline)
        }
    }

    LaunchedEffect(turnGroups, state.loadingOlder) {
        val anchor = olderTimelineAnchor ?: return@LaunchedEffect
        if (state.loadingOlder) return@LaunchedEffect
        val restoredIndex = turnGroups.indexOfFirst { it.id == anchor.itemId }
        if (anchor.keepAtBottom && turnGroups.isNotEmpty()) {
            listState.scrollToTimelineTail(latestContentItemCount.value - 1, animate = false)
        } else if (restoredIndex >= 0) {
            listState.scrollToItem(restoredIndex, anchor.offset)
        }
        olderTimelineAnchor = null
        scrollMode = if (anchor.keepAtBottom) ChatScrollMode.Following else ChatScrollMode.Detached
    }

    LaunchedEffect(state.approval?.id) {
        if (state.approval == null) approvalCollapsed = false
        if (!state.historyLoading && timelineBelongsToCurrentSession && state.approval != null && turnGroups.isNotEmpty()) {
            // 审批卡要用户看到：放掉飞顶停靠，让位给动画滚到底部的请求。
            turnDock = null
            turnDockSpacerPx = 0
            turnDockDetached = false
            state.sessionId?.let { requestLatestViewport(it, animate = true) }
        }
    }

    val isAtBottom by remember {
        derivedStateOf {
            val layoutInfo = listState.layoutInfo
            val lastContentIndex = latestContentItemCount.value - 1
            val tail = layoutInfo.visibleItemsInfo.firstOrNull { it.index == lastContentIndex }
            isTimelineTailVisible(
                lastContentIndex = lastContentIndex,
                visibleContentIndex = tail?.index,
                visibleContentBottom = tail?.let { it.offset.toLong() + it.size },
                viewportEnd = layoutInfo.viewportEndOffset,
                bottomContentPadding = layoutInfo.afterContentPadding,
            )
        }
    }

    var imeSettling by remember { mutableStateOf(false) }

    val readerDragging by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(readerDragging, isAtBottom, listState.isScrollInProgress, imeSettling, programmaticDockScroll, turnDock, turnDockDetached) {
        // IME resize/padding changes also drive LazyColumn scrolling. Do not treat
        // that system animation as the user detaching from the conversation tail.
        if (imeSettling) return@LaunchedEffect
        if (programmaticDockScroll) return@LaunchedEffect
        if (turnDock != null) {
            // 停靠期间滚动只可能是用户发起（程序性滚动已被上面吞掉）。滚走 =
            // 暂时脱离而非销毁停靠：锚点与 spacer 保留，回到尾部（isAtBottom 且
            // 手停）自动恢复吸附，执行器随后按停靠/满屏两种稳态归位。
            if (readerDragging && !isAtBottom) {
                turnDockDetached = true
            } else if (!listState.isScrollInProgress && isAtBottom && turnDockDetached) {
                turnDockDetached = false
            }
            return@LaunchedEffect
        }
        if (readerDragging) {
            if (!isAtBottom) {
                scrollMode = ChatScrollMode.Detached
            }
        } else {
            if (isAtBottom && scrollMode != ChatScrollMode.Returning && scrollMode != ChatScrollMode.Detached) {
                scrollMode = ChatScrollMode.Following
            }
        }
    }

    LaunchedEffect(state.chatOpen, state.sessionId, state.historyLoading, state.timelineSessionId, turnGroups.size, state.loadingOlder, turnDock) {
        if (state.chatOpen && !state.historyLoading && timelineBelongsToCurrentSession && initiallyPositionedSessionId == state.sessionId && !state.loadingOlder && olderTimelineAnchor == null && scrollMode == ChatScrollMode.Following && turnGroups.isNotEmpty() && turnDock == null) {
            state.sessionId?.let { requestLatestViewport(it) }
        }
    }

    // A streamed reply grows within one existing lazy item. Item count alone
    // cannot trigger tail following. Observe measured size, not scroll offset,
    // so our own scroll does not feed back into another request.
    LaunchedEffect(state.sessionId, state.chatOpen, state.historyLoading, timelineBelongsToCurrentSession, scrollMode, turnDock, turnDockDetached) {
        val sessionId = state.sessionId ?: return@LaunchedEffect
        if (scrollMode != ChatScrollMode.Following || turnDock != null || turnDockDetached) return@LaunchedEffect
        snapshotFlow {
            val layout = listState.layoutInfo
            val tailIndex = latestContentItemCount.value - 1
            layout.visibleItemsInfo.takeIf { it.isNotEmpty() }?.let { visible ->
                Triple(tailIndex, visible.sumOf { it.size }, layout.viewportEndOffset - layout.viewportStartOffset)
            }
        }.collect { geometry ->
            if (geometry != null && state.chatOpen && !state.historyLoading && timelineBelongsToCurrentSession) {
                requestLatestViewport(sessionId)
            }
        }
    }

    val hostName = remember(state.activeRemoteTargetId, state.remoteTargets, state.computers) {
        activeComputerDisplayName(
            activeTargetId = state.activeRemoteTargetId,
            remoteTargets = state.remoteTargets,
            computers = state.computers,
            fallback = "This computer",
        )
    }

    val dockGeometry = remember { ChatDockGeometry() }
    val topControlGeometry = remember(state.sessionId) { ChatTopControlGeometry() }
    var composerExpanded by rememberSaveable { mutableStateOf(false) }
    // Queue rows are server-owned. Keep only the edit intent locally so the
    // original row remains durable until the user explicitly sends its edit.
    var editingQueuedMessageId by remember(state.sessionId) { mutableStateOf<String?>(null) }
    var editingQueuedOriginalText by remember(state.sessionId) { mutableStateOf<String?>(null) }
    var editingQueuedAttachmentCount by remember(state.sessionId) { mutableIntStateOf(0) }
    var composerFullscreen by rememberSaveable(state.sessionId) { mutableStateOf(false) }
    val composerFullscreenProgress by animateFloatAsState(
        targetValue = if (composerFullscreen) 1f else 0f,
        animationSpec = tween(motionPolicy().duration(300), easing = FastOutSlowInEasing),
        label = "composer_fullscreen_geometry",
    )
    val composerFullscreenActive = composerFullscreen || composerFullscreenProgress > 0f
    // The breathing room below the visible shell belongs to the dock, not to
    // a second strip of transcript. Share it with the reading edge; glass keeps
    // sampling the complete pre-mask document underneath.
    val composerBottomSpacing = 10.dp - 2.dp * composerFullscreenProgress
    LaunchedEffect(state.approval?.id) {
        // A newly raised approval must remain reachable instead of hiding
        // behind an editor whose send action has just become disabled.
        if (state.approval != null) composerFullscreen = false
    }
    // Dynamic Island for the approval dock: a freshly raised request keys a
    // new remember scope, so it always opens expanded; tapping outside (or
    // the collapsed pill) hands control back to the user. The card can be
    // re-expanded from the pill until an action resolves the request.
    var approvalDockExpanded by remember(state.approval?.id) { mutableStateOf(true) }
    // Existing queue entries load quietly. Only a newly accepted message in
    // this Session opens the island automatically; a newer message restarts
    // its short expanded dwell, while a manual expand cancels that timer.
    var queueDockExpanded by remember(state.sessionId) { mutableStateOf(false) }
    var seenQueueIds by remember(state.sessionId) {
        mutableStateOf(state.queuedMessages.map { it.id }.toSet())
    }
    var queueAutoCollapseGeneration by remember(state.sessionId) { mutableIntStateOf(0) }
    LaunchedEffect(state.sessionId, state.queuedMessages) {
        val currentIds = state.queuedMessages.map { it.id }.toSet()
        if (currentIds.any { it !in seenQueueIds } && state.approval == null) {
            queueDockExpanded = true
            queueAutoCollapseGeneration += 1
        }
        if (currentIds.isEmpty()) queueDockExpanded = false
        seenQueueIds = currentIds
    }
    LaunchedEffect(queueAutoCollapseGeneration, state.approval?.id) {
        if (queueAutoCollapseGeneration > 0 && state.approval == null) {
            kotlinx.coroutines.delay(3_600)
            queueDockExpanded = false
            queueAutoCollapseGeneration = 0
        }
    }
    LaunchedEffect(state.approval?.id) {
        if (state.approval != null) {
            queueDockExpanded = false
            queueAutoCollapseGeneration = 0
        }
    }
    // Top run-details Dynamic Island: the header title capsule expands in
    // place into the run panorama card (replaces the phone bottom sheet).
    val runIslandExpanded = runSheetOpen
    fun openRunIsland() = onSetRunSheetOpen(true)
    fun dismissRunIsland() = onSetRunSheetOpen(false)
    var composerBounds by remember { mutableStateOf(Rect.Zero) }
    var chatCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val statusBarTop = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateTopPadding()
    val topControlsHeight = statusBarTop + 56.dp
    val scrollThresholdPx = with(density) { 24.dp.roundToPx() }
    val isScrolledPastHeader by remember {
        derivedStateOf {
            listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > scrollThresholdPx
        }
    }
    val currentProjectName = remember(state.projects, state.selectedProjectId, state.projectName) {
        state.projects.find { it.id == state.selectedProjectId }?.name ?: state.projectName.takeIf { it.isNotBlank() }
    }
    val currentDeviceName = remember(state.computers, state.remoteTargets, state.activeRemoteTargetId) {
        state.remoteTargets.firstOrNull { it.instanceId == state.activeRemoteTargetId }?.label
            ?: state.computers.firstOrNull { it.id == state.activeRemoteTargetId }?.name
            ?: state.activeRemoteTargetId
            ?: state.computers.firstOrNull { it.connected }?.name
            ?: state.remoteTargets.firstOrNull()?.label
            ?: state.computers.firstOrNull()?.name
    }
    var taskSettingsOpen by rememberSaveable { mutableStateOf(false) }
    val turnDockSpacerDp = with(density) { turnDockSpacerPx.toDp() }
    val conversationPadding = remember(dockGeometry, density, topControlsHeight) {
        dockGeometry.padding(density, top = topControlsHeight + 8.dp, extraBottom = 16.dp)
    }
    val jumpPadding = remember(dockGeometry, density) {
        dockGeometry.padding(density, extraBottom = 12.dp)
    }

    val jumpMotion = motionPolicy()
    val latestReplySignal = remember(turnGroups) {
        turnGroups.asReversed().firstNotNullOfOrNull { turn ->
            val reply = turn.agentMessages.lastOrNull { it.text.isNotBlank() }
                ?: turn.finalAnswer?.takeIf { it.text.isNotBlank() }
                ?: turn.streamingAnswer?.takeIf { it.text.isNotBlank() }
            reply?.let {
                TimelineReplySignal(turn.userPrompt?.requestId ?: turn.userPrompt?.id ?: turn.requestId ?: it.runId ?: turn.id, it.seq)
            }
        }
    }
    val jumpHint = rememberTimelineJumpHint(
        sessionKey = state.activeRemoteTargetId to state.sessionId,
        listState = listState,
        contentItemCount = timelineContentItemCount,
        suppressed = !state.chatOpen || readingPreparing || state.loadingOlder || olderTimelineAnchor != null ||
            imeSettling || programmaticDockScroll ||
            composerFullscreenActive || state.runtimePickerOpen || state.effortPickerOpen ||
            composerActionSheetOpen || runIslandExpanded || state.sessionMenuOpen || state.goalDialogOpen ||
            (state.approval != null && approvalDockExpanded),
        reply = latestReplySignal,
        baselineReplies = historyTransitioning || entryPreparing || state.loadingOlder,
        enterMillis = jumpMotion.duration(120),
    )
    var returnToBottomJob by remember(listState) { mutableStateOf<Job?>(null) }
    DisposableEffect(listState) { onDispose { returnToBottomJob?.cancel() } }
    val jumpGestureConnection = remember(listState, jumpHint) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) {
                    returnToBottomJob?.cancel()
                    scrollMode = ChatScrollMode.Detached
                    if (turnDock != null) turnDockDetached = true
                    jumpHint.userScrolled()
                }
                return Offset.Zero
            }
        }
    }

    val imeInsets = WindowInsets.ime
    // The dock is excluded from the list viewport below. Retain only a small
    // in-list breathing space so its own inset is not counted twice.
    val targetBottomPadding = 24.dp
    val animatedBottomPadding by animateDpAsState(
        targetValue = targetBottomPadding,
        animationSpec = spring(
            dampingRatio = 0.85f,
            stiffness = 380f,
        ),
        label = "chatBottomClearance",
    )
    // 发送飞顶武装：本端发送产生的 pending turn 出现时，建立视口顶停靠并起飞。
    // Retry（Failed→Sending 同 requestId）不重武装：停靠若还活着就继续用。
    val dockMotion = motionPolicy()
    LaunchedEffect(state.sessionId, state.pendingTurn?.requestId) {
        val pending = state.pendingTurn ?: return@LaunchedEffect
        val sessionId = state.sessionId ?: return@LaunchedEffect
        if (pending.state != PendingTurnState.Sending) return@LaunchedEffect
        if (turnDock?.requestId == pending.requestId) return@LaunchedEffect
        val launchTop = armedSendComposerTopPx ?: return@LaunchedEffect
        armedSendComposerTopPx = null
        // Sending is an explicit request to resume following this new turn,
        // even when the previous conversation was opened in reading mode.
        initiallyPositionedSessionId = sessionId
        scrollMode = ChatScrollMode.Following
        turnDock = TurnDockState(sessionId, pending.requestId)
        turnDockDetached = false
        if (dockMotion.preference == MotionPreference.None) return@LaunchedEffect
        dockFlight.launchComposerTopPx = launchTop
        dockFlight.bubbleTopPx = Int.MAX_VALUE
        dockFlight.progress.snapTo(0f)
        dockFlight.activeRequestId = pending.requestId
    }

    // 飞行进度跑通行外的共享 Animatable：380ms cubic-bezier(0.16,1,0.3,1)，
    // 与 web WAAPI 实现同曲线同时长；pending 行在 ACK 早到时被换血，提交后的
    // 用户消息行接力绘制同一段进度，视觉上等于 web 的元素身份不换。
    LaunchedEffect(dockFlight.activeRequestId) {
        if (dockFlight.activeRequestId == null) return@LaunchedEffect
        dockFlight.progress.animateTo(
            1f,
            tween(durationMillis = dockMotion.duration(380), easing = TurnFlightEasing),
        )
        dockFlight.activeRequestId = null
    }

    // 停靠执行器：把 turn 顶边压到视口顶 24dp；尾随 spacer 提供精确滚动余量
    // （web 的 turn runway 零余量不变量）。内容在下方生长时锚点不动、只收缩
    // spacer；turn 高过一屏（spacer 归零仍放不下）时交还 Following 滚到底。
    LaunchedEffect(turnDock) {
        val dock = turnDock ?: return@LaunchedEffect
        val requestId = dock.requestId
        val topGapPx = with(density) { TurnDockTopMargin.roundToPx() }
        val spacingPx = with(density) { AgentoSpacing.Block.roundToPx() }
        var dockedOnce = false
        snapshotFlow {
            val entries = latestTurnGroups.value
            val layout = listState.layoutInfo
            val anchorIndex = resolveTurnDockAnchorIndex(entries, requestId)
            val anchorInfo = layout.visibleItemsInfo.firstOrNull { it.index == anchorIndex }
            val lastContent = layout.visibleItemsInfo.lastOrNull { it.key != TurnDockSpacerKey }
            val first = layout.visibleItemsInfo.firstOrNull()
            TurnDockSignal(
                anchorIndex = anchorIndex,
                anchorTop = anchorInfo?.offset ?: Int.MIN_VALUE,
                anchorSize = anchorInfo?.size ?: 0,
                lastContentEnd = if (lastContent != null && anchorIndex >= 0 && lastContent.index >= anchorIndex) {
                    lastContent.offset + lastContent.size
                } else {
                    Int.MIN_VALUE
                },
                viewportHeightPx = layout.viewportEndOffset - layout.viewportStartOffset,
                atAbsoluteTop = first == null || (first.index == 0 && first.offset >= 0),
                // 在 flow 里读：脱离/吸附翻转本身也要触发执行器重评，
                // 否则停住的手停在吸附线上时没人归位。
                detached = turnDockDetached,
            )
        }.collect { signal ->
            if (!state.chatOpen || state.historyLoading || !timelineBelongsToCurrentSession) return@collect
            if (signal.anchorIndex < 0) return@collect
            val topInsetPx = with(density) { (topControlsHeight + AgentoSpacing.Block).roundToPx() }
            val bottomInsetPx = dockGeometry.heightPx + with(density) { (animatedBottomPadding + 8.dp).roundToPx() }
            val contentHeightPx = signal.viewportHeightPx - topInsetPx - bottomInsetPx
            if (contentHeightPx <= 0) return@collect

            if (signal.detached) {
                // 用户滚走后的暂时脱离：只维护 spacer 余量、不碰滚动位置；
                // 满屏也不交还 Following——交还即立刻滚到底，等于抢滚动。
                // 回到尾部恢复吸附后，走下面的正常稳态（重停靠或满屏交接）。
                if (signal.anchorTop == Int.MIN_VALUE) return@collect
                val turnHeight = if (signal.lastContentEnd > signal.anchorTop) {
                    signal.lastContentEnd - signal.anchorTop
                } else {
                    signal.anchorSize
                }
                if (turnHeight + topGapPx > contentHeightPx) {
                    if (turnDockSpacerPx != 0) turnDockSpacerPx = 0
                } else {
                    val candidate = (contentHeightPx - topGapPx - turnHeight - spacingPx).coerceAtLeast(0)
                    if (candidate != turnDockSpacerPx) turnDockSpacerPx = candidate
                }
                return@collect
            }

            if (signal.anchorTop == Int.MIN_VALUE) {
                // 锚点还没被组合（刚追加到视口外）：直接滚到位，顺带让它完成测量。
                programmaticDockScroll = true
                try {
                    listState.scrollToItem(signal.anchorIndex, -topGapPx)
                } finally {
                    programmaticDockScroll = false
                }
                return@collect
            }

            val turnHeight = if (signal.lastContentEnd > signal.anchorTop) {
                signal.lastContentEnd - signal.anchorTop
            } else {
                signal.anchorSize
            }
            // 满屏判定先行：交还 Following 后由它滚到底（filledScreen 出画是设计行为）。
            if (turnHeight + topGapPx > contentHeightPx) {
                turnDockSpacerPx = 0
                turnDock = null
                state.sessionId?.let { requestLatestViewport(it) }
                return@collect
            }

            val candidate = (contentHeightPx - topGapPx - turnHeight - spacingPx).coerceAtLeast(0)
            if (candidate != turnDockSpacerPx) turnDockSpacerPx = candidate

            // 锚点漂移才滚动：下方生长不移动锚点，与 web 的零重滚一致。
            val drift = signal.anchorTop - topGapPx
            if (drift > 0 && !signal.atAbsoluteTop) {
                programmaticDockScroll = true
                try {
                    listState.scrollToItem(signal.anchorIndex, -topGapPx)
                    // 钳住 = spacer 还差一点（padding 语义的公式误差）。滚完当场
                    // 量残差补进 spacer：下一帧锚点即归位，避免可见的「停靠半路」。
                    val settled = listState.layoutInfo.visibleItemsInfo
                        .firstOrNull { it.index == signal.anchorIndex }
                    val residual = (settled?.offset ?: topGapPx) - topGapPx
                    if (residual > 0) turnDockSpacerPx += residual
                } finally {
                    programmaticDockScroll = false
                }
            } else if (drift == 0) {
                dockedOnce = true
                // 已停靠且 spacer 归零后 spacer 仍不在视口内 = 停靠态下内容还在长，
                // 已到满屏边界，交还 Following（与满屏判定同一稳态）。
                if (dockedOnce && turnDockSpacerPx == 0 && !signal.atAbsoluteTop) {
                    val layout = listState.layoutInfo
                    val spacerInfo = layout.visibleItemsInfo.firstOrNull { it.key == TurnDockSpacerKey }
                    val spacerVisible = spacerInfo != null &&
                        spacerInfo.offset < layout.viewportEndOffset &&
                        spacerInfo.offset + spacerInfo.size > layout.viewportStartOffset
                    if (!spacerVisible) {
                        turnDock = null
                        state.sessionId?.let { requestLatestViewport(it) }
                    }
                }
            }
        }
    }

    // 换会话即作废飞顶状态：锚点、spacer、脱离标记、飞行进度全部回收。
    LaunchedEffect(state.sessionId) {
        turnDock = null
        turnDockSpacerPx = 0
        turnDockDetached = false
        armedSendComposerTopPx = null
        dockFlight.activeRequestId = null
    }

    // Anchor once per dock target change. Watching animatedBottomPadding made
    // this effect snap the list on every spring frame, which was visible as a
    // transcript jump while the composer or IME settled.
    LaunchedEffect(state.chatOpen, state.sessionId, state.historyLoading, sessionEntryBottomPinActive, targetBottomPadding, turnGroups.isNotEmpty(), turnDock) {
        if (
            state.chatOpen &&
            sessionEntryBottomPinActive &&
            !state.historyLoading &&
            timelineBelongsToCurrentSession &&
            initiallyPositionedSessionId == state.sessionId &&
            scrollMode == ChatScrollMode.Following &&
            turnGroups.isNotEmpty() &&
            turnDock == null
        ) {
            state.sessionId?.let { requestLatestViewport(it) }
        }
    }

    val turnRenderKeys = remember(turnGroups) { uniqueTurnRenderKeys(turnGroups) }

    // Keep the empty-state ideas physically close to the composer. When they
    // lived in the transcript as full-width rows, they read like a secondary
    // navigation menu and competed with the one thing an empty chat needs:
    // writing the first message.
    val showComposerSuggestions =
        turnGroups.isEmpty() &&
            !showActiveRunAction && state.stopRequest == StopRequestState.None &&
            !historyTransitioning &&
            state.error == null &&
            !state.voice.recording &&
            !state.voice.processing &&
            state.composerText.isBlank() &&
            attachments.isEmpty()

    val latestTurnUserMessageId = remember(turnGroups, state.runStatus) {
        if (state.runStatus == AgentRunStatus.Working) {
            null
        } else {
            turnGroups.mapNotNull { it.userPrompt }
                .filterNot { it.isPending }
                .lastOrNull()?.id
        }
    }

    val imeCanFollow = rememberUpdatedState(state.chatOpen && !state.historyLoading && timelineBelongsToCurrentSession &&
        turnGroups.isNotEmpty() && scrollMode == ChatScrollMode.Following && turnDock == null)
    LaunchedEffect(imeInsets, listState, density) {
        // Insets change every platform animation frame. Observe them here,
        // without making the entire chat a composition-time inset consumer.
        snapshotFlow { imeInsets.getBottom(density) }.collectLatest {
            imeSettling = true
            if (imeCanFollow.value) {
                // Dock/reading geometry already shares a layout transaction.
                // Only defer the optional follow-tail scroll until IME settles.
                delay(120)
                if (imeCanFollow.value) latestSessionId.value?.let { requestLatestViewport(it) }
            }
            delay(220)
            imeSettling = false
        }
    }

    val colors = LocalAgentocColors.current
    val historyLoadingLabel = stringResource(R.string.chat_history_loading)
    // This captures only the conversation canvas. Temporary controls sample
    // it locally, so their own surfaces defocus the transcript while the
    // activity behind them is merely dimmed by the modal scrim.
    val chatBackdrop = rememberGraphicsLayer()
    var chatBackdropOrigin by remember { mutableStateOf(IntOffset.Zero) }
    // A GraphicsLayer receives its first display list during draw, while the
    // header and composer are composed in that same frame. Do not hand an
    // unrecorded layer to a material surface: wait for two frames (record,
    // then recompose) so the initial resting UI has the same defocus as an
    // interacted-with one.
    var chatBackdropReady by remember(state.sessionId) { mutableStateOf(false) }
    LaunchedEffect(state.sessionId) {
        withFrameNanos { }
        withFrameNanos { }
        chatBackdropReady = true
    }
    val chatBackdropForControls = chatBackdrop.takeIf { chatBackdropReady }
    // Modal windows live outside this Compose host. Capture the complete
    // in-window chat frame as well, so a sheet can locally defocus the dock
    // and header rather than letting them show through its transparent host.
    val chatModalBackdrop = rememberGraphicsLayer()
    // Recording a GraphicsLayer refreshes its display list, but Android does
    // not always invalidate an already-composited sibling RenderNode that uses
    // it as a blur source. Advance a version after the history canvas has had
    // one frame to record; the sampling draw phase reads the version and
    // invalidates only that leaf, not the whole chat composition.
    val chatBackdropRevision = remember(state.sessionId) { mutableIntStateOf(0) }
    val backdropIsMoving = remember(listState) { { listState.isScrollInProgress } }
    val backdropMotionResponse = rememberAgentoBackdropMotionResponse(backdropIsMoving)
    val readingNavigationInsets = WindowInsets.navigationBars
    val readingSystemInsets = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars()
    LaunchedEffect(state.sessionId) {
        withFrameNanos { }
        withFrameNanos { }
        chatBackdropRevision.intValue += 1
    }
    LaunchedEffect(listState, state.sessionId) {
        snapshotFlow {
            listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset
        }.collect {
            withFrameNanos { }
            chatBackdropRevision.intValue += 1
        }
    }
    LaunchedEffect(turnRenderKeys, state.sessionId, entryPreparing) {
        withFrameNanos { }
        chatBackdropRevision.intValue += 1
    }

    val dockContent: @Composable androidx.compose.foundation.layout.BoxScope.(Modifier) -> Unit = { dockMeasurement ->
        // Bottom dock: composer, queued turns, attachments, and approvals.
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .then(dockMeasurement)
                // Paint the overlay before consuming system/IME insets so the
                // gesture area cannot reveal the transcript below fullscreen.
                .background(colors.canvas.copy(alpha = composerFullscreenProgress))
                // This dock is positioned in the edge-to-edge chat root, not
                // below an inset-consuming content container. Keep its top
                // clearance explicit, like the chat header's topControlsHeight.
                .padding(top = if (composerFullscreenActive) statusBarTop else 0.dp)
                // Expanding header children can temporarily be taller than
                // their animated parent. Never paint or hit-test that overflow
                // in the OS status area; keep the canvas outside this clip.
                .then(if (composerFullscreenActive) Modifier.clipToBounds() else Modifier)
                .navigationBarsPadding()
                .imePadding()
                .padding(
                    start = AgentoSpacing.ComposerMargin * (1f - composerFullscreenProgress),
                    end = AgentoSpacing.ComposerMargin * (1f - composerFullscreenProgress),
                    bottom = composerBottomSpacing,
                )
                .zIndex(2.5f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!composerFullscreenActive) {
            AnimatedVisibility(
                visible = showComposerSuggestions,
                enter = fadeIn(tween(motionPolicy().duration(160))) +
                    slideInVertically(
                        initialOffsetY = { it / 3 },
                        animationSpec = AgentoMotion.SpatialOffset,
                    ),
                exit = fadeOut(tween(motionPolicy().duration(120))) +
                    slideOutVertically(
                        targetOffsetY = { it / 4 },
                        animationSpec = AgentoMotion.SpatialOffset,
                    ),
            ) {
                EmptyConversationSuggestionRail(
                    onSuggestion = { suggestion ->
                        onEvent(WorkbenchEvent.ComposerChanged(suggestion))
                        composerExpanded = true
                    },
                    modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
                )
            }

            // Layer C: approval or the server-owned queued-message island.
            JourneyRunFeedback(state, onReconnect = { onEvent(WorkbenchEvent.Retry) },
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth))
            val isTransportFailure = state.error?.let(::isTransportConnectionFailure) == true
            val isOffline = state.connection == AgentConnectionStatus.Disconnected || isTransportFailure
            val activeSummary = when {
                state.pendingTurn?.state == PendingTurnState.Sending -> stringResource(R.string.workbench_status_sending)
                state.currentAction != null -> state.currentAction?.let { presentRunAction(it) }
                state.runStatus == AgentRunStatus.Working -> stringResource(R.string.workbench_status_processing)
                else -> null
            }

            activeDecision?.takeUnless { it.isSubmitted }?.let { decision ->
                AgentoButton(
                    text = stringResource(R.string.approval_answer_question),
                    onClick = { scope.launch { listState.scrollToItem(turnGroups.size) } },
                    enabled = !decision.isSubmitting,
                    secondary = true,
                    modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth).fillMaxWidth().testTag("decision-bottom-entry"),
                )
            }

            RunDock(
                runStatus = state.runStatus,
                approval = state.approval?.copy(
                    resolving = state.approvalResolving,
                    targetHost = hostName,
                ),
                queuedMessages = queuedMessages.filterNot { it.id == editingQueuedMessageId },
                queueExpanded = queueDockExpanded,
                onExpandQueue = {
                    queueAutoCollapseGeneration = 0
                    queueDockExpanded = true
                },
                onCollapseQueue = {
                    queueAutoCollapseGeneration = 0
                    queueDockExpanded = false
                },
                onEditQueuedMessage = { qm ->
                    editingQueuedMessageId = qm.id
                    editingQueuedOriginalText = qm.text
                    editingQueuedAttachmentCount = qm.attachments.size
                    queueAutoCollapseGeneration = 0
                    queueDockExpanded = false
                    onSetEditingTurn(null, null)
                    onSetAttachments(qm.attachments)
                    onEvent(WorkbenchEvent.ComposerChanged(qm.text))
                    composerExpanded = true
                },
                onSteerQueue = { qm -> onEvent(WorkbenchEvent.SteerMessage(qm.id)) },
                onRemoveQueuedMessage = { qm -> onEvent(WorkbenchEvent.RemoveQueuedMessage(qm.id)) },
                isOfflineOrTransportError = isOffline,
                onStop = { onEvent(WorkbenchEvent.CancelRun) },
                onOpenRunDetails = ::openRunIsland,
                onApprove = { reqId -> onEvent(WorkbenchEvent.Approve(reqId)) },
                onDeny = { reqId -> onEvent(WorkbenchEvent.Deny(reqId)) },
                onReviewChanges = {
                    val firstChanged = changedFiles.firstOrNull()
                    if (firstChanged != null) onSetSelectedDiffFile(firstChanged) else openRunIsland()
                },
                onRetryConnection = { onEvent(WorkbenchEvent.Retry) },
                activeActivityText = activeSummary,
                filesChangedCount = changedFiles.size,
                backdropLayer = chatBackdropForControls,
                backdropOrigin = chatBackdropOrigin,
                approvalResolving = state.approvalResolving,
                approvalExpanded = approvalDockExpanded,
                onExpandApproval = { approvalDockExpanded = true },
                onCollapseApproval = { approvalDockExpanded = false },
                goalMode = state.goalMode,
                goalText = state.goalText,
                autoContinue = state.autoContinue,
                goalExpanded = state.goalDialogOpen,
                onExpandGoal = { onEvent(WorkbenchEvent.OpenGoalDialog) },
                onCollapseGoal = { onEvent(WorkbenchEvent.CloseGoalDialog) },
                onSaveGoal = { onEvent(WorkbenchEvent.SaveGoal(it)) },
                onClearGoal = { onEvent(WorkbenchEvent.ClearGoal) },
                onToggleAutoContinue = {
                    if (state.autoContinue) {
                        onEvent(WorkbenchEvent.PauseAutoContinue)
                    } else {
                        onEvent(WorkbenchEvent.StartAutoContinue(state.goalText))
                    }
                },
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
            )

            // Adaptive Attachment Tray & Edit Cancel Pill:
            // When space allows, the cancel button sits beside attachments with flush bottom edges.
            val isEditingTurn = editingTurnId != null || editingQueuedMessageId != null
            AttachmentTray(
                attachments = attachments,
                onRemove = { att -> onSetAttachments(attachments.filterNot { it.id == att.id }) },
                isEditing = isEditingTurn,
                onCancelEdit = {
                    editingQueuedMessageId = null
                    editingQueuedOriginalText = null
                    editingQueuedAttachmentCount = 0
                    onSetEditingTurn(null, null)
                    onSetAttachments(emptyList())
                    onEvent(WorkbenchEvent.ComposerChanged(""))
                },
                backdropLayer = chatBackdropForControls,
                backdropOrigin = chatBackdropOrigin,
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
            )
            }

            // Insets are applied during layout. Derive the editor target from
            // those same constraints, not a composition-time IME snapshot
            // that can lag a frame and place the header in the status bar.
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .then(
                        if (state.goalDialogOpen) {
                            Modifier.clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = { onEvent(WorkbenchEvent.CloseGoalDialog) },
                            )
                        } else Modifier
                    ),
                contentAlignment = Alignment.BottomCenter,
            ) {
            AgentComposer(
                value = state.composerText,
                onValueChange = { onEvent(WorkbenchEvent.ComposerChanged(it)) },
                onSend = {
                    val rawText = state.composerText.trim()
                    val queuedMessageId = editingQueuedMessageId
                    if (queuedMessageId != null) {
                        if (rawText.isBlank() && attachments.isEmpty()) {
                            composerExpanded = true
                            return@AgentComposer
                        }
                        composerExpanded = false
                        onEvent(WorkbenchEvent.ResendQueuedMessage(queuedMessageId, rawText, attachments))
                        editingQueuedMessageId = null
                        editingQueuedOriginalText = null
                        editingQueuedAttachmentCount = 0
                        onSetAttachments(emptyList())
                        onSetEditingTurn(null, null)
                    } else if (state.runStatus == AgentRunStatus.Working) {
                        composerExpanded = false
                        attachments.forEach { onEvent(WorkbenchEvent.AddAttachment(it)) }
                        onEvent(WorkbenchEvent.SendMessage)
                        onSetAttachments(emptyList())
                        onSetEditingTurn(null, null)
                    } else if (editingTurnId != null) {
                        composerExpanded = false
                        onEvent(WorkbenchEvent.SubmitEditTurn(editingTurnId, rawText, attachments))
                        onSetAttachments(emptyList())
                        onSetEditingTurn(null, null)
                    } else {
                        composerExpanded = false
                        armedSendComposerTopPx = composerBounds.top.roundToInt()
                        attachments.forEach { onEvent(WorkbenchEvent.AddAttachment(it)) }
                        onEvent(WorkbenchEvent.SendMessage)
                        onSetAttachments(emptyList())
                        onSetEditingTurn(null, null)
                    }
                },
                onStop = { onEvent(WorkbenchEvent.CancelRun) },
                working = state.runStatus == AgentRunStatus.Working,
                onAddAttachment = { onSetComposerActionSheetOpen(true) },
                enabled = (!state.isLoading || state.runStatus == AgentRunStatus.Working) &&
                    !state.historyLoading && state.approval == null && !state.approvalResolving,
                disabledPlaceholder = stringResource(
                    if (state.approval != null || state.approvalResolving) AgentUiR.string.agentui_resolve_approval
                    else AgentUiR.string.agentui_loading_conversation,
                ),
                actionEnabled = state.connection == AgentConnectionStatus.Connected && state.stopRequest == StopRequestState.None &&
                    !state.runtimeResolving && state.runtimeModel != null && state.runtimeModelsError == null,
                attachmentsEnabled = true,
                runtimeTool = state.runtimeTool,
                slashSuggestions = state.harnessCapabilities.map { item ->
                    ComposerSlashSuggestion(
                        id = item.id,
                        kind = item.kind,
                        source = item.source,
                        title = item.title,
                        description = item.description,
                        invocationText = item.invocationText,
                        enabled = item.enabled,
                        disabledReason = item.disabledReason,
                        selectionMode = if (item.kind == "mcp" || item.kind == "plugin" || item.source == "agentoc") "attach" else "insert",
                    )
                },
                slashSuggestionsLoading = state.harnessCapabilitiesLoading,
                slashSuggestionsError = state.harnessCapabilitiesError,
                onSelectSlashSuggestion = { suggestion ->
                    if (suggestion.selectionMode == "attach") {
                        state.harnessCapabilities.firstOrNull { it.id == suggestion.id && it.enabled }?.let { capability ->
                            onEvent(WorkbenchEvent.AddHarnessCapability(capability))
                            clearComposerSlashToken(state.composerText)?.let { selectedText ->
                                onEvent(WorkbenchEvent.ComposerChanged(selectedText))
                            }
                        }
                    } else {
                        replaceComposerSlashToken(state.composerText, suggestion.invocationText)?.let { selectedText ->
                            onEvent(WorkbenchEvent.ComposerChanged(selectedText))
                        }
                    }
                },
                selectedCapabilities = state.selectedHarnessCapabilities.map { capability ->
                    ComposerSelectedCapability(
                        id = capability.id,
                        kind = capability.kind,
                        source = capability.source,
                        title = capability.title,
                    )
                },
                onRemoveSelectedCapability = { capabilityId ->
                    onEvent(WorkbenchEvent.RemoveHarnessCapability(capabilityId))
                },
                runtimeProvider = state.runtimeProvider,
                runtimeModel = state.runtimeModel,
                runtimeCatalog = state.runtimeCatalog,
                runtimeSelectionDisplay = state.runtimeSelectionDisplay,
                runtimeModelsLoading = state.runtimeModelsLoading,
                runtimeModelsError = state.runtimeModelsError,
                serviceTier = state.serviceTier,
                runtimePickerOpen = state.runtimePickerOpen,
                onOpenRuntimePicker = { onEvent(WorkbenchEvent.OpenRuntimePicker) },
                onCloseRuntimePicker = { onEvent(WorkbenchEvent.CloseRuntimePicker) },
                onSelectRuntime = { onEvent(WorkbenchEvent.SelectRuntime(it)) },
                onSelectProvider = { onEvent(WorkbenchEvent.SelectProvider(it)) },
                onSelectModel = { onEvent(WorkbenchEvent.SelectModel(it)) },
                onSelectServiceTier = { onEvent(WorkbenchEvent.SelectServiceTier(it)) },
                effort = state.thinkingEffort,
                effortPickerOpen = state.effortPickerOpen,
                onOpenEffortPicker = { onEvent(WorkbenchEvent.OpenEffortPicker) },
                onCloseEffortPicker = { onEvent(WorkbenchEvent.CloseEffortPicker) },
                onEffortChange = { onEvent(WorkbenchEvent.EffortChanged(it)) },
                goalMode = state.goalMode,
                goalText = state.goalText,
                onGoalClick = { onEvent(WorkbenchEvent.OpenGoalDialog) },
                onCloseGoalMode = {
                    onEvent(WorkbenchEvent.ClearGoal)
                },
                onSetGoal = { targetText ->
                    onEvent(WorkbenchEvent.SaveGoal(targetText))
                    onEvent(WorkbenchEvent.StartAutoContinue(targetText))
                    onEvent(WorkbenchEvent.ComposerChanged(""))
                },
                planMode = planMode || state.planMode,
                onClosePlanMode = {
                    onSetPlanMode(false)
                    onEvent(WorkbenchEvent.TogglePlanMode(false))
                },
                expanded = composerExpanded,
                onExpandedChange = { composerExpanded = it },
                fullscreen = composerFullscreen,
                fullscreenProgress = composerFullscreenProgress,
                fullscreenHeight = maxHeight,
                onFullscreenChange = { composerFullscreen = it },
                hasAttachments = attachments.isNotEmpty(),
                pendingSend = state.pendingTurn?.state == PendingTurnState.Sending,
                onPasteImage = ::appendClipboardImages,
                backdropLayer = chatBackdropForControls,
                backdropOrigin = chatBackdropOrigin,
                onVoiceClick = { onEvent(WorkbenchEvent.ToggleVoiceInput) },
                voiceActive = state.voice.recording || state.voice.processing,
                voiceRecording = state.voice.recording,
                voiceProcessing = state.voice.processing,
                voiceLevel = state.voice.waveformLevel,
                onVoiceCancelClick = { onEvent(WorkbenchEvent.CancelVoiceInput) },
                modifier = Modifier
                    .then(if (composerFullscreenActive) Modifier else Modifier.widthIn(max = AgentocSizes.ContentMaxWidth))
                    .onGloballyPositioned { composerBounds = it.boundsInRoot() },
            )
            }
        }

    }

    CompositionLocalProvider(
        LocalAgentoBackdropRevision provides chatBackdropRevision,
        LocalAgentoBackdropMotionResponse provides backdropMotionResponse,
        LocalPreparedMarkdownDocuments provides entryDocuments,
    ) {
        SideEffect { appliedEntryDocuments = entryDocuments }
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(
                    brush = if (colors.canvas.red < 0.5f) {
                        com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasDark
                    } else {
                        com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasLight
                    },
                )
                .onGloballyPositioned { chatCoordinates = it }
                .pointerInput(
                    composerExpanded,
                    composerFullscreenActive,
                    composerActionSheetOpen,
                    state.goalDialogOpen,
                    state.runtimePickerOpen,
                    state.effortPickerOpen,
                    state.sessionMenuOpen,
                    runIslandExpanded,
                    approvalDockExpanded,
                ) {
                    if (!composerExpanded || composerFullscreenActive ||
                        composerActionSheetOpen || state.goalDialogOpen ||
                        state.runtimePickerOpen || state.effortPickerOpen ||
                        state.sessionMenuOpen || runIslandExpanded ||
                        (state.approval != null && approvalDockExpanded)
                    ) return@pointerInput

                    awaitEachGesture {
                        val down = awaitFirstDown(
                            requireUnconsumed = false,
                            pass = PointerEventPass.Initial,
                        )
                        var moved = false
                        var upPosition: Offset? = null
                        while (upPosition == null) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            val change = event.changes.firstOrNull() ?: continue
                            if ((change.position - down.position).getDistance() > viewConfiguration.touchSlop) {
                                moved = true
                            }
                            if (!change.pressed && change.previousPressed) {
                                upPosition = change.position
                            }
                        }
                        val downInRoot = chatCoordinates?.localToRoot(down.position)
                        val positionInRoot = chatCoordinates?.localToRoot(upPosition)
                        val downInsideComposer = downInRoot?.let(composerBounds::contains) == true
                        val upInsideComposer = positionInRoot?.let(composerBounds::contains) == true
                        val tappedInsideComposer = downInsideComposer || upInsideComposer
                        if (!moved && !tappedInsideComposer) {
                            composerExpanded = false
                            onEvent(WorkbenchEvent.CloseRuntimePicker)
                            onEvent(WorkbenchEvent.CloseEffortPicker)
                        }
                    }
                },
    ) {
        // Record the complete live chat frame before temporary controls are
        // composed. Sheets remain siblings of this box, which prevents their
        // own pixels or dim scrim from feeding back into the sampled layer.
        ChatReadingDockLayout(
            geometry = dockGeometry,
            retainReadingGeometry = composerFullscreenActive,
            dock = dockContent,
            modifier = Modifier
                .fillMaxSize()
                .drawWithContent {
                    recordToLayer(chatModalBackdrop)
                }
                .background(
                    brush = if (colors.canvas.red < 0.5f) {
                        com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasDark
                    } else {
                        com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasLight
                    },
                ),
        ) {
        // Layer 1: Conversation Canvas with Edge-to-Edge Frosted Backdrop
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .then(if (composerFullscreenActive || entryPreparing) Modifier.clearAndSetSemantics { } else Modifier)
                    .testTag("chat-reading-plane")
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        chatBackdropOrigin = IntOffset(
                            x = position.x.roundToInt(),
                            y = position.y.roundToInt(),
                        )
                    }
                    .agentoReadingEdges(
                        backdrop = chatBackdrop,
                        topInsetPx = { readingSystemInsets.getTop(density).toFloat() },
                        bottomInsetPx = {
                            // The app safe viewport may have consumed navigation
                            // insets already. Do not reserve that strip twice.
                            val remaining = readingSystemInsets.getBottom(density)
                            val consumed = (readingNavigationInsets.getBottom(density) - remaining).coerceAtLeast(0)
                            maxOf(remaining, imeInsets.getBottom(density) - consumed).toFloat() +
                                with(density) { composerBottomSpacing.toPx() }
                        },
                        presentationAlpha = if (readingPreparing) 0f else
                            chatReadingAlpha(readingReveal) * chatWritingContextAlpha(composerFullscreenProgress),
                    )
                    .background(
                        brush = if (colors.canvas.red < 0.5f) {
                            com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasDark
                        } else {
                            com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens.AtmosphericCanvasLight
                        },
                    ),
            ) {
                Column(Modifier.fillMaxSize()) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .testTag("chat-timeline")
                            .nestedScroll(jumpGestureConnection)
                            .weight(1f)
                            .widthIn(max = AgentocSizes.ContentMaxWidth)
                            .align(Alignment.CenterHorizontally)
                            .padding(horizontal = AgentoSpacing.ConversationGutter),
                        verticalArrangement = Arrangement.spacedBy(AgentoSpacing.Block),
                        contentPadding = conversationPadding,
                    ) {
                itemsIndexed(
                    items = turnGroups,
                    key = { index, _ -> turnRenderKeys[index] },
                    contentType = { _, turn -> if (turn.userPrompt?.isPending == true) "PendingTurn" else "TurnGroup" },
                ) { index, turn ->
                    val isLastTurn = index == turnGroups.lastIndex
                    val isRunTurn = index == activeTurnIndex
                    val canMessageAction = canShowMessageActions(state.runStatus, historyTransitioning, state.pendingTurn, state.acceptedTurns.isNotEmpty())
                    val rowMotion = motionPolicy()

                    val isPendingRow = turn.id.startsWith("pending-")
                    val flightRowRequestId = when {
                        isPendingRow -> turn.id.removePrefix("pending-")
                        turn.userPrompt != null && turn.userPrompt.requestId != null -> turn.userPrompt.requestId
                        else -> null
                    }?.takeIf { it == dockFlight.activeRequestId }

                    val rowContent: @Composable () -> Unit = {
                        TurnTimelineView(
                            turn = turn,
                            isLastTurn = isLastTurn,
                            onBranch = if (canMessageAction) {
                                { anchorSeq, mode ->
                                    onEvent(
                                        WorkbenchEvent.ForkFromMessage(
                                            anchorSeq = anchorSeq,
                                            mode = mode,
                                        ),
                                    )
                                }
                            } else null,
                            onRestart = if (!historyTransitioning && turn.requestId != null) {
                                { reqId -> onEvent(WorkbenchEvent.RegenerateMessage(reqId)) }
                            } else null,
                            onEditResend = { text ->
                                val msgId = turn.requestId ?: "turn-edit"
                                onSetEditingTurn(msgId, text)
                                onEvent(WorkbenchEvent.ComposerChanged(text))
                            },
                            onPlanAction = { planId, action -> onEvent(WorkbenchEvent.PlanAction(planId, action)) },
                            onRetryPendingTurn = { onEvent(WorkbenchEvent.RetryPendingTurn) },
                            onOpenFileDiff = { diff -> onSetSelectedDiffFile(diff) },
                            onReport = { text -> onEvent(WorkbenchEvent.ReportAgentContent(text)) },
                            showMessageActions = canMessageAction,
                            runDuration = if (turn.runId?.let(state.runDurations::containsKey) == true || (isRunTurn && (showActiveRunAction || runElapsedSeconds >= 0L ||
                                (currentRunId != null && currentRunId == state.runMetrics.runId && state.runMetrics.durationFormatted != "N/A")))) {{
                                val seconds = if (isRunTurn && showActiveRunAction) runElapsedSeconds else
                                    turn.runId?.let(state.runDurations::get)?.div(1_000) ?: if (isRunTurn) runElapsedSeconds else -1L
                                val duration = if (seconds >= 0) {
                                    if (seconds < 60) stringResource(R.string.workbench_duration_seconds, seconds)
                                    else stringResource(R.string.workbench_duration_minutes_seconds, seconds / 60, seconds % 60)
                                } else if (isRunTurn && currentRunId == state.runMetrics.runId && state.runMetrics.durationFormatted != "N/A") state.runMetrics.durationFormatted else ""
                                val label = if (duration.isEmpty()) stringResource(R.string.workbench_status_processing) else
                                    stringResource(if (isRunTurn && showActiveRunAction) R.string.workbench_run_elapsed else R.string.workbench_run_finished, duration)
                                Text(label,
                                    style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent,
                                    modifier = Modifier.testTag("run-elapsed"))
                            }} else null,
                            runActive = isRunTurn && showActiveRunAction,
                            runWaitingApproval = isRunTurn && state.runStatus == AgentRunStatus.WaitingApproval,
                            activeAction = if (isRunTurn && showActiveRunAction) {{
                                ActiveRunActionBar(status = state.runStatus,
                                    actionSummary = state.currentAction?.sentence,
                                    sending = state.pendingTurn?.state == PendingTurnState.Sending,
                                    actionState = state.currentAction)
                            }} else null,
                        )
                    }

                    Box(
                        modifier = Modifier.animateItem(
                            // Existing transcript rows must stay painted when
                            // a programmatic scroll remeasures/reuses them.
                            // Entry has its own history transition and newly
                            // submitted turns use TurnDockFlightShell below.
                            fadeInSpec = null,
                            // IME/dock insets already animate the reading viewport.
                            // Animating each row's resulting placement again makes
                            // the transcript lag, then drift after the IME settles.
                            // Keep document geometry synchronous with measurement;
                            // intentional send motion remains in TurnDockFlightShell.
                            placementSpec = null,
                            fadeOutSpec = if (rowMotion.preference == MotionPreference.None || flightRowRequestId != null) {
                                null
                            } else {
                                tween(rowMotion.duration(120))
                            },
                        ),
                    ) {
                        if (flightRowRequestId != null) {
                            TurnDockFlightShell(
                                flight = dockFlight,
                                rowRequestId = flightRowRequestId,
                                content = rowContent,
                            )
                        } else {
                            rowContent()
                        }
                    }
                }

                // Interactive Decision Question Card (Spec-03)
                activeDecision?.let { decision ->
                    item(key = "active_decision_${decision.id}") {
                        DecisionQuestionCard(
                            state = decision,
                            onOptionSelected = { optIdx ->
                                onEvent(WorkbenchEvent.SelectDecisionOption(decision.id, optIdx))
                            },
                            onWriteInChanged = { onEvent(WorkbenchEvent.DecisionWriteInChanged(decision.id, it)) },
                            onSubmit = { onEvent(WorkbenchEvent.SubmitDecision(decision.id)) },
                            modifier = Modifier.padding(vertical = 4.dp).testTag("active-decision-card"),
                            onMultiOptionSelected = { questionIndex, optionIndex ->
                                onEvent(WorkbenchEvent.SelectDecisionOption(decision.id, optionIndex, questionIndex))
                            },
                            onMultiWriteInChanged = { questionIndex, text ->
                                onEvent(WorkbenchEvent.DecisionWriteInChanged(decision.id, text, questionIndex))
                            },
                            onDeny = { onEvent(WorkbenchEvent.Deny(decision.id)) },
                        )
                    }
                }

                if (turnGroups.isEmpty() && state.timelineItems.isEmpty() && state.error == null) {
                    item(key = "empty") {
                        if (showActiveRunAction) {
                            ActiveRunActionBar(status = state.runStatus, actionState = state.currentAction,
                                sending = state.pendingTurn?.state == PendingTurnState.Sending)
                        }
                        // A selected computer remains paired while its carrier
                        // reconnects; do not ask the user to set it up again.
                        if (state.connection != AgentConnectionStatus.Connected && state.activeRemoteTargetId == null) {
                            DeviceConnectionPrompt(
                                onConnectDevice = {
                                    onEvent(WorkbenchEvent.OpenPairing)
                                },
                            )
                        }
                    }
                }

                // 发送飞顶的尾随滚动余量（web turnViewportSpacer 对应物）：把短
                // turn 顶到视口顶所需的精确滚动范围。只在停靠态挂载——零高 item
                // 也会因 spacedBy 改变内容尾距，不能留在非停靠路径上。高度与滚动
                // 由停靠执行器同帧配对，不做动画（web 移除 height transition 的
                // 同一结论）。
                if (turnDock != null) {
                    item(key = TurnDockSpacerKey) {
                        Spacer(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(turnDockSpacerDp),
                        )
                    }
                }
                }
            }
                if (state.loadingOlder) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = topControlsHeight)
                            .align(Alignment.TopCenter)
                            .zIndex(1f)
                            .background(colors.canvas.copy(alpha = 0.90f))
                            .padding(vertical = 8.dp)
                            .semantics { contentDescription = "Loading earlier messages" },
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 1.5.dp,
                            color = colors.secondaryContent,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "Loading earlier messages…",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.secondaryContent,
                        )
                    }
                }
            }
        }

        // Layer 1.5: Pure Gradient Blur Masks (ChatGPT app style)
        val measuredDockHeight = with(density) { dockGeometry.visualHeightPx.toDp() }
        val fallbackDockHeight = with(density) { readingNavigationInsets.getBottom(density).toDp() } +
            composerBottomSpacing + 68.dp
        val activeDockHeight = if (measuredDockHeight > 0.dp) measuredDockHeight else fallbackDockHeight
        val maskPresentationAlpha = if (readingPreparing) 0f else
            chatReadingAlpha(readingReveal) * chatWritingContextAlpha(composerFullscreenProgress)

        ChatTopGradientMask(
            topControlsHeight = topControlsHeight,
            canvasColor = colors.canvas,
            backdropLayer = chatBackdropForControls,
            backdropOrigin = chatBackdropOrigin,
            presentationAlpha = maskPresentationAlpha,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .zIndex(1.5f),
        )

        ChatBottomGradientMask(
            dockHeight = activeDockHeight,
            canvasColor = colors.canvas,
            backdropLayer = chatBackdropForControls,
            backdropOrigin = chatBackdropOrigin,
            presentationAlpha = maskPresentationAlpha,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .zIndex(1.8f),
        )

        if (readingPreparing || chatPreparingAlpha(readingReveal) > 0f) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(1f)
                    .graphicsLayer(alpha = chatPreparingAlpha(readingReveal))
                    .semantics { contentDescription = historyLoadingLabel },
                contentAlignment = Alignment.TopCenter,
            ) {
                Surface(
                    modifier = Modifier.padding(top = topControlsHeight + 10.dp),
                    shape = CircleShape,
                    color = colors.surfaceHigh,
                    shadowElevation = 0.dp,
                    tonalElevation = 0.dp,
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 1.5.dp,
                            color = colors.secondaryContent,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = historyLoadingLabel,
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.secondaryContent,
                        )
                    }
                }
            }
        }

        // Only the OS status-bar inset needs an opaque reading background.
        // The floating header below it still samples the scrolling transcript;
        // do not turn the entire navigation region into an opaque app bar.
        // System bands are protected by the shared, clipped app viewport.

        // Layer A: Context Layer (ChatContextBar)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.TopCenter)
                .zIndex(2f)
                .graphicsLayer { alpha = chatWritingContextAlpha(composerFullscreenProgress) }
                .then(if (composerFullscreenActive) Modifier.clearAndSetSemantics { } else Modifier),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding(),
            ) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    FloatingTopChrome(
                        sessionTitle = state.sessionTitle,
                        projectTitle = currentProjectName,
                        hostTitle = currentDeviceName,
                        status = state.runStatus,
                        hasAttentionOrError = state.error != null,
                        onBack = { onEvent(WorkbenchEvent.CloseChat) },
                        onMenu = { onEvent(WorkbenchEvent.OpenSessionMenu) },
                        menuEnabled = state.sessionId != null && !state.sessionActionInProgress,
                        backdropLayer = chatBackdropForControls,
                        backdropOrigin = chatBackdropOrigin,
                        onTitleClick = ::openRunIsland,
                        showTitle = false,
                        sideControlsSpace = topControlGeometry::sideControlsSpace,
                        sideControlsEnabled = !runIslandExpanded,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        // Top run-details Dynamic Island: grows out of the header title
        // capsule in place of the old bottom sheet.
        val pendingIslandRequest = state.approval?.let {
            RunIslandRequest(RunIslandRequestKind.Approval, it.title, state.approvalResolving || it.resolving)
        } ?: activeDecision?.takeUnless { it.isSubmitted }?.let {
            RunIslandRequest(RunIslandRequestKind.Question, it.question, it.isSubmitting)
        }
        key(state.sessionId) {
        RunDetailsIsland(
            onSideControlsSpaceMeasured = topControlGeometry::measureSideControls,
            modifier = Modifier.graphicsLayer { alpha = chatWritingContextAlpha(composerFullscreenProgress) }
                .then(if (composerFullscreenActive) Modifier.clearAndSetSemantics { } else Modifier),
            expanded = runIslandExpanded,
            activitySummary = state.currentAction?.let { presentRunAction(it) },
            pendingRequest = pendingIslandRequest,
            onOpenRequest = {
                // Navigate to the existing request; never approve or answer
                // from the summary. Resolution remains owned by the ViewModel.
                dismissRunIsland()
                when (pendingIslandRequest?.kind) {
                    RunIslandRequestKind.Approval -> approvalDockExpanded = true
                    RunIslandRequestKind.Question -> scope.launch {
                        // The question follows the turn groups in the same
                        // LazyColumn. Its content padding clears the header.
                        listState.scrollToItem(turnGroups.size)
                    }
                    null -> Unit
                }
            },
            onDismiss = ::dismissRunIsland,
            runMetrics = state.runMetrics,
            changedFiles = changedFiles,
            stepTraces = state.stepTraces,
            onOpenFileDiff = { onSetSelectedDiffFile(it) },
            backdropLayer = chatBackdropForControls,
            backdropOrigin = chatBackdropOrigin,
            onExpand = ::openRunIsland,
            collapsedContent = { showStatusIndicator ->
                com.andysagent.agentoc.core.agentui.ConversationCapsuleLabel(
                    state.sessionTitle, currentProjectName, currentDeviceName, state.runStatus,
                    hasAttentionOrError = state.error != null,
                    showStatusIndicator = showStatusIndicator,
                )
            },
        )
        }

        // Approval Dynamic Island dismissal barrier: sits above the
        // transcript and header but below the dock itself, so taps on the
        // card reach it while any other tap collapses the card back to
        // the pill.
        if (state.approval != null && approvalDockExpanded) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(2.3f)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = { approvalDockExpanded = false },
                    ),
            )
        }

        // Goal Dynamic Island dismissal barrier: sits above the
        // transcript and header but below the dock itself, so taps on the
        // card reach it while any other tap collapses the card back to
        // the pill.
        if (state.goalDialogOpen) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .zIndex(2.3f)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = { onEvent(WorkbenchEvent.CloseGoalDialog) },
                    ),
            )
        }


        // This transient control deliberately sits outside the measured dock:
        // it may float while reading, but never changes the transcript's safe
        // viewport or competes with the composer for vertical space.
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(horizontal = AgentoSpacing.ComposerMargin)
                .padding(jumpPadding)
                .widthIn(max = AgentocSizes.ContentMaxWidth)
                .zIndex(2.4f),
            contentAlignment = Alignment.Center,
        ) {
            com.andysagent.agentoc.core.agentui.ScrollToBottomFab(
                visible = jumpHint.visible,
                fastExit = jumpHint.fastExit,
                onClick = {
                    jumpHint.startReturn()
                    returnToBottomJob?.cancel()
                    returnToBottomJob = scope.launch {
                        scrollMode = ChatScrollMode.Returning
                        try {
                            // Re-read the tail after animation: streaming may append another item.
                            repeat(3) {
                                val target = latestContentItemCount.value - 1
                                listState.scrollToTimelineTail(target, animate = true)
                                if (target == latestContentItemCount.value - 1 && isAtBottom) {
                                    turnDockDetached = false
                                    scrollMode = ChatScrollMode.Following
                                    return@launch
                                }
                            }
                        } finally {
                            jumpHint.endReturn()
                            // User cancellation must never re-enable automatic tail following.
                            if (scrollMode == ChatScrollMode.Returning) scrollMode = ChatScrollMode.Detached
                        }
                    }
                },
                unseenCount = state.unseenCount,
            )
        }

        // In-tree Frosted Glass Menu Popover (True hardware defocus blur)
        val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
        AgentoFrostedMenu(
            expanded = state.sessionMenuOpen,
            onDismissRequest = { onEvent(WorkbenchEvent.CloseSessionMenu) },
            backdropLayer = chatBackdropForControls,
            backdropOrigin = chatBackdropOrigin,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(top = 56.dp, end = AgentoSpacing.ComposerMargin)
                .zIndex(10f),
        ) {
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_run_details),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    openRunIsland()
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Info, contentDescription = null) },
            )
            AgentoDropdownMenuItem(
                text = stringResource(
                    R.string.voice_menu_device,
                    state.voice.choiceLabel(
                        state.chatTargetId,
                        phoneLabel = stringResource(R.string.voice_route_phone),
                        cloudLabel = stringResource(R.string.voice_route_cloud),
                        computerFallbackLabel = stringResource(R.string.voice_computers_section),
                    ),
                ),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    onEvent(WorkbenchEvent.RefreshVoiceDevices)
                    voiceDevicePickerOpen = true
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Microphone, contentDescription = null) },
            )
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_rename),
                onClick = {
                    renameText = state.sessionTitle
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    renameDialogOpen = true
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Edit, contentDescription = null) },
            )
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_copy_id),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    state.sessionId?.let { clipboard.setText(androidx.compose.ui.text.AnnotatedString(it)) }
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Copy, contentDescription = null) },
            )
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_compact),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    onEvent(WorkbenchEvent.CompactSession)
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Refresh, contentDescription = null) },
            )
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_clear_tool_results),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    onEvent(WorkbenchEvent.DropTools)
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Terminal, contentDescription = null) },
            )
            HorizontalDivider(
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                color = colors.subtleOutline.copy(alpha = 0.5f),
            )
            AgentoDropdownMenuItem(
                text = stringResource(R.string.workbench_session_delete),
                onClick = {
                    onEvent(WorkbenchEvent.CloseSessionMenu)
                    deleteDialogOpen = true
                },
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Close, contentDescription = null, tint = colors.error) },
                textColor = colors.error,
            )
        }

        }
    }

    if (voiceDevicePickerOpen) {
        AgentoDialog(
            title = stringResource(R.string.voice_picker_title),
            confirmLabel = stringResource(R.string.voice_picker_done),
            onConfirm = { voiceDevicePickerOpen = false },
            onDismiss = { voiceDevicePickerOpen = false },
            backdropLayer = chatModalBackdrop,
            content = {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    SettingsChoiceRow(
                        title = stringResource(R.string.voice_route_automatic),
                        subtitle = stringResource(R.string.voice_route_automatic_hint),
                        selected = state.voice.choice == "auto",
                        onClick = { onEvent(WorkbenchEvent.SelectVoiceChoice("auto")) },
                        modifier = Modifier.testTag("voice-route-auto"),
                    )
                    SettingsChoiceRow(
                        title = stringResource(R.string.voice_route_phone),
                        subtitle = stringResource(
                            if (!state.voice.phoneSupported) R.string.voice_phone_unsupported
                            else if (state.voice.phoneNativeLanguageSupported == false) R.string.voice_phone_native_language_unsupported
                            else if (state.voice.phoneAvailable) R.string.voice_phone_ready
                            else R.string.voice_phone_unsupported,
                        ),
                        selected = state.voice.choice == "phone",
                        onClick = { onEvent(WorkbenchEvent.SelectVoiceChoice("phone")) },
                        modifier = Modifier.testTag("voice-route-phone"),
                    )
                    val cloudRemainingMinutes = ((state.voice.cloudRemainingMs + 59_999L) / 60_000L)
                        .coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
                    val cloudSubtitle = when {
                        state.voice.cloudLimitMs > 0 && state.voice.cloudRemainingMs <= 0 ->
                            stringResource(R.string.voice_cloud_quota_exceeded)
                        state.voice.cloudAvailable -> stringResource(R.string.voice_cloud_ready, cloudRemainingMinutes)
                        else -> stringResource(R.string.voice_cloud_unavailable)
                    }
                    SettingsChoiceRow(
                        title = stringResource(R.string.voice_route_cloud),
                        subtitle = cloudSubtitle,
                        selected = state.voice.choice == "cloud",
                        enabled = (state.voice.cloudAvailable && state.voice.cloudRemainingMs > 0)
                            || state.voice.choice == "cloud",
                        onClick = { onEvent(WorkbenchEvent.SelectVoiceChoice("cloud")) },
                        modifier = Modifier.testTag("voice-route-cloud"),
                    )
                    if (state.voice.cloudConsentGranted) {
                        androidx.compose.material3.TextButton(
                            onClick = { onEvent(WorkbenchEvent.RevokeCloudVoiceConsent) },
                            enabled = state.voice.cloudConsentGranted && !state.voice.cloudConsentBusy,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                contentColor = colors.secondaryContent,
                            ),
                        ) {
                            Text(stringResource(R.string.voice_cloud_consent_revoke))
                        }
                    }
                    state.voice.computers.forEach { computer ->
                        SettingsChoiceRow(
                            title = computer.label,
                            subtitle = when {
                                !computer.connected -> stringResource(R.string.voice_computer_offline)
                                !computer.installed -> stringResource(R.string.voice_computer_not_installed)
                                !computer.enabled -> stringResource(R.string.voice_computer_disabled)
                                !computer.ready -> stringResource(R.string.voice_computer_starting)
                                else -> stringResource(R.string.voice_computer_ready)
                            },
                            selected = state.voice.choice == "computer:${computer.targetId}",
                            enabled = computer.canRouteVoice || state.voice.choice == "computer:${computer.targetId}",
                            onClick = { onEvent(WorkbenchEvent.SelectVoiceChoice("computer:${computer.targetId}")) },
                            modifier = Modifier.testTag("voice-route-computer-${computer.targetId}"),
                        )
                    }
                }
            },
        )
    }

    if (state.voice.cloudConsentPrompt) {
        com.andysagent.agentoc.core.designsystem.AgentoAlertDialog(
            onDismissRequest = { onEvent(WorkbenchEvent.DeclineCloudVoiceConsent) },
            modifier = Modifier.testTag("voice-cloud-consent-dialog"),
            title = { Text(stringResource(R.string.voice_cloud_consent_title)) },
            text = { Text(stringResource(R.string.voice_cloud_upload_disclosure)) },
            dismissButton = {
                androidx.compose.material3.TextButton(
                    onClick = { onEvent(WorkbenchEvent.DeclineCloudVoiceConsent) },
                    enabled = !state.voice.cloudConsentBusy,
                ) {
                    Text(stringResource(R.string.voice_cloud_consent_decline))
                }
            },
            confirmButton = {
                androidx.compose.material3.TextButton(
                    onClick = { onEvent(WorkbenchEvent.AcceptCloudVoiceConsent) },
                    enabled = !state.voice.cloudConsentBusy,
                    colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                        contentColor = colors.accentPrimary,
                    ),
                ) {
                    if (state.voice.cloudConsentBusy) {
                        androidx.compose.material3.CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Text(stringResource(R.string.voice_cloud_consent_accept))
                    }
                }
            },
        )
    }

        // Modals & Bottom Sheets

        if (composerActionSheetOpen) {
            ComposerActionSheet(
                onDismiss = { onSetComposerActionSheetOpen(false) },
                onPickImage = {
                    runCatching {
                        photoPickerLauncher.launch(
                            androidx.activity.result.PickVisualMediaRequest(
                                androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageOnly
                            )
                        )
                    }.onFailure { onSetComposerActionSheetOpen(false) }
                },
                onPickDocument = {
                    runCatching {
                        documentPickerLauncher.launch(arrayOf("*/*"))
                    }.onFailure { onSetComposerActionSheetOpen(false) }
                },
                planMode = planMode,
                onTogglePlanMode = { onSetPlanMode(it) },
                goalMode = state.goalMode,
                goalText = state.goalText,
                onToggleGoalMode = { onEvent(WorkbenchEvent.ToggleGoalMode(it)) },
                onOpenGoalPanel = { onEvent(WorkbenchEvent.OpenGoalDialog) },
                onOpenAgents = {
                    onSetAgentPanelOpen(true)
                    onParityEvent(WebParityEvent.OpenPage(WebParityPage.Agents))
                },
                onOpenConnectors = {
                    onSetConnectorPanelOpen(true)
                    onParityEvent(WebParityEvent.OpenPage(WebParityPage.Connectors))
                },
                onInsertSlashCommand = { cmd ->
                    val newText = if (state.composerText.isBlank()) "$cmd " else "${state.composerText.trim()} $cmd "
                    onEvent(WorkbenchEvent.ComposerChanged(newText))
                },
                backdropLayer = chatModalBackdrop,
            )
        }

        if (agentPanelOpen) {
            AgentPanelModalBottomSheet(
                onDismiss = { onSetAgentPanelOpen(false) },
                agents = parityState.agents,
                selectedAgentId = state.selectedAgentId,
                onSelectAgent = { agent ->
                    onEvent(WorkbenchEvent.SelectAgent(agent?.id))
                },
                onOpenManageAgents = {
                    onSetAgentPanelOpen(false)
                    onEvent(WorkbenchEvent.OpenAgents)
                },
                isLoading = parityState.loading,
                backdropLayer = chatModalBackdrop,
            )
        }

        if (connectorPanelOpen) {
            val context = androidx.compose.ui.platform.LocalContext.current
            ConnectorPanelModalBottomSheet(
                onDismiss = { onSetConnectorPanelOpen(false) },
                connectors = parityState.connectors,
                mcpServers = parityState.mcpServers,
                onOpenManageConnectors = {
                    onSetConnectorPanelOpen(false)
                    onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Connectors))
                },
                onCopyCalendarFeed = {
                    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as? android.content.ClipboardManager
                    val clip = android.content.ClipData.newPlainText("Calendar Subscription", "/subscribe/calendar")
                    clipboard?.setPrimaryClip(clip)
                },
                isLoading = parityState.loading,
                backdropLayer = chatModalBackdrop,
            )
        }


        selectedDiffFile?.let { diffFile ->
            ChangedFilePreview(
                path = diffFile.path,
                state = parityState,
                onDismiss = { onSetSelectedDiffFile(null) },
            )
        }

        if (taskSettingsOpen) {
            TaskSettingsSheet(
                onDismiss = { taskSettingsOpen = false },
                runtimeCatalog = state.runtimeCatalog,
                runtimeTool = state.runtimeTool,
                onSelectRuntime = { onEvent(WorkbenchEvent.SelectRuntime(it)) },
                runtimeModel = state.runtimeModel,
                onSelectModel = { onEvent(WorkbenchEvent.SelectModel(it)) },
                effort = state.thinkingEffort,
                onEffortChange = { onEvent(WorkbenchEvent.EffortChanged(it)) },
                goalMode = state.goalMode,
                goalText = state.goalText,
                onToggleGoalMode = { onEvent(WorkbenchEvent.ToggleGoalMode(it)) },
                onGoalChange = { onEvent(WorkbenchEvent.SaveGoal(it)) },
                serviceTier = state.serviceTier,
                onSelectServiceTier = { onEvent(WorkbenchEvent.SelectServiceTier(it)) },
                backdropLayer = chatModalBackdrop,
            )
        }
    }

    if (state.chatOpen && state.runtimeUnavailable) {
        val needsHarness = state.runtimeCatalog.tools.isEmpty()
        AgentoDialog(
            title = stringResource(if (needsHarness) R.string.runtime_none_title else R.string.runtime_provider_none_title),
            confirmLabel = stringResource(if (needsHarness) R.string.runtime_none_settings else R.string.runtime_provider_none_settings),
            dismissLabel = stringResource(R.string.settings_cancel),
            onConfirm = {
                onEvent(WorkbenchEvent.DismissRuntimeUnavailable)
                onEvent(WorkbenchEvent.OpenSettingsPage(if (needsHarness) SettingsPage.Harnesses else SettingsPage.ModelProviders))
            },
            onDismiss = { onEvent(WorkbenchEvent.DismissRuntimeUnavailable) },
            content = { Text(stringResource(if (needsHarness) R.string.runtime_none_detail else R.string.runtime_provider_none_detail)) },
        )
    }
    if (renameDialogOpen) {
        AgentoDialog(
            title = "Rename session",
            confirmLabel = "Save",
            onConfirm = {
                if (renameText.trim().isNotBlank()) {
                    renameDialogOpen = false
                    onEvent(WorkbenchEvent.RenameSession(renameText))
                }
            },
            onDismiss = { renameDialogOpen = false },
            confirmEnabled = renameText.trim().isNotBlank() && !state.sessionActionInProgress,
            backdropLayer = chatModalBackdrop,
            icon = { AgentoWebIcon(AgentoWebGlyph.Edit, contentDescription = null) },
            content = {
                AgentoTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    label = "Session name",
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.sessionActionInProgress,
                )
            },
        )
    }
    if (deleteDialogOpen) {
        AgentoDialog(
            title = "Delete session?",
            confirmLabel = "Delete",
            onConfirm = {
                deleteDialogOpen = false
                onEvent(WorkbenchEvent.DeleteSession)
            },
            onDismiss = { deleteDialogOpen = false },
            confirmEnabled = !state.sessionActionInProgress,
            backdropLayer = chatModalBackdrop,
            icon = { AgentoWebIcon(AgentoWebGlyph.Info, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
            content = {
                Text(
                    text = "This permanently removes the session history from the connected workspace.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.secondaryContent,
                )
            },
        )
    }
}

@Composable
private fun EmptyConversationSuggestionRail(
    onSuggestion: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val suggestions = listOf(
        Triple(stringResource(R.string.workbench_suggestion_organize_project), AgentoWebGlyph.Folder, LocalAgentocColors.current.accentPrimary),
        Triple(stringResource(R.string.workbench_suggestion_explain_file), AgentoWebGlyph.File, Color(0xFF30D158)),
        Triple(stringResource(R.string.workbench_suggestion_create_plan), AgentoWebGlyph.TargetArrow, Color(0xFFBF5AF2)),
    )
    // These are optional prompts, not a second navigation bar. They remain
    // available while disconnected because they only populate the local
    // draft; the normal pending-send path owns delivery after recovery.
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        suggestions.forEach { (text, glyph, glyphTint) ->
            EmptyConversationSuggestion(
                text = text,
                glyph = glyph,
                glyphTint = glyphTint,
                onClick = { onSuggestion(text) },
                modifier = Modifier.widthIn(min = 190.dp, max = 300.dp),
            )
        }
    }
}

@Composable
private fun EmptyConversationSuggestion(
    text: String,
    glyph: AgentoWebGlyph,
    glyphTint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    AgentoFrostedGlassBox(
        modifier = modifier
            .heightIn(min = 42.dp)
            .agentoPressScale(pressedScale = 0.94f, onClick = onClick),
        shape = AgentoShapes.PillShape,
        surface = AgentoGlassSurface.Tinted(if (isDark) Color(0x28FFFFFF) else Color(0xEEFFFFFF)),
        blurRadius = AgentoFrostedTokens.BlurStandard,
        showTopHairline = true,
        hasShadow = true,
        shadowElevation = 4.dp,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AgentoWebIcon(
                glyph = glyph,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = glyphTint,
            )
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                ),
                color = colors.primaryContent,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun DeviceConnectionPrompt(
    onConnectDevice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
    ) {
        AgentoEmptyState(
            stringResource(R.string.workbench_connect_device_title),
            stringResource(R.string.workbench_connect_device_detail),
        )
        AgentoButton(
            text = stringResource(R.string.workbench_connect_device_action),
            onClick = onConnectDevice,
            decision = true,
        )
    }
}

/** A quiet, fixed-height hint that leaves the transcript as the focal point. */
@Composable
internal fun ActiveRunActionBar(
    status: AgentRunStatus,
    actionSummary: String? = null,
    sending: Boolean = false,
    modifier: Modifier = Modifier,
    actionState: com.andysagent.agentoc.core.timeline.RunActionUiState? = null,
) {
    val colors = LocalAgentocColors.current
    val sentence = when {
        sending -> stringResource(R.string.workbench_status_sending)
        actionState != null -> presentRunAction(actionState)
        !actionSummary.isNullOrBlank() -> actionSummary
        status == AgentRunStatus.WaitingApproval -> stringResource(R.string.workbench_status_awaiting_approval)
        else -> stringResource(R.string.workbench_status_processing)
    }
    val shimmer by rememberInfiniteTransition(label = "run-action-shimmer").animateFloat(
        initialValue = -1f, targetValue = 2f,
        animationSpec = infiniteRepeatable(tween(1800, easing = LinearEasing)), label = "run-action-shimmer-position",
    )
    var textWidth by remember { mutableIntStateOf(1) }
    val base = colors.secondaryContent
    val highlight = androidx.compose.ui.graphics.lerp(base, colors.primaryContent, 0.7f)
    val shimmerBrush = Brush.horizontalGradient(
        colors = listOf(base, highlight, base),
        startX = (shimmer - 0.35f) * textWidth,
        endX = (shimmer + 0.35f) * textWidth,
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp)
            .padding(vertical = 4.dp)
            .testTag("active-run-action")
            .semantics {
                contentDescription = sentence
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AnimatedContent(
            targetState = sentence,
            modifier = Modifier.weight(1f, fill = false),
            transitionSpec = {
                (expandHorizontally(expandFrom = Alignment.Start, animationSpec = tween(280, easing = FastOutSlowInEasing)) +
                    fadeIn(animationSpec = tween(220))) togetherWith fadeOut(animationSpec = tween(120))
            },
            label = "run-action-content",
        ) { current ->
                BasicText(
                    text = current,
                    modifier = Modifier.onSizeChanged { textWidth = it.width.coerceAtLeast(1) },
                    style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.5.sp, brush = shimmerBrush),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
        }
    }
}

@Composable
private fun SendingActivityLine(modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 28.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        com.andysagent.agentoc.core.designsystem.AgentoBreathingDot(
            color = colors.stateRunning,
            size = 5.dp,
        )
        Text(
            stringResource(R.string.workbench_status_sending),
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp),
            color = colors.secondaryContent,
        )
    }
}

@Composable
private fun TimelineDisplayItemView(
    entry: ChatTimelineEntry,
    isLastAgentMessage: Boolean = false,
    canEditResendUserMessage: Boolean = false,
    onBranch: (() -> Unit)? = null,
    onRestart: (() -> Unit)? = null,
    onEditResend: (String) -> Unit = {},
    onPlanAction: (String, String) -> Unit = { _, _ -> },
    onRetryPendingTurn: () -> Unit = {},
) {
    when (entry) {
        is ChatTimelineEntry.LiveActivity -> ToolCallCard(
            state = ToolCallUiState(
                id = entry.operation.id,
                kind = entry.operation.kind.toAgentKind(),
                title = entry.operation.title,
                detail = entry.operation.detail,
                status = entry.operation.status.toAgentStatus(),
                requiresApproval = entry.operation.requiresApproval,
            ),
            activitySummary = displayAgentMessageText(entry.summary),
        )
        is ChatTimelineEntry.Single -> TimelineItemView(
            item = entry.item,
            isLastAgentMessage = isLastAgentMessage,
            canEditResendUserMessage = canEditResendUserMessage,
            onBranch = onBranch,
            onRestart = onRestart,
            onEditResend = onEditResend,
            onPlanAction = onPlanAction,
        )
        is ChatTimelineEntry.Pipeline -> com.andysagent.agentoc.core.agentui.ToolActivityGroupCard(entry.operations)
        is ChatTimelineEntry.FileChangeGroup -> com.andysagent.agentoc.core.agentui.FileChangeSummaryCard(entry.state)
        is ChatTimelineEntry.StatusBanner -> com.andysagent.agentoc.core.agentui.TaskStatusCard(entry.state)
        is ChatTimelineEntry.PendingTurn -> PendingTurnItemView(entry.state, onRetryPendingTurn)
    }
}

/**
 * 飞顶行外壳：测量自身 root 顶部，并按共享飞行进度绘制位移/缩放/透明度。
 * 进度放在 [TurnFlightState] 行外共享，pending→提交换血后由接替行继续绘制
 * 同一段进度，等价于 web 的「echo 元素身份不换」原地升级契约。
 */
@Composable
private fun TurnDockFlightShell(
    flight: TurnFlightState,
    rowRequestId: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .graphicsLayer {
                val bubbleTop = flight.bubbleTopPx
                if (flight.activeRequestId != rowRequestId || bubbleTop == Int.MAX_VALUE) {
                    translationY = 0f
                    scaleX = 1f
                    scaleY = 1f
                    alpha = 1f
                    return@graphicsLayer
                }
                val progress = flight.progress.value
                val delta = (flight.launchComposerTopPx - bubbleTop).toFloat()
                if (delta <= TurnFlightMinDeltaPx) {
                    translationY = 0f
                    scaleX = 1f
                    scaleY = 1f
                    alpha = 1f
                    return@graphicsLayer
                }
                // web 关键帧：transform 380ms 全程；opacity 半程即到 1。
                translationY = delta * (1f - progress)
                val scale = 0.96f + 0.04f * progress
                scaleX = scale
                scaleY = scale
                alpha = (0.88f + 0.24f * progress).coerceAtMost(1f)
            }
            .onGloballyPositioned { coordinates ->
                if (flight.activeRequestId == rowRequestId) {
                    flight.bubbleTopPx = coordinates.boundsInRoot().top.roundToInt()
                }
            },
    ) {
        content()
    }
}

@Composable
private fun PendingTurnItemView(
    state: PendingTurnUiState,
    onRetry: () -> Unit,
) {
    val entryAlpha by animateFloatAsState(
        targetValue = if (state.state == PendingTurnState.Sending) 1f else 0.92f,
        animationSpec = tween(180),
        label = "pendingTurnAlpha",
    )
    Column(
        modifier = Modifier.fillMaxWidth().graphicsLayer(alpha = entryAlpha),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // 入场不在这里包 AnimatedVisibility——visible=true 的首次组合不播动画。
        // 普通时间行走行级 animateItem；发送飞顶的 pending 行由 TurnDockFlightShell
        // 的起飞位移/透明度承担入场（行级 fadeIn 对它已关闭）。
        UserMessage(
            text = state.text,
            attachments = state.attachments.mapIndexed { index, attachment ->
                UserMessageAttachment(
                    id = attachment.id.ifBlank { "pending-attachment-$index" },
                    name = attachment.name,
                    mimeType = attachment.mimeType,
                    sizeBytes = attachment.sizeBytes,
                    url = attachment.previewUrl,
                )
            },
        )
        if (state.state == PendingTurnState.Sending && state.attachments.isNotEmpty()) {
            val progress = state.attachmentUploadProgress
            val hasTransferProgress = progress != null && progress.phase in setOf(
                com.andysagent.agentoc.core.domain.FileUploadPhase.TRANSFERRING,
                com.andysagent.agentoc.core.domain.FileUploadPhase.VERIFYING,
                com.andysagent.agentoc.core.domain.FileUploadPhase.CONFIRMED,
            )
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = if (hasTransferProgress) {
                        stringResource(
                            R.string.workbench_upload_progress,
                            ((progress!!.fraction * 100f).toInt()).coerceIn(0, 100),
                        )
                    } else stringResource(R.string.workbench_upload_preparing),
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalAgentocColors.current.secondaryContent,
                )
                if (hasTransferProgress) {
                    LinearProgressIndicator(
                        progress = { progress!!.fraction },
                        modifier = Modifier.width(144.dp).height(3.dp),
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    LinearProgressIndicator(
                        modifier = Modifier.width(144.dp).height(3.dp),
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
        if (state.state == PendingTurnState.Failed) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = state.error ?: "Message was not sent",
                    style = MaterialTheme.typography.labelMedium,
                    color = LocalAgentocColors.current.error,
                    maxLines = 2,
                    textAlign = TextAlign.End,
                )
                AgentoButton(
                    text = "Retry",
                    onClick = onRetry,
                    secondary = true,
                )
            }
        }
    }
}

@Composable
private fun TimelineItemView(
    item: TimelineItem,
    isLastAgentMessage: Boolean = false,
    canEditResendUserMessage: Boolean = false,
    onBranch: (() -> Unit)? = null,
    onRestart: (() -> Unit)? = null,
    onEditResend: (String) -> Unit = {},
    onPlanAction: (String, String) -> Unit = { _, _ -> },
) {
    when (item) {
        is TimelineItem.Message -> when (item.role) {
            com.andysagent.agentoc.core.timeline.TimelineRole.User -> UserMessage(
                text = item.text,
                attachments = item.attachments.mapIndexed { index, attachment ->
                    UserMessageAttachment(
                        id = attachment.assetId ?: "message-attachment-$index",
                        name = attachment.originalName ?: attachment.filename ?: attachment.assetId ?: "附件",
                        mimeType = attachment.mimeType ?: "application/octet-stream",
                        sizeBytes = attachment.sizeBytes ?: 0L,
                        url = attachment.downloadUrl ?: attachment.url,
                    )
                },
                canEditResend = canEditResendUserMessage,
                onBranch = onBranch,
                onEditResend = { onEditResend(item.text) },
            )
            com.andysagent.agentoc.core.timeline.TimelineRole.Agent -> if (item.completed) {
                com.andysagent.agentoc.core.agentui.AgentMessage(
                    text = displayAgentMessageText(item.text),
                    isLastMessage = isLastAgentMessage,
                    onBranch = onBranch,
                    onRestart = onRestart,
                )
            } else {
                AgentStreamingMessage(
                    text = displayAgentMessageText(item.text),
                )
            }
            com.andysagent.agentoc.core.timeline.TimelineRole.System -> {
                val statusKind = when {
                    item.text.contains("完成") || item.text.contains("completed") -> TaskStatusKind.Completed
                    item.text.contains("等待") || item.text.contains("waiting") -> TaskStatusKind.WaitingInput
                    item.text.contains("失败") || item.text.contains("error") || item.text.contains("fail") -> TaskStatusKind.Failed
                    else -> TaskStatusKind.Running
                }
                TaskStatusCard(
                    state = TaskStatusUiState(
                        id = item.id,
                        status = statusKind,
                        title = item.text,
                    ),
                )
            }
        }
        is TimelineItem.Operation -> ToolCallCard(ToolCallUiState(item.id, item.kind.toAgentKind(), item.title, item.detail, item.status.toAgentStatus(), item.requiresApproval))
        is TimelineItem.Notice -> TaskStatusCard(
            state = TaskStatusUiState(
                id = item.id,
                status = TaskStatusKind.Failed,
                title = "Session notice",
                description = item.text,
                retryLabel = "Dismiss",
            ),
        )
        is TimelineItem.Plan -> PlanArtifactCard(item, onPlanAction)
    }
}

@Composable
private fun PlanArtifactCard(
    plan: TimelineItem.Plan,
    onAction: (String, String) -> Unit,
) {
    val colors = LocalAgentocColors.current
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = AgentoShapes.SquircleL,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.72f),
    ) {
        Column(
            modifier = Modifier.padding(AgentocSpacing.Standard),
            verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(plan.title, style = AgentocTextStyles.pageTitle, color = colors.primaryContent)
                Text("${plan.state} · r${plan.revision}", style = AgentocTextStyles.caption, color = colors.secondaryContent)
            }
            if (plan.items.isEmpty()) {
                Text("Preparing steps", style = AgentocTextStyles.caption, color = colors.secondaryContent)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    plan.items.forEachIndexed { index, step ->
                        Text(
                            text = "${if (step.status == "completed") "✓" else "○"}  ${index + 1}. ${step.text}",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.primaryContent,
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                AgentoButton(
                    text = "Revise",
                    onClick = { onAction(plan.planId, "revise") },
                    modifier = Modifier.weight(1f),
                    secondary = true,
                )
                AgentoButton(
                    text = "Execute",
                    onClick = { onAction(plan.planId, "execute") },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun ComputersSurface(state: WorkbenchUiState, onEvent: (WorkbenchEvent) -> Unit, modifier: Modifier) {
    Column(modifier.fillMaxSize().statusBarsPadding()) {
        AgentoTopBar("Computers", subtitle = "Trusted machines available to this phone", actions = { ConnectionStatus(state.connection) })
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            if (state.computers.isEmpty()) {
                Column(
                    Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth).padding(AgentocSpacing.Gutter),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard),
                ) {
                    AgentoEmptyState("No trusted computer", "Pair a computer to run work and review progress from Android.")
                    AgentoButton("Connect computer", { onEvent(WorkbenchEvent.OpenPairing) }, decision = true)
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = AgentocSpacing.Gutter,
                        end = AgentocSpacing.Gutter,
                        top = AgentocSpacing.Gutter,
                        bottom = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
                ) {
                    items(state.computers, key = { it.id }) { computer ->
                        AgentoListItem(
                            title = computer.name,
                            supportingText = computer.platform ?: "Trusted device",
                            leading = { AgentoWebIcon(AgentoWebGlyph.Monitor, contentDescription = null, modifier = Modifier.size(AgentocSizes.IconLarge)) },
                            trailing = {
                                AgentoStatus(if (computer.connected) "Trusted" else "Revoked", if (computer.connected) AgentoStatusTone.Success else AgentoStatusTone.Error)
                            },
                        )
                    }
                }
            }
        }
        if (state.connection == AgentConnectionStatus.AuthenticationRequired) {
            Column(Modifier.fillMaxWidth().padding(horizontal = AgentocSpacing.Gutter, vertical = AgentocSpacing.Compact), verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                AgentoSectionHeader("Authentication required", supportingText = "Pair this phone again to restore access.")
                AgentoButton("Pair again", { onEvent(WorkbenchEvent.OpenPairing) }, decision = true)
            }
        }
    }
}

@Composable
internal fun ProjectDialog(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    folderBrowser: ProjectFolderBrowser = UnavailableProjectFolderBrowser,
) {
    var locationStep by rememberSaveable { mutableStateOf(ProjectLocationStep.Details) }
    var directoryPath by rememberSaveable { mutableStateOf<String?>(null) }
    var drives by remember { mutableStateOf<List<ProjectFolderLocation>>(emptyList()) }
    var folderListing by remember { mutableStateOf<ProjectFolderListing?>(null) }
    var browserLoading by remember { mutableStateOf(false) }
    var browserError by remember { mutableStateOf<String?>(null) }
    var browserRetryKey by remember { mutableIntStateOf(0) }
    val recentLocations = remember(state.projects) {
        state.projects
            .mapNotNull { it.folder?.trim()?.takeIf(String::isNotBlank) }
            .distinct()
            .take(3)
    }
    val creating = state.projectInProgress || state.projectFolderCreating
    var folderCreationPending by remember { mutableStateOf(false) }
    LaunchedEffect(state.projectFolderCreating) {
        if (state.projectFolderCreating) {
            folderCreationPending = true
        } else if (folderCreationPending) {
            folderCreationPending = false
            if (state.projectFolderError == null) {
                directoryPath = state.projectRootPath
                folderListing = null
                browserRetryKey += 1
            }
        }
    }
    val title = when (locationStep) {
        ProjectLocationStep.Details -> stringResource(R.string.project_create_title)
        ProjectLocationStep.Picker -> stringResource(R.string.project_location_title)
        ProjectLocationStep.Drives,
        ProjectLocationStep.Folders,
        -> stringResource(R.string.project_location_title)
    }
    val confirmLabel = when (locationStep) {
        ProjectLocationStep.Details -> if (creating) {
            stringResource(R.string.project_creating)
        } else {
            stringResource(R.string.project_create)
        }
        ProjectLocationStep.Picker,
        ProjectLocationStep.Drives,
        -> stringResource(R.string.project_done)
        ProjectLocationStep.Folders -> stringResource(R.string.project_use_location)
    }

    LaunchedEffect(locationStep, browserRetryKey) {
        if (locationStep != ProjectLocationStep.Drives) return@LaunchedEffect
        browserLoading = true
        browserError = null
        try {
            drives = folderBrowser.loadRoots()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            drives = emptyList()
            browserError = error.message
        } finally {
            browserLoading = false
        }
    }

    LaunchedEffect(locationStep, directoryPath, browserRetryKey) {
        val requestedPath = directoryPath
        if (locationStep != ProjectLocationStep.Folders || requestedPath.isNullOrBlank()) return@LaunchedEffect
        browserLoading = true
        browserError = null
        try {
            folderListing = folderBrowser.loadDirectory(requestedPath)
            directoryPath = folderListing?.path ?: requestedPath
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            folderListing = null
            browserError = error.message
        } finally {
            browserLoading = false
        }
    }

    AgentoDialog(
        title = title,
        confirmLabel = confirmLabel,
        onConfirm = {
            when (locationStep) {
                ProjectLocationStep.Details -> onEvent(WorkbenchEvent.CreateProject)
                ProjectLocationStep.Picker -> locationStep = ProjectLocationStep.Details
                ProjectLocationStep.Drives -> locationStep = ProjectLocationStep.Picker
                ProjectLocationStep.Folders -> folderListing?.path?.let { path ->
                    onEvent(WorkbenchEvent.ProjectRootPathChanged(path))
                    locationStep = ProjectLocationStep.Details
                }
            }
        },
        onDismiss = {
            if (!creating) {
                locationStep = when (locationStep) {
                    ProjectLocationStep.Details -> {
                        onEvent(WorkbenchEvent.DismissProjectDialog)
                        ProjectLocationStep.Details
                    }
                    ProjectLocationStep.Picker -> ProjectLocationStep.Details
                    ProjectLocationStep.Drives -> ProjectLocationStep.Picker
                    ProjectLocationStep.Folders -> ProjectLocationStep.Drives
                }
            }
        },
        confirmEnabled = !creating && (locationStep != ProjectLocationStep.Folders || folderListing != null),
        dismissEnabled = !creating,
        dismissLabel = if (locationStep == ProjectLocationStep.Details) {
            stringResource(R.string.project_cancel)
        } else {
            stringResource(R.string.project_back)
        },
        icon = { AgentoWebIcon(AgentoWebGlyph.Folder, contentDescription = null) },
        content = {
            AnimatedContent(
                targetState = locationStep,
                transitionSpec = {
                    (fadeIn(tween(180)) + slideInHorizontally(tween(180)) { it / 12 }) togetherWith
                        (fadeOut(tween(120)) + slideOutHorizontally(tween(120)) { -it / 12 })
                },
                label = "project location step",
            ) { step ->
                when (step) {
                    ProjectLocationStep.Details -> ProjectDetailsForm(
                        state = state,
                        onNameChanged = { onEvent(WorkbenchEvent.ProjectNameChanged(it)) },
                        onLocationClick = { locationStep = ProjectLocationStep.Picker },
                    )
                    ProjectLocationStep.Picker -> ProjectLocationPicker(
                        recentLocations = recentLocations,
                        selectedLocation = state.projectRootPath,
                        onLocationSelected = { location ->
                            onEvent(WorkbenchEvent.ProjectRootPathChanged(location))
                            locationStep = ProjectLocationStep.Details
                        },
                        onChooseAnother = {
                            directoryPath = null
                            folderListing = null
                            browserError = null
                            locationStep = ProjectLocationStep.Drives
                        },
                    )
                    ProjectLocationStep.Drives -> ProjectDrivePicker(
                        drives = drives,
                        loading = browserLoading,
                        error = browserError,
                        onDriveSelected = { drive ->
                            directoryPath = drive.path
                            folderListing = null
                            browserError = null
                            locationStep = ProjectLocationStep.Folders
                        },
                        onRetry = { browserRetryKey += 1 },
                    )
                    ProjectLocationStep.Folders -> ProjectFolderPicker(
                        state = state,
                        onEvent = onEvent,
                        listing = folderListing,
                        loading = browserLoading,
                        error = browserError,
                        onFolderSelected = { folder ->
                            directoryPath = folder.path
                            folderListing = null
                        },
                        onNavigateUp = {
                            folderListing?.parent?.let { parent ->
                                directoryPath = parent
                                folderListing = null
                            }
                        },
                        onRetry = { browserRetryKey += 1 },
                    )
                }
            }
        }
    )
}

@Preview(name = "Project folder picker", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun ProjectDialogPreview() {
    AgentocTheme {
        ProjectDialog(
            state = WorkbenchUiState(
                projectDialogOpen = true,
                projectName = "Android app",
                projectRootPath = "C:\\Workspace",
                projectFolderParentPath = "C:\\",
                projectFolderChildren = listOf(
                    ProjectFolder("C:\\Workspace\\Android", "Android"),
                    ProjectFolder("C:\\Workspace\\Documents", "Documents"),
                ),
            ),
            onEvent = {},
        )
    }
}

@Composable
private fun ProjectDrivePicker(
    drives: List<ProjectFolderLocation>,
    loading: Boolean,
    error: String?,
    onDriveSelected: (ProjectFolderLocation) -> Unit,
    onRetry: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard)) {
        Text(
            text = stringResource(R.string.project_drives),
            style = MaterialTheme.typography.labelLarge,
            color = LocalAgentocColors.current.primaryContent,
        )
        when {
            loading -> ProjectLocationLoading()
            error != null -> ProjectLocationLoadError(onRetry)
            drives.isEmpty() -> ProjectLocationEmpty()
            else -> {
                val isDark = LocalAgentocColors.current.canvas.red < 0.5f
                AgentoFrostedGlassBox(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
                    blurRadius = AgentoFrostedTokens.BlurNavigation,
                    material = AgentoGlassMaterial.LiquidClear,
                    showTopHairline = true,
                    hasShadow = true,
                    shadowElevation = 6.dp,
                ) {
                    Column {
                        drives.forEachIndexed { index, drive ->
                            ProjectLocationRow(
                                label = drive.name,
                                onClick = { onDriveSelected(drive) },
                                leadingGlyph = AgentoWebGlyph.Monitor,
                            )
                            if (index < drives.lastIndex) ProjectLocationDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectFolderPicker(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    listing: ProjectFolderListing?,
    loading: Boolean,
    error: String?,
    onFolderSelected: (ProjectFolderLocation) -> Unit,
    onNavigateUp: () -> Unit,
    onRetry: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard)) {
        listing?.let { directory ->
            ProjectFolderBreadcrumb(
                path = directory.path,
                canNavigateUp = directory.parent != null,
                onNavigateUp = onNavigateUp,
            )
            AgentoButton(
                text = stringResource(if (state.projectFolderCreateOpen) R.string.project_cancel else R.string.project_new_folder),
                onClick = {
                    onEvent(WorkbenchEvent.BrowseProjectFolder(directory.path))
                    onEvent(WorkbenchEvent.ToggleProjectFolderCreate)
                },
                secondary = true,
                enabled = !loading && !state.projectFolderCreating,
            )
            if (state.projectFolderCreateOpen) {
                Row(horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact), verticalAlignment = Alignment.CenterVertically) {
                    AgentoTextField(
                        value = state.projectFolderName,
                        onValueChange = { onEvent(WorkbenchEvent.ProjectFolderNameChanged(it)) },
                        label = stringResource(R.string.project_folder_name),
                        modifier = Modifier.weight(1f),
                        enabled = !state.projectFolderCreating,
                    )
                    AgentoButton(
                        text = stringResource(R.string.project_create),
                        onClick = { onEvent(WorkbenchEvent.CreateProjectFolder) },
                        secondary = true,
                        enabled = !state.projectFolderCreating && !state.projectFoldersLoading && state.projectFolderName.isNotBlank(),
                    )
                }
                state.projectFolderError?.let { AgentoErrorText(it) }
            }
        }
        when {
            loading -> ProjectLocationLoading()
            error != null -> ProjectLocationLoadError(onRetry)
            listing == null -> ProjectLocationLoading()
            listing.children.isEmpty() -> ProjectLocationEmpty()
            else -> {
                val isDark = LocalAgentocColors.current.canvas.red < 0.5f
                AgentoFrostedGlassBox(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
                    blurRadius = AgentoFrostedTokens.BlurNavigation,
                    material = AgentoGlassMaterial.LiquidClear,
                    showTopHairline = true,
                    hasShadow = true,
                    shadowElevation = 6.dp,
                ) {
                    Column {
                        listing.children.forEachIndexed { index, folder ->
                            ProjectLocationRow(
                                label = folder.name,
                                onClick = { onFolderSelected(folder) },
                                leadingGlyph = AgentoWebGlyph.Folder,
                            )
                            if (index < listing.children.lastIndex) ProjectLocationDivider()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectFolderBreadcrumb(
    path: String,
    canNavigateUp: Boolean,
    onNavigateUp: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    Row(
        modifier = Modifier.fillMaxWidth().heightIn(min = AgentocSpacing.TouchTarget),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid),
    ) {
        if (canNavigateUp) {
            AgentoIconButton(
                onClick = onNavigateUp,
                contentDescription = stringResource(R.string.project_back),
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Back,
                    contentDescription = null,
                    modifier = Modifier.size(AgentocSizes.Icon),
                    tint = colors.secondaryContent,
                )
            }
        }
        Text(
            text = path.projectLocationBreadcrumb(),
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.primaryContent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ProjectLocationLoading() {
    Box(
        modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            strokeWidth = 2.dp,
            color = LocalAgentocColors.current.accentPrimary,
        )
    }
}

@Composable
private fun ProjectLocationLoadError(onRetry: () -> Unit) {
    val colors = LocalAgentocColors.current
    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
        Text(
            text = stringResource(R.string.project_folder_load_failed),
            style = MaterialTheme.typography.bodySmall,
            color = colors.secondaryContent,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        ProjectLocationRow(
            label = stringResource(R.string.project_retry),
            onClick = onRetry,
            showChevron = false,
            leadingGlyph = AgentoWebGlyph.Refresh,
        )
    }
}

@Composable
private fun ProjectLocationEmpty() {
    Text(
        text = stringResource(R.string.project_folder_empty),
        modifier = Modifier.fillMaxWidth().padding(vertical = AgentocSpacing.xl),
        style = MaterialTheme.typography.bodyMedium,
        color = LocalAgentocColors.current.secondaryContent,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun ProjectLocationDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 52.dp),
        thickness = 0.5.dp,
        color = LocalAgentocColors.current.subtleOutline,
    )
}

@Composable
private fun ProjectDetailsForm(
    state: WorkbenchUiState,
    onNameChanged: (String) -> Unit,
    onLocationClick: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard)) {
        AgentoTextField(
            value = state.projectName,
            onValueChange = onNameChanged,
            label = stringResource(R.string.project_name),
            modifier = Modifier.fillMaxWidth(),
            enabled = !state.projectInProgress,
        )
        ProjectLocationRow(
            label = state.projectRootPath.projectLocationLabel()
                ?: stringResource(R.string.project_choose_location),
            onClick = onLocationClick,
        )
    }
}

@Composable
private fun ProjectLocationPicker(
    recentLocations: List<String>,
    selectedLocation: String,
    onLocationSelected: (String) -> Unit,
    onChooseAnother: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard)) {
        if (recentLocations.isNotEmpty()) {
            Text(
                text = stringResource(R.string.project_recent_locations),
                style = MaterialTheme.typography.labelLarge,
                color = LocalAgentocColors.current.primaryContent,
            )
            val isDark = LocalAgentocColors.current.canvas.red < 0.5f
            AgentoFrostedGlassBox(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                material = AgentoGlassMaterial.LiquidClear,
                showTopHairline = false,
                hasShadow = false,
            ) {
                Column {
                    recentLocations.forEachIndexed { index, location ->
                        ProjectLocationRow(
                            label = location.projectLocationLabel() ?: location,
                            selected = location == selectedLocation,
                            onClick = { onLocationSelected(location) },
                            showChevron = false,
                        )
                        if (index < recentLocations.lastIndex) {
                            HorizontalDivider(
                                modifier = Modifier.padding(start = 52.dp),
                                thickness = 0.5.dp,
                                color = LocalAgentocColors.current.subtleOutline,
                            )
                        }
                    }
                }
            }
        }
        ProjectLocationRow(
            label = stringResource(R.string.project_choose_another_location),
            onClick = onChooseAnother,
        )
    }
}

@Composable
private fun ProjectLocationRow(
    label: String,
    onClick: () -> Unit,
    selected: Boolean = false,
    showChevron: Boolean = true,
    leadingGlyph: AgentoWebGlyph = AgentoWebGlyph.Folder,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val rowShape = RoundedCornerShape(12.dp)
    val rowBg = when {
        selected -> colors.actionPrimary.copy(alpha = if (isDark) 0.18f else 0.10f)
        else -> Color.Transparent
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = AgentocSpacing.TouchTarget)
            .clip(rowShape)
            .background(rowBg)
            .agentoPressScale(
                pressedScale = 0.98f,
                onClick = onClick,
            )
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(
                        when {
                            selected -> colors.actionPrimary.copy(alpha = 0.20f)
                            leadingGlyph == AgentoWebGlyph.Monitor -> Color(0xFF5E5CE6).copy(alpha = if (isDark) 0.18f else 0.12f)
                            else -> LocalAgentocColors.current.accentPrimary.copy(alpha = if (isDark) 0.18f else 0.12f)
                        }
                    ),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = leadingGlyph,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = when {
                        selected -> colors.accentPrimary
                        leadingGlyph == AgentoWebGlyph.Monitor -> Color(0xFF5E5CE6)
                        else -> LocalAgentocColors.current.accentPrimary
                    },
                )
            }
            Text(
                text = label,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = if (selected) colors.accentPrimary else colors.primaryContent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (selected) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Check,
                    contentDescription = null,
                    modifier = Modifier.size(AgentocSizes.Icon),
                    tint = colors.accentPrimary,
                )
            } else if (showChevron) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronRight,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = colors.secondaryContent.copy(alpha = 0.6f),
                )
            }
        }
    }
}

private fun String?.projectLocationLabel(): String? {
    val path = this?.trim()?.takeIf(String::isNotBlank) ?: return null
    val trimmed = path.trimEnd('/', '\\')
    return trimmed.substringAfterLast('\\').substringAfterLast('/').ifBlank { path }
}

/** Keep location context recognizable without pinning a full absolute path in the sheet. */
private fun String.projectLocationBreadcrumb(): String {
    val trimmed = trim().trimEnd('/', '\\')
    val parts = trimmed.split('\\', '/').filter(String::isNotBlank)
    if (parts.isEmpty()) return if (trimmed.startsWith('/')) "/" else trimmed
    return when (parts.size) {
        1 -> parts.single()
        2 -> parts.joinToString(" > ")
        3 -> parts.joinToString(" > ")
        else -> listOf(parts.first(), "...", parts[parts.lastIndex - 1], parts.last()).joinToString(" > ")
    }
}

@Composable
internal fun PairingOnboardingDialog(
    state: PairingOnboardingUiState,
    onEvent: (PairingOnboardingEvent) -> Unit,
    onScanPairing: () -> Unit,
    onScanPairingFromWelcome: () -> Unit,
    onOpenSubscription: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val computerName = state.selectedComputer?.alias?.takeIf { it.isNotBlank() }
        ?: state.computerAlias.takeIf { it.isNotBlank() }
    var detailsOpen by remember(state.errorMessage) { mutableStateOf(false) }
    val verifying = state.step == PairingOnboardingStep.Verifying
    val quotaBlocked = state.step == PairingOnboardingStep.Error && state.subscriptionRequired
    val scannerUnavailable = state.step == PairingOnboardingStep.Error && state.scannerUnavailable
    val scannerFailureFromWelcome = state.step == PairingOnboardingStep.Error &&
        state.scannerFailureReturnsToWelcome
    val confirmLabel = when (state.step) {
        PairingOnboardingStep.Welcome -> error("Welcome is rendered as a full-screen surface")
        PairingOnboardingStep.ConnectionMethods -> error("Connection methods are rendered as a full-screen surface")
        PairingOnboardingStep.GoogleRequired -> error("Google sign-in is rendered as a full-screen surface")
        PairingOnboardingStep.AccountClaimRequired -> stringResource(R.string.pairing_link_computer)
        PairingOnboardingStep.ComputerAliasRequired -> stringResource(R.string.pairing_link_computer)
        PairingOnboardingStep.ComputerSelect -> stringResource(R.string.pairing_connect_selected)
        PairingOnboardingStep.Verifying -> stringResource(R.string.pairing_connecting)
        PairingOnboardingStep.Bound -> stringResource(if (state.temporaryPairing)
            R.string.temporary_pairing_done else R.string.onboarding_begin)
        PairingOnboardingStep.Error -> when {
            quotaBlocked -> stringResource(R.string.pairing_view_pro_plans)
            scannerUnavailable || scannerFailureFromWelcome -> stringResource(R.string.welcome_scan)
            state.canReplaceTemporaryClaim -> stringResource(R.string.temporary_pairing_replace)
            state.requiresNewCode -> stringResource(R.string.pairing_setup_guide_scan)
            else -> stringResource(R.string.pairing_try_again)
        }
    }
    OnboardingSheet(
        modifier = Modifier.testTag("pairing-state-sheet"),
        title = when {
            scannerUnavailable -> stringResource(R.string.pairing_scanner_title)
            verifying -> computerName?.let { stringResource(R.string.onboarding_connecting_named, it) }
                ?: stringResource(R.string.pairing_connecting)
            state.step == PairingOnboardingStep.Bound -> computerName?.let { stringResource(R.string.onboarding_connected_named, it) }
                ?: stringResource(R.string.pairing_connected_status)
            state.requiresNewCode -> stringResource(R.string.onboarding_code_unusable)
            state.temporaryPairingFailure == TemporaryPairingFailure.HostUnavailable -> stringResource(R.string.onboarding_host_unavailable)
            state.step == PairingOnboardingStep.Error -> stringResource(R.string.pairing_connection_failed)
            else -> stringResource(R.string.pairing_dialog_title)
        },
        confirmLabel = confirmLabel,
        onConfirm = {
            when (state.step) {
                PairingOnboardingStep.Welcome -> Unit
                PairingOnboardingStep.ConnectionMethods -> Unit
                PairingOnboardingStep.GoogleRequired -> Unit
                PairingOnboardingStep.AccountClaimRequired -> onScanPairing()
                PairingOnboardingStep.ComputerAliasRequired -> onEvent(PairingOnboardingEvent.ConfirmComputerAlias)
                PairingOnboardingStep.ComputerSelect -> onEvent(PairingOnboardingEvent.TakeOverSelected)
                PairingOnboardingStep.Verifying -> Unit
                PairingOnboardingStep.Bound -> onEvent(PairingOnboardingEvent.Dismiss)
                PairingOnboardingStep.Error -> if (quotaBlocked) {
                    onEvent(PairingOnboardingEvent.Dismiss)
                    onOpenSubscription()
                } else if (scannerFailureFromWelcome) {
                    onScanPairingFromWelcome()
                } else if (scannerUnavailable) {
                    onScanPairing()
                } else if (state.requiresNewCode) {
                    onEvent(PairingOnboardingEvent.Retry)
                    if (state.temporaryPairing || state.accountHandoff) onScanPairingFromWelcome() else onScanPairing()
                } else if (state.canReplaceTemporaryClaim) {
                    onEvent(PairingOnboardingEvent.ReplaceTemporaryClaimAndRetry)
                } else {
                    onEvent(PairingOnboardingEvent.Retry)
                }
            }
        },
        onDismiss = {
            onEvent(when {
                verifying -> PairingOnboardingEvent.StopWaiting
                scannerFailureFromWelcome -> PairingOnboardingEvent.BackToWelcome
                else -> PairingOnboardingEvent.Dismiss
            })
        },
        dismissLabel = when {
            verifying -> stringResource(R.string.pairing_stop_waiting)
            state.step == PairingOnboardingStep.Bound -> stringResource(R.string.pairing_close)
            quotaBlocked -> stringResource(R.string.pairing_close)
            scannerFailureFromWelcome -> stringResource(R.string.pairing_back)
            else -> stringResource(R.string.pairing_cancel)
        },
        showConfirm = !verifying,
        showDismiss = state.step != PairingOnboardingStep.Bound,
        confirmEnabled = !verifying && (state.step != PairingOnboardingStep.ComputerSelect || state.selectedComputerIds.isNotEmpty()),
        icon = {
            if (verifying) AgentoProgress(modifier = Modifier.size(24.dp))
            else AgentoWebIcon(
                when (state.step) {
                    PairingOnboardingStep.Bound -> AgentoWebGlyph.Check
                    PairingOnboardingStep.Error -> AgentoWebGlyph.Info
                    else -> AgentoWebGlyph.Monitor
                }, null, Modifier.size(28.dp),
                when (state.step) {
                    PairingOnboardingStep.Bound -> colors.success
                    PairingOnboardingStep.Error -> colors.stateError
                    else -> colors.accentPrimary
                },
            )
        },
        content = {
            Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact)) {
                when (state.step) {
                    PairingOnboardingStep.Welcome -> Unit
                    PairingOnboardingStep.ConnectionMethods -> Unit
                    PairingOnboardingStep.GoogleRequired -> Unit
                    PairingOnboardingStep.AccountClaimRequired -> {
                        Text(stringResource(R.string.pairing_account_claim_guidance), style = MaterialTheme.typography.bodyMedium)
                    }
                    PairingOnboardingStep.ComputerAliasRequired -> {
                        Text(stringResource(R.string.pairing_computer_alias_hint), style = MaterialTheme.typography.bodyMedium)
                        AgentoTextField(
                            value = state.computerAlias,
                            onValueChange = { onEvent(PairingOnboardingEvent.ComputerAliasChanged(it)) },
                            label = stringResource(R.string.pairing_computer_alias_label),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    PairingOnboardingStep.ComputerSelect -> {
                        Text(stringResource(R.string.pairing_existing_computers), style = MaterialTheme.typography.bodyMedium)
                        Text(
                            if (state.unlimitedConnections) stringResource(R.string.pairing_connection_unlimited)
                            else stringResource(R.string.pairing_connection_limit, state.connectionPlan,
                                state.activeConnections, state.connectionLimit, state.availableSelections),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Column(verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Grid)) {
                            state.discoveredComputers.forEach { computer ->
                                val selected = computer.instanceId in state.selectedComputerIds
                                val selectable = selected || state.selectedComputerIds.size < state.availableSelections
                                AgentoListItem(
                                    title = computer.alias,
                                    supportingText = computer.connectionEndpoint ?: stringResource(R.string.pairing_secure_connection),
                                    selected = selected,
                                    onClick = if (selectable) {
                                        { onEvent(PairingOnboardingEvent.ComputerSelected(computer)) }
                                    } else null,
                                    trailing = {
                                        if (selected) {
                                            AgentoStatus(stringResource(R.string.pairing_selected), AgentoStatusTone.Success)
                                        } else if (!selectable) {
                                            AgentoStatus(stringResource(R.string.pairing_plan_limit), AgentoStatusTone.Neutral)
                                        }
                                    },
                                )
                            }
                        }
                        AgentoButton(stringResource(R.string.pairing_setup_guide_add_another), onScanPairing, secondary = true)
                    }
                    PairingOnboardingStep.Verifying -> {
                        Text(if (state.temporaryPairing) stringResource(R.string.temporary_pairing_waiting)
                            else if (state.accountHandoff) stringResource(R.string.account_pairing_waiting)
                            else stringResource(R.string.pairing_verifying),
                            style = MaterialTheme.typography.bodyMedium)
                        Text(stringResource(R.string.pairing_stop_waiting_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    PairingOnboardingStep.Bound -> {
                        Text(if (state.temporaryFullControl) stringResource(R.string.temporary_control_connected)
                            else if (state.temporaryPairing) stringResource(R.string.temporary_pairing_connected)
                            else stringResource(R.string.pairing_connected_detail),
                            style = MaterialTheme.typography.bodyMedium)
                    }
                    PairingOnboardingStep.Error -> {
                        if (!scannerUnavailable) {
                            val errorText = when {
                                state.canReplaceTemporaryClaim -> stringResource(R.string.temporary_pairing_claim_conflict)
                                state.replacementBlockedOperationCount != null -> stringResource(
                                    R.string.temporary_pairing_operations_blocked,
                                    state.replacementBlockedOperationCount,
                                )
                                state.temporaryPairingFailure != null -> when (state.temporaryPairingFailure) {
                                    TemporaryPairingFailure.PhoneQuotaExceeded -> stringResource(R.string.temporary_pairing_phone_quota)
                                    TemporaryPairingFailure.RateLimited -> stringResource(R.string.temporary_pairing_rate_limited)
                                    TemporaryPairingFailure.HostSlow -> stringResource(R.string.temporary_pairing_host_slow)
                                    TemporaryPairingFailure.HostUnavailable -> stringResource(R.string.temporary_pairing_host_unavailable)
                                }
                                state.errorMessageRes != null -> stringResource(state.errorMessageRes)
                                else -> stringResource(R.string.onboarding_generic_error_hint)
                            }
                            if (!quotaBlocked || state.errorMessageRes != null) Text(errorText,
                                style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent)
                            if (state.canReplaceTemporaryClaim) {
                                Text(stringResource(R.string.temporary_pairing_replacement_note),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            val recoveryHint =
                                if (state.temporaryPairingFailure != null) {
                                    stringResource(R.string.temporary_pairing_retry_hint)
                                } else if (quotaBlocked) {
                                    stringResource(R.string.pairing_error_quota_hint)
                                } else if (state.requiresNewCode && state.errorMessageRes == null) {
                                    stringResource(R.string.pairing_new_code_hint)
                                } else null
                            recoveryHint?.let { Text(it,
                                style = MaterialTheme.typography.bodyMedium,
                            ) }
                        } else {
                            Text(stringResource(R.string.onboarding_camera_hint),
                                style = MaterialTheme.typography.bodyMedium, color = colors.secondaryContent)
                        }
                        if (state.errorMessageRes == null && !state.errorMessage.isNullOrBlank()) {
                            OnboardingTextAction(stringResource(if (detailsOpen) R.string.onboarding_hide_details
                                else R.string.onboarding_details), { detailsOpen = !detailsOpen }, quiet = true)
                            if (detailsOpen) Text(state.errorMessage.orEmpty(),
                                style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun SettingsSurface(
    accountsViewModel: AccountsViewModel?,
    brokerEnrollmentController: BrokerEnrollmentController?,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
    onRequestComputerDiscovery: () -> Unit,
    connectingTargetId: String?,
    state: WorkbenchUiState,
    parityState: WebParityUiState,
    onParityEvent: (WebParityEvent) -> Unit,
    onEvent: (WorkbenchEvent) -> Unit,
    backProgress: Float,
    modifier: Modifier,
) {
    val pageBackProgress = if (parityState.selectedFile != null) 0f else backProgress
    val accountState = accountsViewModel?.state?.collectAsState()?.value
    val accountSessionResolved = accountsViewModel == null || accountState?.accountSessionResolved == true
    var outgoingPage by remember { mutableStateOf<SettingsPage?>(null) }
    SideEffect { if (state.settingsPage != SettingsPage.Overview) outgoingPage = state.settingsPage }
    LaunchedEffect(state.settingsPage, accountSessionResolved) {
        if (state.settingsPage == SettingsPage.ComputerManagement && accountSessionResolved) {
            onRequestComputerDiscovery()
        }
    }
    WorkbenchBackStackTransition(
        isOpen = state.settingsPage != SettingsPage.Overview,
        backProgress = pageBackProgress,
        modifier = modifier.fillMaxSize(),
        parentContent = {
            if (state.settingsParentPage == SettingsPage.ComputerConfiguration) {
                ComputerConfigurationSurface(state, brokerEnrollmentController, onEvent, Modifier.fillMaxSize())
            } else SettingsOverviewContent(
                accountsViewModel = accountsViewModel,
                brokerEnrollmentController = brokerEnrollmentController,
                onRequestGoogleSignIn = onRequestGoogleSignIn,
                state = state.copy(settingsPage = SettingsPage.Overview),
                onEvent = onEvent,
                modifier = Modifier.fillMaxSize(),
            )
        },
        childContent = {
            val page = state.settingsPage.takeUnless { it == SettingsPage.Overview } ?: outgoingPage ?: SettingsPage.Overview
            if (page == SettingsPage.ComputerConfiguration) {
                ComputerConfigurationSurface(state, brokerEnrollmentController, onEvent, Modifier.fillMaxSize())
            } else settingsPageToWebParity(page)?.let { parityPage ->
                WebParitySurface(
                    page = parityPage,
                    state = parityState,
                    onEvent = onParityEvent,
                    onBack = { onEvent(WorkbenchEvent.CloseSettingsPage) },
                    fallbackDevices = if (page == SettingsPage.ComputerManagement) {
                        state.accountComputers.ifEmpty { state.remoteTargets }.map { target ->
                            WebDevice(
                                id = target.instanceId,
                                instanceId = target.instanceId,
                                name = target.label,
                                platform = target.platform ?: "computer",
                                status = target.accessState.name,
                                revocable = false,
                            )
                        }
                    } else {
                        emptyList()
                    },
                    connectedTargetId = state.activeRemoteTargetId.takeIf {
                        state.connection == AgentConnectionStatus.Connected
                    },
                    targetConnectionStates = state.remoteTargetConnectionStates,
                    connectingTargetId = connectingTargetId ?: state.activeRemoteTargetId.takeIf {
                        state.connection == AgentConnectionStatus.Connecting ||
                            state.connection == AgentConnectionStatus.Reconnecting
                    },
                    onConnectComputer = if (page == SettingsPage.ComputerManagement) {
                        { instanceId -> onEvent(WorkbenchEvent.ConnectRemoteTarget(instanceId)) }
                    } else {
                        null
                    },
                    onDisconnectComputer = if (page == SettingsPage.ComputerManagement) {
                        { instanceId -> onEvent(WorkbenchEvent.DisconnectRemoteTarget(instanceId)) }
                    } else {
                        null
                    },
                    onAddComputer = if (page == SettingsPage.ComputerManagement) {
                        { onEvent(WorkbenchEvent.OpenPairing) }
                    } else {
                        null
                    },
                    targetId = state.activeRemoteTargetId,
                    targetLabel = state.remoteTargets.firstOrNull { it.instanceId == state.activeRemoteTargetId }?.label,
                    backProgress = backProgress,
                    connectionAvailable = page == SettingsPage.ComputerManagement || state.connection == AgentConnectionStatus.Connected,
                    modifier = Modifier.fillMaxSize(),
                )
            } ?: SettingsDetailSurface(
                page = page,
                state = state,
                accountsViewModel = accountsViewModel,
                onRequestGoogleSignIn = onRequestGoogleSignIn,
                onEvent = onEvent,
                modifier = Modifier.fillMaxSize(),
            )
        },
    )
}

@Composable
private fun SettingsOverviewContent(
    accountsViewModel: AccountsViewModel?,
    brokerEnrollmentController: BrokerEnrollmentController?,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val account = accountsViewModel?.state?.collectAsState()?.value
    val colors = LocalAgentocColors.current
    val target = state.remoteTargets.firstOrNull { it.instanceId == state.activeRemoteTargetId }
    val bottom = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding()
    LazyColumn(
        state = rememberDestinationListState("settings-overview-scroll"),
        modifier = modifier.fillMaxSize().background(colors.canvas),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp, end = 20.dp,
            top = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateTopPadding() + 16.dp,
            bottom = bottom + AgentocSizes.BottomNavigationBackdrop),
        verticalArrangement = Arrangement.spacedBy(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item {
            Text(stringResource(R.string.settings_title), color = colors.primaryContent,
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 28.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth).fillMaxWidth().padding(horizontal = 4.dp))
        }
        item(key = "account") {
            SettingsGroup(title = stringResource(R.string.settings_section_account),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                SettingsAccountHeader(accountsViewModel,
                    { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Account)) }, onRequestGoogleSignIn)
                if (account?.hasVerifiedAccountSession == true) {
                    HorizontalDivider(color = colors.primaryContent.copy(alpha = 0.06f), modifier = Modifier.padding(horizontal = 16.dp))
                    AgentoSettingRow(
                        leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.ShieldSolid) },
                        title = stringResource(R.string.settings_permission_mode),
                        subtitle = stringResource(if (account.accountPermissionPolicySaving) R.string.journey_settings_saving
                            else permissionModeLabel(account.accountPermissionPolicy?.permissionPolicy)),
                        showDivider = false, modifier = Modifier.testTag("settings-permission-mode"),
                        onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.PermissionMode)) })
                }
                if (account?.hasVerifiedAccountSession != true) {
                    AgentoSettingRow(title = stringResource(R.string.account_data_title), showDivider = false,
                        modifier = Modifier.testTag("settings-account-data"),
                        onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Account)) })
                }
            }
        }
        item(key = "computers") {
            SettingsGroup(title = stringResource(R.string.settings_group_workspace),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth).testTag("settings-list")) {
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Monitor) },
                    title = stringResource(R.string.settings_manage_devices), modifier = Modifier.testTag("settings-manage-devices"),
                    onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerManagement)) })
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Settings) },
                    title = stringResource(R.string.settings_workspace_tools),
                    subtitle = if (target != null) stringResource(R.string.settings_computer_summary, target.label,
                        stringResource(settingsConnectionLabel(state.connection)))
                        else stringResource(if (state.accountComputers.isNotEmpty() || state.remoteTargets.isNotEmpty())
                            R.string.settings_choose_computer else R.string.settings_connect_to_configure),
                    modifier = Modifier.testTag("settings-computer-configuration"),
                    onClick = {
                        if (target != null) onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerConfiguration))
                        else if (state.accountComputers.isNotEmpty() || state.remoteTargets.isNotEmpty())
                            onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerManagement))
                        else onEvent(WorkbenchEvent.OpenComputerSetup)
                    })
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Info) },
                    title = stringResource(R.string.journey_connection_help), showDivider = false,
                    modifier = Modifier.testTag("settings-connection-help"), onClick = { onEvent(WorkbenchEvent.OpenComputerSetup) })
            }
        }
        item(key = "voice-settings-entry") {
            SettingsGroup(modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                AgentoSettingRow(
                    leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Microphone) },
                    title = stringResource(R.string.settings_voice),
                    subtitle = stringResource(R.string.settings_voice_summary),
                    showDivider = false,
                    modifier = Modifier.testTag("settings-voice"),
                    onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Voice)) },
                )
            }
        }
        item(key = "models-runtime") {
            SettingsGroup(title = stringResource(R.string.settings_models_runtime),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Terminal) },
                    title = stringResource(R.string.settings_model_providers),
                    modifier = Modifier.testTag("settings-model-providers"),
                    onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ModelProviders)) })
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Settings) },
                    title = stringResource(R.string.settings_harnesses), showDivider = false,
                    modifier = Modifier.testTag("settings-harnesses"),
                    onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Harnesses)) })
            }
        }
        item(key = "preferences") {
            SettingsGroup(title = stringResource(R.string.settings_group_preferences),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                SettingsValueRow(AgentoWebGlyph.Language, stringResource(R.string.settings_language),
                    stringResource(appLanguageLabelRes(state.appLanguage)), "settings-language") {
                    onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Language))
                }
                SettingsValueRow(AgentoWebGlyph.Palette, stringResource(R.string.settings_theme),
                    stringResource(appThemeLabelRes(state.appTheme)), "settings-theme") {
                    onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Theme))
                }
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Share) },
                    title = stringResource(R.string.settings_sharing_agents), showDivider = false,
                    modifier = Modifier.testTag("settings-sharing-agents"), onClick = { onEvent(WorkbenchEvent.OpenAppApiSettings) })
            }
        }
        item(key = "support") {
            SettingsGroup(title = stringResource(R.string.settings_group_about),
                modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Report) },
                    title = stringResource(R.string.content_report_settings), modifier = Modifier.testTag("settings-content-reports"),
                    onClick = { onEvent(WorkbenchEvent.ReportAgentContent()) })
                AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Info) },
                    title = stringResource(R.string.settings_version), subtitle = state.appVersion,
                    showDivider = false, modifier = Modifier.testTag("settings-version"),
                    onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Version)) })
            }
        }
    }
}

private fun permissionModeLabel(value: String?): Int = when (value) {
    "", "full-auto" -> R.string.settings_permission_full_auto
    "approval" -> R.string.settings_permission_approval
    "conservative-auto" -> R.string.settings_permission_conservative_auto
    else -> R.string.settings_value_unknown
}

private fun settingsConnectionLabel(connection: AgentConnectionStatus): Int = when (connection) {
    AgentConnectionStatus.Connected -> R.string.settings_computer_online
    AgentConnectionStatus.Connecting, AgentConnectionStatus.Reconnecting -> R.string.settings_computer_connecting
    else -> R.string.settings_computer_offline
}

@Composable
private fun SettingsValueRow(glyph: AgentoWebGlyph, title: String, value: String, tag: String, onClick: () -> Unit) {
    val colors = LocalAgentocColors.current
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val stacked = maxWidth < 320.dp || LocalDensity.current.fontScale > 1.3f || value.length > 18
        AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(glyph) }, title = title,
            subtitle = value.takeIf { stacked }, modifier = Modifier.testTag(tag), onClick = onClick,
            trailing = if (stacked) null else ({
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(value, color = colors.secondaryContent, style = MaterialTheme.typography.bodyMedium)
                    AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, tint = colors.tertiaryContent, modifier = Modifier.size(15.dp))
                }
            }))
    }
}

@Composable
private fun ComputerConfigurationSurface(
    state: WorkbenchUiState,
    brokerEnrollmentController: BrokerEnrollmentController?,
    onEvent: (WorkbenchEvent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val target = state.remoteTargets.firstOrNull { it.instanceId == state.activeRemoteTargetId }
    var enrollmentTargetId by remember { mutableStateOf<String?>(null) }
    Column(modifier.fillMaxSize().background(colors.canvas)) {
        SettingsWebHeader(title = stringResource(R.string.settings_workspace_tools),
            onBack = { onEvent(WorkbenchEvent.CloseSettingsPage) },
            subtitle = target?.let { stringResource(R.string.settings_computer_summary, it.label, stringResource(settingsConnectionLabel(state.connection))) })
        LazyColumn(state = rememberDestinationListState("settings-computer-configuration-scroll"),
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 120.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(24.dp)) {
            if (target == null || target.accessState == RemoteTargetAccessState.Revoked) {
                item {
                    Text(stringResource(R.string.settings_computer_unavailable), color = colors.secondaryContent)
                    AgentoButton(stringResource(R.string.settings_manage_devices),
                        { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.ComputerManagement)) }, secondary = true)
                }
            } else {
                if (state.connection != AgentConnectionStatus.Connected) item {
                    Column(Modifier.widthIn(max = AgentocSizes.ContentMaxWidth).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.settings_config_offline), color = colors.secondaryContent,
                            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("settings-offline-explanation"))
                        if (state.connection != AgentConnectionStatus.Connecting && state.connection != AgentConnectionStatus.Reconnecting) {
                            AgentoButton(stringResource(R.string.settings_connect_computer),
                                { onEvent(WorkbenchEvent.ConnectRemoteTarget(target.instanceId)) }, secondary = true,
                                modifier = Modifier.widthIn(min = 168.dp, max = 224.dp))
                        }
                    }
                }
                item {
                    SettingsGroup(modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                        AgentoSettingRow(title = stringResource(R.string.settings_connectors_mcp), showDivider = false,
                            onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Connectors)) })
                    }
                }
                item {
                    SettingsGroup(title = stringResource(R.string.settings_section_operations), modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                        SettingsParityEntry(stringResource(R.string.settings_workspace_files)) { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Files)) }
                        SettingsParityEntry(stringResource(R.string.settings_scheduled_work)) { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Triggers)) }
                        AgentoSettingRow(title = stringResource(R.string.settings_usage), showDivider = false,
                            onClick = { onEvent(WorkbenchEvent.OpenSettingsPage(SettingsPage.Usage)) })
                    }
                }
                if (target.platform.equals("windows", ignoreCase = true) && brokerEnrollmentController != null) item {
                    SettingsGroup(modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                        AgentoSettingRow(leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.ShieldSolid) },
                            title = stringResource(R.string.windows_broker_enrollment_title),
                            subtitle = stringResource(R.string.windows_broker_enrollment_subtitle), showDivider = false,
                            modifier = Modifier.testTag("windows-broker-enrollment"), onClick = { enrollmentTargetId = target.instanceId })
                    }
                }
            }
        }
    }
    enrollmentTargetId?.let { id ->
        if (brokerEnrollmentController != null) BrokerPhoneEnrollmentDialog(id, brokerEnrollmentController) { enrollmentTargetId = null }
    }
}

@Composable
private fun BrokerPhoneEnrollmentDialog(
    targetInstanceId: String,
    controller: BrokerEnrollmentController,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var enrollment by remember(targetInstanceId) { mutableStateOf<BrokerPendingEnrollment?>(null) }
    var material by remember(targetInstanceId) { mutableStateOf<BrokerEnrollmentMaterial?>(null) }
    var loading by remember(targetInstanceId) { mutableStateOf(true) }
    var completing by remember(targetInstanceId) { mutableStateOf(false) }
    var completed by remember(targetInstanceId) { mutableStateOf(false) }
    var confirmationCode by remember(targetInstanceId) { mutableStateOf("") }
    var fingerprintConfirmed by remember(targetInstanceId) { mutableStateOf(false) }
    var error by remember(targetInstanceId) { mutableStateOf<String?>(null) }

    suspend fun refreshChallenge() {
        loading = true
        error = null
        confirmationCode = ""
        fingerprintConfirmed = false
        runCatching {
            material = controller.enrollmentMaterial()
            controller.enrollmentChallenge(targetInstanceId)
        }.onSuccess { enrollment = it }
            .onFailure {
                enrollment = null
                error = it.message
            }
        loading = false
    }

    androidx.compose.runtime.LaunchedEffect(targetInstanceId) { refreshChallenge() }

    com.andysagent.agentoc.core.designsystem.AgentoAlertDialog(
        onDismissRequest = { if (!completing) onDismiss() },
        title = { Text(stringResource(R.string.windows_broker_enrollment_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (loading) {
                    androidx.compose.material3.CircularProgressIndicator()
                } else if (completed) {
                    Text(stringResource(R.string.windows_broker_enrollment_complete))
                } else if (enrollment != null) {
                    Text(stringResource(R.string.windows_broker_enrollment_compare_instructions))
                    Text(
                        enrollment!!.challenge.verificationCode,
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    Text(
                        stringResource(
                            R.string.windows_broker_enrollment_fingerprint,
                            BrokerApprovalProtocol.fingerprint(enrollment!!.brokerPublicKey),
                        ),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.Checkbox(
                            checked = fingerprintConfirmed,
                            onCheckedChange = { fingerprintConfirmed = it },
                        )
                        Text(stringResource(R.string.windows_broker_enrollment_fingerprint_confirm))
                    }
                    androidx.compose.material3.OutlinedTextField(
                        value = confirmationCode,
                        onValueChange = { value ->
                            confirmationCode = value.filter(Char::isDigit).take(8)
                        },
                        label = { Text(stringResource(R.string.windows_broker_enrollment_enter_code)) },
                        singleLine = true,
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Number,
                        ),
                    )
                } else {
                    Text(stringResource(R.string.windows_broker_enrollment_start_admin))
                    material?.let { value ->
                        Text(stringResource(R.string.windows_broker_enrollment_device_id, value.deviceId))
                        Text(stringResource(R.string.windows_broker_enrollment_public_key))
                        val context = LocalContext.current
                        androidx.compose.material3.TextButton(
                            onClick = {
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE)
                                    as android.content.ClipboardManager
                                clipboard.setPrimaryClip(
                                    android.content.ClipData.newPlainText(
                                        "Ragent Broker device public key",
                                        value.publicKeyBase64,
                                    ),
                                )
                            },
                            colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary),
                        ) {
                            Text(stringResource(R.string.windows_broker_enrollment_copy_key))
                        }
                        androidx.compose.foundation.text.selection.SelectionContainer {
                            Text(value.publicKeyBase64, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            if (enrollment != null && !completed) {
                androidx.compose.material3.TextButton(
                    enabled = !completing && fingerprintConfirmed &&
                        confirmationCode == enrollment!!.challenge.verificationCode,
                    onClick = {
                        val current = enrollment ?: return@TextButton
                        completing = true
                        scope.launch {
                            runCatching {
                                controller.completeEnrollment(
                                    targetInstanceId,
                                    current.challenge.enrollmentId,
                                    confirmationCode,
                                )
                            }.onSuccess { completed = true }
                                .onFailure { error = it.message }
                            completing = false
                        }
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary),
                ) {
                    Text(if (completing) stringResource(R.string.windows_broker_enrollment_registering)
                        else stringResource(R.string.windows_broker_enrollment_confirm))
                }
            } else {
                androidx.compose.material3.TextButton(onClick = onDismiss, colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary)) {
                    Text(stringResource(R.string.windows_broker_enrollment_close))
                }
            }
        },
        dismissButton = {
            if (enrollment == null && !loading && !completed) {
                androidx.compose.material3.TextButton(onClick = { scope.launch { refreshChallenge() } }, colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary)) {
                    Text(stringResource(R.string.windows_broker_enrollment_refresh))
                }
            } else if (enrollment != null && !completed) {
                androidx.compose.material3.TextButton(onClick = { scope.launch { refreshChallenge() } }, colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary)) {
                    Text(stringResource(R.string.windows_broker_enrollment_refresh))
                }
            }
        },
    )
}

@Composable
private fun AccountPermissionPolicyEntry(
    accountState: com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountUiState?,
    onClick: () -> Unit,
) {
    val saving = accountState?.accountPermissionPolicySaving == true
    SettingsGroup(
        modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
    ) {
        AgentoSettingRow(
            icon = AgentoWebGlyph.Settings,
            title = stringResource(R.string.settings_permission_mode),
            enabled = !saving,
            showDivider = false,
            onClick = onClick,
        )
    }
}

@Composable
private fun AccountPermissionPolicySettings(
    accountState: com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountUiState?,
    connected: Boolean,
    onSelect: (String) -> Unit,
) {
    if (LocalRestrictedDemoEnvironment.current) {
        Text(stringResource(R.string.demo_environment_limits), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
        return
    }
    val policy = accountState?.accountPermissionPolicy?.permissionPolicy
    val saving = accountState?.accountPermissionPolicySaving == true
    val loaded = policy != null
    val policyEnabled = loaded && !saving && connected
    val colors = LocalAgentocColors.current
    val options = listOf(
        "full-auto" to R.string.settings_permission_full_auto,
        "approval" to R.string.settings_permission_approval,
        "conservative-auto" to R.string.settings_permission_conservative_auto,
    )

    Column(
        modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
    ) {
        Text(stringResource(R.string.settings_policy_scope), color = colors.secondaryContent,
            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 16.dp))
        if (!connected || !loaded || saving) {
            Text(stringResource(if (!connected) R.string.settings_config_offline
                else if (saving) R.string.journey_settings_saving else R.string.settings_value_unknown),
                color = colors.secondaryContent, style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(bottom = 12.dp))
        }
        accountState?.errorMessage?.let {
            Text(stringResource(R.string.settings_policy_save_error), color = colors.stateError,
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
        }
        SettingsGroup {
            options.forEachIndexed { index, (value, titleRes) ->
                val selected = policy == value || (policy == "" && value == "full-auto")
                AgentoSettingRow(
                    leadingIcon = {
                        RadioButton(
                            selected = selected,
                            onClick = null,
                            enabled = policyEnabled,
                            colors = RadioButtonDefaults.colors(
                                selectedColor = colors.accentPrimary,
                                unselectedColor = colors.tertiaryContent,
                            ),
                        )
                    },
                    title = stringResource(titleRes),
                    subtitle = stringResource(when (value) {
                        "approval" -> R.string.settings_policy_approval_hint
                        "conservative-auto" -> R.string.settings_policy_guarded_hint
                        else -> R.string.settings_policy_auto_hint
                    }),
                    modifier = Modifier.testTag("account-permission-policy-${value.ifEmpty { "default" }}").semantics {
                        if (!policyEnabled) disabled()
                    },
                    enabled = policyEnabled,
                    showDivider = index < options.lastIndex,
                    onClick = { onSelect(value) },
                )
            }
        }
        Text(
            text = stringResource(R.string.settings_permission_support_note),
            style = MaterialTheme.typography.bodySmall,
            color = colors.secondaryContent,
            modifier = Modifier.padding(top = AgentocSpacing.Compact),
        )
    }
}

@Composable
private fun SettingsDetailSurface(
    page: SettingsPage,
    state: WorkbenchUiState,
    accountsViewModel: AccountsViewModel?,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
    onEvent: (WorkbenchEvent) -> Unit,
    modifier: Modifier,
) {
    val accountState = accountsViewModel?.state?.collectAsState()?.value
    val title = when (page) {
        SettingsPage.Account -> stringResource(R.string.account_data_title)
        SettingsPage.PermissionMode -> stringResource(R.string.settings_permission_mode)
        SettingsPage.Language -> stringResource(R.string.settings_language)
        SettingsPage.Theme -> stringResource(R.string.settings_theme)
        SettingsPage.ComputerManagement -> stringResource(R.string.settings_manage_devices)
        SettingsPage.Voice -> stringResource(R.string.settings_voice)
        SettingsPage.Version -> stringResource(R.string.settings_version)
        else -> return
    }
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
    ) {
        Column(Modifier.fillMaxSize()) {
            SettingsWebHeader(onBack = { onEvent(WorkbenchEvent.CloseSettingsPage) }, title = title)
            val navBottom = com.andysagent.agentoc.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding()
            LazyColumn(
                state = rememberDestinationListState("settings-${page.name}-scroll"),
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(
                    start = 20.dp,
                    end = 20.dp,
                    top = AgentocSpacing.Compact,
                    bottom = navBottom + 90.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                when (page) {
                    SettingsPage.Voice -> {
                        item(key = "voice-computer-settings") {
                            SettingsGroup(
                                title = stringResource(R.string.voice_computers_section),
                                modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
                            ) {
                                if (state.voice.computers.isEmpty()) {
                                    Text(
                                        text = stringResource(R.string.voice_no_computers),
                                        color = colors.secondaryContent,
                                        style = MaterialTheme.typography.bodyMedium,
                                        modifier = Modifier.padding(16.dp),
                                    )
                                } else state.voice.computers.forEachIndexed { index, computer ->
                                    val statusText = when {
                                        computer.error != null -> computer.error
                                        !computer.connected -> stringResource(R.string.voice_computer_offline)
                                        !computer.installed && !computer.installable -> stringResource(R.string.voice_computer_install_unavailable)
                                        !computer.installed -> stringResource(R.string.voice_computer_not_installed)
                                        !computer.enabled -> stringResource(R.string.voice_computer_disabled)
                                        !computer.ready -> stringResource(R.string.voice_computer_starting)
                                        else -> stringResource(R.string.voice_computer_ready)
                                    }
                                    AgentoSettingRow(
                                        leadingIcon = { SettingsOverviewIcon(AgentoWebGlyph.Monitor) },
                                        title = computer.label,
                                        subtitle = statusText,
                                        trailing = {
                                            if (!computer.installed && computer.installable) {
                                                AgentoButton(
                                                    text = stringResource(if (computer.busy) R.string.voice_installing else R.string.voice_install),
                                                    onClick = { onEvent(WorkbenchEvent.InstallComputerVoice(computer.targetId)) },
                                                    enabled = computer.connected && !computer.busy,
                                                    secondary = true,
                                                    modifier = Modifier.testTag("voice-install-${computer.targetId}"),
                                                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
                                                )
                                            } else if (computer.installed) {
                                                AgentoSwitch(
                                                    checked = computer.enabled,
                                                    onCheckedChange = { enabled ->
                                                        onEvent(WorkbenchEvent.SetComputerVoiceEnabled(computer.targetId, enabled))
                                                    },
                                                    enabled = computer.connected && !computer.busy,
                                                    modifier = Modifier.testTag("voice-computer-switch-${computer.targetId}"),
                                                )
                                            }
                                        },
                                        showDivider = index < state.voice.computers.lastIndex,
                                    )
                                }
                            }
                        }
                        item(key = "voice-privacy-note") {
                            Text(
                                text = stringResource(R.string.voice_privacy_note),
                                color = colors.secondaryContent,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth).padding(horizontal = 8.dp),
                            )
                        }
                    }
                    SettingsPage.Account -> {
                        item(key = "google-account-management") {
                            SettingsGoogleAccountManagement(
                                accountsViewModel = accountsViewModel,
                                onRequestGoogleSignIn = onRequestGoogleSignIn,
                            )
                        }
                        if (accountState?.hasVerifiedAccountSession != true) item(key = "account-data-requests") {
                            SettingsGroup(modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth)) {
                                Box(Modifier.padding(16.dp)) { AccountDataRequests(showTitle = false) }
                            }
                        }
                    }
                    SettingsPage.PermissionMode -> {
                        item(key = "account-permission-mode") {
                            AccountPermissionPolicySettings(
                                accountState = accountsViewModel?.state?.collectAsState()?.value,
                                connected = state.connection == AgentConnectionStatus.Connected,
                                onSelect = { accountsViewModel?.onEvent(AccountsEvent.SetAccountPermissionPolicy(it)) },
                            )
                        }
                    }
                    SettingsPage.Theme -> {
                        item(key = "theme_group") {
                            val monetAvailable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                            SettingsGroup(
                                modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
                            ) {
                                val themes = listOf(
                                    AppTheme.System to R.string.theme_system,
                                    AppTheme.Dark to R.string.theme_dark,
                                    AppTheme.Light to R.string.theme_light,
                                    AppTheme.Oled to R.string.theme_oled,
                                    AppTheme.Amber to R.string.theme_amber,
                                    AppTheme.Monet to R.string.theme_monet,
                                )
                                Column(Modifier.selectableGroup().padding(vertical = 6.dp)) {
                                    themes.forEach { (theme, titleRes) ->
                                        val isEnabled = theme != AppTheme.Monet || monetAvailable
                                        SettingsChoiceRow(
                                            title = stringResource(titleRes),
                                            subtitle = if (!isEnabled) stringResource(R.string.theme_monet_unavailable)
                                                else when (theme) {
                                                    AppTheme.Oled -> stringResource(R.string.settings_theme_black_hint)
                                                    AppTheme.Amber -> stringResource(R.string.settings_theme_amber_hint)
                                                    AppTheme.Monet -> stringResource(R.string.settings_theme_dynamic_hint)
                                                    else -> null
                                                },
                                            leading = { SettingsThemeSwatch(theme) },
                                            selected = state.appTheme == theme,
                                            enabled = isEnabled,
                                            modifier = Modifier.testTag("settings-theme-${theme.name.lowercase()}"),
                                            onClick = { onEvent(WorkbenchEvent.SelectTheme(theme)) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                    SettingsPage.Language -> {
                        item(key = "language_group") {
                            SettingsGroup(
                                modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
                            ) {
                                val languages = listOf(
                                    AppLanguage.System to R.string.language_system_title,
                                    AppLanguage.SimplifiedChinese to R.string.language_simplified_chinese_title,
                                    AppLanguage.TraditionalChinese to R.string.language_traditional_chinese_title,
                                    AppLanguage.English to R.string.language_english_title,
                                    AppLanguage.Japanese to R.string.language_japanese_title,
                                    AppLanguage.Korean to R.string.language_korean_title,
                                    AppLanguage.French to R.string.language_french_title,
                                    AppLanguage.Spanish to R.string.language_spanish_title,
                                )
                                Column(Modifier.selectableGroup().padding(vertical = 6.dp)) {
                                    languages.forEach { (language, titleRes) ->
                                        SettingsChoiceRow(
                                            title = stringResource(titleRes),
                                            selected = state.appLanguage == language,
                                            modifier = Modifier.testTag("settings-language-${language.name.lowercase()}"),
                                            onClick = { onEvent(WorkbenchEvent.SelectLanguage(language)) },
                                        )
                                    }
                                }
                            }
                        }
                    }
                    SettingsPage.Version -> {
                        item(key = "version-summary") {
                            SettingsGroup(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .widthIn(max = AgentocSizes.ContentMaxWidth)
                                    .testTag("settings-version-summary"),
                            ) {
                                AgentoSettingRow(
                                    title = stringResource(R.string.settings_app_version),
                                    subtitle = state.appVersion,
                                    showDivider = true,
                                )
                                AgentoSettingRow(
                                    title = stringResource(R.string.settings_build),
                                    subtitle = state.appBuild,
                                    showDivider = true,
                                )
                                AgentoSettingRow(
                                    title = stringResource(R.string.settings_android),
                                    subtitle = "SDK ${Build.VERSION.SDK_INT} (${Build.VERSION.RELEASE.orEmpty()})",
                                    showDivider = false,
                                )
                            }
                        }
                    }
                    else -> Unit
                }
            }
        }
    }
}

private fun settingsPageToWebParity(page: SettingsPage): WebParityPage? = when (page) {
    SettingsPage.Connectors -> WebParityPage.Connectors
    SettingsPage.ModelProviders -> WebParityPage.ModelProviders
    SettingsPage.Harnesses -> WebParityPage.Harnesses
    SettingsPage.ComputerManagement -> WebParityPage.Devices
    SettingsPage.Files -> WebParityPage.Files
    SettingsPage.Triggers -> WebParityPage.Triggers
    SettingsPage.Usage -> WebParityPage.Usage
    else -> null
}

private fun appLanguageLabelRes(language: AppLanguage): Int = when (language) {
    AppLanguage.System -> R.string.language_label_system
    AppLanguage.SimplifiedChinese -> R.string.language_label_simplified_chinese
    AppLanguage.TraditionalChinese -> R.string.language_label_traditional_chinese
    AppLanguage.English -> R.string.language_label_english
    AppLanguage.Japanese -> R.string.language_label_japanese
    AppLanguage.Korean -> R.string.language_label_korean
    AppLanguage.French -> R.string.language_label_french
    AppLanguage.Spanish -> R.string.language_label_spanish
}

private fun effectiveAppLanguage(language: AppLanguage, systemLocale: java.util.Locale): AppLanguage {
    if (language != AppLanguage.System) return language
    return when (systemLocale.language.lowercase(java.util.Locale.ROOT)) {
        "zh" -> when (systemLocale.country.uppercase(java.util.Locale.ROOT)) {
            "TW", "HK", "MO" -> AppLanguage.TraditionalChinese
            else -> AppLanguage.SimplifiedChinese
        }
        "ja" -> AppLanguage.Japanese
        "ko" -> AppLanguage.Korean
        "fr" -> AppLanguage.French
        "es" -> AppLanguage.Spanish
        else -> AppLanguage.English
    }
}

@Composable
private fun AppLanguageFlag(language: AppLanguage) {
    val glyph = when (language) {
        AppLanguage.SimplifiedChinese -> "简"
        AppLanguage.TraditionalChinese -> "繁"
        AppLanguage.English, AppLanguage.System -> "En"
        AppLanguage.Japanese -> "日"
        AppLanguage.Korean -> "한"
        AppLanguage.French -> "Fr"
        AppLanguage.Spanish -> "Es"
    }
    Text(
        text = glyph,
        modifier = Modifier.size(width = 30.dp, height = 22.dp),
        color = LocalAgentocColors.current.textPrimary,
        fontFamily = FontFamily.SansSerif,
        fontSize = 16.sp,
        fontWeight = FontWeight.Medium,
        textAlign = TextAlign.Center,
        lineHeight = 20.sp,
    )
}

private fun appThemeLabelRes(theme: AppTheme): Int = when (theme) {
    AppTheme.System -> R.string.theme_system
    AppTheme.Dark -> R.string.theme_dark
    AppTheme.Light -> R.string.theme_light
    AppTheme.Oled -> R.string.theme_oled
    AppTheme.Amber -> R.string.theme_amber
    AppTheme.Monet -> R.string.theme_monet
}

@Composable
private fun SettingsParityEntry(
    title: String,
    contentHorizontalPadding: Dp = 18.dp,
    onClick: () -> Unit,
) {
    AgentoSettingRow(
        title = title,
        contentHorizontalPadding = contentHorizontalPadding,
        onClick = onClick,
    )
}

@Composable
private fun RemoteTargetRow(
    target: RemoteTarget,
    selected: Boolean,
    connection: AgentConnectionStatus?,
    onClick: () -> Unit,
    showDivider: Boolean,
) {
    val (status, tone) = when {
        selected && connection == AgentConnectionStatus.Connected -> "Connected" to AgentoStatusTone.Success
        selected && connection == AgentConnectionStatus.Connecting -> "Connecting" to AgentoStatusTone.Running
        selected && connection == AgentConnectionStatus.AuthenticationRequired -> "Needs sign-in" to AgentoStatusTone.Warning
        selected -> "Offline" to AgentoStatusTone.Neutral
        target.accessState == RemoteTargetAccessState.Revoked -> "Revoked" to AgentoStatusTone.Error
        target.accessState == RemoteTargetAccessState.NeedsPairing -> "Needs pairing" to AgentoStatusTone.Warning
        target.accessState == RemoteTargetAccessState.Offline -> "Offline" to AgentoStatusTone.Neutral
        else -> "Available" to AgentoStatusTone.Neutral
    }
    AgentoSettingRow(
        icon = AgentoWebGlyph.Monitor,
        title = target.label,
        subtitle = listOfNotNull(target.platform, target.endpoint).joinToString(" · "),
        showDivider = showDivider,
        trailing = { AgentoStatus(if (selected) "Selected · $status" else status, tone) },
        onClick = onClick,
    )
}

@Composable
internal fun SettingsWebHeader(
    onBack: (() -> Unit)? = null,
    title: String? = null,
    subtitle: String? = null,
    backDescription: String? = null,
    backTag: String = "settings-back",
    onRefresh: (() -> Unit)? = null,
    refreshDescription: String? = null,
    refreshing: Boolean = false,
) {
    val resolvedTitle = title ?: stringResource(R.string.settings_title)
    Box(Modifier.fillMaxWidth().statusBarsPadding(), contentAlignment = Alignment.Center) {
        com.andysagent.agentoc.core.designsystem.AgentoSettingsHeader(
            title = resolvedTitle,
            onBack = onBack,
            backDescription = backDescription ?: stringResource(R.string.settings_back),
            backModifier = Modifier.testTag(backTag),
            subtitle = subtitle,
            onRefresh = onRefresh,
            refreshDescription = refreshDescription ?: resolvedTitle,
            refreshing = refreshing,
            modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
        )
    }
}

@Composable
private fun SettingsGroup(
    modifier: Modifier = Modifier,
    title: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalAgentocColors.current
    Column(modifier.fillMaxWidth()) {
        if (title != null) {
            Text(title, style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium, color = colors.secondaryContent),
                modifier = Modifier.padding(start = 16.dp, bottom = 8.dp))
        }
        Surface(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp),
            color = colors.quietSurface, contentColor = colors.primaryContent) {
            Column(Modifier.fillMaxWidth(), content = content)
        }
        if (footer != null) {
            Text(
                text = footer,
                style = TextStyle(
                    fontSize = 12.sp,
                    color = colors.secondaryContent,
                ),
                modifier = Modifier.padding(start = 16.dp, top = 6.dp),
            )
        }
    }
}

@Composable
private fun SettingsChoiceRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val colors = LocalAgentocColors.current
    val source = remember { MutableInteractionSource() }
    val isDark = colors.canvas.red < 0.5f
    val accent = colors.accentPrimary
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 2.dp)
            .alpha(if (enabled) 1f else 0.52f)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton,
                interactionSource = source, indication = null, onClick = onClick)
            .agentoPressScale(pressedScale = 0.985f, interactionSource = source)
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) accent.copy(alpha = if (isDark) 0.15f else 0.08f) else Color.Transparent)
            .heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        leading?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, color = colors.primaryContent,
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp,
                    fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal))
            subtitle?.let { Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall) }
        }
        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
            if (selected) {
                AgentoWebIcon(AgentoWebGlyph.Check, contentDescription = stringResource(R.string.settings_active),
                    modifier = Modifier.size(19.dp), tint = accent)
            }
        }
    }
}

@Composable
private fun SettingsThemeSwatch(theme: AppTheme) {
    val colors = LocalAgentocColors.current
    val dark = theme == AppTheme.Dark || theme == AppTheme.Oled || theme == AppTheme.Amber
    val background = when (theme) {
        AppTheme.Oled -> Color.Black
        AppTheme.Dark -> Color(0xFF17171B)
        AppTheme.Amber -> Color(0xFF231D13)
        AppTheme.System, AppTheme.Monet -> colors.canvas
        else -> Color(0xFFF1F1F6)
    }
    val accent = if (theme == AppTheme.Amber) Color(0xFFE4B462) else colors.accentPrimary
    Column(Modifier.size(width = 40.dp, height = 28.dp).clip(RoundedCornerShape(6.dp))
        .background(background).padding(5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(Modifier.width(20.dp).height(3.dp).background(if (background.red < 0.5f) Color.White.copy(alpha = 0.7f) else Color.Black.copy(alpha = 0.45f), CircleShape))
        Box(Modifier.width(13.dp).height(3.dp).background(accent, CircleShape))
        Box(Modifier.width(24.dp).height(3.dp).background(accent.copy(alpha = 0.25f), CircleShape))
    }
}

@Composable
private fun SettingsOverviewIcon(glyph: AgentoWebGlyph) {
    AgentoWebIcon(glyph, contentDescription = null, tint = LocalAgentocColors.current.accentPrimary,
        modifier = Modifier.size(21.dp))
}

@Composable
private fun SettingsAccountHeader(
    accountsViewModel: AccountsViewModel?,
    onOpenAccountManagement: () -> Unit,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
) {
    val colors = LocalAgentocColors.current
    val accountState by accountsViewModel?.state?.collectAsState() ?: remember {
        mutableStateOf(com.andysagent.agentoc.feature.workbench.accounts.GoogleAccountUiState())
    }
    LaunchedEffect(accountsViewModel) {
        accountsViewModel?.onEvent(AccountsEvent.Refresh)
    }
    val signedIn = accountState.hasVerifiedAccountSession
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .widthIn(max = AgentocSizes.ContentMaxWidth)
            .padding(vertical = 2.dp),
    ) {
        if (signedIn) {
            // Account is a quiet identity/status line instead of a profile
            // hero card. This prevents Settings from competing with the
            // navigation dock or imitating an unrelated mobile settings app.
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .agentoPressScale(pressedScale = 0.985f, onClick = onOpenAccountManagement)
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                GoogleAccountAvatar(accountState.accountProfile, size = 40.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                    Text(
                        text = accountState.accountProfile?.displayName?.ifBlank {
                            stringResource(R.string.settings_google_account)
                        } ?: stringResource(R.string.settings_google_account),
                        style = MaterialTheme.typography.titleMedium.copy(fontSize = 16.sp, lineHeight = 20.sp),
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    accountState.accountProfile?.email?.let { email ->
                        if (email.isNotBlank()) {
                            Text(
                                text = email,
                                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                                color = colors.secondaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronRight,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = colors.tertiaryContent,
                )
            }
        }
        if (!signedIn) {
            if (accountState.status == GoogleAccountStatus.Checking && accountsViewModel != null) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentoProgress(modifier = Modifier.size(20.dp))
                    Text(stringResource(R.string.settings_account_checking), color = colors.secondaryContent)
                }
            } else if (accountState.status == GoogleAccountStatus.VerificationUnavailable) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(R.string.settings_account_unverified), color = colors.secondaryContent)
                    AgentoButton(stringResource(R.string.settings_retry_account_check),
                        { accountsViewModel?.onEvent(AccountsEvent.Refresh) }, secondary = true,
                        modifier = Modifier.widthIn(min = 168.dp, max = 224.dp))
                }
            } else {
                AgentoSettingRow(leadingIcon = { GoogleBrandIcon() }, title = stringResource(R.string.settings_google_account),
                    subtitle = stringResource(R.string.settings_sign_in), showDivider = false,
                    onClick = { onRequestGoogleSignIn(GoogleSignInRequest.Account) })
            }
        }
        accountState.errorMessage?.let { AgentoErrorText(it) }
    }
}

@Composable
private fun SettingsGoogleAccountManagement(
    accountsViewModel: AccountsViewModel?,
    onRequestGoogleSignIn: (GoogleSignInRequest) -> Unit,
) {
    if (accountsViewModel == null) return
    val accountsState by accountsViewModel.state.collectAsState()
    LaunchedEffect(accountsViewModel) {
        accountsViewModel.onEvent(AccountsEvent.Refresh)
    }
    var confirmSignOut by rememberDestinationFlag("settings-confirm-sign-out")
    val profile = accountsState.accountProfile
    SettingsGroup(
        modifier = Modifier.fillMaxWidth().widthIn(max = AgentocSizes.ContentMaxWidth),
    ) {
        if (accountsState.hasVerifiedAccountSession) {
            Row(
                Modifier.fillMaxWidth().padding(AgentocSpacing.Standard),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard),
            ) {
                GoogleAccountAvatar(profile, size = 48.dp)
                Column(Modifier.weight(1f)) {
                    Text(
                        profile?.displayName ?: stringResource(R.string.settings_google_account),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    profile?.email?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colorsForSettings().secondaryContent) }
                }
            }
            Box(Modifier.padding(horizontal = 16.dp)) { AccountDataRequests(showTitle = false) }
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                AgentoButton(
                    text = stringResource(R.string.settings_sign_out_phone),
                    onClick = { confirmSignOut = true },
                    modifier = Modifier.widthIn(min = 200.dp, max = 280.dp),
                    secondary = true,
                    secondaryContainerColor = LocalAgentocColors.current.canvas,
                    labelMaxLines = 2,
                )
            }
        } else if (accountsState.status == GoogleAccountStatus.Checking) {
            Box(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard)) {
                AgentoProgress(modifier = Modifier.size(AgentocSizes.Icon))
            }
        } else if (accountsState.status == GoogleAccountStatus.VerificationUnavailable) {
            Box(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard)) {
                AgentoButton(
                    text = stringResource(R.string.settings_retry_account_check),
                    onClick = { accountsViewModel.onEvent(AccountsEvent.Refresh) },
                    modifier = Modifier.widthIn(min = 200.dp, max = 280.dp),
                    secondary = true,
                )
            }
        } else {
            Box(Modifier.fillMaxWidth().padding(AgentocSpacing.Standard)) {
                AgentoButton(
                    text = stringResource(R.string.settings_sign_in),
                    onClick = { onRequestGoogleSignIn(GoogleSignInRequest.Account) },
                    modifier = Modifier.widthIn(min = 200.dp, max = 280.dp),
                    leadingIcon = { GoogleBrandIcon() },
                )
            }
        }
        accountsState.errorMessage?.let { AgentoErrorText(it, Modifier.padding(AgentocSpacing.Standard)) }
    }
    if (confirmSignOut) {
        AgentoDialog(
            title = stringResource(R.string.settings_sign_out_phone_title),
            confirmLabel = stringResource(R.string.settings_sign_out),
            destructive = true,
            dismissLabel = stringResource(R.string.settings_cancel),
            onConfirm = {
                confirmSignOut = false
                accountsViewModel.onEvent(AccountsEvent.Unbind)
            },
            onDismiss = { confirmSignOut = false },
        ) {
            Text(stringResource(R.string.settings_sign_out_phone_detail))
        }
    }
}

@Composable
private fun colorsForSettings() = LocalAgentocColors.current

private fun com.andysagent.agentoc.core.timeline.TimelineOperationKind.toAgentKind(): AgentOperationKind = when (this) {
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.Command -> AgentOperationKind.Command
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.FileEdit -> AgentOperationKind.FileEdit
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.Diff -> AgentOperationKind.Diff
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.Tool -> AgentOperationKind.Tool
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.SubAgent -> AgentOperationKind.SubAgent
    com.andysagent.agentoc.core.timeline.TimelineOperationKind.Unknown -> AgentOperationKind.Unknown
}

private fun com.andysagent.agentoc.core.timeline.TimelineOperationStatus.toAgentStatus(): AgentOperationStatus = when (this) {
    com.andysagent.agentoc.core.timeline.TimelineOperationStatus.Pending -> AgentOperationStatus.Pending
    com.andysagent.agentoc.core.timeline.TimelineOperationStatus.InProgress -> AgentOperationStatus.InProgress
    com.andysagent.agentoc.core.timeline.TimelineOperationStatus.Completed -> AgentOperationStatus.Completed
    com.andysagent.agentoc.core.timeline.TimelineOperationStatus.Failed -> AgentOperationStatus.Failed
}

private fun PreviewAccountsViewModel(): AccountsViewModel = AccountsViewModel(object : AccountsRepository {
    override suspend fun getGoogleAccountStatus(): GoogleAccountStatusResult =
        GoogleAccountStatusResult(enabled = true, bound = false, mode = "accounts")

    override suspend fun submitGoogleIdToken(idToken: String, alias: String?): GoogleTokenSubmitResult =
        GoogleTokenSubmitResult(bound = false, mode = "legacy")
})

@androidx.compose.ui.tooling.preview.Preview(showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun WorkbenchScreenPreview() {
    com.andysagent.agentoc.core.designsystem.AgentocTheme {
        WorkbenchScreen(WorkbenchUiState(), accountsViewModel = PreviewAccountsViewModel())
    }
}

@androidx.compose.ui.tooling.preview.Preview(showBackground = true, widthDp = 1024, heightDp = 768)
@Composable
private fun WorkbenchExpandedPreview() {
    com.andysagent.agentoc.core.designsystem.AgentocTheme {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Home),
            accountsViewModel = PreviewAccountsViewModel(),
        )
    }
}
