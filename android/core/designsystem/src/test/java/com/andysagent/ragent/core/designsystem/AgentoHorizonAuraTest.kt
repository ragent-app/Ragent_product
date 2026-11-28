package com.andysagent.ragent.core.designsystem

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AgentoHorizonAuraTest {
    @Test fun idleSustainsVisibleGentleUndulationNeverFreezing() {
        val active = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Idle,
            phaseElapsedMs = 300L,
            nowMs = 1000L,
            isDark = true,
        )
        assertFalse(active.shouldSleep)
        assertTrue(active.targetFrameMs > 0L)

        val peakWave = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Idle,
            phaseElapsedMs = 1300L,
            nowMs = 1000L,
            isDark = true,
        )
        val troughWave = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Idle,
            phaseElapsedMs = 3500L,
            nowMs = 3200L,
            isDark = true,
        )
        assertFalse(peakWave.shouldSleep)
        assertEquals(22L, peakWave.targetFrameMs)
        assertTrue(peakWave.speed in 0.70f..1.10f)
        assertTrue(peakWave.intensity in 0.18f..0.40f)
        assertTrue(troughWave.intensity in 0.18f..0.40f)
        assertTrue(kotlin.math.abs(peakWave.intensity - troughWave.intensity) > 0.10f)
        assertTrue(kotlin.math.abs(peakWave.reach - troughWave.reach) > 0.04f)
    }

    @Test fun startAndRunningRemainLivelierThanIdleUndulation() {
        val start = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Start,
            phaseElapsedMs = 450L,
            nowMs = 1450L,
            isDark = false,
        )
        assertFalse(start.shouldSleep)
        assertTrue(start.surge > 0f)
        assertTrue(start.speed > 1.5f)
        assertEquals(16L, start.targetFrameMs)

        val running = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Running,
            phaseElapsedMs = 3000L,
            nowMs = 4000L,
            isDark = true,
        )
        val idle = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Idle,
            phaseElapsedMs = 3000L,
            nowMs = 4000L,
            isDark = true,
        )
        assertFalse(running.shouldSleep)
        assertEquals(33L, running.targetFrameMs)
        assertTrue(running.speed > idle.speed)
        assertEquals(AgentoAuraSemanticTone.Brand, running.semanticTone)
    }

    @Test fun waitingApprovalCompletedAndPostFlashErrorAllKeepUndulating() {
        val approvalLive = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.WaitingApproval,
            phaseElapsedMs = 400L,
            nowMs = 400L,
            isDark = true,
        )
        assertFalse(approvalLive.shouldSleep)
        assertEquals(AgentoAuraSemanticTone.Waiting, approvalLive.semanticTone)

        val approvalHold = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.WaitingApproval,
            phaseElapsedMs = 1800L,
            nowMs = 1800L,
            isDark = true,
        )
        assertFalse(approvalHold.shouldSleep)
        assertEquals(22L, approvalHold.targetFrameMs)
        assertTrue(approvalHold.speed in 0.55f..0.95f)
        assertTrue(approvalHold.intensity > 0f)
        assertEquals(AgentoAuraSemanticTone.Waiting, approvalHold.semanticTone)

        val completedRipple = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Completed,
            phaseElapsedMs = 300L,
            nowMs = 300L,
            isDark = true,
        )
        assertFalse(completedRipple.shouldSleep)
        assertTrue(completedRipple.surge < 0f)
        assertEquals(AgentoAuraSemanticTone.Success, completedRipple.semanticTone)

        val completedDrift = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Completed,
            phaseElapsedMs = 1500L,
            nowMs = 1500L,
            isDark = true,
        )
        assertFalse(completedDrift.shouldSleep)
        assertEquals(22L, completedDrift.targetFrameMs)
        assertTrue(completedDrift.speed in 0.70f..1.10f)
        assertEquals(0f, completedDrift.surge)
        assertEquals(AgentoAuraSemanticTone.Brand, completedDrift.semanticTone)

        val errorFlash = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Error,
            phaseElapsedMs = 200L,
            nowMs = 200L,
            isDark = true,
        )
        assertFalse(errorFlash.shouldSleep)
        assertEquals(AgentoAuraSemanticTone.Error, errorFlash.semanticTone)

        val errorRecovered = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Error,
            phaseElapsedMs = 1000L,
            nowMs = 1000L,
            isDark = true,
        )
        assertFalse(errorRecovered.shouldSleep)
        assertEquals(22L, errorRecovered.targetFrameMs)
        assertTrue(errorRecovered.intensity > 0f)
        assertEquals(AgentoAuraSemanticTone.Brand, errorRecovered.semanticTone)
    }

    @Test fun voicePhasesScaleWithClampedVoiceLevel() {
        val quiet = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Listening,
            phaseElapsedMs = 200L,
            nowMs = 200L,
            isDark = true,
            voiceLevel = -0.5f,
        )
        val loud = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Listening,
            phaseElapsedMs = 200L,
            nowMs = 200L,
            isDark = true,
            voiceLevel = 2.0f,
        )
        assertTrue(loud.intensity > quiet.intensity)
        assertTrue(loud.reach > quiet.reach)
        assertTrue(loud.intensity <= 1f)
        assertEquals(AgentoAuraSemanticTone.Voice, loud.semanticTone)

        val speaking = computeAgentoAuraOptics(
            phase = AgentoAuraPhase.Speaking,
            phaseElapsedMs = 200L,
            nowMs = 200L,
            isDark = false,
            voiceLevel = 0.6f,
        )
        assertTrue(speaking.surge < 0f)
        assertFalse(speaking.shouldSleep)
    }
}
