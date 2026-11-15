package com.andysagent.ragent.core.agentui

import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals

class ComposerGeometryTest {
    @Test fun nonlinearScalingStillGetsAnAdaptiveSilhouette() {
        for ((scale, height) in listOf(1f to 48, 1.3f to 52, 1.5f to 56, 1.6f to 56, 2f to 64)) {
            assertEquals(height.dp, composerTypeMinimum(48.dp, 16.dp, scale))
        }
        assertEquals(48.dp, composerTypeMinimum(38.dp, 10.dp, 2f))
    }
    private fun compact(lineHeight: Float) = composerControlHeight(lineHeight.dp, 20.dp, 48.dp)
    @Test fun ordinaryTextKeepsTheOriginalHeight() = assertEquals(48.dp, compact(22f))
    @Test fun onePointThreeGainsSpace() = assertEquals(52.dp, compact(28.6f))
    @Test fun onePointFiveGainsSpace() = assertEquals(56.dp, compact(33f))
    @Test fun onePointSixUsesTheSameGridStep() = assertEquals(56.dp, compact(35.2f))
    @Test fun doubleTypeHasTwentyDpOfSpace() = assertEquals(64.dp, compact(44f))
    @Test fun LargerTypeIsNotCappedIntoClipping() = assertEquals(88.dp, compact(66f))
    @Test fun ordinaryModelKeepsItsOriginalChipAndRail() {
        val chip = composerControlHeight(18.dp, 12.dp, 38.dp)
        assertEquals(38.dp, chip)
        assertEquals(48.dp, composerControlHeight(chip, 10.dp, 48.dp))
    }
    @Test fun doubleTypeModelAndRailHaveIndependentBreathingSpace() {
        val chip = composerControlHeight(36.dp, 12.dp, 38.dp)
        assertEquals(48.dp, chip)
        assertEquals(60.dp, composerControlHeight(chip, 10.dp, 48.dp))
    }
}
