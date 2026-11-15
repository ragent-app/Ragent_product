package com.andysagent.ragent.core.agentui

import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import com.andysagent.ragent.core.designsystem.MotionPreference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerPickerMorphTest {
    @Test fun emptyShellRetiresOnlyAfterTheMeasuredHeadingIsGone() {
        for (heading in listOf(36f, 56f, 89f, 128f)) {
            for (step in 0..150) {
                val height = heading * step / 100f
                val alpha = pickerEmptyShellAlpha(height, heading)
                assertTrue(alpha in 0f..1f)
                if (pickerItemRevealAlpha(height, heading) > 0f) assertEquals(1f, alpha, 0f)
                if (height <= heading * .3f) assertTrue(alpha < .26f)
            }
            val values = (0..100).map { pickerEmptyShellAlpha(heading * it / 100f, heading) }
            assertEquals(0f, values.first(), 0f)
            assertEquals(1f, values.last(), 0f)
            assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
            assertTrue(values.reversed().zipWithNext().all { (a, b) -> b <= a })
        }
    }

    @Test fun readingItemsWithdrawBeforeTheViewportCutsTheirContent() {
        for (height in listOf(16f, 36f, 48f, 64f)) {
            assertEquals(0f, pickerItemRevealAlpha(height * .9f, height), 0f)
            assertEquals(1f, pickerItemRevealAlpha(height, height), .00001f)
            val values = (0..100).map { pickerItemRevealAlpha(height * it / 100f, height) }
            assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
            assertTrue(values.any { it > 0f && it < 1f })
        }
    }
    @Test fun presenceHasNoFixedEmptyCapsuleHeightAtItsClosedEndpoint() {
        for (pageHeight in listOf(120f, 174f, 343f)) {
            assertEquals(0f, pageHeight * pickerGeometryProgress(0f), 0f)
            assertTrue(pageHeight * pickerGeometryProgress(.05f) < 18f)
        }
    }
    @Test fun actualPresenceHasReadableIntermediateHeightsAndContinuousReversalVelocity() {
        val opening = TargetBasedAnimation(pickerPresenceSpec(MotionPreference.Full), Float.VectorConverter, 0f, 1f)
        val positions = (0L..640L step 16L).map { opening.getValueFromNanos(it * 1_000_000) }
        assertTrue(positions.all { it in 0f..1f })
        assertTrue(positions.count { pickerForegroundProgress(it) > .5f && it < .95f } >= 8)
        for (ms in listOf(48L, 96L, 160L, 240L)) {
            val time = ms * 1_000_000
            val value = opening.getValueFromNanos(time)
            val velocity = opening.getVelocityVectorFromNanos(time).value
            val reverse = TargetBasedAnimation(pickerPresenceSpec(MotionPreference.Full), Float.VectorConverter, value, 0f, velocity)
            assertEquals(value, reverse.getValueFromNanos(0), .00001f)
            assertEquals(velocity, reverse.getVelocityVectorFromNanos(0).value, .00001f)
            assertTrue((0L..640L step 8L).all { reverse.getValueFromNanos(it * 1_000_000) in 0f..1f })
        }
    }
    @Test fun reducedAndNoneKeepTheirOwnBoundedPresenceDurations() {
        fun duration(preference: MotionPreference) =
            TargetBasedAnimation(pickerPresenceSpec(preference), Float.VectorConverter, 0f, 1f).durationNanos
        assertEquals(120_000_000L, duration(MotionPreference.Reduced))
        assertEquals(0L, duration(MotionPreference.None))
    }
    @Test fun foregroundDoesNotFadeWhileWidthIsSettledAndWholeReadingRowsCanFit() {
        for (step in 0..100) {
            val p = step / 100f
            assertEquals(pickerWidthProgress(p), pickerForegroundProgress(p), 0f)
            if (pickerWidthProgress(p) == 1f) assertEquals(1f, pickerForegroundProgress(p), 0f)
        }
        // A late model-panel exit can still fit its 56 dp header. The former
        // independent .22..55 fade reduced its contrast despite ample space.
        assertEquals(1f, pickerForegroundProgress(70f / 168f), 0f)
        assertEquals(1f, pickerItemRevealAlpha(70f, 56f), .00001f)
    }
    @Test fun foregroundAccompaniesGrowingHeightRatherThanWaitingForAnEmptyFullCard() {
        assertTrue(pickerForegroundProgress(.4f) > .5f)
        assertTrue(pickerGeometryProgress(.4f) < .5f)
        assertEquals(1f, pickerForegroundProgress(.55f), .00001f)
        for (step in 1..100) {
            val p = step / 100f
            if (pickerGeometryProgress(p) > .55f) assertEquals(1f, pickerForegroundProgress(p), .00001f)
            if (pickerForegroundProgress(p) == 0f) assertTrue(pickerGeometryProgress(p) <= .22f)
        }
    }
    @Test fun bothPhasesHaveIntermediateValuesAndReverseInTheSameOrder() {
        val phases = (0..100).map { it / 100f }
        val geometry = phases.map(::pickerGeometryProgress)
        val foreground = phases.map(::pickerForegroundProgress)
        assertTrue(geometry.count { it > 0f && it < 1f } > 20)
        assertTrue(foreground.count { it > 0f && it < 1f } > 20)
        for (values in listOf(geometry, foreground, phases.map(::pickerWidthProgress))) {
            assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
            assertTrue(values.reversed().zipWithNext().all { (a, b) -> b <= a })
            assertEquals(0f, values.first(), 0f)
            assertEquals(1f, values.last(), .00001f)
        }
    }
}
