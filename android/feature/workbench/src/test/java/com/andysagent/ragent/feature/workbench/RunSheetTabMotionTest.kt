package com.andysagent.ragent.feature.workbench

import org.junit.Assert.*
import org.junit.Test

class RunSheetTabMotionTest {
    @Test fun retargetPublishesFreshClockWithoutResettingPreviousSegment() {
        val previous = RunSheetTabSegment()
        val drawn = runSheetTabFrame(RunSheetTabFrame(height = 90), RunSheetTab.Trace, 320, .41f)
        val next = RunSheetTabSegment(drawn, RunSheetTab.Files, 0f)
        assertEquals(1f, previous.progress.value, 0f)
        assertEquals(0f, next.progress.value, 0f)
        assertEquals(drawn, runSheetTabFrame(next.source, next.target, 32, next.progress.value))
        assertNotSame(previous.progress, next.progress)
    }

    @Test fun exactlyOneReadablePageOwnsEveryFrameWithoutAnEmptyGlassPhase() {
        RunSheetTab.entries.forEach { from -> RunSheetTab.entries.filter { it != from }.forEach { to ->
            val source = RunSheetTabFrame(80, from.ordinal.toFloat(), RunSheetTab.entries.map { if (it == from) 1f else 0f })
            for (targetHeight in listOf(32, 320)) for (step in 0..100) {
                val p = step / 100f
                val frame = runSheetTabFrame(source, to, targetHeight, p)
                val visible = frame.opacity.withIndex().filter { it.value > 0f }
                assertEquals("More than one page owns frame p=$p", 1, visible.size)
                assertTrue("Readable content dipped too far at p=$p: ${visible.single().value}",
                    visible.single().value >= 0.72f)
                if (targetHeight > source.height && frame.opacity[to.ordinal] > 0f) {
                    assertEquals("Growing shell exposed destination before it fit", targetHeight, frame.height)
                }
                if (targetHeight < source.height && frame.opacity[to.ordinal] > 0f) {
                    assertTrue("Shrinking shell clipped its smaller destination", frame.height >= targetHeight)
                }
                assertTrue(frame.opacity.all { it in 0f..1f })
            }
        } }
    }

    @Test fun everyInterruptedFrameCanBeReversedWithoutAnEndpointJump() {
        val source = RunSheetTabFrame(height = 90)
        for (step in 1..99) {
            val interrupted = runSheetTabFrame(source, RunSheetTab.Trace, 320, step / 100f)
            val reversal = runSheetTabFrame(interrupted, RunSheetTab.Metrics, 90, 0f)
            assertEquals(interrupted, reversal)
            val endpoint = runSheetTabFrame(interrupted, RunSheetTab.Metrics, 90, 1f)
            assertEquals(source, endpoint)
        }
    }

    @Test fun thirdTabRetargetAlsoRetainsTheRenderedGeometryAndOpacity() {
        val source = RunSheetTabFrame(height = 90)
        val interrupted = runSheetTabFrame(source, RunSheetTab.Trace, 320, 0.41f)
        assertEquals(interrupted, runSheetTabFrame(interrupted, RunSheetTab.Files, 32, 0f))
        val final = runSheetTabFrame(interrupted, RunSheetTab.Files, 32, 1f)
        assertEquals(32, final.height)
        assertEquals(1f, final.selection, 0f)
        assertEquals(listOf(0f, 1f, 0f), final.opacity)
    }
}
