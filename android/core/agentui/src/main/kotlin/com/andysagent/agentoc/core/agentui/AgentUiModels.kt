package com.andysagent.agentoc.core.agentui

import androidx.compose.runtime.Immutable

enum class AgentRunStatus { Idle, Working, WaitingApproval, Completed, Failed, Cancelled }
enum class AgentConnectionStatus { Disconnected, Connecting, Connected, Reconnecting, AuthenticationRequired, Error }
enum class AgentOperationKind { Command, FileEdit, Diff, Tool, SubAgent, Unknown }
enum class AgentOperationStatus { Pending, InProgress, Completed, Failed }

@Immutable
data class ToolCallUiState(
    val id: String,
    val kind: AgentOperationKind,
    val title: String,
    val detail: String = "",
    val status: AgentOperationStatus = AgentOperationStatus.Pending,
    val requiresApproval: Boolean = false,
)

@Immutable
data class ApprovalExplanationUiState(
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

@Immutable
data class PermissionRequestUiState(
    val id: String,
    val title: String,
    val reason: String,
    val saferAlternative: String? = null,
    val approveLabel: String = "Approve",
    val denyLabel: String = "Deny",
    val resolving: Boolean = false,
    val targetHost: String? = null,
    val riskLevel: String? = null,
    val batchId: String? = null,
    val selectionManifestHash: String? = null,
    val permissionMode: String? = null,
    val expiresAt: String? = null,
    val actions: List<ApprovalActionUiState> = emptyList(),
    val command: String? = null,
    val cwd: String? = null,
    val filePaths: List<String> = emptyList(),
    val grantRoot: String? = null,
    val permissionsJson: String? = null,
    val explanation: ApprovalExplanationUiState? = null,
    val executorUnavailableReasonCode: String? = null,
)

@Immutable
data class ApprovalActionUiState(
    val id: String,
    val description: String,
    val summary: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val category: String? = null,
    val executionClass: String? = null,
    val state: String = "waiting_user",
    val risk: String? = null,
    val needsPasskey: Boolean = false,
    val selected: Boolean = true,
    val explanation: ApprovalExplanationUiState? = null,
)

@Immutable
data class RetryUiState(val title: String, val detail: String, val retryLabel: String = "Retry")

enum class FileChangeType { Created, Modified, Deleted }

@Immutable
data class FileChangeItem(
    val path: String,
    val name: String = path.substringAfterLast('/'),
    val type: FileChangeType = FileChangeType.Modified,
    val additions: Int = 0,
    val deletions: Int = 0,
    val diffSummary: String = "",
)

@Immutable
data class FileChangeUiState(
    val id: String,
    val files: List<FileChangeItem>,
    val totalAdditions: Int = files.sumOf { it.additions },
    val totalDeletions: Int = files.sumOf { it.deletions },
    val isCompleted: Boolean = true,
)

enum class TaskStatusKind { Completed, WaitingInput, Failed, Running }

@Immutable
data class TaskStatusUiState(
    val id: String,
    val status: TaskStatusKind,
    val title: String,
    val description: String? = null,
    val timestamp: String? = null,
    val retryLabel: String? = null,
)
