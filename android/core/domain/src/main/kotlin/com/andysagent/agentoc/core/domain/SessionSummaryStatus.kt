package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.SessionStatus

internal const val ACCEPTED_FIRST_TURN_STATUS = "agentoc_accepted_first_turn"
internal const val ACCEPTED_FIRST_TURN_WAITING_STATUS = "agentoc_accepted_first_turn_waiting"

internal fun isAcceptedFirstTurnStatus(status: String?): Boolean =
    status == ACCEPTED_FIRST_TURN_STATUS || status == ACCEPTED_FIRST_TURN_WAITING_STATUS

internal fun acceptedFirstTurnStatus(waiting: Boolean): String =
    if (waiting) ACCEPTED_FIRST_TURN_WAITING_STATUS else ACCEPTED_FIRST_TURN_STATUS

/** A live run is authoritative over a stale idle session summary. */
internal fun chooseSessionSummaryStatus(status: String?, workflowState: String?, runState: String?, fallback: String = "idle"): String {
    val waiting = setOf("waiting_user", "waiting", "waiting_approval", "awaiting_approval", "awaiting_decision")
    val actionable = setOf("starting", "queued", "accepted", "preparing", "running", "working", "streaming",
        "waiting_approval", "awaiting_approval", "awaiting_decision", "done", "completed", "complete", "failed", "error", "cancelled", "canceled")
    return listOf(status, workflowState).firstOrNull { it != null && it.lowercase() in waiting }
        ?: runState?.takeIf { it.lowercase() in actionable }
        ?: status ?: workflowState ?: runState ?: fallback
}

internal fun sessionStatusFromRaw(status: String): SessionStatus = when (status.lowercase()) {
    ACCEPTED_FIRST_TURN_STATUS, "starting", "queued", "accepted", "preparing", "running", "working", "streaming" -> SessionStatus.Working
    ACCEPTED_FIRST_TURN_WAITING_STATUS, "waiting_user", "waiting", "waiting_approval", "awaiting_approval", "awaiting_decision" -> SessionStatus.WaitingApproval
    "done", "completed", "complete" -> SessionStatus.Completed
    "failed", "error" -> SessionStatus.Failed
    "cancelled", "canceled" -> SessionStatus.Cancelled
    else -> SessionStatus.Idle
}
