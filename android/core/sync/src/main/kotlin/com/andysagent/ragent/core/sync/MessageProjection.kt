package com.andysagent.ragent.core.sync

import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.protocol.boundarySeq
import com.andysagent.ragent.core.protocol.messageEntityKey
import com.andysagent.ragent.core.protocol.textContent

/** One message reducer for durable events, history pages and live updates. */
data class ProjectedMessage(
    val id: String,
    val role: String,
    val text: String,
    val firstSeq: Long,
    val lastEventSeq: Long,
    val revision: Long,
    val state: String,
    val requestId: String? = null,
    val runId: String? = null,
    val messagePhase: String? = null,
) {
    val completed: Boolean get() = state != "streaming"
}

fun SessionEventDto.isTimelineMessage(): Boolean = source != "context_compaction_handoff" && type?.lowercase() in setOf(
    "message", "message_start", "user_message", "assistant_message", "text_delta", "assistant_delta",
    "message_delta", "assistant_stream", "assistant_completed", "message_completed",
)

fun SessionEventDto.terminalRunState(): String? {
    if (type?.lowercase() !in setOf("status", "run_completed", "run_failed", "run_cancelled", "session_completed")) return null
    return when ((runState ?: status ?: state ?: textContent()?.trim()
        ?: type?.removePrefix("run_")?.removePrefix("session_")).orEmpty().lowercase()) {
        "completed", "finished", "succeeded", "success", "done" -> "completed"
        "cancelled", "canceled", "interrupted" -> "interrupted"
        "failed", "error" -> "failed"
        else -> null
    }
}

fun SessionEventDto.messageProjectionId(): String {
    canonicalMessageId?.takeIf(String::isNotBlank)?.let { return it }
    val role = role ?: if (type == "user_message") "user" else "assistant"
    // Visible history used message:<role>:<id>, while the native client used
    // message:<id>:<role>. Normalize that wrapper, never the request/run scope.
    val raw = messageEntityKey().removePrefix("message:$role:")
    return if (raw.startsWith("message:") && raw.endsWith(":$role")) raw else "message:$raw:$role"
}

fun reduceMessage(previous: ProjectedMessage?, event: SessionEventDto, provisionalSeq: Long): ProjectedMessage {
    require(event.isTimelineMessage())
    val boundary = event.lastEventSeq ?: event.boundarySeq()
    val revision = event.revision ?: boundary
    if (previous != null && boundary > 0 && previous.lastEventSeq > boundary) return previous
    if (previous != null && event.revision != null && previous.revision > revision) return previous
    val delta = event.textMode == "delta" || (event.textMode == null &&
        (event.type.orEmpty().contains("delta") || event.type.orEmpty().contains("stream")))
    // A terminal message can accept a newer authoritative snapshot, but can
    // never be reopened or changed by a delayed token.
    if (previous?.completed == true && delta) return previous
    val incoming = event.textContent()
    val text = when {
        event.type == "message_start" -> previous?.text.orEmpty()
        delta -> previous?.text.orEmpty() + incoming.orEmpty()
        event.textMode == "metadata" -> previous?.text.orEmpty()
        incoming != null && (incoming.isNotEmpty() || event.textMode == "snapshot") -> incoming
        else -> previous?.text.orEmpty()
    }
    val nextState = event.messageState ?: if (delta || event.type == "message_start") "streaming" else "completed"
    return ProjectedMessage(
        id = event.messageProjectionId(),
        role = event.role ?: previous?.role ?: if (event.type == "user_message") "user" else "assistant",
        text = text,
        firstSeq = listOfNotNull(event.firstSeq?.takeIf { it > 0 }, previous?.firstSeq?.takeIf { it > 0 })
            .minOrNull() ?: provisionalSeq,
        lastEventSeq = maxOf(previous?.lastEventSeq ?: 0, boundary),
        revision = maxOf(previous?.revision ?: 0, revision),
        state = if (previous?.completed == true && nextState == "streaming") previous.state else nextState,
        requestId = event.requestId ?: previous?.requestId,
        runId = event.runId ?: previous?.runId,
        messagePhase = event.messagePhase ?: previous?.messagePhase,
    )
}
