package com.andysagent.agentoc.feature.workbench

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.Immutable
import com.andysagent.agentoc.core.agentui.AgentConnectionStatus
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.agentui.ComposerRuntimeIdentity
import com.andysagent.agentoc.core.agentui.composerRuntimeIdentity
import com.andysagent.agentoc.core.agentui.ApprovalActionUiState
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.domain.RefreshResult
import com.andysagent.agentoc.core.domain.ApprovalResolutionCoordinator
import com.andysagent.agentoc.core.domain.OutboundAttachment
import com.andysagent.agentoc.core.domain.ProjectFolder
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.SessionRepositoryException
import com.andysagent.agentoc.core.domain.SwitchingSessionRepository
import com.andysagent.agentoc.core.domain.newRequestId
import com.andysagent.agentoc.core.protocol.WebAuthnProofDto
import com.andysagent.agentoc.core.protocol.TargetSummary
import com.andysagent.agentoc.core.model.AppLanguage
import com.andysagent.agentoc.core.model.AppTheme
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.OtherDeviceProject
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.QueuedMessage
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.RuntimeModelOption
import com.andysagent.agentoc.core.domain.RuntimeSelection
import com.andysagent.agentoc.core.model.RemoteTarget
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.navigation.AgentoDestination
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import com.andysagent.agentoc.core.timeline.TimelineRole
import com.andysagent.agentoc.core.timeline.RunActionFormatter
import com.andysagent.agentoc.core.timeline.RunActionUiState
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val ARTIFACT_PARSE_OFFLOAD_ITEM_COUNT = 24
private const val ARTIFACT_PARSE_OFFLOAD_TEXT_LENGTH = 12_000

/** Pure render aggregate used by previews and the current Workbench composable. */
@Immutable
data class WorkbenchUiState(
    val stopRequest: StopRequestState = StopRequestState.None,
    val destination: AgentoDestination = AgentoDestination.Home,
    val settingsPage: SettingsPage = SettingsPage.Overview,
    val settingsParentPage: SettingsPage = SettingsPage.Overview,
    val chatOpen: Boolean = false,
    val agentOpen: Boolean = false,
    val sessionSearchQuery: String = "",
    val connection: AgentConnectionStatus = AgentConnectionStatus.Disconnected,
    /** In a split view the visible conversation can belong to another computer. */
    val chatConnection: AgentConnectionStatus? = null,
    val chatTargetId: String? = null,
    val runStatus: AgentRunStatus = AgentRunStatus.Idle,
    val currentAction: RunActionUiState? = null,
    val serverRunActivity: JsonObject? = null,
    val sessionTitle: String = "New session",
    val timelineItems: List<TimelineItem> = emptyList(),
    val pendingTurn: PendingTurnUiState? = null,
    val acceptedTurns: List<PendingTurnUiState> = emptyList(),
    val composerText: String = "",
    val messageCount: Int = 0,
    val unseenCount: Int = 0,
    val sessionId: String? = null,
    /** True while the selected session's durable timeline is being replaced. */
    val historyLoading: Boolean = false,
    /** Session id that owns the currently rendered timeline. */
    val timelineSessionId: String? = null,
    /** Structured Agent id sent with the next run; never encoded into prompt text. */
    val selectedAgentId: String? = null,
    val approval: PermissionRequestUiState? = null,
    val approvalResolving: Boolean = false,
    val pairingOpen: Boolean = false,
    val pairingUri: String = "",
    val pairingDeviceName: String = "Android device",
    val pairingInProgress: Boolean = false,
    val isLoading: Boolean = false,
    val loadingOlder: Boolean = false,
    val hasOlder: Boolean = false,
    val error: String? = null,
    val computers: List<Computer> = emptyList(),
    val projects: List<Project> = emptyList(),
    val sessions: List<Session> = emptyList(),
    /** True while either project or session catalog still lacks its first emission. */
    val projectCatalogLoading: Boolean = false,
    /** User-initiated catalog refresh; cached content stays visible beneath it. */
    val projectCatalogRefreshing: Boolean = false,
    val selectedProjectId: String? = null,
    val projectSessionsOpen: Boolean = false,
    val browsingProjectId: String? = null,
    val projectOrigin: AgentoDestination? = null,
    val projectDialogOpen: Boolean = false,
    val projectName: String = "",
    val projectRootPath: String = "",
    val projectFolderParentPath: String? = null,
    val projectFolderChildren: List<ProjectFolder> = emptyList(),
    val projectFoldersLoading: Boolean = false,
    val projectFolderError: String? = null,
    val projectFolderCreateOpen: Boolean = false,
    val projectFolderName: String = "",
    val projectFolderCreating: Boolean = false,
    val projectInProgress: Boolean = false,
    val runtimeTool: String = "codex",
    val runtimeProvider: String? = null,
    val runtimeModel: String? = null,
    val runtimeCatalog: RuntimeCatalog = RuntimeCatalog(),
    val runtimeSelectionDisplay: ComposerRuntimeIdentity? = null,
    val runtimeModelsLoading: Boolean = false,
    val runtimeModelsError: String? = null,
    val runtimeUnavailable: Boolean = false,
    val runtimeResolving: Boolean = false,
    val serviceTier: String = "standard",
    val runtimePickerOpen: Boolean = false,
    val sessionMenuOpen: Boolean = false,
    val sessionActionInProgress: Boolean = false,
    val thinkingEffort: Float = 0.5f,
    val selectedEffort: String? = null,
    val effortPickerOpen: Boolean = false,
    val goalMode: Boolean = false,
    val goalText: String = "",
    val autoContinue: Boolean = false,
    val goalDialogOpen: Boolean = false,
    val composerActionSheetOpen: Boolean = false,
    val attachments: List<ComposerAttachment> = emptyList(),
    val editingTurnId: String? = null,
    val editingTurnText: String? = null,
    val queuedMessages: List<QueuedMessageUiState> = emptyList(),
    val activeDecision: DecisionQuestionUiState? = null,
    val runSheetOpen: Boolean = false,
    val selectedDiffFile: FileDiffDetail? = null,
    val planMode: Boolean = false,
    val runMetrics: RunMetricsUiState = RunMetricsUiState(),
    val runDurations: Map<String, Long> = emptyMap(),
    val stepTraces: List<StepTraceItem> = emptyList(),
    val changedFiles: List<FileDiffDetail> = emptyList(),
    val remoteTargets: List<RemoteTarget> = emptyList(),
    /** Home-only projects available on background computers; never paths or device diagnostics. */
    val otherDeviceProjects: List<OtherDeviceProject> = emptyList(),
    val accountComputers: List<RemoteTarget> = emptyList(),
    val activeRemoteTargetId: String? = null,
    val remoteTargetConnectionStates: Map<String, com.andysagent.agentoc.core.model.RuntimeConnectionState> = emptyMap(),
    /** Compact summaries collected by summary-only background carriers. */
    val backgroundTargetSummaries: List<TargetSummary> = emptyList(),
    val appTheme: AppTheme = AppTheme.System,
    val appLanguage: AppLanguage = AppLanguage.System,
    val appVersion: String = "Unknown",
    val appBuild: String = "Unknown",
    val voice: VoiceUiState = VoiceUiState(),
)

enum class SettingsPage {
    Overview,
    Account,
    PermissionMode,
    Language,
    Theme,
    ComputerConfiguration,
    Connectors,
    ModelProviders,
    Harnesses,
    Files,
    Triggers,
    Usage,
    ComputerManagement,
    Voice,
    Version,
}

sealed interface WorkbenchEvent {
    data object OpenComputerSetup : WorkbenchEvent
    data class SelectDestination(val destination: AgentoDestination) : WorkbenchEvent
    data class OpenSettingsPage(val page: SettingsPage) : WorkbenchEvent
    data object CloseSettingsPage : WorkbenchEvent
    data object OpenAppApiSettings : WorkbenchEvent
    data object ToggleVoiceInput : WorkbenchEvent
    data object CancelVoiceInput : WorkbenchEvent
    data class SelectVoiceChoice(val choice: String) : WorkbenchEvent
    data class SetPhoneLocalVoiceEnabled(val enabled: Boolean) : WorkbenchEvent
    data object DownloadPhoneVoiceModel : WorkbenchEvent
    data object RemovePhoneVoiceModel : WorkbenchEvent
    data class SetComputerVoiceEnabled(val targetId: String, val enabled: Boolean) : WorkbenchEvent
    data class InstallComputerVoice(val targetId: String) : WorkbenchEvent
    data object RefreshVoiceDevices : WorkbenchEvent
    data class VoiceTranscriptionReceived(val text: String) : WorkbenchEvent
    data class ReportAgentContent(val text: String? = null) : WorkbenchEvent
    data class SelectTheme(val theme: AppTheme) : WorkbenchEvent
    data class SelectLanguage(val language: AppLanguage) : WorkbenchEvent
    data class SelectRemoteTarget(val instanceId: String) : WorkbenchEvent
    data class ConnectRemoteTarget(val instanceId: String) : WorkbenchEvent
    data class DisconnectRemoteTarget(val instanceId: String) : WorkbenchEvent
    data object OpenAgents : WorkbenchEvent
    data object CloseAgents : WorkbenchEvent
    data class OpenNewSession(val projectId: String? = null) : WorkbenchEvent
    data object CloseChat : WorkbenchEvent
    data class SessionSearchChanged(val value: String) : WorkbenchEvent
    data class ComposerChanged(val text: String) : WorkbenchEvent
    data object SendMessage : WorkbenchEvent
    data object RetryPendingTurn : WorkbenchEvent
    data class SelectAgent(val agentId: String?) : WorkbenchEvent
    data class AddAttachment(val attachment: ComposerAttachment) : WorkbenchEvent
    data object CancelRun : WorkbenchEvent
    data object OpenRuntimePicker : WorkbenchEvent
    data object CloseRuntimePicker : WorkbenchEvent
    data class SelectRuntime(val tool: String) : WorkbenchEvent
    data class SelectProvider(val provider: String?) : WorkbenchEvent
    data class SelectModel(val model: String) : WorkbenchEvent
    data class SelectServiceTier(val tier: String) : WorkbenchEvent
    data object OpenEffortPicker : WorkbenchEvent
    data object CloseEffortPicker : WorkbenchEvent
    data class EffortChanged(val effort: Float) : WorkbenchEvent
    data object DismissRuntimeUnavailable : WorkbenchEvent
    data class ToggleGoalMode(val enabled: Boolean) : WorkbenchEvent
    data class TogglePlanMode(val enabled: Boolean) : WorkbenchEvent
    data class GoalChanged(val goal: String) : WorkbenchEvent
    data object OpenGoalDialog : WorkbenchEvent
    data object CloseGoalDialog : WorkbenchEvent
    data class SaveGoal(val goal: String) : WorkbenchEvent
    data object ClearGoal : WorkbenchEvent
    data class StartAutoContinue(val goal: String) : WorkbenchEvent
    data object PauseAutoContinue : WorkbenchEvent
    data object OpenSessionMenu : WorkbenchEvent
    data object CloseSessionMenu : WorkbenchEvent
    data class RenameSession(val name: String) : WorkbenchEvent
    data object DeleteSession : WorkbenchEvent
    data class PrepareListedSessionAction(val targetId: String?, val sessionId: String) : WorkbenchEvent
    data class RenameListedSession(val targetId: String?, val sessionId: String, val name: String) : WorkbenchEvent
    data class DeleteListedSession(val targetId: String?, val sessionId: String) : WorkbenchEvent
    data class PinListedSession(val targetId: String?, val sessionId: String, val pinned: Boolean) : WorkbenchEvent
    data class PrepareListedProjectAction(val targetId: String?, val projectId: String) : WorkbenchEvent
    data class RenameListedProject(val targetId: String?, val projectId: String, val name: String) : WorkbenchEvent
    data class PinListedProject(val targetId: String?, val projectId: String, val pinned: Boolean) : WorkbenchEvent
    data class DeleteListedProject(val targetId: String?, val projectId: String, val deleteSessions: Boolean) : WorkbenchEvent
    data object CompactSession : WorkbenchEvent
    data object DropTools : WorkbenchEvent
    data object ForkSession : WorkbenchEvent
    data class ForkFromMessage(val anchorSeq: Long, val mode: String) : WorkbenchEvent
    data class RegenerateMessage(val requestId: String) : WorkbenchEvent
    data class SubmitEditTurn(
        val requestId: String,
        val text: String,
        val attachments: List<ComposerAttachment> = emptyList(),
    ) : WorkbenchEvent
    /** Delete the original queued follow-up only when its edited replacement is sent. */
    data class ResendQueuedMessage(
        val messageId: String,
        val text: String,
        val attachments: List<ComposerAttachment> = emptyList(),
    ) : WorkbenchEvent
    data class RemoveQueuedMessage(val messageId: String) : WorkbenchEvent
    data class SteerMessage(val messageId: String) : WorkbenchEvent
    data class SelectDecisionOption(val questionId: String, val optionIndex: Int, val questionIndex: Int = 0) : WorkbenchEvent
    data class DecisionWriteInChanged(val questionId: String, val text: String, val questionIndex: Int = 0) : WorkbenchEvent
    data class SubmitDecision(val questionId: String) : WorkbenchEvent
    data class SelectApprovalAction(val approvalId: String, val actionId: String, val selected: Boolean) : WorkbenchEvent
    data class Approve(val approvalId: String) : WorkbenchEvent
    data class Deny(val approvalId: String) : WorkbenchEvent
    data class PlanAction(val planId: String, val action: String) : WorkbenchEvent
    data object OpenPairing : WorkbenchEvent
    data object DismissPairing : WorkbenchEvent
    data class PairingUriChanged(val value: String) : WorkbenchEvent
    data class PairingDeviceNameChanged(val value: String) : WorkbenchEvent
    data object Pair : WorkbenchEvent
    data object OpenProjectDialog : WorkbenchEvent
    data object DismissProjectDialog : WorkbenchEvent
    data class ProjectNameChanged(val value: String) : WorkbenchEvent
    data class ProjectRootPathChanged(val value: String) : WorkbenchEvent
    data class BrowseProjectFolder(val path: String) : WorkbenchEvent
    data object BrowseProjectFolderParent : WorkbenchEvent
    data object RetryProjectFolderBrowse : WorkbenchEvent
    data object ToggleProjectFolderCreate : WorkbenchEvent
    data class ProjectFolderNameChanged(val value: String) : WorkbenchEvent
    data object CreateProjectFolder : WorkbenchEvent
    data object CreateProject : WorkbenchEvent
    data class SelectProject(val projectId: String) : WorkbenchEvent
    data class OpenProjectSessions(val projectId: String) : WorkbenchEvent
    data class OpenOtherDeviceProject(val targetId: String, val projectId: String) : WorkbenchEvent
    data object CloseProjectSessions : WorkbenchEvent
    data class SelectSession(val sessionId: String) : WorkbenchEvent
    data object LoadOlderTimeline : WorkbenchEvent
    data class MarkSessionRead(val sessionId: String) : WorkbenchEvent
    /** Refreshes the Home catalog without replacing the cached surface with a spinner. */
    data object RefreshHome : WorkbenchEvent
    data object Retry : WorkbenchEvent
    data object RetryChat : WorkbenchEvent
    data object DismissError : WorkbenchEvent
}

@Immutable
data class AppShellUiState(
    // Home is the notification-driven entry surface. Project browsing and an
    // individual conversation are intentional next steps, not the cold-start
    // destination. First-run pairing can still intercept before this shell.
    val destination: AgentoDestination = AgentoDestination.Home,
    val settingsPage: SettingsPage = SettingsPage.Overview,
    val settingsBackStack: List<SettingsPage> = emptyList(),
    val chatOpen: Boolean = false,
    val agentOpen: Boolean = false,
    val sessionSearchQuery: String = "",
    val connection: AgentConnectionStatus = AgentConnectionStatus.Disconnected,
    val projectSessionsOpen: Boolean = false,
    val browsingProjectId: String? = null,
    val projectOrigin: AgentoDestination? = null,
    val appTheme: AppTheme = AppTheme.System,
    val appLanguage: AppLanguage = AppLanguage.System,
)

sealed interface AppShellEvent {
    data class SelectDestination(val destination: AgentoDestination, val keepChat: Boolean = false) : AppShellEvent
    data class OpenSettingsPage(val page: SettingsPage, val keepChat: Boolean = false) : AppShellEvent
    data object CloseSettingsPage : AppShellEvent
    data class SelectTheme(val theme: AppTheme) : AppShellEvent
    data class SelectLanguage(val language: AppLanguage) : AppShellEvent
    data class OpenAgents(val keepChat: Boolean = false) : AppShellEvent
    data object CloseAgents : AppShellEvent
    data object OpenChat : AppShellEvent
    data object CloseChat : AppShellEvent
    data class SessionSearchChanged(val value: String) : AppShellEvent
    data class OpenProjectSessions(val projectId: String, val keepChat: Boolean = false) : AppShellEvent
    data object CloseProjectSessions : AppShellEvent
}

class AppShellViewModel(private val repository: SessionRepository) : ViewModel() {
    private val mutableState = MutableStateFlow(AppShellUiState())
    val state: StateFlow<AppShellUiState> = mutableState.asStateFlow()

    init {
        viewModelScope.launch {
            repository.connectionState.collectLatest { connection ->
                updateState { copy(connection = connection.toAgentConnectionStatus()) }
                if (connection == RuntimeConnectionState.Connected) {
                    launch { runCatching { repository.refreshSessions() } }
                    launch { runCatching { repository.refreshComputers() } }
                    launch { runCatching { repository.refreshProjects() } }
                }
            }
        }
    }

    fun onEvent(event: AppShellEvent) {
        when (event) {
            is AppShellEvent.SelectDestination -> updateState {
                copy(
                    destination = event.destination,
                    settingsPage = SettingsPage.Overview,
                    settingsBackStack = emptyList(),
                    chatOpen = chatOpen && event.keepChat,
                    agentOpen = false,
                    projectSessionsOpen = false,
                    browsingProjectId = null,
                    projectOrigin = null,
                )
            }
            is AppShellEvent.OpenSettingsPage -> updateState {
                copy(
                    destination = AgentoDestination.Settings,
                    settingsPage = event.page,
                    settingsBackStack = if (event.page == settingsPage) settingsBackStack
                        else if (event.page == SettingsPage.Overview) emptyList()
                        else settingsBackStack + settingsPage,
                    chatOpen = chatOpen && event.keepChat,
                    agentOpen = false,
                    projectSessionsOpen = false,
                    browsingProjectId = null,
                    projectOrigin = null,
                )
            }
            AppShellEvent.CloseSettingsPage -> updateState {
                copy(settingsPage = settingsBackStack.lastOrNull() ?: SettingsPage.Overview,
                    settingsBackStack = settingsBackStack.dropLast(1))
            }
            is AppShellEvent.SelectTheme -> updateState { copy(appTheme = event.theme) }
            is AppShellEvent.SelectLanguage -> updateState { copy(appLanguage = event.language) }
            AppShellEvent.OpenChat -> updateState { copy(chatOpen = true) }
            AppShellEvent.CloseChat -> updateState { copy(chatOpen = false) }
            is AppShellEvent.OpenAgents -> updateState { copy(agentOpen = true, chatOpen = chatOpen && event.keepChat) }
            AppShellEvent.CloseAgents -> updateState { copy(agentOpen = false) }
            is AppShellEvent.SessionSearchChanged -> updateState { copy(sessionSearchQuery = event.value) }
            is AppShellEvent.OpenProjectSessions -> updateState {
                copy(
                    destination = AgentoDestination.Sessions,
                    chatOpen = chatOpen && event.keepChat,
                    agentOpen = false,
                    projectSessionsOpen = true,
                    browsingProjectId = event.projectId,
                    projectOrigin = projectOrigin ?: destination.takeUnless { it == AgentoDestination.Sessions },
                )
            }
            AppShellEvent.CloseProjectSessions -> updateState {
                copy(
                    destination = projectOrigin ?: destination,
                    projectSessionsOpen = false,
                    browsingProjectId = null,
                    projectOrigin = null,
                )
            }
        }
    }

    private fun updateState(transform: AppShellUiState.() -> AppShellUiState) {
        mutableState.value = mutableState.value.transform()
    }
}

@Immutable
data class ChatUiState(
    val stopRequest: StopRequestState = StopRequestState.None,
    val connection: AgentConnectionStatus = AgentConnectionStatus.Disconnected,
    val runStatus: AgentRunStatus = AgentRunStatus.Idle,
    val currentAction: RunActionUiState? = null,
    val serverRunActivity: JsonObject? = null,
    val sessionTitle: String = "New session",
    val timelineItems: List<TimelineItem> = emptyList(),
    /**
     * A local turn is rendered before the server acknowledges it. It remains
     * at the tail of the timeline until its request id appears in server
     * history, so a slow POST or socket cannot make a send feel inert.
     */
    val pendingTurn: PendingTurnUiState? = null,
    val acceptedTurns: List<PendingTurnUiState> = emptyList(),
    val composerText: String = "",
    val messageCount: Int = 0,
    val unseenCount: Int = 0,
    val sessionId: String? = null,
    /** True while the selected session's durable timeline is being replaced. */
    val historyLoading: Boolean = false,
    /** Session id that owns the currently rendered timeline. */
    val timelineSessionId: String? = null,
    val selectedAgentId: String? = null,
    val approval: PermissionRequestUiState? = null,
    val resolvingApprovalId: String? = null,
    val isLoading: Boolean = false,
    val loadingOlder: Boolean = false,
    val hasOlder: Boolean = false,
    val error: String? = null,
    /** A transient carrier error disappears as soon as the carrier is healthy again. */
    val clearErrorWhenConnected: Boolean = false,
    val runtimeTool: String = "codex",
    val runtimeProvider: String? = null,
    val runtimeModel: String? = null,
    val runtimeCatalog: RuntimeCatalog = RuntimeCatalog(),
    val runtimeSelectionDisplay: ComposerRuntimeIdentity? = null,
    val runtimeModelsLoading: Boolean = false,
    val runtimeModelsError: String? = null,
    val runtimeUnavailable: Boolean = false,
    val runtimeResolving: Boolean = false,
    val serviceTier: String = "standard",
    val runtimePickerOpen: Boolean = false,
    val sessionMenuOpen: Boolean = false,
    val sessionActionInProgress: Boolean = false,
    val thinkingEffort: Float = 0.5f,
    val selectedEffort: String? = null,
    val effortPickerOpen: Boolean = false,
    val goalMode: Boolean = false,
    val goalText: String = "",
    val autoContinue: Boolean = false,
    val goalDialogOpen: Boolean = false,
    val composerActionSheetOpen: Boolean = false,
    val attachments: List<ComposerAttachment> = emptyList(),
    val editingTurnId: String? = null,
    val editingTurnText: String? = null,
    val queuedMessages: List<QueuedMessageUiState> = emptyList(),
    val activeDecision: DecisionQuestionUiState? = null,
    val runSheetOpen: Boolean = false,
    val selectedDiffFile: FileDiffDetail? = null,
    val planMode: Boolean = false,
    val runMetrics: RunMetricsUiState = RunMetricsUiState(),
    val runDurations: Map<String, Long> = emptyMap(),
    val stepTraces: List<StepTraceItem> = emptyList(),
    val changedFiles: List<FileDiffDetail> = emptyList(),
)

@Immutable
data class PendingTurnUiState(
    val requestId: String,
    val text: String,
    val attachments: List<ComposerAttachment>,
    val selection: RuntimeSelection,
    val agentId: String?,
    val goalToPersist: String? = null,
    val state: PendingTurnState = PendingTurnState.Sending,
    val error: String? = null,
)

enum class PendingTurnState { Sending, Accepted, Failed }

/** A request acknowledgement is not proof that the computer has stopped. */
enum class StopRequestState { None, AwaitingConfirmation, OutcomeUnknown }
private data class PendingStopRequest(val state: StopRequestState)

sealed interface ChatEvent {
    data class ComposerChanged(val text: String) : ChatEvent
    data object SendMessage : ChatEvent
    data object RetryPendingTurn : ChatEvent
    data class SelectAgent(val agentId: String?) : ChatEvent
    data object CancelRun : ChatEvent
    data class Approve(val approvalId: String) : ChatEvent
    data class Deny(val approvalId: String) : ChatEvent
    data class PlanAction(val planId: String, val action: String) : ChatEvent
    data class SelectApprovalAction(val approvalId: String, val actionId: String, val selected: Boolean) : ChatEvent
    data class SelectSession(val sessionId: String) : ChatEvent
    data object LoadOlderTimeline : ChatEvent
    data class CreateSession(val projectId: String? = null) : ChatEvent
    data object Retry : ChatEvent
    data object DismissError : ChatEvent
    data object OpenRuntimePicker : ChatEvent
    data object CloseRuntimePicker : ChatEvent
    data object RefreshRuntimeCatalog : ChatEvent
    data class SelectRuntime(val tool: String) : ChatEvent
    data class SelectProvider(val provider: String?) : ChatEvent
    data class SelectModel(val model: String) : ChatEvent
    data class SelectServiceTier(val tier: String) : ChatEvent
    data object OpenEffortPicker : ChatEvent
    data object CloseEffortPicker : ChatEvent
    data class EffortChanged(val effort: Float) : ChatEvent
    data object DismissRuntimeUnavailable : ChatEvent
    data class ToggleGoalMode(val enabled: Boolean) : ChatEvent
    data class GoalChanged(val goal: String) : ChatEvent
    data object OpenGoalDialog : ChatEvent
    data object CloseGoalDialog : ChatEvent
    data class SaveGoal(val goal: String) : ChatEvent
    data object ClearGoal : ChatEvent
    data class StartAutoContinue(val goal: String) : ChatEvent
    data object PauseAutoContinue : ChatEvent
    data object OpenSessionMenu : ChatEvent
    data object CloseSessionMenu : ChatEvent
    data class RenameSession(val name: String) : ChatEvent
    data object DeleteSession : ChatEvent
    data class PrepareListedSessionAction(val sessionId: String) : ChatEvent
    data class RenameListedSession(val sessionId: String, val name: String) : ChatEvent
    data class DeleteListedSession(val sessionId: String) : ChatEvent
    data class PinListedSession(val sessionId: String, val pinned: Boolean) : ChatEvent
    data class PrepareListedProjectAction(val projectId: String) : ChatEvent
    data class RenameListedProject(val projectId: String, val name: String) : ChatEvent
    data class PinListedProject(val projectId: String, val pinned: Boolean) : ChatEvent
    data class DeleteListedProject(val projectId: String, val deleteSessions: Boolean) : ChatEvent
    data object CompactSession : ChatEvent
    data object DropTools : ChatEvent
    data object ForkSession : ChatEvent
    data class ForkFromMessage(val anchorSeq: Long, val mode: String) : ChatEvent
    data class RegenerateMessage(val requestId: String) : ChatEvent

    // Composer additions
    data object OpenComposerActionSheet : ChatEvent
    data object CloseComposerActionSheet : ChatEvent
    data class AddAttachment(val attachment: ComposerAttachment) : ChatEvent
    data class RemoveAttachment(val attachmentId: String) : ChatEvent
    data object ClearAttachments : ChatEvent
    data class TogglePlanMode(val enabled: Boolean) : ChatEvent

    // Edit-resend turn
    data class StartEditTurn(val messageId: String, val text: String) : ChatEvent
    data object CancelEditTurn : ChatEvent
    data class SubmitEditTurn(
        val messageId: String,
        val text: String,
        val attachments: List<ComposerAttachment> = emptyList(),
    ) : ChatEvent
    /** Replaces a queued follow-up by removing it, then sending the edited draft. */
    data class ResendQueuedMessage(
        val messageId: String,
        val text: String,
        val attachments: List<ComposerAttachment> = emptyList(),
    ) : ChatEvent

    // Queue & Steer
    data class QueueMessage(val text: String) : ChatEvent
    data class RemoveQueuedMessage(val messageId: String) : ChatEvent
    data class SteerMessage(val messageId: String) : ChatEvent

    // Decision Card
    data class SelectDecisionOption(val questionId: String, val optionIndex: Int, val questionIndex: Int = 0) : ChatEvent
    data class DecisionWriteInChanged(val questionId: String, val text: String, val questionIndex: Int = 0) : ChatEvent
    data class SubmitDecision(val questionId: String) : ChatEvent

    // Run Sheet & Diff
    data object OpenRunSheet : ChatEvent
    data object CloseRunSheet : ChatEvent
    data class OpenDiffViewer(val file: FileDiffDetail) : ChatEvent
    data object CloseDiffViewer : ChatEvent
}

enum class GoalUpdateStrategy {
    Direct,
    StreamingPromptInjection,
    NextTurnDeferred,
}

fun resolveGoalUpdateStrategy(runtimeTool: String): GoalUpdateStrategy {
    val tool = runtimeTool.trim().lowercase()
    return when {
        tool.startsWith("codex") -> GoalUpdateStrategy.Direct
        tool.startsWith("claude") || tool.startsWith("agy") -> GoalUpdateStrategy.StreamingPromptInjection
        else -> GoalUpdateStrategy.NextTurnDeferred
    }
}

private fun toQueuedMessageUiState(message: QueuedMessage): QueuedMessageUiState = QueuedMessageUiState(
    id = message.requestId,
    text = message.text,
    timestamp = message.queuedAt ?: System.currentTimeMillis(),
    attachments = message.attachments.mapIndexed { index, attachment ->
        ComposerAttachment(
            id = attachment.assetId ?: "${message.requestId}:attachment:$index",
            name = attachment.originalName ?: attachment.filename ?: attachment.assetId ?: "attachment",
            mimeType = attachment.mimeType ?: "application/octet-stream",
            sizeBytes = attachment.sizeBytes ?: 0L,
            previewUrl = attachment.downloadUrl ?: attachment.url,
            assetId = attachment.assetId,
        )
    },
)

private fun Approval.toDecisionQuestionUiState(): DecisionQuestionUiState? {
    val normalizedKind = kind.trim().lowercase()
    val question = questions.firstOrNull()
    if (question == null && normalizedKind != "question") return null
    val labels = question?.options?.map { it.label } ?: options
    val values = question?.options?.map { it.value } ?: options
    val prompt = question?.question?.trim().orEmpty()
        .ifBlank { reason?.trim().orEmpty() }
        .ifBlank { title.trim() }
    if (prompt.isBlank() && labels.isEmpty()) return null
    return DecisionQuestionUiState(
        id = id,
        approvalId = id,
        runId = runId,
        kind = normalizedKind,
        question = prompt,
        options = labels,
        optionValues = values,
        isMultiSelect = question?.isMultiSelect ?: isMultiSelect,
        recommendedIndex = null,
        questionGroups = questions,
    )
}

internal fun requiresDeviceReauthentication(error: Throwable): Boolean =
    error is SessionRepositoryException &&
        (error.statusCode == 401 || (error.statusCode == 403 && error.code == "DEVICE_REVOKED"))

class ChatViewModel(
    private val repository: SessionRepository,
    private val passkeyProvider: (suspend (publicKeyJson: String) -> WebAuthnProofDto)? = null,
    private val readRuntimeCache: suspend (String, String?) -> RuntimeSelection? = { _, _ -> null },
    private val writeRuntimeCache: suspend (String, String?, RuntimeSelection) -> Unit = { _, _, _ -> },
) : ViewModel() {
    private var selectedSessionJob: Job? = null
    // Selection is a logical generation in addition to a coroutine job. Flow
    // cancellation is cooperative, so a final emission from the previous
    // session must not be allowed to repaint the newly selected session.
    private var sessionGeneration = 0L
    private var knownSessions: List<Session> = emptyList()
    private var knownSessionsRepository: SessionRepository? = null
    private var selectedRepository: SessionRepository? = null
    /** An open tablet detail is dismissed only by an explicit navigation action. */
    var preserveSelectedSessionOnRefresh: Boolean = false
    private val stopRequests = mutableMapOf<Pair<SessionRepository, String>, PendingStopRequest>()
    private val approvalResolutionLock = Any()
    private val sessionDrafts = mutableMapOf<Pair<SessionRepository, String>, String>()
    // A local echo belongs to one target repository and one session, including
    // while a send finishes in the background after navigation.
    private val sessionPendingTurns = mutableMapOf<Pair<SessionRepository, String>, PendingTurnUiState>()
    private val sessionAcceptedTurns = mutableMapOf<Pair<SessionRepository, String>, List<PendingTurnUiState>>()
    private val sessionObservedRequests = mutableMapOf<Pair<SessionRepository, String>, Set<String>>()
    private var newSessionRequested = false
    private var listedSessionActionTarget: Pair<SessionRepository, String>? = null
    private var listedProjectActionTarget: Pair<SessionRepository, String>? = null
    private var lastRunProjectionRequest: Pair<String, Long>? = null
    private var durationFetchJob: Job? = null
    private val durationAttempts = mutableMapOf<String, Long>()
    private var artifactProjectionSessionId: String? = null
    private var artifactProjectionRepository: SessionRepository? = null
    private val artifactProjectionLock = Any()
    private var artifactProjectionTimeline: List<TimelineItem> = emptyList()
    private var cachedStepTraces: List<StepTraceItem> = emptyList()
    private var cachedChangedFiles: List<FileDiffDetail> = emptyList()
    // A follow-up can be composed while the previous POST is still crossing
    // the network. Preserve the draft and submit it as soon as that request
    // is accepted instead of dropping a tap on the Send action.
    private var sendAfterPendingTurn = false
    // Session invalidations and session selection can both request a refresh.
    // Serialize them per session so a late refresh cannot interleave its state
    // transition with a newer one. Cancellation still propagates to the caller.
    private val sessionRefreshLocks = mutableMapOf<Pair<SessionRepository, String>, Mutex>()
    private val mutableState = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = mutableState.asStateFlow()
    private val runtimeModelCache = mutableMapOf<Pair<String, String>, List<RuntimeModelOption>>()
    private val sessionRuntimeSelections = mutableMapOf<Pair<SessionRepository, String>, RuntimeSelection>()
    private var runtimeEditGeneration = 0L
    private var runtimeDefaultGeneration = 0L
    private val runtimeSaveMutex = Mutex()
    private var runtimeModelLoadJob: Job? = null
    private var runtimeModelSelectionGeneration = 0L
    private var runtimePickerSnapshot: RuntimeSelection? = null
    private var runtimeCatalogRepository: SessionRepository? = null

    private fun activeRepository(): SessionRepository? =
        if (repository is SwitchingSessionRepository) repository.delegate.value else repository

    // Carry the delegate with its snapshot. Reading a mutable delegate after an
    // emission can otherwise assign an old computer's Session list to a new one.
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun scopedSessions(): Flow<Pair<SessionRepository?, List<Session>>> =
        if (repository is SwitchingSessionRepository) {
            repository.delegate.flatMapLatest { fixed ->
                fixed?.observeSessions()?.map { fixed to it } ?: flowOf(null to emptyList())
            }
        } else repository.observeSessions().map { repository to it }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    private fun scopedConnections(): Flow<Pair<SessionRepository?, RuntimeConnectionState>> =
        if (repository is SwitchingSessionRepository) {
            repository.delegate.flatMapLatest { fixed ->
                fixed?.connectionState?.map { fixed to it } ?: flowOf(null to RuntimeConnectionState.Disconnected)
            }
        } else repository.connectionState.map { repository to it }

    private fun saveSelectedDraft() {
        val fixed = selectedRepository ?: return
        mutableState.value.sessionId?.let { sessionDrafts[fixed to it] = mutableState.value.composerText }
    }

    init {
        viewModelScope.launch {
            scopedConnections().collectLatest { (fixed, connection) ->
                if (fixed !== activeRepository()) return@collectLatest
                if (runtimeCatalogRepository !== fixed) {
                    runtimeCatalogRepository = fixed
                    runtimeModelLoadJob?.cancel()
                    runtimeModelSelectionGeneration++
                    runtimeModelCache.clear()
                    updateState { copy(runtimeCatalog = RuntimeCatalog(), runtimeSelectionDisplay = null, runtimeModelsLoading = false, runtimeModelsError = null) }
                }
                val recoverSessionId = mutableState.value.sessionId.takeIf { mutableState.value.clearErrorWhenConnected }
                val recoverGeneration = sessionGeneration
                updateConnection(connection)
                if (fixed != null && connection == RuntimeConnectionState.Connected) {
                    if (recoverSessionId != null && selectedRepository === fixed) refreshSession(recoverSessionId, recoverGeneration)
                    runCatching { fixed.loadRuntimeCatalog() }
                        .onSuccess { catalog ->
                            if (activeRepository() !== fixed) return@onSuccess
                            val mergedCatalog = mergeRuntimeCatalog(catalog, mutableState.value.runtimeCatalog)
                            updateState { copy(runtimeCatalog = mergedCatalog) }
                            if (!mutableState.value.runtimePickerOpen) resolveDefaultRuntime(fixed, mergedCatalog)
                        }
                }
            }
        }
        viewModelScope.launch {
            scopedSessions().collectLatest { (fixed, sessions) ->
                if (fixed !== activeRepository()) return@collectLatest
                knownSessions = sessions
                if (fixed != null) sessions.filter {
                    it.status !in setOf(SessionStatus.Working, SessionStatus.WaitingApproval)
                }.forEach { stopRequests.remove(fixed to it.id) }
                knownSessionsRepository = fixed
                val currentId = mutableState.value.sessionId
                if (preserveSelectedSessionOnRefresh && fixed === selectedRepository && currentId != null &&
                    sessions.none { it.id == currentId }) return@collectLatest
                val selected = sessions.firstOrNull { it.id == currentId }
                    ?: sessions.firstOrNull().takeUnless { newSessionRequested && fixed === selectedRepository }
                if (selected != null && (selected.id != currentId || fixed !== selectedRepository)) selectSession(selected.id)
                if (selected != null) {
                    val previousRunStatus = mutableState.value.runStatus
                    val queueIds = selected.queuedMessages.map { it.requestId }.toSet()
                    val key = requireNotNull(fixed) to selected.id
                    updateState {
                        copy(
                            sessionId = selected.id,
                            sessionTitle = selected.title.ifBlank { "New session" },
                            selectedAgentId = selected.templateId,
                            runStatus = selected.status.toAgentStatus(),
                            queuedMessages = selected.queuedMessages.map(::toQueuedMessageUiState),
                            acceptedTurns = sessionAcceptedTurns[key].orEmpty().filterNot { it.requestId in queueIds },
                        )
                    }
                    if (previousRunStatus in setOf(AgentRunStatus.Working, AgentRunStatus.WaitingApproval) &&
                        selected.status.toAgentStatus() in setOf(AgentRunStatus.Idle, AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled)) {
                        val items = mutableState.value.timelineItems
                        val lastRunId = items.asReversed().firstNotNullOfOrNull { item -> when (item) {
                            is TimelineItem.Message -> item.runId
                            is TimelineItem.Operation -> item.runId
                            is TimelineItem.Plan -> item.runId
                            is TimelineItem.Notice -> null
                        } }
                        lastRunId?.let { runId ->
                            durationAttempts.remove(runId)
                            loadRunProjection(selected.id, runId, sessionGeneration)
                        }
                        fetchHistoricalDurations(requireNotNull(fixed), selected.id, sessionGeneration, items)
                    }
                } else if (currentId != null || fixed !== selectedRepository) {
                    saveSelectedDraft()
                    selectedSessionJob?.cancel()
                    selectedSessionJob = null
                    sessionGeneration++
                    if (fixed !== selectedRepository) newSessionRequested = false
                    selectedRepository = fixed
                    sendAfterPendingTurn = false
                    updateState {
                        copy(
                            sessionId = null,
                            sessionTitle = "New session",
                            timelineItems = emptyList(),
                            historyLoading = false,
                            timelineSessionId = null,
                            messageCount = 0,
                            composerText = "",
                            attachments = emptyList(),
                            pendingTurn = null,
                            acceptedTurns = emptyList(),
                            isLoading = false,
                            activeDecision = null,
                            approval = null,
                            resolvingApprovalId = null,
                            queuedMessages = emptyList(),
                            editingTurnId = null,
                            editingTurnText = null,
                            runSheetOpen = false,
                            selectedDiffFile = null,
                            stepTraces = emptyList(),
                            changedFiles = emptyList(),
                            runMetrics = RunMetricsUiState(status = AgentRunStatus.Idle),
                            goalText = "",
                            loadingOlder = false,
                            hasOlder = false,
                            runStatus = AgentRunStatus.Idle,
                        )
                    }
                    if (fixed != null && mutableState.value.connection == AgentConnectionStatus.Connected &&
                        runtimeCatalogRepository === fixed) resolveDefaultRuntime(fixed, mutableState.value.runtimeCatalog)
                }
            }
        }
        viewModelScope.launch {
            repository.invalidations.collectLatest { hint ->
                if (hint.type == "sessions_invalidated") refreshSessions()
                if (hint.type == "harnesses_invalidated") refreshRuntimeCatalog()
                if (hint.type == "authentication_required") updateConnection(RuntimeConnectionState.AuthenticationRequired)
                val sessionId = mutableState.value.sessionId
                if (sessionId != null && (hint.sessionId == null || hint.sessionId == sessionId)) {
                    if (hint.events.isNotEmpty() && hint.sessionId == sessionId) {
                        val liveResult = runCatching { repository.applyLiveEvents(sessionId, hint.events) }.getOrNull()
                        if (liveResult is RefreshResult.Gap) refreshSession(sessionId)
                    } else {
                        refreshSession(sessionId)
                    }
                }
            }
        }
    }

    fun onEvent(event: ChatEvent) {
        if ((event is ChatEvent.SendMessage || event is ChatEvent.SubmitEditTurn) && mutableState.value.runtimeResolving) return
        if (event is ChatEvent.SelectRuntime || event is ChatEvent.SelectProvider || event is ChatEvent.SelectModel ||
            event is ChatEvent.OpenRuntimePicker || event is ChatEvent.EffortChanged || event is ChatEvent.SelectServiceTier || event is ChatEvent.SendMessage ||
            event is ChatEvent.SubmitEditTurn) {
            runtimeEditGeneration++
            if (event !is ChatEvent.SendMessage && event !is ChatEvent.SubmitEditTurn) updateState { copy(runtimeResolving = false) }
        }
        when (event) {
            is ChatEvent.ComposerChanged -> {
                selectedRepository?.let { fixed ->
                    mutableState.value.sessionId?.let { sessionDrafts[fixed to it] = event.text }
                }
                updateState { copy(composerText = event.text) }
            }
            ChatEvent.SendMessage -> sendMessage()
            ChatEvent.RetryPendingTurn -> retryPendingTurn()
            is ChatEvent.SelectAgent -> {
                updateState { copy(selectedAgentId = event.agentId) }
                val sessionId = mutableState.value.sessionId
                val selectedSession = knownSessions.firstOrNull { it.id == sessionId }
                // Before the first turn the Web contract can persist the
                // template on the Session. After history exists, keep the
                // same agentId as a per-run override on the next send.
                if (!event.agentId.isNullOrBlank() && sessionId != null && selectedSession?.latestSeq == 0L) {
                    viewModelScope.launch {
                        runCatching { repository.bindAgent(sessionId, event.agentId) }
                            .onFailure { error ->
                                if ((error as? SessionRepositoryException)?.statusCode != 409) {
                                    showError(error, "Agent could not be bound to this session")
                                }
                            }
                    }
                }
            }
            ChatEvent.CancelRun -> cancelRun()
            is ChatEvent.Approve -> resolveApproval(event.approvalId, approve = true)
            is ChatEvent.Deny -> resolveApproval(event.approvalId, approve = false)
            is ChatEvent.PlanAction -> submitPlanAction(event.planId, event.action)
            is ChatEvent.SelectApprovalAction -> selectApprovalAction(event)
            is ChatEvent.SelectSession -> selectSession(event.sessionId)
            ChatEvent.LoadOlderTimeline -> loadOlderTimeline()
            is ChatEvent.CreateSession -> createSession(event.projectId)
            ChatEvent.Retry -> retry()
            ChatEvent.DismissError -> updateState { copy(error = null) }
            ChatEvent.OpenRuntimePicker -> {
                if (!mutableState.value.runtimePickerOpen) {
                    val current = mutableState.value
                    runtimePickerSnapshot = RuntimeSelection(current.runtimeTool, current.runtimeProvider,
                        current.runtimeModel, effort = current.selectedEffort, serviceTier = current.serviceTier)
                }
                updateState { copy(
                    runtimePickerOpen = true,
                    runtimeSelectionDisplay = if (runtimePickerOpen) runtimeSelectionDisplay else
                        composerRuntimeIdentity(runtimeCatalog, runtimeTool, runtimeProvider, runtimeModel, runtimeSelectionDisplay),
                ) }
            }
            ChatEvent.CloseRuntimePicker -> {
                runtimeModelLoadJob?.cancel()
                runtimeModelSelectionGeneration++
                val previous = runtimePickerSnapshot
                runtimePickerSnapshot = null
                updateState { copy(
                    runtimePickerOpen = false,
                    runtimeTool = previous?.tool ?: runtimeTool,
                    runtimeProvider = if (previous != null) previous.providerProfile else runtimeProvider,
                    runtimeModel = if (previous != null) previous.model else runtimeModel,
                    selectedEffort = if (previous != null) previous.effort else selectedEffort,
                    serviceTier = previous?.serviceTier ?: serviceTier,
                    runtimeModelsLoading = false,
                    runtimeModelsError = null,
                ) }
            }
            ChatEvent.RefreshRuntimeCatalog -> refreshRuntimeCatalog()
            is ChatEvent.SelectRuntime -> {
                runtimeModelLoadJob?.cancel()
                updateState {
                    copy(
                        runtimeTool = event.tool,
                        runtimeProvider = null,
                        runtimeModel = null,
                        runtimeModelsLoading = false,
                        runtimeModelsError = null,
                        serviceTier = "standard",
                        runtimePickerOpen = true,
                    )
                }
            }
            is ChatEvent.SelectProvider -> selectRuntimeProvider(event.provider)
            is ChatEvent.SelectModel -> {
                val current = mutableState.value
                val selected = current.runtimeCatalog.tools.firstOrNull { it.id == current.runtimeTool }?.models
                    ?.firstOrNull { it.id == event.model && it.provider == current.runtimeProvider }
                // A stale/foreign row cannot commit a same-ID model from another provider.
                if (selected == null || current.runtimeModelsLoading || current.runtimeModelsError != null) return
                runtimeModelLoadJob?.cancel()
                runtimeModelSelectionGeneration++
                runtimePickerSnapshot = null
                updateState {
                    copy(
                        runtimeModel = event.model,
                        runtimeProvider = selected.provider,
                        selectedEffort = selected.resolveEffort(selectedEffort),
                        thinkingEffort = selected.effortPosition(selected.resolveEffort(selectedEffort)),
                        runtimeSelectionDisplay = composerRuntimeIdentity(runtimeCatalog, runtimeTool, selected.provider, event.model),
                        serviceTier = if (selected.supportsFast) serviceTier else "standard",
                        runtimePickerOpen = false,
                    )
                }
                rememberCurrentRuntime()
            }
            is ChatEvent.SelectServiceTier -> updateState { copy(serviceTier = event.tier) }.also { rememberCurrentRuntime() }
            ChatEvent.OpenEffortPicker -> updateState { copy(effortPickerOpen = true) }
            ChatEvent.CloseEffortPicker -> updateState { copy(effortPickerOpen = false) }
            is ChatEvent.EffortChanged -> updateState {
                val model = currentRuntimeModel()
                val levels = model?.effortLevels.orEmpty()
                val index = if (levels.size > 1) kotlin.math.round(event.effort.coerceIn(0f, 1f) * (levels.size - 1)).toInt() else 0
                copy(thinkingEffort = event.effort, selectedEffort = levels.getOrNull(index))
            }.also { rememberCurrentRuntime() }
            ChatEvent.DismissRuntimeUnavailable -> updateState { copy(runtimeUnavailable = false) }
            is ChatEvent.ToggleGoalMode -> updateState {
                copy(
                    goalMode = event.enabled,
                    autoContinue = if (!event.enabled) false else autoContinue,
                )
            }
            is ChatEvent.GoalChanged -> updateState { copy(goalText = event.goal) }
            ChatEvent.OpenGoalDialog -> updateState { copy(goalDialogOpen = true) }
            ChatEvent.CloseGoalDialog -> updateState { copy(goalDialogOpen = false) }
            ChatEvent.ClearGoal -> {
                val current = mutableState.value
                val fixed = selectedRepository
                val generation = sessionGeneration
                if (current.sessionId != null && (fixed == null || fixed !== activeRepository())) return
                updateState { copy(goalText = "", goalMode = false, autoContinue = false, goalDialogOpen = false) }
                val sid = current.sessionId
                if (sid != null && fixed != null) {
                    runGoalAction(sid, fixed, generation, "Goal could not be cleared") {
                        fixed.updateSessionGoal(sid, null, autoContinue = false)
                    }
                }
            }
            is ChatEvent.SaveGoal -> {
                val current = mutableState.value
                val fixed = selectedRepository
                val generation = sessionGeneration
                if (current.sessionId != null && (fixed == null || fixed !== activeRepository())) return
                val newGoal = event.goal.trim()
                val oldGoal = current.goalText
                val wasNonEmpty = oldGoal.isNotBlank()
                val isAutoContinuing = current.autoContinue || current.runStatus == AgentRunStatus.Working

                updateState {
                    copy(
                        goalText = newGoal,
                        goalMode = newGoal.isNotBlank() || goalMode,
                        goalDialogOpen = false,
                    )
                }

                val sid = current.sessionId
                if (sid != null && fixed != null) {
                    // 本来goal内容就非空且auto continue模式开启的情况下，如果修改goal内容并保存了
                    if (wasNonEmpty && newGoal != oldGoal && isAutoContinuing) {
                        val strategy = resolveGoalUpdateStrategy(current.runtimeTool)
                        viewModelScope.launch {
                            try {
                                when (strategy) {
                                    GoalUpdateStrategy.Direct -> {
                                        fixed.updateSessionGoal(sid, newGoal, autoContinue = true)
                                    }
                                    GoalUpdateStrategy.StreamingPromptInjection -> {
                                        fixed.sendMessage(sid, "[Goal updated]: $newGoal")
                                        fixed.updateSessionGoal(sid, newGoal, autoContinue = true)
                                    }
                                    GoalUpdateStrategy.NextTurnDeferred -> {
                                        // 保存在本地状态，在下一轮发送时将改后的goal传入
                                    }
                                }
                                if (selectedRepository === fixed) refreshSession(sid, generation)
                            } catch (error: CancellationException) {
                                throw error
                            } catch (error: Throwable) {
                                if (selectedRepository === fixed && isCurrentSession(sid, generation)) {
                                    showError(error, "Goal update could not be delivered")
                                }
                            }
                        }
                    } else {
                        viewModelScope.launch {
                            try {
                                fixed.updateSessionGoal(
                                    sid,
                                    newGoal.takeIf { it.isNotBlank() },
                                    autoContinue = current.autoContinue,
                                )
                            } catch (error: CancellationException) {
                                throw error
                            } catch (error: Throwable) {
                                if (selectedRepository === fixed && isCurrentSession(sid, generation)) {
                                    showError(error, "Goal could not be saved")
                                }
                            }
                        }
                    }
                }
            }
            is ChatEvent.StartAutoContinue -> {
                val current = mutableState.value
                val fixed = selectedRepository
                val generation = sessionGeneration
                if (current.sessionId != null && (fixed == null || fixed !== activeRepository())) return
                val newGoal = event.goal.trim()
                val oldGoal = current.goalText
                val wasNonEmpty = oldGoal.isNotBlank()
                val wasWorking = current.runStatus == AgentRunStatus.Working

                updateState {
                    copy(
                        goalText = newGoal,
                        goalMode = true,
                        autoContinue = true,
                        goalDialogOpen = false,
                    )
                }

                val sid = current.sessionId
                if (sid != null && fixed != null) {
                    if (wasNonEmpty && newGoal != oldGoal && wasWorking) {
                        val strategy = resolveGoalUpdateStrategy(current.runtimeTool)
                        runGoalAction(sid, fixed, generation, "Auto-continue could not be started", refresh = true) {
                            when (strategy) {
                                GoalUpdateStrategy.Direct -> {
                                    fixed.updateSessionGoal(sid, newGoal, autoContinue = true)
                                }
                                GoalUpdateStrategy.StreamingPromptInjection -> {
                                    fixed.sendMessage(sid, "[Goal updated]: $newGoal")
                                }
                                GoalUpdateStrategy.NextTurnDeferred -> {}
                            }
                        }
                    } else {
                        runGoalAction(sid, fixed, generation, "Auto-continue could not be started", refresh = true) {
                            fixed.updateSessionGoal(sid, newGoal.takeIf { it.isNotBlank() }, autoContinue = true)
                        }
                    }
                }
            }
            ChatEvent.PauseAutoContinue -> {
                val current = mutableState.value
                val fixed = selectedRepository
                val generation = sessionGeneration
                if (current.sessionId != null && (fixed == null || fixed !== activeRepository())) return
                updateState { copy(autoContinue = false) }
                val sid = current.sessionId
                if (sid != null && fixed != null) {
                    runGoalAction(sid, fixed, generation, "Auto-continue could not be paused") {
                        fixed.updateSessionGoal(sid, current.goalText.takeIf { it.isNotBlank() }, autoContinue = false)
                    }
                }
            }
            ChatEvent.OpenSessionMenu -> updateState { copy(sessionMenuOpen = true) }
            ChatEvent.CloseSessionMenu -> updateState { copy(sessionMenuOpen = false) }
            is ChatEvent.RenameSession -> runSessionAction("Session could not be renamed") {
                repository.renameSession(requireSessionId(), event.name)
            }
            ChatEvent.DeleteSession -> runSessionAction("Session could not be deleted") {
                repository.deleteSession(requireSessionId())
            }
            is ChatEvent.PrepareListedSessionAction -> {
                val fixed = activeRepository()
                listedSessionActionTarget = if (fixed != null && knownSessionsRepository === fixed &&
                    knownSessions.any { it.id == event.sessionId }) fixed to event.sessionId else null
            }
            is ChatEvent.RenameListedSession -> runListedSessionAction(event.sessionId, "Session could not be renamed") { fixed ->
                fixed.renameSession(event.sessionId, event.name)
            }
            is ChatEvent.DeleteListedSession -> runListedSessionAction(event.sessionId, "Session could not be deleted") { fixed ->
                fixed.deleteSession(event.sessionId)
            }
            is ChatEvent.PinListedSession -> runListedSessionAction(event.sessionId, "Session could not be pinned") { fixed ->
                fixed.setSessionPinned(event.sessionId, event.pinned)
            }
            is ChatEvent.PrepareListedProjectAction -> {
                listedProjectActionTarget = activeRepository()?.let { it to event.projectId }
            }
            is ChatEvent.RenameListedProject -> runListedProjectAction(event.projectId, "Project could not be renamed") { it.updateProject(event.projectId, event.name) }
            is ChatEvent.PinListedProject -> runListedProjectAction(event.projectId, "Project could not be pinned") { it.setProjectPinned(event.projectId, event.pinned) }
            is ChatEvent.DeleteListedProject -> runListedProjectAction(event.projectId, "Project could not be deleted") { it.deleteProject(event.projectId, event.deleteSessions) }
            ChatEvent.CompactSession -> runSessionAction("Session context could not be compacted") {
                val sessionId = requireSessionId()
                repository.compactSession(sessionId)
                refreshSession(sessionId)
            }
            ChatEvent.DropTools -> runSessionAction("Tool results could not be dropped") {
                val sessionId = requireSessionId()
                repository.dropTools(sessionId)
                refreshSession(sessionId)
            }
            ChatEvent.ForkSession -> forkSession()
            is ChatEvent.ForkFromMessage -> forkFromMessage(event.anchorSeq, event.mode)
            is ChatEvent.RegenerateMessage -> regenerateMessage(event.requestId)

            // Composer additions
            ChatEvent.OpenComposerActionSheet -> updateState { copy(composerActionSheetOpen = true) }
            ChatEvent.CloseComposerActionSheet -> updateState { copy(composerActionSheetOpen = false) }
            is ChatEvent.AddAttachment -> updateState { copy(attachments = attachments + event.attachment) }
            is ChatEvent.RemoveAttachment -> updateState { copy(attachments = attachments.filterNot { it.id == event.attachmentId }) }
            ChatEvent.ClearAttachments -> updateState { copy(attachments = emptyList()) }
            is ChatEvent.TogglePlanMode -> updateState { copy(planMode = event.enabled) }

            // Edit turn
            is ChatEvent.StartEditTurn -> updateState {
                copy(
                    editingTurnId = event.messageId,
                    editingTurnText = event.text,
                    composerText = event.text,
                )
            }
            ChatEvent.CancelEditTurn -> updateState { copy(editingTurnId = null, editingTurnText = null) }
            is ChatEvent.SubmitEditTurn -> {
                updateState {
                    copy(
                        editingTurnId = null,
                        editingTurnText = null,
                        composerText = event.text,
                        attachments = event.attachments,
                    )
                }
                resendEditedMessage(event.messageId, event.text, event.attachments)
            }
            is ChatEvent.ResendQueuedMessage -> resendQueuedMessage(event.messageId, event.text, event.attachments)

            // Queued messages & Steer
            is ChatEvent.QueueMessage -> {
                updateState { copy(composerText = event.text) }
                sendMessage()
            }
            is ChatEvent.RemoveQueuedMessage -> removeQueuedMessage(event.messageId)
            is ChatEvent.SteerMessage -> steerQueuedMessage(event.messageId)

            // Decision Question Card
            is ChatEvent.SelectDecisionOption -> selectDecisionOption(event.questionId, event.optionIndex, event.questionIndex)
            is ChatEvent.DecisionWriteInChanged -> updateState {
                val current = activeDecision
                if (current != null && current.id == event.questionId) {
                    if ((current.questionGroups.size > 1 || current.questionGroups.any { it.isMultiSelect }) && event.questionIndex in current.questionGroups.indices) {
                        copy(activeDecision = current.copy(
                            customByQuestion = current.customByQuestion + (event.questionIndex to event.text),
                            selectedByQuestion = if (event.text.isNotEmpty()) current.selectedByQuestion - event.questionIndex else current.selectedByQuestion,
                        ))
                    } else copy(activeDecision = current.copy(writeInText = event.text))
                } else this
            }
            is ChatEvent.SubmitDecision -> submitDecision(event.questionId)

            // Run Sheet & Diff
            ChatEvent.OpenRunSheet -> updateState { copy(runSheetOpen = true) }
            ChatEvent.CloseRunSheet -> updateState { copy(runSheetOpen = false) }
            is ChatEvent.OpenDiffViewer -> updateState { copy(selectedDiffFile = event.file) }
            ChatEvent.CloseDiffViewer -> updateState { copy(selectedDiffFile = null) }
        }
    }

    private fun requireSessionId(): String = mutableState.value.sessionId
        ?: error("Open a session before using session actions")

    private fun runListedSessionAction(sessionId: String, fallback: String, action: suspend (SessionRepository) -> Unit) {
        val captured = listedSessionActionTarget
        listedSessionActionTarget = null
        if (captured == null || captured.second != sessionId || activeRepository() !== captured.first ||
            knownSessionsRepository !== captured.first || knownSessions.none { it.id == sessionId }) {
            showError(IllegalStateException("The session or computer changed; reopen the menu and try again"), fallback)
            return
        }
        val fixed = captured.first
        viewModelScope.launch {
            try {
                action(fixed)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (activeRepository() === fixed) showError(error, fallback)
            }
        }
    }

    private fun runListedProjectAction(projectId: String, fallback: String, action: suspend (SessionRepository) -> Unit) {
        val captured = listedProjectActionTarget
        listedProjectActionTarget = null
        if (captured == null || captured.second != projectId || activeRepository() !== captured.first) {
            showError(IllegalStateException("The project or computer changed; reopen the menu and try again"), fallback)
            return
        }
        val fixed = captured.first
        viewModelScope.launch {
            try { action(fixed) } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) { if (activeRepository() === fixed) showError(error, fallback) }
        }
    }

    private fun runSessionAction(fallback: String, action: suspend () -> Unit) {
        if (mutableState.value.sessionId == null) return
        updateState { copy(sessionActionInProgress = true, sessionMenuOpen = false, error = null) }
        viewModelScope.launch {
            runCatching { action() }
                .onFailure { showError(it, fallback) }
                .also { updateState { copy(sessionActionInProgress = false) } }
        }
    }

    private fun forkSession() {
        if (mutableState.value.sessionId == null) return
        updateState { copy(sessionActionInProgress = true, sessionMenuOpen = false, error = null) }
        viewModelScope.launch {
            runCatching { repository.forkSession(requireSessionId()) }
                .onSuccess { forked -> selectSession(forked.id) }
                .onFailure { showError(it, "Session could not be forked") }
                .also { updateState { copy(sessionActionInProgress = false) } }
        }
    }

    private fun forkFromMessage(anchorSeq: Long, mode: String) {
        if (mutableState.value.sessionId == null || anchorSeq <= 0) return
        updateState { copy(sessionActionInProgress = true, sessionMenuOpen = false, error = null) }
        viewModelScope.launch {
            runCatching { repository.forkSessionAt(requireSessionId(), anchorSeq, mode) }
                .onSuccess { forked -> selectSession(forked.id) }
                .onFailure { showError(it, "Message could not be forked") }
                .also { updateState { copy(sessionActionInProgress = false) } }
        }
    }

    private fun regenerateMessage(parentRequestId: String) {
        val current = mutableState.value
        val sessionId = current.sessionId ?: return
        if (parentRequestId.isBlank() || current.runStatus == AgentRunStatus.Working) return
        updateState { copy(isLoading = true, error = null, runStatus = AgentRunStatus.Working) }
        viewModelScope.launch {
            try {
                repository.regenerateMessage(sessionId, parentRequestId)
                refreshSession(sessionId)
            } catch (error: Throwable) {
                showError(error, "Message could not be regenerated")
            } finally {
                val status = knownSessions.firstOrNull { it.id == sessionId }?.status?.toAgentStatus()
                    ?: AgentRunStatus.Idle
                updateState { copy(isLoading = false, runStatus = status) }
            }
        }
    }

    private fun resendEditedMessage(
        parentRequestId: String,
        editedText: String,
        replacementAttachments: List<ComposerAttachment> = mutableState.value.attachments,
    ) {
        val current = mutableState.value
        val sessionId = current.sessionId ?: return
        val prompt = editedText.trim()
        if (parentRequestId.isBlank() || prompt.isBlank()) return
        if (current.connection != AgentConnectionStatus.Connected) {
            publishError("Connect a computer before editing a message.", clearWhenConnected = true)
            return
        }
        val selection = RuntimeSelection(
            tool = current.runtimeTool,
            providerProfile = current.runtimeProvider,
            model = current.runtimeModel,
            effort = current.selectedEffort,
            serviceTier = current.serviceTier,
            interactionMode = if (current.planMode) "plan" else "agent",
            permissionMode = if (current.planMode && (current.runtimeTool == "claude" || current.runtimeTool == "claude-bidi")) "plan" else null,
        )
        updateState {
            copy(
                composerText = "",
                editingTurnId = null,
                editingTurnText = null,
                isLoading = true,
                error = null,
                runStatus = AgentRunStatus.Working,
            )
        }
        viewModelScope.launch {
            try {
                val outboundAttachments = replacementAttachments.map { attachment ->
                    OutboundAttachment(
                        contentUri = attachment.localPath.orEmpty(),
                        originalName = attachment.name,
                        mimeType = attachment.mimeType,
                        sizeBytes = attachment.sizeBytes,
                        assetId = attachment.assetId,
                    )
                }
                if (selection.effort == null && selection.model != null) repository.updateRuntimeSelection(
                    sessionId, selection.tool, selection.providerProfile, selection.model, null, selection.serviceTier,
                )
                repository.resendEditedMessage(
                    sessionId = sessionId,
                    parentRequestId = parentRequestId,
                    prompt = prompt,
                    selection = selection,
                    attachments = outboundAttachments,
                )
                refreshSession(sessionId)
            } catch (error: Throwable) {
                showError(error, "Edited message could not be resent")
            } finally {
                val status = knownSessions.firstOrNull { it.id == sessionId }?.status?.toAgentStatus()
                    ?: AgentRunStatus.Idle
                updateState { copy(isLoading = false, runStatus = status) }
            }
        }
    }

    private fun sendMessage() {
        val current = mutableState.value
        if (current.runtimeResolving) return
        if (current.sessionId != null && selectedRepository !== activeRepository()) return
        val fixed = activeRepository() ?: return
        val rawText = current.composerText.trim()
        if (rawText.isBlank() && current.attachments.isEmpty()) return
        // Keep one in-flight optimistic turn per session. For an active run,
        // the server owns the durable follow-up queue. A follow-up composed
        // before the first POST returns is retained and submitted immediately
        // after acknowledgement, preserving request order and its local echo.
        if (current.pendingTurn != null) {
            if (current.pendingTurn.state == PendingTurnState.Sending) {
                sendAfterPendingTurn = true
            }
            return
        }
        if (current.connection != AgentConnectionStatus.Connected) {
            publishError("Connect a computer before sending a message.", clearWhenConnected = true)
            return
        }
        rememberCurrentRuntime()

        val isPendingGoal = current.goalMode && current.goalText.isBlank()
        val effectiveGoalText = if (isPendingGoal) rawText else current.goalText
        val nextAutoContinue = if (isPendingGoal) true else current.autoContinue

        // The Web contract carries plan/interaction modes as structured fields.
        // Android has no corresponding request state yet, so never smuggle a
        // fake --plan command into the user's prompt.
        val textToSend = rawText.ifBlank { "(attachment)" }
        val selection = RuntimeSelection(
            tool = current.runtimeTool,
            providerProfile = current.runtimeProvider,
            model = current.runtimeModel,
            effort = current.selectedEffort,
            serviceTier = current.serviceTier,
            interactionMode = if (current.planMode) "plan" else "agent",
            permissionMode = if (current.planMode && (current.runtimeTool == "claude" || current.runtimeTool == "claude-bidi")) "plan" else null,
        )
        val pendingTurn = PendingTurnUiState(
            requestId = newRequestId(),
            text = textToSend,
            attachments = current.attachments,
            selection = selection,
            agentId = current.selectedAgentId,
            goalToPersist = effectiveGoalText.takeIf { isPendingGoal && it.isNotBlank() },
        )
        if (current.sessionId != null) sessionPendingTurns[fixed to current.sessionId] = pendingTurn
        else {
            selectedRepository = fixed
            newSessionRequested = true
        }
        selectedRepository?.let { fixed -> current.sessionId?.let { sessionDrafts.remove(fixed to it) } }
        updateState {
            copy(
                composerText = "",
                attachments = emptyList(),
                editingTurnId = null,
                editingTurnText = null,
                isLoading = true,
                error = null,
                runStatus = AgentRunStatus.Working,
                goalText = effectiveGoalText,
                autoContinue = nextAutoContinue,
                pendingTurn = pendingTurn,
            )
        }
        deliverPendingTurn(
            pendingTurn = pendingTurn,
            initialSessionId = current.sessionId,
        )
    }

    private fun retryPendingTurn() {
        val pendingTurn = mutableState.value.pendingTurn ?: return
        if (pendingTurn.state != PendingTurnState.Failed) return
        val fixed = activeRepository() ?: return
        if (selectedRepository !== fixed) return
        val sessionId = mutableState.value.sessionId
        if (sessionId != null && sessionPendingTurns[fixed to sessionId]?.requestId != pendingTurn.requestId) return
        val sending = pendingTurn.copy(state = PendingTurnState.Sending, error = null)
        if (sessionId != null) sessionPendingTurns[fixed to sessionId] = sending
        updateState { copy(pendingTurn = sending, error = null, isLoading = true) }
        deliverPendingTurn(
            pendingTurn = sending,
            initialSessionId = sessionId,
        )
    }

    private fun deliverPendingTurn(
        pendingTurn: PendingTurnUiState,
        initialSessionId: String?,
    ) {
        val fixed = activeRepository() ?: return
        // Resolve once before launching, and use this computer for every stage.
        // The UI proxy is allowed to change while a goal/upload/POST is awaiting.
        if (initialSessionId != null && fixed !== selectedRepository) return
        val initialGeneration = sessionGeneration
        viewModelScope.launch {
            var sessionId = initialSessionId
            var generation = initialGeneration
            try {
                val resolvedSessionId = sessionId
                    ?: fixed.createSession(name = "", tool = pendingTurn.selection.tool).id.also {
                        sessionPendingTurns[fixed to it] = pendingTurn
                        if (activeRepository() === fixed && sessionGeneration == initialGeneration) {
                            val followUpRequested = sendAfterPendingTurn
                            selectSession(it)
                            sendAfterPendingTurn = followUpRequested
                            generation = sessionGeneration
                        }
                    }
                sessionId = resolvedSessionId
                if (!pendingTurn.agentId.isNullOrBlank()
                    && knownSessionsRepository === fixed
                    && knownSessions.firstOrNull { it.id == resolvedSessionId }?.latestSeq == 0L
                ) {
                    runCatching { fixed.bindAgent(resolvedSessionId, pendingTurn.agentId) }
                        .onFailure { error ->
                            if ((error as? SessionRepositoryException)?.statusCode != 409) throw error
                        }
                }
                // The structured message payload is authoritative for this run.
                // Persisting the picker choice is useful, but must never delay
                // the user's local echo or the message POST.
                suspend fun persistRuntimeSelection() {
                    fixed.updateRuntimeSelection(
                        resolvedSessionId,
                        pendingTurn.selection.tool,
                        pendingTurn.selection.providerProfile,
                        pendingTurn.selection.model,
                        pendingTurn.selection.effort,
                        pendingTurn.selection.serviceTier,
                    )
                    fixed.runtimeTargetId?.let { id -> runCatching { writeRuntimeCache(id, resolvedSessionId, pendingTurn.selection) } }
                }
                if (pendingTurn.selection.effort == null && pendingTurn.selection.model != null) {
                    // The server can otherwise inherit an old session effort for
                    // a newly selected model which has no configurable levels.
                    persistRuntimeSelection()
                } else if (pendingTurn.selection.effort != null) launch {
                    runCatching {
                        persistRuntimeSelection()
                    }
                }
                if (pendingTurn.goalToPersist != null) {
                    runCatching {
                        fixed.updateSessionGoal(resolvedSessionId, pendingTurn.goalToPersist, autoContinue = true)
                    }
                }
                val outboundAttachments = pendingTurn.attachments.map { attachment ->
                    OutboundAttachment(
                        contentUri = attachment.localPath.orEmpty(),
                        originalName = attachment.name,
                        mimeType = attachment.mimeType,
                        sizeBytes = attachment.sizeBytes,
                        assetId = attachment.assetId,
                    )
                }
                fixed.sendMessage(
                    sessionId = resolvedSessionId,
                    text = pendingTurn.text,
                    selection = pendingTurn.selection,
                    requestId = pendingTurn.requestId,
                    agentId = pendingTurn.agentId,
                    attachments = outboundAttachments,
                )
                // Once the POST succeeds, this one-shot guard has completed
                // its job. Keeping it through an active run hides Stop and
                // rejects every subsequent follow-up, even though the server
                // has already accepted the message. Timeline observation
                // reconciles the durable local echo by request id.
                val acceptedRequestId = pendingTurn.requestId
                val key = fixed to resolvedSessionId
                val queuedIds = knownSessions.takeIf { knownSessionsRepository === fixed }
                    ?.firstOrNull { it.id == resolvedSessionId }?.queuedMessages?.map { it.requestId }.orEmpty()
                if (acceptedRequestId !in sessionObservedRequests[key].orEmpty()) {
                    sessionAcceptedTurns[key] = (sessionAcceptedTurns[key].orEmpty() + pendingTurn.copy(state = PendingTurnState.Accepted, error = null))
                        .distinctBy { it.requestId }
                }
                if (sessionPendingTurns[key]?.requestId == acceptedRequestId) {
                    sessionPendingTurns.remove(fixed to resolvedSessionId)
                }
                if (isCurrentSession(resolvedSessionId) && selectedRepository === fixed) updateState {
                    if (this.pendingTurn?.requestId == acceptedRequestId) {
                        copy(pendingTurn = null, acceptedTurns = sessionAcceptedTurns[key].orEmpty().filterNot { it.requestId in queuedIds }, historyLoading = false)
                    } else {
                        this
                    }
                }
                if (isCurrentSession(resolvedSessionId) && selectedRepository === fixed && sendAfterPendingTurn) {
                    sendAfterPendingTurn = false
                    sendMessage()
                }
                // The repository already refreshes session metadata after the
                // POST. Timeline reconciliation runs off the socket; this
                // background pull only covers endpoint-less foreground use.
                launch { runCatching { fixed.refreshTimeline(resolvedSessionId) } }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                val failed = pendingTurn.copy(state = PendingTurnState.Failed,
                    error = error.message?.takeIf { it.isNotBlank() } ?: "Message could not be sent")
                val failedSessionId = sessionId
                if (failedSessionId != null) {
                    if (sessionPendingTurns[fixed to failedSessionId]?.requestId != pendingTurn.requestId) return@launch
                    sessionPendingTurns[fixed to failedSessionId] = failed
                }
                if (activeRepository() !== fixed || selectedRepository !== fixed ||
                    (failedSessionId != null && mutableState.value.sessionId != failedSessionId) ||
                    (failedSessionId == null && (sessionGeneration != generation || mutableState.value.sessionId != null)) ||
                    mutableState.value.pendingTurn?.requestId != pendingTurn.requestId) return@launch
                sendAfterPendingTurn = false
                updateState {
                    copy(
                        pendingTurn = failed,
                        error = "Message could not be sent: ${failed.error}",
                    )
                }
            } finally {
                if (activeRepository() === fixed && selectedRepository === fixed &&
                    (sessionId != null && mutableState.value.sessionId == sessionId ||
                        sessionId == null && mutableState.value.sessionId == null && sessionGeneration == generation)) {
                    val currentStatus = knownSessions.firstOrNull { it.id == sessionId }?.status?.toAgentStatus() ?: AgentRunStatus.Idle
                    updateState { copy(isLoading = this.pendingTurn?.state == PendingTurnState.Sending,
                        runStatus = if (this.pendingTurn?.state == PendingTurnState.Sending) AgentRunStatus.Working else currentStatus) }
                }
            }
        }
    }

    private fun steerQueuedMessage(messageId: String) {
        val current = mutableState.value
        val target = current.queuedMessages.firstOrNull { it.id == messageId } ?: return
        val sessionId = current.sessionId ?: return

        viewModelScope.launch {
            try {
                repository.steerQueuedFollowUp(sessionId, target.id)
                refreshSession(sessionId)
            } catch (error: Throwable) {
                showError(error, "Queued follow-up could not be steered")
            }
        }
    }

    private fun forgetAcceptedQueuedMessage(fixed: SessionRepository, sessionId: String, requestId: String) {
        val key = fixed to sessionId
        sessionAcceptedTurns[key] = sessionAcceptedTurns[key].orEmpty().filterNot { it.requestId == requestId }
        if (mutableState.value.sessionId == sessionId && activeRepository() === fixed) updateState {
            copy(acceptedTurns = acceptedTurns.filterNot { it.requestId == requestId })
        }
    }

    private fun removeQueuedMessage(messageId: String) {
        val sessionId = mutableState.value.sessionId ?: return
        val fixed = activeRepository() ?: return
        if (messageId.isBlank()) return
        viewModelScope.launch {
            try {
                fixed.updateQueuedFollowUp(
                    sessionId = sessionId,
                    action = com.andysagent.agentoc.core.domain.QueuedFollowUpAction.Delete,
                    requestId = messageId,
                )
                forgetAcceptedQueuedMessage(fixed, sessionId, messageId)
                refreshSession(sessionId)
            } catch (error: Throwable) {
                showError(error, "Queued follow-up could not be removed")
            }
        }
    }

    /**
     * The current server contract has no edit-in-place mutation for queued
     * follow-ups. Keep the durable item untouched while the composer is open;
     * after Send, remove it and submit the edited draft through the normal
     * message path. Cancelling the editor therefore cannot lose the queue item.
     */
    private fun resendQueuedMessage(
        messageId: String,
        editedText: String,
        replacementAttachments: List<ComposerAttachment>,
    ) {
        val current = mutableState.value
        val sessionId = current.sessionId ?: return
        val fixed = activeRepository() ?: return
        if (messageId.isBlank() || (editedText.trim().isBlank() && replacementAttachments.isEmpty())) return
        if (current.queuedMessages.none { it.id == messageId }) return
        if (current.connection != AgentConnectionStatus.Connected) {
            publishError("Connect a computer before resending a queued message.", clearWhenConnected = true)
            return
        }

        updateState {
            copy(
                composerText = editedText,
                attachments = replacementAttachments,
                editingTurnId = null,
                editingTurnText = null,
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                fixed.updateQueuedFollowUp(
                    sessionId = sessionId,
                    action = com.andysagent.agentoc.core.domain.QueuedFollowUpAction.Delete,
                    requestId = messageId,
                )
                forgetAcceptedQueuedMessage(fixed, sessionId, messageId)
                if (mutableState.value.sessionId != sessionId || activeRepository() !== fixed) return@launch
                // sendMessage owns optimistic state, attachment publishing and
                // the server queue projection for active and idle runs alike.
                sendMessage()
            } catch (error: Throwable) {
                showError(error, "Queued message could not be replaced")
            }
        }
    }

    private fun selectDecisionOption(questionId: String, optionIndex: Int, questionIndex: Int = 0) {
        val current = mutableState.value.activeDecision ?: return
        if (current.id != questionId || current.isSubmitted || current.isSubmitting) return

        if (current.questionGroups.size > 1 || current.questionGroups.any { it.isMultiSelect }) {
            if (questionIndex !in current.questionGroups.indices || optionIndex !in current.questionGroups[questionIndex].options.indices) return
            if (current.questionGroups[questionIndex].isMultiSelect) {
                val selected = current.multiSelectedByQuestion[questionIndex].orEmpty()
                val next = if (optionIndex in selected) selected - optionIndex else selected + optionIndex
                updateState { copy(activeDecision = current.copy(multiSelectedByQuestion = current.multiSelectedByQuestion + (questionIndex to next))) }
                return
            }
            updateState { copy(activeDecision = current.copy(
                selectedByQuestion = current.selectedByQuestion + (questionIndex to optionIndex),
                customByQuestion = current.customByQuestion - questionIndex,
            )) }
            return
        }

        val newIndices = if (current.isMultiSelect) {
            if (current.selectedIndices.contains(optionIndex)) {
                current.selectedIndices - optionIndex
            } else {
                current.selectedIndices + optionIndex
            }
        } else {
            setOf(optionIndex)
        }
        updateState { copy(activeDecision = current.copy(selectedIndices = newIndices)) }
    }

    private fun submitDecision(questionId: String) {
        val currentDecision = mutableState.value.activeDecision ?: return
        if (currentDecision.id != questionId || currentDecision.isSubmitted || currentDecision.isSubmitting) return
        val sessionId = mutableState.value.sessionId ?: return

        if (currentDecision.questionGroups.size > 1 || currentDecision.questionGroups.any { it.isMultiSelect }) {
            val fixed = selectedRepository ?: return
            val choices = currentDecision.questionGroups.indices.map { currentDecision.selectedByQuestion[it] ?: -1 }
            val selections = currentDecision.questionGroups.indices.map { index ->
                if (currentDecision.questionGroups[index].isMultiSelect) currentDecision.multiSelectedByQuestion[index].orEmpty().sorted()
                else currentDecision.selectedByQuestion[index]?.let { listOf(it) }.orEmpty()
            }
            val answers = currentDecision.questionGroups.indices.map { currentDecision.customByQuestion[it].orEmpty().trim() }
            if (selections.indices.any { selections[it].isEmpty() && answers[it].isBlank() }) return
            updateState { copy(activeDecision = currentDecision.copy(isSubmitting = true, submissionError = null)) }
            viewModelScope.launch {
                val coordinator = ApprovalResolutionCoordinator(fixed)
                val outcome = if (currentDecision.questionGroups.any { it.isMultiSelect })
                    coordinator.resolveMultiChoiceQuestions(sessionId, currentDecision.approvalId, selections, answers)
                else coordinator.resolveQuestionsApproval(sessionId, currentDecision.approvalId, choices, customAnswers = answers)
                if (!isCurrentSession(sessionId) || mutableState.value.activeDecision?.id != questionId) return@launch
                when (outcome) {
                    ApprovalResolutionCoordinator.Outcome.Submitted -> {
                        updateState { copy(activeDecision = currentDecision.copy(isSubmitting = false, isSubmitted = true)) }
                        refreshSession(sessionId)
                    }
                    else -> {
                        val message = when (outcome) {
                            is ApprovalResolutionCoordinator.Outcome.Failed -> outcome.message
                            ApprovalResolutionCoordinator.Outcome.Stale -> "This request is no longer pending."
                            else -> "This request requires additional verification."
                        }
                        updateState { copy(activeDecision = currentDecision.copy(isSubmitting = false, submissionError = message)) }
                    }
                }
            }
            return
        }

        if (currentDecision.selectedIndices.size > 1) {
            updateState { copy(activeDecision = currentDecision.copy(submissionError = "This question requires a supported multiple-choice response.")) }
            return
        }
        // Runtime approvals expect one positional option index per question,
        // not the option label or value shown in the interface.
        val selectedChoices = currentDecision.selectedIndices.singleOrNull()?.let { listOf(it.toString()) }.orEmpty()
        val customAnswer = currentDecision.writeInText.trim().takeIf { it.isNotBlank() }
        if (selectedChoices.isEmpty() && customAnswer == null) return

        updateState {
            copy(
                activeDecision = currentDecision.copy(isSubmitting = true, submissionError = null),
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                val requestId = newRequestId()
                val runId = currentDecision.runId
                if (runId != null) {
                    repository.resolveRuntimeApproval(
                        runId = runId,
                        approvalId = currentDecision.approvalId,
                        decision = "approve",
                        choices = selectedChoices,
                        customAnswer = customAnswer,
                        requestId = requestId,
                    )
                } else {
                    repository.decideConfirmation(
                        sessionId = sessionId,
                        confirmationId = currentDecision.approvalId,
                        decision = "approve",
                        requestId = requestId,
                    )
                }
                updateState {
                    copy(activeDecision = currentDecision.copy(isSubmitting = false, isSubmitted = true))
                }
                refreshSession(sessionId)
            } catch (error: Throwable) {
                updateState {
                    copy(
                        activeDecision = currentDecision.copy(
                            isSubmitting = false,
                            submissionError = error.message ?: "Decision could not be submitted",
                        ),
                    )
                }
                showError(error, "Decision answer could not be sent")
            }
        }
    }

    private fun createSession(projectId: String?) {
        val fixed = activeRepository() ?: return
        saveSelectedDraft()
        selectedSessionJob?.cancel()
        selectedSessionJob = null
        val generation = ++sessionGeneration
        selectedRepository = fixed
        newSessionRequested = true
        sendAfterPendingTurn = false
        updateState {
            copy(
                sessionId = null,
                pendingTurn = null,
                acceptedTurns = emptyList(),
                composerText = "",
                goalText = "",
                sessionTitle = "New session",
                runStatus = AgentRunStatus.Idle,
                timelineItems = emptyList(),
                historyLoading = false,
                timelineSessionId = null,
                messageCount = 0,
                unseenCount = 0,
                loadingOlder = false,
                hasOlder = false,
                approval = null,
                resolvingApprovalId = null,
                error = null,
                isLoading = true,
                queuedMessages = emptyList(),
                activeDecision = null,
                attachments = emptyList(),
                editingTurnId = null,
                editingTurnText = null,
                runSheetOpen = false,
                selectedDiffFile = null,
                stepTraces = emptyList(),
                changedFiles = emptyList(),
                runMetrics = RunMetricsUiState(),
            )
        }
        viewModelScope.launch {
            try {
                val session = fixed.createSessionInProject(projectId, name = "")
                if (activeRepository() === fixed && sessionGeneration == generation && mutableState.value.sessionId == null) {
                    selectSession(session.id)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (activeRepository() === fixed && sessionGeneration == generation) showError(error, "Session could not be created")
            } finally {
                if (activeRepository() === fixed && sessionGeneration == generation) updateState { copy(isLoading = false) }
            }
        }
    }

    private fun selectSession(sessionId: String) {
        val fixed = activeRepository() ?: return
        if (selectedRepository === fixed && mutableState.value.sessionId == sessionId && selectedSessionJob?.isActive == true) return
        val computerChanged = selectedRepository !== fixed
        selectedRepository?.let { oldRepository ->
            mutableState.value.sessionId?.let { oldSession ->
                val state = mutableState.value
                sessionRuntimeSelections[oldRepository to oldSession] = RuntimeSelection(
                    state.runtimeTool, state.runtimeProvider, state.runtimeModel,
                    effort = state.selectedEffort, serviceTier = state.serviceTier,
                )
            }
        }
        saveSelectedDraft()
        selectedSessionJob?.cancel()
        val generation = ++sessionGeneration
        durationFetchJob?.cancel()
        durationFetchJob = null
        durationAttempts.clear()
        val editGeneration = ++runtimeEditGeneration
        lastRunProjectionRequest = null
        selectedRepository = fixed
        newSessionRequested = false
        sendAfterPendingTurn = false
        if (computerChanged) {
            sendAfterPendingTurn = false
            runtimeModelLoadJob?.cancel()
            runtimeModelSelectionGeneration++
            runtimeModelCache.clear()
            runtimePickerSnapshot = null
        }
        val restoredDraft = sessionDrafts[fixed to sessionId].orEmpty()
        val restoredPendingTurn = sessionPendingTurns[fixed to sessionId]
        val selectedSession = knownSessions.takeIf { knownSessionsRepository === fixed }?.firstOrNull { it.id == sessionId }
        updateState {
            copy(
                sessionId = sessionId,
                runtimeSelectionDisplay = null,
                runtimeResolving = true,
                sessionTitle = selectedSession?.title?.ifBlank { "New session" } ?: "Session",
                selectedAgentId = selectedSession?.templateId,
                runStatus = selectedSession?.status?.toAgentStatus() ?: AgentRunStatus.Idle,
                composerText = restoredDraft,
                pendingTurn = restoredPendingTurn,
                acceptedTurns = sessionAcceptedTurns[fixed to sessionId].orEmpty().filterNot { accepted -> selectedSession?.queuedMessages.orEmpty().any { it.requestId == accepted.requestId } },
                isLoading = restoredPendingTurn?.state == PendingTurnState.Sending,
                goalText = "",
                // Never display another session's messages under the newly selected title.
                // Show the history loading state until this session's snapshot arrives.
                timelineItems = emptyList(),
                timelineSessionId = null,
                messageCount = 0,
                historyLoading = true,
                approval = null,
                resolvingApprovalId = null,
                error = null,
                queuedMessages = selectedSession?.queuedMessages?.map(::toQueuedMessageUiState).orEmpty(),
                activeDecision = null,
                attachments = emptyList(),
                editingTurnId = null,
                editingTurnText = null,
                runSheetOpen = false,
                selectedDiffFile = null,
                stepTraces = emptyList(),
                changedFiles = emptyList(),
                runMetrics = RunMetricsUiState(status = selectedSession?.status?.toAgentStatus() ?: AgentRunStatus.Idle),
                runDurations = emptyMap(),
                serverRunActivity = null,
                loadingOlder = false,
                hasOlder = false,
            )
        }
        showCachedRuntime(fixed, sessionId, generation, editGeneration)
        selectedSessionJob = viewModelScope.launch {
            launch {
                val restoredCatalog = if (mutableState.value.runtimeCatalog.tools.isEmpty()) {
                    try { fixed.loadRuntimeCatalog() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) {
                        if (isCurrentSession(sessionId, generation) && runtimeEditGeneration == editGeneration) updateState { copy(runtimeResolving = false, runtimeModelsError = "Runtime settings could not be loaded") }
                        return@launch
                    }
                } else mutableState.value.runtimeCatalog
                if (!isCurrentSession(sessionId, generation) || runtimeEditGeneration != editGeneration || mutableState.value.runtimePickerOpen) return@launch
                updateState { copy(runtimeCatalog = mergeRuntimeCatalog(restoredCatalog, runtimeCatalog)) }
                resolveDefaultRuntime(fixed, mutableState.value.runtimeCatalog)
            }
            launch {
                fixed.observeRunActivity(sessionId).collectLatest { activity ->
                    if (isCurrentSession(sessionId, generation)) {
                        updateState { copy(serverRunActivity = activity) }
                        // A terminal status may arrive after the last timeline
                        // item without changing the timeline itself. Refresh
                        // the run when the server transitions to idle so the
                        // final message cannot retain a stale live cursor.
                        if (activity?.get("state")?.jsonPrimitive?.contentOrNull == "idle") {
                            latestTimelineRunId(mutableState.value.timelineItems)?.let { runId ->
                                loadRunProjection(sessionId, runId, generation)
                            }
                        }
                    }
                }
            }
            launch {
                fixed.observeRunDurations(sessionId).collectLatest { durations ->
                    if (isCurrentSession(sessionId, generation)) updateState { copy(runDurations = durations) }
                }
            }
            launch {
                fixed.observeTimeline(sessionId).collectLatest { items ->
                    if (!isCurrentSession(sessionId, generation)) return@collectLatest
                    val operationTextLength = items.sumOf { item ->
                        (item as? TimelineItem.Operation)?.detail?.length ?: 0
                    }
                    val parsedArtifacts = if (
                        items.size >= ARTIFACT_PARSE_OFFLOAD_ITEM_COUNT
                            || operationTextLength >= ARTIFACT_PARSE_OFFLOAD_TEXT_LENGTH
                    ) {
                        withContext(Dispatchers.Default) { parseTimelineArtifacts(sessionId, items, fixed) }
                    } else {
                        parseTimelineArtifacts(sessionId, items, fixed)
                    }
                    val (traces, files) = parsedArtifacts
                    if (!isCurrentSession(sessionId, generation)) return@collectLatest
                    val observedRequests = items.filterIsInstance<TimelineItem.Message>()
                        .filter { it.role == com.andysagent.agentoc.core.timeline.TimelineRole.User }
                        .mapNotNull { it.requestId }.toSet()
                    sessionObservedRequests[fixed to sessionId] = observedRequests
                    sessionAcceptedTurns[fixed to sessionId] = sessionAcceptedTurns[fixed to sessionId].orEmpty()
                        .filterNot { it.requestId in observedRequests }
                    val acknowledgedPendingTurn = mutableState.value.pendingTurn
                        ?.takeIf { pending ->
                            items.any { item ->
                                item is TimelineItem.Message &&
                                    item.role == com.andysagent.agentoc.core.timeline.TimelineRole.User &&
                                    item.requestId == pending.requestId
                            }
                        }
                    if (acknowledgedPendingTurn != null &&
                        sessionPendingTurns[fixed to sessionId]?.requestId == acknowledgedPendingTurn.requestId) {
                        sessionPendingTurns.remove(fixed to sessionId)
                    }
                    updateState {
                        copy(
                            timelineItems = items,
                            timelineSessionId = sessionId,
                            historyLoading = if (items.isNotEmpty()) false else historyLoading,
                            acceptedTurns = sessionAcceptedTurns[fixed to sessionId].orEmpty().filterNot { accepted -> queuedMessages.any { it.id == accepted.requestId } },
                            pendingTurn = pendingTurn?.takeUnless { it == acknowledgedPendingTurn },
                            messageCount = items.size,
                            stepTraces = traces,
                            changedFiles = files,
                            runMetrics = runMetrics.copy(
                                toolCallsCount = traces.size,
                                filesChangedCount = files.size,
                            ),
                        )
                    }
                    fetchHistoricalDurations(fixed, sessionId, generation, items)
                    items.asSequence().mapNotNull { item -> when (item) {
                        is TimelineItem.Message -> item.runId
                        is TimelineItem.Operation -> item.runId
                        is TimelineItem.Plan -> item.runId
                        is TimelineItem.Notice -> null
                    } }
                        .lastOrNull()
                        ?.let { runId ->
                            val now = System.currentTimeMillis()
                            val last = lastRunProjectionRequest
                            if (last?.first != runId || now - last.second >= 1_000L) {
                                lastRunProjectionRequest = runId to now
                                loadRunProjection(sessionId, runId, generation)
                            }
                        }
                }
            }
            launch {
                fixed.observePendingApprovals(sessionId).collectLatest { receivedApprovals ->
                    if (!isCurrentSession(sessionId, generation)) return@collectLatest
                    val approvals = com.andysagent.agentoc.core.model.withoutBatchApprovalShadows(receivedApprovals)
                    val decisionApproval = approvals.firstOrNull { it.toDecisionQuestionUiState() != null }
                    val approval = approvals.firstOrNull { it.id != decisionApproval?.id }?.toUiState()
                    val decision = decisionApproval?.toDecisionQuestionUiState()
                    updateState {
                        val previous = activeDecision?.takeIf {
                            decision != null && it.id == decision.id && it.questionGroups == decision.questionGroups && it.question == decision.question && it.options == decision.options
                        }
                        copy(
                            approval = approval,
                            activeDecision = decision?.let { next -> previous?.let {
                                next.copy(selectedIndices = it.selectedIndices, writeInText = it.writeInText,
                                    selectedByQuestion = it.selectedByQuestion, multiSelectedByQuestion = it.multiSelectedByQuestion, customByQuestion = it.customByQuestion,
                                    isSubmitted = it.isSubmitted, isSubmitting = it.isSubmitting, submissionError = it.submissionError)
                            } ?: next },
                            resolvingApprovalId = resolvingApprovalId?.takeIf { it == approval?.id },
                        )
                    }
                }
            }
            launch {
                fixed.observeTimelinePaging(sessionId).collectLatest { paging ->
                    if (isCurrentSession(sessionId, generation)) {
                        updateState {
                            copy(
                                loadingOlder = paging.loadingOlder,
                                hasOlder = paging.hasOlder,
                                error = paging.error ?: error,
                            )
                        }
                    }
                }
            }
            refreshSession(sessionId, generation)
        }
    }

    private fun isCurrentSession(sessionId: String, generation: Long? = null): Boolean =
        selectedRepository != null && selectedRepository === activeRepository() && mutableState.value.sessionId == sessionId &&
            (generation == null || sessionGeneration == generation)

    private fun parseTimelineArtifacts(
        sessionId: String,
        items: List<TimelineItem>,
        fixed: SessionRepository,
    ): Pair<List<StepTraceItem>, List<FileDiffDetail>> = synchronized(artifactProjectionLock) {
        if (artifactProjectionRepository === fixed && artifactProjectionSessionId == sessionId && onlyNonOperationTailChanged(items)) {
            artifactProjectionTimeline = items
            return@synchronized cachedStepTraces to cachedChangedFiles
        }
        val traces = mutableListOf<StepTraceItem>()
        val files = mutableListOf<FileDiffDetail>()
        var stepIndex = 1
        val currentTurnStart = items.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User }.coerceAtLeast(0)

        for ((index, item) in items.withIndex()) {
            if (item is TimelineItem.Operation) {
                traces.add(
                    StepTraceItem(
                        stepIndex = stepIndex++,
                        toolName = item.kind.name,
                        title = item.title,
                        detail = item.detail,
                        status = item.status.name.lowercase(),
                    )
                )
                if (index >= currentTurnStart && (item.kind == TimelineOperationKind.FileEdit || item.kind == TimelineOperationKind.Diff) &&
                    item.status == com.andysagent.agentoc.core.timeline.TimelineOperationStatus.Completed &&
                    !item.requiresApproval && (item.exitCode == null || item.exitCode == 0)) {
                    val explicitChanges = item.fileChanges.filter { it.path.isNotBlank() }
                    if (explicitChanges.isNotEmpty()) {
                        files += explicitChanges.map { change ->
                            FileDiffDetail(
                                path = change.path,
                                additions = change.additions,
                                deletions = change.deletions,
                                diffContent = item.detail.ifBlank { change.diffSummary },
                            )
                        }
                    }
                }
            }
        }
        artifactProjectionSessionId = sessionId
        artifactProjectionRepository = fixed
        artifactProjectionTimeline = items
        cachedStepTraces = traces
        cachedChangedFiles = files.distinctBy { it.path }
        traces to cachedChangedFiles
    }

    /** Live text deltas normally replace only the final assistant message. */
    private fun onlyNonOperationTailChanged(items: List<TimelineItem>): Boolean {
        val previous = artifactProjectionTimeline
        if (previous.isEmpty() || items.isEmpty()) return false
        val previousTurn = previous.lastOrNull { it is TimelineItem.Message && it.role == TimelineRole.User }?.id
        val currentTurn = items.lastOrNull { it is TimelineItem.Message && it.role == TimelineRole.User }?.id
        if (previousTurn != currentTurn) return false
        val sharedCount = minOf(previous.size, items.size)
        var changedAt = sharedCount
        for (index in 0 until sharedCount) {
            if (previous[index] !== items[index]) {
                changedAt = index
                break
            }
        }
        if (changedAt == sharedCount && previous.size == items.size) return true
        for (index in changedAt until previous.size) {
            if (previous[index] is TimelineItem.Operation) return false
        }
        for (index in changedAt until items.size) {
            if (items[index] is TimelineItem.Operation) return false
        }
        return true
    }

    private fun loadRunProjection(sessionId: String, runId: String, expectedGeneration: Long? = null) {
        val fixed = selectedRepository ?: return
        val generation = expectedGeneration ?: sessionGeneration
        viewModelScope.launch {
            try {
                if (!isCurrentSession(sessionId, generation)) return@launch
                val projection = fixed.loadRunProjection(runId)
                if (isCurrentSession(sessionId, generation) && latestTimelineRunId(mutableState.value.timelineItems) == runId) {
                    updateRunMetricsFromProjection(projection, runId)
                    completedRunDuration(projection)?.let { fixed.saveRunDuration(sessionId, runId, it) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Throwable) {
                // The timeline remains usable when a completed run has expired.
            }
        }
    }

    private fun fetchHistoricalDurations(fixed: SessionRepository, sessionId: String, generation: Long, items: List<TimelineItem>) {
        if (durationFetchJob?.isActive == true) return
        val known = mutableState.value.runDurations
        val runIds = items.mapNotNull { item -> when (item) {
            is TimelineItem.Message -> item.runId
            is TimelineItem.Operation -> item.runId
            is TimelineItem.Plan -> item.runId
            is TimelineItem.Notice -> null
        } }.filter(String::isNotBlank).distinct().asReversed().filter { runId ->
            val now = System.nanoTime() / 1_000_000L
            runId !in known && durationAttempts[runId]?.let { now - it < 30_000L } != true
        }
        if (runIds.isEmpty()) return
        val job = viewModelScope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            for (runId in runIds) {
                if (!isCurrentSession(sessionId, generation)) return@launch
                if (runId in known || runId in mutableState.value.runDurations) continue
                val now = System.nanoTime() / 1_000_000L
                if (durationAttempts[runId]?.let { now - it < 30_000L } == true) continue
                durationAttempts[runId] = now
                try {
                    val projection = fixed.loadRunProjection(runId)
                    val duration = completedRunDuration(projection)
                    if (duration != null && isCurrentSession(sessionId, generation)) {
                        fixed.saveRunDuration(sessionId, runId, duration)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    // Offline or expired runs retain any previously saved duration.
                }
            }
        }
        durationFetchJob = job
        job.invokeOnCompletion {
            if (durationFetchJob === job) {
                durationFetchJob = null
                if (isCurrentSession(sessionId, generation)) {
                    fetchHistoricalDurations(fixed, sessionId, generation, mutableState.value.timelineItems)
                }
            }
        }
        job.start()
    }

    private fun completedRunDuration(projection: JsonObject): Long? {
        val state = projection.stringValue("state") ?: projection.stringValue("status")
        if (state?.lowercase() !in setOf("completed", "finished", "succeeded", "success", "failed", "error", "interrupted", "cancelled", "canceled")) return null
        val started = projection.timestampValue("startedAt") ?: projection.timestampValue("createdAt")
        val ended = projection.timestampValue("finishedAt") ?: projection.timestampValue("completedAt") ?: projection.timestampValue("finalizedAt")
        return (projection.longValue("durationMs") ?: if (started != null && ended != null) ended - started else null)?.takeIf { it >= 0 }
    }

    private fun updateRunMetricsFromProjection(projection: JsonObject, runId: String) {
        val state = projection.stringValue("state") ?: projection.stringValue("status")
        val started = projection.timestampValue("startedAt") ?: projection.timestampValue("createdAt")
        val finished = projection.timestampValue("finishedAt")
            ?: projection.timestampValue("completedAt")
            ?: projection.timestampValue("finalizedAt")
        val duration = projection.longValue("durationMs") ?: if (started != null && finished != null) finished - started else null
        val usage = projection["usage"] as? JsonObject
        updateState {
            val incomingStatus = state?.toRunStatus()
            if (!shouldAcceptRunProjection(runMetrics, runId, incomingStatus)) return@updateState this
            copy(runMetrics = runMetrics.copy(
                runId = runId,
                phase = projection.stringValue("phase"),
                provider = projection.stringValue("provider"),
                model = projection.stringValue("model"),
                runtimeFamily = projection.stringValue("runtimeFamily"),
                failureReason = projection.stringValue("failureReason") ?: projection.stringValue("error"),
                durationFormatted = duration?.let(::formatDuration) ?: runMetrics.durationFormatted,
                promptTokens = (projection.longValue("promptTokens") ?: usage?.longValue("promptTokens"))?.toInt() ?: runMetrics.promptTokens,
                completionTokens = (projection.longValue("completionTokens") ?: usage?.longValue("completionTokens"))?.toInt() ?: runMetrics.completionTokens,
                status = incomingStatus ?: runMetrics.status,
            ))
        }
    }

    private fun JsonObject.stringValue(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }

    private fun JsonObject.longValue(key: String): Long? = this[key]?.jsonPrimitive?.longOrNull

    private fun JsonObject.timestampValue(key: String): Long? = stringValue(key)?.let { value ->
        value.toLongOrNull() ?: runCatching { java.time.Instant.parse(value).toEpochMilli() }.getOrNull()
    }

    private fun formatDuration(durationMs: Long): String {
        val totalSeconds = (durationMs.coerceAtLeast(0L) / 1000L)
        return "%02d:%02d".format(totalSeconds / 60L, totalSeconds % 60L)
    }

    private fun String.toRunStatus(): AgentRunStatus = when (lowercase()) {
        "working", "running", "started", "in_progress" -> AgentRunStatus.Working
        "waiting_approval", "awaiting_decision" -> AgentRunStatus.WaitingApproval
        "completed", "finished", "success", "succeeded" -> AgentRunStatus.Completed
        "failed", "error" -> AgentRunStatus.Failed
        "cancelled", "canceled", "interrupted" -> AgentRunStatus.Cancelled
        else -> AgentRunStatus.Idle
    }

    private fun refreshRuntimeCatalog() {
        val fixed = activeRepository() ?: return
        viewModelScope.launch {
            runCatching { fixed.loadRuntimeCatalog() }
                .onSuccess { catalog ->
                    if (activeRepository() !== fixed) return@onSuccess
                    val mergedCatalog = mergeRuntimeCatalog(catalog, mutableState.value.runtimeCatalog)
                    updateState { copy(runtimeCatalog = mergedCatalog) }
                    if (!mutableState.value.runtimePickerOpen) resolveDefaultRuntime(fixed, mergedCatalog)
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    if (activeRepository() === fixed) showError(error, "Runtime catalog could not be refreshed")
                }
        }
    }

    private fun selectRuntimeProvider(provider: String?) {
        val fixed = activeRepository() ?: return
        runtimeModelLoadJob?.cancel()
        val selectionGeneration = ++runtimeModelSelectionGeneration
        val toolId = mutableState.value.runtimeTool
        val normalizedProvider = provider?.trim()?.takeIf { it.isNotEmpty() }
        val cacheKey = normalizedProvider?.let { toolId to it }
        val cachedModels = cacheKey?.let { runtimeModelCache[it] }
        updateState {
            copy(
                runtimeProvider = normalizedProvider,
                // Provider selection clears the previous model. The model
                // remains unset until the user explicitly chooses one.
                runtimeModel = null,
                runtimeModelsLoading = normalizedProvider != null && cachedModels == null,
                runtimeModelsError = null,
                serviceTier = "standard",
            )
        }
        if (normalizedProvider == null) return
        if (cachedModels != null) {
            updateRuntimeModels(toolId, cachedModels)
        }
        runtimeModelLoadJob = viewModelScope.launch {
            try {
                val models = fixed.loadRuntimeModels(toolId, normalizedProvider)
                if (activeRepository() !== fixed || selectionGeneration != runtimeModelSelectionGeneration
                    || mutableState.value.runtimeTool != toolId
                    || mutableState.value.runtimeProvider != normalizedProvider
                ) return@launch
                runtimeModelCache[toolId to normalizedProvider] = models
                updateRuntimeModels(toolId, models)
                updateState {
                    copy(
                        runtimeModelsLoading = false,
                        runtimeModelsError = null,
                        runtimeModel = null,
                        serviceTier = "standard",
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (activeRepository() !== fixed || selectionGeneration != runtimeModelSelectionGeneration
                    || mutableState.value.runtimeTool != toolId
                    || mutableState.value.runtimeProvider != normalizedProvider
                ) return@launch
                updateState {
                    copy(
                        runtimeModelsLoading = false,
                        runtimeModelsError = "Models could not be loaded",
                    )
                }
                showError(error, "Runtime models could not be loaded")
            }
        }
    }

    private fun updateRuntimeModels(toolId: String, models: List<RuntimeModelOption>) {
        if (mutableState.value.runtimeCatalog.tools.firstOrNull { it.id == toolId }?.models == models) return
        updateState {
            copy(
                runtimeCatalog = runtimeCatalog.copy(
                    tools = runtimeCatalog.tools.map { tool ->
                        if (tool.id == toolId) tool.copy(models = models) else tool
                    },
                ),
            )
        }
    }

    private fun rememberCurrentRuntime() {
        val current = mutableState.value
        if (current.runtimeModel == null) return
        val selection = RuntimeSelection(current.runtimeTool, current.runtimeProvider, current.runtimeModel,
            effort = current.selectedEffort, serviceTier = current.serviceTier)
        selectedRepository?.let { fixed -> current.sessionId?.let { sessionRuntimeSelections[fixed to it] = selection } }
        val fixed = activeRepository() ?: return
        viewModelScope.launch { runtimeSaveMutex.withLock { runCatching {
            fixed.saveGlobalRuntimeSelection(selection)
            fixed.runtimeTargetId?.let { writeRuntimeCache(it, null, selection) }
        } } }
    }

    private fun showCachedRuntime(fixed: SessionRepository, sessionId: String?, generation: Long, editGeneration: Long) {
        val target = fixed.runtimeTargetId ?: return
        viewModelScope.launch {
            val cached = sessionId?.let { runCatching { readRuntimeCache(target, it) }.getOrNull() }
                ?: runCatching { readRuntimeCache(target, null) }.getOrNull() ?: return@launch
            if (activeRepository() !== fixed || generation != sessionGeneration || runtimeEditGeneration != editGeneration ||
                mutableState.value.sessionId != sessionId || !mutableState.value.runtimeResolving || mutableState.value.runtimePickerOpen) return@launch
            updateState {
                val model = runtimeCatalog.tools.firstOrNull { it.id == cached.tool }?.models
                    ?.firstOrNull { it.id == cached.model && it.provider == cached.providerProfile }
                copy(runtimeTool = cached.tool, runtimeProvider = cached.providerProfile,
                    runtimeModel = cached.model, selectedEffort = cached.effort, serviceTier = cached.serviceTier,
                    thinkingEffort = model?.effortPosition(cached.effort) ?: thinkingEffort)
            }
        }
    }

    private fun resolveDefaultRuntime(fixed: SessionRepository, catalog: RuntimeCatalog, sessionChoice: RuntimeSelection? = null) {
        val editGeneration = runtimeEditGeneration
        val generation = sessionGeneration
        val sessionId = mutableState.value.sessionId
        val requestGeneration = ++runtimeDefaultGeneration
        updateState { copy(runtimeResolving = true) }
        viewModelScope.launch {
            val cached = fixed.runtimeTargetId?.let { id ->
                sessionId?.let { runCatching { readRuntimeCache(id, it) }.getOrNull() }
                    ?: runCatching { readRuntimeCache(id, null) }.getOrNull()
            }
            if (cached != null && sessionChoice == null && activeRepository() === fixed &&
                generation == sessionGeneration && runtimeDefaultGeneration == requestGeneration && runtimeEditGeneration == editGeneration &&
                !mutableState.value.runtimePickerOpen) {
                updateState {
                    val cachedModel = runtimeCatalog.tools.firstOrNull { it.id == cached.tool }?.models
                        ?.firstOrNull { it.id == cached.model && it.provider == cached.providerProfile }
                    copy(runtimeTool = cached.tool, runtimeProvider = cached.providerProfile,
                        runtimeModel = cached.model, selectedEffort = cached.effort, serviceTier = cached.serviceTier,
                        thinkingEffort = cachedModel?.effortPosition(cached.effort) ?: thinkingEffort)
                }
            }
            val currentSessionResult = runCatching { sessionChoice ?: sessionId?.let {
                fixed.loadSessionRuntimeSelection(it)
            } }
            if (currentSessionResult.isFailure) {
                if (activeRepository() === fixed && generation == sessionGeneration && runtimeDefaultGeneration == requestGeneration &&
                    runtimeEditGeneration == editGeneration) updateState { copy(runtimeResolving = false,
                        runtimeModelsError = "Session settings could not be loaded") }
                return@launch
            }
            val currentSession = currentSessionResult.getOrNull()
            val lastResult = runCatching { fixed.loadGlobalRuntimeSelection() }
            if (lastResult.isFailure) {
                if (activeRepository() === fixed && generation == sessionGeneration && runtimeDefaultGeneration == requestGeneration &&
                    runtimeEditGeneration == editGeneration) updateState { copy(runtimeResolving = false,
                        runtimeModelsError = "Runtime settings could not be loaded") }
                return@launch
            }
            val last = lastResult.getOrNull()
            runtimeSaveMutex.withLock {
                if (activeRepository() === fixed && generation == sessionGeneration && runtimeDefaultGeneration == requestGeneration &&
                    runtimeEditGeneration == editGeneration) {
                    if (last?.model != null) fixed.runtimeTargetId?.let { id -> runCatching { writeRuntimeCache(id, null, last) } }
                    if (currentSession?.model != null && sessionId != null) fixed.runtimeTargetId?.let { id ->
                        runCatching { writeRuntimeCache(id, sessionId, currentSession) }
                    }
                }
            }
            val choices = listOfNotNull(currentSession, last).filter { !it.model.isNullOrBlank() }
            val priority = listOf("codex", "codex-cli", "claude", "claude-bidi", "agy", "qwen", "opencode", "kimi", "goose", "pi", "deepseek", "openhands")
            val ordered = catalog.tools.sortedWith(compareBy({ priority.indexOf(it.id).let { n -> if (n < 0) priority.size else n } }, { it.id }))
            var lookupFailed = ordered.any { it.catalog.status == com.andysagent.agentoc.core.model.RuntimeCatalogStatus.Error }
            suspend fun select(choice: RuntimeSelection?, tool: com.andysagent.agentoc.core.model.RuntimeToolOption): Pair<RuntimeModelOption, List<RuntimeModelOption>>? {
                val providers: List<String?> = if (choice?.providerProfile != null) listOf(choice.providerProfile)
                    else if (tool.providerSelectionRequired) tool.providers.map { it.id } else listOf(null)
                for (provider in providers) {
                    if (tool.providerSelectionRequired && tool.providers.none { it.id == provider }) continue
                    val models = if (provider != null) try { fixed.loadRuntimeModels(tool.id, provider) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Throwable) { lookupFailed = true; continue }
                    else tool.models
                    val requestedModel = choice?.model
                    val model = if (requestedModel != null) models.firstOrNull { it.id == requestedModel && it.provider == provider }
                        else models.firstOrNull { it.isDefault } ?: models.firstOrNull()
                    if (model != null) return model to models
                }
                return null
            }
            var selected: Pair<RuntimeModelOption, List<RuntimeModelOption>>? = null
            var chosenTool: String? = null
            var preferred: RuntimeSelection? = null
            for (choice in choices) {
                val tool = ordered.firstOrNull { it.id == choice.tool } ?: continue
                val found = select(choice, tool) ?: continue
                selected = found; chosenTool = tool.id; preferred = choice; break
            }
            if (selected == null) for (tool in ordered) {
                val found = select(null, tool) ?: continue
                selected = found; chosenTool = tool.id; break
            }
            if (activeRepository() !== fixed || generation != sessionGeneration || runtimeDefaultGeneration != requestGeneration || runtimeEditGeneration != editGeneration ||
                mutableState.value.sessionId != sessionId || mutableState.value.runtimePickerOpen) return@launch
            val model = selected?.first
            if (model == null || chosenTool == null) {
                updateState { copy(runtimeTool = "", runtimeProvider = null, runtimeModel = null,
                    selectedEffort = null, runtimeUnavailable = !lookupFailed, runtimeResolving = false) }
                return@launch
            }
            updateRuntimeModels(chosenTool, selected.second)
            val effort = model.resolveEffort(preferred?.effort)
            updateState { copy(runtimeTool = chosenTool, runtimeProvider = model.provider, runtimeModel = model.id,
                selectedEffort = effort, thinkingEffort = model.effortPosition(effort),
                serviceTier = if (model.supportsFast) preferred?.serviceTier ?: "standard" else "standard",
                runtimeUnavailable = false, runtimeResolving = false, runtimeModelsError = null) }
        }
    }

    private fun mergeRuntimeCatalog(fresh: RuntimeCatalog, previous: RuntimeCatalog): RuntimeCatalog =
        fresh.copy(tools = fresh.tools.map { tool ->
            val prior = previous.tools.firstOrNull { it.id == tool.id }
            if (tool.models.isEmpty() && tool.providerSelectionRequired && prior != null) {
                val validProviders = tool.providers.map { it.id }.toSet()
                tool.copy(models = prior.models.filter { it.provider in validProviders })
            } else tool
        })

    /** Remote goal controls keep the clicked target; only the original selection receives UI feedback. */
    private fun runGoalAction(
        sessionId: String,
        fixed: SessionRepository,
        generation: Long,
        fallback: String,
        refresh: Boolean = false,
        action: suspend () -> Unit,
    ) {
        viewModelScope.launch {
            try {
                action()
                if (refresh && selectedRepository === fixed) refreshSession(sessionId, generation)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (selectedRepository === fixed && isCurrentSession(sessionId, generation)) showError(error, fallback)
            }
        }
    }

    private suspend fun refreshSessions() {
        try {
            repository.refreshSessions()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            showError(error, "Sessions could not be loaded")
        }
    }

    private suspend fun refreshSession(sessionId: String, expectedGeneration: Long? = null) {
        val fixed = selectedRepository ?: return
        val generation = expectedGeneration ?: sessionGeneration
        // Do not allow an invalidation for a session that is no longer visible
        // to mutate the current conversation's error or loading state.
        if (!isCurrentSession(sessionId, generation)) return
        val lock = synchronized(sessionRefreshLocks) {
            sessionRefreshLocks.getOrPut(fixed to sessionId) { Mutex() }
        }
        lock.withLock {
            if (!isCurrentSession(sessionId, generation)) return
            try {
                fixed.refreshSessionDetail(sessionId)
                if (!isCurrentSession(sessionId, generation)) return
                val result = fixed.refreshTimeline(sessionId)
                if (isCurrentSession(sessionId, generation)) {
                    updateState {
                        copy(
                            historyLoading = false,
                            error = if (result is RefreshResult.ResetRequired) {
                                result.reason ?: "Session history needs to be refreshed"
                            } else if (clearErrorWhenConnected) {
                                null
                            } else {
                                error
                            },
                        )
                    }
                }
            } catch (error: CancellationException) {
                // Switching sessions deliberately cancels the old refresh.
                // Cancellation is not a failed load and must never surface in
                // the new session's error banner.
                throw error
            } catch (error: Throwable) {
                if (isCurrentSession(sessionId, generation)) {
                    updateState {
                        copy(
                            historyLoading = false,
                            timelineItems = if (isRecoverableConnectionError(error) && timelineSessionId == sessionId) timelineItems else emptyList(),
                            timelineSessionId = if (isRecoverableConnectionError(error) && timelineSessionId == sessionId) timelineSessionId else null,
                            messageCount = if (isRecoverableConnectionError(error) && timelineSessionId == sessionId) messageCount else 0,
                        )
                    }
                    showError(error, "Session could not be refreshed")
                }
            }
        }
    }

    private fun loadOlderTimeline() {
        val fixed = selectedRepository ?: return
        val sessionId = mutableState.value.sessionId ?: return
        if (mutableState.value.loadingOlder || !mutableState.value.hasOlder) return
        val generation = sessionGeneration
        updateState { copy(loadingOlder = true, error = null) }
        viewModelScope.launch {
            try {
                if (!isCurrentSession(sessionId, generation)) return@launch
                val result = fixed.loadOlderTimeline(sessionId)
                if (!isCurrentSession(sessionId, generation)) return@launch
                if (result is RefreshResult.ResetRequired) {
                    updateState { copy(error = result.reason ?: "Session history needs to be refreshed") }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (isCurrentSession(sessionId, generation)) showError(error, "Earlier messages could not be loaded")
            } finally {
                if (isCurrentSession(sessionId, generation)) {
                    updateState { copy(loadingOlder = false) }
                }
            }
        }
    }

    private fun cancelRun() {
        val current = mutableState.value
        val sessionId = current.sessionId ?: return
        val fixed = activeRepository() ?: return
        if (fixed !== selectedRepository || current.connection != AgentConnectionStatus.Connected ||
            current.runStatus !in setOf(AgentRunStatus.Working, AgentRunStatus.WaitingApproval)) return
        val key = fixed to sessionId
        if (key in stopRequests) return
        val pending = PendingStopRequest(StopRequestState.AwaitingConfirmation)
        stopRequests[key] = pending
        updateState { this }
        viewModelScope.launch {
            try {
                fixed.cancelSession(sessionId)
                // Refresh the captured computer, even if the user navigates
                // elsewhere. Only its authoritative task state ends waiting.
                fixed.refreshSessions()
                fixed.refreshTimeline(sessionId)
                // An acknowledgement without a terminal task update must not
                // leave the user waiting forever. Recheck never replays work.
                kotlinx.coroutines.delay(15_000)
                if (stopRequests[key] === pending) {
                    stopRequests[key] = PendingStopRequest(StopRequestState.OutcomeUnknown)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                if (stopRequests[key] === pending) stopRequests[key] = PendingStopRequest(StopRequestState.OutcomeUnknown)
            } finally {
                if (selectedRepository === fixed && mutableState.value.sessionId == sessionId) updateState { this }
            }
        }
    }

    private fun selectApprovalAction(event: ChatEvent.SelectApprovalAction) {
        val current = mutableState.value.approval ?: return
        if (current.id != event.approvalId || current.resolving) return
        updateState {
            copy(
                approval = current.copy(
                    actions = current.actions.map { action ->
                        if (action.id == event.actionId) action.copy(selected = event.selected) else action
                    },
                ),
            )
        }
    }

    private fun resolveApproval(approvalId: String, approve: Boolean) {
        val sessionId = mutableState.value.sessionId ?: return
        val accepted = synchronized(approvalResolutionLock) {
            val current = mutableState.value
            if (current.resolvingApprovalId != null ||
                (current.approval?.id != approvalId && current.activeDecision?.id != approvalId)) {
                false
            } else {
                mutableState.value = current.copy(resolvingApprovalId = approvalId, error = null,
                    activeDecision = current.activeDecision?.let {
                        if (it.id == approvalId) it.copy(isSubmitting = true, submissionError = null) else it
                    })
                true
            }
        }
        if (!accepted) return
        viewModelScope.launch {
            try {
                val decision = if (approve) "approve" else "deny"
                val pending = repository.findPendingApproval(sessionId, approvalId)
                    ?.takeIf { it.status == "pending" } ?: error("This request is no longer pending.")
                val runId = pending.runId
                val batchId = pending.batchId
                if (runId != null && batchId != null && pending.kind == "approved_action_batch_request") {
                    val visibleApproval = mutableState.value.approval
                    val decisions = pending.actions.map { action ->
                        ApprovalActionDecision(
                            actionId = action.id,
                            decision = if (approve && visibleApproval?.actions?.firstOrNull { it.id == action.id }?.selected == true) {
                                "approve"
                            } else {
                                "deny"
                            },
                        )
                    }
                    // The passkey checkpoint follows the server-projected
                    // needsPasskey flag, not the execution class: with the
                    // owner-click policy a host action is approved by the
                    // explicit owner click alone.
                    val selectedHostActionIds = if (approve) {
                        decisions.filter { it.decision == "approve" }
                            .mapNotNull { decision ->
                                pending.actions.firstOrNull { it.id == decision.actionId }
                                    ?.takeIf { it.needsPasskey }
                                    ?.id
                            }
                    } else emptyList()
                    val resolutionRequestId = newRequestId()
                    val proof = if (selectedHostActionIds.isNotEmpty()) {
                        val provider = passkeyProvider ?: error("Passkey approval requires the Android system credential provider")
                        val challenge = repository.createApprovedActionWebAuthnChallenge(
                            runId = runId,
                            batchId = batchId,
                            selectedActionIds = selectedHostActionIds,
                            requestId = resolutionRequestId,
                        )
                        provider(challenge.toString())
                    } else null
                    repository.resolveApprovedActionBatchWithProof(
                        sessionId = sessionId,
                        runId = runId,
                        batchId = batchId,
                        decisions = decisions,
                        approvalIntent = if (approve) "approve" else "deny",
                        webauthnProof = proof,
                        requestId = resolutionRequestId,
                    )
                } else if (runId != null && batchId != null) {
                    val visibleApproval = mutableState.value.approval
                    val categoryActions = pending.actions.groupBy { action ->
                        action.category?.takeIf { it.isNotBlank() } ?: "privileged_other"
                    }.filterKeys { it == "privileged_other" || it == "destructive_delete" }
                    if (categoryActions.isEmpty()) {
                        // In-scope software installs are resolved by the
                        // server's install-auto path. They may briefly be
                        // present in a replayed request event, but they are
                        // not a user approval category.
                        refreshSession(sessionId)
                        return@launch
                    }
                    for ((category, actions) in categoryActions) {
                        val checkedOpIds = if (approve) {
                            actions.filter { action ->
                                visibleApproval?.actions?.firstOrNull { it.id == action.id }?.selected == true
                            }.map { it.id }
                        } else emptyList()
                        val resolutionRequestId = newRequestId()
                        // Legacy privileged-category batches carry a
                        // server-projected passkeyRequired flag; absent means
                        // required (safe default for persisted approvals).
                        val proof = if (checkedOpIds.isNotEmpty() && pending.passkeyRequired) {
                            val provider = passkeyProvider ?: error("Passkey approval requires the Android system credential provider")
                            val challenge = repository.createPrivilegedCategoryWebAuthnChallenge(
                                runId = runId,
                                batchId = batchId,
                                category = category,
                                checkedOpIds = checkedOpIds,
                                requestId = resolutionRequestId,
                            )
                            provider(challenge.toString())
                        } else null
                        repository.resolvePrivilegedCategory(
                            sessionId = sessionId,
                            runId = runId,
                            batchId = batchId,
                            category = category,
                            checkedOpIds = checkedOpIds,
                            webauthnProof = proof,
                            requestId = resolutionRequestId,
                        )
                    }
                } else if (runId != null) {
                    repository.resolveRuntimeApproval(runId, approvalId, decision)
                } else {
                    repository.decideConfirmation(sessionId, approvalId, decision)
                }
                refreshSession(sessionId)
            } catch (error: Throwable) {
                mutableState.update { state ->
                    state.copy(activeDecision = state.activeDecision?.let {
                        if (it.id == approvalId) it.copy(submissionError = error.message ?: "Approval could not be resolved") else it
                    })
                }
                showError(error, "Approval could not be resolved")
            } finally {
                mutableState.update { state ->
                    if (state.resolvingApprovalId == approvalId) state.copy(resolvingApprovalId = null,
                        activeDecision = state.activeDecision?.let {
                            if (it.id == approvalId) it.copy(isSubmitting = false) else it
                        }) else state
                }
            }
        }
    }

    private fun retry() {
        val fixed = activeRepository() ?: return
        val sessionId = mutableState.value.sessionId
        val generation = sessionGeneration
        updateState { copy(error = null) }
        viewModelScope.launch {
            try {
                fixed.refreshSessions()
                // A successful explicit recheck restores the ability to stop
                // a task that the computer still reports as running. It never
                // replays either the original message or the stop command.
                sessionId?.let { id ->
                    val key = fixed to id
                    if (stopRequests[key]?.state == StopRequestState.OutcomeUnknown) stopRequests.remove(key)
                    if (selectedRepository === fixed && isCurrentSession(id, generation)) {
                        updateState { this }
                        refreshSession(id, generation)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (activeRepository() === fixed && sessionGeneration == generation) showError(error, "Sessions could not be loaded")
            }
        }
    }

    private fun submitPlanAction(planId: String, action: String) {
        val sessionId = mutableState.value.sessionId ?: return
        if (action != "revise" && action != "execute") return
        viewModelScope.launch {
            try {
                updateState { copy(isLoading = true, error = null) }
                repository.submitPlanAction(
                    sessionId = sessionId,
                    planId = planId,
                    action = action,
                    text = if (action == "revise") mutableState.value.composerText else "",
                )
                refreshSession(sessionId)
            } catch (error: Throwable) {
                showError(error, "Plan action could not be submitted")
            } finally {
                updateState { copy(isLoading = false) }
            }
        }
    }

    private fun updateConnection(connection: RuntimeConnectionState) {
        updateState {
            val recovered = connection == RuntimeConnectionState.Connected && clearErrorWhenConnected
            copy(
                connection = connection.toAgentConnectionStatus(),
                error = if (recovered) null else error,
                clearErrorWhenConnected = if (recovered) false else clearErrorWhenConnected,
            )
        }
    }

    private fun showError(error: Throwable, fallback: String) {
        if (requiresDeviceReauthentication(error)) {
            updateState { copy(connection = AgentConnectionStatus.AuthenticationRequired, error = "Authentication required. Pair this Android device again.") }
            return
        }
        val detail = error.message?.takeIf { it.isNotBlank() } ?: fallback
        publishError(
            "$fallback: $detail",
            clearWhenConnected = isRecoverableConnectionError(error),
        )
    }

    private fun isRecoverableConnectionError(error: Throwable): Boolean =
        error is java.io.IOException ||
            (error is SessionRepositoryException && error.retryable && error.code in setOf("CARRIER_UNAVAILABLE", "NETWORK_ERROR")) ||
            error.message.orEmpty().contains("No verified TURN/P2P carrier", ignoreCase = true)

    private fun publishError(detail: String, clearWhenConnected: Boolean) {
        mutableState.update { state ->
            state.copy(
                error = detail,
                clearErrorWhenConnected = clearWhenConnected,
            ).projectCurrentAction()
        }
    }

    private fun updateState(transform: ChatUiState.() -> ChatUiState) {
        val previous = mutableState.value
        val transformed = previous.transform()
        val next = transformed.copy(stopRequest = transformed.sessionId?.let { id ->
            selectedRepository?.let { stopRequests[it to id]?.state }
        } ?: StopRequestState.None)
        // A normal error must never inherit the auto-dismiss behavior of an
        // earlier connectivity error merely because an intermediate action
        // cleared the banner first.
        val normalized = if (next.error != previous.error) {
            next.copy(clearErrorWhenConnected = false)
        } else {
            next
        }
        mutableState.value = normalized.projectCurrentAction()
    }

    private fun ChatUiState.projectCurrentAction(): ChatUiState {
        // Run metrics may still describe the previous turn until the first
        // tool projection arrives. Bind activity to the current turn instead.
        val currentRunId = serverRunActivity?.stringValue("runId") ?: timelineItems.filterIsInstance<TimelineItem.Message>()
            .lastOrNull { it.role == com.andysagent.agentoc.core.timeline.TimelineRole.User }?.runId
        return copy(
            currentAction = RunActionFormatter.project(
                status = when (runStatus) {
                    AgentRunStatus.Working -> RunActionFormatter.RunActionStatus.Working
                    AgentRunStatus.WaitingApproval -> RunActionFormatter.RunActionStatus.WaitingApproval
                    else -> RunActionFormatter.RunActionStatus.Other
                },
                phase = runMetrics.phase, items = timelineItems,
                activity = serverRunActivity, runId = currentRunId,
            ),
    )
    }

    private fun ChatUiState.currentRuntimeModel(): RuntimeModelOption? =
        runtimeCatalog.tools.firstOrNull { it.id == runtimeTool }?.models
            ?.firstOrNull { it.id == runtimeModel && it.provider == runtimeProvider }

    private fun RuntimeModelOption.resolveEffort(previous: String?): String? =
        previous?.takeIf { it in effortLevels } ?: defaultEffort?.takeIf { it in effortLevels } ?: effortLevels.firstOrNull()

    private fun RuntimeModelOption.effortPosition(value: String?): Float {
        if (effortLevels.size < 2) return 0f
        return effortLevels.indexOf(value).coerceAtLeast(0).toFloat() / (effortLevels.size - 1)
    }
}

@Immutable
data class ProjectsUiState(
    val projects: List<Project> = emptyList(),
    val sessions: List<Session> = emptyList(),
    val selectedProjectId: String? = null,
    val projectDialogOpen: Boolean = false,
    val projectName: String = "",
    val projectRootPath: String = "",
    val projectFolderParentPath: String? = null,
    val projectFolderChildren: List<ProjectFolder> = emptyList(),
    val projectFoldersLoading: Boolean = false,
    val projectFolderError: String? = null,
    val projectFolderCreateOpen: Boolean = false,
    val projectFolderName: String = "",
    val projectFolderCreating: Boolean = false,
    val projectInProgress: Boolean = false,
    val error: String? = null,
    /** False until the repository emits its first catalog, so surfaces can
     *  show skeletons instead of mistaking a cold start for an empty account. */
    val hydrated: Boolean = false,
    /** True only for an explicit user refresh; background invalidations stay quiet. */
    val refreshing: Boolean = false,
)

sealed interface ProjectsEvent {
    data class SelectProject(val projectId: String) : ProjectsEvent
    data object OpenProjectDialog : ProjectsEvent
    data object DismissProjectDialog : ProjectsEvent
    data class ProjectNameChanged(val value: String) : ProjectsEvent
    data class ProjectRootPathChanged(val value: String) : ProjectsEvent
    data class BrowseProjectFolder(val path: String) : ProjectsEvent
    data object BrowseProjectFolderParent : ProjectsEvent
    data object RetryProjectFolderBrowse : ProjectsEvent
    data object ToggleProjectFolderCreate : ProjectsEvent
    data class ProjectFolderNameChanged(val value: String) : ProjectsEvent
    data object CreateProjectFolder : ProjectsEvent
    data object CreateProject : ProjectsEvent
    data class MarkSessionRead(val sessionId: String) : ProjectsEvent
    data object Refresh : ProjectsEvent
    data object Retry : ProjectsEvent
    data object DismissError : ProjectsEvent
}

class ProjectsViewModel(private val repository: SessionRepository) : ViewModel() {
    private val mutableState = MutableStateFlow(ProjectsUiState())
    val state: StateFlow<ProjectsUiState> = mutableState.asStateFlow()
    private var projectsHydrated = false
    private var sessionsHydrated = false
    private var projectFolderRequestId = 0L
    private var refreshError: String? = null

    init {
        viewModelScope.launch {
            repository.observeProjects().collectLatest { projects ->
                projectsHydrated = true
                updateState {
                    copy(
                        projects = projects,
                        selectedProjectId = selectedProjectId?.takeIf { id -> projects.any { it.id == id } }
                            ?: projects.firstOrNull()?.id,
                        hydrated = projectsHydrated && sessionsHydrated,
                    )
                }
            }
        }
        viewModelScope.launch {
            repository.observeSessions().collectLatest { sessions ->
                sessionsHydrated = true
                updateState {
                    copy(
                        sessions = sessions,
                        hydrated = projectsHydrated && sessionsHydrated,
                    )
                }
            }
        }
        viewModelScope.launch {
            repository.invalidations.collectLatest { hint ->
                if (hint.type in setOf("projects_invalidated", "project_invalidated", "sessions_invalidated", "session_invalidated")) refresh()
            }
        }
        viewModelScope.launch {
            repository.connectionState.collectLatest { connection ->
                if (connection == RuntimeConnectionState.Connected && refreshError != null) refresh()
            }
        }
    }

    fun onEvent(event: ProjectsEvent) {
        when (event) {
            is ProjectsEvent.SelectProject -> updateState { copy(selectedProjectId = event.projectId) }
            ProjectsEvent.OpenProjectDialog -> {
                updateState {
                    copy(
                        projectDialogOpen = true,
                        projectName = "",
                        projectRootPath = "",
                        projectFolderParentPath = null,
                        projectFolderChildren = emptyList(),
                        projectFoldersLoading = true,
                        projectFolderError = null,
                        projectFolderCreateOpen = false,
                        projectFolderName = "",
                        projectFolderCreating = false,
                        error = null,
                    )
                }
                browseProjectFolder("~")
            }
            ProjectsEvent.DismissProjectDialog -> {
                projectFolderRequestId += 1
                updateState { copy(projectDialogOpen = false, projectFoldersLoading = false, projectFolderCreateOpen = false) }
            }
            is ProjectsEvent.ProjectNameChanged -> updateState { copy(projectName = event.value) }
            is ProjectsEvent.ProjectRootPathChanged -> updateState { copy(projectRootPath = event.value) }
            is ProjectsEvent.BrowseProjectFolder -> browseProjectFolder(event.path)
            ProjectsEvent.BrowseProjectFolderParent -> mutableState.value.projectFolderParentPath?.let(::browseProjectFolder)
            ProjectsEvent.RetryProjectFolderBrowse -> browseProjectFolder(mutableState.value.projectRootPath)
            ProjectsEvent.ToggleProjectFolderCreate -> updateState {
                copy(projectFolderCreateOpen = !projectFolderCreateOpen, projectFolderName = "", projectFolderError = null)
            }
            is ProjectsEvent.ProjectFolderNameChanged -> updateState { copy(projectFolderName = event.value) }
            ProjectsEvent.CreateProjectFolder -> createProjectFolder()
            ProjectsEvent.CreateProject -> createProject()
            is ProjectsEvent.MarkSessionRead -> viewModelScope.launch {
                runCatching { repository.markSessionReviewed(event.sessionId) }
            }
            ProjectsEvent.Refresh -> requestRefresh()
            ProjectsEvent.Retry -> requestRefresh()
            ProjectsEvent.DismissError -> updateState { copy(error = null) }
        }
    }

    private fun createProject() {
        val current = mutableState.value
        val rootPath = current.projectRootPath.trim()
        if (rootPath.isBlank()) { updateState { copy(error = "Enter a project folder before creating it.") }; return }
        updateState { copy(projectInProgress = true, error = null) }
        viewModelScope.launch {
            try {
                repository.createProject(current.projectName.trim(), rootPath)
                updateState { copy(projectDialogOpen = false, projectName = "", projectRootPath = "", projectInProgress = false) }
                refresh()
            } catch (error: Throwable) {
                updateState { copy(projectInProgress = false, error = error.message ?: "Project could not be created") }
            }
        }
    }

    private fun requestRefresh() {
        if (mutableState.value.refreshing) return
        updateState { copy(error = null, refreshing = true) }
        viewModelScope.launch {
            refresh()
            updateState { copy(refreshing = false) }
        }
    }

    private fun browseProjectFolder(path: String) {
        val requestedPath = path.trim().ifBlank { "~" }
        val requestId = ++projectFolderRequestId
        updateState {
            copy(
                projectRootPath = requestedPath,
                projectFolderParentPath = null,
                projectFolderChildren = emptyList(),
                projectFoldersLoading = true,
                projectFolderError = null,
            )
        }
        viewModelScope.launch {
            try {
                val browser = repository.browseProjectFolders(requestedPath)
                if (requestId != projectFolderRequestId || !mutableState.value.projectDialogOpen) return@launch
                updateState {
                    copy(
                        projectRootPath = browser.path,
                        projectFolderParentPath = browser.parentPath,
                        projectFolderChildren = browser.children,
                        projectFoldersLoading = false,
                        projectFolderError = null,
                        projectName = projectName.ifBlank { browser.path.folderDisplayName() },
                    )
                }
            } catch (error: Throwable) {
                if (requestId != projectFolderRequestId || !mutableState.value.projectDialogOpen) return@launch
                updateState {
                    copy(
                        projectFoldersLoading = false,
                        projectFolderError = error.message ?: "Folder list could not be loaded",
                    )
                }
            }
        }
    }

    private fun createProjectFolder() {
        val current = mutableState.value
        val name = current.projectFolderName.trim()
        if (name.isBlank() || name == "." || name == ".." || name.contains('/') || name.contains('\\')) {
            updateState { copy(projectFolderError = "Enter a single folder name.") }
            return
        }
        val parentPath = current.projectRootPath.trim()
        if (parentPath.isBlank()) return
        updateState { copy(projectFolderCreating = true, projectFolderError = null) }
        viewModelScope.launch {
            try {
                val folder = repository.createProjectFolder(parentPath, name)
                updateState { copy(projectFolderCreateOpen = false, projectFolderName = "", projectFolderCreating = false) }
                browseProjectFolder(folder.path)
            } catch (error: Throwable) {
                updateState {
                    copy(
                        projectFolderCreating = false,
                        projectFolderError = error.message ?: "Folder could not be created",
                    )
                }
            }
        }
    }

    private suspend fun refresh(allowRecoveryRetry: Boolean = true) {
        try {
            repository.refreshProjects()
            repository.refreshSessions()
            val previous = refreshError
            refreshError = null
            if (previous != null) updateState { if (error == previous) copy(error = null) else this }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            val message = failure.message ?: "Projects could not be loaded"
            refreshError = message
            updateState { copy(error = message) }
            // A failed call may finish after the Connected event has already
            // arrived. Recheck once, without an unbounded retry loop.
            if (allowRecoveryRetry && repository.connectionState.value == RuntimeConnectionState.Connected) {
                viewModelScope.launch { kotlinx.coroutines.delay(500); refresh(allowRecoveryRetry = false) }
            }
        }
    }

    private fun updateState(transform: ProjectsUiState.() -> ProjectsUiState) {
        mutableState.value = mutableState.value.transform()
    }
}

private fun String.folderDisplayName(): String {
    val trimmed = trim().trimEnd('/', '\\')
    return trimmed.substringAfterLast('/', trimmed.substringAfterLast('\\')).ifBlank { "Project" }
}

@Immutable
data class ComputersUiState(
    val connection: AgentConnectionStatus = AgentConnectionStatus.Disconnected,
    val computers: List<Computer> = emptyList(),
    val pairingOpen: Boolean = false,
    val pairingUri: String = "",
    val pairingDeviceName: String = "Android device",
    val pairingInProgress: Boolean = false,
    val error: String? = null,
)

sealed interface ComputersEvent {
    data object OpenPairing : ComputersEvent
    data object DismissPairing : ComputersEvent
    data class PairingUriChanged(val value: String) : ComputersEvent
    data class PairingDeviceNameChanged(val value: String) : ComputersEvent
    data object Pair : ComputersEvent
    data object Retry : ComputersEvent
    data object DismissError : ComputersEvent
}

class ComputersViewModel(
    private val repository: SessionRepository,
    private val pairAction: suspend (pairingUri: String, deviceName: String) -> Unit = { _, _ -> },
) : ViewModel() {
    private val mutableState = MutableStateFlow(ComputersUiState())
    val state: StateFlow<ComputersUiState> = mutableState.asStateFlow()
    private var refreshError: String? = null

    init {
        viewModelScope.launch { repository.observeComputers().collectLatest { computers -> updateState { copy(computers = computers) } } }
        viewModelScope.launch { repository.connectionState.collectLatest { connection ->
            updateState { copy(connection = connection.toAgentConnectionStatus()) }
            if (connection == RuntimeConnectionState.Connected && refreshError != null) refresh()
        } }
        viewModelScope.launch {
            repository.invalidations.collectLatest { hint ->
                if (hint.type in setOf("computers_invalidated", "devices_invalidated", "device_invalidated")) refresh()
                if (hint.type == "authentication_required") updateState { copy(connection = AgentConnectionStatus.AuthenticationRequired) }
            }
        }
    }

    fun onEvent(event: ComputersEvent) {
        when (event) {
            ComputersEvent.OpenPairing -> updateState { copy(pairingOpen = true, error = null) }
            ComputersEvent.DismissPairing -> updateState { copy(pairingOpen = false) }
            is ComputersEvent.PairingUriChanged -> updateState { copy(pairingUri = event.value) }
            is ComputersEvent.PairingDeviceNameChanged -> updateState { copy(pairingDeviceName = event.value) }
            ComputersEvent.Pair -> pair()
            ComputersEvent.Retry -> { updateState { copy(error = null) }; viewModelScope.launch { refresh() } }
            ComputersEvent.DismissError -> updateState { copy(error = null) }
        }
    }

    private fun pair() {
        val current = mutableState.value
        val uri = current.pairingUri.trim()
        val name = current.pairingDeviceName.trim()
        if (uri.isBlank() || name.isBlank()) { updateState { copy(error = "Enter the pairing URI and device name.") }; return }
        updateState { copy(pairingInProgress = true, error = null) }
        viewModelScope.launch {
            try {
                pairAction(uri, name)
                updateState { copy(pairingOpen = false, pairingUri = "", pairingInProgress = false) }
                refresh()
            } catch (error: Throwable) {
                updateState { copy(pairingInProgress = false, error = error.message ?: "Pairing failed") }
            }
        }
    }

    private suspend fun refresh(allowRecoveryRetry: Boolean = true) {
        try {
            repository.refreshComputers()
            val previous = refreshError
            refreshError = null
            if (previous != null) updateState { if (error == previous) copy(error = null) else this }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            val message = failure.message ?: "Computers could not be loaded"
            refreshError = message
            updateState { copy(error = message) }
            if (allowRecoveryRetry && repository.connectionState.value == RuntimeConnectionState.Connected) {
                viewModelScope.launch { kotlinx.coroutines.delay(500); refresh(allowRecoveryRetry = false) }
            }
        }
    }

    private fun updateState(transform: ComputersUiState.() -> ComputersUiState) {
        mutableState.value = mutableState.value.transform()
    }
}

class AppShellViewModelFactory(private val repository: SessionRepository) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = AppShellViewModel(repository) as T
}

class ChatViewModelFactory(
    private val repository: SessionRepository,
    private val passkeyProvider: (suspend (String) -> WebAuthnProofDto)? = null,
    private val readRuntimeCache: suspend (String, String?) -> RuntimeSelection? = { _, _ -> null },
    private val writeRuntimeCache: suspend (String, String?, RuntimeSelection) -> Unit = { _, _, _ -> },
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ChatViewModel(repository, passkeyProvider, readRuntimeCache, writeRuntimeCache) as T
}

class ProjectsViewModelFactory(private val repository: SessionRepository) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ProjectsViewModel(repository) as T
}

class ComputersViewModelFactory(
    private val repository: SessionRepository,
    private val pairAction: suspend (String, String) -> Unit = { _, _ -> },
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = ComputersViewModel(repository, pairAction) as T
}

private fun RuntimeConnectionState.toAgentConnectionStatus(): AgentConnectionStatus = when (this) {
    RuntimeConnectionState.Connected -> AgentConnectionStatus.Connected
    RuntimeConnectionState.Connecting -> AgentConnectionStatus.Connecting
    RuntimeConnectionState.Reconnecting -> AgentConnectionStatus.Reconnecting
    RuntimeConnectionState.AuthenticationRequired -> AgentConnectionStatus.AuthenticationRequired
    RuntimeConnectionState.Error -> AgentConnectionStatus.Error
    RuntimeConnectionState.Disconnected -> AgentConnectionStatus.Disconnected
}

private val selectableApprovalActionStates = setOf("proposed", "classified", "waiting_user")

private fun com.andysagent.agentoc.core.model.ApprovalExplanation.toUiState() =
    com.andysagent.agentoc.core.agentui.ApprovalExplanationUiState(summary, reason, saferAlternative, operation, targets, conditional, partial, riskCode, providerConflict, elevated)

private fun Approval.toUiState(): PermissionRequestUiState = PermissionRequestUiState(
    id = id,
    title = title,
    reason = reason ?: "The agent is waiting for your decision before continuing.",
    saferAlternative = saferAlternative,
    approveLabel = approveLabel,
    denyLabel = denyLabel,
    batchId = batchId,
    selectionManifestHash = selectionManifestHash,
    permissionMode = permissionMode,
    expiresAt = expiresAt,
    riskLevel = riskLevel,
    command = command,
    cwd = cwd,
    filePaths = filePaths,
    grantRoot = grantRoot,
    permissionsJson = permissionsJson,
    explanation = explanation?.toUiState(),
    actions = actions.map { action ->
        ApprovalActionUiState(
            id = action.id,
            description = action.description,
            explanation = action.explanation?.toUiState(),
            summary = action.summary ?: action.reason,
            command = action.command,
            cwd = action.cwd,
            category = action.category,
            executionClass = action.executionClass,
            state = action.state,
            risk = action.risk,
            needsPasskey = action.needsPasskey,
            selected = action.state in selectableApprovalActionStates
                && (action.category?.let { defaultSelectedByCategory[it] }?.contains(action.id)
                    ?: (action.category != "destructive_delete")),
        )
    },
)

private fun com.andysagent.agentoc.core.model.SessionStatus.toAgentStatus(): AgentRunStatus = when (this) {
    com.andysagent.agentoc.core.model.SessionStatus.Idle -> AgentRunStatus.Idle
    com.andysagent.agentoc.core.model.SessionStatus.Working -> AgentRunStatus.Working
    com.andysagent.agentoc.core.model.SessionStatus.WaitingApproval -> AgentRunStatus.WaitingApproval
    com.andysagent.agentoc.core.model.SessionStatus.Completed -> AgentRunStatus.Completed
    com.andysagent.agentoc.core.model.SessionStatus.Failed -> AgentRunStatus.Failed
    com.andysagent.agentoc.core.model.SessionStatus.Cancelled -> AgentRunStatus.Cancelled
}
