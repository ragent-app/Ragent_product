package com.andysagent.ragent.core.designsystem

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt

private val LocalSystemBarsReserved = staticCompositionLocalOf { false }

/** Origin of full-page backdrop recordings inside the protected app viewport. */
val LocalAgentoPageBackdropOrigin = compositionLocalOf { IntOffset.Zero }

/** Raw padding reads do not observe Compose inset consumption. Use this for page geometry. */
@Composable
fun remainingAppSystemBars(): WindowInsets =
    if (LocalSystemBarsReserved.current) WindowInsets(0, 0, 0, 0) else WindowInsets.systemBars

/** Only the theme canvas extends behind system bars; foreground and hit targets stay inside. */
@Composable
fun AgentoSystemSafeArea(content: @Composable () -> Unit) {
    var origin by remember { mutableStateOf(IntOffset.Zero) }
    val canvas = LocalRagentColors.current.canvas
    val safeInsets = WindowInsets.systemBars.union(WindowInsets.displayCutout)
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
        // Leave IME to descendants: imePadding subtracts the navigation inset consumed here.
        Box(Modifier.fillMaxSize()
            .windowInsetsPadding(safeInsets)) {
            Box(Modifier.fillMaxSize().clipToBounds()
                .testTag("app-system-safe-content")
                .onGloballyPositioned {
                    val position = it.positionInRoot()
                    origin = IntOffset(position.x.roundToInt(), position.y.roundToInt())
                }) {
                CompositionLocalProvider(
                    LocalSystemBarsReserved provides true,
                    LocalAgentoPageBackdropOrigin provides origin,
                    content = content,
                )
            }
        }
    }
}
