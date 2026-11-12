package com.andysagent.agentoc.feature.workbench

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import org.junit.Assert.assertEquals
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DemoEnvironmentNoticeTest {
    @get:Rule val rule = createComposeRule()

    @Test fun demoWorkbenchDoesNotShowTheRetiredRestrictionBanner() {
        rule.setContent { AgentocTheme { DemoEnvironmentSurface(true) { Text("Workbench content") } } }
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithText("Test account · restricted environment").assertDoesNotExist()
        rule.onNodeWithText("Workbench content").assertIsDisplayed()
    }

    @Test fun fullReviewerKeepsWorkbenchWithoutATopBanner() {
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(restricted = false, testAccount = true) {
                Text(if (LocalRestrictedDemoEnvironment.current) "Restricted" else "Full workbench")
            }
        } }
        rule.onNodeWithTag("full-demo-notice").assertDoesNotExist()
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithText("Test account · isolated workspace").assertDoesNotExist()
        rule.onNodeWithText("Full workbench").assertIsDisplayed()
    }

    @Test fun ordinaryGoogleAccountsHaveNoDemoNotice() {
        rule.setContent { AgentocTheme { DemoEnvironmentSurface(false) { Text("Workbench content") } } }
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithText("Workbench content").assertIsDisplayed()
    }

    @Test fun accountLoginOffersSpecialAccountEntry() {
        var starts = 0
        rule.setContent { AgentocTheme { GoogleSignInGuideScreen({}, {}, onContinueWithDemo = { starts++ }) } }
        rule.onNodeWithText("Sign in with Ragent").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, starts)
    }

}
