package com.andysagent.ragent.core.agentui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-end Markdown contract for the native renderer.
 *
 * These tests pin the native block/inline behaviour against the shared
 * expectations recorded in `docs/markdown-rendering-contract.md` so the web
 * (GFM `marked`) and Android pipelines agree on the same message source.
 * Unsupported constructs must degrade to readable text — never silent loss.
 */
class AgentMarkdownContractTest {

    @Test
    fun `prose block alignment follows content while chrome retains app direction`() {
        val ltr = androidx.compose.ui.unit.LayoutDirection.Ltr
        val rtl = androidx.compose.ui.unit.LayoutDirection.Rtl
        for (source in listOf("中文内容。", "## English heading", "- 中文列表", "> English quote")) {
            assertEquals(ltr, markdownBlockDirection(parseBlocks(source).single(), rtl))
        }
        assertEquals(rtl, markdownBlockDirection(parseBlocks("- مرحبا بالعالم").single(), ltr))
        assertEquals(rtl, markdownBlockDirection(MarkdownBlock.Code(language = "kotlin", text = "println(1)"), rtl))
    }

    @Test
    fun `prose uses content direction without changing its typography`() {
        val source = RagentonversationTypography.Body
        val resolved = markdownProseStyle(source)
        assertEquals(androidx.compose.ui.text.style.TextDirection.Content, resolved.textDirection)
        assertEquals(source.fontSize, resolved.fontSize)
        assertEquals(source.lineHeight, resolved.lineHeight)
        assertEquals(source.fontWeight, resolved.fontWeight)
    }

    // ---------------------------------------------------------------- lists

    @Test
    fun `nested unordered lists keep their indent levels`() {
        val blocks = parseBlocks("- 一级\n  - 二级\n    - 三级")

        val list = blocks.single() as MarkdownBlock.ListBlock
        assertEquals(
            listOf(0, 1, 2),
            list.items.map { it.indentLevel },
        )
    }

    @Test
    fun `ordered list preserves its start number`() {
        val blocks = parseBlocks("3. 第三步\n4. 第四步")

        val list = blocks.single() as MarkdownBlock.ListBlock
        assertEquals(listOf(3, 4), list.items.map { (it as ListItem.Ordered).number })
    }

    @Test
    fun `task lists keep checked state for unordered and ordered markers`() {
        val blocks = parseBlocks("- [ ] 等待审批\n- [x] 已连接\n1. [ ] 检查")

        val list = blocks.single() as MarkdownBlock.ListBlock
        assertEquals(
            listOf(false, true, false),
            list.items.map { (it as ListItem.Task).checked },
        )
    }

    // ------------------------------------------------------------- headings

    @Test
    fun `atx headings map to their level`() {
        val blocks = parseBlocks("## 二级标题")

        assertEquals(MarkdownBlock.Heading(2, "二级标题"), blocks.single())
    }

    @Test
    fun `setext underline turns the previous paragraph into a heading`() {
        // Matches the web pipeline: marked renders "Title\n---" as <h2>.
        assertEquals(
            MarkdownBlock.Heading(2, "任务总览"),
            parseBlocks("任务总览\n---").single(),
        )
        assertEquals(
            MarkdownBlock.Heading(1, "任务总览"),
            parseBlocks("任务总览\n===").single(),
        )
    }

    @Test
    fun `thematic break after a blank line stays a divider`() {
        val blocks = parseBlocks("正文段落。\n\n---\n\n另一段。")

        assertEquals(
            listOf(
                MarkdownBlock.Paragraph("正文段落。"),
                MarkdownBlock.Divider,
                MarkdownBlock.Paragraph("另一段。"),
            ),
            blocks,
        )
    }

    // --------------------------------------------------------------- tables

    @Test
    fun `table cells keep escaped pipes as literal content`() {
        val blocks = parseBlocks(
            """
            | 表达式 | 说明 |
            | --- | --- |
            | a \| b | 竖线示例 |
            """.trimIndent(),
        )

        val table = blocks.single() as MarkdownBlock.Table
        assertEquals(listOf("表达式", "说明"), table.headers)
        assertEquals(listOf("a | b", "竖线示例"), table.rows.single())
    }

    @Test
    fun `table alignment markers map to column alignments`() {
        val blocks = parseBlocks(
            """
            | 左 | 中 | 右 |
            | :--- | :---: | ---: |
            | a | b | c |
            """.trimIndent(),
        )

        val table = blocks.single() as MarkdownBlock.Table
        assertEquals(
            listOf(TableAlignment.Left, TableAlignment.Center, TableAlignment.Right),
            table.alignments,
        )
    }

    // --------------------------------------------------------------- inline

    private fun inline(text: String) = buildAgentInlineMarkdown(
        text = text,
        style = RagentonversationTypography.Body,
        linkColor = Color.Blue,
        codeBackground = Color.LightGray,
        codeTextColor = Color.Black,
    )

    @Test
    fun `strikethrough renders as line-through without tildes`() {
        val annotated = inline("删除线 ~~旧方案~~ 保持可读")

        assertEquals("删除线 旧方案 保持可读", annotated.text)
        assertTrue(
            annotated.spanStyles.any {
                it.item.textDecoration == TextDecoration.LineThrough
            },
        )
    }

    @Test
    fun `bare urls become links`() {
        val annotated = inline("发布页 https://example.com/release 已上线")
        val urls = annotated.getLinkAnnotations(0, annotated.length)
            .mapNotNull { (it.item as? LinkAnnotation.Url)?.url }

        assertTrue(urls.any { it == "https://example.com/release" })
    }

    @Test
    fun `angle autolinks drop the brackets and keep the target`() {
        val annotated = inline("参考 <https://example.com/docs> 章节")

        assertEquals("参考 https://example.com/docs 章节", annotated.text)
        val urls = annotated.getLinkAnnotations(0, annotated.length)
            .mapNotNull { (it.item as? LinkAnnotation.Url)?.url }
        assertTrue(urls.contains("https://example.com/docs"))
    }

    @Test
    fun `inline links keep label and destination`() {
        val annotated = inline("[Ragent 文档](https://example.com/docs)")

        assertEquals("Ragent 文档", annotated.text)
        val urls = annotated.getLinkAnnotations(0, annotated.length)
            .mapNotNull { (it.item as? LinkAnnotation.Url)?.url }
        assertEquals(listOf("https://example.com/docs"), urls)
    }

    // ----------------------------------------------------- degradation policy

    @Test
    fun `images degrade to alt text linked to their destination`() {
        val annotated = inline("结果如下 ![架构图](https://example.com/a.png) 供参考")

        // Alt text survives as readable, linked content — never silent loss.
        assertEquals("结果如下 架构图 供参考", annotated.text)
        assertFalse(annotated.text.contains("!["))
        val urls = annotated.getLinkAnnotations(0, annotated.length)
            .mapNotNull { (it.item as? LinkAnnotation.Url)?.url }
        assertEquals(listOf("https://example.com/a.png"), urls)
    }

    @Test
    fun `images without alt text fall back to the destination`() {
        val annotated = inline("![](https://example.com/a.png)")

        assertEquals("https://example.com/a.png", annotated.text)
    }

    @Test
    fun `unresolved reference links keep their label visible`() {
        val annotated = inline("见 [附录][appendix] 说明")

        // Degradation: the label stays readable raw text; no fake link is
        // invented because the definition cannot be resolved.
        assertTrue(annotated.text.contains("附录"))
        val urls = annotated.getLinkAnnotations(0, annotated.length)
            .mapNotNull { (it.item as? LinkAnnotation.Url)?.url }
        assertTrue(urls.isEmpty())
    }

    // -------------------------------------------------------- reading corpus

    @Test
    fun `reading sample parses into the expected block mix`() {
        val blocks = parseBlocks(AgentMarkdownCorpus.readingSample)

        assertTrue(blocks.any { it is MarkdownBlock.Heading })
        assertTrue(blocks.any { it is MarkdownBlock.ListBlock })
        assertTrue(blocks.any { it is MarkdownBlock.Quote })
        assertTrue(blocks.any { it is MarkdownBlock.Code })
        val table = blocks.filterIsInstance<MarkdownBlock.Table>().single()
        assertTrue(table.headers.size >= 4, "reading sample keeps a wide table for scroll baselines")
        assertTrue(blocks.contains(MarkdownBlock.Divider))
    }

    @Test
    fun `message body weight baseline stays inside the approved band`() {
        val weight = RagentonversationTypography.MessageBodyWeight.weight
        // 400 (web parity) … 500 (heaviest approved reading weight).
        assertTrue(weight in 400..500, "body weight $weight outside approved 400..500 band")
        assertEquals(450, weight)
    }
}
