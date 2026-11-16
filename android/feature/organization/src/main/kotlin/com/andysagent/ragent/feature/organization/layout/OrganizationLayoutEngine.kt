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
        val childrenByParent = nodes.values.groupBy { it.parentId }
        // Depth is based only on the actual parent chain, never on the visual center.
        fun managementDepth(node: OrganizationNodeModel): Int? {
            val seen = mutableSetOf<String>()
            var current = node
            var depth = 0
            while (true) {
                if (!seen.add(current.id)) return null
                val parentId = current.parentId ?: return depth
                current = nodes[parentId] ?: return null
                depth++
            }
        }
        fun nodeRadius(node: OrganizationNodeModel): Float {
            if (node.role == NodeRole.EXECUTIVE) return 36f
            val manages = node.role == NodeRole.MANAGER || node.role == NodeRole.PHASE_LEAD ||
                childrenByParent[node.id].orEmpty().any { it.id != node.id }
            if (!manages) return 24f
            return when (managementDepth(node)) {
                0 -> 36f
                1 -> 32f
                2 -> 28f
                null -> when (node.role) {
                    NodeRole.MANAGER -> 32f
                    NodeRole.PHASE_LEAD -> 28f
                    else -> 24f
                }
                else -> 26f
            }
        }
        val calculatedPositions = mutableMapOf<String, EdgePoint>()
        val clusterNodes = mutableMapOf<String, NodePosition>()

        val roleOrder = mapOf(NodeRole.MANAGER to 0, NodeRole.PHASE_LEAD to 1, NodeRole.WORKER to 2, NodeRole.WRITER to 3, NodeRole.EXPERT to 4, NodeRole.REVIEWER to 5, NodeRole.EXECUTIVE to 6, NodeRole.UNKNOWN to 7)
        val comparator = compareBy<OrganizationNodeModel>({ roleOrder[it.role] ?: 4 }, { it.domain.name }, { it.id })
        val visibleChildren = mutableMapOf<String, MutableList<String>>()
        val componentRoots = mutableListOf<String>()
        val visited = mutableSetOf(rootId)
        val clusteredChildren = mutableMapOf<String, List<String>>()
        fun visit(parent: String) {
            val children = childrenByParent[parent].orEmpty().sortedWith(comparator).filter { it.id !in visited }
            if (children.size > clusterThreshold && parent !in collapsedClusterIds) {
                val clusterId = "cluster_$parent"
                visibleChildren.getOrPut(parent) { mutableListOf() }.add(clusterId)
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
                if (visited.add(child.id)) {
                    visibleChildren.getOrPut(parent) { mutableListOf() }.add(child.id)
                    visit(child.id)
                }
            }
        }
        visit(rootId)
        val stableNodes = nodes.values.sortedWith(comparator)
        // Start orphaned components at their real boundary before handling cycles.
        stableNodes.filter { node -> node.parentId == null || node.parentId !in nodes || node.parentId in visited }.forEach { node ->
            if (visited.add(node.id)) { componentRoots.add(node.id); visit(node.id) }
        }
        // A component with no boundary is cyclic; choose a deterministic break.
        stableNodes.forEach { node ->
            if (visited.add(node.id)) { componentRoots.add(node.id); visit(node.id) }
        }
        val d = density.coerceAtLeast(.1f)
        fun radiusOf(id: String): Float = nodes[id]?.let(::nodeRadius) ?: 28f
        val spans = mutableMapOf<String, Float>()
        fun span(id: String): Float = spans.getOrPut(id) {
            val children = visibleChildren[id].orEmpty()
            val own = max(radiusOf(id) * 2f, 64f) * d
            if (children.isEmpty()) own else max(own, children.sumOf { span(it).toDouble() }.toFloat() + 16f * d * (children.size - 1))
        }
        val unitRoots = (visibleChildren[rootId].orEmpty() + componentRoots).sortedWith(
            compareBy<String>({ roleOrder[nodes[it]?.role ?: nodes[it.removePrefix("cluster_")]?.role] ?: 4 },
                { (nodes[it] ?: nodes[it.removePrefix("cluster_")])?.domain?.name.orEmpty() }, { it }),
        )
        val axes = mutableMapOf<String, EdgePoint>()
        calculatedPositions[rootId] = EdgePoint(0f, 0f)
        val tan35 = kotlin.math.tan(Math.toRadians(35.0)).toFloat()
        val branchGap = floatArrayOf(30f, 42f, 24f, 36f)
        val childFactors = floatArrayOf(.92f, 1.08f, 1f, .96f)
        unitRoots.forEachIndexed { index, unit ->
            val angle = when (unitRoots.size) {
                1 -> floatArrayOf(-65f)[index]
                2 -> floatArrayOf(-65f, 145f)[index]
                3 -> floatArrayOf(-100f, 20f, 145f)[index]
                4 -> floatArrayOf(-120f, -25f, 65f, 160f)[index]
                else -> -110f + index * (360f / unitRoots.size) + if (index % 2 == 0) 4f else -4f
            }
            val radians = Math.toRadians(angle.toDouble())
            val axis = EdgePoint(kotlin.math.cos(radians).toFloat(), kotlin.math.sin(radians).toFloat())
            val normal = EdgePoint(-axis.y, axis.x)
            val unitAngle = min(35f, 140f / unitRoots.size)
            val distance = max((radiusOf(rootId) + radiusOf(unit) + branchGap[index % branchGap.size]) * d,
                span(unit) / 2f / kotlin.math.tan(Math.toRadians(unitAngle.toDouble())).toFloat())
            fun place(id: String, forward: Float, cross: Float) {
                axes[id] = axis
                calculatedPositions[id] = EdgePoint(axis.x * forward + normal.x * cross, axis.y * forward + normal.y * cross)
                val children = visibleChildren[id].orEmpty()
                if (children.isEmpty()) return
                val childrenSpan = children.sumOf { span(it).toDouble() }.toFloat() + 16f * d * (children.size - 1)
                var cursor = cross - childrenSpan / 2f
                children.forEachIndexed { slot, child ->
                    val childSpan = span(child)
                    val childCross = cursor + childSpan / 2f
                    val step = max((radiusOf(id) + radiusOf(child) + 24f * childFactors[slot % childFactors.size]) * d,
                        kotlin.math.abs(childCross - cross) / tan35)
                    place(child, forward + step, childCross)
                    cursor += childSpan + 16f * d
                }
            }
            place(unit, distance, 0f)
        }

        // Center the unfocused graph once; focus never moves other nodes.
        var left = Float.POSITIVE_INFINITY; var right = Float.NEGATIVE_INFINITY
        var top = Float.POSITIVE_INFINITY; var bottom = Float.NEGATIVE_INFINITY
        calculatedPositions.forEach { (id, point) ->
            val extent = (max(radiusOf(id) * 1.06f, 32f) + 18f) * d
            left = min(left, point.x - extent); right = max(right, point.x + extent)
            top = min(top, point.y - extent); bottom = max(bottom, point.y + extent)
        }
        val translateX = viewportWidth * .5f - (left + right) / 2f
        val translateY = viewportHeight * .48f - (top + bottom) / 2f
        calculatedPositions.keys.toList().forEach { id ->
            val point = calculatedPositions.getValue(id)
            val axis = if (id == focusNodeId && id != rootId) axes[id] else null
            calculatedPositions[id] = EdgePoint(point.x + translateX + (axis?.x ?: 0f) * 10f * d,
                point.y + translateY + (axis?.y ?: 0f) * 10f * d)
        }
        clusteredChildren.forEach { (id, children) ->
            val point = calculatedPositions.getValue(id)
            clusterNodes[id] = NodePosition(id, point.x, point.y, 28f, isCluster = true,
                clusterCount = children.count { nodes[it]?.parentId == id.removePrefix("cluster_") }, clusterChildIds = children,
                alpha = if (focusNodeId != null && focusNodeId != rootId && focusNodeId != id) .5f else 1f)
        }

        // Build NodePosition objects
        val nodePositions = mutableMapOf<String, NodePosition>()
        nodes.values.forEach { node ->
            val pt = calculatedPositions[node.id] ?: return@forEach
            val isFocused = (node.id == focusNodeId)
            val isDimmed = (focusNodeId != null && focusNodeId != rootId && node.id != focusNodeId)

            val radius = nodeRadius(node)

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
            val extent = (max(pos.radius * max(pos.scale, 1f), 32f) + 8f) * d
            minX = min(minX, pos.x - extent)
            maxX = max(maxX, pos.x + extent)
            minY = min(minY, pos.y - extent)
            maxY = max(maxY, pos.y + extent)
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
