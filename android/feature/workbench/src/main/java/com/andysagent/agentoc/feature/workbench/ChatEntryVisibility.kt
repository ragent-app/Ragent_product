package com.andysagent.agentoc.feature.workbench

// A freshly created session already has a local echo before its first history
// snapshot. It should start at the tail rather than restore a history anchor.
internal fun isInitialLocalTimeline(
    sessionId: String?,
    timelineSessionId: String?,
    timelineItemCount: Int,
    hasLocalTurn: Boolean,
): Boolean = sessionId != null && (timelineSessionId == null || timelineSessionId == sessionId) &&
    timelineItemCount == 0 && hasLocalTurn
