package com.andysagent.ragent.feature.workbench

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.AttentionUiState
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WindowsBrokerAttentionDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun brokerApprovalIsVisibleAndActionableInItsOpenSession() {
        val approval = Approval(
            id = "test-request", sessionId = "test-session", runId = "test-run",
            title = "Start Windows test service", reason = "Computer: test; service: fixture",
            status = "pending", kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
            riskLevel = "privileged", passkeyRequired = false,
            brokerTargetInstanceId = "test-computer", brokerChallengeDigest = "test-digest",
        )
        val state = AttentionReducer.reduce(
            AttentionUiState(visibleSessionId = "test-session"), AttentionReducer.projectBrokerApprovals(listOf(approval)),
        ).copy(expanded = true)
        val decisions = mutableListOf<AttentionEvent>()
        rule.setContent { RagentTheme { AttentionSurface(state, decisions::add, onOpenSession = {}) } }
        rule.onNodeWithTag("attention-headline").assertIsDisplayed()
        val approve = rule.activity.getString(R.string.attention_approve)
        val deny = rule.activity.getString(R.string.attention_deny)
        rule.onNodeWithText(approve).assertIsDisplayed()
        rule.onNodeWithText(deny).assertIsDisplayed()
        // Compose semantics can settle before the device compositor presents
        // the first frame; wait for a visible frame before capturing evidence.
        rule.waitForIdle()
        Thread.sleep(750)
        val output = File(requireNotNull(rule.activity.getExternalFilesDir(null)), "windows-broker-approval.png")
        val screenshot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val colors = mutableSetOf<Int>()
        for (y in (screenshot.height / 8) until (screenshot.height / 2) step 8) {
            for (x in (screenshot.width / 10) until (screenshot.width * 9 / 10) step 8) colors += screenshot.getPixel(x, y)
        }
        check(colors.size > 30) { "Approval screenshot did not contain a rendered card" }
        output.outputStream().use { assertEquals(true, screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        screenshot.recycle()
        rule.onNodeWithText(approve).performClick()
        rule.onNodeWithText(deny).performClick()
        rule.runOnIdle {
            val id = requireNotNull(state.activeItemId)
            assertEquals(listOf<AttentionEvent>(AttentionEvent.ResolveApproval(id, true), AttentionEvent.ResolveApproval(id, false)), decisions)
        }
    }
}
