package com.andysagent.ragent.feature.organization.layout

import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.EdgeType
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.domain.OrganizationEdgeModel
import com.andysagent.ragent.feature.organization.domain.OrganizationNodeModel
import kotlin.math.hypot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class OrganizationLayoutEngineTest {

    private val engine = OrganizationLayoutEngine()

    @Test
    fun testRootNodePlacedAtTopCenter() {
        val root = OrganizationNodeModel(
            id = "root",
            displayName = "Executive",
            role = NodeRole.EXECUTIVE,
        )
        val result = engine.computeLayout(
            nodes = mapOf("root" to root),
            edges = emptyList(),
            viewportWidth = 1000f,
            viewportHeight = 1500f,
        )

        val pos = result.nodePositions["root"]
        assertNotNull(pos)
        assertEquals(500f, pos.x)
        assertTrue(pos.y > 0f && pos.y < 500f)
    }

    @Test
    fun testNoOverlappingNodesIn3NodeOrganization() {
        val root = OrganizationNodeModel(id = "root", displayName = "Executive", role = NodeRole.EXECUTIVE)
        val lead1 = OrganizationNodeModel(id = "lead1", parentId = "root", displayName = "Backend", role = NodeRole.MANAGER)
        val lead2 = OrganizationNodeModel(id = "lead2", parentId = "root", displayName = "Android", role = NodeRole.MANAGER)

        val edges = listOf(
            OrganizationEdgeModel("e1", "root", "lead1"),
            OrganizationEdgeModel("e2", "root", "lead2"),
        )

        val result = engine.computeLayout(
            nodes = mapOf("root" to root, "lead1" to lead1, "lead2" to lead2),
            edges = edges,
            viewportWidth = 1000f,
            viewportHeight = 1500f,
        )

        val positions = result.nodePositions.values.toList()
        for (i in positions.indices) {
            for (j in i + 1 until positions.size) {
                val p1 = positions[i]
                val p2 = positions[j]
                val dist = hypot(p1.x - p2.x, p1.y - p2.y)
                val minSafeDist = (p1.radius + p2.radius) * 1.5f
                assertTrue(dist >= minSafeDist, "Nodes ${p1.id} and ${p2.id} overlap: distance is $dist")
            }
        }
    }

    @Test
    fun testAutomaticClusteringWhenChildrenExceedThreshold() {
        val root = OrganizationNodeModel(id = "root", displayName = "Executive", role = NodeRole.EXECUTIVE)
        val manager = OrganizationNodeModel(id = "mgr", parentId = "root", displayName = "Lead", role = NodeRole.MANAGER)

        val workers = (1..7).map { i ->
            OrganizationNodeModel(id = "w$i", parentId = "mgr", displayName = "Worker $i", role = NodeRole.WORKER)
        }

        val allNodes = (listOf(root, manager) + workers).associateBy { it.id }
        val edges = listOf(OrganizationEdgeModel("e_mgr", "root", "mgr")) +
                workers.map { OrganizationEdgeModel("e_${it.id}", "mgr", it.id) }

        val result = engine.computeLayout(
            nodes = allNodes,
            edges = edges,
            viewportWidth = 1000f,
            viewportHeight = 1500f,
        )

        // The 7 workers should be folded into a cluster node
        val clusterNode = result.nodePositions["cluster_mgr"]
        assertNotNull(clusterNode, "Expected cluster_mgr to exist")
        assertTrue(clusterNode.isCluster)
        assertEquals(7, clusterNode.clusterCount)
    }

    @Test
    fun testStablePlacementStrategyPreservesExistingPositions() {
        val root = OrganizationNodeModel(id = "root", displayName = "Executive", role = NodeRole.EXECUTIVE)
        val lead1 = OrganizationNodeModel(id = "lead1", parentId = "root", displayName = "Backend", role = NodeRole.MANAGER)

        val initialResult = engine.computeLayout(
            nodes = mapOf("root" to root, "lead1" to lead1),
            edges = listOf(OrganizationEdgeModel("e1", "root", "lead1")),
            viewportWidth = 1000f,
            viewportHeight = 1500f,
        )

        val savedPositions = initialResult.nodePositions.mapValues { EdgePoint(it.value.x, it.value.y) }

        // Now add a new lead in Revision N+1
        val lead2 = OrganizationNodeModel(id = "lead2", parentId = "root", displayName = "Android", role = NodeRole.MANAGER)
        val newResult = engine.computeLayout(
            nodes = mapOf("root" to root, "lead1" to lead1, "lead2" to lead2),
            edges = listOf(
                OrganizationEdgeModel("e1", "root", "lead1"),
                OrganizationEdgeModel("e2", "root", "lead2"),
            ),
            viewportWidth = 1000f,
            viewportHeight = 1500f,
            previousPositions = savedPositions,
        )

        // Existing nodes should remain at their exact previous positions!
        val rootPos = newResult.nodePositions["root"]
        val lead1Pos = newResult.nodePositions["lead1"]
        assertNotNull(rootPos)
        assertNotNull(lead1Pos)
        assertEquals(savedPositions["root"]!!.x, rootPos.x, 0.01f)
        assertEquals(savedPositions["root"]!!.y, rootPos.y, 0.01f)
        assertEquals(savedPositions["lead1"]!!.x, lead1Pos.x, 0.01f)
        assertEquals(savedPositions["lead1"]!!.y, lead1Pos.y, 0.01f)
    }
}
