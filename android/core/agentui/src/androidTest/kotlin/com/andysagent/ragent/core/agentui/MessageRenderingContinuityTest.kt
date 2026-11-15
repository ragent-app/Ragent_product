package com.andysagent.ragent.core.agentui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File

class MessageRenderingContinuityTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun awaitBody(text: String) {
        rule.waitUntil(timeoutMillis = 2000) {
            if (!rule.mainClock.autoAdvance) rule.mainClock.advanceTimeByFrame()
            rule.onAllNodesWithText(text).fetchSemanticsNodes().size == 1
        }
    }

    @Test fun staleBackgroundParseCannotReplaceTheNewestCorrection() {
        var text by mutableStateOf("Original readable body")
        rule.setContent { RagentTheme { AgentMarkdown(text, isStreaming = true) } }
        rule.onNodeWithText(text).assertIsDisplayed()
        val longDraft = "## Obsolete\n\n" + (1..2500).joinToString("\n") { "- old draft item $it" }
        rule.runOnUiThread { text = longDraft }
        rule.waitForIdle()
        rule.runOnUiThread { text = "Newest correction" }
        awaitBody("Newest correction")
        android.os.SystemClock.sleep(200)
        rule.waitForIdle()
        rule.onNodeWithText("Newest correction").assertIsDisplayed()
        rule.onNodeWithText("Obsolete").assertDoesNotExist()
    }

    @Test fun burstUpdatesKeepTheEntireReceivedPrefixVisibleInDarkMode() {
        var text by mutableStateOf("Received 0")
        rule.setContent { RagentTheme(darkTheme = true, motionPreference = MotionPreference.Full) {
            AgentStreamingMessage(text)
        } }
        rule.mainClock.autoAdvance = false
        var previous = "Received 0"
        repeat(40) { update ->
            val next = "Stable content ".repeat(update + 1) + "frontier $update"
            rule.runOnUiThread { text = next }
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            val oldVisible = rule.onAllNodesWithText(previous).fetchSemanticsNodes().isNotEmpty()
            val newVisible = rule.onAllNodesWithText(next).fetchSemanticsNodes().isNotEmpty()
            assertTrue("An update cleared the readable body", oldVisible || newVisible)
            awaitBody(next)
            rule.onNodeWithText(next).assertExists()
            previous = next
        }
    }

    @Test fun remountingActiveMessageShowsAllReceivedTextOnFirstFrame() {
        var visible by mutableStateOf(true)
        val text = "Already received text must remain visible after scrolling back. ".repeat(8).trimEnd()
        rule.mainClock.autoAdvance = false
        rule.setContent { RagentTheme(motionPreference = MotionPreference.Full) {
            if (visible) AgentStreamingMessage(text)
        } }
        rule.onNodeWithText(text).assertExists()
        rule.runOnUiThread { visible = false }
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        rule.runOnUiThread { visible = true }
        rule.mainClock.advanceTimeByFrame()
        rule.waitForIdle()
        rule.onNodeWithText(text).assertExists()
    }

    @Test fun correctedShorterSnapshotIsNotHiddenBehindOldPlaybackFrontier() {
        var text by mutableStateOf("An obsolete long draft that will be corrected immediately.")
        rule.setContent { RagentTheme { AgentStreamingMessage(text) } }
        rule.onNodeWithText(text).assertExists()
        rule.runOnUiThread { text = "Correct answer" }
        awaitBody("Correct answer")
        rule.onNodeWithText("Correct answer").assertIsDisplayed()
        rule.onNodeWithText("An obsolete long draft that will be corrected immediately.").assertDoesNotExist()
    }

    @Test fun finalizingMarkdownNeverReplacesReadableBodyWithASkeleton() {
        var completed by mutableStateOf(false)
        val text = "## Result\n\nA stable completed answer.\n\n- Keep the original order\n- Preserve every distinct message\n\n> Verified result"
        rule.setContent { RagentTheme(motionPreference = MotionPreference.Full) {
            Column(Modifier.fillMaxWidth().testTag("body")) {
                if (completed) FinalizedMarkdownMessage(text) else AgentStreamingMessage(text)
            }
        } }
        rule.onNodeWithText("A stable completed answer.").assertIsDisplayed()
        val beforeBounds = rule.onNodeWithTag("body").getUnclippedBoundsInRoot()
        val before = beforeBounds.bottom.value - beforeBounds.top.value
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { completed = true }
        repeat(8) {
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            rule.onNodeWithText("A stable completed answer.").assertIsDisplayed()
            val bounds = rule.onNodeWithTag("body").getUnclippedBoundsInRoot()
            val height = bounds.bottom.value - bounds.top.value
            assertTrue("Body collapsed during completion: $before -> $height", height >= before - 12f)
        }
        val image = rule.onRoot().captureToImage().asAndroidBitmap()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "completed-markdown.png").outputStream().use {
            image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
