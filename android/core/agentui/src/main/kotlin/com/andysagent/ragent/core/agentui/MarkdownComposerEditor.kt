package com.andysagent.ragent.core.agentui

import com.andysagent.ragent.core.designsystem.LocalRagentColors

import android.content.ClipboardManager
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.content.MediaType
import androidx.compose.foundation.content.ReceiveContentListener
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.content.hasMediaType
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.input.key.type
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.mohamedrejeb.richeditor.model.RichTextState
import com.mohamedrejeb.richeditor.model.rememberRichTextState
import com.mohamedrejeb.richeditor.ui.BasicRichTextEditor
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first

/**
 * Ragent's adapter around the open-source Compose Rich Editor.
 *
 * The library owns Markdown parsing, rich-text editing, selection/IME handling,
 * clipboard behavior, undo/redo, and Markdown serialization. This wrapper only
 * bridges its [RichTextState] to the existing String-based composer contract so
 * the workbench does not need to know which editor library is in use.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MarkdownComposerEditor(
    value: String,
    onValueChange: (String) -> Unit,
    onPasteImage: (List<Uri>) -> Unit = {},
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = false,
    selectionActive: Boolean = true,
    maxLines: Int = Int.MAX_VALUE,
    textStyle: TextStyle,
    cursorBrush: Brush = SolidColor(LocalRagentColors.current.accentPrimary),
    isDark: Boolean,
    scrollState: ScrollState = rememberScrollState(),
    onTextLayout: (TextLayoutResult) -> Unit = {},
    onContentSizeChange: (IntSize) -> Unit = {},
    onFirstLineSizeChange: (Int) -> Unit = {},
    decorationBox: @Composable (@Composable () -> Unit) -> Unit = { innerTextField -> innerTextField() },
) {
    val state = rememberRichTextState()
    val selectionRetention = remember { ComposerSelectionRetention() }
    // Observe selection in composition, not only inside SideEffect. The rich
    // field can update its own selection without changing the Markdown value.
    val editingSelection = state.selection
    // rc10's singleParagraph flag changes its mutation algorithm, not just
    // layout. Parsed Markdown owns multiple RichParagraphs and must use the
    // multi-paragraph deletion/merge path. Plain drafts keep literal newlines.
    var plainDocumentMode by remember { mutableStateOf(!composerHasMarkup(value)) }
    var renderedPlainDocumentMode by remember { mutableStateOf(plainDocumentMode) }
    suspend fun awaitEditorMode(plain: Boolean) {
        plainDocumentMode = plain
        // An external document can change the mode after initial composition.
        // Wait until that mode has actually reached the child, then allow its
        // LaunchedEffect to run before installing the new paragraph tree.
        snapshotFlow { renderedPlainDocumentMode }.first { it == plain }
        withFrameNanos { }
    }
    val currentValue by rememberUpdatedState(value)
    val currentOnValueChange by rememberUpdatedState(onValueChange)
    val currentOnPasteImage by rememberUpdatedState(onPasteImage)
    var initialized by remember { mutableStateOf(false) }
    var lastEmittedValue by remember { mutableStateOf<String?>(null) }
    var applyingExternalValue by remember { mutableStateOf(false) }
    val pendingEchoes = remember { ComposerDraftEchoes() }
    var textLayoutResult by remember { mutableStateOf<TextLayoutResult?>(null) }
    // The child can relayout its document without recomposing this wrapper.
    // Subscribe here: a read only in SideEffect misses those updates and keeps
    // the pre-fullscreen height until the inline modifier changes on return.
    val observedTextLayout = textLayoutResult
    val currentOnTextLayout by rememberUpdatedState(onTextLayout)
    val currentOnContentSizeChange by rememberUpdatedState(onContentSizeChange)
    val currentOnFirstLineSizeChange by rememberUpdatedState(onFirstLineSizeChange)
    val density = LocalDensity.current
    // rc10 Code draws 2sp beyond the glyph box plus half a 1sp stroke.
    // Reserve 3sp INSIDE the rich-span drawing node, not merely outside it.
    // Focused TextField layers can clip drawing outside their own bounds
    // even when the outer scroll viewport has enough empty padding.
    // Plain documents retain their small inset and five-line capacity.
    val decorationInset = if (singleLine || plainDocumentMode) 0.dp else with(density) { 3.sp.toDp() }
    val bottomInset = if (singleLine) 0.dp else maxOf(2.dp, decorationInset)
    val richContentPadding = PaddingValues(top = decorationInset, bottom = bottomInset)
    val clipboardManager = LocalContext.current.getSystemService(ClipboardManager::class.java)
    val imagePasteReceiver = remember {
        ReceiveContentListener { transferableContent ->
            if (!transferableContent.hasMediaType(MediaType.Image)) {
                return@ReceiveContentListener transferableContent
            }

            val clipData = transferableContent.clipEntry.clipData
            val clipUris = buildList {
                for (index in 0 until clipData.itemCount) {
                    clipData.getItemAt(index).uri?.let(::add)
                }
            }
            val imageUris = buildList {
                addAll(clipUris)
                transferableContent.platformTransferableContent?.linkUri?.let(::add)
            }.distinct()
            if (imageUris.isEmpty()) {
                return@ReceiveContentListener transferableContent
            }

            currentOnPasteImage(imageUris)
            if (clipUris.isNotEmpty()) {
                transferableContent.consume { item -> item.uri != null }
            } else {
                // InputConnection#commitContent can expose the image only through
                // platformTransferableContent.linkUri. Consume the event so the
                // editor does not insert an opaque fallback string as text.
                null
            }
        }
    }

    // The parent still owns the serialized Markdown string. Load only genuine
    // external changes (session switch, draft restore, edit/resend), not the
    // callback echo produced by this editor itself.
    LaunchedEffect(value) {
        if (initialized && (pendingEchoes.acknowledge(value) || value == lastEmittedValue)) {
            return@LaunchedEffect
        }
        pendingEchoes.clear()
        selectionRetention.discard()
        applyingExternalValue = true
        try {
            awaitEditorMode(plain = !composerHasMarkup(currentValue))
            loadEditorDocument(state, currentValue)
            lastEmittedValue = state.toMarkdown()
            initialized = true
        } finally {
            applyingExternalValue = false
        }
    }

    LaunchedEffect(state) {
        // Include the annotated text in the observed snapshot. The library's Markdown decoder
        // walks its paragraph tree, while annotatedString is the state that BasicTextField
        // publishes to semantics and paint; observing both keeps this bridge reliable on every
        // editor update.
        snapshotFlow {
            EditorDocumentSnapshot(
                visibleText = state.annotatedString.text,
                markdown = state.toMarkdown(),
                composing = state.composition != null,
                ready = initialized && !applyingExternalValue,
            )
        }
            .distinctUntilChanged()
            .collect { (visibleText, markdown, composing, ready) ->
                if (!ready) return@collect

                // Compose Rich Editor parses Markdown supplied through setMarkdown(), but typed
                // delimiters are otherwise treated as literal text. Normalize a completed
                // Markdown run back through the library so the editor remains WYSIWYG while
                // the parent still receives the lossless Markdown source.
                // Parsing trims paragraph whitespace. That alone is NOT a
                // formatting change and must never restart the IME's document.
                // Composition completion is observed even when Markdown did
                // not change, so CJK/preedit text can be normalized only after
                // the IME has committed it.
                if (!composing && visibleText == markdown && !composerRequiresLiteralMarkdown(markdown)) {
                    val parsed = RichTextState().setMarkdown(markdown)
                    if (hasComposerMarkupTransformation(markdown, parsed.toText())) {
                        applyingExternalValue = true
                        try {
                            awaitEditorMode(plain = false)
                            // The IME can commit more text while the mode is
                            // being applied. Never normalize an older snapshot
                            // over a newer edit or an active composition.
                            if (state.composition != null || state.toMarkdown() != markdown) return@collect
                            val oldText = state.toText()
                            val selection = state.selection
                            state.setMarkdown(markdown)
                            state.selection = androidx.compose.ui.text.TextRange(
                                mapNormalizedOffset(selection.start, oldText, parsed.toText()),
                                mapNormalizedOffset(selection.end, oldText, parsed.toText()),
                            )
                            if (selection.collapsed && selection.end == oldText.length) {
                                // Typing a closing delimiter finishes that run.
                                state.clearSpanStyles()
                                state.clearRichSpans()
                            }
                        } finally {
                            applyingExternalValue = false
                        }
                    }
                }

                if (markdown == lastEmittedValue) return@collect
                lastEmittedValue = markdown
                pendingEchoes.record(markdown)
                currentOnValueChange(markdown)
            }
    }

    val caretLayout = remember(state, scrollState) { ComposerCaretLayout() }
    val viewportModifier = if (singleLine) modifier else modifier.layout { measurable, constraints ->
        val placeable = measurable.measure(constraints)
        // verticalScroll has measured its content/maxValue by this point.
        // Move the caret in the same layout, before scroll placement reads the
        // offset. An onSizeChanged -> effect round trip exposes one clipped
        // frame whenever fullscreen/IME changes the viewport height.
        val snapshot = CaretVisibilitySnapshot(
                selection = state.selection,
                textLayoutResult = textLayoutResult,
                viewportHeight = placeable.height,
                maxScroll = scrollState.maxValue,
                topInset = decorationInset.roundToPx(),
            )
        if (caretLayout.last != snapshot) {
            caretLayout.last = snapshot
            val result = snapshot.textLayoutResult
            if (result != null && snapshot.viewportHeight > 0 && snapshot.maxScroll > 0) {
                val offset = snapshot.selection.end.coerceIn(0, result.layoutInput.text.length)
                val target = composerCaretScrollTarget(
                    cursor = result.getCursorRect(offset),
                    topInset = snapshot.topInset,
                    viewportHeight = snapshot.viewportHeight,
                    currentScroll = scrollState.value,
                    maxScroll = snapshot.maxScroll,
                )
                scrollState.dispatchRawDelta((target - scrollState.value).toFloat())
            }
        }
        layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
    }

    val scrollModifier = if (singleLine) {
        viewportModifier.horizontalScroll(scrollState)
    } else {
        viewportModifier.verticalScroll(scrollState)
    }

    val clipboardImagePasteModifier = Modifier.onPreviewKeyEvent { event ->
        val isPasteKey = event.key == Key.Paste ||
            (event.key == Key.V && (event.isCtrlPressed || event.isMetaPressed))
        if (event.type != KeyEventType.KeyDown || !isPasteKey) return@onPreviewKeyEvent false

        val imageUris = clipboardImageUris(clipboardManager)
        if (imageUris.isEmpty()) return@onPreviewKeyEvent false

        // Rich Editor currently wraps the value-based BasicTextField API, which cannot
        // participate in AndroidX's contentReceiver paste path. Handle the keyboard/context
        // menu paste command here while leaving ordinary text paste to the editor.
        currentOnPasteImage(imageUris)
        true
    }

    val textToolbar = LocalTextToolbar.current
    val imageAwareTextToolbar = remember(textToolbar, clipboardManager) {
        object : TextToolbar {
            override fun showMenu(
                rect: Rect,
                onCopyRequested: (() -> Unit)?,
                onPasteRequested: (() -> Unit)?,
                onCutRequested: (() -> Unit)?,
                onSelectAllRequested: (() -> Unit)?,
            ) {
                val imageUris = clipboardImageUris(clipboardManager)
                val imagePaste = imageUris.takeIf { it.isNotEmpty() }?.let { uris ->
                    { currentOnPasteImage(uris) }
                }
                textToolbar.showMenu(
                    rect = rect,
                    onCopyRequested = onCopyRequested,
                    onPasteRequested = imagePaste ?: onPasteRequested,
                    onCutRequested = onCutRequested,
                    onSelectAllRequested = onSelectAllRequested,
                )
            }

            override fun hide() = textToolbar.hide()

            override val status: TextToolbarStatus
                get() = textToolbar.status
        }
    }

    var isEditorFocused by remember { mutableStateOf(false) }
    val focusChangeModifier = Modifier.onFocusChanged { focusState ->
        if (focusState.isFocused && !isEditorFocused) {
            val currentLen = state.toText().length
            if (currentLen > 0 && state.selection.start == 0 && state.selection.end == 0) {
                state.selection = androidx.compose.ui.text.TextRange(currentLen)
            }
        }
        isEditorFocused = focusState.isFocused
    }

    LaunchedEffect(selectionActive, isEditorFocused) {
        if (selectionActive && selectionRetention.selectionToRestore(state.toText().length) != null) {
            // Restore after the field has applied its focus/constraint change.
            // Keep the pending range while unfocused, so entering the reopened
            // editor cannot collapse it a second time during focus setup.
            withFrameNanos { }
            selectionRetention.selectionToRestore(state.toText().length)?.let { selection ->
                state.selection = selection
                if (isEditorFocused) selectionRetention.restored(selection)
            }
        }
    }

    CompositionLocalProvider(LocalTextToolbar provides imageAwareTextToolbar) {
        snapshotRichTextTransformation(state)
        BasicRichTextEditor(
            state = state,
            modifier = scrollModifier
                .then(focusChangeModifier)
                .then(clipboardImagePasteModifier)
                .contentReceiver(imagePasteReceiver),
            enabled = enabled,
            readOnly = !enabled,
            singleParagraph = plainDocumentMode,
            textStyle = textStyle,
            singleLine = singleLine,
            maxLines = maxLines,
            onTextLayout = { result ->
                textLayoutResult = result
                currentOnTextLayout(result)
            },
            cursorBrush = cursorBrush,
            decorationBox = { innerTextField ->
                Box(Modifier.padding(richContentPadding)) { decorationBox(innerTextField) }
            },
            // rc10 uses this offset for both span drawing and pointer mapping.
            // Keep it identical to the actual inner-field padding above.
            contentPadding = richContentPadding,
        )
        SideEffect {
            selectionRetention.observe(selectionActive, isEditorFocused, editingSelection)
            renderedPlainDocumentMode = plainDocumentMode
            observedTextLayout?.let { result ->
                if (result.lineCount > 0) currentOnFirstLineSizeChange(
                    kotlin.math.ceil(result.getLineBottom(0)).toInt() +
                        with(density) { decorationInset.roundToPx() + bottomInset.roundToPx() },
                )
                // Scroll content can inherit fullscreen's minimum height.
                // Report the natural paragraph height, not that forced box,
                // so a shortened draft has the correct inline return target.
                currentOnContentSizeChange(IntSize(
                    result.size.width,
                    (if (result.lineCount > 0) kotlin.math.ceil(result.getLineBottom(result.lineCount - 1)).toInt() else 0) +
                        with(density) { decorationInset.roundToPx() + bottomInset.roundToPx() },
                ))
            }
        }
    }
}

private data class CaretVisibilitySnapshot(
    val selection: androidx.compose.ui.text.TextRange,
    val textLayoutResult: TextLayoutResult?,
    val viewportHeight: Int,
    val maxScroll: Int,
    val topInset: Int,
)

private class ComposerCaretLayout {
    var last: CaretVisibilitySnapshot? = null
}

/** Preserve manual scrolling until the selection, document, or viewport changes. */
internal fun composerCaretScrollTarget(
    cursor: Rect,
    topInset: Int,
    viewportHeight: Int,
    currentScroll: Int,
    maxScroll: Int,
): Int {
    val margin = minOf(cursor.height, ((viewportHeight - cursor.height) / 2f).coerceAtLeast(0f))
    val top = cursor.top + topInset
    val bottom = cursor.bottom + topInset
    return when {
        bottom > currentScroll + viewportHeight - margin -> kotlin.math.ceil(bottom + margin - viewportHeight).toInt()
        top < currentScroll + margin -> kotlin.math.floor(top - margin).toInt()
        else -> currentScroll
    }.coerceIn(0, maxScroll.coerceAtLeast(0))
}

private data class EditorDocumentSnapshot(
    val visibleText: String,
    val markdown: String,
    val composing: Boolean,
    val ready: Boolean,
)

/**
 * Loads [markdown] into [state], keeping plain documents on the editor's
 * single-paragraph text path. The library decodes Markdown into one paragraph
 * per line and renders those paragraphs through ParagraphStyle spans that
 * ignore the base text style's lineHeight, so a decoded document collapses to
 * the font's default line height. A plain document has nothing to decode: it
 * loads as text with real newlines in the text model and renders at the
 * requested line height.
 */
private suspend fun loadEditorDocument(
    state: RichTextState,
    markdown: String,
    moveCursorToEnd: Boolean = true,
) {
    // Wait for BasicRichTextEditor's mode effect before installing the
    // document. Plain and parsed documents have different mutation contracts.
    withFrameNanos { }
    if (composerHasMarkup(markdown)) {
        state.setMarkdown(markdown)
        withFrameNanos { }
        if (moveCursorToEnd) {
            val length = state.toText().length
            state.selection = androidx.compose.ui.text.TextRange(length)
        }
        return
    }

    // setText edits the existing tree; it does not replace that tree. Discard
    // the previous external document's paragraph/style structure first so a
    // plain replacement cannot leave formatted spans with stale text ranges.
    state.setMarkdown("")
    state.setText(markdown)
    if (moveCursorToEnd) {
        val length = state.toText().length
        state.selection = androidx.compose.ui.text.TextRange(length)
    } else {
        state.selection = androidx.compose.ui.text.TextRange(0)
    }
}

private fun clipboardImageUris(clipboardManager: ClipboardManager?): List<Uri> {
    val clipData = runCatching { clipboardManager?.primaryClip }.getOrNull() ?: return emptyList()
    if (!clipData.description.hasMimeType("image/*")) return emptyList()
    return buildList {
        for (index in 0 until clipData.itemCount) {
            clipData.getItemAt(index).uri?.let(::add)
        }
    }.distinct()
}

internal fun hasComposerMarkupTransformation(source: String, rendered: String): Boolean =
    source.filterNot(Char::isWhitespace) != rendered.filterNot(Char::isWhitespace)

private fun composerHasMarkup(source: String): Boolean =
    !composerRequiresLiteralMarkdown(source) &&
        hasComposerMarkupTransformation(source, RichTextState().setMarkdown(source).toText())

// rc10 does not retain fenced-code bodies in its Markdown paragraph tree.
// Keep such drafts on its literal-text path rather than losing pasted code.
// This is a conservative adapter fallback, not a second Markdown codec.
internal fun composerRequiresLiteralMarkdown(source: String): Boolean =
    Regex("(?m)^ {0,3}(`{3,}|~{3,})").containsMatchIn(source)

/**
 * The String-based owner can echo an older callback after a newer local edit.
 * Consume in-order/coalesced acknowledgements without reloading the editor.
 * Unrecognized values still mean an authoritative external replacement.
 * Bound retained drafts for previews/read-only owners that never acknowledge.
 */
internal class ComposerDraftEchoes {
    private val values = ArrayDeque<String>()

    fun record(value: String) {
        if (values.size == 32) values.removeFirst()
        values.addLast(value)
    }

    fun acknowledge(value: String): Boolean {
        val index = values.indexOfLast { it == value }
        if (index < 0) return false
        repeat(index + 1) { values.removeFirst() }
        return true
    }

    fun clear() = values.clear()
}

private fun mapNormalizedOffset(offset: Int, oldText: String, newText: String): Int {
    val prefix = oldText.commonPrefixWith(newText).length
    val suffix = oldText.drop(prefix).commonSuffixWith(newText.drop(prefix)).length
    val oldChangedEnd = oldText.length - suffix
    val newChangedEnd = newText.length - suffix
    return when {
        offset <= prefix -> offset
        offset >= oldChangedEnd -> (offset + newText.length - oldText.length)
            .coerceIn(0, newText.length)
        else -> newChangedEnd.coerceIn(0, newText.length)
    }
}

/** Exposed only to focused previews/tests that need to verify the library boundary. */
internal fun RichTextState.markdownForComposer(): String = toMarkdown()
