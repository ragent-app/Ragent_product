package com.andysagent.ragent.feature.organization.layout

import com.andysagent.ragent.feature.organization.domain.EdgeType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.OrganizationEdgeModel
import com.andysagent.ragent.feature.organization.domain.OrganizationNodeModel
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

data class NodePosition(
    val id: String,
    val x: Float,
    val y: Float,
    val radius: Float,
    val isVisible: Boolean = true,
    val isCluster: Boolean = false,
    val clusterCount: Int = 0,
    val clusterChildIds: List<String> = emptyList(),
    val alpha: Float = 1.0f,
    val scale: Float = 1.0f,
    val isFocused: Boolean = false,
)

data class EdgePoint(val x: Float, val y: Float)

data class EdgePathModel(
    val id: String,
    val fromNodeId: String,
    val toNodeId: String,
    val start: EdgePoint,
    val end: EdgePoint,
    val control1: EdgePoint? = null,
    val control2: EdgePoint? = null,
    val isCurved: Boolean = true,
    val alpha: Float = 1.0f,
)

data class LayoutBounds(
    val minX: Float,
    val minY: Float,
    val maxX: Float,
    val maxY: Float,
) {
    val width: Float get() = max(1f, maxX - minX)
    val height: Float get() = max(1f, maxY - minY)
    val centerX: Float get() = (minX + maxX) / 2f
    val centerY: Float get() = (minY + maxY) / 2f
}

data class LayoutResult(
    val nodePositions: Map<String, NodePosition>,
    val edges: List<EdgePathModel>,
    val bounds: LayoutBounds,
    val rootId: String?,
)

class OrganizationLayoutEngine {

    // Threshold for automatic clustering (> 5 direct children)
    val clusterThreshold = 5

    fun computeLayout(
        nodes: Map<String, OrganizationNodeModel>,
        edges: List<OrganizationEdgeModel>,
        viewportWidth: Float,
        viewportHeight: Float,
        focusNodeId: String? = null,
        collapsedClusterIds: Set<String> = emptySet(),
        previousPositions: Map<String, EdgePoint> = emptyMap(),
    ): LayoutResult {
        if (nodes.isEmpty()) {
            return LayoutResult(
                nodePositions = emptyMap(),
                edges = emptyList(),
                bounds = LayoutBounds(0f, 0f, viewportWidth, viewportHeight),
                rootId = null,
            )
        }

        val rootNode = nodes.values.firstOrNull { it.role == NodeRole.EXECUTIVE }
            ?: nodes.values.firstOrNull { it.parentId == null }
            ?: nodes.values.first()

        val rootId = rootNode.id
        val centerX = viewportWidth / 2f
        val rootY = max(120f, viewportHeight * 0.18f)

        val childrenByParent = nodes.values.groupBy { it.parentId }
        val calculatedPositions = mutableMapOf<String, EdgePoint>()
        val clusterNodes = mutableMapOf<String, NodePosition>()

        // 1. Position Root Executive
        val rootPos = previousPositions[rootId] ?: EdgePoint(centerX, rootY)
        calculatedPositions[rootId] = rootPos

        // 2. Direct leads of Root (Level 1)
        val level1Nodes = childrenByParent[rootId].orEmpty()
        val level1Count = level1Nodes.size

        if (level1Count > 0) {
            val fanRadius = max(180f, 60f + level1Count * 30f)
            val idealPoints = RadialLayout.calculateFanPositions(
                centerX = rootPos.x,
                centerY = rootPos.y,
                radius = fanRadius,
                count = level1Count,
                arcDegrees = min(170f, max(90f, level1Count * 35f)),
                centerAngleDegrees = 90f,
            )

            level1Nodes.forEachIndexed { index, node ->
                val prev = previousPositions[node.id]
                val point = prev ?: idealPoints[index]
                calculatedPositions[node.id] = point
            }
        }

        // 3. Level 2+ Workers / Subtrees
        for (lead in level1Nodes) {
            val leadPos = calculatedPositions[lead.id] ?: continue
            val children = childrenByParent[lead.id].orEmpty()
            if (children.isEmpty()) continue

            val isFocused = (focusNodeId == lead.id)
            val shouldCluster = (children.size > clusterThreshold && !isFocused && !collapsedClusterIds.contains(lead.id))

            if (shouldCluster) {
                // Group into cluster
                val clusterId = "cluster_${lead.id}"
                val clusterY = leadPos.y + 110f
                val clusterPos = EdgePoint(leadPos.x, clusterY)
                calculatedPositions[clusterId] = clusterPos
                clusterNodes[clusterId] = NodePosition(
                    id = clusterId,
                    x = clusterPos.x,
                    y = clusterPos.y,
                    radius = 20f,
                    isVisible = true,
                    isCluster = true,
                    clusterCount = children.size,
                    clusterChildIds = children.map { it.id },
                    alpha = if (focusNodeId != null && focusNodeId != lead.id && focusNodeId != rootId) 0.45f else 1.0f,
                )
            } else {
                // Expanded children layout
                val childPositions = FocusTreeLayout.layoutChildren(
                    parentPoint = leadPos,
                    children = children,
                    verticalSpacing = 110f,
                    horizontalSpacing = 90f,
                )
                childPositions.forEach { (childId, pt) ->
                    val pos = previousPositions[childId] ?: pt
                    calculatedPositions[childId] = pos
                }
            }
        }

        // Position any remaining unassigned nodes
        nodes.values.forEach { node ->
            if (!calculatedPositions.containsKey(node.id)) {
                val parentPt = node.parentId?.let { calculatedPositions[it] } ?: rootPos
                val offset = (node.id.hashCode() % 60).toFloat()
                calculatedPositions[node.id] = EdgePoint(parentPt.x + offset, parentPt.y + 100f)
            }
        }

        // Build NodePosition objects
        val nodePositions = mutableMapOf<String, NodePosition>()
        nodes.values.forEach { node ->
            val pt = calculatedPositions[node.id] ?: return@forEach
            val isFocused = (node.id == focusNodeId)
            val isDimmed = (focusNodeId != null && focusNodeId != rootId && node.id != focusNodeId && node.parentId != focusNodeId)

            val radius = when (node.role) {
                NodeRole.EXECUTIVE -> 24f
                NodeRole.MANAGER -> 20f
                NodeRole.REVIEWER -> 16f
                NodeRole.EXPERT -> 18f
                NodeRole.WORKER -> 16f
            }

            // If node is hidden because it's in a cluster
            val isHiddenInCluster = clusterNodes.values.any { it.clusterChildIds.contains(node.id) }
            if (!isHiddenInCluster) {
                nodePositions[node.id] = NodePosition(
                    id = node.id,
                    x = pt.x,
                    y = pt.y,
                    radius = radius,
                    isVisible = true,
                    isCluster = false,
                    clusterCount = 0,
                    alpha = if (isDimmed) 0.4f else 1.0f,
                    scale = if (isFocused) 1.08f else 1.0f,
                    isFocused = isFocused,
                )
            }
        }

        // Add cluster nodes to position map
        nodePositions.putAll(clusterNodes)

        // 4. Edge routing
        val edgePaths = mutableListOf<EdgePathModel>()
        edges.forEach { edge ->
            val fromPos = calculatedPositions[edge.fromNodeId]
            var toPos = calculatedPositions[edge.toNodeId]

            // If target is inside a cluster, point edge to the cluster node
            val containingCluster = clusterNodes.values.firstOrNull { it.clusterChildIds.contains(edge.toNodeId) }
            if (containingCluster != null) {
                toPos = EdgePoint(containingCluster.x, containingCluster.y)
            }

            if (fromPos != null && toPos != null) {
                val isReview = (edge.type == EdgeType.REVIEWS)
                val alpha = if (focusNodeId != null && edge.fromNodeId != focusNodeId && edge.toNodeId != focusNodeId) 0.3f else 0.85f
                edgePaths.add(
                    EdgeRouter.routeEdge(
                        edgeId = edge.id,
                        fromNodeId = edge.fromNodeId,
                        toNodeId = if (containingCluster != null) containingCluster.id else edge.toNodeId,
                        from = fromPos,
                        to = toPos,
                        alpha = alpha,
                    )
                )
            }
        }

        // Also add edges from leads to their cluster nodes
        clusterNodes.forEach { (clusterId, clusterNode) ->
            val leadId = clusterId.removePrefix("cluster_")
            val leadPos = calculatedPositions[leadId]
            if (leadPos != null) {
                edgePaths.add(
                    EdgeRouter.routeEdge(
                        edgeId = "edge_$clusterId",
                        fromNodeId = leadId,
                        toNodeId = clusterId,
                        from = leadPos,
                        to = EdgePoint(clusterNode.x, clusterNode.y),
                        alpha = 0.85f,
                    )
                )
            }
        }

        // 5. Calculate Bounds
        var minX = Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxX = Float.MIN_VALUE
        var maxY = Float.MIN_VALUE

        nodePositions.values.forEach { pos ->
            minX = min(minX, pos.x - 48f)
            maxX = max(maxX, pos.x + 48f)
            minY = min(minY, pos.y - 48f)
            maxY = max(maxY, pos.y + 48f)
        }

        if (minX == Float.MAX_VALUE) {
            minX = 0f; maxX = viewportWidth; minY = 0f; maxY = viewportHeight
        }

        val bounds = LayoutBounds(minX, minY, maxX, maxY)

        return LayoutResult(
            nodePositions = nodePositions,
            edges = edgePaths,
            bounds = bounds,
            rootId = rootId,
        )
    }
}
