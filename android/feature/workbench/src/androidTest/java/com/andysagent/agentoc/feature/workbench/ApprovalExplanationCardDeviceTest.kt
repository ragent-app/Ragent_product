package com.andysagent.agentoc.feature.workbench

import androidx.activity.ComponentActivity
import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import java.util.Locale
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.agentui.ApprovalExplanationUiState
import com.andysagent.agentoc.core.agentui.ApprovalActionUiState
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Rule
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ApprovalExplanationCardDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun unavailableMacSessionCardAllowsOnlyDenial() {
        var denied = false
        val approval = PermissionRequestUiState(id = "mac", title = "Bash", reason = "Restart service",
            approveLabel = "Test approve", denyLabel = "Test deny", executorUnavailableReasonCode = "macos_administrator_unavailable")
        rule.setContent { AgentocTheme { ApprovalCardContent(approval, {}, { denied = true }, {}) } }
        rule.onNodeWithText(rule.activity.getString(R.string.approval_macos_executor_unavailable)).assertIsDisplayed()
        rule.onNodeWithText("Test approve").assertDoesNotExist()
        rule.onNodeWithText("Test deny").performClick()
        rule.runOnIdle { assertTrue(denied) }
    }

    @Test fun unavailableMacStructuredCardAllowsOnlyDenial() {
        var denied = false
        val approval = PermissionRequestUiState(id = "mac-batch", title = "Batch", reason = "Restart service",
            approveLabel = "Test approve", denyLabel = "Test deny", executorUnavailableReasonCode = "macos_administrator_unavailable",
            actions = listOf(ApprovalActionUiState(id = "op", description = "Restart", category = "privileged_other")))
        rule.setContent { AgentocTheme { StructuredApprovalCard(approval, { _, _ -> }, {}, { denied = true }) } }
        rule.onNodeWithText(rule.activity.getString(R.string.approval_macos_executor_unavailable)).assertIsDisplayed()
        rule.onNodeWithText("Test approve").assertDoesNotExist()
        rule.onNodeWithText("Test deny").performClick()
        rule.runOnIdle { assertTrue(denied) }
    }

    @Test fun sessionCardShowsLocalizedActionAndProviderDescription() {
        val approval = PermissionRequestUiState(id = "a", title = "Bash", reason = "Read example", command = "if true; then rm example; fi",
            explanation = ApprovalExplanationUiState(summary = "旧摘要", reason = "旧原因", operation = "delete",
                targets = listOf("example"), conditional = true, partial = true, riskCode = "composite_unanalyzed", providerConflict = true))
        rule.setContent { AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) } }
        val action = rule.activity.getString(R.string.approval_operation_delete)
        rule.onNodeWithText(rule.activity.getString(R.string.approval_operation_may, if (rule.activity.resources.configuration.locales[0]?.language == "en") action.replaceFirstChar { it.lowercase() } else action) + ": example").assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.approval_provider_description, "Read example")).assertExists()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_approve)).assertIsDisplayed()
    }

    @Test fun chineseLocaleUsesChineseSummaryAndRisk() {
        val configuration = Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.SIMPLIFIED_CHINESE) }
        val localizedContext = rule.activity.createConfigurationContext(configuration)
        val approval = PermissionRequestUiState(id = "zh", title = "Bash", reason = "", command = "rm example",
            explanation = ApprovalExplanationUiState(operation = "delete", targets = listOf("example"),
                conditional = true, partial = true, riskCode = "composite_unanalyzed"))
        rule.setContent {
            CompositionLocalProvider(LocalContext provides localizedContext, LocalConfiguration provides configuration) {
                AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) }
            }
        }
        rule.onNodeWithText("可能删除: example").assertIsDisplayed()
        rule.onNodeWithText("删除文件可能无法恢复，请核对完整目标路径。", substring = true).assertExists()
    }

    @Test fun englishLocaleUsesEnglishSummaryAndRisk() {
        val configuration = Configuration(rule.activity.resources.configuration).apply { setLocale(Locale.ENGLISH) }
        val localizedContext = rule.activity.createConfigurationContext(configuration)
        val approval = PermissionRequestUiState(id = "en", title = "Bash", reason = "", command = "rm example",
            explanation = ApprovalExplanationUiState(operation = "delete", targets = listOf("example"),
                conditional = true, partial = true, riskCode = "composite_unanalyzed"))
        rule.setContent {
            CompositionLocalProvider(LocalContext provides localizedContext, LocalConfiguration provides configuration) {
                AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) }
            }
        }
        rule.onNodeWithText("May delete: example").assertIsDisplayed()
        rule.onNodeWithText("Deleting files may be irreversible. Check the full target path.", substring = true).assertExists()
    }

    @Test fun legacyCompositeUsesProviderDescriptionAndLocalizedWarning() {
        val approval = PermissionRequestUiState(id = "legacy", title = "Bash", reason = "Remove example",
            command = "if true; then rm example; fi", explanation = ApprovalExplanationUiState(
                summary = "包含 3 步操作", reason = "命令串联了多个步骤，部分行为无法静态确认",
                saferAlternative = "拆成单条命令逐步确认后再执行"))
        rule.setContent { AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) } }
        rule.onNodeWithText("Remove example").assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.approval_provider_heading)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.approval_operation_partial)).assertExists()
    }

    @Test fun forcePushIncludesSpecificSaferOption() {
        val approval = PermissionRequestUiState(id = "force", title = "Bash", reason = "",
            command = "git push --force", explanation = ApprovalExplanationUiState(operation = "git_force_push", riskCode = "force_push"))
        rule.setContent { AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) } }
        rule.onNodeWithText(rule.activity.getString(R.string.approval_safer_force_push)).assertExists()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
    }

    @Test fun longSummaryKeepsDecisionButtonsVisible() {
        val approval = PermissionRequestUiState(id = "long", title = "Bash", reason = "",
            command = "rm very-long-name", explanation = ApprovalExplanationUiState(operation = "delete",
                targets = listOf("very-long-name-".repeat(35)), riskCode = "delete_unresolvable"))
        rule.setContent { AgentocTheme { ApprovalCardContent(approval, {}, {}, {}) } }
        rule.onNodeWithText(rule.activity.getString(R.string.attention_deny)).assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(R.string.attention_approve)).assertIsDisplayed()
    }
}
