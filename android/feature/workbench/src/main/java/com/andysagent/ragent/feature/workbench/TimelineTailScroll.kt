package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.withFrameNanos

/** Align real content above the dock without an unbounded item scroll offset. */
internal suspend fun LazyListState.scrollToTimelineTail(index: Int, animate: Boolean) {
    if (index < 0) return
    if (layoutInfo.visibleItemsInfo.none { it.index == index }) {
        if (animate) animateScrollToItem(index) else scrollToItem(index)
    }
    // A newly composed Markdown item may finish measuring on the next frame.
    // Re-read geometry, rather than carrying an old height through the scroll.
    repeat(3) {
        withFrameNanos { }
        val layout = layoutInfo
        val tail = layout.visibleItemsInfo.firstOrNull { it.index == index } ?: return
        val remaining = timelineTailScrollDistance(
            tail.offset, tail.size, layout.viewportEndOffset, layout.afterContentPadding,
        )
        if (remaining <= 1f) return
        val consumed = if (animate) animateScrollBy(remaining) else scrollBy(remaining)
        if (consumed <= 0f) return
    }
}

internal fun timelineTailScrollDistance(offset: Int, size: Int, viewportEnd: Int, padding: Int): Float =
    (offset.toLong() + size - viewportEnd + padding).coerceAtLeast(0L).toFloat()
