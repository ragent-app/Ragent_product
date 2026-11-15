package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.ApprovalExplanationUiState
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.ApprovalExplanation

internal fun ApprovalExplanation.toExplanationUiState() = ApprovalExplanationUiState(
    summary, reason, saferAlternative, operation, targets, conditional, partial, riskCode, providerConflict, elevated,
)

/** Structured facts are localized on the device; older server text stays intact. */
@Composable
internal fun localizedExplanation(input: ApprovalExplanationUiState?): ApprovalExplanationUiState? {
    input ?: return null
    val value = if (input.riskCode == null && input.reason == "命令串联了多个步骤，部分行为无法静态确认")
        input.copy(riskCode = "composite_unanalyzed") else input
    val label = when (value.operation) {
        "delete" -> R.string.approval_operation_delete
        "copy" -> R.string.approval_operation_copy
        "move" -> R.string.approval_operation_move
        "write_file" -> R.string.approval_operation_write_file
        "append_file" -> R.string.approval_operation_append_file
        "package_install" -> R.string.approval_operation_install
        "package_remove" -> R.string.approval_operation_remove
        "git_push" -> R.string.approval_operation_git_push
        "git_force_push" -> R.string.approval_operation_git_force_push
        "git_reset" -> R.string.approval_operation_git_reset
        "git_reset_hard" -> R.string.approval_operation_git_reset_hard
        "git_commit" -> R.string.approval_operation_git_commit
        "service_start" -> R.string.approval_operation_service_start
        "service_stop" -> R.string.approval_operation_service_stop
        "service_restart" -> R.string.approval_operation_service_restart
        else -> null
    }
    if (label == null && value.riskCode == null) return value
    val target = if (label == null) "" else if (value.operation in setOf("copy", "move") && value.targets.size >= 2)
        value.targets.dropLast(1).joinToString(", ") + " → " + value.targets.last()
    else value.targets.joinToString(", ")
    val action = stringResource(label ?: R.string.approval_operation_run)
    val conditionalAction = if (LocalConfiguration.current.locales[0]?.language == "en") action.replaceFirstChar { it.lowercase() } else action
    val title = (if (value.conditional) stringResource(R.string.approval_operation_may, conditionalAction) else action) + if (target.isNotBlank()) ": $target" else ""
    // Only replace the composite template: other server risk text can carry
    // specific warnings and must not be silently dropped.
    val riskLabel = when (value.riskCode) {
        "composite_unanalyzed" -> R.string.approval_operation_partial
        "delete_filesystem_root" -> R.string.approval_risk_root
        "delete_system_path" -> R.string.approval_risk_system_delete
        "delete_git_metadata" -> R.string.approval_risk_git_metadata
        "delete_project_root" -> R.string.approval_risk_project_root
        "delete_home_root" -> R.string.approval_risk_home_root
        "force_push", "script_interpreter_force_push" -> R.string.approval_risk_force_push
        "delete_glob_pattern" -> R.string.approval_risk_glob
        "delete_variable_target", "delete_unresolvable", "delete_no_target" -> R.string.approval_risk_unknown_target
        "privilege_escalation", "sudo_script_interpreter", "sudo_system_admin", "sudo_service_control", "declared_privileged_op", "install_sudo", "script_interpreter_sudo" -> R.string.approval_risk_privilege
        "download_and_execute", "script_interpreter_download_exec" -> R.string.approval_risk_download
        "sensitive_system_read", "protected_control_read" -> R.string.approval_risk_sensitive
        "file_edit_system_path", "system_path_write", "shell_control_system_path", "protected_control_path", "script_interpreter_system_path" -> R.string.approval_risk_system
        "network_egress", "git_remote_operation" -> R.string.approval_risk_network
        "unknown_command", "unclassified" -> R.string.approval_risk_unknown
        "git_clean_force" -> R.string.approval_risk_git_clean
        "destructive_erase", "shell_control_destructive", "interpreter_destructive_keyword", "script_interpreter_destructive", "script_interpreter_delete", "find_exec_destructive", "xargs_destructive" -> R.string.approval_risk_delete
        "ordinary_command", "no_command", null -> null
        else -> when {
            value.riskCode?.startsWith("delete_") == true -> R.string.approval_risk_delete
            value.riskCode?.startsWith("script_interpreter_") == true -> R.string.approval_risk_script
            else -> R.string.approval_risk_unknown
        }
    }
    val reason = riskLabel?.let { stringResource(it) } ?: if (value.riskCode == null) value.reason else null
    val contextualReason = listOfNotNull(
        if (value.operation == "delete" && value.riskCode != "delete_filesystem_root" && value.riskCode?.startsWith("delete_") != true) stringResource(R.string.approval_risk_delete) else null,
        if (value.elevated && riskLabel != R.string.approval_risk_privilege) stringResource(R.string.approval_risk_privilege) else null,
        if (value.operation == "git_reset_hard") stringResource(R.string.approval_risk_git_reset_hard) else null,
        if (value.operation in setOf("write_file", "copy", "move")) stringResource(R.string.approval_risk_overwrite) else null,
        reason,
        if (value.partial && value.riskCode != "composite_unanalyzed") stringResource(R.string.approval_operation_partial) else null,
        if (value.providerConflict) stringResource(R.string.approval_provider_conflict) else null,
    ).joinToString(" ").ifBlank { null }
    val saferLabel = when (value.riskCode) {
        "force_push", "script_interpreter_force_push" -> R.string.approval_safer_force_push
        "delete_glob_pattern", "delete_find_batch", "find_exec_destructive", "xargs_destructive" -> R.string.approval_safer_preview
        "delete_variable_target", "delete_unresolvable", "delete_no_target" -> R.string.approval_safer_target
        "delete_filesystem_root", "delete_home_root", "delete_project_root", "delete_git_metadata" -> R.string.approval_safer_backup
        "download_and_execute", "script_interpreter_download_exec" -> R.string.approval_safer_download
        else -> null
    }
    val safer = saferLabel?.let { stringResource(it) } ?: if (value.riskCode == null) value.saferAlternative else null
    return value.copy(operation = if (label == null) null else value.operation, summary = title, reason = contextualReason, saferAlternative = safer)
}

@Composable
internal fun ApprovalExplanationContent(
    value: ApprovalExplanationUiState?, skipSummary: Boolean = false, skipReason: Boolean = false,
) {
    val explanation = localizedExplanation(value) ?: return
    val colors = LocalRagentColors.current
    val entries = listOf(
        R.string.approval_explanation_summary to explanation.summary.takeUnless { skipSummary },
        R.string.approval_explanation_reason to explanation.reason.takeUnless { skipReason },
        R.string.approval_explanation_alternative to explanation.saferAlternative,
    ).filter { !it.second.isNullOrBlank() }
    if (entries.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        entries.forEach { (label, text) ->
            Text(stringResource(label), style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold, color = colors.primaryContent)
            Text(text.orEmpty(), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }
    }
}
