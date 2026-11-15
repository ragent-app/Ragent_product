package com.andysagent.ragent.feature.organization.data

import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.domain.OrganizationReducer
import com.andysagent.ragent.feature.organization.domain.OrganizationState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

interface OrganizationRepository {
    val state: StateFlow<OrganizationState>
    suspend fun refresh(organizationId: String? = null, sessionId: String? = null)
    fun applyProjection(dto: OrganizationProjectionDto)
    fun onEventReceived(event: OrganizationEventDto)
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
        _state.value = OrganizationReducer.reduceProjection(_state.value, dto)
    }

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
