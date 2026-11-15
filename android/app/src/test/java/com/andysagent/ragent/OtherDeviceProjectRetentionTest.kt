package com.andysagent.ragent

import com.andysagent.ragent.core.model.OtherDeviceProject
import org.junit.Assert.assertEquals
import org.junit.Test

class OtherDeviceProjectRetentionTest {
    private fun row(target: String, project: String, updated: Long = 0) = OtherDeviceProject(
        targetId = target, targetLabel = target, projectId = project, projectName = project, updatedAt = updated,
    )

    @Test fun transientFailureRetainsOnlyThatTargetsPreviousResults() {
        val previous = listOf(row("a", "old-a"), row("b", "old-b"), row("removed", "old-removed"))
        val results = mapOf("a" to listOf(row("a", "new-a")), "b" to null)
        val merged = mergeOtherDeviceProjects(previous, results, setOf("a", "b"))
        assertEquals(setOf("new-a", "old-b"), merged.map { it.projectId }.toSet())
    }

    @Test fun authoritativeEmptyResultAndRemovedTargetClearOldRows() {
        val previous = listOf(row("a", "old-a"), row("b", "old-b"))
        assertEquals(emptyList<OtherDeviceProject>(), mergeOtherDeviceProjects(previous, mapOf("a" to emptyList()), setOf("a")))
    }

    @Test fun resultsCannotIntroduceRowsForAnotherTarget() {
        val merged = mergeOtherDeviceProjects(emptyList(), mapOf("a" to listOf(row("b", "wrong"), row("a", "right"))), setOf("a"))
        assertEquals(listOf("right"), merged.map { it.projectId })
    }
}
