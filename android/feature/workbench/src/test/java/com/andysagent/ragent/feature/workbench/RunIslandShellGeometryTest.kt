package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunIslandShellGeometryTest {
    @Test fun `closing and reversal retain endpoint height despite viewport remeasurement`() {
        val body = RunIslandBodyHeight()
        assertEquals(320, body.resolve(320, 1f, expanded = true))
        (100 downTo 1).forEach {
            assertEquals(320, body.resolve(512, it / 100f, expanded = false))
        }
        (1..99).forEach {
            assertEquals(320, body.resolve(512, it / 100f, expanded = true))
        }
        assertEquals(120, body.resolve(120, 0f, expanded = false))
        assertEquals(120, body.resolve(512, .4f, expanded = true))
        assertEquals(240, body.resolve(240, 1f, expanded = true))
        assertEquals(180, body.resolve(180, 1f, expanded = true))
    }

    @Test fun `both axes move together without a late title contraction or scaled foreground`() {
        (0..1000).forEach {
            val p = it / 1000f
            val geometry = runIslandShellGeometry(p)
            val remaining = 1f - p
            val remainingCubed = remaining * remaining * remaining
            assertEquals(1f - remainingCubed * (.15f + .85f * remainingCubed), geometry.shellProgress)
            assertEquals(p * p, geometry.bodyProgress)
            assertEquals(p * (2f - p), geometry.bodyAlpha)
            if (p > 0f && p < 1f) {
                assertTrue(geometry.shellProgress in 0f..1f)
                assertTrue(geometry.shellProgress >= geometry.bodyProgress)
                assertTrue(geometry.bodyProgress > 0f && geometry.bodyAlpha > 0f)
            }
        }
    }

    @Test fun `width keeps reading room while height withdraws without a gated phase`() {
        val widths = (0..100).map { runIslandShellGeometry(it / 100f).shellProgress }
        assertTrue(widths.zipWithNext().all { (a, b) -> b > a })
        val middle = runIslandShellGeometry(.5f)
        assertEquals(.96796876f, middle.shellProgress)
        assertEquals(.25f, middle.bodyProgress)
        assertEquals(.75f, middle.bodyAlpha)
        assertTrue(middle.shellProgress > .9f && middle.bodyProgress < .4f && middle.bodyAlpha >= .7f,
            "Mid-close must keep reading width while removing the empty tail")
    }

    @Test fun `side controls consume only measured free space and reverse with the shell`() {
        assertEquals(1f, runIslandSideControlsSpace(400, 180, 48))
        assertEquals(.5f, runIslandSideControlsSpace(400, 352, 48))
        assertEquals(0f, runIslandSideControlsSpace(400, 400, 48))
        val widths = (180..400).toList()
        val scales = widths.map { runIslandSideControlsSpace(400, it, 48) }
        assertEquals(scales.reversed(), widths.reversed().map { runIslandSideControlsSpace(400, it, 48) })
        widths.zip(scales).forEach { (width, scale) -> assertTrue(48f * scale <= (400 - width) / 2f) }
        assertEquals(0f, runIslandSideControlsSpace(320, 500, 48))
    }

    @Test fun `space and foreground are continuous and reversible on the same timeline`() {
        val opening = (0..100).map { runIslandShellGeometry(it / 100f) }
        assertEquals(RunIslandShellGeometry(0f, 0f, 0f), opening.first())
        assertEquals(RunIslandShellGeometry(1f, 1f, 1f), opening.last())
        assertEquals(opening.reversed(), (100 downTo 0).map { runIslandShellGeometry(it / 100f) })
        assertTrue(opening.zipWithNext().all { (a, b) ->
            b.shellProgress >= a.shellProgress && b.bodyAlpha >= a.bodyAlpha && b.bodyProgress >= a.bodyProgress
        })
        assertTrue(opening.count { it.shellProgress > 0f && it.shellProgress < 1f } > 20)
        assertTrue(opening.count { it.bodyProgress > 0f && it.bodyProgress < 1f } > 50)
        assertTrue(opening.count { it.bodyAlpha > 0f && it.bodyAlpha < 1f } > 5)
    }

    @Test fun `overshoot is bounded without a second content identity`() {
        assertEquals(RunIslandShellGeometry(0f, 0f, 0f), runIslandShellGeometry(-1f))
        assertEquals(RunIslandShellGeometry(1f, 1f, 1f), runIslandShellGeometry(2f))
    }
}
