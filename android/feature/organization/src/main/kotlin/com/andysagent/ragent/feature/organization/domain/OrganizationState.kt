package com.andysagent.ragent.feature.organization.domain

enum class NodeRole {
    EXECUTIVE,
    MANAGER,
    PHASE_LEAD,
    WORKER,
    WRITER,
    REVIEWER,
    EXPERT,
    UNKNOWN;

    companion object {
        fun fromString(role: String?): NodeRole = when (role?.lowercase()) {
            "root", "executive", "lead" -> EXECUTIVE
            "manager", "lead_worker" -> MANAGER
            "phase_lead" -> PHASE_LEAD
            "worker" -> WORKER
            "writer" -> WRITER
            "reviewer" -> REVIEWER
            "expert", "consultant", "specialist" -> EXPERT
            else -> UNKNOWN
        }
    }
}

// Visual icon categories only. The original, unrestricted specialty is kept separately.
enum class AgentDomain {
    BACKEND,
    MOBILE,
    WEB,
    RUNTIME,
    ARCHITECTURE,
    DATABASE,
    DATA,
    AI,
    CLOUD,
    NETWORK,
    HARDWARE,
    SECURITY,
    TESTING,
    DESIGN,
    PRODUCT,
    RESEARCH,
    WRITING,
    TRANSLATION,
    EDUCATION,
    BUSINESS,
    FINANCE,
    LEGAL,
    HEALTH,
    MARKETING,
    SALES,
    PEOPLE,
    OPERATIONS,
    LOGISTICS,
    MEDIA,
    ENVIRONMENT,
    ENGINEERING,
    GENERAL;

    companion object {
        fun fromExplicit(domain: String?, iconKey: String?): AgentDomain? {
            val key = (iconKey ?: domain)?.trim()?.lowercase() ?: return null
            if (iconKey != null && (key == "android" || key == "ios")) return MOBILE
            return entries.firstOrNull { it.name.lowercase() == key }
        }
    }
}

enum class NodeRuntimeState {
    PROVISIONING,
    IDLE,
    WORKING,
    WAITING,
    BLOCKED,
    REVIEWING,
    DONE,
    FAILED,
    PAUSED;

    companion object {
        fun fromString(status: String?, currentActivity: String?, hasBlocker: Boolean): NodeRuntimeState {
            if (hasBlocker) return BLOCKED
            return when (status?.lowercase()) {
                "provisioning", "unbound" -> PROVISIONING
                "working", "running" -> WORKING
                "waiting", "waiting_children", "waiting_approval" -> WAITING
                "reviewing", "waiting_review" -> REVIEWING
                "done", "completed", "succeeded" -> DONE
                "failed" -> FAILED
                "paused", "cancelled" -> PAUSED
                "idle", "ready" -> {
                    if (currentActivity == "running") WORKING else IDLE
                }
                else -> IDLE
            }
        }
    }
}

enum class EdgeType {
    MANAGES,
    REVIEWS
}

enum class CommunicationType {
    TASK_ASSIGNED,
    RESULT_AVAILABLE,
    REVIEW_REQUESTED,
    REVIEW_COMPLETED,
    BLOCKER_ESCALATED,
    HANDOFF_AVAILABLE;

    companion object {
        fun fromString(type: String?): CommunicationType = when (type?.uppercase()) {
            "RESULT_AVAILABLE", "RESULT", "PACKET" -> RESULT_AVAILABLE
            "REVIEW_REQUESTED", "REVIEW_REQ" -> REVIEW_REQUESTED
            "REVIEW_COMPLETED", "REVIEW_DONE" -> REVIEW_COMPLETED
            "BLOCKER_ESCALATED", "BLOCKER", "BLOCKER_REPORTED" -> BLOCKER_ESCALATED
            "HANDOFF_AVAILABLE", "HANDOFF" -> HANDOFF_AVAILABLE
            else -> TASK_ASSIGNED
        }
    }
}

enum class ConsultationPhaseState {
    PLANNED,
    ACTIVE,
    RETURNING,
    CONCLUDED
}

data class ExpertNodeModel(
    val id: String,
    val domain: AgentDomain,
    val displayName: String,
    val isWorking: Boolean = false,
    val hasReturnedPacket: Boolean = false,
)

data class ConsultationState(
    val isActive: Boolean = false,
    val roundNumber: Int = 1,
    val experts: List<ExpertNodeModel> = emptyList(),
    val decisionRecord: String? = null,
    val state: ConsultationPhaseState = ConsultationPhaseState.PLANNED,
)

data class OrganizationNodeModel(
    val id: String,
    val parentId: String? = null,
    val role: NodeRole = NodeRole.UNKNOWN,
    val domain: AgentDomain = AgentDomain.GENERAL,
    val hasRecognizedDomain: Boolean = false,
    val professionName: String? = null,
    val displayName: String = "",
    val phaseId: String? = null,
    val sessionClass: String = "",
    val runtimeState: NodeRuntimeState = NodeRuntimeState.IDLE,
    val sessionId: String? = null,
    val currentActivity: String? = null,
    val currentTaskSummary: String? = null,
    val currentTaskDetail: String? = null,
    val progressCompleted: Int = 0,
    val progressTotal: Int = 0,
    val blockerText: String? = null,
    val reviewState: String? = null,
    val attemptCount: Int = 1,
    val testsPassed: Int = 0,
    val testsTotal: Int = 0,
    val directChildCount: Int = 0,
    val activeChildCount: Int = 0,
    val blockedChildCount: Int = 0,
    val isCluster: Boolean = false,
    val clusterChildren: List<String> = emptyList(),
    val lastChangedAt: Long = 0L,
    val changedFiles: List<String> = emptyList(),
    val resultPacketSummary: String? = null,
    val failureCode: String? = null,
    val harness: String? = null,
    val workspaceMode: String? = null,
    val workspaceBranch: String? = null,
)

data class OrganizationEdgeModel(
    val id: String,
    val fromNodeId: String,
    val toNodeId: String,
    val type: EdgeType = EdgeType.MANAGES,
    val state: String = "active",
)

data class OrganizationCommunicationModel(
    val id: String,
    val type: CommunicationType,
    val fromNodeId: String,
    val toNodeId: String,
    val subject: String? = null,
    val priority: Int = 4,
    val occurredAt: Long = 0L,
)

data class OrganizationPhaseModel(
    val phaseId: String,
    val objective: String = "",
    val isCompleted: Boolean = false,
    val dependsOn: List<String> = emptyList(),
    val acceptanceCriteria: List<String> = emptyList(),
)

data class OrganizationBlockerModel(
    val id: String,
    val nodeId: String? = null,
    val reason: String = "",
    val createdAt: String? = null,
)

data class OrganizationActivityEvent(
    val id: String,
    val fromNodeId: String? = null,
    val toNodeId: String? = null,
    val fromName: String = "",
    val toName: String = "",
    val message: String = "",
    val timestamp: Long = 0L,
    val type: CommunicationType? = null,
)

data class SwarmCountsModel(
    val waiting: Int = 0,
    val working: Int = 0,
    val stopped: Int = 0,
    val killed: Int = 0,
    val active: Int = 0,
    val total: Int = 0,
)

data class SwarmStallAlertModel(
    val id: String,
    val conditionKind: String? = null,
    val targetRole: String? = null,
    val targetNodeId: String? = null,
    val boardSeq: Long? = null,
    val reason: String? = null,
    val alertCount: Int = 1,
    val lastAlertAt: String? = null,
)

data class SwarmUsageBucketModel(
    val label: String,
    val totalTokens: Long = 0L,
    val costUsd: Double = 0.0,
)

data class SwarmMemberModel(
    val nodeId: String,
    val displayName: String,
    val role: NodeRole = NodeRole.WORKER,
    val domain: AgentDomain = AgentDomain.GENERAL,
    val hasRecognizedDomain: Boolean = false,
    val professionName: String? = null,
    val parentNodeId: String? = null,
    val currentSessionId: String? = null,
    val swarmState: String = "waiting",
    val lifecycleState: String? = null,
    val sessionClass: String = "",
    val harness: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val workspaceMode: String? = null,
    val workspaceBranch: String? = null,
    val lastStateReason: String? = null,
    val lastRunFailureReason: String? = null,
    val lastRunFailureState: String? = null,
)

data class SwarmBoardChannelModel(
    val name: String,
    val topic: String? = null,
    val messageCount: Int = 0,
    val latestSeq: Long = 0L,
    val unreadCount: Int = 0,
)

data class SwarmBoardArtifactRefModel(
    val id: String,
    val kind: String? = null,
    val label: String,
    val packetId: String? = null,
    val path: String? = null,
)

data class SwarmBoardMessageModel(
    val id: String,
    val seq: Long,
    val channel: String,
    val senderKind: String,
    val senderNodeId: String? = null,
    val senderName: String,
    val senderRole: String? = null,
    val senderHarness: String? = null,
    val kind: String = "message",
    val bodyMarkdown: String = "",
    val mentions: List<String> = emptyList(),
    val replyToSeq: Long? = null,
    val artifactRefs: List<SwarmBoardArtifactRefModel> = emptyList(),
    val isDoneSignal: Boolean = false,
    val isStallAlert: Boolean = false,
    val createdAt: String? = null,
)

data class SwarmStatusModel(
    val organizationId: String? = null,
    val rootSessionId: String? = null,
    val mode: String? = null,
    val title: String? = null,
    val headSeq: Long = 0L,
    val isDone: Boolean = false,
    val counts: SwarmCountsModel = SwarmCountsModel(),
    val members: List<SwarmMemberModel> = emptyList(),
    val channels: List<SwarmBoardChannelModel> = emptyList(),
    val activeStalls: List<SwarmStallAlertModel> = emptyList(),
    val usageByModel: List<SwarmUsageBucketModel> = emptyList(),
)

data class SwarmBoardModel(
    val organizationId: String? = null,
    val mode: String? = null,
    val source: String? = null,
    val readOnly: Boolean = true,
    val title: String? = null,
    val headSeq: Long = 0L,
    val isDone: Boolean = false,
    val channels: List<SwarmBoardChannelModel> = emptyList(),
    val messages: List<SwarmBoardMessageModel> = emptyList(),
    val hasMore: Boolean = false,
    val activeStalls: List<SwarmStallAlertModel> = emptyList(),
) {
    val isWritable: Boolean
        get() = mode == "ragent_swarm" && !readOnly
}

data class OrganizationState(
    val organizationId: String = "",
    val rootSessionId: String? = null,
    val revision: Int = 0,
    val objective: String = "",
    val state: String = "idle",
    val progressEpoch: Int = 0,
    val sequence: Long = 0L,
    val nodes: Map<String, OrganizationNodeModel> = emptyMap(),
    val edges: List<OrganizationEdgeModel> = emptyList(),
    val phases: List<OrganizationPhaseModel> = emptyList(),
    val activeCommunications: List<OrganizationCommunicationModel> = emptyList(),
    val blockers: List<OrganizationBlockerModel> = emptyList(),
    val consultation: ConsultationState? = null,
    val recentActivity: List<OrganizationActivityEvent> = emptyList(),
    val isCompleted: Boolean = false,
    val leaderSummary: String? = null,
    val isSyntheticSwarmNodes: Boolean = false,
    val swarmStatus: SwarmStatusModel? = null,
    val board: SwarmBoardModel? = null,
    val selectedBoardChannel: String? = null,
    val boardReplyToSeq: Long? = null,
    val boardComposerDraft: String = "",
    val boardPosting: Boolean = false,
    val boardError: String? = null,
) {
    val rootExecutiveNode: OrganizationNodeModel?
        get() = nodes.values.firstOrNull { it.role == NodeRole.EXECUTIVE } ?: nodes.values.firstOrNull { it.parentId == null }
}
