package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentoSendButton
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.feature.workbench.DecisionQuestionCard
import com.andysagent.ragent.feature.workbench.DecisionQuestionUiState
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Tests real production controls, not swatches that bypass their material. */
class ActionContrastUiTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test fun light() = verify("light", false)
    @Test fun dark() = verify("dark", true)
    @Test fun oled() = verify("oled", true)
    @Test fun amber() = verify("amber", true)
    @Test fun monetLight() = verify("monet", false)
    @Test fun monetDark() = verify("monet", true)
    @Test fun systemLight() = verify("system", false)
    @Test fun systemDark() = verify("system", true)

    private fun verify(variant: String, dark: Boolean) {
        lateinit var app: RagentColors
        var materialFill = Color.Unspecified
        var materialInk = Color.Unspecified
        compose.setContent {
            RagentTheme(darkTheme = dark, themeVariant = variant, motionPreference = MotionPreference.None) {
                app = LocalRagentColors.current
                materialFill = MaterialTheme.colorScheme.primary
                materialInk = MaterialTheme.colorScheme.onPrimary
                Surface(Modifier.fillMaxSize(), color = app.canvas) {
                    Column(Modifier.safeDrawingPadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("Action contrast · $variant · ${if (dark) "dark" else "light"}", style = MaterialTheme.typography.titleMedium)
                        AgentoButton("Continue", {}, Modifier.fillMaxWidth().height(52.dp).testTag("app-action"))
                        Button({}, Modifier.fillMaxWidth().height(52.dp).testTag("material-action")) { Text("Continue") }
                        AgentoButton("Decline", {}, Modifier.fillMaxWidth().height(52.dp).testTag("destructive-action"), destructive = true)
                        DecisionQuestionCard(
                            DecisionQuestionUiState("qa-local", "本地示例 · Select report contents", listOf("Summary", "Complete details"), selectedIndices = setOf(0)),
                            {}, {}, {},
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                            AgentoSendButton({}, working = false, enabled = true, hasText = true, modifier = Modifier.testTag("send-action"))
                            AgentoSendButton({}, working = false, enabled = false, hasText = false, modifier = Modifier.testTag("disabled-send"))
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithTag("disabled-send").assertIsNotEnabled()
        // Check all foreground roles, including aliases used outside this fixture.
        assertContrast("app action", app.actionPrimaryContent, app.actionPrimary.compositeOver(app.canvas), 4.5f)
        assertContrast("accent action", app.onAccentPrimary, app.accentPrimary.compositeOver(app.canvas), 4.5f)
        assertContrast("Material action", materialInk, materialFill.compositeOver(app.canvas), 4.5f)
        assertEquals("App and Material primary actions must agree", app.actionPrimary, materialFill)
        assertEquals("App and Material action content must agree", app.actionPrimaryContent, materialInk)
        if (variant in setOf("light", "dark", "system")) {
            assertEquals("Brand buttons use white labels and glyphs", Color.White, app.actionPrimaryContent)
            // Standalone text accents must remain legible on neutral surfaces.
            assertContrast("accent on canvas", app.accentPrimary, app.canvas, 4.5f)
            assertContrast("accent on surface", app.accentPrimary, app.quietSurface, 4.5f)
        }
        val screenshot = capture("action-contrast-$variant-${if (dark) "dark" else "light"}")
        try {
            verifyPixels(screenshot, "app-action", app.actionPrimary, app.actionPrimaryContent, app.canvas, 4.5f)
            verifyPixels(screenshot, "material-action", materialFill, materialInk, app.canvas, 4.5f)
            verifyPixels(screenshot, "destructive-action", app.actionDestructive, Color.White, app.canvas, 4.5f)
            verifyPixels(screenshot, "decision-submit", app.actionPrimary, app.actionPrimaryContent, app.surfaceLow.compositeOver(app.canvas), 4.5f)
            verifyPixels(screenshot, "send-action", app.actionPrimary, app.actionPrimaryContent, app.canvas, 3f)
        } finally { screenshot.recycle() }
    }

    private fun verifyPixels(screenshot: android.graphics.Bitmap, tag: String, fill: Color, ink: Color, behind: Color, minimum: Float) {
        // Sample the actual presented screen at semantic node coordinates.
        // Five independent PixelCopy redraws can inspect different frames and
        // hit the library's 2s capture timeout even after semantics are idle.
        val bounds = compose.onNodeWithTag(tag).assertIsDisplayed().fetchSemanticsNode().boundsInWindow
        val left = bounds.left.roundToInt()
        val top = bounds.top.roundToInt()
        val right = bounds.right.roundToInt()
        val bottom = bounds.bottom.roundToInt()
        assertTrue("$tag must be completely inside the captured screen", left >= 0 && top >= 0 && right <= screenshot.width && bottom <= screenshot.height)
        val expectedFill = fill.compositeOver(behind)
        val expectedInk = ink.compositeOver(expectedFill)
        var backgrounds = 0
        var foregrounds = 0
        var sampledBackground = Color.Unspecified
        var sampledForeground = Color.Unspecified
        for (y in top until bottom) for (x in left until right) {
            val pixel = Color(screenshot.getPixel(x, y))
            if (close(pixel, expectedFill)) { backgrounds++; sampledBackground = pixel }
            if (close(pixel, expectedInk)) { foregrounds++; sampledForeground = pixel }
        }
        assertTrue("$tag must render its exact semantic fill (not a diluted glass tint): $backgrounds", backgrounds > (right - left) * (bottom - top) / 3)
        assertTrue("$tag must render actual foreground glyphs: $foregrounds", foregrounds >= 8)
        assertContrast("rendered $tag", sampledForeground, sampledBackground, minimum)
    }

    private fun close(a: Color, b: Color) = abs(a.red - b.red) <= 2f / 255 && abs(a.green - b.green) <= 2f / 255 && abs(a.blue - b.blue) <= 2f / 255

    private fun assertContrast(label: String, foreground: Color, background: Color, minimum: Float) {
        val a = foreground.luminance()
        val b = background.luminance()
        val ratio = (maxOf(a, b) + .05f) / (minOf(a, b) + .05f)
        assertTrue("$label contrast $ratio must be >= $minimum", ratio >= minimum)
    }

    private fun capture(name: String): android.graphics.Bitmap {
        compose.waitForIdle()
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val committed = CountDownLatch(1)
            compose.activityRule.scenario.onActivity {
                val view = it.window.decorView
                view.viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                view.invalidate()
            }
            check(committed.await(5, TimeUnit.SECONDS)) { "No committed frame: $name" }
        }
        android.os.SystemClock.sleep(350)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use {
            check(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
        }
        return screenshot
    }
}
