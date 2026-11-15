package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import com.andysagent.ragent.core.designsystem.motionPolicy

internal class AttentionDisclosureMotion(initiallyExpanded: Boolean) {
    val animation = Animatable(if (initiallyExpanded) 1f else 0f)
    var lastPresented = animation.value
    var animationTarget = initiallyExpanded

    // An animation frame may advance before the new target's effect runs.
    // Keep the last measured geometry until that effect takes over.
    fun progress(expanded: Boolean): Float {
        val animated = animation.value // Keep observing frames while a retarget is pending.
        return if (expanded != animationTarget) lastPresented else animated
    }

    fun record(progress: Float) { lastPresented = progress }
}

@Composable
internal fun rememberAttentionDisclosureMotion(expanded: Boolean): AttentionDisclosureMotion {
    val policy = motionPolicy()
    val motion = remember { AttentionDisclosureMotion(expanded) }
    LaunchedEffect(expanded, policy.preference) {
        val target = if (expanded) 1f else 0f
        motion.animation.snapTo(motion.lastPresented)
        motion.animationTarget = expanded
        if (policy.duration(280) == 0) motion.animation.snapTo(target)
        else motion.animation.animateTo(target, tween(policy.duration(280)))
    }
    return motion
}

/** One reveal plane: height, text visibility and disclosure indicator share a clock. */
@Composable
internal fun AttentionDisclosure(
    expanded: Boolean,
    progress: Float,
    onPresented: (Float) -> Unit,
    content: @Composable () -> Unit,
) {
    if (!expanded && progress <= 0f) {
        onPresented(0f)
        return
    }
    val interactive = expanded && progress >= 0.999f
    Box(
        Modifier.testTag("attention-disclosure")
            .clipToBounds()
            .layout { measurable, constraints ->
                val child = measurable.measure(constraints.copy(minHeight = 0))
                onPresented(progress)
                layout(child.width, attentionDisclosureHeight(child.height, progress)) {
                    child.placeRelative(0, 0)
                }
            }
            .graphicsLayer {
                alpha = (progress * 4f).coerceIn(0f, 1f)
                compositingStrategy = CompositingStrategy.Offscreen
            }
            .attentionContentEdges(bottom = { progress < .999f })
            .then(if (interactive) Modifier else Modifier
                .clearAndSetSemantics { }
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                    }
                }),
    ) { content() }
}
