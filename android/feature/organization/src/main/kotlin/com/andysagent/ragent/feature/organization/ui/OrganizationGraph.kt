package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.core.designsystem.rememberAgentoPressScale
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState

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
    onAdvancePhysicsFrame: (Long) -> Unit = {},
    onReportBirthSurfaceGaps: (Map<String, Float>) -> Unit = {},
) {
    val density = LocalDensity.current.density
    val preference = if (uiState.reduceMotion && motionPolicy().preference == MotionPreference.Full) MotionPreference.Reduced else motionPolicy().preference
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(uiState.nodes.isNotEmpty()) { if (uiState.nodes.isNotEmpty()) shown = true }
    val opacity by animateFloatAsState(if (shown) 1f else 0f,
        animationSpec = tween(when (preference) { MotionPreference.Full -> 180; MotionPreference.Reduced -> 100; MotionPreference.None -> 0 }), label = "organization-graph-opacity")
    val interactions = mutableMapOf<String, MutableInteractionSource>()
    val presses = mutableMapOf<String, Float>()
    uiState.nodes.forEach { node -> key(node.id) {
        val interaction = remember { MutableInteractionSource() }
        val press by rememberAgentoPressScale(interaction)
        interactions[node.id] = interaction
        presses[node.id] = press
    } }
    val dark = LocalRagentColors.current.canvas.luminance() < .5f
    val surfaces = uiState.nodes.map { node ->
        val frame = node.physicsFrame
        val radiusDp = frame?.radiusDp ?: (node.radiusDp * node.scale)
        GraphNodeSurface(node.id, Offset(frame?.centerX ?: node.x, frame?.centerY ?: node.y),
            radiusDp * density * (presses[node.id] ?: 1f),
            nodeAccent(nodeVisual(node), dark), node.alpha, node.id == hiddenNodeId,
            frame?.birthSourceId, frame?.birthProgress ?: 1f, frame?.separationMaterialProgress ?: 1f, frame?.birthVisible ?: true,
            frame?.sourceDeformation ?: 0f, Offset(frame?.deformationDirectionX ?: 0f, frame?.deformationDirectionY ?: 1f))
    }
    val surfacesById = surfaces.associateBy { it.id }
    val currentSurfaces by rememberUpdatedState(surfaces)
    val currentZoom by rememberUpdatedState(uiState.zoomScale)
    val reportGaps by rememberUpdatedState(onReportBirthSurfaceGaps)
    val advanceFrame by rememberUpdatedState(onAdvancePhysicsFrame)
    LaunchedEffect(uiState.physicsRunning, preference, density) {
        if (uiState.physicsRunning && preference == MotionPreference.Full) {
            while (true) withFrameNanos { frameNanos ->
                val byId = currentSurfaces.associateBy { it.id }
                val gaps = currentSurfaces.mapNotNull { child ->
                    val source = child.birthSourceId?.let(byId::get) ?: return@mapNotNull null
                    if (!child.visible || !source.visible) return@mapNotNull null
                    child.id to (graphSurfaceGap(source, child) * currentZoom / density)
                }.toMap()
                if (gaps.isNotEmpty()) reportGaps(gaps)
                advanceFrame(frameNanos)
            }
        }
    }
    val transform = rememberTransformableState { zoom, pan, _ -> onZoom(zoom); onPan(pan) }
    var viewportCoordinates by remember { mutableStateOf<LayoutCoordinates?>(null) }
    var viewportOrigin by remember { mutableStateOf(Offset.Unspecified) }
    val coordinates = viewportCoordinates?.takeIf { it.isAttached && viewportOrigin != Offset.Unspecified }
    val viewport = coordinates?.let { Rect(viewportOrigin, androidx.compose.ui.geometry.Size(it.size.width.toFloat(), it.size.height.toFloat())) }
    val anchors = if (coordinates == null) emptyMap() else uiState.nodes.mapNotNull { node ->
        val surface = surfacesById[node.id] ?: return@mapNotNull null
        val layerCenter = Offset(coordinates.size.width / 2f, coordinates.size.height / 2f)
        val transformed = layerCenter + (surface.center - layerCenter) * uiState.zoomScale + uiState.panOffset
        node.id to OrganizationNodeAnchor(coordinates.localToRoot(transformed), surface.major * uiState.zoomScale,
            node.physicsFrame?.radiusDp ?: node.radiusDp, opacity * node.alpha)
    }.toMap()
    SideEffect { onAnchorsChanged(anchors, viewport) }
    Box(modifier.clipToBounds().onSizeChanged { onSizeChanged(it.width, it.height, density) }
        .onGloballyPositioned { viewportCoordinates = it; viewportOrigin = it.localToRoot(Offset.Zero) }) {
        Box(Modifier.fillMaxSize().graphicsLayer { alpha = opacity }.transformable(state = transform).graphicsLayer {
            translationX = uiState.panOffset.x; translationY = uiState.panOffset.y
            scaleX = uiState.zoomScale; scaleY = uiState.zoomScale
        }) {
            OrganizationGraphArt(surfaces, uiState.edges, uiState.zoomScale)
            uiState.nodes.forEach { node ->
                val frame = node.physicsFrame
                val surface = surfacesById[node.id] ?: return@forEach
                val press = presses[node.id] ?: 1f
                val radiusDp = surface.radius / density / press.coerceAtLeast(.001f)
                val source = frame?.birthSourceId?.let(surfacesById::get)?.takeIf { it.visible && !it.hidden }
                val badgeAngle = remember(node.id) {
                    val directions = uiState.edges.mapNotNull { edge ->
                        val otherId = when (node.id) {
                            edge.fromNodeId -> edge.toNodeId
                            edge.toNodeId -> edge.fromNodeId
                            else -> null
                        }
                        otherId?.let(surfacesById::get)?.let { it.center - surface.center }
                            ?.takeIf { it.getDistance() > .001f }
                    }
                    val candidates = listOf(45f, 135f, 315f, 225f)
                    fun clearance(angle: Float): Float {
                        val radians = Math.toRadians(angle.toDouble())
                        val v = Offset(kotlin.math.cos(radians).toFloat(), kotlin.math.sin(radians).toFloat())
                        return directions.minOfOrNull { d ->
                            kotlin.math.acos(((v.x * d.x + v.y * d.y) / d.getDistance()).coerceIn(-1f, 1f)) * 180f / Math.PI.toFloat()
                        } ?: 180f
                    }
                    val best = candidates.maxByOrNull(::clearance) ?: 45f
                    if (clearance(best) - clearance(45f) < 15f) 45f else best
                }
                val badgeVisible = (frame?.birthProgress ?: 1f) >= .85f &&
                    (source == null || graphSurfaceGap(source, surface) > 0f)
                OrganizationNode(node.copy(x = surface.center.x, y = surface.center.y, radiusDp = radiusDp, scale = 1f),
                    onClick = { onNodeClick(node.id) }, onDoubleTap = { onNodeDoubleTap(node.id) },
                    modifier = Modifier.align(AbsoluteAlignment.TopLeft), morphHidden = node.id == hiddenNodeId || !surface.visible,
                    interactionSource = interactions[node.id], externalPressScale = press, drawSurface = false,
                    clickable = surface.visible && (frame?.clickable ?: true), iconAlpha = frame?.iconAlpha ?: 1f,
                    occluderOffset = source?.let { it.center - surface.center }, occluderRadius = source?.radius ?: 0f,
                    occluderMajor = source?.major ?: 0f, occluderMinor = source?.minor ?: 0f, occluderAxis = source?.axis ?: Offset(0f, 1f),
                    minimumTouchSize = 64.dp / (uiState.zoomScale * press).coerceAtLeast(.001f),
                    actionVisible = badgeVisible, badgeAngleDegrees = badgeAngle, motionPreference = preference)
            }
        }
    }
}
