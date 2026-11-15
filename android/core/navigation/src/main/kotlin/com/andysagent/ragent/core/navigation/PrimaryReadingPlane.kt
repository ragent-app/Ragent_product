package com.andysagent.ragent.core.navigation

import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.recordToLayer

/** Measured in the same transaction as the dock, not after global positioning. */
internal class PrimaryDockGeometry {
    private val extent = mutableIntStateOf(0)
    val height: Int get() = extent.intValue
    fun measure(height: Int) { extent.intValue = height.coerceAtLeast(0) }
}

internal fun primaryReadableBottom(height: Float, dockHeight: Int): Float =
    (height - dockHeight.coerceAtLeast(0)).coerceIn(0f, height.coerceAtLeast(0f))

/** The reader exits before controls; their glass still sees unmodified page pixels. */
internal fun Modifier.primaryReadingPlane(backdrop: GraphicsLayer, dock: PrimaryDockGeometry): Modifier =
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithCache {
        val height = size.height.coerceAtLeast(1f)
        val bottom = primaryReadableBottom(size.height, dock.height)
        val feather = minOf(24.dp.toPx(), bottom)
        val mask = Brush.verticalGradient(
            0f to Color.White,
            ((bottom - feather) / height) to Color.White,
            (bottom / height) to Color.Transparent,
            1f to Color.Transparent,
            startY = 0f, endY = height,
        )
        onDrawWithContent {
            recordToLayer(backdrop)
            if (dock.height > 0) drawRect(mask, blendMode = BlendMode.DstIn)
        }
    }
