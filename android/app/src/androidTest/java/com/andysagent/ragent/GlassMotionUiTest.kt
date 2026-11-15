package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.*
import kotlin.math.abs
import kotlin.math.roundToInt
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class GlassMotionUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightMovingGlassCompressesLiveLuminanceWithoutRecomposingLabels() = verifyMotionPixels(false)
    @Test fun darkMovingGlassCompressesLiveLuminanceWithoutRecomposingLabels() = verifyMotionPixels(true)

    private fun verifyMotionPixels(dark: Boolean) {
        val response = mutableStateOf(1f)
        val colour = mutableStateOf(Color.Black)
        val revision = mutableIntStateOf(0)
        var labels = 0
        rule.setContent {
            RagentTheme(darkTheme = dark) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(
                    LocalAgentoBackdropRevision provides revision,
                    LocalAgentoBackdropMotionResponse provides response,
                ) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                            Box(Modifier.fillMaxSize().drawWithContent { drawRect(colour.value) })
                        }
                        AgentoFrostedGlassBox(Modifier.size(180.dp, 100.dp).testTag("glass"),
                            backdropLayer = source, hasShadow = false) { SideEffect { labels++ } }
                    }
                }
            }
        }
        fun sample(value: Color): Float {
            rule.runOnIdle { colour.value = value }
            rule.waitForIdle()
            rule.runOnIdle { revision.intValue++ }
            val pixels = rule.onNodeWithTag("glass").captureToImage().toPixelMap()
            return pixels[pixels.width / 2, pixels.height / 2].red
        }
        val restBlack = sample(Color.Black)
        val restSwing = sample(Color.White) - restBlack
        val initialLabels = labels
        rule.runOnIdle { response.value = .55f }
        val movingBlack = sample(Color.Black)
        val movingSwing = sample(Color.White) - movingBlack
        assertTrue("Live sampling disappeared", movingSwing > .08f)
        assertEquals("Draw-phase damping did not reach the hardware filter", .55f, movingSwing / restSwing, .06f)
        rule.runOnIdle { response.value = 1f }
        assertEquals("Stopped glass must recover its recipe", restBlack, sample(Color.Black), .015f)
        assertEquals("Colour response must not recompose foreground", initialLabels, labels)
    }

    @Test fun blurSamplesNeighboursButCannotPaintOutsideThePill() {
        val outside = mutableStateOf(Color.Red)
        val shown = mutableStateOf(true)
        val revision = mutableIntStateOf(0)
        rule.setContent {
            RagentTheme(darkTheme = false) {
                val source = rememberGraphicsLayer()
                var offset by remember { mutableStateOf(IntOffset.Zero) }
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize().testTag("root"), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().drawWithContent {
                            recordToLayer(source)
                        }) {
                            Box(Modifier.fillMaxSize().drawWithContent {
                                drawRect(outside.value)
                                val pane = Size(180.dp.toPx(), 48.dp.toPx())
                                val origin = Offset((size.width - pane.width) / 2, (size.height - pane.height) / 2)
                                offset = IntOffset(-origin.x.roundToInt(), -origin.y.roundToInt())
                                drawRect(Color.White, origin, pane)
                            })
                        }
                        if (shown.value) AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 48.dp).testTag("glass"),
                            shape = androidx.compose.foundation.shape.CircleShape,
                            backdropLayer = source, backdropOffsetProvider = { offset }, hasShadow = false,
                        ) {}
                    }
                }
            }
        }
        fun centre(): Color {
            rule.waitForIdle()
            rule.runOnIdle { revision.intValue++ }
            val pixels = rule.onNodeWithTag("glass").captureToImage().toPixelMap()
            return pixels[pixels.width / 2, pixels.height / 2]
        }
        val red = centre()
        rule.runOnIdle { outside.value = Color.Blue }
        val blue = centre()
        assertTrue("Kernel ignored pixels outside the 48dp crop: $red -> $blue",
            red.red > red.blue + .03f && blue.blue > blue.red + .03f)
        val rootBounds = rule.onNodeWithTag("root").fetchSemanticsNode().boundsInRoot
        val bounds = rule.onNodeWithTag("glass").fetchSemanticsNode().boundsInRoot.translate(-rootBounds.topLeft)
        val withGlass = rule.onNodeWithTag("root").captureToImage().toPixelMap()
        rule.runOnIdle { shown.value = false }
        val withoutGlass = rule.onNodeWithTag("root").captureToImage().toPixelMap()
        // Check all four sides, inside the oversized sampling node's extent.
        val points = listOf(
            bounds.center.x.toInt() to bounds.top.toInt() - 4,
            bounds.center.x.toInt() to bounds.bottom.toInt() + 4,
            bounds.left.toInt() - 4 to bounds.center.y.toInt(),
            bounds.right.toInt() + 4 to bounds.center.y.toInt(),
            bounds.left.toInt() + 2 to bounds.top.toInt() + 2,
            bounds.right.toInt() - 2 to bounds.bottom.toInt() - 2,
        )
        points.forEach { (x, y) ->
            val a = withGlass[x, y]; val b = withoutGlass[x, y]
            assertTrue("Overscan leaked outside glass at $x,$y: $a != $b",
                abs(a.red - b.red) + abs(a.green - b.green) + abs(a.blue - b.blue) < .015f)
        }
    }

    @Test fun motionResponseHoldsAcrossDirectionChangesAndRestoresGradually() {
        val moving = mutableStateOf(false)
        lateinit var response: State<Float>
        rule.setContent {
            val isMoving = remember { { moving.value } }
            response = rememberAgentoBackdropMotionResponse(isMoving)
        }
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        rule.runOnIdle { moving.value = true }
        rule.mainClock.advanceTimeBy(80)
        val entering = rule.runOnIdle { response.value }
        assertTrue("Entry should be continuous: $entering", entering in .56f.. .99f)
        rule.mainClock.advanceTimeBy(120)
        rule.runOnIdle { assertEquals(.55f, response.value, .01f); moving.value = false }
        rule.mainClock.advanceTimeBy(112)
        rule.runOnIdle { assertEquals(.55f, response.value, .01f); moving.value = true }
        rule.mainClock.advanceTimeBy(160)
        rule.runOnIdle { assertEquals(.55f, response.value, .01f); moving.value = false }
        rule.mainClock.advanceTimeBy(360)
        rule.runOnIdle { assertTrue("Release should not snap", response.value in .56f.. .99f) }
        rule.mainClock.advanceTimeBy(400)
        rule.runOnIdle { assertEquals(1f, response.value, .001f) }
        rule.mainClock.autoAdvance = true
    }
}
