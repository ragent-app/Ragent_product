package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.agentoReadingEdges
import com.andysagent.ragent.core.designsystem.LocalAgentoBackdropRevision
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Hardware pixels distinguish real progressive blur from a white/black wash. */
class ReadingEdgesUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightEdgesBlurBeforeFadingAndLeaveTheDocumentUntouched() = verify(false)
    @Test fun darkEdgesBlurBeforeFadingAndLeaveTheDocumentUntouched() = verify(true)

    private fun verify(dark: Boolean) {
        val inset = with(rule.density) { 60.dp.toPx() }
        val liftedBottom = mutableStateOf(inset)
        val phase = mutableStateOf(0f)
        val paper = mutableStateOf(Color.White)
        val revision = mutableIntStateOf(0)
        val canvas = if (dark) Color.Black else Color.White
        rule.setContent {
            val source = rememberGraphicsLayer()
            CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
            Box(Modifier.fillMaxSize().background(canvas)) {
                Box(Modifier.fillMaxSize().testTag("edges")
                    .agentoReadingEdges(source, { inset }, { liftedBottom.value })
                    .drawBehind {
                        drawRect(paper.value)
                        for (x in -16 until size.width.toInt() step 16) {
                            drawRect(Color.Black, Offset(x + phase.value, 0f), Size(8f, size.height))
                        }
                    })
            }
            }
        }
        fun px(dp: Int) = with(rule.density) { dp.dp.roundToPx() }
        fun check() {
            val image = rule.onNodeWithTag("edges").captureToImage().toPixelMap()
            fun contrast(y: Int): Float {
                val values = (image.width / 4 until image.width * 3 / 4).map { image[it, y].red }
                return values.max() - values.min()
            }
            val top = inset.toInt()
            val bottom = (image.height - liftedBottom.value).toInt()
            listOf(top to 1, bottom to -1).forEach { (edge, direction) ->
                val near = contrast(edge + direction * px(10))
                val middle = contrast(edge + direction * px(18))
                val clear = contrast(edge + direction * px(30))
                assertTrue("Edge only faded, did not blur: $near / $middle / $clear",
                    near < .65f && middle > near + .12f && middle < .9f && clear > .95f)
                // At 10dp, mean luminance stays grey in both themes. A theme
                // colour wash would shift it toward black/white instead.
                val mean = (image.width / 4 until image.width * 3 / 4)
                    .map { image[it, edge + direction * px(10)].red }.average()
                assertEquals("Blur band must not be an opaque theme wash", .5, mean, .035)
                val excluded = image[image.width / 2, edge - direction * px(4)]
                assertEquals("System band must be protected", canvas.red, excluded.red, .01f)
            }
        }
        check()
        // Simulates an IME inset change and moving source in the same frame.
        rule.runOnIdle { liftedBottom.value = inset + px(160); phase.value = 8f }
        check()
        rule.runOnIdle { paper.value = Color.Red }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        val live = rule.onNodeWithTag("edges").captureToImage().toPixelMap()
        listOf(inset.toInt() + px(10), (live.height - liftedBottom.value).toInt() - px(10)).forEach { y ->
            val green = (live.width / 4 until live.width * 3 / 4).map { live[it, y].green }.average()
            assertTrue("Blurred edge kept stale white-source pixels: $green", green < .08)
        }
    }
}
