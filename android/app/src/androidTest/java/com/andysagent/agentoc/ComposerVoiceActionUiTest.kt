package com.andysagent.agentoc

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.andysagent.agentoc.core.agentui.AgentComposer
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ComposerVoiceActionUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private var draft by mutableStateOf("")
    private var hasAttachments by mutableStateOf(false)
    private var expanded by mutableStateOf(false)

    private fun showComposer() {
        draft = ""
        hasAttachments = false
        expanded = false
        compose.setContent {
            AgentocTheme {
                Box(Modifier.width(360.dp)) {
                    AgentComposer(
                        value = draft,
                        onValueChange = { draft = it },
                        onSend = {},
                        onStop = {},
                        working = false,
                        attachmentsEnabled = true,
                        onAddAttachment = {},
                        hasAttachments = hasAttachments,
                        expanded = expanded,
                        onExpandedChange = { expanded = it },
                        onVoiceClick = {},
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    @Test fun microphoneUsesSendSlotWhenEmptyAndSlidesBackWhenDraftOrAttachmentExists() {
        showComposer()

        val railWhenEmpty = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        val emptyVoice = compose.onNodeWithTag("composer-voice-action")
            .assertIsDisplayed().getUnclippedBoundsInRoot()
        compose.onNodeWithTag("composer-send-action").assertDoesNotExist()
        val emptyRightInset = railWhenEmpty.right - emptyVoice.right

        compose.runOnIdle { draft = "A voice draft" }
        compose.waitForIdle()
        val railWithDraft = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        val draftVoice = compose.onNodeWithTag("composer-voice-action").getUnclippedBoundsInRoot()
        val draftSend = compose.onNodeWithTag("composer-send-action")
            .assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue("Microphone and send targets overlap", draftVoice.right <= draftSend.left + 1.dp)
        assertTrue(
            "Microphone did not move left to make room for Send",
            railWithDraft.right - draftVoice.right > emptyRightInset + 36.dp,
        )

        compose.runOnIdle {
            draft = ""
            hasAttachments = true
        }
        compose.waitForIdle()
        val railWithAttachment = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        val attachmentVoice = compose.onNodeWithTag("composer-voice-action").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("composer-send-action").assertIsDisplayed()
        assertTrue(
            "Attachment did not keep Send visible beside the microphone",
            railWithAttachment.right - attachmentVoice.right > emptyRightInset + 36.dp,
        )

        compose.runOnIdle { hasAttachments = false }
        compose.waitForIdle()
        val railAfterClear = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot()
        val clearedVoice = compose.onNodeWithTag("composer-voice-action").getUnclippedBoundsInRoot()
        compose.onNodeWithTag("composer-send-action").assertDoesNotExist()
        assertTrue(
            "Microphone did not return to the trailing Send slot after clearing",
            kotlin.math.abs(((railAfterClear.right - clearedVoice.right) - emptyRightInset).value) < 4.dp.value,
        )
    }

    @Test fun sendAndMicrophoneMoveThroughIntermediateFramesWhenDraftAppearsAndClears() {
        showComposer()
        fun trailingInset() = compose.onNodeWithTag("composer-action-rail").getUnclippedBoundsInRoot().right -
            compose.onNodeWithTag("composer-voice-action").getUnclippedBoundsInRoot().right

        val emptyInset = trailingInset()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { draft = "A voice draft" }
        val enteringFrames = buildList {
            repeat(20) {
                compose.mainClock.advanceTimeByFrame()
                add(trailingInset())
            }
        }
        compose.mainClock.advanceTimeBy(800)
        val fullInset = trailingInset()
        assertTrue("Send did not open its slot", fullInset > emptyInset + 36.dp)
        assertTrue(
            "Microphone did not move through intermediate enter frames: $enteringFrames",
            enteringFrames.any { it > emptyInset + 1.dp && it < fullInset - 1.dp },
        )

        compose.runOnIdle { draft = "" }
        val exitingFrames = buildList {
            repeat(20) {
                compose.mainClock.advanceTimeByFrame()
                add(trailingInset())
            }
        }
        compose.mainClock.advanceTimeBy(800)
        val clearedInset = trailingInset()
        assertTrue("Microphone did not move through intermediate exit frames: $exitingFrames",
            exitingFrames.any { it < fullInset - 1.dp && it > emptyInset + 1.dp })
        assertTrue("Microphone did not return to the empty trailing slot", kotlin.math.abs(clearedInset.value - emptyInset.value) < 4.dp.value)
        compose.mainClock.autoAdvance = true
    }
}
