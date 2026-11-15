package com.andysagent.ragent.core.agentui

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.ceil
import kotlin.math.round

/** Nonlinear Android font scaling must not leave the large-type silhouette flat. */
internal fun composerTypeMinimum(base: Dp, growth: Dp, fontScale: Float): Dp {
    if (fontScale <= 1f) return base
    return maxOf(base, (round((base.value + growth.value * (fontScale - 1f)) / 4f) * 4f).dp)
}

/** Use resolved (including font scaling) content height, not a font-scale multiplier. */
internal fun composerControlHeight(contentHeight: Dp, verticalSpace: Dp, minimum: Dp): Dp {
    val desired = contentHeight + verticalSpace
    return if (desired <= minimum) minimum else (ceil(desired.value / 4f) * 4f).dp
}
