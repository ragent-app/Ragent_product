package com.andysagent.agentoc.feature.workbench.accounts

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.feature.workbench.DemoEnvironmentSurface
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DemoConnectionGateTest {
    @get:Rule val rule = createComposeRule()

    @Test fun connectionProgressFloatsOverTheMountedWorkbench() {
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(true, DemoConnectionUiState(active = true)) { Text("Send a task") }
        } }
        rule.onNodeWithTag("demo-connection-progress").assertIsDisplayed()
        rule.onNodeWithText("Finding your workspace").assertIsDisplayed()
        rule.onNodeWithText("Send a task").assertExists()
    }

    @Test fun closingFailureDoesNotSignOutOrRemoveTheWorkbench() {
        var signOut = 0
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(restricted = false, testAccount = true,
                connection = DemoConnectionUiState(active = true, phase = DemoConnectionPhase.Unavailable),
                onSignOut = { signOut++ }) { Text("Review workbench") }
        } }
        rule.onNodeWithText("Close").performClick()
        rule.onNodeWithTag("demo-connection-gate").assertDoesNotExist()
        rule.onNodeWithText("Review workbench").assertIsDisplayed()
        assertEquals(0, signOut)
    }

    @Test fun normalGoogleAccountsKeepTheirWorkbenchDuringDemoRecovery() {
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(false, DemoConnectionUiState(active = true)) { Text("Normal workbench") }
        } }
        rule.onNodeWithTag("demo-connection-gate").assertDoesNotExist()
        rule.onNodeWithText("Normal workbench").assertIsDisplayed()
    }

    @Test fun retryAndCloseRemainAccessibleWhenTheConnectionIsSlow() {
        var retry = 0; var signOut = 0
        rule.setContent { AgentocTheme {
            DemoConnectionGate(DemoConnectionUiState(active = true, phase = DemoConnectionPhase.Reconnecting,
                elapsedMillis = 5_100), { retry++ }, { signOut++ })
        } }
        rule.onNodeWithText("Reconnecting to your workspace").assertIsDisplayed()
        rule.onNodeWithText("This is taking longer than expected. We’re still trying to connect.").assertIsDisplayed()
        rule.onNodeWithText("Retry connection").performClick()
        rule.onNodeWithText("Close").performClick()
        assertEquals(1, retry); assertEquals(1, signOut)
    }
}
