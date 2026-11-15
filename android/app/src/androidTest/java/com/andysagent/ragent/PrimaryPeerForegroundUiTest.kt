package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.navigation.AgentoAdaptiveScaffold
import com.andysagent.ragent.core.navigation.AgentoDestination
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Adversarial foreground draw, not evidence that production titles overlapped. */
class PrimaryPeerForegroundUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun checkBoundary(forward: Boolean) {
        val initial = if (forward) AgentoDestination.Home else AgentoDestination.Settings
        val target = if (forward) AgentoDestination.Settings else AgentoDestination.Home
        var selected by mutableStateOf(initial)
        rule.setContent {
            RagentTheme(motionPreference = MotionPreference.Full) {
                AgentoAdaptiveScaffold(selected = selected, onDestinationSelected = { selected = it },
                    dockVisible = false, modifier = Modifier.width(360.dp).height(650.dp)) { modifier, page, _, _ ->
                    Box(modifier.drawBehind {
                        // Content intentionally paints beyond its own measured page.
                        drawRect(if (page == AgentoDestination.Home) Color.Red else Color.Blue,
                            topLeft = Offset(-size.width, 0f), size = Size(size.width * 3, size.height))
                    })
                }
            }
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { selected = target }
        rule.mainClock.advanceTimeBy(160)
        val incoming = rule.onNodeWithTag("primary-page-${target.route}").getUnclippedBoundsInRoot()
        val outgoing = rule.onNodeWithTag("primary-page-${initial.route}").getUnclippedBoundsInRoot()
        val root = rule.onNodeWithTag("primary-reading-plane").getUnclippedBoundsInRoot()
        val seam = if (forward) incoming.left.value else incoming.right.value
        assertTrue("Need an actual intermediate page boundary: $incoming", seam > root.left.value + 20 && seam < root.right.value - 20)
        val pixels = rule.onNodeWithTag("primary-reading-plane").captureToImage().toPixelMap()
        fun sample(x: Float) = pixels[((x - root.left.value) / (root.right - root.left).value * pixels.width).toInt(), pixels.height / 2]
        val left = sample((root.left.value + seam) / 2)
        val right = sample((root.right.value + seam) / 2)
        assertTrue("Home foreground escaped across seam: $left / $right", left.red > .95f && left.blue < .05f)
        assertTrue("Settings foreground escaped across seam: $left / $right", right.blue > .95f && right.red < .05f)
        assertEquals("Peer page viewports must meet", if (forward) outgoing.right.value else outgoing.left.value, seam, 1f)
        rule.mainClock.autoAdvance = true
    }
    @Test fun forwardPeerForegroundStaysInsideItsMovingViewport() = checkBoundary(true)
    @Test fun reversePeerForegroundStaysInsideItsMovingViewport() = checkBoundary(false)
}
