package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import com.andysagent.ragent.core.designsystem.MotionPreference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunIslandMotionTest {
    private fun animation(from: Float, to: Float, velocity: Float = 0f,
        preference: MotionPreference = MotionPreference.Full) = TargetBasedAnimation(
        runIslandMotionSpec(preference), Float.VectorConverter, from, to, velocity,
    )

    @Test fun `resting endpoints approach continuously without overshoot`() {
        for ((from, to) in listOf(0f to 1f, 1f to 0f)) {
            val motion = animation(from, to)
            val values = (0L..640L step 16L).map { motion.getValueFromNanos(it * 1_000_000) }
            assertTrue(values.all { it in 0f..1f })
            assertTrue(values.count { it > .01f && it < .99f } >= 12)
            assertEquals(from, values.first())
            assertEquals(to, values.last())
        }
    }

    @Test fun `reversal starts from actual position and velocity not a fresh ease in`() {
        val opening = animation(0f, 1f)
        for (ms in listOf(48L, 96L, 160L, 240L)) {
            val time = ms * 1_000_000
            val value = opening.getValueFromNanos(time)
            val velocity = opening.getVelocityVectorFromNanos(time).value
            val reversed = animation(value, 0f, velocity)
            assertEquals(value, reversed.getValueFromNanos(0))
            assertEquals(velocity, reversed.getVelocityVectorFromNanos(0).value, .0001f)
            val values = (0L..640L step 8L).map { reversed.getValueFromNanos(it * 1_000_000) }
            assertTrue(values.all { it in 0f..1f })
            assertTrue(values.zipWithNext().all { (a, b) -> kotlin.math.abs(b - a) < .10f })
            assertEquals(0f, values.last())
        }
    }

    @Test fun `reduced and none retain their own bounded durations`() {
        assertEquals(160_000_000L, animation(0f, 1f, preference = MotionPreference.Reduced).durationNanos)
        assertEquals(0L, animation(0f, 1f, preference = MotionPreference.None).durationNanos)
    }
}
