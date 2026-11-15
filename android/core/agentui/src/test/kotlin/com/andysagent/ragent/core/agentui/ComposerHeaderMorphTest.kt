package com.andysagent.ragent.core.agentui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerHeaderMorphTest {
    @Test fun textRequiresTheFullMeasuredViewportAndForegroundsNeverOverlap() {
        for (step in 0..1000) {
            val p = step / 1000f
            val inline = composerInlineHeaderOpacity(p)
            val full = composerFullscreenHeaderOpacity(p)
            assertTrue("Two control foregrounds at $p", inline == 0f || full == 0f)
            if (full > 0f) assertEquals(1f, composerHeaderGeometryProgress(p), 0f)
        }
    }

    @Test fun progressIsReversibleWithContinuousIntermediateGeometryAndOpacity() {
        val phases = (0..1000).map { it / 1000f }
        for (values in listOf(phases.map(::composerHeaderGeometryProgress), phases.map(::composerFullscreenHeaderOpacity))) {
            assertEquals(0f, values.first(), 0f)
            assertEquals(1f, values.last(), 0f)
            assertTrue(values.count { it > 0f && it < 1f } > 200)
            assertTrue(values.zipWithNext().all { (a, b) -> b >= a && b - a < .004f })
            assertTrue(values.reversed().zipWithNext().all { (a, b) -> b <= a })
        }
        assertEquals(1f, composerInlineHeaderOpacity(0f), 0f)
        assertEquals(0f, composerInlineHeaderOpacity(1f), 0f)
    }
}
