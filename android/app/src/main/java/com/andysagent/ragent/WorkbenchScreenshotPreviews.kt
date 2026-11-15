package com.andysagent.ragent

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.PermissionRequestCard
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.AccountsRepository
import com.andysagent.ragent.core.domain.GoogleAccountStatusResult
import com.andysagent.ragent.core.domain.GoogleTokenSubmitResult
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationKind
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import com.andysagent.ragent.feature.workbench.SettingsPage
import com.andysagent.ragent.feature.workbench.PairingOnboardingStep
import com.andysagent.ragent.feature.workbench.PairingOnboardingUiState
import com.andysagent.ragent.feature.workbench.accounts.AccountsViewModel

/** Preview-only accounts VM: never submits (Settings is not in the golden states). */
internal fun previewAccountsViewModel(): AccountsViewModel = AccountsViewModel(object : AccountsRepository {
    override suspend fun getGoogleAccountStatus(): GoogleAccountStatusResult =
        GoogleAccountStatusResult(enabled = true, bound = false, mode = "accounts")

    override suspend fun submitGoogleIdToken(idToken: String, alias: String?): GoogleTokenSubmitResult =
        GoogleTokenSubmitResult(bound = false, mode = "legacy")
})

/**
 * Golden baseline previews for the Workbench surface.
 *
 * Consumed by :app:recordDebugScreenshotTest to establish Compose screenshot
 * baselines for the key session states. Keep these deterministic: no infinite
 * animations, no time/random inputs. Names become the golden image filenames.
 */
internal object WorkbenchGoldenStates {
    val sessionIdle = WorkbenchUiState(chatOpen = true, sessionId = "session-idle")

    val sessionRunning = WorkbenchUiState(
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

    val sessionError = WorkbenchUiState(
        chatOpen = true,
        sessionId = "session-error",
        error = "Connect a computer before sending a message.",
    )

    val sessionApproval = sessionRunning.copy(
        runStatus = AgentRunStatus.WaitingApproval,
        sessionTitle = "Publish weekly report",
        approval = PermissionRequestUiState(
            id = "approval-1",
            title = "Approve file upload",
            reason = "Ragent is ready to upload the final report to the shared workspace.",
            saferAlternative = "Review the generated report before allowing the upload.",
        ),
    )

    val sessionCompleted = sessionRunning.copy(
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Prepare weekly report",
        timelineItems = listOf(
            TimelineItem.Message(id = "u2", seq = 1, role = TimelineRole.User, text = "Prepare the weekly report from the new exports.", completed = true),
            TimelineItem.Operation(id = "op2", seq = 2, kind = TimelineOperationKind.FileEdit, title = "weekly-report.xlsx", detail = "/work/reports/weekly-report.xlsx", status = TimelineOperationStatus.Completed),
            TimelineItem.Message(id = "c2", seq = 3, role = TimelineRole.Agent, text = "## Report ready\n\nThe report is **ready**. I cleaned the source data, updated the summary, and saved the final workbook.\n\n- Source data cleaned\n- Summary updated\n\n```text\nweekly-report.xlsx\n```", completed = true),
        ),
    )

    val sessionMarkdownStress = sessionRunning.copy(
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Markdown Theme Verification",
        timelineItems = listOf(
            TimelineItem.Message(id = "u-stress", seq = 1, role = TimelineRole.User, text = "请执行 AgentoMarkdownTheme v1 全要素视觉回归测试", completed = true),
            TimelineItem.Message(id = "c-stress", seq = 2, role = TimelineRole.Agent, text = com.andysagent.ragent.core.agentui.STRESS_TEST_MARKDOWN, completed = true),
        ),
    )

    val sessionInlineCodeWrap = sessionRunning.copy(
        runStatus = AgentRunStatus.Completed,
        sessionTitle = "Inline Code Wrap Verification",
        timelineItems = listOf(
            TimelineItem.Message(id = "u-wrap", seq = 1, role = TimelineRole.User, text = "验证跨行 inline code 背景的分段绘制", completed = true),
            TimelineItem.Message(id = "c-wrap", seq = 2, role = TimelineRole.Agent, text = com.andysagent.ragent.core.agentui.INLINE_CODE_WRAP_MARKDOWN, completed = true),
        ),
    )

    val home = WorkbenchUiState(
        destination = AgentoDestination.Home,
        computers = listOf(Computer("computer-windows", "Office PC", "Windows", connected = true)),
        sessions = listOf(
            Session("home-waiting", "Review the monthly export", status = SessionStatus.WaitingApproval, latestSeq = 10),
            Session("home-running", "Clean up weekly exports", status = SessionStatus.Working, latestSeq = 9),
            Session("home-complete", "Prepare the quarterly report", status = SessionStatus.Completed, latestSeq = 8),
        ),
    )

    val sessions = WorkbenchUiState(
        destination = AgentoDestination.Sessions,
        projects = listOf(
            Project("project-1", "Operations", "/work/operations"),
            Project("project-2", "Quarterly reports", "/work/reports"),
        ),
        sessions = listOf(
            Session("session-1", "Prepare weekly operations summary", "project-1", SessionStatus.Working, latestSeq = 12),
            Session("session-2", "Review monthly export", "project-1", SessionStatus.WaitingApproval, latestSeq = 8),
            Session("session-3", "Quarterly folders are ready", "project-2", SessionStatus.Completed, latestSeq = 5),
        ),
        selectedProjectId = "project-1",
    )

    val projectL2 = sessions.copy(
        projectSessionsOpen = true,
        browsingProjectId = "project-1",
    )

    val projectDialog = sessions.copy(
        projectDialogOpen = true,
        projectName = "Customer exports",
        projectRootPath = "C:/Work/customer-exports",
    )
}

@Preview(name = "session-idle", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionIdlePreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionIdle, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-idle-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionIdleDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessionIdle, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-running", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionRunningPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionRunning, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-running-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionRunningDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessionRunning, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-error", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionErrorPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionError, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-approval", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionApprovalPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionApproval, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-completed", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionCompletedPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionCompleted, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-completed-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionCompletedDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessionCompleted, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-markdown-stress", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionMarkdownStressPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionMarkdownStress, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-markdown-stress-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionMarkdownStressDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessionMarkdownStress, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-inline-code-wrap", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionInlineCodeWrapPreview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessionInlineCodeWrap, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "session-inline-code-wrap-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionInlineCodeWrapDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessionInlineCodeWrap, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "approval-dialog", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ApprovalDialogPreview() {
    RagentTheme {
        Column(Modifier.padding(RagentSpacing.Gutter)) {
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
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.home, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "home-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun HomeDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.home, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "settings", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SettingsPreview() {
    RagentTheme {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Settings),
            accountsViewModel = previewAccountsViewModel(),
        )
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
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.sessions, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "sessions-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun SessionsDarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.sessions, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "projects-l2", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsL2Preview() {
    RagentTheme { WorkbenchScreen(WorkbenchGoldenStates.projectL2, accountsViewModel = previewAccountsViewModel()) }
}

@Preview(name = "projects-l2-dark", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectsL2DarkPreview() {
    RagentTheme(darkTheme = true) { WorkbenchScreen(WorkbenchGoldenStates.projectL2, accountsViewModel = previewAccountsViewModel()) }
}


@Preview(name = "sessions-expanded", showBackground = true, widthDp = 1024, heightDp = 768)
@Composable
fun SessionsExpandedPreview() {
    RagentTheme {
        WorkbenchScreen(
            WorkbenchGoldenStates.sessions.copy(
                chatOpen = true,
                sessionId = "session-1",
                sessionTitle = "Prepare weekly operations summary",
                connection = AgentConnectionStatus.Connected,
                runStatus = AgentRunStatus.Working,
                timelineItems = listOf(
                    TimelineItem.Message(
                        id = "tablet-preview-message",
                        seq = 1,
                        role = TimelineRole.Agent,
                        text = "Checking the latest operations export.",
                        completed = false,
                    ),
                ),
            ),
            accountsViewModel = previewAccountsViewModel(),
            windowSizeClass = com.andysagent.ragent.core.navigation.AgentoWindowSizeClass.Expanded,
        )
    }
}

@Preview(name = "project-dialog", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun ProjectDialogPreview() {
    RagentTheme {
        WorkbenchScreen(WorkbenchGoldenStates.projectDialog, accountsViewModel = previewAccountsViewModel())
    }
}

@Preview(name = "pairing-scan", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
fun PairingScanPreview() {
    RagentTheme {
        WorkbenchScreen(
            WorkbenchUiState(destination = AgentoDestination.Settings),
            accountsViewModel = previewAccountsViewModel(),
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
            WorkbenchUiState(destination = AgentoDestination.Settings),
            accountsViewModel = previewAccountsViewModel(),
            pairingOnboardingState = PairingOnboardingUiState(
                open = true,
                step = PairingOnboardingStep.Error,
                errorMessage = "This pairing code expired. Show a new code on the computer and scan again.",
            ),
        )
    }
}
