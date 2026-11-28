package com.andysagent.ragent.core.designsystem

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.IntOffset
import kotlinx.coroutines.isActive
import kotlin.math.roundToInt

private val LocalSystemBarsReserved = staticCompositionLocalOf { false }

/** Origin of full-page backdrop recordings inside the protected app viewport. */
val LocalAgentoPageBackdropOrigin = compositionLocalOf { IntOffset.Zero }

@Immutable
data class HorizonEdgeAuraSpec(
    val ownerKey: String,
    val phase: AgentoAuraPhase,
    val voiceLevel: Float = 0f,
    val ambientIntensity: Float = 1f,
    val heightFraction: Float = 0.32f,
    val renderInEdgeStrip: Boolean = true,
)

@Stable
class HorizonEdgeAuraController {
    private val registrations = mutableStateMapOf<String, HorizonEdgeAuraSpec>()

    val activeSpec: HorizonEdgeAuraSpec?
        get() = registrations["chat"] ?: registrations["home"]

    internal val phaseEnteredAtMs = mutableLongStateOf(System.currentTimeMillis())
    internal val frameNowMs = mutableLongStateOf(phaseEnteredAtMs.longValue)
    internal val animTimeSec = mutableFloatStateOf(0f)

    fun register(spec: HorizonEdgeAuraSpec) {
        registrations[spec.ownerKey] = spec
    }

    fun clear(ownerKey: String) {
        registrations.remove(ownerKey)
    }
}

val LocalHorizonEdgeAuraController = compositionLocalOf<HorizonEdgeAuraController?> { null }
val LocalSystemBottomInsetPx = compositionLocalOf { 0f }

/** Raw padding reads do not observe Compose inset consumption. Use this for page geometry. */
@Composable
fun remainingAppSystemBars(): WindowInsets =
    if (LocalSystemBarsReserved.current) WindowInsets(0, 0, 0, 0) else WindowInsets.systemBars

/** Only the theme canvas and opted-in horizon aura extend behind system bars; foreground and hit targets stay inside. */
@Composable
fun AgentoSystemSafeArea(content: @Composable () -> Unit) {
    var origin by remember { mutableStateOf(IntOffset.Zero) }
    var safeViewportHeightPx by remember { mutableFloatStateOf(0f) }
    val controller = remember { HorizonEdgeAuraController() }
    val colors = LocalRagentColors.current
    val canvas = colors.canvas
    val isDark = canvas.red < 0.5f
    val motionPreference = LocalMotionPolicy.current.preference
    val backgrounded = LocalAgentoBackgrounded.current
    val density = LocalDensity.current
    val safeInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout)
    val bottomInsetPx = safeInsets.getBottom(density).toFloat()
    val activeSpec = controller.activeSpec

    LaunchedEffect(activeSpec?.ownerKey, activeSpec?.phase, motionPreference, isDark, backgrounded) {
        val current = activeSpec ?: return@LaunchedEffect
        val enterMs = System.currentTimeMillis()
        controller.phaseEnteredAtMs.longValue = enterMs
        controller.frameNowMs.longValue = enterMs
        if (motionPreference != MotionPreference.Full || backgrounded) {
            return@LaunchedEffect
        }
        var lastDrawNs = 0L
        var prevFrameNs = 0L
        while (isActive) {
            var shouldContinue = true
            withFrameNanos { nowNs ->
                if (prevFrameNs == 0L) prevFrameNs = nowNs
                val nowMs = System.currentTimeMillis()
                val elapsedMs = (nowMs - enterMs).coerceAtLeast(0L)
                val latestVoiceLevel = controller.activeSpec?.voiceLevel ?: current.voiceLevel
                val optics = computeAgentoAuraOptics(
                    phase = current.phase,
                    phaseElapsedMs = elapsedMs,
                    nowMs = nowMs,
                    isDark = isDark,
                    voiceLevel = latestVoiceLevel,
                )
                if (optics.shouldSleep) {
                    controller.frameNowMs.longValue = nowMs
                    shouldContinue = false
                    return@withFrameNanos
                }
                val gapMs = if (lastDrawNs == 0L) Long.MAX_VALUE else (nowNs - lastDrawNs) / 1_000_000L
                if (gapMs >= optics.targetFrameMs) {
                    val dtSec = ((nowNs - prevFrameNs).coerceIn(0L, 50_000_000L)) / 1_000_000_000f
                    controller.animTimeSec.floatValue = (controller.animTimeSec.floatValue + dtSec * optics.speed) % 10_000f
                    controller.frameNowMs.longValue = nowMs
                    lastDrawNs = nowNs
                    prevFrameNs = nowNs
                }
            }
            if (!shouldContinue) break
        }
    }

    // Paint only reserved bands: a separate Dialog must keep its interior transparent.
    Box(Modifier.fillMaxSize().drawBehind {
        val top = safeInsets.getTop(this).toFloat().coerceAtMost(size.height)
        val bottom = safeInsets.getBottom(this).toFloat().coerceAtMost(size.height)
        val left = safeInsets.getLeft(this, layoutDirection).toFloat().coerceAtMost(size.width)
        val right = safeInsets.getRight(this, layoutDirection).toFloat().coerceAtMost(size.width)
        drawRect(canvas, size = Size(size.width, top))
        drawRect(canvas, topLeft = Offset(0f, size.height - bottom), size = Size(size.width, bottom))
        drawRect(canvas, size = Size(left, size.height))
        drawRect(canvas, topLeft = Offset(size.width - right, 0f), size = Size(right, size.height))
    }) {
        if (activeSpec != null && activeSpec.renderInEdgeStrip && bottomInsetPx > 0.5f && safeViewportHeightPx > 0f) {
            Box(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(with(density) { bottomInsetPx.toDp() })
                    .clipToBounds(),
            ) {
                AgentoHorizonAura(
                    phase = activeSpec.phase,
                    voiceLevel = activeSpec.voiceLevel,
                    ambientIntensity = activeSpec.ambientIntensity,
                    heightFraction = activeSpec.heightFraction,
                    renderHeightOverridePx = safeViewportHeightPx + bottomInsetPx,
                    verticalOffsetPx = -safeViewportHeightPx,
                    sharedClock = controller,
                )
            }
        }
        // Leave IME to descendants: imePadding subtracts the navigation inset consumed here.
        Box(Modifier.fillMaxSize()
            .windowInsetsPadding(safeInsets)) {
            Box(Modifier.fillMaxSize().clipToBounds()
                .testTag("app-system-safe-content")
                .onSizeChanged { safeViewportHeightPx = it.height.toFloat() }
                .onGloballyPositioned {
                    val position = it.positionInRoot()
                    origin = IntOffset(position.x.roundToInt(), position.y.roundToInt())
                }) {
                CompositionLocalProvider(
                    LocalSystemBarsReserved provides true,
                    LocalAgentoPageBackdropOrigin provides origin,
                    LocalHorizonEdgeAuraController provides controller,
                    LocalSystemBottomInsetPx provides bottomInsetPx,
                    content = content,
                )
            }
        }
    }
}
