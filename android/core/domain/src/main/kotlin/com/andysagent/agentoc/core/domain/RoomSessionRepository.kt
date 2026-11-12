package com.andysagent.agentoc.core.domain

import com.andysagent.agentoc.core.model.RuntimeConnectionState

import com.andysagent.agentoc.core.database.TimelineMessageStagingEntity
import com.andysagent.agentoc.core.sync.ProjectedMessage
import com.andysagent.agentoc.core.sync.isTimelineMessage
import com.andysagent.agentoc.core.sync.messageProjectionId
import com.andysagent.agentoc.core.sync.reduceMessage
import com.andysagent.agentoc.core.sync.terminalRunState

import android.content.ContentResolver
import android.net.Uri
import java.security.MessageDigest
import com.andysagent.agentoc.core.database.AgentoCDao
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.database.ApprovalEntity
import com.andysagent.agentoc.core.database.ComputerEntity
import com.andysagent.agentoc.core.database.MessageEntity
import com.andysagent.agentoc.core.database.PendingOperationEntity
import com.andysagent.agentoc.core.database.ProjectEntity
import com.andysagent.agentoc.core.database.SessionEntity
import com.andysagent.agentoc.core.database.SyncCursorEntity
import com.andysagent.agentoc.core.database.TargetRuntimeSummaryCursorEntity
import com.andysagent.agentoc.core.database.TargetRuntimeSummaryEntity
import com.andysagent.agentoc.core.database.TargetRuntimeSummaryEventEntity
import com.andysagent.agentoc.core.model.Attachment
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.core.model.ApprovalExplanation
import com.andysagent.agentoc.core.model.ApprovalActionDecision
import com.andysagent.agentoc.core.model.ApprovalAuthorization
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.Message
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.Computer
import com.andysagent.agentoc.core.model.Project
import com.andysagent.agentoc.core.model.Session
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.model.SyncCursor
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.model.RuntimeCatalogMetadata
import com.andysagent.agentoc.core.model.RuntimeCatalogStatus
import com.andysagent.agentoc.core.model.RuntimeModelOption
import com.andysagent.agentoc.core.model.RuntimeProviderOption
import com.andysagent.agentoc.core.model.RuntimeToolOption
import com.andysagent.agentoc.core.model.QueuedMessage
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiRequestBodySource
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import com.andysagent.agentoc.core.protocol.ApprovalAuthorizationDto
import com.andysagent.agentoc.core.protocol.ApprovalResolutionRequestDto
import com.andysagent.agentoc.core.protocol.ApprovedActionDto
import com.andysagent.agentoc.core.protocol.AttachmentItemDto
import com.andysagent.agentoc.core.protocol.ConfirmationDecisionRequestDto
import com.andysagent.agentoc.core.protocol.ApplyTemplateRequestDto
import com.andysagent.agentoc.core.protocol.CreateSessionRequestDto
import com.andysagent.agentoc.core.protocol.CreateSessionResponseDto
import com.andysagent.agentoc.core.protocol.CreateProjectRequestDto
import com.andysagent.agentoc.core.protocol.ListTrustedDevicesResponse
import com.andysagent.agentoc.core.protocol.ProjectListResponseDto
import com.andysagent.agentoc.core.protocol.ProtocolCodec
import com.andysagent.agentoc.core.protocol.RuntimeApprovalDecisionRequestDto
import com.andysagent.agentoc.core.protocol.QueueMutationRequestDto
import com.andysagent.agentoc.core.protocol.QueueMutationResponseDto
import com.andysagent.agentoc.core.protocol.QueuedFollowUpDto
import com.andysagent.agentoc.core.protocol.allAttachments
import com.andysagent.agentoc.core.protocol.allOptions
import com.andysagent.agentoc.core.protocol.ForkAtRequestDto
import com.andysagent.agentoc.core.protocol.RegenerateMessageRequestDto
import com.andysagent.agentoc.core.protocol.ResendEditedMessageRequestDto
import com.andysagent.agentoc.core.protocol.SendMessageRequestDto
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.protocol.SessionEventsPageDto
import com.andysagent.agentoc.core.protocol.SessionListResponseDto
import com.andysagent.agentoc.core.protocol.TargetSummary
import com.andysagent.agentoc.core.protocol.TargetSummaryActivity
import com.andysagent.agentoc.core.protocol.TargetSummaryApprovalCounts
import com.andysagent.agentoc.core.protocol.TargetSummaryEvent
import com.andysagent.agentoc.core.protocol.TargetSummaryEventsPage
import com.andysagent.agentoc.core.protocol.TargetSummaryRunCounts
import com.andysagent.agentoc.core.protocol.TargetSummarySessionCounts
import com.andysagent.agentoc.core.protocol.boundarySeq
import com.andysagent.agentoc.core.protocol.messageEntityKey
import com.andysagent.agentoc.core.protocol.startingSeq
import com.andysagent.agentoc.core.protocol.requestKey
import com.andysagent.agentoc.core.protocol.long
import com.andysagent.agentoc.core.protocol.string
import com.andysagent.agentoc.core.protocol.textContent
import com.andysagent.agentoc.core.sync.CursorStore
import com.andysagent.agentoc.core.sync.EventSink
import com.andysagent.agentoc.core.sync.ReplayProvider
import com.andysagent.agentoc.core.sync.SessionSyncEngine
import com.andysagent.agentoc.core.sync.TargetSummaryCursor
import com.andysagent.agentoc.core.sync.TargetSummaryLedger
import com.andysagent.agentoc.core.sync.TargetSummarySyncEngine
import com.andysagent.agentoc.core.sync.TargetSummarySyncResult
import com.andysagent.agentoc.core.sync.SyncResult
import com.andysagent.agentoc.core.sync.AtomicEventSink
import com.andysagent.agentoc.core.sync.EventValidation
import com.andysagent.agentoc.core.sync.CursorMetadata
import com.andysagent.agentoc.core.timeline.LiveTimelineProjector
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineProjector
import com.andysagent.agentoc.core.timeline.TimelineRole
import com.andysagent.agentoc.core.timeline.messageTimelineId
import com.andysagent.agentoc.core.timeline.mergeTimelineItems
import androidx.room.withTransaction
import com.andysagent.agentoc.core.database.SessionEventEntity
import com.andysagent.agentoc.core.protocol.legacyDedupeKey
import com.andysagent.agentoc.core.protocol.dedupeKey
import com.andysagent.agentoc.core.protocol.sessionEventFingerprint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.sample
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

internal fun parseRuntimeCatalogMetadata(
    element: JsonElement?,
    fallbackProviderProfileId: String? = null,
    fallbackModelCount: Int = 0,
): RuntimeCatalogMetadata {
    val objectValue = element as? JsonObject
    val catalogModels = objectValue?.get("models") as? JsonArray
    val modelCount = catalogModels?.size ?: fallbackModelCount
    val hasError = objectValue?.containsKey("error") == true
    val errorObject = objectValue?.get("error") as? JsonObject
    return RuntimeCatalogMetadata(
        status = RuntimeCatalogStatus.fromValue(
            objectValue?.string("status"),
            modelCount = modelCount,
            hasError = hasError,
        ),
        providerProfileId = objectValue?.string("providerProfileId")?.takeIf { it.isNotBlank() }
            ?: fallbackProviderProfileId?.takeIf { it.isNotBlank() },
        catalogVersion = objectValue?.string("catalogVersion")?.takeIf { it.isNotBlank() },
        fetchedAt = objectValue?.string("fetchedAt")?.takeIf { it.isNotBlank() },
        expiresAt = (objectValue?.get("expiresAt") as? JsonPrimitive)?.contentOrNull?.toLongOrNull(),
        source = objectValue?.string("source")?.takeIf { it.isNotBlank() },
        errorCode = errorObject?.string("code")?.takeIf { it.isNotBlank() },
        modelCount = modelCount,
    )
}

class RoomSessionRepository(
    private val database: AgentoCDatabase,
    private val transport: AgentoCTransport,
    private val codec: ProtocolCodec = ProtocolCodec(),
    private val contentResolver: ContentResolver? = null,
    private val targetId: String? = null,
    private val attachmentRelay: AttachmentRelayTransport? = null,
) : SessionRepository {
    override val runtimeTargetId: String? get() = targetId
    private companion object {
        const val LIVE_TIMELINE_UI_INTERVAL_MS = 16L
        const val MAX_ATTACHMENT_BYTES = FileAssetUploadClient.MAXIMUM_METADATA_BYTES
        const val DEFAULT_ATTACHMENT_BUFFER_BYTES = 64 * 1024
    }

    private val dao: AgentoCDao = database.dao()
    // A long-poll for one conversation must not delay approvals or history
    // in another. Operations within a single conversation remain ordered.
    private val sessionSyncMutexes = java.util.concurrent.ConcurrentHashMap<String, Mutex>()
    private fun sessionSyncMutex(sessionId: String): Mutex = sessionSyncMutexes.computeIfAbsent(sessionId) { Mutex() }
    private val sessionListRefreshMutex = Mutex()
    private val activePendingOperationIds = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private suspend fun <T> withPendingOperationClaim(requestId: String, action: suspend () -> T): T {
        check(activePendingOperationIds.add(requestId)) { "Pending operation is already executing" }
        try { return action() } finally { activePendingOperationIds.remove(requestId) }
    }
    private val targetSummaryRefreshMutex = Mutex()
    private val liveProjectionMutex = Mutex()
    private val dedicatedLiveSessions = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val liveSyncScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val liveSyncLock = Any()
    private val liveSyncJobs = mutableMapOf<String, Job>()
    private var liveSyncCoordinatorJob: Job? = null
    private val liveProjectors = mutableMapOf<String, LiveTimelineProjector>()
    private val liveFeedCursors = java.util.concurrent.ConcurrentHashMap<String, Pair<String, Long>>()
    private val liveFeedMuted = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val liveFeedCapable = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val firstTurnCandidates = java.util.concurrent.ConcurrentHashMap<String, SessionEntity>()
    private val acceptedFirstTurnSnapshots = java.util.concurrent.ConcurrentHashMap<String, SessionEntity>()
    private val acceptedFirstTurnSessionIds = MutableStateFlow<Set<String>>(emptySet())
    private val approvalRecoveryAttempts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val terminalApprovalRecoveryAttempts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val terminalApprovalRecoveryOffsets = java.util.concurrent.ConcurrentHashMap<String, Int>()
    private val liveTimelineState = MutableStateFlow<Map<String, List<com.andysagent.agentoc.core.timeline.TimelineEvent>>>(emptyMap())
    private val runActivityState = MutableStateFlow<Map<String, JsonObject>>(emptyMap())
    override fun observeRunActivity(sessionId: String): Flow<JsonObject?> =
        runActivityState.map { it[sessionId] }.distinctUntilChanged()
    override fun observeRunDurations(sessionId: String): Flow<Map<String, Long>> =
        dao.observeRunDurations(sessionId).map { rows -> rows.associate { it.runId to it.durationMs } }
    override suspend fun saveRunDuration(sessionId: String, runId: String, durationMs: Long) {
        if (sessionId.isNotBlank() && runId.isNotBlank() && durationMs >= 0) {
            dao.upsertRunDuration(com.andysagent.agentoc.core.database.RunDurationEntity(sessionId, runId, durationMs))
        }
    }
    private val durableArtifactState = MutableStateFlow<Map<String, List<SessionEventDto>>>(emptyMap())
    // Retry a failed visible projection on
    // the next sync without rewinding the durable event cursor.
    private val pendingVisibleOperationRefresh = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val visibleTimelineState = MutableStateFlow<Map<String, List<TimelineItem>>>(emptyMap())
    private val attachmentUploadProgressState = MutableStateFlow<Map<String, AttachmentUploadProgress>>(emptyMap())
    override fun observeAttachmentUploadProgress(sessionId: String): Flow<Map<String, AttachmentUploadProgress>> =
        attachmentUploadProgressState.map { progress ->
            if (sessionId.isBlank()) emptyMap() else progress.filterValues { it.sessionId == sessionId }
        }.distinctUntilChanged()
    private val timelinePagingState = MutableStateFlow<Map<String, TimelinePagingState>>(emptyMap())
    private val visibleTimelineEvents = java.util.concurrent.ConcurrentHashMap<String, List<SessionEventDto>>()
    private val targetSummaryLedger = RoomTargetSummaryLedger(database, dao, codec)

    override val connectionState = transport.connectionState
    override val invalidations = transport.invalidations.map { SessionInvalidation(it.type, it.sessionId, it.events) }
    override fun observeAcceptedFirstTurnSessionIds(): Flow<Set<String>> = acceptedFirstTurnSessionIds
    override val requiresLiveSync: Boolean
        get() = transport.requiresEventPolling

    override fun startLiveSync() {
        if (!transport.requiresEventPolling) return
        synchronized(liveSyncLock) {
            if (liveSyncCoordinatorJob?.isActive == true) return
            liveSyncCoordinatorJob = liveSyncScope.launch {
                // Endpoint-less carriers have no directory invalidation socket.
                // Reconcile even idle sessions so another phone's delete/rename
                // appears without reconnecting or starting a model run.
                launch {
                    while (isActive) {
                        connectionState.filter { it == RuntimeConnectionState.Connected }.first()
                        try { refreshSessions() }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (_: Exception) { /* Retain the last authoritative list until retry. */ }
                        delay(3_000)
                    }
                }
                combine(observeSessions(), observeRows(dao.observeAllPendingApprovals())) { sessions, approvals ->
                    sessions to approvals
                }.collect { (sessions, approvals) ->
                    val sessionIds = sessions.mapTo(mutableSetOf()) { it.id }
                    val activeIds = sessions
                        .filter { it.status == SessionStatus.Working || it.status == SessionStatus.WaitingApproval }
                        .mapTo(mutableSetOf()) { it.id }
                    // A previous client may have persisted an approval after
                    // its run ended. Terminal sessions need reconciliation too;
                    // otherwise neither surface ever gets an authoritative clear.
                    approvals.filter { !it.runId.isNullOrBlank() && it.sessionId in sessionIds }
                        .mapTo(activeIds) { it.sessionId }
                    synchronized(liveSyncLock) {
                        liveSyncJobs.keys
                            // A worker may have just applied the terminal
                            // event that changed its Room row. Let that
                            // worker perform its final detail/event reconcile;
                            // only cancel workers for sessions that vanished.
                            .filter { it !in sessionIds }
                            .toList()
                            .forEach { id -> liveSyncJobs.remove(id)?.cancel() }
                        activeIds.forEach { id ->
                            if (liveSyncJobs[id]?.isActive != true) {
                                // Keep the worker independent from the
                                // coordinator. Its own detail refresh can
                                // update this Room row to a terminal state;
                                // cancelling child jobs from the collector
                                // would otherwise interrupt the final event
                                // reconcile before it is applied.
                                liveSyncJobs[id] = liveSyncScope.launch { reconcileSessionUntilSettled(id) }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun stopLiveSync() {
        synchronized(liveSyncLock) {
            liveSyncCoordinatorJob?.cancel()
            liveSyncCoordinatorJob = null
            liveSyncJobs.values.forEach { it.cancel() }
            liveSyncJobs.clear()
        }
    }

    override suspend fun close() = withContext(NonCancellable) {
        liveSyncScope.coroutineContext[Job]?.cancelAndJoin()
        synchronized(liveSyncLock) {
            liveSyncCoordinatorJob = null
            liveSyncJobs.clear()
        }
    }

    // Room observers can otherwise outlive a removed target's database when
    // their UI collector is cancelled asynchronously. Own the actual query
    // collection here so terminal close can cancel and join it before SQLite.
    private fun <T> observeRows(upstream: Flow<T>): Flow<T> = channelFlow {
        val observer = liveSyncScope.launch {
            try { upstream.collect { send(it) } }
            catch (error: Exception) { channel.close(error) }
        }
        observer.invokeOnCompletion { channel.close(it) }
        awaitClose { observer.cancel() }
    }

    private suspend fun reconcileSessionUntilSettled(sessionId: String) {
        coroutineScope {
            connectionState.filter { it == com.andysagent.agentoc.core.model.RuntimeConnectionState.Connected }.first()
            val liveSupported = try {
                readDedicatedLivePage(sessionId, probe = true)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) { false }
            val liveJob = if (liveSupported) {
                dedicatedLiveSessions.add(sessionId)
                launch {
                    try {
                    while (isActive) {
                        try {
                            if (!readDedicatedLivePage(sessionId)) return@launch
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: ApiException) {
                            if (error.statusCode == 401 || error.statusCode == 403) return@launch
                            delay(1_000)
                        } catch (_: Exception) { delay(1_000) }
                    }
                    } finally { dedicatedLiveSessions.remove(sessionId) }
                }
            } else null
            val activityJob = if (liveSupported) launch {
                while (isActive) {
                    try {
                        refreshCanonicalRunActivity(sessionId)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: ApiException) {
                        if (error.statusCode == 401 || error.statusCode == 403) return@launch
                    } catch (_: Exception) { /* Retain the last confirmed action on transient failure. */ }
                    delay(1_000)
                }
            } else null
            try {
                reconcileDurableSessionUntilSettled(sessionId)
            } finally {
                liveJob?.cancelAndJoin()
                activityJob?.cancelAndJoin()
                dedicatedLiveSessions.remove(sessionId)
            }
        }
    }

    private suspend fun readDedicatedLivePage(sessionId: String, probe: Boolean = false): Boolean {
        val cursor = liveFeedCursors[sessionId]
        val path = "/api/sessions/${encode(sessionId)}/events/wait?includeLive=1&liveOnly=1" +
            "&timeoutMs=${if (probe) 1 else 15000}&liveAfterCursor=${cursor?.second ?: 0}" +
            (cursor?.first?.let { "&liveStreamId=${encode(it)}" } ?: "")
        val response = execute(ApiRequest("GET", path))
        val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
        if (!page.liveOnly) return false // Older servers retain their existing polling path.
        if (android.util.Log.isLoggable("AgentoCLive", android.util.Log.DEBUG)) {
            android.util.Log.d("AgentoCLive", "live-only session=${sessionId.hashCode()} cursor=${page.liveCursor} reset=${page.liveResetRequired} frames=${page.liveEvents.size} chars=${page.liveEvents.sumOf { it.text?.length ?: 0 }}")
        }
        if (page.events.isNotEmpty() || page.sessionId != sessionId || page.liveStreamId == null || page.liveCursor == null) {
            throw SessionRepositoryException(502, "SESSION_LIVE_INVALID", "Invalid live-only scope", false)
        }
        applyLivePage(sessionId, page)
        return true
    }

    private suspend fun reconcileDurableSessionUntilSettled(sessionId: String) {
        var retryDelayMs = 1_000L
        var lastDetailRefresh = 0L
        while (liveSyncScope.isActive) {
            connectionState
                .filter { it == com.andysagent.agentoc.core.model.RuntimeConnectionState.Connected }
                .first()
            try {
                // Detail carries the authoritative run/session state; events
                // then advance the Room cursor and materialize the reply.
                val now = android.os.SystemClock.elapsedRealtime()
                val detail = if (now - lastDetailRefresh >= 1_000L || lastDetailRefresh == 0L) {
                    lastDetailRefresh = now
                    refreshSessionDetail(sessionId)
                } else dao.getSession(sessionId)?.let(::toDomain)
                val result = refreshEvents(sessionId)
                if (result is RefreshResult.ResetRequired) return
                val terminal = detail == null || detail.status == SessionStatus.Completed ||
                    detail.status == SessionStatus.Failed || detail.status == SessionStatus.Cancelled ||
                    detail.status == SessionStatus.Idle
                // A finished run can still have unread event pages or a failed
                // visible-history refresh. Keep reconciling until the terminal
                // message and tool results have actually reached the UI.
                if (terminal && result is RefreshResult.Applied &&
                    result.latestSeq >= (detail?.latestSeq ?: 0L) &&
                    sessionId !in pendingVisibleOperationRefresh
                ) {
                    if (dao.getPendingApprovals(sessionId).none { !it.runId.isNullOrBlank() }) return
                    // Keep retrying missed terminal events or transient run
                    // lookups, without a tight loop on unverifiable requests.
                    delay(5_000L)
                    continue
                }
                retryDelayMs = 1_000L
                delay(if (sessionId in dedicatedLiveSessions) 1_000L else if (sessionId in liveFeedCapable) 200L else retryDelayMs)
            } catch (error: CancellationException) {
                throw error
            } catch (error: ApiException) {
                if (error.statusCode == 401 || error.statusCode == 403) return
                delay(retryDelayMs)
                retryDelayMs = minOf(5_000L, retryDelayMs * 2L)
            } catch (_: Throwable) {
                delay(retryDelayMs)
                retryDelayMs = minOf(5_000L, retryDelayMs * 2L)
            }
        }
    }

    private suspend fun refreshCanonicalRunActivity(sessionId: String) {
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/events?filter=visible&limit=1"))
        val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
        if (page.sessionId != sessionId) throw SessionRepositoryException(502, "SESSION_SCOPE_INVALID", "Invalid activity scope", false)
        (page.runActivity as? JsonObject)?.let { activity -> runActivityState.update { it + (sessionId to activity) } }
    }

    override fun observeComputers(): Flow<List<Computer>> = observeRows(dao.observeComputers()).map { items -> items.map(::toDomain) }

    override fun observeProjects(): Flow<List<Project>> = observeRows(dao.observeProjects()).map { items -> items.map(::toDomain) }

    override fun observeSessions(): Flow<List<Session>> = combine(
        observeRows(dao.observeSessions()),
        acceptedFirstTurnSessionIds,
    ) { items, acceptedIds ->
        val existingIds = items.mapTo(mutableSetOf()) { it.id }
        val retained = acceptedIds.mapNotNull { id ->
            if (id in existingIds) null else acceptedFirstTurnSnapshots[id]
        }
        (items + retained).map(::toDomain)
    }

    override fun observeSession(sessionId: String): Flow<Session?> = observeRows(dao.observeSessions()).map { items -> items.firstOrNull { it.id == sessionId }?.let(::toDomain) }

    override fun observeMessages(sessionId: String): Flow<List<Message>> = observeRows(dao.observeMessages(sessionId)).map { items ->
        items.filterNot {
            // Older app versions persisted compaction handoffs as assistant
            // messages without retaining their source. Hide the distinctive
            // internal envelope while preserving the stored history.
            it.role == "assistant" && it.runId.isNullOrBlank() &&
                it.content.trimStart().startsWith("# Auto Compress\n") &&
                it.content.contains("## Kept in current context")
        }.map {
            Message(
                id = it.id,
                sessionId = it.sessionId,
                role = it.role,
                content = it.content,
                seq = it.seq,
                completed = it.completed,
                lastEventSeq = it.lastEventSeq, revision = it.revision, messageState = it.messageState,
                messagePhase = it.messagePhase,
                requestId = it.requestId,
                runId = it.runId,
            )
        }
    }

    @OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
    override fun observeTimeline(sessionId: String): Flow<List<TimelineItem>> = combine(
        observeMessages(sessionId),
        liveTimelineState.map { it[sessionId].orEmpty() },
        durableArtifactState.map { artifacts -> artifacts[sessionId].orEmpty() },
        visibleTimelineState.map { it[sessionId].orEmpty() },
    ) { durable, live, artifacts, visible -> TimelineProjectionInput(durable, live, artifacts, visible) }
        // A WS burst can contain one delta per token. Keep the protocol/live
        // state current, but give Compose one projection at most every frame
        // or two while streaming. Durable changes are also bounded to this
        // small window, which is below a visible interaction threshold.
        .sample(LIVE_TIMELINE_UI_INTERVAL_MS)
        .distinctUntilChanged()
        .let { inputs ->
            // Keep a projection cache per collector. Durable history is stable
            // while a response streams, so only the changed live overlay is
            // folded into the existing timeline engine.
            flow {
                val projector = com.andysagent.agentoc.core.timeline.IncrementalTimelineProjector()
                var artifactProjector = com.andysagent.agentoc.core.timeline.LiveTimelineProjector()
                val appliedArtifactFingerprints = mutableMapOf<String, String>()
                var previousArtifactKeys: Set<String> = emptySet()
                var artifactItems: List<TimelineItem> = emptyList()
                var artifactDurableCursor = 0L
                inputs
                    .mapLatest { input ->
                        projector.project(input.durable, input.live)
                            .let { base ->
                                val withVisible = mergeTimelineItems(input.visible, base)
                                if (input.artifacts.isEmpty()) {
                                    if (previousArtifactKeys.isNotEmpty()) {
                                        artifactProjector = com.andysagent.agentoc.core.timeline.LiveTimelineProjector()
                                        appliedArtifactFingerprints.clear()
                                        previousArtifactKeys = emptySet()
                                        artifactDurableCursor = 0L
                                    }
                                    artifactItems = emptyList()
                                    withVisible
                                } else {
                                    val artifactKeys = input.artifacts.mapTo(mutableSetOf()) { event ->
                                        event.dedupeKey() ?: "fingerprint:${event.sessionEventFingerprint()}"
                                    }
                                    if (!artifactKeys.containsAll(previousArtifactKeys)) {
                                        artifactProjector = com.andysagent.agentoc.core.timeline.LiveTimelineProjector()
                                        appliedArtifactFingerprints.clear()
                                        artifactItems = emptyList()
                                        artifactDurableCursor = 0L
                                    }
                                    val durableCursor = input.durable.maxOfOrNull { it.seq ?: 0L } ?: 0L
                                    val durableAdvanced = durableCursor != artifactDurableCursor
                                    artifactProjector.reconcileDurableCursor(
                                        durableCursor,
                                    )
                                    val changedArtifacts = input.artifacts.filter { event ->
                                        val key = event.dedupeKey() ?: "fingerprint:${event.sessionEventFingerprint()}"
                                        val fingerprint = event.sessionEventFingerprint()
                                        appliedArtifactFingerprints[key] != fingerprint
                                    }
                                    val needsReplay = durableAdvanced || artifactItems.isEmpty()
                                    val artifactsToApply = if (needsReplay) input.artifacts else changedArtifacts
                                    if (artifactsToApply.isNotEmpty()) {
                                        artifactProjector.applyArtifactEvents(artifactsToApply)
                                        artifactsToApply.forEach { event ->
                                            val key = event.dedupeKey() ?: "fingerprint:${event.sessionEventFingerprint()}"
                                            appliedArtifactFingerprints[key] = event.sessionEventFingerprint()
                                        }
                                        artifactItems = com.andysagent.agentoc.core.timeline.TimelineProjector.project(
                                            emptyList(),
                                            artifactProjector.snapshotEvents(),
                                        )
                                    }
                                    artifactDurableCursor = durableCursor
                                    previousArtifactKeys = artifactKeys
                                    mergeTimelineItems(withVisible, artifactItems)
                                }
                            }
                    }
                    .collect { emit(it) }
            }
        }
        // Timeline sorting and model allocation must not compete with Compose
        // measure/layout on the main thread during a token burst.
        .flowOn(Dispatchers.Default)

    override fun observeTimelinePaging(sessionId: String): Flow<TimelinePagingState> =
        timelinePagingState.map { it[sessionId] ?: TimelinePagingState() }.distinctUntilChanged()

    override fun observePendingApprovals(sessionId: String): Flow<List<Approval>> =
        combine(observeRows(dao.observePendingApprovals(sessionId)), observeRunActivity(sessionId)) { items, activity ->
            val sourceSeq = (activity?.get("sourceSeq") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
            val runId = (activity?.get("runId") as? JsonPrimitive)?.contentOrNull
            val isWaiting = (activity?.get("actionRequired") as? JsonPrimitive)?.booleanOrNull == true &&
                (activity["kind"] as? JsonPrimitive)?.contentOrNull == "approval"
            val ordered = if (isWaiting && sourceSeq != null) items.sortedByDescending {
                it.approvalSourceSequence() == sourceSeq && (runId.isNullOrBlank() || it.runId == runId)
            } else items
            ordered.map { it.toDomainApproval() }
        }

    override fun observeAllPendingApprovals(): Flow<List<Approval>> = observeRows(dao.observeAllPendingApprovals()).map { items ->
        items.map { it.toDomainApproval() }
    }

    override suspend fun findPendingApproval(sessionId: String, approvalId: String): Approval? = dao.getApproval(sessionId, approvalId)?.let {
        it.toDomainApproval()
    }

    override suspend fun retireStaleApproval(sessionId: String, approvalId: String) {
        val approval = dao.getApproval(sessionId, approvalId) ?: return
        if (approval.status != "pending") return
        dao.upsertApprovals(listOf(approval.copy(status = "resolved", updatedAt = System.currentTimeMillis())))
    }

    private suspend fun retirePendingApprovals(
        sessionId: String,
        runId: String? = null,
        requestId: String? = null,
        runIds: Set<String> = emptySet(),
        unscoped: Boolean = false,
    ) {
        val pending = dao.getPendingApprovals(sessionId)
        val matches = pending.filter { approval ->
            when {
                !runId.isNullOrBlank() && approval.runId == runId -> true
                !runId.isNullOrBlank() && !approval.runId.isNullOrBlank() -> false
                runIds.isNotEmpty() && approval.runId in runIds -> true
                unscoped && approval.runId.isNullOrBlank() -> true
                !requestId.isNullOrBlank() -> approval.id == requestId || approval.requestIdFromDetails() == requestId
                else -> false
            }
        }
        if (matches.isNotEmpty()) {
            val now = System.currentTimeMillis()
            dao.upsertApprovals(matches.map { it.copy(status = "resolved", updatedAt = now) })
        }
    }

    override suspend fun refreshComputers() {
        val response = execute(ApiRequest("GET", "/api/device-pairing/devices"))
        val payload = codec.decode(serializer<ListTrustedDevicesResponse>(), response.body)
        val now = System.currentTimeMillis()
        dao.replaceComputers(payload.devices.map { device ->
            ComputerEntity(
                id = device.id,
                name = device.deviceName,
                platform = device.platform,
                endpoint = device.entryUrl,
                connected = device.revokedAt.isNullOrBlank(),
                updatedAt = device.lastSeenAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: now,
            )
        })
    }

    override suspend fun refreshProjects() {
        val response = execute(ApiRequest("GET", "/api/projects"))
        val payload = codec.decode(serializer<ProjectListResponseDto>(), response.body)
        val now = System.currentTimeMillis()
        dao.replaceProjects(payload.projects.map { project ->
            ProjectEntity(
                id = project.string("id").orEmpty(),
                name = project.string("name") ?: "Unnamed project",
                folder = project.string("rootPath"),
                updatedAt = project.string("updatedAt")?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() } ?: now,
                pinned = (project["pinned"] as? JsonPrimitive)?.booleanOrNull == true,
            )
        }.filter { it.id.isNotBlank() })
    }

    override suspend fun createProject(name: String, rootPath: String): Project {
        require(rootPath.isNotBlank()) { "Project path must not be blank" }
        val body = codec.encode(serializer<CreateProjectRequestDto>(), CreateProjectRequestDto(name.trim(), rootPath.trim()))
        val response = execute(ApiRequest("POST", "/api/projects", body))
        val project = codec.decode(serializer<kotlinx.serialization.json.JsonObject>(), response.body)["project"]?.jsonObject
            ?: error("Project response did not include a project")
        val entity = ProjectEntity(
            id = project.string("id").orEmpty().also { require(it.isNotBlank()) { "Created project has no id" } },
            name = project.string("name") ?: name.ifBlank { "Unnamed project" },
            folder = project.string("rootPath"),
            updatedAt = System.currentTimeMillis(),
        )
        dao.upsertProjects(listOf(entity))
        return toDomain(entity)
    }

    override suspend fun browseProjectFolders(path: String): ProjectFolderBrowser {
        val requestedPath = path.trim().ifBlank { "~" }
        val encodedPath = java.net.URLEncoder.encode(requestedPath, Charsets.UTF_8.name())
        val response = execute(ApiRequest("GET", "/api/browse?path=$encodedPath&mode=directories"))
        val payload = codec.decode(JsonObject.serializer(), response.body)
        val resolvedPath = payload.string("path")?.trim().orEmpty().ifBlank { requestedPath }
        val parentPath = payload.string("parent")?.trim()?.takeIf { it.isNotEmpty() }
        val children = payload["children"]?.jsonArray.orEmpty()
            .mapNotNull { item ->
                val folder = item as? JsonObject ?: return@mapNotNull null
                val childPath = folder.string("path")?.trim().orEmpty()
                if (childPath.isBlank()) return@mapNotNull null
                ProjectFolder(
                    path = childPath,
                    name = folder.string("name")?.trim()?.takeIf { it.isNotEmpty() }
                        ?: childPath.trimEnd('/', '\\').substringAfterLast('/', childPath.substringAfterLast('\\')),
                )
            }
        return ProjectFolderBrowser(resolvedPath, parentPath, children)
    }

    override suspend fun createProjectFolder(parentPath: String, name: String): ProjectFolder {
        require(parentPath.isNotBlank()) { "Parent folder must not be blank" }
        val normalizedName = name.trim()
        require(normalizedName.isNotBlank() && normalizedName != "." && normalizedName != ".." && !normalizedName.contains('/') && !normalizedName.contains('\\')) {
            "Folder name must be a single directory name"
        }
        val body = buildJsonObject {
            put("path", JsonPrimitive(parentPath.trim()))
            put("name", JsonPrimitive(normalizedName))
        }.toString()
        val response = execute(ApiRequest("POST", "/api/browse/mkdir", body))
        val payload = codec.decode(JsonObject.serializer(), response.body)
        val folderPath = payload.string("path")?.trim().orEmpty()
        require(folderPath.isNotBlank()) { "Created folder has no path" }
        return ProjectFolder(
            path = folderPath,
            name = payload.string("name")?.trim()?.takeIf { it.isNotEmpty() } ?: normalizedName,
        )
    }

    override suspend fun updateProject(projectId: String, name: String?, rootPath: String?): Project {
        require(projectId.isNotBlank()) { "Project id must not be blank" }
        require(name != null || rootPath != null) { "A project update is required" }
        val body = buildJsonObject {
            name?.trim()?.takeIf { it.isNotEmpty() }?.let { put("name", JsonPrimitive(it)) }
            rootPath?.trim()?.takeIf { it.isNotEmpty() }?.let { put("rootPath", JsonPrimitive(it)) }
        }.toString()
        val response = execute(ApiRequest("PATCH", "/api/projects/${java.net.URLEncoder.encode(projectId, Charsets.UTF_8.name())}", body))
        val project = codec.decode(serializer<JsonObject>(), response.body)["project"]?.jsonObject
            ?: error("Project response did not include a project")
        val entity = ProjectEntity(
            id = project.string("id").orEmpty().also { require(it.isNotBlank()) { "Updated project has no id" } },
            name = project.string("name") ?: name.orEmpty(),
            folder = project.string("rootPath") ?: rootPath,
            updatedAt = System.currentTimeMillis(),
            pinned = (project["pinned"] as? JsonPrimitive)?.booleanOrNull == true,
        )
        dao.upsertProjects(listOf(entity))
        return toDomain(entity)
    }

    override suspend fun deleteProject(projectId: String, deleteSessions: Boolean) {
        require(projectId.isNotBlank()) { "Project id must not be blank" }
        val body = buildJsonObject { put("deleteSessions", JsonPrimitive(deleteSessions)) }.toString()
        execute(ApiRequest("DELETE", "/api/projects/${java.net.URLEncoder.encode(projectId, Charsets.UTF_8.name())}", body))
        refreshProjects()
        refreshSessions()
    }

    override suspend fun setProjectPinned(projectId: String, pinned: Boolean) {
        require(projectId.isNotBlank()) { "Project id must not be blank" }
        execute(ApiRequest("PATCH", "/api/projects/${encode(projectId)}", buildJsonObject { put("pinned", JsonPrimitive(pinned)) }.toString()))
        refreshProjects()
    }

    override suspend fun createSession(name: String, tool: String): Session {
        return createSessionRequest(name, tool, projectId = null)
    }

    override suspend fun createSessionIdempotent(
        request: CreateSessionRequestDto,
        idempotencyKey: String,
    ): SessionCreationReceipt {
        require(idempotencyKey.isNotBlank() && idempotencyKey.length <= 200) { "Invalid session creation key" }
        require(request.idempotencyKey == null || request.idempotencyKey == idempotencyKey) { "Session creation keys differ" }
        require(request.tool.isNotBlank()) { "Runtime tool must not be blank" }
        // Fail before the first effect on an older server which would ignore
        // the key. This is authenticated through the same target carrier.
        val contractResponse = execute(ApiRequest("GET", "/api/session-creation-contract"))
        val contract = codec.decode(serializer<JsonObject>(), contractResponse.body)
        check(contract.long("version") == 1L) { "Target does not support session creation contract v1" }
        val body = codec.encode(serializer<CreateSessionRequestDto>(), request.copy(idempotencyKey = idempotencyKey))
        val response = execute(ApiRequest("POST", "/api/sessions", body, idempotencyKey, idempotencyKey))
        val payload = codec.decode(serializer<CreateSessionResponseDto>(), response.body)
        check(payload.creationContractVersion == 1) { "Target did not acknowledge idempotent creation" }
        val entity = sessionEntityFromClientJson(payload.session)
        dao.upsertSessions(listOf(entity))
        return SessionCreationReceipt(toDomain(entity), idempotencyKey, payload.duplicate)
    }

    override suspend fun submitMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String?,
        attachments: List<AttachmentItemDto>,
    ): MessageSubmissionReceipt {
        require(sessionId.isNotBlank() && requestId.isNotBlank()) { "Session and request identity are required" }
        require(text.isNotBlank()) { "Message text is required" }
        require(attachments.size <= 16 && attachments.all { !it.assetId.isNullOrBlank() && it.url == null && it.text == null }) { "Only verified file asset references may be submitted" }
        val body = encodeMessage(text, requestId, selection, agentId, attachments.toList())
        val response = execute(ApiRequest("POST", "/api/sessions/${encode(sessionId)}/messages", body, requestId, requestId))
        val receipt = messageSubmissionReceipt(sessionId, requestId, codec.decode(serializer<JsonObject>(), response.body))
        markFirstTurnAccepted(sessionId)
        return receipt
    }

    override suspend fun findMessageSubmissionReceipt(sessionId: String, requestId: String): MessageSubmissionReceipt? {
        require(sessionId.isNotBlank() && requestId.isNotBlank() && requestId.length <= 200) { "Invalid receipt identity" }
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/message-receipts/${encode(requestId)}"))
        val receipt = lookupMessageSubmissionReceipt(sessionId, requestId, codec.decode(serializer<JsonObject>(), response.body))
        if (receipt != null) markFirstTurnAccepted(sessionId)
        return receipt
    }

    override suspend fun createSessionInProject(projectId: String?, name: String, tool: String): Session {
        return createSessionRequest(name, tool, projectId = projectId?.trim()?.takeIf { it.isNotEmpty() })
    }

    private suspend fun createSessionRequest(name: String, tool: String, projectId: String?): Session {
        require(tool.isNotBlank()) { "Runtime tool must not be blank" }
        val body = codec.encode(
            serializer<CreateSessionRequestDto>(),
            CreateSessionRequestDto(tool = tool, name = name.trim(), projectId = projectId),
        )
        val response = execute(ApiRequest("POST", "/api/sessions", body))
        val payload = codec.decode(serializer<CreateSessionResponseDto>(), response.body)
        val item = payload.session
        val session = SessionEntity(
            id = item.string("id").orEmpty().also { require(it.isNotBlank()) { "Created session has no id" } },
            title = item.string("title") ?: item.string("name") ?: name.ifBlank { "New session" },
            projectId = item.string("projectId"),
            templateId = item.string("templateId"),
            status = item.string("workflowState") ?: "idle",
            latestSeq = item.long("latestSeq") ?: 0L,
            updatedAt = System.currentTimeMillis(),
            workflowState = item.string("workflowState"),
            waitingAction = item.string("waitingAction") ?: item.string("attentionKind"),
        )
        dao.upsertSessions(listOf(session))
        if (session.latestSeq == 0L) firstTurnCandidates[session.id] = session
        return toDomain(session)
    }

    override suspend fun bindAgent(sessionId: String, templateId: String) {
        val normalizedTemplateId = templateId.trim()
        require(normalizedTemplateId.isNotBlank()) { "Agent id must not be blank" }
        val requestId = newRequestId()
        val path = "/api/sessions/${encode(sessionId)}/apply-template"
        val body = codec.encode(serializer<ApplyTemplateRequestDto>(), ApplyTemplateRequestDto(normalizedTemplateId))
        try {
            executePending(sessionId, requestId, "bind_agent", path, body) {
                execute(ApiRequest("POST", path, body, requestId, requestId))
            }
        } catch (error: SessionRepositoryException) {
            // The server only permits template binding before the first
            // message (and while the session is not running). A 409 here is
            // a known terminal conflict, not an unknown network outcome;
            // retaining it would make every startup retry an impossible
            // operation. Keep pending rows for all other failures because
            // those may still be recoverable or have unknown delivery state.
            if (error.statusCode == 409) dao.deleteOperation(requestId)
            throw error
        }
        // The response is intentionally reconciled through the canonical list
        // projection so the next process/session selection reads server state.
        refreshSessions()
    }

    override suspend fun renameSession(sessionId: String, name: String) {
        require(name.trim().isNotBlank()) { "Session name must not be blank" }
        execute(ApiRequest(
            "PATCH",
            "/api/sessions/${encode(sessionId)}",
            buildJsonObject { put("name", JsonPrimitive(name.trim())) }.toString(),
        ))
        refreshSessions()
    }

    override suspend fun deleteSession(sessionId: String) {
        execute(ApiRequest("DELETE", "/api/sessions/${encode(sessionId)}"))
        firstTurnCandidates.remove(sessionId)
        acceptedFirstTurnSnapshots.remove(sessionId)
        acceptedFirstTurnSessionIds.update { it - sessionId }
        dao.deleteRunDurations(sessionId)
        refreshSessions()
    }

    override suspend fun setSessionPinned(sessionId: String, pinned: Boolean) {
        require(sessionId.isNotBlank()) { "Session id must not be blank" }
        execute(ApiRequest("PATCH", "/api/sessions/${encode(sessionId)}",
            buildJsonObject { put("pinned", JsonPrimitive(pinned)) }.toString()))
        refreshSessions()
    }

    /**
     * Mirrors the Web home mark-read PATCH: an optimistic local stamp keeps the
     * focus card cleared immediately (including while offline), then the server
     * stamp is persisted and reconciled through the canonical list projection.
     * A transient failure keeps the optimistic dismissal instead of blocking
     * the owner with an error banner over a benign read action.
     */
    override suspend fun markSessionReviewed(sessionId: String) {
        val reviewedAt = System.currentTimeMillis()
        val existing = dao.getSession(sessionId) ?: return
        dao.upsertSessions(listOf(existing.copy(lastReviewedAt = reviewedAt)))
        runCatching {
            execute(ApiRequest(
                "PATCH",
                "/api/sessions/${encode(sessionId)}",
                buildJsonObject {
                    put("lastReviewedAt", JsonPrimitive(java.time.Instant.ofEpochMilli(reviewedAt).toString()))
                }.toString(),
            ))
            refreshSessions()
        }
    }

    override suspend fun compactSession(sessionId: String) {
        execute(ApiRequest("POST", "/api/sessions/${encode(sessionId)}/compact"))
        refreshEvents(sessionId)
    }

    override suspend fun dropTools(sessionId: String) {
        execute(ApiRequest("POST", "/api/sessions/${encode(sessionId)}/drop-tools"))
        refreshEvents(sessionId)
    }

    override suspend fun forkSession(sessionId: String): Session {
        val response = execute(ApiRequest("POST", "/api/sessions/${encode(sessionId)}/fork"))
        val item = codec.decode(serializer<kotlinx.serialization.json.JsonObject>(), response.body)["session"]?.jsonObject
            ?: error("Fork response did not include a session")
        val session = SessionEntity(
            id = item.string("id").orEmpty().also { require(it.isNotBlank()) { "Forked session has no id" } },
            title = item.string("title") ?: item.string("name") ?: "Forked session",
            projectId = item.string("projectId"),
            templateId = item.string("templateId"),
            status = item.string("workflowState") ?: "idle",
            latestSeq = item.long("latestSeq") ?: 0L,
            updatedAt = System.currentTimeMillis(),
            workflowState = item.string("workflowState"),
            waitingAction = item.string("waitingAction") ?: item.string("attentionKind"),
        )
        dao.upsertSessions(listOf(session))
        return toDomain(session)
    }

    override suspend fun regenerateMessage(sessionId: String, parentRequestId: String, requestId: String) {
        require(parentRequestId.isNotBlank()) { "Source request id must not be blank" }
        require(requestId.isNotBlank()) { "Regenerate request id must not be blank" }
        val path = "/api/sessions/${encode(sessionId)}/regenerate"
        val body = codec.encode(
            serializer<RegenerateMessageRequestDto>(),
            RegenerateMessageRequestDto(requestId = parentRequestId, newRequestId = requestId),
        )
        executePending(sessionId, requestId, "regenerate_message", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
        refreshEvents(sessionId)
    }

    override suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String,
    ) {
        resendEditedMessage(sessionId, parentRequestId, prompt, selection, requestId, emptyList())
    }

    override suspend fun resendEditedMessage(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        selection: RuntimeSelection,
        requestId: String,
        attachments: List<OutboundAttachment>,
    ) {
        require(parentRequestId.isNotBlank()) { "Source request id must not be blank" }
        require(prompt.trim().isNotBlank()) { "Edited prompt must not be blank" }
        require(requestId.isNotBlank()) { "Edited resend request id must not be blank" }
        val path = "/api/sessions/${encode(sessionId)}/resend-edited"
        if (attachments.isEmpty()) {
            val body = codec.encode(
                serializer<ResendEditedMessageRequestDto>(),
                ResendEditedMessageRequestDto(
                    requestId = parentRequestId,
                    prompt = prompt.trim(),
                    newRequestId = requestId,
                    tool = selection.tool.takeIf { it.isNotBlank() },
                    model = selection.model,
                    effort = selection.effort,
                    serviceTier = selection.serviceTier,
                ),
            )
            executePending(sessionId, requestId, "resend_edited_message", path, body) {
                execute(ApiRequest("POST", path, body, requestId, requestId))
            }
        } else withPendingOperationClaim(requestId) {
            var operation = PendingOperationEntity(
                requestId = requestId,
                kind = "resend_edited_message_with_attachments",
                path = path,
                payload = encodeAttachmentResendCommand(
                    sessionId = sessionId,
                    parentRequestId = parentRequestId,
                    prompt = prompt.trim(),
                    requestId = requestId,
                    selection = selection,
                    attachments = attachments,
                ),
                state = "pending",
                createdAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis(),
                method = "POST",
                idempotencyKey = requestId,
            )
            dao.upsertOperation(operation)
            try {
                val materialized = materializePendingAttachments(operation)
                operation = materialized.first
                val payload = AgentocProtocol.json.parseToJsonElement(operation.payload).jsonObject
                val body = encodeEditedMessage(
                    parentRequestId = payload.string("parentRequestId").orEmpty(),
                    prompt = payload.string("prompt").orEmpty(),
                    requestId = payload.string("requestId") ?: operation.requestId,
                    selection = selectionFromAttachmentPayload(payload),
                    attachments = materialized.second,
                )
                dao.upsertOperation(operation.copy(state = "sending", updatedAt = System.currentTimeMillis()))
                execute(ApiRequest("POST", path, body, requestId, requestId))
                dao.deleteOperation(requestId)
            } catch (error: Throwable) {
                val recoverable = dao.getPendingOperation(requestId) ?: operation
                dao.upsertOperation(recoverable.copy(
                    state = if (isPermanentClientFailure(error)) "failed" else "pending",
                    updatedAt = System.currentTimeMillis(),
                    lastError = error.message,
                ))
                throw error
            }
        }
        runCatching { refreshSessionDetail(sessionId) }
    }

    override suspend fun forkSessionAt(
        sessionId: String,
        anchorSeq: Long,
        mode: String,
        idempotencyKey: String,
    ): Session {
        require(anchorSeq > 0) { "Fork anchor must be a positive sequence" }
        require(mode == "user-continue" || mode == "assistant-continue") { "Unsupported fork mode" }
        require(idempotencyKey.isNotBlank()) { "Fork idempotency key must not be blank" }
        val path = "/api/sessions/${encode(sessionId)}/fork-at"
        val body = codec.encode(
            serializer<ForkAtRequestDto>(),
            ForkAtRequestDto(anchorSeq = anchorSeq, mode = mode, idempotencyKey = idempotencyKey),
        )
        val response = executePendingResponse(sessionId, idempotencyKey, "fork_at", path, body) {
            execute(ApiRequest("POST", path, body, idempotencyKey, idempotencyKey))
        }
        return persistForkedSessionResponse(response.body)
    }

    private suspend fun requestSessionList(): com.andysagent.agentoc.core.network.ApiResponse = try {
        execute(ApiRequest("GET", "/api/sessions?view=summary"))
    } catch (error: SessionRepositoryException) {
        // Older temporary-control carriers reject this optional query before
        // dispatch. Retry only their specific route-denial response; do not
        // treat ordinary authorization failures as a compatibility signal.
        if (error.statusCode != 403 || error.code != "temporary_control_route_denied") throw error
        execute(ApiRequest("GET", "/api/sessions"))
    }

    override suspend fun refreshSessions() = sessionListRefreshMutex.withLock {
        val response = requestSessionList()
        val payload = codec.decode(serializer<SessionListResponseDto>(), response.body)
        val now = System.currentTimeMillis()
        val persistedSnapshots = dao.observeSessions().first()
            .filter { isAcceptedFirstTurnStatus(it.status) }.associateBy { it.id }
        val canonical = payload.sessions.map { item ->
            val existing = item.string("id")?.let { dao.getSession(it) }
            val activity = item["activity"]?.jsonObject
            val run = activity?.get("run")?.jsonObject
            val workflowState = item.string("workflowState")
            val rawStatus = chooseSessionSummaryStatus(item.string("status"), workflowState, run?.string("state"))
            val sessionId = item.string("id").orEmpty()
            val status = preservePendingApprovalStatus(sessionId, rawStatus, sessionRunId(item))
            val waitingAction = item.string("waitingAction")
                ?: item.string("attentionKind")
                ?: run?.string("kind")?.takeIf { it.equals("approval", ignoreCase = true) }
                ?: if (workflowState.equals("waiting_user", ignoreCase = true)) "reply" else null
            val serverUpdatedAt = parseTimestamp(
                item.string("lastActivityAt")
                    ?: item.string("lastEventAt")
                    ?: item.string("updatedAt")
                    ?: item.string("created"),
            ) ?: now
            SessionEntity(
                id = item.string("id").orEmpty(),
                title = item.string("title") ?: item.string("name") ?: "Unnamed session",
                projectId = if (item.containsKey("projectId")) item.string("projectId") else existing?.projectId,
                templateId = item.string("templateId"),
                status = status,
                latestSeq = item["latestSeq"]?.toString()?.trim('"')?.toLongOrNull() ?: 0L,
                updatedAt = serverUpdatedAt,
                lastAssistantMessageAt = parseTimestamp(item.string("lastAssistantMessageAt")),
                lastReviewedAt = parseTimestamp(item.string("lastReviewedAt")),
                workflowStateChangedAt = parseTimestamp(item.string("workflowStateChangedAt")),
                workflowState = workflowState,
                waitingAction = waitingAction,
                queuedMessagesJson = queuedMessagesJson(item, existing?.queuedMessagesJson),
            timelineProjectionVersion = existing?.timelineProjectionVersion ?: 2,
                pinned = (item["pinned"] as? JsonPrimitive)?.booleanOrNull == true,
            )
        }.filter { it.id.isNotBlank() }
        val canonicalById = canonical.associateBy { it.id }
        val acceptedIds = acceptedFirstTurnSessionIds.value + persistedSnapshots.keys
        val completedFirstTurns = mutableSetOf<String>()
        val reconciled = canonical.map { session ->
            if (session.id !in acceptedIds) return@map session
            val terminal = session.status.lowercase() in setOf("completed", "failed", "cancelled", "canceled")
            if (session.latestSeq > 0L || terminal) {
                completedFirstTurns += session.id
                return@map session
            }
            val retainedStatus = acceptedFirstTurnStatus(sessionStatusFromRaw(session.status) == SessionStatus.WaitingApproval)
            session.copy(status = retainedStatus).also { acceptedFirstTurnSnapshots[session.id] = it }
        }.toMutableList()
        for (sessionId in acceptedIds - canonicalById.keys) {
            val retained = acceptedFirstTurnSnapshots[sessionId] ?: persistedSnapshots[sessionId] ?: continue
            // A stale list can omit a just-accepted session. A definitive 404
            // is different: another device may have deleted it intentionally.
            val deleted = try {
                execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}"))
                false
            } catch (error: SessionRepositoryException) {
                error.statusCode == 404
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            if (!deleted) reconciled.add(retained) else completedFirstTurns += sessionId
        }
        dao.replaceSessions(reconciled)
        if (completedFirstTurns.isNotEmpty()) {
            completedFirstTurns.forEach(acceptedFirstTurnSnapshots::remove)
            acceptedFirstTurnSessionIds.update { it - completedFirstTurns }
        }
    }

    override suspend fun readSessionMetadataList(): List<SessionMetadataSnapshot> {
        val response = requestSessionList()
        if (response.body.toByteArray(Charsets.UTF_8).size > 2 * 1024 * 1024) throw SessionRepositoryException(413, "SESSION_METADATA_LIMIT", "Session metadata exceeds budget", false)
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        val items = root["sessions"] as? JsonArray ?: metadataInvalid()
        if (items.size > 2048) throw SessionRepositoryException(413, "SESSION_METADATA_LIMIT", "Session metadata exceeds budget", false)
        return items.map { metadataSnapshot(it as? JsonObject ?: metadataInvalid()) }
    }

    override suspend fun readSessionMetadata(sessionId: String): SessionMetadataSnapshot? {
        val response = try { execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}?view=summary")) }
        catch (error: SessionRepositoryException) { if (error.statusCode == 404) return null; throw error }
        if (response.body.toByteArray(Charsets.UTF_8).size > 64 * 1024) throw SessionRepositoryException(413, "SESSION_METADATA_LIMIT", "Session metadata exceeds budget", false)
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        return metadataSnapshot(root["session"] as? JsonObject ?: metadataInvalid())
    }

    override suspend fun readSessionMutationProtocol(): SessionMutationProtocol {
        val response = try { execute(ApiRequest("GET", "/api/session-mutation-contract")) }
        catch (error: SessionRepositoryException) {
            if (error.statusCode == 404) throw SessionRepositoryException(501, "SESSION_MUTATION_UNSUPPORTED", "Session mutations are unsupported", false)
            throw error
        }
        return decodeMutation<SessionMutationProtocol>(response.body)
    }

    override suspend fun readSessionMutationContext(sessionId: String): SessionMutationContext {
        require(sessionMutationIdentifier(sessionId, 256))
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/app-api-context"))
        return decodeMutation<SessionMutationContext>(response.body).validate().also {
            if (it.sessionId != sessionId) metadataInvalid()
        }
    }

    override suspend fun applySessionMutation(sessionId: String, command: SessionMutationCommand): SessionMutationReceipt {
        require(sessionMutationIdentifier(sessionId, 256)); command.validate()
        val body = SessionMutationJson.encodeToString(serializer<SessionMutationCommand>(), command)
        require(body.toByteArray(Charsets.UTF_8).size <= 8192)
        val response = execute(ApiRequest("POST", "/api/sessions/${encode(sessionId)}/app-api-mutations", body = body, contentType = "application/json"))
        return decodeMutation<SessionMutationReceipt>(response.body).validate().also {
            if (it.sessionId != sessionId || it.requestId != command.requestId || it.kind != command.kind ||
                it.projectId != command.expectedProjectId || it.scopeRevision != command.expectedScopeRevision) metadataInvalid()
        }
    }

    override suspend fun readSessionMutationReceipt(sessionId: String, requestId: String): SessionMutationReceipt? {
        require(sessionMutationIdentifier(sessionId, 256) && sessionMutationIdentifier(requestId, 200))
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/app-api-mutations/${encode(requestId)}"))
        return decodeMutation<SessionMutationReceipt?>(response.body)?.validate()?.also {
            if (it.sessionId != sessionId || it.requestId != requestId || it.duplicate) metadataInvalid()
        }
    }

    private inline fun <reified T> decodeMutation(body: String): T {
        if (body.toByteArray(Charsets.UTF_8).size > 16384)
            throw SessionRepositoryException(413, "SESSION_MUTATION_LIMIT", "Mutation response exceeds budget", false)
        return try { SessionMutationJson.decodeFromString(serializer<T>(), body) }
        catch (_: kotlinx.serialization.SerializationException) { metadataInvalid() }
    }

    private fun metadataInvalid(): Nothing =
        throw SessionRepositoryException(502, "SESSION_METADATA_INVALID", "Invalid Session metadata", false)

    private fun metadataSnapshot(item: JsonObject): SessionMetadataSnapshot {
        fun text(key: String, max: Int): String? = when (val field = item[key]) {
            null, JsonNull -> null
            is JsonPrimitive -> field.takeIf { it.isString && it.content.length <= max }?.content ?: metadataInvalid()
            else -> metadataInvalid()
        }
        val id = text("id", 256)?.takeIf { it.isNotBlank() && it.none(Char::isISOControl) } ?: metadataInvalid()
        val project = text("projectId", 256)?.also { if (it.isBlank() || it.any(Char::isISOControl)) metadataInvalid() }
        return SessionMetadataSnapshot(id, text("title", 8192) ?: text("name", 8192) ?: "Unnamed session", project,
            text("status", 64) ?: text("workflowState", 64) ?: "unknown",
            text("lastActivityAt", 64) ?: text("updatedAt", 64) ?: text("created", 64))
    }

    override suspend fun readSessionAccessContext(sessionId: String): SessionAccessContext? {
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}"))
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        val item = root["session"]?.jsonObject ?: root
        val id = (item["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?.takeIf { it.isNotBlank() } ?: return null
        val project = when (val field = item["projectId"]) {
            null, JsonNull -> null
            is JsonPrimitive -> field.takeIf { it.isString && it.content.isNotBlank() }?.content
                ?: throw SessionRepositoryException(502, "SESSION_SCOPE_INVALID", "Invalid Session project scope", false)
            else -> throw SessionRepositoryException(502, "SESSION_SCOPE_INVALID", "Invalid Session project scope", false)
        }
        return SessionAccessContext(id, project)
    }

    override suspend fun refreshSessionDetail(sessionId: String): Session? {
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}"))
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        val item = root["session"]?.jsonObject ?: root
        if (item.string("id").isNullOrBlank()) return null
        val initial = sessionEntityFromClientJson(item, dao.getSession(sessionId), authoritative = true)
        val runId = sessionRunId(item)
        val terminalSession = hasTerminalSessionDetail(item) ||
            (!isAcceptedFirstTurnStatus(initial.status) && isAuthoritativelyIdleSession(item))
        val activity = item["activity"] as? JsonObject
        val activityRun = activity?.get("run") as? JsonObject
        val activityRunState = (activityRun?.get("state") ?: activityRun?.get("status"))
            ?.let { (it as? JsonPrimitive)?.contentOrNull?.lowercase() }
        val terminalActivityRun = activityRunState in TERMINAL_RUN_ACTIVITY_STATES
        val entity = initial.copy(
            status = if (terminalActivityRun) initial.status else preservePendingApprovalStatus(sessionId, initial.status, runId),
            waitingAction = if (terminalSession) null else initial.waitingAction,
            workflowState = if (terminalSession && item.string("workflowState").isNullOrBlank()) null else initial.workflowState,
        )
        val activityRequestId = ((activity?.get("requestId") ?: activity?.get("turnId")
            ?: activityRun?.get("requestId") ?: activityRun?.get("turnId")) as? JsonPrimitive)?.contentOrNull
        val terminalRunIds = if (terminalSession) {
            verifyTerminalApprovalRuns(sessionId, runId.takeIf { terminalActivityRun }, dao.getPendingApprovals(sessionId))
        } else emptySet()
        database.withTransaction {
            dao.upsertSessions(listOf(entity))
            when {
                terminalSession -> retirePendingApprovals(sessionId, runIds = terminalRunIds, unscoped = true)
                terminalActivityRun -> retirePendingApprovals(sessionId, runId = runId, requestId = activityRequestId)
            }
        }
        val result = toDomain(entity)
        if (result.status in setOf(SessionStatus.Completed, SessionStatus.Failed, SessionStatus.Cancelled, SessionStatus.Idle)) {
            liveFeedMuted.remove(sessionId)
        }
        return result
    }

    private fun sessionRunId(item: JsonObject): String? {
        val run = (item["activity"] as? JsonObject)?.get("run") as? JsonObject
        return (run?.string("runId") ?: run?.string("id") ?: item.string("runId") ?: item.string("currentRunId"))
            ?.takeIf { it.isNotBlank() }
    }

    private suspend fun preservePendingApprovalStatus(sessionId: String, status: String, runId: String?): String {
        if (sessionId.isBlank() || sessionStatusFromRaw(status) != SessionStatus.Working) return status
        return if (dao.getPendingApprovals(sessionId).any { approval ->
                runId == null || approval.runId.isNullOrBlank() || approval.runId == runId
            }) if (isAcceptedFirstTurnStatus(status)) ACCEPTED_FIRST_TURN_WAITING_STATUS else "waiting_approval" else status
    }

    private suspend fun verifyTerminalApprovalRuns(
        sessionId: String,
        knownTerminalRunId: String?,
        pending: List<ApprovalEntity>,
    ): Set<String> {
        val runIds = pending.mapNotNull { it.runId?.takeIf(String::isNotBlank) }.distinct()
        val verified = linkedSetOf<String>()
        knownTerminalRunId?.takeIf { it in runIds }?.let(verified::add)
        val now = android.os.SystemClock.elapsedRealtime()
        if (terminalApprovalRecoveryAttempts[sessionId]?.let { now - it < 5_000L } == true) return verified
        terminalApprovalRecoveryAttempts[sessionId] = now
        val candidates = runIds.filterNot { it in verified }
        if (candidates.isEmpty()) return verified
        val start = (terminalApprovalRecoveryOffsets[sessionId] ?: 0) % candidates.size
        val selected = (candidates.drop(start) + candidates.take(start)).take((8 - verified.size).coerceAtLeast(0))
        terminalApprovalRecoveryOffsets[sessionId] = (start + selected.size) % candidates.size
        for (runId in selected) {
            try {
                val run = loadRunProjection(runId)
                val state = (run["state"] as? JsonPrimitive)?.contentOrNull?.lowercase()
                if ((run["id"] as? JsonPrimitive)?.contentOrNull == runId &&
                    (run["sessionId"] as? JsonPrimitive)?.contentOrNull == sessionId &&
                    state in TERMINAL_RUN_ACTIVITY_STATES
                ) verified += runId
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A failed status lookup is not proof that a request is stale.
            }
        }
        return verified
    }

    override suspend fun refreshEvents(sessionId: String): RefreshResult {
        return sessionSyncMutex(sessionId).withLock { refreshEventsLocked(sessionId) }
    }

    override fun observeTargetSummary(): Flow<TargetSummary?> {
        val id = targetId?.trim().orEmpty()
        if (id.isBlank()) return flow { emit(null) }
        return observeRows(dao.observeTargetRuntimeSummary(id)).map { entity -> entity?.let(targetSummaryFromEntity(codec)) }
    }

    override suspend fun refreshTargetSummary(): TargetSummary? = targetSummaryRefreshMutex.withLock {
        val response = execute(ApiRequest("GET", "/api/runtime/summary"))
        val summary = codec.decode(serializer<TargetSummary>(), response.body).validate()
        val effectiveTargetId = targetId?.trim().takeUnless { it.isNullOrBlank() } ?: summary.targetId
        val cursor = dao.getTargetRuntimeSummaryCursor(effectiveTargetId)?.cursor ?: 0L
        val eventsResponse = execute(ApiRequest(
            "GET",
            "/api/runtime/summary/events?afterCursor=$cursor&limit=100",
        ))
        val page = codec.decode(serializer<TargetSummaryEventsPage>(), eventsResponse.body)
        val syncResult = TargetSummarySyncEngine(effectiveTargetId, targetSummaryLedger).apply(page.events)
        if (syncResult is TargetSummarySyncResult.InvalidEvent) {
            throw SessionRepositoryException(502, "TARGET_SUMMARY_EVENT_INVALID", syncResult.reason, retryable = false)
        }
        if (syncResult is TargetSummarySyncResult.GapDetected) {
            // The page is bounded. Keep the direct summary visible while the
            // next refresh starts from the durable cursor and can recover.
            targetSummaryLedger.saveSnapshot(summary, effectiveTargetId)
            return@withLock summary
        }
        targetSummaryLedger.saveSnapshot(summary, effectiveTargetId)
        summary
    }

    override suspend fun refreshTimeline(sessionId: String): RefreshResult = sessionSyncMutex(sessionId).withLock {
        // Opening an idle/new conversation must not wait fifteen seconds for
        // a future event before enabling its composer. Background sync owns waits.
        val durableResult = refreshEventsLocked(sessionId, waitForEvents = false)
        if (durableResult is RefreshResult.ResetRequired) return@withLock durableResult
        refreshVisibleTimelineLocked(sessionId)
    }

    override suspend fun loadOlderTimeline(sessionId: String): RefreshResult = sessionSyncMutex(sessionId).withLock {
        val current = timelinePagingState.value[sessionId] ?: TimelinePagingState()
        val beforeSeq = current.nextBeforeSeq
        if (current.loadingOlder || !current.hasOlder || beforeSeq == null || beforeSeq <= 1L) {
            return@withLock RefreshResult.Applied(0, current.latestSeq)
        }
        timelinePagingState.update { it + (sessionId to current.copy(loadingOlder = true, error = null)) }
        try {
            val response = execute(ApiRequest(
                "GET",
                visibleEventPagePath(sessionId, beforeSeq),
            ))
            val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
            if (page.resetRequired) {
                timelinePagingState.update { it + (sessionId to current.copy(loadingOlder = false, error = page.reason)) }
                return@withLock RefreshResult.ResetRequired(page.reason)
            }
            val existing = visibleTimelineEvents[sessionId].orEmpty()
            val merged = (existing + page.events)
                .filter { it.boundarySeq() > 0L }
                .distinctBy { it.dedupeKey() ?: "fingerprint:${it.sessionEventFingerprint()}" }
                .sortedBy { it.boundarySeq() }
            visibleTimelineEvents[sessionId] = merged
            updateVisibleTimelineProjection(sessionId, merged)
            val nextBefore = page.pagination?.nextBeforeSeq ?: page.pagination?.oldestSeq
            val hasOlder = page.pagination?.hasMoreBefore == true && nextBefore != null && nextBefore < beforeSeq
            timelinePagingState.update { it + (sessionId to current.copy(
                loadingOlder = false,
                hasOlder = hasOlder,
                nextBeforeSeq = nextBefore,
                latestSeq = maxOf(current.latestSeq, page.latestSeq ?: merged.maxOfOrNull { it.boundarySeq() } ?: 0L),
                error = null,
            )) }
            RefreshResult.Applied(page.events.size, page.latestSeq ?: current.latestSeq)
        } catch (error: Throwable) {
            timelinePagingState.update { it + (sessionId to current.copy(loadingOlder = false, error = error.message)) }
            throw error
        }
    }

    override suspend fun applyLiveEvents(sessionId: String, events: List<SessionEventDto>): RefreshResult =
        applyLiveEventsLocked(sessionId, events)

    private suspend fun applyLiveEventsLocked(sessionId: String, events: List<SessionEventDto>): RefreshResult = liveProjectionMutex.withLock {
        if (events.isEmpty()) return@withLock RefreshResult.Applied(0, dao.getCursor(sessionId)?.lastAppliedSeq ?: 0L)
        val incomingArtifacts = events.filter { event ->
            val type = event.type.orEmpty().lowercase()
            type == "plan" || event.planId != null || event.artifactId != null
        }
        if (incomingArtifacts.isNotEmpty()) {
            val artifacts = durableArtifactState.value[sessionId].orEmpty().toMutableList()
            incomingArtifacts.forEach { incoming ->
                val identity = incoming.planId ?: incoming.artifactId ?: incoming.entityId ?: incoming.id
                val index = artifacts.indexOfFirst { existing ->
                    (existing.planId ?: existing.artifactId ?: existing.entityId ?: existing.id) == identity
                }
                if (index >= 0) artifacts[index] = incoming else artifacts += incoming
            }
            durableArtifactState.update { it + (sessionId to artifacts) }
        }
            val projector = liveProjectors.getOrPut(sessionId) { LiveTimelineProjector() }
            val durableMessages = dao.getMessages(sessionId)
            projector.reconcileDurableCursor(
                dao.getCursor(sessionId)?.lastAppliedSeq ?: 0L,
                durableMessages.associate { it.id to it.content },
                durableMessages.filter { it.completed }.mapTo(mutableSetOf()) { it.id },
            )
            val result = withContext(Dispatchers.Default) {
                projector.apply(events)
            }
            if (android.util.Log.isLoggable("AgentoCLive", android.util.Log.DEBUG)) {
                android.util.Log.d("AgentoCLive", "projection session=${sessionId.hashCode()} durable=${dao.getCursor(sessionId)?.lastAppliedSeq ?: 0} messages=${result.events.filter { it.messageState != null }.take(4).map { "${it.messageState}:${it.text?.length ?: 0}" }} invalid=${result.invalidEvent?.type} gap=${result.gapExpectedSeq}")
            }
            liveTimelineState.value = liveTimelineState.value + (sessionId to result.events)
            val invalidEvent = result.invalidEvent
            val gapExpectedSeq = result.gapExpectedSeq
            return@withLock when {
                invalidEvent != null -> RefreshResult.Gap(result.latestSeq + 1L, invalidEvent.boundarySeq())
                gapExpectedSeq != null -> RefreshResult.Gap(gapExpectedSeq, result.latestSeq + 1L)
                else -> RefreshResult.Applied(events.size, result.latestSeq)
            }
    }

    private suspend fun rebuildLegacyTimeline(sessionId: String) {
        // Network IO and staging never remove the offline copy. Only a fully
        // validated, fixed high-water prefix may replace that copy atomically.
        dao.clearStagedMessages(sessionId)
        var after = 0L
        var watermark: Long? = null
        var lastEventId: String? = null
        while (true) {
            val response = requestDurableEventPage(eventPagePath(sessionId, after, waitForEvents = false))
            val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
            check(!page.resetRequired) { "Timeline history requires reset: ${page.reason}" }
            if (watermark == null) watermark = page.latestSeq
                ?: dao.getSession(sessionId)?.latestSeq
                ?: page.events.maxOfOrNull { it.boundarySeq() } ?: 0L
            val events = page.events.filter { it.boundarySeq() <= watermark!! }
            if (events.isEmpty()) {
                check(after >= watermark!!) { "Incomplete timeline rebuild at $after of $watermark" }
                break
            }
            for (event in events) {
                check(event.startingSeq() <= after + 1 && event.boundarySeq() > after) {
                    "Timeline rebuild gap at ${after + 1}"
                }
                if (event.isTimelineMessage()) {
                    val old = dao.getStagedMessage(sessionId, event.messageProjectionId())
                    val previous = old?.let { ProjectedMessage(it.id, it.role, it.content,
                        it.seq, it.lastEventSeq, it.revision, it.messageState, it.requestId, it.runId, it.messagePhase) }
                    val next = reduceMessage(previous, event, event.boundarySeq())
                    dao.upsertStagedMessage(TimelineMessageStagingEntity(sessionId, next.id,
                        next.role, next.text, next.firstSeq, next.lastEventSeq, next.revision,
                        next.state, next.requestId, next.runId, next.messagePhase))
                }
                event.terminalRunState()?.let { terminal ->
                    dao.settleStagedMessages(sessionId, event.runId, event.requestId, terminal)
                }
                after = event.boundarySeq()
                lastEventId = event.dedupeKey()
            }
            if (after >= watermark!!) break
        }
        database.withTransaction {
            dao.deleteSessionMessages(sessionId)
            dao.publishStagedMessages(sessionId, System.currentTimeMillis())
            dao.deleteSessionEventProjection(sessionId)
            dao.upsertCursor(SyncCursorEntity(sessionId, after, lastEventId, updatedAt = System.currentTimeMillis()))
            dao.markTimelineProjectionCurrent(sessionId)
            dao.clearStagedMessages(sessionId)
        }
        liveProjectionMutex.withLock {
            liveProjectors.remove(sessionId)
            liveTimelineState.value = liveTimelineState.value - sessionId
        }
        visibleTimelineEvents.remove(sessionId)
        visibleTimelineState.update { it - sessionId }
    }

    private suspend fun refreshEventsLocked(sessionId: String, waitForEvents: Boolean = transport.requiresEventPolling && sessionId !in dedicatedLiveSessions): RefreshResult {
        if (dao.getSession(sessionId)?.timelineProjectionVersion == 0) rebuildLegacyTimeline(sessionId)
        val cursor = dao.getCursor(sessionId)
        val afterSeq = cursor?.lastAppliedSeq ?: 0L
        val response = requestDurableEventPage(eventPagePath(sessionId, afterSeq, waitForEvents = waitForEvents))
        val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
        if (android.util.Log.isLoggable("AgentoCLive", android.util.Log.DEBUG)) {
            android.util.Log.d("AgentoCLive", "page session=${sessionId.hashCode()} live=${page.liveCursor} reset=${page.liveResetRequired} frames=${page.liveEvents.size} durable=${page.events.size}")
        }
        if (page.resetRequired) return RefreshResult.ResetRequired(page.reason)
        (page.runActivity as? JsonObject)?.let { activity ->
            runActivityState.update { it + (sessionId to activity) }
        }
        val engine = SessionSyncEngine(
            scope = sessionId,
            cursorStore = RoomCursorStore(dao),
            eventSink = RoomEventSink(database, dao),
            replayProvider = ReplayProvider { scope, applied, _ ->
                val replayResponse = requestDurableEventPage(eventPagePath(scope, applied, waitForEvents = false))
                codec.decode(serializer<SessionEventsPageDto>(), replayResponse.body).events
            },
        )
        return when (val result = engine.apply(
            page.events,
            CursorMetadata(page.serverCursor, page.snapshotVersion),
        )) {
            is SyncResult.Applied -> {
                val activitySnapshot = page.runActivity as? JsonObject
                val activityState = listOf("state", "status", "runState")
                    .firstNotNullOfOrNull { key -> (activitySnapshot?.get(key) as? JsonPrimitive)?.contentOrNull }
                    ?.lowercase()
                if (activityState in TERMINAL_RUN_ACTIVITY_STATES) {
                    val activityRunId = ((activitySnapshot?.get("runId") ?: activitySnapshot?.get("id")) as? JsonPrimitive)?.contentOrNull
                    val activityRequestId = ((activitySnapshot?.get("requestId") ?: activitySnapshot?.get("turnId")) as? JsonPrimitive)?.contentOrNull
                    if (!activityRunId.isNullOrBlank() || !activityRequestId.isNullOrBlank()) {
                        database.withTransaction {
                            retirePendingApprovals(sessionId, runId = activityRunId, requestId = activityRequestId)
                        }
                    } else {
                        try {
                            refreshSessionDetail(sessionId)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            // A later durable event or idle reconciliation retries this fallback.
                        }
                    }
                }
                val artifacts = durableArtifactState.value[sessionId].orEmpty().toMutableList()
                page.events.filter { event ->
                    val type = event.type.orEmpty().lowercase()
                    type == "plan" || event.planId != null || event.artifactId != null
                }.forEach { incoming ->
                    val identity = incoming.planId ?: incoming.artifactId ?: incoming.entityId ?: incoming.id
                    val index = artifacts.indexOfFirst { existing ->
                        (existing.planId ?: existing.artifactId ?: existing.entityId ?: existing.id) == identity
                    }
                    if (index >= 0) artifacts[index] = incoming else artifacts += incoming
                }
                durableArtifactState.update { it + (sessionId to artifacts) }
                liveProjectionMutex.withLock { liveProjectors[sessionId]?.let { projector ->
                    val durableMessages = dao.getMessages(sessionId)
                    projector.reconcileDurableCursor(
                        result.cursor.lastAppliedSeq,
                        durableMessages.associate { it.id to it.content },
                        durableMessages.filter { it.completed }.mapTo(mutableSetOf()) { it.id },
                        page.events.filter { it.terminalRunState() != null }.mapNotNullTo(mutableSetOf()) { it.runId?.takeIf(String::isNotBlank) },
                    )
                    liveTimelineState.value = liveTimelineState.value + (sessionId to projector.snapshotEvents())
                } }
                // The durable message store does not retain tool operations. Refresh
                // the server's canonical visible projection when they change so
                // advancing the durable cursor cannot make tool cards disappear.
                if (page.events.any { event ->
                        event.type.orEmpty().lowercase() in setOf("tool_use", "tool_call", "tool_result", "operation", "file_change")
                    }) pendingVisibleOperationRefresh += sessionId
                if (sessionId in pendingVisibleOperationRefresh) {
                    try {
                        if (refreshVisibleTimelineLocked(sessionId, preserveLoadedHistory = true) is RefreshResult.Applied) {
                            pendingVisibleOperationRefresh -= sessionId
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // The durable cursor is already committed. A transient
                        // history failure must not prevent subsequent syncing.
                    }
                }
                // Background sessions need the same recovery as an opened
                // conversation when an old cursor skipped its pending event.
                // A missing row is not evidence that an approval was granted.
                val activity = page.runActivity as? JsonObject
                val waitingForApproval = (activity?.get("actionRequired") as? JsonPrimitive)?.booleanOrNull == true &&
                    (activity["kind"] as? JsonPrimitive)?.contentOrNull == "approval"
                val now = android.os.SystemClock.elapsedRealtime()
                val pendingApprovals = if (waitingForApproval) dao.getPendingApprovals(sessionId) else emptyList()
                val sourceSeq = (activity?.get("sourceSeq") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
                val runId = (activity?.get("runId") as? JsonPrimitive)?.contentOrNull
                val currentApproval = pendingApprovals.firstOrNull { approval ->
                    sourceSeq != null && approval.approvalSourceSequence() == sourceSeq &&
                        (runId.isNullOrBlank() || approval.runId == runId)
                }
                val needsRecovery = currentApproval == null || currentApproval.needsExplanationRecovery()
                val recoveryInterval = if (currentApproval == null) 5_000L else 300_000L
                if (waitingForApproval && needsRecovery &&
                    (approvalRecoveryAttempts[sessionId]?.let { now - it >= recoveryInterval } != false)) {
                    approvalRecoveryAttempts[sessionId] = now
                    try {
                        recoverVisiblePendingApproval(sessionId, page)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // A transient failure must not stop durable syncing;
                        // another poll retries recovery after the cooldown.
                    }
                }
                // A legacy pending approval can keep session metadata in a
                // waiting state even after its run has ended. Do not gate this
                // recovery on runActivity being idle: verify each exact run
                // before retiring its approvals, so stale activity cannot
                // resurrect an approval after a reconnect or cursor migration.
                if ((terminalApprovalRecoveryAttempts[sessionId]?.let { now - it >= 5_000L } != false)) {
                    val pending = dao.getPendingApprovals(sessionId)
                    if (pending.isNotEmpty()) {
                        terminalApprovalRecoveryAttempts[sessionId] = now
                        val runs = pending.mapNotNull { it.runId?.takeIf(String::isNotBlank) }.distinct()
                        val start = if (runs.isEmpty()) 0 else (terminalApprovalRecoveryOffsets[sessionId] ?: 0) % runs.size
                        val selected = if (runs.isEmpty()) emptyList() else
                            (runs.drop(start) + runs.take(start)).take(8)
                        terminalApprovalRecoveryOffsets[sessionId] = if (runs.isEmpty()) 0 else (start + selected.size) % runs.size
                        for (runId in selected) {
                            try {
                                val run = loadRunProjection(runId)
                                val state = (run["state"] as? JsonPrimitive)?.contentOrNull?.lowercase()
                                if ((run["id"] as? JsonPrimitive)?.contentOrNull == runId &&
                                    (run["sessionId"] as? JsonPrimitive)?.contentOrNull == sessionId &&
                                    state in setOf("completed", "failed", "cancelled", "canceled", "interrupted")) {
                                    database.withTransaction {
                                        val stale = dao.getPendingApprovals(sessionId).filter { it.runId == runId }
                                        if (stale.isNotEmpty()) dao.upsertApprovals(stale.map {
                                            it.copy(status = "resolved", updatedAt = System.currentTimeMillis())
                                        })
                                    }
                                }
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) { /* Retry on a later sync. */ }
                        }
                        if (pending.any { it.runId.isNullOrBlank() }) {
                            // A stale approval without run identity cannot be
                            // safely matched to a run endpoint. The session
                            // detail is the authoritative fallback; a terminal
                            // session retires the remaining requests.
                            try {
                                refreshSessionDetail(sessionId)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) { /* Retry on a later sync. */ }
                        }
                    }
                }
                RefreshResult.Applied(result.count, result.cursor.lastAppliedSeq)
            }
            is SyncResult.GapDetected -> RefreshResult.Gap(result.expectedSeq, result.receivedSeq)
            is SyncResult.InvalidEvent -> RefreshResult.Gap(result.event.boundarySeq(), result.event.boundarySeq())
        }.also { applyLivePage(sessionId, page) }
    }

    private suspend fun applyLivePage(sessionId: String, page: SessionEventsPageDto) {
            val streamId = page.liveStreamId
            val liveCursor = page.liveCursor
            if (streamId != null && liveCursor != null) {
                if (!streamId.matches(Regex("^[a-f0-9-]{36}$")) || liveCursor < 0 || page.liveEvents.size > 128) {
                    throw SessionRepositoryException(502, "SESSION_LIVE_INVALID", "Invalid live event page", false)
                }
                liveFeedCapable.add(sessionId)
                if (page.liveResetRequired) {
                    // A missing token prefix cannot be presented as a complete
                    // answer. Use durable history until this run settles.
                    liveFeedMuted.add(sessionId)
                    liveProjectionMutex.withLock {
                        liveProjectors.remove(sessionId)
                        liveTimelineState.value = liveTimelineState.value + (sessionId to emptyList())
                    }
                } else if (sessionId !in liveFeedMuted && page.liveEvents.isNotEmpty()) {
                    val live = applyLiveEventsLocked(sessionId, page.liveEvents)
                    if (live is RefreshResult.Gap) throw SessionRepositoryException(502,
                        "SESSION_LIVE_INVALID", "Live event sequence needs reconciliation", false)
                }
                liveFeedCursors[sessionId] = streamId to liveCursor
            }
    }

    private suspend fun requestDurableEventPage(path: String): com.andysagent.agentoc.core.network.ApiResponse = try {
        execute(ApiRequest("GET", path))
    } catch (error: SessionRepositoryException) {
        if (error.statusCode != 403 || error.code != "temporary_control_route_denied") throw error
        execute(ApiRequest("GET", path.replace("&compact=1", "")))
    }

    private fun eventPagePath(sessionId: String, afterSeq: Long, waitForEvents: Boolean): String {
        val route = if (waitForEvents) {
            "/api/sessions/${encode(sessionId)}/events/wait"
        } else {
            "/api/sessions/${encode(sessionId)}/events"
        }
        val live = liveFeedCursors[sessionId]
        val waitQuery = if (waitForEvents) "&timeoutMs=15000&includeLive=1&liveAfterCursor=${live?.second ?: 0}" +
            (live?.first?.let { "&liveStreamId=${encode(it)}" } ?: "") else ""
        return "$route?filter=all&limit=200&afterSeq=$afterSeq&direction=forward&compact=1$waitQuery"
    }

    private suspend fun refreshVisibleTimelineLocked(sessionId: String, preserveLoadedHistory: Boolean = false): RefreshResult {
        val response = execute(ApiRequest("GET", visibleEventPagePath(sessionId, null)))
        val page = codec.decode(serializer<SessionEventsPageDto>(), response.body)
        (page.runActivity as? JsonObject)?.let { activity ->
            runActivityState.update { it + (sessionId to activity) }
        }
        recoverVisiblePendingApproval(sessionId, page)
        if (page.resetRequired) {
            timelinePagingState.update { it + (sessionId to TimelinePagingState(error = page.reason)) }
            return RefreshResult.ResetRequired(page.reason)
        }
        val events = page.events
            .filter { it.boundarySeq() > 0L }
            .distinctBy { it.dedupeKey() ?: "fingerprint:${it.sessionEventFingerprint()}" }
            .sortedBy { it.boundarySeq() }
        val firstNewSeq = events.minOfOrNull { it.startingSeq() }
        val older = if (preserveLoadedHistory && firstNewSeq != null) {
            visibleTimelineEvents[sessionId].orEmpty().filter { it.boundarySeq() < firstNewSeq }
        } else emptyList()
        val merged = older + events
        visibleTimelineEvents[sessionId] = merged
        updateVisibleTimelineProjection(sessionId, merged)
        val nextBefore = page.pagination?.nextBeforeSeq ?: page.pagination?.oldestSeq
        val latestSeq = page.latestSeq ?: events.maxOfOrNull { it.boundarySeq() } ?: 0L
        val priorPaging = timelinePagingState.value[sessionId]
        timelinePagingState.update { it + (sessionId to TimelinePagingState(
            hasOlder = if (older.isNotEmpty() && priorPaging != null) priorPaging.hasOlder else page.pagination?.hasMoreBefore == true && nextBefore != null && nextBefore > 1L,
            nextBeforeSeq = if (older.isNotEmpty() && priorPaging != null) priorPaging.nextBeforeSeq else nextBefore,
            latestSeq = latestSeq,
        )) }
        return RefreshResult.Applied(events.size, latestSeq)
    }

    // A history migration can advance the durable cursor without materializing
    // old approval rows. Recover only the exact request the server identifies
    // as currently waiting; never reopen a locally resolved request.
    private suspend fun recoverVisiblePendingApproval(sessionId: String, page: SessionEventsPageDto) {
        if (page.resetRequired || page.sessionId != sessionId) return
        val activity = page.runActivity as? JsonObject ?: return
        if ((activity["actionRequired"] as? JsonPrimitive)?.booleanOrNull != true ||
            (activity["kind"] as? JsonPrimitive)?.contentOrNull != "approval") return
        val sourceSeq = (activity["sourceSeq"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: return
        fun findRequest(events: List<SessionEventDto>) = events.firstOrNull {
            it.type == "approval_request" && it.boundarySeq() == sourceSeq &&
                !it.approvalId.isNullOrBlank() && !it.runId.isNullOrBlank() &&
                it.status.orEmpty().lowercase() !in setOf("approved", "denied", "declined", "cancelled", "canceled", "resolved")
        }
        // The visible projection may fold an approval into an operation, or
        // the request may be outside its page. Fetch the durable source event.
        val request = findRequest(page.events) ?: run {
            val response = requestDurableEventPage(eventPagePath(sessionId, sourceSeq - 1, waitForEvents = false))
            val durable = codec.decode(serializer<SessionEventsPageDto>(), response.body)
            if (durable.resetRequired || durable.sessionId != sessionId) return
            val activityResponse = execute(ApiRequest("GET", visibleEventPagePath(sessionId, null)))
            val activityPage = codec.decode(serializer<SessionEventsPageDto>(), activityResponse.body)
            val current = activityPage.runActivity as? JsonObject ?: return
            if (activityPage.resetRequired || activityPage.sessionId != sessionId ||
                (current["actionRequired"] as? JsonPrimitive)?.booleanOrNull != true ||
                (current["kind"] as? JsonPrimitive)?.contentOrNull != "approval" ||
                (current["sourceSeq"] as? JsonPrimitive)?.contentOrNull?.toLongOrNull() != sourceSeq) return
            findRequest(durable.events) ?: return
        }
        database.withTransaction {
            val existing = dao.getApproval(sessionId, request.approvalId!!)
            if (existing == null) {
                RoomEventSink(database, dao).apply(sessionId, request)
            } else if (existing.status == "pending" && existing.runId == request.runId) {
                val original = runCatching { existing.detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it) as? JsonObject } }.getOrNull() ?: JsonObject(emptyMap())
                val restored = original.toMutableMap()
                restored["sourceSeq"] = JsonPrimitive(request.boundarySeq())
                if (existing.needsExplanationRecovery() && request.explanation.toApprovalExplanation() != null) {
                    restored["explanation"] = request.explanation!!
                }
                val details = JsonObject(restored).toString()
                if (details != existing.detailsJson) dao.upsertApprovals(listOf(existing.copy(detailsJson = details)))
            }
        }
    }

    private fun updateVisibleTimelineProjection(sessionId: String, events: List<SessionEventDto>) {
        val projector = LiveTimelineProjector()
        val projectedEvents = projector.projectPage(events)
        val projectedItems = TimelineProjector.project(emptyList(), projectedEvents)
        visibleTimelineState.update { it + (sessionId to projectedItems) }
    }

    private fun visibleEventPagePath(sessionId: String, beforeSeq: Long?): String = buildString {
        append("/api/sessions/${encode(sessionId)}/events?filter=visible&limit=50")
        if (beforeSeq != null) append("&direction=before&beforeSeq=$beforeSeq")
        else append("&direction=latest")
    }

    override suspend fun sendMessage(sessionId: String, text: String, requestId: String) {
        val body = codec.encode(serializer<SendMessageRequestDto>(), SendMessageRequestDto(text, requestId))
        val path = "/api/sessions/${encode(sessionId)}/messages"
        executePending(sessionId, requestId, "send_message", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
        refreshSessionDetail(sessionId)
    }

    override suspend fun sendMessage(
        sessionId: String,
        text: String,
        selection: RuntimeSelection,
        requestId: String,
        agentId: String?,
        attachments: List<OutboundAttachment>,
        harnessCapabilityIds: List<String>,
    ) {
        val path = "/api/sessions/${encode(sessionId)}/messages"
        if (attachments.isEmpty()) {
            val body = encodeMessage(
                text = text,
                requestId = requestId,
                selection = selection,
                agentId = agentId,
                attachments = emptyList(),
                harnessCapabilityIds = harnessCapabilityIds,
            )
            executePending(sessionId, requestId, "send_message", path, body) {
                execute(ApiRequest("POST", path, body, requestId, requestId))
            }
            refreshSessionDetail(sessionId)
            return
        }

        // Uploads are a multi-request transaction. Persist the source URI and
        // every finalized asset id before starting it, so a process death after
        // upload but before message POST can resume with the same refs instead
        // of silently losing the user's message or creating duplicate assets.
        withPendingOperationClaim(requestId) {
            var operation = PendingOperationEntity(
                requestId = requestId,
                kind = "send_message_with_attachments",
                path = path,
                payload = encodeAttachmentSendCommand(sessionId, text, requestId, selection, agentId, attachments, harnessCapabilityIds),
                state = "pending",
                createdAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis(),
                method = "POST",
                idempotencyKey = requestId,
            )
            dao.upsertOperation(operation)
            try {
                val materialized = materializePendingAttachments(operation)
                operation = materialized.first
                val body = encodeMessage(
                    text = text,
                    requestId = requestId,
                    selection = selection,
                    agentId = agentId,
                    attachments = materialized.second,
                    harnessCapabilityIds = harnessCapabilityIds,
                )
                dao.upsertOperation(operation.copy(state = "sending", updatedAt = System.currentTimeMillis()))
                execute(ApiRequest("POST", path, body, requestId, requestId))
                markFirstTurnAccepted(sessionId)
                dao.deleteOperation(requestId)
            } catch (error: Throwable) {
                val recoverable = dao.getPendingOperation(requestId) ?: operation
                dao.upsertOperation(recoverable.copy(state = "pending", updatedAt = System.currentTimeMillis(), lastError = error.message))
                throw error
            }
        }
        runCatching { refreshSessionDetail(sessionId) }
    }

    private suspend fun markFirstTurnAccepted(sessionId: String) = sessionListRefreshMutex.withLock {
        val candidate = firstTurnCandidates.remove(sessionId)
        val current = dao.getSession(sessionId) ?: candidate ?: return@withLock
        if (current.latestSeq > 0L) return@withLock
        val retained = current.copy(status = acceptedFirstTurnStatus(sessionStatusFromRaw(current.status) == SessionStatus.WaitingApproval))
        acceptedFirstTurnSnapshots[sessionId] = retained
        acceptedFirstTurnSessionIds.update { it + sessionId }
        dao.upsertSessions(listOf(retained))
    }

    override suspend fun updateQueuedFollowUp(
        sessionId: String,
        action: QueuedFollowUpAction,
        requestId: String?,
    ): Session? {
        require(action == QueuedFollowUpAction.Clear || !requestId.isNullOrBlank()) {
            "requestId is required for a queued follow-up mutation"
        }
        val operationRequestId = newRequestId()
        val path = "/api/sessions/${encode(sessionId)}/queue"
        val body = codec.encode(
            serializer<QueueMutationRequestDto>(),
            QueueMutationRequestDto(action.wireValue, requestId),
        )
        val response = executePendingResponse(sessionId, operationRequestId, "queue_${action.wireValue}", path, body) {
            execute(ApiRequest("POST", path, body, operationRequestId, operationRequestId))
        }
        return persistQueueMutationSession(response.body, sessionId)
    }

    override suspend fun steerQueuedFollowUp(sessionId: String, requestId: String): QueueMutationResult {
        require(requestId.isNotBlank()) { "Queued follow-up request id must not be blank" }
        val operationRequestId = newRequestId()
        val path = "/api/sessions/${encode(sessionId)}/queue"
        val body = codec.encode(
            serializer<QueueMutationRequestDto>(),
            QueueMutationRequestDto("steer", requestId),
        )
        val response = executePendingResponse(sessionId, operationRequestId, "queue_steer", path, body) {
            execute(ApiRequest("POST", path, body, operationRequestId, operationRequestId))
        }
        val payload = codec.decode(serializer<QueueMutationResponseDto>(), response.body)
        val session = payload.session?.let { persistSessionJson(it, sessionId) }
            ?: refreshSessionDetail(sessionId)
        return QueueMutationResult(
            session = session,
            requestId = payload.requestId ?: requestId,
            steered = payload.steered,
            pendingCancel = payload.pendingCancel,
            interruptedRunId = payload.interruptedRunId,
            queued = payload.queued,
        )
    }

    private fun encodeMessage(
        text: String,
        requestId: String,
        selection: RuntimeSelection,
        agentId: String?,
        attachments: List<AttachmentItemDto>,
        harnessCapabilityIds: List<String> = emptyList(),
    ): String = codec.encode(
        serializer<SendMessageRequestDto>(),
        SendMessageRequestDto(
            text = text,
            requestId = requestId,
            tool = selection.tool,
            providerProfile = selection.providerProfile,
            model = selection.model,
            effort = selection.effort,
            serviceTier = selection.serviceTier,
            agentId = agentId,
            interactionMode = selection.interactionMode,
            permissionMode = selection.permissionMode,
            planAction = selection.planAction,
            planId = selection.planId,
            harnessCapabilityIds = harnessCapabilityIds,
            attachments = attachments,
        ),
    )

    private fun encodeEditedMessage(
        parentRequestId: String,
        prompt: String,
        requestId: String,
        selection: RuntimeSelection,
        attachments: List<AttachmentItemDto>,
    ): String = codec.encode(
        serializer<ResendEditedMessageRequestDto>(),
        ResendEditedMessageRequestDto(
            requestId = parentRequestId,
            prompt = prompt,
            newRequestId = requestId,
            tool = selection.tool.takeIf { it.isNotBlank() },
            model = selection.model,
            effort = selection.effort,
            serviceTier = selection.serviceTier,
            interactionMode = selection.interactionMode,
            permissionMode = selection.permissionMode,
            planAction = selection.planAction,
            planId = selection.planId,
            attachments = attachments,
        ),
    )

    private fun selectionFromAttachmentPayload(payload: JsonObject): RuntimeSelection = RuntimeSelection(
        tool = payload.string("tool").orEmpty(),
        providerProfile = payload.string("providerProfile"),
        model = payload.string("model"),
        effort = payload.string("effort"),
        serviceTier = payload.string("serviceTier") ?: "standard",
        interactionMode = payload.string("interactionMode") ?: "agent",
        permissionMode = payload.string("permissionMode"),
        planAction = payload.string("planAction"),
        planId = payload.string("planId"),
    )

    private fun encodeAttachmentSendCommand(
        sessionId: String,
        text: String,
        requestId: String,
        selection: RuntimeSelection,
        agentId: String?,
        attachments: List<OutboundAttachment>,
        harnessCapabilityIds: List<String>,
    ): String = buildJsonObject {
        put("sessionId", JsonPrimitive(sessionId))
        put("text", JsonPrimitive(text))
        put("requestId", JsonPrimitive(requestId))
        put("tool", JsonPrimitive(selection.tool))
        selection.providerProfile?.let { put("providerProfile", JsonPrimitive(it)) }
        selection.model?.let { put("model", JsonPrimitive(it)) }
        selection.effort?.let { put("effort", JsonPrimitive(it)) }
        put("serviceTier", JsonPrimitive(selection.serviceTier))
        put("interactionMode", JsonPrimitive(selection.interactionMode))
        selection.permissionMode?.let { put("permissionMode", JsonPrimitive(it)) }
        selection.planAction?.let { put("planAction", JsonPrimitive(it)) }
        selection.planId?.let { put("planId", JsonPrimitive(it)) }
        agentId?.let { put("agentId", JsonPrimitive(it)) }
        put("harnessCapabilityIds", buildJsonArray {
            harnessCapabilityIds.forEach { add(JsonPrimitive(it)) }
        })
        put("attachments", buildJsonArray {
            attachments.forEach { attachment ->
                add(buildJsonObject {
                    put("contentUri", JsonPrimitive(attachment.contentUri))
                    put("originalName", JsonPrimitive(attachment.originalName))
                    put("mimeType", JsonPrimitive(attachment.mimeType))
                    put("sizeBytes", JsonPrimitive(attachment.sizeBytes))
                    put("renderAsFile", JsonPrimitive(attachment.renderAsFile))
                    attachment.assetId?.takeIf { it.isNotBlank() }?.let {
                        put("assetId", JsonPrimitive(it))
                    }
                })
            }
        })
    }.toString()

    private fun encodeAttachmentResendCommand(
        sessionId: String,
        parentRequestId: String,
        prompt: String,
        requestId: String,
        selection: RuntimeSelection,
        attachments: List<OutboundAttachment>,
    ): String = buildJsonObject {
        put("sessionId", JsonPrimitive(sessionId))
        put("parentRequestId", JsonPrimitive(parentRequestId))
        put("prompt", JsonPrimitive(prompt))
        put("requestId", JsonPrimitive(requestId))
        put("tool", JsonPrimitive(selection.tool))
        selection.providerProfile?.let { put("providerProfile", JsonPrimitive(it)) }
        selection.model?.let { put("model", JsonPrimitive(it)) }
        selection.effort?.let { put("effort", JsonPrimitive(it)) }
        put("serviceTier", JsonPrimitive(selection.serviceTier))
        put("interactionMode", JsonPrimitive(selection.interactionMode))
        selection.permissionMode?.let { put("permissionMode", JsonPrimitive(it)) }
        selection.planAction?.let { put("planAction", JsonPrimitive(it)) }
        selection.planId?.let { put("planId", JsonPrimitive(it)) }
        put("attachments", buildJsonArray {
            attachments.forEach { attachment ->
                add(buildJsonObject {
                    put("contentUri", JsonPrimitive(attachment.contentUri))
                    put("originalName", JsonPrimitive(attachment.originalName))
                    put("mimeType", JsonPrimitive(attachment.mimeType))
                    put("sizeBytes", JsonPrimitive(attachment.sizeBytes))
                    put("renderAsFile", JsonPrimitive(attachment.renderAsFile))
                    attachment.assetId?.takeIf { it.isNotBlank() }?.let {
                        put("assetId", JsonPrimitive(it))
                    }
                })
            }
        })
    }.toString()

    private suspend fun materializePendingAttachments(
        initial: PendingOperationEntity,
    ): Pair<PendingOperationEntity, List<AttachmentItemDto>> {
        var operation = initial.copy(state = "sending", updatedAt = System.currentTimeMillis())
        var payload = AgentocProtocol.json.parseToJsonElement(operation.payload).jsonObject
        val specs = payload["attachments"]?.jsonArray.orEmpty()
        val messageRequestId = payload.string("requestId") ?: operation.requestId
        val sessionId = operationScope(payload)
        val totals = AttachmentProgressTotals(specs.map { element ->
            element.jsonObject["sizeBytes"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.coerceAtLeast(0L) ?: 0L
        })
        val refs = mutableListOf<AttachmentItemDto>()
        var lastProgressAt = 0L
        var lastProgress: AttachmentUploadProgress? = null
        fun publishProgress(phase: FileUploadPhase, transferredBytes: Long, force: Boolean = false) {
            val totalBytes = totals.total() ?: return
            if (sessionId.isBlank()) return
            val progress = AttachmentUploadProgress(
                sessionId = sessionId,
                phase = phase,
                transferredBytes = transferredBytes.coerceIn(0L, totalBytes),
                totalBytes = totalBytes,
            )
            val now = System.currentTimeMillis()
            if (!force && lastProgress?.phase == phase && now - lastProgressAt < 200L
                && progress.transferredBytes - (lastProgress?.transferredBytes ?: 0L) < 1024L * 1024L) return
            lastProgressAt = now
            lastProgress = progress
            attachmentUploadProgressState.update { it + (operation.requestId to progress) }
        }
        publishProgress(FileUploadPhase.PREPARING, 0L, force = true)
        try {
            specs.forEachIndexed { index, element ->
                val spec = element.jsonObject
                val attachmentSize = spec["sizeBytes"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()?.coerceAtLeast(0L) ?: 0L
                val existing = attachmentRefFromPendingSpec(spec)
                val ref = existing ?: uploadAttachment(
                    sessionId,
                    stableAttachmentUploadRequestId(messageRequestId, index),
                    quotaBatchId = messageRequestId,
                    attachment = OutboundAttachment(
                        contentUri = spec.string("contentUri").orEmpty(),
                        originalName = spec.string("originalName").orEmpty(),
                        mimeType = spec.string("mimeType").orEmpty(),
                        sizeBytes = attachmentSize,
                        renderAsFile = spec["renderAsFile"]?.jsonPrimitive?.booleanOrNull == true,
                        assetId = spec.string("assetId"),
                    ),
                    onProgress = { uploadProgress ->
                        totals.discover(index, uploadProgress.totalBytes)
                        val currentBytes = if (uploadProgress.phase == FileUploadPhase.CONFIRMED) uploadProgress.totalBytes
                            else uploadProgress.writtenBytes ?: 0L
                        publishProgress(uploadProgress.phase, totals.transferred(currentBytes))
                    },
                )
                refs += ref
                ref.sizeBytes?.let { totals.discover(index, it) }
                totals.complete(index)
                if (existing != null) publishProgress(FileUploadPhase.TRANSFERRING, totals.transferred(0))
                payload = payloadWithAttachmentRef(payload, index, ref)
                operation = operation.copy(payload = payload.toString(), updatedAt = System.currentTimeMillis(), lastError = null)
                dao.upsertOperation(operation)
            }
            totals.total()?.let { publishProgress(FileUploadPhase.CONFIRMED, it, force = true) }
            return operation to refs
        } finally {
            attachmentUploadProgressState.update { it - operation.requestId }
        }
    }

    private fun operationScope(payload: JsonObject): String = payload.string("sessionId").orEmpty()

    private fun attachmentRefFromPendingSpec(spec: JsonObject): AttachmentItemDto? {
        val assetId = spec.string("assetId")?.takeIf { it.isNotBlank() } ?: return null
        return AttachmentItemDto(
            assetId = assetId,
            originalName = spec.string("originalName"),
            mimeType = spec.string("mimeType"),
            sizeBytes = spec["sizeBytes"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
            renderAs = "file".takeIf { spec["renderAsFile"]?.jsonPrimitive?.booleanOrNull == true },
        )
    }

    private fun payloadWithAttachmentRef(payload: JsonObject, index: Int, ref: AttachmentItemDto): JsonObject = buildJsonObject {
        payload.forEach { (key, value) ->
            if (key != "attachments") put(key, value)
        }
        put("attachments", buildJsonArray {
            payload["attachments"]?.jsonArray.orEmpty().forEachIndexed { currentIndex, value ->
                if (currentIndex != index) {
                    add(value)
                } else {
                    add(buildJsonObject {
                        value.jsonObject.forEach { (key, child) ->
                            if (key != "assetId") put(key, child)
                        }
                        put("assetId", JsonPrimitive(ref.assetId.orEmpty()))
                    })
                }
            }
        })
    }

    private suspend fun uploadAttachment(
        sessionId: String,
        uploadRequestId: String,
        quotaBatchId: String,
        attachment: OutboundAttachment,
        onProgress: (FileUploadProgress) -> Unit = {},
    ): AttachmentItemDto {
        val resolver = contentResolver
            ?: error("Attachment upload is unavailable until the Android file resolver is configured")
        val fixedTargetId = targetId?.takeIf { it.isNotBlank() }
            ?: error("Attachment upload requires a fixed connected computer")
        val uri = Uri.parse(attachment.contentUri)
        val descriptor = withContext(Dispatchers.IO) {
            resolver.openInputStream(uri)?.use { input ->
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(DEFAULT_ATTACHMENT_BUFFER_BYTES)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    require(total <= MAX_ATTACHMENT_BYTES) {
                        "Attachment exceeds the maximum supported size"
                    }
                    digest.update(buffer, 0, read)
                }
                total to digest.digest().joinToString("") { "%02x".format(it) }
            } ?: error("Attachment file could not be opened")
        }
        val sizeBytes = attachment.sizeBytes.takeIf { it > 0 } ?: descriptor.first
        require(sizeBytes == descriptor.first) { "Attachment changed after it was selected" }
        require(sizeBytes in 1..MAX_ATTACHMENT_BYTES) { "Attachment size is unsupported" }
        val mimeType = attachment.mimeType.ifBlank { "application/octet-stream" }
        val source = ApiRequestBodySource(sizeBytes, descriptor.second) {
            resolver.openInputStream(uri) ?: error("Attachment file could not be reopened")
        }
        onProgress(FileUploadProgress(FileUploadPhase.PREPARING, sizeBytes, 0L))
        val uploaded = FileAssetUploadClient(fixedTargetId, transport, attachmentRelay).upload(
            sessionId,
            FileUploadInput(uploadRequestId, attachment.originalName, mimeType, sizeBytes, descriptor.second,
                quotaBatchId = quotaBatchId),
            source,
            onProgress = onProgress,
        )
        return AttachmentItemDto(
            assetId = uploaded.assetId,
            originalName = uploaded.originalName,
            mimeType = uploaded.mimeType,
            sizeBytes = uploaded.sizeBytes,
            renderAs = "file".takeIf { attachment.renderAsFile },
        )
    }

    private fun stableAttachmentUploadRequestId(messageRequestId: String, index: Int): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$messageRequestId\u0000$index".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return "message-attachment:$digest"
    }

    private fun parseRuntimeModels(modelsJson: JsonObject?): List<RuntimeModelOption> =
        (modelsJson?.get("models") as? JsonArray).orEmpty().mapNotNull { modelElement ->
            val model = modelElement as? JsonObject ?: return@mapNotNull null
            val modelId = model.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val provider = modelId.substringAfterLast('@', "").takeIf { it.isNotBlank() }
            val serviceTiers = model["serviceTiers"] as? JsonArray
            val capabilities = model["capabilities"] as? JsonObject
            val serviceTier = capabilities?.get("serviceTier") as? JsonObject
            val supportsFast = serviceTiers?.any { (it as? JsonPrimitive)?.content == "fast" } == true
                || (serviceTier?.get("supportsFast") as? JsonPrimitive)?.booleanOrNull == true
            val reasoning = model["reasoning"] as? JsonObject
            val toolReasoning = modelsJson?.get("reasoning") as? JsonObject
            val levelsJson = (model["effortLevels"] as? JsonArray)
                ?: (reasoning?.get("levels") as? JsonArray)
                ?: if (reasoning?.string("kind") in listOf("none", "toggle")) null else
                    (modelsJson?.get("effortLevels") as? JsonArray)
                        ?: (toolReasoning?.get("levels") as? JsonArray)
            val levels = levelsJson.orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                .filter { it.isNotBlank() }.distinct()
            val default = model.string("defaultEffort") ?: reasoning?.string("default")
                ?: toolReasoning?.string("default")
            val defaultModel = modelsJson?.string("defaultModel")
            RuntimeModelOption(modelId, model.string("label") ?: modelId, provider, supportsFast,
                levels, default?.takeIf { it in levels },
                (model["isDefault"] as? JsonPrimitive)?.booleanOrNull == true ||
                    (!defaultModel.isNullOrBlank() && (modelId == defaultModel || modelId.substringBeforeLast('@') == defaultModel)))
        }

    private fun parseRuntimeProviders(providersJson: JsonObject?): List<RuntimeProviderOption> =
        (providersJson?.get("providers") as? JsonArray).orEmpty().mapNotNull { providerElement ->
            val provider = providerElement as? JsonObject ?: return@mapNotNull null
            val id = provider.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val modelCount = provider["modelCount"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0
            RuntimeProviderOption(
                id = id,
                label = provider.string("displayName") ?: provider.string("label") ?: id,
                catalog = RuntimeCatalogMetadata(
                    status = RuntimeCatalogStatus.fromValue(null, modelCount = modelCount),
                    providerProfileId = id,
                    modelCount = modelCount,
                ),
            )
        }

    override suspend fun loadRuntimeProviders(tool: String): List<RuntimeProviderOption> {
        val response = execute(ApiRequest("GET", "/api/native-providers?tool=${encode(tool)}"))
        return parseRuntimeProviders(codec.decode(serializer<JsonObject>(), response.body))
    }

    override suspend fun loadHarnessCapabilities(
        sessionId: String,
        tool: String?,
        providerProfile: String?,
    ): HarnessCapabilityCatalog {
        val query = buildList {
            tool?.takeIf { it.isNotBlank() }?.let { add("tool=${encode(it)}") }
            providerProfile?.takeIf { it.isNotBlank() }?.let { add("providerProfile=${encode(it)}") }
        }.joinToString("&").takeIf { it.isNotBlank() }?.let { "?$it" }.orEmpty()
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/harness-capabilities$query"))
        val root = codec.decode(serializer<JsonObject>(), response.body)
        val items = (root["items"] as? JsonArray).orEmpty().mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val id = item.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val title = item.string("title")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            HarnessCapabilityItem(
                id = id,
                kind = item.string("kind") ?: "command",
                source = item.string("source") ?: "harness",
                title = title,
                description = item.string("description") ?: "",
                invocationText = item.string("invocationText") ?: "",
                enabled = item["enabled"]?.jsonPrimitive?.booleanOrNull != false,
                disabledReason = item.string("disabledReason"),
            )
        }
        val errors = (root["errors"] as? JsonObject).orEmpty().mapNotNull { (key, value) ->
            val message = (value as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
            message?.let { key to it }
        }.toMap()
        return HarnessCapabilityCatalog(
            tool = root.string("tool") ?: "unknown",
            items = items,
            errors = errors,
        )
    }

    override suspend fun loadRuntimeModels(tool: String, providerProfile: String): List<RuntimeModelOption> {
        val response = execute(ApiRequest(
            "GET",
            "/api/models?tool=${encode(tool)}&provider=${encode(providerProfile)}",
        ))
        return parseRuntimeModels(codec.decode(serializer<JsonObject>(), response.body)).map { model ->
            if (model.provider == null) model.copy(provider = providerProfile) else model
        }
    }

    override suspend fun loadSessionRuntimeSelection(sessionId: String): RuntimeSelection? {
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}"))
        val root = codec.decode(serializer<JsonObject>(), response.body)
        val session = (root["session"] as? JsonObject) ?: root
        if (session.string("id") != sessionId) return null
        val tool = session.string("tool")?.takeIf { it.isNotBlank() } ?: return null
        return RuntimeSelection(
            tool = tool,
            providerProfile = session.string("providerProfile"),
            model = session.string("model"),
            effort = session.string("effort"),
            serviceTier = session.string("serviceTier") ?: "standard",
        )
    }

    override suspend fun loadGlobalRuntimeSelection(): RuntimeSelection? {
        val response = execute(ApiRequest("GET", "/api/runtime-selection"))
        val root = codec.decode(serializer<JsonObject>(), response.body)
        val selection = root["selection"] as? JsonObject ?: return null
        val tool = selection.string("selectedTool")?.takeIf { it.isNotBlank() } ?: return null
        val model = selection.string("selectedModel")?.takeIf { it.isNotBlank() }
        val provider = selection.string("selectedProviderProfile")?.takeIf { it.isNotBlank() }
            ?: model?.substringAfterLast('@', "")?.takeIf { it.isNotBlank() }
        return RuntimeSelection(tool, provider, model,
            selection.string("selectedEffort")?.takeIf { it.isNotBlank() },
            selection.string("selectedServiceTier")?.takeIf { it.isNotBlank() } ?: "standard")
    }

    override suspend fun saveGlobalRuntimeSelection(selection: RuntimeSelection) {
        val payload = buildJsonObject {
            put("selectedTool", JsonPrimitive(selection.tool))
            put("selectedModel", JsonPrimitive(selection.model ?: ""))
            put("selectedProviderProfile", JsonPrimitive(selection.providerProfile ?: ""))
            put("selectedEffort", JsonPrimitive(selection.effort ?: ""))
            put("selectedServiceTier", JsonPrimitive(selection.serviceTier))
            put("reasoningKind", JsonPrimitive(if (selection.effort == null) "none" else "enum"))
        }.toString()
        execute(ApiRequest("POST", "/api/runtime-selection", payload))
    }

    override suspend fun loadRuntimeCatalog(): RuntimeCatalog {
        val toolsResponse = execute(ApiRequest("GET", "/api/tools"))
        val toolsJson = codec.decode(serializer<JsonObject>(), toolsResponse.body)
        // Provider discovery is independent per Harness. Run it concurrently
        // so a slow local provider or unreachable endpoint cannot serialize the
        // entire picker catalog behind it.
        val tools = coroutineScope {
            (toolsJson["tools"] as? JsonArray).orEmpty().mapNotNull { toolElement ->
                val tool = toolElement as? JsonObject ?: return@mapNotNull null
                val id = tool.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                async {
                    val providerFamily = runtimeProviderFamily(id, tool.string("runtimeFamily").orEmpty())
                    val providerResult = runCatching { loadRuntimeProviders(providerFamily ?: id) }
                    val providers = providerResult.getOrDefault(emptyList())
                    // Provider-backed Harnesses are intentionally lazy. A plain
                    // tool without providers still needs its static/direct model list now.
                    val models = if (providerFamily == null && providers.isEmpty()) {
                        runCatching {
                            val response = execute(ApiRequest("GET", "/api/models?tool=${encode(id)}"))
                            parseRuntimeModels(codec.decode(serializer<JsonObject>(), response.body))
                        }.getOrDefault(emptyList())
                    } else {
                        emptyList()
                    }
                    RuntimeToolOption(
                        id = id,
                        label = tool.string("name") ?: tool.string("label") ?: id,
                        providers = providers,
                        models = models,
                        catalog = RuntimeCatalogMetadata(
                            modelCount = models.size,
                            status = if (providerFamily != null && providerResult.isFailure) RuntimeCatalogStatus.Error
                                else RuntimeCatalogStatus.fromValue(null, modelCount = models.size),
                        ),
                        providerSelectionRequired = providerFamily != null || providers.isNotEmpty(),
                    )
                }
            }.map { it.await() }
        }
        return RuntimeCatalog(tools)
    }

    override suspend fun updateRuntimeSelection(
        sessionId: String,
        tool: String,
        providerProfile: String?,
        model: String?,
        effort: String?,
        serviceTier: String,
    ) {
        val payload = buildJsonObject {
            put("tool", JsonPrimitive(tool))
            put("providerProfile", JsonPrimitive(providerProfile ?: ""))
            put("model", JsonPrimitive(model ?: ""))
            put("effort", JsonPrimitive(effort ?: ""))
            put("serviceTier", JsonPrimitive(serviceTier))
        }.toString()
        execute(ApiRequest("PATCH", "/api/sessions/${encode(sessionId)}", payload))
    }

    override suspend fun cancelSession(sessionId: String) {
        val requestId = newRequestId()
        val path = "/api/sessions/${encode(sessionId)}/cancel"
        // Cancellation is idempotent at the server boundary: a retry after a
        // lost response either observes the same cancellation or the already
        // terminal run. Keep it durable across carrier/app recovery.
        executePending(sessionId, requestId, "cancel_session", path, "{}") {
            execute(ApiRequest("POST", path, "{}", requestId, requestId))
        }
    }

    override suspend fun decideConfirmation(sessionId: String, confirmationId: String, decision: String, requestId: String) {
        val body = codec.encode(serializer<ConfirmationDecisionRequestDto>(), ConfirmationDecisionRequestDto(decision, requestId))
        val path = "/api/sessions/${encode(sessionId)}/confirmations/${encode(confirmationId)}"
        executePending(sessionId, requestId, "confirmation", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun resolveApproval(runId: String, batchId: String, decisionsJson: String, requestId: String) {
        val decisions = AgentocProtocol.json.parseToJsonElement(decisionsJson)
        val body = codec.encode(
            serializer<ApprovalResolutionRequestDto>(),
            ApprovalResolutionRequestDto(decisions, requestId, approvalIntent = "approve"),
        )
        val path = "/api/runs/${encode(runId)}/approved-actions/${encode(batchId)}/resolve"
        executePending(runId, requestId, "approval", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun resolveApprovedActions(sessionId: String, runId: String, batchId: String, approve: Boolean, requestId: String) {
        val approval = dao.getApproval(sessionId, batchId)?.toDomainApproval()
            ?: error("Approval $batchId was not found")
        val decision = if (approve) "approve" else "deny"
        val decisions = approval.actions.map { ApprovalActionDecision(it.id, decision) }
        resolveApprovedActionBatch(sessionId, runId, batchId, decisions, decision, requestId)
    }

    override suspend fun resolveApprovedActionBatch(
        sessionId: String,
        runId: String,
        batchId: String,
        decisions: List<ApprovalActionDecision>,
        approvalIntent: String,
        requestId: String,
    ) {
        resolveApprovedActionBatchWithProof(sessionId, runId, batchId, decisions, approvalIntent, null, requestId)
    }

    override suspend fun resolveApprovedActionBatchWithProof(
        sessionId: String,
        runId: String,
        batchId: String,
        decisions: List<ApprovalActionDecision>,
        approvalIntent: String,
        webauthnProof: com.andysagent.agentoc.core.protocol.WebAuthnProofDto?,
        requestId: String,
    ) {
        val approval = dao.getApproval(sessionId, batchId)?.toDomainApproval()
            ?: error("Approval $batchId was not found")
        val knownActionIds = approval.actions.map { it.id }.toSet()
        val normalizedIntent = approvalIntent.trim().lowercase()
        require(normalizedIntent == "approve" || normalizedIntent == "deny") {
            "Approval intent must be approve or deny"
        }
        require(decisions.size == decisions.map { it.actionId }.distinct().size) {
            "Approval decisions must not contain duplicate action ids"
        }
        require(decisions.all { it.actionId in knownActionIds }) {
            "Approval decisions contain an unknown action id"
        }
        val normalizedDecisions = decisions
            .associate { it.actionId to it.decision.trim().lowercase() }
        require(normalizedDecisions.isNotEmpty()) { "Approval $batchId has no actionable decisions" }
        require(normalizedDecisions.keys == knownActionIds) {
            "Approval decisions must include every action in batch $batchId"
        }
        require(normalizedDecisions.values.all { it == "approve" || it == "deny" }) {
            "Approval decisions must be approve or deny"
        }
        val decisionsJson = buildJsonObject {
            normalizedDecisions.forEach { (actionId, decision) ->
                put(actionId, JsonPrimitive(decision))
            }
        }
        val body = codec.encode(
            serializer<ApprovalResolutionRequestDto>(),
            ApprovalResolutionRequestDto(decisionsJson, requestId, normalizedIntent, webauthnProof),
        )
        val path = "/api/runs/${encode(runId)}/approved-actions/${encode(batchId)}/resolve"
        executePending(runId, requestId, "approved_actions", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun createApprovedActionWebAuthnChallenge(
        runId: String,
        batchId: String,
        selectedActionIds: List<String>,
        requestId: String,
    ): JsonObject {
        require(runId.isNotBlank() && batchId.isNotBlank()) { "Approved-action challenge target is required" }
        val path = "/api/runs/${encode(runId)}/approved-actions/${encode(batchId)}/webauthn-challenge"
        val body = buildJsonObject {
            put("selectedActionIds", buildJsonArray { selectedActionIds.forEach { add(JsonPrimitive(it)) } })
            put("requestId", JsonPrimitive(requestId))
        }.toString()
        val response = execute(ApiRequest(
            "POST",
            path,
            body,
            requestId,
            requestId,
            headers = mapOf("X-AgentoC-Client" to "android-native-passkey"),
        ))
        return AgentocProtocol.json.parseToJsonElement(response.body).jsonObject["publicKey"]?.jsonObject
            ?: error("Approved-action WebAuthn challenge did not include publicKey")
    }

    override suspend fun createPrivilegedCategoryWebAuthnChallenge(
        runId: String,
        batchId: String,
        category: String,
        checkedOpIds: List<String>,
        requestId: String,
    ): JsonObject {
        require(runId.isNotBlank() && batchId.isNotBlank() && category.isNotBlank()) {
            "Privileged challenge target is required"
        }
        val path = "/api/runs/${encode(runId)}/privileged-batches/${encode(batchId)}/categories/${encode(category)}/webauthn-challenge"
        val body = buildJsonObject {
            put("checkedOpIds", buildJsonArray { checkedOpIds.forEach { add(JsonPrimitive(it)) } })
            put("requestId", JsonPrimitive(requestId))
        }.toString()
        val response = execute(ApiRequest(
            "POST",
            path,
            body,
            requestId,
            requestId,
            headers = mapOf("X-AgentoC-Client" to "android-native-passkey"),
        ))
        return AgentocProtocol.json.parseToJsonElement(response.body).jsonObject["publicKey"]?.jsonObject
            ?: error("Privileged WebAuthn challenge did not include publicKey")
    }

    override suspend fun resolvePrivilegedCategory(
        sessionId: String,
        runId: String,
        batchId: String,
        category: String,
        checkedOpIds: List<String>,
        webauthnProof: com.andysagent.agentoc.core.protocol.WebAuthnProofDto?,
        requestId: String,
    ) {
        require(category.isNotBlank()) { "Privileged category is required" }
        val path = "/api/runs/${encode(runId)}/privileged-batches/${encode(batchId)}/categories/${encode(category)}"
        val body = buildJsonObject {
            put("checkedOpIds", buildJsonArray { checkedOpIds.forEach { add(JsonPrimitive(it)) } })
            put("requestId", JsonPrimitive(requestId))
            webauthnProof?.let {
                put("webauthnProof", AgentocProtocol.json.encodeToJsonElement(serializer<com.andysagent.agentoc.core.protocol.WebAuthnProofDto>(), it))
            }
        }.toString()
        executePending(runId, requestId, "privileged_category", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun resolveRuntimeApproval(
        runId: String,
        approvalId: String,
        decision: String,
        choices: List<String>,
        customAnswer: String?,
        requestId: String,
    ) {
        val body = codec.encode(
            serializer<RuntimeApprovalDecisionRequestDto>(),
            RuntimeApprovalDecisionRequestDto(decision, requestId, choices, customAnswer),
        )
        val path = "/api/runs/${encode(runId)}/approvals/${encode(approvalId)}"
        executePending(runId, requestId, "runtime_approval", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun resolveRuntimeApprovalWithMultiChoices(runId: String, approvalId: String, multiChoices: List<List<Int>>, customAnswers: List<String>, requestId: String) {
        val body = codec.encode(serializer<RuntimeApprovalDecisionRequestDto>(),
            RuntimeApprovalDecisionRequestDto("approve_with_multi_choices", requestId, customAnswers = customAnswers, multiChoices = multiChoices))
        val path = "/api/runs/${encode(runId)}/approvals/${encode(approvalId)}"
        executePending(runId, requestId, "runtime_approval", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun resolveRuntimeApprovalWithAnswers(
        runId: String,
        approvalId: String,
        choices: List<String>,
        customAnswers: List<String>,
        requestId: String,
    ) {
        val body = codec.encode(serializer<RuntimeApprovalDecisionRequestDto>(),
            RuntimeApprovalDecisionRequestDto("approve_with_answers", requestId, choices, customAnswers = customAnswers))
        val path = "/api/runs/${encode(runId)}/approvals/${encode(approvalId)}"
        executePending(runId, requestId, "runtime_approval", path, body) {
            execute(ApiRequest("POST", path, body, requestId, requestId))
        }
    }

    override suspend fun updateSessionGoal(sessionId: String, goal: String?, autoContinue: Boolean) {
        val payload = if (goal != null && goal.isNotBlank()) {
            buildJsonObject {
                put("goal", buildJsonObject {
                    put("objective", JsonPrimitive(goal.trim()))
                    put("enabled", JsonPrimitive(true))
                    put("chasing", JsonPrimitive(autoContinue))
                })
            }.toString()
        } else {
            buildJsonObject {
                put("goal", kotlinx.serialization.json.JsonNull)
            }.toString()
        }
        val path = "/api/sessions/${encode(sessionId)}"
        val requestId = newRequestId()
        executePending(sessionId, requestId, "update_goal", path, payload, method = "PATCH") {
            execute(ApiRequest("PATCH", path, payload, requestId, requestId))
        }
    }

    override suspend fun submitPlanAction(
        sessionId: String,
        planId: String,
        action: String,
        text: String,
        requestId: String,
    ): JsonObject {
        require(sessionId.isNotBlank() && planId.isNotBlank()) { "Plan action target is required" }
        require(action == "revise" || action == "execute") { "Unsupported plan action" }
        val path = "/api/sessions/${encode(sessionId)}/plans/${encode(planId)}/actions"
        val payload = buildJsonObject {
            put("action", JsonPrimitive(action))
            put("requestId", JsonPrimitive(requestId))
            if (text.isNotBlank()) put("text", JsonPrimitive(text.trim()))
        }.toString()
        val response = executePendingResponse(sessionId, requestId, "plan_action", path, payload) {
            execute(ApiRequest("POST", path, payload, requestId, requestId))
        }
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        root["session"]?.jsonObject?.let { persistSessionJson(it, sessionId) }
        return root
    }

    override suspend fun loadMessageResult(sessionId: String, requestId: String): JsonObject {
        require(sessionId.isNotBlank() && requestId.isNotBlank()) { "Result identity is required" }
        val response = execute(ApiRequest("GET", "/api/sessions/${encode(sessionId)}/message-results/${encode(requestId)}"))
        return codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
    }

    override suspend fun loadRunProjection(runId: String): JsonObject {
        require(runId.isNotBlank()) { "Run id is required" }
        val response = execute(ApiRequest("GET", "/api/runs/${encode(runId)}"))
        val root = codec.decode<JsonObject>(serializer<JsonObject>(), response.body)
        return root["run"]?.jsonObject ?: root
    }

    override suspend fun resumePendingOperations(): Int {
        var completed = 0
        for (snapshot in dao.pendingOperations()) {
            if (!activePendingOperationIds.add(snapshot.requestId)) continue
            try {
                val operation = dao.getPendingOperation(snapshot.requestId) ?: continue
                if (operation.state !in setOf("pending", "sending")) continue
                if (operation.path.isBlank()) continue
                dao.upsertOperation(operation.copy(state = "sending", updatedAt = System.currentTimeMillis()))
                try {
                    val response = if (operation.kind == "send_message_with_attachments") {
                        val materialized = materializePendingAttachments(operation)
                        val payload = AgentocProtocol.json.parseToJsonElement(materialized.first.payload).jsonObject
                        val body = encodeMessage(
                            text = payload.string("text").orEmpty(),
                            requestId = payload.string("requestId") ?: operation.requestId,
                            selection = RuntimeSelection(
                                tool = payload.string("tool").orEmpty(),
                                providerProfile = payload.string("providerProfile"),
                                model = payload.string("model"),
                                effort = payload.string("effort"),
                                serviceTier = payload.string("serviceTier") ?: "standard",
                                interactionMode = payload.string("interactionMode") ?: "agent",
                                permissionMode = payload.string("permissionMode"),
                                planAction = payload.string("planAction"),
                                planId = payload.string("planId"),
                            ),
                            agentId = payload.string("agentId"),
                            attachments = materialized.second,
                            harnessCapabilityIds = payload["harnessCapabilityIds"]?.jsonArray
                                ?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
                        )
                        execute(ApiRequest("POST", operation.path, body, operation.requestId, operation.idempotencyKey ?: operation.requestId))
                    } else if (operation.kind == "resend_edited_message_with_attachments") {
                        val materialized = materializePendingAttachments(operation)
                        val payload = AgentocProtocol.json.parseToJsonElement(materialized.first.payload).jsonObject
                        val body = encodeEditedMessage(
                            parentRequestId = payload.string("parentRequestId").orEmpty(),
                            prompt = payload.string("prompt").orEmpty(),
                            requestId = payload.string("requestId") ?: operation.requestId,
                            selection = selectionFromAttachmentPayload(payload),
                            attachments = materialized.second,
                        )
                        execute(ApiRequest("POST", operation.path, body, operation.requestId, operation.idempotencyKey ?: operation.requestId))
                    } else {
                        execute(
                            ApiRequest(
                                method = operation.method.ifBlank { "POST" },
                                path = operation.path,
                                body = operation.payload,
                                requestId = operation.requestId,
                                idempotencyKey = operation.idempotencyKey ?: operation.requestId,
                                headers = decodeHeaders(operation.headersJson),
                            ),
                        )
                    }
                    if (operation.kind == "fork_at") {
                        persistForkedSessionResponse(response.body)
                    }
                    if (operation.kind.startsWith("queue_")) {
                        runCatching { persistQueueMutationSession(response.body, sessionIdFromPath(operation.path)) }
                    }
                    if (operation.kind == "send_message" || operation.kind == "send_message_with_attachments") {
                        markFirstTurnAccepted(sessionIdFromPath(operation.path))
                    }
                    dao.deleteOperation(operation.requestId)
                    completed += 1
                } catch (error: Throwable) {
                    val recoverable = dao.getPendingOperation(operation.requestId) ?: operation
                    dao.upsertOperation(recoverable.copy(
                        state = if (isPermanentClientFailure(error)) "failed" else "pending",
                        updatedAt = System.currentTimeMillis(),
                        lastError = error.message,
                    ))
                    if (error is CancellationException) throw error
                }
            } finally { activePendingOperationIds.remove(snapshot.requestId) }
        }
        return completed
    }

    private suspend fun persistForkedSessionResponse(body: String): Session {
        val item = codec.decode<JsonObject>(serializer<JsonObject>(), body)["session"]?.jsonObject
            ?: error("Fork-at response did not include a session")
        val entity = SessionEntity(
            id = item.string("id").orEmpty().also { require(it.isNotBlank()) { "Forked session has no id" } },
            title = item.string("title") ?: item.string("name") ?: "Forked session",
            projectId = item.string("projectId"),
            templateId = item.string("templateId"),
            status = item.string("workflowState") ?: item.string("status") ?: "idle",
            latestSeq = item.long("latestSeq") ?: 0L,
            updatedAt = System.currentTimeMillis(),
            workflowState = item.string("workflowState"),
            waitingAction = item.string("waitingAction") ?: item.string("attentionKind"),
        )
        dao.upsertSessions(listOf(entity))
        return toDomain(entity)
    }

    private suspend fun persistQueueMutationSession(body: String, sessionId: String): Session? {
        val payload = codec.decode(serializer<QueueMutationResponseDto>(), body)
        return payload.session?.let { persistSessionJson(it, sessionId) }
            ?: refreshSessionDetail(sessionId)
    }

    private suspend fun persistSessionJson(item: JsonObject, fallbackSessionId: String): Session? {
        val id = item.string("id")?.takeIf { it.isNotBlank() } ?: fallbackSessionId
        if (id.isBlank()) return null
        val entity = sessionEntityFromClientJson(item, dao.getSession(id))
        dao.upsertSessions(listOf(entity))
        return toDomain(entity)
    }

    private suspend fun executePending(
        scope: String,
        requestId: String,
        kind: String,
        path: String,
        payload: String,
        method: String = "POST",
        headers: Map<String, String> = emptyMap(),
        idempotencyKey: String = requestId,
        action: suspend () -> Unit,
    ) {
        executePendingResponse(scope, requestId, kind, path, payload, method, headers, idempotencyKey) {
            action()
            com.andysagent.agentoc.core.network.ApiResponse(204, "{}")
        }
    }

    private suspend fun executePendingResponse(
        scope: String,
        requestId: String,
        kind: String,
        path: String,
        payload: String,
        method: String = "POST",
        headers: Map<String, String> = emptyMap(),
        idempotencyKey: String = requestId,
        action: suspend () -> com.andysagent.agentoc.core.network.ApiResponse,
    ): com.andysagent.agentoc.core.network.ApiResponse = withPendingOperationClaim(requestId) {
        val now = System.currentTimeMillis()
        val operation = PendingOperationEntity(
            requestId = requestId,
            kind = kind,
            path = path,
            payload = payload,
            state = "pending",
            createdAt = now,
            updatedAt = now,
            method = method,
            headersJson = buildJsonObject { headers.forEach { (key, value) -> put(key, JsonPrimitive(value)) } }.toString(),
            idempotencyKey = idempotencyKey,
        )
        dao.upsertOperation(operation)
        dao.upsertOperation(operation.copy(state = "sending", updatedAt = System.currentTimeMillis()))
        try {
            val response = action()
            if (kind == "send_message") markFirstTurnAccepted(scope)
            dao.deleteOperation(requestId)
            response
        } catch (error: Throwable) {
            dao.upsertOperation(operation.copy(
                state = if (isPermanentClientFailure(error)) "failed" else "pending",
                updatedAt = System.currentTimeMillis(),
                lastError = error.message,
            ))
            throw error
        }
    }

    private fun isPermanentClientFailure(error: Throwable): Boolean =
        error is SessionRepositoryException && !error.retryable && error.statusCode in 400..499
            && error.statusCode !in setOf(401, 403)

    private fun decodeHeaders(value: String): Map<String, String> = runCatching {
        AgentocProtocol.json.parseToJsonElement(value).jsonObject.mapNotNull { (key, element) ->
            element.jsonPrimitive.contentOrNull?.let { key to it }
        }.toMap()
    }.getOrDefault(emptyMap())

    private fun sessionEntityFromClientJson(item: JsonObject, existing: SessionEntity? = null, authoritative: Boolean = false): SessionEntity {
        val id = item.string("id").orEmpty().ifBlank { existing?.id.orEmpty() }
        require(id.isNotBlank()) { "Session projection has no id" }
        val activity = item["activity"]?.jsonObject
        val run = activity?.get("run")?.jsonObject
        val workflowState = item.string("workflowState")
        val summaryStatus = chooseSessionSummaryStatus(item.string("status"), workflowState, run?.string("state"), existing?.status ?: "idle")
        val latestSeq = item["latestSeq"]?.toString()?.trim('"')?.toLongOrNull() ?: existing?.latestSeq ?: 0L
        val rawStatus = if (isAcceptedFirstTurnStatus(existing?.status) && latestSeq == 0L &&
            sessionStatusFromRaw(summaryStatus) !in setOf(SessionStatus.Completed, SessionStatus.Failed, SessionStatus.Cancelled))
            acceptedFirstTurnStatus(sessionStatusFromRaw(summaryStatus) == SessionStatus.WaitingApproval) else summaryStatus
        val waitingAction = item.string("waitingAction")
            ?: item.string("attentionKind")
            ?: run?.string("kind")?.takeIf { it.equals("approval", ignoreCase = true) }
            ?: if (workflowState.equals("waiting_user", ignoreCase = true)) "reply" else null
        val serverUpdatedAt = parseTimestamp(
            item.string("lastActivityAt")
                ?: item.string("lastEventAt")
                ?: item.string("updatedAt")
                ?: item.string("created"),
        ) ?: existing?.updatedAt ?: System.currentTimeMillis()
        return SessionEntity(
            id = id,
            title = item.string("title") ?: item.string("name") ?: existing?.title ?: "Unnamed session",
            projectId = if (item.containsKey("projectId")) item.string("projectId") else existing?.projectId,
            status = rawStatus,
            latestSeq = latestSeq,
            updatedAt = serverUpdatedAt,
            lastAssistantMessageAt = parseTimestamp(item.string("lastAssistantMessageAt")) ?: existing?.lastAssistantMessageAt,
            lastReviewedAt = parseTimestamp(item.string("lastReviewedAt")) ?: existing?.lastReviewedAt,
            workflowStateChangedAt = parseTimestamp(item.string("workflowStateChangedAt")) ?: existing?.workflowStateChangedAt,
            workflowState = workflowState ?: existing?.workflowState,
            waitingAction = waitingAction ?: existing?.waitingAction,
            templateId = item.string("templateId") ?: existing?.templateId,
            queuedMessagesJson = queuedMessagesJson(item, existing?.queuedMessagesJson),
            timelineProjectionVersion = existing?.timelineProjectionVersion ?: 2,
            pinned = (item["pinned"] as? JsonPrimitive)?.booleanOrNull ?: if (authoritative) false else existing?.pinned ?: false,
        )
    }

    private fun queuedMessagesJson(item: JsonObject, fallback: String?): String? {
        if (!item.containsKey("queuedMessages")) return fallback
        return runCatching { item["queuedMessages"]?.jsonArray?.toString() ?: "[]" }.getOrDefault("[]")
    }

    private fun sessionIdFromPath(path: String): String {
        val prefix = "/api/sessions/"
        if (!path.startsWith(prefix)) return ""
        return Uri.decode(path.removePrefix(prefix).substringBefore('/'))
    }

    private fun queuedMessagesFromJson(value: String?): List<QueuedMessage> = runCatching {
        value?.takeIf { it.isNotBlank() }?.let { codec.decode(serializer<List<QueuedFollowUpDto>>(), it) }.orEmpty()
    }.getOrDefault(emptyList()).mapNotNull { queued ->
        queued.requestId.takeIf { it.isNotBlank() }?.let {
            QueuedMessage(
                requestId = it,
                responseId = queued.responseId,
                text = queued.text,
                queuedAt = parseTimestamp(queued.queuedAt),
                attachments = queued.allAttachments().map { attachment ->
                    Attachment(
                        assetId = attachment.assetId,
                        filename = attachment.filename,
                        originalName = attachment.originalName,
                        mimeType = attachment.mimeType,
                        sizeBytes = attachment.sizeBytes,
                        downloadUrl = attachment.downloadUrl,
                        url = attachment.url,
                        caption = attachment.caption,
                    )
                },
                tool = queued.tool,
                model = queued.model,
                effort = queued.effort,
                serviceTier = queued.serviceTier,
                interactionMode = queued.interactionMode,
                permissionMode = queued.permissionMode,
                templateId = queued.templateId,
                planAction = queued.planAction,
                planId = queued.planId,
                thinking = queued.thinking,
            )
        }
    }

    private suspend fun execute(request: ApiRequest): com.andysagent.agentoc.core.network.ApiResponse = try {
        transport.execute(request)
    } catch (error: ApiException) {
        throw SessionRepositoryException(error.statusCode, error.code, error.message, error.retryable, error)
    }

    private fun encode(value: String): String = Uri.encode(value)

    private fun toDomain(item: ComputerEntity): Computer = Computer(
        id = item.id,
        name = item.name,
        platform = item.platform,
        endpoint = item.endpoint,
        connected = item.connected,
    )

    private fun toDomain(item: ProjectEntity): Project = Project(
        id = item.id,
        name = item.name,
        folder = item.folder,
        pinned = item.pinned,
    )

    private fun toDomain(item: SessionEntity): Session = Session(
        id = item.id,
        title = item.title,
        projectId = item.projectId,
        status = sessionStatusFromRaw(item.status),
        latestSeq = item.latestSeq,
        updatedAt = item.updatedAt,
        templateId = item.templateId,
        lastAssistantMessageAt = item.lastAssistantMessageAt,
        lastReviewedAt = item.lastReviewedAt,
        workflowStateChangedAt = item.workflowStateChangedAt,
        workflowState = item.workflowState,
        waitingAction = item.waitingAction,
        queuedMessages = queuedMessagesFromJson(item.queuedMessagesJson),
        pinned = item.pinned,
    )

    private fun parseTimestamp(value: String?): Long? {
        val normalized = value?.trim().orEmpty()
        if (normalized.isEmpty()) return null
        normalized.toLongOrNull()?.let { return it }
        return runCatching { java.time.Instant.parse(normalized).toEpochMilli() }.getOrNull()
    }
}

private data class TimelineProjectionInput(
    val durable: List<Message>,
    val live: List<com.andysagent.agentoc.core.timeline.TimelineEvent>,
    val artifacts: List<SessionEventDto> = emptyList(),
    val visible: List<TimelineItem> = emptyList(),
)

private class RoomCursorStore(private val dao: AgentoCDao) : CursorStore {
    override suspend fun load(scope: String): SyncCursor = dao.getCursor(scope)?.let {
        SyncCursor(it.scope, it.lastAppliedSeq, it.lastEventId, it.lastServerCursor, it.lastSnapshotVersion)
    } ?: SyncCursor(scope)

    override suspend fun save(cursor: SyncCursor) {
        dao.upsertCursor(SyncCursorEntity(
            scope = cursor.scope,
            lastAppliedSeq = cursor.lastAppliedSeq,
            lastEventId = cursor.lastEventId,
            lastServerCursor = cursor.lastServerCursor,
            lastSnapshotVersion = cursor.lastSnapshotVersion,
            updatedAt = System.currentTimeMillis(),
        ))
    }
}

private class RoomEventSink(
    private val database: AgentoCDatabase,
    private val dao: AgentoCDao,
) : AtomicEventSink {
    override suspend fun validate(scope: String, event: SessionEventDto): EventValidation {
        val eventId = event.storageEventId(scope)
        val scoped = dao.getSessionEvent(eventId)
        if (scoped != null && scoped.sessionId != scope) return EventValidation.Invalid("Event scope does not match storage")
        // Old versions used an unscoped primary key. Such a row only owns its
        // own conversation, even when another session reuses the event ID.
        val oldKey = event.legacyDedupeKey()
        val legacyScoped = oldKey?.let { dao.getSessionEvent("session:${scope.length}:$scope:$it") }
        val legacyUnscoped = oldKey?.let { dao.getSessionEvent(it) }
        // An old unscoped row can belong to another run with the same harness ID.
        val existing = scoped ?: listOfNotNull(legacyScoped, legacyUnscoped)
            .firstOrNull { it.sessionId == scope && it.seq == event.boundarySeq() }
            ?: return EventValidation.New
        return if (existing.fingerprint == event.fingerprint()) EventValidation.Duplicate
        else EventValidation.Invalid("Event ID was reused with different content")
    }

    override suspend fun applyAtomically(scope: String, event: SessionEventDto, cursor: com.andysagent.agentoc.core.model.SyncCursor) {
        database.withTransaction {
            applyProjection(scope, event)
            dao.insertSessionEvent(
                SessionEventEntity(
                    eventId = event.storageEventId(scope),
                    sessionId = scope,
                    seq = event.boundarySeq(),
                    entityId = event.entityId ?: event.messageId ?: event.operationId,
                    revision = event.revision,
                    clientId = event.clientId,
                    type = event.type,
                    fingerprint = event.fingerprint(),
                    appliedAt = System.currentTimeMillis(),
                ),
            )
            dao.upsertCursor(SyncCursorEntity(
                scope = cursor.scope,
                lastAppliedSeq = cursor.lastAppliedSeq,
                lastEventId = cursor.lastEventId,
                lastServerCursor = cursor.lastServerCursor,
                lastSnapshotVersion = cursor.lastSnapshotVersion,
                updatedAt = System.currentTimeMillis(),
            ))
        }
    }

    override suspend fun apply(scope: String, event: SessionEventDto) {
        applyProjection(scope, event)
    }

    private suspend fun applyProjection(scope: String, event: SessionEventDto) {
        val type = event.type.orEmpty().lowercase()
        val requestId = event.requestKey()
        val text = event.textContent() ?: event.content?.toString()
        if (event.isTimelineMessage()) {
            val id = event.messageProjectionId()
            val existing = dao.getMessage(id)?.takeIf { it.sessionId == scope }
            val previous = existing?.let {
                ProjectedMessage(it.id, it.role, it.content, it.seq ?: event.boundarySeq(),
                    it.lastEventSeq, it.revision, it.messageState, it.requestId, it.runId, it.messagePhase)
            }
            val next = reduceMessage(previous, event, event.boundarySeq())
            dao.upsertMessages(listOf(MessageEntity(
                id = next.id, sessionId = scope, role = next.role, content = next.text,
                seq = next.firstSeq, requestId = next.requestId, runId = next.runId,
                completed = next.completed, updatedAt = System.currentTimeMillis(),
                lastEventSeq = next.lastEventSeq, revision = next.revision, messageState = next.state,
                messagePhase = next.messagePhase,
            )))
        }
        event.terminalRunState()?.let { terminal ->
            val unsettled = dao.getMessages(scope).filter { message ->
                !message.completed && if (!event.runId.isNullOrBlank()) message.runId == event.runId
                    else !event.requestId.isNullOrBlank() && message.requestId == event.requestId
            }
            dao.upsertMessages(unsettled.map { it.copy(
                completed = true, messageState = terminal,
                lastEventSeq = maxOf(it.lastEventSeq, event.boundarySeq()),
                updatedAt = System.currentTimeMillis(),
            ) })
            // A terminal run can no longer accept its outstanding approvals.
            // Never resolve requests belonging to a different run.
            retirePendingApprovals(scope, runId = event.runId, requestId = event.requestId)
        }
        val session = dao.getSession(scope)
        if (session != null) {
            val status = event.terminalRunState()?.let { if (it == "interrupted") "cancelled" else it } ?: when {
                type.contains("approval_request") || type.contains("confirmation_request")
                    || type == "privileged_batch_request" || type == "approved_action_batch_request" -> "waiting_approval"
                type.contains("approval_response") || type.contains("confirmation_response")
                    || type == "privileged_batch_response" || type == "approved_action_batch_response"
                    || type == "approved_action_state" || type.contains("decision") -> "working"
                type.contains("failed") || type.contains("error") -> "failed"
                type.contains("cancel") -> "cancelled"
                type.contains("completed") || type.contains("done") || type.contains("finished") -> "completed"
                type.contains("started") || type.contains("running") || type.contains("delta") -> "working"
                else -> session.status
            }
            dao.upsertSessions(listOf(session.copy(status = status, latestSeq = maxOf(session.latestSeq, event.boundarySeq()), updatedAt = System.currentTimeMillis())))
        }
        val isApprovalRequest = type == "approval_request"
            || type == "confirmation_request"
            || type == "privileged_batch_request"
            || type == "approved_action_batch_request"
        val isApprovalResponse = type == "approval_response"
            || type == "confirmation_response"
            || type == "privileged_batch_response"
            || type == "approved_action_batch_response"
            || type == "approved_action_state"
            || type == "decision"
        val isServerManagedInstallOnly = type == "privileged_batch_request"
            && event.other.isEmpty()
            && event.delete.isEmpty()
            && event.installAuto.isNotEmpty()
        if (isApprovalRequest && !isServerManagedInstallOnly) {
            val approvalId = event.approvalId ?: event.batchId ?: requestId
            val details = buildApprovalDetails(event)
            val priorStatus = dao.getApproval(scope, approvalId)?.takeIf { it.runId == event.runId }
                ?.status?.lowercase()?.takeIf {
                    it in setOf("resolved", "approved", "denied", "declined", "cancelled", "canceled", "completed", "failed", "expired")
                }
            dao.upsertApprovals(listOf(ApprovalEntity(
                id = approvalId,
                sessionId = scope,
                title = event.title ?: text ?: event.batchId ?: type,
                // Event replay and visible-history recovery can encounter an old
                // request after its response was submitted. Never let that old
                // request resurrect itself as actionable.
                status = priorStatus ?: "pending",
                runId = event.runId,
                batchId = event.batchId,
                kind = type,
                detailsJson = details,
                reason = event.reason,
                saferAlternative = event.saferAlternative,
                approveLabel = event.approveLabel ?: "Approve",
                denyLabel = event.denyLabel ?: "Deny",
                updatedAt = System.currentTimeMillis(),
            )))
        } else if (type == "privileged_batch_response") {
            val batchId = event.batchId ?: return
            val existing = dao.getApproval(scope, event.approvalId ?: batchId) ?: dao.getApprovalByBatchId(scope, batchId) ?: return
            val updated = existing.withPrivilegedCategoryResponse(event)
            dao.upsertApprovals(listOf(updated))
            if (updated.status == "pending") {
                dao.getSession(scope)?.let { dao.upsertSessions(listOf(it.copy(status = "waiting_approval", updatedAt = System.currentTimeMillis()))) }
            }
        } else if (type == "approved_action_batch_response") {
            val batchId = event.batchId ?: return
            val existing = dao.getApproval(scope, batchId)
            if (existing != null) {
                dao.upsertApprovals(listOf(existing.withApprovedActionBatchResponse(event)))
            }
        } else if (type == "approved_action_state") {
            val batchId = event.batchId ?: event.approvalId ?: requestId
            val existing = dao.getApproval(scope, batchId)
            if (existing != null) {
                dao.upsertApprovals(listOf(existing.withApprovedActionState(event)))
            }
        } else if (isApprovalResponse && type != "approved_action_batch_response") {
            dao.updateApprovalStatus(event.approvalId ?: event.batchId ?: requestId, "resolved", System.currentTimeMillis())
        }
        // A response can resolve just one of several concurrent provider requests.
        // Subsequent streaming events can also arrive while another request is
        // still waiting. Preserve the waiting state for the matching run until
        // its ordinary or privileged approval has actually been resolved.
        if (session != null && event.terminalRunState() == null &&
            (type == "approval_response" || type == "confirmation_response" || type == "decision" ||
                type == "privileged_batch_response" || type.contains("delta") ||
                type.contains("started") || type.contains("running"))) {
            val waiting = dao.getPendingApprovals(scope).any { approval ->
                approval.kind in setOf("approval_request", "confirmation_request", "privileged_batch_request") &&
                    (event.runId.isNullOrBlank() || approval.runId.isNullOrBlank() || approval.runId == event.runId)
            }
            if (waiting) dao.getSession(scope)?.let {
                if (sessionStatusFromRaw(it.status) == SessionStatus.Working) dao.upsertSessions(listOf(it.copy(
                    status = if (isAcceptedFirstTurnStatus(it.status)) ACCEPTED_FIRST_TURN_WAITING_STATUS else "waiting_approval",
                    updatedAt = System.currentTimeMillis(),
                )))
            }
        }
    }

    private suspend fun retirePendingApprovals(
        sessionId: String,
        runId: String? = null,
        requestId: String? = null,
    ) {
        val pending = dao.getPendingApprovals(sessionId)
        val matches = pending.filter { approval ->
            when {
                !runId.isNullOrBlank() && approval.runId == runId -> true
                !runId.isNullOrBlank() && !approval.runId.isNullOrBlank() -> false
                !requestId.isNullOrBlank() -> approval.id == requestId || approval.requestIdFromDetails() == requestId
                else -> false
            }
        }
        if (matches.isNotEmpty()) {
            val now = System.currentTimeMillis()
            dao.upsertApprovals(matches.map { it.copy(status = "resolved", updatedAt = now) })
        }
    }
}

private val TERMINAL_SESSION_STATUS_NAMES = setOf("completed", "complete", "finished", "succeeded", "success", "failed", "error", "cancelled", "canceled", "interrupted", "stopped", "expired")
private val TERMINAL_RUN_ACTIVITY_STATES = setOf("completed", "complete", "finished", "succeeded", "success", "failed", "error", "cancelled", "canceled", "interrupted", "expired")
private val WAITING_SESSION_STATES = setOf("waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input", "waiting_approval")

private fun hasTerminalSessionDetail(item: JsonObject): Boolean {
    val reportedState = item.string("status") ?: item.string("workflowState") ?: return false
    return reportedState.trim().lowercase() in TERMINAL_SESSION_STATUS_NAMES
}

/** Idle detail is authoritative only when it also says there is no active wait or run. */
private fun isAuthoritativelyIdleSession(item: JsonObject): Boolean {
    val sessionState = (item.string("status") ?: item.string("workflowState"))?.trim()?.lowercase()
    if (sessionState != "idle") return false
    val workflowState = item.string("workflowState")?.trim()?.lowercase()
    if (workflowState in WAITING_SESSION_STATES) return false
    val attention = item.string("waitingAction") ?: item.string("attentionKind")
    if (!attention.isNullOrBlank()) return false
    val activity = item["activity"] as? JsonObject
    if ((activity?.get("actionRequired") as? JsonPrimitive)?.booleanOrNull == true) return false
    val run = activity?.get("run") as? JsonObject ?: return true
    val runState = (run["state"] ?: run["status"])?.let { (it as? JsonPrimitive)?.contentOrNull?.lowercase() }
    return runState == "idle" || runState in TERMINAL_RUN_ACTIVITY_STATES
}

private fun ApprovalEntity.requestIdFromDetails(): String? = runCatching {
    detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it).jsonObject["requestId"]?.jsonPrimitive?.contentOrNull }
}.getOrNull()

private val terminalApprovedActionStates = setOf("denied", "cancelled", "expired", "completed", "failed")

private fun ApprovalEntity.withPrivilegedCategoryResponse(event: SessionEventDto): ApprovalEntity {
    val category = when (event.category) {
        "other", "privileged_other" -> "privileged_other"
        "delete", "destructive_delete" -> "destructive_delete"
        else -> return this
    }
    val details = runCatching { detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it).jsonObject } }.getOrNull() ?: return this
    val actions = details["actions"]?.jsonArray.orEmpty().map { element ->
        val action = element.jsonObject
        if (action["category"]?.jsonPrimitive?.contentOrNull != category) return@map element
        val id = action["actionId"]?.jsonPrimitive?.contentOrNull
        val decision = id?.let { event.decisions?.get(it)?.jsonPrimitive?.contentOrNull }
        val resolvedState = when (decision) { "approved" -> "approved"; "denied" -> "denied"; else -> "resolved" }
        JsonObject(action.toMutableMap().apply { put("state", JsonPrimitive(resolvedState)) })
    }
    if (actions.none { it.jsonObject["category"]?.jsonPrimitive?.contentOrNull == category }) return this
    val pending = actions.any { action ->
        action.jsonObject["category"]?.jsonPrimitive?.contentOrNull in setOf("privileged_other", "destructive_delete") &&
            action.jsonObject["state"]?.jsonPrimitive?.contentOrNull.orEmpty() !in setOf("approved", "denied", "resolved", "cancelled", "expired")
    }
    val next = details.toMutableMap().apply { put("actions", buildJsonArray { actions.forEach(::add) }) }
    return copy(status = if (pending) "pending" else "resolved", detailsJson = JsonObject(next).toString(), updatedAt = System.currentTimeMillis())
}

private fun ApprovalEntity.withApprovedActionState(event: SessionEventDto): ApprovalEntity {
    val details = runCatching {
        detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it).jsonObject }
    }.getOrNull() ?: return copy(status = "pending", updatedAt = System.currentTimeMillis())
    val actionId = event.actionId ?: return copy(updatedAt = System.currentTimeMillis())
    val actions = details["actions"]?.jsonArray.orEmpty().map { element ->
        val action = element.jsonObject
        if (action["actionId"]?.jsonPrimitive?.contentOrNull != actionId) return@map element
        val next = action.toMutableMap()
        event.state?.let { next["state"] = JsonPrimitive(it) }
        event.updatedAt?.let { next["updatedAt"] = JsonPrimitive(it) }
        event.manifestHash?.let { next["manifestHash"] = JsonPrimitive(it) }
        event.authorization?.let {
            next["authorization"] = AgentocProtocol.json.encodeToJsonElement(serializer<ApprovalAuthorizationDto>(), it)
        }
        event.resultRef?.let { next["resultRef"] = it }
        JsonObject(next)
    }
    if (actions.isEmpty()) return copy(updatedAt = System.currentTimeMillis())
    val nextDetails = details.toMutableMap()
    nextDetails["actions"] = buildJsonArray { actions.forEach(::add) }
    val allTerminal = actions.all { action ->
        action.jsonObject["state"]?.jsonPrimitive?.contentOrNull.orEmpty() in terminalApprovedActionStates
    }
    return copy(
        status = if (allTerminal) "resolved" else "pending",
        detailsJson = JsonObject(nextDetails).toString(),
        updatedAt = System.currentTimeMillis(),
    )
}

private fun ApprovalEntity.withApprovedActionBatchResponse(event: SessionEventDto): ApprovalEntity {
    val details = runCatching {
        detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it).jsonObject }
    }.getOrNull() ?: return this
    val decisions = event.decisions ?: return this
    val actions = details["actions"]?.jsonArray.orEmpty().map { element ->
        val action = element.jsonObject
        val actionId = action["actionId"]?.jsonPrimitive?.contentOrNull
        val decision = actionId?.let { decisions[it]?.jsonPrimitive?.contentOrNull?.lowercase() }
        val state = when (decision) {
            "approved" -> "approved"
            "denied" -> "denied"
            "cancelled", "canceled" -> "cancelled"
            "expired" -> "expired"
            else -> null
        } ?: return@map element
        JsonObject(action.toMutableMap().apply { put("state", JsonPrimitive(state)) })
    }
    if (actions.isEmpty()) return this
    val nextDetails = details.toMutableMap().apply {
        put("actions", buildJsonArray { actions.forEach(::add) })
    }
    val allTerminal = actions.all { action ->
        action.jsonObject["state"]?.jsonPrimitive?.contentOrNull.orEmpty() in terminalApprovedActionStates
    }
    return copy(
        status = if (allTerminal) "resolved" else "pending",
        detailsJson = JsonObject(nextDetails).toString(),
        updatedAt = System.currentTimeMillis(),
    )
}

private fun SessionEventDto.storageEventId(scope: String): String =
    "session:${scope.length}:$scope:${legacyStorageEventId()}"

private fun SessionEventDto.legacyStorageEventId(): String = dedupeKey()
    ?: "fingerprint:${fingerprint()}"

private fun SessionEventDto.fingerprint(): String = sessionEventFingerprint()

private fun ApprovalEntity.approvalSourceSequence(): Long? = runCatching {
    val details = detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it) as? JsonObject }
    (details?.get("sourceSeq") as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
}.getOrNull()

private fun ApprovalEntity.needsExplanationRecovery(): Boolean {
    if (status != "pending" || kind != "approval_request") return false
    val details = runCatching { detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it) as? JsonObject } }.getOrNull() ?: return false
    return (details["command"] as? JsonPrimitive)?.contentOrNull?.isNotBlank() == true &&
        details["explanation"].toApprovalExplanation() == null
}

private fun JsonElement?.toApprovalExplanation(): ApprovalExplanation? {
    val obj = this as? JsonObject ?: return null
    fun text(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
    val explanation = ApprovalExplanation(
        summary = text("summary")?.takeUnless { Regex("^包含\\s*\\d+\\s*步操作(?:，.*)?$").matches(it) },
        reason = text("reason"), saferAlternative = text("saferAlternative"),
        operation = text("operation"),
        targets = (obj["targets"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) },
        conditional = (obj["conditional"] as? JsonPrimitive)?.booleanOrNull == true,
        partial = (obj["partial"] as? JsonPrimitive)?.booleanOrNull == true,
        riskCode = text("riskCode"),
        providerConflict = (obj["providerConflict"] as? JsonPrimitive)?.booleanOrNull == true,
        elevated = (obj["elevated"] as? JsonPrimitive)?.booleanOrNull == true,
    )
    return explanation.takeIf { it.summary != null || it.reason != null || it.saferAlternative != null || it.operation != null }
}

private fun ApprovalEntity.toDomainApproval(): Approval {
    val details = runCatching { detailsJson?.let { AgentocProtocol.json.parseToJsonElement(it).jsonObject } }.getOrNull()
    val optionsList = details?.get("options")?.jsonArray?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
    val isMulti = details?.get("isMultiSelect")?.jsonPrimitive?.booleanOrNull ?: false
    val risk = details?.get("riskLevel")?.jsonPrimitive?.contentOrNull
    val actions = details?.get("actions")?.jsonArray.orEmpty().mapNotNull { element ->
        runCatching {
            val action = element.jsonObject
            val actionId = action["actionId"]?.jsonPrimitive?.contentOrNull
                ?: return@runCatching null
            val authorization = action["authorization"]?.jsonObject?.let { auth ->
                ApprovalAuthorization(
                    source = auth["source"]?.jsonPrimitive?.contentOrNull,
                    approvedAt = auth["approvedAt"]?.jsonPrimitive?.contentOrNull,
                    credentialId = auth["credentialId"]?.jsonPrimitive?.contentOrNull,
                    selectionManifestHash = auth["selectionManifestHash"]?.jsonPrimitive?.contentOrNull,
                    permissionMode = auth["permissionMode"]?.jsonPrimitive?.contentOrNull,
                    capabilityRef = auth["capabilityRef"]?.jsonPrimitive?.contentOrNull,
                )
            }
            ApprovalAction(
                id = actionId,
                description = action["description"]?.jsonPrimitive?.contentOrNull
                    ?: action["reason"]?.jsonPrimitive?.contentOrNull
                    ?: actionId,
                summary = action["summary"]?.jsonPrimitive?.contentOrNull,
                reason = action["reason"]?.jsonPrimitive?.contentOrNull,
                command = action["command"]?.jsonPrimitive?.contentOrNull,
                cwd = action["cwd"]?.jsonPrimitive?.contentOrNull,
                category = action["category"]?.jsonPrimitive?.contentOrNull,
                executionClass = action["executionClass"]?.jsonPrimitive?.contentOrNull,
                state = action["state"]?.jsonPrimitive?.contentOrNull ?: "waiting_user",
                risk = action["risk"]?.jsonPrimitive?.contentOrNull,
                needsPasskey = action["needsPasskey"]?.jsonPrimitive?.booleanOrNull ?: false,
                manifestHash = action["manifestHash"]?.jsonPrimitive?.contentOrNull,
                expiresAt = action["expiresAt"]?.jsonPrimitive?.contentOrNull,
                authorization = authorization,
                updatedAt = action["updatedAt"]?.jsonPrimitive?.contentOrNull,
                explanation = action["explanation"].toApprovalExplanation(),
                identityAliases = listOf("id", "opId", "approvalId", "providerRequestId", "providerItemId")
                    .mapNotNull { key -> (action[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }.toSet(),
            )
        }.getOrNull()
    }
    val selectionManifestHash = details?.get("selectionManifestHash")?.jsonPrimitive?.contentOrNull
    val permissionMode = details?.get("permissionMode")?.jsonPrimitive?.contentOrNull
    val expiresAt = details?.get("expiresAt")?.jsonPrimitive?.contentOrNull
    val schemaVersion = details?.get("schemaVersion")?.jsonPrimitive?.intOrNull
    val channel = details?.get("channel")?.jsonPrimitive?.contentOrNull
    val structuredQuestions = details?.get("questions")?.jsonArray.orEmpty().mapNotNull { element ->
        runCatching {
            val question = element.jsonObject
            val options = question["options"]?.jsonArray.orEmpty().mapNotNull { optionElement ->
                val option = optionElement.jsonObject
                val label = option["label"]?.jsonPrimitive?.contentOrNull
                    ?: option["value"]?.jsonPrimitive?.contentOrNull
                label?.takeIf { it.isNotBlank() }?.let {
                    ApprovalOption(
                        label = it,
                        value = option["value"]?.jsonPrimitive?.contentOrNull ?: it,
                        description = option["description"]?.jsonPrimitive?.contentOrNull,
                    )
                }
            }
            val text = question["question"]?.jsonPrimitive?.contentOrNull.orEmpty()
            if (text.isBlank() && options.isEmpty()) null else ApprovalQuestion(
                id = question["id"]?.jsonPrimitive?.contentOrNull,
                header = question["header"]?.jsonPrimitive?.contentOrNull,
                question = text,
                options = options,
                isMultiSelect = question["multiSelect"]?.jsonPrimitive?.booleanOrNull
                    ?: question["isMultiSelect"]?.jsonPrimitive?.booleanOrNull ?: isMulti,
            )
        }.getOrNull()
    }
    val questions = structuredQuestions.ifEmpty {
        val text = details?.get("question")?.jsonPrimitive?.contentOrNull.orEmpty()
        if (text.isBlank() && optionsList.isEmpty()) emptyList() else listOf(
            ApprovalQuestion(
                question = text.ifBlank { title },
                options = optionsList.map { ApprovalOption(it) },
                isMultiSelect = isMulti,
            ),
        )
    }

    return Approval(
        id = id,
        sessionId = sessionId,
        title = title,
        status = status,
        runId = runId,
        batchId = batchId,
        kind = kind,
        detailsJson = detailsJson,
        explanation = details?.get("explanation").toApprovalExplanation(),
        reason = reason,
        saferAlternative = saferAlternative,
        approveLabel = approveLabel,
        denyLabel = denyLabel,
        options = optionsList,
        isMultiSelect = isMulti,
        riskLevel = risk,
        questions = questions,
        actions = actions,
        passkeyRequired = details?.get("passkeyRequired")?.jsonPrimitive?.booleanOrNull ?: (batchId != null),
        selectionManifestHash = selectionManifestHash,
        permissionMode = permissionMode,
        expiresAt = expiresAt,
        schemaVersion = schemaVersion,
        channel = channel,
        requestKind = details?.get("requestKind")?.jsonPrimitive?.contentOrNull,
        command = details?.get("command")?.jsonPrimitive?.contentOrNull,
        cwd = details?.get("cwd")?.jsonPrimitive?.contentOrNull,
        filePaths = details?.get("filePaths")?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull },
        grantRoot = details?.get("grantRoot")?.jsonPrimitive?.contentOrNull,
        permissionsJson = details?.get("permissions")?.toString(),
        executorUnavailableReasonCode = details?.get("executorUnavailableReasonCode")?.jsonPrimitive?.contentOrNull,
        defaultSelectedByCategory = buildMap {
            val defaults = details?.get("defaultSelected") as? JsonObject
            fun selected(vararg keys: String): Set<String>? = keys.firstNotNullOfOrNull { key ->
                (defaults?.get(key) as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet()
            }
            selected("other", "privileged_other")?.let { put("privileged_other", it) }
            selected("delete", "destructive_delete")?.let { put("destructive_delete", it) }
        },
        identityAliases = listOf("id", "approvalId", "batchId", "providerRequestId", "providerItemId")
            .mapNotNull { key -> (details?.get(key) as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty) }.toSet(),
    )
}

private fun buildApprovalDetails(event: SessionEventDto): String? {
    fun normalizedPrivilegedAction(source: JsonObject, category: String): JsonObject {
        val action = source.toMutableMap()
        val actionId = source.string("actionId") ?: source.string("opId")
        actionId?.let { action["actionId"] = JsonPrimitive(it) }
        action["category"] = JsonPrimitive(category)
        return JsonObject(action)
    }

    val details = buildJsonObject {
        if (event.boundarySeq() > 0) put("sourceSeq", JsonPrimitive(event.boundarySeq()))
        event.id?.let { put("id", JsonPrimitive(it)) }
        event.approvalId?.let { put("approvalId", JsonPrimitive(it)) }
        event.batchId?.let { put("batchId", JsonPrimitive(it)) }
        event.requestId?.let { put("requestId", JsonPrimitive(it)) }
        event.providerRequestId?.let { put("providerRequestId", JsonPrimitive(it)) }
        event.providerItemId?.let { put("providerItemId", JsonPrimitive(it)) }
        event.kind?.let { put("requestKind", JsonPrimitive(it)) }
        event.explanation?.let { put("explanation", it) }
        event.command?.let { put("command", JsonPrimitive(it)) }
        event.cwd?.let { put("cwd", JsonPrimitive(it)) }
        if (event.filePaths.isNotEmpty()) put("filePaths", buildJsonArray { event.filePaths.forEach { add(JsonPrimitive(it)) } })
        event.grantRoot?.let { put("grantRoot", JsonPrimitive(it)) }
        event.permissions?.let { put("permissions", it) }
        event.defaultSelected?.let { put("defaultSelected", it) }
        if (event.other.isNotEmpty()) put("other", buildJsonArray { event.other.forEach(::add) })
        if (event.delete.isNotEmpty()) put("delete", buildJsonArray { event.delete.forEach(::add) })
        if (event.installAuto.isNotEmpty()) put("installAuto", buildJsonArray { event.installAuto.forEach(::add) })
        val options = event.options.ifEmpty { event.choices }
        if (options.isNotEmpty()) put("options", buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
        event.isMultiSelect?.let { put("isMultiSelect", JsonPrimitive(it)) }
        (event.riskLevel ?: (event.risk as? JsonPrimitive)?.contentOrNull
            ?: (event.risk as? JsonObject)?.get("tier")?.jsonPrimitive?.contentOrNull)?.let { put("riskLevel", JsonPrimitive(it)) }
        event.passkeyRequired?.let { put("passkeyRequired", JsonPrimitive(it)) }
        event.executorUnavailableReasonCode?.let { put("executorUnavailableReasonCode", JsonPrimitive(it)) }
        event.question?.takeIf { it.isNotBlank() }?.let { put("question", JsonPrimitive(it)) }
        event.schemaVersion?.let { put("schemaVersion", JsonPrimitive(it)) }
        event.channel?.let { put("channel", JsonPrimitive(it)) }
        event.selectionManifestHash?.let { put("selectionManifestHash", JsonPrimitive(it)) }
        event.permissionMode?.let { put("permissionMode", JsonPrimitive(it)) }
        event.expiresAt?.let { put("expiresAt", JsonPrimitive(it)) }
        if (event.questions.isNotEmpty()) {
            put("questions", buildJsonArray {
                event.questions.forEach { question ->
                    add(buildJsonObject {
                        question.id?.let { put("id", JsonPrimitive(it)) }
                        question.header?.let { put("header", JsonPrimitive(it)) }
                        question.question?.let { put("question", JsonPrimitive(it)) }
                        (question.multiSelect ?: question.isMultiSelect)?.let { put("multiSelect", JsonPrimitive(it)) }
                        val questionOptions = question.allOptions()
                        if (questionOptions.isNotEmpty()) {
                            put("options", buildJsonArray {
                                questionOptions.forEach { option ->
                                    add(buildJsonObject {
                                        put("label", JsonPrimitive(option.label))
                                        option.value?.let { put("value", JsonPrimitive(it)) }
                                        option.description?.let { put("description", JsonPrimitive(it)) }
                                    })
                                }
                            })
                        }
                    })
                }
            })
        }
        val privilegedActions = buildList {
            event.other.forEach { add(normalizedPrivilegedAction(it, "privileged_other")) }
            event.delete.forEach { add(normalizedPrivilegedAction(it, "destructive_delete")) }
            event.installAuto.forEach { add(normalizedPrivilegedAction(it, "software_install")) }
        }
        if (event.actions.isNotEmpty()) {
            put("actions", buildJsonArray {
                event.actions.forEach { action ->
                    add(AgentocProtocol.json.encodeToJsonElement(serializer<ApprovedActionDto>(), action))
                }
            })
        } else if (privilegedActions.isNotEmpty()) {
            put("actions", buildJsonArray { privilegedActions.forEach(::add) })
        }
    }
    return details.takeIf { it.isNotEmpty() }?.toString()
}
