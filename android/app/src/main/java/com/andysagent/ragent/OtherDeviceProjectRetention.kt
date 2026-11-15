package com.andysagent.ragent

import com.andysagent.ragent.core.model.OtherDeviceProject

/** Null means a transient failure; an empty list is an authoritative empty result. */
internal fun mergeOtherDeviceProjects(
    previous: List<OtherDeviceProject>,
    results: Map<String, List<OtherDeviceProject>?>,
    allowedTargets: Set<String>,
): List<OtherDeviceProject> {
    val oldByTarget = previous.groupBy { it.targetId }
    return allowedTargets.flatMap { id ->
        val rows = if (results.containsKey(id)) results[id] ?: oldByTarget[id].orEmpty() else oldByTarget[id].orEmpty()
        rows.filter { it.targetId == id }
    }.sortedWith(
        compareByDescending<OtherDeviceProject> { it.targetLastSeenAt }
            .thenByDescending { it.updatedAt }
            .thenBy { it.targetLabel.lowercase() }
            .thenBy { it.projectName.lowercase() },
    )
}
