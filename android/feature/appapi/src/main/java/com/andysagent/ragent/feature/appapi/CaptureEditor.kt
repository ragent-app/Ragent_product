package com.andysagent.ragent.feature.appapi

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.designsystem.*

/** Presentation-only sheet state. Opening, choosing and dismissing never submit a task. */
private enum class CapturePanel { MATERIAL, COMPUTER, RUNTIME }

@Composable
fun CaptureScreen(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    var panel by rememberSaveable(state.draft?.draftId) { mutableStateOf<CapturePanel?>(null) }
    val focus = LocalFocusManager.current
    val open: (CapturePanel) -> Unit = { focus.clearFocus(); panel = it }
    BoxWithConstraints(modifier.fillMaxSize().background(colors.canvas).safeDrawingPadding().imePadding()) {
        val compact = maxHeight < 300.dp && WindowInsets.ime.getBottom(LocalDensity.current) > 0
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            if (!compact) CaptureHeader(stringResource(R.string.api_capture_title), onClose = { onEvent(CaptureEvent.SaveAndClose) })
            Column(Modifier.weight(1f).widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth()
                .verticalScroll(rememberScrollState()).testTag("capture-content").padding(horizontal = 20.dp, vertical = if (compact) 4.dp else 12.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp)) {
                if (state.loading) CaptureLoading()
                state.error?.let { CaptureCard { CaptureError(it) } }
                val draft = state.draft
                if (draft != null) {
                    if (state.selectionMode != CaptureSelectionMode.NONE) {
                        CaptureNotice(stringResource(if (state.selectionMode == CaptureSelectionMode.READ_ONLY)
                            R.string.api_selection_readonly else R.string.api_selection_replaceable))
                    }
                    if (draft.operationId == null) {
                        if (!compact) {
                            Text(stringResource(R.string.share_headline), style = MaterialTheme.typography.headlineMedium,
                                fontWeight = FontWeight.SemiBold, color = colors.primaryContent)
                            CaptureMaterials(state, onEvent) { open(CapturePanel.MATERIAL) }
                        }
                        CaptureComposer(state, onEvent, compact)
                        draft.intakeDecision?.let { decision ->
                            CaptureCard {
                                when (decision.decision) {
                                    "needs_clarification" -> Text(decision.question ?: stringResource(R.string.share_intake_question),
                                        color = colors.primaryContent)
                                    "wait_context" -> Text(stringResource(R.string.share_intake_wait), color = colors.secondaryContent)
                                    else -> Text(decision.reason ?: stringResource(R.string.share_intake_resolving),
                                        color = colors.secondaryContent)
                                }
                            }
                        }
                        if (!compact) Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            CaptureSectionLabel(stringResource(R.string.share_destination))
                            CaptureCard(padding = 0) {
                                CaptureSummaryRow(AgentoWebGlyph.Monitor, stringResource(R.string.api_capture_computer),
                                    targetLabel(state), state.editable, "capture-computer", onClick = { open(CapturePanel.COMPUTER) })
                                HorizontalDivider(color = colors.subtleOutline, modifier = Modifier.padding(horizontal = 18.dp))
                                CaptureSummaryRow(AgentoWebGlyph.Agent, stringResource(R.string.share_execution),
                                    runtimeLabel(state), state.editable && draft.targetInstanceId != null, "capture-runtime",
                                    onClick = { open(CapturePanel.RUNTIME) })
                            }
                            CaptureRoutingNotices(state, onEvent)
                        }
                        if (state.error == ApiErrorCode.REVISION_CONFLICT) CaptureAction(R.string.api_capture_copy, state, onEvent, CaptureEvent.CopyAsNew)
                    } else {
                        CaptureReceipt(state, onEvent)
                        CaptureMaterials(state, onEvent) { open(CapturePanel.MATERIAL) }
                        CaptureCard {
                            CaptureSectionLabel(stringResource(R.string.api_capture_instruction))
                            SelectionContainer { Text(draft.instruction, color = colors.primaryContent) }
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }
            }
            if (state.draft != null) CaptureDock(state, onEvent, compact)
        }
    }
    // A platform modal isolates accessibility focus and handles Back/IME; its content uses Ragent tokens.
    panel?.let { current ->
        CapturePickerSheet(current, state, onEvent, onDismiss = { panel = null })
    }
}

@Composable
internal fun CaptureHeader(title: String, onClose: () -> Unit) {
    val colors = LocalRagentColors.current
    Row(Modifier.widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AgentoWebIcon(AgentoWebGlyph.Share, null, Modifier.size(20.dp), colors.secondaryContent)
        Text(title, Modifier.weight(1f), color = colors.primaryContent, style = MaterialTheme.typography.titleMedium)
        AgentoIconButton(onClose, stringResource(R.string.api_close)) { AgentoWebIcon(AgentoWebGlyph.Close, null, Modifier.size(20.dp)) }
    }
}

@Composable
internal fun CaptureCard(modifier: Modifier = Modifier, padding: Int = 18, content: @Composable ColumnScope.() -> Unit) {
    val colors = LocalRagentColors.current
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(colors.surfaceLow).padding(padding.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

@Composable
internal fun CaptureSectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = LocalRagentColors.current.secondaryContent,
        modifier = Modifier.semantics { heading() })
}

@Composable
private fun CaptureMaterials(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, onExpand: () -> Unit) {
    val draft = state.draft ?: return
    val colors = LocalRagentColors.current
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CaptureSectionLabel(stringResource(R.string.api_capture_source))
            Spacer(Modifier.weight(1f))
            Text(captureMaterialCount( draft.input.resources.size + draft.input.imports.size +
                if (draft.input.sharedText.isNotBlank()) 1 else 0), style = MaterialTheme.typography.labelMedium, color = colors.secondaryContent)
        }
        CaptureCard {
            if (state.busy && draft.input.imports.isNotEmpty()) {
                Text(stringResource(R.string.share_import_batch, draft.input.resources.size,
                    draft.input.resources.size + draft.input.imports.size), color = colors.secondaryContent,
                    style = MaterialTheme.typography.labelMedium)
                Text(stringResource(R.string.share_import_local_only), color = colors.secondaryContent,
                    style = MaterialTheme.typography.bodySmall)
            }
            if (draft.input.sharedText.isNotBlank()) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                    CaptureGlyph(AgentoWebGlyph.File)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        draft.input.title?.takeIf { it.isNotBlank() }?.let { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleSmall, color = colors.primaryContent) }
                        Text(draft.input.sharedText, maxLines = 3, overflow = TextOverflow.Ellipsis,
                            color = colors.primaryContent, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            } else if (draft.input.resources.isEmpty() && draft.input.imports.isEmpty()) {
                Text(stringResource(R.string.share_no_material), color = colors.secondaryContent, style = MaterialTheme.typography.bodyMedium)
            }
            draft.input.resources.forEach { resource ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CaptureGlyph(AgentoWebGlyph.File)
                    Column(Modifier.weight(1f)) {
                        Text(resource.originalName, color = colors.primaryContent, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${resource.mimeType} · ${Formatter.formatShortFileSize(LocalContext.current, resource.sizeBytes)}",
                            color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
                    }
                    if (draft.operationId == null) IconButton(onClick = { onEvent(CaptureEvent.RemoveResource(resource.resourceId)) },
                        enabled = state.editable, modifier = Modifier.size(48.dp)) {
                        AgentoWebIcon(AgentoWebGlyph.Close, stringResource(R.string.api_capture_remove_file, resource.originalName), Modifier.size(18.dp), colors.secondaryContent)
                    }
                }
            }
            draft.input.imports.forEachIndexed { index, slot ->
                val progress = state.importProgress?.takeIf { it.resourceId == slot.resourceId && slot.error == null }
                val name = progress?.originalName ?: slot.name ?: stringResource(R.string.api_capture_import_file, index + 1)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(name, color = colors.primaryContent)
                    if (progress != null) CaptureImportStatus(progress)
                    else Text(stringResource(if (slot.error != null) R.string.api_capture_import_failed
                        else if (state.importProgress != null) R.string.share_import_waiting else R.string.api_capture_importing),
                        color = if (slot.error == null) colors.secondaryContent else colors.stateError, style = MaterialTheme.typography.bodySmall)
                    slot.error?.let { CaptureError(it) }
                    if (draft.operationId == null) TextButton(onClick = { onEvent(CaptureEvent.RemoveImport(slot.resourceId)) }, enabled = state.editable, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) {
                        Text(stringResource(R.string.api_capture_skip_file, name), color = colors.secondaryContent)
                    }
                }
            }
            if (state.editable || draft.input.sharedText.isNotBlank()) TextButton(
                onClick = onExpand, modifier = Modifier.testTag("capture-material-edit"), enabled = !state.loading,
                colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
            ) {
                AgentoWebIcon(if (state.editable) AgentoWebGlyph.Edit else AgentoWebGlyph.Maximize, null, Modifier.size(16.dp), colors.secondaryContent)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(if (state.editable) R.string.share_edit_material else R.string.share_view_material), color = colors.secondaryContent)
            }
        }
    }
}

@Composable
private fun CaptureImportStatus(progress: CaptureImportProgress) {
    val colors = LocalRagentColors.current
    val context = LocalContext.current
    val copied = Formatter.formatShortFileSize(context, progress.copiedBytes)
    val total = progress.totalBytes
    val status = when {
        progress.phase == CaptureImportPhase.SAVING -> stringResource(R.string.share_import_saving, copied)
        total != null -> stringResource(R.string.share_import_known, copied,
            Formatter.formatShortFileSize(context, total))
        else -> stringResource(R.string.share_import_unknown, copied)
    }
    Column(Modifier.testTag("capture-import-${progress.resourceId}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(status, color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
        if (progress.phase == CaptureImportPhase.COPYING && total != null)
            LinearProgressIndicator(progress = { progress.copiedBytes.toFloat() / total },
                modifier = Modifier.fillMaxWidth(), color = colors.accentPrimary, trackColor = colors.subtleOutline)
        else LinearProgressIndicator(Modifier.fillMaxWidth(), color = colors.accentPrimary, trackColor = colors.subtleOutline)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CaptureComposer(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, compact: Boolean) {
    val colors = LocalRagentColors.current
    val draft = state.draft ?: return
    val label = stringResource(R.string.api_capture_instruction)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (!compact) CaptureSectionLabel(label)
        AgentoFrostedGlassBox(Modifier.fillMaxWidth(), shape = RoundedCornerShape(26.dp), material = AgentoGlassMaterial.ContentThick,
            shadowElevation = 4.dp) {
            BasicTextField(draft.instruction, { onEvent(CaptureEvent.Instruction(it)) }, enabled = state.editable,
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.primaryContent), cursorBrush = SolidColor(colors.accentPrimary),
                minLines = if (compact) 1 else 3, maxLines = if (compact) 3 else 7, modifier = Modifier.fillMaxWidth().padding(if (compact) 12.dp else 20.dp).testTag("capture-instruction")
                    .semantics { contentDescription = label }, decorationBox = { inner ->
                    Box { if (draft.instruction.isEmpty()) Text(stringResource(R.string.share_instruction_hint),
                        color = colors.secondaryContent, style = MaterialTheme.typography.bodyLarge); inner() }
                })
        }
        if (draft.instruction.isBlank() && state.editable && !compact) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf(R.string.share_suggest_summary to R.string.share_prompt_summary,
                    R.string.share_suggest_translate to R.string.share_prompt_translate,
                    R.string.share_suggest_actions to R.string.share_prompt_actions).forEach { (labelId, promptId) ->
                    val prompt = stringResource(promptId)
                    SuggestionChip(onClick = { onEvent(CaptureEvent.Instruction(prompt)) }, label = { Text(stringResource(labelId)) },
                        shape = RoundedCornerShape(50), colors = SuggestionChipDefaults.suggestionChipColors(labelColor = colors.secondaryContent), border = null)
                }
            }
        }
    }
}

@Composable
private fun CaptureSummaryRow(glyph: AgentoWebGlyph, title: String, value: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val colors = LocalRagentColors.current
    Surface(onClick = onClick, enabled = enabled, color = colors.surfaceLow, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            AgentoWebIcon(glyph, null, Modifier.size(22.dp), colors.secondaryContent)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(title, color = colors.secondaryContent, style = MaterialTheme.typography.labelMedium)
                Text(value, color = colors.primaryContent, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            AgentoWebIcon(AgentoWebGlyph.ChevronDown, null, Modifier.size(18.dp), colors.secondaryContent)
        }
    }
}

@Composable
private fun targetLabel(state: CaptureUiState): String = state.directory.computers.firstOrNull { it.instanceId == state.draft?.targetInstanceId }
    ?.let { computer -> computer.label.ifBlank { computer.instanceId } +
        if (state.directory.computers.count { it.label == computer.label } > 1) " · ${computer.instanceId}" else "" }
    ?: stringResource(if (state.draft?.targetInstanceId == null) R.string.share_choose_computer else R.string.api_target_removed)

@Composable
private fun runtimeLabel(state: CaptureUiState): String {
    if (state.catalogLoading) return stringResource(R.string.api_loading)
    val tool = state.catalog.tools.firstOrNull { it.id == state.draft?.runtime?.tool }
    val model = state.models.firstOrNull { it.id == state.draft?.runtime?.model }
    return listOfNotNull(tool?.label, tool?.providers?.firstOrNull { it.id == state.draft?.runtime?.providerProfile }?.label, model?.label).joinToString(" · ").ifBlank { stringResource(R.string.share_choose_runtime) }
}

@Composable
private fun CaptureRoutingNotices(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit) {
    val draft = state.draft ?: return
    val defaultId = state.directory.appApiRouting.defaultShareTargetId
    if (draft.requireTargetSelection) CaptureNotice(stringResource(R.string.api_capture_shortcut_unavailable))
    if (!state.directory.appApiRouting.readable) {
        CaptureError(ApiErrorCode.PERMISSION_DENIED)
        CaptureNotice(stringResource(R.string.api_routing_unreadable))
        CaptureAction(R.string.api_routing_title, state, onEvent, CaptureEvent.OpenRoutingSettings)
    }
    if (defaultId != null && state.directory.computers.none { it.instanceId == defaultId }) CaptureNotice(stringResource(R.string.api_default_missing))
    if (state.directory.computers.isEmpty()) CaptureNotice(stringResource(R.string.api_no_computers))
    if (draft.targetInstanceId != null && state.directory.computers.none { it.instanceId == draft.targetInstanceId }) CaptureError(ApiErrorCode.TARGET_NOT_FOUND)
    if (state.runtimeRestored) CaptureNotice(stringResource(R.string.share_runtime_restored))
    if (state.directory.computers.any { it.instanceId == draft.targetInstanceId }) CaptureConnectionStatusRow(state, onEvent)
}

@Composable
private fun CaptureConnectionStatusRow(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit) {
    val context = LocalContext.current
    val colors = LocalRagentColors.current
    val observed = state.connectionObservation?.takeIf { it.targetId == state.draft?.targetInstanceId }
    val label = when {
        state.checkingConnection -> R.string.share_connection_checking
        observed == null -> R.string.share_connection_unknown
        state.connectionObservationStale -> R.string.share_connection_stale
        else -> when (observed.status) {
            CaptureConnectionStatus.AVAILABLE -> R.string.share_connection_available
            CaptureConnectionStatus.UNREACHABLE -> R.string.share_connection_unreachable
            CaptureConnectionStatus.AUTHENTICATION_REQUIRED -> R.string.share_connection_auth
            CaptureConnectionStatus.SERVICE_UNAVAILABLE -> R.string.share_connection_service_unavailable
            CaptureConnectionStatus.UNPAIRED -> R.string.share_connection_unpaired
            CaptureConnectionStatus.UNKNOWN -> R.string.share_connection_inconclusive
        }
    }
    Column(Modifier.testTag("capture-connection-status"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Column(Modifier.fillMaxWidth()) {
            Text(stringResource(label), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            TextButton({ onEvent(CaptureEvent.CheckConnection) }, enabled = state.canCheckConnection,
                modifier = Modifier.heightIn(min = 48.dp).testTag("capture-connection-check"),
                colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
            ) {
                Text(stringResource(R.string.share_connection_check), color = colors.secondaryContent)
            }
        }
        observed?.let {
            val date = java.util.Date(it.checkedAtMillis)
            val time = android.text.format.DateFormat.getDateFormat(context).format(date) + " " +
                android.text.format.DateFormat.getTimeFormat(context).format(date)
            Text(stringResource(R.string.share_connection_checked_at, time), color = colors.secondaryContent,
                style = MaterialTheme.typography.labelSmall)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CapturePickerSheet(panel: CapturePanel, state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, onDismiss: () -> Unit) {
    val colors = LocalRagentColors.current
    val draft = state.draft ?: return
    // Dialog windows install Android locals from the Activity; retain the app's explicit language and font scale.
    val localizedContext = LocalContext.current
    val localizedConfiguration = LocalConfiguration.current
    val localizedDensity = LocalDensity.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = androidx.compose.ui.graphics.Color.Transparent, contentColor = colors.primaryContent,
        dragHandle = null, shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp)) {
        CompositionLocalProvider(LocalContext provides localizedContext, LocalConfiguration provides localizedConfiguration,
            LocalDensity provides localizedDensity) {
            com.andysagent.ragent.core.designsystem.RagentapsuleGlassBox(
                modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(topStart = 30.dp, topEnd = 30.dp)) {
            Column(Modifier.fillMaxWidth().heightIn(max = 680.dp).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.align(Alignment.CenterHorizontally).padding(top = 12.dp)
                    .size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(50)).background(colors.secondaryContent.copy(alpha = 0.32f)))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(when (panel) { CapturePanel.MATERIAL -> R.string.api_capture_source
                        CapturePanel.COMPUTER -> R.string.api_capture_computer; CapturePanel.RUNTIME -> R.string.share_execution }),
                        style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton(onClick = onDismiss, modifier = Modifier.testTag("capture-sheet-done"), colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.share_done), color = colors.accentPrimary) }
                }
                when (panel) {
                    CapturePanel.MATERIAL -> {
                        val label = stringResource(R.string.api_capture_source)
                        if (state.editable) AgentoTextField(draft.input.sharedText, { onEvent(CaptureEvent.SourceText(it)) }, label,
                            singleLine = false, inputModifier = Modifier.heightIn(min = 160.dp, max = 360.dp).semantics { contentDescription = label })
                        else SelectionContainer { Text(draft.input.sharedText.ifBlank { stringResource(R.string.share_no_text) }) }
                        CaptureNotice(stringResource(R.string.share_material_help))
                    }
                    CapturePanel.COMPUTER -> {
                        CaptureNotice(stringResource(R.string.share_computer_help))
                        Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            state.directory.computers.forEach { computer ->
                                CaptureOption(computer.label.ifBlank { computer.instanceId }, computer.instanceId,
                                    draft.targetInstanceId == computer.instanceId, state.editable) { onEvent(CaptureEvent.Target(computer.instanceId)) }
                                CapturePickerConnectionRow(computer.instanceId, state, onEvent)
                            }
                        }
                        if (state.directory.computers.isEmpty()) CaptureNotice(stringResource(R.string.api_no_computers))
                        if (state.directory.computers.any { it.instanceId == draft.targetInstanceId }) {
                            CaptureAction(R.string.api_capture_pin, state, onEvent, CaptureEvent.PinTarget, enabled = state.editable)
                            state.pinResult?.let { Text(stringResource(when (it) {
                                CapturePinResult.REQUESTED -> R.string.api_capture_pin_requested
                                CapturePinResult.UNSUPPORTED -> R.string.api_capture_pin_unsupported
                                CapturePinResult.FAILED -> R.string.api_capture_pin_failed
                            }), color = colors.secondaryContent) }
                        }
                        CaptureAction(R.string.api_routing_title, state, onEvent, CaptureEvent.OpenRoutingSettings)
                    }
                    CapturePanel.RUNTIME -> {
                        if (state.catalogLoading) CaptureLoading()
                        state.error?.let { CaptureError(it) }
                        CaptureSectionLabel(stringResource(R.string.api_capture_runtime))
                        Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            state.catalog.tools.forEach { tool -> CaptureOption(tool.label, null, draft.runtime?.tool == tool.id,
                                state.editable && !state.catalogLoading) { onEvent(CaptureEvent.Tool(tool.id)) } }
                        }
                        if (!state.catalogLoading && state.catalog.tools.isEmpty()) CaptureNotice(stringResource(R.string.api_capture_no_runtime))
                        val tool = state.catalog.tools.firstOrNull { it.id == draft.runtime?.tool }
                        if (tool?.providerSelectionRequired == true) {
                            CaptureSectionLabel(stringResource(R.string.api_capture_provider))
                            Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                tool.providers.forEach { provider -> CaptureOption(provider.label, null, draft.runtime?.providerProfile == provider.id,
                                    state.editable && !state.catalogLoading) { onEvent(CaptureEvent.Provider(provider.id)) } }
                            }
                        }
                        if (tool != null) {
                            CaptureSectionLabel(stringResource(R.string.api_capture_model))
                            if (!state.catalogLoading && state.models.isEmpty()) CaptureNotice(stringResource(R.string.api_capture_no_models))
                            Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                state.models.forEach { model -> CaptureOption(model.label, null, draft.runtime?.model == model.id,
                                    state.editable && !state.catalogLoading) { onEvent(CaptureEvent.Model(model.id)) } }
                            }
                        }
                        CaptureAction(R.string.api_capture_refresh_runtime, state, onEvent, CaptureEvent.ReloadCatalog, state.editable && !state.catalogLoading)
                    }
                }
                Spacer(Modifier.height(20.dp))
            }
            }
        }
    }
}

@Composable
private fun CapturePickerConnectionRow(targetId: String, state: CaptureUiState, onEvent: (CaptureEvent) -> Unit) {
    val colors = LocalRagentColors.current
    val observed = state.connectionObservations[targetId]
    val label = when {
        state.checkingConnectionTargetId == targetId -> R.string.share_connection_checking
        observed == null -> R.string.share_connection_unknown
        targetId in state.staleConnectionTargets -> R.string.share_connection_stale
        else -> connectionStatusLabel(observed.status)
    }
    Column(Modifier.fillMaxWidth().padding(start = 14.dp)) {
        Text(stringResource(label), style = MaterialTheme.typography.bodySmall,
            color = colors.secondaryContent)
        TextButton({ onEvent(CaptureEvent.CheckTargetConnection(targetId)) },
            enabled = state.canCheckConnection(targetId),
            modifier = Modifier.heightIn(min = 48.dp).testTag("capture-connection-check-$targetId"),
            colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
        ) {
            Text(stringResource(R.string.share_connection_check), color = colors.secondaryContent)
        }
    }
}

private fun connectionStatusLabel(status: CaptureConnectionStatus): Int = when (status) {
    CaptureConnectionStatus.AVAILABLE -> R.string.share_connection_available
    CaptureConnectionStatus.UNREACHABLE -> R.string.share_connection_unreachable
    CaptureConnectionStatus.AUTHENTICATION_REQUIRED -> R.string.share_connection_auth
    CaptureConnectionStatus.SERVICE_UNAVAILABLE -> R.string.share_connection_service_unavailable
    CaptureConnectionStatus.UNPAIRED -> R.string.share_connection_unpaired
    CaptureConnectionStatus.UNKNOWN -> R.string.share_connection_inconclusive
}

@Composable
private fun CaptureOption(label: String, subtitle: String?, chosen: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = LocalRagentColors.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(if (chosen) colors.actionPrimary.copy(alpha = 0.09f) else colors.surfaceLow)
        .selectable(selected = chosen, enabled = enabled, role = Role.RadioButton, onClick = onClick)
        .padding(16.dp).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(label, color = if (enabled) colors.primaryContent else colors.disabledContent, style = MaterialTheme.typography.bodyLarge)
            subtitle?.let { Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall) }
        }
        if (chosen) AgentoWebIcon(AgentoWebGlyph.Check, stringResource(R.string.api_capture_selected), Modifier.size(22.dp), colors.accentPrimary)
    }
}

@Composable
private fun CaptureDock(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, compact: Boolean) {
    val colors = LocalRagentColors.current
    val draft = state.draft ?: return
    val hasSubmit = state.operation?.stage !in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED, OperationStage.SUBMITTING)
    Column(Modifier.widthIn(max = RagentSizes.ContentMaxWidth).fillMaxWidth().testTag("capture-dock")
        .padding(horizontal = 20.dp, vertical = if (compact) 4.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.busy) {
            if (!compact) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp), color = colors.accentPrimary, strokeWidth = 2.dp)
                Text(stringResource(when {
                    draft.input.imports.isNotEmpty() -> R.string.api_capture_importing
                    state.uploadProgress != null -> uploadStageLabel(state.uploadProgress)
                    draft.operationId == null && draft.projectCreationOperationId != null -> R.string.share_intake_creating
                    draft.operationId == null && draft.intakeId != null -> R.string.share_intake_resolving
                    else -> R.string.api_capture_waiting
                }),
                    color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
            AgentoButton(stringResource(R.string.api_capture_stop_waiting), { onEvent(CaptureEvent.StopWaiting) }, Modifier.fillMaxWidth(), secondary = true, labelMaxLines = 2)
        } else if (state.canReturnSelection) {
            AgentoButton(stringResource(R.string.api_selection_replace), { onEvent(CaptureEvent.ReturnSelection) }, Modifier.fillMaxWidth(), labelMaxLines = 3)
        } else if (hasSubmit) {
            val intakeStatus = state.intakeObservation?.takeIf {
                state.requiresIntake && draft.operationId == null && it.targetId == draft.targetInstanceId
            }?.status
            if (intakeStatus == CaptureIntakeStatus.UNSUPPORTED || intakeStatus == CaptureIntakeStatus.UNAVAILABLE) {
                Text(stringResource(if (intakeStatus == CaptureIntakeStatus.UNSUPPORTED) R.string.share_intake_upgrade_pc
                    else R.string.share_intake_check_unavailable), color = colors.stateError,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                AgentoButton(stringResource(R.string.share_intake_retry_check), { onEvent(CaptureEvent.RetryIntakeSupport) },
                    Modifier.fillMaxWidth(), enabled = state.editable, secondary = true, labelMaxLines = 2)
            }
            if (!compact && intakeStatus !in setOf(CaptureIntakeStatus.UNSUPPORTED, CaptureIntakeStatus.UNAVAILABLE))
                Text(stringResource(submitHint(state)), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            AgentoButton(stringResource(if (draft.operationId == null) R.string.api_capture_submit else R.string.api_capture_resume),
                { onEvent(CaptureEvent.Submit) }, Modifier.fillMaxWidth().testTag("capture-submit"), enabled = state.canSubmit, decision = !compact,
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.TriangleSend, null, Modifier.size(18.dp)) }, labelMaxLines = 2)
            if (state.supportsBackgroundDelivery && state.selectionMode == CaptureSelectionMode.NONE) {
                if (!compact) Text(stringResource(R.string.api_capture_background_hint), color = colors.secondaryContent,
                    style = MaterialTheme.typography.bodySmall)
                AgentoButton(stringResource(R.string.api_capture_background),
                    { onEvent(CaptureEvent.SubmitInBackground) }, Modifier.fillMaxWidth().testTag("capture-submit-background"),
                    enabled = state.canSubmitInBackground, secondary = true, labelMaxLines = 2)
            }
        }
        if (!compact) Text(stringResource(if (state.dirty) R.string.api_saving else R.string.share_saved), color = colors.secondaryContent,
            style = MaterialTheme.typography.labelSmall)
    }
}

private fun submitHint(state: CaptureUiState): Int = when {
    state.draft?.operationId != null -> R.string.api_capture_frozen
    state.draft?.input?.imports?.isNotEmpty() == true -> R.string.share_resolve_files
    state.draft?.instruction.isNullOrBlank() -> R.string.share_add_instruction
    state.draft?.targetInstanceId == null -> R.string.share_choose_computer
    state.requiresIntake && state.intakeObservation?.targetId == state.draft?.targetInstanceId &&
        state.intakeObservation?.status == CaptureIntakeStatus.CHECKING -> R.string.share_intake_checking
    state.requiresIntake && state.intakeObservation?.targetId == state.draft?.targetInstanceId &&
        state.intakeObservation?.status == CaptureIntakeStatus.UNSUPPORTED -> R.string.share_intake_upgrade_pc
    state.requiresIntake && state.intakeObservation?.targetId == state.draft?.targetInstanceId &&
        state.intakeObservation?.status == CaptureIntakeStatus.UNAVAILABLE -> R.string.share_intake_check_unavailable
    !state.canSubmit -> R.string.share_finish_configuration
    else -> R.string.share_submit_hint
}

@Composable
private fun CaptureReceipt(state: CaptureUiState, onEvent: (CaptureEvent) -> Unit) {
    val colors = LocalRagentColors.current
    val draft = state.draft ?: return
    val operation = state.operation
    val accepted = operation?.stage == OperationStage.ACCEPTED
    CaptureCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CaptureGlyph(if (accepted) AgentoWebGlyph.Check else AgentoWebGlyph.Clock)
            Column(Modifier.weight(1f)) {
                Text(stringResource(R.string.share_task_status), color = colors.secondaryContent, style = MaterialTheme.typography.labelMedium)
                Text(targetLabel(state), color = colors.primaryContent, style = MaterialTheme.typography.titleLarge)
            }
        }
        Text(stringResource(state.uploadProgress?.let(::uploadStageLabel) ?: when (operation?.stage) {
            OperationStage.ACCEPTED -> if (operation.queued) R.string.api_capture_queued else R.string.api_capture_accepted
            OperationStage.SUBMITTING -> R.string.api_capture_unknown
            OperationStage.UPLOADING -> R.string.api_capture_uploading
            OperationStage.CANCELLED -> R.string.api_capture_cancelled
            OperationStage.EXPIRED -> R.string.api_capture_expired
            else -> R.string.api_capture_not_accepted
        }), color = colors.primaryContent, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        state.uploadProgress?.let { CaptureUploadStatus(it) }
        if (operation?.stage in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) {
            CaptureAction(R.string.api_capture_check_receipt, state, onEvent, CaptureEvent.CheckReceipt)
            CaptureAction(R.string.api_capture_check_result, state, onEvent, CaptureEvent.CheckResult)
        }
    }
    operation?.result?.let { result -> CaptureCard { CaptureResult(result) } }
    if (state.selectionMode != CaptureSelectionMode.NONE) CaptureAction(R.string.api_selection_view_saved, state, onEvent, CaptureEvent.ViewSavedTask)
    if (state.selectionMode == CaptureSelectionMode.NONE && accepted) CaptureAction(R.string.api_outputs_title, state, onEvent, CaptureEvent.ViewOutputs)
    var details by rememberSaveable(draft.draftId) { mutableStateOf(false) }
    TextButton(onClick = { details = !details }, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(if (details) R.string.share_hide_details else R.string.share_details), color = colors.secondaryContent) }
    if (details) CaptureCard {
        Text(stringResource(R.string.api_capture_frozen), color = colors.secondaryContent)
        SelectionContainer { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.api_capture_target_identity, draft.targetInstanceId.orEmpty()), color = colors.secondaryContent)
            Text(listOfNotNull(draft.runtime?.tool, draft.runtime?.providerProfile, draft.runtime?.model).joinToString(" · "), color = colors.secondaryContent)
            Text(stringResource(R.string.api_capture_operation_identity, draft.operationId.orEmpty()), color = colors.secondaryContent)
            operation?.sessionId?.let { Text(stringResource(R.string.api_capture_session_identity, it), color = colors.secondaryContent) }
        } }
    }
    CaptureAction(R.string.api_capture_copy, state, onEvent, CaptureEvent.CopyAsNew)
    if (operation != null && operation.stage !in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED)) {
        AgentoButton(stringResource(R.string.api_capture_cancel_submission), { onEvent(CaptureEvent.CancelSubmission) },
            enabled = !state.busy, secondary = true, destructive = true, labelMaxLines = 2)
    }
}

@Composable
private fun CaptureUploadStatus(progress: TaskUploadProgress) {
    val context = LocalContext.current
    val colors = LocalRagentColors.current
    val written = progress.writtenBytes
    Column(Modifier.testTag("capture-upload-progress"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.share_upload_confirmed, progress.confirmedFiles, progress.totalFiles,
            Formatter.formatShortFileSize(context, progress.confirmedBytes), Formatter.formatShortFileSize(context, progress.totalBytes)),
            style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        Text(progress.originalName, color = colors.primaryContent, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(stringResource(when (progress.phase) {
            TaskUploadPhase.CHECKING -> R.string.share_upload_checking
            TaskUploadPhase.PREPARING -> R.string.share_upload_preparing
            TaskUploadPhase.TRANSFERRING -> R.string.share_upload_transferring
            TaskUploadPhase.VERIFYING -> R.string.share_upload_verifying
            TaskUploadPhase.CONFIRMED -> R.string.share_upload_file_ready
        }), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
        if (progress.phase == TaskUploadPhase.TRANSFERRING && written != null) {
            Text(stringResource(R.string.share_upload_written, Formatter.formatShortFileSize(context, written),
                Formatter.formatShortFileSize(context, progress.fileBytes)), color = colors.secondaryContent,
                style = MaterialTheme.typography.bodySmall)
            LinearProgressIndicator(progress = { written.toFloat() / progress.fileBytes }, modifier = Modifier.fillMaxWidth(),
                color = colors.accentPrimary, trackColor = colors.subtleOutline)
        } else LinearProgressIndicator(Modifier.fillMaxWidth(), color = colors.accentPrimary, trackColor = colors.subtleOutline)
        Text(stringResource(R.string.share_upload_task_pending), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
    }
}

private fun uploadStageLabel(progress: TaskUploadProgress) =
    if (progress.confirmedFiles == progress.totalFiles) R.string.share_upload_submitting else R.string.share_upload_active

@Composable
private fun CaptureAction(label: Int, state: CaptureUiState, onEvent: (CaptureEvent) -> Unit, event: CaptureEvent, enabled: Boolean = !state.busy) {
    AgentoButton(stringResource(label), { onEvent(event) }, enabled = enabled, secondary = true, labelMaxLines = 3)
}

@Composable
private fun CaptureNotice(text: String) {
    Text(text, color = LocalRagentColors.current.secondaryContent, style = MaterialTheme.typography.bodySmall)
}

@Composable
internal fun CaptureGlyph(glyph: AgentoWebGlyph) {
    val colors = LocalRagentColors.current
    Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(colors.surfaceHigh), contentAlignment = Alignment.Center) {
        AgentoWebIcon(glyph, null, Modifier.size(20.dp), colors.secondaryContent)
    }
}

@Composable
private fun CaptureLoading() {
    val colors = LocalRagentColors.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.accentPrimary)
        Text(stringResource(R.string.api_loading), color = colors.secondaryContent)
    }
}

@Composable
internal fun captureMaterialCount(count: Int): String = androidx.compose.ui.res.pluralStringResource(R.plurals.share_material_count, count, count)
