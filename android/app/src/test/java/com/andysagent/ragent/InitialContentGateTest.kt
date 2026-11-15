package com.andysagent.ragent

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class InitialContentGateTest {
    @Test fun doesNotReleaseBeforeAnySnapshot() = assertFalse(InitialContentGate().ready)

    @Test fun eachLocalInputIsRequired() {
        listOf(Triple(false, true, true), Triple(true, false, true), Triple(true, true, false)).forEach {
            val gate = InitialContentGate()
            gate.update(it.first, it.second, it.third)
            assertFalse(gate.ready)
        }
    }

    @Test fun resolvedLocalInputsReleaseWithoutNetworkInput() {
        val gate = InitialContentGate()
        gate.update(true, true, true)
        assertTrue(gate.ready)
    }

    @Test fun laterRefreshCannotHideAnAlreadyVisiblePage() {
        val gate = InitialContentGate()
        gate.update(true, true, true)
        gate.update(false, false, false)
        assertTrue(gate.ready)
    }
}
