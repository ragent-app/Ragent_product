// Ported from com.mikepenz:multiplatform-markdown-renderer (Apache-2.0),
// files: utils/EntityConverter.kt, utils/Extensions.kt (subset) and
// annotator/AnnotatedStringKtx.kt — the upstream inline Markdown →
// AnnotatedString pipeline, trimmed to the dependencies actually needed by
// Ragent's chat renderer (no image transformer / reference links).
package com.andysagent.ragent.core.agentui.markdown

import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.ast.LeafASTNode
import org.intellij.markdown.ast.CompositeASTNode
import org.intellij.markdown.ast.getTextInNode
import org.intellij.markdown.flavours.MarkdownFlavourDescriptor
import org.intellij.markdown.flavours.gfm.GFMElementTypes
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.flavours.gfm.GFMTokenTypes
import org.intellij.markdown.parser.MarkdownParser
import org.intellij.markdown.html.entities.Entities

/** Tag used to indicate an image url for inline content. Required for rendering. */
const val MARKDOWN_TAG_IMAGE_URL = "MARKDOWN_IMAGE_URL"

object EntityConverter {
    private const val ESCAPE_ALLOWED_STRING = """!"#\$%&'\(\)\*\+,\-.\/:;<=>\?@\[\\\]\^_`{\|}~"""
    private val REGEX = Regex("""&(?:([a-zA-Z0-9]+)|#([0-9]{1,8})|#[xX]([a-fA-F0-9]{1,8}));|(["&<>])""")
    private val REGEX_ESCAPES = Regex("${REGEX.pattern}|\\\\([$ESCAPE_ALLOWED_STRING])")

    fun replaceEntities(
        text: CharSequence,
        processEntities: Boolean,
        processEscapes: Boolean,
    ): String {
        val regex = if (processEscapes) REGEX_ESCAPES else REGEX
        return regex.replace(text) { match ->
            val g = match.groups
            when {
                g.size > 5 && g[5] != null -> g[5]!!.value[0].toString()
                g[4] != null -> match.value
                else -> {
                    val code = when {
                        !processEntities -> null
                        g[1] != null -> Entities.map[match.value]
                        g[2] != null -> g[2]!!.value.toInt()
                        g[3] != null -> g[3]!!.value.toInt(16)
                        else -> null
                    }
                    code?.toChar()?.toString() ?: "&${match.value.substring(1)}"
                }
            }
        }
    }
}

internal fun ASTNode.getUnescapedTextInNode(allFileText: CharSequence): String {
    val escapedText = getTextInNode(allFileText).toString()
    return EntityConverter.replaceEntities(
        escapedText,
        processEntities = false,
        processEscapes = true
    )
}

/** Helper function to drop the first and last element in the children list. */
internal fun List<ASTNode>.innerList(): List<ASTNode> = this.subList(1, this.size - 1)

internal fun List<ASTNode>.mapAutoLinkToType(targetType: org.intellij.markdown.IElementType = MarkdownTokenTypes.TEXT): List<ASTNode> {
    return map {
        if (it is LeafASTNode) {
            if (
                it.type == GFMTokenTypes.GFM_AUTOLINK ||
                it.type == MarkdownElementTypes.AUTOLINK ||
                it.type == MarkdownTokenTypes.EMAIL_AUTOLINK
            ) {
                LeafASTNode(targetType, it.startOffset, it.endOffset)
            } else {
                it
            }
        } else if (it is CompositeASTNode) {
            CompositeASTNode(it.type, it.children.mapAutoLinkToType(targetType))
        } else {
            it
        }
    }
}

/**
 * Upstream inline annotator settings, reduced to the pieces Ragent needs.
 * The annotator hook and reference link handler were dropped because the chat
 * renderer neither intercepts nodes nor resolves reference-style links.
 */
class AgentMarkdownAnnotatorSettings(
    val linkTextSpanStyle: TextLinkStyles,
    val codeSpanStyle: SpanStyle,
    val linkInteractionListener: LinkInteractionListener? = null,
)

/**
 * Extension function to build an `AnnotatedString` from a Markdown string.
 * This function will parse the Markdown content and apply the given styles to the text.
 *
 * It only supports TEXT and PARAGRAPH nodes.
 */
fun String.buildMarkdownAnnotatedString(
    style: TextStyle,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
    flavour: MarkdownFlavourDescriptor = GFMFlavourDescriptor(),
): AnnotatedString {
    val content = this
    val parsedTree = MarkdownParser(flavour).buildMarkdownTreeFromString(content)
    val textNode = parsedTree.children.firstOrNull { node ->
        node.type == MarkdownTokenTypes.TEXT || node.type == MarkdownElementTypes.PARAGRAPH
    }
    if (textNode == null) return buildAnnotatedString { }
    return content.buildMarkdownAnnotatedString(
        textNode = textNode,
        style = style,
        annotatorSettings = annotatorSettings
    )
}

fun String.buildMarkdownAnnotatedString(
    textNode: ASTNode,
    style: TextStyle,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
): AnnotatedString = buildAnnotatedString {
    pushStyle(style.toSpanStyle())
    buildMarkdownAnnotatedString(this@buildMarkdownAnnotatedString, textNode, annotatorSettings)
    pop()
}

/**
 * Appends a Markdown link to the `AnnotatedString.Builder`.
 */
fun AnnotatedString.Builder.appendMarkdownLink(
    content: String,
    node: ASTNode,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) {
    val linkText = node.findChildOfTypeList(MarkdownElementTypes.LINK_TEXT)?.children?.innerList()
    if (linkText == null) {
        append(node.getUnescapedTextInNode(content))
        return
    }
    val text = linkText.firstOrNull()?.getUnescapedTextInNode(content)
    val destination = node.findChildOfTypeList(MarkdownElementTypes.LINK_DESTINATION)?.getUnescapedTextInNode(content)

    if (destination != null && text != null) {
        withLink(LinkAnnotation.Url(destination, annotatorSettings.linkTextSpanStyle, annotatorSettings.linkInteractionListener)) {
            buildMarkdownAnnotatedString(content, linkText.mapAutoLinkToType(), annotatorSettings)
        }
    } else {
        buildMarkdownAnnotatedString(content, linkText, annotatorSettings)
    }
}

/** Minimal stand-in for the upstream `findChildOfType` helper. */
private fun ASTNode.findChildOfTypeList(type: org.intellij.markdown.IElementType): ASTNode? {
    children.forEach {
        if (it.type == type) return it
    }
    return null
}

private fun ASTNode.findDescendantOfType(type: org.intellij.markdown.IElementType): ASTNode? {
    if (this.type == type) return this
    children.forEach { child ->
        child.findDescendantOfType(type)?.let { return it }
    }
    return null
}

/**
 * Chat messages do not render remote images. Degrade readably instead of
 * dropping the node: the alt text becomes a link to the destination (or the
 * destination itself when there is no alt text), so no structure is lost
 * silently. Native image rendering needs an explicit loading/safety contract
 * and stays out of scope for the text renderer.
 */
private fun AnnotatedString.Builder.appendMarkdownImageFallback(
    content: String,
    node: ASTNode,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) {
    val altText = node.findDescendantOfType(MarkdownElementTypes.LINK_TEXT)
        ?.children?.innerList()?.firstOrNull()?.getUnescapedTextInNode(content)
    val destination = node.findDescendantOfType(MarkdownElementTypes.LINK_DESTINATION)
        ?.getUnescapedTextInNode(content)

    if (destination == null) {
        if (!altText.isNullOrEmpty()) append(altText)
        return
    }
    withLink(
        LinkAnnotation.Url(destination, annotatorSettings.linkTextSpanStyle, annotatorSettings.linkInteractionListener),
    ) {
        append(altText?.takeIf { it.isNotBlank() } ?: destination)
    }
}

/**
 * Appends an auto-detected link to the `AnnotatedString.Builder`.
 */
fun AnnotatedString.Builder.appendAutoLink(
    content: String,
    node: ASTNode,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) {
    val targetNode = node.children.firstOrNull {
        it.type.name == MarkdownElementTypes.AUTOLINK.name
    } ?: node
    val destination = targetNode.getUnescapedTextInNode(content)

    withLink(LinkAnnotation.Url(destination, annotatorSettings.linkTextSpanStyle, linkInteractionListener = annotatorSettings.linkInteractionListener)) {
        append(destination)
    }
}

/**
 * Appends an email auto-link without its surrounding angle brackets.
 */
private fun AnnotatedString.Builder.appendEmailAutoLink(
    content: String,
    node: ASTNode,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) {
    val email = node.getUnescapedTextInNode(content)
    val destination = "mailto:$email"

    withLink(LinkAnnotation.Url(destination, annotatorSettings.linkTextSpanStyle, linkInteractionListener = annotatorSettings.linkInteractionListener)) {
        append(email)
    }
}

/**
 * Builds an [AnnotatedString] with the contents of the given Markdown [ASTNode] node.
 *
 * This method automatically constructs the string with child components like:
 * - Paragraph
 * - Image
 * - Strong
 * - ...
 */
fun AnnotatedString.Builder.buildMarkdownAnnotatedString(
    content: String,
    node: ASTNode,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) = buildMarkdownAnnotatedString(
    content = content,
    children = node.children,
    annotatorSettings = annotatorSettings,
)

fun AnnotatedString.Builder.buildMarkdownAnnotatedString(
    content: String,
    children: List<ASTNode>,
    annotatorSettings: AgentMarkdownAnnotatorSettings,
) {
    val eolAsNewLine = false
    var skipIfNext: Any? = null
    children.forEachIndexed { index, child ->
        if (skipIfNext == null || skipIfNext != child.type) {
            val parentType = child.parent?.type

            when (child.type) {
                // Element types
                MarkdownElementTypes.PARAGRAPH -> buildMarkdownAnnotatedString(content = content, node = child, annotatorSettings = annotatorSettings)

                MarkdownElementTypes.IMAGE -> appendMarkdownImageFallback(content, child, annotatorSettings)

                MarkdownElementTypes.EMPH -> {
                    pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    buildMarkdownAnnotatedString(content, child, annotatorSettings)
                    pop()
                }

                MarkdownElementTypes.STRONG -> {
                    // Strong text should establish hierarchy without becoming a
                    // second headline inside a conversational paragraph.
                    pushStyle(SpanStyle(fontWeight = FontWeight(600)))
                    buildMarkdownAnnotatedString(content, child, annotatorSettings)
                    pop()
                }

                GFMElementTypes.STRIKETHROUGH -> {
                    pushStyle(SpanStyle(textDecoration = TextDecoration.LineThrough))
                    buildMarkdownAnnotatedString(content, child, annotatorSettings)
                    pop()
                }

                MarkdownElementTypes.CODE_SPAN -> {
                    pushStyle(annotatorSettings.codeSpanStyle)
                    buildMarkdownAnnotatedString(content, child.children.innerList(), annotatorSettings)
                    pop()
                }

                MarkdownElementTypes.AUTOLINK -> appendAutoLink(content, child, annotatorSettings)
                MarkdownElementTypes.INLINE_LINK -> appendMarkdownLink(content, child, annotatorSettings)
                MarkdownElementTypes.SHORT_REFERENCE_LINK -> append(child.getUnescapedTextInNode(content))
                MarkdownElementTypes.FULL_REFERENCE_LINK -> append(child.getUnescapedTextInNode(content))

                // Token Types
                MarkdownTokenTypes.TEXT -> append(child.getUnescapedTextInNode(content))
                MarkdownTokenTypes.EMAIL_AUTOLINK -> if (parentType == MarkdownElementTypes.LINK_TEXT) {
                    append(child.getUnescapedTextInNode(content))
                } else appendEmailAutoLink(content, child, annotatorSettings)

                GFMTokenTypes.GFM_AUTOLINK -> if (parentType == MarkdownElementTypes.LINK_TEXT) {
                    append(child.getUnescapedTextInNode(content))
                } else appendAutoLink(content, child, annotatorSettings)

                GFMTokenTypes.DOLLAR -> append('$')

                MarkdownTokenTypes.SINGLE_QUOTE -> append('\'')
                MarkdownTokenTypes.DOUBLE_QUOTE -> append('\"')
                MarkdownTokenTypes.LPAREN -> append('(')
                MarkdownTokenTypes.RPAREN -> append(')')
                MarkdownTokenTypes.LBRACKET -> append('[')
                MarkdownTokenTypes.RBRACKET -> append(']')
                // Email auto-links are parsed as sibling LT, EMAIL_AUTOLINK, and GT tokens.
                MarkdownTokenTypes.LT -> if (children.getOrNull(index + 1)?.type != MarkdownTokenTypes.EMAIL_AUTOLINK) append('<')
                MarkdownTokenTypes.GT -> if (children.getOrNull(index - 1)?.type != MarkdownTokenTypes.EMAIL_AUTOLINK) append('>')
                MarkdownTokenTypes.COLON -> append(':')
                MarkdownTokenTypes.EXCLAMATION_MARK -> append('!')
                MarkdownTokenTypes.BACKTICK -> append('`')
                MarkdownTokenTypes.HARD_LINE_BREAK -> {
                    append('\n')
                    skipIfNext = MarkdownTokenTypes.EOL
                }

                MarkdownTokenTypes.EMPH -> {
                    if (parentType != MarkdownElementTypes.EMPH && parentType != MarkdownElementTypes.STRONG) {
                        append(child.getTextInNode(content))
                    }
                }

                MarkdownTokenTypes.EOL -> if (eolAsNewLine) append('\n') else append(' ')
                MarkdownTokenTypes.WHITE_SPACE -> if (length > 0) append(' ')
                MarkdownTokenTypes.BLOCK_QUOTE -> {
                    skipIfNext = MarkdownTokenTypes.WHITE_SPACE
                }

                else -> {
                    // `~` is not a specific `MarkdownTokenTypes`
                    if (child.type.name == "~" && parentType != GFMElementTypes.STRIKETHROUGH) {
                        append(child.getTextInNode(content))
                    }
                }
            }
        } else {
            skipIfNext = null
        }
    }
}
