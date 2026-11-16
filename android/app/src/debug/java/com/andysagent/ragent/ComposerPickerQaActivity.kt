package com.andysagent.ragent

import android.os.Bundle
import android.view.KeyEvent
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.andysagent.ragent.core.domain.RuntimeSelection
import com.andysagent.ragent.core.agentui.composerRuntimeIdentity
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.feature.workbench.RunMetricsUiState
import com.andysagent.ragent.feature.workbench.FileDiffDetail
import com.andysagent.ragent.feature.workbench.StepTraceItem
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.AppTheme
import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeModelOption
import com.andysagent.ragent.core.model.RuntimeProviderOption
import com.andysagent.ragent.core.model.RuntimeToolOption
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.ApprovalAction
import com.andysagent.ragent.feature.workbench.AttentionEvent
import kotlinx.coroutines.delay

/** Local, offline visual fixture. Never included in release builds or persisted. */
class ComposerPickerQaActivity : ComponentActivity() {
    private var organizationDemoTransport: LocalOrganizationDemoTransport? = null
    private var organizationDemoSwitch: Job? = null

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val transport = organizationDemoTransport
        if (transport != null && event.repeatCount == 0 &&
            (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            val visible = keyCode == KeyEvent.KEYCODE_VOLUME_UP
            organizationDemoSwitch?.cancel()
            organizationDemoSwitch = lifecycleScope.launch { transport.showMembers(visible) }
            Toast.makeText(this, if (visible) "本地演示 · 五成员" else "本地演示 · 空协作", Toast.LENGTH_SHORT).show()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val oldHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            android.util.Log.e("QA_CRASH", "FATAL CRASH in QA Activity", e)
            oldHandler?.uncaughtException(t, e)
        }
        enableEdgeToEdge()
        val dark = intent.getBooleanExtra("dark", false)
        val qaTheme = AppTheme.entries.firstOrNull { it.value == intent.getStringExtra("theme") }
            ?: if (dark) AppTheme.Dark else AppTheme.Light
        val page = intent.getStringExtra("page") ?: "chat"
        val projectSessionCount = intent.getIntExtra("project_session_count", 3).coerceIn(1, 60)
        val mixedProjectSessions = intent.getBooleanExtra("mixed_project_sessions", false)
        if (intent.getBooleanExtra("organization_demo", false)) {
            val demoSessionId = if (mixedProjectSessions) "qa-session-4" else "composer-visual-qa"
            organizationDemoTransport = LocalOrganizationDemoTransport(demoSessionId)
            Toast.makeText(this, "本地演示 · 音量上键显示协作，音量下键还原", Toast.LENGTH_LONG).show()
        }
        val longPreviewTitles = intent.getBooleanExtra("long_preview_titles", false)
        val qaFontScale = intent.getFloatExtra("font_scale", 1f)
        val panel = intent.getStringExtra("panel")
        val localeTag = intent.getStringExtra("locale")
        val status = AgentRunStatus.entries.firstOrNull {
            it.name.equals(intent.getStringExtra("status"), ignoreCase = true)
        } ?: AgentRunStatus.Idle
        val localizedContext = android.view.ContextThemeWrapper(this, 0).apply {
            applyOverrideConfiguration(android.content.res.Configuration(this@ComposerPickerQaActivity.resources.configuration).apply {
                fontScale = qaFontScale
                localeTag?.let { setLocale(java.util.Locale.forLanguageTag(it)) }
            })
        }
        // Popup windows use their source View's context, not only LocalContext.
        // Keep the real Activity owner while localizing the whole view tree.
        val composeView = androidx.compose.ui.platform.ComposeView(localizedContext).apply {
            // The Activity's decor still has the device locale. Do not inherit its
            // direction when this isolated QA surface overrides the locale.
            layoutDirection = localizedContext.resources.configuration.layoutDirection
        }
        setContentView(composeView)
        composeView.setContent {
            val seededAttention = remember {
                if (panel == "notification") {
                    val approval = Approval(
                        id = "offline-approval", sessionId = "offline-notification-source",
                        title = "Export the audited weekly report", passkeyRequired = false,
                        reason = "The report will be saved in the shared team folder. Existing source files are not modified by this local fixture.",
                        actions = listOf(
                            ApprovalAction("export", description = "Export the report with its source references",
                                summary = "Export the audited weekly report", command = "report-export --include-sources --output weekly-report.pdf",
                                cwd = "C:/Example/Reports", risk = "medium"),
                            ApprovalAction("copy", description = "Copy the generated report to the team folder",
                                command = "copy weekly-report.pdf C:/Example/Shared/weekly-report.pdf", cwd = "C:/Example/Reports"),
                        ),
                        riskLevel = "medium", permissionMode = "selected actions only",
                    )
                    val item = AttentionItem("offline-attention", approval.sessionId, "Weekly report · local preview",
                        AttentionKind.Approval, approval.title, approval.title, approval = approval)
                    AttentionUiState(items = listOf(item), activeItemId = item.id,
                        error = intent.getStringExtra("attention_error"),
                        resolvingItemId = if (intent.getBooleanExtra("resolving", false)) item.id else null)
                } else AttentionUiState()
            }
            val attentionDelay = intent.getIntExtra("attention_delay_ms", 0).coerceIn(0, 30_000)
            var attention by remember { mutableStateOf(if (attentionDelay > 0) AttentionUiState() else seededAttention) }
            LaunchedEffect(Unit) {
                if (attentionDelay > 0) { delay(attentionDelay.toLong()); attention = seededAttention }
            }
            var fullscreenOpen by remember { mutableStateOf(panel == "fullscreen") }
            var pickerSnapshot by remember {
                mutableStateOf(if (panel == "runtime") RuntimeSelection("codex", "qa-personal", "qa-balanced") else null)
            }
            var state by remember {
                mutableStateOf(WorkbenchUiState(
                    chatOpen = page == "chat",
                    composerText = intent.getStringExtra("draft") ?: if (panel == "fullscreen" || intent.getBooleanExtra("long_draft", false))
                        "Local preview\n第一行\n第二行\n第三行\n第四行\n第五行\n**Important**: verify `healthz`" else "",
                    effortPickerOpen = panel == "effort",
                    runtimePickerOpen = panel == "runtime",
                    composerActionSheetOpen = panel == "actions",
                    goalDialogOpen = panel == "goal",
                    goalMode = panel == "goal" || intent.getBooleanExtra("goal_mode", false) || intent.hasExtra("goal"),
                    goalText = intent.getStringExtra("goal") ?: "",
                    autoContinue = intent.getBooleanExtra("auto_continue", false),
                    planMode = intent.getBooleanExtra("plan", false),
                    queuedMessages = if (panel == "queue") listOf(
                        com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                            id = "qa-queue-first", text = "Local preview · Review the report and list the missing sources before continuing."),
                        com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                            id = "qa-queue-second", text = "Local preview · Keep the original files unchanged."),
                    ) else emptyList(),
                    destination = when (page) {
                        "settings" -> AgentoDestination.Settings
                        "projects" -> AgentoDestination.Sessions
                        else -> AgentoDestination.Home
                    },
                    runMetrics = if (intent.getBooleanExtra("run_context", false)) RunMetricsUiState(
                        status = status, durationFormatted = "2m 18s", promptTokens = 1240,
                        completionTokens = 360, toolCallsCount = 8,
                        filesChangedCount = if (intent.getBooleanExtra("run_detail_content", false)) 2 else 0,
                        runId = "local-preview", phase = status.name.lowercase(java.util.Locale.ROOT), provider = "Local provider",
                        model = "Local model", runtimeFamily = "Offline UI fixture",
                        failureReason = intent.getStringExtra("failure_reason"),
                    ) else RunMetricsUiState(status = status),
                    runStatus = status,
                    changedFiles = if (intent.getBooleanExtra("run_detail_content", false)) listOf(
                        FileDiffDetail("app/src/main/ChatScreen.kt", 24, 8, "Local preview only"),
                        FileDiffDetail("app/src/main/GlassSurface.kt", 11, 3, "Local preview only"),
                    ) else emptyList(),
                    stepTraces = if (intent.getBooleanExtra("run_detail_content", false)) listOf(
                        StepTraceItem(1, "read", "Reviewed the conversation", status = "completed"),
                        StepTraceItem(2, "edit", "Updated two local preview files", status = "completed"),
                        StepTraceItem(3, "test", "Checked the rendered result", status = "completed"),
                    ) else emptyList(),
                    currentAction = intent.getStringExtra("activity_summary")?.let {
                        com.andysagent.ragent.core.timeline.RunActionUiState("local-preview", it)
                    },
                    activeDecision = if (panel == "question") com.andysagent.ragent.feature.workbench.DecisionQuestionUiState(
                        id = "qa-question-local-only",
                        question = "本地示例 · 报告需要包含哪些内容？",
                        options = listOf("汇总与待办", "完整明细"),
                        isSubmitting = intent.getBooleanExtra("resolving", false),
                    ) else null,
                    approvalResolving = panel == "approval" && intent.getBooleanExtra("resolving", false),
                    approval = if (panel == "approval") com.andysagent.ragent.core.agentui.PermissionRequestUiState(
                        id = "qa-approval-local-only",
                        title = "Local preview · Upload the weekly report",
                        reason = "Offline UI fixture. No file is uploaded and no permission is granted.",
                        resolving = intent.getBooleanExtra("resolving", false),
                    ) else null,
                    projects = (1..6).map { Project("qa-project-$it", "示例项目 $it · 每周工作", "/example/$it") },
                    sessions = (1..6 * projectSessionCount).map { index -> Session(
                        id = "qa-session-$index",
                        title = if (longPreviewTitles && (index - 1) % projectSessionCount == 2)
                            if (localeTag?.startsWith("zh") == true)
                                "检查每周汇总中的原始来源，再确认待办与输出文件，保留所有已核对的结果"
                            else "Check every source in the weekly report, confirm the outstanding items and preserve the reviewed files"
                        else if (mixedProjectSessions && index == 1)
                            "核对每周报告的引用来源与待办事项，再整理一份可以直接交给团队的完整说明"
                        else "示例任务 $index · 整理文件并核对结果",
                        projectId = "qa-project-${(index - 1) / projectSessionCount + 1}",
                        status = if (mixedProjectSessions) when (index % 6) {
                            2 -> SessionStatus.Working
                            3, 5 -> SessionStatus.WaitingApproval
                            else -> SessionStatus.Completed
                        } else SessionStatus.Completed,
                        waitingAction = if (mixedProjectSessions) when (index % 6) {
                            3 -> "approval"
                            5 -> "reply"
                            else -> null
                        } else null,
                        lastAssistantMessageAt = if (mixedProjectSessions && index % 6 == 0) System.currentTimeMillis() else null,
                        updatedAt = System.currentTimeMillis() - index * 60_000L,
                    ) },
                    sessionId = if (mixedProjectSessions) "qa-session-4" else "composer-visual-qa",
                    sessionTitle = "输入面板 · 长会话检查",
                    connection = AgentConnectionStatus.Connected,
                    appTheme = qaTheme,
                    runtimeTool = "codex",
                    runtimeProvider = "qa-personal",
                    runtimeModel = "qa-balanced",
                    runtimeCatalog = RuntimeCatalog(tools = listOf(
                        RuntimeToolOption("codex", "Codex", providers = listOf(
                            RuntimeProviderOption("qa-personal", "Personal · 示例"),
                            RuntimeProviderOption("qa-work", "Work · 示例"),
                        ), models = listOf(
                            RuntimeModelOption("qa-balanced", "Balanced · 示例", "qa-personal", supportsFast = true),
                            RuntimeModelOption("qa-reasoning", "Reasoning · 示例", "qa-personal"),
                            RuntimeModelOption("qa-fast", "Fast · 示例", "qa-work"),
                        )),
                        RuntimeToolOption("claude", "Claude", providers = listOf(
                            RuntimeProviderOption("qa-claude", "Personal · 示例"),
                        ), models = listOf(RuntimeModelOption("qa-claude-model", "Balanced · 示例", "qa-claude"))),
                    )),
                    timelineItems = (1..36).map { index ->
                        TimelineItem.Message(
                            id = "qa-$index", seq = index.toLong(),
                            role = if (index % 3 == 0) TimelineRole.User else TimelineRole.Agent,
                            completed = true,
                            text = if (index % 3 == 0) "检查第 $index 段的布局和背景采样，继续上下滚动。"
                            else "### 第 $index 段：阅读与配置\n\n这是一段用于检查玻璃材质的本地示例，不会提交真实请求。滚动时背景应保持动态采样，文字轮廓应被散焦成柔和色块。\n\n" +
                                "- 面板标题与当前选项清晰可读\n- 阴影、圆角与输入框保持一致\n- 打开键盘后面板仍可正常选择\n\n```kotlin\nval result = review(step = $index)\nprintln(result)\n```",
                        )
                    },
                ).let { initial -> initial.copy(runtimeSelectionDisplay = composerRuntimeIdentity(
                    initial.runtimeCatalog, initial.runtimeTool, initial.runtimeProvider, initial.runtimeModel,
                )) })
            }
            LaunchedEffect(panel) {
                if (panel == "queue-arrival" || panel == "queue-arrival-attachments") {
                    delay(intent.getIntExtra("queue_arrival_delay_ms", 900).coerceIn(0, 30_000).toLong())
                    val includesAttachments = panel == "queue-arrival-attachments"
                    state = state.copy(queuedMessages = listOf(
                        com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                            id = "qa-arrival-first", text = "Check the weekly report sources before continuing.",
                            attachments = if (includesAttachments) listOf(
                                com.andysagent.ragent.feature.workbench.ComposerAttachment(
                                    id = "qa-arrival-report", name = "weekly-report.pdf",
                                    mimeType = "application/pdf", sizeBytes = 284_000,
                                    assetId = "qa-asset-report",
                                ),
                            ) else emptyList(),
                        ),
                    ))
                    delay(1_200)
                    state = state.copy(queuedMessages = state.queuedMessages +
                        com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                            id = "qa-arrival-second",
                            text = if (includesAttachments) "" else "Keep the original source files unchanged.",
                            attachments = if (includesAttachments) listOf(
                                com.andysagent.ragent.feature.workbench.ComposerAttachment(
                                    id = "qa-arrival-image", name = "reference-image.png",
                                    mimeType = "image/png", sizeBytes = 456_000,
                                    assetId = "qa-asset-image",
                                ),
                            ) else emptyList(),
                        ))
                }
            }
            RagentTheme(darkTheme = dark, themeVariant = state.appTheme.value) {
                if (fullscreenOpen) {
                    com.andysagent.ragent.core.agentui.FullscreenComposerModal(
                        value = state.composerText,
                        onValueChange = { state = state.copy(composerText = it) },
                        onDismiss = { fullscreenOpen = false },
                        onSend = { state = state.copy(composerText = "") },
                        onStop = { state = state.copy(runStatus = AgentRunStatus.Idle) },
                        working = state.runStatus == AgentRunStatus.Working,
                        enabled = intent.getBooleanExtra("enabled", true),
                    )
                } else WorkbenchScreen(state = state, onEvent = { event ->
                    state = when (event) {
                        is WorkbenchEvent.SelectDestination -> state.copy(destination = event.destination, chatOpen = false)
                        is WorkbenchEvent.SelectTheme -> state.copy(appTheme = event.theme)
                        is WorkbenchEvent.OpenSettingsPage -> state.copy(settingsPage = event.page)
                        WorkbenchEvent.CloseSettingsPage -> state.copy(settingsPage = SettingsPage.Overview)
                        WorkbenchEvent.CloseChat -> state.copy(chatOpen = false)
                        is WorkbenchEvent.OpenProjectSessions -> state.copy(projectSessionsOpen = true, browsingProjectId = event.projectId)
                        WorkbenchEvent.CloseProjectSessions -> state.copy(projectSessionsOpen = false, browsingProjectId = null)
                        is WorkbenchEvent.SessionSearchChanged -> state.copy(sessionSearchQuery = event.value)
                        is WorkbenchEvent.SelectSession -> state.copy(chatOpen = true, sessionId = event.sessionId)
                        is WorkbenchEvent.ComposerChanged -> state.copy(composerText = event.text)
                        WorkbenchEvent.SendMessage -> if (state.runStatus == AgentRunStatus.Working && state.composerText.isNotBlank()) {
                            state.copy(composerText = "", queuedMessages = state.queuedMessages +
                                com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                                    id = "qa-sent-${System.nanoTime()}", text = state.composerText.trim(),
                                ))
                        } else state.copy(composerText = "")
                        is WorkbenchEvent.ResendQueuedMessage -> state.copy(
                            composerText = "",
                            queuedMessages = state.queuedMessages.filterNot { it.id == event.messageId } +
                                com.andysagent.ragent.feature.workbench.QueuedMessageUiState(
                                    id = "qa-resend-${System.nanoTime()}",
                                    text = event.text.trim(),
                                    attachments = event.attachments,
                                ),
                        )
                        is WorkbenchEvent.RemoveQueuedMessage -> state.copy(
                            queuedMessages = state.queuedMessages.filterNot { it.id == event.messageId })
                        is WorkbenchEvent.SteerMessage -> state.copy(
                            queuedMessages = state.queuedMessages.filterNot { it.id == event.messageId })
                        is WorkbenchEvent.ToggleGoalMode -> state.copy(goalMode = event.enabled)
                        is WorkbenchEvent.TogglePlanMode -> state.copy(planMode = event.enabled)
                        WorkbenchEvent.OpenGoalDialog -> state.copy(goalDialogOpen = true)
                        WorkbenchEvent.CloseGoalDialog -> state.copy(goalDialogOpen = false)
                        is WorkbenchEvent.SaveGoal -> state.copy(goalText = event.goal.trim(), goalDialogOpen = false,
                            goalMode = event.goal.isNotBlank() || state.goalMode)
                        WorkbenchEvent.ClearGoal -> state.copy(goalText = "", goalMode = false,
                            autoContinue = false, goalDialogOpen = false)
                        is WorkbenchEvent.StartAutoContinue -> state.copy(goalText = event.goal.trim(), goalMode = true,
                            autoContinue = true, goalDialogOpen = false)
                        WorkbenchEvent.PauseAutoContinue -> state.copy(autoContinue = false, goalDialogOpen = false)
                        is WorkbenchEvent.SelectDecisionOption -> {
                            val question = state.activeDecision
                            if (question == null || question.id != event.questionId || question.isSubmitting || question.isSubmitted) state
                            else state.copy(activeDecision = question.copy(selectedIndices = setOf(event.optionIndex)))
                        }
                        is WorkbenchEvent.DecisionWriteInChanged -> {
                            val question = state.activeDecision
                            if (question == null || question.id != event.questionId || question.isSubmitting || question.isSubmitted) state
                            else state.copy(activeDecision = question.copy(writeInText = event.text))
                        }
                        WorkbenchEvent.OpenRuntimePicker -> {
                            if (!state.runtimePickerOpen) pickerSnapshot = RuntimeSelection(
                                state.runtimeTool, state.runtimeProvider, state.runtimeModel, serviceTier = state.serviceTier,
                            )
                            state.copy(runtimePickerOpen = true, effortPickerOpen = false,
                                runtimeSelectionDisplay = if (state.runtimePickerOpen) state.runtimeSelectionDisplay else
                                    composerRuntimeIdentity(state.runtimeCatalog, state.runtimeTool, state.runtimeProvider, state.runtimeModel, state.runtimeSelectionDisplay))
                        }
                        WorkbenchEvent.CloseRuntimePicker -> {
                            val previous = pickerSnapshot
                            pickerSnapshot = null
                            state.copy(runtimePickerOpen = false,
                                runtimeTool = previous?.tool ?: state.runtimeTool,
                                runtimeProvider = if (previous != null) previous.providerProfile else state.runtimeProvider,
                                runtimeModel = if (previous != null) previous.model else state.runtimeModel,
                                serviceTier = previous?.serviceTier ?: state.serviceTier)
                        }
                        WorkbenchEvent.OpenEffortPicker -> state.copy(effortPickerOpen = true, runtimePickerOpen = false)
                        WorkbenchEvent.CloseEffortPicker -> state.copy(effortPickerOpen = false)
                        is WorkbenchEvent.EffortChanged -> state.copy(thinkingEffort = event.effort)
                        is WorkbenchEvent.SelectRuntime -> state.copy(runtimeTool = event.tool, runtimeProvider = null, runtimeModel = null, runtimePickerOpen = true)
                        is WorkbenchEvent.SelectProvider -> state.copy(runtimeProvider = event.provider, runtimeModel = null, runtimePickerOpen = true)
                        is WorkbenchEvent.SelectModel -> {
                            pickerSnapshot = null
                            state.copy(runtimeModel = event.model, runtimePickerOpen = false,
                                runtimeSelectionDisplay = composerRuntimeIdentity(state.runtimeCatalog, state.runtimeTool, state.runtimeProvider, event.model))
                        }
                        is WorkbenchEvent.SelectServiceTier -> state.copy(serviceTier = event.tier)
                        WorkbenchEvent.OpenSessionMenu -> state.copy(sessionMenuOpen = true)
                        WorkbenchEvent.CloseSessionMenu -> state.copy(sessionMenuOpen = false)
                        WorkbenchEvent.CompactSession -> state.copy(sessionMenuOpen = false)
                        WorkbenchEvent.DropTools -> state.copy(sessionMenuOpen = false)
                        is WorkbenchEvent.RenameSession -> state.copy(sessionTitle = event.name, sessionMenuOpen = false)
                        WorkbenchEvent.DeleteSession -> state.copy(sessionMenuOpen = false)
                        else -> state
                    }
                }, attentionState = attention, onAttentionEvent = { event ->
                    // Offline fixture only; decisions never leave this Activity.
                    attention = when (event) {
                        is AttentionEvent.SetExpanded -> attention.copy(expanded = event.expanded)
                        is AttentionEvent.Dismiss -> AttentionUiState()
                        AttentionEvent.ClearError -> attention.copy(error = null)
                        is AttentionEvent.ResolveApproval, is AttentionEvent.ResolveActionBatch ->
                            attention.copy(error = "Local preview: no real action was dispatched. Try again.")
                        else -> attention
                    }
                }, onAttentionOpenSession = { attention = AttentionUiState() },
                    organizationTransport = organizationDemoTransport)
            }
        }
    }
}
