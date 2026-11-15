// Copyright 2023, Saket Narayan
// SPDX-License-Identifier: Apache-2.0
// https://github.com/saket/extended-spans
// Ported from com.mikepenz:multiplatform-markdown-renderer (Apache-2.0),
// files: compose/extendedspans/internal/{ColorSerializers,Lists,TextLinkStyles}.kt
// — merged into one file, kept verbatim except for package relocation.
package com.andysagent.ragent.core.agentui.markdown.internal

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.isUnspecified
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import kotlin.contracts.ExperimentalContracts
import kotlin.contracts.contract

internal fun Color?.serialize(): String {
    return if (this == null || isUnspecified) "null" else "${toArgb()}"
}

internal fun String.deserializeToColor(): Color? {
    return if (this == "null") null else Color(this.toInt())
}

internal fun Color?.colorOrNull(): Color? {
    return if (this == null || isUnspecified) null else this
}

@OptIn(ExperimentalContracts::class)
internal inline fun <R> fastMapRange(
    start: Int,
    end: Int,
    transform: (Int) -> R,
): List<R> {
    contract { callsInPlace(transform) }
    val destination = ArrayList<R>(/* initialCapacity = */ end - start + 1)
    for (i in start..end) {
        destination.add(transform(i))
    }
    return destination
}

/**
 * Updates the [TextLinkStyles] with the provided [block].
 */
fun TextLinkStyles.update(block: SpanStyle.() -> SpanStyle): TextLinkStyles {
    return TextLinkStyles(
        style = style?.run(block),
        focusedStyle = focusedStyle?.run(block),
        hoveredStyle = focusedStyle?.run(block),
        pressedStyle = focusedStyle?.run(block),
    )
}
