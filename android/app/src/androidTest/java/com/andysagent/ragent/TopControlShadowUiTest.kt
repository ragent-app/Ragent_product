package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Inspect outside the shapes: a clipped halo cannot pass by darkening the glass. */
class TopControlShadowUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun allThreeHeaderControlsHaveAnUnclippedDiffuseHalo() {
        rule.setContent {
            RagentTheme(darkTheme = false) {
                WorkbenchScreen(WorkbenchUiState(
                    chatOpen = true, sessionId = "top-shadow-local", sessionTitle = "Shadow",
                    connection = AgentConnectionStatus.Connected,
                ))
            }
        }
        rule.waitForIdle()
        val root = rule.onRoot()
        val origin = root.fetchSemanticsNode().boundsInWindow.topLeft
        val capture = root.captureToImage()
        val pixels = capture.toPixelMap()
        val folder = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir("top-shadow-qa")!!
        File(folder, "header-halos.png").outputStream().use {
            capture.asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        fun px(value: Int) = with(rule.density) { value.dp.toPx() }
        for (tag in listOf("conversation-back-shell", "run-island-shell", "conversation-more-shell")) {
            val bounds = rule.onNodeWithTag(tag, true).fetchSemanticsNode().boundsInWindow.translate(-origin)
            // Icon hit targets are 48dp; their visible circular glass is 36dp.
            val bottom = if (tag == "run-island-shell") bounds.bottom else bounds.center.y + px(18)
            fun mean(offset: Int): Double {
                val y = (bottom + px(offset)).toInt()
                val x = bounds.center.x.toInt()
                return (-3..3).map { pixels[x + it, y].red.toDouble() }.average()
            }
            val near = mean(4)
            val halo = mean(12)
            val clear = mean(40)
            assertTrue("$tag shadow clipped or absent: $near / $halo / $clear", clear - halo > .0015)
            assertTrue("$tag shadow does not fade outward: $near / $halo / $clear", near < halo && halo < clear)
        }
    }
}
