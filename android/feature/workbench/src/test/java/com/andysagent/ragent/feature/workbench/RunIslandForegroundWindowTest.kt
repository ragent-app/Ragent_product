package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunIslandForegroundWindowTest {
    @Test fun `moving mask follows the real centered shell without changing body width`() {
        for (step in 0..100) {
            val p = step / 100f
            val visible = 180f + 180f * p
            val window = runIslandForegroundWindow(360f, visible, p, 32f)
            assertEquals(visible, window.right - window.left, .0001f)
            assertEquals(360f, window.left + window.right, .0001f)
            assertTrue(window.featherFraction in 0f.. .5f)
            if (p < 1f) assertTrue(window.featherFraction > 0f)
        }
    }

    @Test fun `stable reading endpoint is entirely sharp`() {
        assertEquals(RunIslandForegroundWindow(0f, 360f, 0f),
            runIslandForegroundWindow(360f, 360f, 1f, 32f))
    }

    @Test fun `small or stale viewport never inverts the fade stops`() {
        for (width in listOf(-10f, 0f, 1f, 30f, 900f)) {
            val window = runIslandForegroundWindow(360f, width, .1f, 32f)
            assertTrue(window.left >= 0f && window.right <= 360f)
            assertTrue(window.right >= window.left)
            assertTrue(window.featherFraction in 0f.. .5f)
        }
    }
}
