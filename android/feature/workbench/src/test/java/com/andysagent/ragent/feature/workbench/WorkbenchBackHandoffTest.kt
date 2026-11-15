package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.LayoutDirection
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Actual detail/parent positions on a local clock; not native predictive-back presentation QA. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WorkbenchBackHandoffTest {
    @get:Rule val rule = createComposeRule()
    private val open = mutableStateOf(true)
    private val back = mutableStateOf(0f)
    private lateinit var observedMotion: WorkbenchBackStackMotion
    private var explicitMotion = true
    private var spatialSign = 1f

    private fun show(policy: MotionPreference = MotionPreference.Full, initiallyOpen: Boolean = true,
        useExplicitMotion: Boolean = true, layoutDirection: LayoutDirection = LayoutDirection.Ltr) {
        open.value = initiallyOpen
        explicitMotion = useExplicitMotion
        spatialSign = if (layoutDirection == LayoutDirection.Ltr) 1f else -1f
        rule.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
            RagentTheme(darkTheme = false, motionPreference = policy) {
                if (useExplicitMotion) {
                    val motion = rememberWorkbenchBackStackMotion(open.value, back.value)
                    SideEffect { observedMotion = motion }
                    WorkbenchBackStackTransition(open.value, back.value,
                        parentContent = { Box(Modifier.fillMaxSize().background(Color.Blue).testTag("parent")) },
                        childContent = { Box(Modifier.fillMaxSize().background(Color.Red).testTag("detail")) },
                        motion = motion)
                } else {
                    WorkbenchBackStackTransition(open.value, back.value,
                        parentContent = { Box(Modifier.fillMaxSize().background(Color.Blue).testTag("parent")) },
                        childContent = { Box(Modifier.fillMaxSize().background(Color.Red).testTag("detail")) })
                }
            }
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
    }

    private fun offset(): Float {
        rule.waitForIdle()
        val coordinates = rule.onNodeWithTag("detail", true).fetchSemanticsNode().layoutInfo.coordinates
        return spatialSign * coordinates.localToRoot(Offset.Zero).x / coordinates.size.width.toFloat()
    }

    private fun gesture(value: Float) {
        rule.runOnIdle { back.value = value }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(32)
        if (explicitMotion)
            assertEquals("Gesture did not reach the production motion state", value, observedMotion.effectiveOffset.value, .015f)
        assertEquals("Actual detail did not follow the gesture", value, offset(), .015f)
    }

    @Test fun completedGestureDoesNotReappearWhenTheExternalProgressIsCleared() {
        show()
        gesture(.35f)
        gesture(.7f)
        gesture(1f)
        assertCompletedGestureStaysOffscreen()
    }

    @Test fun defaultMotionCallerAlsoKeepsACompletedGestureOffscreen() {
        show(useExplicitMotion = false)
        gesture(.6f)
        gesture(1f)
        assertCompletedGestureStaysOffscreen()
    }

    @Test fun rtlDetailAndItsBackHandoffUseTheLogicalEndOfThePage() {
        show(layoutDirection = LayoutDirection.Rtl)
        gesture(.3f)
        gesture(.65f)
        gesture(1f)
        assertCompletedGestureStaysOffscreen()
    }

    private fun assertCompletedGestureStaysOffscreen() {
        rule.runOnIdle { open.value = false; back.value = 0f }
        rule.waitForIdle()
        repeat(12) { frame ->
            rule.mainClock.advanceTimeBy(16)
            if (rule.onAllNodesWithTag("detail", true).fetchSemanticsNodes().isNotEmpty())
                assertTrue("Completed detail reappeared at frame $frame, offset=${offset()}", offset() >= .985f)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("detail", true).assertDoesNotExist()
        assertEquals(0f, rule.onNodeWithTag("parent", true).getUnclippedBoundsInRoot().left.value, 1f)
    }

    @Test fun cancelledGestureReturnsFromItsPresentedPositionInsteadOfSnappingOpen() {
        show()
        gesture(.6f)
        rule.runOnIdle { back.value = 0f }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(16)
        val first = offset()
        assertTrue("Cancelled gesture snapped to the open endpoint: $first", first > .4f)
        assertTrue("Cancelled gesture moved farther out: $first", first <= .615f)
        var previous = first
        repeat(16) { frame ->
            rule.mainClock.advanceTimeBy(16)
            val current = offset()
            assertTrue("Cancellation jumped between frames $frame: $previous -> $current", previous - current < .2f)
            assertTrue("Cancellation travelled away from the page at $frame: $previous -> $current", current <= previous + .015f)
            previous = current
        }
        assertTrue("Cancellation never returned toward the page", previous < first)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(0f, offset(), .01f)
    }

    @Test fun gestureCanReverseDirectionAndASecondGestureDoesNotReuseItsOldOffset() {
        show()
        gesture(.65f)
        gesture(.25f)
        rule.runOnIdle { back.value = 0f }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        gesture(.15f)
        gesture(.45f)
        rule.runOnIdle { open.value = false; back.value = 0f }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(16)
        assertTrue("A close request restarted from the open endpoint", offset() >= .435f)
        repeat(12) { frame ->
            rule.mainClock.advanceTimeBy(16)
            if (rule.onAllNodesWithTag("detail", true).fetchSemanticsNodes().isNotEmpty())
                assertTrue("A close after a second gesture returned to the screen at $frame", offset() >= .435f)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        rule.onNodeWithTag("detail", true).assertDoesNotExist()
    }

    @Test fun programmaticCloseAndReopenKeepTheActualIntermediatePosition() {
        show()
        rule.runOnIdle { open.value = false }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(112)
        val closing = offset()
        assertTrue("Programmatic close had no meaningful intermediate geometry: $closing", closing in .1f.. .95f)
        rule.runOnIdle { open.value = true }
        rule.waitForIdle()
        val handoff = offset()
        assertEquals("Reopen replaced the presented detail", closing, handoff, .015f)
        rule.mainClock.advanceTimeBy(32)
        assertTrue("Reversal discarded the outgoing page's momentum", offset() > closing + .005f)
        rule.mainClock.advanceTimeBy(96)
        assertTrue("Reopen did not return from its actual position", offset() < closing)
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(0f, offset(), .01f)
    }

    @Test fun noMotionClosesWithoutASecondAnimatedExit() {
        show(MotionPreference.None)
        rule.runOnIdle { open.value = false }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(48)
        rule.onNodeWithTag("detail", true).assertDoesNotExist()
        rule.mainClock.autoAdvance = true
    }

    @Test fun gestureStartingDuringEntryContinuesFromThePresentedDetail() {
        show(initiallyOpen = false)
        rule.runOnIdle { open.value = true }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(112)
        val entering = offset()
        assertTrue("Entry did not have an intermediate position: $entering", entering in .05f.. .9f)
        rule.runOnIdle { back.value = .05f }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(32)
        val gestureStart = offset()
        assertTrue("Gesture restarted from an endpoint: $entering -> $gestureStart",
            kotlin.math.abs(gestureStart - entering) <= .15f)
        // The entry may travel one frame before the new input is composed;
        // after acquisition, a larger Back must move outward, never re-enter.
        rule.runOnIdle { back.value = .15f }
        rule.waitForIdle()
        rule.mainClock.advanceTimeBy(32)
        assertTrue("The acquired gesture kept entering", offset() >= gestureStart - .015f)
        rule.runOnIdle { back.value = 0f }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(0f, offset(), .01f)
    }
}
