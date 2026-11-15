package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.designsystem.LocalRagentColors

import androidx.compose.material3.ButtonDefaults

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import com.andysagent.ragent.core.designsystem.AgentoAlertDialog as AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.ContentReportError
import com.andysagent.ragent.core.domain.ContentReportReason

@Composable
fun ContentReportHost(viewModel: ContentReportViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    ContentReportDialog(state, viewModel::reason, viewModel::details, viewModel::includeContent,
        viewModel::content, viewModel::submit, { viewModel.checkReceipt(false) },
        { viewModel.checkReceipt(true) }, viewModel::dismiss, viewModel::requestClear,
        viewModel::cancelClear, viewModel::clearLocal)
}

@Composable
fun ContentReportDialog(
    state: ContentReportUiState,
    onReason: (ContentReportReason) -> Unit = {},
    onDetails: (String) -> Unit = {},
    onIncludeContent: (Boolean) -> Unit = {},
    onContent: (String) -> Unit = {},
    onSubmit: () -> Unit = {},
    onCheck: () -> Unit = {},
    onRetry: () -> Unit = {},
    onDismiss: () -> Unit = {},
    onRequestClear: () -> Unit = {},
    onCancelClear: () -> Unit = {},
    onClear: () -> Unit = {},
) {
    if (!state.open) return
    val saved = state.record
    val editable = !state.busy && saved == null && state.error != ContentReportError.Storage
    AlertDialog(
        modifier = Modifier.testTag("content-report-dialog"),
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.content_report_title)) },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.content_report_disclosure))
                if (state.busy) CircularProgressIndicator(Modifier.testTag("content-report-busy"))
                if (saved != null) {
                    Text(stringResource(R.string.content_report_saved_notice))
                    Text(stringResource(R.string.content_report_request_id, saved.payload.requestId),
                        modifier = Modifier.testTag("content-report-request-id"))
                    val status = when (saved.receipt?.status) {
                        "received" -> R.string.content_report_received
                        "in_review" -> R.string.content_report_in_review
                        "closed" -> R.string.content_report_closed
                        else -> R.string.content_report_unconfirmed
                    }
                    Text(stringResource(status), modifier = Modifier.testTag("content-report-status"))
                    saved.receipt?.let { Text(stringResource(R.string.content_report_received_at, it.receivedAt)) }
                    Text(stringResource(reportReasonLabel(ContentReportReason.entries.first { it.wire == saved.payload.reason })))
                    if (saved.payload.details.isNotEmpty()) Text(saved.payload.details)
                    if (saved.payload.includeContent) Text(saved.payload.content)
                    TextButton(onClick = onRequestClear, enabled = !state.busy, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
                        Text(stringResource(R.string.content_report_clear_local))
                    }
                } else if (state.selectedReply) {
                    Text(stringResource(R.string.content_report_reason), style = MaterialTheme.typography.titleSmall)
                    ContentReportReason.entries.forEach { reason ->
                        Row(Modifier.fillMaxWidth().clickable(enabled = editable) { onReason(reason) },
                            verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(state.reason == reason, onClick = { onReason(reason) }, enabled = editable)
                            Text(stringResource(reportReasonLabel(reason)))
                        }
                    }
                    OutlinedTextField(state.details, onDetails, enabled = editable,
                        label = { Text(stringResource(R.string.content_report_details)) },
                        supportingText = { Text("${state.details.length}/1000") },
                        modifier = Modifier.fillMaxWidth().testTag("content-report-details"))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(state.includeContent, onIncludeContent, enabled = editable,
                            modifier = Modifier.testTag("content-report-include"))
                        Text(stringResource(R.string.content_report_include))
                    }
                    if (state.includeContent) OutlinedTextField(state.content, onContent, enabled = editable,
                        label = { Text(stringResource(R.string.content_report_excerpt)) },
                        supportingText = { Text("${state.content.length}/4000") },
                        modifier = Modifier.fillMaxWidth().testTag("content-report-excerpt"))
                } else Text(stringResource(R.string.content_report_choose_reply))
                state.error?.let {
                    Text(stringResource(reportErrorLabel(it)), color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.testTag("content-report-error"))
                    if (it == ContentReportError.Storage && saved == null) TextButton(onClick = onRequestClear, enabled = !state.busy, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
                        Text(stringResource(R.string.content_report_clear_local))
                    }
                }
            }
        },
        confirmButton = {
            if (saved == null && state.selectedReply) Button(onClick = onSubmit,
                enabled = editable && state.reason != null, modifier = Modifier.testTag("content-report-submit")) {
                Text(stringResource(R.string.content_report_send))
            } else if (saved != null) Column {
                TextButton(onClick = onCheck, enabled = !state.busy, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.content_report_check)) }
                if (saved.receipt == null) TextButton(onClick = onRetry, enabled = !state.busy, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
                    Text(stringResource(R.string.content_report_retry))
                }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.content_report_close)) } },
    )
    if (state.clearConfirmation) AlertDialog(onDismissRequest = onCancelClear,
        title = { Text(stringResource(R.string.content_report_clear_local)) },
        text = { Text(stringResource(R.string.content_report_clear_warning)) },
        confirmButton = { TextButton(onClick = onClear, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.content_report_clear_local)) } },
        dismissButton = { TextButton(onClick = onCancelClear, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.content_report_close)) } })
}

internal fun reportReasonLabel(reason: ContentReportReason): Int = when (reason) {
    ContentReportReason.Unsafe -> R.string.content_report_reason_unsafe
    ContentReportReason.Harassment -> R.string.content_report_reason_harassment
    ContentReportReason.Sexual -> R.string.content_report_reason_sexual
    ContentReportReason.Privacy -> R.string.content_report_reason_privacy
    ContentReportReason.Deceptive -> R.string.content_report_reason_deceptive
    ContentReportReason.Other -> R.string.content_report_reason_other
}
internal fun reportErrorLabel(error: ContentReportError): Int = when (error) {
    ContentReportError.Storage -> R.string.content_report_error_storage
    ContentReportError.Unavailable -> R.string.content_report_error_unavailable
    ContentReportError.RateLimited -> R.string.content_report_error_rate
    ContentReportError.Rejected -> R.string.content_report_error_rejected
    ContentReportError.Conflict -> R.string.content_report_error_conflict
    ContentReportError.Unconfirmed -> R.string.content_report_error_unconfirmed
}

@Preview(showBackground = true, widthDp = 360, heightDp = 720)
@Composable private fun ContentReportPreview() {
    RagentTheme { ContentReportDialog(ContentReportUiState(open = true, selectedReply = true)) }
}
