package com.andysagent.ragent.core.navigation

import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.layer.GraphicsLayer
import com.andysagent.ragent.core.designsystem.recordToLayer

/** Measured in the same transaction as the dock, not after global positioning. */
internal class PrimaryDockGeometry {
    private val extent = mutableIntStateOf(0)
    val height: Int get() = extent.intValue
    fun measure(height: Int) { extent.intValue = height.coerceAtLeast(0) }
}

internal fun primaryReadableBottom(height: Float, dockHeight: Int): Float =
    (height - dockHeight.coerceAtLeast(0)).coerceIn(0f, height.coerceAtLeast(0f))

/** Captures live pixels for floating navigation glass without painting a bottom gradient fade mask. */
internal fun Modifier.primaryReadingPlane(backdrop: GraphicsLayer, dock: PrimaryDockGeometry): Modifier =
    drawWithContent {
        recordToLayer(backdrop)
    }
