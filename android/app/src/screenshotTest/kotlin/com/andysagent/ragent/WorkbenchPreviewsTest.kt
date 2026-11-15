package com.andysagent.ragent

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.PermissionRequestCard
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionItem
import com.andysagent.ragent.core.model.AttentionKind
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.PairingOnboardingStep
import com.andysagent.ragent.feature.workbench.PairingOnboardingUiState
import com.andysagent.ragent.feature.workbench.ProjectsReferenceFixtures
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.SettingsPage

private fun previewRunningState(): WorkbenchUiState = WorkbenchUiState(
    chatOpen = true,
    sessionId = "session-running",
    connection = AgentConnectionStatus.Connected,
    runStatus = AgentRunStatus.Working,
    sessionTitle = "Refactor network layer",
    timelineItems = listOf(
        TimelineItem.Operation(
            id = "op1",
            seq = 1,
            kind = TimelineOperationKind.Command,
            title = "npm test",
            detail = "npx vitest run",
            status = TimelineOperationStatus.InProgress,
        ),
        TimelineItem.Message(id = "s", seq = 2, role = TimelineRole.Agent, text = "Running the test suite…", completed = false),
        TimelineItem.Message(id = "u", seq = 3, role = TimelineRole.User, text = "check tests", completed = true),
        TimelineItem.Message(id = "c", seq = 4, role = TimelineRole.Agent, text = "All 42 tests passed.", completed = true),
    ),
)

private fun previewApprovalState(): WorkbenchUiState = previewRunningState().copy(
    runStatus = AgentRunStatus.WaitingApproval,
    sessionTitle = "Publish weekly report",
    approval = PermissionRequestUiState(
        id = "approval-1",
        title = "Approve file upload",
        reason = "Ragent is ready to upload the final report to the shared workspace.",
        saferAlternative = "Review the generated report before allowing the upload.",
    ),
)

private fun previewCompletedState(): WorkbenchUiState = previewRunningState().copy(
    runStatus = AgentRunStatus.Completed,
    sessionTitle = "Prepare weekly report",
    timelineItems = listOf(
        TimelineItem.Message(id = "u2", seq = 1, role = TimelineRole.User, text = "Prepare the weekly report from the new exports.", completed = true),
        TimelineItem.Operation(id = "op2", seq = 2, kind = TimelineOperationKind.FileEdit, title = "weekly-report.xlsx", detail = "/work/reports/weekly-report.xlsx", status = TimelineOperationStatus.Completed),
        TimelineItem.Message(id = "c2", seq = 3, role = TimelineRole.Agent, text = "## Report ready\n\nThe report is **ready**. I cleaned the source data, updated the summary, and saved the final workbook.\n\n- Source data cleaned\n- Summary updated\n\n```text\nweekly-report.xlsx\n```", completed = true),
    ),
)

private fun previewMarkdownStressState(): WorkbenchUiState = previewRunningState().copy(
    runStatus = AgentRunStatus.Completed,
    sessionTitle = "Markdown Theme Verification",
    timelineItems = listOf(
        TimelineItem.Message(id = "u-stress", seq = 1, role = TimelineRole.User, text = "请执行 AgentoMarkdownTheme v1 全要素视觉回归测试", completed = true),
        TimelineItem.Message(id = "c-stress", seq = 2, role = TimelineRole.Agent, text = com.andysagent.ragent.core.agentui.STRESS_TEST_MARKDOWN, completed = true),
    ),
)

private fun previewProjectsReferenceState() = WorkbenchUiState(
    destination = AgentoDestination.Sessions,
    computers = listOf(
        Computer("computer-windows", "Office PC", "Windows", connected = true),
        Computer("computer-linux", "Build machine", "Linux", connected = false),
    ),
    projects = listOf(
        Project("project-operations", "Operations", "C:/Work/operations"),
        Project("project-reports", "Quarterly reports", "C:/Work/reports"),
        Project("project-inbox", "Unsorted work", "C:/Work/inbox"),
    ),
    sessions = listOf(
        Session("session-cleanup", "Clean up weekly exports", "project-operations", SessionStatus.Working, latestSeq = 12),
        Session("session-approval", "Review the monthly export", "project-operations", SessionStatus.WaitingApproval, latestSeq = 10),
        Session("session-archive", "Archive completed files", "project-operations", SessionStatus.Completed, latestSeq = 6),
        Session("session-quarterly", "Prepare the quarterly report", "project-reports", SessionStatus.Completed, latestSeq = 8),
        Session("session-inbox", "Rename incoming documents", "project-inbox", SessionStatus.Idle, latestSeq = 2),
    ),
    selectedProjectId = "project-operations",
)

@Preview(name = "session-idle", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionIdlePreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-idle"))
    }
}

@Preview(name = "session-idle-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionIdleDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(WorkbenchUiState(chatOpen = true, sessionId = "session-idle"))
    }
}

@Preview(name = "session-running", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionRunningPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewRunningState())
    }
}

@Preview(name = "session-running-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionRunningDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(previewRunningState())
    }
}

@Preview(name = "session-error", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionErrorPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            WorkbenchUiState(
                chatOpen = true,
                sessionId = "session-error",
                error = "Connect a computer before sending a message.",
            ),
        )
    }
}

@Preview(name = "session-approval", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionApprovalPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewApprovalState())
    }
}

@Preview(name = "session-completed", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionCompletedPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewCompletedState())
    }
}

@Preview(name = "session-completed-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionCompletedDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(previewCompletedState())
    }
}

@Preview(name = "session-markdown-stress", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionMarkdownStressPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewMarkdownStressState())
    }
}

@Preview(name = "session-markdown-stress-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionMarkdownStressDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(previewMarkdownStressState())
    }
}

@Preview(name = "session-goal-mode", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionGoalModePreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewCompletedState().copy(goalMode = true, goalText = "Deploy v2"))
    }
}

@Preview(name = "session-effort-picker", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionEffortPickerPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(previewCompletedState().copy(effortPickerOpen = true, thinkingEffort = 0.8f))
    }
}

@Preview(name = "session-effort-picker-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionEffortPickerDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(previewCompletedState().copy(effortPickerOpen = true, thinkingEffort = 0.8f))
    }
}

@Preview(name = "session-user-message-long", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionUserMessageLongPreview() {
    val longText = "Please refactor the network layer to use WebSockets with automatic reconnection, heartbeat pings every 15 seconds, and exponential backoff retry. Ensure data payload compression is enabled and verify all tests pass."
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            previewCompletedState().copy(
                timelineItems = listOf(
                    TimelineItem.Message(id = "u1", seq = 1, role = TimelineRole.User, text = "Hi", completed = true),
                    TimelineItem.Message(id = "u2", seq = 2, role = TimelineRole.User, text = longText, completed = true),
                    TimelineItem.Message(id = "c1", seq = 3, role = TimelineRole.Agent, text = "I'm starting the refactor as requested.", completed = true),
                ),
            ),
        )
    }
}

@Preview(name = "session-user-message-long-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionUserMessageLongDarkPreview() {
    val longText = "Please refactor the network layer to use WebSockets with automatic reconnection, heartbeat pings every 15 seconds, and exponential backoff retry. Ensure data payload compression is enabled and verify all tests pass."
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            previewCompletedState().copy(
                timelineItems = listOf(
                    TimelineItem.Message(id = "u1", seq = 1, role = TimelineRole.User, text = "Hi", completed = true),
                    TimelineItem.Message(id = "u2", seq = 2, role = TimelineRole.User, text = longText, completed = true),
                    TimelineItem.Message(id = "c1", seq = 3, role = TimelineRole.Agent, text = "I'm starting the refactor as requested.", completed = true),
                ),
            ),
        )
    }
}

@Preview(name = "approval-dialog", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ApprovalDialogPreview() {
    RagentTheme {
        Box(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(RagentSpacing.Gutter)) {
            PermissionRequestCard(
                state = PermissionRequestUiState(
                    id = "approval-1",
                    title = "Approve command",
                    reason = "The agent wants to run `git push origin main` on your computer.",
                    saferAlternative = "You can review the exact diff before approving.",
                ),
                onApprove = {},
                onDeny = {},
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Preview(name = "home", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun HomePreview() {
    RagentTheme {
        WorkbenchScreen(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                connection = AgentConnectionStatus.Connected,
                computers = listOf(Computer("computer-windows", "Office PC", "Windows", connected = true)),
                sessions = listOf(
                    Session("session-waiting", "Review the monthly export", status = SessionStatus.WaitingApproval, latestSeq = 10),
                    Session("session-running", "Clean up weekly exports", status = SessionStatus.Working, latestSeq = 9),
                    Session("session-complete", "Prepare the quarterly report", status = SessionStatus.Completed, latestSeq = 8),
                ),
            ),
        )
    }
}

@Preview(name = "home-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun HomeDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            WorkbenchUiState(
                destination = AgentoDestination.Home,
                connection = AgentConnectionStatus.Connected,
                computers = listOf(Computer("computer-windows", "Office PC", "Windows", connected = true)),
                sessions = listOf(
                    Session("session-waiting", "Review the monthly export", status = SessionStatus.WaitingApproval, latestSeq = 10),
                    Session("session-running", "Clean up weekly exports", status = SessionStatus.Working, latestSeq = 9),
                    Session("session-complete", "Prepare the quarterly report", status = SessionStatus.Completed, latestSeq = 8),
                ),
            ),
        )
    }
}

@Preview(name = "settings", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SettingsPreview() {
    RagentTheme {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Settings))
    }
}

@Preview(name = "settings-manage-devices", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SettingsManageDevicesPreview() {
    RagentTheme {
        WorkbenchScreen(
            WorkbenchUiState(
                destination = AgentoDestination.Settings,
                settingsPage = SettingsPage.ComputerManagement,
                accountComputers = listOf(
                    RemoteTarget(
                        instanceId = "office",
                        label = "Office PC",
                        endpoint = "https://office.example.test",
                        platform = "Windows",
                        lastSelectedAt = 20L,
                    ),
                    RemoteTarget(
                        instanceId = "home",
                        label = "Home PC",
                        endpoint = "https://home.example.test",
                        platform = "Windows",
                        linkedToPhone = false,
                    ),
                ),
                activeRemoteTargetId = "office",
                connection = AgentConnectionStatus.Connected,
            ),
        )
    }
}

@Preview(name = "sessions", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionsPreview() {
    RagentTheme {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Sessions))
    }
}

@Preview(name = "sessions-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionsDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(WorkbenchUiState(destination = AgentoDestination.Sessions))
    }
}

@Preview(name = "projects-l2", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsL2Preview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            state = previewProjectsReferenceState().copy(
                projectSessionsOpen = true,
                browsingProjectId = "project-operations",
            ),
            windowSizeClass = AgentoWindowSizeClass.Compact,
        )
    }
}

@Preview(name = "projects-l2-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsL2DarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            state = previewProjectsReferenceState().copy(
                projectSessionsOpen = true,
                browsingProjectId = "project-operations",
            ),
            windowSizeClass = AgentoWindowSizeClass.Compact,
        )
    }
}


@Preview(name = "projects-sessions-compact-light", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsSessionsCompactLightPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            state = previewProjectsReferenceState(),
            windowSizeClass = AgentoWindowSizeClass.Compact,
        )
    }
}

@Preview(name = "projects-sessions-compact-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsSessionsCompactDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            state = previewProjectsReferenceState(),
            windowSizeClass = AgentoWindowSizeClass.Compact,
        )
    }
}

@Preview(name = "projects-sessions-reference-expanded-empty", showBackground = true, widthDp = 1024, heightDp = 768)
@Composable
fun ProjectsSessionsReferenceExpandedEmptyPreview() {
    RagentTheme {
        WorkbenchScreen(
            state = previewProjectsReferenceState(),
            windowSizeClass = AgentoWindowSizeClass.Expanded,
        )
    }
}

@Preview(name = "project-dialog", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectDialogPreview() {
    RagentTheme {
        WorkbenchScreen(
            state = previewProjectsReferenceState().copy(
                projectDialogOpen = true,
                projectName = "Customer exports",
                projectRootPath = "C:/Work/customer-exports",
            ),
        )
    }
}

@Preview(name = "pairing-scan", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun PairingScanPreview() {
    RagentTheme {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Settings),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.AccountClaimRequired,
            ),
        )
    }
}

@Preview(name = "pairing-error-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun PairingErrorDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Settings),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.Error,
                errorMessage = "This pairing code expired. Show a new code on the computer and scan again.",
            ),
        )
    }
}

private fun previewAttentionApproval(expanded: Boolean = false, extra: Int = 0): AttentionUiState {
    val approvalItem = AttentionItem(
        id = AttentionReducer.approvalItemId("session-approval", "approval-1"),
        sessionId = "session-approval",
        sessionTitle = "Publish weekly report",
        kind = AttentionKind.Approval,
        title = "Approve command",
        summary = "git push origin main — 需要你的确认",
        reason = "The agent wants to run `git push origin main` on your computer.",
        priority = AttentionItem.PRIORITY_NORMAL,
        approval = Approval(
            id = "approval-1",
            sessionId = "session-approval",
            title = "Approve command",
            reason = "The agent wants to run `git push origin main` on your computer.",
            passkeyRequired = false,
        ),
    )
    val queued = (0 until extra).map { index ->
        AttentionItem(
            id = "waiting:session-queued-$index",
            sessionId = "session-queued-$index",
            sessionTitle = "Follow-up task $index",
            kind = AttentionKind.Question,
            title = "Follow-up task $index",
            summary = "有一个问题等待你的回答",
            updatedAt = 100L + index,
        )
    }
    val items = (listOf(approvalItem) + queued).sortedBy { it.priority }
    return AttentionUiState(
        items = items,
        activeItemId = items.first().id,
        expanded = expanded,
    )
}

@Preview(name = "attention-brief", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun AttentionBriefPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = previewAttentionApproval(),
        )
    }
}

@Preview(name = "attention-brief-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun AttentionBriefDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = previewAttentionApproval(),
        )
    }
}

@Preview(name = "attention-expanded", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun AttentionExpandedPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = previewAttentionApproval(expanded = true),
        )
    }
}

@Preview(name = "attention-queued", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun AttentionQueuedPreview() {
    RagentTheme(darkTheme = false) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = previewAttentionApproval(expanded = false, extra = 2),
        )
    }
}

@Preview(name = "attention-completion-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun AttentionCompletionDarkPreview() {
    RagentTheme(darkTheme = true) {
        WorkbenchScreen(
            state = WorkbenchUiState(destination = AgentoDestination.Home),
            attentionState = AttentionUiState(
                items = listOf(
                    AttentionItem(
                        id = "completion:session-done",
                        sessionId = "session-done",
                        sessionTitle = "Prepare weekly report",
                        kind = AttentionKind.Completion,
                        title = "Prepare weekly report",
                        summary = "任务已完成",
                        priority = AttentionItem.PRIORITY_COMPLETION,
                    ),
                ),
                activeItemId = "completion:session-done",
            ),
        )
    }
}
