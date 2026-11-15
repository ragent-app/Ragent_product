package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.GoogleSignInSuccessAction
import com.andysagent.ragent.feature.workbench.GoogleSignInSuccessScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class GoogleSignInSuccessUiTest {
    private fun text(id: Int) = InstrumentationRegistry.getInstrumentation().targetContext.getString(id)
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun connectActionIsShownAfterPairingSignIn() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            RagentTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.ConnectComputer,
                    onAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithContentDescription(text(WorkbenchR.string.onboarding_success_description)).assertExists()
        composeRule.onNodeWithText(text(WorkbenchR.string.onboarding_signed_in)).assertExists()
        composeRule.onNodeWithText(text(WorkbenchR.string.journey_setup_computer)).performScrollTo().performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.ConnectComputer, action) }
    }

    @Test
    fun enterAppActionIsShownAfterAccountSignIn() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            RagentTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.EnterApp,
                    onAction = { action = it },
                    accountLabel = "test@example.com",
                )
            }
        }

        composeRule.onNodeWithText("test@example.com").assertExists()
        composeRule.onNodeWithText(text(WorkbenchR.string.onboarding_enter_workspace)).performScrollTo().performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.EnterApp, action) }
    }

    @Test
    fun welcomeSignInActionReturnsToSignedInWelcome() {
        var action: GoogleSignInSuccessAction? = null
        composeRule.setContent {
            RagentTheme {
                GoogleSignInSuccessScreen(
                    action = GoogleSignInSuccessAction.OpenSignedInWelcome,
                    onAction = { action = it },
                )
            }
        }

        composeRule.onNodeWithText("Continue").assertDoesNotExist()
        composeRule.onNodeWithText(text(WorkbenchR.string.journey_setup_computer)).performScrollTo().performClick()
        composeRule.runOnIdle { assertEquals(GoogleSignInSuccessAction.OpenSignedInWelcome, action) }
    }
}
