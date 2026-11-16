package com.andysagent.ragent.feature.organization.data

import java.time.Instant

/** A cue is scoped to its durable source and can be consumed only once. */
data class BirthCue(val sourceId: String, val eventId: String, val nodeId: String, val actorNodeId: String)

data class NativeBirthEvent(val runId: String, val event: DelegationEventDto)

private data class Candidate(val cue: BirthCue, val timestamp: Long)

/**
 * Consumes complete logical graphs, not visible or clustered render subsets.
 * `continuous` is false on the first observation, reconnection, scope change,
 * incomplete paging or any source gap. In those cases this resets the baseline.
 * Callers must pass only new, fully paged events for the current session.
 */
class BirthEventTracker {
    private var scope: String? = null
    private var baseline = false
    private val knownNodes = mutableSetOf<String>()
    private val seenEvents = mutableSetOf<Pair<String, String>>()
    private val pending = linkedMapOf<Pair<String, String>, Candidate>()

    fun reset() {
        scope = null
        baseline = false
        knownNodes.clear()
        seenEvents.clear()
        pending.clear()
    }

    fun observe(
        scopeId: String,
        sessionId: String,
        continuous: Boolean,
        graphParents: Map<String, String?>,
        organizationId: String?,
        organizationEvents: List<OrganizationActionDto>,
        nativeEvents: List<NativeBirthEvent>,
        nativeRecords: List<NativeDelegationDto>,
    ): List<BirthCue> {
        if (scope != scopeId || !continuous || !baseline) {
            reset()
            scope = scopeId
            baseline = true
            knownNodes.addAll(graphParents.keys)
            return emptyList()
        }
        val nativeById = nativeRecords.filter { it.parentSessionId == sessionId }
            .associateBy { it.runId to it.delegationId }
        val candidates = mutableListOf<Candidate>()
        if (organizationId != null) for (event in organizationEvents) {
            val actor = event.actorNodeId ?: continue
            val node = event.nodeId ?: continue
            if (event.type != "node.created") continue
            candidates += Candidate(BirthCue("organization:$organizationId", event.id.toString(), node, actor),
                runCatching { Instant.parse(event.createdAt).toEpochMilli() }.getOrDefault(0L))
        }
        for ((runId, event) in nativeEvents) {
            if (event.kind != "spawned" || event.runId != runId || event.parentSessionId != sessionId) continue
            val parent = event.parentDelegationId ?: continue
            val childRecord = nativeById[runId to event.delegationId] ?: continue
            if (childRecord.parentDelegationId != parent || nativeById[runId to parent] == null) continue
            fun nodeId(id: String) = "native:${runId.length}:$runId$id"
            candidates += Candidate(BirthCue("native:$runId", event.id, nodeId(event.delegationId), nodeId(parent)), event.timestamp)
        }
        for (candidate in candidates.sortedBy { it.timestamp }) {
            val cue = candidate.cue
            val key = cue.sourceId to cue.eventId
            if (!seenEvents.add(key) || cue.nodeId in knownNodes || cue.actorNodeId !in knownNodes) continue
            pending[key] = candidate
        }
        val result = mutableListOf<BirthCue>()
        val iterator = pending.iterator()
        while (iterator.hasNext()) {
            val cue = iterator.next().value.cue
            if (cue.nodeId !in graphParents) continue
            if (cue.nodeId !in knownNodes && isAncestor(cue.actorNodeId, cue.nodeId, graphParents)) result += cue
            iterator.remove()
        }
        knownNodes.addAll(graphParents.keys)
        return result
    }

    private fun isAncestor(actor: String, child: String, parents: Map<String, String?>): Boolean {
        val visited = mutableSetOf(child)
        var parent = parents[child]
        while (parent != null && visited.add(parent)) {
            if (parent == actor) return true
            parent = parents[parent]
        }
        return false
    }
}
