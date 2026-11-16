package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.animateOffsetAsState
import androidx.compose.animation.core.snap
import androidx.compose.runtime.key
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.material3.Icon
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Alignment
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import kotlin.math.pow
import kotlin.math.roundToInt

data class OrganizationRootVisual(val icon: Int, val colors: List<Color>, val radiusDp: Float, val runtimeState: NodeRuntimeState)

/** A single, fixed-layout chat surface revealed inside a reversible moving shell.
 * Rectangles are physical pixel coordinates in the Compose root. The caller keeps
 * the source rectangle current and owns interaction and accessibility semantics.
 */
@Composable
fun OrganizationRootShell(
    expanded: Boolean,
    origin: Rect,
    target: Rect,
    sourceIsCircle: Boolean,
    modifier: Modifier = Modifier,
    surfaceColor: Color = Color.Unspecified,
    sourceVisual: OrganizationRootVisual? = null,
    onVisibleSizeChanged: (width: Float, height: Float) -> Unit = { _, _ -> },
    onSettled: (expanded: Boolean) -> Unit = {},
    content: @Composable (progress: Float) -> Unit,
) {
    val density = LocalDensity.current
    val layoutDirection = LocalLayoutDirection.current
    val preference = motionPolicy().preference
    val animated by animateFloatAsState(if (expanded) 1f else 0f, animationSpec = when (preference) {
        MotionPreference.Full -> spring(dampingRatio = 1f, stiffness = 220f, visibilityThreshold = .002f)
        MotionPreference.Reduced -> tween(160, easing = FastOutSlowInEasing)
        MotionPreference.None -> tween(0)
    }, label = "root-conversation-shell")
    val p = animated.coerceIn(0f, 1f)
    val follow = if (preference == MotionPreference.Full) spring<Offset>(dampingRatio = 1f, stiffness = 420f) else snap()
    val sizeFollow = if (preference == MotionPreference.Full) spring<Float>(dampingRatio = 1f, stiffness = 420f) else snap()
    val liveOrigin = key(sourceIsCircle) {
        val center by animateOffsetAsState(origin.center, animationSpec = follow, label = "root-origin-center")
        val width by animateFloatAsState(origin.width, animationSpec = sizeFollow, label = "root-origin-width")
        val height by animateFloatAsState(origin.height, animationSpec = sizeFollow, label = "root-origin-height")
        Rect(center.x - width / 2f, center.y - height / 2f, center.x + width / 2f, center.y + height / 2f)
    }
    val originSettled = (liveOrigin.center - origin.center).getDistance() < .5f &&
        kotlin.math.abs(liveOrigin.width - origin.width) < .5f && kotlin.math.abs(liveOrigin.height - origin.height) < .5f
    androidx.compose.runtime.LaunchedEffect(expanded, p, originSettled) {
        if ((expanded && p >= .999f) || (!expanded && p <= .001f && originSettled)) onSettled(expanded)
    }
    var rootOrigin by remember { mutableStateOf<Offset?>(null) }
    val width = (liveOrigin.width + (target.width - liveOrigin.width) * p).coerceAtLeast(1f)
    val height = (liveOrigin.height + (target.height - liveOrigin.height) * p.pow(1.15f)).coerceAtLeast(1f)
    androidx.compose.runtime.SideEffect { onVisibleSizeChanged(width, height) }
    val center = liveOrigin.center + (target.center - liveOrigin.center) * p - (rootOrigin ?: Offset.Zero)
    val corner = if (sourceIsCircle) minOf(width, height) / 2f +
        (with(density) { 22.dp.toPx() } - minOf(width, height) / 2f) * smoothRoot(p, .10f, .80f) else with(density) { 22.dp.toPx() }
    val color = if (surfaceColor == Color.Unspecified) LocalRagentColors.current.canvas else surfaceColor.copy(alpha = 1f)
    Box(modifier.fillMaxSize().onGloballyPositioned { rootOrigin = it.localToRoot(Offset.Zero) }) {
        Box(Modifier.align(AbsoluteAlignment.TopLeft)
            .graphicsLayer { alpha = if (rootOrigin != null && origin.width > 0f && origin.height > 0f && target.width > 0f && target.height > 0f) 1f else 0f }
            .absoluteOffset { IntOffset((center.x - width / 2f).roundToInt(), (center.y - height / 2f).roundToInt()) }
            .size(with(density) { width.toDp() }, with(density) { height.toDp() })
            .clip(RoundedCornerShape(with(density) { corner.coerceAtLeast(0f).toDp() })).drawWithCache {
                val palette = if (sourceIsCircle && sourceVisual != null && sourceVisual.colors.size >= 3)
                    sourceVisual.colors.map { lerp(it, color, smoothRoot(p, .15f, .85f)) } else listOf(color, color, color)
                val brush = Brush.linearGradient(0f to palette[0], .55f to palette[1], 1f to palette[2],
                    start = Offset(size.width * .12f, size.height * .08f), end = Offset(size.width * .88f, size.height * .92f))
                onDrawBehind { drawRect(brush) }
            }) {
            Layout(content = { content(p) }) { measurables, constraints ->
                val child = measurables.single().measure(Constraints.fixed(target.width.roundToInt().coerceAtLeast(1), target.height.roundToInt().coerceAtLeast(1)))
                layout(constraints.maxWidth, constraints.maxHeight) { child.placeRelative(0, constraints.maxHeight - child.height) }
            }
            if (sourceIsCircle && sourceVisual != null) {
                val glyphMotion = smoothRoot(p, .15f, .90f)
                val scale = liveOrigin.width / 2f / with(density) { sourceVisual.radiusDp.dp.toPx().coerceAtLeast(1f) }
                val glyphSize = nodeIconSize(sourceVisual.radiusDp).dp * scale * (1f - glyphMotion) + 20.dp * glyphMotion
                val glyphTargetX = if (layoutDirection == LayoutDirection.Ltr) with(density) { 32.dp.toPx() } else width - with(density) { 32.dp.toPx() }
                val x = width / 2f + (glyphTargetX - width / 2f) * glyphMotion
                val y = height / 2f + (with(density) { 32.dp.toPx() } - height / 2f) * glyphMotion
                Icon(painterResource(sourceVisual.icon), contentDescription = null, tint = color,
                    modifier = Modifier.align(AbsoluteAlignment.TopLeft).absoluteOffset {
                        IntOffset((x - glyphSize.toPx() / 2f).roundToInt(), (y - glyphSize.toPx() / 2f).roundToInt())
                    }.size(glyphSize).graphicsLayer { alpha = 1f - smoothRoot(p, .55f, .85f) })
                if (sourceVisual.runtimeState != NodeRuntimeState.IDLE) {
                    val dotSize = 11.dp * scale
                    val dotCenter = width / 2f + liveOrigin.width / 2f * .70710678f
                    val dotY = height / 2f + liveOrigin.height / 2f * .70710678f
                    val colors = LocalRagentColors.current
                    val dotColor = when (sourceVisual.runtimeState) {
                        NodeRuntimeState.WORKING, NodeRuntimeState.REVIEWING -> colors.running
                        NodeRuntimeState.BLOCKED, NodeRuntimeState.FAILED -> colors.error
                        NodeRuntimeState.DONE -> colors.success
                        else -> colors.secondaryContent
                    }
                    Box(Modifier.align(AbsoluteAlignment.TopLeft).absoluteOffset {
                        IntOffset((dotCenter - dotSize.toPx() / 2f).roundToInt(), (dotY - dotSize.toPx() / 2f).roundToInt())
                    }.size(dotSize).graphicsLayer { alpha = 1f - smoothRoot(p, 0f, .18f) }.clip(CircleShape).background(color),
                        contentAlignment = Alignment.Center) {
                        Box(Modifier.fillMaxSize(7f / 11f).clip(CircleShape).background(dotColor))
                    }
                }
            }
        }
    }
}

private fun smoothRoot(p: Float, start: Float, end: Float): Float {
    val u = ((p - start) / (end - start)).coerceIn(0f, 1f)
    return u * u * (3f - 2f * u)
}
