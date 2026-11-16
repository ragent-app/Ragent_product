package com.andysagent.ragent.feature.organization.domain

import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationCommunicationDto
import com.andysagent.ragent.feature.organization.data.OrganizationEventDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto

object OrganizationReducer {

    fun reduceProjection(
        current: OrganizationState,
        dto: OrganizationProjectionDto,
    ): OrganizationState {
        val blockersMap = dto.blockers.associateBy { it.nodeId ?: it.id.orEmpty() }

        val rawNodes = dto.nodes.map { nodeDto ->
            val blocker = blockersMap[nodeDto.id] ?: nodeDto.blocker
            mapNode(nodeDto, blocker)
        }

        val nodesWithExecutive = rawNodes

        // Calculate parent-child relationships and directChildCount
        val childrenByParent = nodesWithExecutive.groupBy { it.parentId }
        val nodes = nodesWithExecutive.associate { node ->
            val children = childrenByParent[node.id].orEmpty()
            val directCount = children.size
            val activeCount = children.count { it.runtimeState == NodeRuntimeState.WORKING || it.runtimeState == NodeRuntimeState.REVIEWING }
            val blockedCount = children.count { it.runtimeState == NodeRuntimeState.BLOCKED }
            node.id to node.copy(
                directChildCount = directCount,
                activeChildCount = activeCount,
                blockedChildCount = blockedCount,
            )
        }

        val edges = dto.edges.map { edgeDto ->
            OrganizationEdgeModel(
                id = edgeDto.id,
                fromNodeId = edgeDto.fromNodeId,
                toNodeId = edgeDto.toNodeId,
                type = if (edgeDto.type.equals("REVIEWS", ignoreCase = true)) EdgeType.REVIEWS else EdgeType.MANAGES,
                state = edgeDto.state ?: "active",
            )
        }

        val phases = dto.phases.map { phaseDto ->
            OrganizationPhaseModel(
                phaseId = phaseDto.phaseId,
                objective = phaseDto.objective,
                isCompleted = phaseDto.state.equals("completed", ignoreCase = true),
                dependsOn = phaseDto.dependsOn,
                acceptanceCriteria = phaseDto.acceptance.map { it.criterion },
            )
        }

        val communications = dto.activeCommunications.map { commDto ->
            OrganizationCommunicationModel(
                id = commDto.id,
                type = CommunicationType.fromString(commDto.type),
                fromNodeId = commDto.fromNodeId,
                toNodeId = commDto.toNodeId,
                subject = commDto.subject,
                priority = commDto.priority,
                occurredAt = commDto.occurredAt.takeIf { it > 0 } ?: System.currentTimeMillis(),
            )
        }

        val blockers = dto.blockers.map { b ->
            OrganizationBlockerModel(
                id = b.id ?: b.nodeId.orEmpty(),
                nodeId = b.nodeId,
                reason = b.reasonCode ?: b.type ?: "Blocker reported",
                createdAt = b.createdAt,
            )
        }

        val recentActivity = dto.recentEvents.mapNotNull { event ->
            mapEventToActivity(event, nodes)
        }

        val isCompleted = dto.state.equals("completed", ignoreCase = true) ||
                (phases.isNotEmpty() && phases.all { it.isCompleted })

        return current.copy(
            organizationId = dto.organizationId,
            rootSessionId = dto.rootSessionId ?: current.rootSessionId,
            revision = dto.revision?.number ?: current.revision,
            objective = dto.objective.ifEmpty { current.objective },
            state = dto.state,
            progressEpoch = dto.progress?.epoch ?: current.progressEpoch,
            sequence = dto.asOf?.eventId ?: current.sequence,
            nodes = nodes,
            edges = edges,
            phases = phases,
            activeCommunications = communications,
            blockers = blockers,
            recentActivity = if (recentActivity.isNotEmpty()) recentActivity else current.recentActivity,
            isCompleted = isCompleted,
            leaderSummary = dto.summary?.let {
                "Organization completed: ${it.completedNodes}/${it.totalNodes} tasks succeeded."
            } ?: current.leaderSummary,
        )
    }

    private fun mapNode(dto: OrganizationNodeDto, blocker: OrganizationBlockerDto?): OrganizationNodeModel {
        val role = NodeRole.fromString(dto.role)
        val domain = AgentDomain.fromExplicit(dto.domain, dto.iconKey)
        val hasBlocker = (blocker != null)
        val runtimeState = NodeRuntimeState.fromString(dto.status, dto.currentActivity, hasBlocker)

        return OrganizationNodeModel(
            id = dto.id,
            parentId = dto.parentId,
            role = role,
            domain = domain ?: AgentDomain.GENERAL,
            hasRecognizedDomain = domain != null,
            professionName = dto.domain?.trim()?.takeIf { it.isNotEmpty() },
            displayName = dto.displayName.ifEmpty { dto.id },
            phaseId = dto.phaseId,
            sessionClass = dto.sessionClass,
            runtimeState = runtimeState,
            sessionId = dto.sessionId,
            currentActivity = dto.currentActivity,
            currentTaskSummary = dto.currentTask?.objective,
            progressCompleted = dto.progress?.completed ?: 0,
            progressTotal = dto.progress?.total ?: 0,
            blockerText = blocker?.reasonCode ?: blocker?.type,
            reviewState = dto.reviewState,
            attemptCount = dto.attemptCount,
            lastChangedAt = System.currentTimeMillis(),
        )
    }

    private fun mapEventToActivity(
        event: OrganizationEventDto,
        nodes: Map<String, OrganizationNodeModel>,
    ): OrganizationActivityEvent? {
        val nodeName = event.nodeId?.let { nodes[it]?.displayName } ?: event.nodeId.orEmpty()
        val text = when (event.type) {
            "node.created" -> "$nodeName joined the organization"
            "node.session_bound" -> "$nodeName initialized session"
            "task.assigned" -> "$nodeName assigned task ${event.taskId.orEmpty()}"
            "task.started" -> "$nodeName started working"
            "task.completed" -> "$nodeName completed task"
            "review.requested" -> "$nodeName requested review"
            "review.passed" -> "$nodeName passed review"
            "blocker.reported", "blocker.escalated" -> "Blocker escalated on $nodeName"
            else -> return null
        }
        return OrganizationActivityEvent(
            id = event.id.toString(),
            fromNodeId = event.nodeId,
            fromName = nodeName,
            message = text,
            timestamp = System.currentTimeMillis(),
        )
    }
}
