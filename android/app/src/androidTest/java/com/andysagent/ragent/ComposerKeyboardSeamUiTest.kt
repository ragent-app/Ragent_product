package com.andysagent.ragent

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlin.math.abs
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real-window IME geometry: the dock's breathing room is not a second reading strip. */
class ComposerKeyboardSeamUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lightKeyboardSeamContainsNoTranscriptFragments() = verify("light")
    @Test fun darkKeyboardSeamContainsNoTranscriptFragments() = verify("dark")

    private fun verify(theme: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("theme", theme).putExtra("page", "chat").putExtra("locale", "en")
            .putExtra("font_scale", 1f).putExtra("draft", "Native-draft")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            compose.onNodeWithContentDescription("Message composer").performClick()
            compose.onNodeWithTag("inline-composer-editor").performClick()
            var imeTop = 0
            compose.waitUntil(10_000) {
                var visible = false
                scenario.onActivity {
                    val decor = it.window.decorView
                    val insets = requireNotNull(ViewCompat.getRootWindowInsets(decor))
                    visible = insets.isVisible(WindowInsetsCompat.Type.ime())
                    imeTop = decor.height - insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                }
                visible
            }
            compose.waitForIdle()
            val plane = compose.onNodeWithTag("chat-reading-plane")
            val origin = plane.fetchSemanticsNode().boundsInWindow.top
            val dockBottom = compose.onNodeWithTag("agent-composer").fetchSemanticsNode().boundsInWindow.bottom
            val margin = with(compose.density) { 2.dp.toPx() }
            val top = (dockBottom - origin + margin).toInt()
            val bottom = (imeTop - origin - margin).toInt()
            assertTrue("Fixture must have an actual composer/IME gap: $dockBottom .. $imeTop", bottom > top + 3)
            val capture = plane.captureToImage()
            File(context.getExternalFilesDir(null), "keyboard-seam-$theme.png").outputStream().use {
                capture.asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            val pixels = capture.toPixelMap()
            // Compare with the already excluded OS band in this same reading
            // layer, avoiding hard-coded theme RGB and overlaid control shadows.
            val canvas = pixels[pixels.width / 2, pixels.height - 1]
            val altered = (top until bottom).sumOf { y ->
                (pixels.width / 8 until pixels.width * 7 / 8).count { x ->
                    val pixel = pixels[x, y]
                    maxOf(abs(pixel.red - canvas.red), abs(pixel.green - canvas.green),
                        abs(pixel.blue - canvas.blue)) > .03f
                }
            }
            assertEquals("Transcript leaked into composer/IME breathing room ($top..$bottom)", 0, altered)
            compose.onNodeWithTag("inline-composer-editor").assertTextContains("Native-draft")
        }
    }
}
