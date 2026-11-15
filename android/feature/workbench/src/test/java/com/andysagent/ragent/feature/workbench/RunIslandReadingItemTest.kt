package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunIslandReadingItemTest {
    @Test fun `reading unit withdraws before either side intersects and reverses without another clock`() {
        for ((left, right) in listOf(16f to 384f, 28f to 192f, 208f to 372f, 160f to 240f)) {
            val values = (200..400).map { width ->
                val alpha = runIslandReadingAlpha(400f, width.toFloat(), left, right, 8f)
                val edge = (400 - width) / 2f
                if (edge >= left || 400 - edge <= right) assertEquals(0f, alpha)
                assertTrue(alpha in 0f..1f)
                alpha
            }
            assertEquals(1f, values.last())
            assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
            assertEquals(values.reversed(), (400 downTo 200).map { runIslandReadingAlpha(400f, it.toFloat(), left, right, 8f) })
        }
    }
    @Test fun `stable layout and opposite aligned units retain equal treatment`() {
        assertEquals(1f, runIslandReadingAlpha(400f, 400f, 0f, 400f, 8f))
        for (width in 0..400) assertEquals(
            runIslandReadingAlpha(400f, width.toFloat(), 28f, 192f, 8f),
            runIslandReadingAlpha(400f, width.toFloat(), 208f, 372f, 8f))
    }

    @Test fun `whole reading unit leaves before the moving bottom edge can crop it`() {
        val bottom = 172f
        val values = (100..220).map { visible ->
            val alpha = runIslandReadingVerticalAlpha(visible.toFloat(), bottom, 20f)
            if (visible <= bottom) assertEquals(0f, alpha)
            assertTrue(alpha in 0f..1f)
            alpha
        }
        assertEquals(0f, values.first())
        assertEquals(1f, values.last())
        assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
        assertEquals(values.reversed(), (220 downTo 100).map {
            runIslandReadingVerticalAlpha(it.toFloat(), bottom, 20f)
        })
    }
}
