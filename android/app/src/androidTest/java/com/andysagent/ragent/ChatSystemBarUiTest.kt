package com.andysagent.ragent

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatSystemBarUiTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lightStatusBarKeepsAQuietBackgroundOverLargeTranscript() = verifySystemBar(false)
    @Test fun darkStatusBarKeepsAQuietBackgroundOverLargeTranscript() = verifySystemBar(true)

    private fun verifySystemBar(dark: Boolean) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "zh-CN").putExtra("font_scale", 1.6f).putExtra("dark", dark)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use { scenario ->
            // The old chat-only overlay has been replaced by a shared safe viewport.
            val bounds = compose.onNodeWithTag("app-system-safe-content").assertIsDisplayed().getUnclippedBoundsInRoot()
            var top = 0
            scenario.onActivity { activity ->
                top = requireNotNull(androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView))
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars() or
                        androidx.core.view.WindowInsetsCompat.Type.displayCutout()).top
                assertTrue("Foreground viewport invades status bar", bounds.top.value * activity.resources.displayMetrics.density >= top - 1)
            }
            assertTrue("Must cover an actual system inset", top > 20)
            val screenshot = requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
            try {
                val x = screenshot.width * 2 / 5
                val expected = screenshot.getPixel(x, top / 2)
                for (y in 2 until top - 2) for (dx in 0..5) {
                    org.junit.Assert.assertEquals("Transcript leaked into system bar", expected, screenshot.getPixel(x + dx, y))
                }
                val red = android.graphics.Color.red(expected)
                assertTrue("Status bar must match the theme", if (dark) red < 77 else red > 204)
            } finally { screenshot.recycle() }
        }
    }

    @Test fun cancelledRunNeverShowsReadyInItsExpandedSummary() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, ComposerPickerQaActivity::class.java)
            .putExtra("locale", "zh-CN").putExtra("status", "Cancelled")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ActivityScenario.launch<ComposerPickerQaActivity>(intent).use {
            compose.onNodeWithText("输入面板 · 长会话检查").performClick()
            compose.onNodeWithText("已取消").assertIsDisplayed()
            compose.onNodeWithText("可在会话中查看取消前已完成的工作。").assertIsDisplayed()
            compose.onNodeWithText("准备就绪").assertDoesNotExist()
            compose.onNodeWithContentDescription("运行详情").performClick()
            compose.onNodeWithText("已取消").assertIsDisplayed()
            compose.onNodeWithText("Idle").assertDoesNotExist()
            compose.onNodeWithText("耗时").assertIsDisplayed()
            // The inline island omits the old redundant "运行信息" heading.
            // Verify the actual details surface, not retired presentation copy.
            compose.onNodeWithTag("run-metrics-group").assertIsDisplayed()
            compose.onNodeWithText("文件（0）").performClick()
            compose.onNodeWithText("本次运行尚未报告文件变更。").assertIsDisplayed()
            val emptyBounds = compose.onNodeWithTag("run-island-shell").getUnclippedBoundsInRoot()
            println("Cancelled empty files shell height=${emptyBounds.bottom - emptyBounds.top}")
            assertTrue("An empty tab must not reserve a full-height detail panel", emptyBounds.bottom - emptyBounds.top < 280.dp)
            compose.onNodeWithText("步骤（0）").performClick()
            compose.onNodeWithText("本次运行尚无执行步骤记录。").assertIsDisplayed()
            val traceBounds = compose.onNodeWithTag("run-island-shell").getUnclippedBoundsInRoot()
            println("Cancelled empty steps shell height=${traceBounds.bottom - traceBounds.top}")
            assertTrue("Empty steps must not reserve a full-height detail panel", traceBounds.bottom - traceBounds.top < 280.dp)
        }
    }
}
