package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.navigation.AgentoAdaptiveScaffold
import com.andysagent.ragent.core.navigation.AgentoDestination
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

/** Real root draw contracts; these do not approve whole-page aesthetics or motion. */
class PrimaryReadingPlaneUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun verifySampling(dark: Boolean) {
        var source by mutableStateOf(Color.Red)
        var dockVisible by mutableStateOf(true)
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = MotionPreference.None) {
                AgentoAdaptiveScaffold(
                    selected = AgentoDestination.Home, onDestinationSelected = {},
                    dockVisible = dockVisible, modifier = Modifier.width(360.dp).height(650.dp),
                ) { modifier, _, _, _ -> Box(modifier.background(source)) }
            }
        }
        rule.waitForIdle()
        fun glassPixel(): Color {
            val pixels = rule.onNodeWithTag("bottom-navigation-shell").captureToImage().toPixelMap()
            return pixels[(pixels.width * .05f).toInt(), pixels.height / 2]
        }
        val red = glassPixel()
        rule.runOnIdle { source = Color.Blue }
        rule.waitForIdle()
        val blue = glassPixel()
        assertTrue("Raw backdrop froze or received the masked reader plane: $red -> $blue",
            red.red > blue.red + .01f && blue.blue > red.blue + .01f)

        val plane = rule.onNodeWithTag("primary-reading-plane").captureToImage().toPixelMap()
        assertTrue("Readable page lost its actual source", plane[plane.width / 2, 80].blue > .95f)
        // captureToImage crops the composited window, not this modifier's
        // transparent offscreen layer. The revealed root must match exactly,
        // rather than expecting an alpha channel in the window screenshot.
        val root = ((if (dark) AgentoFrostedTokens.AtmosphericCanvasDark
            else AgentoFrostedTokens.AtmosphericCanvasLight) as SolidColor).value
        val bottom = plane[plane.width / 2, plane.height - 2]
        assertTrue("Reader source still paints below the dock: $bottom, expected root $root",
            abs(bottom.red - root.red) < .01f && abs(bottom.green - root.green) < .01f &&
                abs(bottom.blue - root.blue) < .01f)

        // A settings detail can remove the dock entirely. There must be no
        // missing-measurable crash and no stale reading mask after it leaves.
        rule.runOnIdle { dockVisible = false }
        rule.waitForIdle()
        rule.onNodeWithTag("bottom-navigation-shell").assertDoesNotExist()
        val withoutDock = rule.onNodeWithTag("primary-reading-plane").captureToImage().toPixelMap()
        assertTrue("Hidden dock retained a dead reading boundary",
            withoutDock[withoutDock.width / 2, withoutDock.height - 2].blue > .95f)
    }

    @Test fun lightReaderExitsWhileGlassKeepsDynamicRawSampling() = verifySampling(false)
    @Test fun darkReaderExitsWhileGlassKeepsDynamicRawSampling() = verifySampling(true)
}
