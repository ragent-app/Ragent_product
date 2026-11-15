package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.feature.workbench.ComposerActionSheet
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

/** Actual command foreground and sampled glass, not a comparison of two tokens. */
class ComposerCommandContrastUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun lightCommandsRemainReadable() = verify("light", false)
    @Test fun darkCommandsRemainReadable() = verify("dark", true)
    @Test fun oledCommandsRemainReadable() = verify("oled", true)
    @Test fun amberCommandsRemainReadable() = verify("amber", true)
    @Test fun monetLightCommandsRemainReadable() = verify("monet", false)
    @Test fun monetDarkCommandsRemainReadable() = verify("monet", true)

    private fun verify(variant: String, dark: Boolean) {
        val sourceColor = mutableStateOf(Color.Black)
        val revision = mutableIntStateOf(0)
        var ink = Color.Unspecified
        var inset = 0
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                RagentTheme(darkTheme = dark, themeVariant = variant, motionPreference = MotionPreference.None) {
                    val source = rememberGraphicsLayer()
                    val colors = LocalRagentColors.current
                    SideEffect { ink = if (colors.canvas.red < .5f) Color.White else colors.primaryContent; inset = with(density) { 4.dp.roundToPx() } }
                    CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                        Box(Modifier.fillMaxSize()) {
                            Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                                Box(Modifier.fillMaxSize().drawWithContent { drawRect(sourceColor.value) })
                            }
                            ComposerActionSheet({}, {}, {}, false, {}, onInsertSlashCommand = {}, backdropLayer = source)
                        }
                    }
                }
            }
        }
        rule.onNodeWithText("/learn").performScrollTo().assertIsDisplayed()
        var redBackground = Color.Unspecified
        var blueBackground = Color.Unspecified
        for (background in listOf(Color.Black, Color.White, Color.Red, Color.Blue)) {
            rule.runOnIdle { sourceColor.value = background }
            rule.waitForIdle()
            rule.runOnIdle { revision.intValue++ }
            rule.waitForIdle()
            val pixels = rule.onNodeWithTag("composer-command-learn").captureToImage().toPixelMap()
            var renderedInk = 0
            for (y in 0 until pixels.height) for (x in 0 until pixels.width) {
                val pixel = pixels[x, y]
                if (abs(pixel.red - ink.red) < .012f && abs(pixel.green - ink.green) < .012f && abs(pixel.blue - ink.blue) < .012f) renderedInk++
            }
            assertTrue("No actual command glyphs rendered: $variant/$background", renderedInk >= 8)
            // Central top band is inside the pill, above the text; avoid rounded
            // transparent corners and anti-aliased glyphs being counted as glass.
            val sample = pixels[pixels.width / 2, inset]
            val a = ink.luminance()
            for (y in inset until inset * 2) for (x in pixels.width * 2 / 5 until pixels.width * 3 / 5) {
                val b = pixels[x, y].luminance()
                val ratio = (maxOf(a, b) + .05f) / (minOf(a, b) + .05f)
                assertTrue("Actual $variant command contrast $ratio < 4.5 over $background", ratio >= 4.5f)
            }
            if (background == Color.Red) redBackground = sample
            if (background == Color.Blue) blueBackground = sample
        }
        assertTrue("Sheet failed to sample changing red/blue backgrounds", abs(redBackground.red - blueBackground.red) > .02f)
    }
}
