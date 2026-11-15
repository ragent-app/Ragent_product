package com.andysagent.ragent.feature.appapi

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.*
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.*

private sealed interface PendingOutputAction {
    val operationId: String
    data class Delete(override val operationId: String, val file: SavedResultRow) : PendingOutputAction
    data class Revoke(override val operationId: String, val ref: ResultDeliveryRef) : PendingOutputAction
    data class ClearHistory(override val operationId: String, val saves: List<DocumentSaveRef>) : PendingOutputAction
}

@Composable
fun ResultOutputsScreen(state: ResultOutputsUiState, onEvent: (ResultOutputsEvent) -> Unit,
    onClose: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    var pending by remember { mutableStateOf<PendingOutputAction?>(null) }
    Column(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
      ApiSettingsHeader(stringResource(R.string.api_outputs_title), onClose)
      Column(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
          .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
          verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (state.loading) Text(stringResource(R.string.api_loading), color = colors.secondaryContent)
        state.error?.let { ResultOutputsError(it) }
        state.notice?.let { notice -> Text(stringResource(when (notice) {
            ResultOutputsNotice.STOPPED -> R.string.api_outputs_stopped
            ResultOutputsNotice.SHARE_REQUESTED -> R.string.api_outputs_share_requested
            ResultOutputsNotice.SAVED -> R.string.api_outputs_saved
            ResultOutputsNotice.SAVE_CANCELLED -> R.string.api_outputs_save_cancelled
            ResultOutputsNotice.SAVE_INTERRUPTED -> R.string.api_outputs_save_interrupted
            ResultOutputsNotice.REVOKED -> R.string.api_outputs_revoked
        }), color = colors.secondaryContent) }
        if (state.busy) {
            Text(stringResource(R.string.api_outputs_busy), color = colors.secondaryContent)
            AgentoButton(stringResource(R.string.api_outputs_stop), { onEvent(ResultOutputsEvent.Stop) },
                secondary = true, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-stop"))
        }
        if (state.awaitingSave != null) Text(stringResource(R.string.api_outputs_select_document), color = colors.secondaryContent)
        val snapshot = state.snapshot
        if (snapshot != null) {
            Text(snapshot.task.title, color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.api_outputs_binding, snapshot.task.targetId, snapshot.task.operationId), color = colors.secondaryContent)
            Text(stringResource(R.string.api_outputs_local_only), color = colors.secondaryContent)
            AgentoButton(stringResource(R.string.api_outputs_query), { onEvent(ResultOutputsEvent.QueryManifest) },
                enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-query"))
            Text(stringResource(R.string.api_outputs_pc_resources), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
            val manifest = snapshot.task.manifest
            if (manifest == null) Text(stringResource(R.string.api_outputs_query_hint), color = colors.secondaryContent)
            else {
                Text(stringResource(R.string.api_outputs_manifest_expiry, manifest.expiresAt), color = colors.secondaryContent)
                manifest.resources.forEach { resource ->
                  ApiSettingsCard {
                    Text(resource.originalName, color = colors.primaryContent)
                    Text("${resource.mimeType} · ${resource.sizeBytes ?: 0} B", color = colors.secondaryContent)
                    if (!resource.available) Text(stringResource(R.string.api_outputs_unavailable), color = colors.secondaryContent)
                    else AgentoButton(stringResource(R.string.api_outputs_download), { onEvent(ResultOutputsEvent.Download(resource.resourceId)) },
                        enabled = state.canAct && snapshot.files.none { it.resourceId == resource.resourceId && it.manifestRevision == manifest.revision },
                        labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-download-${resource.resourceId}"))
                  }
                }
            }
            Text(stringResource(R.string.api_outputs_private_files), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
            if (snapshot.files.isEmpty()) Text(stringResource(R.string.api_outputs_no_files), color = colors.secondaryContent)
            snapshot.files.forEach { file ->
                ApiSettingsCard(Modifier.testTag("outputs-file-${file.id}")) {
                    Text(file.name, color = colors.primaryContent)
                    Text(stringResource(when (file.state) {
                        ResultOutputState.DOWNLOADING -> R.string.api_outputs_downloading
                        ResultOutputState.PARTIAL -> R.string.api_outputs_partial
                        ResultOutputState.COMMITTING -> R.string.api_outputs_verifying
                        ResultOutputState.READY -> R.string.api_outputs_ready
                        ResultOutputState.FAILED -> R.string.api_outputs_failed
                        ResultOutputState.DELETED -> R.string.api_outputs_deleted
                    }), color = colors.secondaryContent)
                    Text("${file.receivedBytes} / ${file.sizeBytes} B · ${file.mimeType}", color = colors.secondaryContent)
                    file.error?.let { ResultOutputsError(it) }
                    if (file.state == ResultOutputState.PARTIAL) AgentoButton(stringResource(R.string.api_outputs_resume),
                        { onEvent(ResultOutputsEvent.Resume(file.id)) }, enabled = state.canAct,
                        labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-resume-${file.id}"))
                    if (file.state == ResultOutputState.READY) {
                        AgentoButton(stringResource(R.string.api_outputs_share), { onEvent(ResultOutputsEvent.Deliver(file.id, ResultDeliveryAction.SHARE)) },
                            enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-share-${file.id}"))
                        AgentoButton(stringResource(R.string.api_outputs_save), { onEvent(ResultOutputsEvent.Deliver(file.id, ResultDeliveryAction.SAVE)) },
                            secondary = true, enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-save-${file.id}"))
                    }
                    if (file.state !in setOf(ResultOutputState.DOWNLOADING, ResultOutputState.COMMITTING, ResultOutputState.DELETED))
                        AgentoButton(stringResource(R.string.api_outputs_delete), { pending = PendingOutputAction.Delete(snapshot.task.operationId, file) },
                            secondary = true, enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-delete-${file.id}"))
                }
            }
            if (snapshot.documentSaves.isNotEmpty()) {
                Text(stringResource(R.string.api_outputs_save_history), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
                snapshot.documentSaves.forEach { save ->
                    Text(save.name, color = colors.primaryContent)
                    Text(stringResource(when (save.state) {
                        DocumentSaveState.WAITING_SELECTION -> R.string.api_outputs_save_waiting
                        DocumentSaveState.COPYING -> R.string.api_outputs_save_copying
                        DocumentSaveState.SAVED -> R.string.api_outputs_save_done
                        DocumentSaveState.CANCELLED -> R.string.api_outputs_save_cancelled_history
                        DocumentSaveState.INTERRUPTED -> R.string.api_outputs_save_interrupted_history
                    }), color = colors.secondaryContent, modifier = Modifier.testTag("outputs-document-${save.ticketId}"))
                    if (save.state == DocumentSaveState.INTERRUPTED && save.copyStarted)
                        Text(stringResource(R.string.api_outputs_save_partial_history), color = colors.secondaryContent)
                }
                Text(stringResource(R.string.api_outputs_save_history_hint), color = colors.secondaryContent)
                AgentoButton(stringResource(R.string.api_outputs_save_clear_history), { pending = PendingOutputAction.ClearHistory(snapshot.task.operationId, snapshot.documentSaves.toList()) },
                    secondary = true, enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-clear-document-history"))
            }
            if (snapshot.deliveries.isNotEmpty()) {
                Text(stringResource(R.string.api_outputs_deliveries), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.api_outputs_revoke_limit), color = colors.secondaryContent)
                snapshot.deliveries.forEach { ref ->
                    val expiry = java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT,
                        LocalConfiguration.current.locales[0]).format(java.util.Date(ref.expiresAt))
                    Text(stringResource(R.string.api_outputs_ticket, ref.name, expiry), color = colors.secondaryContent)
                    AgentoButton(stringResource(R.string.api_outputs_revoke), { pending = PendingOutputAction.Revoke(snapshot.task.operationId, ref) },
                        secondary = true, enabled = state.canAct, labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-revoke-${ref.id}"))
                }
            }
        }
        if (!state.loading) AgentoButton(stringResource(R.string.api_outputs_refresh), { onEvent(ResultOutputsEvent.RefreshLocal) },
            secondary = true, enabled = !state.busy && state.effect == null && state.awaitingSave == null,
            labelMaxLines = Int.MAX_VALUE, contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                modifier = Modifier.testTag("outputs-refresh"))
      }
    }
    pending?.let { action ->
        val title = stringResource(when (action) {
            is PendingOutputAction.Delete -> R.string.api_outputs_delete
            is PendingOutputAction.Revoke -> R.string.api_outputs_revoke
            is PendingOutputAction.ClearHistory -> R.string.api_outputs_save_clear_history
        })
        val description = stringResource(when (action) {
            is PendingOutputAction.Delete -> R.string.api_outputs_delete_confirm
            is PendingOutputAction.Revoke -> R.string.api_outputs_revoke_limit
            is PendingOutputAction.ClearHistory -> R.string.api_outputs_save_history_hint
        })
        val label = when (action) {
            is PendingOutputAction.Delete -> action.file.name
            is PendingOutputAction.Revoke -> action.ref.name
            is PendingOutputAction.ClearHistory -> null
        }
        val confirm = stringResource(R.string.api_confirm)
        val cancel = stringResource(R.string.api_cancel)
        AgentoDialog(title = title, confirmLabel = confirm, dismissLabel = cancel, destructive = true,
            onDismiss = { pending = null }, onConfirm = {
                pending = null
                val snapshot = state.snapshot
                if (state.canAct && snapshot != null && snapshot.task.operationId == action.operationId) {
                    when (action) {
                        is PendingOutputAction.Delete -> if (snapshot.files.contains(action.file) &&
                            action.file.state !in setOf(ResultOutputState.DOWNLOADING, ResultOutputState.COMMITTING, ResultOutputState.DELETED))
                            onEvent(ResultOutputsEvent.Delete(action.file.id))
                        is PendingOutputAction.Revoke -> if (snapshot.deliveries.contains(action.ref)) onEvent(ResultOutputsEvent.Revoke(action.ref.id))
                        is PendingOutputAction.ClearHistory -> if (snapshot.documentSaves == action.saves && action.saves.isNotEmpty()) onEvent(ResultOutputsEvent.ClearDocumentHistory)
                    }
                }
            }) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                label?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = colors.primaryContent) }
                Text(description, color = colors.primaryContent)
            }
        }
    }
}

@Composable
private fun ResultOutputsError(code: ApiErrorCode) {
    val specific = when (code) {
        ApiErrorCode.INVALID_ARGUMENT -> R.string.api_outputs_error_invalid
        ApiErrorCode.REVISION_CONFLICT -> R.string.api_outputs_error_conflict
        ApiErrorCode.REQUEST_EXPIRED -> R.string.api_outputs_error_expired
        ApiErrorCode.RESOURCE_LIMIT -> R.string.api_outputs_error_limit
        ApiErrorCode.RATE_LIMITED -> R.string.api_outputs_error_busy
        ApiErrorCode.RESULT_UNKNOWN -> R.string.api_outputs_error_unknown
        ApiErrorCode.INTERNAL_ERROR -> R.string.api_outputs_error_failed
        ApiErrorCode.CANCELLED -> R.string.api_outputs_stopped
        else -> null
    }
    if (specific == null) CaptureError(code)
    else Text(stringResource(specific), color = LocalRagentColors.current.stateError,
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

class ResultOutputsPreviewStates : PreviewParameterProvider<ResultOutputsUiState> {
    override val values: Sequence<ResultOutputsUiState> get() {
        val ready = SavedResultRow("file", "text", "revision", 3, "Report.txt", "text/plain", 4096, 4096, ResultOutputState.READY)
        val snapshot = ResultOutputsSnapshot(ResultTaskInfo("operation", "Office PC", "session", "Analyze the report", OperationStage.ACCEPTED, null),
            listOf(ready), listOf(ResultDeliveryRef("ticket", ready.name, ready.mimeType, ready.sizeBytes, 2_000_000_000_000)))
        val manifest = ResultExportManifest(1, "Office PC", "session", "request", "run", "final",
            listOf(ResultExportResource("text", "Report.txt", "text/plain", true, 4096, "a".repeat(64)),
                ResultExportResource("missing", "Unavailable.pdf", "application/pdf", false)),
            4096, 65536, "2033-05-18T00:00:00Z", "revision")
        return sequenceOf(ResultOutputsUiState(), ResultOutputsUiState(loading = false, snapshot = snapshot),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(files = emptyList(), deliveries = emptyList())),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(files = listOf(ready.copy(state = ResultOutputState.PARTIAL, receivedBytes = 1024)))),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(files = listOf(ready.copy(state = ResultOutputState.DOWNLOADING, receivedBytes = 1024))), busy = true),
            ResultOutputsUiState(loading = false, error = ApiErrorCode.PERMISSION_DENIED),
            ResultOutputsUiState(loading = false, snapshot = snapshot, notice = ResultOutputsNotice.SAVE_INTERRUPTED),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(task = snapshot.task.copy(manifest = manifest))),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(files = listOf(ready.copy(state = ResultOutputState.COMMITTING))), busy = true),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(files = listOf(ready.copy(state = ResultOutputState.FAILED, error = ApiErrorCode.REVISION_CONFLICT)))),
            ResultOutputsUiState(loading = false, snapshot = snapshot, awaitingSave = snapshot.deliveries.single()),
            ResultOutputsUiState(loading = false, snapshot = snapshot.copy(documentSaves = DocumentSaveState.entries.map { stage ->
                DocumentSaveRef(stage.name, "Report.txt", 4096, stage, 2_000_000_000_000,
                    stage in setOf(DocumentSaveState.COPYING, DocumentSaveState.SAVED, DocumentSaveState.INTERRUPTED), null)
            })))
    }
}
@Preview(widthDp = 360, heightDp = 840)
@Preview(widthDp = 600, heightDp = 900, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun ResultOutputsPreview(@PreviewParameter(ResultOutputsPreviewStates::class) state: ResultOutputsUiState) {
    RagentTheme { ResultOutputsScreen(state, {}, {}) }
}
