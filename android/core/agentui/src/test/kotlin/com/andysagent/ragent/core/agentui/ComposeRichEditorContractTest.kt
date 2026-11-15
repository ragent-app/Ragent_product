package com.andysagent.ragent.core.agentui

import com.mohamedrejeb.richeditor.model.RichTextState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Contract tests for the open-source Compose Rich Editor boundary.
 *
 * Markdown parsing, rich-text state, selection/IME editing, and serialization
 * belong to Compose Rich Editor. Ragent must not grow a second codec beside
 * it; these tests therefore exercise the library state directly instead of
 * testing a local parser or visual transformation.
 */
class ComposeRichEditorContractTest {

    @Test
    fun richEditorParsesInlineMarkdownAndSerializesItBack() {
        val code = "\u0060git status\u0060"
        val source = "Plan **next steps** with $code and ~~obsolete~~."
        val state = RichTextState().setMarkdown(source)

        assertEquals("Plan next steps with git status and obsolete.", state.toText())
        assertEquals(source, state.toMarkdown())
    }

    @Test
    fun richEditorPreservesBlockMarkdownSemantics() {
        val source = "## Delivery plan\n\n- verify **healthz**\n- review [the logs](https://example.com/logs)"
        val state = RichTextState().setMarkdown(source)
        val serialized = state.toMarkdown()

        assertTrue(serialized.contains("## Delivery plan"))
        assertTrue(serialized.contains("verify **healthz**"))
        assertTrue(serialized.contains("[the logs](https://example.com/logs)"))
        assertTrue(state.toText().contains("Delivery plan"))
        assertTrue(state.toText().contains("verify healthz"))
        assertTrue(state.toText().contains("review the logs"))
    }

    @Test
    fun richEditorExposesFormattedTextWithoutMarkdownDelimiters() {
        val state = RichTextState().setMarkdown("Before **bold** after")

        assertEquals("Before bold after", state.toText())
        assertTrue(state.annotatedString.text.contains("Before bold after"))
        assertTrue(state.toMarkdown().contains("**bold**"))
    }

    @Test
    fun richEditorCanReplaceSelectedContentThroughItsEditingState() {
        val state = RichTextState().setMarkdown("Draft **bold**")
        val start = state.toText().indexOf("bold")
        val end = start + "bold".length

        state.selection = androidx.compose.ui.text.TextRange(start, end)
        state.replaceSelectedText("updated")

        assertEquals("Draft updated", state.toText())
        assertEquals("Draft updated", state.toMarkdown())
    }
}
