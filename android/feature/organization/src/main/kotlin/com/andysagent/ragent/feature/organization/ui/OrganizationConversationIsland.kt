package com.andysagent.ragent.feature.organization.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateOffsetAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState
import kotlin.math.roundToInt

@Composable
internal fun OrganizationConversationIsland(
    node: RenderedNodeUiState,
    anchor: OrganizationNodeAnchor,
    screenOrigin: Offset,
    cardWidth: Float,
    cardHeight: Float,
    cardCenter: Offset,
    expanded: Boolean,
    closingRequested: Boolean,
    deleted: Boolean,
    runtimeState: String?,
    onDismiss: () -> Unit,
    onReopen: () -> Unit,
    onClosed: () -> Unit,
    content: @Composable (String, Modifier) -> Unit,
) {
    val density = LocalDensity.current
    val preference = motionPolicy().preference
    val followSpec = if (preference == MotionPreference.Full) spring<Offset>(dampingRatio = 1f, stiffness = 420f) else snap()
    val radiusSpec = if (preference == MotionPreference.Full) spring<Float>(dampingRatio = 1f, stiffness = 420f) else snap()
    val liveCenter by animateOffsetAsState(anchor.center - screenOrigin, animationSpec = followSpec, label = "conversation-anchor")
    val liveRadius by animateFloatAsState(anchor.radius, animationSpec = radiusSpec, label = "conversation-anchor-radius")
    var openingStarted by remember(node.id) { mutableStateOf(false) }
    var lastProgress by remember(node.id) { mutableFloatStateOf(0f) }
    LaunchedEffect(node.id) { openingStarted = true }
    val expansion by animateFloatAsState(if (deleted) lastProgress else if (expanded && openingStarted) 1f else 0f, animationSpec = islandMorphMotionSpec(preference), label = "conversation-shell")
    SideEffect { if (!deleted) lastProgress = expansion }
    var endpointHeight by remember(node.id) { mutableFloatStateOf(cardHeight) }
    var endpointWidth by remember(node.id) { mutableFloatStateOf(cardWidth) }
    var endpointCenter by remember(node.id) { mutableStateOf(cardCenter) }
    LaunchedEffect(cardHeight, cardWidth, cardCenter, expansion) {
        if (!deleted && (expansion <= .001f || expansion >= .999f)) {
            endpointHeight = cardHeight
            endpointWidth = cardWidth
            endpointCenter = cardCenter
        }
    }
    val targetHeight by animateFloatAsState(endpointHeight, animationSpec = radiusSpec, label = "conversation-card-height")
    val targetWidth by animateFloatAsState(endpointWidth, animationSpec = radiusSpec, label = "conversation-card-width")
    val targetCenter by animateOffsetAsState(endpointCenter, animationSpec = followSpec, label = "conversation-card-center")
    val deletionAlpha by animateFloatAsState(if (deleted) 0f else 1f, animationSpec = tween(if (preference == MotionPreference.None) 0 else 120), label = "conversation-deleted")
    var lastFrame by remember(node.id) { mutableStateOf<ConversationIslandFrame?>(null) }
    val currentFrame = ConversationIslandFrame(expansion, liveCenter, liveRadius, targetWidth, targetHeight, targetCenter, anchor.baseRadiusDp)
    SideEffect { if (!deleted) lastFrame = currentFrame }
    val frame = if (deleted) lastFrame ?: currentFrame else currentFrame
    val geometry = islandMorphGeometry(frame.expansion)
    val shellWidth = frame.radius * 2f + (frame.width - frame.radius * 2f) * geometry.shellProgress
    val shellHeight = frame.radius * 2f + (frame.height - frame.radius * 2f) * geometry.bodyProgress
    val center = frame.center + (frame.targetCenter - frame.center) * geometry.shellProgress
    val cornerPx = frame.radius + (with(density) { 22.dp.toPx() } - frame.radius) * geometry.shellProgress
    val closeReady = !expanded && expansion <= .001f && (liveCenter - (anchor.center - screenOrigin)).getDistance() < .5f && kotlin.math.abs(liveRadius - anchor.radius) < .5f
    LaunchedEffect(closeReady, deleted, deletionAlpha) {
        if ((deleted && deletionAlpha <= .001f) || (!deleted && closeReady)) onClosed()
    }
    BackHandler(enabled = true, onBack = onDismiss)
    val colors = LocalRagentColors.current
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.matchParentSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss))
        val shape = RoundedCornerShape(with(density) { cornerPx.coerceAtLeast(0f).toDp() })
        Box(Modifier.offset { IntOffset((center.x - shellWidth / 2f).roundToInt(), (center.y - shellHeight / 2f).roundToInt()) }
            .size(with(density) { shellWidth.coerceAtLeast(1f).toDp() }, with(density) { shellHeight.coerceAtLeast(1f).toDp() })
            .graphicsLayer { alpha = deletionAlpha }.clip(shape)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null,
                onClick = { if (closingRequested && !deleted) onReopen() })) {
            AgentoFrostedGlassBox(Modifier.matchParentSize().graphicsLayer { alpha = geometry.bodyAlpha },
                shape = shape, surface = AgentoGlassSurface.Neutral, material = AgentoGlassMaterial.LiquidClear,
                backdropTone = AgentoBackdropTone.QuietHeader, hasShadow = false) {}
            Layout(modifier = Modifier.fillMaxSize(), content = {
            Column(Modifier.organizationConversationForegroundReveal(
                    progress = { geometry.bodyProgress }, visibleWidth = { shellWidth }, visibleHeight = { shellHeight })
                .graphicsLayer { alpha = geometry.bodyAlpha }
                .then(if (expansion < .999f || !expanded) Modifier.pointerInput(Unit) {
                    awaitPointerEventScope { while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() } }
                } else Modifier)
                .then(if (expansion < .999f || !expanded) Modifier.clearAndSetSemantics {} else Modifier)) {
                Row(Modifier.fillMaxWidth().height(64.dp).padding(start = 64.dp, end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(node.displayName, color = colors.primaryContent, fontSize = 17.sp, lineHeight = 24.sp,
                            fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val state = when (runtimeState?.lowercase()) {
                            "running", "working" -> R.string.organization_node_working
                            "waiting", "waiting_children", "waiting_approval" -> R.string.organization_node_waiting
                            "blocked" -> R.string.organization_node_blocked
                            "reviewing", "waiting_review" -> R.string.organization_node_reviewing
                            "completed", "done", "succeeded" -> R.string.organization_node_done
                            "failed" -> R.string.organization_node_failed
                            "paused", "cancelled" -> R.string.organization_node_paused
                            "provisioning" -> R.string.organization_node_provisioning
                            "idle" -> R.string.organization_node_idle
                            else -> R.string.organization_state_unknown
                        }
                        Text(stringResource(state), color = colors.secondaryContent, fontSize = 12.sp, lineHeight = 18.sp)
                    }
                    AgentoIconButton(onClick = onDismiss, contentDescription = stringResource(R.string.organization_conversation_close), modifier = Modifier.size(48.dp)) {
                        AgentoWebIcon(AgentoWebGlyph.Close, contentDescription = null, modifier = Modifier.size(20.dp), tint = colors.secondaryContent)
                    }
                }
                content(node.id, Modifier.fillMaxWidth().weight(1f))
            }
            }) { measurables, constraints ->
                val body = measurables.single().measure(Constraints.fixed(
                    frame.width.roundToInt().coerceAtLeast(1), frame.height.roundToInt().coerceAtLeast(1)))
                layout(constraints.maxWidth, constraints.maxHeight) {
                    body.placeRelative((constraints.maxWidth - body.width) / 2, 0)
                }
            }
        }
        val avatarX = center.x - shellWidth / 2f + shellWidth / 2f * (1f - geometry.shellProgress) + with(density) { 32.dp.toPx() } * geometry.shellProgress
        val avatarY = center.y - shellHeight / 2f + shellHeight / 2f * (1f - geometry.shellProgress) + with(density) { 32.dp.toPx() } * geometry.shellProgress
        val avatarRadius = frame.radius + (with(density) { 16.dp.toPx() } - frame.radius) * geometry.shellProgress
        val baseRadius = frame.baseRadiusDp.coerceAtLeast(1f)
        OrganizationNode(node.copy(x = avatarX, y = avatarY, radiusDp = baseRadius,
            scale = avatarRadius / (baseRadius * density.density), alpha = deletionAlpha),
            onClick = { if (closingRequested && !deleted) onReopen() }, modifier = Modifier.clearAndSetSemantics {})
    }
}

private data class ConversationIslandFrame(
    val expansion: Float, val center: Offset, val radius: Float,
    val width: Float, val height: Float, val targetCenter: Offset, val baseRadiusDp: Float,
)

/** Fade the moving reading-window edges while the normal-size body is revealed. */
private fun Modifier.organizationConversationForegroundReveal(
    progress: () -> Float,
    visibleWidth: () -> Float,
    visibleHeight: () -> Float,
): Modifier = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithCache {
    val p = progress().coerceIn(0f, 1f)
    val visible = visibleHeight().coerceIn(0f, size.height)
    val feather = minOf(24.dp.toPx() * (1f - p), visible)
    val height = size.height.coerceAtLeast(1f)
    val width = visibleWidth().coerceIn(0f, size.width)
    val left = (size.width - width) / 2f
    val horizontalFeather = minOf(32.dp.toPx() * (1f - p), width / 2f)
    val fraction = if (width > 0f) horizontalFeather / width else .5f
    val horizontalMask = Brush.horizontalGradient(0f to Color.Transparent, fraction to Color.White,
        (1f - fraction) to Color.White, 1f to Color.Transparent, startX = left, endX = (left + width).coerceAtLeast(left + 1f))
    val verticalMask = Brush.verticalGradient(0f to Color.White, ((visible - feather) / height) to Color.White,
        (visible / height) to Color.Transparent, 1f to Color.Transparent, startY = 0f, endY = height)
    onDrawWithContent {
        drawContent()
        if (p < 1f) {
            drawRect(verticalMask, blendMode = BlendMode.DstIn)
            if (width < size.width) drawRect(horizontalMask, blendMode = BlendMode.DstIn)
        }
    }
}
