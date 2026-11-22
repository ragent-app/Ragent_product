package com.andysagent.ragent.feature.organization.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.feature.organization.data.ButlerBucket
import com.andysagent.ragent.feature.organization.data.ButlerOverviewItemDto
import com.andysagent.ragent.feature.organization.data.ButlerOverviewResponseDto
import com.andysagent.ragent.feature.organization.data.ButlerRepository
import com.andysagent.ragent.feature.organization.data.CreateVoiceSessionRequestDto
import com.andysagent.ragent.feature.organization.data.ResponsibilitySnapshotDto
import com.andysagent.ragent.feature.organization.data.VoiceAdaptersResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceApprovalCardDto
import com.andysagent.ragent.feature.organization.data.VoiceAsrInputDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceInterruptRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceSessionDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnResponseDto
import com.andysagent.ragent.feature.organization.data.overviewItemToApprovalCard
import com.andysagent.ragent.feature.organization.voice.AsrCaptureOutcome
import com.andysagent.ragent.feature.organization.voice.ButlerAsrAdapter
import com.andysagent.ragent.feature.organization.voice.ButlerDeviceIdentity
import com.andysagent.ragent.feature.organization.voice.ButlerTtsAdapter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

enum class ButlerFilter {
    ALL,
    IN_PROGRESS,
    AWAITING_DECISION,
    DELIVERED_ARTIFACTS,
    BLOCKED_AND_ALERTS,
}

enum class ButlerVoicePhase {
    IDLE,
    CREATING_SESSION,
    LISTENING,
    THINKING,
    SPEAKING,
    INTERRUPTED,
    ASR_ERROR,
    AWAITING_APPROVAL,
}

data class ButlerUiState(
    val organizationId: String = "",
    val rootSessionId: String = "",
    val overviewLoading: Boolean = false,
    val overviewError: String? = null,
    val overview: ButlerOverviewResponseDto? = null,
    val activeFilter: ButlerFilter = ButlerFilter.ALL,
    val voiceSheetOpen: Boolean = false,
    val voicePhase: ButlerVoicePhase = ButlerVoicePhase.IDLE,
    val continuousMode: Boolean = true,
    val boundResponsibilityId: String? = null,
    val boundResponsibilityTitle: String? = null,
    val voiceSession: VoiceSessionDto? = null,
    val availableSessions: List<VoiceSessionDto> = emptyList(),
    val turns: List<VoiceTurnDto> = emptyList(),
    val handoffs: List<VoiceHandoffDto> = emptyList(),
    val responsibilitySnapshot: ResponsibilitySnapshotDto? = null,
    val adapters: VoiceAdaptersResponseDto? = null,
    val selectedAsrEngineId: String? = null,
    val selectedReasonerEngineId: String? = null,
    val selectedTtsEngineId: String? = null,
    val minConfidence: Double = 0.55,
    val rmsLevel: Float = 0f,
    val asrErrorBanner: String? = null,
    val clarificationPrompt: String? = null,
    val voiceError: String? = null,
    val handoffNotice: String? = null,
    val draftText: String = "",
    val lastInterruptedGeneration: Long? = null,
    val bargeInCount: Int = 0,
    val pendingApprovalCard: VoiceApprovalCardDto? = null,
    val pendingApprovalIdempotencyKey: String? = null,
    val approvalConfirmBusy: Boolean = false,
    val approvalConfirmError: String? = null,
    val approvalConfirmNotice: String? = null,
)

class ButlerViewModel(
    private val repository: ButlerRepository,
    private val asrAdapter: ButlerAsrAdapter,
    private val ttsAdapter: ButlerTtsAdapter,
    private val deviceIdentity: ButlerDeviceIdentity,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ButlerUiState())
    val uiState: StateFlow<ButlerUiState> = _uiState.asStateFlow()

    private val voiceMutex = Mutex()
    private var activeListenJob: Job? = null
    private var latestExpectedGeneration: Long = 0L
    private var lastSubmittedOrganizationId: String? = null

    init {
        viewModelScope.launch {
            asrAdapter.rmsLevel.collect { level ->
                _uiState.update { it.copy(rmsLevel = level) }
            }
        }
    }

    fun initialize(organizationId: String, rootSessionId: String) {
        val changed = _uiState.value.organizationId != organizationId || _uiState.value.rootSessionId != rootSessionId
        _uiState.update { it.copy(organizationId = organizationId, rootSessionId = rootSessionId) }
        if (changed || lastSubmittedOrganizationId != organizationId) {
            lastSubmittedOrganizationId = organizationId
            refreshOverview()
            loadVoiceMetadata()
        }
    }

    fun setFilter(filter: ButlerFilter) {
        _uiState.update { it.copy(activeFilter = filter) }
    }

    fun setContinuousMode(enabled: Boolean) {
        _uiState.update { it.copy(continuousMode = enabled) }
    }

    fun setDraftText(text: String) {
        _uiState.update { it.copy(draftText = text) }
    }

    fun selectAdapters(asrId: String? = null, reasonerId: String? = null, ttsId: String? = null) {
        _uiState.update {
            it.copy(
                selectedAsrEngineId = asrId ?: it.selectedAsrEngineId,
                selectedReasonerEngineId = reasonerId ?: it.selectedReasonerEngineId,
                selectedTtsEngineId = ttsId ?: it.selectedTtsEngineId,
            )
        }
    }

    fun refreshOverview() {
        val orgId = _uiState.value.organizationId
        viewModelScope.launch {
            _uiState.update { it.copy(overviewLoading = true, overviewError = null) }
            repository.getButlerOverview(organizationId = orgId.takeIf { it.isNotBlank() })
                .onSuccess { data ->
                    _uiState.update {
                        it.copy(
                            overviewLoading = false,
                            overviewError = null,
                            overview = data,
                        )
                    }
                }
                .onFailure { err ->
                    if (err is CancellationException) throw err
                    _uiState.update {
                        it.copy(
                            overviewLoading = false,
                            overviewError = err.message ?: "Unable to load butler overview",
                        )
                    }
                }
        }
    }

    fun loadVoiceMetadata(responsibilityId: String? = _uiState.value.boundResponsibilityId) {
        viewModelScope.launch {
            repository.getVoiceAdapters().onSuccess { adapters ->
                _uiState.update { current ->
                    current.copy(
                        adapters = adapters,
                        selectedAsrEngineId = current.selectedAsrEngineId
                            ?: adapters.asr.firstOrNull { it.isDefault && it.available }?.id
                            ?: adapters.asr.firstOrNull { it.available }?.id,
                        selectedReasonerEngineId = current.selectedReasonerEngineId
                            ?: adapters.reasoner.firstOrNull { it.isDefault && it.available }?.id
                            ?: adapters.reasoner.firstOrNull { it.available }?.id,
                        selectedTtsEngineId = current.selectedTtsEngineId
                            ?: adapters.tts.firstOrNull { it.isDefault && it.available }?.id
                            ?: adapters.tts.firstOrNull { it.available }?.id,
                    )
                }
            }
            repository.listVoiceSessions(responsibilityId = responsibilityId).onSuccess { list ->
                _uiState.update { it.copy(availableSessions = list.sessions) }
            }
        }
    }

    fun openVoiceButler(
        responsibilityId: String? = null,
        responsibilityTitle: String? = null,
        existingVoiceSessionId: String? = null,
        autoStartListening: Boolean = false,
    ) {
        _uiState.update {
            it.copy(
                voiceSheetOpen = true,
                boundResponsibilityId = responsibilityId ?: it.boundResponsibilityId,
                boundResponsibilityTitle = responsibilityTitle ?: it.boundResponsibilityTitle,
                asrErrorBanner = null,
                clarificationPrompt = null,
                voiceError = null,
                handoffNotice = null,
            )
        }
        viewModelScope.launch {
            loadVoiceMetadata(responsibilityId)
            val currentSession = _uiState.value.voiceSession
            val targetSessionId = existingVoiceSessionId
                ?: currentSession?.takeIf {
                    responsibilityId == null || it.responsibilityId == responsibilityId
                }?.id
            if (!targetSessionId.isNullOrBlank()) {
                resumeVoiceSessionInternal(targetSessionId)
            } else {
                createNewVoiceSessionInternal(responsibilityId)
            }
            if (autoStartListening && _uiState.value.voiceSession != null && _uiState.value.pendingApprovalCard == null) {
                startListeningOrBargeIn()
            }
        }
    }

    fun closeVoiceButler() {
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        ttsAdapter.stopImmediately("sheet_closed")
        _uiState.update {
            it.copy(
                voiceSheetOpen = false,
                voicePhase = if (it.pendingApprovalCard != null) ButlerVoicePhase.AWAITING_APPROVAL else ButlerVoicePhase.IDLE,
                rmsLevel = 0f,
            )
        }
    }

    fun startNewVoiceSession(responsibilityId: String? = _uiState.value.boundResponsibilityId, title: String? = null) {
        ttsAdapter.stopImmediately("new_session")
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        if (title != null) {
            _uiState.update { it.copy(boundResponsibilityTitle = title) }
        }
        viewModelScope.launch {
            createNewVoiceSessionInternal(responsibilityId)
        }
    }

    fun resumeVoiceSession(sessionId: String) {
        ttsAdapter.stopImmediately("resume_session")
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        viewModelScope.launch {
            resumeVoiceSessionInternal(sessionId)
        }
    }

    fun refreshActiveVoiceSession() {
        val sessionId = _uiState.value.voiceSession?.id ?: return
        viewModelScope.launch {
            resumeVoiceSessionInternal(sessionId)
        }
    }

    fun startListeningOrBargeIn() {
        val current = _uiState.value
        if (current.pendingApprovalCard != null) {
            _uiState.update {
                it.copy(
                    voicePhase = ButlerVoicePhase.AWAITING_APPROVAL,
                    voiceError = "Review or dismiss the pending visual approval card before continuing.",
                )
            }
            return
        }
        if (current.voicePhase == ButlerVoicePhase.LISTENING) {
            asrAdapter.stopListening()
            return
        }
        val wasSpeaking = current.voicePhase == ButlerVoicePhase.SPEAKING || ttsAdapter.isSpeaking.value
        activeListenJob?.cancel()
        activeListenJob = viewModelScope.launch {
            if (wasSpeaking) {
                performBargeInLocked(reason = "user_barge_in")
            }
            captureAndSubmitVoiceTurn(interruptCurrent = wasSpeaking)
        }
    }

    fun interruptSpeakingOnly(reason: String = "user_interrupt") {
        val session = _uiState.value.voiceSession
        val wasSpeaking = _uiState.value.voicePhase == ButlerVoicePhase.SPEAKING || ttsAdapter.isSpeaking.value
        val (stoppedGen, stoppedChunk) = ttsAdapter.stopImmediately(reason)
        if (!wasSpeaking && stoppedGen <= 0L) return
        _uiState.update {
            it.copy(
                voicePhase = ButlerVoicePhase.INTERRUPTED,
                lastInterruptedGeneration = stoppedGen.takeIf { g -> g > 0L } ?: it.lastInterruptedGeneration,
                bargeInCount = it.bargeInCount + 1,
            )
        }
        if (session != null) {
            viewModelScope.launch {
                voiceMutex.withLock {
                    callServerInterrupt(session, stoppedGen, stoppedChunk, reason)
                }
            }
        }
    }

    fun submitTypedOrSimulatedTurn(
        transcript: String,
        confidence: Double = 0.96,
        asrStatus: String = "ok",
        errorCode: String? = null,
        errorMessage: String? = null,
    ) {
        val current = _uiState.value
        if (current.pendingApprovalCard != null) {
            _uiState.update {
                it.copy(voiceError = "Confirm or cancel the pending visual approval card first.")
            }
            return
        }
        val wasSpeaking = current.voicePhase == ButlerVoicePhase.SPEAKING || ttsAdapter.isSpeaking.value
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        viewModelScope.launch {
            if (_uiState.value.voiceSession == null) {
                createNewVoiceSessionInternal(_uiState.value.boundResponsibilityId)
            }
            if (_uiState.value.voiceSession == null) return@launch
            if (wasSpeaking) {
                performBargeInLocked(reason = "user_barge_in")
            }
            submitTurnInternal(
                asr = VoiceAsrInputDto(
                    transcript = transcript,
                    confidence = confidence,
                    status = asrStatus,
                    errorCode = errorCode,
                    errorMessage = errorMessage,
                    engineId = _uiState.value.selectedAsrEngineId ?: "local",
                    mode = "local",
                ),
                interruptCurrent = wasSpeaking,
                allowContinuousRestart = false,
            )
        }
    }

    fun requestHandoff(
        targetDeviceId: String,
        targetDeviceType: String,
        targetDeviceLabel: String? = null,
        targetRootSessionId: String? = null,
        reason: String = "user_requested_cross_device_handoff",
    ) {
        val session = _uiState.value.voiceSession ?: return
        val cleanTargetId = targetDeviceId.trim()
        if (cleanTargetId.isEmpty()) {
            _uiState.update { it.copy(voiceError = "Target device ID is required for handoff.") }
            return
        }
        ttsAdapter.stopImmediately("handoff")
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        viewModelScope.launch {
            voiceMutex.withLock {
                repository.handoffVoiceSession(
                    sessionId = session.id,
                    request = VoiceHandoffRequestDto(
                        targetDeviceId = cleanTargetId,
                        targetDeviceType = targetDeviceType.trim().ifEmpty { "desktop" },
                        targetDeviceLabel = targetDeviceLabel?.trim()?.takeIf { it.isNotEmpty() },
                        targetRootSessionId = targetRootSessionId?.trim()?.takeIf { it.isNotEmpty() },
                        expectedRowVersion = session.rowVersion,
                        reason = reason,
                        idempotencyKey = UUID.randomUUID().toString(),
                    ),
                ).onSuccess { res ->
                    latestExpectedGeneration = res.session.playbackGeneration
                    _uiState.update { state ->
                        val updatedHandoffs = res.handoff?.let { h ->
                            (state.handoffs + h).distinctBy { it.id }
                        } ?: state.handoffs
                        state.copy(
                            voiceSession = res.session,
                            turns = if (res.turns.isNotEmpty()) res.turns else state.turns,
                            handoffs = updatedHandoffs,
                            responsibilitySnapshot = res.responsibilitySnapshot ?: state.responsibilitySnapshot,
                            voicePhase = ButlerVoicePhase.IDLE,
                            voiceError = null,
                            handoffNotice = "Synced to ${res.session.activeDeviceLabel ?: res.session.activeDeviceType ?: cleanTargetId}",
                        )
                    }
                }.onFailure { err ->
                    if (err is CancellationException) throw err
                    _uiState.update {
                        it.copy(voiceError = err.message ?: "Cross-device handoff failed")
                    }
                }
            }
        }
    }

    fun openApprovalFromOverviewItem(item: ButlerOverviewItemDto) {
        val card = overviewItemToApprovalCard(item)
        openVisualApprovalCard(card)
    }

    fun openVisualApprovalCard(card: VoiceApprovalCardDto) {
        ttsAdapter.stopImmediately("approval_open")
        activeListenJob?.cancel()
        activeListenJob = null
        asrAdapter.cancel()
        _uiState.update {
            it.copy(
                pendingApprovalCard = card,
                pendingApprovalIdempotencyKey = UUID.randomUUID().toString(),
                approvalConfirmBusy = false,
                approvalConfirmError = null,
                approvalConfirmNotice = null,
                voicePhase = ButlerVoicePhase.AWAITING_APPROVAL,
            )
        }
    }

    fun dismissVisualApprovalCard() {
        _uiState.update {
            it.copy(
                pendingApprovalCard = null,
                pendingApprovalIdempotencyKey = null,
                approvalConfirmBusy = false,
                approvalConfirmError = null,
                voicePhase = ButlerVoicePhase.IDLE,
            )
        }
    }

    fun confirmPendingApproval() {
        val state = _uiState.value
        val card = state.pendingApprovalCard ?: return
        if (state.approvalConfirmBusy) return
        val key = state.pendingApprovalIdempotencyKey ?: UUID.randomUUID().toString()
        _uiState.update {
            it.copy(
                pendingApprovalIdempotencyKey = key,
                approvalConfirmBusy = true,
                approvalConfirmError = null,
                approvalConfirmNotice = null,
            )
        }
        viewModelScope.launch {
            repository.confirmVisualApproval(card, key)
                .onSuccess {
                    _uiState.update { current ->
                        current.copy(
                            pendingApprovalCard = null,
                            pendingApprovalIdempotencyKey = null,
                            approvalConfirmBusy = false,
                            approvalConfirmError = null,
                            approvalConfirmNotice = "Confirmed: ${card.title.ifBlank { card.kind }}",
                            voicePhase = ButlerVoicePhase.IDLE,
                        )
                    }
                    refreshOverview()
                    refreshActiveVoiceSession()
                }
                .onFailure { err ->
                    if (err is CancellationException) throw err
                    _uiState.update { current ->
                        current.copy(
                            approvalConfirmBusy = false,
                            approvalConfirmError = err.message ?: "Confirmation failed; retry uses the same key.",
                        )
                    }
                }
        }
    }

    fun clearNotices() {
        _uiState.update {
            it.copy(
                asrErrorBanner = null,
                clarificationPrompt = null,
                voiceError = null,
                handoffNotice = null,
                approvalConfirmNotice = null,
            )
        }
    }

    private suspend fun createNewVoiceSessionInternal(responsibilityId: String?) {
        _uiState.update { it.copy(voicePhase = ButlerVoicePhase.CREATING_SESSION, voiceError = null) }
        val state = _uiState.value
        repository.createVoiceSession(
            CreateVoiceSessionRequestDto(
                responsibilityId = responsibilityId?.takeIf { it.isNotBlank() },
                rootSessionId = state.rootSessionId.takeIf { it.isNotBlank() },
                deviceId = deviceIdentity.deviceId,
                deviceType = deviceIdentity.deviceType,
                deviceLabel = deviceIdentity.deviceLabel,
                asrEngineId = state.selectedAsrEngineId,
                reasonerEngineId = state.selectedReasonerEngineId,
                ttsEngineId = state.selectedTtsEngineId,
                idempotencyKey = UUID.randomUUID().toString(),
            ),
        ).onSuccess { detail ->
            latestExpectedGeneration = detail.session.playbackGeneration
            _uiState.update { current ->
                current.copy(
                    voiceSession = detail.session,
                    boundResponsibilityId = detail.session.responsibilityId ?: current.boundResponsibilityId,
                    turns = detail.turns,
                    handoffs = detail.handoffs,
                    responsibilitySnapshot = detail.responsibilitySnapshot,
                    voicePhase = ButlerVoicePhase.IDLE,
                    voiceError = null,
                )
            }
        }.onFailure { err ->
            if (err is CancellationException) throw err
            _uiState.update {
                it.copy(
                    voicePhase = ButlerVoicePhase.IDLE,
                    voiceError = err.message ?: "Unable to start voice session",
                )
            }
        }
    }

    private suspend fun resumeVoiceSessionInternal(sessionId: String) {
        repository.getVoiceSession(sessionId).onSuccess { detail ->
            latestExpectedGeneration = detail.session.playbackGeneration
            _uiState.update { current ->
                current.copy(
                    voiceSession = detail.session,
                    boundResponsibilityId = detail.session.responsibilityId ?: current.boundResponsibilityId,
                    turns = detail.turns,
                    handoffs = detail.handoffs,
                    responsibilitySnapshot = detail.responsibilitySnapshot,
                    voicePhase = if (current.pendingApprovalCard != null) ButlerVoicePhase.AWAITING_APPROVAL else ButlerVoicePhase.IDLE,
                    voiceError = null,
                )
            }
        }.onFailure { err ->
            if (err is CancellationException) throw err
            _uiState.update {
                it.copy(voiceError = err.message ?: "Unable to resume voice session")
            }
        }
    }

    private suspend fun performBargeInLocked(reason: String) {
        val (stoppedGen, stoppedChunk) = ttsAdapter.stopImmediately(reason)
        _uiState.update {
            it.copy(
                voicePhase = ButlerVoicePhase.INTERRUPTED,
                lastInterruptedGeneration = stoppedGen.takeIf { g -> g > 0L } ?: it.lastInterruptedGeneration,
                bargeInCount = it.bargeInCount + 1,
            )
        }
        val session = _uiState.value.voiceSession ?: return
        voiceMutex.withLock {
            callServerInterrupt(session, stoppedGen, stoppedChunk, reason)
        }
    }

    private suspend fun callServerInterrupt(
        session: VoiceSessionDto,
        stoppedGen: Long,
        stoppedChunk: Int,
        reason: String,
    ) {
        val targetGen = stoppedGen.takeIf { it > 0L } ?: session.playbackGeneration
        repository.interruptVoiceSession(
            sessionId = session.id,
            request = VoiceInterruptRequestDto(
                targetGeneration = targetGen,
                targetTurnSeq = session.turnSeq,
                interruptedChunkIndex = stoppedChunk.coerceAtLeast(0),
                reason = reason,
                deviceId = deviceIdentity.deviceId,
                deviceType = deviceIdentity.deviceType,
            ),
        ).onSuccess { res ->
            latestExpectedGeneration = res.playbackGeneration
            _uiState.update { current ->
                val updatedTurns = res.interruptedTurn?.let { interrupted ->
                    current.turns.map { if (it.id == interrupted.id) interrupted else it }
                } ?: current.turns
                current.copy(
                    voiceSession = res.session,
                    turns = updatedTurns,
                    lastInterruptedGeneration = res.previousGeneration.takeIf { it > 0L } ?: current.lastInterruptedGeneration,
                )
            }
        }.onFailure { err ->
            if (err is CancellationException) throw err
            _uiState.update { it.copy(voiceError = err.message ?: "Interrupt sync error") }
        }
    }

    private suspend fun captureAndSubmitVoiceTurn(interruptCurrent: Boolean) {
        val state = _uiState.value
        val session = state.voiceSession
        if (session == null) {
            createNewVoiceSessionInternal(state.boundResponsibilityId)
        }
        if (_uiState.value.voiceSession == null) return

        _uiState.update {
            it.copy(
                voicePhase = ButlerVoicePhase.LISTENING,
                asrErrorBanner = null,
                clarificationPrompt = null,
                voiceError = null,
            )
        }

        when (val outcome = asrAdapter.captureOnce(_uiState.value.selectedAsrEngineId, _uiState.value.voiceSession?.language)) {
            is AsrCaptureOutcome.Cancelled -> {
                _uiState.update {
                    if (it.voicePhase == ButlerVoicePhase.LISTENING) it.copy(voicePhase = ButlerVoicePhase.IDLE, rmsLevel = 0f)
                    else it
                }
            }
            is AsrCaptureOutcome.Failed -> {
                // Hardware/permission errors stay purely local with retry prompt & zero writes.
                val reportToServer = outcome.status == "empty" || outcome.errorCode == "asr_no_match"
                if (reportToServer) {
                    submitTurnInternal(
                        asr = VoiceAsrInputDto(
                            transcript = "",
                            confidence = 0.0,
                            status = outcome.status,
                            errorCode = outcome.errorCode,
                            errorMessage = outcome.errorMessage,
                            engineId = outcome.engineId,
                            mode = outcome.mode,
                        ),
                        interruptCurrent = interruptCurrent,
                        allowContinuousRestart = false,
                        fallbackRetryPrompt = outcome.retryPrompt,
                    )
                } else {
                    _uiState.update {
                        it.copy(
                            voicePhase = ButlerVoicePhase.ASR_ERROR,
                            rmsLevel = 0f,
                            asrErrorBanner = outcome.retryPrompt,
                            clarificationPrompt = null,
                        )
                    }
                }
            }
            is AsrCaptureOutcome.Success -> {
                submitTurnInternal(
                    asr = VoiceAsrInputDto(
                        transcript = outcome.transcript,
                        confidence = outcome.confidence,
                        language = outcome.language,
                        status = "ok",
                        engineId = outcome.engineId,
                        mode = outcome.mode,
                        audioBase64 = outcome.audioBase64,
                        mimeType = outcome.mimeType,
                    ),
                    interruptCurrent = interruptCurrent,
                    allowContinuousRestart = _uiState.value.continuousMode,
                )
            }
        }
    }

    private suspend fun submitTurnInternal(
        asr: VoiceAsrInputDto,
        interruptCurrent: Boolean,
        allowContinuousRestart: Boolean,
        fallbackRetryPrompt: String? = null,
    ) {
        val result: Result<VoiceTurnResponseDto> = voiceMutex.withLock {
            val state = _uiState.value
            val session = state.voiceSession ?: return@withLock Result.failure(IllegalStateException("No active voice session"))
            _uiState.update {
                it.copy(
                    voicePhase = ButlerVoicePhase.THINKING,
                    rmsLevel = 0f,
                    asrErrorBanner = null,
                    clarificationPrompt = null,
                    voiceError = null,
                )
            }
            val expectedGen = latestExpectedGeneration.takeIf { it > 0L } ?: session.playbackGeneration
            repository.submitVoiceTurn(
                sessionId = session.id,
                request = VoiceTurnRequestDto(
                    asr = asr,
                    minConfidence = state.minConfidence,
                    responsibilityId = state.boundResponsibilityId,
                    deviceId = deviceIdentity.deviceId,
                    deviceType = deviceIdentity.deviceType,
                    deviceLabel = deviceIdentity.deviceLabel,
                    interruptCurrent = interruptCurrent,
                    expectedGeneration = expectedGen,
                    streamTts = true,
                    asrEngineId = state.selectedAsrEngineId,
                    reasonerEngineId = state.selectedReasonerEngineId,
                    ttsEngineId = state.selectedTtsEngineId,
                    idempotencyKey = UUID.randomUUID().toString(),
                ),
            )
        }

        result.onFailure { err ->
            if (err is CancellationException) throw err
            _uiState.update {
                it.copy(
                    voicePhase = if (fallbackRetryPrompt != null) ButlerVoicePhase.ASR_ERROR else ButlerVoicePhase.IDLE,
                    asrErrorBanner = fallbackRetryPrompt,
                    voiceError = if (fallbackRetryPrompt == null) (err.message ?: "Voice request failed") else null,
                )
            }
            return
        }

        val response = result.getOrThrow()
        latestExpectedGeneration = response.session.playbackGeneration
        val isAsrRejected = response.outcome == "asr_failed" || response.outcome == "clarification_required"
        val approvalCard = response.approvalCard
        val needsVisualApproval = response.outcome == "requires_visual_approval" || approvalCard != null

        _uiState.update { current ->
            val nextTurns = response.turn?.let { turn ->
                val withoutDup = current.turns.filterNot { it.id == turn.id && turn.id.isNotBlank() }
                (withoutDup + turn).sortedBy { it.turnSeq }
            } ?: current.turns

            val retryBanner = when {
                isAsrRejected -> response.clarificationPrompt?.takeIf { it.isNotBlank() }
                    ?: fallbackRetryPrompt
                    ?: "Voice input was unclear; please repeat. No changes were executed."
                else -> null
            }

            current.copy(
                voiceSession = response.session,
                turns = nextTurns,
                responsibilitySnapshot = response.responsibilitySnapshot ?: current.responsibilitySnapshot,
                boundResponsibilityId = response.session.responsibilityId ?: current.boundResponsibilityId,
                draftText = if (asr.status == "ok" && !isAsrRejected) "" else current.draftText,
                asrErrorBanner = retryBanner,
                clarificationPrompt = response.clarificationPrompt,
                pendingApprovalCard = approvalCard ?: current.pendingApprovalCard,
                pendingApprovalIdempotencyKey = if (approvalCard != null) UUID.randomUUID().toString() else current.pendingApprovalIdempotencyKey,
                approvalConfirmError = if (approvalCard != null) null else current.approvalConfirmError,
                voicePhase = when {
                    needsVisualApproval -> ButlerVoicePhase.AWAITING_APPROVAL
                    isAsrRejected -> ButlerVoicePhase.ASR_ERROR
                    else -> ButlerVoicePhase.SPEAKING
                },
            )
        }

        // Strict safety: never auto-execute and never loop on ASR error or pending approval.
        if (needsVisualApproval) {
            if (response.responseText.isNotBlank()) {
                val gen = response.ttsStream?.generation?.takeIf { it > 0L } ?: response.session.playbackGeneration
                ttsAdapter.speakChunks(
                    generation = gen,
                    chunks = response.ttsStream?.chunks.orEmpty(),
                    fallbackText = response.responseText,
                    onFinished = {
                        _uiState.update { state ->
                            if (state.pendingApprovalCard != null) state.copy(voicePhase = ButlerVoicePhase.AWAITING_APPROVAL)
                            else state
                        }
                    },
                    onInterrupted = { _, _ -> },
                )
            }
            return
        }

        if (isAsrRejected) {
            // Speak clarification prompt optionally, without auto-restarting capture in an error loop.
            val prompt = response.responseText.ifBlank { response.clarificationPrompt.orEmpty() }
            if (prompt.isNotBlank() && ttsAdapter.ready.value) {
                val gen = response.ttsStream?.generation?.takeIf { it > 0L } ?: response.session.playbackGeneration
                ttsAdapter.speakChunks(
                    generation = gen,
                    chunks = response.ttsStream?.chunks.orEmpty(),
                    fallbackText = prompt,
                    onFinished = { _ ->
                        _uiState.update { state ->
                            if (state.voicePhase == ButlerVoicePhase.SPEAKING) state.copy(voicePhase = ButlerVoicePhase.ASR_ERROR)
                            else state
                        }
                    },
                    onInterrupted = { _, _ -> },
                )
            }
            return
        }

        val stream = response.ttsStream
        val gen = stream?.generation?.takeIf { it > 0L } ?: response.session.playbackGeneration
        val speakText = response.responseText
        if (speakText.isBlank() && stream?.chunks.isNullOrEmpty()) {
            _uiState.update { it.copy(voicePhase = ButlerVoicePhase.IDLE) }
            if (allowContinuousRestart && _uiState.value.continuousMode && _uiState.value.voiceSheetOpen && _uiState.value.pendingApprovalCard == null) {
                startListeningOrBargeIn()
            }
            return
        }

        ttsAdapter.speakChunks(
            generation = gen,
            chunks = stream?.chunks.orEmpty(),
            fallbackText = speakText,
            onFinished = { finishedGen ->
                viewModelScope.launch {
                    val cur = _uiState.value
                    if (cur.voicePhase == ButlerVoicePhase.SPEAKING && latestExpectedGeneration <= finishedGen) {
                        _uiState.update { it.copy(voicePhase = ButlerVoicePhase.IDLE) }
                        if (allowContinuousRestart && cur.continuousMode && cur.voiceSheetOpen && cur.pendingApprovalCard == null) {
                            startListeningOrBargeIn()
                        }
                    }
                }
            },
            onInterrupted = { interruptedGen, _ ->
                viewModelScope.launch {
                    _uiState.update { state ->
                        if (state.voicePhase == ButlerVoicePhase.SPEAKING) {
                            state.copy(
                                voicePhase = ButlerVoicePhase.INTERRUPTED,
                                lastInterruptedGeneration = interruptedGen,
                            )
                        } else state
                    }
                }
            },
        )
    }

    override fun onCleared() {
        super.onCleared()
        activeListenJob?.cancel()
        asrAdapter.shutdown()
        ttsAdapter.shutdown()
    }
}
