package com.andysagent.ragent

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.PermissionRequestUiState
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.QueuedMessageUiState
import com.andysagent.ragent.feature.workbench.ComposerAttachment
import com.andysagent.ragent.feature.workbench.RunDock
import com.andysagent.ragent.feature.workbench.R as WorkbenchR
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class RunDockQueueIslandUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private val entries = listOf(
        QueuedMessageUiState(id = "first", text = "Review the report sources"),
        QueuedMessageUiState(id = "second", text = "Leave the original files unchanged"),
    )

    @Test fun compactQueueMorphsToEveryMessageAndActionsTargetTheirOwnEntry() {
        var expanded by mutableStateOf(false)
        var queue by mutableStateOf(entries)
        val actions = mutableListOf<String>()
        compose.setContent {
            RagentTheme {
                RunDock(
                    runStatus = AgentRunStatus.Working, approval = null,
                    isOfflineOrTransportError = false, onStop = {}, onOpenRunDetails = {},
                    onApprove = {}, onDeny = {}, onReviewChanges = {}, onRetryConnection = {},
                    queuedMessages = queue, queueExpanded = expanded,
                    onExpandQueue = { expanded = true }, onCollapseQueue = { expanded = false },
                    onEditQueuedMessage = { actions += "edit:${it.id}" },
                    onSteerQueue = { actions += "steer:${it.id}" },
                    onRemoveQueuedMessage = { message ->
                        actions += "remove:${message.id}"
                        queue = queue.filterNot { it.id == message.id }
                    },
                )
            }
        }
        compose.onNodeWithTag("queue-island-pill").assertIsDisplayed()
        val twoQueued = compose.activity.resources.getQuantityString(WorkbenchR.plurals.composer_queued_messages, 2, 2)
        val oneQueued = compose.activity.resources.getQuantityString(WorkbenchR.plurals.composer_queued_messages, 1, 1)
        val steerLabel = compose.activity.resources.getString(WorkbenchR.string.composer_steer)
        val editLabel = compose.activity.resources.getString(WorkbenchR.string.composer_edit_queued)
        val removeLabel = compose.activity.resources.getString(WorkbenchR.string.composer_remove_queued)
        compose.onNodeWithContentDescription(twoQueued).assertExists()
        compose.onNodeWithText(entries[0].text).assertDoesNotExist()
        compose.onNodeWithTag("queue-island-pill").performClick()
        compose.waitForIdle()
        entries.forEach { compose.onNodeWithText(it.text).assertIsDisplayed() }
        compose.onNodeWithContentDescription("$editLabel 2").performClick()
        compose.onAllNodesWithText(steerLabel)[1].performClick()
        compose.onNodeWithContentDescription("$removeLabel 1").performClick()
        compose.runOnIdle { assertEquals(listOf("edit:second", "steer:second", "remove:first"), actions) }
        compose.onNodeWithText(oneQueued).assertIsDisplayed()
        compose.onNodeWithText(entries[0].text).assertDoesNotExist()
        compose.onNodeWithTag("queue-island-collapse").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("queue-island-pill").assertIsDisplayed()
    }

    @Test fun approvalOwnsTheDockUntilResolvedAndEmptyQueueLeavesNothing() {
        var approval by mutableStateOf<PermissionRequestUiState?>(PermissionRequestUiState(
            id = "approve-qa", title = "Review file upload", reason = "Local test only",
        ))
        var queue by mutableStateOf(entries)
        compose.setContent {
            RagentTheme {
                RunDock(
                    runStatus = AgentRunStatus.Working, approval = approval,
                    isOfflineOrTransportError = false, onStop = {}, onOpenRunDetails = {},
                    onApprove = {}, onDeny = {}, onReviewChanges = {}, onRetryConnection = {},
                    queuedMessages = queue,
                )
            }
        }
        compose.onNodeWithText("Approve").assertIsDisplayed()
        compose.onNodeWithTag("composer-queue-rail").assertDoesNotExist()
        compose.runOnIdle { approval = null }
        compose.onNodeWithTag("queue-island-pill").assertIsDisplayed()
        compose.runOnIdle { queue = emptyList() }
        compose.waitForIdle()
        compose.onNodeWithTag("composer-queue-rail").assertDoesNotExist()
    }

    @Test fun queuedAttachmentsShowTheirNamesAlongsideTheQueuedText() {
        val attachment = ComposerAttachment(
            id = "report", name = "weekly-report.pdf", mimeType = "application/pdf", sizeBytes = 284_000,
        )
        var expanded by mutableStateOf(true)
        var editedMessageId: String? = null
        compose.setContent {
            RagentTheme {
                RunDock(
                    runStatus = AgentRunStatus.Working, approval = null,
                    isOfflineOrTransportError = false, onStop = {}, onOpenRunDetails = {},
                    onApprove = {}, onDeny = {}, onReviewChanges = {}, onRetryConnection = {},
                    queuedMessages = listOf(QueuedMessageUiState("attachment", "Review this report", listOf(attachment))),
                    queueExpanded = expanded, onExpandQueue = { expanded = true }, onCollapseQueue = { expanded = false },
                    onEditQueuedMessage = { editedMessageId = it.id },
                )
            }
        }
        compose.onNodeWithText("Review this report").assertIsDisplayed()
        val attachmentCount = compose.activity.resources.getQuantityString(
            WorkbenchR.plurals.composer_queued_attachments, 1, 1,
        )
        compose.onNodeWithText("weekly-report.pdf · $attachmentCount").assertIsDisplayed()
        compose.onNodeWithTag("queue-island-attachments-1").assertIsDisplayed()
        val editLabel = compose.activity.resources.getString(WorkbenchR.string.composer_edit_queued)
        compose.onNodeWithContentDescription("$editLabel 1").performClick()
        compose.runOnIdle { assertEquals("attachment", editedMessageId) }
    }

    @Test fun attachmentOnlyQueuedMessagesCanBeEditedAndDisplayProperly() {
        val attachment = ComposerAttachment(
            id = "photo", name = "screenshot.png", mimeType = "image/png", sizeBytes = 120_000,
        )
        var expanded by mutableStateOf(true)
        var editedMessageId: String? = null
        compose.setContent {
            RagentTheme {
                RunDock(
                    runStatus = AgentRunStatus.Working, approval = null,
                    isOfflineOrTransportError = false, onStop = {}, onOpenRunDetails = {},
                    onApprove = {}, onDeny = {}, onReviewChanges = {}, onRetryConnection = {},
                    queuedMessages = listOf(QueuedMessageUiState("attachment-only", "", listOf(attachment))),
                    queueExpanded = expanded, onExpandQueue = { expanded = true }, onCollapseQueue = { expanded = false },
                    onEditQueuedMessage = { editedMessageId = it.id },
                )
            }
        }
        val attachmentCount = compose.activity.resources.getQuantityString(
            WorkbenchR.plurals.composer_queued_attachments, 1, 1,
        )
        compose.onNodeWithText(attachmentCount).assertIsDisplayed()
        val editLabel = compose.activity.resources.getString(WorkbenchR.string.composer_edit_queued)
        compose.onNodeWithContentDescription("$editLabel 1").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals("attachment-only", editedMessageId) }
    }
}

/** The actual chat projection, not just the island in isolation. */
class QueuedMessageArrivalUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun newlyArrivedQueueOpensThenAutomaticallyReturnsToCountPill() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("page", "chat").putExtra("panel", "queue-arrival")
            .putExtra("status", "Working").putExtra("locale", "en")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.onNodeWithTag("composer-queue-rail").assertDoesNotExist()
            compose.waitUntil(6_000) {
                compose.onAllNodesWithText("Keep the original source files unchanged.")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("2 messages queued").assertIsDisplayed()
            compose.waitUntil(8_000) {
                compose.onAllNodesWithTag("queue-island-pill")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNodeWithText("2 messages queued").assertIsDisplayed()
            compose.onNodeWithText("Keep the original source files unchanged.").assertDoesNotExist()
        }
    }

    @Test fun editingQueuedMessageWithAttachmentsRestoresAttachmentsToComposerTray() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("page", "chat").putExtra("panel", "queue-arrival-attachments")
            .putExtra("queue_arrival_delay_ms", 100)
            .putExtra("status", "Working").putExtra("locale", "en")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.waitUntil(6_000) {
                compose.onAllNodesWithText("Check the weekly report sources before continuing.")
                    .fetchSemanticsNodes().isNotEmpty()
            }
            val edit1 = hasContentDescription("Edit and resend queued message 1") or hasContentDescription("编辑并重发待发消息 1")
            val edit2 = hasContentDescription("Edit and resend queued message 2") or hasContentDescription("编辑并重发待发消息 2")
            val cancelNode = hasText("Cancel edit") or hasText("取消编辑")

            // 1. Edit message with text + attachment
            compose.onNode(edit1).performClick()
            compose.waitForIdle()
            compose.onAllNodesWithText("Check the weekly report sources before continuing.")
                .assertCountEquals(1)
            compose.onNodeWithText("weekly-report.pdf").assertIsDisplayed()
            compose.onNode(cancelNode).assertIsDisplayed()

            // Cancel edit
            compose.onNode(cancelNode).performClick()
            compose.waitForIdle()
            compose.onNodeWithText("weekly-report.pdf").assertDoesNotExist()

            // 2. Wait for message 2 (attachment only) and edit it
            compose.waitUntil(6_000) {
                compose.onAllNodes(edit2).fetchSemanticsNodes().isNotEmpty()
            }
            compose.onNode(edit2).performClick()
            compose.waitForIdle()
            compose.onNode(cancelNode).assertIsDisplayed()
            val refImageNode = hasText("reference-image.png") or hasContentDescription("reference-image.png")
            compose.onNode(refImageNode).assertIsDisplayed()

            // Cancel edit
            compose.onNode(cancelNode).performClick()
            compose.waitForIdle()
            compose.onNode(refImageNode).assertDoesNotExist()
        }
    }
}

