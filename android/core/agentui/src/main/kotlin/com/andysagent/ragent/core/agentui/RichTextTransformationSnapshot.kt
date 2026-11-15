package com.andysagent.ragent.core.agentui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.NonRestartableComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import com.mohamedrejeb.richeditor.model.RichTextState

/**
 * rc10 compatibility boundary; remove with an upstream fixed library upgrade.
 *
 * Its transform closes over mutable state. CoreTextField can still be laying
 * out the previous value when an IME commit changes that state, so Identity
 * maps the newer document against the old length and throws. Upstream 1.0.0
 * fixes this by capturing the AnnotatedString by value; retain that invariant
 * here without changing the pinned Kotlin/Compose toolchain.
 */
@Suppress("INVISIBLE_MEMBER", "INVISIBLE_REFERENCE")
@Composable
@NonRestartableComposable
internal fun snapshotRichTextTransformation(state: RichTextState) {
    // Observe here so this parent publishes the matching immutable transform
    // before BasicRichTextEditor recomposes. Never read the live state inside
    // filter(), and never rebuild the editor/input connection on each edit.
    val document = state.annotatedString
    val frozen = remember(state, document) {
        VisualTransformation { TransformedText(document, OffsetMapping.Identity) }
    }
    // rc10 has no public transformation hook. Keep this one version-specific
    // setter isolated and covered by retained-callback/native editor tests.
    // rc10 also replaces the callback on equal-text updates (selection/reset).
    // Observe callback identity as well: document equality alone misses those
    // replacements. Run in the caller's scope so repair precedes its editor child.
    if (state.visualTransformation !== frozen) state.visualTransformation = frozen
}
