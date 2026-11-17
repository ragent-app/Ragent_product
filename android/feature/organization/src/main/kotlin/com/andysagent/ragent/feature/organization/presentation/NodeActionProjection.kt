package com.andysagent.ragent.feature.organization.presentation

import com.andysagent.ragent.feature.organization.data.NodeActivityDto

/** Activity is already scoped and freshness-checked by its owning projection. */
fun nodeAction(activity: NodeActivityDto?): NodeActionKind? {
    activity ?: return null
    if (activity.state == "unknown" || activity.state == "idle") return null
    if (activity.actionRequired) return NodeActionKind.NEEDS_USER
    return when (activity.state) {
        "failed" -> NodeActionKind.FAILED
        "blocked" -> NodeActionKind.BLOCKED
        "waiting" -> if (activity.kind == "wait_subordinates") NodeActionKind.WAITING_SUBORDINATES else NodeActionKind.WAITING
        "working" -> when (activity.kind) {
            "read", "list", "task_read", "task_list" -> NodeActionKind.READING
            "search" -> NodeActionKind.SEARCHING
            "edit", "delete", "move", "task_update" -> NodeActionKind.EDITING
            "inspect", "diff" -> NodeActionKind.INSPECTING
            "delegate", "subagent" -> NodeActionKind.DELEGATING
            "message", "send" -> NodeActionKind.SENDING
            "wait_agent" -> NodeActionKind.WAITING_SUBORDINATES
            "wait" -> NodeActionKind.WAITING
            "responding" -> NodeActionKind.RESPONDING
            "execute", "fetch", "switch_mode", "other", "mcp", "web", "click", "input", "scroll", "capture", "generate", "task_create", "task_stop" -> NodeActionKind.EXECUTING
            else -> null
        }
        else -> null
    }
}
