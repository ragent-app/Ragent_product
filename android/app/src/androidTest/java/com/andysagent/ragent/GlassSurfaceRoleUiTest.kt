package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Real displayed pixels: no color token may accidentally select another surface role. */
class GlassSurfaceRoleUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightSurfaceRolesRemainDistinctWithoutBackdrop() = verify(false)
    @Test fun darkSurfaceRolesRemainDistinctWithoutBackdrop() = verify(true)

    private fun verify(dark: Boolean) {
        compose.setContent {
            RagentTheme(darkTheme = dark) {
                Column(Modifier.fillMaxSize().background(Color(0xFF222299))
                    .safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Glass role QA · ${if (dark) "dark" else "light"}", color = Color.White)
                    Sample("neutral", AgentoGlassSurface.Neutral)
                    Sample("white-tint", AgentoGlassSurface.Tinted(Color.White.copy(alpha = 0.88f)))
                    Sample("wash-fallback", AgentoGlassSurface.BrushOverlay(SolidColor(Color.White.copy(alpha = 0.35f))))
                    Sample("control-fill", AgentoGlassSurface.BrushOverlay(
                        SolidColor(Color.White.copy(alpha = 0.35f)), keepWithoutBackdrop = true))
                }
            }
        }
        compose.waitForIdle()
        val neutral = sample("neutral")
        val tint = sample("white-tint")
        val fallback = sample("wash-fallback")
        val control = sample("control-fill")
        assertTrue("Explicit white tint must not disappear: neutral=$neutral tint=$tint",
            tint.red > neutral.red + 0.015f)
        assertTrue("Backdrop wash must use neutral fallback, not Brush identity: $neutral / $fallback",
            abs(neutral.red - fallback.red) < 0.015f && abs(neutral.blue - fallback.blue) < 0.015f)
        assertTrue("Independent control brush must keep its distinct fill: $neutral / $control",
            abs(control.red - neutral.red) > 0.04f)
    }

    @Composable private fun Sample(tag: String, surface: AgentoGlassSurface) {
        Text(tag, color = Color.White)
        AgentoFrostedGlassBox(Modifier.fillMaxWidth().height(64.dp).testTag(tag),
            surface = surface, hasShadow = false) {}
    }

    private fun sample(tag: String): Color {
        // Capture the actual node's Window buffer with Compose/PixelCopy.
        // A system screenshot can still contain a launch or previous frame,
        // whose coordinates do not match the current semantics hierarchy.
        val pixels = compose.onNodeWithTag(tag).assertIsDisplayed().captureToImage().toPixelMap()
        val x = pixels.width / 2
        val y = pixels.height / 2
        check(x >= 15 && y >= 15 && x + 15 < pixels.width && y + 15 < pixels.height)
        var red = 0f
        var green = 0f
        var blue = 0f
        for (dy in -15..15) for (dx in -15..15) {
            val pixel = pixels[x + dx, y + dy]
            red += pixel.red; green += pixel.green; blue += pixel.blue
        }
        return Color(red / 961, green / 961, blue / 961)
    }
}
