package com.andysagent.ragent.core.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.LayoutDirection
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import kotlin.math.abs
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Real NavHost/dock with a local frame clock; not native presentation or FPS evidence. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PrimaryPageLayerTest {
    @get:Rule val rule = createComposeRule()
    private val selected = mutableStateOf(AgentoDestination.Home)
    private var direction = LayoutDirection.Ltr

    private fun show(policy: MotionPreference = MotionPreference.Full, layoutDirection: LayoutDirection = LayoutDirection.Ltr) {
        direction = layoutDirection
        rule.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides layoutDirection) {
            RagentTheme(darkTheme = false, motionPreference = policy) {
                AgentoAdaptiveScaffold(selected.value, { selected.value = it }, onCreateProject = {}) { modifier, destination, _, _ ->
                    Box(modifier.testTag("content-${destination.route}"))
                }
            }
            }
        }
        rule.waitForIdle()
    }

    private fun page(destination: AgentoDestination) =
        rule.onNodeWithTag("primary-page-${destination.route}").getUnclippedBoundsInRoot()

    private fun slot(): Float {
        val shell = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
        val lens = rule.onNodeWithTag("bottom-navigation-selection").getUnclippedBoundsInRoot()
        // Insets shrink the lens, not the equal-width tab slots.
        val start = if (direction == LayoutDirection.Ltr) lens.left - shell.left else shell.right - lens.right
        return (start.value - 4f) / ((shell.right - shell.left).value / 3f)
    }

    @Test fun pagesMeetAndDockTracksActualLayerPositionsInBothDirections() {
        checkPeerGeometry(LayoutDirection.Ltr)
    }

    @Test fun rtlPagesMoveFromTheSamePhysicalSideAsTheirMirroredDockSlots() {
        checkPeerGeometry(LayoutDirection.Rtl)
    }

    private fun checkPeerGeometry(layoutDirection: LayoutDirection) {
        show(layoutDirection = layoutDirection)
        listOf(AgentoDestination.Sessions, AgentoDestination.Settings, AgentoDestination.Home).forEach { target ->
            val previous = selected.value
            val initialSlot = slot()
            var movingFrames = 0
            rule.mainClock.autoAdvance = false
            rule.runOnUiThread { selected.value = target }
            repeat(24) { frame ->
                rule.mainClock.advanceTimeBy(16)
                if (rule.onAllNodesWithTag("primary-page-${target.route}").fetchSemanticsNodes().isNotEmpty()) {
                    val incoming = page(target)
                    val phase = 1f - abs(incoming.left.value) / (incoming.right - incoming.left).value
                    assertEquals("Dock left its page at $target frame $frame",
                        initialSlot + (target.ordinal - initialSlot) * phase, slot(), .012f)
                    if (phase > .02f && phase < .98f) {
                        movingFrames++
                        val outgoing = page(previous)
                        val travelsFromRight = primaryPeerIsForward(previous, target) == (layoutDirection == LayoutDirection.Ltr)
                        assertTrue("Incoming page chose the wrong side for $layoutDirection", if (travelsFromRight)
                            incoming.left.value > 0f else incoming.left.value < 0f)
                        if (travelsFromRight)
                            assertEquals("Gap or overlap on forward switch", outgoing.right.value, incoming.left.value, 1f)
                        else assertEquals("Gap or overlap on backward switch", incoming.right.value, outgoing.left.value, 1f)
                    }
                }
            }
            assertTrue("No meaningful intermediate page positions for $target", movingFrames >= 6)
            rule.mainClock.autoAdvance = true
            rule.waitForIdle()
            assertEquals(0f, page(target).left.value, 1f)
        }
    }

    @Test fun reversalReusesTheVisiblePageWithoutARequestTimeTeleport() {
        show()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Chat").performTouchInput { click() }
        rule.mainClock.advanceTimeBy(128)
        val before = page(AgentoDestination.Home)
        assertTrue("Outgoing Home never moved", before.left.value > 1f)
        val dockBefore = slot()
        // A native click injects 16ms between down/up. The still-running old
        // page is allowed to move then; this assertion isolates a zero-frame
        // request handoff instead of comparing different animation times.
        rule.runOnUiThread { selected.value = AgentoDestination.Home }
        rule.onAllNodesWithTag("primary-page-home").assertCountEquals(1)
        assertEquals(before.left.value, page(AgentoDestination.Home).left.value, 1f)
        assertEquals(dockBefore, slot(), .012f)
        repeat(16) {
            rule.mainClock.advanceTimeBy(16)
            val home = page(AgentoDestination.Home)
            assertTrue("Retained Home was replaced by a page on the opposite side", home.left.value >= -1f)
            assertEquals("Dock detached during reversal", home.left.value / (home.right - home.left).value, 1f - slot(), .012f)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(AgentoDestination.Home, selected.value)
        rule.onNodeWithTag("primary-page-sessions").assertDoesNotExist()
    }

    @Test fun thirdTargetPreservesCurrentPagePositionAndLastRequestWins() {
        show()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Chat").performTouchInput { click() }
        rule.mainClock.advanceTimeBy(96)
        val chatBefore = page(AgentoDestination.Sessions)
        val slotBefore = slot()
        rule.runOnUiThread { selected.value = AgentoDestination.Settings }
        assertEquals(chatBefore.left.value, page(AgentoDestination.Sessions).left.value, 1f)
        assertEquals(slotBefore, slot(), .012f)
        rule.mainClock.advanceTimeBy(64)
        rule.onNodeWithContentDescription("Home").performTouchInput { click() }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(AgentoDestination.Home, selected.value)
        assertEquals(0f, page(AgentoDestination.Home).left.value, 1f)
        rule.onNodeWithTag("primary-page-settings").assertDoesNotExist()
        rule.onNodeWithTag("primary-page-sessions").assertDoesNotExist()
    }

    @Test fun touchReversalKeepsTheDockWithTheActualReturningLayer() {
        checkTouchReversal(LayoutDirection.Ltr)
    }

    @Test fun rtlTouchReversalKeepsTheDockWithTheRetainedPage() {
        checkTouchReversal(LayoutDirection.Rtl)
    }

    private fun checkTouchReversal(layoutDirection: LayoutDirection) {
        show(layoutDirection = layoutDirection)
        val spatialSign = if (layoutDirection == LayoutDirection.Ltr) 1f else -1f
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Chat").performTouchInput { click() }
        rule.mainClock.advanceTimeBy(128)
        rule.onNodeWithContentDescription("Home").performTouchInput { click() }
        repeat(20) { frame ->
            rule.mainClock.advanceTimeBy(16)
            rule.onAllNodesWithTag("primary-page-home").assertCountEquals(1)
            val home = page(AgentoDestination.Home)
            assertTrue("Touch reversal spawned Home on the wrong side at $frame", home.left.value * spatialSign >= -1f)
            assertEquals("Touch reversal separated page and lens at $frame",
                spatialSign * home.left.value / (home.right - home.left).value, 1f - slot(), .012f)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(AgentoDestination.Home, selected.value)
        assertEquals(0f, page(AgentoDestination.Home).left.value, 1f)
    }

    @Test fun reducedMotionDoesNotIntroduceHorizontalTravel() = checkNonSpatial(MotionPreference.Reduced)
    @Test fun noMotionDoesNotIntroduceHorizontalTravel() = checkNonSpatial(MotionPreference.None)

    private fun checkNonSpatial(policy: MotionPreference) {
        show(policy)
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Settings").performTouchInput { click() }
        repeat(10) {
            rule.mainClock.advanceTimeBy(16)
            if (rule.onAllNodesWithTag("primary-page-settings").fetchSemanticsNodes().isNotEmpty())
                assertEquals(0f, page(AgentoDestination.Settings).left.value, 1f)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(AgentoDestination.Settings, selected.value)
    }
}
