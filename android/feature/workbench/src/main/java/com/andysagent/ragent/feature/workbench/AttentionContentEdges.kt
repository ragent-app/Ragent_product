package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

/** Only notification details: the glass/raw sample and fixed decision rail stay outside. */
internal fun Modifier.attentionContentEdges(
    top: () -> Boolean = { false },
    bottom: () -> Boolean = { false },
): Modifier = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithCache {
    val upper = if (top()) minOf(12.dp.toPx(), size.height / 2f) else 0f
    val lower = if (bottom()) minOf(16.dp.toPx(), size.height / 2f) else 0f
    val height = size.height.coerceAtLeast(1f)
    val mask = Brush.verticalGradient(
        0f to if (upper > 0f) Color.Transparent else Color.White,
        upper / height to Color.White,
        (height - lower) / height to Color.White,
        1f to if (lower > 0f) Color.Transparent else Color.White,
    )
    onDrawWithContent {
        drawContent()
        if (upper > 0f || lower > 0f) drawRect(mask, blendMode = BlendMode.DstIn)
    }
}
