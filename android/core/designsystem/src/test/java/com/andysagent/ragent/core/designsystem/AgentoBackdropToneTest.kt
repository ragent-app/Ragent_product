package com.andysagent.ragent.core.designsystem

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AgentoBackdropToneTest {
    @Test fun motionDampsDeviationsWithoutChangingBlankTintOrAlpha() {
        listOf(Color(0xFFF2F2F8), Color(0xFF17171B)).forEach { canvas ->
            AgentoBackdropTone.entries.forEach { tone ->
                val tint = agentoFrostTint(canvas, Color(0xFF2C2C2E))
                val rest = agentoBackdropColourMatrix(.72f, .51f, tone, canvas, tint)
                val moving = agentoBackdropColourMatrix(.72f, .51f, tone, canvas, tint, .55f)
                apply(rest, canvas).zip(apply(moving, canvas)).forEach { (a, b) ->
                    assertEquals(a, b, .000001f)
                }
                val oldDelta = apply(rest, Color.White).zip(apply(rest, Color.Black))
                val newDelta = apply(moving, Color.White).zip(apply(moving, Color.Black))
                oldDelta.zip(newDelta).forEach { (old, new) ->
                    assertEquals((old.first - old.second) * .55f, new.first - new.second, .000001f)
                }
                assertEquals(rest.slice(15..19), moving.slice(15..19))
            }
        }
    }

    private fun matrix(tone: AgentoBackdropTone, canvas: Color) =
        agentoBackdropColourMatrix(0.72f, 0.51f, tone, canvas,
            agentoFrostTint(canvas, Color(0xFF2C2C2E)))

    @Test fun nightFrostDoesNotLiftBlackToMidGrey() {
        AgentoBackdropTone.entries.forEach { tone ->
            val black = apply(matrix(tone, Color.Black), Color.Black)
            black.forEach { assertTrue(it in 0.07f..0.10f, "Night frost baseline: $black") }
        }
    }

    @Test fun oledFrostResolvesTranslucentWhiteAgainstItsCanvas() {
        val tint = agentoFrostTint(Color.Black, Color.White.copy(alpha = 0.12f))
        assertEquals(0.12f, tint.red, 0.002f)
        assertEquals(1f, tint.alpha)
        assertEquals(Color.White, agentoFrostTint(Color(0xFFF2F2F8), Color(0xFFE1E1E3)))
    }

    @Test fun themedFrostOnlyChangesTheOffsetNotDefocusColourResponse() {
        val canvas = Color(0xFF0D0C0A)
        val tint = Color(0xFF3D3220)
        AgentoBackdropTone.entries.forEach { tone ->
            val old = agentoBackdropColourMatrix(0.72f, 0.51f, tone, canvas, Color.White)
            val themed = agentoBackdropColourMatrix(0.72f, 0.51f, tone, canvas, tint)
            (0..19).filter { it !in listOf(4, 9, 14) }.forEach {
                assertEquals(old[it], themed[it], 0.000001f)
            }
            val blank = apply(themed, canvas)
            assertTrue(blank[0] > blank[2], "Amber tint should retain its warm hue")
        }
    }

    private fun apply(matrix: FloatArray, colour: Color): List<Float> = (0..2).map { row ->
        matrix[row * 5] * colour.red + matrix[row * 5 + 1] * colour.green +
            matrix[row * 5 + 2] * colour.blue + matrix[row * 5 + 4] / 255f
    }

    @Test fun standardPreservesTheComposerRecipe() {
        val matrix = matrix(AgentoBackdropTone.Standard, Color.White)
        val luma = floatArrayOf(0.2126f, 0.7152f, 0.0722f)
        for (row in 0..2) {
            for (column in 0..2) assertEquals(
                0.49f * (luma[column] * 0.28f + if (row == column) 0.72f else 0f),
                matrix[row * 5 + column], 0.000001f,
            )
            assertEquals(255f * 0.51f, matrix[row * 5 + 4], 0.00001f)
        }
    }

    @Test fun blankCanvasIsUnchangedInLightAndDarkThemes() {
        listOf(Color(0xFFF2F2F8), Color(0xFF17171B)).forEach { canvas ->
            val standard = apply(matrix(AgentoBackdropTone.Standard, canvas), canvas)
            val quiet = apply(matrix(AgentoBackdropTone.QuietHeader, canvas), canvas)
            standard.zip(quiet).forEach { (a, b) -> assertEquals(a, b, 0.000001f) }
        }
    }

    @Test fun colourChangesRemainDynamicButHaveLessAmplitude() {
        listOf(Color.White, Color.Black).forEach { canvas ->
            val standard = matrix(AgentoBackdropTone.Standard, canvas)
            val quiet = matrix(AgentoBackdropTone.QuietHeader, canvas)
            val oldDelta = apply(standard, Color.Red).zip(apply(standard, Color.Blue))
            val newDelta = apply(quiet, Color.Red).zip(apply(quiet, Color.Blue))
            oldDelta.zip(newDelta).forEach { (old, new) ->
                assertEquals((old.first - old.second) * 0.45f, new.first - new.second, 0.000001f)
            }
        }
    }

    @Test fun colourResponseNeverChangesAlpha() {
        AgentoBackdropTone.entries.forEach { tone ->
            val matrix = matrix(tone, Color.White)
            assertEquals(listOf(0f, 0f, 0f, 1f, 0f), matrix.slice(15..19))
            assertEquals(listOf(0f, 0f, 0f), listOf(matrix[3], matrix[8], matrix[13]))
        }
    }
}
