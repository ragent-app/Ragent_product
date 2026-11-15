package com.andysagent.ragent.feature.workbench

/** A tail is read only when its bottom clears the persistent input/approval dock. */
internal fun isTimelineTailVisible(
    lastContentIndex: Int,
    visibleContentIndex: Int?,
    visibleContentBottom: Long?,
    viewportEnd: Int,
    bottomContentPadding: Int,
): Boolean {
    if (lastContentIndex < 0) return true
    if (visibleContentIndex != lastContentIndex || visibleContentBottom == null) return false
    // LazyColumn's viewport includes after-content padding. That region is
    // behind the floating dock, not readable message space. Allow only the
    // one-pixel layout rounding error, not a whole-item proximity threshold.
    val readableEnd = viewportEnd.toLong() - bottomContentPadding + 1L
    return visibleContentBottom <= readableEnd
}
