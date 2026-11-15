package com.andysagent.ragent.core.navigation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AgentoNavigationMotionTest {
    @Test fun secondaryActionKeepsSlotTrajectoryWithoutShrinkingVisibleGlyphs() {
        kotlin.test.assertEquals(NavigationActionFrame(0f, 0f, 0f), navigationActionFrame(0f))
        kotlin.test.assertEquals(NavigationActionFrame(48f, 4f, 1f), navigationActionFrame(1f))
        listOf(0f, .15f, .4f, .55f, .7f, .85f, 1f).forEach { p ->
            val frame = navigationActionFrame(p)
            kotlin.test.assertEquals(28f * p, frame.start + frame.diameter / 2f, .00001f)
            assertTrue(frame.start + frame.diameter <= 56f)
            assertTrue(frame.glyphAlpha in 0f..1f)
            if (frame.glyphAlpha > 0f) assertTrue(frame.diameter > 26f)
        }
        kotlin.test.assertEquals(navigationActionFrame(0f), navigationActionFrame(-1f))
        kotlin.test.assertEquals(navigationActionFrame(1f), navigationActionFrame(2f))
    }
    @Test fun requestedTargetDoesNotFreezeTheStillEnteringPageOrReplayAnExitingClock() {
        val home = NavigationDockTarget(AgentoDestination.Home, false)
        val chat = NavigationDockTarget(AgentoDestination.Sessions, true)
        val settings = NavigationDockTarget(AgentoDestination.Settings, false)
        val motion = NavigationDockMotion(home)
        val phase = androidx.compose.runtime.mutableStateOf(0f)
        var entering = true
        val clock = NavigationPeerClock("chat-visit", AgentoDestination.Sessions, phase,
            entering = { entering }, settled = { false })
        motion.follow(chat, clock)
        phase.value = .3f
        motion.presented(motion.frame(chat))
        phase.value = .4f
        val stillEntering = motion.frame(settings)
        kotlin.test.assertEquals(.6f, stillEntering.lensSlot, .00001f)
        motion.presented(stillEntering)
        entering = false
        phase.value = .1f
        // Both a newer request and a stale composition must preserve the last
        // geometry instead of running the old entry path backwards.
        kotlin.test.assertEquals(stillEntering, motion.frame(settings))
        kotlin.test.assertEquals(stillEntering, motion.frame(chat))
        entering = true
        clock.disposed = true
        kotlin.test.assertEquals(stillEntering, motion.frame(chat))
    }

    @Test fun readingBoundaryUsesCurrentMeasuredDockExtentWithoutChangingPageHeight() {
        kotlin.test.assertEquals(700f, primaryReadableBottom(800f, 100))
        kotlin.test.assertEquals(800f, primaryReadableBottom(800f, 0))
        kotlin.test.assertEquals(0f, primaryReadableBottom(800f, 900))
        kotlin.test.assertEquals(800f, primaryReadableBottom(800f, -10))
        kotlin.test.assertEquals(0f, primaryReadableBottom(0f, 100))
    }
    @Test fun reusedPeerClockNormalizesFromItsLastPresentedPhase() {
        kotlin.test.assertEquals(0f, navigationPeerFraction(.4f, .4f))
        kotlin.test.assertEquals(.5f, navigationPeerFraction(.7f, .4f), .00001f)
        kotlin.test.assertEquals(1f, navigationPeerFraction(1f, .4f))
        kotlin.test.assertEquals(0f, navigationPeerFraction(.3f, .4f))
        kotlin.test.assertEquals(1f, navigationPeerFraction(1f, 1f))
    }
    @Test fun dockGeometryAndForegroundShareOneBoundedPhase() {
        val start = NavigationDockTarget(AgentoDestination.Sessions, true).endpoint()
        val end = NavigationDockTarget(AgentoDestination.Settings, false).endpoint()
        listOf(0f, .1f, .35f, .7f, 1f).forEach { p ->
            val frame = start.towards(end, p)
            kotlin.test.assertEquals(p, frame.lensSlot / 2f, .00001f)
            kotlin.test.assertEquals(p, 1f - frame.actionPresence, .00001f)
            kotlin.test.assertEquals(p, frame.emphasis[2], .00001f)
            kotlin.test.assertEquals(1f - p, frame.emphasis[0], .00001f)
            kotlin.test.assertEquals(1f + (end.widthFraction - 1f) * p, frame.widthFraction, .00001f)
        }
        kotlin.test.assertEquals(end, start.towards(end, 1.05f))
        kotlin.test.assertEquals(start, start.towards(end, -.05f))
    }

    @Test fun retargetInterpolationStartsAtActualIntermediateGeometry() {
        val start = NavigationDockTarget(AgentoDestination.Sessions, true).endpoint()
        val settings = NavigationDockTarget(AgentoDestination.Settings, false).endpoint()
        val mid = start.towards(settings, .4f)
        val home = NavigationDockTarget(AgentoDestination.Home, false).endpoint()
        kotlin.test.assertEquals(mid, mid.towards(home, 0f))
        kotlin.test.assertEquals(home, mid.towards(home, 1f))
        assertTrue(mid.towards(start, .1f).lensSlot < mid.lensSlot)
        assertTrue(mid.towards(start, .1f).actionPresence > mid.actionPresence)
    }

    @Test fun projectGlyphFollowsSpatialProgressRatherThanOpenFlag() {
        kotlin.test.assertEquals(1f, projectDockGlyphAlpha(0f, false))
        kotlin.test.assertEquals(0f, projectDockGlyphAlpha(0f, true))
        kotlin.test.assertEquals(1f, projectDockGlyphAlpha(1f, true))
        kotlin.test.assertEquals(0f, projectDockGlyphAlpha(1f, false))
        assertTrue(projectDockGlyphAlpha(.2f, false) > 0f)
        kotlin.test.assertEquals(0f, projectDockGlyphAlpha(.2f, true))
        assertTrue(projectDockGlyphAlpha(.8f, true) > 0f)
        kotlin.test.assertEquals(0f, projectDockGlyphAlpha(.8f, false))
        assertTrue(projectDockGlyphAlpha(.5f, true) + projectDockGlyphAlpha(.5f, false) < .2f)
    }
    @Test
    fun initialFrameUsesSelectedDestinationWhenNavHostHasNoRoute() {
        assertTrue(
            visibleNavigationDestination(
                currentRoute = null,
                selected = AgentoDestination.Home,
            ) == AgentoDestination.Home,
        )
    }

    @Test
    fun installedNavRouteOverridesInitialSelectionFallback() {
        assertTrue(
            visibleNavigationDestination(
                currentRoute = AgentoDestination.Sessions.route,
                selected = AgentoDestination.Home,
            ) == AgentoDestination.Sessions,
        )
    }

    @Test
    fun movingBetweenPrimaryDestinationsUsesPeerMotion() {
        assertTrue(
            primaryNavigationUsesPeerTransition(
                initial = AgentoDestination.Sessions,
                target = AgentoDestination.Settings,
            ),
        )
    }

    @Test
    fun peerMotionRequestedForBackwardMovesToo() {
        assertTrue(
            primaryNavigationUsesPeerTransition(
                initial = AgentoDestination.Settings,
                target = AgentoDestination.Sessions,
            ),
        )
    }

    @Test
    fun unchangedDestinationDoesNotRequestPeerTransition() {
        assertFalse(
            primaryNavigationUsesPeerTransition(
                AgentoDestination.Home,
                AgentoDestination.Home,
            ),
        )
    }

    @Test
    fun peerPushFollowsDockOrderForward() {
        assertTrue(
            primaryPeerIsForward(
                AgentoDestination.Sessions,
                AgentoDestination.Home,
            ),
        )
        assertTrue(
            primaryPeerIsForward(
                AgentoDestination.Home,
                AgentoDestination.Settings,
            ),
        )
    }

    @Test
    fun peerPushMirrorsDockOrderBackward() {
        assertFalse(
            primaryPeerIsForward(
                AgentoDestination.Settings,
                AgentoDestination.Home,
            ),
        )
        assertFalse(
            primaryPeerIsForward(
                AgentoDestination.Home,
                AgentoDestination.Sessions,
            ),
        )
    }
}
