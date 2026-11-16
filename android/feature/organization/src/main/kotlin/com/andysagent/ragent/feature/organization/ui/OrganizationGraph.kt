package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateOffsetAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import kotlin.math.hypot
import kotlin.math.min

@Composable
internal fun OrganizationGraph(
    uiState: OrganizationUiState,
    onPan: (Offset) -> Unit,
    onZoom: (Float) -> Unit,
    onNodeClick: (String) -> Unit,
    onNodeDoubleTap: (String) -> Unit,
    onSizeChanged: (Int, Int, Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current.density
    val preference = if (uiState.reduceMotion && motionPolicy().preference == MotionPreference.Full) MotionPreference.Reduced else motionPolicy().preference
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(uiState.nodes.isNotEmpty()) { if (uiState.nodes.isNotEmpty()) shown = true }
    val opacity by animateFloatAsState(
        if (shown) 1f else 0f,
        animationSpec = tween(when (preference) { MotionPreference.Full -> 180; MotionPreference.Reduced -> 100; MotionPreference.None -> 0 }),
        label = "organization-graph-opacity",
    )
    val positions = mutableMapOf<String, Offset>()
    val scales = mutableMapOf<String, Float>()
    val alphas = mutableMapOf<String, Float>()
    uiState.nodes.forEach { node ->
        key(node.id) {
            val spec = if (preference == MotionPreference.Full) {
                if (node.role == NodeRole.EXECUTIVE) spring<Offset>(dampingRatio = .92f, stiffness = 260f)
                else spring(dampingRatio = .74f, stiffness = 140f)
            } else snap()
            positions[node.id] = animateOffsetAsState(Offset(node.x, node.y), animationSpec = spec, label = "organization-node-${node.id}").value
            scales[node.id] = animateFloatAsState(node.scale,
                animationSpec = if (preference == MotionPreference.Full) spring(dampingRatio = .88f, stiffness = 320f) else snap(),
                label = "organization-scale-${node.id}").value
            alphas[node.id] = animateFloatAsState(node.alpha,
                animationSpec = when (preference) { MotionPreference.Full -> tween(120); MotionPreference.Reduced -> tween(100); MotionPreference.None -> snap() },
                label = "organization-alpha-${node.id}").value
        }
    }
    val nodesById = uiState.nodes.associateBy { it.id }
    fun radius(id: String, animated: Boolean = false): Float {
        val node = nodesById[id] ?: return 28f * density
        return (if (node.role == NodeRole.EXECUTIVE) 32f else 28f) * density * (if (animated) scales[id] ?: node.scale else node.scale)
    }
    // Candidate search depends on target layout, not animated positions.
    val targetGeometry = uiState.nodes.map { listOf(it.id, it.x, it.y, it.scale, it.role) }
    val edgeGeometry = uiState.edges.map { Triple(it.id, it.fromNodeId, it.toNodeId) }
    val targetBends = remember(targetGeometry, edgeGeometry, density) {
      val targetPositions = uiState.nodes.associate { it.id to Offset(it.x, it.y) }
      uiState.edges.associate { edge ->
        val from = targetPositions[edge.fromNodeId]
        val to = targetPositions[edge.toNodeId]
        val bend = if (from == null || to == null) 0f else {
            val delta = to - from
            val length = hypot(delta.x, delta.y).coerceAtLeast(1f)
            val unit = delta / length
            val start = from + unit * radius(edge.fromNodeId)
            val end = to - unit * radius(edge.toNodeId)
            val line = end - start
            val lineLength = hypot(line.x, line.y).coerceAtLeast(1f)
            val normal = Offset(-line.y / lineLength, line.x / lineLength)
            val sign = if ((edge.id.hashCode() and 1) == 0) 1f else -1f
            val candidates = listOf(min(18f * density, lineLength * .08f) * sign) +
                listOf(32f, 48f, 64f, 80f).flatMap { listOf(it * density * sign, -it * density * sign) }
            fun controls(bend: Float): Pair<Offset, Offset> =
                (start + line / 3f + normal * bend) to (start + line * (2f / 3f) + normal * bend)
            fun crossings(bend: Float): Int {
                val (a, b) = controls(bend)
                val points = (0..24).map { index ->
                    val t = index / 24f
                    val u = 1f - t
                    start * (u * u * u) + a * (3f * u * u * t) + b * (3f * u * t * t) + end * (t * t * t)
                }
                return uiState.nodes.count { other ->
                    if (other.id == edge.fromNodeId || other.id == edge.toNodeId) false else {
                        val center = targetPositions[other.id] ?: return@count false
                        val limit = radius(other.id) + 8f * density
                        points.zipWithNext().any { (p, q) ->
                            val segment = q - p
                            val length2 = segment.x * segment.x + segment.y * segment.y
                            val t = if (length2 == 0f) 0f else (((center.x - p.x) * segment.x + (center.y - p.y) * segment.y) / length2).coerceIn(0f, 1f)
                            val nearest = p + segment * t
                            hypot(center.x - nearest.x, center.y - nearest.y) < limit
                        }
                    }
                }
            }
            var selected = candidates.first()
            var bestCrossings = Int.MAX_VALUE
            for (candidate in candidates) {
                val count = crossings(candidate)
                if (count < bestCrossings) { selected = candidate; bestCrossings = count }
                if (count == 0) break
            }
            selected
        }
        edge.id to bend
      }
    }
    val edges = uiState.edges.map { edge ->
        key(edge.id) {
            val bend by animateFloatAsState(targetBends[edge.id] ?: 0f,
                animationSpec = if (preference == MotionPreference.Full) spring(dampingRatio = .74f, stiffness = 140f) else snap(),
                label = "organization-bend-${edge.id}")
            val from = positions[edge.fromNodeId]
            val to = positions[edge.toNodeId]
            if (from == null || to == null) edge else {
            val delta = to - from
            val length = hypot(delta.x, delta.y).coerceAtLeast(1f)
            val unit = delta / length
            val start = from + unit * radius(edge.fromNodeId, animated = true)
            val end = to - unit * radius(edge.toNodeId, animated = true)
            val line = end - start
            val lineLength = hypot(line.x, line.y).coerceAtLeast(1f)
            val normal = Offset(-line.y / lineLength, line.x / lineLength)
            val c1 = start + line / 3f + normal * bend
            val c2 = start + line * (2f / 3f) + normal * bend
            edge.copy(start = EdgePoint(start.x, start.y), end = EdgePoint(end.x, end.y), control1 = EdgePoint(c1.x, c1.y), control2 = EdgePoint(c2.x, c2.y), isCurved = true)
            }
        }
    }
    val transform = rememberTransformableState { zoom, pan, _ -> onZoom(zoom); onPan(pan) }
    Box(modifier.clipToBounds().onSizeChanged { onSizeChanged(it.width, it.height, density) }) {
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = opacity }.transformable(state = transform).graphicsLayer {
            translationX = uiState.panOffset.x; translationY = uiState.panOffset.y
            scaleX = uiState.zoomScale; scaleY = uiState.zoomScale
        }) {
            // Particle records have no edge identity, so they cannot follow these animated paths reliably.
            OrganizationCanvas(edges, emptyList())
            uiState.nodes.forEach { node ->
                val position = positions[node.id]
                OrganizationNode(node.copy(x = position?.x ?: node.x, y = position?.y ?: node.y,
                    scale = scales[node.id] ?: node.scale, alpha = alphas[node.id] ?: node.alpha),
                    onClick = { onNodeClick(node.id) }, onDoubleTap = { onNodeDoubleTap(node.id) })
            }
        }
    }
}
