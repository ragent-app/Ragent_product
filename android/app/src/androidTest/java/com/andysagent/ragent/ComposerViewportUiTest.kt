package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.MarkdownComposerEditor
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.RagentTextStyles
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ComposerViewportUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private lateinit var scroll: ScrollState
    private var layout: TextLayoutResult? = null
    private var height by mutableStateOf(120.dp)
    private var draft by mutableStateOf("")
    private var densityValue = 1f
    private val placements = mutableListOf<Pair<Float, Int>>()

    private fun show(text: String, fontScale: Float = 2f) {
        draft = text
        compose.setContent {
            val base = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale)) {
                densityValue = LocalDensity.current.density
                val viewportHeight by animateDpAsState(height, tween(300), label = "test-viewport")
                scroll = rememberScrollState()
                RagentTheme(darkTheme = true) {
                    Box(Modifier.width(288.dp).height(viewportHeight).background(Color.Black).testTag("viewport")) {
                        MarkdownComposerEditor(
                            value = draft, onValueChange = { draft = it }, isDark = true,
                            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)
                                .onGloballyPositioned { coordinates ->
                                    layout?.let { result ->
                                        if (result.layoutInput.text.text.endsWith("healthz")) {
                                            // Sample in placement, not after waiting for effects to repair a frame.
                                            val bottom = result.getCursorRect(result.layoutInput.text.length).bottom +
                                                3f * fontScale * base.density - scroll.value
                                            placements += bottom to coordinates.size.height
                                        }
                                    }
                                },
                            textStyle = RagentTextStyles.userBody.copy(color = Color.White),
                            scrollState = scroll, onTextLayout = { layout = it },
                            decorationBox = { inner -> Box(Modifier.fillMaxWidth()) { inner() } },
                        )
                    }
                }
            }
        }
        compose.waitUntil(5_000) { layout?.layoutInput?.text?.text?.contains("healthz") == true }
        compose.waitForIdle()
    }

    private fun assertBorderHasRoom(bottom: Boolean) {
        val image = compose.onNodeWithTag("viewport").captureToImage().toPixelMap()
        val edge = if (bottom) image.height - 1 else 0
        assertTrue("Code outline touches the viewport clip",
            (0 until image.width).all { x -> image[x, edge].red < 0.08f })
        val rows = if (bottom) (image.height - 16 until image.height - 1) else (1 until 16)
        val outlinePixels = rows.sumOf { y -> (0 until image.width).count { x ->
            val c = image[x, y]; c.red > 0.5f && c.red < 0.95f && kotlin.math.abs(c.red - c.blue) < 0.05f
        } }
        assertTrue("No visible border near the reserved edge: $outlinePixels", outlinePixels > 20)
    }

    @Test fun largeTextLastCodeOutlineIsNotCutAtMaximumScroll() {
        show("First\nSecond\nThird\nFourth\n`healthz`")
        compose.runOnIdle { assertTrue(scroll.maxValue > 0); assertEquals(scroll.maxValue, scroll.value) }
        assertBorderHasRoom(bottom = true)
    }

    @Test fun firstCodeOutlineIsNotCutAtTheTop() {
        show("`healthz`")
        assertBorderHasRoom(bottom = false)
    }

    @Test fun manualDocumentScrollIsNotPulledBackToTheCaret() {
        show("First\nSecond\nThird\nFourth\nFifth\nSixth\n`healthz`")
        val before = scroll.value
        compose.onNodeWithTag("viewport").performTouchInput { swipeDown(durationMillis = 500) }
        compose.waitForIdle()
        val after = scroll.value
        assertTrue("Manual gesture did not scroll toward the beginning: $before -> $after", after < before)
        compose.mainClock.advanceTimeBy(500)
        compose.runOnIdle { assertEquals("Caret maintenance undid manual scrolling", after, scroll.value) }
    }

    @Test fun shrinkingViewportPlacesTheCaretInsideEveryFrame() {
        height = 400.dp
        show("First\nSecond\nThird\nFourth\nFifth\nSixth\n`healthz`")
        compose.runOnIdle { placements.clear() }
        compose.mainClock.autoAdvance = false
        compose.runOnUiThread { height = 120.dp }
        repeat(24) { compose.mainClock.advanceTimeByFrame(); compose.waitForIdle() }
        compose.mainClock.autoAdvance = true
        compose.runOnIdle {
            assertTrue("No intermediate placements sampled", placements.size >= 5)
            placements.forEachIndexed { index, (caretBottom, viewport) ->
                assertTrue("Clipped caret in placement $index: $caretBottom > $viewport", caretBottom <= viewport + 1f)
            }
        }
    }

    @Test fun fivePlainLinesKeepTheirCapacityWithoutRichDecorationPadding() {
        height = 139.5.dp // five 27.5sp lines plus the existing plain 2dp inset
        show("One\nTwo\nThree\nFour\nhealthz", fontScale = 1f)
        compose.runOnIdle { assertTrue("Five plain lines unexpectedly scroll: ${scroll.maxValue}", scroll.maxValue <= densityValue) }
        compose.runOnIdle { draft += "\nSix" }
        compose.waitUntil(5_000) { scroll.maxValue > 10 * densityValue }
    }
}
