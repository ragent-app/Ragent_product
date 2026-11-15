package com.andysagent.ragent.core.agentui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import kotlin.math.roundToInt

// One reversible clock, with geometry established before fullscreen labels
// become visible. In particular a short draft may have no inline header at all.
internal fun composerHeaderGeometryProgress(p: Float): Float = (p / .35f).coerceIn(0f, 1f)
internal fun composerInlineHeaderOpacity(p: Float): Float = (1f - p / .35f).coerceIn(0f, 1f)
internal fun composerFullscreenHeaderOpacity(p: Float): Float = ((p - .35f) / .3f).coerceIn(0f, 1f)

/**
 * The header shares the shell's fullscreen phase. Both endpoints are measured
 * at normal size; their heights are interpolated, never stacked. Foregrounds
 * hand over without overlapping, and fullscreen labels never enter a viewport
 * shorter than their measured height. In particular,
 * reversing fullscreen does not start a second independent header animation.
 */
@Composable
internal fun ComposerHeaderMorph(
    fullscreenProgress: Float,
    inlineProgress: Float,
    fullscreenTarget: Boolean,
    inlineHeader: @Composable () -> Unit,
    fullscreenHeader: @Composable () -> Unit,
) {
    val p = fullscreenProgress.coerceIn(0f, 1f)
    Layout(
        modifier = Modifier.fillMaxWidth().clipToBounds().testTag("composer-morph-header"),
        content = {
            Box(Modifier.fillMaxWidth().then(if (fullscreenTarget || inlineProgress <= .001f || composerInlineHeaderOpacity(p) <= 0f) Modifier.clearAndSetSemantics {} else Modifier)) {
                inlineHeader()
            }
            Box(Modifier.fillMaxWidth().then(if (!fullscreenTarget || composerFullscreenHeaderOpacity(p) <= 0f) Modifier.clearAndSetSemantics {} else Modifier)) {
                fullscreenHeader()
            }
        },
    ) { children, constraints ->
        val loose = Constraints(maxWidth = constraints.maxWidth, maxHeight = constraints.maxHeight)
        val inline = children[0].measure(loose)
        val full = children[1].measure(loose)
        val inlineHeight = inline.height * inlineProgress.coerceIn(0f, 1f)
        val geometry = composerHeaderGeometryProgress(p)
        val height = constraints.constrainHeight((inlineHeight * (1f - geometry) + full.height * geometry).roundToInt())
        layout(constraints.maxWidth, height) {
            fun placeInline() = inline.placeRelativeWithLayer(0, 0) {
                alpha = (composerInlineHeaderOpacity(p) * inlineProgress).coerceIn(0f, 1f)
            }
            fun placeFull() = full.placeRelativeWithLayer(0, 0) {
                alpha = composerFullscreenHeaderOpacity(p)
            }
            // Only the target owns live controls/semantics. Place it last so
            // retained, transparent endpoint controls cannot intercept it.
            if (fullscreenTarget) { placeInline(); placeFull() }
            else { placeFull(); placeInline() }
        }
    }
}
