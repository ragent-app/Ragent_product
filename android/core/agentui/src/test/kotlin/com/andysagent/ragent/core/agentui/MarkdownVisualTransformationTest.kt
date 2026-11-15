package com.andysagent.ragent.core.agentui

import androidx.compose.ui.text.TextRange
import com.mohamedrejeb.richeditor.model.RichTextState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownVisualTransformationTest {

    @Test
    fun `inactive inline markdown renders without source delimiters`() {
        val result = RichTextState().setMarkdown("Plan **next steps** with `git status`.")

        assertEquals("Plan next steps with git status.", result.toText())
        assertTrue(result.annotatedString.spanStyles.isNotEmpty())
    }

    @Test
    fun `caret movement preserves markdown without restoring a second codec`() {
        val source = "Plan **next steps** today"
        val result = RichTextState().setMarkdown(source)
        result.selection = TextRange(result.toText().indexOf("steps"))

        assertEquals(source, result.toMarkdown())
        assertEquals("Plan next steps today", result.toText())
    }

    @Test
    fun `heading marker stays hidden outside the active line`() {
        val source = "## Implementation\nPlain paragraph"
        val result = RichTextState().setMarkdown(source)
        result.selection = TextRange(result.toText().length)

        assertTrue(result.toText().contains("Implementation"))
        assertTrue(result.toText().contains("Plain paragraph"))
        assertTrue(!result.toText().contains("##"))
    }

    @Test
    fun `lists and quotes render through the current rich editor`() {
        val source = "- first item\n\n> note"
        val result = RichTextState().setMarkdown(source)

        assertTrue(result.toText().contains("first item"))
        assertTrue(result.toText().contains("note"))
    }

    @Test
    fun `fenced code uses lossless literal fallback rather than discarding its body`() {
        val source = "- first item\n\n```kotlin\nval answer = 42\n```"
        assertTrue(composerRequiresLiteralMarkdown(source))
        val result = RichTextState().setText(source)
        assertEquals(source, result.toText())
        assertTrue(composerRequiresLiteralMarkdown("~~~\ncode\n~~~"))
        assertTrue(!composerRequiresLiteralMarkdown("Plan `git status`"))
    }
}
