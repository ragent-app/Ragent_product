package com.andysagent.ragent.feature.organization.domain

enum class NodeRole {
    EXECUTIVE,
    MANAGER,
    WORKER,
    REVIEWER,
    EXPERT;

    companion object {
        fun fromString(role: String?): NodeRole = when (role?.lowercase()) {
            "root", "executive", "lead" -> EXECUTIVE
            "manager", "lead_worker" -> MANAGER
            "reviewer" -> REVIEWER
            "expert", "consultant" -> EXPERT
            else -> WORKER
        }
    }
}

enum class AgentDomain {
    BACKEND,
    ANDROID,
    RUNTIME,
    SECURITY,
    TESTING,
    ARCHITECTURE,
    DATABASE,
    RESEARCH,
    GENERAL;

    companion object {
        fun infer(displayName: String, domainHint: String? = null): AgentDomain {
            val text = "${domainHint.orEmpty()} $displayName".lowercase()
            return when {
                text.contains("android") || text.contains("ui") || text.contains("frontend") -> ANDROID
                text.contains("runtime") || text.contains("protocol") || text.contains("stream") -> RUNTIME
                text.contains("security") || text.contains("permission") || text.contains("auth") -> SECURITY
                text.contains("test") || text.contains("qa") || text.contains("benchmark") -> TESTING
                text.contains("arch") -> ARCHITECTURE
                text.contains("db") || text.contains("database") || text.contains("sqlite") || text.contains("room") -> DATABASE
                text.contains("research") || text.contains("doc") -> RESEARCH
                text.contains("backend") || text.contains("server") || text.contains("api") -> BACKEND
                else -> GENERAL
            }
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
    val role: NodeRole = NodeRole.WORKER,
    val domain: AgentDomain = AgentDomain.GENERAL,
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
) {
    val rootExecutiveNode: OrganizationNodeModel?
        get() = nodes.values.firstOrNull { it.role == NodeRole.EXECUTIVE } ?: nodes.values.firstOrNull { it.parentId == null }
}
