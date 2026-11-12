package com.andysagent.agentoc.core.model

enum class AppTheme(val value: String) {
    System("system"),
    Dark("dark"),
    Light("light"),
    Oled("oled"),
    Amber("amber"),
    Monet("monet");

    companion object {
        fun fromValue(value: String?): AppTheme = entries.firstOrNull { it.value == value } ?: System
    }
}

enum class AppLanguage(val value: String, val tag: String) {
    System("system", ""),
    SimplifiedChinese("zh-CN", "zh-CN"),
    TraditionalChinese("zh-TW", "zh-TW"),
    English("en", "en"),
    Japanese("ja", "ja"),
    Korean("ko", "ko"),
    French("fr", "fr"),
    Spanish("es", "es");

    companion object {
        fun fromValue(value: String?): AppLanguage = entries.firstOrNull { it.value == value } ?: System
    }
}

enum class ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Working,
    WaitingApproval,
    Completed,
    Error,
}

enum class RuntimeConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    AuthenticationRequired,
    Error,
}

enum class SessionStatus {
    Idle,
    Working,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

data class Computer(
    val id: String,
    val name: String,
    val platform: String? = null,
    val endpoint: String? = null,
    val connected: Boolean = false,
)

enum class RemoteTargetAccessState {
    Connected,
    NeedsPairing,
    Offline,
    Revoked,
    Unavailable,
}

/** Identity used to keep every remote setting and operation tied to one computer. */
data class RemoteTarget(
    val instanceId: String,
    val label: String,
    val endpoint: String,
    val platform: String? = null,
    val accessState: RemoteTargetAccessState = RemoteTargetAccessState.Connected,
    val linkedToPhone: Boolean = true,
    val lastSeenAt: Long? = null,
    val lastSelectedAt: Long = 0L,
)

data class Project(
    val id: String,
    val name: String,
    val folder: String? = null,
    val pinned: Boolean = false,
)

/**
 * Deliberately small cross-device project projection for Home. The source
 * target owns paths, session bodies, and file metadata; the phone needs only
 * a human-readable project name and ordering evidence.
 */
data class OtherDeviceProject(
    val targetId: String,
    val targetLabel: String,
    val targetLastSeenAt: Long = 0L,
    val projectId: String,
    val projectName: String,
    val updatedAt: Long = 0L,
    /** Approvals the source computer reports as pending, for Home urgency. */
    val pendingApprovals: Int = 0,
)

data class Session(
    val id: String,
    val title: String,
    val projectId: String? = null,
    val status: SessionStatus = SessionStatus.Idle,
    val latestSeq: Long = 0,
    /** Server activity timestamp used by compact project/session lists. */
    val updatedAt: Long = 0L,
    val lastAssistantMessageAt: Long? = null,
    val lastReviewedAt: Long? = null,
    val workflowStateChangedAt: Long? = null,
    val workflowState: String? = null,
    /** `approval` for an explicit approval gate, `reply` for a user question. */
    val waitingAction: String? = null,
    /** Server-owned Agent/template binding for this Session, when present. */
    val templateId: String? = null,
    /** Durable follow-up queue projection returned by the session detail API. */
    val queuedMessages: List<QueuedMessage> = emptyList(),
    /** Server-owned pin, used consistently in both session-list levels. */
    val pinned: Boolean = false,
)

enum class RuntimeCatalogStatus {
    Fresh,
    Stale,
    Unavailable,
    Empty,
    Error;

    companion object {
        fun fromValue(value: String?, modelCount: Int = 0, hasError: Boolean = false): RuntimeCatalogStatus {
            return when (value?.trim()?.lowercase()) {
                "fresh" -> if (modelCount > 0) Fresh else Empty
                "stale" -> Stale
                "unavailable" -> if (hasError) Error else Unavailable
                "error" -> Error
                else -> when {
                    hasError -> Error
                    modelCount > 0 -> Fresh
                    else -> Unavailable
                }
            }
        }
    }
}

data class RuntimeCatalogMetadata(
    val status: RuntimeCatalogStatus = RuntimeCatalogStatus.Unavailable,
    val providerProfileId: String? = null,
    val catalogVersion: String? = null,
    val fetchedAt: String? = null,
    val expiresAt: Long? = null,
    val source: String? = null,
    val errorCode: String? = null,
    val modelCount: Int = 0,
)

data class RuntimeModelOption(
    val id: String,
    val label: String,
    val provider: String? = null,
    val supportsFast: Boolean = false,
    val effortLevels: List<String> = emptyList(),
    val defaultEffort: String? = null,
    val isDefault: Boolean = false,
)

data class RuntimeProviderOption(
    val id: String,
    val label: String,
    val catalog: RuntimeCatalogMetadata = RuntimeCatalogMetadata(providerProfileId = id),
)

data class RuntimeToolOption(
    val id: String,
    val label: String,
    val providers: List<RuntimeProviderOption> = emptyList(),
    val models: List<RuntimeModelOption> = emptyList(),
    val catalog: RuntimeCatalogMetadata = RuntimeCatalogMetadata(modelCount = models.size),
    // An empty provider response must not flatten a provider-backed runtime.
    val providerSelectionRequired: Boolean = providers.isNotEmpty(),
)

data class RuntimeCatalog(
    val tools: List<RuntimeToolOption> = emptyList(),
)

data class Attachment(
    val assetId: String? = null,
    val filename: String? = null,
    val originalName: String? = null,
    val mimeType: String? = null,
    val sizeBytes: Long? = null,
    val downloadUrl: String? = null,
    val url: String? = null,
    val caption: String? = null,
)

data class ApprovalOption(
    val label: String,
    val value: String = label,
    val description: String? = null,
)

data class ApprovalQuestion(
    val id: String? = null,
    val header: String? = null,
    val question: String = "",
    val options: List<ApprovalOption> = emptyList(),
    val isMultiSelect: Boolean = false,
)

data class ApprovalAuthorization(
    val source: String? = null,
    val approvedAt: String? = null,
    val credentialId: String? = null,
    val selectionManifestHash: String? = null,
    val permissionMode: String? = null,
    val capabilityRef: String? = null,
)

data class ApprovalExplanation(
    val summary: String? = null,
    val reason: String? = null,
    val saferAlternative: String? = null,
    val operation: String? = null,
    val targets: List<String> = emptyList(),
    val conditional: Boolean = false,
    val partial: Boolean = false,
    val riskCode: String? = null,
    val providerConflict: Boolean = false,
    val elevated: Boolean = false,
)

data class ApprovalAction(
    val id: String,
    val description: String = "",
    val summary: String? = null,
    val reason: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val category: String? = null,
    val executionClass: String? = null,
    val state: String = "waiting_user",
    val risk: String? = null,
    val needsPasskey: Boolean = false,
    val manifestHash: String? = null,
    val expiresAt: String? = null,
    val authorization: ApprovalAuthorization? = null,
    val updatedAt: String? = null,
    val identityAliases: Set<String> = emptySet(),
    val explanation: ApprovalExplanation? = null,
)

data class ApprovalActionDecision(
    val actionId: String,
    val decision: String,
)

data class QueuedMessage(
    val requestId: String,
    val responseId: String? = null,
    val text: String,
    val queuedAt: Long? = null,
    val attachments: List<Attachment> = emptyList(),
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

data class Message(
    val id: String,
    val sessionId: String,
    val role: String,
    val content: String,
    val seq: Long? = null,
    val completed: Boolean = true,
    val attachments: List<Attachment> = emptyList(),
    val timestamp: Long? = null,
    /** Server request/run anchor used by regenerate, edit-resend and fork-at. */
    val requestId: String? = null,
    /** Provider run anchor used to reconcile live and durable message aliases. */
    val runId: String? = null,
    val lastEventSeq: Long = seq ?: 0,
    val revision: Long = 0,
    val messageState: String = if (completed) "completed" else "streaming",
    val messagePhase: String? = null,
)

data class Approval(
    val id: String,
    val sessionId: String,
    val title: String,
    val status: String = "pending",
    val runId: String? = null,
    val batchId: String? = null,
    val kind: String = "approval",
    val detailsJson: String? = null,
    val reason: String? = null,
    val saferAlternative: String? = null,
    val approveLabel: String = "Approve",
    val denyLabel: String = "Deny",
    val options: List<String> = emptyList(),
    val isMultiSelect: Boolean = false,
    val riskLevel: String? = null,
    /** Structured questions from the server approval projection. */
    val questions: List<ApprovalQuestion> = emptyList(),
    /** Structured action projection for approved_action_batch_request. */
    val actions: List<ApprovalAction> = emptyList(),
    /**
     * Server-projected owner passkey checkpoint for legacy privileged-category
     * batches. An absent flag requires a passkey for legacy batches, while
     * ordinary runtime approvals do not carry this batch-specific field.
     */
    val passkeyRequired: Boolean = batchId != null,
    val selectionManifestHash: String? = null,
    val permissionMode: String? = null,
    val expiresAt: String? = null,
    val schemaVersion: Int? = null,
    val channel: String? = null,
    /** Local-only binding for a signed Windows Broker card; never sent as a decision field. */
    val brokerTargetInstanceId: String? = null,
    /** SHA-256 of the canonical signed challenge, including request, target, nonce and expiry. */
    val brokerChallengeDigest: String? = null,
    /** A decision was submitted without a confirmed terminal result; do not offer another POST. */
    val brokerDecisionUncertain: Boolean = false,
    val requestKind: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val filePaths: List<String> = emptyList(),
    val grantRoot: String? = null,
    val permissionsJson: String? = null,
    val defaultSelectedByCategory: Map<String, Set<String>> = emptyMap(),
    val executorUnavailableReasonCode: String? = null,
    val identityAliases: Set<String> = emptySet(),
    val explanation: ApprovalExplanation? = null,
)

data class RunActivity(
    val state: String = "idle",
    val phase: String? = null,
    val runId: String? = null,
    val tool: String? = null,
    val model: String? = null,
    val thinking: Boolean = false,
    val queueCount: Int = 0,
)

data class SyncCursor(
    val scope: String,
    val lastAppliedSeq: Long = 0,
    val lastEventId: String? = null,
    val lastServerCursor: String? = null,
    val lastSnapshotVersion: Long? = null,
)

data class RuntimeError(
    val code: String? = null,
    val message: String,
    val retryable: Boolean = false,
)

data class WorkbenchUiState(
    val connection: ConnectionState = ConnectionState.Disconnected,
    val sessionTitle: String = "New session",
    val messageCount: Int = 0,
    val requiresAction: Boolean = false,
    val statusMessage: String = "Ready for a new task",
)
