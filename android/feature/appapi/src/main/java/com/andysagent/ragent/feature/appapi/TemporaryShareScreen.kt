package com.andysagent.ragent.feature.appapi

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.LocalRagentColors

/** The temporary principal has its own finite task UI; Owner catalog and credentials never enter it. */
data class TemporaryShareUiState(
    val targets: List<TemporaryShareTarget> = emptyList(),
    val runtimes: List<TemporaryShareRuntime> = emptyList(),
    val selectedInstanceId: String? = null,
    val selectedRuntimeId: String? = null,
    val computerLabel: String? = null,
    val expiryLabel: String? = null,
    val sharedText: String = "",
    val instruction: String = "",
    val filesPresent: Boolean = false,
    val attachmentNames: List<String> = emptyList(),
    val ready: Boolean = false,
    val busy: Boolean = false,
    val cancellable: Boolean = false,
    val transferFileName: String? = null,
    val transferProgress: Float? = null,
    val operationId: String? = null,
    val runId: String? = null,
    val resultState: String? = null,
    val resultText: String? = null,
    val resultTruncated: Boolean = false,
    val error: String? = null,
)

data class TemporaryShareTarget(
    val instanceId: String,
    val label: String,
    val expiryLabel: String,
    val ready: Boolean,
)

data class TemporaryShareRuntime(val id: String, val label: String, val ready: Boolean)

internal fun canSubmitTemporaryShare(state: TemporaryShareUiState): Boolean = state.selectedInstanceId != null && state.ready && !state.busy &&
    (state.operationId != null ||
        ((state.sharedText.isNotBlank() || state.filesPresent) && state.instruction.isNotBlank() &&
            state.runtimes.any { it.id == state.selectedRuntimeId && it.ready })) &&
    state.runId == null

@Composable
fun TemporaryShareScreen(state: TemporaryShareUiState, onInstruction: (String) -> Unit,
    onSelectTarget: (String) -> Unit, onSelectRuntime: (String) -> Unit,
    onSubmit: () -> Unit, onCheckResult: () -> Unit,
    onCancel: () -> Unit, onClose: () -> Unit, onOpenApp: () -> Unit,
    modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    Column(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding().imePadding(),
        horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
        CaptureHeader(stringResource(R.string.temporary_share_title), onClose)
        Column(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(stringResource(R.string.temporary_share_headline),
                style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold,
                color = colors.primaryContent)
            CaptureSectionLabel(stringResource(R.string.temporary_share_destination))
            CaptureCard {
                if (state.targets.isEmpty()) Text(stringResource(R.string.temporary_share_no_target),
                    style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
                state.targets.forEach { target ->
                    val selected = state.selectedInstanceId == target.instanceId
                    Row(Modifier.fillMaxWidth().selectable(selected = selected,
                        enabled = !state.busy && state.operationId == null, role = Role.RadioButton,
                        onClick = { onSelectTarget(target.instanceId) })
                        .testTag("temporary-target-${target.instanceId}"),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        RadioButton(selected = selected, onClick = null,
                            enabled = !state.busy && state.operationId == null)
                        Column(Modifier.weight(1f)) {
                            Text(target.label, style = MaterialTheme.typography.titleSmall, color = colors.primaryContent)
                            Text(stringResource(R.string.temporary_share_expires, target.expiryLabel),
                                style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                        }
                        Text(stringResource(if (target.ready) R.string.temporary_share_target_ready
                            else R.string.temporary_share_target_connecting),
                            style = MaterialTheme.typography.labelSmall,
                            color = if (target.ready) colors.accentPrimary else colors.secondaryContent)
                    }
                }
                state.targets.firstOrNull { it.instanceId == state.selectedInstanceId }?.let { target ->
                    Text(target.instanceId, style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
                }
                if (!state.ready) Text(stringResource(
                    if (state.targets.isEmpty()) R.string.temporary_share_connect_hint
                    else R.string.temporary_share_connecting_hint),
                    style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            }
            if (state.operationId == null) {
                CaptureSectionLabel(stringResource(R.string.temporary_share_runtime))
                CaptureCard {
                    if (state.runtimes.isEmpty()) Text(stringResource(
                        if (state.ready) R.string.temporary_share_runtime_none
                        else R.string.temporary_share_runtime_waiting),
                        style = MaterialTheme.typography.bodyMedium, color = colors.secondaryContent)
                    state.runtimes.forEach { runtime ->
                        val selected = runtime.id == state.selectedRuntimeId
                        Row(Modifier.fillMaxWidth().selectable(selected = selected,
                            enabled = !state.busy && runtime.ready, role = Role.RadioButton,
                            onClick = { onSelectRuntime(runtime.id) }).testTag("temporary-runtime-${runtime.id}"),
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            RadioButton(selected = selected, onClick = null,
                                enabled = !state.busy && runtime.ready)
                            Column(Modifier.weight(1f)) {
                                Text(runtime.label, style = MaterialTheme.typography.titleSmall,
                                    color = if (runtime.ready) colors.primaryContent else colors.secondaryContent)
                                if (!runtime.ready) Text(stringResource(R.string.temporary_share_runtime_unavailable),
                                    style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                            }
                        }
                    }
                }
            }
            CaptureSectionLabel(stringResource(R.string.temporary_share_material))
            CaptureCard {
                if (state.sharedText.isNotBlank()) SelectionContainer {
                    Text(state.sharedText, maxLines = 8, overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent)
                }
                if (state.filesPresent) {
                    Text(stringResource(R.string.temporary_share_files_pending),
                        style = MaterialTheme.typography.bodyMedium, color = colors.secondaryContent)
                    state.attachmentNames.forEach { name ->
                        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                    }
                }
            }
            if (state.operationId == null) {
                CaptureSectionLabel(stringResource(R.string.temporary_share_instruction))
                OutlinedTextField(value = state.instruction, onValueChange = onInstruction,
                    label = { Text(stringResource(R.string.temporary_share_instruction_hint)) },
                    enabled = !state.busy, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 5)
            }
            state.error?.let { Text(it, style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error) }
            if (state.cancellable) CaptureCard(modifier = Modifier.testTag("temporary-share-progress")) {
                val percent = state.transferProgress?.coerceIn(0f, 1f)?.times(100)?.toInt()
                Text(if (state.transferFileName != null && percent != null)
                    stringResource(R.string.temporary_share_upload_progress, state.transferFileName, percent)
                    else stringResource(R.string.temporary_share_sending),
                    style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent,
                    modifier = Modifier.testTag("temporary-share-progress-label")
                        .semantics { liveRegion = LiveRegionMode.Polite })
                if (state.transferProgress != null) LinearProgressIndicator(
                    progress = { state.transferProgress.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth().testTag("temporary-share-progress-bar"),
                    color = colors.accentPrimary, trackColor = colors.subtleOutline)
                else LinearProgressIndicator(Modifier.fillMaxWidth(), color = colors.accentPrimary,
                    trackColor = colors.subtleOutline)
                TextButton(onClick = onCancel, modifier = Modifier.align(androidx.compose.ui.Alignment.End)
                    .testTag("temporary-share-cancel"),
                    colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
                ) {
                    Text(stringResource(R.string.temporary_share_cancel))
                }
            }
            if (state.runId != null) CaptureCard {
                Text(stringResource(R.string.temporary_share_accepted),
                    style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
                Text(state.runId, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                state.resultState?.let { Text(it, style = MaterialTheme.typography.bodyMedium,
                    color = colors.secondaryContent) }
                state.resultText?.let { SelectionContainer { Text(it,
                    style = MaterialTheme.typography.bodyMedium, color = colors.primaryContent) } }
                if (state.resultTruncated) Text(stringResource(R.string.temporary_share_result_truncated),
                    style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            }
            if (!state.ready) TextButton(onClick = onOpenApp, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
                Text(stringResource(R.string.temporary_share_open_app))
            }
            Button(onClick = onSubmit,
                enabled = canSubmitTemporaryShare(state),
                modifier = Modifier.fillMaxWidth().testTag("temporary-share-submit")) {
                Text(stringResource(when {
                    state.busy -> R.string.temporary_share_sending
                    state.operationId != null -> R.string.temporary_share_check
                    else -> R.string.temporary_share_send
                }))
            }
            if (state.runId != null && state.ready) OutlinedButton(onClick = onCheckResult,
                enabled = !state.busy, modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
            ) {
                Text(stringResource(R.string.temporary_share_check_result))
            }
        }
    }
}
