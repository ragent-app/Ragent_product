package com.andysagent.ragent.feature.organization.domain

import com.andysagent.ragent.feature.organization.data.OrganizationBlockerDto
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationPhaseDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class OrganizationReducerTest {

    @Test
    fun testSnapshotBuildsCorrectGraph() {
        val dto = OrganizationProjectionDto(
            organizationId = "org_1",
            objective = "Build Ragent Windows Runtime",
            state = "active",
            nodes = listOf(
                OrganizationNodeDto(id = "root", role = "executive", displayName = "Root Leader", status = "idle"),
                OrganizationNodeDto(id = "backend", parentId = "root", role = "manager", displayName = "Backend Lead", status = "working"),
                OrganizationNodeDto(id = "runtime", parentId = "backend", role = "worker", displayName = "Runtime Worker", status = "working"),
            ),
            edges = listOf(
                OrganizationEdgeDto(id = "e1", parentId = "root", childId = "backend", type = "MANAGES"),
                OrganizationEdgeDto(id = "e2", parentId = "backend", childId = "runtime", type = "MANAGES"),
            ),
        )

        val state = OrganizationReducer.reduceProjection(OrganizationState(), dto)

        assertEquals("org_1", state.organizationId)
        assertEquals(3, state.nodes.size)
        assertEquals(2, state.edges.size)
        assertEquals(NodeRole.EXECUTIVE, state.nodes["root"]?.role)
        assertEquals(NodeRole.MANAGER, state.nodes["backend"]?.role)
        assertEquals(NodeRole.WORKER, state.nodes["runtime"]?.role)
        assertEquals(NodeRuntimeState.WORKING, state.nodes["backend"]?.runtimeState)
    }

    @Test
    fun testBlockerRendersBlockedState() {
        val dto = OrganizationProjectionDto(
            organizationId = "org_2",
            nodes = listOf(
                OrganizationNodeDto(id = "worker1", role = "worker", displayName = "Worker 1", status = "working"),
            ),
            blockers = listOf(
                OrganizationBlockerDto(id = "b1", nodeId = "worker1", reasonCode = "missing_dependency"),
            ),
        )

        val state = OrganizationReducer.reduceProjection(OrganizationState(), dto)
        val worker = state.nodes["worker1"]
        assertNotNull(worker)
        assertEquals(NodeRuntimeState.BLOCKED, worker.runtimeState)
        assertEquals("missing_dependency", worker.blockerText)
    }

    @Test
    fun testReviewerRendersReviewingState() {
        val dto = OrganizationProjectionDto(
            organizationId = "org_3",
            nodes = listOf(
                OrganizationNodeDto(id = "rev1", role = "reviewer", displayName = "Security Reviewer", status = "reviewing"),
            ),
        )

        val state = OrganizationReducer.reduceProjection(OrganizationState(), dto)
        val reviewer = state.nodes["rev1"]
        assertNotNull(reviewer)
        assertEquals(NodeRole.REVIEWER, reviewer.role)
        assertEquals(NodeRuntimeState.REVIEWING, reviewer.runtimeState)
    }

    @Test
    fun testCompletedPhasesMarksOrganizationCompleted() {
        val dto = OrganizationProjectionDto(
            organizationId = "org_4",
            state = "completed",
            phases = listOf(
                OrganizationPhaseDto(phaseId = "p1", objective = "Phase 1", state = "completed"),
            ),
        )

        val state = OrganizationReducer.reduceProjection(OrganizationState(), dto)
        assertTrue(state.isCompleted)
    }
}
