package com.andysagent.ragent.feature.organization.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

enum class ButlerBucket(val key: String) {
    IN_PROGRESS("inProgress"),
    AWAITING_DECISION("awaitingDecision"),
    DELIVERED_ARTIFACTS("deliveredArtifacts"),
    BLOCKED_AND_ALERTS("blockedAndAlerts"),
}

@Serializable
data class ButlerOverviewCountsDto(
    val inProgress: Int = 0,
    val awaitingDecision: Int = 0,
    val deliveredArtifacts: Int = 0,
    val blockedAndAlerts: Int = 0,
    val unknownOutcomeCount: Int = 0,
    val total: Int = 0,
)

@Serializable
data class ButlerDiagnosticsDto(
    val code: String? = null,
    val message: String? = null,
    val rootCause: String? = null,
    val repairAttempt: JsonElement? = null,
    val safeToRetry: Boolean = false,
    val requiresVerification: Boolean = false,
)

@Serializable
data class ButlerArtifactDto(
    val packetId: String? = null,
    val candidateDigest: String? = null,
    val milestone: String? = null,
    val target: String? = null,
    val summary: String? = null,
    val artifactLinks: List<JsonElement> = emptyList(),
    val deliveredAt: String? = null,
)

@Serializable
data class ButlerActionTargetDto(
    val kind: String? = null,
    val planId: String? = null,
    val proposalDigest: String? = null,
    val workItemId: String? = null,
    val approvalId: String? = null,
    val conflictGroupId: String? = null,
    val expectedVersion: Long? = null,
    val target: String? = null,
    val impactSummary: String? = null,
    val confirmationPath: String? = null,
    val confirmationMethod: String? = null,
)

@Serializable
data class ButlerOverviewItemDto(
    val itemId: String = "",
    val itemType: String = "responsibility",
    val bucket: String = "",
    val responsibilityId: String? = null,
    val organizationId: String? = null,
    val projectId: String? = null,
    val responsibilityObjective: String = "",
    val responsibilityLifecycle: String? = null,
    val responsibilityRowVersion: Long? = null,
    val title: String = "",
    val summary: String = "",
    val status: String = "",
    val state: String = "",
    val controlState: String? = null,
    val stopStatus: String? = null,
    val isUnknownOutcome: Boolean = false,
    val severity: String = "info",
    val updatedAt: String? = null,
    val diagnostics: ButlerDiagnosticsDto? = null,
    val artifact: ButlerArtifactDto? = null,
    val actionTarget: ButlerActionTargetDto? = null,
) {
    val resolvedResponsibilityId: String get() = responsibilityId.orEmpty()
}

@Serializable
data class ButlerOverviewResponseDto(
    val schemaVersion: Int = 1,
    val asOf: String? = null,
    val counts: ButlerOverviewCountsDto = ButlerOverviewCountsDto(),
    val inProgress: List<ButlerOverviewItemDto> = emptyList(),
    val awaitingDecision: List<ButlerOverviewItemDto> = emptyList(),
    val deliveredArtifacts: List<ButlerOverviewItemDto> = emptyList(),
    val blockedAndAlerts: List<ButlerOverviewItemDto> = emptyList(),
)

@Serializable
data class VoiceAdapterDescriptorDto(
    val id: String = "",
    val name: String? = null,
    val label: String? = null,
    val kind: String? = null,
    val mode: String? = null,
    val providerKind: String? = null,
    val model: String? = null,
    val supportsStreaming: Boolean? = null,
    val supportsTools: Boolean? = null,
    val available: Boolean = true,
    @SerialName("default")
    val isDefault: Boolean = false,
    val metadata: JsonObject? = null,
) {
    val displayLabel: String
        get() = label?.takeIf { it.isNotBlank() }
            ?: name?.takeIf { it.isNotBlank() }
            ?: listOfNotNull(id.takeIf { it.isNotBlank() }, mode?.takeIf { it.isNotBlank() }).joinToString(" · ")
}

@Serializable
data class VoiceAdaptersResponseDto(
    val schemaVersion: Int = 1,
    val asr: List<VoiceAdapterDescriptorDto> = emptyList(),
    val reasoner: List<VoiceAdapterDescriptorDto> = emptyList(),
    val tts: List<VoiceAdapterDescriptorDto> = emptyList(),
)

@Serializable
data class VoiceSessionDto(
    val id: String = "",
    val ownerPrincipalId: String = "",
    val organizationId: String? = null,
    val projectId: String? = null,
    val responsibilityId: String? = null,
    val rootSessionId: String? = null,
    val activeDeviceId: String? = null,
    val activeDeviceType: String? = null,
    val activeDeviceLabel: String? = null,
    val asrEngineId: String? = null,
    val reasonerEngineId: String? = null,
    val ttsEngineId: String? = null,
    val language: String? = null,
    val state: String = "idle",
    val turnSeq: Long = 0L,
    val playbackGeneration: Long = 0L,
    val activeTurnId: String? = null,
    val lastInterruptedGeneration: Long? = null,
    val contextSummary: JsonObject? = null,
    val rowVersion: Long = 0L,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val lastTurnAt: String? = null,
)

@Serializable
data class VoiceApprovalEndpointDto(
    val method: String = "POST",
    val path: String = "",
    val bodyTemplate: JsonObject? = null,
)

@Serializable
data class VoiceApprovalCardDto(
    val schemaVersion: Int = 1,
    val approvalId: String = "",
    val kind: String = "",
    val title: String = "",
    val target: String = "",
    val impactSummary: String = "",
    val diffSummary: String? = null,
    val actionDigest: String? = null,
    val responsibilityId: String? = null,
    val expectedVersion: Long? = null,
    val planId: String? = null,
    val proposalDigest: String? = null,
    val workItemId: String? = null,
    val connectorId: String? = null,
    val riskLevel: String? = null,
    val confirmationPolicy: String = "require_visual_approval",
    val confirmationEndpoint: VoiceApprovalEndpointDto? = null,
    val requiresExplicitConfirm: Boolean = true,
    val executableViaVoice: Boolean = false,
    val status: String = "pending_visual_confirmation",
    val createdAt: String? = null,
)

@Serializable
data class VoiceTurnDto(
    val id: String = "",
    val voiceSessionId: String = "",
    val sessionId: String = "",
    val turnSeq: Long = 0L,
    val playbackGeneration: Long? = null,
    val deviceId: String? = null,
    val deviceType: String? = null,
    val deviceLabel: String? = null,
    val responsibilityId: String? = null,
    val status: String = "",
    val intent: String? = null,
    val transcript: String? = null,
    val responseText: String? = null,
    val asr: VoiceAsrResultDto? = null,
    val ttsStream: VoiceTtsStreamDto? = null,
    val confidence: Double? = null,
    val asrStatus: String? = null,
    val outcome: String? = null,
    val safetyDecision: String? = null,
    val interrupted: Boolean = false,
    val approvalCard: VoiceApprovalCardDto? = null,
    val draft: JsonObject? = null,
    val diagnostics: JsonObject? = null,
    val interruptedAt: String? = null,
    val interruptReason: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val resolvedConfidence: Double? get() = confidence ?: asr?.confidence
    val resolvedAsrStatus: String? get() = asrStatus ?: asr?.status
    val resolvedSafetyDecision: String?
        get() = safetyDecision
            ?: diagnostics?.get("safetyDecision")?.jsonPrimitive?.contentOrNull
    val isInterrupted: Boolean
        get() = interrupted ||
            status == "interrupted" ||
            ttsStream?.interrupted == true ||
            !interruptedAt.isNullOrBlank()
}

@Serializable
data class VoiceHandoffDto(
    val id: String = "",
    val voiceSessionId: String = "",
    val sessionId: String = "",
    val fromDeviceId: String? = null,
    val fromDeviceType: String? = null,
    val fromDeviceLabel: String? = null,
    val toDeviceId: String? = null,
    val toDeviceType: String? = null,
    val toDeviceLabel: String? = null,
    val responsibilityId: String? = null,
    val rootSessionId: String? = null,
    val targetRootSessionId: String? = null,
    val turnSeq: Long = 0L,
    val turnSeqAtHandoff: Long? = null,
    val playbackGeneration: Long = 0L,
    val handoffDigest: String? = null,
    val reason: String? = null,
    val createdAt: String? = null,
) {
    val resolvedTurnSeq: Long get() = turnSeqAtHandoff ?: turnSeq
}

@Serializable
data class ResponsibilitySnapshotDto(
    val responsibility: JsonObject? = null,
    val workSummary: List<JsonObject> = emptyList(),
    val pendingPlans: List<JsonObject> = emptyList(),
    val workLinksCount: Int = 0,
    val failureDiagnostics: JsonElement? = null,
    val deliveredArtifacts: List<JsonObject> = emptyList(),
    val budgetStatus: JsonObject? = null,
    val latestPlanningOutcome: JsonObject? = null,
    val sessionContext: JsonObject? = null,
)

@Serializable
data class VoiceSessionListResponseDto(
    val schemaVersion: Int = 1,
    val sessions: List<VoiceSessionDto> = emptyList(),
)

@Serializable
data class VoiceSessionDetailResponseDto(
    val schemaVersion: Int = 1,
    val replayed: Boolean = false,
    val handoff: VoiceHandoffDto? = null,
    val session: VoiceSessionDto = VoiceSessionDto(),
    val turns: List<VoiceTurnDto> = emptyList(),
    val handoffs: List<VoiceHandoffDto> = emptyList(),
    val responsibilitySnapshot: ResponsibilitySnapshotDto? = null,
)

@Serializable
data class CreateVoiceSessionRequestDto(
    val responsibilityId: String? = null,
    val rootSessionId: String? = null,
    val deviceId: String? = null,
    val deviceType: String = "android",
    val deviceLabel: String? = null,
    val language: String? = null,
    val asrEngineId: String? = null,
    val reasonerEngineId: String? = null,
    val ttsEngineId: String? = null,
    val idempotencyKey: String? = null,
)

@Serializable
data class VoiceAsrInputDto(
    val transcript: String = "",
    val confidence: Double? = null,
    val language: String? = null,
    val status: String = "ok",
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val engineId: String? = null,
    val mode: String? = null,
    val audioBase64: String? = null,
    val mimeType: String? = null,
)

@Serializable
data class VoiceAsrResultDto(
    val ok: Boolean = false,
    val status: String = "empty",
    val confidence: Double? = null,
    val language: String? = null,
    val engineId: String? = null,
    val mode: String? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null,
)

@Serializable
data class VoiceTtsChunkDto(
    val chunkIndex: Int = 0,
    val text: String = "",
    val audioChunkBase64: String? = null,
    val mimeType: String? = null,
    val isFinal: Boolean = false,
)

@Serializable
data class VoiceTtsStreamDto(
    val generation: Long = 0L,
    val turnSeq: Long = 0L,
    val engineId: String? = null,
    val mode: String? = null,
    val interrupted: Boolean = false,
    val completed: Boolean = false,
    val chunks: List<VoiceTtsChunkDto> = emptyList(),
)

@Serializable
data class VoiceTurnRequestDto(
    val asr: VoiceAsrInputDto,
    val minConfidence: Double = 0.55,
    val responsibilityId: String? = null,
    val deviceId: String? = null,
    val deviceType: String = "android",
    val deviceLabel: String? = null,
    val interruptCurrent: Boolean = false,
    val expectedGeneration: Long? = null,
    val streamTts: Boolean = true,
    val asrEngineId: String? = null,
    val reasonerEngineId: String? = null,
    val ttsEngineId: String? = null,
    val idempotencyKey: String? = null,
)

@Serializable
data class VoiceTurnResponseDto(
    val schemaVersion: Int = 1,
    val replayed: Boolean = false,
    val session: VoiceSessionDto = VoiceSessionDto(),
    val turn: VoiceTurnDto? = null,
    val outcome: String = "answered",
    val safetyDecision: String = "read_only_allowed",
    val mutated: Boolean = false,
    val dispatched: Boolean = false,
    val transcript: String = "",
    val asrResult: VoiceAsrResultDto? = null,
    val responseText: String = "",
    val ttsStream: VoiceTtsStreamDto? = null,
    val approvalCard: VoiceApprovalCardDto? = null,
    val draft: JsonObject? = null,
    val clarificationPrompt: String? = null,
    val responsibilitySnapshot: ResponsibilitySnapshotDto? = null,
)

@Serializable
data class VoiceInterruptRequestDto(
    val targetGeneration: Long? = null,
    val targetTurnSeq: Long? = null,
    val interruptedChunkIndex: Int? = null,
    val reason: String? = null,
    val deviceId: String? = null,
    val deviceType: String? = null,
)

@Serializable
data class VoiceInterruptResponseDto(
    val schemaVersion: Int = 1,
    val interrupted: Boolean = false,
    val alreadySuperseded: Boolean = false,
    val previousGeneration: Long = 0L,
    val playbackGeneration: Long = 0L,
    val turnSeq: Long = 0L,
    val session: VoiceSessionDto = VoiceSessionDto(),
    val interruptedTurn: VoiceTurnDto? = null,
)

@Serializable
data class VoiceHandoffRequestDto(
    val targetDeviceId: String,
    val targetDeviceType: String,
    val targetDeviceLabel: String? = null,
    val targetRootSessionId: String? = null,
    val expectedRowVersion: Long? = null,
    val reason: String? = null,
    val idempotencyKey: String? = null,
)

@Serializable
data class VoiceHandoffResponseDto(
    val schemaVersion: Int = 1,
    val replayed: Boolean = false,
    val handoff: VoiceHandoffDto? = null,
    val session: VoiceSessionDto = VoiceSessionDto(),
    val turns: List<VoiceTurnDto> = emptyList(),
    val responsibilitySnapshot: ResponsibilitySnapshotDto? = null,
)
