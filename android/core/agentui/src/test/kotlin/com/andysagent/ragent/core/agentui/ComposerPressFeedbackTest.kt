package com.andysagent.ragent.core.agentui

import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.HoverInteraction
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.agentoPressScale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Local Compose behavior/geometry checks, not device frames or glass pixel QA. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerPressFeedbackTest {
    @get:Rule val rule = createComposeRule()

    private fun width(tag: String): Float {
        val coordinates = rule.onNodeWithTag(tag, true).fetchSemanticsNode().layoutInfo.coordinates
        return coordinates.localToRoot(Offset(coordinates.size.width.toFloat(), 0f)).x -
            coordinates.localToRoot(Offset.Zero).x
    }

    private fun send(policy: MotionPreference, enabled: Boolean = true): () -> Int {
        var clicks = 0
        rule.setContent {
            RagentTheme(darkTheme = false, motionPreference = policy) {
                AgentoSendButton({ clicks++ }, working = false, enabled = enabled,
                    hasText = true, modifier = Modifier.testTag("send-action"))
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        return { clicks }
    }

    @Test fun sendShortTapHasVisibleFeedbackWithoutDelayingOrDuplicatingSend() {
        val clicks = send(MotionPreference.Full)
        val resting = width("composer-send-disc")
        rule.onNodeWithTag("send-action").performTouchInput { down(center); advanceEventTime(8); up() }
        rule.runOnIdle { assertEquals(1, clicks()) }
        rule.mainClock.advanceTimeBy(48)
        assertTrue("Actual send disc lost the short-tap feedback", width("composer-send-disc") < resting * .98f)
        rule.mainClock.advanceTimeBy(600)
        assertEquals(resting, width("composer-send-disc"), .5f)
        rule.runOnIdle { assertEquals(1, clicks()) }
        rule.mainClock.autoAdvance = true
    }

    @Test fun sendRespectsNoMotionWithoutSuppressingTheAction() {
        val clicks = send(MotionPreference.None)
        val resting = width("composer-send-disc")
        rule.onNodeWithTag("send-action").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(112)
        assertEquals("No-motion send still compressed", resting, width("composer-send-disc"), .5f)
        rule.onNodeWithTag("send-action").performTouchInput { up() }
        rule.runOnIdle { assertEquals(1, clicks()) }
        rule.mainClock.autoAdvance = true
    }

    @Test fun disabledSendNeverCompressesOrDispatches() {
        val clicks = send(MotionPreference.Full, enabled = false)
        val resting = width("composer-send-disc")
        rule.onNodeWithTag("send-action").assertIsNotEnabled().performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(112)
        assertEquals(resting, width("composer-send-disc"), .5f)
        rule.onNodeWithTag("send-action").performTouchInput { up() }
        rule.runOnIdle { assertEquals(0, clicks()) }
        rule.mainClock.autoAdvance = true
    }

    private fun composer(attachmentsEnabled: Boolean = true): () -> Int {
        var additions = 0
        rule.setContent {
            RagentTheme(darkTheme = false, motionPreference = MotionPreference.Full) {
                AgentComposer(value = "", onValueChange = {}, onSend = {}, onStop = {}, working = false,
                    attachmentsEnabled = attachmentsEnabled, onAddAttachment = { additions++ })
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        return { additions }
    }

    @Test fun attachmentActionCompressesItsActualGlyphAndDispatchesOnce() {
        val additions = composer()
        val resting = width("composer-attachment-glyph")
        rule.onNodeWithTag("composer-attachment-action").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(112)
        assertTrue("The composer plus is not connected to its press source",
            width("composer-attachment-glyph") < resting * .95f)
        rule.onNodeWithTag("composer-attachment-action").performTouchInput { up() }
        rule.runOnIdle { assertEquals(1, additions()) }
        rule.mainClock.advanceTimeBy(600)
        assertEquals(resting, width("composer-attachment-glyph"), .5f)
        rule.mainClock.autoAdvance = true
    }

    @Test fun unavailableAttachmentActionDoesNotCompressOrOpenThePanel() {
        val additions = composer(attachmentsEnabled = false)
        val resting = width("composer-attachment-glyph")
        rule.onNodeWithTag("composer-attachment-action").assertIsNotEnabled().performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(112)
        assertEquals(resting, width("composer-attachment-glyph"), .5f)
        rule.onNodeWithTag("composer-attachment-action").performTouchInput { up() }
        rule.runOnIdle { assertEquals(0, additions()) }
        rule.mainClock.autoAdvance = true
    }

    @Test fun focusAndHoverCannotCancelCompressionOrAReleaseInFlight() {
        lateinit var source: MutableInteractionSource
        rule.setContent {
            RagentTheme(darkTheme = false, motionPreference = MotionPreference.Full) {
                source = remember { MutableInteractionSource() }
                Box(Modifier.size(100.dp).agentoPressScale(pressedScale = .9f,
                    interactionSource = source, hapticFeedback = false)) {
                    Box(Modifier.size(100.dp).testTag("face"))
                }
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        val resting = width("face")
        val press = PressInteraction.Press(Offset.Zero)
        rule.runOnIdle { check(source.tryEmit(press)) }
        rule.mainClock.advanceTimeBy(32)
        rule.runOnIdle { check(source.tryEmit(FocusInteraction.Focus())); check(source.tryEmit(HoverInteraction.Enter())) }
        rule.mainClock.advanceTimeBy(96)
        assertEquals(resting * .9f, width("face"), .5f)
        rule.runOnIdle { check(source.tryEmit(PressInteraction.Release(press))) }
        rule.mainClock.advanceTimeBy(32)
        rule.runOnIdle { check(source.tryEmit(HoverInteraction.Enter())) }
        rule.mainClock.advanceTimeBy(600)
        assertEquals(resting, width("face"), .5f)
        rule.mainClock.autoAdvance = true
    }
}
