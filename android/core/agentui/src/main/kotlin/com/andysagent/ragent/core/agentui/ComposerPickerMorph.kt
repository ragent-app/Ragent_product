package com.andysagent.ragent.core.agentui

import androidx.compose.foundation.layout.Box
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.constrainHeight
import kotlin.math.roundToInt
import com.andysagent.ragent.core.designsystem.AgentoSprings
import com.andysagent.ragent.core.designsystem.RagentComposerShadowTokens
import com.andysagent.ragent.core.designsystem.MotionPreference

/** Width settles first; readable content accompanies height rather than an empty full shell. */
internal fun pickerGeometryProgress(presence: Float): Float = presence.coerceIn(0f, 1f)
internal fun pickerWidthProgress(presence: Float): Float = (presence / .22f).coerceIn(0f, 1f)
// Height-based item reveal already protects each reading row from the moving
// edge. A second, later global fade made even a fully fitting heading disappear
// into an otherwise full-width glass shell. Finish this short entry fade with
// width settlement; let the measured viewport own the rest of the reveal/exit.
internal fun pickerForegroundProgress(presence: Float): Float = pickerWidthProgress(presence)

internal fun pickerPresenceSpec(preference: MotionPreference): FiniteAnimationSpec<Float> = when (preference) {
    MotionPreference.Full -> spring(dampingRatio = AgentoSprings.DAMPING_BOUNCELESS,
        stiffness = AgentoSprings.STIFFNESS_HIGH, visibilityThreshold = .002f)
    MotionPreference.Reduced -> tween(120, easing = FastOutSlowInEasing)
    MotionPreference.None -> tween(0)
}

/** Do not reveal a reading item while the moving edge crosses its text or thumb. */
internal fun pickerItemRevealAlpha(availableHeight: Float, itemHeight: Float): Float =
    if (itemHeight <= 0f) 1f else ((availableHeight / itemHeight - .92f) / .08f).coerceIn(0f, 1f)

/** Retire only the empty tail; any visible heading keeps a fully sampled blocker. */
internal fun pickerEmptyShellAlpha(shellHeight: Float, headingHeight: Float): Float {
    if (shellHeight <= 0f) return 0f
    if (headingHeight <= 0f) return 1f
    val progress = (shellHeight / (headingHeight * .92f)).coerceIn(0f, 1f)
    // Same geometry on entry, exit and reversal; zero derivative at both ends.
    return progress * progress * (3f - 2f * progress)
}

internal class PickerReadingViewport {
    var height by mutableIntStateOf(0)
    var headingHeight by mutableIntStateOf(0)
    var animating by mutableStateOf(false)
    var coordinates: LayoutCoordinates? = null
}

/** Group opacity with room for the diffuse halo, not a shell-sized offscreen clip. */
@Composable
internal fun Modifier.pickerShellPresence(viewport: PickerReadingViewport): Modifier {
    val paint = remember { Paint() }
    return drawWithContent {
        val alpha = pickerEmptyShellAlpha(size.height, viewport.headingHeight.toFloat())
        if (alpha >= 1f) drawContent()
        else if (alpha > 0f) {
            val halo = (maxOf(RagentComposerShadowTokens.AmbientBlur, RagentComposerShadowTokens.KeyBlur) * 3 +
                RagentComposerShadowTokens.OffsetY).toPx()
            paint.alpha = alpha
            drawContext.canvas.saveLayer(Rect(-halo, -halo, size.width + halo, size.height + halo), paint)
            try { drawContent() } finally { drawContext.canvas.restore() }
        }
    }
}

private class PickerReadingItem { var coordinates: LayoutCoordinates? = null }
private val LocalPickerReadingViewport = staticCompositionLocalOf<PickerReadingViewport?> { null }

/** A draw-only content treatment. Never masks the chat or fades the sampled glass. */
@Composable
internal fun Modifier.pickerItemReveal(heading: Boolean = false): Modifier {
    val viewport = LocalPickerReadingViewport.current ?: return this
    val item = remember { PickerReadingItem() }
    val paint = remember { Paint() }
    return then(if (heading) Modifier.layout { measurable, constraints ->
        val placeable = measurable.measure(constraints)
        // Publish actual localized/font-scaled height in measure, before the
        // parent shell draws. No position callback/frame delay.
        viewport.headingHeight = placeable.height
        layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
    } else Modifier).onPlaced { item.coordinates = it }.drawWithContent {
        if (!viewport.animating) {
            drawContent()
        } else {
            val parent = viewport.coordinates
            val child = item.coordinates
            val top = if (parent?.isAttached == true && child?.isAttached == true)
                parent.localPositionOf(child, Offset.Zero).y else Float.POSITIVE_INFINITY
            val alpha = pickerItemRevealAlpha(viewport.height - top, size.height)
            if (alpha >= 1f) drawContent()
            else if (alpha > 0f) {
                paint.alpha = alpha
                drawContext.canvas.saveLayer(Rect(Offset.Zero, size), paint)
                try { drawContent() } finally { drawContext.canvas.restore() }
            }
        }
    }
}

/**
 * Measure the page at its final width, keeping text/layout and scroll identity.
 * Only the glass viewport changes size. Its blocker remains fully effective
 * while any reading item is visible; the parent retires the empty tail only.
 */
@Composable
internal fun ComposerPickerMorphBody(
    expandedWidth: Dp,
    presence: Float,
    viewport: PickerReadingViewport,
    content: @Composable () -> Unit,
) {
    viewport.animating = presence < 1f
    Layout(modifier = Modifier.onPlaced { viewport.coordinates = it }, content = {
        Box(Modifier.testTag("composer-picker-foreground")
            .graphicsLayer { alpha = pickerForegroundProgress(presence) }) {
            CompositionLocalProvider(LocalPickerReadingViewport provides viewport) { content() }
        }
    }) { children, constraints ->
        val page = children.single().measure(Constraints(
            minWidth = expandedWidth.roundToPx(), maxWidth = expandedWidth.roundToPx(),
            maxHeight = constraints.maxHeight,
        ))
        val height = constraints.constrainHeight((page.height * pickerGeometryProgress(presence)).roundToInt())
        viewport.height = height
        layout(constraints.maxWidth, height) {
            page.placeRelative((constraints.maxWidth - page.width) / 2, 0)
        }
    }
}
