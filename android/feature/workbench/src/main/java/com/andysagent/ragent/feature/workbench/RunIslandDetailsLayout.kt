package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.constrainHeight
import kotlin.math.roundToInt

internal data class RunIslandDetailsGeometry(
    val height: Int,
    val detailsTop: Int,
    val detailsViewportHeight: Int,
    val detailsAlpha: Float,
)

internal fun runIslandDetailsGeometry(
    summaryHeight: Int,
    detailsHeight: Int,
    progress: Float,
    gap: Int = 0,
): RunIslandDetailsGeometry {
    val p = progress.coerceIn(0f, 1f)
    val tail = ((gap + detailsHeight) * p).roundToInt()
    val visibleGap = (gap * p).roundToInt()
    return RunIslandDetailsGeometry(
        height = summaryHeight + tail,
        detailsTop = summaryHeight + visibleGap,
        detailsViewportHeight = tail - visibleGap,
        // Height and foreground start together, rather than growing an empty
        // tail until the old miniature-content threshold has been crossed.
        detailsAlpha = FastOutSlowInEasing.transform((p / .16f).coerceIn(0f, 1f)),
    )
}

/** Progressive disclosure: preserve the task context and add details below it. */
@Composable
internal fun RunIslandDetailsLayout(
    progress: () -> Float,
    detailsExpanded: Boolean,
    summary: @Composable () -> Unit,
    details: @Composable () -> Unit,
) {
    var visibleDetailsHeight by remember { mutableIntStateOf(0) }
    Layout(modifier = Modifier.fillMaxWidth().clipToBounds(), content = {
        Box(Modifier.fillMaxWidth()) { summary() }
        val interactive = detailsExpanded && progress() >= 1f
        Box(Modifier.fillMaxWidth().testTag("run-island-details-body")
            .runIslandForegroundReveal(progress, { visibleDetailsHeight })
            .then(if (!interactive) Modifier.clearAndSetSemantics { }.pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                }
            } else Modifier)) { details() }
    }) { children, constraints ->
        val loose = constraints.copy(minHeight = 0)
        val summaryPlaceable = children[0].measure(loose)
        val detailsPlaceable = children[1].measure(loose)
        val geometry = runIslandDetailsGeometry(summaryPlaceable.height, detailsPlaceable.height, progress(), 6.dp.roundToPx())
        val height = constraints.constrainHeight(geometry.height)
        visibleDetailsHeight = (height - geometry.detailsTop).coerceIn(0, detailsPlaceable.height)
        layout(constraints.maxWidth, height) {
            // Keep final wrapping and normal glyph size throughout disclosure.
            // The soft viewport edge, not whole-card scaling, reveals new rows.
            summaryPlaceable.placeRelative(0, 0)
            // Keep layout/scroll identity placed even at the hidden endpoint,
            // as with the whole island body. Alpha and the viewport mask hide it.
            detailsPlaceable.placeRelativeWithLayer(0, geometry.detailsTop) {
                alpha = geometry.detailsAlpha
            }
        }
    }
}
