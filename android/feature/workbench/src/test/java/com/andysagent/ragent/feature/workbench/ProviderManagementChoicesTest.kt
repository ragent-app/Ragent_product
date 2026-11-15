package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w390dp-h844dp")
class ProviderManagementChoicesTest {
    @get:Rule val rule = createComposeRule()

    @Test fun onlyInstalledSupportedHarnessesAppearWithAnExplanation() {
        val state = WebParityUiState(page = WebParityPage.ModelProviders, providerHarnessesLoaded = true, harnesses = listOf(
            WebHarness("codex", "Codex", installed = true),
            WebHarness("claude", "Claude", installed = false),
            WebHarness("qwen-code", "Qwen Code", installed = true, providerProtocols = listOf("openai-chat", "anthropic-messages")),
            WebHarness("unsupported", "Unsupported", installed = true, providerProtocols = emptyList()),
        ))
        rule.setContent { RagentTheme { WebParitySurface(WebParityPage.ModelProviders, state, {}, {}) } }
        rule.onNodeWithText("Add provider").performClick()
        rule.onNodeWithText("Only installed Harnesses that support provider setup are listed. Install a Harness on this computer to add its provider.").assertIsDisplayed()
        rule.onNodeWithTag("provider-harness-codex").assertExists()
        rule.onNodeWithTag("provider-harness-qwen-code").assertExists()
        rule.onNodeWithTag("provider-harness-claude").assertDoesNotExist()
        rule.onNodeWithTag("provider-harness-unsupported").assertDoesNotExist()
    }

    @Test fun noInstalledHarnessCannotCreateAProvider() {
        val state = WebParityUiState(page = WebParityPage.ModelProviders)
        rule.setContent { RagentTheme { WebParitySurface(WebParityPage.ModelProviders, state, {}, {}) } }
        rule.onNodeWithText("Add provider").performClick()
        rule.onNodeWithText("Save").assertIsNotEnabled()
    }

    @Test fun savedProviderWithoutHarnessCanStillBeEditedAndDeleted() {
        val state = WebParityUiState(page = WebParityPage.ModelProviders, providerHarnessesLoaded = true,
            providers = listOf(WebProvider("legacy", "Saved provider", "Claude", true, agentType = "claude")))
        rule.setContent { RagentTheme { WebParitySurface(WebParityPage.ModelProviders, state, {}, {}) } }
        rule.onNodeWithText("Not installed").assertIsDisplayed()
        rule.onNodeWithText("This instance has no matching Harness installed. You can still edit or delete its configuration.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Edit").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Delete").performScrollTo().assertIsDisplayed()
    }
}
