package com.andysagent.ragent

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.feature.workbench.WorkbenchEvent
import com.andysagent.ragent.feature.workbench.WorkbenchScreen
import com.andysagent.ragent.feature.workbench.WorkbenchUiState
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

/** Production parent constraints and real focus, not a standalone text-field fixture. */
@OptIn(ExperimentalTestApi::class)
class ComposerCodeOutlineUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val original = "Local preview\n第一行\n第二行\n第三行\n第四行\n第五行\n**Important**: verify `healthz`"
    private var state by mutableStateOf(WorkbenchUiState())
    private fun editor() = rule.onNodeWithTag("inline-composer-editor")

    private fun show(fontScale: Float) {
        rule.runOnUiThread {
            rule.activity.enableEdgeToEdge()
            rule.activity.window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        state = WorkbenchUiState(chatOpen = true, sessionId = "code-outline-local", composerText = original)
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                RagentTheme(darkTheme = true) {
                    Box(Modifier.width(320.dp)) {
                        WorkbenchScreen(state = state, onEvent = {
                            if (it is WorkbenchEvent.ComposerChanged) state = state.copy(composerText = it.text)
                        })
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    private fun assertLastCodeBottomBorder() {
        val layouts = mutableListOf<TextLayoutResult>()
        editor().performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        val result = layouts.single()
        val codeStart = result.layoutInput.text.text.lastIndexOf("healthz")
        assertTrue("Missing rendered code", codeStart >= 0)
        val codeWidth = result.getBoundingBox(codeStart + 6).right - result.getBoundingBox(codeStart).left
        val pixels = editor().captureToImage().toPixelMap()
        // Only this document's final span has an outline. Require both long
        // horizontal edges, separated by the last line height. The upper
        // stroke and a few side-arc pixels alone must never pass this check.
        var longest = 0
        val edgeRows = mutableListOf<Int>()
        for (y in 0 until pixels.height) {
            var run = 0
            var rowLongest = 0
            for (x in 0 until pixels.width) {
                val c = pixels[x, y]
                run = if (c.red in 0.65f..0.90f && abs(c.red - c.blue) < 0.04f && abs(c.red - c.green) < 0.04f) run + 1 else 0
                rowLongest = maxOf(rowLongest, run)
            }
            longest = maxOf(longest, rowLongest)
            if (rowLongest >= codeWidth * 0.45f) edgeRows += y
        }
        val lastLine = result.lineCount - 1
        val lineHeight = result.getLineBottom(lastLine) - result.getLineTop(lastLine)
        println("Code outline: image=${pixels.width}x${pixels.height}, codeWidth=$codeWidth, run=$longest, edgeRows=$edgeRows, lineHeight=$lineHeight, layout=${result.size}")
        assertTrue("Code outline has no upper and lower edges: $edgeRows", edgeRows.size >= 2)
        assertTrue("Last code bottom border is clipped: $edgeRows, lineHeight=$lineHeight",
            edgeRows.last() - edgeRows.first() >= lineHeight * 0.75f)
    }

    @Test fun focusedLongDraftKeepsItsCodeOutline() {
        show(1f)
        editor().performClick()
        val end = editor().fetchSemanticsNode().config[SemanticsProperties.EditableText].length
        editor().performTextInputSelection(TextRange(end))
        rule.waitForIdle()
        assertLastCodeBottomBorder()
    }

    @Test fun largeTextReturnKeepsItsCodeOutline() {
        show(2f)
        rule.onNodeWithContentDescription(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_fullscreen_edit)).performClick()
        rule.onNodeWithTag("fullscreen-composer-editor").assertIsFocused()
        rule.onNodeWithText(rule.activity.getString(com.andysagent.ragent.core.agentui.R.string.agentui_done)).performClick()
        rule.waitForIdle()
        assertLastCodeBottomBorder()
    }
}
