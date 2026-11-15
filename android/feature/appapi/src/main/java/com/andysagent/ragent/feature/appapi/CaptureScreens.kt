package com.andysagent.ragent.feature.appapi

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.tooling.preview.*
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.core.model.*

@Composable
internal fun CaptureResult(result: TaskResultSnapshot) {
    val colors = LocalRagentColors.current
    Text(stringResource(R.string.api_capture_result_title), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
    Text(stringResource(when (result.state) {
        TaskResultState.UNCONFIRMED -> R.string.api_capture_result_unconfirmed
        TaskResultState.QUEUED -> R.string.api_capture_result_queued
        TaskResultState.CHECKING -> R.string.api_capture_result_checking
        TaskResultState.RUNNING -> R.string.api_capture_result_running
        TaskResultState.READY -> R.string.api_capture_result_ready
        TaskResultState.FAILED -> R.string.api_capture_result_failed
        TaskResultState.CANCELLED -> R.string.api_capture_result_cancelled
    }), color = colors.primaryContent, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    Text(stringResource(R.string.api_capture_result_observed, result.observedAt), color = colors.secondaryContent)
    result.text?.takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it, color = colors.primaryContent) } }
    if (result.state == TaskResultState.READY && result.text.isNullOrBlank()) Text(stringResource(R.string.api_capture_result_empty), color = colors.secondaryContent)
    if (result.textTruncated) Text(stringResource(R.string.api_capture_result_truncated), color = colors.secondaryContent)
    if (result.hasAttachments) Text(stringResource(R.string.api_capture_result_files), color = colors.secondaryContent)
    result.artifacts.forEach { artifact -> Text(artifact.originalName, color = colors.primaryContent) }
}

@Composable
internal fun CaptureError(code: ApiErrorCode) {
    Text(stringResource(when (code) {
        ApiErrorCode.INVALID_ARGUMENT -> R.string.api_capture_invalid
        ApiErrorCode.CAPABILITY_UNSUPPORTED -> R.string.api_capture_unsupported
        ApiErrorCode.TARGET_OFFLINE -> R.string.api_capture_offline
        ApiErrorCode.AUTHENTICATION_REQUIRED -> R.string.api_capture_auth
        ApiErrorCode.PERMISSION_DENIED -> R.string.api_capture_permission
        ApiErrorCode.TARGET_NOT_FOUND -> R.string.api_target_removed
        ApiErrorCode.AMBIGUOUS_TARGET -> R.string.api_capture_choose
        ApiErrorCode.RATE_LIMITED -> R.string.api_capture_busy
        ApiErrorCode.REVISION_CONFLICT -> R.string.api_capture_conflict
        ApiErrorCode.REQUEST_EXPIRED -> R.string.api_capture_expired
        ApiErrorCode.RESULT_UNKNOWN -> R.string.api_capture_unknown
        ApiErrorCode.RESOURCE_NOT_FOUND -> R.string.api_capture_missing
        else -> R.string.api_capture_error
    }), color = LocalRagentColors.current.stateError, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
}

@Composable
fun DraftInboxScreen(state: DraftInboxUiState, onOpen: (String) -> Unit, onDelete: (CaptureDraft) -> Unit,
    onReload: () -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    var pendingDelete by remember { mutableStateOf<CaptureDraft?>(null) }
    Column(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
        ApiSettingsHeader(stringResource(R.string.api_saved_drafts), onClose)
        LazyColumn(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth(),
            contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.loading) item { AgentoProgress() }
            state.error?.let { error -> item { CaptureCard { CaptureError(error); AgentoButton(stringResource(R.string.api_retry), onReload, secondary = true) } } }
            if (!state.loading && state.error == null && state.drafts.isEmpty()) item {
                CaptureCard {
                    CaptureGlyph(AgentoWebGlyph.Share)
                    Text(stringResource(R.string.api_capture_inbox_empty), color = colors.secondaryContent)
                }
            }
            items(state.drafts, key = { it.draftId }) { draft ->
                CaptureCard {
                    val label = draft.input.title?.takeIf { it.isNotBlank() } ?: draft.instruction.takeIf { it.isNotBlank() }?.take(80) ?: stringResource(R.string.api_capture_untitled)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CaptureGlyph(if (draft.operationId == null) AgentoWebGlyph.Edit else AgentoWebGlyph.Clock)
                        val status = when {
                            draft.operationId != null -> R.string.api_capture_frozen_short
                            draft.projectCreationOperationId != null && draft.projectId == null -> R.string.share_intake_creating
                            draft.intakeDecision?.decision == "needs_clarification" -> R.string.share_intake_question
                            draft.intakeDecision?.decision == "wait_context" -> R.string.share_intake_wait
                            draft.intakeId != null && draft.projectId == null -> R.string.share_intake_resolving
                            else -> R.string.api_capture_editable
                        }
                        AgentoSettingRow(title = label, subtitle = stringResource(status),
                            onClick = { onOpen(draft.draftId) }, modifier = Modifier.weight(1f))
                    }
                    if (draft.input.sharedText.isNotBlank()) Text(draft.input.sharedText, maxLines = 2,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, color = colors.secondaryContent, style = MaterialTheme.typography.bodyMedium)
                    if (draft.input.resources.isNotEmpty()) Text(captureMaterialCount( draft.input.resources.size),
                        color = colors.secondaryContent, style = MaterialTheme.typography.labelMedium)
                    if (draft.operationId == null && draft.projectCreationOperationId == null) AgentoButton(stringResource(R.string.api_capture_delete, label), { pendingDelete = draft },
                        enabled = !state.deleting, destructive = true, secondary = true, labelMaxLines = 2)
                }
            }
        }
    }
    pendingDelete?.let { selected ->
        val label = selected.input.title?.takeIf { it.isNotBlank() } ?: selected.instruction.takeIf { it.isNotBlank() }?.take(80) ?: stringResource(R.string.api_capture_untitled)
        val title = stringResource(R.string.api_capture_delete, label)
        val body = stringResource(R.string.api_capture_delete_confirm)
        val confirm = stringResource(R.string.api_confirm)
        val cancel = stringResource(R.string.api_cancel)
        AgentoDialog(title = title, confirmLabel = confirm, dismissLabel = cancel, destructive = true,
            onDismiss = { pendingDelete = null }, onConfirm = {
                pendingDelete = null
                val current = state.drafts.firstOrNull { it.draftId == selected.draftId }
                if (!state.loading && !state.deleting && current != null && current.revision == selected.revision &&
                    current.operationId == null && current.projectCreationOperationId == null) onDelete(current)
            }) { Text(body, color = colors.primaryContent) }
    }
}

class CapturePreviewStates : PreviewParameterProvider<CaptureUiState> {
    private val draft = CaptureDraft("example", "owner", 0, input = CaptureInput("https://example.com/article"), instruction = "Summarize the article", targetInstanceId = "home", runtime = TaskRuntime("tool", model = "model"))
    private val directory = ComputerDirectory(listOf(LinkedComputer("home", "", "Home")))
    private val models = listOf(RuntimeModelOption("model", "Available model"))
    private val ready = TaskOperation("capture_example", "owner", "hash", "prep", "home",
        TaskRequest("capture_example", "Summarize the article", TaskRuntime("tool")), "create", "request", 0, 10,
        stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run",
        result = TaskResultSnapshot("session", "request", "run", "run", TaskResultState.READY,
            "The completed analysis is ready to read.", false, emptyList(), "2026-10-11T00:00:00Z"))
    override val values = sequenceOf(CaptureUiState(), CaptureUiState(loading = false, error = ApiErrorCode.CAPABILITY_UNSUPPORTED),
        CaptureUiState(loading = false, draft = draft.copy(targetInstanceId = null, runtime = null)),
        CaptureUiState(loading = false, draft = draft, directory = directory, catalog = RuntimeCatalog(listOf(RuntimeToolOption("tool", "PC tool", models = models))), models = models),
        CaptureUiState(loading = false, draft = draft.copy(operationId = "capture_example"), busy = true),
        CaptureUiState(loading = false, draft = draft.copy(operationId = "capture_example"), error = ApiErrorCode.RESULT_UNKNOWN),
        CaptureUiState(loading = false, draft = draft.copy(input = draft.input.copy(resources = listOf(
            CaptureResourceRef("sample", 1, "sample.csv", "text/csv", 1024, "a".repeat(64))))), directory = directory),
        CaptureUiState(loading = false, draft = draft.copy(input = draft.input.copy(imports = listOf(CaptureImportSlot("pending")))), busy = true),
        CaptureUiState(loading = false, draft = draft.copy(input = draft.input.copy(imports = listOf(CaptureImportSlot("failed", error = ApiErrorCode.PERMISSION_DENIED))))),
        CaptureUiState(loading = false, draft = draft.copy(operationId = "capture_example"), operation = ready),
        CaptureUiState(loading = false, draft = draft.copy(operationId = "capture_example"), operation = ready.copy(result = ready.result!!.copy(textTruncated = true))),
        CaptureUiState(loading = false, draft = draft.copy(operationId = "capture_example"), operation = ready, directory = directory,
            selectionMode = CaptureSelectionMode.REPLACEABLE),
        CaptureUiState(loading = false, draft = draft, directory = directory, selectionMode = CaptureSelectionMode.READ_ONLY))
}
@Preview(widthDp = 360, heightDp = 800, fontScale = 1.6f)
@Preview(widthDp = 360, heightDp = 800)
@Preview(widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(widthDp = 840, heightDp = 800)
@Preview(widthDp = 840, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun CapturePreview(@PreviewParameter(CapturePreviewStates::class) state: CaptureUiState) {
    RagentTheme(darkTheme = isSystemInDarkTheme()) { CaptureScreen(state, {}) }
}
class InboxPreviewStates : PreviewParameterProvider<DraftInboxUiState> {
    override val values = sequenceOf(DraftInboxUiState(), DraftInboxUiState(loading = false), DraftInboxUiState(loading = false, error = ApiErrorCode.INTERNAL_ERROR),
        DraftInboxUiState(loading = false, drafts = listOf(CaptureDraft("a", "owner", 0, input = CaptureInput("Article link")), CaptureDraft("b", "owner", 0, input = CaptureInput("Reference"), operationId = "capture_b"))))
}
@Preview(widthDp = 360, heightDp = 800, fontScale = 1.6f)
@Preview(widthDp = 360, heightDp = 800)
@Preview(widthDp = 360, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(widthDp = 840, heightDp = 800)
@Preview(widthDp = 840, heightDp = 800, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun InboxPreview(@PreviewParameter(InboxPreviewStates::class) state: DraftInboxUiState) {
    RagentTheme(darkTheme = isSystemInDarkTheme()) { DraftInboxScreen(state, {}, {}, {}, {}) }
}
