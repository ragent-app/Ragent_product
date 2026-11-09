package com.andysagent.agentoc.core.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.net.URI
import java.time.Instant

object AgentocProtocol {
    const val PAIRING_SCHEME = "agentoc"
    const val PAIRING_HOST = "pair"
    const val CURRENT_EVENT_PROTOCOL_VERSION = 1
    val supportedPairingVersions = setOf(2, 3, 4)

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
        coerceInputValues = true
    }
}

@Serializable
data class PairingUriDto(
    val version: Int,
    val instanceId: String,
    val endpoint: String,
    val token: String,
    val expiresAt: String,
    val transport: String? = null,
    val signalingEndpoint: String? = null,
    val roomId: String? = null,
    /** Public identity of the computer, present in v3 account-claim QR codes. */
    val instancePublicKey: String? = null,
    val instanceKeyFingerprint: String? = null,
    /** v4 ordinary account authorization exchange; independent of temporary control. */
    val accountInvitationId: String? = null,
    /** v4 enrollment namespace hint; Accounts still verifies the source account. */
    val accountType: String? = null,
)

@Serializable
data class ConnectivityCandidateDto(
    val kind: String,
    val endpoint: String? = null,
    val signalingEndpoint: String? = null,
    val roomId: String? = null,
    val expiresAt: String? = null,
)

@Serializable
data class ConnectivityPolicyDto(
    val order: List<String> = emptyList(),
    val p2p: P2pConnectivityDto? = null,
)

@Serializable
data class P2pConnectivityDto(
    val enabled: Boolean = false,
    val signalingEndpoint: String? = null,
)

@Serializable
data class PairingInvitationDto(
    val id: String,
    val instanceId: String,
    val endpoint: String,
    val connectivity: ConnectivityPolicyDto? = null,
    val candidates: List<ConnectivityCandidateDto> = emptyList(),
    val p2pRoomId: String? = null,
    val token: String,
    val shortCode: String? = null,
    val createdAt: String,
    val expiresAt: String,
    val pairingUri: String,
)

@Serializable
data class CreatePairingInvitationRequest(
    val endpoint: String? = null,
    val protocolVersion: Int? = null,
    val signalingEndpoint: String? = null,
    val ttlMs: Long? = null,
)

@Serializable
data class CreatePairingInvitationResponse(
    val invitation: PairingInvitationDto,
)

@Serializable
data class RedeemPairingInvitationRequest(
    val token: String? = null,
    val shortCode: String? = null,
    val deviceName: String = "Android device",
    val platform: String = "android",
    val devicePublicKey: String,
    val authVersion: Int? = null,
)

@Serializable
data class TrustedDeviceDto(
    val id: String,
    val deviceName: String,
    val platform: String,
    val devicePublicKey: String? = null,
    val entryUrl: String? = null,
    val authVersion: Int? = null,
    val keyAlgorithm: String? = null,
    val status: String? = null,
    val accountId: String? = null,
    val createdAt: String? = null,
    val boundAt: String? = null,
    val lastSeenAt: String? = null,
    val temporaryExpiresAt: String? = null,
    val revokedAt: String? = null,
)

@Serializable
data class PairingCredentialDto(
    val type: String,
    val token: String? = null,
    val expiresAt: String? = null,
    val scope: String? = null,
)

/**
 * A phone-scoped `adev_` public-key identity registered with Accounts. The
 * private key remains in Android Keystore; this DTO deliberately contains no
 * bearer token.
 */
@Serializable
data class AccountSessionDeviceDto(
    val deviceId: String,
    val publicKey: String,
    val alias: String,
    val platform: String = "android",
    val devicePublicKeyFingerprint: String? = null,
)

@Serializable
data class CreateAccountSessionChallengeRequest(
    val requestId: String,
    val device: AccountSessionDeviceDto,
)

@Serializable
data class CreateAccountSessionChallengeResponse(
    val contractVersion: Int,
    val transactionId: String,
    val nonce: String,
    val expiresAt: String,
    /** One-time ticket for the browser sign-in page (non-GMS handoff). */
    val browserTicket: String? = null,
    /** The Accounts server can redeliver the same signed completion within this bound. */
    val completionRecoveryWindowMs: Long = 0,
)

@Serializable
data class CompleteAccountSessionRequest(
    val transactionId: String,
    val requestId: String,
    val idToken: String,
    val signature: String,
)

@Serializable
data class AccountSessionCredentialDto(
    val type: String = "Bearer",
    val token: String,
    val credentialId: String,
    val scope: String = "account-directory",
    val expiresAt: String,
)

@Serializable
data class CompleteAccountSessionResponse(
    val contractVersion: Int = 2,
    val accountId: String,
    val deviceId: String,
    val credential: AccountSessionCredentialDto,
    /** Present on browser-verified sign-ins; the native token also carries it. */
    val email: String? = null,
    /** Operator-owned demo presentation mode; absent servers retain restricted behavior. */
    val demoAccessMode: String? = null,
)

@Serializable
data class RefreshAccountSessionRequest(
    val credentialId: String,
    val deviceId: String,
    val requestId: String,
    val issuedAt: String,
    val nonce: String,
    val signature: String,
)

/**
 * Authorizes a target-side account intent. `deviceId` is that intent's `rdev_`
 * ID, while Accounts derives the phone's distinct `adev_` ID from `rac_`.
 */
@Serializable
data class AccountJoinAuthorizationRequest(
    val requestId: String,
    val deviceId: String,
    val devicePublicKeyFingerprint: String,
    val nonce: String,
    val issuedAt: String,
    val deviceSignature: String,
)

@Serializable
data class AccountJoinAuthorizationResponse(
    val accountJoinGrant: String,
    val expiresAt: String,
    val intentId: String,
    val instanceId: String,
    val deviceId: String,
    /** New servers atomically publish the grant for an endpoint-less join. */
    val rendezvousGrantSubmitted: Boolean = false,
)

@Serializable
data class CreateAccountJoinIntentRequest(
    val devicePublicKey: String,
    val deviceName: String = "Android device",
    val platform: String = "android",
    /** Present only for a freshly scanned unbound-computer account claim. */
    val accountClaimToken: String? = null,
    /** Optional name for the computer represented by the scanned QR code. */
    val computerAlias: String = "",
    /** Automatic authority upgrade must retain an active enrollment. */
    val renewExistingDeviceId: String? = null,
)

@Serializable
data class AccountJoinIntentDto(
    val intentId: String,
    val instanceId: String,
    val deviceId: String,
    val devicePublicKeyFingerprint: String,
    val nonce: String,
    val issuedAt: String,
    val expiresAt: String,
    // Current Accounts rendezvous intents authenticate the computer through
    // its nested instance identity and the later signed poll. The legacy
    // account-intent response may still include this field, but rendezvous
    // responses intentionally omit it.
    val instanceSignature: String = "",
    val deviceName: String = "Android device",
    val platform: String = "android",
    /** Optional name for the computer represented by the scanned QR code. */
    val computerAlias: String = "",
    val instancePublicKey: String = "",
    val instanceKeyFingerprint: String = "",
    val requestId: String = "",
)

@Serializable
data class CreateAccountJoinIntentResponse(
    val intent: AccountJoinIntentDto,
)

@Serializable
data class CompleteAccountJoinIntentRequest(
    val accountJoinGrant: String,
    val nonce: String,
    val deviceSignature: String,
)

@Serializable
data class CompleteAccountJoinIntentResponse(
    val ok: Boolean,
    val bound: Boolean,
    val mode: String,
    val intentId: String,
    val deviceState: String,
    val deviceId: String,
    val credential: PairingCredentialDto,
)

@Serializable
data class CreateAccountRendezvousRequest(
    val requestId: String,
    val targetInstanceId: String,
    val targetInstance: AccountRendezvousTargetInstanceDto? = null,
    val accountClaimToken: String? = null,
    val device: AccountSessionDeviceDto,
    /** Optional name for the computer represented by the scanned QR code. */
    val computerAlias: String = "",
)

@Serializable
data class AccountRendezvousTargetInstanceDto(
    val instanceId: String,
    val publicKey: String,
    val keyFingerprint: String,
)

@Serializable
data class CreateAccountRendezvousResponse(
    val intent: AccountJoinIntentDto,
    val replayed: Boolean = false,
)

@Serializable
data class DeviceP2PDto(
    val roomId: String,
    val secret: String,
    val signalingEndpoint: String,
)

@Serializable
data class RedeemPairingInvitationResponse(
    val instanceId: String,
    val endpoint: String,
    val connectivity: ConnectivityPolicyDto? = null,
    val device: TrustedDeviceDto,
    val credential: PairingCredentialDto,
    @SerialName("deviceP2P") val deviceP2P: DeviceP2PDto? = null,
)

@Serializable
data class ListTrustedDevicesResponse(
    val instanceId: String,
    val devices: List<TrustedDeviceDto> = emptyList(),
)

@Serializable
data class CreateDeviceChallengeRequest(
    val deviceId: String = "",
    val audience: String? = null,
    val devicePublicKey: String? = null,
)

@Serializable
data class DeviceChallengeDto(
    val challengeId: String,
    val deviceId: String,
    val nonce: String,
    val message: String,
    val issuedAt: String? = null,
    val expiresAt: String? = null,
    val audience: String? = null,
    val instanceId: String? = null,
)

@Serializable
data class CreateDeviceChallengeResponse(
    val challenge: DeviceChallengeDto,
)

@Serializable
data class VerifyDeviceChallengeRequest(
    val deviceId: String,
    val challengeId: String,
    val nonce: String,
    val signature: String,
)

@Serializable
data class VerifiedDeviceCredentialDto(
    val type: String,
    val token: String,
    val expiresAt: String,
)

@Serializable
data class VerifyDeviceChallengeResponse(
    val verified: Boolean,
    val deviceId: String,
    val credential: VerifiedDeviceCredentialDto,
    val bootstrap: BootstrapHintDto? = null,
    val deviceP2P: DeviceP2PDto? = null,
)

@Serializable
data class BootstrapHintDto(
    val endpoint: String,
    val contractVersion: Int,
)

@Serializable
data class ConnectionBootstrapPublicKeyDto(
    val algorithm: String,
    val keyId: String,
    val publicKeyPem: String,
)

@Serializable
data class ConnectionBootstrapCandidateDto(
    val id: String,
    val kind: String,
    val provider: String,
    val endpoint: String,
    val priority: Int,
    val expiresAt: String,
    val requiresUserConsent: Boolean,
    val metadata: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class ConnectionBootstrapInitialCarrierDto(
    val candidateId: String,
    val kind: String,
    val provider: String,
    val endpoint: String,
)

@Serializable
data class ConnectionBootstrapIceServerDto(
    val urls: String,
    val username: String,
    val password: String,
)

@Serializable
data class ConnectionBootstrapTurnAuthorizationDto(
    val policyVersion: String,
    val authorized: Boolean,
    val status: String,
    val reasonCode: String,
    val plan: String,
    val maxDevices: Int,
    val activeDeviceCount: Int,
    val connectionId: String? = null,
)

@Serializable
data class ConnectionBootstrapTurnDto(
    val provider: String,
    val endpoint: String,
    val iceServers: List<ConnectionBootstrapIceServerDto>,
    val expiresAt: String,
    val transport: String,
    val appTrafficOnly: Boolean,
    val credentialScope: String,
    val source: String,
    val connectionId: String? = null,
    val authorization: ConnectionBootstrapTurnAuthorizationDto? = null,
)

@Serializable
data class ConnectionBootstrapUpgradeDto(
    val strategy: String,
    val targets: List<String>,
    val retainCurrentWhenNoP2PPath: Boolean,
)

@Serializable
data class ConnectionBootstrapSignatureDto(
    val algorithm: String,
    val keyId: String,
    val signedAt: String,
    val value: String,
)

@Serializable
data class ConnectionBootstrapContractDto(
    val contractVersion: Int,
    val instanceId: String,
    val deviceId: String,
    val enrollmentKind: String,
    val connectionMode: String,
    val issuedAt: String,
    val expiresAt: String,
    val candidates: List<ConnectionBootstrapCandidateDto>,
    val turn: ConnectionBootstrapTurnDto? = null,
    val turnAuthorization: ConnectionBootstrapTurnAuthorizationDto? = null,
    val initialCarrier: ConnectionBootstrapInitialCarrierDto? = null,
    val upgrade: ConnectionBootstrapUpgradeDto? = null,
    val fallback: JsonElement? = null,
    val signature: ConnectionBootstrapSignatureDto,
)

@Serializable
data class ConnectionBootstrapReportRequestDto(
    val requestId: String,
    val phase: String,
    val candidateId: String? = null,
    val transport: String? = null,
    val connectionMode: String? = null,
    val connectionId: String? = null,
    val errorCode: String? = null,
    val detail: String? = null,
)

@Serializable
data class ConnectionBootstrapReportDto(
    val deviceId: String,
    val requestId: String,
    val phase: String,
    val candidateId: String? = null,
    val transport: String? = null,
    val connectionMode: String? = null,
    val connectionId: String? = null,
    val errorCode: String? = null,
    val detail: String? = null,
    val recordedAt: String,
)

@Serializable
data class ConnectionBootstrapReportAckDto(
    val recorded: Boolean,
    val duplicate: Boolean,
    val report: ConnectionBootstrapReportDto? = null,
)

@Serializable
data class ConnectionBootstrapTurnReleaseRequestDto(
    val connectionId: String? = null,
    val reason: String? = null,
)

@Serializable
data class ConnectionBootstrapTurnReleaseResponseDto(
    val ok: Boolean,
    val released: Int,
    val leaseIds: List<String> = emptyList(),
)

@Serializable
data class ErrorResponseDto(
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class AttachmentItemDto(
    val assetId: String? = null,
    val filename: String? = null,
    val originalName: String? = null,
    val mimeType: String? = null,
    val sizeBytes: Long? = null,
    val downloadUrl: String? = null,
    val url: String? = null,
    val text: String? = null,
    val caption: String? = null,
    val renderAs: String? = null,
)

/**
 * Server-owned follow-up queue entry. This is intentionally separate from a
 * normal message: the entry has a durable request/response identity and is
 * consumed by the queue mutation and steer endpoints before it becomes a
 * provider turn.
 */
@Serializable
data class QueuedFollowUpDto(
    val requestId: String,
    val responseId: String? = null,
    val text: String = "",
    val queuedAt: String? = null,
    val attachments: List<AttachmentItemDto> = emptyList(),
    val images: List<AttachmentItemDto> = emptyList(),
    val tool: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val interactionMode: String? = null,
    val permissionMode: String? = null,
    val templateId: String? = null,
    val planAction: String? = null,
    val planId: String? = null,
    val thinking: Boolean = false,
)

fun QueuedFollowUpDto.allAttachments(): List<AttachmentItemDto> = when {
    attachments.isNotEmpty() -> attachments
    images.isNotEmpty() -> images
    else -> emptyList()
}

@Serializable
data class FileChangeDto(
    val path: String = "",
    val filePath: String? = null,
    val changeType: String? = null,
    val added: Int? = null,
    val removed: Int? = null,
    val name: String? = null,
    val type: String = "modify",
    val additions: Int = 0,
    val deletions: Int = 0,
    val diffSummary: String = "",
)

@Serializable
data class RunQueueDto(
    val count: Int? = null,
)

@Serializable
data class RunDto(
    val id: String,
    val sessionId: String,
    val state: String,
    val requestId: String? = null,
    val responseId: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val thinking: Boolean = false,
    val provider: String? = null,
    val runtimeFamily: String? = null,
    val cancelRequested: Boolean = false,
    val failureReason: String? = null,
)

@Serializable
data class RunActivityDto(
    val state: String? = null,
    val phase: String? = null,
    val runId: String? = null,
    val run: RunDto? = null,
    val queue: RunQueueDto? = null,
)

/** The normalized option shape emitted inside an approval question. */
@Serializable
data class ApprovalOptionDto(
    val label: String = "",
    val value: String? = null,
    val description: String? = null,
)

/** A server-owned user-facing question, as carried by approval_request. */
@Serializable
data class ApprovalQuestionDto(
    val id: String? = null,
    val header: String? = null,
    val question: String? = null,
    val options: List<ApprovalOptionDto> = emptyList(),
    val choices: List<ApprovalOptionDto> = emptyList(),
    val multiSelect: Boolean? = null,
    val isMultiSelect: Boolean? = null,
)

fun ApprovalQuestionDto.allOptions(): List<ApprovalOptionDto> = options.ifEmpty { choices }

/** Non-secret authorization metadata exposed by the approved-action client projection. */
@Serializable
data class ApprovalAuthorizationDto(
    val source: String? = null,
    val approvedAt: String? = null,
    val credentialId: String? = null,
    val selectionManifestHash: String? = null,
    val permissionMode: String? = null,
    val capabilityRef: String? = null,
)

/** Client-safe projection of one action in an approved-action batch. */
@Serializable
data class ApprovedActionDto(
    val actionId: String? = null,
    val id: String? = null,
    val opId: String? = null,
    val approvalId: String? = null,
    val requestId: String? = null,
    val providerRequestId: String? = null,
    val providerItemId: String? = null,
    val description: String? = null,
    val summary: String? = null,
    val reason: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val category: String? = null,
    val executionClass: String? = null,
    val state: String? = null,
    val risk: String? = null,
    val needsPasskey: Boolean = false,
    val manifestHash: String? = null,
    val expiresAt: String? = null,
    val authorization: ApprovalAuthorizationDto? = null,
    val resultRef: JsonElement? = null,
    val updatedAt: String? = null,
    val agentDefinition: JsonObject? = null,
    val explanation: JsonObject? = null,
)

@Serializable
data class SessionEventDto(
    /** v2 message identity is shared by HTTP history and ephemeral push. */
    val canonicalMessageId: String? = null,
    val firstSeq: Long? = null,
    val lastEventSeq: Long? = null,
    val messageState: String? = null,
    val messagePhase: String? = null,
    val beforeAssistantAtSameSeq: Boolean = false,
    val displaySeq: Long? = null,
    val textMode: String? = null,
    val runState: String? = null,
    val seq: Long? = null,
    val startSeq: Long? = null,
    val endSeq: Long? = null,
    val blockStartSeq: Long? = null,
    val blockEndSeq: Long? = null,
    val mergedStartSeq: Long? = null,
    val mergedEndSeq: Long? = null,
    val eventId: String? = null,
    val messageId: String? = null,
    val entityId: String? = null,
    val timelineEntityId: String? = null,
    val clientId: String? = null,
    val providerEventId: String? = null,
    val sourceEventId: String? = null,
    val streamItemId: String? = null,
    val providerMessageId: String? = null,
    val providerBlockId: String? = null,
    val providerContentBlockIndex: Int? = null,
    val messageBlockIndex: Int? = null,
    val providerItemId: String? = null,
    val providerRequestId: String? = null,
    val providerToolUseId: String? = null,
    val type: String? = null,
    val channel: String? = null,
    val requestId: String? = null,
    val approvalId: String? = null,
    val batchId: String? = null,
    val category: String? = null,
    val decisions: JsonObject? = null,
    val defaultSelected: JsonObject? = null,
    val id: String? = null,
    val operationId: String? = null,
    val deliveryKey: String? = null,
    val runId: String? = null,
    val responseId: String? = null,
    val blockId: String? = null,
    val timestamp: Long? = null,
    val role: String? = null,
    val title: String? = null,
    val reason: String? = null,
    val saferAlternative: String? = null,
    val approveLabel: String? = null,
    val denyLabel: String? = null,
    val other: List<JsonObject> = emptyList(),
    val delete: List<JsonObject> = emptyList(),
    val installAuto: List<JsonObject> = emptyList(),
    val actions: List<ApprovedActionDto> = emptyList(),
    val text: String? = null,
    val content: JsonElement? = null,
    val message: String? = null,
    val status: String? = null,
    val revision: Long? = null,
    val mergedAssistantRunMessage: Boolean? = null,
    val payload: JsonObject? = null,
    val state: String? = null,
    val kind: String? = null,
    val detail: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val filePaths: List<String> = emptyList(),
    val grantRoot: String? = null,
    val permissions: JsonObject? = null,
    val risk: JsonElement? = null,
    val explanation: JsonObject? = null,
    val outputPreview: JsonElement? = null,
    val toolName: String? = null,
    val input: JsonElement? = null,
    val toolInput: JsonElement? = null,
    val toolOutput: JsonElement? = null,
    val attachments: List<AttachmentItemDto> = emptyList(),
    val images: List<AttachmentItemDto> = emptyList(),
    val fileChanges: List<FileChangeDto> = emptyList(),
    val filePath: String? = null,
    val changeType: String? = null,
    val added: Int? = null,
    val removed: Int? = null,
    val operationLifecycle: String? = null,
    val additions: Int? = null,
    val deletions: Int? = null,
    val exitCode: Int? = null,
    val durationMs: Long? = null,
    val options: List<String> = emptyList(),
    val choices: List<String> = emptyList(),
    val isMultiSelect: Boolean? = null,
    val customAnswer: String? = null,
    val question: String? = null,
    val questions: List<ApprovalQuestionDto> = emptyList(),
    val promptTokens: Long? = null,
    val completionTokens: Long? = null,
    val totalTokens: Long? = null,
    val riskLevel: String? = null,
    val passkeyRequired: Boolean? = null,
    val severity: String? = null,
    val schemaVersion: Int? = null,
    val requestKey: String? = null,
    val turnId: String? = null,
    val actionId: String? = null,
    val previousState: String? = null,
    val manifestHash: String? = null,
    val selectionManifestHash: String? = null,
    val permissionMode: String? = null,
    val expiresAt: String? = null,
    val updatedAt: String? = null,
    val authorization: ApprovalAuthorizationDto? = null,
    val resultRef: JsonElement? = null,
    /** Structured plan artifact fields emitted by the Web event projection. */
    val planId: String? = null,
    val artifactId: String? = null,
    val bodyMarkdown: String? = null,
    val items: List<JsonObject> = emptyList(),
    val planIntent: String? = null,
    val interactionMode: String? = null,
    val source: String? = null,
    val previousPlanId: String? = null,
    val lastPlanAction: String? = null,
)

@Serializable
data class SessionEventsPageDto(
    val sessionId: String,
    val filter: String? = null,
    val events: List<SessionEventDto> = emptyList(),
    val pagination: PaginationDto? = null,
    val latestSeq: Long? = null,
    val serverCursor: String? = null,
    val snapshotVersion: Long? = null,
    val runActivity: JsonElement? = null,
    val operationUpdates: List<JsonObject> = emptyList(),
    val resetRequired: Boolean = false,
    val reason: String? = null,
    val liveStreamId: String? = null,
    val liveCursor: Long? = null,
    val liveEvents: List<SessionEventDto> = emptyList(),
    val liveResetRequired: Boolean = false,
    val liveOnly: Boolean = false,
)

@Serializable
data class SessionListResponseDto(
    val sessions: List<JsonObject> = emptyList(),
)

@Serializable
data class ProjectListResponseDto(
    val projects: List<JsonObject> = emptyList(),
)

@Serializable
data class CreateProjectRequestDto(
    val name: String = "",
    val rootPath: String,
)

@Serializable
data class CreateSessionRequestDto(
    val folder: String = "",
    val tool: String,
    val name: String = "",
    val projectId: String? = null,
    val templateId: String? = null,
    val idempotencyKey: String? = null,
)

@Serializable
data class CreateSessionResponseDto(
    val session: JsonObject,
    val duplicate: Boolean = false,
    val creationContractVersion: Int? = null,
)

@Serializable
data class ApplyTemplateRequestDto(
    val templateId: String,
)

@Serializable
data class PaginationDto(
    val limit: Int? = null,
    val direction: String? = null,
    val beforeSeq: Long? = null,
    val afterSeq: Long? = null,
    val hasMoreBefore: Boolean = false,
    val hasMoreAfter: Boolean = false,
    val nextBeforeSeq: Long? = null,
    val oldestSeq: Long? = null,
    val latestSeq: Long? = null,
    val totalEvents: Long? = null,
)

@Serializable
data class WebSocketPushDto(
    val type: String,
    val sessionId: String? = null,
    val events: List<SessionEventDto> = emptyList(),
    val buildInfo: JsonObject? = null,
)

@Serializable
data class RequestMetadataDto(
    val requestId: String,
    val idempotencyKey: String? = null,
)

@Serializable
data class SendMessageRequestDto(
    val text: String,
    val requestId: String,
    val tool: String? = null,
    val providerProfile: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val thinking: Boolean? = null,
    val agentId: String? = null,
    val templateId: String? = null,
    val interactionMode: String? = null,
    val permissionMode: String? = null,
    val planAction: String? = null,
    val planId: String? = null,
    val harnessCapabilityIds: List<String> = emptyList(),
    val attachments: List<AttachmentItemDto> = emptyList(),
)

@Serializable
data class RegenerateMessageRequestDto(
    /** The completed run being replayed. */
    val requestId: String,
    /** Idempotency key for the new run. */
    val newRequestId: String,
)

@Serializable
data class ResendEditedMessageRequestDto(
    /** The completed run whose user prompt is being replaced. */
    val requestId: String,
    val prompt: String,
    /** Idempotency key for the replacement run. */
    val newRequestId: String,
    val tool: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val serviceTier: String? = null,
    val thinking: Boolean? = null,
    val interactionMode: String? = null,
    val permissionMode: String? = null,
    val planAction: String? = null,
    val planId: String? = null,
    val attachments: List<AttachmentItemDto> = emptyList(),
)

@Serializable
data class ForkAtRequestDto(
    val anchorSeq: Long,
    val mode: String,
    val idempotencyKey: String,
)

@Serializable
data class CreateTriggerRequestDto(
    val title: String = "",
    val text: String,
    val scheduledAt: String,
    val sessionId: String,
    val tool: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val thinking: Boolean = false,
    val enabled: Boolean = true,
)

@Serializable
data class ConfirmationDecisionRequestDto(
    val decision: String,
    val requestId: String,
)

@Serializable
data class QueueMutationRequestDto(
    val action: String,
    val requestId: String? = null,
)

@Serializable
data class QueueMutationResponseDto(
    val requestId: String? = null,
    val steered: Boolean = false,
    val pendingCancel: Boolean = false,
    val interruptedRunId: String? = null,
    val queued: Boolean = false,
    val run: JsonObject? = null,
    val response: JsonObject? = null,
    val session: JsonObject? = null,
)

@Serializable
data class ApprovalResolutionRequestDto(
    val decisions: JsonElement,
    val requestId: String,
    val approvalIntent: String,
    val webauthnProof: WebAuthnProofDto? = null,
)

@Serializable
data class WebAuthnProofResponseDto(
    val clientDataJSON: String,
    val authenticatorData: String,
    val signature: String,
    val userHandle: String? = null,
)

@Serializable
data class WebAuthnProofDto(
    val id: String,
    val rawId: String,
    val response: WebAuthnProofResponseDto,
)

@Serializable
data class RuntimeApprovalDecisionRequestDto(
    val decision: String,
    val requestId: String,
    val choices: List<String> = emptyList(),
    val customAnswer: String? = null,
    val customAnswers: List<String> = emptyList(),
    val multiChoices: List<List<Int>>? = null,
)

fun parsePairingUri(value: String): PairingUriDto {
    val uri = URI(value)
    require(uri.scheme in setOf(AgentocProtocol.PAIRING_SCHEME, "riollant", "ragent") && uri.host == AgentocProtocol.PAIRING_HOST) {
        "Unsupported Ragent pairing URI"
    }
    val query = uri.rawQuery.orEmpty().split('&')
        .mapNotNull { part ->
            val index = part.indexOf('=')
            if (index <= 0) null else decodeUriComponent(part.substring(0, index)) to decodeUriComponent(part.substring(index + 1))
        }.toMap()
    val version = query["v"]?.toIntOrNull() ?: error("Pairing URI version is missing")
    require(version in AgentocProtocol.supportedPairingVersions) { "Unsupported pairing URI version: $version" }
    // v3 QR generation uses compact aliases to keep the code reliably
    // readable on a phone display. Long v2 field names remain supported for
    // compatibility with older desktop instances and pasted links.
    val endpoint = (query["e"] ?: query["endpoint"]).orEmpty().also { endpointValue ->
        if (endpointValue.isNotBlank()) {
            val endpointUri = URI(endpointValue)
            require(endpointUri.scheme in setOf("http", "https") && !endpointUri.host.isNullOrBlank()) {
                "Pairing endpoint must be an HTTP(S) URL with a host"
            }
        }
    }
    val expiresAt = (query["x"] ?: query["expires"]).orEmpty().also { expiry ->
        require(expiry.isNotBlank())
        require(Instant.parse(expiry).isAfter(Instant.now())) { "Pairing URI has expired" }
    }
    val token = (query["t"] ?: query["token"]).orEmpty().also { tokenValue ->
        require(tokenValue.startsWith("rpi_") && tokenValue.length > 4) { "Pairing token is invalid" }
    }
    val instancePublicKey = (query["p"] ?: query["publicKey"]).orEmpty()
    val instanceKeyFingerprint = (query["f"] ?: query["fingerprint"]).orEmpty()
    val accountInvitationId = query["q"]
    val accountType = query["accountType"]
    require(accountType == null || (version == 4 && accountType in setOf("google", "demo"))) { "Account type is invalid" }
    if (version == 4) {
        require(accountInvitationId?.matches(Regex("^[A-Za-z0-9_-]{16,160}$")) == true) { "Account invitation id is missing" }
        require(endpoint.isBlank() && instancePublicKey.isNotBlank() && instanceKeyFingerprint.isNotBlank()) { "Account authorization identity is missing" }
    }
    if (instancePublicKey.isNotBlank() || instanceKeyFingerprint.isNotBlank()) {
        require(instancePublicKey.isNotBlank() && instanceKeyFingerprint.matches(Regex("^[a-fA-F0-9]{64}$"))) {
            "Pairing computer identity is incomplete"
        }
    }
    return PairingUriDto(
        version = version,
        instanceId = (query["i"] ?: query["instance"]).orEmpty().also { require(it.isNotBlank()) },
        endpoint = endpoint,
        token = token,
        expiresAt = expiresAt,
        transport = query["transport"],
        signalingEndpoint = query["signal"],
        roomId = query["room"],
        instancePublicKey = instancePublicKey.takeIf { it.isNotBlank() },
        instanceKeyFingerprint = instanceKeyFingerprint.takeIf { it.isNotBlank() },
        accountInvitationId = accountInvitationId,
        accountType = accountType,
    )
}

fun buildAccountJoinIntentMessage(
    instanceId: String,
    intentId: String,
    deviceId: String,
    devicePublicKeyFingerprint: String,
    nonce: String,
    issuedAt: String,
    audience: String = "agentoc-account-join",
): String = listOf(
    "agentoc-account-join-intent-v1",
    instanceId.trim(),
    intentId.trim(),
    deviceId.trim(),
    devicePublicKeyFingerprint.trim(),
    nonce.trim(),
    issuedAt.trim(),
    audience.trim().ifBlank { "agentoc-account-join" },
).joinToString("\n")

/**
 * Canonical proof for completing the Google-to-Accounts phone session. Keep
 * this byte-for-byte aligned with Accounts: UTF-8 fields separated by `\n`.
 */
fun buildAccountSessionCompleteMessage(
    transactionId: String,
    requestId: String,
    deviceId: String,
    publicKeyFingerprint: String,
    nonce: String,
): String = listOf(
    "agentoc-owner-auth-account-session-v1",
    transactionId.trim(),
    requestId.trim(),
    deviceId.trim(),
    publicKeyFingerprint.trim(),
    nonce.trim(),
).joinToString("\n")

/** Canonical proof for rotating an Accounts-only phone credential without GMS. */
fun buildAccountSessionRefreshMessage(
    credentialId: String,
    deviceId: String,
    requestId: String,
    issuedAt: String,
    nonce: String,
): String = listOf(
    "agentoc-owner-auth-account-refresh-v1",
    credentialId.trim(),
    deviceId.trim(),
    requestId.trim(),
    issuedAt.trim(),
    nonce.trim(),
).joinToString("\n")

private fun decodeUriComponent(value: String): String = java.net.URLDecoder.decode(value, Charsets.UTF_8.name())

fun SessionEventDto.boundarySeq(): Long = listOfNotNull(endSeq, blockEndSeq, mergedEndSeq, seq).maxOrNull() ?: 0

fun SessionEventDto.startingSeq(): Long = listOfNotNull(startSeq, blockStartSeq, mergedStartSeq, seq).minOrNull() ?: boundarySeq()

fun SessionEventDto.allAttachments(): List<AttachmentItemDto> = when {
    attachments.isNotEmpty() -> attachments
    images.isNotEmpty() -> images
    else -> emptyList()
}

fun SessionEventDto.toolInputText(): String? = ((toolInput ?: input) as? JsonPrimitive)?.contentOrNull
    ?: (toolInput ?: input)?.toString()

fun SessionEventDto.toolOutputText(): String? = (toolOutput as? JsonPrimitive)?.contentOrNull
    ?: toolOutput?.toString()

fun SessionEventDto.textContent(): String? = text
    ?: (content as? JsonPrimitive)?.contentOrNull
    ?: toolOutputText()
    ?: message

/** Harness event IDs may restart at the beginning of each run. */
fun SessionEventDto.legacyDedupeKey(): String? = when {
    !eventId.isNullOrBlank() -> "event:$eventId"
    !providerEventId.isNullOrBlank() -> "provider:$providerEventId"
    !id.isNullOrBlank() -> "event:$id"
    !sourceEventId.isNullOrBlank() -> "source:$sourceEventId"
    else -> null
}

fun SessionEventDto.dedupeKey(): String? {
    val key = legacyDedupeKey() ?: return null
    val run = runId?.takeIf { it.isNotBlank() } ?: return key
    return "run:${run.length}:$run:$key"
}

/** Stable message identity used by both the Room projection and live overlay. */
fun SessionEventDto.messageEntityKey(): String = listOf(
    canonicalMessageId,
    timelineEntityId,
    messageId,
    providerMessageId,
    providerItemId,
    streamItemId,
    entityId,
    responseId,
    runId,
    requestId,
).firstOrNull { !it.isNullOrBlank() }?.trim() ?: "event:${boundarySeq()}"

/**
 * Stable content fingerprint used to reject reuse of an immutable event ID.
 * Keep identity fields and projection-relevant payload here; an event ID is
 * not enough to detect a malformed replay with changed content.
 */
fun SessionEventDto.sessionEventFingerprint(): String = listOf(
    canonicalMessageId, firstSeq, lastEventSeq, messageState, textMode, runState,
    seq,
    startSeq,
    endSeq,
    blockStartSeq,
    blockEndSeq,
    mergedStartSeq,
    mergedEndSeq,
    messageId,
    entityId,
    timelineEntityId,
    clientId,
    providerEventId,
    sourceEventId,
    streamItemId,
    providerMessageId,
    providerBlockId,
    providerItemId,
    providerToolUseId,
    type,
    channel,
    requestId,
    approvalId,
    batchId,
    category,
    id,
    operationId,
    deliveryKey,
    runId,
    responseId,
    blockId,
    timestamp,
    role,
    title,
    reason,
    saferAlternative,
    approveLabel,
    denyLabel,
    text,
    content,
    message,
    status,
    revision,
    mergedAssistantRunMessage,
    other,
    delete,
    installAuto,
    actions,
    payload,
    state,
    toolName,
    toolInput,
    toolOutput,
    attachments,
    images,
    fileChanges,
    filePath,
    changeType,
    added,
    removed,
    operationLifecycle,
    additions,
    deletions,
    exitCode,
    durationMs,
    options,
    choices,
    isMultiSelect,
    customAnswer,
    question,
    promptTokens,
    completionTokens,
    totalTokens,
    riskLevel,
    severity,
).joinToString("|")

fun SessionEventDto.requestKey(): String = requestId
    ?: operationId
    ?: runId
    ?: "event:${boundarySeq()}"

fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
