package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

/** Reveal normal-size foreground; neither glass nor raw backdrop enters this mask. */
internal fun Modifier.runIslandForegroundReveal(
    progress: () -> Float,
    visibleHeight: () -> Int,
    visibleWidth: () -> Int = { Int.MAX_VALUE },
): Modifier = graphicsLayer {
    compositingStrategy = CompositingStrategy.Offscreen
}.drawWithCache {
    val p = progress().coerceIn(0f, 1f)
    val visible = visibleHeight().toFloat().coerceIn(0f, size.height)
    val feather = minOf(24.dp.toPx() * (1f - p), visible)
    val height = size.height.coerceAtLeast(1f)
    val measuredWidth = visibleWidth().toFloat()
    val window = runIslandForegroundWindow(size.width, measuredWidth, p, 32.dp.toPx())
    val horizontalMask = Brush.horizontalGradient(
        0f to Color.Transparent,
        window.featherFraction to Color.White,
        (1f - window.featherFraction) to Color.White,
        1f to Color.Transparent,
        startX = window.left, endX = window.right.coerceAtLeast(window.left + 1f),
    )
    val mask = Brush.verticalGradient(
        0f to Color.White,
        ((visible - feather) / height) to Color.White,
        (visible / height) to Color.Transparent,
        1f to Color.Transparent,
        startY = 0f, endY = height,
    )
    onDrawWithContent {
        drawContent()
        // At the stable endpoint the last line/control remains entirely sharp.
        if (p < 1f) {
            drawRect(mask, blendMode = BlendMode.DstIn)
            // The body retains its full reading width while the shell narrows.
            // Soften the actual moving viewport edges, rather than chopping
            // normal-size letters at the shell's left/right clip boundary.
            if (measuredWidth < size.width) drawRect(horizontalMask, blendMode = BlendMode.DstIn)
        }
    }
}

internal data class RunIslandForegroundWindow(
    val left: Float,
    val right: Float,
    val featherFraction: Float,
)

internal fun runIslandForegroundWindow(
    bodyWidth: Float,
    visibleWidth: Float,
    progress: Float,
    maximumFeather: Float,
): RunIslandForegroundWindow {
    val body = bodyWidth.coerceAtLeast(0f)
    val visible = visibleWidth.coerceIn(0f, body)
    val left = (body - visible) / 2f
    val feather = minOf(maximumFeather.coerceAtLeast(0f) * (1f - progress.coerceIn(0f, 1f)), visible / 2f)
    return RunIslandForegroundWindow(left, left + visible, if (visible > 0f) feather / visible else .5f)
}
