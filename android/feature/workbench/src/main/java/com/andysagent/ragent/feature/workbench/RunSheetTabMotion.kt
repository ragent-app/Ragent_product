package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.constrainHeight
import kotlin.math.roundToInt

@Immutable
internal data class RunSheetTabFrame(
    val height: Int = 0,
    val selection: Float = 0f,
    val opacity: List<Float> = listOf(1f, 0f, 0f),
)

/** Last placed frame, not an intermediate measurement or observable layout loop. */
internal class RunSheetFrameHolder { var frame: RunSheetTabFrame? = null }

/** Publish the source, destination and fresh clock together on retarget. */
internal class RunSheetTabSegment(
    val source: RunSheetTabFrame = RunSheetTabFrame(),
    val target: RunSheetTab = RunSheetTab.Metrics,
    initialProgress: Float = 1f,
) {
    val progress = Animatable(initialProgress)
}

internal fun runSheetTabFrame(source: RunSheetTabFrame, target: RunSheetTab, targetHeight: Int, progress: Float): RunSheetTabFrame {
    val p = progress.coerceIn(0f, 1f)
    if (p == 0f) return source
    val startHeight = source.height.takeIf { it > 0 } ?: targetHeight
    val expanding = targetHeight > startHeight
    val shrinking = targetHeight < startHeight
    // Grow first so the destination is never clipped. When shrinking, the
    // smaller destination can take ownership early while the shell follows it.
    val reshape = FastOutSlowInEasing.transform(
        when {
            expanding -> (p / 0.68f).coerceIn(0f, 1f)
            shrinking -> ((p - 0.12f) / 0.88f).coerceIn(0f, 1f)
            else -> p
        },
    )
    val handoff = when {
        expanding -> 0.72f
        shrinking -> 0.28f
        else -> 0.5f
    }
    val dipSpan = 0.10f
    val dipAlpha = 0.72f
    val sourceIndex = source.opacity.indices.maxByOrNull { source.opacity[it] }
        ?: source.selection.roundToInt().coerceIn(0, RunSheetTab.entries.lastIndex)
    // A single readable page owns the pixels at every frame. The brief opacity
    // dip softens the ownership swap without crossfading two sets of glyphs.
    val ownerIndex: Int
    val ownerAlpha: Float
    if (p < handoff) {
        ownerIndex = sourceIndex
        val dip = FastOutSlowInEasing.transform(
            ((p - (handoff - dipSpan)) / dipSpan).coerceIn(0f, 1f),
        )
        ownerAlpha = 1f - (1f - dipAlpha) * dip
    } else {
        ownerIndex = target.ordinal
        val recover = FastOutSlowInEasing.transform(((p - handoff) / dipSpan).coerceIn(0f, 1f))
        ownerAlpha = dipAlpha + (1f - dipAlpha) * recover
    }
    return RunSheetTabFrame(
        height = (startHeight + (targetHeight - startHeight) * reshape).roundToInt(),
        selection = source.selection + (target.ordinal - source.selection) * FastOutSlowInEasing.transform(p),
        opacity = RunSheetTab.entries.mapIndexed { index, _ -> if (index == ownerIndex) ownerAlpha else 0f },
    )
}

/** All geometry/opacity is derived from one interruptible transaction clock. */
@Composable
internal fun RunSheetPages(
    sourceFrame: RunSheetTabFrame,
    target: RunSheetTab,
    progress: State<Float>,
    holder: RunSheetFrameHolder,
    content: @Composable (RunSheetTab) -> Unit,
) {
    Layout(
        modifier = Modifier.fillMaxWidth().clipToBounds(),
        content = {
            RunSheetTab.entries.forEach { tab -> key(tab) { Box { content(tab) } } }
        },
    ) { measurables, constraints ->
        val pages = measurables.map { it.measure(constraints.copy(minHeight = 0)) }
        val frame = runSheetTabFrame(sourceFrame, target, pages[target.ordinal].height, progress.value)
            .let { it.copy(height = constraints.constrainHeight(it.height)) }
        layout(constraints.maxWidth, frame.height) {
            holder.frame = frame
            pages.forEachIndexed { index, page ->
                // Unplaced transparent pages cannot intercept the selected page.
                if (frame.opacity[index] > 0f) page.placeWithLayer(0, 0) { alpha = frame.opacity[index] }
            }
        }
    }
}
