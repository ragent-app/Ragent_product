package com.andysagent.ragent.core.agentui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AgentMarkdownTest {

    @Test
    fun `long user messages expose the disclosure control`() {
        assertTrue(shouldCollapseUserMessage("a".repeat(221)))
        assertTrue(shouldCollapseUserMessage("line\n".repeat(5)))
        assertTrue(shouldCollapseUserMessage("```kotlin\nprintln(\"hello\")\n```"))
        assertTrue(!shouldCollapseUserMessage("A short request."))
    }

    @Test
    fun `latest grapheme is tinted without changing the streaming text`() {
        val tinted = tintLatestGrapheme(AnnotatedString("Hi 👨‍👩‍👧‍👦"), Color.Gray)

        assertEquals("Hi 👨‍👩‍👧‍👦", tinted.text)
        assertTrue(tinted.spanStyles.any { style -> style.item.color == Color.Gray })
        val range = latestGraphemeRange(tinted.text)!!
        assertTrue(tinted.spanStyles.any { style -> style.start == range.first && style.end == range.last + 1 })
    }

    @Test
    fun `streaming reveal advances by grapheme and keeps emoji clusters intact`() {
        val text = "中👨‍👩‍👧‍👦👍🏽后"
        val ranges = streamingGraphemeRanges(text)

        assertEquals(4, ranges.size)
        assertEquals("中", revealStreamingText(text, 1))
        assertEquals("中👨‍👩‍👧‍👦", revealStreamingText(text, 2))
        assertEquals("中👨‍👩‍👧‍👦👍🏽", revealStreamingText(text, 3))
        assertEquals(text, revealStreamingText(text, 4))
        assertEquals(text, revealStreamingText(text, 99))
    }

    @Test
    fun `streaming presentation clock starts gently and caps burst catch up`() {
        val clock = StreamingPresentationClock()

        assertEquals(1, clock.advance(currentCount = 0, targetCount = 100, elapsedMs = 0))
        assertEquals(2, clock.advance(currentCount = 1, targetCount = 100, elapsedMs = 16))
        assertEquals(4, clock.advance(currentCount = 3, targetCount = 100, elapsedMs = 16))
    }

    @Test
    fun `streaming presentation clock never moves backwards when target shrinks`() {
        val clock = StreamingPresentationClock()

        assertEquals(4, clock.advance(currentCount = 4, targetCount = 2, elapsedMs = 16))
        assertEquals(0, clock.advance(currentCount = 0, targetCount = 0, elapsedMs = 16))
    }

    @Test
    fun `parseBlocks extracts headings with appropriate level`() {
        val markdown = """
            # Heading 1
            ## Heading 2
            ### Heading 3
            #### Heading 4
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(4, blocks.size)
        assertEquals(MarkdownBlock.Heading(1, "Heading 1"), blocks[0])
        assertEquals(MarkdownBlock.Heading(2, "Heading 2"), blocks[1])
        assertEquals(MarkdownBlock.Heading(3, "Heading 3"), blocks[2])
        assertEquals(MarkdownBlock.Heading(4, "Heading 4"), blocks[3])
    }

    @Test
    fun `parseBlocks handles code blocks with language`() {
        val markdown = """
            ```kotlin
            suspend fun connect() {
                client.connect()
            }
            ```
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Code)
        val codeBlock = blocks[0] as MarkdownBlock.Code
        assertEquals("kotlin", codeBlock.language)
        assertEquals("suspend fun connect() {\n    client.connect()\n}", codeBlock.text)
    }

    @Test
    fun `code language labels normalize aliases and plain text`() {
        assertEquals("javascript", normalizedCodeLanguage("js"))
        assertEquals("powershell", normalizedCodeLanguage("ps1"))
        assertEquals("text", normalizedCodeLanguage(""))
        assertEquals("JavaScript", displayCodeLanguage("js"))
        assertEquals("PowerShell", displayCodeLanguage("pwsh"))
        assertEquals("Plain text", displayCodeLanguage(null))
    }

    @Test
    fun `parseBlocks keeps an unfinished streaming fence as a code block`() {
        val blocks = parseBlocks(
            """
            ## Working draft

            ```kotlin
            val state = stream.collect()
            """.trimIndent(),
        )

        assertEquals(MarkdownBlock.Heading(2, "Working draft"), blocks.first())
        val code = blocks.last() as MarkdownBlock.Code
        assertEquals("kotlin", code.language)
        assertEquals("val state = stream.collect()", code.text)
    }

    @Test
    fun `parseBlocks handles quotes and dividers`() {
        val markdown = """
            > This is a quote
            > with multiple lines

            ---

            Another paragraph.
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(3, blocks.size)
        assertEquals(MarkdownBlock.Quote("This is a quote\nwith multiple lines"), blocks[0])
        assertEquals(MarkdownBlock.Divider, blocks[1])
        assertEquals(MarkdownBlock.Paragraph("Another paragraph."), blocks[2])
    }

    @Test
    fun `single newlines stay visible inside a markdown paragraph`() {
        val source = "First line\n**Second line** with `healthz`"
        val blocks = parseBlocks(source)

        assertEquals(listOf(MarkdownBlock.Paragraph(source)), blocks)
        val annotated = buildAgentInlineMarkdown(
            text = (blocks.single() as MarkdownBlock.Paragraph).text,
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )
        assertEquals("First line\nSecond line with healthz", annotated.text)
        assertTrue(annotated.spanStyles.isNotEmpty())
    }

    @Test
    fun `parseBlocks handles unordered, ordered and task lists`() {
        val markdown = """
            - Item 1
            - Item 2
              - Nested item

            1. First step
            2. Second step

            - [ ] Pending task
            - [x] Completed task
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(3, blocks.size)

        val list1 = blocks[0] as MarkdownBlock.ListBlock
        assertEquals(3, list1.items.size)
        assertEquals(ListItem.Unordered("Item 1", 0), list1.items[0])
        assertEquals(ListItem.Unordered("Item 2", 0), list1.items[1])
        assertEquals(ListItem.Unordered("Nested item", 1), list1.items[2])

        val list2 = blocks[1] as MarkdownBlock.ListBlock
        assertEquals(2, list2.items.size)
        assertEquals(ListItem.Ordered(1, "First step", 0), list2.items[0])
        assertEquals(ListItem.Ordered(2, "Second step", 0), list2.items[1])

        val list3 = blocks[2] as MarkdownBlock.ListBlock
        assertEquals(2, list3.items.size)
        assertEquals(ListItem.Task(false, "Pending task", 0), list3.items[0])
        assertEquals(ListItem.Task(true, "Completed task", 0), list3.items[1])
    }

    @Test
    fun `parseBlocks handles tables`() {
        val markdown = """
            | Name | Status | Time |
            | --- | --- | --- |
            | Auth | Done | 21 ms |
            | Network | Failed | 84 ms |
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Table)
        val table = blocks[0] as MarkdownBlock.Table
        assertEquals(listOf("Name", "Status", "Time"), table.headers)
        assertEquals(2, table.rows.size)
        assertEquals(listOf("Auth", "Done", "21 ms"), table.rows[0])
        assertEquals(listOf("Network", "Failed", "84 ms"), table.rows[1])
    }

    @Test
    fun `parseBlocks handles tables with alignment indicators`() {
        val markdown = """
            | Item | Alignment | Value |
            | :--- | :---: | ---: |
            | A | Centered | $100 |
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        val table = blocks[0] as MarkdownBlock.Table
        assertEquals(listOf("Item", "Alignment", "Value"), table.headers)
        assertEquals(listOf(TableAlignment.Left, TableAlignment.Center, TableAlignment.Right), table.alignments)
    }

    @Test
    fun `highlightCode highlights Kotlin, Python, JSON, and Diff`() {
        val kotlinCode = "class App(val name: String) {\n    fun run() = println(name)\n}"
        val kotlinAnnotated = highlightCode(kotlinCode, "kotlin", isDark = true)
        assertTrue(kotlinAnnotated.spanStyles.isNotEmpty())

        val pythonCode = "def fetch_data(url: str) -> dict:\n    return {\"status\": \"ok\", \"count\": 42}"
        val pythonAnnotated = highlightCode(pythonCode, "python", isDark = true)
        assertTrue(pythonAnnotated.spanStyles.isNotEmpty())

        val powershellAnnotated = highlightCode("New-Item -Path \$target", "ps1", isDark = true)
        assertTrue(powershellAnnotated.spanStyles.isNotEmpty())

        val diffCode = "--- old.kt\n+++ new.kt\n@@ -1,2 +1,2 @@\n-val x = 1\n+val x = 2"
        val diffAnnotated = highlightCode(diffCode, "diff", isDark = true)
        assertTrue(diffAnnotated.spanStyles.isNotEmpty())
    }

    @Test
    fun `plain text code blocks keep their source unstyled`() {
        val plain = highlightCode("true // leave this alone", "text", isDark = true)

        assertEquals("true // leave this alone", plain.text)
        assertTrue(plain.spanStyles.isEmpty())
    }

    @Test
    fun `inline markdown processes bold, italic, code, and links`() {
        val annotated = buildAgentInlineMarkdown(
            text = "Check **bold** and *italic* and `inlineCode()` and [Link](https://example.com)",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )

        assertEquals("Check bold and inlineCode() and Link", annotated.text.replace("bold and italic and", "bold and"))
        assertTrue(annotated.spanStyles.isNotEmpty())
        // Upstream code spans carry a background span (later moved into the
        // ExtendedSpans painter), so assert via span styles instead of the old tag.
        assertTrue(annotated.spanStyles.any { it.item.background == Color.LightGray })
        assertTrue(annotated.getLinkAnnotations(0, annotated.length).isNotEmpty())
    }

    @Test
    fun `inline markdown does not parse single or double quotes as code`() {
        val annotated = buildAgentInlineMarkdown(
            text = "This is 'regular quotes' and ‘中文引号’ while `realCode()` is code.",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )

        val codeSpans = annotated.spanStyles.filter { it.item.background == Color.LightGray }
        assertEquals(1, codeSpans.size)
        assertTrue(annotated.text.contains("realCode()"))
    }

    @Test
    fun `inline markdown unclosed backtick during streaming stays bounded`() {
        // Streaming mid-token: a single unclosed backtick must render literally
        // (no span, no crash) until its closer arrives.
        val single = buildAgentInlineMarkdown(
            text = "代码如下：`val x = 1",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )
        assertEquals(0, single.spanStyles.count { it.item.background == Color.LightGray })
        assertTrue(single.text.contains("val x = 1"))

        // Two backticks on separate lines form one CommonMark code span:
        // `unclosed backtick\nLine 2 with ` — the closer is the backtick
        // after "with " on line 2, so the span crosses the line boundary.
        // Upstream behaviour, distinct from the old homegrown line-local
        // parser; the span stays one annotation so ExtendedSpans handles the
        // wrapped lines at draw time.
        val pair = buildAgentInlineMarkdown(
            text = "Line 1 with `unclosed backtick\nLine 2 with `validCode` here",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )
        val codeSpans = pair.spanStyles.filter { it.item.background == Color.LightGray }
        assertEquals(1, codeSpans.size)
        val spanText = pair.text.substring(codeSpans[0].start, codeSpans[0].end)
        assertTrue(spanText.contains("unclosed backtick"))
        assertTrue(spanText.contains("Line 2 with"))
        // Line-fragmentation prerequisite: the span's start and end offsets
        // straddle the newline (offset 35 in this input).
        assertTrue(codeSpans[0].start < 35 && codeSpans[0].end > 35)
    }

    @Test
    fun `inline markdown long sha hash wraps as single continuous span`() {
        val sha = "ac759c3ee9cee6ae2a1b52b1e91946e8391f81f443e00b2b"
        val annotated = buildAgentInlineMarkdown(
            text = "强密码：`$sha`",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )

        val codeSpans = annotated.spanStyles.filter { it.item.background == Color.LightGray }
        assertEquals(1, codeSpans.size)
        // The full hash is one contiguous span — line fragmentation is done at
        // draw time via ExtendedSpans, never by splitting the span itself.
        assertEquals(sha, annotated.text.substring(codeSpans[0].start, codeSpans[0].end).trim())
    }

    @Test
    fun `inline markdown long file path stays single span`() {
        val path = "/home/user/projects/ragent/android/app/src/main/java/com/example/VeryLongFileName.kt"
        val annotated = buildAgentInlineMarkdown(
            text = "路径：`$path` 已更新。",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )

        val codeSpans = annotated.spanStyles.filter { it.item.background == Color.LightGray }
        assertEquals(1, codeSpans.size)
        assertTrue(annotated.text.substring(codeSpans[0].start, codeSpans[0].end).contains("VeryLongFileName.kt"))
    }

    @Test
    fun `inline markdown mixed chinese and english with code`() {
        val annotated = buildAgentInlineMarkdown(
            text = "当 `StreamingAccumulator.consume(token)` 在长中文段落中间被换行切断时，背景条带必须保持连续。",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )

        val codeSpans = annotated.spanStyles.filter { it.item.background == Color.LightGray }
        assertEquals(1, codeSpans.size)
        assertTrue(annotated.text.contains("背景条带必须保持连续。"))
    }

    @Test
    fun `parseBlocks handles mermaid and flowchart diagram blocks`() {
        val markdown = """
            ```mermaid
            graph TD
            A[Start] --> B[Process]
            B --> C[Done]
            ```
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Diagram)
        val diagram = blocks[0] as MarkdownBlock.Diagram
        assertEquals("mermaid", diagram.diagramType)
        assertTrue(diagram.source.contains("A[Start] --> B[Process]"))
    }

    @Test
    fun `parseBlocks handles katex block and inline math`() {
        val markdown = """
            $$
            f(x) = \alpha x^2 + \beta x + \gamma
            $$
        """.trimIndent()

        val blocks = parseBlocks(markdown)
        assertEquals(1, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Math)
        val math = blocks[0] as MarkdownBlock.Math
        assertTrue(math.formula.contains("\\alpha"))

        val inlineAnnotated = buildAgentInlineMarkdown(
            text = "Formula: ${'$'}\\alpha + \\beta^2${'$'} is computed.",
            style = RagentonversationTypography.Body,
            linkColor = Color.Blue,
            codeBackground = Color.LightGray,
            codeTextColor = Color.Black,
        )
        assertTrue(inlineAnnotated.text.contains("α + β²"))
    }

    @Test
    fun `streaming syntax guard closes only unfinished markdown outside code`() {
        assertEquals("**draft**", autoCloseMarkdownSyntax("**draft"))

        val unfinishedCode = autoCloseMarkdownSyntax(
            "```kotlin\nval literal = \"**not bold**\"",
        )
        assertTrue(unfinishedCode.endsWith("\n```"))
        assertTrue(unfinishedCode.contains("**not bold**"))
    }

    @Test
    fun `markdown tokens keep comfortable chat reading rhythm`() {
        assertEquals(20f, AgentoMarkdownTokens.H1FontSize.value)
        assertEquals(28f, AgentoMarkdownTokens.H1LineHeight.value)
        assertEquals(18f, AgentoMarkdownTokens.H2FontSize.value)
        assertEquals(16f, AgentoMarkdownTokens.BodyFontSize.value)
        assertEquals(25f, AgentoMarkdownTokens.BodyLineHeight.value)
        assertEquals(0f, AgentoMarkdownTokens.BodyLetterSpacing.value)
        assertEquals(0f, AgentoMarkdownTokens.H1LetterSpacing.value)
        assertEquals(0f, AgentoMarkdownTokens.H2LetterSpacing.value)
        assertEquals(24f, AgentoMarkdownTokens.InlineCodeLineHeight.value)
        assertEquals(3f, AgentoMarkdownTokens.InlineCodeHPadding.value)
        assertEquals(12f, AgentoMarkdownTokens.ParagraphToParagraph.value)
        assertEquals(4f, AgentoMarkdownTokens.ListItemToListItem.value)
        assertEquals(4f, AgentoMarkdownTokens.HeadingToNestedHeading.value)
    }

    @Test
    fun `latestGraphemeRange matches streamingGraphemeRanges lastOrNull in O(1)`() {
        val samples = listOf(
            "",
            "a",
            "hello world!",
            "你好，世界。",
            "e\u0301",
            "👍🏽",
            "👨‍👩‍👧‍👦",
            "🇺🇸",
            "flag 🇺🇸🇯🇵 end",
            "text 👨‍👩‍👧 middle 👍🏽!",
        )
        for (sample in samples) {
            assertEquals(
                streamingGraphemeRanges(sample).lastOrNull(),
                latestGraphemeRange(sample),
                "Mismatch for sample: $sample",
            )
        }
    }
}
