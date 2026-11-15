package com.andysagent.ragent

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.agentui.AgentMarkdown
import com.andysagent.ragent.core.agentui.AgentMarkdownCorpus
import com.andysagent.ragent.core.agentui.LocalAgentMarkdownBodyWeight
import com.andysagent.ragent.core.designsystem.RagentTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * Message reading baselines for the native Markdown renderer.
 *
 * Renders [AgentMarkdownCorpus.readingSample] at the candidate body weights
 * (400 / 450 / 500) in light and dark themes, on-device, and publishes the PNGs
 * to `/sdcard/Download/ragent-screenshots` for `adb pull`. The chosen weight
 * and the comparison outcome are recorded in
 * `docs/markdown-rendering-contract.md`.
 *
 * Run:
 * ```
 * ./gradlew :app:connectedDebugAndroidTest \
 *   -Pandroid.testInstrumentationRunnerArguments.class=com.andysagent.ragent.MarkdownReadingScreenshotTest
 * adb pull /sdcard/Download/ragent-screenshots
 * ```
 */
@RunWith(AndroidJUnit4::class)
class MarkdownReadingScreenshotTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun captureReadingWeights() {
        val renderSpec = installRenderer(AgentMarkdownCorpus.readingSample)
        for (weight in listOf(400, 450, 500)) {
            capture(
                renderSpec = renderSpec,
                name = "markdown-reading-w$weight",
                dark = false,
                bodyWeight = FontWeight(weight),
            )
            capture(
                renderSpec = renderSpec,
                name = "markdown-reading-w${weight}-dark",
                dark = true,
                bodyWeight = FontWeight(weight),
            )
        }
    }

    @Test
    fun captureHeadingHierarchy() {
        val renderSpec = installRenderer(AgentMarkdownCorpus.headingSample)
        capture(renderSpec = renderSpec, name = "markdown-headings", dark = false)
    }

    private fun installRenderer(sample: String): MutableState<RenderSpec> {
        val renderSpec = mutableStateOf(RenderSpec(sample = sample))
        composeRule.setContent {
            val spec = renderSpec.value
            RagentTheme(darkTheme = spec.dark) {
                CompositionLocalProvider(LocalAgentMarkdownBodyWeight provides spec.bodyWeight) {
                    Surface(modifier = Modifier.fillMaxSize()) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 20.dp),
                        ) {
                            AgentMarkdown(spec.sample)
                        }
                    }
                }
            }
        }
        return renderSpec
    }

    private fun capture(
        renderSpec: MutableState<RenderSpec>,
        name: String,
        dark: Boolean,
        bodyWeight: FontWeight = FontWeight(450),
    ) {
        renderSpec.value = RenderSpec(
            sample = renderSpec.value.sample,
            dark = dark,
            bodyWeight = bodyWeight,
        )
        composeRule.waitForIdle()
        SystemClock.sleep(400)

        val bitmap = takeNonBlankScreenshot(dark)
        val outputDir = File(
            InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),
            "screenshots",
        )
        outputDir.mkdirs()
        val output = File(outputDir, "$name.png")
        FileOutputStream(output).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
        val publishedDir = "/sdcard/Download/ragent-screenshots"
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand("mkdir -p $publishedDir")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        automation.executeShellCommand("cp ${output.absolutePath} $publishedDir/${output.name}")
            .use { command -> FileInputStream(command.fileDescriptor).use { it.readBytes() } }
        android.util.Log.i("MarkdownBaseline", "captured $name.png (${bitmap.width}x${bitmap.height})")
    }

    private data class RenderSpec(
        val sample: String,
        val dark: Boolean = false,
        val bodyWeight: FontWeight = FontWeight(450),
    )

    /** Screenshots through the automation layer are occasionally blank; retry. */
    private fun takeNonBlankScreenshot(dark: Boolean): Bitmap {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        repeat(10) { attempt ->
            val bitmap = automation.takeScreenshot()
            if (hasVisibleContent(bitmap, dark)) return bitmap
            bitmap.recycle()
            android.util.Log.w("MarkdownBaseline", "blank frame $attempt; retrying")
            SystemClock.sleep(250)
        }
        error("Screenshot remained blank after 10 attempts")
    }

    /** Counts pixels that differ from the theme background, so a blank frame fails. */
    private fun hasVisibleContent(bitmap: Bitmap, dark: Boolean): Boolean {
        var contentSamples = 0
        val startY = bitmap.height / 10
        val endY = bitmap.height * 9 / 10
        for (y in startY until endY step 8) {
            for (x in 0 until bitmap.width step 8) {
                val pixel = bitmap.getPixel(x, y)
                val luma = (android.graphics.Color.red(pixel) +
                    android.graphics.Color.green(pixel) +
                    android.graphics.Color.blue(pixel)) / 3
                val isBackground = if (dark) luma < 60 else luma > 244
                if (!isBackground) {
                    contentSamples += 1
                    if (contentSamples >= 80) return true
                }
            }
        }
        return false
    }
}
