package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Isolate viewport remeasurement from IME scheduling; native IME video is separate. */
class ChatViewportContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightTranscriptDoesNotRunASecondAnimationAfterViewportResize() = verify(false)
    @Test fun darkTranscriptDoesNotRunASecondAnimationAfterViewportResize() = verify(true)

    private fun assertLabelActuallyPainted(label: String) {
        val pixels = rule.onNodeWithText(label).captureToImage().toPixelMap()
        var ink = 0
        for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
            val color = pixels[x, y]
            if (color.red + color.green + color.blue < 1.2f) ink++
        }
        assertTrue("Label exists in semantics but its glyphs are absent from the window: $label", ink > 8)
    }

    private fun retainMenuFrame(name: String) {
        rule.waitForIdle()
        // Semantics can precede the physical Android window buffer. Wait for
        // real display frames before pixel evidence, including popup windows.
        android.os.SystemClock.sleep(350)
        val inst = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val folder = java.io.File(inst.targetContext.cacheDir, "menu-evidence").apply { mkdirs() }
        inst.uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(folder, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun userMessageCopyLabelIsVisibleInLongPressMenu() {
        rule.setContent { RagentTheme {
            com.andysagent.ragent.feature.workbench.UserPromptBlock(
                com.andysagent.ragent.feature.workbench.TurnUserPrompt("copy-menu", "Message to copy"),
                onBranch = {}, onEditResend = {}, onRetry = {},
            )
        } }
        rule.onNodeWithText("Message to copy").performTouchInput { longClick() }
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy)).assertIsDisplayed()
        retainMenuFrame("copy-menu.png")
        assertLabelActuallyPainted(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy))
    }

    @Test fun imageUploadLabelIsVisibleInComposerPanel() {
        rule.setContent { RagentTheme {
            com.andysagent.ragent.feature.workbench.ComposerActionSheet(
                onDismiss = {}, onPickImage = {}, onPickDocument = {}, planMode = false,
                onTogglePlanMode = {}, onInsertSlashCommand = {},
            )
        } }
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.composer_action_images)).assertIsDisplayed()
        retainMenuFrame("image-menu.png")
        assertLabelActuallyPainted(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.composer_action_images))
    }

    @Test fun expandedToolShowsCompleteResultAndFailure() {
        var openedPath: String? = null
        val operation = TimelineItem.Operation(
            id = "tool-result", seq = 2,
            kind = com.andysagent.ragent.core.timeline.TimelineOperationKind.Command,
            title = "Read project files", detail = "First result line\nLast result line",
            status = com.andysagent.ragent.core.timeline.TimelineOperationStatus.Failed,
            inputJson = "cat README.md", outputJson = "stdout contents\npermission denied", exitCode = 1,
            fileChanges = listOf(com.andysagent.ragent.core.timeline.FileChangeItem("README.md", additions = 1)),
        )
        rule.setContent { RagentTheme {
            com.andysagent.ragent.feature.workbench.OperationGroup(
                com.andysagent.ragent.feature.workbench.TurnOperationSummary(
                    totalCount = 1, runningCount = 0, failedCount = 1, isWorking = false,
                    summaryText = operation.title, operations = listOf(operation),
                ), onOpenFileDiff = { openedPath = it.path },
            )
        } }
        rule.onNodeWithTag("operation-toggle").performClick()
        rule.onNodeWithText("First result line\nLast result line").assertIsDisplayed()
        rule.onNodeWithText("stdout contents\npermission denied").assertIsDisplayed()
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_exit_code, 1)).assertIsDisplayed()
        rule.onNodeWithTag("operation-toggle").assertContentDescriptionContains(rule.activity.getString(com.andysagent.ragent.feature.workbench.R.string.timeline_failed), substring = true)
        rule.onNodeWithText("README.md").performClick()
        rule.runOnIdle { assertEquals("README.md", openedPath) }
    }

    @Test fun actionLineRemainsVisibleBeforeTextAndDuringExecution() {
        var working by mutableStateOf(true)
        var action by mutableStateOf("Connecting to the model")
        var reply by mutableStateOf("")
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.Full) {
                WorkbenchScreen(WorkbenchUiState(
                    chatOpen = true, sessionId = "action-line", sessionTitle = "Activity",
                    connection = AgentConnectionStatus.Connected,
                    runStatus = if (working) com.andysagent.ragent.core.agentui.AgentRunStatus.Working
                        else com.andysagent.ragent.core.agentui.AgentRunStatus.Idle,
                    currentAction = com.andysagent.ragent.core.timeline.RunActionUiState("working", action),
                    timelineItems = if (reply.isEmpty()) emptyList() else listOf(
                        TimelineItem.Message("reply", 1, TimelineRole.Agent, reply, !working),
                    ),
                ))
            }
        }
        rule.onNodeWithTag("active-run-action").assertIsDisplayed()
        rule.onNodeWithText("Connecting to the model").assertIsDisplayed()
        rule.runOnIdle { action = "Reading README.md"; reply = "Here is the first result." }
        rule.onNodeWithTag("active-run-action").assertIsDisplayed()
        rule.onNodeWithText("Reading README.md").assertIsDisplayed()
        rule.runOnIdle { working = false }
        rule.onNodeWithTag("active-run-action").assertDoesNotExist()
    }

    @Test fun growingReplyFollowsTailUntilTheReaderScrollsAway() {
        fun paragraphs(count: Int) = (1..count).joinToString("\n\n") { "Stream paragraph $it." }
        var body by mutableStateOf(paragraphs(2))
        var started by mutableStateOf(false)
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.Full) {
                Box(Modifier.fillMaxWidth().height(500.dp)) {
                    WorkbenchScreen(WorkbenchUiState(
                        chatOpen = true, sessionId = "stream-tail", sessionTitle = "Streaming",
                        connection = AgentConnectionStatus.Connected,
                        timelineItems = if (!started) emptyList() else listOf(
                            TimelineItem.Message("stream-user", 1, TimelineRole.User, "Explain the steps", true),
                            TimelineItem.Message("stream-reply", 2, TimelineRole.Agent, body, false),
                        ),
                    ))
                }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { started = true }
        rule.waitForIdle()
        rule.runOnIdle { body = paragraphs(40) }
        rule.waitForIdle()
        // The Web-style prose fast path is one Text node, not one node per
        // paragraph. Check the actual tail glyph bounds, not node existence.
        fun paragraphVisible(number: Int): Boolean = runCatching {
            val needle = "Stream paragraph $number."
            val node = rule.onNodeWithText(needle, substring = true, useUnmergedTree = true)
            val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            node.performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult) { it(layouts) }
            val layout = layouts.single()
            val offset = layout.layoutInput.text.text.indexOf(needle)
            if (offset < 0) return@runCatching false
            val glyph = layout.getBoundingBox(offset)
            val position = node.fetchSemanticsNode().positionInRoot
            val viewport = rule.onNodeWithTag("chat-timeline").fetchSemanticsNode().boundsInRoot
            position.y + glyph.bottom > viewport.top && position.y + glyph.top < viewport.bottom
        }.getOrDefault(false)
        rule.waitUntil(5_000) { paragraphVisible(40) }
        assertTrue(paragraphVisible(40))
        rule.onNodeWithTag("chat-timeline").performTouchInput { swipeDown() }
        rule.waitForIdle()
        assertFalse(paragraphVisible(40))
        rule.runOnIdle { body = paragraphs(60) }
        rule.waitForIdle()
        assertFalse(paragraphVisible(60))
    }

    private fun verify(dark: Boolean) {
        var viewportHeight by mutableStateOf(400.dp)
        val state = WorkbenchUiState(
            chatOpen = true, sessionId = "viewport-continuity", sessionTitle = "Viewport",
            connection = AgentConnectionStatus.Connected,
            timelineItems = (1..12).map { index -> TimelineItem.Message(
                id = "viewport-$index", seq = index.toLong(), completed = true,
                role = if (index % 2 == 1) TimelineRole.User else TimelineRole.Agent,
                text = if (index % 2 == 1) "Request $index" else "Reply $index",
            ) },
        )
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.Full) {
                Box(Modifier.fillMaxWidth().height(viewportHeight)) { WorkbenchScreen(state) }
            }
        }
        rule.onNodeWithText("Reply 12").assertIsDisplayed()
        fun y() = rule.onNodeWithText("Reply 12").getUnclippedBoundsInRoot().top.value
        val before = y()
        rule.mainClock.autoAdvance = false
        try {
            rule.runOnUiThread { viewportHeight = 650.dp }
            rule.mainClock.advanceTimeByFrame()
            rule.waitForIdle()
            val first = y()
            val positions = mutableListOf(first)
            repeat(22) {
                rule.mainClock.advanceTimeByFrame()
                rule.waitForIdle()
                positions += y()
            }
            assertTrue("Fixture did not resize the visible transcript: $before -> ${positions.last()}",
                kotlin.math.abs(positions.last() - before) > 100f)
            positions.forEachIndexed { frame, position ->
                assertEquals("Viewport settled but text kept moving at frame $frame: $positions",
                    first, position, 1f)
            }
        } finally { rule.mainClock.autoAdvance = true }
    }
}
