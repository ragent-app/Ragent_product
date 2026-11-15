package com.andysagent.ragent.core.agentui

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainHeight
import com.andysagent.ragent.core.designsystem.MotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import kotlin.math.roundToInt

internal fun <T> composerMorphSpec(policy: MotionPolicy): FiniteAnimationSpec<T> = when (policy.preference) {
    MotionPreference.Full -> spring(dampingRatio = .88f, stiffness = 380f)
    MotionPreference.Reduced -> tween(120)
    MotionPreference.None -> snap()
}

/** A single editor moves from the rail to the writing area; it is never replaced. */
@Composable
internal fun ComposerMorphLayout(
    modifier: Modifier = Modifier,
    progress: Float,
    compactEditor: Boolean,
    firstLineHeight: Dp,
    editorTopPadding: Dp,
    inlineEditorHeight: Dp,
    fullscreen: Boolean,
    header: @Composable () -> Unit,
    editor: @Composable () -> Unit,
    rail: @Composable () -> Unit,
) {
    Layout(modifier = modifier, content = { header(); editor(); rail() }) { children, constraints ->
        val width = constraints.maxWidth
        val loose = Constraints(maxWidth = width, maxHeight = constraints.maxHeight)
        val headerPlaceable = children[0].measure(loose)
        val railPlaceable = children[2].measure(loose)
        val available = (constraints.maxHeight - headerPlaceable.height - railPlaceable.height).coerceAtLeast(0)
        val editorPlaceable = children[1].measure(if (fullscreen) loose.copy(minHeight = available, maxHeight = available) else loose)
        val p = progress.coerceIn(0f, 1f)
        val fullEditorHeight = if (fullscreen) available else inlineEditorHeight.roundToPx()
        val editorSpace = (fullEditorHeight * p).roundToInt()
        val height = constraints.constrainHeight(headerPlaceable.height + editorSpace + railPlaceable.height)
        // At the first opening frame progress is still zero, but the editor
        // already allows wrapping. Its whole measured height is no longer a
        // single line: using it here briefly exposes line two in the capsule.
        val firstLine = if (compactEditor) editorPlaceable.height else
            firstLineHeight.roundToPx().coerceAtMost(editorPlaceable.height)
        val compactTop = (railPlaceable.height - firstLine) / 2f - editorTopPadding.toPx()
        val editorY = (compactTop * (1f - p) + headerPlaceable.height * p).roundToInt()
        // Reveal later lines without slicing the first line across the glass edge.
        val visibleHeight = (firstLine + (fullEditorHeight - firstLine) * p).roundToInt()
        layout(width, height) {
            headerPlaceable.placeRelative(0, 0)
            editorPlaceable.placeRelativeWithLayer(0, editorY) {
                clip = true
                shape = EditorViewportShape(visibleHeight)
            }
            railPlaceable.placeRelative(0, height - railPlaceable.height)
        }
    }
}

private data class EditorViewportShape(private val height: Int) : Shape {
    override fun createOutline(size: androidx.compose.ui.geometry.Size, layoutDirection: LayoutDirection, density: Density): Outline =
        Outline.Rectangle(Rect(0f, 0f, size.width, height.toFloat().coerceAtMost(size.height)))
}
