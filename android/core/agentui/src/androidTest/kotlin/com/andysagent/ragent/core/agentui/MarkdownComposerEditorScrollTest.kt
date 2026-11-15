package com.andysagent.ragent.core.agentui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MarkdownComposerEditorScrollTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun composerShowsFiveLinesBeforeTheEditorStartsScrolling() {
        val fiveLines = (1..5).joinToString("\n") { "line $it" }
        var scrollState: ScrollState? = null
        var layout: TextLayoutResult? = null

        composeRule.setContent {
            ComposerScrollProbe(
                value = fiveLines,
                onScrollState = { scrollState = it },
                onTextLayout = { layout = it },
            )
        }
        waitUntilTextIsDisplayed(fiveLines) { layout }

        assertEquals("five lines must fit before scrolling starts", 0, scrollState!!.maxValue)
    }

    @Test
    fun composerScrollsOnceTheSixthLineExceedsTheViewport() {
        val sixLines = (1..6).joinToString("\n") { "line $it" }
        var scrollState: ScrollState? = null
        var layout: TextLayoutResult? = null

        composeRule.setContent {
            ComposerScrollProbe(
                value = sixLines,
                onScrollState = { scrollState = it },
                onTextLayout = { layout = it },
            )
        }
        waitUntilTextIsDisplayed(sixLines) { layout }

        assertTrue("the sixth line must create a scroll range", scrollState!!.maxValue > 0)
    }

    @Test
    fun scrollingToDocumentEndKeepsTheFinalLineInsideTheViewport() {
        val value = (1..18).joinToString("\n") { "line $it" }
        var scrollState: ScrollState? = null
        var layout: TextLayoutResult? = null
        var viewportHeight = 0

        composeRule.setContent {
            val rememberedScrollState = rememberScrollState()
            scrollState = rememberedScrollState
            RagentTheme {
                Box(
                    modifier = Modifier
                        .width(320.dp)
                        .height(96.dp),
                ) {
                    MarkdownComposerEditor(
                        value = value,
                        onValueChange = {},
                        modifier = Modifier
                            .fillMaxSize()
                            .onSizeChanged { viewportHeight = it.height },
                        textStyle = TextStyle(
                            fontSize = 16.sp,
                            lineHeight = 27.5.sp,
                        ),
                        isDark = false,
                        scrollState = rememberedScrollState,
                        onTextLayout = { layout = it },
                    )
                }
            }
        }
        waitUntilTextIsDisplayed(value) { layout }
        assertTrue("the long document must have scrollable content", scrollState!!.maxValue > 0)

        runBlocking { scrollState!!.scrollTo(scrollState!!.maxValue) }
        composeRule.waitForIdle()

        val textLayout = layout ?: error("editor did not publish a text layout")
        val lastLine = textLayout.lineCount - 1
        val viewportBottom = scrollState!!.value + viewportHeight
        assertTrue(
            "the final line must remain below the viewport top at maxScroll",
            textLayout.getLineTop(lastLine) >= scrollState!!.value,
        )
        assertTrue(
            "the final line must clear the clipped viewport edge " +
                "(${textLayout.getLineBottom(lastLine)}px <= ${viewportBottom - 1}px)",
            textLayout.getLineBottom(lastLine) <= viewportBottom - 1,
        )
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun movingSelectionToHiddenLinesBringsTheActiveLineIntoTheComposerViewport() {
        val value = (1..18).joinToString("\n") { "line $it" }
        var scrollState: ScrollState? = null
        var layout: TextLayoutResult? = null

        composeRule.setContent {
            val rememberedScrollState = rememberScrollState()
            scrollState = rememberedScrollState
            RagentTheme {
                Box(
                    modifier = Modifier
                        .width(320.dp)
                        .height(96.dp),
                ) {
                    MarkdownComposerEditor(
                        value = value,
                        onValueChange = {},
                        modifier = Modifier.fillMaxSize(),
                        textStyle = TextStyle.Default,
                        isDark = false,
                        scrollState = rememberedScrollState,
                        onTextLayout = { layout = it },
                    )
                }
            }
        }
        waitUntilTextIsDisplayed(value) { layout }
        assertTrue("The long document must have scrollable content", scrollState!!.maxValue > 0)

        runBlocking { scrollState!!.scrollTo(scrollState!!.maxValue) }
        composeRule.waitForIdle()
        composeRule
            .onNode(hasSetTextAction())
            .performTextInputSelection(TextRange(0))
        composeRule.waitForIdle()

        assertTrue(
            "Moving the active line above the viewport must scroll back to the start",
            scrollState!!.value == 0,
        )

        runBlocking { scrollState!!.scrollTo(0) }
        composeRule.waitForIdle()
        composeRule
            .onNode(hasSetTextAction())
            .performTextInputSelection(TextRange(value.length))
        composeRule.waitForIdle()

        assertTrue(
            "The active line must be brought into view after selection moves",
            scrollState!!.value > 0,
        )

        runBlocking { scrollState!!.scrollTo(0) }
        composeRule.waitForIdle()
        composeRule.onNode(hasSetTextAction()).performTextInput("\nline 19")
        composeRule.waitForIdle()
        assertTrue("Typing at the hidden document end must stay visible", scrollState!!.value > 0)

        runBlocking { scrollState!!.scrollTo(scrollState!!.maxValue) }
        composeRule.waitForIdle()
        val scrollBeforeTailInput = scrollState!!.value
        composeRule.onNode(hasSetTextAction()).performTextInput(" tail")
        composeRule.waitForIdle()
        assertTrue(
            "Typing while the editor is already at its end must not jump to the top",
            scrollState!!.value >= scrollBeforeTailInput - 1,
        )
    }

    @Test
    @OptIn(ExperimentalTestApi::class)
    fun softWrappingAfterWidthChangeKeepsTheActiveLineInsideTheViewport() {
        val value = List(22) { "soft wrapping" }.joinToString(" ")
        var composerWidth by mutableStateOf(420.dp)
        var scrollState: ScrollState? = null
        var layout: TextLayoutResult? = null

        composeRule.setContent {
            val rememberedScrollState = rememberScrollState()
            scrollState = rememberedScrollState
            RagentTheme {
                Box(
                    modifier = Modifier
                        .width(composerWidth)
                        .height(RagentSizes.ComposerMaxHeight),
                ) {
                    MarkdownComposerEditor(
                        value = value,
                        onValueChange = {},
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(top = 12.dp, bottom = AgentoSpacing.Compact),
                        textStyle = TextStyle(
                            fontSize = 16.sp,
                            lineHeight = 27.5.sp,
                        ),
                        isDark = false,
                        scrollState = rememberedScrollState,
                        onTextLayout = { layout = it },
                    )
                }
            }
        }
        waitUntilTextIsDisplayed(value) { layout }
        composeRule.onNode(hasSetTextAction())
            .performTextInputSelection(TextRange(value.length))
        composeRule.waitForIdle()

        composerWidth = 150.dp
        composeRule.waitForIdle()

        val reflowedLineCount = layout?.lineCount ?: 0
        assertTrue(
            "A narrower composer must soft-wrap the plain draft ($reflowedLineCount lines)",
            reflowedLineCount > 5,
        )
        assertTrue(
            "Soft wrapping beyond the composer cap must create a scroll range " +
                "(${scrollState!!.value}px of ${scrollState!!.maxValue}px)",
            scrollState!!.maxValue > 0,
        )

        assertTrue(
            "Soft wrapping must move an end caret into the capped viewport " +
                "(${scrollState!!.value}px of ${scrollState!!.maxValue}px)",
            scrollState!!.value >= scrollState!!.maxValue - 2,
        )

        composeRule.onNode(hasSetTextAction())
            .performTextInputSelection(TextRange(0))
        composeRule.waitForIdle()
        assertEquals(
            "Moving back to the first soft-wrapped line must restore the top of the draft",
            0,
            scrollState!!.value,
        )
    }

    @OptIn(ExperimentalTestApi::class)
    private fun waitUntilTextIsDisplayed(
        expected: String,
        layoutProvider: () -> TextLayoutResult?,
    ) {
        composeRule.waitUntil(timeoutMillis = 5_000) {
            layoutProvider()?.layoutInput?.text?.text == expected
        }
    }

    @Composable
    private fun ComposerScrollProbe(
        value: String,
        onScrollState: (ScrollState) -> Unit,
        onTextLayout: (TextLayoutResult) -> Unit,
    ) {
        val rememberedScrollState = rememberScrollState()
        onScrollState(rememberedScrollState)
        RagentTheme {
            Box(
                modifier = Modifier
                    .width(320.dp)
                    .height(RagentSizes.ComposerMaxHeight),
            ) {
                MarkdownComposerEditor(
                    value = value,
                    onValueChange = {},
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(
                            min = RagentSizes.ComposerTextMinHeight,
                            max = RagentSizes.ComposerMaxHeight,
                        )
                        .padding(top = 12.dp, bottom = AgentoSpacing.Compact),
                    textStyle = TextStyle(
                        fontSize = 16.sp,
                        lineHeight = 27.5.sp,
                    ),
                    isDark = false,
                    scrollState = rememberedScrollState,
                    onTextLayout = onTextLayout,
                )
            }
        }
    }
}
