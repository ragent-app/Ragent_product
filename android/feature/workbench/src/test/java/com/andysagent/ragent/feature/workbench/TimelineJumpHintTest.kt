package com.andysagent.ragent.feature.workbench

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TimelineJumpHintTest {
    @Test fun restoredHistoryAndProgrammaticScrollingNeverShowTheHint() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.reply(TimelineReplySignal("history", 100), true)
        hint.viewport(TailDistance.Far, true, false)
        hint.viewport(TailDistance.Far, false, false)
        assertFalse(hint.visible)
    }

    @Test fun waitsForFlingThenExpiresWhileStillAwayFromBottom() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, true, false)
        advanceTimeBy(3_000)
        assertFalse(hint.visible)
        hint.viewport(TailDistance.Far, false, false)
        runCurrent()
        assertTrue(hint.visible)
        advanceTimeBy(1_619)
        assertTrue(hint.visible)
        advanceTimeBy(1)
        runCurrent()
        assertFalse(hint.visible)
        hint.viewport(TailDistance.Far, false, false)
        assertFalse(hint.visible)
    }

    @Test fun secondGestureCancelsTheOldExpiryAndGetsItsOwnWindow() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, false, false)
        runCurrent()
        advanceTimeBy(1_000)
        hint.userScrolled()
        assertFalse(hint.visible)
        assertTrue(hint.fastExit)
        hint.viewport(TailDistance.Far, true, false)
        advanceTimeBy(500)
        hint.viewport(TailDistance.Far, false, false)
        runCurrent()
        advanceTimeBy(200) // The first window would have expired here.
        assertTrue(hint.visible)
        advanceTimeBy(1_420)
        runCurrent()
        assertFalse(hint.visible)
    }

    @Test fun thresholdHysteresisDoesNotFlickerAndNearBottomAlwaysHides() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Near, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Between, false, false)
        assertFalse(hint.visible)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, true, false)
        hint.viewport(TailDistance.Between, false, false)
        assertTrue(hint.visible)
        hint.viewport(TailDistance.Near, false, false)
        assertFalse(hint.visible)
        hint.viewport(TailDistance.Between, false, false)
        assertFalse(hint.visible)
    }

    @Test fun panelOrImeCancelsPendingGestureAndDoesNotResurrectOnClose() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, true, true)
        hint.viewport(TailDistance.Far, false, false)
        assertFalse(hint.visible)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, false, false)
        assertTrue(hint.visible)
        hint.viewport(TailDistance.Far, false, true)
        hint.viewport(TailDistance.Far, false, false)
        assertFalse(hint.visible)
    }

    @Test fun streamingChunksAndFinalAliasCannotExtendOrReopenTheWindow() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.reply(TimelineReplySignal("old", 100), true)
        hint.viewport(TailDistance.Far, false, false)
        hint.reply(TimelineReplySignal("new-turn", 101), false)
        runCurrent()
        repeat(8) {
            advanceTimeBy(200)
            hint.reply(TimelineReplySignal("new-turn", 102L + it), false)
            assertTrue(hint.visible)
        }
        advanceTimeBy(20)
        runCurrent()
        assertFalse(hint.visible)
        hint.reply(TimelineReplySignal("new-turn", 200), false)
        assertFalse(hint.visible)
    }

    @Test fun prependedHistoryAndBlockedRepliesDoNotBecomeLateNotifications() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.reply(TimelineReplySignal("history", 100), true)
        hint.viewport(TailDistance.Far, false, false)
        hint.reply(TimelineReplySignal("older-page", 40), false)
        assertFalse(hint.visible)
        hint.viewport(TailDistance.Far, false, true)
        hint.reply(TimelineReplySignal("new-turn", 101), false)
        hint.viewport(TailDistance.Far, false, false)
        hint.reply(TimelineReplySignal("new-turn", 102), false)
        assertFalse(hint.visible)
    }

    @Test fun incomingReplyCannotExtendAnAlreadyVisibleScrollHint() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.reply(TimelineReplySignal("old", 1), true)
        hint.viewport(TailDistance.Far, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, false, false)
        runCurrent()
        advanceTimeBy(1_500)
        hint.reply(TimelineReplySignal("new", 2), false)
        advanceTimeBy(120)
        runCurrent()
        assertFalse(hint.visible)
    }

    @Test fun dismissAndSessionDisposalCancelExpiryAndPendingInput() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.userScrolled()
        hint.viewport(TailDistance.Far, false, false)
        hint.dismiss()
        hint.viewport(TailDistance.Far, false, false)
        assertFalse(hint.visible)
        hint.userScrolled()
        hint.dispose()
        advanceTimeBy(5_000)
        val nextSession = TimelineJumpHint(backgroundScope)
        nextSession.viewport(TailDistance.Far, false, false)
        assertFalse(nextSession.visible)
    }

    @Test fun userCanInterruptReturnAndGetANewHintAfterStopping() = runTest {
        val hint = TimelineJumpHint(backgroundScope)
        hint.viewport(TailDistance.Far, false, false)
        hint.startReturn()
        hint.viewport(TailDistance.Far, true, false)
        assertFalse(hint.visible)
        hint.userScrolled()
        hint.endReturn()
        hint.viewport(TailDistance.Far, false, false)
        assertTrue(hint.visible)
    }
}
