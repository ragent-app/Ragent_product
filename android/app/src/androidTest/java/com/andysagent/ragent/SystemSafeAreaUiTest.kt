package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Actual window insets, clipped foreground bounds and OS-composited pixels. */
class SystemSafeAreaUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lightChatProtectsBothBarsWhileScrolling() = verify("light", false, "chat", scroll = true)
    @Test fun darkChatProtectsBothBarsWhileScrolling() = verify("dark", true, "chat", scroll = true)
    @Test fun oledHomeProtectsBothBars() = verify("oled", true, "home")
    @Test fun amberSettingsProtectsBothBars() = verify("amber", true, "settings")
    @Test fun fullscreenEditorProtectsBothBars() = verify("light", false, "chat", panel = "fullscreen")

    private fun verify(theme: String, dark: Boolean, page: String, panel: String? = null, scroll: Boolean = false) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intent = Intent(instrumentation.targetContext, ComposerPickerQaActivity::class.java)
            .putExtra("theme", theme).putExtra("page", page).putExtra("locale", "en")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        panel?.let { intent.putExtra("panel", it) }
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            compose.onNodeWithTag("app-system-safe-content").assertIsDisplayed()
            var captureIndex = 0
            fun check() {
                compose.waitForIdle()
                var safeTop = 0; var safeBottom = 0; var scale = 1f; var height = 0
                scenario.onActivity { activity ->
                    val decor = activity.window.decorView
                    val insets = requireNotNull(ViewCompat.getRootWindowInsets(decor))
                        .getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                    safeTop = insets.top; safeBottom = insets.bottom; height = decor.height
                    scale = activity.resources.displayMetrics.density
                    val controller = WindowCompat.getInsetsController(activity.window, decor)
                    assertEquals("Status icons must follow app palette", !dark, controller.isAppearanceLightStatusBars)
                    assertEquals("Nav icons must follow app palette", !dark, controller.isAppearanceLightNavigationBars)
                }
                assertTrue("Test requires real status and nav insets", safeTop > 0 && safeBottom > 0)
                val viewport = compose.onNodeWithTag("app-system-safe-content").getUnclippedBoundsInRoot()
                assertEquals(safeTop.toFloat(), viewport.top.value * scale, 1.5f)
                assertEquals((height - safeBottom).toFloat(), viewport.bottom.value * scale, 1.5f)
                fun save(bitmap: android.graphics.Bitmap, phase: String) {
                    val file = java.io.File(instrumentation.targetContext.getExternalFilesDir(null),
                        "safe-$theme-$page-$captureIndex-$phase.png")
                    java.io.FileOutputStream(file).use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                }
                if (captureIndex == 0) {
                    val early = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                    try { save(early, "early") } finally { early.recycle() }
                    // Activity window transitions are outside Compose's idle/test clock.
                    // Keep the early frame as evidence; this assertion covers settled rendering.
                    android.os.SystemClock.sleep(750)
                }
                val screenshot = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                try {
                    save(screenshot, "settled")
                    // Separate blank strips: notification icons occupy 30% at the top,
                    // while the centered gesture handle occupies 40% at the bottom.
                    val x = screenshot.width * 2 / 5
                    val navX = screenshot.width / 4
                    val expected = screenshot.getPixel(x, safeTop / 2)
                    assertTrue("Bar canvas disagrees with $theme: ${expected.toUInt().toString(16)}", if (dark)
                        android.graphics.Color.red(expected) < 90 else android.graphics.Color.red(expected) > 200)
                    for (y in 2 until safeTop - 2) for (dx in 0..5)
                        assertEquals("Foreground leaked into status area", expected, screenshot.getPixel(x + dx, y))
                    for (y in screenshot.height - safeBottom + 2 until screenshot.height - 2) for (dx in 0..5)
                        assertEquals("Foreground leaked into navigation area", expected, screenshot.getPixel(navX + dx, y))
                } finally { screenshot.recycle() }
                captureIndex++
            }
            check()
            if (scroll) {
                repeat(2) {
                    compose.onNodeWithTag("chat-timeline").performTouchInput { swipeUp() }
                    check()
                }
                compose.onNodeWithTag("chat-timeline").performTouchInput { swipeDown() }
                check()
                compose.onNodeWithText("输入面板 · 长会话检查").performTouchInput { click() }
                check()
            }
        }
    }
}
