package com.andysagent.ragent.feature.organization.presentation

import androidx.compose.ui.geometry.Offset
import com.andysagent.ragent.feature.organization.animation.NodeAppearanceAnimation
import com.andysagent.ragent.feature.organization.animation.ParticleAnimation
import com.andysagent.ragent.feature.organization.domain.EdgeType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.domain.OrganizationNodeModel
import com.andysagent.ragent.feature.organization.domain.OrganizationState
import com.andysagent.ragent.feature.organization.layout.LayoutResult

object OrganizationUiMapper {

    fun mapToUiState(
        state: OrganizationState,
        layout: LayoutResult,
        nodeAnimations: Map<String, NodeAppearanceAnimation>,
        activeParticles: List<ParticleAnimation>,
        panOffset: Offset,
        zoomScale: Float,
        focusNodeId: String?,
        selectedSheetNodeId: String?,
        activeDetailNodeId: String?,
        isActivityFeedExpanded: Boolean,
        reduceMotion: Boolean,
    ): OrganizationUiState {
        val renderedNodes = layout.nodePositions.values.map { pos ->
            if (pos.isCluster) {
                RenderedNodeUiState(
                    id = pos.id,
                    x = pos.x,
                    y = pos.y,
                    radiusDp = pos.radius,
                    role = NodeRole.MANAGER,
                    domain = com.andysagent.ragent.feature.organization.domain.AgentDomain.GENERAL,
                    displayName = "Cluster (${pos.clusterCount})",
                    runtimeState = NodeRuntimeState.IDLE,
                    isCluster = true,
                    clusterCount = pos.clusterCount,
                    clusterChildIds = pos.clusterChildIds,
                    alpha = pos.alpha,
                    scale = pos.scale,
                    isFocused = (pos.id == focusNodeId),
                    accessibilityText = "Team cluster, ${pos.clusterCount} agents. Double tap to expand subtree.",
                )
            } else {
                val node = state.nodes[pos.id]
                val anim = nodeAnimations[pos.id]
                val role = node?.role ?: NodeRole.UNKNOWN
                val domain = node?.domain ?: com.andysagent.ragent.feature.organization.domain.AgentDomain.GENERAL
                val name = node?.displayName ?: pos.id
                val runtimeState = node?.runtimeState ?: NodeRuntimeState.IDLE
                val hasBlocker = (runtimeState == NodeRuntimeState.BLOCKED)
                val blockerText = node?.blockerText

                val effectiveScale = anim?.nodeScale ?: pos.scale
                val effectiveAlpha = anim?.nodeAlpha ?: pos.alpha

                // Section 63 Accessibility semantic text
                val a11y = buildString {
                    append("$name, ")
                    append(when (runtimeState) {
                        NodeRuntimeState.WORKING -> "working"
                        NodeRuntimeState.WAITING -> "waiting"
                        NodeRuntimeState.BLOCKED -> "blocked"
                        NodeRuntimeState.REVIEWING -> "reviewing"
                        NodeRuntimeState.DONE -> "completed"
                        NodeRuntimeState.PROVISIONING -> "provisioning"
                        else -> "idle"
                    })
                    if (node != null && node.activeChildCount > 0) {
                        append(", ${node.activeChildCount} active children")
                    }
                    if (!node?.currentTaskSummary.isNullOrBlank()) {
                        append(", current task: ${node?.currentTaskSummary}")
                    }
                    if (hasBlocker && !blockerText.isNullOrBlank()) {
                        append(", blocker: $blockerText")
                    }
                }

                RenderedNodeUiState(
                    id = pos.id,
                    x = pos.x,
                    y = pos.y,
                    radiusDp = pos.radius,
                    role = role,
                    domain = domain,
                    hasRecognizedDomain = node?.hasRecognizedDomain == true,
                    professionName = node?.professionName,
                    displayName = name,
                    runtimeState = runtimeState,
                    isCluster = false,
                    alpha = effectiveAlpha,
                    scale = effectiveScale,
                    isFocused = (pos.id == focusNodeId),
                    currentActivity = node?.currentActivity,
                    taskSummary = node?.currentTaskSummary,
                    hasBlocker = hasBlocker,
                    blockerText = blockerText,
                    reviewState = node?.reviewState,
                    attemptCount = node?.attemptCount ?: 1,
                    testsPassed = node?.testsPassed ?: 0,
                    testsTotal = node?.testsTotal ?: 0,
                    accessibilityText = a11y,
                )
            }
        }

        val renderedEdges = layout.edges.map { edgePath ->
            val anim = nodeAnimations[edgePath.toNodeId]
            val growth = anim?.edgeProgress ?: 1.0f
            val edgeModel = state.edges.firstOrNull { it.id == edgePath.id }
            val isReview = edgeModel?.type == EdgeType.REVIEWS

            RenderedEdgeUiState(
                id = edgePath.id,
                fromNodeId = edgePath.fromNodeId,
                toNodeId = edgePath.toNodeId,
                start = edgePath.start,
                end = edgePath.end,
                control1 = edgePath.control1,
                control2 = edgePath.control2,
                isCurved = edgePath.isCurved,
                isReview = isReview,
                alpha = edgePath.alpha,
                growthProgress = growth,
            )
        }

        val particles = activeParticles.map { p ->
            val pt = p.currentPosition
            ParticleUiState(
                id = p.id,
                type = p.type,
                x = pt.x,
                y = pt.y,
                progress = p.progress,
            )
        }

        val selectedSheetNode = selectedSheetNodeId?.let { id ->
            state.nodes[id]?.let { mapToDetailState(it) }
        }

        val activeDetailNode = activeDetailNodeId?.let { id ->
            state.nodes[id]?.let { mapToDetailState(it) }
        }

        val feedItems = state.recentActivity.take(15).map { act ->
            ActivityFeedItemUiState(
                id = act.id,
                timeAgo = "",
                message = act.message,
                type = act.type,
            )
        }

        // Check if any node is waiting for approval
        // A blocked node is not evidence of an approval request. The old
        // controls had no server command behind them, so do not present them.
        val approvalOverlay: ApprovalOverlayUiState? = null

        return OrganizationUiState(
            organizationId = state.organizationId,
            rootSessionId = state.rootSessionId,
            objective = state.objective,
            revisionNumber = state.revision,
            state = state.state,
            isCompleted = state.isCompleted,
            leaderSummary = state.leaderSummary,
            nodes = renderedNodes,
            edges = renderedEdges,
            particles = particles,
            consultation = null, // Can be wired with consultation round
            selectedSheetNode = selectedSheetNode,
            activeDetailNode = activeDetailNode,
            activityFeed = feedItems,
            isActivityFeedExpanded = isActivityFeedExpanded,
            approvalOverlay = approvalOverlay,
            panOffset = panOffset,
            zoomScale = zoomScale,
            bounds = layout.bounds,
            focusNodeId = focusNodeId,
            reduceMotion = reduceMotion,
            isLoading = false,
        )
    }

    fun mapToDetailState(node: OrganizationNodeModel): NodeDetailUiState {
        return NodeDetailUiState(
            id = node.id,
            displayName = node.displayName,
            role = node.role,
            domain = node.domain,
            professionName = node.professionName,
            runtimeState = node.runtimeState,
            sessionId = node.sessionId,
            currentTaskSummary = node.currentTaskSummary,
            currentTaskDetail = node.currentTaskDetail,
            currentActivity = node.currentActivity,
            progressCompleted = node.progressCompleted,
            progressTotal = node.progressTotal,
            latestUpdateText = null,
            testsPassed = node.testsPassed,
            testsTotal = node.testsTotal,
            blockerText = node.blockerText,
            reviewState = node.reviewState,
            attemptCount = node.attemptCount,
            changedFiles = node.changedFiles,
            resultPacketSummary = node.resultPacketSummary,
            isRootLeader = (node.role == NodeRole.EXECUTIVE),
        )
    }
}
