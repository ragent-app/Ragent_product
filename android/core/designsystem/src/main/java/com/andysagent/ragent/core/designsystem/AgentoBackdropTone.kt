package com.andysagent.ragent.core.designsystem

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver

/** Colour response only: never changes spatial defocus, grain, or opacity. */
enum class AgentoBackdropTone(val colourResponse: Float) {
    Standard(1f),
    QuietHeader(0.45f),
}

internal fun agentoFrostTint(canvas: Color, elevatedSurface: Color): Color =
    if (canvas.red < 0.5f) elevatedSurface.compositeOver(canvas) else Color.White

internal fun agentoBackdropColourMatrix(
    saturation: Float,
    frostWhiteness: Float,
    tone: AgentoBackdropTone,
    canvas: Color,
    frostTint: Color,
    motionResponse: Float = 1f,
): FloatArray {
    val weight = 1f - frostWhiteness
    val luma = floatArrayOf(0.2126f, 0.7152f, 0.0722f)
    val anchor = floatArrayOf(canvas.red, canvas.green, canvas.blue)
    val frost = floatArrayOf(frostTint.red, frostTint.green, frostTint.blue)
    val response = tone.colourResponse * motionResponse.coerceIn(0f, 1f)
    return FloatArray(20).also { matrix ->
        for (row in 0..2) {
            var anchoredColour = 0f
            for (column in 0..2) {
                val coefficient = weight * (luma[column] * (1f - saturation) +
                    if (row == column) saturation else 0f)
                matrix[row * 5 + column] = response * coefficient
                anchoredColour += coefficient * anchor[column]
            }
            // Compress deviations around the page, not white. Blank areas
            // retain the Standard baseline in both light and dark themes.
            // Frost describes the mixing weight, not a compulsory white lift.
            // Night materials converge toward their elevated theme surface.
            matrix[row * 5 + 4] = 255f * (frostWhiteness * frost[row] + (1f - response) * anchoredColour)
        }
        matrix[18] = 1f
    }
}
