package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.navigation.AgentoBottomNavigation
import com.andysagent.ragent.core.navigation.AgentoDestination
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class NavigationDockContinuityUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private var selected by mutableStateOf(AgentoDestination.Sessions)
    private var creations = 0
    private fun show(policy: MotionPreference = MotionPreference.Full, direction: LayoutDirection = LayoutDirection.Ltr) {
        rule.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides direction) {
            RagentTheme(darkTheme = false, motionPreference = policy) {
                Box(Modifier.width(360.dp)) {
                    AgentoBottomNavigation(selected, { selected = it }, onCreateProject = { creations++ })
                }
            }
            }
        }
        rule.waitForIdle()
    }
    private fun shell() = rule.onNodeWithTag("bottom-navigation-shell").getUnclippedBoundsInRoot()
    private fun lens() = rule.onNodeWithTag("bottom-navigation-selection").getUnclippedBoundsInRoot()
    private fun select(destination: AgentoDestination) = rule.runOnUiThread { selected = destination }

    @Test fun secondaryActionKeepsLargeHitSlotAndNativeSizeGlyphWhileDiscContracts() {
        show()
        val hit = rule.onNodeWithTag("bottom-navigation-contextual-action").getUnclippedBoundsInRoot()
        val disc = rule.onNodeWithTag("bottom-navigation-action-surface", true).getUnclippedBoundsInRoot()
        assertEquals(56f, (hit.right - hit.left).value, .5f)
        assertEquals(48f, (disc.right - disc.left).value, .5f)
        assertEquals(4f, (disc.top - hit.top).value, .5f)
        assertEquals((hit.left + hit.right).value / 2f, (disc.left + disc.right).value / 2f, .5f)
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        var intermediate = 0
        repeat(10) {
            rule.mainClock.advanceTimeBy(16)
            val surfaces = rule.onAllNodesWithTag("bottom-navigation-action-surface", true).fetchSemanticsNodes()
            if (surfaces.isNotEmpty()) {
                val actual = rule.onNodeWithTag("bottom-navigation-action-surface", true).getUnclippedBoundsInRoot()
                if ((actual.right - actual.left).value in 27f..47f) {
                    intermediate++
                    val glyph = rule.onNodeWithTag("bottom-navigation-action-glyph", true).getUnclippedBoundsInRoot()
                    assertEquals("Visible glyph must not shrink with the disc", 20f, (glyph.right - glyph.left).value, .5f)
                    assertEquals(20f, (glyph.bottom - glyph.top).value, .5f)
                    val movingHit = rule.onNodeWithTag("bottom-navigation-contextual-action").getUnclippedBoundsInRoot()
                    assertEquals(56f, (movingHit.right - movingHit.left).value, .5f)
                }
            }
        }
        assertTrue("No actual intermediate disc geometry checked", intermediate >= 2)
        rule.mainClock.autoAdvance = true
    }

    @Test fun actualForegroundPixelsFollowPresentedLensPhase() {
        show()
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        repeat(8) { frame ->
            rule.mainClock.advanceTimeBy(32)
            val shell = shell()
            val lens = lens()
            val p = ((lens.left - shell.left - 4.dp).value /
                ((shell.right - shell.left).value / 3f) / 2f).coerceIn(0f, 1f)
            listOf(AgentoDestination.Sessions to (1f - p), AgentoDestination.Settings to p).forEach { (target, emphasis) ->
                val pixels = rule.onNodeWithTag("bottom-navigation-foreground-${target.route}", useUnmergedTree = true)
                    .captureToImage().toPixelMap()
                var actualBlueContrast = 0f
                for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                    val pixel = pixels[x, y]
                    actualBlueContrast = maxOf(actualBlueContrast, pixel.blue - pixel.red)
                }
                val tint = lerp(Color(0x993C3C43), AgentoFrostedTokens.AppleBlueLight, emphasis)
                // Solid glyph interiors expose the tint; tolerate background
                // lens variation/AA, not a whole frame of the previous colour.
                val expectedBlueContrast = (tint.blue - tint.red) * tint.alpha
                assertEquals("Foreground left the displayed lens at $target frame $frame",
                    expectedBlueContrast, actualBlueContrast, .06f)
            }
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun shellLensAndActionAllocationFollowOnePhaseOnEveryMeasuredFrame() {
        show()
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        repeat(10) {
            rule.mainClock.advanceTimeBy(32)
            val shell = shell()
            val lens = lens()
            val slot = (lens.left - shell.left - 4.dp).value / ((shell.right - shell.left).value / 3f)
            val phase = slot / 2f
            val allocatedWidth = 2f * shell.right.value - 360f
            val actionExtent = shell.left.value - (360f - allocatedWidth) / 2f
            assertEquals("Width ran on another clock at frame $it", 360f *
                (1f + (RagentSizes.CollapsedComposerWidthFraction - 1f) * phase), allocatedWidth, 1f)
            assertEquals("Action slot ran on another clock at frame $it", 66f * (1f - phase), actionExtent, 1f)
        }
        rule.mainClock.autoAdvance = true
    }

    @Test fun returningActionIsNotClickableDuringTravelAndReverseHasNoExtraOldDirectionFrame() {
        show()
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        rule.mainClock.advanceTimeBy(96)
        val before = lens().left.value
        select(AgentoDestination.Sessions)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasNoClickAction()
        assertEquals(before, lens().left.value, .5f)
        rule.mainClock.advanceTimeBy(32)
        assertTrue("The lens continued in the cancelled direction", lens().left.value <= before + .5f)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasNoClickAction()
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasClickAction()
        rule.mainClock.autoAdvance = true
    }

    @Test fun exitRetainsPixelsWithoutActionAndGeometryChangesContinuously() {
        show()
        val initial = shell()
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        rule.mainClock.advanceTimeBy(80)
        val middle = shell()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertExists().assertHasNoClickAction()
        assertTrue("Shell slot jumped instead of morphing", middle.left.value < initial.left.value && middle.left.value > 0f)
        val middleLens = lens()
        val normalized = (middleLens.left - middle.left - 4.dp).value / ((middle.right - middle.left).value / 3f)
        assertTrue("Lens should be between tabs at 80ms: $normalized", normalized > 0f && normalized < 2f)
        rule.mainClock.advanceTimeBy(1_000)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertDoesNotExist()
        assertEquals(4f, (shell().right - lens().right).value, .5f)
        assertEquals(0, creations)
        rule.mainClock.autoAdvance = true
    }

    @Test fun reversingMidFlightPreservesGeometryAndRestoresAction() {
        show()
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        rule.mainClock.advanceTimeBy(96)
        val before = shell()
        val beforeLens = lens()
        select(AgentoDestination.Sessions)
        // The target change must not replace the shell or reset its position.
        assertEquals(before.left.value, shell().left.value, .5f)
        assertEquals(beforeLens.left.value, lens().left.value, .5f)
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(4f, (lens().left - shell().left).value, .5f)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertHasClickAction().performClick()
        assertEquals(1, creations)
        rule.mainClock.autoAdvance = true
    }

    @Test fun reducedMotionCompletesQuicklyWithoutDroppingEndpointClearance() {
        show(MotionPreference.Reduced)
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        rule.mainClock.advanceTimeBy(160)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertDoesNotExist()
        assertEquals(4f, (shell().right - lens().right).value, .5f)
        rule.mainClock.autoAdvance = true
    }

    @Test fun rtlMorphMirrorsSlotsAndKeepsEqualEndpointClearance() {
        show(direction = LayoutDirection.Rtl)
        assertEquals(4f, (shell().right - lens().right).value, .5f)
        rule.mainClock.autoAdvance = false
        select(AgentoDestination.Settings)
        rule.mainClock.advanceTimeBy(80)
        val middle = shell()
        val middleLens = lens()
        val normalized = (middle.right - middleLens.right - 4.dp).value / ((middle.right - middle.left).value / 3f)
        assertTrue("RTL lens should move continuously between mirrored slots: $normalized", normalized > 0f && normalized < 2f)
        rule.mainClock.advanceTimeBy(1_000)
        assertEquals(4f, (lens().left - shell().left).value, .5f)
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertDoesNotExist()
        rule.mainClock.autoAdvance = true
    }

    @Test fun disabledMotionSnapsWithoutRetainingOutgoingTouchTarget() {
        show(MotionPreference.None)
        select(AgentoDestination.Settings)
        rule.waitForIdle()
        rule.onNodeWithTag("bottom-navigation-contextual-action").assertDoesNotExist()
        assertEquals(4f, (shell().right - lens().right).value, .5f)
    }
}
