package com.andysagent.ragent.core.navigation

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.MotionPreference

internal data class NavigationDockTarget(val destination: AgentoDestination, val hasAction: Boolean)

/** Dp geometry of the secondary creation disc, on the dock's existing phase. */
internal data class NavigationActionFrame(val diameter: Float, val start: Float, val glyphAlpha: Float)

internal fun navigationActionFrame(presence: Float): NavigationActionFrame {
    val p = presence.coerceIn(0f, 1f)
    return NavigationActionFrame(
        diameter = 48f * p,
        start = 4f * p,
        // Keep a normal-size 20dp symbol, with room around it before revealing it.
        glyphAlpha = ((p - .55f) / .45f).coerceIn(0f, 1f),
    )
}

internal data class NavigationDockFrame(
    val widthFraction: Float,
    val actionPresence: Float,
    val lensSlot: Float,
    val emphasis: List<Float>,
) {
    fun towards(target: NavigationDockFrame, progress: Float): NavigationDockFrame {
        // A shared bounded phase keeps the shell, lens and action at their
        // endpoints together. Spring overshoot must not cross the glass edge.
        val p = progress.coerceIn(0f, 1f)
        fun mix(a: Float, b: Float) = a + (b - a) * p
        return NavigationDockFrame(mix(widthFraction, target.widthFraction),
            mix(actionPresence, target.actionPresence), mix(lensSlot, target.lensSlot),
            emphasis.zip(target.emphasis) { a, b -> mix(a, b) })
    }
}

internal fun NavigationDockTarget.endpoint(): NavigationDockFrame = NavigationDockFrame(
    widthFraction = if (destination == AgentoDestination.Sessions) 1f else RagentSizes.CollapsedComposerWidthFraction,
    actionPresence = if (hasAction) 1f else 0f,
    lensSlot = destination.ordinal.toFloat(),
    emphasis = AgentoDestination.entries.map { if (it == destination) 1f else 0f },
)

/** Public child-animation state from the real NavHost, never a second timer. */
@Stable
internal class NavigationPeerClock(
    val visitId: String,
    val destination: AgentoDestination,
    val phase: State<Float>,
    val entering: () -> Boolean,
    val settled: () -> Boolean,
) { var disposed = false }

@Stable
internal class NavigationPeerClockStore {
    var clock by mutableStateOf<NavigationPeerClock?>(null)
}

internal val LocalNavigationPeerClockStore = compositionLocalOf<NavigationPeerClockStore?> { null }

internal fun navigationPeerFraction(value: Float, start: Float): Float =
    if (start >= .99999f) 1f else ((value - start) / (1f - start)).coerceIn(0f, 1f)

/** One phase, including foreground emphasis; retarget from the last measured frame. */
@Stable
internal class NavigationDockMotion(initial: NavigationDockTarget) {
    private val progress = Animatable(1f)
    private var activeTarget by mutableStateOf(initial)
    private var start by mutableStateOf(initial.endpoint())
    private var peerClock by mutableStateOf<NavigationPeerClock?>(null)
    private var peerStart by mutableStateOf(0f)
    private val presentedPeerPhases = mutableMapOf<NavigationPeerClock, Float>()
    private var lastPresented = start
    private var awaitingGesture by mutableStateOf(false)
    private var gestureTarget: NavigationDockTarget? = null

    /** Keep the finger's last frame until the new route or local settle takes over. */
    fun releaseGesture(target: NavigationDockTarget) {
        awaitingGesture = true
        gestureTarget = target
        peerClock = null
    }

    fun frame(target: NavigationDockTarget): NavigationDockFrame =
        // A requested tab can precede NavHost's actual handoff. Its old page is
        // still moving in that frame, so retain the old *live* clock as well as
        // its endpoint. Freezing only the dock separates it from visible pages.
        // The standalone dock has no page clock and still freezes until retarget.
        if (awaitingGesture || (peerClock != null && (peerClock!!.disposed || !peerClock!!.entering())) ||
            (target != activeTarget && peerClock == null)) lastPresented else start.towards(activeTarget.endpoint(),
            peerClock?.let { navigationPeerFraction(it.phase.value, peerStart) } ?: progress.value)

    fun presented(frame: NavigationDockFrame) {
        lastPresented = frame
        // Capture already-known reverse sources at the same displayed frame,
        // not a later effect frame. Predictive-back cancellation can reuse one.
        presentedPeerPhases.keys.toList().forEach {
            if (it.disposed) presentedPeerPhases.remove(it) else presentedPeerPhases[it] = it.phase.value
        }
    }

    fun settled(target: NavigationDockTarget): Boolean =
        !awaitingGesture && target == activeTarget && (peerClock?.settled?.invoke()
            ?: (progress.value >= 1f && !progress.isRunning))

    fun follow(target: NavigationDockTarget, clock: NavigationPeerClock?) {
        if (clock == null || clock.disposed || !clock.entering() || clock.destination != target.destination) return
        if (gestureTarget != null && (target != gestureTarget || clock.settled())) return
        if (clock === peerClock && target == activeTarget) return
        start = lastPresented
        peerStart = presentedPeerPhases[clock] ?: 0f
        presentedPeerPhases[clock] = clock.phase.value
        peerClock = clock
        activeTarget = target
        awaitingGesture = false
        gestureTarget = null
    }

    suspend fun retarget(target: NavigationDockTarget, preference: MotionPreference) {
        if (!awaitingGesture && target == activeTarget && progress.value == 1f) return
        // Before this effect takes over, frame() freezes the old motion. This
        // prevents an extra old-direction frame on a rapid reverse request.
        start = lastPresented
        progress.snapTo(0f)
        activeTarget = target
        awaitingGesture = false
        progress.animateTo(1f, when (preference) {
            MotionPreference.None -> snap()
            MotionPreference.Reduced -> tween(120)
            MotionPreference.Full -> spring(dampingRatio = .86f, stiffness = 280f)
        })
        gestureTarget = null
    }
}
