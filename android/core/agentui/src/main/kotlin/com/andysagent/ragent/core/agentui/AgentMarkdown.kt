package com.andysagent.ragent.core.agentui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.key
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentColors
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.agentoAmbientShadow
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.agentui.markdown.AgentMarkdownAnnotatorSettings
import com.andysagent.ragent.core.agentui.markdown.ExtendedSpans
import com.andysagent.ragent.core.agentui.markdown.RoundedCornerSpanPainter
import com.andysagent.ragent.core.agentui.markdown.buildMarkdownAnnotatedString
import com.andysagent.ragent.core.agentui.markdown.drawBehind
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.BreakIterator
import java.util.Locale

/**
 * Ragent Markdown 主题色阶与垂直节奏标尺规范定义 (AgentoMarkdownTheme v2)
 */
object AgentoMarkdownTokens {
    // Conversation prose should read as a document, not a dense status feed.
    // This is deliberately close to the platform chat reading scale while
    // retaining the shorter line length of a phone conversation column.
    val BodyFontSize = 16.sp
    val BodyLineHeight = 25.sp
    val BodyLetterSpacing = 0.sp

    val H1FontSize = 20.sp
    val H1LineHeight = 28.sp
    val H1LetterSpacing = 0.sp

    val H2FontSize = 18.sp
    val H2LineHeight = 25.sp
    val H2LetterSpacing = 0.sp

    val H3FontSize = 16.sp
    val H3LineHeight = 23.sp
    val H3LetterSpacing = 0.sp

    val H4FontSize = 15.sp
    val H4LineHeight = 22.sp
    val H4LetterSpacing = 0.sp

    val CodeFontSize = 13.sp
    val CodeLineHeight = 20.sp

    val InlineCodeFontSize = 13.sp
    val InlineCodeLineHeight = 24.sp

    // Zero-outline inline code: the text layout owns the line box.
    val InlineCodeRadius = 3.dp
    val InlineCodeHPadding = 3.dp
    val InlineCodeTopMargin = 0.sp
    val InlineCodeBottomMargin = 0.sp

    val InlineCodeBgLight = Color(0x0A000000)
    val InlineCodeBgDark = Color(0x12FFFFFF)
    val InlineCodeStrokeLight = Color(0x14000000)
    val InlineCodeStrokeDark = Color(0x1FFFFFFF)
    val InlineCodeTextLight = Color(0xFF1F2328)
    val InlineCodeTextDark = Color(0xFFE6EDF3)

    val BlockquoteFontSize = 15.sp
    val BlockquoteLineHeight = 23.sp

    val TableFontSize = 13.5.sp
    val TableLineHeight = 19.sp

    // Vertical Rhythm 亲密性垂直间距标尺 (dp)
    val ParagraphToParagraph = 12.dp
    val ParagraphToH1 = 22.dp
    val ParagraphToH2 = 18.dp
    val ParagraphToH3 = 16.dp
    val ParagraphToH4 = 14.dp
    val H1ToParagraph = 6.dp
    val H2ToParagraph = 5.dp
    val H3ToParagraph = 4.dp
    val HeadingToParagraph = 4.dp
    val HeadingToNestedHeading = 4.dp
    val ParagraphToList = 8.dp
    val ListItemToListItem = 4.dp
    val ListToParagraph = 12.dp
    val ParagraphToCodeBlock = 12.dp
    val CodeBlockToParagraph = 12.dp
    val CodeBlockToCodeBlock = 10.dp
    val ParagraphToBlockquote = 10.dp
    val BlockquoteToParagraph = 12.dp
    val ParagraphToTable = 12.dp
    val TableToParagraph = 12.dp
    val DividerVertical = 16.dp
    val ListIndentStep = 20.dp
    val ListMarkerWidth = 20.dp
    val ListMarkerGap = 4.dp
    val listBulletSize = 4.dp
}

/**
 * Ambient reading weight for message-body markdown. Defaults to the
 * design-system baseline; screenshot baselines override it to compare
 * candidate weights (400/450/500) without touching production styles.
 */
val LocalAgentMarkdownBodyWeight = staticCompositionLocalOf {
    RagentonversationTypography.MessageBodyWeight
}

@Composable
private fun markdownBodyStyle(): TextStyle = RagentonversationTypography.Body.copy(
    fontWeight = LocalAgentMarkdownBodyWeight.current,
    fontSize = AgentoMarkdownTokens.BodyFontSize,
    lineHeight = AgentoMarkdownTokens.BodyLineHeight,
    letterSpacing = AgentoMarkdownTokens.BodyLetterSpacing,
)

@Composable
private fun markdownListStyle(): TextStyle = RagentonversationTypography.ListItem.copy(
    fontWeight = LocalAgentMarkdownBodyWeight.current,
    fontSize = AgentoMarkdownTokens.BodyFontSize,
    lineHeight = AgentoMarkdownTokens.BodyLineHeight,
    letterSpacing = AgentoMarkdownTokens.BodyLetterSpacing,
)

@Composable
private fun markdownQuoteStyle(): TextStyle = RagentonversationTypography.Blockquote.copy(
    fontWeight = LocalAgentMarkdownBodyWeight.current,
)

@Composable
private fun markdownTableCellStyle(): TextStyle = RagentonversationTypography.TableCell.copy(
    fontWeight = LocalAgentMarkdownBodyWeight.current,
)

private data class MarkdownHeadingSpec(
    val fontSize: androidx.compose.ui.unit.TextUnit,
    val lineHeight: androidx.compose.ui.unit.TextUnit,
    val letterSpacing: androidx.compose.ui.unit.TextUnit,
    val weight: FontWeight,
)

private fun markdownHeadingStyle(level: Int): TextStyle {
    val source = when (level) {
        1 -> RagentonversationTypography.Heading1
        2 -> RagentonversationTypography.Heading2
        3 -> RagentonversationTypography.Heading3
        4 -> RagentonversationTypography.Heading4
        5 -> RagentonversationTypography.Heading5
        6 -> RagentonversationTypography.Heading6
        else -> RagentonversationTypography.Heading3
    }
    val spec = when (level) {
        1 -> MarkdownHeadingSpec(AgentoMarkdownTokens.H1FontSize, AgentoMarkdownTokens.H1LineHeight, AgentoMarkdownTokens.H1LetterSpacing, FontWeight(600))
        2 -> MarkdownHeadingSpec(AgentoMarkdownTokens.H2FontSize, AgentoMarkdownTokens.H2LineHeight, AgentoMarkdownTokens.H2LetterSpacing, FontWeight(600))
        3 -> MarkdownHeadingSpec(AgentoMarkdownTokens.H3FontSize, AgentoMarkdownTokens.H3LineHeight, AgentoMarkdownTokens.H3LetterSpacing, FontWeight(600))
        4 -> MarkdownHeadingSpec(AgentoMarkdownTokens.H4FontSize, AgentoMarkdownTokens.H4LineHeight, AgentoMarkdownTokens.H4LetterSpacing, FontWeight(600))
        5 -> MarkdownHeadingSpec(14.5.sp, 21.sp, 0.sp, FontWeight(550))
        else -> MarkdownHeadingSpec(13.5.sp, 20.sp, 0.sp, FontWeight(550))
    }
    return source.copy(
        fontSize = spec.fontSize,
        lineHeight = spec.lineHeight,
        letterSpacing = spec.letterSpacing,
        fontWeight = spec.weight,
    )
}

private val markdownBlockCache = object : androidx.collection.LruCache<String, List<MarkdownBlock>>(300) {}
private val markdownBlockCacheLock = Any()

fun parseBlocksFast(source: String): List<MarkdownBlock> {
    synchronized(markdownBlockCacheLock) {
        markdownBlockCache.get(source)?.let { return it }
    }
    val parsed = parseBlocks(source)
    synchronized(markdownBlockCacheLock) {
        markdownBlockCache.put(source, parsed)
    }
    return parsed
}

/**
 * Makes an in-flight response render as its eventual Markdown shape. Only
 * syntax outside an open code fence is repaired, so code content containing
 * asterisks remains literal while it streams.
 */
fun autoCloseMarkdownSyntax(raw: String): String {
    if (raw.isEmpty()) return raw

    var insideFence = false
    var boldMarkers = 0
    raw.replace("\r\n", "\n").lines().forEach { line ->
        if (line.trimStart().startsWith("```")) {
            insideFence = !insideFence
            return@forEach
        }
        if (!insideFence) {
            var index = 0
            while (index < line.length - 1) {
                if (line[index] == '*' && line[index + 1] == '*' &&
                    (index == 0 || line[index - 1] != '\\')
                ) {
                    boldMarkers += 1
                    index += 2
                } else {
                    index += 1
                }
            }
        }
    }

    var closed = raw
    if (insideFence) {
        closed += if (closed.endsWith("\n")) "```" else "\n```"
    }
    if (boldMarkers % 2 != 0) closed += "**"
    return closed
}

/**
 * Native Markdown renderer for Ragent Agent timeline stream.
 *
 * AgentoMarkdownTheme v2 核心设计架构：
 * 1. Chat-Native Scale: 标题克制，H1 最大 20sp，融入对话流
 * 2. Zero-Outline & Low-Alpha Tonality: 依靠背景色明度差分层，消除 1dp 硬线
 * 3. Semantic Proximity Rhythm: 同组内容紧凑，章节之间再拉开层次
 * 4. CJK / Latin / Code Baseline Lock: 正文行高锁定 24sp，消除混排垂直抖动
 */
private val liveMarkdownTrigger = Regex(
    """(?:`|\*\*|__|~~|!\[|]\(|\||^#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>\s?|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$|<[a-z/][^>]*>)""",
    setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE),
)

@Composable
fun AgentMarkdown(
    markdown: String,
    modifier: Modifier = Modifier,
    isStreaming: Boolean = false,
    latestGraphemeColor: Color? = null,
) {
    // Match the Web renderer: ordinary live prose paints directly. Parsing the
    // entire growing document on every delta delays otherwise available text.
    val plainLiveText = isStreaming && !liveMarkdownTrigger.containsMatchIn(markdown)
    if (plainLiveText) {
        Text(
            text = markdown,
            style = markdownBodyStyle(),
            color = LocalRagentColors.current.primaryContent,
            modifier = modifier.fillMaxWidth(),
        )
        return
    }
    val source = remember(markdown, isStreaming) {
        if (isStreaming) autoCloseMarkdownSyntax(markdown) else markdown
    }
    val prepared = LocalPreparedMarkdownDocuments.current[source]
    val cached = remember(source, prepared) {
        prepared ?: synchronized(markdownBlockCacheLock) { markdownBlockCache.get(source) }
    }
    // Entry prepares loaded history off-thread. A standalone/cold first
    // document still has an immediate initial paint; subsequent provider
    // updates must not parse the full body in the composition/measure path.
    var document by remember { mutableStateOf(cached ?: parseBlocksFast(source)) }
    var documentSource by remember { mutableStateOf(source) }
    SideEffect {
        if (cached != null && documentSource != source) {
            // Record the actually painted cache hit before another update can
            // need it as its retained body while preparing a cache miss.
            document = cached
            documentSource = source
        }
    }
    val latestParseRequest = rememberUpdatedState(source to cached)
    LaunchedEffect(Unit) {
        // Finish the current parse before consuming the latest request. A
        // parser cancelled on every token can starve the visible document.
        snapshotFlow { latestParseRequest.value }.collect { (requestedSource, preparedBlocks) ->
          if (documentSource != requestedSource) {
            val next = preparedBlocks ?: withContext(Dispatchers.Default) { parseBlocksFast(requestedSource) }
            document = next.mapIndexed { index, block ->
                document.getOrNull(index)?.takeIf { it == block } ?: block
            }
            documentSource = requestedSource
          }
        }
    }
    val blocks = cached ?: document
    MarkdownBlockRenderer(
        blocks = blocks,
        isStreaming = isStreaming,
        latestGraphemeColor = latestGraphemeColor,
        modifier = modifier,
    )
}

/** Returns the UTF-16 range of the last user-perceived character in O(1) from the tail. */
fun latestGraphemeRange(text: String): IntRange? {
    if (text.isEmpty()) return null
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
    iterator.setText(text)
    val end = iterator.last()
    var start = iterator.previous()
    if (start == BreakIterator.DONE) return null
    while (start > 0) {
        if (!shouldJoinGrapheme(text, start, start)) break
        val previousStart = iterator.previous()
        if (previousStart == BreakIterator.DONE) break
        start = previousStart
    }
    return if (end > start) start until end else null
}

/**
 * Returns grapheme ranges as UTF-16 offsets. Android's text stack uses UTF-16
 * indices, while a stream must advance by user-perceived characters rather
 * than by code units. BreakIterator supplies the locale-aware boundaries;
 * the small join pass keeps ZWJ emoji, modifiers, variation selectors, and
 * combining marks together on API levels whose iterator is more conservative.
 */
fun streamingGraphemeRanges(text: String): List<IntRange> {
    if (text.isEmpty()) return emptyList()
    val iterator = BreakIterator.getCharacterInstance(Locale.ROOT)
    iterator.setText(text)
    val raw = buildList {
        var start = iterator.first()
        while (start != BreakIterator.DONE) {
            val end = iterator.next()
            if (end == BreakIterator.DONE) break
            if (end > start) add(start until end)
            start = end
        }
    }
    if (raw.isEmpty()) return emptyList()

    val merged = mutableListOf<IntRange>()
    raw.forEach { range ->
        val previous = merged.lastOrNull()
        if (previous != null && shouldJoinGrapheme(text, previous.last + 1, range.first)) {
            merged[merged.lastIndex] = previous.first until (range.last + 1)
        } else {
            merged += range
        }
    }
    return merged
}

private fun shouldJoinGrapheme(text: String, previousEnd: Int, currentStart: Int): Boolean {
    if (previousEnd <= 0 || currentStart >= text.length || previousEnd > text.length) return false
    val current = text.codePointAt(currentStart)
    val previous = text.codePointBefore(previousEnd)
    if (current == 0x200D || previous == 0x200D) return true
    if (current in 0xFE00..0xFE0F || current in 0xE0100..0xE01EF) return true
    if (current in 0x1F3FB..0x1F3FF) return true
    val currentType = Character.getType(current)
    if (currentType == Character.NON_SPACING_MARK.toInt()
        || currentType == Character.COMBINING_SPACING_MARK.toInt()
        || currentType == Character.ENCLOSING_MARK.toInt()
    ) return true

    // Regional indicators form flags in pairs. BreakIterator may expose the
    // pair as two characters on older Android releases.
    if (isRegionalIndicator(previous) && isRegionalIndicator(current)) {
        var cursor = previousEnd
        var count = 1
        while (cursor > 0) {
            val codePoint = text.codePointBefore(cursor)
            if (!isRegionalIndicator(codePoint)) break
            count += 1
            cursor -= Character.charCount(codePoint)
        }
        return count % 2 == 1
    }
    return false
}

private fun isRegionalIndicator(codePoint: Int): Boolean = codePoint in 0x1F1E6..0x1F1FF

/** Returns the prefix containing at most [graphemeCount] user-perceived characters. */
fun revealStreamingText(text: String, graphemeCount: Int): String {
    return revealStreamingText(text, graphemeCount, streamingGraphemeRanges(text))
}

/** Reveals text using boundaries already computed for the current target. */
fun revealStreamingText(text: String, graphemeCount: Int, ranges: List<IntRange>): String {
    if (graphemeCount <= 0 || text.isEmpty()) return ""
    val range = ranges.getOrNull(graphemeCount - 1) ?: return text
    return text.substring(0, range.last + 1)
}

/** Applies the streaming frontier color without changing the message text. */
fun tintLatestGrapheme(annotated: AnnotatedString, color: Color): AnnotatedString {
    val range = latestGraphemeRange(annotated.text) ?: return annotated
    return AnnotatedString.Builder(annotated).apply {
        addStyle(SpanStyle(color = color), range.first, range.last + 1)
    }.toAnnotatedString()
}

/**
 * Markdown 后台异步解析与富文本渲染组件
 * 在流式结束或长文本时使用，防止主线程 AST 解析卡顿
 */
@Composable
fun FinalizedMarkdownMessage(
    rawMarkdown: String,
    modifier: Modifier = Modifier,
) {
    AgentMarkdown(markdown = rawMarkdown, modifier = modifier)

}

/**
 * 根据格式塔亲密性原则计算块级元素转移垂直间距
 */
fun calculateBlockSpacing(current: MarkdownBlock, next: MarkdownBlock?): Dp {
    if (next == null) return 0.dp
    return when (current) {
        is MarkdownBlock.Heading -> {
            when (next) {
                is MarkdownBlock.Heading -> AgentoMarkdownTokens.HeadingToNestedHeading
                else -> when (current.level) {
                    1 -> AgentoMarkdownTokens.H1ToParagraph
                    2 -> AgentoMarkdownTokens.H2ToParagraph
                    3 -> AgentoMarkdownTokens.H3ToParagraph
                    else -> AgentoMarkdownTokens.HeadingToParagraph
                }
            }
        }
        is MarkdownBlock.Paragraph -> {
            when (next) {
                is MarkdownBlock.Heading -> when (next.level) {
                    1 -> AgentoMarkdownTokens.ParagraphToH1
                    2 -> AgentoMarkdownTokens.ParagraphToH2
                    3 -> AgentoMarkdownTokens.ParagraphToH3
                    4 -> AgentoMarkdownTokens.ParagraphToH4
                    else -> AgentoMarkdownTokens.ParagraphToH4
                }
                is MarkdownBlock.Paragraph -> AgentoMarkdownTokens.ParagraphToParagraph
                is MarkdownBlock.ListBlock -> AgentoMarkdownTokens.ParagraphToList
                is MarkdownBlock.Code -> AgentoMarkdownTokens.ParagraphToCodeBlock
                is MarkdownBlock.Quote -> AgentoMarkdownTokens.ParagraphToBlockquote
                is MarkdownBlock.Table -> AgentoMarkdownTokens.ParagraphToTable
                is MarkdownBlock.Diagram -> AgentoMarkdownTokens.ParagraphToCodeBlock
                is MarkdownBlock.Math -> AgentoMarkdownTokens.ParagraphToCodeBlock
                is MarkdownBlock.Divider -> AgentoMarkdownTokens.DividerVertical
            }
        }
        is MarkdownBlock.ListBlock -> {
            when (next) {
                is MarkdownBlock.Heading -> when (next.level) {
                    1 -> AgentoMarkdownTokens.ParagraphToH1
                    2 -> AgentoMarkdownTokens.ParagraphToH2
                    3 -> AgentoMarkdownTokens.ParagraphToH3
                    4 -> AgentoMarkdownTokens.ParagraphToH4
                    else -> AgentoMarkdownTokens.ParagraphToH4
                }
                is MarkdownBlock.Paragraph -> AgentoMarkdownTokens.ListToParagraph
                is MarkdownBlock.ListBlock -> AgentoMarkdownTokens.ListItemToListItem
                is MarkdownBlock.Code -> AgentoMarkdownTokens.ParagraphToCodeBlock
                else -> AgentoMarkdownTokens.ListToParagraph
            }
        }
        is MarkdownBlock.Code -> {
            when (next) {
                is MarkdownBlock.Code -> AgentoMarkdownTokens.CodeBlockToCodeBlock
                is MarkdownBlock.Heading -> when (next.level) {
                    1 -> AgentoMarkdownTokens.ParagraphToH1
                    2 -> AgentoMarkdownTokens.ParagraphToH2
                    3 -> AgentoMarkdownTokens.ParagraphToH3
                    4 -> AgentoMarkdownTokens.ParagraphToH4
                    else -> AgentoMarkdownTokens.ParagraphToH4
                }
                else -> AgentoMarkdownTokens.CodeBlockToParagraph
            }
        }
        is MarkdownBlock.Quote -> {
            when (next) {
                is MarkdownBlock.Heading -> when (next.level) {
                    1 -> AgentoMarkdownTokens.ParagraphToH1
                    2 -> AgentoMarkdownTokens.ParagraphToH2
                    3 -> AgentoMarkdownTokens.ParagraphToH3
                    4 -> AgentoMarkdownTokens.ParagraphToH4
                    else -> AgentoMarkdownTokens.ParagraphToH4
                }
                else -> AgentoMarkdownTokens.BlockquoteToParagraph
            }
        }
        is MarkdownBlock.Table -> {
            when (next) {
                is MarkdownBlock.Heading -> when (next.level) {
                    1 -> AgentoMarkdownTokens.ParagraphToH1
                    2 -> AgentoMarkdownTokens.ParagraphToH2
                    3 -> AgentoMarkdownTokens.ParagraphToH3
                    4 -> AgentoMarkdownTokens.ParagraphToH4
                    else -> AgentoMarkdownTokens.ParagraphToH4
                }
                else -> AgentoMarkdownTokens.TableToParagraph
            }
        }
        is MarkdownBlock.Diagram -> AgentoMarkdownTokens.CodeBlockToParagraph
        is MarkdownBlock.Math -> AgentoMarkdownTokens.CodeBlockToParagraph
        is MarkdownBlock.Divider -> AgentoMarkdownTokens.DividerVertical
    }
}

/**
 * Upstream-ported inline Markdown pipeline.
 *
 * [buildAgentInlineMarkdown] uses the JetBrains markdown parser (via the ported
 * `buildMarkdownAnnotatedString`) to construct the [AnnotatedString], and
 * [AgentoMarkdownText] renders it with `ExtendedSpans` +
 * `RoundedCornerSpanPainter` — the mature line-fragmentation strategy from
 * mikepenz/multiplatform-markdown-renderer (itself ported from
 * saket/extended-spans). Backgrounds are computed from
 * `TextLayoutResult.getBoundingBoxes()`: first line keeps its left corners,
 * last line its right corners, middle lines run full-height so long inline
 * code (SHA hashes, paths) wraps naturally with no seams, bars, or split
 * pills.
 */

/** LRU cache for parsed inline ASTs — streaming re-parses the tail text often. */
private val inlineAnnotatedCache = object : androidx.collection.LruCache<String, AnnotatedString>(300) {}

/** Per-theme settings bundle derived once per composition from Ragent tokens. */
private class AgentInlineSettings(
    val linkStyle: androidx.compose.ui.text.TextLinkStyles,
    val codeSpanStyle: SpanStyle,
)

@Composable
private fun rememberAgentInlineSettings(
    linkColor: Color,
    codeBackground: Color,
    codeTextColor: Color,
): AgentInlineSettings {
    return remember(linkColor, codeBackground, codeTextColor) {
        AgentInlineSettings(
            linkStyle = androidx.compose.ui.text.TextLinkStyles(
                style = SpanStyle(
                    color = linkColor,
                    fontWeight = FontWeight.Medium,
                    textDecoration = TextDecoration.None,
                ),
            ),
            codeSpanStyle = SpanStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = AgentoMarkdownTokens.InlineCodeFontSize,
                fontWeight = FontWeight(500),
                color = codeTextColor,
                background = codeBackground,
            ),
        )
    }
}

/**
 * Builds the inline [AnnotatedString] for a chat fragment using the upstream
 * parser pipeline. Cached: identical text under an identical theme resolves to
 * the same instance, keeping streaming recompositions cheap.
 */
fun buildAgentInlineMarkdown(
    text: String,
    style: TextStyle,
    linkColor: Color,
    codeBackground: Color,
    codeTextColor: Color,
): AnnotatedString {
    val key = "${style.hashCode()}|${linkColor.hashCode()}|${codeBackground.hashCode()}|${codeTextColor.hashCode()}|$text"
    inlineAnnotatedCache.get(key)?.let { return it }

    val settings = AgentInlineSettings(
        linkStyle = androidx.compose.ui.text.TextLinkStyles(
            style = SpanStyle(
                color = linkColor,
                fontWeight = FontWeight.Medium,
                textDecoration = TextDecoration.None,
            ),
        ),
        codeSpanStyle = SpanStyle(
            fontFamily = FontFamily.Monospace,
            fontSize = AgentoMarkdownTokens.InlineCodeFontSize,
            fontWeight = FontWeight(500),
            color = codeTextColor,
            background = codeBackground,
        ),
    )
    // Wrap in a paragraph so the upstream single-paragraph builder treats the
    // whole fragment as one PARAGRAPH node regardless of surrounding blocks.
    val settingsImpl = com.andysagent.ragent.core.agentui.markdown.AgentMarkdownAnnotatorSettings(
        linkTextSpanStyle = settings.linkStyle,
        codeSpanStyle = settings.codeSpanStyle,
    )
    val rawAnnotated = buildWithInlineMath(
        markdownWithVisibleLineBreaks(text),
        style,
        settingsImpl,
    )
    val annotated = highlightHexColorsInAnnotated(rawAnnotated)
    inlineAnnotatedCache.put(key, annotated)
    return annotated
}

private fun highlightHexColorsInAnnotated(annotated: AnnotatedString): AnnotatedString {
    val raw = annotated.text
    val hexRegex = Regex("""#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b""")
    if (!hexRegex.containsMatchIn(raw)) return annotated
    val builder = AnnotatedString.Builder(annotated)
    for (match in hexRegex.findAll(raw)) {
        val hex = match.value
        try {
            val parsedInt = android.graphics.Color.parseColor(
                if (hex.length == 4) "#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}" else hex
            )
            val color = Color(parsedInt)
            builder.addStyle(
                SpanStyle(
                    color = color,
                    fontWeight = FontWeight.SemiBold,
                    background = color.copy(alpha = 0.18f),
                ),
                match.range.first,
                match.range.last + 1
            )
        } catch (_: Exception) {}
    }
    return builder.toAnnotatedString()
}

/**
 * Keep a normal Enter visible in rendered conversation Markdown, matching the
 * composer and web client. CommonMark treats a bare newline as a soft break
 * and many renderers collapse it into a space; two trailing spaces make it an
 * explicit hard break without changing paragraph boundaries or code blocks.
 */
private fun markdownWithVisibleLineBreaks(text: String): String =
    text.replace("\r\n", "\n").replace("\n", "  \n")

/**
 * Splits the fragment on closed `$...$` inline-math spans and renders the
 * markdown parts through the upstream pipeline. The JetBrains parser has no
 * math flavour, so math is handled here (as before the port) while every
 * other construct keeps upstream behaviour. A `$` without a same-line closer
 // stays literal via the markdown fallback path.
 */
private fun buildWithInlineMath(
    text: String,
    style: TextStyle,
    settings: com.andysagent.ragent.core.agentui.markdown.AgentMarkdownAnnotatorSettings,
): AnnotatedString {
    var hasMath = false
    var searchIndex = 0
    while (searchIndex < text.length) {
        val dollar = text.indexOf('$', searchIndex)
        if (dollar < 0) break
        if (text.startsWith("$$", dollar)) { searchIndex = dollar + 2; continue }
        val lineEnd = text.indexOf('\n', dollar).let { if (it < 0) text.length else it }
        val close = text.indexOf('$', dollar + 1)
        if (close in (dollar + 1) until lineEnd && close > dollar + 1) {
            hasMath = true
            break
        }
        searchIndex = dollar + 1
    }
    if (!hasMath) {
        return text.buildMarkdownAnnotatedString(style = style, annotatorSettings = settings)
    }

    return androidx.compose.ui.text.buildAnnotatedString {
        var index = 0
        while (index < text.length) {
            val ch = text[index]
            if (ch == '$' && !text.startsWith("$$", index)) {
                val nextNewline = text.indexOf('\n', index)
                val lineLimit = if (nextNewline != -1) nextNewline else text.length
                val end = text.indexOf('$', index + 1)
                if (end in (index + 1) until lineLimit) {
                    val mathContent = text.substring(index + 1, end)
                    if (mathContent.isNotEmpty()) {
                        withStyle(
                            SpanStyle(
                                fontFamily = FontFamily.Serif,
                                fontStyle = FontStyle.Italic,
                                fontWeight = FontWeight.Normal,
                            ),
                        ) {
                            append(formatLatexMath(mathContent))
                        }
                        index = end + 1
                        continue
                    }
                }
            }
            // Non-math run: find the next potential math start and render the
            // run through the upstream markdown pipeline.
            var runEnd = index
            while (runEnd < text.length) {
                val c = text[runEnd]
                if (c == '$' && !text.startsWith("$$", runEnd)) {
                    val nl = text.indexOf('\n', runEnd)
                    val lim = if (nl != -1) nl else text.length
                    val cl = text.indexOf('$', runEnd + 1)
                    if (cl in (runEnd + 1) until lim && cl > runEnd + 1) break
                }
                runEnd += 1
            }
            if (runEnd > index) {
                append(
                    text.substring(index, runEnd).buildMarkdownAnnotatedString(
                        style = style,
                        annotatorSettings = settings,
                    ),
                )
                index = runEnd
            } else {
                append(ch)
                index += 1
            }
        }
    }
}

@Composable
fun AgentoMarkdownText(
    text: String,
    style: TextStyle,
    color: Color,
    inlineCodeBg: Color,
    modifier: Modifier = Modifier,
    codeTextColor: Color? = null,
    latestGraphemeColor: Color? = null,
    onTextLayout: ((TextLayoutResult) -> Unit)? = null,
) {
    val colors = LocalRagentColors.current
    val resolvedCodeTextColor = codeTextColor ?: color
    val annotated = remember(text, style, colors.running, inlineCodeBg, resolvedCodeTextColor) {
        buildAgentInlineMarkdown(
            text = text,
            style = style,
            linkColor = colors.running,
            codeBackground = inlineCodeBg,
            codeTextColor = resolvedCodeTextColor,
        )
    }

    // The painter fragments one logical code span across wrapped lines. The
    // surface is intentionally fill-only: inline code has zero outline.
    val density = LocalDensity.current
    val extendedSpans = remember(inlineCodeBg) {
        ExtendedSpans(
            RoundedCornerSpanPainter(
                cornerRadius = with(density) { AgentoMarkdownTokens.InlineCodeRadius.toSp() },
                padding = RoundedCornerSpanPainter.TextPaddingValues(
                    horizontal = with(density) { AgentoMarkdownTokens.InlineCodeHPadding.toSp() },
                    vertical = 0.sp,
                ),
                topMargin = AgentoMarkdownTokens.InlineCodeTopMargin,
                bottomMargin = AgentoMarkdownTokens.InlineCodeBottomMargin,
            ),
        )
    }
    val streamingAnnotated = remember(annotated, latestGraphemeColor) {
        latestGraphemeColor?.let { tintLatestGrapheme(annotated, it) } ?: annotated
    }
    val extended = remember(streamingAnnotated, extendedSpans) { extendedSpans.extend(streamingAnnotated) }

    Text(
        text = extended,
        style = markdownProseStyle(style),
        color = color,
        onTextLayout = { result ->
            extendedSpans.onTextLayout(result, color)
            onTextLayout?.invoke(result)
        },
        modifier = modifier.drawBehind(extendedSpans),
    )
}

// Paragraph direction follows its content, not the language of the app chrome.
internal fun markdownProseStyle(style: TextStyle): TextStyle = style.copy(textDirection = TextDirection.Content)

internal fun markdownBlockDirection(block: MarkdownBlock, fallback: LayoutDirection): LayoutDirection {
    val content = when (block) {
        is MarkdownBlock.Paragraph -> block.text
        is MarkdownBlock.Heading -> block.text
        is MarkdownBlock.Quote -> block.text
        is MarkdownBlock.ListBlock -> block.items.joinToString("\n") { it.text }
        else -> return fallback
    }
    val base = if (fallback == LayoutDirection.Rtl) java.text.Bidi.DIRECTION_DEFAULT_RIGHT_TO_LEFT
        else java.text.Bidi.DIRECTION_DEFAULT_LEFT_TO_RIGHT
    return if (java.text.Bidi(content, base).baseIsLeftToRight()) LayoutDirection.Ltr else LayoutDirection.Rtl
}

@Composable
fun MarkdownBlockRenderer(
    blocks: List<MarkdownBlock>,
    isStreaming: Boolean = false,
    latestGraphemeColor: Color? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val inlineCodeBg = if (isDark) AgentoMarkdownTokens.InlineCodeBgDark else AgentoMarkdownTokens.InlineCodeBgLight
    val inlineCodeText = if (isDark) AgentoMarkdownTokens.InlineCodeTextDark else AgentoMarkdownTokens.InlineCodeTextLight

    Box(modifier = modifier.fillMaxWidth()) {
      Column(Modifier.fillMaxWidth()) {
        blocks.forEachIndexed { index, block ->
            val nextBlock = blocks.getOrNull(index + 1)
            val bottomSpacing = calculateBlockSpacing(block, nextBlock)
            val isFrontierBlock = isStreaming && index == blocks.lastIndex
            // The trailing block is the live frontier. Keep its identity
            // stable while its text changes so Compose updates the existing
            // layout instead of repeatedly remounting the whole block.
            key(index) {
                val fallbackDirection = LocalLayoutDirection.current
                val blockDirection = remember(block, fallbackDirection) { markdownBlockDirection(block, fallbackDirection) }
                CompositionLocalProvider(LocalLayoutDirection provides blockDirection) {
                Column(Modifier.fillMaxWidth()) {
                when (block) {
                is MarkdownBlock.Paragraph -> {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = bottomSpacing),
                        verticalAlignment = Alignment.Bottom,
                    ) {
                        AgentoMarkdownText(
                            text = block.text,
                            style = markdownBodyStyle(),
                            color = colors.primaryContent,
                            inlineCodeBg = inlineCodeBg,
                            codeTextColor = inlineCodeText,
                            latestGraphemeColor = latestGraphemeColor.takeIf { isFrontierBlock },
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                }

                is MarkdownBlock.Heading -> {
                    val style = markdownHeadingStyle(block.level)
                    AgentoMarkdownText(
                        text = block.text,
                        style = style,
                        color = colors.primaryContent,
                        inlineCodeBg = inlineCodeBg,
                        codeTextColor = inlineCodeText,
                        latestGraphemeColor = latestGraphemeColor.takeIf { isFrontierBlock },
                        modifier = Modifier.padding(bottom = bottomSpacing),
                    )
                }

                is MarkdownBlock.ListBlock -> {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(AgentoMarkdownTokens.ListItemToListItem),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = bottomSpacing),
                    ) {
                        block.items.forEach { item ->
                            val indentPadding = (item.indentLevel * AgentoMarkdownTokens.ListIndentStep.value)
                                .coerceAtMost(AgentoMarkdownTokens.ListIndentStep.value * 2)
                                .dp
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = indentPadding),
                                horizontalArrangement = Arrangement.spacedBy(AgentoMarkdownTokens.ListMarkerGap),
                                verticalAlignment = Alignment.Top,
                            ) {
                                when (item) {
                                    is ListItem.Task -> {
                                        Box(
                                            modifier = Modifier.width(AgentoMarkdownTokens.ListMarkerWidth),
                                            contentAlignment = Alignment.TopEnd,
                                        ) {
                                            Surface(
                                                modifier = Modifier
                                                    .padding(top = 2.dp)
                                                    .size(16.dp),
                                                shape = RoundedCornerShape(4.dp),
                                                color = if (item.checked) LocalRagentColors.current.actionPrimary else Ragentolors.SurfaceLevel2,
                                                border = null,
                                            ) {
                                                if (item.checked) {
                                                    Box(contentAlignment = Alignment.Center) {
                                                        AgentoWebIcon(
                                                            glyph = AgentoWebGlyph.Check,
                                                            contentDescription = null,
                                                            tint = LocalRagentColors.current.actionPrimaryContent,
                                                            modifier = Modifier.size(12.dp),
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    is ListItem.Ordered -> {
                                        Box(
                                            modifier = Modifier.width(AgentoMarkdownTokens.ListMarkerWidth),
                                            contentAlignment = Alignment.TopEnd,
                                        ) {
                                            Text(
                                                text = "${item.number}.",
                                                style = TextStyle(
                                                    fontFamily = FontFamily.Monospace,
                                                    fontSize = AgentoMarkdownTokens.BodyFontSize,
                                                    fontWeight = FontWeight(550),
                                                    lineHeight = AgentoMarkdownTokens.BodyLineHeight,
                                                    letterSpacing = 0.sp,
                                                ),
                                                color = colors.secondaryContent,
                                            )
                                        }
                                    }

                                    is ListItem.Unordered -> {
                                        Box(
                                            modifier = Modifier.width(AgentoMarkdownTokens.ListMarkerWidth),
                                            contentAlignment = Alignment.TopCenter,
                                        ) {
                                            Box(
                                                modifier = Modifier
                                                    .padding(top = 10.dp)
                                                    .size(AgentoMarkdownTokens.listBulletSize)
                                                    .background(colors.secondaryContent.copy(alpha = 0.55f), CircleShape),
                                            )
                                        }
                                    }
                                }

                                AgentoMarkdownText(
                                    text = item.text,
                                    style = markdownListStyle(),
                                    color = if (item is ListItem.Task && item.checked) colors.secondaryContent else colors.primaryContent,
                                    inlineCodeBg = inlineCodeBg,
                                    codeTextColor = inlineCodeText,
                                    latestGraphemeColor = latestGraphemeColor.takeIf { isFrontierBlock && item == block.items.lastOrNull() },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }

                is MarkdownBlock.Quote -> {
                    val quoteBg = if (isDark) Color(0x0DFFFFFF) else Color(0x08000000)
                    val accentColor = colors.running.copy(alpha = if (isDark) 0.45f else 0.38f)

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(IntrinsicSize.Min)
                            .padding(bottom = bottomSpacing)
                            .clip(RoundedCornerShape(topStart = 0.dp, bottomStart = 0.dp, topEnd = 8.dp, bottomEnd = 8.dp))
                            .background(quoteBg)
                            .padding(start = 0.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxHeight()
                                .width(3.dp)
                                .clip(RoundedCornerShape(1.5.dp))
                                .background(accentColor),
                        )
                        Spacer(Modifier.width(12.dp))
                        AgentoMarkdownText(
                            text = block.text,
                            style = markdownQuoteStyle(),
                            color = colors.secondaryContent,
                            inlineCodeBg = inlineCodeBg,
                            codeTextColor = inlineCodeText,
                            latestGraphemeColor = latestGraphemeColor.takeIf { isFrontierBlock },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }

                is MarkdownBlock.Code -> {
                    Box(
                        modifier = Modifier.padding(bottom = bottomSpacing),
                    ) {
                        RagentodeBlock(
                            language = block.language,
                            code = block.text,
                        )
                    }
                }

                is MarkdownBlock.Diagram -> {
                    Box(
                        modifier = Modifier.padding(bottom = bottomSpacing),
                    ) {
                        MermaidDiagramBlock(block)
                    }
                }

                is MarkdownBlock.Math -> {
                    Box(
                        modifier = Modifier.padding(bottom = bottomSpacing),
                    ) {
                        MarkdownMathBlock(block)
                    }
                }

                is MarkdownBlock.Table -> {
                    Box(
                        modifier = Modifier.padding(bottom = bottomSpacing),
                    ) {
                        MarkdownTableBlock(block)
                    }
                }

                is MarkdownBlock.Divider -> {
                    val dividerColor = colors.lineSubtle.copy(alpha = if (isDark) 0.20f else 0.15f)
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = AgentoMarkdownTokens.DividerVertical)
                            .height(1.dp)
                            .background(dividerColor),
                    )
                }
            }
            }
                }
            }
        }
      }
      if (isStreaming) {
          // The frontier is paint, not a new paragraph. Removing it at
          // completion must not change the measured body or scroll offset.
          AgentoStreamingCursor(Modifier.align(Alignment.BottomEnd))
      }
    }

}

/**
 * Quiet code container. Short snippets stay close to surrounding prose;
 * longer code earns a compact language and copy rail.
 */
fun normalizedCodeLanguage(language: String?): String {
    val raw = language?.trim()?.lowercase(Locale.ROOT).orEmpty()
    return when (raw) {
        "", "text", "txt", "plain", "plaintext" -> "text"
        "js", "jsx" -> "javascript"
        "ts", "tsx" -> "typescript"
        "py" -> "python"
        "ps", "ps1", "psm1", "pwsh" -> "powershell"
        "sh", "bash", "zsh" -> "shell"
        "yml" -> "yaml"
        "md" -> "markdown"
        "html", "htm", "xml" -> "markup"
        else -> raw
    }
}

fun displayCodeLanguage(language: String?): String {
    val key = normalizedCodeLanguage(language)
    return when (key) {
        "text" -> "Plain text"
        "javascript" -> "JavaScript"
        "typescript" -> "TypeScript"
        "python" -> "Python"
        "powershell" -> "PowerShell"
        "shell" -> "Shell"
        "yaml" -> "YAML"
        "markdown" -> "Markdown"
        "markup" -> "HTML"
        "css" -> "CSS"
        "sql" -> "SQL"
        "json" -> "JSON"
        "kotlin" -> "Kotlin"
        "java" -> "Java"
        "diff" -> "Diff"
        "patch" -> "Patch"
        else -> key.replaceFirstChar { character -> character.uppercase(Locale.ROOT) }
    }
}

@Composable
fun RagentodeBlock(
    code: String,
    language: String?,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val clipboardManager = LocalClipboardManager.current
    var isCopied by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    val languageKey = remember(language) { normalizedCodeLanguage(language) }
    val displayLang = remember(language) { displayCodeLanguage(language) }

    val isDark = colors.canvas.red < 0.5f
    val containerBg = if (isDark) Color(0xFF0E131B).copy(alpha = 0.94f) else Color(0xFFF7F8FA).copy(alpha = 0.95f)
    val headerBg = if (isDark) Color(0xFF161E2E).copy(alpha = 0.88f) else Color(0xFFECEFF5).copy(alpha = 0.92f)
    val codeShape = RoundedCornerShape(16.dp)
    val codeBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )
    val scrollState = rememberScrollState()

    val highlightedText = remember(code, languageKey, isDark) {
        highlightCode(code, languageKey, isDark)
    }

    Surface(
        color = containerBg,
        shape = codeShape,
        border = codeBorder,
        modifier = modifier
            .fillMaxWidth()
            .clip(codeShape)
            .semantics { contentDescription = "$displayLang code block" },
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(34.dp)
                    .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                    .background(headerBg)
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = displayLang,
                    style = TextStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.secondaryContent,
                    ),
                )

                // The visible control stays compact while its touch target is
                // kept at the spec's 28dp minimum.
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .agentoPressScale(
                            pressedScale = 0.88f,
                            onClick = {
                                clipboardManager.setText(AnnotatedString(code))
                                isCopied = true
                                coroutineScope.launch {
                                    delay(2000)
                                    isCopied = false
                                }
                            },
                        )
                        .semantics {
                            contentDescription = if (isCopied) "Copied" else "Copy code block"
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (isCopied) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Check,
                            contentDescription = null,
                            modifier = Modifier.size(13.dp),
                            tint = if (isDark) Color(0xFF4E9B58) else Color(0xFF2F6B3C),
                        )
                    } else {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Copy,
                            contentDescription = "Copy code block",
                            modifier = Modifier.size(13.dp),
                            tint = colors.secondaryContent,
                        )
                    }
                }
            }

            // Source remains LTR (including indentation and scroll origin), while
            // the surrounding language label / copy action follows app direction.
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
                Box(modifier = Modifier.fillMaxWidth()) {
                    SelectionContainer {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(scrollState)
                                .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
                        ) {
                            Text(
                                text = highlightedText,
                                style = RagentonversationTypography.Code.copy(textDirection = TextDirection.Ltr),
                                softWrap = false,
                            )
                        }
                    }
                    if (scrollState.canScrollForward) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.CenterEnd)
                                .width(16.dp)
                                .fillMaxHeight()
                                .background(
                                    Brush.horizontalGradient(
                                        colors = listOf(Color.Transparent, containerBg),
                                    ),
                                ),
                        )
                    }
                }
            }
        }
    }
}

/**
 * 专为 Mermaid Flowchart / Sequence 设计的原生结构化矢量图表卡片
 */
@Composable
fun MermaidDiagramBlock(
    block: MarkdownBlock.Diagram,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val clipboardManager = LocalClipboardManager.current
    var isCopied by remember { mutableStateOf(false) }
    var showSource by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    val containerBg = if (isDark) Color(0xFF10141C) else Color(0xFFF7F9FC)
    val headerBg = if (isDark) Color(0xFF161C26) else Color(0xFFEBF0F7)

    val diagramBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )
    val diagramShape = RoundedCornerShape(16.dp)

    Surface(
        color = containerBg,
        shape = diagramShape,
        border = diagramBorder,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(34.dp)
                    .clip(RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp))
                    .background(headerBg)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.TargetArrow,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = LocalRagentColors.current.accentPrimary,
                    )
                    Text(
                        text = "Mermaid · ${block.diagramType.replaceFirstChar { it.uppercase() }}",
                        style = TextStyle(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = colors.primaryContent,
                        ),
                    )
                }

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Surface(
                        onClick = { showSource = !showSource },
                        shape = RoundedCornerShape(4.dp),
                        color = if (isDark) Color(0x22FFFFFF) else Color(0x18000000),
                    ) {
                        Text(
                            text = if (showSource) "图表视图" else "代码源",
                            style = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.Medium),
                            color = colors.secondaryContent,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }

                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(4.dp))
                            .clickable {
                                clipboardManager.setText(AnnotatedString(block.source))
                                isCopied = true
                                coroutineScope.launch { delay(2000); isCopied = false }
                            }
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        AgentoWebIcon(
                            glyph = if (isCopied) AgentoWebGlyph.Check else AgentoWebGlyph.Copy,
                            contentDescription = "Copy diagram source",
                            modifier = Modifier.size(12.dp),
                            tint = if (isCopied) Ragentolors.Success else colors.secondaryContent,
                        )
                    }
                }
            }

            if (showSource) {
                SelectionContainer {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(12.dp),
                    ) {
                        Text(
                            text = highlightCode(block.source, "mermaid", isDark),
                            style = RagentonversationTypography.Code,
                        )
                    }
                }
            } else {
                MermaidVisualView(
                    source = block.source,
                    isDark = isDark,
                    colors = colors,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                )
            }
        }
    }
}

private sealed interface MermaidElement {
    data class Node(val id: String, val label: String) : MermaidElement
    data class Edge(val from: String, val to: String, val label: String = "") : MermaidElement
}

private fun parseMermaidGraph(source: String): List<MermaidElement> {
    val elements = mutableListOf<MermaidElement>()
    val lines = source.lines()

    for (line in lines) {
        val trimmed = line.trim()
        if (trimmed.isEmpty() || trimmed.startsWith("graph") || trimmed.startsWith("flowchart") || trimmed.startsWith("%%") || trimmed.startsWith("sequenceDiagram")) {
            continue
        }

        // Check for edge: A --> B or A[Label1] -->|text| B[Label2]
        if (trimmed.contains("-->") || trimmed.contains("->>") || trimmed.contains("->")) {
            val parts = trimmed.split(Regex("-->|->>|->"))
            if (parts.size >= 2) {
                val left = parts[0].trim()
                val right = parts[1].trim()

                var edgeLabel = ""
                val rightTarget: String
                val secondPipe = if (right.startsWith("|")) right.indexOf('|', startIndex = 1) else -1
                if (right.startsWith("|") && secondPipe != -1) {
                    edgeLabel = right.substring(1, secondPipe).trim()
                    rightTarget = right.substring(secondPipe + 1).trim()
                } else {
                    rightTarget = right
                }

                val leftLabel = extractNodeLabel(left)
                val rightLabel = extractNodeLabel(rightTarget)

                if (elements.none { it is MermaidElement.Node && it.label == leftLabel }) {
                    elements.add(MermaidElement.Node(left, leftLabel))
                }
                elements.add(MermaidElement.Edge(left, rightTarget, edgeLabel))
                if (elements.none { it is MermaidElement.Node && it.label == rightLabel }) {
                    elements.add(MermaidElement.Node(rightTarget, rightLabel))
                }
            }
        } else if (trimmed.isNotBlank()) {
            val label = extractNodeLabel(trimmed)
            elements.add(MermaidElement.Node(trimmed, label))
        }
    }

    if (elements.isEmpty()) {
        elements.add(MermaidElement.Node("1", "Task Started"))
        elements.add(MermaidElement.Edge("1", "2", "process"))
        elements.add(MermaidElement.Node("2", "Execution"))
        elements.add(MermaidElement.Edge("2", "3", "complete"))
        elements.add(MermaidElement.Node("3", "Outcome Verified"))
    }

    return elements
}

private fun extractNodeLabel(raw: String): String {
    val bracketMatch = Regex("\\[(.+)\\]|\\((.+)\\)|\\{(.+)\\}").find(raw)
    return bracketMatch?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }?.trim() ?: raw.trim()
}

@Composable
private fun MermaidVisualView(
    source: String,
    isDark: Boolean,
    colors: RagentColors,
    modifier: Modifier = Modifier,
) {
    val nodes = remember(source) { parseMermaidGraph(source) }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(vertical = 6.dp),
        ) {
            nodes.forEachIndexed { idx, item ->
                when (item) {
                    is MermaidElement.Node -> {
                        Surface(
                            shape = AgentoShapes.SquircleS,
                            color = if (isDark) Color(0xFF1C2230) else Color(0xFFFFFFFF),
                            shadowElevation = 0.dp,
                            border = null,
                            modifier = Modifier.agentoAmbientShadow(elevation = 2.dp, shape = AgentoShapes.SquircleS, alpha = 0.06f),
                        ) {
                            Row(
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(6.dp)
                                        .background(
                                            if (idx == 0) Ragentolors.Success else LocalRagentColors.current.accentPrimary,
                                            CircleShape,
                                        ),
                                )
                                Text(
                                    text = item.label,
                                    style = TextStyle(
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = FontWeight.SemiBold,
                                        fontSize = 13.sp,
                                        color = colors.primaryContent,
                                    ),
                                )
                            }
                        }
                    }
                    is MermaidElement.Edge -> {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            if (item.label.isNotBlank()) {
                                Surface(
                                    shape = RoundedCornerShape(4.dp),
                                    color = if (isDark) Color(0xFF252D3D) else Color(0xFFE2E8F0),
                                ) {
                                    Text(
                                        text = item.label,
                                        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium),
                                        color = colors.secondaryContent,
                                        modifier = Modifier.padding(horizontal = 5.dp, vertical = 1.dp),
                                    )
                                }
                            }
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.ChevronRight,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = LocalRagentColors.current.accentPrimary.copy(alpha = 0.8f),
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * 专为 KaTeX / LaTeX 公式排版设计的数学公式渲染卡片
 */
@Composable
fun MarkdownMathBlock(
    block: MarkdownBlock.Math,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val formattedFormula = remember(block.formula) { formatLatexMath(block.formula) }

    val mathBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )
    Surface(
        color = if (isDark) Color(0xFF131722).copy(alpha = 0.92f) else Color(0xFFF6F8FB).copy(alpha = 0.95f),
        shape = RoundedCornerShape(16.dp),
        border = mathBorder,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "KaTeX · Math",
                    style = TextStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.secondaryContent,
                    ),
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(vertical = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = formattedFormula,
                    style = TextStyle(
                        fontFamily = FontFamily.Serif,
                        fontStyle = FontStyle.Italic,
                        fontSize = 17.sp,
                        lineHeight = 26.sp,
                        fontWeight = FontWeight.Normal,
                        color = colors.primaryContent,
                    ),
                )
            }
        }
    }
}

fun formatLatexMath(raw: String): String {
    var s = raw
        .replace("\\alpha", "α")
        .replace("\\beta", "β")
        .replace("\\gamma", "γ")
        .replace("\\delta", "δ")
        .replace("\\epsilon", "ε")
        .replace("\\theta", "θ")
        .replace("\\lambda", "λ")
        .replace("\\mu", "μ")
        .replace("\\pi", "π")
        .replace("\\sigma", "σ")
        .replace("\\omega", "ω")
        .replace("\\Delta", "Δ")
        .replace("\\Sigma", "Σ")
        .replace("\\Omega", "Ω")
        .replace("\\sum", "∑")
        .replace("\\prod", "∏")
        .replace("\\int", "∫")
        .replace("\\sqrt", "√")
        .replace("\\infty", "∞")
        .replace("\\approx", "≈")
        .replace("\\neq", "≠")
        .replace("\\le", "≤")
        .replace("\\ge", "≥")
        .replace("\\times", "×")
        .replace("\\cdot", "·")
        .replace("\\pm", "±")
        .replace("\\to", "→")
        .replace("\\rightarrow", "→")
        .replace("\\leftarrow", "←")
        .replace("\\in", "∈")
        .replace("\\notin", "∉")
        .replace("\\subset", "⊂")
        .replace("\\cup", "∪")
        .replace("\\cap", "∩")
        .replace("\\partial", "∂")
        .replace("\\nabla", "∇")
        .replace("\\forall", "∀")
        .replace("\\exists", "∃")

    // Superscripts
    s = s.replace(Regex("\\^([0-9nxi+]+)")) { match ->
        match.groupValues[1].map { ch ->
            when (ch) {
                '0' -> '⁰'; '1' -> '¹'; '2' -> '²'; '3' -> '³'; '4' -> '⁴'
                '5' -> '⁵'; '6' -> '⁶'; '7' -> '⁷'; '8' -> '⁸'; '9' -> '⁹'
                'n' -> 'ⁿ'; 'i' -> 'ⁱ'; 'x' -> 'ˣ'; '+' -> '⁺'; else -> ch
            }
        }.joinToString("")
    }

    // Subscripts
    s = s.replace(Regex("_([0-9a-z]+)")) { match ->
        match.groupValues[1].map { ch ->
            when (ch) {
                '0' -> '₀'; '1' -> '₁'; '2' -> '₂'; '3' -> '₃'; '4' -> '₄'
                '5' -> '₅'; '6' -> '₆'; '7' -> '₇'; '8' -> '₈'; '9' -> '₉'
                'i' -> 'ᵢ'; 'j' -> 'ⱼ'; 'k' -> 'ₖ'; 'n' -> 'ₙ'; 'm' -> 'ₘ'; 'x' -> 'ₓ'
                else -> ch
            }
        }.joinToString("")
    }

    // Fractions \frac{a}{b} -> (a / b)
    s = s.replace(Regex("\\\\frac\\{([^}]+)\\}\\{([^}]+)\\}")) { match ->
        "(${match.groupValues[1]} / ${match.groupValues[2]})"
    }

    return s
}

fun highlightCode(code: String, language: String, isDark: Boolean): AnnotatedString {
    val builder = AnnotatedString.Builder()
    val lang = normalizedCodeLanguage(language)
    if (lang == "text") return AnnotatedString(code)

    val kwColor = if (isDark) Color(0xFFC678DD) else Color(0xFFA626A4)
    val typeColor = if (isDark) Color(0xFFE5C07B) else Color(0xFFB06A00)
    val fnColor = if (isDark) Color(0xFF61AFEF) else Color(0xFF0066CC)
    val strColor = if (isDark) Color(0xFF98C379) else Color(0xFF2E7D32)
    val numColor = if (isDark) Color(0xFFD19A66) else Color(0xFFC75E00)
    val commentColor = if (isDark) Color(0xFF7F848E) else Color(0xFF6E7781)
    val annoColor = if (isDark) Color(0xFFE5C07B) else Color(0xFF6F42C1)
    val keyColor = if (isDark) Color(0xFF79C0FF) else Color(0xFF0550AE)
    val varColor = if (isDark) Color(0xFFE06C75) else Color(0xFFCF222E)
    val opColor = if (isDark) Color(0xFF8B949E) else Color(0xFF57606A)
    val diffAddColor = if (isDark) Color(0xFF7EE787) else Color(0xFF1A7F37)
    val diffDelColor = if (isDark) Color(0xFFFFA198) else Color(0xFFCF222E)
    val defaultColor = if (isDark) Color(0xFFE6EDF3) else Color(0xFF1F2328)

    // Diff / Patch special mode
    if (lang in listOf("diff", "patch")) {
        val lines = code.lines()
        lines.forEachIndexed { index, line ->
            when {
                line.startsWith("+++") || line.startsWith("---") -> {
                    builder.withStyle(SpanStyle(color = typeColor, fontWeight = FontWeight.SemiBold)) { append(line) }
                }
                line.startsWith("+") -> {
                    builder.withStyle(SpanStyle(color = diffAddColor)) { append(line) }
                }
                line.startsWith("-") -> {
                    builder.withStyle(SpanStyle(color = diffDelColor)) { append(line) }
                }
                line.startsWith("@@") -> {
                    builder.withStyle(SpanStyle(color = annoColor, fontStyle = FontStyle.Italic)) { append(line) }
                }
                else -> {
                    builder.withStyle(SpanStyle(color = defaultColor)) { append(line) }
                }
            }
            if (index < lines.lastIndex) builder.append("\n")
        }
        return builder.toAnnotatedString()
    }

    val allKeywords = setOf(
        // Kotlin / Java
        "val", "var", "fun", "class", "data", "sealed", "enum", "interface", "object", "package", "import",
        "return", "if", "else", "when", "for", "while", "do", "try", "catch", "finally", "throw", "throws",
        "override", "private", "public", "protected", "internal", "suspend", "inline", "noinline", "crossinline",
        "reified", "tailrec", "operator", "infix", "const", "lateinit", "open", "abstract", "final", "annotation",
        "companion", "init", "constructor", "this", "super", "it", "true", "false", "null", "by", "lazy",
        "typealias", "is", "as", "in", "out", "where", "get", "set", "field", "value", "new", "static",
        "synchronized", "volatile", "transient", "native", "strictfp", "void", "boolean", "byte", "char",
        "short", "int", "long", "float", "double", "instanceof", "extends", "implements",

        // Python
        "def", "lambda", "pass", "raise", "except", "with", "yield", "global", "nonlocal", "assert", "not",
        "and", "or", "elif", "none", "self", "cls",

        // JS / TS
        "let", "function", "switch", "case", "default", "break", "continue", "delete", "typeof",
        "undefined", "nan", "declare", "namespace", "module", "readonly", "keyof", "satisfies",
        "export", "from", "async", "await", "debugger",

        // Go
        "func", "chan", "go", "defer", "map", "make", "nil", "iota", "fallthrough", "goto",

        // Rust
        "fn", "mut", "pub", "struct", "impl", "trait", "mod", "match", "loop", "unsafe", "dyn", "ref",
        "move", "crate", "extern", "macro_rules",

        // SQL
        "select", "from", "where", "insert", "into", "values", "update", "delete", "join", "inner", "left",
        "right", "full", "outer", "cross", "on", "group", "having", "order", "asc", "desc", "limit", "offset",
        "union", "all", "create", "table", "alter", "drop", "index", "view", "like", "ilike", "between",
        "exists", "then", "distinct", "primary", "foreign", "references", "constraint", "check",

        // Shell
        "echo", "export", "cd", "pwd", "mkdir", "rm", "cp", "mv", "ls", "grep", "cat", "chmod", "chown",
        "curl", "wget", "git", "docker", "npm", "npx", "pnpm", "yarn", "cargo", "pip", "python", "node",
        "sed", "awk", "find", "source", "sudo", "alias", "local", "readonly", "unset", "then", "elif",
        "fi", "done", "esac", "exit", "trap", "exec"
    )

    val commonTypes = setOf(
        "String", "Int", "Long", "Float", "Double", "Boolean", "Byte", "Short", "Char", "Unit", "Any", "Nothing",
        "List", "Map", "Set", "Array", "MutableList", "MutableMap", "MutableSet", "ArrayList", "HashMap", "HashSet",
        "Modifier", "Composable", "State", "MutableState", "Flow", "SharedFlow", "StateFlow", "CoroutineScope",
        "Job", "Deferred", "Box", "Column", "Row", "Text", "Surface", "Button", "Card", "Icon", "Spacer",
        "Color", "Dp", "TextUnit", "AnnotatedString", "SpanStyle", "TextStyle", "FontWeight", "FontFamily",
        "Promise", "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
        "dict", "list", "tuple", "set", "str", "int", "bool", "float", "bytes", "object", "type",
        "Vec", "Option", "Result", "Some", "None", "Ok", "Err", "Box", "Rc", "Arc", "Mutex", "Cell", "RefCell",
        "Error", "Exception", "RuntimeException", "Throwable"
    )

    var i = 0
    val len = code.length

    while (i < len) {
        val c = code[i]

        when {
            // 1. Line comment (// or # or --)
            (code.startsWith("//", i) ||
             (c == '#' && lang in listOf("python", "py", "sh", "bash", "shell", "zsh", "yaml", "yml", "dockerfile", "r", "ruby", "rb", "toml", "conf", "env")) ||
             (code.startsWith("--", i) && (lang in listOf("sql", "sqlite", "mysql", "pgsql", "postgres", "lua", "haskell") || lang.isBlank()))) -> {
                val end = code.indexOf('\n', i).let { if (it == -1) len else it }
                builder.withStyle(SpanStyle(color = commentColor, fontStyle = FontStyle.Italic)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 2. Block comments: /* ... */ or <!-- ... -->
            code.startsWith("/*", i) -> {
                val end = code.indexOf("*/", i + 2).let { if (it == -1) len else it + 2 }
                builder.withStyle(SpanStyle(color = commentColor, fontStyle = FontStyle.Italic)) {
                    append(code.substring(i, end))
                }
                i = end
            }
            code.startsWith("<!--", i) -> {
                val end = code.indexOf("-->", i + 4).let { if (it == -1) len else it + 4 }
                builder.withStyle(SpanStyle(color = commentColor, fontStyle = FontStyle.Italic)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 3. Triple quoted strings: """ ... """ or ''' ... '''
            code.startsWith("\"\"\"", i) -> {
                val end = code.indexOf("\"\"\"", i + 3).let { if (it == -1) len else it + 3 }
                builder.withStyle(SpanStyle(color = strColor)) {
                    append(code.substring(i, end))
                }
                i = end
            }
            code.startsWith("'''", i) -> {
                val end = code.indexOf("'''", i + 3).let { if (it == -1) len else it + 3 }
                builder.withStyle(SpanStyle(color = strColor)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 4. Backtick template strings: `...`
            c == '`' -> {
                var end = i + 1
                while (end < len && code[end] != '`') {
                    if (code[end] == '\\' && end + 1 < len) end += 2 else end++
                }
                if (end < len && code[end] == '`') end++
                builder.withStyle(SpanStyle(color = strColor)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 5. String literals: "..." or '...'
            c == '"' || (c == '\'' && lang !in listOf("rust", "rs", "cpp", "c", "c++", "cs", "csharp")) -> {
                val quote = c
                var end = i + 1
                while (end < len && code[end] != quote && code[end] != '\n') {
                    if (code[end] == '\\' && end + 1 < len) end += 2 else end++
                }
                if (end < len && code[end] == quote) end++

                // Check if this string is a JSON / Map property key (e.g. "key":)
                var nextNonSpace = end
                while (nextNonSpace < len && (code[nextNonSpace] == ' ' || code[nextNonSpace] == '\t')) nextNonSpace++
                val isJsonKey = nextNonSpace < len && code[nextNonSpace] == ':'

                val color = if (isJsonKey) keyColor else strColor
                builder.withStyle(SpanStyle(color = color)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 6. Annotations / Decorators / Preprocessor: @Composable, @Test, #include, @param
            c == '@' || (c == '#' && lang in listOf("c", "cpp", "c++", "h", "hpp", "cs")) -> {
                var end = i + 1
                while (end < len && (code[end].isLetterOrDigit() || code[end] == '_' || code[end] == '.' || code[end] == ':')) {
                    end++
                }
                builder.withStyle(SpanStyle(color = annoColor, fontWeight = FontWeight.SemiBold)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 7. Shell variables: $VAR, ${VAR}, $1
            c == '$' && i + 1 < len && (code[i + 1].isLetterOrDigit() || code[i + 1] == '_' || code[i + 1] == '{') -> {
                var end = i + 1
                if (code[end] == '{') {
                    end = code.indexOf('}', end).let { if (it == -1) len else it + 1 }
                } else {
                    while (end < len && (code[end].isLetterOrDigit() || code[end] == '_')) end++
                }
                builder.withStyle(SpanStyle(color = varColor, fontWeight = FontWeight.Medium)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 8. CLI flags: --option or -f (in shell / bash)
            (c == '-' && (lang in listOf("sh", "bash", "shell", "zsh") || lang.isBlank()) && i + 1 < len && (code[i + 1].isLetter() || code[i + 1] == '-')) -> {
                var end = i + 1
                if (code[end] == '-') end++
                while (end < len && (code[end].isLetterOrDigit() || code[end] == '-' || code[end] == '_')) end++
                builder.withStyle(SpanStyle(color = numColor)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 9. Numbers (Hex, Binary, Floats, Integers)
            c.isDigit() && (i == 0 || (!code[i - 1].isLetterOrDigit() && code[i - 1] != '_' && code[i - 1] != '$')) -> {
                var end = i
                if (code.startsWith("0x", i, ignoreCase = true) || code.startsWith("0b", i, ignoreCase = true)) {
                    end += 2
                    while (end < len && (code[end].isLetterOrDigit() || code[end] == '_')) end++
                } else {
                    while (end < len && (code[end].isDigit() || code[end] == '.' || code[end] == '_' || code[end] == 'f' || code[end] == 'F' || code[end] == 'L' || code[end] == 'u' || code[end] == 'U')) {
                        end++
                    }
                }
                builder.withStyle(SpanStyle(color = numColor)) {
                    append(code.substring(i, end))
                }
                i = end
            }

            // 10. Identifiers / Keywords / Types / Functions
            c.isLetter() || c == '_' -> {
                var end = i
                while (end < len && (code[end].isLetterOrDigit() || code[end] == '_')) end++
                val word = code.substring(i, end)

                var peek = end
                while (peek < len && (code[peek] == ' ' || code[peek] == '\t')) peek++
                val isFunctionCall = peek < len && code[peek] == '('
                val isColon = peek < len && code[peek] == ':' && (peek + 1 >= len || code[peek + 1] != ':')

                val wordLower = word.lowercase()
                when {
                    wordLower in allKeywords -> {
                        builder.withStyle(SpanStyle(color = kwColor, fontWeight = FontWeight.SemiBold)) {
                            append(word)
                        }
                    }
                    word in commonTypes || (word.first().isUpperCase() && word.length > 1 && !word.all { it.isUpperCase() }) -> {
                        builder.withStyle(SpanStyle(color = typeColor, fontWeight = FontWeight.Medium)) {
                            append(word)
                        }
                    }
                    isColon && (lang in listOf("yaml", "yml", "json", "toml") || (i == 0 || code[i - 1] == '\n' || code[i - 1] == ' ')) -> {
                        builder.withStyle(SpanStyle(color = keyColor, fontWeight = FontWeight.Medium)) {
                            append(word)
                        }
                    }
                    isFunctionCall -> {
                        builder.withStyle(SpanStyle(color = fnColor)) {
                            append(word)
                        }
                    }
                    word.all { it.isUpperCase() || it == '_' } && word.length > 1 -> {
                        builder.withStyle(SpanStyle(color = numColor, fontWeight = FontWeight.Medium)) {
                            append(word)
                        }
                    }
                    else -> {
                        builder.withStyle(SpanStyle(color = defaultColor)) {
                            append(word)
                        }
                    }
                }
                i = end
            }

            // 11. Operators and Punctuation
            c in "=+-*/%&|^!<>?:;,." -> {
                builder.withStyle(SpanStyle(color = opColor)) {
                    append(c)
                }
                i++
            }

            else -> {
                builder.withStyle(SpanStyle(color = defaultColor)) {
                    append(c)
                }
                i++
            }
        }
    }
    return builder.toAnnotatedString()
}

/**
 * 带有 Apple HIG 物理平滑呼吸的流式光标胶囊
 */
@Composable
fun AgentoStreamingCursor(
    modifier: Modifier = Modifier,
) {
    val motion = LocalMotionPolicy.current
    val colors = LocalRagentColors.current
    val infiniteTransition = rememberInfiniteTransition(label = "cursorBlink")
    val animatedAlpha by infiniteTransition.animateFloat(
        initialValue = 0.22f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 650, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "cursorAlpha",
    )
    val alpha = if (motion.preference == MotionPreference.Full) animatedAlpha else 0.65f

    Box(
        modifier = modifier
            .width(3.dp)
            .height(16.dp)
            .clip(RoundedCornerShape(1.5.dp))
            .background(
                Brush.verticalGradient(
                    listOf(
                        colors.stateRunning.copy(alpha = alpha),
                        colors.actionPrimary.copy(alpha = alpha * 0.85f),
                    ),
                ),
            ),
    )
}

enum class TableAlignment { Left, Center, Right }

fun parseTableAlignments(delimiterLine: String): List<TableAlignment> {
    val cols = delimiterLine.trim().trim('|').split('|')
    return cols.map { col ->
        val t = col.trim()
        val startColon = t.startsWith(":")
        val endColon = t.endsWith(":")
        when {
            startColon && endColon -> TableAlignment.Center
            endColon -> TableAlignment.Right
            else -> TableAlignment.Left
        }
    }
}

private class TableMetrics {
    var hasHeader: Boolean = false
    var rowCount: Int = 0
    var colCount: Int = 0
    var totalWidth: Int = 0
    var totalHeight: Int = 0
    var colOffsets: IntArray = IntArray(0)
    var colWidths: IntArray = IntArray(0)
    var rowOffsets: IntArray = IntArray(0)
    var rowHeights: IntArray = IntArray(0)
}

@Composable
private fun TableGridLayout(
    columnCount: Int,
    hasHeader: Boolean,
    alignments: List<TableAlignment>,
    headerBg: Color,
    zebraBg: Color,
    separatorColor: Color,
    cellHorizontalPadding: Dp,
    cellVerticalPadding: Dp,
    minColumnWidth: Dp,
    minRowHeight: Dp,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val metrics = remember { TableMetrics() }

    Layout(
        content = content,
        modifier = modifier.drawWithContent {
            val totalW = metrics.totalWidth.toFloat()
            val totalH = metrics.totalHeight.toFloat()
            if (totalW > 0f && totalH > 0f) {
                // 1. Draw header background
                if (metrics.hasHeader && metrics.rowCount > 0 && metrics.rowHeights.isNotEmpty()) {
                    val hH = metrics.rowHeights[0].toFloat()
                    drawRect(
                        color = headerBg,
                        topLeft = Offset(0f, 0f),
                        size = Size(totalW, hH),
                    )
                }
                // 2. Draw zebra alternating row backgrounds
                val dataStartRow = if (metrics.hasHeader) 1 else 0
                for (r in dataStartRow until metrics.rowCount) {
                    if ((r - dataStartRow) % 2 == 1 && r < metrics.rowOffsets.size && r < metrics.rowHeights.size) {
                        val rY = metrics.rowOffsets[r].toFloat()
                        val rH = metrics.rowHeights[r].toFloat()
                        drawRect(
                            color = zebraBg,
                            topLeft = Offset(0f, rY),
                            size = Size(totalW, rH),
                        )
                    }
                }
                // 3. Draw horizontal row dividers
                for (r in 1 until metrics.rowCount) {
                    if (r < metrics.rowOffsets.size) {
                        val rY = metrics.rowOffsets[r].toFloat()
                        drawLine(
                            color = separatorColor,
                            start = Offset(0f, rY),
                            end = Offset(totalW, rY),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                }
            }
            drawContent()
        },
    ) { measurables, _ ->
        if (measurables.isEmpty() || columnCount <= 0) {
            return@Layout layout(0, 0) {}
        }

        val totalCells = measurables.size
        val rowCount = (totalCells + columnCount - 1) / columnCount
        val hPadPx = cellHorizontalPadding.roundToPx()
        val vPadPx = cellVerticalPadding.roundToPx()
        val minColWidthPx = minColumnWidth.roundToPx()
        val minRowHeightPx = minRowHeight.roundToPx()

        val cellConstraints = Constraints(
            minWidth = 0,
            maxWidth = Constraints.Infinity,
            minHeight = 0,
            maxHeight = Constraints.Infinity,
        )
        val placeables = measurables.map { it.measure(cellConstraints) }

        val colWidths = IntArray(columnCount) { minColWidthPx }
        val rowHeights = IntArray(rowCount) { minRowHeightPx }

        for (i in placeables.indices) {
            val r = i / columnCount
            val c = i % columnCount
            val p = placeables[i]
            colWidths[c] = maxOf(colWidths[c], p.width + hPadPx * 2)
            rowHeights[r] = maxOf(rowHeights[r], p.height + vPadPx * 2)
        }

        val totalWidth = colWidths.sum()
        val totalHeight = rowHeights.sum()

        val colOffsets = IntArray(columnCount) { 0 }
        var currentX = 0
        for (c in 0 until columnCount) {
            colOffsets[c] = currentX
            currentX += colWidths[c]
        }

        val rowOffsets = IntArray(rowCount) { 0 }
        var currentY = 0
        for (r in 0 until rowCount) {
            rowOffsets[r] = currentY
            currentY += rowHeights[r]
        }

        metrics.hasHeader = hasHeader
        metrics.rowCount = rowCount
        metrics.colCount = columnCount
        metrics.totalWidth = totalWidth
        metrics.totalHeight = totalHeight
        metrics.colOffsets = colOffsets
        metrics.colWidths = colWidths
        metrics.rowOffsets = rowOffsets
        metrics.rowHeights = rowHeights

        layout(totalWidth, totalHeight) {
            for (i in placeables.indices) {
                val r = i / columnCount
                val c = i % columnCount
                val p = placeables[i]
                val alignment = alignments.getOrElse(c) { TableAlignment.Left }
                val colWidth = colWidths[c]
                val rowHeight = rowHeights[r]
                val colX = colOffsets[c]
                val rowY = rowOffsets[r]

                val x = when (alignment) {
                    TableAlignment.Left -> colX + hPadPx
                    TableAlignment.Center -> colX + (colWidth - p.width) / 2
                    TableAlignment.Right -> colX + colWidth - hPadPx - p.width
                }
                val y = rowY + (rowHeight - p.height) / 2

                p.placeRelative(x, y)
            }
        }
    }
}

@Composable
private fun MarkdownTableBlock(
    table: MarkdownBlock.Table,
    modifier: Modifier = Modifier,
) {
    if (table.headers.isEmpty() && table.rows.isEmpty()) return

    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val headerBg = if (isDark) Color(0xFF1E222B) else Color(0xFFE8ECF2)
    val zebraBg = if (isDark) Color(0xFF161A22) else Color(0xFFF6F8FA)
    val separatorColor = if (isDark) Color(0x28FFFFFF) else Color(0x18000000)
    val inlineCodeBg = if (isDark) AgentoMarkdownTokens.InlineCodeBgDark else AgentoMarkdownTokens.InlineCodeBgLight
    val inlineCodeText = if (isDark) AgentoMarkdownTokens.InlineCodeTextDark else AgentoMarkdownTokens.InlineCodeTextLight

    val columnCount = maxOf(table.headers.size, table.rows.maxOfOrNull { it.size } ?: 0).coerceAtLeast(1)
    val alignments = remember(table) {
        List(columnCount) { idx ->
            table.alignments.getOrNull(idx) ?: TableAlignment.Left
        }
    }

    val tableBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )
    Surface(
        shape = RoundedCornerShape(16.dp),
        border = tableBorder,
        color = if (isDark) AgentoFrostedTokens.SurfaceLevel1.copy(alpha = 0.88f) else AgentoFrostedTokens.LightSurfaceLevel1.copy(alpha = 0.92f),
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp)),
    ) {
        val horizontalScroll = rememberScrollState()
        Box(modifier = Modifier.fillMaxWidth()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(horizontalScroll),
            ) {
                TableGridLayout(
                    columnCount = columnCount,
                    hasHeader = table.headers.isNotEmpty(),
                    alignments = alignments,
                    headerBg = headerBg,
                    zebraBg = zebraBg,
                    separatorColor = separatorColor,
                    cellHorizontalPadding = 12.dp,
                    cellVerticalPadding = 8.dp,
                    minColumnWidth = 80.dp,
                    minRowHeight = 36.dp,
                ) {
                    // Emit headers
                    if (table.headers.isNotEmpty()) {
                        for (c in 0 until columnCount) {
                            val text = table.headers.getOrElse(c) { "" }
                            AgentoMarkdownText(
                                text = text,
                                style = RagentonversationTypography.TableHeader,
                                color = colors.primaryContent,
                                inlineCodeBg = inlineCodeBg,
                                codeTextColor = inlineCodeText,
                            )
                        }
                    }
                    // Emit rows
                    for (row in table.rows) {
                        for (c in 0 until columnCount) {
                            val text = row.getOrElse(c) { "" }
                            AgentoMarkdownText(
                                text = text,
                                style = markdownTableCellStyle(),
                                color = colors.primaryContent,
                                inlineCodeBg = inlineCodeBg,
                                codeTextColor = inlineCodeText,
                            )
                        }
                    }
                }
            }
            // Quiet scroll affordance for wide tables: fade the trailing edge
            // instead of drawing a border, matching the code block treatment.
            if (horizontalScroll.canScrollForward) {
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterEnd)
                        .width(20.dp)
                        .fillMaxHeight()
                        .background(
                            Brush.horizontalGradient(
                                colors = listOf(Color.Transparent, colors.canvas),
                            ),
                        ),
                )
            }
        }
    }
}

sealed interface ListItem {
    val text: String
    val indentLevel: Int

    data class Unordered(override val text: String, override val indentLevel: Int = 0) : ListItem
    data class Ordered(val number: Int, override val text: String, override val indentLevel: Int = 0) : ListItem
    data class Task(val checked: Boolean, override val text: String, override val indentLevel: Int = 0) : ListItem
}

sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class ListBlock(val items: kotlin.collections.List<ListItem>) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val language: String, val text: String) : MarkdownBlock
    data class Table(
        val headers: kotlin.collections.List<String>,
        val rows: kotlin.collections.List<kotlin.collections.List<String>>,
        val alignments: kotlin.collections.List<TableAlignment> = emptyList(),
    ) : MarkdownBlock
    data class Diagram(val diagramType: String, val source: String) : MarkdownBlock
    data class Math(val formula: String) : MarkdownBlock
    object Divider : MarkdownBlock
}

fun parseBlocks(source: String): kotlin.collections.List<MarkdownBlock> {
    val lines = source.replace("\r\n", "\n").split('\n')
    val blocks = mutableListOf<MarkdownBlock>()
    var index = 0

    while (index < lines.size) {
        val rawLine = lines[index]
        val trimmed = rawLine.trim()

        if (trimmed.isEmpty()) {
            index += 1
            continue
        }

        // 1. Code Fence (```)
        if (trimmed.startsWith("```")) {
            val language = trimmed.removePrefix("```").trim()
            index += 1
            val codeLines = mutableListOf<String>()
            while (index < lines.size && !lines[index].trimStart().startsWith("```")) {
                codeLines.add(lines[index])
                index += 1
            }
            if (index < lines.size) index += 1 // skip closing ```
            val langLower = language.lowercase()
            val fullCode = codeLines.joinToString("\n")
            if (langLower in listOf("mermaid", "flowchart", "graph", "sequencediagram", "statediagram", "classdiagram") ||
                codeLines.firstOrNull()?.trim()?.startsWith("graph ") == true ||
                codeLines.firstOrNull()?.trim()?.startsWith("flowchart ") == true ||
                codeLines.firstOrNull()?.trim()?.startsWith("sequenceDiagram") == true) {
                blocks += MarkdownBlock.Diagram(if (langLower.isNotBlank()) language else "mermaid", fullCode)
            } else if (langLower in listOf("math", "katex", "latex")) {
                blocks += MarkdownBlock.Math(fullCode)
            } else {
                blocks += MarkdownBlock.Code(language, fullCode)
            }
            continue
        }

        // 2. Block Math ($$)
        if (trimmed.startsWith("$$")) {
            if (trimmed.endsWith("$$") && trimmed.length > 4) {
                val formula = trimmed.removePrefix("$$").removeSuffix("$$").trim()
                blocks += MarkdownBlock.Math(formula)
                index += 1
                continue
            } else {
                val mathLines = mutableListOf<String>()
                val firstLine = trimmed.removePrefix("$$").trim()
                if (firstLine.isNotEmpty()) mathLines.add(firstLine)
                index += 1
                while (index < lines.size && !lines[index].trim().endsWith("$$")) {
                    mathLines.add(lines[index])
                    index += 1
                }
                if (index < lines.size) {
                    val lastLine = lines[index].trim().removeSuffix("$$").trim()
                    if (lastLine.isNotEmpty()) mathLines.add(lastLine)
                    index += 1
                }
                blocks += MarkdownBlock.Math(mathLines.joinToString("\n"))
                continue
            }
        }

        // 2. Horizontal Divider (---, ***, ___)
        if (Regex("^(\\-{3,}|\\*{3,}|_{3,})$").matches(trimmed)) {
            blocks += MarkdownBlock.Divider
            index += 1
            continue
        }

        // 3. Headings (# h1 .. ###### h6)
        val headingMatch = Regex("^(#{1,6})\\s+(.+)$").matchEntire(trimmed)
        if (headingMatch != null) {
            val level = headingMatch.groupValues[1].length
            val text = headingMatch.groupValues[2].trim()
            blocks += MarkdownBlock.Heading(level, text)
            index += 1
            continue
        }

        // 4. Blockquote (> ...)
        if (trimmed.startsWith(">")) {
            val quoteLines = mutableListOf<String>()
            while (index < lines.size && lines[index].trimStart().startsWith(">")) {
                quoteLines.add(lines[index].trimStart().removePrefix(">").trim())
                index += 1
            }
            blocks += MarkdownBlock.Quote(quoteLines.joinToString("\n"))
            continue
        }

        // 5. Table (| a | b |)
        if (trimmed.startsWith("|") && trimmed.endsWith("|") && lines.getOrNull(index + 1)?.trim()?.let { Regex("^\\|[\\s\\-:\\|]+\\|$").matches(it) } == true) {
            val headers = splitMarkdownTableRow(trimmed.trim('|'))
            val delimiterLine = lines[index + 1]
            val alignments = parseTableAlignments(delimiterLine)
            index += 2 // skip header and delimiter line
            val rows = mutableListOf<kotlin.collections.List<String>>()
            while (index < lines.size && lines[index].trim().startsWith("|") && lines[index].trim().endsWith("|")) {
                rows.add(splitMarkdownTableRow(lines[index].trim().trim('|')))
                index += 1
            }
            blocks += MarkdownBlock.Table(headers, rows, alignments)
            continue
        }

        // 6. Lists (Unordered, Ordered, Task lists)
        val isListLine = isListItemLine(rawLine)
        if (isListLine) {
            val listItems = mutableListOf<ListItem>()
            while (index < lines.size && isListItemLine(lines[index])) {
                listItems.add(parseListItem(lines[index]))
                index += 1
            }
            blocks += MarkdownBlock.ListBlock(listItems)
            continue
        }

        // 7. Regular Paragraph (accumulate until block boundary or blank line)
        val paragraphLines = mutableListOf<String>()
        while (index < lines.size && lines[index].isNotBlank()) {
            val next = lines[index]
            val nextTrimmed = next.trim()
            if (paragraphLines.isNotEmpty() && (
                nextTrimmed.startsWith("```") ||
                Regex("^(\\-{3,}|\\*{3,}|_{3,})$").matches(nextTrimmed) ||
                Regex("^(#{1,6})\\s+(.+)$").matches(nextTrimmed) ||
                nextTrimmed.startsWith(">") ||
                isListItemLine(next) ||
                Regex("^(=+|-+)$").matches(nextTrimmed) ||
                (nextTrimmed.startsWith("|") && nextTrimmed.endsWith("|"))
            )) {
                break
            }
            paragraphLines.add(nextTrimmed)
            index += 1
        }
        if (paragraphLines.isNotEmpty()) {
            // Setext headings: a paragraph directly followed by an underline of
            // "=" or "-" becomes H1/H2, matching CommonMark and the web (GFM
            // marked) pipeline. A thematic break after a blank line still
            // renders as a Divider.
            val underline = lines.getOrNull(index)?.trim()
            blocks += when {
                underline != null && Regex("^=+$").matches(underline) -> {
                    index += 1
                    MarkdownBlock.Heading(1, paragraphLines.joinToString(" "))
                }
                underline != null && Regex("^-+$").matches(underline) -> {
                    index += 1
                    MarkdownBlock.Heading(2, paragraphLines.joinToString(" "))
                }
                else -> MarkdownBlock.Paragraph(paragraphLines.joinToString("\n"))
            }
        }
    }

    return blocks
}

/**
 * Splits a table row into cells on unescaped pipes only, then unescapes
 * `\|` so cell content containing a literal pipe survives (GFM behaviour).
 */
private fun splitMarkdownTableRow(row: String): List<String> {
    val cells = mutableListOf<String>()
    val current = StringBuilder()
    var escaped = false
    row.trim().forEach { ch ->
        when {
            escaped -> {
                current.append(if (ch == '|') '|' else "\\$ch")
                escaped = false
            }
            ch == '\\' -> escaped = true
            ch == '|' -> {
                cells.add(current.toString().trim())
                current.clear()
            }
            else -> current.append(ch)
        }
    }
    cells.add(current.toString().trim())
    return cells
}

private fun isListItemLine(line: String): Boolean {
    val trimmed = line.trimStart()
    return Regex("^(\\s*[-*+]\\s+\\[[ xX]\\]\\s+.+)$").matches(line) ||
           Regex("^(\\s*\\d+[.)]\\s+\\[[ xX]\\]\\s+.+)$").matches(line) ||
           Regex("^(\\s*[-*+]\\s+.+)$").matches(line) ||
           Regex("^(\\s*\\d+[.)]\\s+.+)$").matches(line)
}

private fun parseListItem(line: String): ListItem {
    val indentSpaces = line.takeWhile { it == ' ' || it == '\t' }.length
    val indentLevel = (indentSpaces / 2).coerceAtMost(3)
    val trimmed = line.trimStart()

    // Task list unordered: "- [ ] task" or "- [x] task"
    val taskUnordered = Regex("^[-*+]\\s+\\[([ xX])\\]\\s+(.+)$").matchEntire(trimmed)
    if (taskUnordered != null) {
        val checked = taskUnordered.groupValues[1].lowercase() == "x"
        return ListItem.Task(checked, taskUnordered.groupValues[2].trim(), indentLevel)
    }

    // Task list ordered: "1. [ ] task"
    val taskOrdered = Regex("^\\d+[.)]\\s+\\[([ xX])\\]\\s+(.+)$").matchEntire(trimmed)
    if (taskOrdered != null) {
        val checked = taskOrdered.groupValues[1].lowercase() == "x"
        return ListItem.Task(checked, taskOrdered.groupValues[2].trim(), indentLevel)
    }

    // Ordered list: "1. item"
    val orderedMatch = Regex("^(\\d+)[.)]\\s+(.+)$").matchEntire(trimmed)
    if (orderedMatch != null) {
        val num = orderedMatch.groupValues[1].toIntOrNull() ?: 1
        return ListItem.Ordered(num, orderedMatch.groupValues[2].trim(), indentLevel)
    }

    // Unordered list: "- item" or "* item"
    val unorderedMatch = Regex("^[-*+]\\s+(.+)$").matchEntire(trimmed)
    val text = unorderedMatch?.groupValues?.get(1)?.trim() ?: trimmed
    return ListItem.Unordered(text, indentLevel)
}

/**
 * Section 9 全要素 Markdown 视觉回归压力测试用例
 */
const val STRESS_TEST_MARKDOWN = """# 1. 架构升级概览 (H1)

Ragent Android 客户端已全面接入 **Ragent Markdown** 排版引擎。这是一段包含 *Italic 辅助说明*、[核心链接](https://ragent.example.test) 以及 `SessionSyncEngine.kt` 行内代码的中英混合排版测试。

## 2. 列表与嵌套体系 (H2)

*   **一级无序列表项**：验证悬挂缩进（Hanging Indent）在多行中文环境下的排版稳定性与中线对齐。
    *   二级嵌套无序项：缩进严格收敛至 14dp，保留横向可用宽度。
    *   二级嵌套代码说明：调用 `StreamingAccumulator.consume()` 触发局部增量重组。
1.  **有序列表第一项**：测试数字标记向右对齐。
2.  **有序列表第二项**：测试连续换行与垂直亲密性间距。

### 3. 代码工作区与引用体验 (H3)

> 引用块设计：使用 2.5dp 低 Alpha 装饰条与极轻底色，彻底移除传统粗黑描边。

```kotlin
// AgentoMarkdownPipeline.kt
class AgentoMarkdownPipeline(
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default
) {
    fun parseStreamIncremental(rawText: String): Flow<MarkdownBlockAst> = flow {
        val stableBlocks = splitCompletedBlocks(rawText)
        emit(stableBlocks)
    }.flowOn(dispatcher)
}
```

```python
# 验证 Python 多语言代码块与长行横向滚动
def calculate_stream_rhythm(tokens: list[str], max_line_width_dp: float = 390.0) -> dict:
    return {"status": "success", "baseline_locked": True, "zero_outline": True, "token_count": len(tokens)}
```

---

### 4. 窄屏表格数据展示

| 模块组件 | 目标字号 / 行高 | 描边策略 | 空间优化特性 |
| :--- | :---: | :---: | :--- |
| **Inline Code** | `14sp` / `25sp` | **Zero-Outline** | 锁定 CJK 基线，无垂直抖动 |
| **Code Block** | `13.5sp` / `20sp` | **Zero-Outline** | 独立横向滑动容器，带语言栏与复制 |
| **Nested List** | `16sp` / `25sp` | 无边框 | 14dp 紧凑嵌套缩进，拒绝挤压空间 |

这是一个用于验证超长段落阅读体验的测试结尾。在 390dp 移动端屏幕上，连续多行的文本应该呈现出均匀、平稳、无视觉噪声的阅读流，段落之间有清晰的 10dp 呼吸间距，使开发者与用户在长时间监控 Agent 执行长篇任务时保持舒适与专注。"""

@androidx.compose.ui.tooling.preview.Preview(name = "agent-markdown-stress-light", showBackground = true, widthDp = 390)
@Composable
private fun AgentMarkdownStressLightPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(markdown = STRESS_TEST_MARKDOWN)
        }
    }
}

@androidx.compose.ui.tooling.preview.Preview(name = "agent-markdown-stress-dark", showBackground = true, widthDp = 390)
@Composable
private fun AgentMarkdownStressDarkPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme(darkTheme = true) {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(markdown = STRESS_TEST_MARKDOWN)
        }
    }
}

/**
 * 跨行 inline code 专项压力样本：长 SHA、长 URL、文件路径、中英混排。
 * 用于验证 slice 语义分段背景在窄屏（390dp）换行后的连续性与圆角归属。
 */
const val INLINE_CODE_WRAP_MARKDOWN = """## 跨行 Inline Code 验证

提交 `9f8e7d6c5b4a392817065544332211ffeeddccbbaa99887766554433221100` 已合入 main 分支，触发完整回归。

文档地址是 `https://ragent.example.com/projects/pinggu-workspace/sessions/1699cfb2549ea7bad55089c68a5e5dee/events?offset=1280&filter=tool_calls` 请查收。

改动集中在 `android/core/agentui/src/main/kotlin/com/andysagent/ragent/core/agentui/AgentMarkdown.kt` 与 `static/chat/chat-messages.css` 两处。

中英混排场景：当 `StreamingAccumulator.consume(token)` 在长中文段落中间被换行切断时，背景条带必须保持连续，不能出现漂浮碎片。

单行短码 `ok` 与行尾代码 `edge_case()` 不应受影响。"""

@androidx.compose.ui.tooling.preview.Preview(name = "inline-code-wrap-light", showBackground = true, widthDp = 390)
@Composable
private fun InlineCodeWrapLightPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(markdown = INLINE_CODE_WRAP_MARKDOWN)
        }
    }
}

@androidx.compose.ui.tooling.preview.Preview(name = "inline-code-wrap-dark", showBackground = true, widthDp = 390)
@Composable
private fun InlineCodeWrapDarkPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme(darkTheme = true) {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(markdown = INLINE_CODE_WRAP_MARKDOWN)
        }
    }
}

@androidx.compose.ui.tooling.preview.Preview(name = "agent-markdown-light", showBackground = true, widthDp = 390)
@Composable
private fun AgentMarkdownLightPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(
                markdown = """
                    我检查了登录流程，主要有两个问题。

                    ### 1. Token 刷新逻辑

                    `refreshToken()` 在网络异常时缺少指数退避，容易导致风暴重试。

                    ```kotlin
                    suspend fun refreshToken(force: Boolean = false): AuthToken {
                        val client = clientProvider.get()
                        return client.refreshToken(force)
                    }
                    ```

                    > 注意：修改远程配置时请务必确认 scope 权限，避免影响线上已有鉴权会话。

                    - [x] 修复重试逻辑
                    - [ ] 增加单元测试覆盖
                    - 关联模块：
                      - `AuthRepository.kt`
                      - `NetworkMonitor.kt`

                    | 步骤 | 状态 | 耗时 |
                    | --- | --- | --- |
                    | 语法检查 | 通过 | 12ms |
                    | 单元测试 | 通过 | 380ms |

                    ---

                    修改完成，请查看上述文件及测试建议。
                """.trimIndent(),
            )
        }
    }
}

@androidx.compose.ui.tooling.preview.Preview(name = "agent-markdown-dark", showBackground = true, widthDp = 390)
@Composable
private fun AgentMarkdownDarkPreview() {
    com.andysagent.ragent.core.designsystem.RagentTheme(darkTheme = true) {
        Surface(
            color = LocalRagentColors.current.canvas,
            modifier = Modifier.padding(16.dp),
        ) {
            AgentMarkdown(
                markdown = """
                    问题已定位在 `SessionRepository.kt` 的并发连接竞争。

                    ### 修复方案

                    当并发调用 `connect()` 时引入互斥锁进行串行化。

                    ```kotlin
                    class SessionRepository(private val mutex: Mutex = Mutex()) {
                        suspend fun connect(target: String) = mutex.withLock {
                            doConnect(target)
                        }
                    }
                    ```

                    > 提示：保持轻量无锁读路径，只有在状态变更时加锁。
                """.trimIndent(),
            )
        }
    }
}
