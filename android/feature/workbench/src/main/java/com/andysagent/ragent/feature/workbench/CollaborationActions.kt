package com.andysagent.ragent.feature.workbench

import androidx.compose.runtime.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.feature.organization.data.DelegationEventDto
import com.andysagent.ragent.feature.organization.data.NativeDelegationDto
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.time.Instant

/** Event IDs are namespaced by their owning organization or native run. */
data class CollaborationActionPresentation(
    val id: String, val timestamp: Long, val kind: String,
    val displayName: String? = null, val summary: String? = null, val details: String? = null,
    val status: String? = null, val nodeId: String? = null, val native: Boolean = false,
)

data class NativeDelegationRecord(val runId: String, val event: DelegationEventDto)
internal data class CollaborationData(
    val actions: List<CollaborationActionPresentation>, val events: List<NativeDelegationRecord>,
    val nodes: List<NativeDelegationDto>, val nativeResolved: Boolean, val nativeDefinitive: Boolean,
    val nativeReceiptElapsed: Long,
)
private class NativePollState {
    val cursors = mutableMapOf<String, Long>()
    val finished = mutableMapOf<String, String>()
    val scannedAt = mutableMapOf<String, Long>()
}

@Composable
internal fun rememberCollaborationActions(
    transport: RagentTransport?, sessionId: String?, targetId: String?, ownerScope: String?, active: Boolean,
): CollaborationData {
    var actions by remember(transport, sessionId, targetId, ownerScope) { mutableStateOf(emptyList<CollaborationActionPresentation>()) }
    var nativeEvents by remember(transport, sessionId, targetId, ownerScope) { mutableStateOf(emptyList<NativeDelegationRecord>()) }
    var nativeNodes by remember(transport, sessionId, targetId, ownerScope) { mutableStateOf(emptyList<NativeDelegationDto>()) }
    var nativeResolved by remember(transport, sessionId, targetId, ownerScope) { mutableStateOf(transport == null || sessionId == null) }
    var nativeDefinitive by remember(transport, sessionId, targetId, ownerScope) { mutableStateOf(false) }
    var nativeReceiptElapsed by remember(transport, sessionId, targetId, ownerScope) { mutableLongStateOf(0L) }
    val nativePoll = remember(transport, sessionId, targetId, ownerScope) { NativePollState() }
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val connection = transport?.connectionState?.collectAsState()?.value
    LaunchedEffect(transport, sessionId, targetId, ownerScope, active, lifecycle, connection) {
        if (connection == RuntimeConnectionState.AuthenticationRequired) { actions = emptyList(); return@LaunchedEffect }
        if (transport == null || sessionId == null || !active || lifecycle != Lifecycle.State.RESUMED || connection != RuntimeConnectionState.Connected) return@LaunchedEffect
        val api = RealOrganizationApi(transport)
        var cursor = 0L
        var organizationId: String? = null
        while (true) {
            val response = api.getSessionActions(sessionId, cursor)
            val failure = response.exceptionOrNull()
            if (failure is CancellationException) throw failure
            if (failure != null) {
                if (failure is ApiException && failure.statusCode in listOf(401, 403)) {
                    actions = emptyList(); cursor = 0; organizationId = null
                }
                delay(3_000); continue
            }
            val page = response.getOrNull()
            if (page == null) { actions = emptyList(); cursor = 0; organizationId = null }
            else {
                if (organizationId != null && organizationId != page.organizationId) {
                    actions = emptyList(); cursor = 0; organizationId = page.organizationId; continue
                }
                organizationId = page.organizationId
                val incoming = page.actions.mapNotNull { action ->
                    val timestamp = runCatching { Instant.parse(action.createdAt).toEpochMilli() }.getOrNull() ?: return@mapNotNull null
                    CollaborationActionPresentation("collaboration:org:${page.organizationId}:${action.id}", timestamp, action.type,
                        action.displayName, action.summary, action.details, action.status, action.nodeId)
                }
                actions = (actions + incoming).distinctBy { it.id }.sortedBy { it.timestamp }
                val advanced = page.nextAfterId > cursor
                cursor = maxOf(cursor, page.nextAfterId)
                if (page.hasMore && advanced) continue
            }
            delay(3_000)
        }
    }
    LaunchedEffect(transport, sessionId, targetId, ownerScope, active, lifecycle, connection) {
        if (connection == RuntimeConnectionState.AuthenticationRequired) { nativeEvents = emptyList(); nativeNodes = emptyList(); nativePoll.cursors.clear(); nativePoll.finished.clear(); nativePoll.scannedAt.clear(); nativeResolved = true; nativeDefinitive = false; return@LaunchedEffect }
        if (transport == null || sessionId == null || !active || lifecycle != Lifecycle.State.RESUMED || connection != RuntimeConnectionState.Connected) {
            nativeResolved = true
            nativeDefinitive = false
            return@LaunchedEffect
        }
        nativeResolved = false
        nativeDefinitive = false
        val api = RealOrganizationApi(transport)
        val cursors = nativePoll.cursors
        while (true) {
            val runs = api.getDelegationRuns(sessionId)
            val failure = runs.exceptionOrNull()
            if (failure is CancellationException) throw failure
            if (failure != null) { nativeResolved = true; nativeDefinitive = false; nativeReceiptElapsed = 0L }
            if (failure is ApiException && failure.statusCode in listOf(401, 403)) {
                nativeEvents = emptyList(); nativeNodes = emptyList(); cursors.clear(); nativePoll.finished.clear()
                delay(3_000); continue
            }
            var authorizationDenied = false
            var incomplete = false
            var nextNodes = nativeNodes
            var nextEvents = nativeEvents
            val nextCursors = cursors.toMutableMap()
            val nextFinished = nativePoll.finished.toMutableMap()
            val nextScannedAt = nativePoll.scannedAt.toMutableMap()
            runs.getOrNull()?.runs?.forEach { run ->
                if (authorizationDenied) return@forEach
                val version = "${run.state}:${run.updatedAt.orEmpty()}"
                if (nativePoll.finished[run.id] == version && (run.updatedAt != null ||
                    android.os.SystemClock.elapsedRealtime() - (nativePoll.scannedAt[run.id] ?: 0L) < 60_000L)) return@forEach
                var more = true
                var reachedTail = false
                while (more) {
                    val cursor = nextCursors[run.id] ?: 0L
                    val response = api.getDelegationEvents(sessionId, run.id, cursor)
                    val error = response.exceptionOrNull()
                    if (error is CancellationException) throw error
                    if (error is ApiException && error.statusCode in listOf(401, 403)) {
                        nativeEvents = emptyList(); nativeNodes = emptyList(); cursors.clear(); nativePoll.finished.clear()
                        authorizationDenied = true
                        break
                    }
                    val page = response.getOrNull()
                    if (page == null) { incomplete = true; break }
                    if (page.gap || page.sourceAvailability != "verified") incomplete = true
                    if (!page.gap) nextNodes = nextNodes.filterNot { it.runId == run.id } + page.delegations
                    nextEvents = (nextEvents + page.events.map { NativeDelegationRecord(run.id, it) })
                        .distinctBy { it.runId to it.event.id }
                    nextCursors[run.id] = maxOf(cursor, page.nextAfterLines)
                    more = page.hasMore && page.nextAfterLines > cursor
                    if (page.hasMore && !more) incomplete = true
                    reachedTail = !page.hasMore && !page.gap
                }
                if (reachedTail && run.state.lowercase() in setOf("completed", "failed", "cancelled", "interrupted")) {
                    nextFinished[run.id] = version
                    nextScannedAt[run.id] = android.os.SystemClock.elapsedRealtime()
                } else nextFinished.remove(run.id)
            }
            if (runs.isSuccess) {
                nativeResolved = true
                nativeDefinitive = !authorizationDenied && !incomplete
                nativeReceiptElapsed = if (nativeDefinitive) android.os.SystemClock.elapsedRealtime() else 0L
                if (!authorizationDenied) {
                    nativeNodes = nextNodes
                    nativeEvents = nextEvents
                }
                if (nativeDefinitive) {
                    cursors.clear(); cursors.putAll(nextCursors)
                    nativePoll.finished.clear(); nativePoll.finished.putAll(nextFinished)
                    nativePoll.scannedAt.clear(); nativePoll.scannedAt.putAll(nextScannedAt)
                }
            }
            delay(3_000)
        }
    }
    return CollaborationData(actions, nativeEvents, nativeNodes, nativeResolved, nativeDefinitive, nativeReceiptElapsed)
}

internal fun mergeCollaborationActions(items: List<TimelineItem>, actions: List<CollaborationActionPresentation>, labels: Map<String, String>): List<TimelineItem> {
    if (actions.isEmpty()) return items
    val merged = items.toMutableList()
    actions.sortedBy { it.timestamp }.forEach { action ->
        val label = labels[action.kind] ?: return@forEach
        val index = merged.indexOfFirst { it is TimelineItem.Message && (it.timestamp?.let { timestamp -> timestamp > action.timestamp } == true) }
            .let { if (it < 0) merged.size else it }
        val seq = merged.getOrNull(index - 1)?.seq ?: merged.getOrNull(index)?.seq ?: 0L
        merged.add(index, TimelineItem.Notice(id = action.id, seq = seq, text = label))
    }
    return merged
}
