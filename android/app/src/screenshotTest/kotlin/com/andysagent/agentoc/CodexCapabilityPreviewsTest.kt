package com.andysagent.agentoc

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.WebCodexPluginPreference
import com.andysagent.agentoc.feature.workbench.WebCodexApp
import com.andysagent.agentoc.feature.workbench.WebCodexSkill
import com.andysagent.agentoc.feature.workbench.WebCodexSyncState
import com.andysagent.agentoc.feature.workbench.WebMcpServer
import com.andysagent.agentoc.feature.workbench.WebMcpOAuthJob
import com.andysagent.agentoc.feature.workbench.WebParityPage
import com.andysagent.agentoc.feature.workbench.WebParitySurface
import com.andysagent.agentoc.feature.workbench.WebParityUiState
import com.andysagent.agentoc.feature.workbench.WebProvider

private fun capabilityFixture() = WebParityUiState(
    page = WebParityPage.Connectors,
    openSessionId = "session",
    providers = listOf(
        WebProvider("account-a", "工作账号 long-account-name@example.com", "Codex", true),
        WebProvider("account-b", "个人账号", "Codex", true),
    ),
    mcpServers = listOf(WebMcpServer("codex", "google-drive", "http", "account-a", "authorization_required")),
    codexManagementProviderId = "account-a",
    codexPluginPreference = WebCodexPluginPreference("account-a", true),
    codexSyncState = WebCodexSyncState("account-a", "discovered"),
    codexApps = listOf(WebCodexApp("drive", "account-a", "Google Drive", "callable", "enabled", true)),
    codexSkills = listOf(WebCodexSkill("skill", "account-a", "文档处理", true, false)),
)

@Preview(name = "codex-capabilities-compact-zh", widthDp = 320, heightDp = 1600, locale = "zh-rCN", fontScale = 1.3f, showBackground = true)
@PreviewTest
@Composable
fun CodexCapabilitiesCompactPreview() {
    AgentocTheme(darkTheme = false) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows 工作电脑")
    }
}

@Preview(name = "codex-capabilities-phone-zh", widthDp = 320, heightDp = 720, locale = "zh-rCN", fontScale = 1.3f, showBackground = true)
@PreviewTest
@Composable
fun CodexCapabilitiesPhonePreview() {
    AgentocTheme(darkTheme = false) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows 工作电脑")
    }
}

@Preview(name = "codex-capabilities-dark-en", widthDp = 360, heightDp = 1600, locale = "en", showBackground = true)
@PreviewTest
@Composable
fun CodexCapabilitiesDarkPreview() {
    AgentocTheme(darkTheme = true) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows workstation")
    }
}

@Preview(name = "mcp-mobile-auth-compact-zh", widthDp = 320, heightDp = 720, locale = "zh-rCN", fontScale = 1.3f, showBackground = true)
@PreviewTest
@Composable
fun McpMobileAuthorizationCompactPreview() {
    AgentocTheme(darkTheme = false) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture().copy(
            mcpOAuthJob = WebMcpOAuthJob("job", "account-a", "google-drive", "https://example.invalid/authorize", "pending", mobileCallbackSupported = true),
            error = "Callback is invalid, expired, or unsupported",
        ), onEvent = {}, onBack = {}, targetLabel = "Windows 工作电脑")
    }
}

@Preview(name = "mcp-mobile-auth-submitted-en", widthDp = 360, heightDp = 720, locale = "en", showBackground = true)
@PreviewTest
@Composable
fun McpMobileAuthorizationSubmittedPreview() {
    AgentocTheme(darkTheme = true) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture().copy(
            mcpOAuthJob = WebMcpOAuthJob("job", "account-a", "google-drive", "https://example.invalid/authorize", "pending", mobileCallbackSupported = true, callbackSubmitted = true),
        ), onEvent = {}, onBack = {}, targetLabel = "Windows workstation")
    }
}
