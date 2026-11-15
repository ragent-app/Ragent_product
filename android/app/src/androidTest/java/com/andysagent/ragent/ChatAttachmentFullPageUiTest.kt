package com.andysagent.ragent

import android.graphics.Bitmap
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.RuntimeSelection
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.timeline.AttachmentItem
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.workbench.*
import java.io.File
import org.junit.Rule
import org.junit.Test

class ChatAttachmentFullPageUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun optimisticAndDurableCopiesReconcileToOneVisibleAttachment() {
        val imageFile = File(rule.activity.cacheDir, "full-page-fixture.png")
        Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.rgb(30, 145, 200))
            imageFile.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        val image = ComposerAttachment(id = "attachment", name = "full-page-fixture.png", mimeType = "image/png", localPath = imageFile.absolutePath)
        val pending = PendingTurnUiState("fixture-request", "Review this image", listOf(image), RuntimeSelection(tool = "codex"), null)
        val durable = TimelineItem.Message("server-user", 1, TimelineRole.User, "Review this image", true,
            attachments = listOf(AttachmentItem(assetId = "attachment", originalName = image.name, mimeType = image.mimeType, url = imageFile.absolutePath)),
            requestId = pending.requestId)
        var state by mutableStateOf(WorkbenchUiState(destination = AgentoDestination.Sessions, chatOpen = true,
            sessionId = "fixture-session", timelineSessionId = "fixture-session", sessionTitle = "Attachment fixture", pendingTurn = pending))
        rule.setContent { CompositionLocalProvider(LocalActivityResultRegistryOwner provides rule.activity) {
            RagentTheme { WorkbenchScreen(state = state) }
        } }
        fun assertSingle() {
            rule.waitUntil(15_000) { rule.onAllNodesWithContentDescription(image.name).fetchSemanticsNodes().isNotEmpty() }
            rule.onAllNodesWithContentDescription(image.name).assertCountEquals(1)
            rule.onAllNodesWithContentDescription("Remove ${image.name}").assertCountEquals(0)
            rule.onAllNodesWithText("Review this image").assertCountEquals(1)
        }
        assertSingle()
        rule.runOnIdle { state = state.copy(timelineItems = listOf(durable), acceptedTurns = listOf(pending), pendingTurn = pending) }
        assertSingle()
        rule.runOnIdle { state = state.copy(pendingTurn = null, acceptedTurns = emptyList()) }
        assertSingle()
        rule.waitForIdle()
        val out = File(rule.activity.getExternalFilesDir(null), "chat-attachment-full-page.png")
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
