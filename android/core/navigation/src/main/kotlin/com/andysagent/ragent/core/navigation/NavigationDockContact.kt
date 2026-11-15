package com.andysagent.ragent.core.navigation

import android.view.MotionEvent
import android.view.Window
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalView

/** Android's nominal pressure is 1; valid sensor samples can exceed 1. */
internal fun navigationContactLoad(pressure: Float): Float =
    if (!pressure.isFinite() || pressure <= 0f) .58f
    else .22f + .78f * (pressure / (pressure + .45f))

private class PressureWindowCallback(val delegate: Window.Callback, var onLoad: ((Float) -> Unit)?) : Window.Callback by delegate {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN || event.actionMasked == MotionEvent.ACTION_MOVE)
            onLoad?.invoke(navigationContactLoad(event.pressure))
        return delegate.dispatchTouchEvent(event)
    }
}

private fun Context.contactWindow(): Window? = when (this) {
    is Activity -> window
    is ContextWrapper -> if (baseContext !== this) baseContext.contactWindow() else null
    else -> null
}

/** Compose coalesces stationary MOVE events. Observe pressure before that stage,
 * forwarding every event unchanged and restoring the window callback on disposal. */
@Composable
internal fun rememberNavigationContactLoad(): MutableState<Float> {
    val load = remember { mutableStateOf(.58f) }
    val window = LocalView.current.context.contactWindow()
    DisposableEffect(window) {
        val previous = window?.callback
        val observer = previous?.let { PressureWindowCallback(it) { value -> load.value = value } }
        if (window != null && observer != null) window.callback = observer
        onDispose {
            observer?.onLoad = null
            if (window != null && observer != null && window.callback === observer) window.callback = previous
        }
    }
    return load
}

internal data class NavigationContactPose(val rotationX: Float, val rotationY: Float, val scale: Float)

/** One rigid plane: no path distortion, local dents, or independent X/Y scaling. */
internal fun navigationContactPose(contact: Offset, strength: Float): NavigationContactPose {
    val load = strength.coerceIn(0f, 1f)
    val x = (contact.x.coerceIn(0f, 1f) - .5f) * 2f
    val y = (contact.y.coerceIn(0f, 1f) - .5f) * 2f
    return NavigationContactPose(rotationX = -y * 12f * load, rotationY = x * 15f * load,
        scale = 1f + .15f * load)
}
