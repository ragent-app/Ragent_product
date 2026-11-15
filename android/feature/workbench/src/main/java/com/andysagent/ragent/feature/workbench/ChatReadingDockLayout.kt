package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

/** Read in measure/draw, never used to recompose the entire chat on every IME pixel. */
internal class ChatDockGeometry {
    private val measuredHeight = mutableIntStateOf(0)
    private val visualHeight = mutableIntStateOf(0)
    val heightPx: Int get() = measuredHeight.intValue
    val visualHeightPx: Int get() = visualHeight.intValue

    fun measure(height: Int, retainReadingGeometry: Boolean = false) {
        val extent = height.coerceAtLeast(0)
        // A fullscreen editor freezes document layout, not the visible edge.
        // Its live shell/IME must still exclude text throughout the return.
        visualHeight.intValue = extent
        if (!retainReadingGeometry) measuredHeight.intValue = extent
    }

    fun padding(density: Density, top: Dp = 0.dp, extraBottom: Dp = 0.dp): PaddingValues =
        object : PaddingValues {
            override fun calculateLeftPadding(layoutDirection: LayoutDirection) = 0.dp
            override fun calculateRightPadding(layoutDirection: LayoutDirection) = 0.dp
            override fun calculateTopPadding() = top
            override fun calculateBottomPadding() = with(density) { heightPx.toDp() } + extraBottom
        }
}

/** Dock and transcript consume one layout transaction, including animated platform IME insets. */
@Composable
internal fun ChatReadingDockLayout(
    geometry: ChatDockGeometry,
    retainReadingGeometry: Boolean,
    modifier: Modifier = Modifier,
    dock: @Composable BoxScope.(Modifier) -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    // Box measures children in composition order, while their existing zIndex
    // still determines paint/hit order. Keep chrome/barriers and dock as peers:
    // wrapping all chrome in a separate branch would trap its zIndex below the
    // composer and let an expanded island's dismissal barrier be bypassed.
    Box(modifier = modifier) {
        dock(Modifier.layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            geometry.measure(placeable.height, retainReadingGeometry)
            layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
        })
        content()
    }
}
