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
        density: Float = 1f,
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
        val centerX = viewportWidth * .5f
        val rootY = viewportHeight * .46f

        val childrenByParent = nodes.values.groupBy { it.parentId }
        val calculatedPositions = mutableMapOf<String, EdgePoint>()
        val clusterNodes = mutableMapOf<String, NodePosition>()

        val rootPos = EdgePoint(centerX, rootY)
        calculatedPositions[rootId] = rootPos
        val roleOrder = mapOf(NodeRole.MANAGER to 0, NodeRole.WORKER to 1, NodeRole.EXPERT to 2, NodeRole.REVIEWER to 3, NodeRole.EXECUTIVE to 4)
        val comparator = compareBy<OrganizationNodeModel>({ roleOrder[it.role] ?: 4 }, { it.domain.name }, { it.id })
        val ordered = mutableListOf<String>()
        val visited = mutableSetOf(rootId)
        val clusteredChildren = mutableMapOf<String, List<String>>()
        fun visit(parent: String) {
            val children = childrenByParent[parent].orEmpty().sortedWith(comparator).filter { it.id !in visited }
            if (children.size > clusterThreshold && focusNodeId != parent && parent !in collapsedClusterIds) {
                val clusterId = "cluster_$parent"
                ordered.add(clusterId)
                val hidden = mutableListOf<String>()
                fun hide(id: String) {
                    if (!visited.add(id)) return
                    hidden.add(id)
                    childrenByParent[id].orEmpty().forEach { hide(it.id) }
                }
                children.forEach { hide(it.id) }
                clusteredChildren[clusterId] = hidden
                return
            }
            children.forEach { child ->
                if (visited.add(child.id)) { ordered.add(child.id); visit(child.id) }
            }
        }
        visit(rootId)
        nodes.values.sortedWith(comparator).forEach { node ->
            if (visited.add(node.id)) { ordered.add(node.id); visit(node.id) }
        }
        val d = density.coerceAtLeast(.1f)
        val radius = minOf(132f * d, (viewportWidth / 2f - 44f * d) / 1.08f, (min(rootY, viewportHeight - rootY) - 40f * d) / 1.08f).coerceAtLeast(84f * d)
        val factors = floatArrayOf(.88f, 1f, .92f, 1.08f)
        val firstCount = min(ordered.size, 6)
        ordered.forEachIndexed { index, id ->
            val ring = if (index < 6) 0 else 1 + (index - 6) / 8
            val slot = if (ring == 0) index else (index - 6) % 8
            val angle = if (ring == 0 && firstCount <= 4) when (firstCount) {
                1 -> floatArrayOf(35f)
                2 -> floatArrayOf(-145f, 35f)
                3 -> floatArrayOf(-125f, -15f, 110f)
                else -> floatArrayOf(-145f, -38f, 53f, 151f)
            }[slot] else if (ring == 0) -145f + slot * (360f / firstCount) + if (slot % 2 == 0) 5f else -5f
                else -120f + slot * 45f
            val radians = Math.toRadians(angle.toDouble())
            val distance = (radius + ring * 100f * d) * factors[slot % 4] + if (id == focusNodeId) 10f * d else 0f
            val point = EdgePoint(centerX + kotlin.math.cos(radians).toFloat() * distance, rootY + kotlin.math.sin(radians).toFloat() * distance)
            calculatedPositions[id] = point
            clusteredChildren[id]?.let { children ->
                clusterNodes[id] = NodePosition(id, point.x, point.y, 28f, isCluster = true, clusterCount = children.count { nodes[it]?.parentId == id.removePrefix("cluster_") }, clusterChildIds = children,
                    alpha = if (focusNodeId != null && focusNodeId != rootId && focusNodeId != id) .5f else 1f)
            }
        }

        // Build NodePosition objects
        val nodePositions = mutableMapOf<String, NodePosition>()
        nodes.values.forEach { node ->
            val pt = calculatedPositions[node.id] ?: return@forEach
            val isFocused = (node.id == focusNodeId)
            val isDimmed = (focusNodeId != null && focusNodeId != rootId && node.id != focusNodeId)

            val radius = if (node.role == NodeRole.EXECUTIVE) 32f else 28f

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
                    alpha = if (isDimmed) 0.5f else 1.0f,
                    scale = if (isFocused && node.id != rootId) 1.06f else 1.0f,
                    isFocused = isFocused,
                )
            }
        }

        // Add cluster nodes to position map
        nodePositions.putAll(clusterNodes)

        // 4. Edge routing
        val edgePaths = mutableListOf<EdgePathModel>()
        val clusterByChild = clusterNodes.values.flatMap { cluster -> cluster.clusterChildIds.map { it to cluster.id } }.toMap()
        val emittedEdges = mutableSetOf<Triple<String, String, EdgeType>>()
        edges.sortedBy { it.id }.forEach { edge ->
            val fromId = clusterByChild[edge.fromNodeId] ?: edge.fromNodeId
            val toId = clusterByChild[edge.toNodeId] ?: edge.toNodeId
            val fromPos = calculatedPositions[fromId]
            val toPos = calculatedPositions[toId]
            val aggregated = fromId != edge.fromNodeId || toId != edge.toNodeId
            if (fromId != toId && fromPos != null && toPos != null && (!aggregated || emittedEdges.add(Triple(fromId, toId, edge.type)))) {
                val alpha = if (focusNodeId != null && focusNodeId != rootId && edge.fromNodeId != focusNodeId && edge.toNodeId != focusNodeId) 0.5f else 1f
                edgePaths.add(
                    EdgeRouter.routeEdge(
                        edgeId = edge.id,
                        fromNodeId = fromId,
                        toNodeId = toId,
                        from = fromPos,
                        to = toPos,
                        alpha = alpha,
                    )
                )
            }
        }

        // 5. Calculate Bounds
        var minX = Float.MAX_VALUE
        var minY = Float.MAX_VALUE
        var maxX = Float.NEGATIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY

        nodePositions.values.forEach { pos ->
            minX = min(minX, pos.x - 40f * d)
            maxX = max(maxX, pos.x + 40f * d)
            minY = min(minY, pos.y - 40f * d)
            maxY = max(maxY, pos.y + 40f * d)
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
