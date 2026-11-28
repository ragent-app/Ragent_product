package com.andysagent.ragent.core.designsystem

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings

enum class MotionPreference { Full, Reduced, None }

@Immutable
data class MotionPolicy(val preference: MotionPreference = MotionPreference.Full) {
    fun duration(normal: Int): Int = when (preference) {
        MotionPreference.Full -> normal
        MotionPreference.Reduced -> when (normal) {
            RagentMotion.Navigation, RagentMotion.Disclosure -> RagentMotion.Feedback
            else -> normal
        }
        MotionPreference.None -> RagentMotion.Immediate
    }

    fun usesFadeForStructuralChange(): Boolean = preference != MotionPreference.None
}

val LocalMotionPolicy = staticCompositionLocalOf { MotionPolicy() }

/** True while a navigation layer is retained only for predictive-back reveal. */
val LocalAgentoBackgrounded = staticCompositionLocalOf { false }

@Composable
fun rememberSystemMotionPreference(): MotionPreference {
    val context = LocalContext.current
    var preference by remember(context) { mutableStateOf(readSystemMotionPreference(context)) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                preference = readSystemMotionPreference(context)
            }
        }
        val resolver = context.contentResolver
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.TRANSITION_ANIMATION_SCALE), false, observer)
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.WINDOW_ANIMATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return preference
}

fun readSystemMotionPreference(context: Context): MotionPreference {
    val resolver = context.contentResolver
    val scales = listOf(
        Settings.Global.ANIMATOR_DURATION_SCALE,
        Settings.Global.TRANSITION_ANIMATION_SCALE,
        Settings.Global.WINDOW_ANIMATION_SCALE,
    ).map { key -> Settings.Global.getFloat(resolver, key, 1f) }
    return when {
        scales.any { it <= 0f } -> MotionPreference.None
        scales.any { it < 1f } -> MotionPreference.Reduced
        else -> MotionPreference.Full
    }
}

@Composable
fun motionPolicy(): MotionPolicy = LocalMotionPolicy.current

/**
 * Apple & M3 damping spring standards (Spec-07)
 */
object AgentoSprings {
    const val DAMPING_SNAPPY = 0.82f
    const val DAMPING_BOUNCY = 0.72f
    const val DAMPING_SMOOTH = 0.88f
    const val DAMPING_GENTLE = 0.90f
    const val DAMPING_MICRO = 0.78f
    const val DAMPING_INDICATOR = 0.88f
    const val DAMPING_BOUNCELESS = 1.0f

    const val STIFFNESS_HIGH = 420f
    const val STIFFNESS_EXPRESSIVE = 360f
    const val STIFFNESS_MEDIUM = 320f
    const val STIFFNESS_LOW = 180f

    fun <T> snappy(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_SNAPPY, stiffness = STIFFNESS_HIGH)

    fun <T> bouncy(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_BOUNCY, stiffness = STIFFNESS_EXPRESSIVE)

    fun <T> smooth(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_SMOOTH, stiffness = STIFFNESS_MEDIUM)

    fun <T> gentle(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_GENTLE, stiffness = 260f)

    fun <T> micro(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_MICRO, stiffness = 440f)

    fun <T> indicator(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_INDICATOR, stiffness = 430f)

    fun <T> keyboard(): androidx.compose.animation.core.SpringSpec<T> =
        androidx.compose.animation.core.spring(dampingRatio = DAMPING_BOUNCELESS, stiffness = STIFFNESS_HIGH)
}
