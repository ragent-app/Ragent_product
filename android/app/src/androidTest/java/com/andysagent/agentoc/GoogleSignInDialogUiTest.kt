package com.andysagent.agentoc

import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.feature.workbench.GoogleSignInRequest
import com.andysagent.agentoc.feature.workbench.R as WorkbenchR
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

class GoogleSignInDialogUiTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun agreementDisplaysVoiceDisclosureBeforeConfirmingSignIn() {
        var accepted = false
        composeRule.setContent {
            AgentocTheme {
                GoogleSignInConfirmationDialog(
                    request = GoogleSignInRequest.Account,
                    onConfirm = { accepted = true }, onDismiss = {},
                )
            }
        }
        composeRule.onNodeWithText(composeRule.activity.getString(WorkbenchR.string.sign_in_agreement_summary)).assertExists()
        composeRule.onNodeWithText(composeRule.activity.getString(WorkbenchR.string.voice_cloud_upload_disclosure)).assertExists()
        assertFalse(accepted)
        composeRule.onNodeWithText(composeRule.activity.getString(WorkbenchR.string.voice_cloud_consent_accept)).performClick()
        assertTrue(accepted)
    }

    @Test
    fun darkSignInDialogUsesDenseNeutralSurfaceOverHighContrastContent() {
        composeRule.setContent {
            AgentocTheme(darkTheme = true) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.Red),
                )
                GoogleSignInConfirmationDialog(
                    request = GoogleSignInRequest.PairComputer,
                    onConfirm = {},
                    onDismiss = {},
                    modifier = Modifier.testTag("sign-in-dialog-surface"),
                )
            }
        }

        composeRule.waitForIdle()
        val bitmap = composeRule.onNodeWithTag("sign-in-dialog-surface").captureToImage().asAndroidBitmap()
        val actual = bitmap.getPixel(bitmap.width / 2, 2)
        assertTrue(
            "Dark sign-in dialog needs a dense neutral substrate over a saturated backdrop: actual=${Integer.toHexString(actual)}",
            AndroidColor.alpha(actual) >= 216 &&
                abs(AndroidColor.red(actual) - AndroidColor.green(actual)) <= 8 &&
                abs(AndroidColor.green(actual) - AndroidColor.blue(actual)) <= 8,
        )
    }

    @Test
    fun deviceSignInDescriptionAndDemoActionDoNotOverlap() {
        composeRule.setContent {
            AgentocTheme {
                GoogleSignInConfirmationDialog(
                    request = GoogleSignInRequest.ManageDevices,
                    onConfirm = {}, onDismiss = {}, onDemoSignIn = {},
                )
            }
        }
        val detail = composeRule.onNodeWithText(composeRule.activity.getString(WorkbenchR.string.settings_google_sign_in_devices_detail)).fetchSemanticsNode().boundsInRoot
        val demo = composeRule.onNodeWithText(composeRule.activity.getString(WorkbenchR.string.ragent_login_title)).fetchSemanticsNode().boundsInRoot
        assertTrue("Demo action must be below the sign-in description", demo.top >= detail.bottom)
    }
}
