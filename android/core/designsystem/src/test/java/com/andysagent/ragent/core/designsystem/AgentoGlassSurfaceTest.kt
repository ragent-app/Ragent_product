package com.andysagent.ragent.core.designsystem

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertSame

class AgentoGlassSurfaceTest {
    @Test fun neutralNeverAddsATintInAnyMaterial() {
        AgentoGlassMaterial.entries.forEach { material ->
            assertEquals(Color.Transparent, AgentoGlassSurface.Neutral.tintColor(material))
        }
    }

    @Test fun intentionalWhiteTintIsNotSilentlyReclassifiedAsNeutral() {
        val material = AgentoGlassMaterial.LiquidClear
        listOf(0.87f, 0.88f, 0.89f).forEach { alpha ->
            val color = Color.White.copy(alpha = alpha)
            assertEquals(color.copy(alpha = color.alpha * material.semanticTintScale),
                AgentoGlassSurface.Tinted(color).tintColor(material))
        }
    }

    @Test fun semanticColorUsesTheUnchangedMaterialWeight() {
        val color = Color(0x805566AA)
        AgentoGlassMaterial.entries.forEach { material ->
            assertEquals(color.copy(alpha = (color.alpha * material.semanticTintScale).coerceIn(0f, 0.86f)),
                AgentoGlassSurface.Tinted(color).tintColor(material))
        }
    }

    @Test fun backdropWashFallsBackWithoutDependingOnBrushIdentity() {
        val brush = SolidColor(Color.White.copy(alpha = 0.35f))
        val surface = AgentoGlassSurface.BrushOverlay(brush)
        assertSame(brush, surface.substrateBrush(hasBackdrop = true))
        assertNull(surface.substrateBrush(hasBackdrop = false))
        assertEquals(Color.Transparent, surface.tintColor(AgentoGlassMaterial.LiquidClear))
    }

    @Test fun independentControlFillExplicitlySurvivesMissingBackdrop() {
        val brush = SolidColor(Color.White.copy(alpha = 0.35f))
        val surface = AgentoGlassSurface.BrushOverlay(brush, keepWithoutBackdrop = true)
        assertSame(brush, surface.substrateBrush(hasBackdrop = true))
        assertSame(brush, surface.substrateBrush(hasBackdrop = false))
    }

    @Test fun unspecifiedIsNotAnImplicitMaterialSelector() {
        assertFailsWith<IllegalArgumentException> { AgentoGlassSurface.Tinted(Color.Unspecified) }
    }
}
