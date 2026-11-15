package com.andysagent.ragent.core.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/** Surface intent, independent of the material's frozen blur and transmission recipe. */
@Immutable
sealed interface AgentoGlassSurface {
    /** Theme-neutral substrate, with no extra status or selection tint. */
    data object Neutral : AgentoGlassSurface

    /** An intentional overlay, never inferred from the numerical value of a color. */
    data class Tinted(val color: Color) : AgentoGlassSurface {
        init {
            require(color != Color.Unspecified) { "Use Neutral for an untinted glass surface" }
        }
    }

    /**
     * Existing surface wash. Without sampling, use the readable neutral fallback
     * unless this is an independent control fill (such as the navigation lens).
     */
    data class BrushOverlay(
        val brush: Brush,
        val keepWithoutBackdrop: Boolean = false,
    ) : AgentoGlassSurface
}

internal fun AgentoGlassSurface.tintColor(material: AgentoGlassMaterial): Color = when (this) {
    is AgentoGlassSurface.Tinted -> color.copy(
        alpha = (color.alpha * material.semanticTintScale).coerceIn(0f, 0.86f),
    )
    else -> Color.Transparent
}

internal fun AgentoGlassSurface.substrateBrush(hasBackdrop: Boolean): Brush? = when (this) {
    is AgentoGlassSurface.BrushOverlay -> brush.takeIf { hasBackdrop || keepWithoutBackdrop }
    else -> null
}
