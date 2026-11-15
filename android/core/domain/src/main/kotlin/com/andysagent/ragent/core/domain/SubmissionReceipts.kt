package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.Session
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

data class SessionCreationReceipt(
    val session: Session,
    val idempotencyKey: String,
    val duplicate: Boolean,
)

/** Acceptance of a control-plane message; never proof the AI work is finished. */
data class MessageSubmissionReceipt(
    val sessionId: String,
    val requestId: String,
    val duplicate: Boolean,
    val queued: Boolean,
    val runId: String?,
)

/** Retained acceptance evidence. Null means unconfirmed, never safe to send a new identity. */
fun lookupMessageSubmissionReceipt(sessionId: String, requestId: String, body: JsonObject): MessageSubmissionReceipt? {
    require(body["receiptContractVersion"]?.jsonPrimitive?.contentOrNull == "1") { "Unsupported receipt lookup contract" }
    require(body["sessionId"]?.jsonPrimitive?.contentOrNull == sessionId
        && body["requestId"]?.jsonPrimitive?.contentOrNull == requestId) { "Receipt lookup identity differs" }
    return when (body["state"]?.jsonPrimitive?.contentOrNull) {
        "unconfirmed" -> null
        "accepted" -> {
            val queued = body["queued"]?.jsonPrimitive?.booleanOrNull
                ?: error("Receipt lookup omitted queue state")
            val runId = body["runId"]?.jsonPrimitive?.contentOrNull
            require(runId == null || runId.isNotBlank()) { "Invalid receipt Run identity" }
            MessageSubmissionReceipt(sessionId, requestId, duplicate = false, queued = queued, runId = runId)
        }
        else -> error("Unknown receipt lookup state")
    }
}

fun messageSubmissionReceipt(sessionId: String, requestId: String, body: JsonObject): MessageSubmissionReceipt {
    val acknowledgedId = body["requestId"]?.jsonPrimitive?.contentOrNull
    require(acknowledgedId == requestId) { "Message acknowledgement does not match the submitted request" }
    val run = body["run"] as? JsonObject
    return MessageSubmissionReceipt(
        sessionId = sessionId,
        requestId = requestId,
        duplicate = body["duplicate"]?.jsonPrimitive?.booleanOrNull ?: false,
        queued = body["queued"]?.jsonPrimitive?.booleanOrNull ?: false,
        runId = run?.get("id")?.jsonPrimitive?.contentOrNull,
    )
}
