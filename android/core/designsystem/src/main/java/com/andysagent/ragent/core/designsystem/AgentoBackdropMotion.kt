package com.andysagent.ragent.core.designsystem

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest

/** Draw-phase colour response, not opacity or a stale screenshot of the page. */
val LocalAgentoBackdropMotionResponse = compositionLocalOf<State<Float>> { mutableStateOf(1f) }

@Composable
fun rememberAgentoBackdropMotionResponse(isMoving: () -> Boolean): State<Float> {
    val response = remember { Animatable(1f) }
    LaunchedEffect(isMoving) {
        snapshotFlow(isMoving).collectLatest { moving ->
            if (moving) {
                response.animateTo(0.55f, tween(120))
            } else {
                // Do not brighten between a drag and its fling, or when the
                // user reverses direction. Cancellation resumes from here.
                delay(180)
                response.animateTo(1f, tween(420))
            }
        }
    }
    return response.asState()
}
