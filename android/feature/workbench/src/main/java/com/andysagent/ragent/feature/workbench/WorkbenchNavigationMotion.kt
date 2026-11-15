package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.Animatable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.animation.core.tween
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import com.andysagent.ragent.core.designsystem.AgentoMotion
import com.andysagent.ragent.core.designsystem.LocalAgentoBackgrounded
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference

import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.LayoutDirection

/**
 * A two-level horizontal stack with an interruptible, interactive back offset.
 * The parent stays rendered underneath the child so predictive back reveals
 * the actual page that opened the current one instead of a blank background.
 */
@Composable
internal fun rememberWorkbenchBackStackMotion(isOpen: Boolean, backProgress: Float): WorkbenchBackStackMotion {
    val policy = LocalMotionPolicy.current
    val offset = remember { Animatable(if (isOpen) 0f else 1f) }
    val gesture = remember { WorkbenchBackGesture() }
    LaunchedEffect(isOpen, backProgress, policy.preference) {
        if (isOpen && backProgress > 0f) {
            // An early Back starts at the page's actual entry position, not
            // a fictional fully-open endpoint. Keep that origin for this drag.
            val origin = gesture.origin ?: offset.value.coerceIn(0f, 1f).also { gesture.origin = it }
            gesture.velocity = 0f
            offset.snapTo(origin + (1f - origin) * backProgress.coerceIn(0f, 1f))
        } else {
            gesture.origin = null
            val target = if (isOpen) 0f else 1f
            // One persistent position owns entry, Back, cancellation and exit.
            // Clearing external progress leaves the last dragged value intact;
            // LaunchedEffect cancellation clears Animatable's velocity, so
            // retain the last sampled velocity explicitly across retargets.
            if (policy.preference == MotionPreference.None) {
                gesture.velocity = 0f
                offset.snapTo(target)
            } else {
                offset.animateTo(target, initialVelocity = gesture.velocity, animationSpec = when (policy.preference) {
                    MotionPreference.Reduced -> tween(120)
                    else -> AgentoMotion.AppleSpring
                }) { gesture.velocity = velocity }
                gesture.velocity = 0f
            }
        }
    }
    val childOffset = offset.asState()
    val effectiveOffset = remember(childOffset) {
        derivedStateOf { childOffset.value.coerceIn(0f, 1f) }
    }
    val presence = remember(effectiveOffset) { derivedStateOf { 1f - effectiveOffset.value } }
    return WorkbenchBackStackMotion(isOpen, childOffset, effectiveOffset, presence)
}

private class WorkbenchBackGesture {
    var origin: Float? = null
    var velocity: Float = 0f
}

/** One spatial progress is shared by the sheet and its contextual dock glyph. */
internal class WorkbenchBackStackMotion(
    val isOpen: Boolean,
    val childOffset: State<Float>,
    val effectiveOffset: State<Float>,
    val presence: State<Float>,
)

@Composable
internal fun WorkbenchBackStackTransition(
    isOpen: Boolean,
    backProgress: Float,
    modifier: Modifier = Modifier,
    parentContent: @Composable () -> Unit,
    childContent: @Composable () -> Unit,
    motion: WorkbenchBackStackMotion = rememberWorkbenchBackStackMotion(isOpen, backProgress),
) {
    val spatialSign = if (LocalLayoutDirection.current == LayoutDirection.Ltr) 1f else -1f
    val isChildVisible by remember(motion.isOpen, motion.childOffset) {
        derivedStateOf { motion.isOpen || motion.childOffset.value < .999f }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(LocalRagentColors.current.canvas)
            .clipToBounds(),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer { translationX = -spatialSign * size.width * 0.15f * motion.presence.value }
                .then(if (isOpen) Modifier.clearAndSetSemantics {} else Modifier),
        ) {
            CompositionLocalProvider(LocalAgentoBackgrounded provides isOpen) {
                parentContent()
            }
            if (isChildVisible) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .drawBehind { drawRect(Color.Black,
                            alpha = (motion.presence.value * .16f).coerceIn(0f, .20f)) },
                )
            }
        }
        if (isChildVisible) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        translationX = spatialSign * size.width * motion.effectiveOffset.value
                    },
            ) {
                // Physical edge shadow cast by the sliding sheet over the background
                Box(
                    modifier = Modifier
                        .align(Alignment.CenterStart)
                        .fillMaxHeight()
                        .width(18.dp)
                        .graphicsLayer {
                            translationX = -spatialSign * 18.dp.toPx()
                            // Depth leaves with the page, including interactive
                            // Back and reversals; no full-strength trailing rail.
                            alpha = motion.presence.value
                        }
                        .background(
                            brush = Brush.horizontalGradient(
                                colors = if (spatialSign > 0f)
                                    listOf(Color.Transparent, Color.Black.copy(alpha = 0.10f))
                                else listOf(Color.Black.copy(alpha = 0.10f), Color.Transparent),
                            ),
                        ),
                )
                childContent()
            }
        }
    }
}
