package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.FiniteAnimationSpec
import com.andysagent.ragent.core.designsystem.islandMorphMotionSpec
import com.andysagent.ragent.core.designsystem.MotionPreference

/** Preserve interruption velocity without letting the reading shell overshoot. */
internal fun runIslandMotionSpec(preference: MotionPreference): FiniteAnimationSpec<Float> =
    islandMorphMotionSpec(preference)
