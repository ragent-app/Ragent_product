package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.*
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w320dp-h568dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ContentReportDialogTest {
    @get:Rule val rule = createComposeRule()

    @Test fun noExcerptLeavesPhoneByDefaultAndReasonIsRequired() {
        rule.setContent { RagentTheme { ContentReportDialog(ContentReportUiState(open = true, selectedReply = true,
            content = "private unselected reply")) } }
        rule.onNodeWithTag("content-report-submit").assertIsNotEnabled()
        rule.onNodeWithTag("content-report-excerpt").assertDoesNotExist()
        rule.onNodeWithTag("content-report-include").performScrollTo().assertIsOff()
        rule.onNodeWithText("Send report").assertIsDisplayed()
    }

    @Test fun receivedStateShowsActualReceiptAndCannotResubmit() {
        val id = "067ba243-89bd-411e-8ea7-5d939e426014"
        val record = ContentReportRecord(ContentReportPayload(requestId = id, reason = "privacy", details = "",
            includeContent = false, content = "", appVersion = "0.0.1"),
            ContentReportReceipt("report_$id", "received", "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z"))
        rule.setContent { RagentTheme { ContentReportDialog(ContentReportUiState(open = true, record = record)) } }
        rule.onNodeWithTag("content-report-status").performScrollTo().assertTextEquals("Received by the developer service. Human review is pending.")
        rule.onNodeWithTag("content-report-submit").assertDoesNotExist()
        rule.onNodeWithText("Check receipt").assertIsDisplayed()
        rule.onNodeWithText("Check, then retry this report").assertDoesNotExist()
    }

    @Test fun historicalAssistantReplyCanBeReportedWithoutRegenerateOrBranch() {
        var reported = ""
        rule.setContent { RagentTheme {
            ResultBlock(TimelineItem.Message(id = "reply", seq = 1, role = TimelineRole.Agent, text = "historical answer", completed = true),
                isLastTurn = false, onBranch = { error("must not branch") }, onRestart = null,
                onReport = { reported = "historical answer" })
        } }
        rule.onNodeWithTag("report-ai-content").performClick()
        assertEquals("historical answer", reported)
    }
}
