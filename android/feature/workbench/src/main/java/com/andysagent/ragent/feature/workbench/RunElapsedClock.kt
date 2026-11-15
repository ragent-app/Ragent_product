package com.andysagent.ragent.feature.workbench

/** Anchors a server-measured run duration to the device's monotonic clock. */
internal fun updateRunElapsedAnchor(previous: Long, serverElapsedMs: Long?, nowElapsedMs: Long): Long {
    if (serverElapsedMs == null || serverElapsedMs < 0) return previous
    return minOf(previous, nowElapsedMs - serverElapsedMs)
}

internal fun runElapsedSeconds(anchor: Long, nowElapsedMs: Long, previousSeconds: Long): Long {
    if (anchor == Long.MAX_VALUE) return previousSeconds
    return maxOf(previousSeconds, (nowElapsedMs - anchor).coerceAtLeast(0) / 1_000)
}
