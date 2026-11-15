package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.AgentoBackdropTone
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.LocalAgentoBackdropRevision
import com.andysagent.ragent.core.designsystem.LocalAgentoBackdropMotionResponse
import com.andysagent.ragent.core.designsystem.recordToLayer
import com.andysagent.ragent.core.agentui.AgentComposer
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Actual RenderNode sampling, not an assertion against a material token. */
class GlassSamplingUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun quietHeaderKeepsDynamicSamplingWithReducedColourSwing() = verifyColourSwing(false)

    @Test fun darkHeaderKeepsDynamicSamplingWithReducedColourSwing() = verifyColourSwing(true)

    @Test fun lightGlassRemovesTextScaleEdges() = verifyTextScaleEdges(false)
    @Test fun darkGlassRemovesTextScaleEdges() = verifyTextScaleEdges(true)

    @Test fun lightMotionResponseUpdatesWithoutFreezingSampling() = verifyMotionResponse(false)
    @Test fun darkMotionResponseUpdatesWithoutFreezingSampling() = verifyMotionResponse(true)

    private fun verifyMotionResponse(dark: Boolean) {
        val revision = mutableIntStateOf(0)
        val response = mutableStateOf(1f)
        val sourceColour = mutableStateOf(Color.Red)
        var foregroundCompositions = 0
        rule.setContent {
            RagentTheme(darkTheme = dark) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(
                    LocalAgentoBackdropRevision provides revision,
                    LocalAgentoBackdropMotionResponse provides response,
                ) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                            Box(Modifier.fillMaxSize().drawWithContent { drawRect(sourceColour.value) })
                        }
                        AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 100.dp).testTag("sample"),
                            backdropLayer = source, hasShadow = false,
                        ) { SideEffect { foregroundCompositions++ } }
                    }
                }
            }
        }
        fun sample(colour: Color): Color {
            rule.runOnIdle { sourceColour.value = colour }
            rule.waitForIdle()
            rule.runOnIdle { revision.intValue++ }
            rule.waitForIdle()
            return sampleCentre()
        }
        val originalRed = sample(Color.Red)
        val originalBlue = sample(Color.Blue)
        val initialCompositions = foregroundCompositions
        rule.runOnIdle { response.value = .55f }
        val dampedBlue = sample(Color.Blue)
        val dampedRed = sample(Color.Red)
        val originalSwing = abs(originalRed.red - originalBlue.red)
        val dampedSwing = abs(dampedRed.red - dampedBlue.red)
        assertTrue("Fixture must show live colour: $originalSwing", originalSwing > .1f)
        assertTrue("Damping must update the filter, not freeze its source: $dampedSwing / $originalSwing",
            dampedSwing > originalSwing * .4f && dampedSwing < originalSwing * .7f)
        rule.runOnIdle { response.value = 1f }
        val restoredRed = sample(Color.Red)
        val restoredBlue = sample(Color.Blue)
        assertEquals("Restoring response must restore red", originalRed.red, restoredRed.red, .015f)
        assertEquals("Restoring response must restore blue", originalBlue.blue, restoredBlue.blue, .015f)
        assertEquals("Response and source updates must not recompose foreground",
            initialCompositions, foregroundCompositions)
    }

    private fun verifyTextScaleEdges(dark: Boolean) {
        val revision = mutableIntStateOf(0)
        rule.setContent {
            RagentTheme(darkTheme = dark) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().testTag("raw-source").drawWithContent {
                            recordToLayer(source)
                        }) {
                            Box(Modifier.fillMaxSize().drawWithContent {
                                drawRect(Color.White)
                                for (x in 0 until size.width.toInt() step 24) {
                                    drawRect(Color.Black, Offset(x.toFloat(), 0f), Size(12f, size.height))
                                }
                            })
                        }
                        AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 100.dp).testTag("sample"),
                            backdropLayer = source, hasShadow = false,
                        ) {}
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val pixels = rule.onNodeWithTag("sample").captureToImage().toPixelMap()
        // Average the fine grain vertically, then measure contrast at the
        // actual 12px glyph-stroke scale. Whole-pane min/max incorrectly counts
        // intentional broad colour fields as sharp text (old/new PNGs agree).
        val columnMeans = (pixels.width / 4 until pixels.width * 3 / 4).map { x ->
            (pixels.height / 3 until pixels.height * 2 / 3).map { y -> pixels[x, y].red }.average()
        }
        val strokeContrast = (0 until columnMeans.size - 12).maxOf { x -> abs(columnMeans[x + 12] - columnMeans[x]) }
        val raw = rule.onNodeWithTag("raw-source").captureToImage().toPixelMap()
        val rawContrast = (raw.width / 4 until raw.width * 3 / 4 - 12)
            .maxOf { x -> abs(raw[x + 12, 20].red - raw[x, 20].red) }
        println("${if (dark) "dark" else "light"} stroke contrast=$strokeContrast raw=$rawContrast")
        assertTrue("Fixture must contain sharp black/white strokes", rawContrast > .9f)
        assertTrue("Text-scale contrast survived: $strokeContrast", strokeContrast < .015)
    }

    private fun verifyColourSwing(dark: Boolean) {
        val revision = mutableIntStateOf(0)
        val sourceColour = mutableStateOf(Color.Red)
        rule.setContent {
            RagentTheme(darkTheme = dark) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize()) {
                        Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                            Box(Modifier.fillMaxSize().drawWithContent { drawRect(sourceColour.value) })
                        }
                        AgentoBackdropTone.entries.forEach { tone ->
                            AgentoFrostedGlassBox(
                                modifier = Modifier.align(if (tone == AgentoBackdropTone.Standard)
                                    Alignment.TopCenter else Alignment.BottomCenter)
                                    .size(180.dp, 100.dp).testTag(tone.name),
                                backdropLayer = source, backdropTone = tone, hasShadow = false,
                            ) {}
                        }
                    }
                }
            }
        }
        fun capture(tone: AgentoBackdropTone): Color {
            val pixels = rule.onNodeWithTag(tone.name).captureToImage().toPixelMap()
            return pixels[pixels.width / 2, pixels.height / 2]
        }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val standardRed = capture(AgentoBackdropTone.Standard)
        val quietRed = capture(AgentoBackdropTone.QuietHeader)
        rule.runOnIdle { sourceColour.value = Color.Blue }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val standardBlue = capture(AgentoBackdropTone.Standard)
        val quietBlue = capture(AgentoBackdropTone.QuietHeader)
        val standardSwing = abs(standardRed.red - standardBlue.red)
        val quietSwing = abs(quietRed.red - quietBlue.red)
        assertTrue("Header must retain live colour: $quietRed -> $quietBlue", quietSwing > 0.04f)
        assertTrue("Header swing $quietSwing vs composer $standardSwing",
            quietSwing < standardSwing * 0.6f && quietSwing > standardSwing * 0.3f)
    }

    @Test fun changingThemeReplacesWhiteFrostWithoutFreezingTheBackdrop() {
        val dark = mutableStateOf(false)
        val revision = mutableIntStateOf(0)
        val sourceColour = mutableStateOf(Color.Black)
        rule.setContent {
            RagentTheme(darkTheme = dark.value) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                            Box(Modifier.fillMaxSize().drawWithContent { drawRect(sourceColour.value) })
                        }
                        AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 100.dp).testTag("sample"),
                            backdropLayer = source, hasShadow = false,
                        ) {}
                    }
                }
            }
        }
        fun refreshedSample(): Color {
            rule.waitForIdle()
            rule.runOnIdle { revision.intValue++ }
            rule.waitForIdle()
            return sampleCentre()
        }
        val light = refreshedSample()
        rule.runOnIdle { dark.value = true }
        val night = refreshedSample()
        assertTrue("Light frost must keep its original lift: $light", light.red > 0.45f)
        assertTrue("Night blank should be charcoal, not grey or invisible: $night", night.red in 0.05f..0.20f)
        rule.runOnIdle { sourceColour.value = Color.White }
        val brightBackdrop = refreshedSample()
        assertTrue("Dark glass must still respond to its live backdrop: $night -> $brightBackdrop",
            brightBackdrop.red > night.red + 0.15f)
        rule.runOnIdle { sourceColour.value = Color.Black; dark.value = false }
        val restored = refreshedSample()
        assertEquals("Switching back must preserve the light recipe", light.red, restored.red, 0.02f)
    }

    @Test fun disablingComposerDoesNotExposeTheUnblurredTranscript() {
        val enabled = mutableStateOf(true)
        val revision = mutableIntStateOf(0)
        rule.setContent {
            RagentTheme(darkTheme = false) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                        Box(Modifier.fillMaxSize().drawWithContent { recordToLayer(source) }) {
                            Box(Modifier.fillMaxSize().drawWithContent {
                                drawRect(Color.White)
                                for (x in 0 until size.width.toInt() step 24) {
                                    drawRect(Color.Black, Offset(x.toFloat(), 0f), Size(12f, size.height))
                                }
                            })
                        }
                        AgentComposer(
                            value = "", onValueChange = {}, onSend = {}, onStop = {},
                            working = false, enabled = enabled.value, onAddAttachment = {},
                            backdropLayer = source,
                        )
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val before = rule.onNodeWithTag("agent-composer").captureToImage().toPixelMap()
        rule.runOnIdle { enabled.value = false }
        rule.waitForIdle()
        val after = rule.onNodeWithTag("agent-composer").captureToImage().toPixelMap()
        assertEquals(before.width, after.width)
        assertEquals(before.height, after.height)
        // The top-centre interior has no foreground controls. Dimming the
        // whole surface blends the sharp black/white source into this band.
        var difference = 0f
        var count = 0
        for (y in 5..9) for (x in before.width / 3 until before.width * 2 / 3) {
            difference += abs(before[x, y].red - after[x, y].red)
            count++
        }
        assertTrue("Disabled glass changed its substrate by ${difference / count}", difference / count < 0.025f)
    }

    @Test fun backgroundSamplingUpdatesWithoutProviderRecomposition() {
        val revision = mutableIntStateOf(0)
        val sourceColour = mutableStateOf(Color.Red)
        var compositions = 0
        rule.setContent {
            RagentTheme(darkTheme = false) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    SideEffect { compositions++ }
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize().drawWithContent {
                            recordToLayer(source)
                        }) {
                            Box(Modifier.fillMaxSize().drawWithContent { drawRect(sourceColour.value) })
                        }
                        AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 100.dp).testTag("sample"),
                            backdropLayer = source,
                            // Solid source deliberately isolates invalidation from offset math.
                            backdropOffset = IntOffset.Zero,
                            hasShadow = false,
                        ) {}
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val red = sampleCentre()
        val initialCompositions = compositions
        rule.runOnIdle { sourceColour.value = Color.Blue }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        rule.waitForIdle()
        val blue = sampleCentre()
        assertTrue("Red backdrop must tint the glass: $red", red.red > red.blue + 0.02f)
        assertTrue("Updated blue backdrop must tint the glass: $blue", blue.blue > blue.red + 0.02f)
        assertEquals("Draw invalidation must not recompose the provider", initialCompositions, compositions)
    }

    private fun sampleCentre(): Color {
        val pixels = rule.onNodeWithTag("sample").captureToImage().toPixelMap()
        return pixels[pixels.width / 2, pixels.height / 2]
    }

    @Test fun movingSamplingOriginUpdatesPixelsWithoutForegroundRecomposition() {
        val revision = mutableIntStateOf(0)
        val offset = mutableStateOf(IntOffset.Zero)
        var foregroundCompositions = 0
        var sourceHeight = 0
        rule.setContent {
            RagentTheme(darkTheme = false) {
                val source = rememberGraphicsLayer()
                CompositionLocalProvider(LocalAgentoBackdropRevision provides revision) {
                    Box(Modifier.fillMaxSize()) {
                        Box(Modifier.fillMaxSize().drawWithContent {
                            recordToLayer(source)
                        }) {
                            Box(Modifier.fillMaxSize().drawWithContent {
                                sourceHeight = size.height.toInt()
                                drawRect(Color.Red)
                                drawRect(Color.Blue, Offset(0f, size.height / 2), Size(size.width, size.height / 2))
                            })
                        }
                        AgentoFrostedGlassBox(
                            modifier = Modifier.size(180.dp, 100.dp).testTag("sample"),
                            backdropLayer = source,
                            backdropOffsetProvider = { offset.value },
                            hasShadow = false,
                        ) {
                            SideEffect { foregroundCompositions++ }
                        }
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { revision.intValue++ }
        val red = sampleCentre()
        val initialCompositions = foregroundCompositions
        rule.runOnIdle { offset.value = IntOffset(0, -sourceHeight * 3 / 4) }
        rule.waitForIdle()
        val blue = sampleCentre()
        assertTrue("Draw-phase origin must sample red: $red", red.red > red.blue + .02f)
        assertTrue("Moving origin must sample blue: $blue", blue.blue > blue.red + .02f)
        assertEquals("Moving the sampling origin must not recompose foreground",
            initialCompositions, foregroundCompositions)
    }
}
