package com.andysagent.ragent.feature.organization.animation

import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.layout.EdgePoint
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CommunicationVisualSchedulerTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    @Test
    fun testThrottlingToMaxThreeActiveParticles() {
        val scheduler = CommunicationVisualScheduler(testScope, maxActiveParticles = 3)
        val positions = mapOf(
            "n1" to EdgePoint(100f, 100f),
            "n2" to EdgePoint(200f, 200f),
            "n3" to EdgePoint(300f, 300f),
            "n4" to EdgePoint(400f, 400f),
            "n5" to EdgePoint(500f, 500f),
        )

        // Schedule 5 communications
        scheduler.scheduleCommunication("c1", CommunicationType.TASK_ASSIGNED, "n1", "n2")
        scheduler.scheduleCommunication("c2", CommunicationType.RESULT_AVAILABLE, "n2", "n1")
        scheduler.scheduleCommunication("c3", CommunicationType.REVIEW_REQUESTED, "n1", "n3")
        scheduler.scheduleCommunication("c4", CommunicationType.BLOCKER_ESCALATED, "n4", "n1")
        scheduler.scheduleCommunication("c5", CommunicationType.TASK_ASSIGNED, "n1", "n5")

        // First tick
        scheduler.updateTick(positions)

        // At most 3 particles should be active simultaneously
        val active = scheduler.activeParticles.value
        assertEquals(3, active.size)

        // Blocker escalated has priority 1, so c4 MUST be among the active particles!
        val c4 = active.firstOrNull { it.id == "c4" }
        assertTrue(c4 != null, "High priority blocker should be dispatched immediately")
    }
}
