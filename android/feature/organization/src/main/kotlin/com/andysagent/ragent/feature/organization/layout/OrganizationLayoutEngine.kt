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
    val fitScale: Float = 1f,
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
        preferredFitScale: Float? = null,
        rootSessionId: String? = null,
    ): LayoutResult {
        if (nodes.isEmpty()) {
            return LayoutResult(
                nodePositions = emptyMap(),
                edges = emptyList(),
                bounds = LayoutBounds(0f, 0f, viewportWidth, viewportHeight),
                rootId = null,
            )
        }

        val rootNode = rootSessionId?.let { session -> nodes.values.singleOrNull { it.sessionId == session } }
            ?: nodes.values.firstOrNull { it.role == NodeRole.EXECUTIVE }
            ?: nodes.values.firstOrNull { it.parentId == null }
            ?: nodes.values.first()

        val rootId = rootNode.id
        val childrenByParent = nodes.values.groupBy { it.parentId }
        // Size derives from real management ancestry; review roles and labels do not create hierarchy.
        fun descendantHeight(id: String, seen: Set<String> = emptySet()): Int {
            if (id in seen) return 0
            val children = childrenByParent[id].orEmpty().filter { it.id != id && it.id !in seen }
            return if (children.isEmpty()) 0 else 1 + (children.maxOfOrNull { descendantHeight(it.id, seen + id) } ?: 0)
        }
        val maximumDescendantHeight = nodes.keys.maxOfOrNull { descendantHeight(it) } ?: 0
        fun nodeRadius(node: OrganizationNodeModel): Float {
            if (node.id == rootId) return 42f
            val hierarchyFraction = descendantHeight(node.id).toFloat() / (maximumDescendantHeight + 1).toFloat()
            return 28f * (1f + .5f * hierarchyFraction)
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
            if (children.isEmpty()) own else max(own, children.sumOf { span(it).toDouble() }.toFloat() + 24f * d * (children.size - 1) + 16f * d)
        }
        val axes = mutableMapOf<String, EdgePoint>()
        calculatedPositions[rootId] = EdgePoint(0f, 0f)
        val tan40 = kotlin.math.tan(Math.toRadians(40.0)).toFloat()
        val childFactors = floatArrayOf(.94f, 1.08f, 1f, .98f)
        fun placeChildren(parent: String, inheritedDrift: Float?) {
            val children = visibleChildren[parent].orEmpty()
            if (children.isEmpty()) return
            val parentPosition = calculatedPositions.getValue(parent)
            val childrenSpan = children.sumOf { span(it).toDouble() }.toFloat() + 24f * d * (children.size - 1)
            var cursor = parentPosition.x - childrenSpan / 2f
            children.forEachIndexed { index, child ->
                val childSpan = span(child)
                val drift = inheritedDrift ?: if (children.size == 1) -8f * d
                    else 8f * d * (2f * index / (children.size - 1) - 1f)
                val childX = cursor + childSpan / 2f + drift
                val deltaX = childX - parentPosition.x
                val deltaY = max((radiusOf(parent) + radiusOf(child) + 28f * childFactors[index % childFactors.size]) * d,
                    kotlin.math.abs(deltaX) / tan40)
                val length = hypot(deltaX, deltaY)
                calculatedPositions[child] = EdgePoint(childX, parentPosition.y + deltaY)
                axes[child] = EdgePoint(deltaX / length, deltaY / length)
                placeChildren(child, drift)
                cursor += childSpan + 24f * d
            }
        }
        placeChildren(rootId, null)

        // Independent components retain their own roots; placement adds no relationship.
        var componentLeft = span(rootId) / 2f + 32f * d
        componentRoots.forEach { component ->
            val componentSpan = span(component)
            calculatedPositions[component] = EdgePoint(componentLeft + componentSpan / 2f,
                max((radiusOf(rootId) + radiusOf(component) + 32f) * d, 96f * d))
            axes[component] = EdgePoint(0f, 1f)
            placeChildren(component, null)
            componentLeft += componentSpan + 32f * d
        }

        // Center the unfocused graph while keeping the real layout anchor near the middle.
        var left = Float.POSITIVE_INFINITY
        var right = Float.NEGATIVE_INFINITY
        calculatedPositions.forEach { (id, point) ->
            val extent = (max(radiusOf(id), 32f) + 8f) * d
            left = min(left, point.x - extent)
            right = max(right, point.x + extent)
        }
        val translateX = (viewportWidth * .5f - (left + right) / 2f).coerceIn(viewportWidth * .38f, viewportWidth * .62f)
        val translateY = (viewportHeight * .18f).coerceIn(56f * d, 84f * d)
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

        // A single scale fits actual node/touch bounds. If the 48dp minimum prevents
        // fitting, retain that minimum and let the viewport pan over the overflow.
        // The 48dp leaf floor also applies when a snapshot currently has only a root.
        val minFit = 24f / 28f
        val maxFit = max(minFit, 32f / 28f)
        fun extents(scale: Float): LayoutBounds {
            var l = Float.POSITIVE_INFINITY; var t = Float.POSITIVE_INFINITY
            var r = Float.NEGATIVE_INFINITY; var b = Float.NEGATIVE_INFINITY
            nodePositions.values.forEach { pos ->
                val point = calculatedPositions.getValue(pos.id)
                val extent = (max(pos.radius * scale * max(pos.scale, 1f), 32f) + 8f) * d
                l = min(l, point.x * scale - extent); r = max(r, point.x * scale + extent)
                t = min(t, point.y * scale - extent); b = max(b, point.y * scale + extent)
            }
            return LayoutBounds(l, t, r, b)
        }
        val fit = preferredFitScale?.coerceIn(minFit, maxFit) ?: run {
            var low = minFit; var high = maxFit
            repeat(20) {
                val middle = (low + high) / 2f
                val bounds = extents(middle)
                if (bounds.width <= viewportWidth * .88f && bounds.height <= viewportHeight * .86f) low = middle else high = middle
            }
            low
        }
        val fitted = extents(fit)
        val shiftX = viewportWidth / 2f - fitted.centerX
        val rootPosition = calculatedPositions.getValue(rootId)
        val rootRadius = nodePositions.getValue(rootId).radius * fit
        val rootSafety = max(56f * d, (max(rootRadius, 32f) + 8f) * d)
        val shiftY = if (fitted.height <= viewportHeight * .86f) {
            viewportHeight / 2f - (fitted.minY + fitted.maxY) / 2f
        } else {
            rootSafety.coerceAtMost(84f * d) - rootPosition.y * fit
        }
        calculatedPositions.keys.toList().forEach { id ->
            val point = calculatedPositions.getValue(id)
            calculatedPositions[id] = EdgePoint(point.x * fit + shiftX, point.y * fit + shiftY)
        }
        nodePositions.keys.toList().forEach { id ->
            val point = calculatedPositions.getValue(id)
            val node = nodePositions.getValue(id)
            nodePositions[id] = node.copy(x = point.x, y = point.y, radius = node.radius * fit)
        }

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
            fitScale = fit,
        )
    }
}
