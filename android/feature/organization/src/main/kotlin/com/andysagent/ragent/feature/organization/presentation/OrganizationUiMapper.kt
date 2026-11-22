package com.andysagent.ragent.feature.organization.presentation

import androidx.compose.ui.geometry.Offset
import com.andysagent.ragent.feature.organization.animation.NodeAppearanceAnimation
import com.andysagent.ragent.feature.organization.animation.ParticleAnimation
import com.andysagent.ragent.feature.organization.domain.EdgeType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.domain.OrganizationNodeModel
import com.andysagent.ragent.feature.organization.domain.OrganizationState
import com.andysagent.ragent.feature.organization.domain.SwarmStallAlertModel
import com.andysagent.ragent.feature.organization.layout.LayoutResult
import java.util.Locale

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
                val failureCode = node?.failureCode
                val resultPacketId = node?.resultPacketId
                val resultPacketSummary = node?.resultPacketSummary

                val effectiveScale = anim?.nodeScale ?: pos.scale
                val effectiveAlpha = anim?.nodeAlpha ?: pos.alpha

                // Section 63 Accessibility semantic text
                val a11y = buildString {
                    append("$name, ")
                    append(when (runtimeState) {
                        NodeRuntimeState.WORKING -> "working"
                        NodeRuntimeState.WAITING -> "waiting"
                        NodeRuntimeState.BLOCKED -> "blocked"
                        NodeRuntimeState.FAILED -> "failed"
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
                    if (!blockerText.isNullOrBlank() && (hasBlocker || runtimeState == NodeRuntimeState.FAILED)) {
                        append(", blocker: $blockerText")
                    }
                    if (!failureCode.isNullOrBlank() && failureCode != blockerText) {
                        append(", failure: $failureCode")
                    }
                    if (node?.reviewState.equals("needs_changes", ignoreCase = true) ||
                        node?.reviewState.equals("rejected", ignoreCase = true)
                    ) {
                        append(", review: ${node?.reviewState}")
                    }
                    if (!resultPacketSummary.isNullOrBlank()) {
                        append(", $resultPacketSummary")
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
                    failureCode = failureCode,
                    resultPacketId = resultPacketId,
                    resultPacketSummary = resultPacketSummary,
                    harness = node?.harness,
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
            swarmOverview = mapSwarmOverview(state),
            swarmBoard = mapSwarmBoard(state),
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
            resultPacketId = node.resultPacketId,
            resultPacketSummary = node.resultPacketSummary,
            isRootLeader = (node.role == NodeRole.EXECUTIVE),
            failureCode = node.failureCode,
            harness = node.harness,
            workspaceBranch = node.workspaceBranch,
        )
    }

    private fun mapSwarmOverview(state: OrganizationState): SwarmOverviewUiState? {
        val status = state.swarmStatus
        val board = state.board
        if (status == null && board == null) return null

        val rawStalls = status?.activeStalls?.takeIf { it.isNotEmpty() } ?: board?.activeStalls.orEmpty()
        val stalls = rawStalls.map(::mapStallBadge)
        val isReadOnlyNative = (board?.mode == "provider_native" || status?.mode == "provider_native" || board?.readOnly == true)

        if (status != null) {
            val harnessCounts = linkedMapOf<String, Int>()
            val branchLabels = linkedSetOf<String>()
            for (member in status.members) {
                if (member.swarmState.equals("killed", ignoreCase = true)) continue
                val harness = (member.harness ?: member.provider)?.trim()?.lowercase(Locale.ROOT)
                if (!harness.isNullOrEmpty()) {
                    harnessCounts[harness] = (harnessCounts[harness] ?: 0) + 1
                }
                val wsMode = member.workspaceMode?.lowercase(Locale.ROOT) ?: "inherit"
                if (wsMode == "worktree" || wsMode == "staging" || !member.workspaceBranch.isNullOrBlank()) {
                    val label = if (!member.workspaceBranch.isNullOrBlank()) {
                        "${if (wsMode == "staging") "staging" else "branch"}: ${member.workspaceBranch}"
                    } else {
                        "$wsMode: ${member.displayName}"
                    }
                    branchLabels.add(label)
                }
            }
            val usageLabels = status.usageByModel.map { bucket ->
                if (bucket.totalTokens > 0L || bucket.costUsd > 0.0) {
                    val costSuffix = if (bucket.costUsd > 0.0) String.format(Locale.US, ", $%.4f", bucket.costUsd) else ""
                    "${bucket.label} (${bucket.totalTokens} tok$costSuffix)"
                } else {
                    bucket.label
                }
            }
            val nativeMode = isReadOnlyNative && status.mode != "ragent_swarm"
            return SwarmOverviewUiState(
                mode = status.mode ?: board?.mode,
                title = status.title ?: board?.title,
                workingCount = status.counts.working,
                waitingCount = status.counts.waiting,
                stoppedCount = status.counts.stopped,
                killedCount = status.counts.killed,
                activeCount = status.counts.active,
                totalCount = status.counts.total,
                isDone = status.isDone || (board?.isDone == true),
                showSwarmCounts = !nativeMode,
                isReadOnlyNative = nativeMode,
                harnesses = harnessCounts.map { (harness, count) -> SwarmHarnessBadgeUiState(harness, count) },
                branches = branchLabels.toList(),
                stalls = stalls,
                usageLabels = usageLabels,
            )
        }

        val activeBoard = board ?: return null
        return SwarmOverviewUiState(
            mode = activeBoard.mode,
            title = activeBoard.title,
            totalCount = state.nodes.size,
            isDone = activeBoard.isDone,
            showSwarmCounts = false,
            isReadOnlyNative = activeBoard.readOnly || activeBoard.mode != "ragent_swarm",
            stalls = stalls,
        )
    }

    private fun mapSwarmBoard(state: OrganizationState): SwarmBoardUiState? {
        val board = state.board ?: return null
        val selectedChannel = state.selectedBoardChannel?.takeIf { it.isNotBlank() } ?: "__all__"

        val channelStats = linkedMapOf<String, Pair<Int, Int>>()
        board.channels.forEach { ch ->
            channelStats[ch.name] = ch.messageCount to ch.unreadCount
        }
        board.messages.forEach { msg ->
            if (!channelStats.containsKey(msg.channel)) {
                channelStats[msg.channel] = board.messages.count { it.channel == msg.channel } to 0
            }
        }
        if (channelStats.isEmpty()) {
            channelStats["main"] = board.messages.size to 0
        }

        val totalMsgCount = maxOf(board.messages.size, channelStats.values.sumOf { it.first })
        val totalUnread = channelStats.values.sumOf { it.second }
        val channelTabs = buildList {
            add(
                SwarmBoardChannelTabUiState(
                    id = "__all__",
                    label = "All",
                    messageCount = totalMsgCount,
                    unreadCount = totalUnread,
                    selected = selectedChannel == "__all__",
                )
            )
            channelStats.forEach { (name, counts) ->
                add(
                    SwarmBoardChannelTabUiState(
                        id = name,
                        label = "#$name",
                        messageCount = counts.first,
                        unreadCount = counts.second,
                        selected = selectedChannel == name,
                    )
                )
            }
        }

        val visibleMessages = if (selectedChannel == "__all__") {
            board.messages
        } else {
            board.messages.filter { it.channel == selectedChannel }
        }.map { msg ->
            SwarmBoardMessageUiState(
                id = msg.id,
                seq = msg.seq,
                channel = msg.channel,
                senderKind = msg.senderKind,
                senderNodeId = msg.senderNodeId,
                senderName = msg.senderName,
                senderRole = msg.senderRole,
                senderHarness = msg.senderHarness,
                kind = msg.kind,
                bodyMarkdown = msg.bodyMarkdown,
                mentions = msg.mentions,
                replyToSeq = msg.replyToSeq,
                artifactLabels = msg.artifactRefs.map { it.label }.filter { it.isNotBlank() },
                isDoneSignal = msg.isDoneSignal,
                isStallAlert = msg.isStallAlert,
                createdAt = msg.createdAt,
            )
        }

        return SwarmBoardUiState(
            mode = board.mode,
            title = board.title,
            headSeq = board.headSeq,
            isDone = board.isDone,
            readOnly = board.readOnly,
            isWritable = board.isWritable,
            channels = channelTabs,
            selectedChannel = selectedChannel,
            messages = visibleMessages,
            activeStalls = board.activeStalls.map(::mapStallBadge),
            replyToSeq = state.boardReplyToSeq,
            composerDraft = state.boardComposerDraft,
            isPosting = state.boardPosting,
            postError = state.boardError,
        )
    }

    private fun mapStallBadge(stall: SwarmStallAlertModel): SwarmStallBadgeUiState {
        val detail = stall.reason ?: stall.conditionKind ?: "stall"
        val target = stall.targetNodeId?.takeIf { it.isNotBlank() } ?: stall.targetRole?.takeIf { it.isNotBlank() }
        val countSuffix = if (stall.alertCount > 1) " ×${stall.alertCount}" else ""
        val targetSuffix = if (target != null) " ($target)" else ""
        return SwarmStallBadgeUiState(
            id = stall.id,
            label = "[stall] $detail$targetSuffix$countSuffix",
        )
    }
}
