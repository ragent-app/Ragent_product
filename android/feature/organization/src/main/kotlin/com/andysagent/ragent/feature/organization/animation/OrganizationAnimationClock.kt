package com.andysagent.ragent.feature.organization.animation

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import kotlin.math.abs
import kotlin.math.sin

enum class AnimationMode {
    Normal,
    Reduced,
    Test
}

@Immutable
data class AnimationClockValues(
    val breathCycle: Float, // 0f .. 1f
    val sweepRotationDeg: Float, // 0f .. 360f
    val blockedPulse: Float, // 0f .. 1f
    val mode: AnimationMode = AnimationMode.Normal,
) {
    /**
     * Breathing scale for Working nodes (1.00f -> 1.08f -> 1.00f)
     * with hash-based phase offset per node.
     */
    fun nodeBreathingScale(nodeId: String): Float {
        if (mode != AnimationMode.Normal) return 1.0f
        val phase = (abs(nodeId.hashCode()) % 1000) / 1000f
        val normalized = (breathCycle + phase) % 1.0f
        // Sinusoidal ease
        val factor = ((sin(normalized * 2.0 * Math.PI - Math.PI / 2.0) + 1.0) / 2.0).toFloat()
        return 1.00f + (factor * 0.08f)
    }

    /**
     * Outer ring breathing alpha (0.35f -> 0.65f -> 0.35f)
     */
    fun nodeOuterRingAlpha(nodeId: String): Float {
        if (mode != AnimationMode.Normal) return 0.5f
        val phase = (abs(nodeId.hashCode()) % 1000) / 1000f
        val normalized = (breathCycle + phase) % 1.0f
        val factor = ((sin(normalized * 2.0 * Math.PI - Math.PI / 2.0) + 1.0) / 2.0).toFloat()
        return 0.35f + (factor * 0.30f)
    }

    /**
     * Warning pulse for Blocked nodes (subtle pulse every 3s)
     */
    fun blockedPulseAlpha(nodeId: String): Float {
        if (mode != AnimationMode.Normal) return 0.7f
        val phase = (abs(nodeId.hashCode()) % 1000) / 1000f
        val normalized = (blockedPulse + phase) % 1.0f
        val factor = ((sin(normalized * 2.0 * Math.PI - Math.PI / 2.0) + 1.0) / 2.0).toFloat()
        return 0.4f + (factor * 0.45f)
    }
}

val LocalOrganizationAnimationClock = staticCompositionLocalOf {
    AnimationClockValues(breathCycle = 0f, sweepRotationDeg = 0f, blockedPulse = 0f)
}

@Composable
fun rememberOrganizationAnimationClock(
    mode: AnimationMode = AnimationMode.Normal,
    isPaused: Boolean = false,
): AnimationClockValues {
    if (mode == AnimationMode.Test || isPaused) {
        return remember {
            AnimationClockValues(breathCycle = 0.5f, sweepRotationDeg = 0f, blockedPulse = 0.5f, mode = mode)
        }
    }

    val infiniteTransition = rememberInfiniteTransition(label = "org_clock")

    val breathCycle by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "org_breath",
    )

    val sweepRotation by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 4000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "org_sweep",
    )

    val blockedPulse by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 3200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "org_blocked_pulse",
    )

    return remember(breathCycle, sweepRotation, blockedPulse, mode) {
        AnimationClockValues(
            breathCycle = breathCycle,
            sweepRotationDeg = sweepRotation,
            blockedPulse = blockedPulse,
            mode = mode,
        )
    }
}
