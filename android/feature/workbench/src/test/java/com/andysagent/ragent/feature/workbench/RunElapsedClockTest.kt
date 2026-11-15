package com.andysagent.ragent.feature.workbench

import org.junit.Assert.assertEquals
import org.junit.Test

class RunElapsedClockTest {
    @Test fun disconnectAndStaleSnapshotNeverResetElapsedTime() {
        var anchor = updateRunElapsedAnchor(Long.MAX_VALUE, 12_000, 100_000)
        assertEquals(12, runElapsedSeconds(anchor, 100_000, -1))
        assertEquals(17, runElapsedSeconds(anchor, 105_000, 12))
        anchor = updateRunElapsedAnchor(anchor, null, 105_000)
        anchor = updateRunElapsedAnchor(anchor, 2_000, 105_000)
        assertEquals(17, runElapsedSeconds(anchor, 105_000, 17))
        anchor = updateRunElapsedAnchor(anchor, 20_000, 106_000)
        assertEquals(20, runElapsedSeconds(anchor, 106_000, 17))
    }

    @Test fun missingServerTimingDoesNotInventZero() {
        assertEquals(-1, runElapsedSeconds(updateRunElapsedAnchor(Long.MAX_VALUE, null, 10_000), 10_000, -1))
    }
}
