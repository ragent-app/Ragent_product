package com.andysagent.ragent.core.designsystem

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween

data class IslandMorphGeometry(val shellProgress: Float, val bodyProgress: Float, val bodyAlpha: Float)

fun islandMorphGeometry(progress: Float): IslandMorphGeometry {
    val p = progress.coerceIn(0f, 1f)
    val remaining = 1f - p
    val cube = remaining * remaining * remaining
    return IslandMorphGeometry(1f - cube * (.15f + .85f * cube), p * p, p * (2f - p))
}

fun islandMorphMotionSpec(preference: MotionPreference): FiniteAnimationSpec<Float> = when (preference) {
    MotionPreference.Full -> spring(dampingRatio = 1f, stiffness = 420f, visibilityThreshold = .002f)
    MotionPreference.Reduced -> tween(160, easing = FastOutSlowInEasing)
    MotionPreference.None -> tween(0)
}
