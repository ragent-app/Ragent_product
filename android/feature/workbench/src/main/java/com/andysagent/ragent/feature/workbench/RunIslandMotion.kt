package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import com.andysagent.ragent.core.designsystem.AgentoSprings
import com.andysagent.ragent.core.designsystem.MotionPreference

/** Preserve interruption velocity without letting the reading shell overshoot. */
internal fun runIslandMotionSpec(preference: MotionPreference): FiniteAnimationSpec<Float> =
    when (preference) {
        MotionPreference.Full -> spring(
            dampingRatio = AgentoSprings.DAMPING_BOUNCELESS,
            stiffness = AgentoSprings.STIFFNESS_HIGH,
            visibilityThreshold = .002f,
        )
        MotionPreference.Reduced -> tween(160, easing = FastOutSlowInEasing)
        MotionPreference.None -> tween(0)
    }
