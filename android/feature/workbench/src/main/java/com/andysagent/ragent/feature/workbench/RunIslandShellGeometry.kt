package com.andysagent.ragent.feature.workbench

internal data class RunIslandShellGeometry(
    val shellProgress: Float,
    val bodyProgress: Float,
    val bodyAlpha: Float,
)

/** Keep the endpoint body size stable while the whole shell is morphing. */
internal class RunIslandBodyHeight {
    private var retained: Int? = null

    fun resolve(measured: Int, progress: Float, expanded: Boolean): Int {
        if (retained == null || progress <= 0f || (expanded && progress >= 1f)) {
            retained = measured
        }
        return requireNotNull(retained)
    }
}

/**
 * All channels belong to one spring. Width holds a readable viewport while
 * the body withdraws more decisively, so the card does not keep a tall empty
 * glass tail after its reading units have left. The foreground itself remains
 * endpoint-sized; item and viewport masks still protect glyphs from clipping.
 */
internal fun runIslandShellGeometry(progress: Float): RunIslandShellGeometry {
    val p = progress.coerceIn(0f, 1f)
    val remaining = 1f - p
    val remainingCubed = remaining * remaining * remaining
    return RunIslandShellGeometry(
        // A sixth-order-biased continuous arc is not a delayed second stage:
        // width moves on every frame, but keeps both side margins readable
        // until the body is nearly gone. The cubic share preserves a real,
        // representable tail near 1f instead of flattening in Float precision.
        shellProgress = 1f - remainingCubed * (.15f + .85f * remainingCubed),
        // Faster height withdrawal removes the empty lower chamber without a
        // threshold, plateau, or replacement shell.
        bodyProgress = p * p,
        // Let readable content outlive its old p^2 fade. The existing masks,
        // rather than whole-body opacity, decide when an individual row no
        // longer fits the moving viewport.
        bodyAlpha = p * (2f - p),
    )
}

/** Reserve only the real free space on each side of the centred title shell. */
internal fun runIslandSideControlsSpace(fullWidth: Int, shellWidth: Int, controlWidth: Int): Float =
    ((fullWidth - shellWidth).coerceAtLeast(0).toFloat() / (2f * controlWidth.coerceAtLeast(1)))
        .coerceIn(0f, 1f)
