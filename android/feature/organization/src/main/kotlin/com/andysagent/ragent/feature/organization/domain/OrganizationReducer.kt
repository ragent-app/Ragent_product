package com.andysagent.ragent.feature.organization.domain

import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationCommunicationDto
import com.andysagent.ragent.feature.organization.data.OrganizationEventDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationPhaseDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardChannelDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardMessageDto
import com.andysagent.ragent.feature.organization.data.SwarmBoardResponseDto
import com.andysagent.ragent.feature.organization.data.SwarmMemberDto
import com.andysagent.ragent.feature.organization.data.SwarmStallAlertDto
import com.andysagent.ragent.feature.organization.data.SwarmStatusDto
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

object OrganizationReducer {

    fun reduceProjection(
        current: OrganizationState,
        dto: OrganizationProjectionDto,
    ): OrganizationState {
        val blockersByNode = dto.blockers.groupBy { it.nodeId ?: it.id.orEmpty() }
        val phasesById = dto.phases.associateBy { it.phaseId }
        val swarmMembers = current.swarmStatus?.members.orEmpty()

        val rawNodes = dto.nodes.map { nodeDto ->
            val mapped = mapNode(
                dto = nodeDto,
                projectionBlockers = blockersByNode[nodeDto.id].orEmpty(),
                phase = nodeDto.phaseId?.let(phasesById::get),
            )
            val swarmMatch = swarmMembers.firstOrNull { member ->
                member.nodeId == mapped.id ||
                    (!mapped.sessionId.isNullOrBlank() && member.currentSessionId == mapped.sessionId)
            }
            if (swarmMatch != null) mergeSwarmMemberIntoNode(mapped, swarmMatch) else mapped
        }

        val nodes = withChildCounts(rawNodes)

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
            val detail = listOfNotNull(
                b.reason?.trim()?.takeIf { it.isNotEmpty() },
                b.reasonCode?.trim()?.takeIf { it.isNotEmpty() },
                b.message?.trim()?.takeIf { it.isNotEmpty() },
                b.type?.trim()?.takeIf { it.isNotEmpty() },
            ).firstOrNull() ?: "Blocker reported"
            OrganizationBlockerModel(
                id = b.id ?: b.nodeId.orEmpty(),
                nodeId = b.nodeId,
                reason = detail,
                createdAt = b.createdAt,
            )
        }

        val recentActivity = dto.recentEvents.mapNotNull { event ->
            mapEventToActivity(event, nodes)
        }

        val isCompleted = dto.state.equals("completed", ignoreCase = true) ||
                (phases.isNotEmpty() && phases.all { it.isCompleted }) ||
                current.swarmStatus?.isDone == true ||
                current.board?.isDone == true

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
            isSyntheticSwarmNodes = false,
        )
    }

    fun reduceSwarmStatus(
        current: OrganizationState,
        dto: SwarmStatusDto?,
    ): OrganizationState {
        if (dto == null) {
            return if (current.isSyntheticSwarmNodes) {
                current.copy(
                    swarmStatus = null,
                    nodes = emptyMap(),
                    edges = emptyList(),
                    isSyntheticSwarmNodes = false,
                )
            } else {
                current.copy(swarmStatus = null)
            }
        }

        val mappedMembers = dto.members.map(::mapSwarmMember)
        val countsDto = dto.counts
        val counts = if (countsDto != null) {
            SwarmCountsModel(
                waiting = countsDto.waiting,
                working = countsDto.working,
                stopped = countsDto.stopped,
                killed = countsDto.killed,
                active = countsDto.active,
                total = countsDto.total,
            )
        } else {
            SwarmCountsModel(
                waiting = mappedMembers.count { it.swarmState.equals("waiting", true) },
                working = mappedMembers.count { it.swarmState.equals("working", true) },
                stopped = mappedMembers.count { it.swarmState.equals("stopped", true) },
                killed = mappedMembers.count { it.swarmState.equals("killed", true) },
                active = mappedMembers.count {
                    it.swarmState.equals("working", true) || it.swarmState.equals("waiting", true)
                },
                total = mappedMembers.size,
            )
        }

        val swarmModel = SwarmStatusModel(
            organizationId = dto.organizationId,
            rootSessionId = dto.rootSessionId,
            mode = dto.mode,
            title = dto.title?.trim()?.takeIf { it.isNotEmpty() },
            headSeq = dto.headSeq,
            isDone = dto.isDone,
            counts = counts,
            members = mappedMembers,
            channels = dto.channels.map(::mapBoardChannel),
            activeStalls = dto.activeStalls.map(::mapStallAlert),
            usageByModel = dto.usageByModel.map { bucket ->
                val label = bucket.modelKey?.takeIf { it.isNotBlank() }
                    ?: "${bucket.tool?.takeIf { it.isNotBlank() } ?: "runtime"}:${bucket.model ?: bucket.provider ?: "default"}"
                SwarmUsageBucketModel(label = label, totalTokens = bucket.totalTokens, costUsd = bucket.costUsd)
            },
        )

        val useSynthetic = current.nodes.isEmpty() || current.isSyntheticSwarmNodes
        val nextNodes = if (useSynthetic) {
            withChildCounts(mappedMembers.map(::synthesizeNodeFromSwarmMember))
        } else {
            withChildCounts(
                current.nodes.values.map { existing ->
                    val match = mappedMembers.firstOrNull { member ->
                        member.nodeId == existing.id ||
                            (!existing.sessionId.isNullOrBlank() && member.currentSessionId == existing.sessionId)
                    }
                    if (match != null) mergeSwarmMemberIntoNode(existing, match) else existing
                }
            )
        }

        val nextEdges = if (useSynthetic) {
            val nodeIds = nextNodes.keys
            mappedMembers.mapNotNull { member ->
                val parentId = member.parentNodeId?.takeIf { it in nodeIds && it != member.nodeId } ?: return@mapNotNull null
                OrganizationEdgeModel(
                    id = "swarm-edge:$parentId->${member.nodeId}",
                    fromNodeId = parentId,
                    toNodeId = member.nodeId,
                    type = EdgeType.MANAGES,
                    state = "active",
                )
            }
        } else {
            current.edges
        }

        return current.copy(
            organizationId = current.organizationId.ifBlank { dto.organizationId.orEmpty() },
            rootSessionId = current.rootSessionId ?: dto.rootSessionId,
            objective = current.objective.ifBlank { dto.title.orEmpty() },
            nodes = nextNodes,
            edges = nextEdges,
            isCompleted = if (useSynthetic) dto.isDone else (current.isCompleted || dto.isDone),
            isSyntheticSwarmNodes = useSynthetic,
            swarmStatus = swarmModel,
        )
    }

    fun reduceBoardResponse(
        current: OrganizationState,
        dto: SwarmBoardResponseDto?,
    ): OrganizationState {
        if (dto == null) {
            return current.copy(
                board = null,
                selectedBoardChannel = null,
                boardReplyToSeq = null,
                boardError = null,
            )
        }

        val activeBoard = dto.activeBoard
        val mergedChannels = buildList {
            addAll(activeBoard?.channels.orEmpty())
            addAll(dto.channels)
        }.distinctBy { it.name }.map(::mapBoardChannel)

        val messages = activeBoard?.messages.orEmpty()
            .map(::mapBoardMessage)
            .sortedBy { it.seq }
        val activeStalls = activeBoard?.activeStalls.orEmpty().map(::mapStallAlert)
        val boardMode = dto.mode ?: activeBoard?.mode
        val readOnly = dto.readOnly || (activeBoard?.readOnly == true) || boardMode != "ragent_swarm"

        val boardModel = SwarmBoardModel(
            organizationId = dto.organizationId ?: activeBoard?.organizationId,
            mode = boardMode,
            source = activeBoard?.source,
            readOnly = readOnly,
            title = activeBoard?.title?.trim()?.takeIf { it.isNotEmpty() },
            headSeq = activeBoard?.headSeq ?: messages.maxOfOrNull { it.seq } ?: 0L,
            isDone = activeBoard?.isDone == true,
            channels = mergedChannels,
            messages = messages,
            hasMore = activeBoard?.hasMore == true,
            activeStalls = activeStalls,
        )

        val validSelected = current.selectedBoardChannel?.takeIf { selected ->
            selected == "__all__" || mergedChannels.any { it.name == selected } || messages.any { it.channel == selected }
        }

        return current.copy(
            organizationId = current.organizationId.ifBlank { boardModel.organizationId.orEmpty() },
            rootSessionId = current.rootSessionId ?: dto.rootSessionId,
            isCompleted = current.isCompleted || boardModel.isDone,
            board = boardModel,
            selectedBoardChannel = validSelected ?: "__all__",
            boardReplyToSeq = if (boardModel.isWritable) current.boardReplyToSeq else null,
            boardComposerDraft = if (boardModel.isWritable) current.boardComposerDraft else "",
        )
    }

    private fun withChildCounts(nodesList: List<OrganizationNodeModel>): Map<String, OrganizationNodeModel> {
        val childrenByParent = nodesList.groupBy { it.parentId }
        return nodesList.associate { node ->
            val children = childrenByParent[node.id].orEmpty()
            node.id to node.copy(
                directChildCount = children.size,
                activeChildCount = children.count {
                    it.runtimeState == NodeRuntimeState.WORKING || it.runtimeState == NodeRuntimeState.REVIEWING
                },
                blockedChildCount = children.count {
                    it.runtimeState == NodeRuntimeState.BLOCKED || it.runtimeState == NodeRuntimeState.FAILED
                },
            )
        }
    }

    private fun mapNode(
        dto: OrganizationNodeDto,
        projectionBlockers: List<OrganizationBlockerDto> = emptyList(),
        phase: OrganizationPhaseDto? = null,
    ): OrganizationNodeModel {
        val role = NodeRole.fromString(dto.role)
        val domain = AgentDomain.fromExplicit(dto.domain, dto.iconKey)
        val allBlockers = (listOfNotNull(dto.blocker) + dto.blockers + projectionBlockers).distinct()
        val packetObj = dto.resultPacket
        val packetBlockers = extractPacketStringList(packetObj, "blockers") +
            extractPacketStringList(packetObj, "unresolvedItems")
        val packetAcceptance = extractPacketStringList(packetObj, "acceptanceNotes")
        val hasBlocker = allBlockers.isNotEmpty() ||
            dto.status.equals("blocked", ignoreCase = true) ||
            packetBlockers.isNotEmpty()
        val rawRuntimeState = NodeRuntimeState.fromString(dto.status, dto.currentActivity, hasBlocker)
        val attemptFailure = dto.attempt?.failureReasonCode?.trim()?.takeIf { it.isNotEmpty() }
        val attemptReason = dto.attempt?.failureReason?.trim()?.takeIf { it.isNotEmpty() }
        val runtimeState = if (!hasBlocker && attemptFailure != null &&
            (dto.status.equals("failed", true) || dto.attempt.runState.equals("failed", true))
        ) {
            NodeRuntimeState.FAILED
        } else {
            rawRuntimeState
        }

        val blockerReasonCodes = allBlockers.mapNotNull { it.reasonCode?.trim()?.takeIf(String::isNotEmpty) }.distinct()
        val concreteBlockerMessages = (
            listOfNotNull(attemptReason) +
                allBlockers.flatMap { listOfNotNull(it.reason, it.message) }
                    .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) } +
                packetBlockers
            ).distinct()
        val fallbackBlockerTags = allBlockers.mapNotNull {
            (it.reasonCode ?: it.type ?: it.kind)?.trim()?.takeIf(String::isNotEmpty)
        }.distinct()
        val failureCode = attemptFailure
            ?: blockerReasonCodes.firstOrNull()
            ?: fallbackBlockerTags.firstOrNull()
            ?: concreteBlockerMessages.firstOrNull()
        val blockerText = concreteBlockerMessages.takeIf { it.isNotEmpty() }?.joinToString(" · ")
            ?: fallbackBlockerTags.firstOrNull()
            ?: attemptFailure

        val packetId = (dto.attempt?.resultPacketId
            ?: dto.resultPacketId
            ?: (packetObj?.get("id") as? JsonPrimitive)?.contentOrNull)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        val packetVerdict = (dto.attempt?.verdict
            ?: (packetObj?.get("verdict") as? JsonPrimitive)?.contentOrNull
            ?: (packetObj?.get("state") as? JsonPrimitive)?.contentOrNull)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        val packetSummaryBody = (
            (packetObj?.get("summary") as? JsonPrimitive)?.contentOrNull
                ?: dto.attempt?.summary
            )?.trim()?.takeIf { it.isNotEmpty() }
        val structuredPacketSummary = buildList {
            if (packetVerdict != null && !packetVerdict.equals("completed", true) &&
                (packetSummaryBody == null || !packetSummaryBody.contains(packetVerdict, ignoreCase = true))
            ) {
                add(packetVerdict)
            }
            if (packetSummaryBody != null) add(packetSummaryBody)
            else if (packetAcceptance.isNotEmpty()) add(packetAcceptance.joinToString(" · "))
        }.joinToString(": ").takeIf { it.isNotBlank() }
        val rawSummary = dto.resultPacketSummary?.trim()?.takeIf { it.isNotEmpty() }
            ?: dto.resultSummary?.trim()?.takeIf { it.isNotEmpty() }
            ?: structuredPacketSummary
        val resultPacketSummary = rawSummary ?: packetId?.let { "ResultPacket: $it" }

        val rawReview = dto.reviewState?.trim()?.takeIf { it.isNotEmpty() }
        val phaseReview = phase?.reviewState?.trim()?.takeIf { it.isNotEmpty() }
        val effectiveReviewState = when {
            rawReview != null && !rawReview.equals("not_applicable", ignoreCase = true) -> rawReview
            phaseReview.equals("needs_changes", ignoreCase = true) ||
                phaseReview.equals("rejected", ignoreCase = true) -> phaseReview
            else -> rawReview
        }
        val effectiveSessionId = dto.currentBinding?.sessionId?.takeIf { it.isNotBlank() } ?: dto.sessionId

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
            sessionId = effectiveSessionId,
            currentActivity = dto.currentActivity ?: dto.activity?.kind,
            currentTaskSummary = dto.currentTask?.objective,
            progressCompleted = dto.progress?.completed ?: 0,
            progressTotal = dto.progress?.total ?: 0,
            blockerText = blockerText,
            reviewState = effectiveReviewState,
            attemptCount = dto.attemptCount,
            lastChangedAt = System.currentTimeMillis(),
            resultPacketId = packetId,
            resultPacketSummary = resultPacketSummary,
            failureCode = failureCode,
        )
    }

    private fun extractPacketStringList(packet: JsonObject?, key: String): List<String> {
        val arr = packet?.get(key) as? JsonArray ?: return emptyList()
        return arr.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }
    }

    private fun mapSwarmMember(dto: SwarmMemberDto): SwarmMemberModel {
        val id = dto.nodeId.ifBlank { dto.id }.ifBlank { dto.stableKey }
        val domain = AgentDomain.fromExplicit(dto.domain, null)
        return SwarmMemberModel(
            nodeId = id,
            displayName = dto.name.ifBlank { dto.stableKey }.ifBlank { id },
            role = NodeRole.fromString(dto.role),
            domain = domain ?: AgentDomain.GENERAL,
            hasRecognizedDomain = domain != null,
            professionName = dto.domain?.trim()?.takeIf { it.isNotEmpty() },
            parentNodeId = dto.parentNodeId?.takeIf { it.isNotBlank() },
            currentSessionId = dto.currentSessionId?.takeIf { it.isNotBlank() },
            swarmState = dto.swarmState.lowercase(),
            lifecycleState = dto.lifecycleState?.lowercase(),
            sessionClass = dto.sessionClass,
            harness = dto.harness?.trim()?.takeIf { it.isNotEmpty() } ?: dto.provider?.trim()?.takeIf { it.isNotEmpty() },
            provider = dto.provider?.trim()?.takeIf { it.isNotEmpty() },
            model = dto.model?.trim()?.takeIf { it.isNotEmpty() },
            workspaceMode = dto.workspaceMode?.trim()?.takeIf { it.isNotEmpty() },
            workspaceBranch = dto.workspaceBranch?.trim()?.takeIf { it.isNotEmpty() },
            lastStateReason = dto.lastStateReason?.trim()?.takeIf { it.isNotEmpty() },
            lastRunFailureReason = dto.lastRunFailure?.reason?.trim()?.takeIf { it.isNotEmpty() },
            lastRunFailureState = dto.lastRunFailure?.state?.trim()?.takeIf { it.isNotEmpty() },
        )
    }

    private fun synthesizeNodeFromSwarmMember(member: SwarmMemberModel): OrganizationNodeModel {
        val failure = member.lastRunFailureReason ?: member.lastStateReason?.takeIf {
            member.lifecycleState == "blocked" || member.lifecycleState == "failed" || member.lastRunFailureState == "failed"
        }
        val runtimeState = when {
            member.lifecycleState == "blocked" -> NodeRuntimeState.BLOCKED
            member.lastRunFailureReason != null || member.lifecycleState == "failed" -> NodeRuntimeState.FAILED
            member.swarmState == "working" -> NodeRuntimeState.WORKING
            member.swarmState == "waiting" -> NodeRuntimeState.WAITING
            member.swarmState == "stopped" || member.swarmState == "killed" -> {
                if (member.lifecycleState == "completed" || member.lifecycleState == "done") NodeRuntimeState.DONE
                else NodeRuntimeState.PAUSED
            }
            else -> NodeRuntimeState.fromString(member.lifecycleState, null, false)
        }
        return OrganizationNodeModel(
            id = member.nodeId,
            parentId = member.parentNodeId,
            role = member.role,
            domain = member.domain,
            hasRecognizedDomain = member.hasRecognizedDomain,
            professionName = member.professionName,
            displayName = member.displayName,
            sessionClass = member.sessionClass,
            runtimeState = runtimeState,
            sessionId = member.currentSessionId,
            currentActivity = member.swarmState,
            blockerText = failure,
            failureCode = failure,
            harness = member.harness,
            workspaceMode = member.workspaceMode,
            workspaceBranch = member.workspaceBranch,
        )
    }

    private fun mergeSwarmMemberIntoNode(
        node: OrganizationNodeModel,
        member: SwarmMemberModel,
    ): OrganizationNodeModel {
        val swarmFailure = member.lastRunFailureReason ?: member.lastStateReason?.takeIf {
            node.runtimeState == NodeRuntimeState.BLOCKED || node.runtimeState == NodeRuntimeState.FAILED || member.lastRunFailureState == "failed"
        }
        val mergedFailure = node.failureCode?.takeIf { it.isNotBlank() } ?: swarmFailure
        val mergedBlocker = node.blockerText?.takeIf { it.isNotBlank() }
            ?: if (node.runtimeState == NodeRuntimeState.BLOCKED || node.runtimeState == NodeRuntimeState.FAILED || member.lastRunFailureReason != null) {
                mergedFailure
            } else {
                null
            }
        val upgradedState = if (node.runtimeState == NodeRuntimeState.IDLE && member.lastRunFailureReason != null) {
            NodeRuntimeState.FAILED
        } else {
            node.runtimeState
        }
        return node.copy(
            runtimeState = upgradedState,
            blockerText = mergedBlocker,
            failureCode = mergedFailure,
            harness = node.harness ?: member.harness,
            workspaceMode = node.workspaceMode ?: member.workspaceMode,
            workspaceBranch = node.workspaceBranch ?: member.workspaceBranch,
        )
    }

    private fun mapBoardChannel(dto: SwarmBoardChannelDto): SwarmBoardChannelModel =
        SwarmBoardChannelModel(
            name = dto.name,
            topic = dto.topic?.trim()?.takeIf { it.isNotEmpty() },
            messageCount = dto.messageCount,
            latestSeq = dto.latestSeq,
            unreadCount = dto.unreadCount,
        )

    private fun mapBoardMessage(dto: SwarmBoardMessageDto): SwarmBoardMessageModel =
        SwarmBoardMessageModel(
            id = dto.id?.takeIf { it.isNotBlank() } ?: "seq:${dto.seq}",
            seq = dto.seq,
            channel = dto.channel.ifBlank { "main" },
            senderKind = dto.senderKind,
            senderNodeId = dto.senderNodeId,
            senderName = dto.resolvedSender,
            senderRole = dto.senderRole?.trim()?.takeIf { it.isNotEmpty() },
            senderHarness = dto.senderHarness?.trim()?.takeIf { it.isNotEmpty() },
            kind = dto.kind,
            bodyMarkdown = dto.displayBody,
            mentions = dto.mentions,
            replyToSeq = dto.replyToSeq,
            artifactRefs = dto.artifactRefs.map { ref ->
                val label = ref.title?.takeIf { it.isNotBlank() }
                    ?: ref.label?.takeIf { it.isNotBlank() }
                    ?: ref.path?.takeIf { it.isNotBlank() }
                    ?: ref.packetId?.takeIf { it.isNotBlank() }
                    ?: ref.ref?.takeIf { it.isNotBlank() }
                    ?: ref.id
                SwarmBoardArtifactRefModel(
                    id = ref.id.ifBlank { label },
                    kind = ref.kind,
                    label = label,
                    packetId = ref.packetId,
                    path = ref.path,
                )
            },
            isDoneSignal = dto.isDoneSignal || dto.kind == "done",
            isStallAlert = dto.isStallAlert || dto.kind == "stall",
            createdAt = dto.createdAt,
        )

    private fun mapStallAlert(dto: SwarmStallAlertDto): SwarmStallAlertModel {
        val reason = dto.details?.get("reason")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: dto.conditionKind?.takeIf { it.isNotBlank() }
        return SwarmStallAlertModel(
            id = dto.id.ifBlank { dto.dedupeKey ?: "stall:${dto.boardSeq ?: 0L}" },
            conditionKind = dto.conditionKind,
            targetRole = dto.targetRole,
            targetNodeId = dto.targetNodeId,
            boardSeq = dto.boardSeq,
            reason = reason,
            alertCount = dto.alertCount,
            lastAlertAt = dto.lastAlertAt,
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
