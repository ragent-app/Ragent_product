package com.andysagent.ragent.feature.workbench

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
@Config(sdk = [35])
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
}
