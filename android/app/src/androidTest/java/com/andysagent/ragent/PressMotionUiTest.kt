package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Surface
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.agentoPressScale
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PressMotionUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private lateinit var source: MutableInteractionSource
    private var clicks = 0
    private fun show(policy: MotionPreference = MotionPreference.Full, materialClick: Boolean = false) {
        rule.setContent {
            RagentTheme(motionPreference = policy) {
                source = remember { MutableInteractionSource() }
                val visual = Modifier.size(100.dp)
                    .agentoPressScale(pressedScale = .92f,
                        onClick = if (materialClick) null else { { clicks++ } },
                        interactionSource = source, hapticFeedback = false)
                if (materialClick) Surface(onClick = { clicks++ }, interactionSource = source,
                    modifier = visual) { Box(Modifier.size(100.dp).testTag("press-face").background(Color.Blue)) }
                else Box(visual) { Box(Modifier.size(100.dp).testTag("press-face").background(Color.Blue)) }
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
    }
    private fun drawnWidth(): Float {
        val c = rule.onNodeWithTag("press-face", true).fetchSemanticsNode().layoutInfo.coordinates
        return c.localToRoot(Offset(c.size.width.toFloat(), 0f)).x - c.localToRoot(Offset.Zero).x
    }
    @Test fun shortTapRemainsVisibleAfterImmediateClickAndReturnsToRest() {
        show()
        val resting = drawnWidth()
        rule.onNodeWithTag("press-face", true).performTouchInput { down(center); advanceEventTime(8); up() }
        rule.runOnIdle { assertEquals("Click must not wait for the visual return", 1, clicks) }
        rule.mainClock.advanceTimeBy(48)
        assertTrue("Short tap lost its feedback", drawnWidth() < resting * .98f)
        rule.mainClock.advanceTimeBy(600)
        assertEquals(resting, drawnWidth(), .5f)
        rule.mainClock.autoAdvance = true
    }
    @Test fun externalMaterialClickDrivesTheSameCompressionAndDoesNotDuplicateActions() {
        show(materialClick = true)
        val resting = drawnWidth()
        rule.onNodeWithTag("press-face", true).performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(96)
        assertTrue("Material click did not reach the press modifier", drawnWidth() < resting * .95f)
        rule.onNodeWithTag("press-face", true).performTouchInput { up() }
        rule.runOnIdle { assertEquals(1, clicks) }
        rule.mainClock.advanceTimeBy(600)
        assertEquals(resting, drawnWidth(), .5f)
        rule.mainClock.autoAdvance = true
    }
    @Test fun cancelledPressReturnsWithoutClickAndCanBePressedAgain() {
        show()
        val resting = drawnWidth()
        val press = PressInteraction.Press(Offset.Zero)
        rule.runOnIdle { source.tryEmit(press) }
        rule.mainClock.advanceTimeBy(96)
        assertTrue(drawnWidth() < resting * .95f)
        rule.runOnIdle { source.tryEmit(PressInteraction.Cancel(press)) }
        rule.mainClock.advanceTimeBy(450)
        assertEquals(resting, drawnWidth(), .5f)
        rule.runOnIdle { assertEquals(0, clicks) }
        rule.onNodeWithTag("press-face", true).performTouchInput { click(center) }
        rule.runOnIdle { assertEquals(1, clicks) }
        rule.mainClock.autoAdvance = true
    }
    @Test fun noMotionKeepsSizeAndClickBehavior() {
        show(MotionPreference.None)
        val resting = drawnWidth()
        rule.onNodeWithTag("press-face", true).performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(100)
        assertEquals(resting, drawnWidth(), .5f)
        rule.onNodeWithTag("press-face", true).performTouchInput { up() }
        rule.runOnIdle { assertEquals(1, clicks) }
        rule.mainClock.autoAdvance = true
    }
}
