package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import kotlin.math.pow
import kotlin.math.roundToInt

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
    content: @Composable (progress: Float) -> Unit,
) {
    val density = LocalDensity.current
    val preference = motionPolicy().preference
    val animated by animateFloatAsState(if (expanded) 1f else 0f, animationSpec = when (preference) {
        MotionPreference.Full -> spring(dampingRatio = 1f, stiffness = 220f, visibilityThreshold = .002f)
        MotionPreference.Reduced -> tween(160, easing = FastOutSlowInEasing)
        MotionPreference.None -> tween(0)
    }, label = "root-conversation-shell")
    val p = animated.coerceIn(0f, 1f)
    var rootOrigin by remember { mutableStateOf<Offset?>(null) }
    val width = (origin.width + (target.width - origin.width) * p).coerceAtLeast(1f)
    val height = (origin.height + (target.height - origin.height) * p.pow(1.15f)).coerceAtLeast(1f)
    val center = origin.center + (target.center - origin.center) * p - (rootOrigin ?: Offset.Zero)
    val corner = if (sourceIsCircle) minOf(width, height) / 2f +
        (with(density) { 22.dp.toPx() } - minOf(width, height) / 2f) * smoothRoot(p, .10f, .80f) else with(density) { 22.dp.toPx() }
    val color = if (surfaceColor == Color.Unspecified) LocalRagentColors.current.canvas else surfaceColor.copy(alpha = 1f)
    Box(modifier.fillMaxSize().onGloballyPositioned { rootOrigin = it.localToRoot(Offset.Zero) }) {
        if (rootOrigin != null && origin.width > 0f && origin.height > 0f && target.width > 0f && target.height > 0f) Box(Modifier.align(AbsoluteAlignment.TopLeft)
            .absoluteOffset { IntOffset((center.x - width / 2f).roundToInt(), (center.y - height / 2f).roundToInt()) }
            .size(with(density) { width.toDp() }, with(density) { height.toDp() })
            .clip(RoundedCornerShape(with(density) { corner.coerceAtLeast(0f).toDp() })).background(color)) {
            Layout(content = { content(p) }) { measurables, constraints ->
                val child = measurables.single().measure(Constraints.fixed(target.width.roundToInt().coerceAtLeast(1), target.height.roundToInt().coerceAtLeast(1)))
                layout(constraints.maxWidth, constraints.maxHeight) { child.placeRelative(0, constraints.maxHeight - child.height) }
            }
        }
    }
}

private fun smoothRoot(p: Float, start: Float, end: Float): Float {
    val u = ((p - start) / (end - start)).coerceIn(0f, 1f)
    return u * u * (3f - 2f * u)
}
