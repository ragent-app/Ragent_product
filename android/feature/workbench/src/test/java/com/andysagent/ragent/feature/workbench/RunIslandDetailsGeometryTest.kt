package com.andysagent.ragent.feature.workbench

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunIslandDetailsGeometryTest {
    @Test fun `height has one source through expansion and collapse`() {
        val heights = (0..20).map { runIslandDetailsGeometry(60, 280, it / 20f).height }
        assertEquals(60, heights.first())
        assertEquals(340, heights.last())
        assertTrue(heights.zipWithNext().all { (before, after) -> after >= before })
        assertEquals(heights.reversed(), (20 downTo 0).map { runIslandDetailsGeometry(60, 280, it / 20f).height })
        assertEquals(200, runIslandDetailsGeometry(60, 280, .5f).height)
    }

    @Test fun `summary stays above details without an empty handoff window`() {
        (0..100).forEach {
            val progress = it / 100f
            val geometry = runIslandDetailsGeometry(60, 280, progress, gap = 12)
            assertTrue(geometry.detailsTop >= 60)
            assertEquals(geometry.height, geometry.detailsTop + geometry.detailsViewportHeight)
            if (progress > 0f) assertTrue(geometry.detailsAlpha > 0f)
            if (progress == 0f) assertEquals(0f, geometry.detailsAlpha)
            if (progress >= .16f) assertEquals(1f, geometry.detailsAlpha)
            if (progress > 0f) assertTrue(geometry.detailsViewportHeight > 0)
        }
        assertEquals(60, runIslandDetailsGeometry(60, 280, 0f, gap = 12).height)
        assertEquals(352, runIslandDetailsGeometry(60, 280, 1f, gap = 12).height)
    }

    @Test fun `reverse and short details keep the task context without a new size spring`() {
        assertEquals(190, runIslandDetailsGeometry(180, 20, .5f).height)
        assertEquals(listOf(185, 190, 195, 190, 185),
            listOf(.25f, .5f, .75f, .5f, .25f).map { runIslandDetailsGeometry(180, 20, it).height })
        assertEquals(180, runIslandDetailsGeometry(180, 20, -1f).height)
        assertEquals(200, runIslandDetailsGeometry(180, 20, 2f).height)
    }
}
