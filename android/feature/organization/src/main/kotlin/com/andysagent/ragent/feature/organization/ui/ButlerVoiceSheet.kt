package com.andysagent.ragent.feature.organization.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.VoiceAdapterDescriptorDto
import com.andysagent.ragent.feature.organization.data.VoiceApprovalCardDto
import com.andysagent.ragent.feature.organization.data.VoiceHandoffDto
import com.andysagent.ragent.feature.organization.data.VoiceSessionDto
import com.andysagent.ragent.feature.organization.data.VoiceTurnDto
import com.andysagent.ragent.feature.organization.presentation.ButlerUiState
import com.andysagent.ragent.feature.organization.presentation.ButlerVoicePhase

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ButlerVoiceSheet(
    uiState: ButlerUiState,
    onDismiss: () -> Unit,
    onMicOrBargeIn: () -> Unit,
    onInterruptSpeaking: () -> Unit,
    onToggleContinuousMode: (Boolean) -> Unit,
    onDraftTextChange: (String) -> Unit,
    onSubmitTextTurn: (String) -> Unit,
    onRefreshSession: () -> Unit,
    onStartNewSession: () -> Unit,
    onResumeSession: (String) -> Unit,
    onRequestHandoff: (targetDeviceId: String, targetDeviceType: String, targetDeviceLabel: String?) -> Unit,
    onSelectAdapters: (asrId: String?, reasonerId: String?, ttsId: String?) -> Unit,
    onOpenApprovalCard: (VoiceApprovalCardDto) -> Unit,
) {
    val context = LocalContext.current
    val colors = LocalRagentColors.current
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val listState = rememberLazyListState()

    var showSessionsPicker by remember { mutableStateOf(false) }
    var showHandoffPanel by remember { mutableStateOf(false) }
    var showEnginesPanel by remember { mutableStateOf(false) }
    var handoffDeviceId by remember { mutableStateOf("desktop-primary") }
    var handoffDeviceType by remember { mutableStateOf("desktop") }
    var handoffDeviceLabel by remember { mutableStateOf("Desktop Workstation") }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            onMicOrBargeIn()
        }
    }

    fun triggerVoiceCaptureOrBargeIn() {
        val isSpeaking = uiState.voicePhase == ButlerVoicePhase.SPEAKING
        val isListening = uiState.voicePhase == ButlerVoicePhase.LISTENING
        if (isSpeaking || isListening) {
            onMicOrBargeIn()
            return
        }
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) {
            onMicOrBargeIn()
        } else {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    LaunchedEffect(uiState.turns.size) {
        if (uiState.turns.isNotEmpty()) {
            listState.animateScrollToItem(uiState.turns.size - 1)
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.canvas,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.9f)
                .padding(horizontal = 16.dp)
                .testTag("butler-voice-sheet"),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.butler_voice_title),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.primaryContent,
                    )
                    Text(
                        text = uiState.boundResponsibilityTitle?.takeIf { it.isNotBlank() }
                            ?: uiState.boundResponsibilityId?.let { "Responsibility $it" }
                            ?: "All responsibilities",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.secondaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    AgentoIconButton(
                        onClick = onRefreshSession,
                        contentDescription = stringResource(R.string.butler_voice_sync),
                    ) {
                        Icon(Icons.Rounded.Refresh, contentDescription = null)
                    }
                    AgentoIconButton(
                        onClick = onDismiss,
                        contentDescription = stringResource(R.string.butler_approval_cancel),
                    ) {
                        Icon(Icons.Rounded.Close, contentDescription = null)
                    }
                }
            }

            // Session Continuity & Device Action Strip
            uiState.voiceSession?.let { session ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceSmallShape)
                        .background(colors.quietSurface)
                        .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceSmallShape)
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "Session ${session.id.take(12)} · turn #${session.turnSeq} · gen ${session.playbackGeneration}",
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = colors.primaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = session.activeDeviceLabel
                                ?: session.activeDeviceType
                                ?: "android",
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.actionPrimary,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        FilterChip(
                            selected = showHandoffPanel,
                            onClick = { showHandoffPanel = !showHandoffPanel },
                            leadingIcon = { Icon(Icons.Rounded.Devices, contentDescription = null, modifier = Modifier.size(16.dp)) },
                            label = { Text(stringResource(R.string.butler_voice_handoff)) },
                        )
                        FilterChip(
                            selected = showSessionsPicker,
                            onClick = { showSessionsPicker = !showSessionsPicker },
                            leadingIcon = { Icon(Icons.Rounded.Sync, contentDescription = null, modifier = Modifier.size(16.dp)) },
                            label = { Text("${stringResource(R.string.butler_voice_sessions)} (${uiState.availableSessions.size})") },
                        )
                        FilterChip(
                            selected = showEnginesPanel,
                            onClick = { showEnginesPanel = !showEnginesPanel },
                            leadingIcon = { Icon(Icons.Rounded.Tune, contentDescription = null, modifier = Modifier.size(16.dp)) },
                            label = { Text(stringResource(R.string.butler_voice_engines)) },
                        )
                        TextButton(onClick = onStartNewSession) {
                            Text("New Session")
                        }
                    }
                }
            }

            if (showHandoffPanel && uiState.voiceSession != null) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceSmallShape)
                        .background(colors.surfaceLow)
                        .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceSmallShape)
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "Cross-Device Continuity Handoff",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.primaryContent,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("desktop", "web", "android").forEach { kind ->
                            FilterChip(
                                selected = handoffDeviceType == kind,
                                onClick = {
                                    handoffDeviceType = kind
                                    if (handoffDeviceId.isBlank() || handoffDeviceId.endsWith("-primary")) {
                                        handoffDeviceId = "$kind-primary"
                                    }
                                    handoffDeviceLabel = when (kind) {
                                        "desktop" -> "Desktop Workstation"
                                        "web" -> "Web Browser"
                                        else -> "Android Device"
                                    }
                                },
                                label = { Text(kind) },
                            )
                        }
                    }
                    OutlinedTextField(
                        value = handoffDeviceId,
                        onValueChange = { handoffDeviceId = it },
                        label = { Text("Target device ID") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = handoffDeviceLabel,
                        onValueChange = { handoffDeviceLabel = it },
                        label = { Text("Target device label") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    AgentoButton(
                        text = "Sync & Handoff Now",
                        onClick = {
                            onRequestHandoff(handoffDeviceId, handoffDeviceType, handoffDeviceLabel)
                            showHandoffPanel = false
                        },
                        enabled = handoffDeviceId.isNotBlank(),
                        modifier = Modifier.fillMaxWidth().testTag("butler-handoff-submit"),
                    )
                }
            }

            if (showSessionsPicker) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceSmallShape)
                        .background(colors.surfaceLow)
                        .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceSmallShape)
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "Resume Cross-Device Session",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    if (uiState.availableSessions.isEmpty()) {
                        Text("No other saved voice sessions.", style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                    } else {
                        uiState.availableSessions.take(6).forEach { candidate ->
                            SessionResumeRow(
                                session = candidate,
                                isActive = candidate.id == uiState.voiceSession?.id,
                                onClick = {
                                    onResumeSession(candidate.id)
                                    showSessionsPicker = false
                                },
                            )
                        }
                    }
                }
            }

            if (showEnginesPanel) {
                AdapterSelectionPanel(
                    asrAdapters = uiState.adapters?.asr.orEmpty(),
                    reasonerAdapters = uiState.adapters?.reasoner.orEmpty(),
                    ttsAdapters = uiState.adapters?.tts.orEmpty(),
                    selectedAsr = uiState.selectedAsrEngineId,
                    selectedReasoner = uiState.selectedReasonerEngineId,
                    selectedTts = uiState.selectedTtsEngineId,
                    onSelect = onSelectAdapters,
                )
            }

            uiState.handoffNotice?.let { notice ->
                VoiceBannerCard(text = notice, accent = colors.actionPrimary)
            }

            // Live Phase & Safety Banners
            VoicePhaseStatusCard(
                phase = uiState.voicePhase,
                rmsLevel = uiState.rmsLevel,
                playbackGeneration = uiState.voiceSession?.playbackGeneration ?: 0L,
                bargeInCount = uiState.bargeInCount,
                onBargeIn = { triggerVoiceCaptureOrBargeIn() },
            )

            val safetyPrompt = uiState.asrErrorBanner ?: uiState.clarificationPrompt
            if (!safetyPrompt.isNullOrBlank()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceSmallShape)
                        .background(colors.error.copy(alpha = 0.12f))
                        .border(0.75.dp, colors.error.copy(alpha = 0.35f), AgentoShapes.SurfaceSmallShape)
                        .padding(12.dp)
                        .testTag("butler-asr-retry-banner"),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Rounded.WarningAmber, contentDescription = null, tint = colors.error, modifier = Modifier.size(18.dp))
                        Text(
                            text = safetyPrompt,
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.primaryContent,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                    Text(
                        text = stringResource(R.string.butler_voice_no_write_on_asr_error),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.secondaryContent,
                    )
                    AgentoButton(
                        text = stringResource(R.string.butler_voice_retry),
                        onClick = { triggerVoiceCaptureOrBargeIn() },
                        secondary = true,
                    )
                }
            }

            uiState.voiceError?.takeIf { it.isNotBlank() }?.let { err ->
                VoiceBannerCard(text = err, accent = colors.error)
            }

            // Turns + Handoffs Timeline
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (uiState.turns.isEmpty() && uiState.handoffs.isEmpty()) {
                    item("voice-empty") {
                        Text(
                            text = "Ask about responsibility progress, blockers, recent deliverables, or request an approval draft.",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.secondaryContent,
                            modifier = Modifier.padding(vertical = 12.dp),
                        )
                    }
                }
                items(uiState.turns, key = { it.id.ifBlank { "seq:${it.turnSeq}" } }) { turn ->
                    VoiceTurnCard(
                        turn = turn,
                        onOpenApproval = { card -> onOpenApprovalCard(card) },
                    )
                }
                if (uiState.handoffs.isNotEmpty()) {
                    item("handoff-history-header") {
                        HorizontalDivider(color = colors.subtleOutline)
                    }
                    items(uiState.handoffs, key = { "handoff:${it.id}" }) { handoff ->
                        HandoffEventPill(handoff)
                    }
                }
            }

            HorizontalDivider(color = colors.subtleOutline)

            // Continuous mode toggle & primary controls
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = stringResource(R.string.butler_voice_continuous),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.primaryContent,
                )
                Switch(
                    checked = uiState.continuousMode,
                    onCheckedChange = onToggleContinuousMode,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val isSpeaking = uiState.voicePhase == ButlerVoicePhase.SPEAKING
                val isListening = uiState.voicePhase == ButlerVoicePhase.LISTENING
                val micLabel = when {
                    isSpeaking -> stringResource(R.string.butler_voice_barge_in)
                    isListening -> stringResource(R.string.butler_voice_listening)
                    uiState.voicePhase == ButlerVoicePhase.ASR_ERROR -> stringResource(R.string.butler_voice_retry)
                    else -> stringResource(R.string.butler_voice_speak)
                }
                AgentoButton(
                    text = micLabel,
                    onClick = { triggerVoiceCaptureOrBargeIn() },
                    enabled = uiState.voicePhase != ButlerVoicePhase.THINKING &&
                        uiState.voicePhase != ButlerVoicePhase.CREATING_SESSION &&
                        uiState.pendingApprovalCard == null,
                    destructive = isListening,
                    leadingIcon = {
                        Icon(
                            imageVector = when {
                                isSpeaking -> Icons.Rounded.GraphicEq
                                isListening -> Icons.Rounded.MicOff
                                else -> Icons.Rounded.Mic
                            },
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    },
                    modifier = Modifier
                        .weight(1f)
                        .testTag("butler-voice-mic-button"),
                )
                if (isSpeaking) {
                    AgentoButton(
                        text = stringResource(R.string.butler_voice_stop_tts),
                        onClick = onInterruptSpeaking,
                        secondary = true,
                        leadingIcon = {
                            Icon(Icons.Rounded.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                        },
                        modifier = Modifier.testTag("butler-voice-stop-tts-button"),
                    )
                }
            }

            // Text fallback inside same continuous voiceSessionId
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = uiState.draftText,
                    onValueChange = onDraftTextChange,
                    placeholder = { Text("Or type a follow-up in this voice session…") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                AgentoIconButton(
                    onClick = {
                        val trimmed = uiState.draftText.trim()
                        if (trimmed.isNotEmpty()) {
                            onSubmitTextTurn(trimmed)
                        }
                    },
                    enabled = uiState.draftText.isNotBlank() && uiState.pendingApprovalCard == null,
                    contentDescription = "Send",
                ) {
                    Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = null)
                }
            }
        }
    }
}

@Composable
private fun VoicePhaseStatusCard(
    phase: ButlerVoicePhase,
    rmsLevel: Float,
    playbackGeneration: Long,
    bargeInCount: Int,
    onBargeIn: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val (label, accent) = when (phase) {
        ButlerVoicePhase.IDLE -> "Ready" to colors.secondaryContent
        ButlerVoicePhase.CREATING_SESSION -> "Connecting voice session…" to colors.actionPrimary
        ButlerVoicePhase.LISTENING -> stringResource(R.string.butler_voice_listening) to colors.running
        ButlerVoicePhase.THINKING -> stringResource(R.string.butler_voice_thinking) to colors.actionPrimary
        ButlerVoicePhase.SPEAKING -> stringResource(R.string.butler_voice_speaking, playbackGeneration) to colors.success
        ButlerVoicePhase.INTERRUPTED -> stringResource(R.string.butler_voice_interrupted) to colors.waiting
        ButlerVoicePhase.ASR_ERROR -> "ASR did not capture cleanly" to colors.error
        ButlerVoicePhase.AWAITING_APPROVAL -> stringResource(R.string.butler_approval_title) to colors.error
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(accent.copy(alpha = 0.10f))
            .border(0.75.dp, accent.copy(alpha = 0.30f), AgentoShapes.SurfaceSmallShape)
            .then(if (phase == ButlerVoicePhase.SPEAKING) Modifier.clickable(onClick = onBargeIn) else Modifier)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = accent,
            )
            if (bargeInCount > 0) {
                Text(
                    text = "Barge-ins: $bargeInCount",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.secondaryContent,
                )
            }
        }
        if (phase == ButlerVoicePhase.LISTENING) {
            LinearProgressIndicator(
                progress = { rmsLevel.coerceIn(0.08f, 1f) },
                modifier = Modifier.fillMaxWidth().height(4.dp),
            )
        } else if (phase == ButlerVoicePhase.THINKING || phase == ButlerVoicePhase.CREATING_SESSION) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth().height(3.dp))
        }
    }
}

@Composable
private fun VoiceTurnCard(
    turn: VoiceTurnDto,
    onOpenApproval: (VoiceApprovalCardDto) -> Unit,
) {
    val colors = LocalRagentColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceMediumShape)
            .background(colors.surfaceLow)
            .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceMediumShape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = "#${turn.turnSeq} · ${turn.deviceLabel ?: turn.deviceType ?: "device"}",
                style = MaterialTheme.typography.labelSmall,
                color = colors.secondaryContent,
            )
            val conf = turn.resolvedConfidence?.let { "${(it * 100).toInt()}%" }
            val meta = listOfNotNull(conf, turn.resolvedAsrStatus, turn.status.takeIf { it.isNotBlank() }).joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(
                    text = meta,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.secondaryContent,
                )
            }
        }
        turn.transcript?.takeIf { it.isNotBlank() }?.let { transcript ->
            Text(
                text = "You: $transcript",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = colors.primaryContent,
            )
        }
        turn.responseText?.takeIf { it.isNotBlank() }?.let { reply ->
            Text(
                text = "Butler: $reply",
                style = MaterialTheme.typography.bodySmall,
                color = colors.primaryContent,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            turn.resolvedSafetyDecision?.takeIf { it.isNotBlank() }?.let { safety ->
                Text(
                    text = safety,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (safety == "visual_approval_required") colors.error else colors.secondaryContent,
                    fontFamily = FontFamily.Monospace,
                )
            }
            if (turn.isInterrupted) {
                Text(
                    text = "interrupted",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.waiting,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        turn.approvalCard?.let { card ->
            AgentoButton(
                text = stringResource(R.string.butler_review_approve),
                onClick = { onOpenApproval(card) },
                secondary = true,
            )
        }
    }
}

@Composable
private fun HandoffEventPill(handoff: VoiceHandoffDto) {
    val colors = LocalRagentColors.current
    Text(
        text = "Handoff @ turn #${handoff.resolvedTurnSeq}: ${handoff.fromDeviceLabel ?: handoff.fromDeviceType ?: "?"} -> ${handoff.toDeviceLabel ?: handoff.toDeviceType ?: handoff.toDeviceId ?: "?"}",
        style = MaterialTheme.typography.labelSmall,
        color = colors.actionPrimary,
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.PillShape)
            .background(colors.actionPrimary.copy(alpha = 0.1f))
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

@Composable
private fun SessionResumeRow(
    session: VoiceSessionDto,
    isActive: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(if (isActive) colors.actionPrimary.copy(alpha = 0.14f) else colors.quietSurface)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                text = "${session.id.take(10)} · ${session.activeDeviceLabel ?: session.activeDeviceType ?: "device"}",
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = colors.primaryContent,
            )
            Text(
                text = "turns ${session.turnSeq} · state ${session.state}",
                style = MaterialTheme.typography.labelSmall,
                color = colors.secondaryContent,
            )
        }
        if (isActive) {
            Text("Active", style = MaterialTheme.typography.labelSmall, color = colors.actionPrimary)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdapterSelectionPanel(
    asrAdapters: List<VoiceAdapterDescriptorDto>,
    reasonerAdapters: List<VoiceAdapterDescriptorDto>,
    ttsAdapters: List<VoiceAdapterDescriptorDto>,
    selectedAsr: String?,
    selectedReasoner: String?,
    selectedTts: String?,
    onSelect: (asrId: String?, reasonerId: String?, ttsId: String?) -> Unit,
) {
    val colors = LocalRagentColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(colors.surfaceLow)
            .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceSmallShape)
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (asrAdapters.isNotEmpty()) {
            Text("ASR Engine", style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                asrAdapters.forEach { adapter ->
                    FilterChip(
                        selected = selectedAsr == adapter.id,
                        onClick = { onSelect(adapter.id, null, null) },
                        label = { Text(adapter.displayLabel) },
                    )
                }
            }
        }
        if (reasonerAdapters.isNotEmpty()) {
            Text("Reasoner", style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                reasonerAdapters.forEach { adapter ->
                    FilterChip(
                        selected = selectedReasoner == adapter.id,
                        onClick = { onSelect(null, adapter.id, null) },
                        label = { Text(adapter.displayLabel) },
                    )
                }
            }
        }
        if (ttsAdapters.isNotEmpty()) {
            Text("TTS Engine", style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ttsAdapters.forEach { adapter ->
                    FilterChip(
                        selected = selectedTts == adapter.id,
                        onClick = { onSelect(null, null, adapter.id) },
                        label = { Text(adapter.displayLabel) },
                    )
                }
            }
        }
    }
}

@Composable
private fun VoiceBannerCard(text: String, accent: Color) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(accent.copy(alpha = 0.12f))
            .border(0.75.dp, accent.copy(alpha = 0.35f), AgentoShapes.SurfaceSmallShape)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = LocalRagentColors.current.primaryContent)
    }
}
