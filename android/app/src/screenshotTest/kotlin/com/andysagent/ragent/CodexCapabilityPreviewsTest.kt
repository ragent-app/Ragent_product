package com.andysagent.ragent

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WebCodexPluginPreference
import com.andysagent.ragent.feature.workbench.WebCodexApp
import com.andysagent.ragent.feature.workbench.WebCodexSkill
import com.andysagent.ragent.feature.workbench.WebCodexSyncState
import com.andysagent.ragent.feature.workbench.WebMcpServer
import com.andysagent.ragent.feature.workbench.WebMcpOAuthJob
import com.andysagent.ragent.feature.workbench.WebParityPage
import com.andysagent.ragent.feature.workbench.WebParitySurface
import com.andysagent.ragent.feature.workbench.WebParityUiState
import com.andysagent.ragent.feature.workbench.WebProvider

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
    RagentTheme(darkTheme = false) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows 工作电脑")
    }
}

@Preview(name = "codex-capabilities-phone-zh", widthDp = 320, heightDp = 720, locale = "zh-rCN", fontScale = 1.3f, showBackground = true)
@PreviewTest
@Composable
fun CodexCapabilitiesPhonePreview() {
    RagentTheme(darkTheme = false) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows 工作电脑")
    }
}

@Preview(name = "codex-capabilities-dark-en", widthDp = 360, heightDp = 1600, locale = "en", showBackground = true)
@PreviewTest
@Composable
fun CodexCapabilitiesDarkPreview() {
    RagentTheme(darkTheme = true) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture(), onEvent = {}, onBack = {}, targetLabel = "Windows workstation")
    }
}

@Preview(name = "mcp-mobile-auth-compact-zh", widthDp = 320, heightDp = 720, locale = "zh-rCN", fontScale = 1.3f, showBackground = true)
@PreviewTest
@Composable
fun McpMobileAuthorizationCompactPreview() {
    RagentTheme(darkTheme = false) {
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
    RagentTheme(darkTheme = true) {
        WebParitySurface(WebParityPage.Connectors, capabilityFixture().copy(
            mcpOAuthJob = WebMcpOAuthJob("job", "account-a", "google-drive", "https://example.invalid/authorize", "pending", mobileCallbackSupported = true, callbackSubmitted = true),
        ), onEvent = {}, onBack = {}, targetLabel = "Windows workstation")
    }
}
