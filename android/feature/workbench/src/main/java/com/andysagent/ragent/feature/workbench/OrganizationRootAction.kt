package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineOperationStatus
import com.andysagent.ragent.core.timeline.TimelineRole
import com.andysagent.ragent.feature.organization.presentation.NodeActionKind
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Only structured, current run state is used; provider prose is never classified. */
internal fun organizationRootAction(state: WorkbenchUiState): NodeActionKind? {
    if (state.connection != AgentConnectionStatus.Connected) return null
    if (state.runStatus == AgentRunStatus.WaitingApproval) return NodeActionKind.NEEDS_USER
    if (state.runStatus == AgentRunStatus.Failed) return NodeActionKind.FAILED
    if (state.runStatus != AgentRunStatus.Working) return null
    val userIndex = state.timelineItems.indexOfLast { it is TimelineItem.Message && it.role == TimelineRole.User }
    val currentRunId = (state.timelineItems.getOrNull(userIndex) as? TimelineItem.Message)?.runId
    val currentTurn = state.timelineItems.drop(userIndex + 1)
    val operation = currentTurn.filterIsInstance<TimelineItem.Operation>().lastOrNull {
        it.status == TimelineOperationStatus.InProgress && !it.isReasoning &&
            currentRunId != null && it.runId == currentRunId &&
            (state.currentAction?.operationId == it.id)
    }
    val tool = operation?.toolName?.lowercase()?.substringAfterLast("__")
    if (tool == "wait_agent") return NodeActionKind.WAITING_SUBORDINATES
    if (tool == "send_input") return NodeActionKind.SENDING
    fun activityValue(key: String) = (state.serverRunActivity?.get(key) as? JsonPrimitive)?.contentOrNull?.lowercase()
    val kind = state.currentAction?.kind?.lowercase()
    val serverState = activityValue("operationState")
    val serverKind = activityValue("labelKind") ?: activityValue("kind")
    val currentServerRun = currentRunId != null && activityValue("runId") == currentRunId.lowercase()
    val serverActive = currentServerRun && serverState in setOf("running", "started", "in_progress") && serverKind == kind
    if (kind == "responding") {
        val streaming = currentTurn.filterIsInstance<TimelineItem.Message>().lastOrNull { it.role == TimelineRole.Agent }
        return if (streaming != null && currentRunId != null && streaming.runId == currentRunId && !streaming.completed && streaming.messageState == "streaming") NodeActionKind.RESPONDING else null
    }
    if (currentServerRun && kind in setOf("wait", "waiting") && activityValue("state") == "waiting" && serverKind == kind) return NodeActionKind.WAITING
    if (operation == null && !serverActive) return null
    return when (kind) {
        "read", "list", "task_read", "task_list" -> NodeActionKind.READING
        "search" -> NodeActionKind.SEARCHING
        "edit", "file_edit", "delete", "move", "task_update" -> NodeActionKind.EDITING
        "inspect", "diff" -> NodeActionKind.INSPECTING
        "delegate", "subagent" -> NodeActionKind.DELEGATING
        "message" -> NodeActionKind.SENDING
        "wait", "waiting" -> NodeActionKind.WAITING
        "approval", "question" -> NodeActionKind.NEEDS_USER
        "execute", "execute_composite", "command", "tool", "mcp", "other", "web", "click", "input", "fetch", "scroll", "capture", "task_create" -> NodeActionKind.EXECUTING
        else -> if (operation != null) NodeActionKind.EXECUTING else null
    }
}
