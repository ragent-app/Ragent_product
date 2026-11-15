package com.andysagent.ragent.core.agentui

import kotlin.test.Test
import kotlin.test.assertEquals

class EffortStopsTest {
    @Test fun stopsRoundTripWithoutChangingRuntimeLevels() {
        (0..3).forEach { assertEquals(it, effortStopIndex(effortValueAtStop(it))) }
    }

    @Test fun existingThresholdsRemainCompatible() {
        assertEquals(0, effortStopIndex(0.25f))
        assertEquals(1, effortStopIndex(0.5f))
        assertEquals(1, effortStopIndex(0.55f))
        assertEquals(2, effortStopIndex(0.85f))
        assertEquals(3, effortStopIndex(1f))
        assertEquals(0f, effortValueAtStop(-1))
        assertEquals(1f, effortValueAtStop(4))
    }
}
