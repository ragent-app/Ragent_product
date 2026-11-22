package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.core.designsystem.rememberAgentoPressScale
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

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
    val colors = LocalRagentColors.current
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
            val edgeSegments = uiState.edges.mapNotNull { edge ->
                val fromSurface = surfacesById[edge.fromNodeId] ?: return@mapNotNull null
                val toSurface = surfacesById[edge.toNodeId] ?: return@mapNotNull null
                if (!fromSurface.visible || !toSurface.visible) return@mapNotNull null
                fromSurface.center to toSurface.center
            }
            uiState.nodes.forEach { node ->
                val frame = node.physicsFrame
                val surface = surfacesById[node.id] ?: return@forEach
                key(node.id) {
                    val press = presses[node.id] ?: 1f
                    val radiusDp = surface.radius / density / press.coerceAtLeast(.001f)
                    val source = frame?.birthSourceId?.let(surfacesById::get)?.takeIf { it.visible && !it.hidden }
                    val badgeAngle = remember(node.id, surfacesById, uiState.edges) {
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
                    val reviewRejectCaption = when {
                        node.reviewState.equals("needs_changes", ignoreCase = true) -> stringResource(R.string.organization_review_needs_changes)
                        node.reviewState.equals("rejected", ignoreCase = true) -> stringResource(R.string.organization_review_rejected)
                        else -> null
                    }
                    val failureCaption = (node.failureCode ?: node.blockerText ?: reviewRejectCaption)?.takeIf {
                        it.isNotBlank() && (node.runtimeState == NodeRuntimeState.BLOCKED || node.runtimeState == NodeRuntimeState.FAILED || reviewRejectCaption != null)
                    }
                    val captionText = failureCaption ?: node.resultPacketSummary?.takeIf { it.isNotBlank() }
                    if (captionText != null && node.id != hiddenNodeId && surface.visible && (frame?.birthProgress ?: 1f) >= .85f) {
                        val isError = failureCaption != null
                        val captionBg = if (isError) colors.error.copy(alpha = 0.14f) else colors.quietSurface.copy(alpha = 0.94f)
                        val captionBorder = if (isError) colors.error.copy(alpha = 0.35f) else colors.subtleOutline
                        val captionColor = if (isError) colors.error else colors.secondaryContent
                        val otherNodes = surfaces.mapNotNull { other ->
                            if (other.id == node.id || !other.visible || other.hidden) null
                            else other.center to other.radius
                        }
                        val badgeSizePx = (radiusDp * 2f * .28f).coerceIn(18f, 24f) * density
                        val badgeRadiusPx = badgeSizePx / 2f
                        val badgeCenter = if (node.action != null && badgeVisible) {
                            val distancePx = (radiusDp - (badgeSizePx / density) / 6f) * density
                            val radians = Math.toRadians(badgeAngle.toDouble())
                            surface.center + Offset(
                                distancePx * kotlin.math.cos(radians).toFloat(),
                                distancePx * kotlin.math.sin(radians).toFloat(),
                            )
                        } else null
                        Layout(
                            modifier = Modifier.align(AbsoluteAlignment.TopLeft).graphicsLayer { alpha = node.alpha },
                            content = {
                                Text(
                                    text = captionText,
                                    color = captionColor,
                                    fontSize = 10.sp,
                                    lineHeight = 13.sp,
                                    fontWeight = if (isError) FontWeight.SemiBold else FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier
                                        .testTag("node-status-caption-${node.id}")
                                        .widthIn(max = 136.dp)
                                        .clip(AgentoShapes.PillShape)
                                        .background(captionBg)
                                        .border(0.75.dp, captionBorder, AgentoShapes.PillShape)
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            },
                        ) { measurables, constraints ->
                            val placeable = measurables.single().measure(Constraints())
                            val placement = computeNodeCaptionOffset(
                                center = surface.center,
                                radius = surface.radius,
                                captionWidth = placeable.width.toFloat(),
                                captionHeight = placeable.height.toFloat(),
                                density = density,
                                edgeSegments = edgeSegments,
                                otherNodes = otherNodes,
                                viewportWidth = if (constraints.hasBoundedWidth) constraints.maxWidth.toFloat() else 0f,
                                viewportHeight = if (constraints.hasBoundedHeight) constraints.maxHeight.toFloat() else 0f,
                                badgeCenter = badgeCenter,
                                badgeRadius = badgeRadiusPx,
                            )
                            layout(constraints.maxWidth, constraints.maxHeight) {
                                placeable.place(
                                    x = placement.x.roundToInt(),
                                    y = placement.y.roundToInt(),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

internal fun computeNodeCaptionOffset(
    center: Offset,
    radius: Float,
    captionWidth: Float,
    captionHeight: Float,
    density: Float,
    edgeSegments: List<Pair<Offset, Offset>>,
    otherNodes: List<Pair<Offset, Float>> = emptyList(),
    viewportWidth: Float = 0f,
    viewportHeight: Float = 0f,
    badgeCenter: Offset? = null,
    badgeRadius: Float = 0f,
): Offset {
    val gapPx = 6f * density
    val edgePadding = 6f * density
    val nodePadding = 4f * density
    val badgePadding = 3f * density
    val halfW = captionWidth / 2f
    val halfH = captionHeight / 2f
    val diag = radius * 0.72f + gapPx

    val candidates = listOf(
        Offset(center.x - halfW, center.y + radius + gapPx),                  // Bottom
        Offset(center.x + radius + gapPx, center.y - halfH),                  // Right
        Offset(center.x - radius - gapPx - captionWidth, center.y - halfH),   // Left
        Offset(center.x - halfW, center.y - radius - gapPx - captionHeight),  // Top
        Offset(center.x + diag, center.y + diag),                             // Bottom-Right
        Offset(center.x - diag - captionWidth, center.y + diag),              // Bottom-Left
        Offset(center.x + diag, center.y - diag - captionHeight),             // Top-Right
        Offset(center.x - diag - captionWidth, center.y - diag - captionHeight), // Top-Left
    )

    data class ScoredCandidate(
        val offset: Offset,
        val overlapPenalty: Float,
        val boundsPenalty: Float,
        val minEdgeDistance: Float,
        val priority: Int,
    )

    val scored = candidates.mapIndexed { index, topLeft ->
        val rect = Rect(topLeft.x, topLeft.y, topLeft.x + captionWidth, topLeft.y + captionHeight)
        val minEdge = edgeSegments.minOfOrNull { (a, b) -> rectToSegmentDistance(rect, a, b) } ?: Float.POSITIVE_INFINITY
        val edgeViolation = if (minEdge < edgePadding) edgePadding - minEdge else 0f

        val nodeViolation = otherNodes.sumOf { (otherCenter, otherRadius) ->
            val dist = pointToRectDistance(otherCenter, rect)
            val required = otherRadius + nodePadding
            if (dist < required) (required - dist).toDouble() else 0.0
        }.toFloat()

        val badgeViolation = if (badgeCenter != null && badgeRadius > 0f) {
            val dist = pointToRectDistance(badgeCenter, rect)
            val required = badgeRadius + badgePadding
            if (dist < required) required - dist else 0f
        } else 0f

        val margin = 4f * density
        val boundsPenalty = if (viewportWidth > 0f && viewportHeight > 0f) {
            max(0f, margin - rect.left) +
                max(0f, rect.right - (viewportWidth - margin)) +
                max(0f, margin - rect.top) +
                max(0f, rect.bottom - (viewportHeight - margin))
        } else 0f

        ScoredCandidate(
            offset = topLeft,
            overlapPenalty = edgeViolation * 100f + nodeViolation * 60f + badgeViolation * 40f,
            boundsPenalty = boundsPenalty,
            minEdgeDistance = minEdge,
            priority = index,
        )
    }

    val best = scored.minWith(
        compareBy<ScoredCandidate>(
            { it.overlapPenalty > 0f },
            { it.boundsPenalty > 0f },
            { it.overlapPenalty + it.boundsPenalty },
            { it.priority },
        ).thenByDescending { it.minEdgeDistance },
    )
    return best.offset
}

internal fun rectToSegmentDistance(rect: Rect, p1: Offset, p2: Offset): Float {
    if (segmentIntersectsRect(p1, p2, rect)) return 0f
    val c1 = Offset(rect.left, rect.top)
    val c2 = Offset(rect.right, rect.top)
    val c3 = Offset(rect.right, rect.bottom)
    val c4 = Offset(rect.left, rect.bottom)
    return minOf(
        pointToRectDistance(p1, rect),
        pointToRectDistance(p2, rect),
        pointToSegmentDistance(c1, p1, p2),
        pointToSegmentDistance(c2, p1, p2),
        pointToSegmentDistance(c3, p1, p2),
        pointToSegmentDistance(c4, p1, p2),
    )
}

private fun pointToRectDistance(point: Offset, rect: Rect): Float {
    val dx = max(max(rect.left - point.x, 0f), point.x - rect.right)
    val dy = max(max(rect.top - point.y, 0f), point.y - rect.bottom)
    return hypot(dx, dy)
}

private fun pointToSegmentDistance(point: Offset, a: Offset, b: Offset): Float {
    val dx = b.x - a.x
    val dy = b.y - a.y
    val lenSq = dx * dx + dy * dy
    if (lenSq <= 1e-6f) return hypot(point.x - a.x, point.y - a.y)
    val t = (((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq).coerceIn(0f, 1f)
    return hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

private fun segmentIntersectsRect(p1: Offset, p2: Offset, rect: Rect): Boolean {
    if (p1.x in rect.left..rect.right && p1.y in rect.top..rect.bottom) return true
    if (p2.x in rect.left..rect.right && p2.y in rect.top..rect.bottom) return true
    val dx = p2.x - p1.x
    val dy = p2.y - p1.y
    var tMin = 0f
    var tMax = 1f
    fun clip(p: Float, q: Float): Boolean {
        if (kotlin.math.abs(p) <= 1e-6f) return q >= 0f
        val r = q / p
        if (p < 0f) {
            if (r > tMax) return false
            if (r > tMin) tMin = r
        } else {
            if (r < tMin) return false
            if (r < tMax) tMax = r
        }
        return true
    }
    return clip(-dx, p1.x - rect.left) &&
        clip(dx, rect.right - p1.x) &&
        clip(-dy, p1.y - rect.top) &&
        clip(dy, rect.bottom - p1.y) &&
        tMin <= tMax
}
