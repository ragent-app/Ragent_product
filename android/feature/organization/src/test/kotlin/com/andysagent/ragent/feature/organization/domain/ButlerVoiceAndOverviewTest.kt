package com.andysagent.ragent.feature.organization.domain

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.data.ButlerActionTargetDto
import com.andysagent.ragent.feature.organization.data.ButlerArtifactDto
import com.andysagent.ragent.feature.organization.data.ButlerDiagnosticsDto
import com.andysagent.ragent.feature.organization.data.ButlerOverviewCountsDto
import com.andysagent.ragent.feature.organization.data.ButlerOverviewItemDto
import com.andysagent.ragent.feature.organization.data.ButlerOverviewResponseDto
import com.andysagent.ragent.feature.organization.data.ButlerRepository
import com.andysagent.ragent.feature.organization.data.CreateVoiceSessionRequestDto
import com.andysagent.ragent.feature.organization.data.RealButlerRepository
import com.andysagent.ragent.feature.organization.data.ResponsibilitySnapshotDto
import com.andysagent.ragent.feature.organization.data.VoiceAdapterDescriptorDto
import com.andysagent.ragent.feature.organization.data.VoiceAdaptersResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceApprovalCardDto
import com.andysagent.ragent.feature.organization.data.VoiceApprovalEndpointDto
import com.andysagent.ragent.feature.organization.data.VoiceAsrResultDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceInterruptRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceInterruptResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceSessionDetailResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceSessionDto
import com.andysagent.ragent.feature.organization.data.VoiceSessionListResponseDto
import com.andysagent.ragent.feature.organization.data.VoiceTtsChunkDto
import com.andysagent.ragent.feature.organization.data.VoiceTtsStreamDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnRequestDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnResponseDto
import com.andysagent.ragent.feature.organization.presentation.ButlerViewModel
import com.andysagent.ragent.feature.organization.presentation.ButlerVoicePhase
import com.andysagent.ragent.feature.organization.voice.AsrCaptureOutcome
import com.andysagent.ragent.feature.organization.voice.ButlerAsrAdapter
import com.andysagent.ragent.feature.organization.voice.ButlerDeviceIdentity
import com.andysagent.ragent.feature.organization.voice.ButlerTtsAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ButlerVoiceAndOverviewTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun realButlerRepositoryAlignsWithBackendJsonAndEnforcesVisualConfirmationGuards() = runTest(testDispatcher) {
        val recordedRequests = mutableListOf<ApiRequest>()
        val transport = object : RagentTransport {
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override val connectionState: StateFlow<RuntimeConnectionState> =
                MutableStateFlow(RuntimeConnectionState.Connected)

            override suspend fun execute(request: ApiRequest): ApiResponse {
                recordedRequests += request
                return when {
                    request.path.startsWith("/api/responsibilities/butler-overview") -> ApiResponse(
                        200,
                        """
                        {
                          "schemaVersion": 1,
                          "asOf": "2026-11-22T16:00:00.000Z",
                          "counts": {
                            "inProgress": 1,
                            "awaitingDecision": 1,
                            "deliveredArtifacts": 1,
                            "blockedAndAlerts": 1,
                            "unknownOutcomeCount": 1,
                            "total": 4
                          },
                          "inProgress": [{
                            "itemId": "resp_1",
                            "itemType": "responsibility",
                            "bucket": "inProgress",
                            "responsibilityId": "resp_1",
                            "organizationId": "org_1",
                            "projectId": "proj_1",
                            "responsibilityObjective": "Maintain nightly QA report",
                            "responsibilityLifecycle": "active",
                            "responsibilityRowVersion": 3,
                            "title": "Maintain nightly QA report",
                            "summary": "Running verification",
                            "status": "active",
                            "state": "running",
                            "isUnknownOutcome": false,
                            "severity": "info"
                          }],
                          "awaitingDecision": [{
                            "itemId": "plan_9",
                            "itemType": "plan",
                            "bucket": "awaitingDecision",
                            "responsibilityId": "resp_1",
                            "organizationId": "org_1",
                            "projectId": "proj_1",
                            "responsibilityObjective": "Maintain nightly QA report",
                            "responsibilityLifecycle": "active",
                            "responsibilityRowVersion": 3,
                            "title": "Approve Plan plan_9",
                            "summary": "1 code patch requires owner confirmation",
                            "status": "pending_review",
                            "state": "pending_review",
                            "isUnknownOutcome": false,
                            "severity": "warning",
                            "actionTarget": {
                              "kind": "plan_approval",
                              "planId": "plan_9",
                              "proposalDigest": "sha256:plan9",
                              "expectedVersion": 3,
                              "target": "repo/ragent",
                              "impactSummary": "Apply bounded fix in android/",
                              "confirmationPath": "/api/responsibilities/resp_1/plans/plan_9/approve",
                              "confirmationMethod": "POST"
                            }
                          }],
                          "deliveredArtifacts": [{
                            "itemId": "art_1",
                            "itemType": "work_item",
                            "bucket": "deliveredArtifacts",
                            "responsibilityId": "resp_1",
                            "title": "QA Summary Report",
                            "summary": "Delivered cleanly",
                            "status": "completed",
                            "state": "completed",
                            "artifact": {
                              "packetId": "pkt_1",
                              "candidateDigest": "sha256:cand1",
                              "milestone": "delivered",
                              "target": "reports/qa.md",
                              "summary": "All checks passed",
                              "artifactLinks": ["reports/qa.md"],
                              "deliveredAt": "2026-11-22T15:59:00.000Z"
                            }
                          }],
                          "blockedAndAlerts": [{
                            "itemId": "conn_7",
                            "itemType": "connector_action",
                            "bucket": "blockedAndAlerts",
                            "responsibilityId": null,
                            "organizationId": null,
                            "projectId": null,
                            "responsibilityObjective": "gmail: gmail.message.send",
                            "responsibilityLifecycle": null,
                            "responsibilityRowVersion": null,
                            "title": "Gmail send receipt unverified",
                            "summary": "Wire crossed before timeout",
                            "status": "unknown_outcome",
                            "state": "unknown_outcome",
                            "isUnknownOutcome": true,
                            "severity": "critical",
                            "diagnostics": {
                              "code": "CONNECTOR_TIMEOUT",
                              "message": "Timed out awaiting provider receipt",
                              "rootCause": "network_timeout",
                              "safeToRetry": false,
                              "requiresVerification": true
                            }
                          }]
                        }
                        """.trimIndent(),
                    )
                    request.path == "/api/responsibilities/voice/adapters" -> ApiResponse(
                        200,
                        """
                        {
                          "schemaVersion": 1,
                          "asr": [{"id":"local","mode":"local","providerKind":"client","supportsStreaming":false}],
                          "reasoner": [{"id":"deterministic-butler","mode":"deterministic","providerKind":"builtin","model":""}],
                          "tts": [{"id":"client-tts","mode":"local","providerKind":"client","supportsStreaming":true}]
                        }
                        """.trimIndent(),
                    )
                    request.path == "/api/responsibilities/voice/sessions" && request.method == "POST" -> ApiResponse(
                        200,
                        """
                        {
                          "schemaVersion": 1,
                          "replayed": false,
                          "session": {
                            "id": "vsess_1",
                            "ownerPrincipalId": "owner_1",
                            "organizationId": "org_1",
                            "projectId": "proj_1",
                            "responsibilityId": "resp_1",
                            "rootSessionId": "sess_root",
                            "activeDeviceId": "android-1",
                            "activeDeviceType": "android",
                            "activeDeviceLabel": "Pixel 9",
                            "asrEngineId": "local",
                            "reasonerEngineId": "deterministic-butler",
                            "ttsEngineId": "client-tts",
                            "language": "zh-CN",
                            "state": "idle",
                            "turnSeq": 0,
                            "playbackGeneration": 0,
                            "activeTurnId": "",
                            "lastInterruptedGeneration": 0,
                            "contextSummary": {
                              "responsibilityObjective": "Maintain nightly QA report",
                              "responsibilityLifecycle": "active",
                              "lastIntent": "",
                              "pendingApprovalId": null,
                              "turnCount": 0
                            },
                            "rowVersion": 1,
                            "createdAt": "2026-11-22T16:00:00.000Z",
                            "updatedAt": "2026-11-22T16:00:00.000Z",
                            "lastTurnAt": null
                          },
                          "turns": [],
                          "handoffs": [],
                          "responsibilitySnapshot": {
                            "responsibility": {"id": "resp_1", "objective": "Maintain nightly QA report", "rowVersion": 3},
                            "workSummary": [{"workItemId": "w1", "state": "running", "isUnknownOutcome": false}],
                            "pendingPlans": [],
                            "workLinksCount": 1,
                            "failureDiagnostics": [],
                            "deliveredArtifacts": []
                          }
                        }
                        """.trimIndent(),
                    )
                    request.path == "/api/responsibilities/resp_1/plans/plan_9/approve" -> ApiResponse(
                        200,
                        """{"ok":true,"plan":{"id":"plan_9","state":"approved"}}""",
                    )
                    else -> ApiResponse(404, """{"error":"not found"}""")
                }
            }

            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }

        val repo = RealButlerRepository(transport)
        val overview = repo.getButlerOverview(organizationId = "org_1").getOrThrow()
        assertEquals(4, overview.counts.total)
        assertEquals(1, overview.counts.unknownOutcomeCount)
        assertEquals("plan_9", overview.awaitingDecision.single().actionTarget?.planId)
        assertTrue(overview.blockedAndAlerts.single().isUnknownOutcome)
        assertEquals("", overview.blockedAndAlerts.single().resolvedResponsibilityId)
        assertTrue(overview.blockedAndAlerts.single().diagnostics?.requiresVerification == true)

        val adapters = repo.getVoiceAdapters().getOrThrow()
        assertEquals("local", adapters.asr.single().id)
        assertEquals("deterministic-butler", adapters.reasoner.single().id)
        assertEquals("client-tts", adapters.tts.single().id)

        val createdSession = repo.createVoiceSession(
            CreateVoiceSessionRequestDto(
                responsibilityId = "resp_1",
                rootSessionId = "sess_root",
                deviceId = "android-1",
                deviceType = "android",
                deviceLabel = "Pixel 9",
                idempotencyKey = "sess-create-1",
            ),
        ).getOrThrow()
        assertEquals("vsess_1", createdSession.session.id)
        assertNotNull(createdSession.session.contextSummary)
        assertEquals(1, createdSession.responsibilitySnapshot?.workSummary?.size)

        // Reject missing endpoint
        val noEndpointCard = VoiceApprovalCardDto(
            approvalId = "ap_1",
            kind = "connector_action",
            title = "External write",
            target = "gmail:user@example.com",
            impactSummary = "Send external email",
            confirmationEndpoint = null,
        )
        assertTrue(repo.confirmVisualApproval(noEndpointCard, "idem-1").isFailure)

        // Reject non-responsibility/organization path
        val badPathCard = noEndpointCard.copy(
            confirmationEndpoint = VoiceApprovalEndpointDto("POST", "/api/admin/nuke"),
        )
        assertTrue(repo.confirmVisualApproval(badPathCard, "idem-2").isFailure)

        // Reject card marked executableViaVoice=true
        val bypassCard = noEndpointCard.copy(
            executableViaVoice = true,
            confirmationEndpoint = VoiceApprovalEndpointDto("POST", "/api/responsibilities/resp_1/plans/plan_9/approve"),
        )
        assertTrue(repo.confirmVisualApproval(bypassCard, "idem-3").isFailure)

        // Valid card confirms with confirmed=true and explicit idempotencyKey
        val validCard = VoiceApprovalCardDto(
            approvalId = "ap_valid",
            kind = "plan_approval",
            title = "Approve Plan plan_9",
            target = "repo/ragent",
            impactSummary = "Apply bounded fix",
            responsibilityId = "resp_1",
            expectedVersion = 3L,
            planId = "plan_9",
            proposalDigest = "sha256:plan9",
            confirmationEndpoint = VoiceApprovalEndpointDto(
                method = "POST",
                path = "/api/responsibilities/resp_1/plans/plan_9/approve",
                bodyTemplate = buildJsonObject {
                    put("expectedVersion", 3L)
                    put("proposalDigest", "sha256:plan9")
                },
            ),
        )
        val confirmed = repo.confirmVisualApproval(validCard, "idem-valid-1").getOrThrow()
        assertTrue(confirmed["ok"]?.jsonPrimitive?.booleanOrNull == true)

        val postReq = recordedRequests.last()
        assertEquals("POST", postReq.method)
        assertEquals("/api/responsibilities/resp_1/plans/plan_9/approve", postReq.path)
        assertEquals("idem-valid-1", postReq.idempotencyKey)
        val bodyObj = Json.parseToJsonElement(postReq.body!!).jsonObject
        assertTrue(bodyObj["confirmed"]?.jsonPrimitive?.booleanOrNull == true)
        assertEquals("idem-valid-1", bodyObj["idempotencyKey"]?.jsonPrimitive?.content)
        assertEquals("sha256:plan9", bodyObj["proposalDigest"]?.jsonPrimitive?.content)
    }

    @Test
    fun continuousVoiceTurnBargeInStopsTtsBeforeInterruptAndNextTurn() = runTest(testDispatcher) {
        val repo = FakeButlerRepository()
        val asr = FakeButlerAsrAdapter(
            outcomes = ArrayDeque(
                listOf(
                    AsrCaptureOutcome.Success("What is the status?", 0.94, "en-US", "local-asr", "local"),
                    AsrCaptureOutcome.Success("Why did Windows fail?", 0.92, "en-US", "local-asr", "local"),
                    AsrCaptureOutcome.Cancelled,
                ),
            ),
        )
        val tts = FakeButlerTtsAdapter(autoFinishImmediately = false).apply {
            sharedTimeline = repo.timeline
        }
        val vm = ButlerViewModel(
            repository = repo,
            asrAdapter = asr,
            ttsAdapter = tts,
            deviceIdentity = ButlerDeviceIdentity("android-pixel-9", "android", "Pixel 9"),
        )

        vm.initialize("org_1", "sess_root")
        advanceUntilIdle()

        vm.openVoiceButler(responsibilityId = "resp_1", responsibilityTitle = "Nightly Build", autoStartListening = true)
        advanceUntilIdle()

        // Turn 1 finished ASR -> submitted to server -> TTS speaking generation 1
        assertEquals("vs_1", vm.uiState.value.voiceSession?.id)
        assertEquals(1, vm.uiState.value.turns.size)
        assertEquals(ButlerVoicePhase.SPEAKING, vm.uiState.value.voicePhase)
        assertTrue(tts.isSpeaking.value)
        assertEquals(1L, tts.activeGeneration.value)

        // Barge-in mid-TTS!
        vm.startListeningOrBargeIn()
        advanceUntilIdle()

        // Local TTS must be stopped immediately BEFORE /interrupt, and Turn 2 sent with interruptCurrent=true
        val bargeEvents = repo.eventLog + tts.eventLog
        assertTrue(tts.stopCalls.isNotEmpty())
        assertEquals(1, repo.interruptCalls.size)
        assertEquals(1L, repo.interruptCalls.single().targetGeneration)
        assertEquals(2, repo.turnCalls.size)
        assertFalse(repo.turnCalls[0].interruptCurrent)
        assertTrue(repo.turnCalls[1].interruptCurrent)
        assertEquals(2L, repo.turnCalls[1].expectedGeneration)
        assertEquals(1, vm.uiState.value.bargeInCount)

        // Order check: tts.stop happened before interrupt, and interrupt happened before turn 2
        val timeline = repo.timeline
        val ttsStopIdx = timeline.indexOfFirst { it.startsWith("tts:stop:") }
        val interruptIdx = timeline.indexOfFirst { it == "api:interrupt:1" }
        val turn2Idx = timeline.indexOfFirst { it.startsWith("api:turn:2:") }
        assertTrue(ttsStopIdx >= 0 && interruptIdx > ttsStopIdx && turn2Idx > interruptIdx)
        assertNotNull(bargeEvents)
    }

    @Test
    fun asrFailureAndLowConfidenceNeverTriggerWritesAndSurfaceRetryPrompt() = runTest(testDispatcher) {
        val repo = FakeButlerRepository()
        val asr = FakeButlerAsrAdapter(
            outcomes = ArrayDeque(
                listOf(
                    AsrCaptureOutcome.Failed(
                        status = "error",
                        errorCode = "asr_audio_error",
                        errorMessage = "Mic busy",
                        engineId = "local-asr",
                        mode = "local",
                        retryPrompt = "Microphone audio failed. Check audio input and retry.",
                    ),
                ),
            ),
        )
        val tts = FakeButlerTtsAdapter(autoFinishImmediately = true)
        val vm = ButlerViewModel(
            repository = repo,
            asrAdapter = asr,
            ttsAdapter = tts,
            deviceIdentity = ButlerDeviceIdentity("android-1", "android", "Pixel"),
        )
        vm.initialize("org_1", "sess_root")
        vm.openVoiceButler("resp_1", "Maintain project", autoStartListening = true)
        advanceUntilIdle()

        // Local ASR failure must surface retry banner and NEVER call confirm or turn
        assertEquals(ButlerVoicePhase.ASR_ERROR, vm.uiState.value.voicePhase)
        assertEquals("Microphone audio failed. Check audio input and retry.", vm.uiState.value.asrErrorBanner)
        assertEquals(0, repo.confirmCalls.size)
        assertEquals(0, repo.turnCalls.size)
        assertNull(vm.uiState.value.pendingApprovalCard)

        // Low confidence utterance submitted to backend returns clarification_required with mutated=false
        vm.submitTypedOrSimulatedTurn(transcript = "maybe send something", confidence = 0.28, asrStatus = "ok")
        advanceUntilIdle()
        assertEquals(ButlerVoicePhase.ASR_ERROR, vm.uiState.value.voicePhase)
        assertTrue(vm.uiState.value.clarificationPrompt?.contains("Please repeat") == true)
        assertEquals(0, repo.confirmCalls.size)
        assertNull(vm.uiState.value.pendingApprovalCard)
    }

    @Test
    fun highRiskVoiceRequestOpensVisualApprovalCardAndOnlyExecutesOnExplicitConfirm() = runTest(testDispatcher) {
        val repo = FakeButlerRepository()
        val asr = FakeButlerAsrAdapter(ArrayDeque())
        val tts = FakeButlerTtsAdapter(autoFinishImmediately = true)
        val vm = ButlerViewModel(
            repository = repo,
            asrAdapter = asr,
            ttsAdapter = tts,
            deviceIdentity = ButlerDeviceIdentity("android-1", "android", "Pixel"),
        )
        vm.initialize("org_1", "sess_root")
        vm.openVoiceButler("resp_1", "Release Maintenance")
        advanceUntilIdle()

        // Ask voice butler to merge PR / send external message -> returns requires_visual_approval
        vm.submitTypedOrSimulatedTurn(transcript = "merge pull request 42 now", confidence = 0.95)
        advanceUntilIdle()

        val card = vm.uiState.value.pendingApprovalCard
        assertNotNull(card)
        assertEquals(ButlerVoicePhase.AWAITING_APPROVAL, vm.uiState.value.voicePhase)
        assertEquals("github:owner/repo#42", card.target)
        assertEquals("Merge PR #42 into main", card.impactSummary)
        assertEquals("sha256:merge42", card.actionDigest)
        assertTrue(card.requiresExplicitConfirm)
        assertFalse(card.executableViaVoice)
        // Must NEVER execute before explicit confirmation
        assertEquals(0, repo.confirmCalls.size)

        // Attempting to start listening while approval is pending must be blocked
        vm.startListeningOrBargeIn()
        advanceUntilIdle()
        assertEquals(ButlerVoicePhase.AWAITING_APPROVAL, vm.uiState.value.voicePhase)
        assertEquals(0, repo.confirmCalls.size)

        // First confirm fails transiently -> preserves SAME idempotencyKey for safe retry
        repo.failNextConfirm = true
        vm.confirmPendingApproval()
        advanceUntilIdle()
        assertEquals(1, repo.confirmCalls.size)
        val firstKey = repo.confirmCalls[0].second
        assertNotNull(vm.uiState.value.pendingApprovalCard)
        assertNotNull(vm.uiState.value.approvalConfirmError)

        // Retry uses exact same idempotencyKey and succeeds
        repo.failNextConfirm = false
        vm.confirmPendingApproval()
        advanceUntilIdle()
        assertEquals(2, repo.confirmCalls.size)
        assertEquals(firstKey, repo.confirmCalls[1].second)
        assertNull(vm.uiState.value.pendingApprovalCard)
        assertEquals(ButlerVoicePhase.IDLE, vm.uiState.value.voicePhase)
    }

    @Test
    fun crossDeviceHandoffAndSessionResumePreserveTurnHistoryAndSnapshot() = runTest(testDispatcher) {
        val repo = FakeButlerRepository()
        val asr = FakeButlerAsrAdapter(ArrayDeque())
        val tts = FakeButlerTtsAdapter(autoFinishImmediately = true)
        val vm = ButlerViewModel(
            repository = repo,
            asrAdapter = asr,
            ttsAdapter = tts,
            deviceIdentity = ButlerDeviceIdentity("android-1", "android", "Pixel 9"),
        )
        vm.initialize("org_1", "sess_root")
        vm.openVoiceButler("resp_1", "Build Watcher")
        advanceUntilIdle()

        vm.submitTypedOrSimulatedTurn("Check current status", confidence = 0.96)
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.turns.size)

        vm.requestHandoff(
            targetDeviceId = "win-desktop-1",
            targetDeviceType = "desktop",
            targetDeviceLabel = "Windows Workstation",
        )
        advanceUntilIdle()

        assertEquals("desktop", vm.uiState.value.voiceSession?.activeDeviceType)
        assertEquals("Windows Workstation", vm.uiState.value.voiceSession?.activeDeviceLabel)
        assertEquals(1, vm.uiState.value.handoffs.size)
        assertTrue(vm.uiState.value.handoffNotice?.contains("Windows Workstation") == true)

        // Resume session after cross-device update
        vm.resumeVoiceSession("vs_1")
        advanceUntilIdle()
        assertEquals(1, vm.uiState.value.turns.size)
        assertNotNull(vm.uiState.value.responsibilitySnapshot)

        // Open approval from awaitingDecision bucket item and confirm explicitly
        val awaiting = vm.uiState.value.overview?.awaitingDecision?.singleOrNull()
        assertNotNull(awaiting)
        vm.openApprovalFromOverviewItem(awaiting)
        assertNotNull(vm.uiState.value.pendingApprovalCard)
        assertEquals("sha256:p1", vm.uiState.value.pendingApprovalCard?.actionDigest)
        vm.confirmPendingApproval()
        advanceUntilIdle()
        assertNull(vm.uiState.value.pendingApprovalCard)
        assertEquals(1, repo.confirmCalls.size)
    }

    private class FakeButlerAsrAdapter(
        private val outcomes: ArrayDeque<AsrCaptureOutcome>,
    ) : ButlerAsrAdapter {
        override val isListening = MutableStateFlow(false)
        override val rmsLevel = MutableStateFlow(0f)
        override fun isAvailable() = true
        override fun hasAudioPermission() = true

        override suspend fun captureOnce(engineId: String?, language: String?): AsrCaptureOutcome {
            isListening.value = true
            val next = if (outcomes.isEmpty()) AsrCaptureOutcome.Cancelled else outcomes.removeFirst()
            isListening.value = false
            return next
        }

        override fun stopListening() {
            isListening.value = false
        }

        override fun cancel() {
            isListening.value = false
        }

        override fun shutdown() {
            isListening.value = false
        }
    }

    private class FakeButlerTtsAdapter(
        private val autoFinishImmediately: Boolean,
    ) : ButlerTtsAdapter {
        override val ready = MutableStateFlow(true)
        override val isSpeaking = MutableStateFlow(false)
        override val activeGeneration = MutableStateFlow(0L)
        override val currentChunkIndex = MutableStateFlow(0)
        val stopCalls = mutableListOf<String>()
        val eventLog = mutableListOf<String>()
        var sharedTimeline: MutableList<String>? = null
        private var activeOnInterrupted: ((Long, Int) -> Unit)? = null

        override fun speakChunks(
            generation: Long,
            chunks: List<VoiceTtsChunkDto>,
            fallbackText: String,
            onFinished: (Long) -> Unit,
            onInterrupted: (Long, Int) -> Unit,
        ) {
            activeGeneration.value = generation
            currentChunkIndex.value = chunks.firstOrNull()?.chunkIndex ?: 0
            isSpeaking.value = true
            activeOnInterrupted = onInterrupted
            sharedTimeline?.add("tts:start:$generation")
            if (autoFinishImmediately) {
                isSpeaking.value = false
                activeOnInterrupted = null
                onFinished(generation)
            }
        }

        override fun stopImmediately(reason: String): Pair<Long, Int> {
            val prevGen = activeGeneration.value
            val prevChunk = currentChunkIndex.value
            stopCalls += reason
            eventLog += "tts:stop:$reason:$prevGen"
            sharedTimeline?.add("tts:stop:$prevGen")
            val cb = activeOnInterrupted
            activeOnInterrupted = null
            isSpeaking.value = false
            cb?.invoke(prevGen, prevChunk)
            return prevGen to prevChunk
        }

        override fun shutdown() {
            isSpeaking.value = false
        }
    }

    private class FakeButlerRepository : ButlerRepository {
        val timeline = mutableListOf<String>()
        val eventLog = mutableListOf<String>()
        val turnCalls = mutableListOf<VoiceTurnRequestDto>()
        val interruptCalls = mutableListOf<VoiceInterruptRequestDto>()
        val confirmCalls = mutableListOf<Pair<VoiceApprovalCardDto, String>>()
        var failNextConfirm = false

        private var session = VoiceSessionDto(
            id = "vs_1",
            ownerPrincipalId = "owner_1",
            organizationId = "org_1",
            projectId = "proj_1",
            responsibilityId = "resp_1",
            rootSessionId = "sess_root",
            activeDeviceId = "android-pixel-9",
            activeDeviceType = "android",
            activeDeviceLabel = "Pixel 9",
            state = "idle",
            turnSeq = 0L,
            playbackGeneration = 0L,
            rowVersion = 1L,
        )
        private val turns = mutableListOf<VoiceTurnDto>()
        private val handoffs = mutableListOf<VoiceHandoffDto>()

        override suspend fun getButlerOverview(organizationId: String?, projectId: String?, limit: Int): Result<ButlerOverviewResponseDto> =
            Result.success(
                ButlerOverviewResponseDto(
                    counts = ButlerOverviewCountsDto(inProgress = 1, awaitingDecision = 1, deliveredArtifacts = 1, blockedAndAlerts = 1, unknownOutcomeCount = 1, total = 4),
                    inProgress = listOf(ButlerOverviewItemDto(itemId = "r1", bucket = "inProgress", responsibilityId = "resp_1", title = "Active work")),
                    awaitingDecision = listOf(
                        ButlerOverviewItemDto(
                            itemId = "p1",
                            itemType = "plan",
                            bucket = "awaitingDecision",
                            responsibilityId = "resp_1",
                            title = "Approve Plan p1",
                            actionTarget = ButlerActionTargetDto(
                                kind = "plan_approval",
                                planId = "p1",
                                proposalDigest = "sha256:p1",
                                expectedVersion = 2L,
                                target = "repo",
                                impactSummary = "Apply fix",
                                confirmationPath = "/api/responsibilities/resp_1/plans/p1/approve",
                            ),
                        ),
                    ),
                    deliveredArtifacts = listOf(ButlerOverviewItemDto(itemId = "a1", bucket = "deliveredArtifacts", responsibilityId = "resp_1", title = "Report", artifact = ButlerArtifactDto(packetId = "pkt_1"))),
                    blockedAndAlerts = listOf(ButlerOverviewItemDto(itemId = "b1", bucket = "blockedAndAlerts", responsibilityId = "resp_1", title = "Timeout", isUnknownOutcome = true, diagnostics = ButlerDiagnosticsDto(code = "TIMEOUT", requiresVerification = true))),
                ),
            )

        override suspend fun getVoiceAdapters(): Result<VoiceAdaptersResponseDto> = Result.success(
            VoiceAdaptersResponseDto(
                asr = listOf(VoiceAdapterDescriptorDto(id = "local-asr", label = "System ASR", isDefault = true)),
                reasoner = listOf(VoiceAdapterDescriptorDto(id = "resp-reasoner", label = "Responsibility Reasoner", isDefault = true)),
                tts = listOf(VoiceAdapterDescriptorDto(id = "android-tts", label = "Android TTS", isDefault = true)),
            ),
        )

        override suspend fun listVoiceSessions(responsibilityId: String?, limit: Int): Result<VoiceSessionListResponseDto> =
            Result.success(VoiceSessionListResponseDto(sessions = listOf(session)))

        override suspend fun createVoiceSession(request: CreateVoiceSessionRequestDto): Result<VoiceSessionDetailResponseDto> =
            Result.success(
                VoiceSessionDetailResponseDto(
                    session = session,
                    turns = turns.toList(),
                    handoffs = handoffs.toList(),
                    responsibilitySnapshot = ResponsibilitySnapshotDto(),
                ),
            )

        override suspend fun getVoiceSession(sessionId: String, turnLimit: Int): Result<VoiceSessionDetailResponseDto> =
            Result.success(
                VoiceSessionDetailResponseDto(
                    session = session,
                    turns = turns.toList(),
                    handoffs = handoffs.toList(),
                    responsibilitySnapshot = ResponsibilitySnapshotDto(),
                ),
            )

        override suspend fun submitVoiceTurn(sessionId: String, request: VoiceTurnRequestDto): Result<VoiceTurnResponseDto> {
            turnCalls += request
            val seq = session.turnSeq + 1L
            timeline += "api:turn:$seq:${request.interruptCurrent}"
            val gen = session.playbackGeneration + 1L

            if ((request.asr.confidence ?: 1.0) < request.minConfidence || request.asr.status != "ok") {
                session = session.copy(turnSeq = seq, rowVersion = session.rowVersion + 1L, state = "listening")
                val turn = VoiceTurnDto(
                    id = "vt_$seq",
                    sessionId = sessionId,
                    turnSeq = seq,
                    transcript = request.asr.transcript,
                    confidence = request.asr.confidence,
                    asrStatus = "low_confidence",
                    outcome = "clarification_required",
                    safetyDecision = "blocked_no_write",
                    responseText = "Please repeat clearly.",
                )
                turns += turn
                return Result.success(
                    VoiceTurnResponseDto(
                        session = session,
                        turn = turn,
                        outcome = "clarification_required",
                        safetyDecision = "blocked_no_write",
                        mutated = false,
                        dispatched = false,
                        transcript = request.asr.transcript,
                        asrResult = VoiceAsrResultDto(ok = false, status = "low_confidence", confidence = request.asr.confidence),
                        responseText = "Please repeat clearly.",
                        clarificationPrompt = "Please repeat clearly — no actions were executed.",
                    ),
                )
            }

            if (request.asr.transcript.contains("merge", ignoreCase = true)) {
                session = session.copy(turnSeq = seq, playbackGeneration = gen, rowVersion = session.rowVersion + 1L, state = "awaiting_approval")
                val card = VoiceApprovalCardDto(
                    approvalId = "ap_$seq",
                    kind = "github_pr_merge",
                    title = "Confirm PR Merge",
                    target = "github:owner/repo#42",
                    impactSummary = "Merge PR #42 into main",
                    diffSummary = "+12 -3 files",
                    actionDigest = "sha256:merge42",
                    responsibilityId = "resp_1",
                    expectedVersion = 4L,
                    riskLevel = "irreversible_write",
                    confirmationEndpoint = VoiceApprovalEndpointDto(
                        method = "POST",
                        path = "/api/responsibilities/resp_1/plans/plan_merge/approve",
                        bodyTemplate = buildJsonObject { put("expectedVersion", 4L) },
                    ),
                )
                val turn = VoiceTurnDto(
                    id = "vt_$seq",
                    sessionId = sessionId,
                    turnSeq = seq,
                    transcript = request.asr.transcript,
                    confidence = request.asr.confidence,
                    asrStatus = "ok",
                    outcome = "requires_visual_approval",
                    safetyDecision = "visual_approval_required",
                    responseText = "Please confirm on screen before merging PR #42.",
                    approvalCard = card,
                )
                turns += turn
                return Result.success(
                    VoiceTurnResponseDto(
                        session = session,
                        turn = turn,
                        outcome = "requires_visual_approval",
                        safetyDecision = "visual_approval_required",
                        mutated = false,
                        dispatched = false,
                        transcript = request.asr.transcript,
                        responseText = "Please confirm on screen before merging PR #42.",
                        approvalCard = card,
                    ),
                )
            }

            session = session.copy(turnSeq = seq, playbackGeneration = gen, rowVersion = session.rowVersion + 1L, state = "speaking")
            val turn = VoiceTurnDto(
                id = "vt_$seq",
                sessionId = sessionId,
                turnSeq = seq,
                transcript = request.asr.transcript,
                confidence = request.asr.confidence,
                asrStatus = "ok",
                outcome = "answered",
                safetyDecision = "read_only_allowed",
                responseText = "Status is running; 1 check passed.",
                playbackGeneration = gen,
            )
            turns += turn
            return Result.success(
                VoiceTurnResponseDto(
                    session = session,
                    turn = turn,
                    outcome = "answered",
                    safetyDecision = "read_only_allowed",
                    mutated = false,
                    dispatched = false,
                    transcript = request.asr.transcript,
                    responseText = "Status is running; 1 check passed.",
                    ttsStream = VoiceTtsStreamDto(
                        generation = gen,
                        turnSeq = seq,
                        chunks = listOf(VoiceTtsChunkDto(0, "Status is running; 1 check passed.", isFinal = true)),
                    ),
                    responsibilitySnapshot = ResponsibilitySnapshotDto(),
                ),
            )
        }

        override suspend fun interruptVoiceSession(sessionId: String, request: VoiceInterruptRequestDto): Result<VoiceInterruptResponseDto> {
            interruptCalls += request
            val prevGen = session.playbackGeneration
            val nextGen = prevGen + 1L
            timeline += "api:interrupt:$prevGen"
            session = session.copy(playbackGeneration = nextGen, lastInterruptedGeneration = prevGen, state = "interrupted")
            return Result.success(
                VoiceInterruptResponseDto(
                    interrupted = true,
                    previousGeneration = prevGen,
                    playbackGeneration = nextGen,
                    turnSeq = session.turnSeq,
                    session = session,
                ),
            )
        }

        override suspend fun handoffVoiceSession(sessionId: String, request: VoiceHandoffRequestDto): Result<VoiceHandoffResponseDto> {
            val handoff = VoiceHandoffDto(
                id = "vh_${handoffs.size + 1}",
                sessionId = sessionId,
                fromDeviceId = session.activeDeviceId,
                fromDeviceType = session.activeDeviceType,
                fromDeviceLabel = session.activeDeviceLabel,
                toDeviceId = request.targetDeviceId,
                toDeviceType = request.targetDeviceType,
                toDeviceLabel = request.targetDeviceLabel,
                reason = request.reason,
                turnSeqAtHandoff = session.turnSeq,
            )
            handoffs += handoff
            session = session.copy(
                activeDeviceId = request.targetDeviceId,
                activeDeviceType = request.targetDeviceType,
                activeDeviceLabel = request.targetDeviceLabel,
                rowVersion = session.rowVersion + 1L,
            )
            return Result.success(
                VoiceHandoffResponseDto(
                    handoff = handoff,
                    session = session,
                    turns = turns.toList(),
                    responsibilitySnapshot = ResponsibilitySnapshotDto(),
                ),
            )
        }

        override suspend fun confirmVisualApproval(card: VoiceApprovalCardDto, idempotencyKey: String): Result<JsonObject> {
            confirmCalls += card to idempotencyKey
            return if (failNextConfirm) Result.failure(IllegalStateException("Transient network error"))
            else Result.success(buildJsonObject { put("ok", true) })
        }
    }
}
