package com.andysagent.ragent.feature.workbench

import org.junit.Assert.*
import org.junit.Test

class TimelineTailVisibilityTest {
    @Test fun measuredScrollClearsOnlyTheCoveredTail() {
        assertEquals(300f, timelineTailScrollDistance(500, 600, 1000, 200), 0f)
        assertEquals(0f, timelineTailScrollDistance(100, 200, 1000, 200), 0f)
    }

    @Test fun measuredScrollDoesNotOverflowToTheStart() {
        assertTrue(timelineTailScrollDistance(Int.MAX_VALUE - 100, 200, 1000, 200) > 0f)
    }

    @Test fun emptyTimelineHasNoUnreadTail() {
        assertTrue(isTimelineTailVisible(-1, null, null, 1000, 200))
    }

    @Test fun penultimateItemIsNotTheTailEvenIfItsBottomFits() {
        assertFalse(isTimelineTailVisible(11, 10, 500, 1000, 200))
    }

    @Test fun tailBehindComposerIsNotReadable() {
        assertFalse(isTimelineTailVisible(11, 11, 900, 1000, 200))
    }

    @Test fun partialTallFinalReplyKeepsTheJumpAvailable() {
        assertFalse(isTimelineTailVisible(11, 11, 2400, 1000, 200))
    }

    @Test fun tailClearingTheDockCountsEvenWhenItsStartIsAboveTheViewport() {
        assertTrue(isTimelineTailVisible(11, 11, 800, 1000, 200))
        assertTrue(isTimelineTailVisible(11, 11, 801, 1000, 200))
        assertFalse(isTimelineTailVisible(11, 11, 802, 1000, 200))
    }

    @Test fun growingInputDockReopensTheUnreadTail() {
        assertTrue(isTimelineTailVisible(11, 11, 800, 1000, 180))
        assertFalse(isTimelineTailVisible(11, 11, 800, 1000, 400))
    }

    @Test fun artificialRunwayDoesNotStandInForContent() {
        assertFalse(isTimelineTailVisible(11, 12, 500, 1000, 200))
        assertFalse(isTimelineTailVisible(11, null, null, 1000, 200))
    }
}
