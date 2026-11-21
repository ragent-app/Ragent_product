package com.andysagent.ragent.feature.organization.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class DelegationRunsDto(val sessionId: String, val runs: List<DelegationRunDto> = emptyList())

@Serializable
data class DelegationRunDto(val id: String, val state: String = "", val updatedAt: String? = null)

@Serializable
data class DelegationEventsDto(
    val sessionId: String,
    val runId: String,
    val events: List<DelegationEventDto> = emptyList(),
    val delegations: List<NativeDelegationDto> = emptyList(),
    val nextAfterLines: Long = 0L,
    val hasMore: Boolean = false,
    val sourceAvailability: String = "unknown",
    val gap: Boolean = false,
    val recoverability: String = "unknown",
)

@Serializable
data class NativeDelegationDto(
    val delegationId: String,
    val parentDelegationId: String? = null,
    val parentSessionId: String,
    val childSessionId: String? = null,
    val provider: String? = null,
    val runId: String,
    val state: String,
    val currentAction: String? = null,
    val startedAt: Long? = null,
    val updatedAt: Long? = null,
    val completedAt: Long? = null,
    val activity: NodeActivityDto? = null,
)

@Serializable
data class NodeActivityDto(
    val state: String = "unknown",
    val kind: String? = null,
    val actionRequired: Boolean = false,
    val observedAt: String? = null,
    val runId: String? = null,
    val sourceSeq: Long? = null,
)

@Serializable
data class DelegationEventDto(
    val id: String,
    val runId: String? = null,
    val parentSessionId: String? = null,
    val delegationId: String,
    val parentDelegationId: String? = null,
    val childSessionId: String? = null,
    val kind: String,
    val state: String,
    val seq: Long,
    val timestamp: Long,
    val birthActor: String? = null,
    val details: String? = null,
)

@Serializable
data class OrganizationActionsDto(
    val rootSessionId: String,
    val organizationId: String,
    val hasCreatedSubordinate: Boolean = false,
    val actions: List<OrganizationActionDto> = emptyList(),
    val nextAfterId: Long = 0L,
    val hasMore: Boolean = false,
)

@Serializable
data class OrganizationActionDto(
    val id: Long,
    val type: String,
    val nodeId: String? = null,
    val actorNodeId: String? = null,
    val taskId: String? = null,
    val attemptId: String? = null,
    val createdAt: String,
    val displayName: String? = null,
    val summary: String? = null,
    val details: String? = null,
    val operationId: String? = null,
    val status: String? = null,
)

@Serializable
data class OrganizationProjectionDto(
    val schemaVersion: Int = 1,
    val organizationId: String,
    val rootSessionId: String? = null,
    val hasCreatedSubordinate: Boolean = false,
    val revision: OrganizationRevisionDto? = null,
    val objective: String = "",
    val state: String = "idle",
    val progress: OrganizationProgressDto? = null,
    val nodes: List<OrganizationNodeDto> = emptyList(),
    val edges: List<OrganizationEdgeDto> = emptyList(),
    val phases: List<OrganizationPhaseDto> = emptyList(),
    val activeCommunications: List<OrganizationCommunicationDto> = emptyList(),
    val blockers: List<OrganizationBlockerDto> = emptyList(),
    val recentEvents: List<OrganizationEventDto> = emptyList(),
    val generatedAt: String? = null,
    val summary: OrganizationSummaryDto? = null,
    val asOf: OrganizationAsOfDto? = null,
    val changes: List<OrganizationEventDto> = emptyList(),
    val digest: String? = null,
)

@Serializable
data class OrganizationRevisionDto(
    val number: Int = 0,
    val digest: String? = null,
    val state: String = "active",
)

@Serializable
data class OrganizationProgressDto(
    val epoch: Int = 0,
    val state: String = "idle",
    val completed: Int = 0,
    val total: Int = 0,
)

@Serializable
data class OrganizationNodeDto(
    val id: String,
    val member: UnifiedMemberDto? = null,
    val parentId: String? = null,
    val role: String = "",
    val domain: String? = null,
    val iconKey: String? = null,
    val displayName: String = "",
    val phaseId: String? = null,
    val sessionClass: String = "",
    val status: String = "idle",
    val sessionId: String? = null,
    val currentBinding: OrganizationBindingDto? = null,
    val bindingRuntimeState: String? = null,
    val activity: NodeActivityDto? = null,
    val currentActivity: String? = null,
    val currentTask: OrganizationTaskDto? = null,
    val attempt: OrganizationAttemptDto? = null,
    val progress: OrganizationNodeProgressDto? = null,
    val blocker: OrganizationBlockerDto? = null,
    val reviewState: String? = null,
    val lastChangedAt: String? = null,
    val attemptCount: Int = 1,
    val resultPacketId: String? = null,
    val resultPacketSummary: String? = null,
    val directChildCount: Int = 0,
    val activeChildCount: Int = 0,
    val blockedChildCount: Int = 0,
    val isCollapsedRecommended: Boolean = false,
)

@Serializable
data class UnifiedMemberDto(
    val canonicalId: String,
    val sourceTag: String? = null,
    val executionHarnessId: String? = null,
    val parentCanonicalId: String? = null,
    val relationKnown: Boolean = false,
    val aliases: List<MemberAliasDto> = emptyList(),
    val conversation: MemberConversationRefDto? = null,
    val activity: NodeActivityDto? = null,
    val birth: MemberBirthDto? = null,
)

@Serializable data class MemberAliasDto(val kind: String, val id: String, val runId: String? = null)
@Serializable data class MemberBirthDto(val id: String, val actorCanonicalId: String, val operationId: String? = null, val timestamp: kotlinx.serialization.json.JsonElement? = null)
@Serializable data class MemberConversationRefDto(val ref: String? = null, val generation: Long? = null, val scope: String = "unavailable")
@Serializable data class UnifiedMembersPageDto(
    val rootSessionId: String, val rootCanonicalId: String, val members: List<UnifiedMemberDto> = emptyList(),
    val membersComplete: Boolean = false, val sourceCoverage: MemberSourceCoverageDto? = null,
)
@Serializable data class MemberSourceCoverageDto(val harness: String? = null, val gap: Boolean? = null)

@Serializable
data class OrganizationBindingDto(val sessionId: String? = null, val generation: Long = 0L)

@Serializable
data class OrganizationTaskDto(
    val taskId: String,
    val state: String = "unknown",
    val objective: String = "",
    val phaseId: String? = null,
    val attempt: Int = 0,
    val sessionId: String? = null,
    val runId: String? = null,
    val runState: String? = null,
)

@Serializable
data class OrganizationAttemptDto(
    val id: String,
    val number: Int = 1,
    val state: String = "unknown",
    val sessionId: String? = null,
    val runId: String? = null,
    val runState: String? = null,
    val resultPacketId: String? = null,
    val failureReasonCode: String? = null,
    val startedAt: String? = null,
    val completedAt: String? = null,
)

@Serializable
data class OrganizationNodeProgressDto(
    val state: String = "idle",
    val completed: Int = 0,
    val total: Int = 0,
    val epoch: Int = 0,
)

@Serializable
data class OrganizationEdgeDto(
    val id: String,
    val type: String = "MANAGES",
    val parentId: String? = null,
    val childId: String? = null,
    val from: String? = null,
    val to: String? = null,
    val revision: Int? = null,
    val state: String? = "active",
) {
    val fromNodeId: String get() = parentId ?: from.orEmpty()
    val toNodeId: String get() = childId ?: to.orEmpty()
}

@Serializable
data class OrganizationPhaseDto(
    val phaseId: String,
    val objective: String = "",
    val state: String = "active",
    val dependsOn: List<String> = emptyList(),
    val acceptance: List<OrganizationAcceptanceCriterionDto> = emptyList(),
    val reviewRequired: Boolean = true,
    val reviewState: String = "pending",
)

@Serializable
data class OrganizationAcceptanceCriterionDto(
    val criterion: String,
    val evidenceRequired: Boolean = true,
)

@Serializable
data class OrganizationCommunicationDto(
    val id: String,
    val type: String = "TASK_ASSIGNED",
    val fromNodeId: String = "",
    val toNodeId: String = "",
    val subject: String? = null,
    val priority: Int = 4,
    val state: String = "pending",
    val occurredAt: Long = 0L,
    val createdAt: String? = null,
)

@Serializable
data class OrganizationBlockerDto(
    val id: String? = null,
    val nodeId: String? = null,
    val type: String? = null,
    val reasonCode: String? = null,
    val reason: String? = null,
    val message: String? = null,
    val kind: String? = null,
    val taskId: String? = null,
    val attemptId: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class OrganizationEventDto(
    val id: Long = 0L,
    val type: String,
    val revision: Int? = null,
    val phaseId: String? = null,
    val nodeId: String? = null,
    val actorNodeId: String? = null,
    val taskId: String? = null,
    val attemptId: String? = null,
    val packetId: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class OrganizationSummaryDto(
    val totalNodes: Int = 0,
    val activeNodes: Int = 0,
    val completedNodes: Int = 0,
    val blockedNodes: Int = 0,
)

@Serializable
data class OrganizationAsOfDto(
    val revision: Int? = null,
    val eventId: Long = 0L,
    val progressEpoch: Int = 0,
    val projectionDigest: String? = null,
)

@Serializable
data class SwarmRunFailureDto(
    val runId: String? = null,
    val state: String? = null,
    val reason: String? = null,
    val failedAt: String? = null,
)

@Serializable
data class SwarmMemberDto(
    val nodeId: String = "",
    val id: String = "",
    val organizationId: String? = null,
    val name: String = "",
    val stableKey: String = "",
    val role: String = "worker",
    val contractRole: String? = null,
    val domain: String? = null,
    val lifecycleMode: String? = null,
    val lifecycleState: String? = null,
    val swarmState: String = "waiting",
    val sessionClass: String = "",
    val roleInstanceId: String? = null,
    val parentNodeId: String? = null,
    val depth: Int = 0,
    val currentSessionId: String? = null,
    val bindingGeneration: Long = 0L,
    val harness: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val workspaceMode: String? = null,
    val workspacePath: String? = null,
    val workspaceBranch: String? = null,
    val channels: List<String> = emptyList(),
    val lastRunId: String? = null,
    val lastStateReason: String? = null,
    val lastRunFailure: SwarmRunFailureDto? = null,
)

@Serializable
data class SwarmCountsDto(
    val waiting: Int = 0,
    val working: Int = 0,
    val stopped: Int = 0,
    val killed: Int = 0,
    val active: Int = 0,
    val total: Int = 0,
)

@Serializable
data class SwarmStallAlertDto(
    val id: String = "",
    val dedupeKey: String? = null,
    val conditionKind: String? = null,
    val targetRole: String? = null,
    val targetNodeId: String? = null,
    val boardSeq: Long? = null,
    val details: JsonObject? = null,
    val alertCount: Int = 1,
    val lastAlertAt: String? = null,
)

@Serializable
data class SwarmUsageByModelDto(
    val modelKey: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val provider: String? = null,
    val totalTokens: Long = 0L,
    val costUsd: Double = 0.0,
)

@Serializable
data class SwarmBoardChannelDto(
    val id: String? = null,
    val organizationId: String? = null,
    val name: String,
    val topic: String? = null,
    val visibility: String? = null,
    val state: String? = null,
    val createdByNodeId: String? = null,
    val createdAt: String? = null,
    val messageCount: Int = 0,
    val latestSeq: Long = 0L,
    val unreadCount: Int = 0,
)

@Serializable
data class SwarmBoardArtifactRefDto(
    val id: String = "",
    val kind: String? = null,
    val title: String? = null,
    val label: String? = null,
    val packetId: String? = null,
    val path: String? = null,
    val ref: String? = null,
)

@Serializable
data class SwarmBoardMessageDto(
    val id: String? = null,
    val organizationId: String? = null,
    val seq: Long = 0L,
    val channel: String = "main",
    val senderKind: String = "system",
    val senderNodeId: String? = null,
    val sender: String? = null,
    val senderName: String? = null,
    val senderRole: String? = null,
    val senderHarness: String? = null,
    val kind: String = "message",
    val text: String? = null,
    val bodyMarkdown: String? = null,
    val mentions: List<String> = emptyList(),
    val replyToSeq: Long? = null,
    val artifactRefs: List<SwarmBoardArtifactRefDto> = emptyList(),
    val isDoneSignal: Boolean = false,
    val isStallAlert: Boolean = false,
    val createdAt: String? = null,
) {
    val displayBody: String get() = bodyMarkdown?.takeIf { it.isNotBlank() } ?: text.orEmpty()
    val resolvedSender: String get() = senderName?.takeIf { it.isNotBlank() }
        ?: sender?.takeIf { it.isNotBlank() }
        ?: senderNodeId?.takeIf { it.isNotBlank() }
        ?: senderKind
}

@Serializable
data class SwarmBoardPayloadDto(
    val mode: String? = null,
    val source: String? = null,
    val readOnly: Boolean = false,
    val organizationId: String? = null,
    val title: String? = null,
    val headSeq: Long = 0L,
    val isDone: Boolean = false,
    val channels: List<SwarmBoardChannelDto> = emptyList(),
    val messages: List<SwarmBoardMessageDto> = emptyList(),
    val hasMore: Boolean = false,
    val activeStalls: List<SwarmStallAlertDto> = emptyList(),
)

@Serializable
data class SwarmStatusDto(
    val rootSessionId: String? = null,
    val mode: String? = null,
    val organizationId: String? = null,
    val title: String? = null,
    val headSeq: Long = 0L,
    val isDone: Boolean = false,
    val counts: SwarmCountsDto? = null,
    val members: List<SwarmMemberDto> = emptyList(),
    val channels: List<SwarmBoardChannelDto> = emptyList(),
    val activeStalls: List<SwarmStallAlertDto> = emptyList(),
    val budget: JsonObject? = null,
    val usageByModel: List<SwarmUsageByModelDto> = emptyList(),
)

@Serializable
data class SwarmBoardResponseDto(
    val rootSessionId: String? = null,
    val organizationId: String? = null,
    val mode: String? = null,
    val readOnly: Boolean = true,
    val board: SwarmBoardPayloadDto? = null,
    val channels: List<SwarmBoardChannelDto> = emptyList(),
    val nativeBoard: SwarmBoardPayloadDto? = null,
    val sourceCoverage: MemberSourceCoverageDto? = null,
) {
    val activeBoard: SwarmBoardPayloadDto?
        get() = board ?: nativeBoard

    val effectiveReadOnly: Boolean
        get() = readOnly || (activeBoard?.readOnly == true) || mode != "ragent_swarm"

    val isWritable: Boolean
        get() = mode == "ragent_swarm" && !effectiveReadOnly
}

@Serializable
data class PostBoardMessageRequestDto(
    val channel: String = "main",
    val bodyMarkdown: String,
    val replyToSeq: Long? = null,
    val idempotencyKey: String? = null,
)

@Serializable
data class PostBoardMessageResponseDto(
    val rootSessionId: String? = null,
    val organizationId: String? = null,
    val message: SwarmBoardMessageDto? = null,
    val headSeq: Long = 0L,
    val replay: Boolean = false,
)
