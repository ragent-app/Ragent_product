package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w390dp-h844dp")
class ProviderOAuthDialogTest {
    @get:Rule val compose = createComposeRule()
    @Test fun `device code is visible with reopen and cancellation controls`() {
        val events = mutableListOf<WebParityEvent>()
        compose.setContent { RagentTheme { ProviderOAuthDialog(WebParityUiState(providerOAuthJob =
            ProviderOAuthJob("fixture", "codex", "pending", "https://auth.openai.com/codex/device", "TEST-CODE", false, "", "")), events::add) } }
        compose.onNodeWithText("TEST-CODE").assertIsDisplayed()
        compose.onNodeWithText("Copy device code").assertIsDisplayed()
        compose.onNodeWithText("Open login page").performScrollTo().performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.runOnIdle { assertEquals(WebParityEvent.OpenProviderOAuth, events.last()) }
        compose.onNodeWithText("Cancel login").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.runOnIdle { assertEquals(WebParityEvent.CancelProviderOAuth, events.last()) }
    }
    @Test fun `saved state does not show obsolete code or ask for more authentication`() {
        compose.setContent { RagentTheme { ProviderOAuthDialog(WebParityUiState(providerOAuthJob =
            ProviderOAuthJob("fixture", "codex", "completed", null, "", false, "saved", "")), {}) } }
        compose.onNodeWithText("Account saved on the connected computer.").assertIsDisplayed()
        compose.onNodeWithText("Copy device code").assertDoesNotExist()
        compose.onNodeWithText("Close").assertIsEnabled()
    }
    @Test fun `agy dialog hides device code controls and shows credential input when awaiting input`() {
        compose.setContent { RagentTheme { ProviderOAuthDialog(WebParityUiState(providerOAuthJob =
            ProviderOAuthJob("fixture", "agy", "awaiting-input", "https://accounts.google.com/o/oauth2/v2/auth?state=1", "FALSE-CODE", true, "", "")), {}) } }
        compose.onNodeWithText("Copy device code").assertDoesNotExist()
        compose.onNodeWithText("FALSE-CODE").assertDoesNotExist()
        compose.onNodeWithText("Open login page").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Submit credential").performScrollTo().assertIsDisplayed()
    }
    @Test fun `add provider dialog stays open and shows error when OAuth start fails`() {
        var state by mutableStateOf(WebParityUiState(
            page = WebParityPage.ModelProviders,
            harnesses = listOf(WebHarness("agy", "Antigravity CLI", installed = true, providerProtocols = listOf("agy"))),
            providerHarnessesLoaded = true,
        ))
        compose.setContent {
            RagentTheme {
                WebParitySurface(
                    page = WebParityPage.ModelProviders,
                    state = state,
                    onEvent = { event ->
                        if (event is WebParityEvent.StartProviderOAuth) {
                            state = state.copy(actionInProgress = false, error = "agy internal runtime is unavailable.")
                        }
                    },
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("Add provider").performClick()
        compose.onNodeWithTag("provider-save").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.waitForIdle()
        compose.onNodeWithText("Start login").assertIsDisplayed()
        compose.onAllNodesWithText("agy internal runtime is unavailable.").assertCountEquals(2)
    }
}
