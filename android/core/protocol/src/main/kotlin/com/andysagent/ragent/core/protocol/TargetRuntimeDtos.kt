package com.andysagent.ragent.core.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

/** The cross-surface target runtime contract. Keep field names aligned with the Web JSON. */
object TargetRuntimeContract {
    const val SCHEMA_VERSION = 1
    const val DEFAULT_COMMAND_TTL_MS = 60_000L

    val statuses = setOf("paired", "connecting", "online", "degraded", "offline", "revoked")
    val eventTypes = setOf("created", "updated", "deleted", "snapshot")
    val commandStatuses = setOf("accepted", "queued", "running", "succeeded", "failed", "expired")
    val operations = setOf(
        "agent.read", "agent.write", "approval.read", "approval.resolve", "connector.read", "connector.write",
        "file.read", "file.write", "home.read", "model.read", "notification.read", "notification.write",
        "project.read", "project.write", "provider.read", "provider.write", "run.read", "run.cancel",
        "runtime.summary", "session.create", "session.read", "session.message", "session.queue",
        "session.update", "session.delete", "session.cancel", "session.compact", "session.drop-tools",
        "session.fork", "settings.read", "settings.write", "tool.read", "tool.write", "trigger.read",
        "trigger.write", "usage.read", "workflow.read", "workflow.write",
    )
}

class TargetRuntimeContractException(message: String) : IllegalArgumentException(message)

@Serializable
data class TargetDescriptor(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val targetId: String,
    val instanceId: String,
    val deviceKind: String = "computer",
    val label: String,
    val platform: String = "",
    val status: String = "offline",
    val runtimeVersion: String = "",
    val capabilities: List<String> = emptyList(),
    val snapshotVersion: Long = 0L,
    val lastSeenAt: String = "",
) {
    fun validate(): TargetDescriptor {
        requireText(targetId, "targetId")
        requireText(instanceId, "instanceId")
        requireText(label, "label")
        require(status in TargetRuntimeContract.statuses) { "status is invalid" }
        require(snapshotVersion >= 0L) { "snapshotVersion must be non-negative" }
        if (lastSeenAt.isNotBlank()) parseTimestamp(lastSeenAt, "lastSeenAt")
        return this
    }
}

@Serializable
data class TargetCatalog(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val revision: Long = 0L,
    val activeTargetId: String? = null,
    val targets: List<TargetDescriptor> = emptyList(),
) {
    fun validate(): TargetCatalog {
        require(revision >= 0L) { "revision must be non-negative" }
        targets.forEach { it.validate() }
        require(targets.map { it.targetId }.toSet().size == targets.size) { "targetId values must be unique" }
        require(activeTargetId == null || targets.any { it.targetId == activeTargetId }) {
            "activeTargetId must refer to a target"
        }
        return this
    }
}

@Serializable
data class TargetSummarySessionCounts(
    val total: Int = 0,
    val active: Int = 0,
)

@Serializable
data class TargetSummaryRunCounts(
    val active: Int = 0,
)

@Serializable
data class TargetSummaryApprovalCounts(
    val pending: Int = 0,
)

@Serializable
data class TargetSummaryActivity(
    val entityType: String = "session",
    val entityId: String,
    val title: String = "",
    val status: String = "idle",
    val updatedAt: String = "",
    val revision: Long = 0L,
)

/** A path-free project projection used by the Home cross-device list. */
@Serializable
data class TargetSummaryProject(
    val id: String,
    val name: String = "",
    val updatedAt: String = "",
)

@Serializable
data class TargetSummary(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val targetId: String,
    val instanceId: String,
    val revision: Long = 0L,
    val eventCursor: String = "0",
    val generatedAt: String,
    val sessions: TargetSummarySessionCounts = TargetSummarySessionCounts(),
    val runs: TargetSummaryRunCounts = TargetSummaryRunCounts(),
    val approvals: TargetSummaryApprovalCounts = TargetSummaryApprovalCounts(),
    val recentActivity: List<TargetSummaryActivity> = emptyList(),
    val recentProjects: List<TargetSummaryProject> = emptyList(),
) {
    fun validate(): TargetSummary {
        requireText(targetId, "targetId")
        requireText(instanceId, "instanceId")
        require(revision >= 0L) { "revision must be non-negative" }
        require(eventCursor.toLongOrNull()?.let { it >= 0L } == true) { "eventCursor is invalid" }
        parseTimestamp(generatedAt, "generatedAt")
        require(sessions.total >= 0 && sessions.active >= 0) { "session counts are invalid" }
        require(runs.active >= 0 && approvals.pending >= 0) { "summary counts are invalid" }
        recentProjects.forEach { project ->
            requireText(project.id, "recentProjects.id")
            requireText(project.name, "recentProjects.name")
            if (project.updatedAt.isNotBlank()) parseTimestamp(project.updatedAt, "recentProjects.updatedAt")
        }
        return this
    }
}

@Serializable
data class TargetSummaryEvent(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val eventId: String,
    val targetId: String,
    val instanceId: String,
    val entityType: String = "notification",
    val entityId: String,
    val revision: Long = 0L,
    val type: String = "updated",
    val emittedAt: String,
    val cursor: Long = 0L,
    val summary: JsonObject = JsonObject(emptyMap()),
) {
    fun validate(): TargetSummaryEvent {
        requireText(eventId, "eventId")
        requireText(targetId, "targetId")
        requireText(instanceId, "instanceId")
        requireText(entityId, "entityId")
        require(entityType in setOf("session", "run", "approval", "notification")) { "entityType is invalid" }
        require(type in TargetRuntimeContract.eventTypes) { "type is invalid" }
        require(revision >= 0L && cursor > 0L) { "event revision/cursor is invalid" }
        parseTimestamp(emittedAt, "emittedAt")
        return this
    }
}

@Serializable
data class TargetSummaryEventsPage(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val revision: Long = 0L,
    val cursor: String = "0",
    val nextCursor: String? = null,
    val hasMore: Boolean = false,
    val events: List<TargetSummaryEvent> = emptyList(),
)

@Serializable
data class TargetCommand(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val requestId: String,
    val idempotencyKey: String,
    val targetId: String,
    val operation: String,
    val resourceId: String,
    val expectedRevision: Long,
    val expiresAt: String,
) {
    fun validate(now: Instant = Instant.now()): TargetCommand {
        requireText(requestId, "requestId")
        requireText(idempotencyKey, "idempotencyKey")
        requireText(targetId, "targetId")
        require(operation in TargetRuntimeContract.operations) { "operation is invalid" }
        requireText(resourceId, "resourceId")
        require(expectedRevision >= 0L) { "expectedRevision must be non-negative" }
        require(Instant.parse(expiresAt).isAfter(now)) { "Command expiry must be in the future" }
        return this
    }
}

@Serializable
data class TargetCommandError(
    val code: String,
    val message: String = "",
    val retryable: Boolean = false,
)

@Serializable
data class TargetCommandResult(
    val schemaVersion: Int = TargetRuntimeContract.SCHEMA_VERSION,
    val requestId: String,
    val idempotencyKey: String,
    val targetId: String,
    val status: String,
    val revision: Long = 0L,
    val error: TargetCommandError? = null,
) {
    fun validate(): TargetCommandResult {
        requireText(requestId, "requestId")
        requireText(idempotencyKey, "idempotencyKey")
        requireText(targetId, "targetId")
        require(status in TargetRuntimeContract.commandStatuses) { "status is invalid" }
        require(revision >= 0L) { "revision must be non-negative" }
        return this
    }
}

private fun requireText(value: String, field: String) {
    require(value.isNotBlank()) { "$field is required" }
}

private fun parseTimestamp(value: String, field: String) {
    try {
        Instant.parse(value)
    } catch (error: Exception) {
        throw TargetRuntimeContractException("$field must be an ISO timestamp: ${error.message}")
    }
}
