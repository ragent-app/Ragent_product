package com.andysagent.ragent.feature.workbench

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectSearchDisclosureTest {
    @Test fun lineIsInvisibleUntilItFitsWithClearance() {
        assertEquals(0f, searchDisclosureAlpha(0f, 48f, 24f), 0f)
        assertEquals(0f, searchDisclosureAlpha(27f, 48f, 24f), 0f)
        assertEquals(0f, searchDisclosureAlpha(28f, 48f, 24f), 0f)
    }
    @Test fun completeLineFadesContinuouslyAsShellFinishes() {
        assertEquals(.5f, searchDisclosureAlpha(38f, 48f, 24f), .001f)
        assertEquals(1f, searchDisclosureAlpha(48f, 48f, 24f), 0f)
    }
    @Test fun largerMeasuredLineMovesVisibilityThresholdInsteadOfClipping() {
        assertEquals(0f, searchDisclosureAlpha(48f, 72f, 24f), 0f)
        assertTrue(searchDisclosureAlpha(60f, 72f, 24f) > 0f)
        assertEquals(1f, searchDisclosureAlpha(72f, 72f, 24f), 0f)
    }
}
