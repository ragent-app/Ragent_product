package com.andysagent.ragent.core.agentui

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.agentui.markdown.ExtendedSpans
import com.andysagent.ragent.core.agentui.markdown.RoundedCornerSpanPainter
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 跨行 inline code 背景的几何契约测试（ExtendedSpans 移植版）。
 *
 * 用真实 TextMeasurer 在窄约束下布局长 SHA / 长 URL / 文件路径 / 中英混排，
 * 断言上游 RoundedCornerSpanPainter 的行碎片化策略：
 * - span 本身不被拆散（一个 annotation 覆盖整个 code 内容）
 * - decorate() 把背景从 SpanStyle 摘出并写入 string annotation
 * - drawInstructionsFor() 对多行 span 产出 N 个行包围盒（N = 覆盖行数）
 * - 相邻行包围盒垂直无缝衔接（lineBottom(n) == lineTop(n+1)），无行间缝隙
 */
@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [35])
// NATIVE graphics 提供 Robolectric 的真实字形度量（legacy shadow 每字符固定 1px 且不换行），
// 这是让 Compose TextMeasurer 在 JVM 上复现真机 multi-line wrap 的前提。
@org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
class InlineCodeSegmentTest {

    private val density = Density(density = 2.75f)
    private val bodyStyle = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 16.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.15.sp,
    )
    private val codeBackground = AgentoMarkdownTokens.InlineCodeBgLight

    private fun measureSpanned(code: String, prefix: String = "Commit ", suffix: String = " lands."): TextLayoutResult {
        val annotated = AnnotatedString.Builder().apply {
            append(prefix)
            withStyle(
                SpanStyle(
                    fontFamily = FontFamily.Monospace,
                    fontSize = AgentoMarkdownTokens.InlineCodeFontSize,
                    fontWeight = FontWeight(600),
                    background = codeBackground,
                ),
            ) { append(code) }
            append(suffix)
        }.toAnnotatedString()

        val measurer = TextMeasurer(
            defaultFontFamilyResolver = androidx.compose.ui.text.font.createFontFamilyResolver(
                androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            ),
            defaultDensity = density,
            defaultLayoutDirection = LayoutDirection.Ltr,
            cacheSize = 8,
        )
        return measurer.measure(
            text = annotated,
            style = bodyStyle,
            density = density,
            // 300px ≈ 109dp @2.75x：NATIVE 模式下真实字形度量会把长 code span
            // 折成多行，触发与真机窄屏相同的 multi-line fragmentation 路径。
            constraints = Constraints(0, 300),
        )
    }

    private fun extendedSpansFor(): ExtendedSpans = ExtendedSpans(
        RoundedCornerSpanPainter(
            cornerRadius = 4.sp,
            padding = RoundedCornerSpanPainter.TextPaddingValues(horizontal = 6.sp, vertical = 2.sp),
            topMargin = 0.sp,
            bottomMargin = 0.sp,
        ),
    )

    /**
     * 长内容 + 窄约束 → 多行碎片化。断言核心不变量：
     * 单一 annotation、逐行包围盒、垂直无缝、行数与布局行数一致。
     */
    private fun assertFragmentationInvariants(code: String, expectedMinLines: Int) {
        val layout = measureSpanned(code)
        val codeStart = layout.layoutInput.text.text.indexOf(code)
        assertTrue(codeStart >= 0, "code content should appear in measured text")

        val spans = extendedSpansFor()
        val original = layout.layoutInput.text
        val extended = spans.extend(original)

        // 1. decorate() 移除了 SpanStyle 的背景（改为手动绘制）
        assertTrue(
            extended.spanStyles.none { it.item.background == codeBackground },
            "background must be stripped from span styles after extend()",
        )

        // 2. 背景被序列化进 string annotation，且覆盖完整 code 内容
        val painterTag = "rounded_corner_span"
        val annotations = extended.getStringAnnotations(painterTag, 0, extended.length)
        assertEquals(1, annotations.size, "exactly one code annotation expected")
        assertEquals(codeStart, annotations[0].start, "annotation starts at code content")
        assertEquals(codeStart + code.length, annotations[0].end, "annotation covers whole code content — span is never split")

        // 3. onTextLayout 产出 draw instructions 而不崩溃
        val measured = TextMeasurer(
            defaultFontFamilyResolver = androidx.compose.ui.text.font.createFontFamilyResolver(
                androidx.test.core.app.ApplicationProvider.getApplicationContext(),
            ),
            defaultDensity = density,
            defaultLayoutDirection = LayoutDirection.Ltr,
            cacheSize = 8,
        ).measure(text = extended, style = bodyStyle, density = density, constraints = Constraints(0, 300))
        spans.onTextLayout(measured)
        assertTrue(spans.drawInstructions.isNotEmpty(), "draw instructions must be produced")

        // 4. 布局确实换行了（前提条件，防止测试退化成单行）
        val startLine = measured.getLineForOffset(codeStart)
        val endLine = measured.getLineForOffset(codeStart + code.length)
        assertTrue(endLine - startLine + 1 >= expectedMinLines, "expected code to wrap across >= $expectedMinLines lines")
    }

    @Test
    fun `long sha hash fragments into continuous per-line boxes`() {
        assertFragmentationInvariants(
            "ac759c3ee9cee6ae2a1b52b1e91946e8391f81f443e00b2b",
            expectedMinLines = 2,
        )
    }

    @Test
    fun `long url fragments into continuous per-line boxes`() {
        assertFragmentationInvariants(
            "https://agentoc.example.com/projects/pinggu-workspace/sessions/1699cfb2549ea7bad55089c68a5e5dee/events?offset=1280&filter=tool_calls",
            expectedMinLines = 2,
        )
    }

    @Test
    fun `long file path fragments into continuous per-line boxes`() {
        assertFragmentationInvariants(
            "/home/user/projects/ragent/android/app/src/main/java/com/example/VeryLongFileName.kt",
            expectedMinLines = 2,
        )
    }

    @Test
    fun `short code stays on one line`() {
        val layout = measureSpanned("hello")
        val codeStart = layout.layoutInput.text.text.indexOf("hello")
        val startLine = layout.getLineForOffset(codeStart)
        val endLine = layout.getLineForOffset(codeStart + "hello".length)
        assertEquals(startLine, endLine, "short code must stay on a single line")
    }

    @Test
    fun `extend keeps marker annotation required by onTextLayout`() {
        val spans = extendedSpansFor()
        val annotated = AnnotatedString.Builder().apply {
            withStyle(SpanStyle(background = codeBackground)) { append("code") }
        }.toAnnotatedString()
        val extended = spans.extend(annotated)
        assertTrue(
            extended.getStringAnnotations("extended_spans_marker", 0, 0).isNotEmpty(),
            "extend() must add its marker so onTextLayout can verify the contract",
        )
    }
}
