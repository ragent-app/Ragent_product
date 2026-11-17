package com.andysagent.ragent.feature.organization.presentation

import androidx.compose.ui.geometry.Offset
import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import com.andysagent.ragent.feature.organization.layout.LayoutBounds

enum class NodeActionKind {
    RESPONDING, READING, SEARCHING, EDITING, EXECUTING, INSPECTING, DELEGATING, SENDING,
    WAITING, WAITING_SUBORDINATES, NEEDS_USER, BLOCKED, FAILED,
}

/** One shared graph frame, in graph-local physical pixels and unzoomed dp. */
data class NodePhysicsFrame(
    val centerX: Float,
    val centerY: Float,
    val radiusDp: Float,
    val birthProgress: Float = 1f,
    val birthSourceId: String? = null,
    val separationMaterialProgress: Float = 1f,
    val birthVisible: Boolean = true,
    val clickable: Boolean = true,
    val iconAlpha: Float = 1f,
    val sourceDeformation: Float = 0f,
    val deformationDirectionX: Float = 0f,
    val deformationDirectionY: Float = 1f,
)

data class RenderedNodeUiState(
    val id: String,
    val x: Float,
    val y: Float,
    val radiusDp: Float,
    val role: NodeRole,
    val domain: AgentDomain,
    val displayName: String,
    val runtimeState: NodeRuntimeState,
    val action: NodeActionKind? = null,
    val isCluster: Boolean = false,
    val clusterCount: Int = 0,
    val clusterChildIds: List<String> = emptyList(),
    val alpha: Float = 1.0f,
    val scale: Float = 1.0f,
    val isFocused: Boolean = false,
    val currentActivity: String? = null,
    val taskSummary: String? = null,
    val hasBlocker: Boolean = false,
    val blockerText: String? = null,
    val reviewState: String? = null,
    val attemptCount: Int = 1,
    val testsPassed: Int = 0,
    val testsTotal: Int = 0,
    val accessibilityText: String = "",
    val hasRecognizedDomain: Boolean = false,
    val professionName: String? = null,
    val physicsFrame: NodePhysicsFrame? = null,
)

data class RenderedEdgeUiState(
    val id: String,
    val fromNodeId: String,
    val toNodeId: String,
    val start: EdgePoint,
    val end: EdgePoint,
    val control1: EdgePoint? = null,
    val control2: EdgePoint? = null,
    val isCurved: Boolean = true,
    val isReview: Boolean = false,
    val alpha: Float = 0.85f,
    val growthProgress: Float = 1.0f,
)

data class ParticleUiState(
    val id: String,
    val type: CommunicationType,
    val x: Float,
    val y: Float,
    val progress: Float,
)

data class ExpertNodeUiState(
    val id: String,
    val domain: AgentDomain,
    val displayName: String,
    val isWorking: Boolean,
    val hasReturnedPacket: Boolean,
    val x: Float,
    val y: Float,
)

data class ConsultationUiState(
    val isActive: Boolean,
    val roundNumber: Int,
    val experts: List<ExpertNodeUiState>,
    val decisionRecord: String?,
)

data class NodeDetailUiState(
    val id: String,
    val displayName: String,
    val role: NodeRole,
    val domain: AgentDomain,
    val runtimeState: NodeRuntimeState,
    val sessionId: String?,
    val currentTaskSummary: String?,
    val currentTaskDetail: String?,
    val currentActivity: String?,
    val progressCompleted: Int,
    val progressTotal: Int,
    val latestUpdateText: String?,
    val testsPassed: Int,
    val testsTotal: Int,
    val blockerText: String?,
    val reviewState: String?,
    val attemptCount: Int,
    val changedFiles: List<String> = emptyList(),
    val resultPacketSummary: String? = null,
    val isRootLeader: Boolean = false,
    val professionName: String? = null,
)

data class ActivityFeedItemUiState(
    val id: String,
    val timeAgo: String,
    val message: String,
    val type: CommunicationType?,
)

data class ApprovalOverlayUiState(
    val id: String,
    val requestingNodeName: String,
    val actionSummary: String,
    val details: String,
)

data class OrganizationUiState(
    val organizationId: String = "",
    val rootSessionId: String? = null,
    val objective: String = "",
    val revisionNumber: Int = 1,
    val state: String = "idle",
    val isCompleted: Boolean = false,
    val leaderSummary: String? = null,
    val nodes: List<RenderedNodeUiState> = emptyList(),
    val edges: List<RenderedEdgeUiState> = emptyList(),
    val particles: List<ParticleUiState> = emptyList(),
    val consultation: ConsultationUiState? = null,
    val selectedSheetNode: NodeDetailUiState? = null,
    val activeDetailNode: NodeDetailUiState? = null,
    val activityFeed: List<ActivityFeedItemUiState> = emptyList(),
    val isActivityFeedExpanded: Boolean = false,
    val approvalOverlay: ApprovalOverlayUiState? = null,
    val panOffset: Offset = Offset.Zero,
    val zoomScale: Float = 1.0f,
    val bounds: LayoutBounds = LayoutBounds(0f, 0f, 1000f, 1000f),
    val focusNodeId: String? = null,
    val reduceMotion: Boolean = false,
    val physicsRunning: Boolean = false,
    val isLoading: Boolean = false,
)
