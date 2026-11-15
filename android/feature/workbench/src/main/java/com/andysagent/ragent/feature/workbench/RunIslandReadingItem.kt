package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.unit.dp

internal class RunIslandReadingViewport {
    var width by mutableIntStateOf(0)
    var height by mutableIntStateOf(0)
    var coordinates: LayoutCoordinates? = null
}

internal val LocalRunIslandReadingViewport = staticCompositionLocalOf<RunIslandReadingViewport?> { null }
private class RunIslandReadingCoordinates { var value: LayoutCoordinates? = null }

/** Fade a complete reading unit before either moving side can cut its letters. */
internal fun runIslandReadingAlpha(bodyWidth: Float, shellWidth: Float, left: Float, right: Float, feather: Float): Float {
    if (shellWidth >= bodyWidth) return 1f
    val edge = (bodyWidth - shellWidth.coerceAtLeast(0f)) / 2f
    val clearance = minOf(left - edge, bodyWidth - edge - right)
    val p = (clearance / feather.coerceAtLeast(1f)).coerceIn(0f, 1f)
    return p * p * (3f - 2f * p)
}

/** Fade the complete unit before the moving bottom edge reaches its glyphs. */
internal fun runIslandReadingVerticalAlpha(visibleHeight: Float, bottom: Float, feather: Float): Float {
    if (bottom <= visibleHeight - feather) return 1f
    if (bottom >= visibleHeight) return 0f
    val p = ((visibleHeight - bottom) / feather.coerceAtLeast(1f)).coerceIn(0f, 1f)
    return p * p * (3f - 2f * p)
}

/** No-op outside the morphing phone island (e.g. the tablet's shared run sheet). */
@Composable
internal fun Modifier.runIslandReadingItem(protectBottom: Boolean = true): Modifier {
    val viewport = LocalRunIslandReadingViewport.current ?: return this
    val item = remember { RunIslandReadingCoordinates() }
    val paint = remember { Paint() }
    return onPlaced { item.value = it }.drawWithContent {
        val width = viewport.width.toFloat()
        val body = viewport.coordinates
        val child = item.value
        val alpha = if (body?.isAttached == true && child?.isAttached == true) {
            val position = body.localPositionOf(child, Offset.Zero)
            val horizontal = runIslandReadingAlpha(
                body.size.width.toFloat(), width, position.x, position.x + size.width, 8.dp.toPx(),
            )
            val vertical = if (protectBottom) runIslandReadingVerticalAlpha(
                viewport.height.toFloat(), position.y + size.height, 20.dp.toPx(),
            ) else 1f
            minOf(horizontal, vertical)
        } else 0f
        if (alpha >= 1f) drawContent()
        else if (alpha > 0f) {
            paint.alpha = alpha
            drawContext.canvas.saveLayer(Rect(Offset.Zero, size), paint)
            try { drawContent() } finally { drawContext.canvas.restore() }
        }
    }
}
