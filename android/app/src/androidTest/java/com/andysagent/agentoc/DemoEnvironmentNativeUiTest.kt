package com.andysagent.agentoc

import com.andysagent.agentoc.feature.workbench.DemoEnvironmentSurface
import com.andysagent.agentoc.feature.workbench.GoogleSignInGuideScreen

import androidx.compose.material3.Text
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.graphics.asAndroidBitmap
import android.graphics.Bitmap
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(androidx.test.ext.junit.runners.AndroidJUnit4::class)
class DemoEnvironmentNativeUiTest {
    @org.junit.Before fun requireOwnedHonor() {
        org.junit.Assume.assumeTrue(androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("demoFixture") == "owned-honor-ADNQ6R5716008635")
    }
    @get:Rule val rule = createComposeRule()

    @Test fun demoWorkbenchDoesNotShowTheRetiredRestrictionBanner() {
        rule.setContent { AgentocTheme { DemoEnvironmentSurface(true) { Text("Workbench content") } } }
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithText("Test account 路 restricted environment").assertDoesNotExist()
        rule.onNodeWithText("Workbench content").assertIsDisplayed()
        exportScreenshot("demo-without-retired-banner.png")
    }

    @Test fun ordinaryGoogleAccountsHaveNoDemoNotice() {
        rule.setContent { AgentocTheme { DemoEnvironmentSurface(false) { Text("Workbench content") } } }
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithText("Workbench content").assertIsDisplayed()
    }

    @Test fun accountSignInOffersRagentAlongsideGoogle() {
        var starts = 0
        rule.setContent { AgentocTheme { GoogleSignInGuideScreen({}, {}, onContinueWithDemo = { starts++ }) } }
        val label = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.getString(com.andysagent.agentoc.feature.workbench.R.string.ragent_login_title)
        rule.onNodeWithTag("account-sign-in-primary").assertIsDisplayed()
        rule.onNodeWithText(label).performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, starts)
        exportScreenshot("special-account-welcome.png")
    }

    @Test fun fullReviewerConnectionFailureFloatsAndClosesWithoutSigningOut() {
        var signOuts = 0
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(
                restricted = false,
                testAccount = true,
                connection = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionUiState(
                    active = true,
                    phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Unavailable,
                ),
                onSignOut = { signOuts++ },
            ) { Text("Review workbench") }
        } }
        rule.onNodeWithTag("restricted-demo-notice").assertDoesNotExist()
        rule.onNodeWithTag("full-demo-notice").assertDoesNotExist()
        rule.onNodeWithTag("demo-connection-gate").assertIsDisplayed()
        rule.onNodeWithText("Review workbench").assertExists()
        androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation())
            .takeScreenshot(File(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "demo-connection-blurred.png"))
        val close = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            .targetContext.getString(com.andysagent.agentoc.feature.workbench.R.string.demo_connection_close)
        rule.onNodeWithText(close).performClick()
        rule.onNodeWithTag("demo-connection-gate").assertDoesNotExist()
        rule.onNodeWithText("Review workbench").assertIsDisplayed()
        assertEquals(0, signOuts)
        exportScreenshot("full-reviewer-dismissed-connection.png")
    }
    @Test fun dismissedConnectionDoesNotReopenOnBackgroundRetry() {
        val state = androidx.compose.runtime.mutableStateOf(
            com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionUiState(active = true,
                targetId = "honor-synthetic-target", phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Unavailable))
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(restricted = false, testAccount = true, connection = state.value) { Text("Retained workbench") }
        } }
        val close = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
            .getString(com.andysagent.agentoc.feature.workbench.R.string.demo_connection_close)
        rule.onNodeWithText(close).performClick()
        rule.runOnIdle { state.value = state.value.copy(phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Reconnecting) }
        rule.onNodeWithTag("demo-connection-gate").assertDoesNotExist()
        rule.onNodeWithText("Retained workbench").assertIsDisplayed()
    }

    @Test fun reconnectOverlayKeepsEditorFocusedAndInteractive() {
        val connection = androidx.compose.runtime.mutableStateOf(
            com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionUiState(active = true,
                targetId = "honor-synthetic-target", phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Ready))
        val draft = androidx.compose.runtime.mutableStateOf("")
        var backgroundClicks = 0
        rule.setContent { AgentocTheme {
            DemoEnvironmentSurface(restricted = false, testAccount = true, connection = connection.value) {
                androidx.compose.foundation.layout.Column(androidx.compose.ui.Modifier.fillMaxSize(),
                    verticalArrangement = androidx.compose.foundation.layout.Arrangement.Bottom) {
                    androidx.compose.material3.TextButton(onClick = { backgroundClicks++ }) { Text("Background action") }
                    androidx.compose.foundation.text.BasicTextField(value = draft.value, onValueChange = { draft.value = it },
                        modifier = androidx.compose.ui.Modifier.fillMaxWidth().testTag("reconnect-draft"))
                }
            }
        } }
        rule.onNodeWithTag("reconnect-draft").performClick().performTextInput("before")
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val device = androidx.test.uiautomator.UiDevice.getInstance(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation())
        device.takeScreenshot(File(context.cacheDir, "reconnect-before.png"))
        rule.runOnIdle { connection.value = connection.value.copy(phase = com.andysagent.agentoc.feature.workbench.accounts.DemoConnectionPhase.Reconnecting) }
        rule.onNodeWithTag("demo-connection-gate").assertIsDisplayed()
        rule.onNodeWithTag("reconnect-draft").assertIsFocused().performTextInput(" after")
        rule.runOnIdle { assertEquals("before after", draft.value) }
        rule.waitForIdle()
        android.os.SystemClock.sleep(500)
        val reconnectTitle = context.getString(com.andysagent.agentoc.feature.workbench.R.string.demo_connection_reconnecting)
        assertTrue("The reconnect card must be visible while the keyboard is open",
            device.wait(androidx.test.uiautomator.Until.hasObject(androidx.test.uiautomator.By.text(reconnectTitle)), 5_000))
        val closeLabel = context.getString(com.andysagent.agentoc.feature.workbench.R.string.demo_connection_close)
        val closeBounds = device.findObject(androidx.test.uiautomator.By.text(closeLabel)).visibleBounds
        val editorBounds = device.findObject(androidx.test.uiautomator.By.text("before after")).visibleBounds
        assertTrue("The reconnect card actions must stay above the editor", closeBounds.bottom < editorBounds.top)
        File(context.cacheDir, "reconnect-card.png").outputStream().use { output ->
            rule.onNodeWithTag("demo-connection-gate").captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
        }
        device.dumpWindowHierarchy(File(context.cacheDir, "reconnect-window.xml"))
        device.takeScreenshot(File(context.cacheDir, "reconnect-visible.png"))
        rule.onNodeWithText("Background action").performClick()
        rule.runOnIdle { assertEquals(1, backgroundClicks) }
    }
    @Test fun chronologicalCompletedReplyKeepsItsReportAction() {
        var reported = ""
        val message = com.andysagent.agentoc.core.timeline.TimelineItem.Message(
            "honor-report-message", 2, com.andysagent.agentoc.core.timeline.TimelineRole.Agent, "Owned synthetic answer", true)
        val turn = com.andysagent.agentoc.feature.workbench.TurnGroup(
            id = "honor-report-turn", agentMessages = listOf(message), entries = listOf(message))
        rule.setContent { AgentocTheme {
            com.andysagent.agentoc.feature.workbench.TurnTimelineView(
                turn = turn, isLastTurn = false, onBranch = null, onRestart = null,
                onEditResend = {}, onPlanAction = { _, _ -> }, onRetryPendingTurn = {}, onOpenFileDiff = {},
                onReport = { reported = it },
            )
        } }
        rule.onNodeWithTag("report-ai-content").assertIsDisplayed().performClick()
        assertEquals("Owned synthetic answer", reported)
    }
    @Test fun receivedStreamingChunksRenderWithoutAnArtificialTypingDelay() {
        val text = androidx.compose.runtime.mutableStateOf("")
        val streaming = androidx.compose.runtime.mutableStateOf(true)
        rule.mainClock.autoAdvance = false
        rule.setContent { AgentocTheme {
            com.andysagent.agentoc.feature.workbench.ResultBlock(
                message = com.andysagent.agentoc.core.timeline.TimelineItem.Message(
                    "real-result-block", 1, com.andysagent.agentoc.core.timeline.TimelineRole.Agent,
                    text.value, !streaming.value),
                isLastTurn = false, onBranch = {}, onRestart = null,
            )
        } }
        rule.mainClock.advanceTimeByFrame()
        fun rendered(): String = rule.onAllNodes(androidx.compose.ui.test.hasText("", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().flatMap { it.config.getOrElse(androidx.compose.ui.semantics.SemanticsProperties.Text) { emptyList() }.orEmpty() }
            .joinToString("") { it.text }
        val chunk = "The streaming response should reveal progressively across several frames."
        rule.runOnIdle { text.value = chunk }
        rule.mainClock.advanceTimeBy(48)
        assertEquals(chunk, rendered())
        val next = chunk + " The next real delta is visible as soon as it arrives."
        rule.runOnIdle { text.value = next }
        rule.mainClock.advanceTimeBy(48)
        assertEquals(next, rendered())
        rule.runOnIdle { streaming.value = false }
        rule.mainClock.advanceTimeByFrame()
        assertEquals(next, rendered())
        rule.mainClock.autoAdvance = true
    }

    private fun exportScreenshot(name: String) {
        val directory = File(androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "demo-003")
        require(directory.isAbsolute)
        directory.mkdirs()
        File(directory, name).outputStream().use { output ->
            rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
        }
    }
}
