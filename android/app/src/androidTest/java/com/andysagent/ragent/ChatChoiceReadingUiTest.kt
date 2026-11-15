package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.core.model.RuntimeCatalog
import com.andysagent.ragent.core.model.RuntimeToolOption
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs
import java.io.File

/** A narrow native overlay must not erase the main-window document around it. */
class ChatChoiceReadingUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun lightHeaderGapsDoNotEraseTranscript() = verifyHeaderGaps(false)
    @Test fun darkHeaderGapsDoNotEraseTranscript() = verifyHeaderGaps(true)

    private fun verifyHeaderGaps(dark: Boolean) {
        val state = WorkbenchUiState(
            chatOpen = true, sessionId = "edge-reading-local", sessionTitle = "Test",
            connection = AgentConnectionStatus.Connected,
            timelineItems = (1..12).map { index -> TimelineItem.Message(
                id = "edge-$index", seq = index.toLong(), role = TimelineRole.Agent, completed = true,
                text = "阅读正文不应被整行遮罩抹掉，胶囊之外保持清晰。".repeat(100),
            ) },
        )
        rule.setContent { RagentTheme(darkTheme = dark) { WorkbenchScreen(state, onEvent = {}) } }
        rule.waitForIdle()
        val timeline = rule.onNodeWithTag("chat-timeline")
        val scrollKey = androidx.compose.ui.semantics.SemanticsProperties.VerticalScrollAxisRange
        val beforeScroll = timeline.fetchSemanticsNode().config[scrollKey].value()
        // All agent fragments belong to one turn. Its initial anchor is the
        // paragraph start; scroll INTO it, not farther toward the empty start.
        timeline.performTouchInput {
            swipeUp(startY = height * .65f, endY = height * .35f, durationMillis = 900)
        }
        rule.waitForIdle()
        assertTrue("Fixture did not move text into the header lane",
            timeline.fetchSemanticsNode().config[scrollKey].value() > beforeScroll)
        val plane = rule.onNodeWithTag("chat-reading-plane")
        val capture = plane.captureToImage()
        val evidence = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir("reading-edge-qa")!!
        File(evidence, "${if (dark) "dark" else "light"}-header-gap.png").outputStream().use {
            capture.asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        val image = capture.toPixelMap()
        val origin = plane.fetchSemanticsNode().boundsInWindow.topLeft
        val back = rule.onNodeWithTag("conversation-back-shell", true).fetchSemanticsNode().boundsInWindow.translate(-origin)
        val title = rule.onNodeWithTag("run-island-shell", true).fetchSemanticsNode().boundsInWindow.translate(-origin)
        val left = (back.right + with(rule.density) { 4.dp.toPx() }).toInt()
        val right = (title.left - with(rule.density) { 4.dp.toPx() }).toInt()
        val top = back.center.y.toInt()
        val bottom = back.bottom.toInt()
        assertTrue("Fixture needs a real gap between controls", right - left > 12)
        val count = (top until bottom).sumOf { y -> (left until right).count { x ->
            if (dark) image[x, y].red > .65f else image[x, y].red < .3f
        } }
        assertEquals("Header mask protects controls from noisy text bleed: $count foreground pixels", 0, count)
    }

    private fun verify(dark: Boolean, animated: Boolean = false) {
        var state by mutableStateOf(WorkbenchUiState(
            chatOpen = true, sessionId = "choice-reading-local", composerText = "Local preview",
            // This local fixture has no carrier. Suppress the separate offline
            // foreground so the measured band tests only reading fragments.
            connection = AgentConnectionStatus.Connected,
            runtimeCatalog = RuntimeCatalog(listOf(RuntimeToolOption("codex", "Codex"), RuntimeToolOption("claude", "Claude"))),
            timelineItems = (1..12).map { index -> TimelineItem.Message(
                id = "reading-$index", seq = index.toLong(), role = TimelineRole.Agent, completed = true,
                text = "### Reading context $index\n\n```kotlin\nval result = review(step = $index)\nprintln(result)\n```\n\n" +
                    // Dense natural wrapping puts real glyphs on both sides
                    // even beside a short effort shell during its first growth.
                    // A sparse list's last bullet has no right-side pixels.
                    "阅读正文保持原样，选择运行环境、服务提供者和模型时，不应遮住面板外的内容。".repeat(24),
            ) },
        ))
        rule.setContent {
            RagentTheme(darkTheme = dark, motionPreference = if (animated) MotionPreference.Full else MotionPreference.None) {
                WorkbenchScreen(state, onEvent = { event -> state = when (event) {
                    WorkbenchEvent.OpenRuntimePicker -> state.copy(runtimePickerOpen = true, effortPickerOpen = false)
                    WorkbenchEvent.CloseRuntimePicker -> state.copy(runtimePickerOpen = false)
                    WorkbenchEvent.OpenEffortPicker -> state.copy(effortPickerOpen = true, runtimePickerOpen = false)
                    WorkbenchEvent.CloseEffortPicker -> state.copy(effortPickerOpen = false)
                    else -> state
                } })
            }
        }
        rule.waitForIdle()
        val canvas = ((if (dark) AgentoFrostedTokens.AtmosphericCanvasDark
            else AgentoFrostedTokens.AtmosphericCanvasLight) as SolidColor).value
        fun distance(pixel: Color) = maxOf(abs(pixel.red - canvas.red),
            abs(pixel.green - canvas.green), abs(pixel.blue - canvas.blue))
        val plane = rule.onNodeWithTag("chat-reading-plane")
        fun capture(step: String): ImageBitmap = plane.captureToImage().also { bitmap ->
            val folder = InstrumentationRegistry.getInstrumentation().targetContext
                .getExternalFilesDir("reading-qa")!!
            File(folder, "${if (dark) "dark" else "light"}-$step.png").outputStream().use {
                bitmap.asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
        val before = capture("before").toPixelMap()
        val dock = rule.onNodeWithTag("agent-composer").fetchSemanticsNode().boundsInWindow
        val reading = plane.fetchSemanticsNode().boundsInWindow
        // The bottom gradient mask creates a smooth progressive defocus/fade zone above
        // the composer dock, ensuring no sharp background text creates visual clutter around the composer.
        val composerTop = (dock.top - reading.top).toInt()
        val bandTop = composerTop - with(rule.density) { 14.dp.roundToPx() }
        val bandBottom = composerTop - with(rule.density) { 2.dp.roundToPx() }
        val strongExteriorPixels = (bandTop until bandBottom).sumOf { y ->
            (before.width / 8 until before.width * 7 / 8).count { x -> distance(before[x, y]) > .65f }
        }
        assertEquals("Composer exterior is smoothly masked to protect legibility: $strongExteriorPixels",
            0, strongExteriorPixels)
        // captureToImage inspects the retained main-window reading plane.
        // The Popup draws its rounded glass in its own window, and must not
        // change this document at all. Keep both side strips, avoiding the
        // independent jump-to-bottom control at the lower right.
        val left = with(rule.density) { 24.dp.roundToPx() }
        val right = with(rule.density) { 44.dp.roundToPx() }
        val bottom = (dock.top - reading.top - with(rule.density) { 16.dp.toPx() }).toInt()
        for (runtime in listOf(true, false)) {
            if (animated) rule.mainClock.autoAdvance = false
            rule.runOnIdle { state = if (runtime) state.copy(runtimePickerOpen = true) else state.copy(effortPickerOpen = true) }
            if (animated) {
                rule.mainClock.advanceTimeByFrame()
                rule.onNodeWithTag("composer-picker-window").captureToImage()
                rule.mainClock.advanceTimeByFrame()
                rule.mainClock.advanceTimeBy(80)
            }
            val panel = rule.onNodeWithTag(if (runtime) "composer-runtime-picker" else "composer-effort-picker")
            panel.assertIsDisplayed()
            val top = (bottom - panel.fetchSemanticsNode().boundsInWindow.height).toInt().coerceAtLeast(0)
            val open = capture(if (runtime) "runtime" else "effort").toPixelMap()
            // The original paragraph ends before the outermost gutter. Use
            // its actual right text strip, also left of the 48dp jump control.
            // Keep the non-empty gate: sampling a blank gutter proves nothing.
            val exteriorLeft = before.width - with(rule.density) { 96.dp.roundToPx() }
            val exteriorRight = before.width - with(rule.density) { 64.dp.roundToPx() }
            val bands = listOf(Triple(left until right, top until bottom, "left"),
                Triple(exteriorLeft until exteriorRight, top until bottom, "right"))
            bands.forEach { (xs, ys, name) ->
                assertTrue("Fixture lacks actual $name reading pixels for $runtime",
                    ys.sumOf { y -> xs.count { x -> distance(before[x, y]) > .015f } } > 100)
                val changed = ys.flatMap { y -> xs.filter { x ->
                    val a = before[x, y]; val b = open[x, y]
                    maxOf(abs(a.red-b.red), abs(a.green-b.green), abs(a.blue-b.blue)) > .015f
                }.map { x -> "$x,$y=${open[x, y]}" } }
                assertEquals("Narrow $runtime choice erased or changed $name reading pixels; " +
                    "first=${changed.firstOrNull()} last=${changed.lastOrNull()}", 0, changed.size)
            }
            if (animated) {
                val movingHeight = panel.fetchSemanticsNode().boundsInWindow.height
                rule.mainClock.advanceTimeBy(800)
                val fullHeight = panel.fetchSemanticsNode().boundsInWindow.height
                assertTrue("Pixel check missed the growing shell: moving=$movingHeight full=$fullHeight",
                    movingHeight > 0f && movingHeight < fullHeight - 2f)
            }
            rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
            if (animated) {
                rule.mainClock.advanceTimeBy(800)
                rule.mainClock.autoAdvance = true
            }
            rule.waitForIdle()
            val restored = plane.captureToImage().toPixelMap()
            val changed = (top until bottom).sumOf { y -> (left until right).count { x ->
                val a = before[x, y]; val b = restored[x, y]
                maxOf(abs(a.red-b.red), abs(a.green-b.green), abs(a.blue-b.blue)) > .015f
            } }
            assertEquals("Closed panel kept a stale edge or moved the reading document", 0, changed)
        }
    }

    @Test fun lightChoicePreservesTheSurroundingReadingPlane() = verify(false)
    @Test fun darkChoicePreservesTheSurroundingReadingPlane() = verify(true)
    @Test fun lightMovingChoiceDoesNotEraseTheSurroundingDocument() = verify(false, animated = true)
    @Test fun darkMovingChoiceDoesNotEraseTheSurroundingDocument() = verify(true, animated = true)
}
