package com.andysagent.ragent.feature.organization.data

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.domain.OrganizationReducer
import com.andysagent.ragent.feature.organization.domain.OrganizationState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

interface OrganizationRepository {
    val state: StateFlow<OrganizationState>
    suspend fun refresh(organizationId: String? = null, sessionId: String? = null)
    fun applyProjection(dto: OrganizationProjectionDto)
    fun onEventReceived(event: OrganizationEventDto)
    suspend fun refreshSwarmAndBoard(sessionId: String, channel: String? = null) = Unit
    fun applySwarmStatus(dto: SwarmStatusDto?) = Unit
    fun applyBoardResponse(dto: SwarmBoardResponseDto?) = Unit
    fun clearSwarmAndBoard() = Unit
    fun selectBoardChannel(channel: String?) = Unit
    fun setBoardComposerDraft(draft: String) = Unit
    fun setBoardReplyToSeq(seq: Long?) = Unit
    suspend fun postBoardMessage(sessionId: String): Result<PostBoardMessageResponseDto> =
        Result.failure(UnsupportedOperationException("Board posting unavailable"))
}

class RealOrganizationRepository(
    private val api: OrganizationApi,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Default),
) : OrganizationRepository {

    private val _state = MutableStateFlow(OrganizationState())
    override val state: StateFlow<OrganizationState> = _state.asStateFlow()

    private var currentOrgId: String? = null
    private var currentSessionId: String? = null
    private var lastObservedSequence: Long = 0L
    private var coalescingJob: Job? = null
    private val pendingEvents = mutableListOf<OrganizationEventDto>()

    override suspend fun refresh(organizationId: String?, sessionId: String?) {
        val targetOrgId = organizationId ?: currentOrgId
        val targetSessionId = sessionId ?: currentSessionId

        currentOrgId = targetOrgId
        currentSessionId = targetSessionId

        if (!targetOrgId.isNullOrBlank()) {
            api.getProjection(targetOrgId).onSuccess { dto ->
                applyProjection(dto)
            }
        } else if (!targetSessionId.isNullOrBlank()) {
            api.getSessionOrganization(targetSessionId).onSuccess { dto ->
                if (dto != null) {
                    currentOrgId = dto.organizationId
                    applyProjection(dto)
                }
            }
        }
    }

    override fun applyProjection(dto: OrganizationProjectionDto) {
        lastObservedSequence = dto.asOf?.eventId ?: _state.value.sequence
        _state.update { OrganizationReducer.reduceProjection(it, dto) }
    }

    override suspend fun refreshSwarmAndBoard(sessionId: String, channel: String?) {
        currentSessionId = sessionId
        val activeChannel = channel ?: _state.value.selectedBoardChannel?.takeIf { it != "__all__" }
        coroutineScope {
            val swarmDeferred = async { api.getSwarmStatus(sessionId) }
            val boardDeferred = async { api.getBoard(sessionId, channel = activeChannel) }
            swarmDeferred.await().onSuccess { applySwarmStatus(it) }
            boardDeferred.await().onSuccess { applyBoardResponse(it) }
        }
    }

    override fun applySwarmStatus(dto: SwarmStatusDto?) {
        _state.update { OrganizationReducer.reduceSwarmStatus(it, dto) }
    }

    override fun applyBoardResponse(dto: SwarmBoardResponseDto?) {
        _state.update { OrganizationReducer.reduceBoardResponse(it, dto) }
    }

    override fun clearSwarmAndBoard() {
        _state.update { current ->
            val withoutSwarm = OrganizationReducer.reduceSwarmStatus(current, null)
            OrganizationReducer.reduceBoardResponse(withoutSwarm, null).copy(
                boardComposerDraft = "",
                boardPosting = false,
                boardError = null,
            )
        }
    }

    override fun selectBoardChannel(channel: String?) {
        val normalized = channel?.trim()?.takeIf { it.isNotEmpty() } ?: "__all__"
        _state.update { it.copy(selectedBoardChannel = normalized, boardError = null) }
    }

    override fun setBoardComposerDraft(draft: String) {
        _state.update { it.copy(boardComposerDraft = draft, boardError = null) }
    }

    override fun setBoardReplyToSeq(seq: Long?) {
        _state.update { it.copy(boardReplyToSeq = seq) }
    }

    override suspend fun postBoardMessage(sessionId: String): Result<PostBoardMessageResponseDto> {
        val current = _state.value
        val board = current.board
        if (board == null || !board.isWritable) {
            return Result.failure(IllegalStateException("Board is read-only"))
        }
        val body = current.boardComposerDraft.trim()
        if (body.isEmpty()) {
            return Result.failure(IllegalArgumentException("Message cannot be empty"))
        }
        val targetChannel = current.selectedBoardChannel
            ?.takeIf { it.isNotBlank() && it != "__all__" }
            ?: board.channels.firstOrNull()?.name
            ?: "main"
        val replyToSeq = current.boardReplyToSeq
        _state.update { it.copy(boardPosting = true, boardError = null) }

        val result = api.postBoardMessage(
            sessionId = sessionId,
            channel = targetChannel,
            bodyMarkdown = body,
            replyToSeq = replyToSeq,
            idempotencyKey = UUID.randomUUID().toString(),
        )
        result.onSuccess { posted ->
            val optimisticDto = posted.message?.let { message ->
                val existingBoard = _state.value.board
                if (existingBoard != null) {
                    val alreadyPresent = boardMessagesDtoContainsSeq(message.seq)
                    if (!alreadyPresent) {
                        val mergedMessage = OrganizationReducer.reduceBoardResponse(
                            _state.value,
                            SwarmBoardResponseDto(
                                rootSessionId = _state.value.rootSessionId,
                                organizationId = existingBoard.organizationId,
                                mode = existingBoard.mode,
                                readOnly = existingBoard.readOnly,
                                board = SwarmBoardPayloadDto(
                                    mode = existingBoard.mode,
                                    source = existingBoard.source,
                                    readOnly = existingBoard.readOnly,
                                    organizationId = existingBoard.organizationId,
                                    title = existingBoard.title,
                                    headSeq = maxOf(existingBoard.headSeq, posted.headSeq),
                                    isDone = existingBoard.isDone,
                                    messages = listOf(message),
                                ),
                            ),
                        ).board?.messages.orEmpty()
                        val merged = (existingBoard.messages + mergedMessage)
                            .distinctBy { it.seq }
                            .sortedBy { it.seq }
                        existingBoard.copy(
                            headSeq = maxOf(existingBoard.headSeq, posted.headSeq),
                            messages = merged,
                        )
                    } else existingBoard
                } else null
            }
            _state.update {
                it.copy(
                    board = optimisticDto ?: it.board,
                    boardComposerDraft = "",
                    boardReplyToSeq = null,
                    boardPosting = false,
                    boardError = null,
                )
            }
            val activeChannel = _state.value.selectedBoardChannel?.takeIf { ch -> ch != "__all__" }
            api.getBoard(sessionId, channel = activeChannel).onSuccess { refreshed ->
                if (refreshed != null) applyBoardResponse(refreshed)
            }
        }.onFailure { err ->
            _state.update {
                it.copy(
                    boardPosting = false,
                    boardError = err.message ?: "Failed to post message",
                )
            }
        }
        return result
    }

    private fun boardMessagesDtoContainsSeq(seq: Long): Boolean =
        _state.value.board?.messages?.any { it.seq == seq } == true

    override fun onEventReceived(event: OrganizationEventDto) {
        // Gap detection: if sequence jumps by more than 1, trigger snapshot refresh
        val expectedSeq = lastObservedSequence + 1
        if (event.id > expectedSeq && lastObservedSequence > 0) {
            // Gap detected! Re-fetch full snapshot
            scope.launch {
                currentOrgId?.let { refresh(it) }
            }
            return
        }

        lastObservedSequence = maxOf(lastObservedSequence, event.id)

        // Semantic coalescing: batch high-frequency activity updates
        synchronized(pendingEvents) {
            pendingEvents.add(event)
        }

        coalescingJob?.cancel()
        coalescingJob = scope.launch {
            delay(80) // 80ms coalescing window
            flushPendingEvents()
        }
    }

    private fun flushPendingEvents() {
        val eventsToProcess: List<OrganizationEventDto>
        synchronized(pendingEvents) {
            eventsToProcess = pendingEvents.toList()
            pendingEvents.clear()
        }
        if (eventsToProcess.isEmpty()) return

        // Apply events to state
        var currentState = _state.value
        // If structural change occurs in events, trigger projection refresh
        val hasStructuralChange = eventsToProcess.any {
            it.type in listOf("node.created", "node.retired", "revision.frozen", "plan.amendment")
        }
        if (hasStructuralChange) {
            scope.launch {
                currentOrgId?.let { refresh(it) }
            }
        }
    }
}
