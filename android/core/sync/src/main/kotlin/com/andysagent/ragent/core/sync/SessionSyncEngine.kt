package com.andysagent.ragent.core.sync

import com.andysagent.ragent.core.model.SyncCursor
import com.andysagent.ragent.core.protocol.SessionEventDto
import com.andysagent.ragent.core.protocol.boundarySeq
import com.andysagent.ragent.core.protocol.dedupeKey
import com.andysagent.ragent.core.protocol.requestKey
import com.andysagent.ragent.core.protocol.sessionEventFingerprint
import com.andysagent.ragent.core.protocol.startingSeq
import com.andysagent.ragent.core.protocol.textContent
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

interface CursorStore {
    suspend fun load(scope: String): SyncCursor
    suspend fun save(cursor: SyncCursor)
}

interface EventSink {
    suspend fun validate(scope: String, event: SessionEventDto): EventValidation = EventValidation.New
    suspend fun apply(scope: String, event: SessionEventDto)
}

sealed interface EventValidation {
    data object New : EventValidation
    data object Duplicate : EventValidation
    data class Invalid(val reason: String) : EventValidation
}

interface AtomicEventSink : EventSink {
    suspend fun applyAtomically(scope: String, event: SessionEventDto, cursor: SyncCursor)
}

data class CursorMetadata(
    val serverCursor: String? = null,
    val snapshotVersion: Long? = null,
)

fun interface ReplayProvider {
    suspend fun replay(scope: String, afterSeq: Long, expectedSeq: Long): List<SessionEventDto>
}

sealed interface SyncResult {
    data class Applied(val cursor: SyncCursor, val count: Int) : SyncResult
    data class GapDetected(val scope: String, val expectedSeq: Long, val receivedSeq: Long) : SyncResult
    data class InvalidEvent(val scope: String, val event: SessionEventDto) : SyncResult
}

class SessionSyncEngine(
    private val scope: String,
    private val cursorStore: CursorStore,
    private val eventSink: EventSink,
    private val replayProvider: ReplayProvider? = null,
) {
    private var cursor: SyncCursor? = null
    private val pending = mutableListOf<SessionEventDto>()
    private val pendingKeys = linkedSetOf<String>()
    private val seenKeys = linkedSetOf<String>()
    private val identities = mutableMapOf<String, String>()

    suspend fun apply(incoming: List<SessionEventDto>, metadata: CursorMetadata = CursorMetadata()): SyncResult {
        ensureLoaded()
        var appliedCount = 0
        for (event in incoming) {
            val startSeq = event.startingSeq()
            val boundarySeq = event.boundarySeq()
            if (startSeq <= 0L || boundarySeq < startSeq) return SyncResult.InvalidEvent(scope, event)
            val key = event.dedupeKey() ?: "fingerprint:${eventFingerprint(event)}"
            val identity = event.sessionEventFingerprint()
            val previousIdentity = identities[key]
            if (previousIdentity != null && previousIdentity != identity) {
                return SyncResult.InvalidEvent(scope, event)
            }
            identities[key] = identity
            when (eventSink.validate(scope, event)) {
                is EventValidation.Invalid -> return SyncResult.InvalidEvent(scope, event)
                EventValidation.Duplicate -> {
                    continue
                }
                EventValidation.New -> Unit
            }
            if (seenKeys.contains(key) || pendingKeys.contains(key)) continue
            if (boundarySeq <= cursor!!.lastAppliedSeq) {
                rememberSeen(key)
                continue
            }
            pendingKeys += key
            pending += event
        }

        while (true) {
            val expected = cursor!!.lastAppliedSeq + 1
            pending.filter { it.boundarySeq() <= cursor!!.lastAppliedSeq }.forEach(::removePending)
            val next = pending
                .filter { it.startingSeq() <= expected && it.boundarySeq() > cursor!!.lastAppliedSeq }
                .minWithOrNull(compareBy<SessionEventDto> { it.boundarySeq() }.thenBy { it.startingSeq() })
            if (next == null) {
                val firstPending = pending.minByOrNull { it.startingSeq() }
                if (firstPending == null) break
                val replay = replayProvider?.replay(scope, cursor!!.lastAppliedSeq, expected).orEmpty()
                if (replay.isNotEmpty()) {
                    for (event in replay) {
                        val startSeq = event.startingSeq()
                        val boundarySeq = event.boundarySeq()
                        if (startSeq <= 0L || boundarySeq < startSeq || boundarySeq <= cursor!!.lastAppliedSeq) continue
                        val key = event.dedupeKey() ?: "fingerprint:${eventFingerprint(event)}"
                        val identity = event.sessionEventFingerprint()
                        val previousIdentity = identities[key]
                        if (previousIdentity != null && previousIdentity != identity) return SyncResult.InvalidEvent(scope, event)
                        identities[key] = identity
                        if (seenKeys.contains(key) || pendingKeys.contains(key)) continue
                        pendingKeys += key
                        pending += event
                    }
                    if (pending.any { it.startingSeq() <= expected && it.boundarySeq() > cursor!!.lastAppliedSeq }) continue
                }
                return SyncResult.GapDetected(scope, expected, pending.minByOrNull { it.startingSeq() }?.startingSeq() ?: firstPending.startingSeq())
            }
            removePending(next)
            val nextCursor = cursor!!.copy(
                lastAppliedSeq = next.boundarySeq(),
                lastEventId = next.dedupeKey() ?: cursor!!.lastEventId,
                lastServerCursor = metadata.serverCursor ?: cursor!!.lastServerCursor,
                lastSnapshotVersion = metadata.snapshotVersion ?: cursor!!.lastSnapshotVersion,
            )
            val atomicSink = eventSink as? AtomicEventSink
            if (atomicSink != null) {
                atomicSink.applyAtomically(scope, next, nextCursor)
            } else {
                eventSink.apply(scope, next)
                cursorStore.save(nextCursor)
            }
            cursor = nextCursor
            appliedCount += 1
        }

        cursor = cursor!!.copy(
            lastServerCursor = metadata.serverCursor ?: cursor!!.lastServerCursor,
            lastSnapshotVersion = metadata.snapshotVersion ?: cursor!!.lastSnapshotVersion,
        )
        // Atomic sinks persist event projections and the sequence cursor together.
        // The metadata-only path still needs a cursor write when a page has no events.
        cursorStore.save(cursor!!)
        return SyncResult.Applied(cursor!!, appliedCount)
    }

    private suspend fun ensureLoaded() {
        if (cursor == null) cursor = cursorStore.load(scope)
    }

    private fun removePending(event: SessionEventDto) {
        pending.remove(event)
        val key = event.dedupeKey() ?: "fingerprint:${eventFingerprint(event)}"
        pendingKeys.remove(key)
        rememberSeen(key)
    }

    private fun rememberSeen(key: String) {
        seenKeys += key
        while (seenKeys.size > 8192) seenKeys.remove(seenKeys.first())
    }

    private fun eventFingerprint(event: SessionEventDto): String = event.sessionEventFingerprint()
}

interface InvalidationConnection {
    fun connect()
    suspend fun close()
}

class ConnectionLifecycleCoordinator(
    private val connection: InvalidationConnection,
) {
    private val mutableState = MutableStateFlow(RuntimeConnectionState.Disconnected)
    val state: StateFlow<RuntimeConnectionState> = mutableState

    fun onForeground() {
        mutableState.value = RuntimeConnectionState.Connecting
        runCatching { connection.connect() }
            .onSuccess { mutableState.value = RuntimeConnectionState.Connected }
            .onFailure { mutableState.value = RuntimeConnectionState.Error }
    }

    suspend fun onBackground() {
        connection.close()
        mutableState.value = RuntimeConnectionState.Disconnected
    }

    fun onAuthenticationRequired() {
        mutableState.value = RuntimeConnectionState.AuthenticationRequired
    }
}

data class ReducedSessionState(
    val latestSeq: Long = 0,
    val status: String = "idle",
    val messages: Map<String, String> = emptyMap(),
    val approvals: Set<String> = emptySet(),
)

class SessionEventReducer(
    private val accumulator: StreamingAccumulator = StreamingAccumulator(),
) : EventSink {
    private val states = mutableMapOf<String, ReducedSessionState>()

    fun state(scope: String): ReducedSessionState = states[scope] ?: ReducedSessionState()

    override suspend fun apply(scope: String, event: SessionEventDto) {
        val before = state(scope)
        val type = event.type.orEmpty().lowercase()
        val requestId = event.requestKey()
        val delta = event.textContent()
        val messages = before.messages.toMutableMap()
        val approvals = before.approvals.toMutableSet()
        var status = before.status
        when {
            type.contains("approval_request") || type.contains("confirmation_request")
                || type.contains("privileged_batch_request") || type.contains("approved_action_batch_request") -> {
                val approvalKey = event.batchId ?: event.approvalId ?: requestId
                approvals += approvalKey
                status = "waiting_approval"
            }
            type.contains("approval_response") || type.contains("confirmation_response") || type.contains("decision")
                || type.contains("privileged_batch_response") || type.contains("approved_action_batch_response") -> {
                val approvalKey = event.batchId ?: event.approvalId ?: requestId
                approvals -= approvalKey
                status = if (approvals.isEmpty()) "working" else "waiting_approval"
            }
            type == "message" || type.contains("delta") || type.contains("stream") || type == "reasoning" || type == "thinking_block" -> {
                if (delta != null) messages[requestId] = accumulator.append(requestId, delta).text
                status = if (type == "thinking_block" && event.state == "completed") before.status else "working"
            }
            type == "tool_use" || type == "tool_call" || type == "file_change" -> {
                status = "working"
            }
            type == "tool_result" -> {
                status = if (event.exitCode != null && event.exitCode != 0) "failed" else "working"
            }
            type.contains("completed") || type.contains("done") || type.contains("finished") -> {
                if (delta != null) messages[requestId] = accumulator.complete(requestId, delta).text
                else if (messages.containsKey(requestId)) accumulator.complete(requestId)
                status = "completed"
            }
            type.contains("failed") || type.contains("error") -> status = "failed"
            type.contains("cancel") -> status = "cancelled"
            type.contains("started") || type.contains("running") -> status = "working"
        }
        states[scope] = before.copy(
            latestSeq = maxOf(before.latestSeq, event.boundarySeq()),
            status = status,
            messages = messages,
            approvals = approvals,
        )
    }
}
