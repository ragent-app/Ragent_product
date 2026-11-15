package com.andysagent.ragent.feature.workbench

import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

class ChatDockGeometryTest {
    @Test fun `existing padding reads current measured dock without recreation`() {
        val dock = ChatDockGeometry()
        val padding = dock.padding(Density(2f), top = 56.dp, extraBottom = 32.dp)
        dock.measure(96)
        assertEquals(80.dp, padding.calculateBottomPadding())
        dock.measure(800)
        assertEquals(432.dp, padding.calculateBottomPadding())
        dock.measure(96)
        assertEquals(80.dp, padding.calculateBottomPadding())
        assertEquals(56.dp, padding.calculateTopPadding())
        assertEquals(0.dp, padding.calculateLeftPadding(LayoutDirection.Rtl))
        assertEquals(0.dp, padding.calculateRightPadding(LayoutDirection.Ltr))
    }
    @Test fun `dock measurement follows both directions without defining a mask`() {
        val dock = ChatDockGeometry()
        listOf(96, 280, 800, 600, 240, 96).forEach { measured ->
            dock.measure(measured)
            assertEquals(measured, dock.heightPx)
        }
        dock.measure(-1)
        assertEquals(0, dock.heightPx)
    }

    @Test fun `writing retains document viewport but visual edge follows shell and IME return`() {
        val dock = ChatDockGeometry()
        val padding = dock.padding(Density(2f), extraBottom = 32.dp)
        dock.measure(96)
        listOf(280, 800, 900, 800, 600, 240).forEach { shell ->
            dock.measure(shell, retainReadingGeometry = true)
            assertEquals(96, dock.heightPx)
            assertEquals(80.dp, padding.calculateBottomPadding())
            assertEquals(shell, dock.visualHeightPx)
        }
        dock.measure(240)
        assertEquals(240, dock.heightPx)
        assertEquals(240, dock.visualHeightPx)
        assertEquals(152.dp, padding.calculateBottomPadding())
    }
}
