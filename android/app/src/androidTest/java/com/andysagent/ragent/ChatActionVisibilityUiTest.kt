package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import com.andysagent.ragent.core.agentui.AgentMessageActionBar
import org.junit.Assert.assertEquals
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.TurnGroup
import com.andysagent.ragent.feature.workbench.TurnTimelineView
import org.junit.Rule
import org.junit.Test

class ChatActionVisibilityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun copyActionWritesTheCompleteReplyToProvidedClipboard() {
        var copied: AnnotatedString? = null
        val clipboard = object : ClipboardManager {
            override fun getText(): AnnotatedString? = copied
            override fun setText(annotatedString: AnnotatedString) { copied = annotatedString }
        }
        val expected = "First line\nSecond line with **Markdown** and 中文"
        val copy = InstrumentationRegistry.getInstrumentation().targetContext.getString(
            com.andysagent.ragent.core.agentui.R.string.agentui_copy_message)
        rule.setContent { CompositionLocalProvider(LocalClipboardManager provides clipboard) {
            RagentTheme { AgentMessageActionBar(expected, false, null, null) }
        } }
        rule.onNodeWithContentDescription(copy).performClick()
        rule.runOnIdle { assertEquals(expected, copied?.text) }
    }

    @Test fun actionsAppearOnlyWhenAllowedAndBranchRequiresAnchor() {
        var showActions by mutableStateOf(false)
        var allowBranch by mutableStateOf(false)
        val item = TimelineItem.Message("m", 1, TimelineRole.Agent, "Readable commentary", true, requestId = "r")
        val turn = TurnGroup(id = "r", requestId = "r", agentMessages = listOf(item), finalAnswer = item)
        val resources = InstrumentationRegistry.getInstrumentation().targetContext.resources
        val copy = resources.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy_message)
        val branch = resources.getString(com.andysagent.ragent.core.agentui.R.string.agentui_branch_from_message)
        rule.setContent { RagentTheme {
            TurnTimelineView(turn, true, if (allowBranch) ({ _, _ -> }) else null, {}, {}, { _, _ -> }, {}, {}, onReport = {}, showMessageActions = showActions)
        } }
        rule.onNodeWithText("Readable commentary").assertIsDisplayed()
        rule.onAllNodesWithContentDescription(copy).assertCountEquals(0)
        rule.onAllNodesWithTag("report-ai-content").assertCountEquals(0)
        rule.runOnIdle { showActions = true }
        rule.onNodeWithContentDescription(copy).assertIsDisplayed()
        rule.onNodeWithTag("report-ai-content").assertIsDisplayed()
        rule.onAllNodesWithContentDescription(branch).assertCountEquals(0)
        rule.runOnIdle { allowBranch = true }
        rule.onNodeWithContentDescription(branch).assertIsDisplayed()
        rule.runOnIdle { showActions = false }
        rule.onAllNodesWithContentDescription(copy).assertCountEquals(0)
        rule.onAllNodesWithTag("report-ai-content").assertCountEquals(0)
    }
}
