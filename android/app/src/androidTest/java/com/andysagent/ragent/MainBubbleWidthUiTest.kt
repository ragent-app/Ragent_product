package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.workbench.TurnUserPrompt
import com.andysagent.ragent.feature.workbench.UserPromptBlock
import java.io.File
import org.junit.Rule
import org.junit.Test

class MainBubbleWidthUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    @Test fun shortAndLongMessages() {
        val short = "Hi"
        val long = "A longer message with several words wraps at the available width. ".repeat(4)
        rule.setContent { RagentTheme {
            Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp)) {
                UserPromptBlock(TurnUserPrompt("short", short), {}, {}, {})
                UserPromptBlock(TurnUserPrompt("long", long), {}, {}, {})
            }
        } }
        rule.onNodeWithText(short).assertIsDisplayed()
        rule.waitForIdle()
        android.os.SystemClock.sleep(500)
        val out = File(rule.activity.getExternalFilesDir(null), "main-bubble-width.png")
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().let { bitmap ->
            out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
