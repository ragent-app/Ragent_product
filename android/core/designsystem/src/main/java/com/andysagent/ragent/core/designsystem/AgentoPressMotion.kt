package com.andysagent.ragent.core.designsystem

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance

/** One press language for controls, including externally owned Material clicks. */
@Composable
fun rememberAgentoPressScale(
    interactionSource: MutableInteractionSource,
    pressedScale: Float = .98f,
): State<Float> {
    val policy = LocalMotionPolicy.current
    val pressure = remember { Animatable(0f) }
    LaunchedEffect(interactionSource, policy.preference) {
        pressure.snapTo(0f)
        var activePress: PressInteraction.Press? = null
        interactionSource.interactions.filterIsInstance<PressInteraction>().filter { interaction ->
            // Hover/focus events must not cancel an in-flight press animation;
            // nor may a late release from an older pointer release a new press.
            when (interaction) {
                is PressInteraction.Press -> { activePress = interaction; true }
                is PressInteraction.Release -> (activePress === interaction.press).also {
                    if (it) activePress = null
                }
                is PressInteraction.Cancel -> (activePress === interaction.press).also {
                    if (it) activePress = null
                }
                else -> false
            }
        }.collectLatest { interaction ->
            if (policy.preference == MotionPreference.None) {
                pressure.snapTo(0f)
            } else when (interaction) {
                is PressInteraction.Press -> pressure.animateTo(1f, tween(
                    if (policy.preference == MotionPreference.Reduced) 50 else 70,
                    easing = LinearOutSlowInEasing,
                ))
                is PressInteraction.Release -> {
                    // A very short tap still gets a visible compression. This
                    // only continues the visual response; onClick runs on up.
                    if (pressure.value < .65f) pressure.animateTo(.65f, tween(35))
                    pressure.animateTo(0f, if (policy.preference == MotionPreference.Reduced)
                        tween(90) else spring(dampingRatio = .76f, stiffness = 650f))
                }
                is PressInteraction.Cancel -> pressure.animateTo(0f,
                    spring(dampingRatio = 1f, stiffness = 900f))
            }
        }
    }
    return remember(pressure, pressedScale, policy.preference) {
        derivedStateOf {
            val depth = (1f - pressedScale.coerceIn(.8f, 1f)) *
                if (policy.preference == MotionPreference.Reduced) .5f else 1f
            1f - depth * pressure.value.coerceIn(-.12f, 1f)
        }
    }
}
