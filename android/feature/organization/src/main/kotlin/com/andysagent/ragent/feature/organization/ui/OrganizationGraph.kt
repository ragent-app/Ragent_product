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
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import kotlin.math.hypot

internal data class OrganizationNodeAnchor(val center: Offset, val radius: Float, val baseRadiusDp: Float, val alpha: Float)

@Composable
internal fun OrganizationGraph(
    uiState: OrganizationUiState,
    onPan: (Offset) -> Unit,
    onZoom: (Float) -> Unit,
    onNodeClick: (String) -> Unit,
    onNodeDoubleTap: (String) -> Unit,
    onSizeChanged: (Int, Int, Float) -> Unit,
    modifier: Modifier = Modifier,
    hiddenNodeId: String? = null,
    onAnchorsChanged: (Map<String, OrganizationNodeAnchor>, Rect?) -> Unit = { _, _ -> },
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
    val radii = mutableMapOf<String, Float>()
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
            radii[node.id] = animateFloatAsState(node.radiusDp,
                animationSpec = if (preference == MotionPreference.Full) spring(dampingRatio = .88f, stiffness = 320f) else snap(),
                label = "organization-radius-${node.id}").value
            alphas[node.id] = animateFloatAsState(node.alpha,
                animationSpec = when (preference) { MotionPreference.Full -> tween(120); MotionPreference.Reduced -> tween(100); MotionPreference.None -> snap() },
                label = "organization-alpha-${node.id}").value
        }
    }
    val nodesById = uiState.nodes.associateBy { it.id }
    val edges = uiState.edges.mapNotNull { edge ->
        val from = positions[edge.fromNodeId]
        val to = positions[edge.toNodeId]
        val fromNode = nodesById[edge.fromNodeId]
        val toNode = nodesById[edge.toNodeId]
        val fromRadius = radii[edge.fromNodeId]
        val toRadius = radii[edge.toNodeId]
        if (from == null || to == null || fromNode == null || toNode == null || fromRadius == null || toRadius == null) {
            null
        } else {
            val delta = to - from
            val length = hypot(delta.x, delta.y).coerceAtLeast(1f)
            val unit = delta / length
            val start = from + unit * (fromRadius * density * (scales[edge.fromNodeId] ?: fromNode.scale))
            val end = to - unit * (toRadius * density * (scales[edge.toNodeId] ?: toNode.scale))
            edge.copy(start = EdgePoint(start.x, start.y), end = EdgePoint(end.x, end.y), control1 = null, control2 = null, isCurved = false)
        }
    }
    val transform = rememberTransformableState { zoom, pan, _ -> onZoom(zoom); onPan(pan) }
    var viewportCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var viewportOrigin by remember { mutableStateOf(Offset.Unspecified) }
    val viewport = viewportCoordinates?.takeIf { it.isAttached && viewportOrigin != Offset.Unspecified }?.let {
        Rect(viewportOrigin, androidx.compose.ui.geometry.Size(it.size.width.toFloat(), it.size.height.toFloat()))
    }
    val actualCoordinates = viewportCoordinates?.takeIf { it.isAttached && viewportOrigin != Offset.Unspecified }
    val anchors = if (actualCoordinates == null) emptyMap() else uiState.nodes.mapNotNull { node ->
        val position = positions[node.id] ?: return@mapNotNull null
        val radius = radii[node.id] ?: return@mapNotNull null
        val layerCenter = Offset(actualCoordinates.size.width / 2f, actualCoordinates.size.height / 2f)
        val transformed = layerCenter + (position - layerCenter) * uiState.zoomScale + uiState.panOffset
        node.id to OrganizationNodeAnchor(actualCoordinates.localToRoot(transformed),
            radius * density * (scales[node.id] ?: node.scale) * uiState.zoomScale, radius, opacity * (alphas[node.id] ?: node.alpha))
    }.toMap()
    SideEffect { onAnchorsChanged(anchors, viewport) }
    Box(modifier.clipToBounds().onSizeChanged { onSizeChanged(it.width, it.height, density) }.onGloballyPositioned { viewportCoordinates = it; viewportOrigin = it.localToRoot(Offset.Zero) }) {
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = opacity }.transformable(state = transform).graphicsLayer {
            translationX = uiState.panOffset.x; translationY = uiState.panOffset.y
            scaleX = uiState.zoomScale; scaleY = uiState.zoomScale
        }) {
            // Particle records have no edge identity, so they cannot follow these animated paths reliably.
            OrganizationCanvas(edges, emptyList())
            uiState.nodes.forEach { node ->
                val position = positions[node.id]
                OrganizationNode(node.copy(x = position?.x ?: node.x, y = position?.y ?: node.y, radiusDp = radii[node.id] ?: node.radiusDp,
                    scale = scales[node.id] ?: node.scale, alpha = alphas[node.id] ?: node.alpha),
                    onClick = { onNodeClick(node.id) }, onDoubleTap = { onNodeDoubleTap(node.id) },
                    morphHidden = node.id == hiddenNodeId)
            }
        }
    }
}
