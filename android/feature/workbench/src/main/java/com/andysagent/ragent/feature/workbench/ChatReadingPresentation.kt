package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.mutableFloatStateOf

/** One progress owns the loading/answer handoff; they never paint over each other. */
internal fun chatReadingAlpha(progress: Float): Float = ((progress - 0.25f) / 0.75f).coerceIn(0f, 1f)
internal fun chatPreparingAlpha(progress: Float): Float = (1f - progress / 0.25f).coerceIn(0f, 1f)

/** Retire chat context before the writing header begins its own foreground handoff. */
internal fun chatWritingContextAlpha(progress: Float): Float = (1f - progress / .35f).coerceIn(0f, 1f)

/** Island expansion moves side controls, but never grows a full-width reading mask. */
internal class ChatTopControlGeometry {
    private val sideControlsSpace = mutableFloatStateOf(1f)
    fun measureSideControls(space: Float) { sideControlsSpace.floatValue = space.coerceIn(0f, 1f) }
    fun sideControlsSpace(): Float = sideControlsSpace.floatValue
}
