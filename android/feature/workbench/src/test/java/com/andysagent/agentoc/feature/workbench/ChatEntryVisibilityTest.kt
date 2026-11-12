package com.andysagent.agentoc.feature.workbench

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatEntryVisibilityTest {
    @Test fun localFirstTurnIsImmediatelyVisible() {
        assertTrue(isInitialLocalTimeline("new-session", null, 0, true))
        assertTrue(isInitialLocalTimeline("new-session", "new-session", 0, true))
    }

    @Test fun existingHistoryAndEmptyDraftStillUseNormalEntry() {
        assertFalse(isInitialLocalTimeline(null, null, 0, true))
        assertFalse(isInitialLocalTimeline("session", "other-session", 0, true))
        assertFalse(isInitialLocalTimeline("session", null, 1, true))
        assertFalse(isInitialLocalTimeline("session", null, 0, false))
    }
}
