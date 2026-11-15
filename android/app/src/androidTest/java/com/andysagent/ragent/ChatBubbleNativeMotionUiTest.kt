package com.andysagent.ragent

import android.os.SystemClock
import android.graphics.Bitmap
import android.graphics.Color
import java.io.File
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import com.andysagent.ragent.feature.workbench.ComposerAttachment
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.workbench.TurnUserPrompt
import com.andysagent.ragent.feature.workbench.UserPromptBlock
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Exercises actual window/input timing for a concurrent device recording. */
class ChatBubbleNativeMotionUiTest {
    @Test fun longPressMenuAndExpandedMessage() = exercise(dark = false)
    @Test fun darkLongPressMenuAndExpandedMessage() = exercise(dark = true)

    @Test fun attachmentLoadingAndScrollingUseNativeTiming() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val imageFile = File(activity.cacheDir, "native-motion-preview.png")
                Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888).also { bitmap ->
                    bitmap.eraseColor(Color.rgb(225, 31, 35))
                    imageFile.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                    bitmap.recycle()
                }
                val image = ComposerAttachment(id = "native-motion-real", name = "preview.png", mimeType = "image/png", localPath = imageFile.absolutePath)
                val file = ComposerAttachment(id = "native-motion-document", name = "project-notes.pdf", mimeType = "application/pdf", sizeBytes = 2048)
                activity.setContent { RagentTheme(darkTheme = true) {
                    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas)
                        .verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        repeat(9) { index ->
                            UserPromptBlock(TurnUserPrompt("native-attachment-$index", "Message $index", listOf(image, file)), {}, {}, {})
                        }
                    }
                } }
            }
            assertNotNull(device.wait(Until.findObject(By.text("Message 0")), 5_000))
            SystemClock.sleep(1800)
            val cx = device.displayWidth / 2
            val top = device.displayHeight / 4
            val bottom = device.displayHeight * 3 / 4
            device.swipe(cx, bottom, cx, top, 35)
            SystemClock.sleep(500)
            device.swipe(cx, top, cx, bottom, 35)
            SystemClock.sleep(1200)
        }
    }

    private fun exercise(dark: Boolean) {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            var copyLabel = ""
            var expandLabel = ""
            scenario.onActivity { activity ->
                copyLabel = activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_copy)
                expandLabel = activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_expand)
                activity.setContent { RagentTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxSize().background(LocalRagentColors.current.canvas).padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        UserPromptBlock(TurnUserPrompt("short-motion", "Please check the project."), {}, {}, {})
                        UserPromptBlock(TurnUserPrompt("long-motion", "Please inspect these files and explain the changes. ".repeat(8)), {}, {}, {})
                    }
                } }
            }
            val prompt = device.wait(Until.findObject(By.textContains("Please check the project")), 5_000)
            assertNotNull(prompt)
            SystemClock.sleep(1000)
            prompt.longClick()
            assertNotNull(device.wait(Until.findObject(By.text(copyLabel)), 5_000))
            SystemClock.sleep(1000)
            device.pressBack()
            val expand = device.wait(Until.findObject(By.text(expandLabel)), 5_000)
            assertNotNull(expand)
            SystemClock.sleep(700)
            expand.click()
            SystemClock.sleep(1200)
        }
    }
}
