package com.andysagent.ragent.core.agentui

import androidx.compose.ui.text.TextRange

/** Preserve the editing selection when the composer becomes a non-editing capsule. */
internal class ComposerSelectionRetention {
    private var wasActive = true
    private var lastActive: TextRange? = null
    private var retained: TextRange? = null

    fun observe(active: Boolean, focused: Boolean, selection: TextRange) {
        if (!active && wasActive) retained = lastActive
        // BasicTextField collapses the range on blur. Do not overwrite the
        // retained editing range with that inactive presentation change.
        if (active && focused && retained == null) lastActive = selection
        wasActive = active
    }

    fun selectionToRestore(length: Int): TextRange? = retained?.let {
        TextRange(it.start.coerceIn(0, length), it.end.coerceIn(0, length))
    }

    fun restored(selection: TextRange) {
        lastActive = selection
        retained = null
    }

    fun discard() {
        lastActive = null
        retained = null
    }
}
