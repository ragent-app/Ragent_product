package com.andysagent.agentoc.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.agentui.AgentMarkdown
import com.andysagent.agentoc.core.agentui.AgentMessageActionBar
import com.andysagent.agentoc.core.agentui.AgentStreamingMessage
import com.andysagent.agentoc.core.agentui.ClassicForkIcon
import com.andysagent.agentoc.core.agentui.FinalizedMarkdownMessage
import com.andysagent.agentoc.core.agentui.R as AgentUiR
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.AgentoBackdropTone
import com.andysagent.agentoc.core.designsystem.agentoComposerShadow
import com.andysagent.agentoc.core.designsystem.AgentoColors
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenu
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenuItem
import com.andysagent.agentoc.core.designsystem.AgentoMotion
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.agentoc.core.domain.FileUploadPhase
import com.andysagent.agentoc.core.timeline.FileChangeItem
import com.andysagent.agentoc.core.timeline.PlanStepItem
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import kotlinx.coroutines.flow.collectLatest

/**
 * Renders a full turn in the Task Canvas (Layer B).
 */
internal fun canShowMessageActions(runStatus: com.andysagent.agentoc.core.agentui.AgentRunStatus, historyTransitioning: Boolean, pendingTurn: PendingTurnUiState?, hasAcceptedTurn: Boolean = false): Boolean =
    !historyTransitioning && !hasAcceptedTurn && pendingTurn?.state != PendingTurnState.Sending &&
        runStatus != com.andysagent.agentoc.core.agentui.AgentRunStatus.Working &&
        runStatus != com.andysagent.agentoc.core.agentui.AgentRunStatus.WaitingApproval

@Composable
fun TurnTimelineView(
    turn: TurnGroup,
    isLastTurn: Boolean,
    onBranch: ((Long, String) -> Unit)?,
    onRestart: ((String) -> Unit)?,
    onEditResend: (String) -> Unit,
    onPlanAction: (String, String) -> Unit,
    onRetryPendingTurn: () -> Unit,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    modifier: Modifier = Modifier,
    onReport: ((String) -> Unit)? = null,
    showMessageActions: Boolean = true,
    runDuration: (@Composable () -> Unit)? = null,
    runActive: Boolean = false,
    runWaitingApproval: Boolean = false,
    activeAction: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // 1. User Prompt Block
        turn.userPrompt?.let { prompt ->
            UserPromptBlock(
                prompt = prompt,
                onBranch = onBranch?.takeIf { prompt.seq > 0L }?.let { branch -> { branch(prompt.seq, "user-continue") } },
                onEditResend = { onEditResend(prompt.text) },
                onRetry = onRetryPendingTurn,
                showMessageActions = showMessageActions,
            )
        }

        if (turn.entries.isNotEmpty() || runActive) {
            val (beforeFinal, finalEntries) = splitTurnEntries(turn.entries,
                allowTerminalFallback = !runActive && turn.agentMessages.none { !it.completed })
            // While a reply is being generated, render the ordered stream in
            // the process area. Legacy terminal transcripts may lack a phase;
            // only a completed reply at the end can be treated as final.
            val hasFinal = turn.entries.any { it is TimelineItem.Message && it.messagePhase == "final_answer" }
            val processEntries = if (runActive && !hasFinal) turn.entries else beforeFinal
            val outsideEntries = if (runActive && !hasFinal) emptyList() else finalEntries
            var expanded by rememberSaveable(turn.requestId ?: turn.id) { mutableStateOf(runActive) }
            var userToggled by rememberSaveable(turn.requestId ?: turn.id) { mutableStateOf(false) }
            LaunchedEffect(runActive) { if (!runActive && !userToggled) expanded = false }
            val toggleDescription = stringResource(if (expanded) R.string.timeline_details_hide else R.string.timeline_details_show)
            val renderEntry: @Composable (TimelineItem) -> Unit = { item -> key(item.id) {
                when (item) {
                    is TimelineItem.Message -> {
                        ResultBlock(item,
                            isLastTurn && item.id == turn.agentMessages.lastOrNull { it.completed }?.id,
                            onBranch?.takeIf { item.lastEventSeq > 0L }?.let { branch -> { branch(item.lastEventSeq, "assistant-continue") } },
                            item.requestId?.let { request -> onRestart?.let { restart -> { restart(request) } } },
                            onReport = onReport?.let { report -> { report(item.text) } },
                            showMessageActions = showMessageActions,
                            pauseStreaming = runWaitingApproval)
                    }
                    is TimelineItem.Plan -> PlanBlock(item, onPlanAction)
                    is TimelineItem.Operation -> {
                        if (item.isReasoning) ThinkingRow(item) else ProcessOperationRow(item)
                    }
                    is TimelineItem.Notice -> if (item.text.isNotBlank()) Text(item.text)
                }
            } }
            if (processEntries.isNotEmpty() || runActive || runDuration != null) {
                val canExpand = processEntries.isNotEmpty() || activeAction != null
                Row(Modifier.fillMaxWidth().heightIn(min = 36.dp)
                    .clickable(enabled = canExpand) { expanded = !expanded; userToggled = true }
                    .testTag("turn-process-toggle")
                    .semantics { contentDescription = toggleDescription },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (runDuration != null) runDuration() else Text(stringResource(R.string.timeline_process),
                        style = MaterialTheme.typography.labelSmall, color = LocalAgentocColors.current.secondaryContent)
                    if (canExpand) AgentoWebIcon(if (expanded) AgentoWebGlyph.ChevronDown else AgentoWebGlyph.ChevronRight,
                        null, Modifier.size(14.dp), tint = LocalAgentocColors.current.secondaryContent)
                }
                AnimatedVisibility(expanded) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        processEntries.forEach { renderEntry(it) }
                        activeAction?.invoke()
                    }
                }
            }
            outsideEntries.forEach { renderEntry(it) }
            return@Column
        }

        // 2. Agent Progress / Thought Summary (during active work)
        turn.agentSummary?.takeIf { it.isNotBlank() }?.let { summary ->
            AgentProgressBlock(summaryText = summary)
        }

        // 3. Plan & Steps (Collapsible)
        turn.plans.forEach { plan ->
            PlanBlock(
                plan = plan,
                onPlanAction = onPlanAction,
            )
        }

        // Thinking remains available; tool-call records are omitted from chat.
        turn.operationSummary?.operations?.filter { it.isReasoning }?.forEach { ThinkingRow(it) }

        // 6. Keep every distinct assistant message, including progress before
        // a final reply. Only an update to the same entity replaces its text.
        val answers = turn.agentMessages.ifEmpty { listOfNotNull(turn.finalAnswer ?: turn.streamingAnswer) }
            .map { it.copy(text = displayAgentMessageText(it.text)) }.filter { it.text.isNotBlank() }
        val latestCompleted = answers.indexOfLast { it.completed }
        answers.forEachIndexed { index, message ->
            key(message.id) {
                run {
                    ResultBlock(
                        message = message,
                        isLastTurn = isLastTurn && index == latestCompleted,
                        onBranch = onBranch?.takeIf { message.lastEventSeq > 0L }?.let { branch -> { branch(message.lastEventSeq, "assistant-continue") } },
                        onRestart = turn.requestId?.let { reqId -> onRestart?.let { restart -> { restart(reqId) } } },
                        onReport = onReport?.let { report -> { report(message.text) } },
                        showMessageActions = showMessageActions,
                        pauseStreaming = runWaitingApproval,
                    )
                }
            }
        }
    }
}

@Composable
private fun ProcessOperationRow(operation: TimelineItem.Operation) {
    val state = com.andysagent.agentoc.core.timeline.RunActionFormatter.forOperation(operation)
    val text = state.let {
        when (operation.status) {
            TimelineOperationStatus.Completed -> presentCompletedAction(it)
            TimelineOperationStatus.Failed -> presentFailedAction(it)
            else -> presentRunAction(it)
        }
    }
    Text(text, style = MaterialTheme.typography.bodySmall,
        color = LocalAgentocColors.current.secondaryContent, modifier = Modifier.testTag("process-operation"))
}

/**
 * UserPromptBlock: Right-aligned, max width ~82%, 18dp corner radius.
 * Actions (Copy, Edit, Branch) accessible via long-press menu.
 */
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun UserPromptBlock(
    prompt: TurnUserPrompt,
    onBranch: (() -> Unit)?,
    onEditResend: () -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    showMessageActions: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val bubbleColor = if (isDark) AgentoColors.SurfaceLevel1 else colors.surfaceHigh
    val clipboardManager = LocalClipboardManager.current
    var menuExpanded by remember { mutableStateOf(false) }

    var isExpanded by rememberSaveable(prompt.id) { mutableStateOf(false) }
    val collapsedHeightPx = with(LocalDensity.current) { 160.dp.roundToPx() }

    BoxWithConstraints(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.CenterEnd,
    ) {
        val maxBubbleWidth = (maxWidth * 0.85f).coerceAtMost(520.dp)
        var isClipped by remember(prompt.id, prompt.text, maxBubbleWidth, collapsedHeightPx) { mutableStateOf(false) }

        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // Attachment preview pills if attached to user message
            if (prompt.attachments.isNotEmpty()) {
                FlowRow(
                    modifier = Modifier.widthIn(max = maxBubbleWidth).fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    prompt.attachments.forEach { attachment ->
                        AttachmentThumbnailCard(attachment = attachment, onRemove = null)
                    }
                }
            }

            if (prompt.isSending && prompt.attachments.isNotEmpty()) {
                val progress = prompt.attachmentUploadProgress
                val hasTransferProgress = progress != null && progress.phase in setOf(
                    FileUploadPhase.TRANSFERRING,
                    FileUploadPhase.VERIFYING,
                    FileUploadPhase.CONFIRMED,
                )
                Text(
                    text = if (hasTransferProgress) {
                        stringResource(
                            R.string.workbench_upload_progress,
                            ((progress!!.fraction * 100f).toInt()).coerceIn(0, 100),
                        )
                    } else stringResource(R.string.workbench_upload_preparing),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.secondaryContent,
                )
            }

            Box {
                Surface(
                    modifier = Modifier
                        .widthIn(min = 48.dp, max = maxBubbleWidth)
                        .width(IntrinsicSize.Max)
                        .testTag("user-message-bubble-${prompt.id}")
                        .clip(AgentoShapes.UserBubble)
                        .agentoPressScale(pressedScale = 0.985f, onClick = {},
                            onLongClick = if (showMessageActions) ({ menuExpanded = true }) else null),
                    shape = AgentoShapes.UserBubble,
                    color = bubbleColor,
                    contentColor = colors.primaryContent,
                    shadowElevation = 0.dp,
                ) {
                    Column(
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(
                                    if (!isExpanded) {
                                        Modifier.heightIn(max = 160.dp).clip(RoundedCornerShape(4.dp))
                                    } else Modifier
                                ),
                        ) {
                            AgentMarkdown(
                                markdown = prompt.text,
                                isStreaming = false,
                                modifier = Modifier.fillMaxWidth().onSizeChanged { size ->
                                    if (!isExpanded) isClipped = size.height >= collapsedHeightPx
                                },
                            )
                            if (!isExpanded && isClipped) {
                                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(28.dp)
                                    .background(Brush.verticalGradient(listOf(Color.Transparent, bubbleColor))))
                            }
                        }

                        if (isClipped || isExpanded) {
                            Row(
                                modifier = Modifier
                                    .clickable { isExpanded = !isExpanded }
                                    .padding(vertical = 2.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    text = stringResource(if (isExpanded) AgentUiR.string.agentui_collapse else AgentUiR.string.agentui_expand),
                                    style = MaterialTheme.typography.labelMedium.copy(
                                        fontWeight = FontWeight.SemiBold,
                                        color = colors.secondaryContent,
                                    ),
                                )
                                AgentoWebIcon(
                                    glyph = AgentoWebGlyph.ChevronDown,
                                    contentDescription = null,
                                    modifier = Modifier
                                        .size(12.dp)
                                        .rotate(if (isExpanded) 180f else 0f),
                                    tint = colors.secondaryContent,
                                )
                            }
                        }
                    }
                }

                // Long-press context dropdown
                AgentoDropdownMenu(
                    expanded = menuExpanded && showMessageActions,
                    onDismissRequest = { menuExpanded = false },
                    opaqueFallback = true,
                ) {
                    AgentoDropdownMenuItem(
                        text = stringResource(AgentUiR.string.agentui_copy),
                        onClick = {
                            menuExpanded = false
                            clipboardManager.setText(AnnotatedString(prompt.text))
                        },
                        leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Copy, null) },
                    )
                    if (onBranch != null) AgentoDropdownMenuItem(
                        text = stringResource(AgentUiR.string.agentui_branch),
                        onClick = { menuExpanded = false; onBranch() },
                        leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Fork, null, modifier = Modifier.size(16.dp)) },
                    )
                    AgentoDropdownMenuItem(
                        text = stringResource(AgentUiR.string.agentui_edit_and_resend),
                        onClick = {
                            menuExpanded = false
                            onEditResend()
                        },
                        leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Edit, null) },
                    )
                }
            }

            // Pending failed state hint
            if (prompt.pendingFailed) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = prompt.pendingError ?: stringResource(R.string.timeline_send_failed),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.error,
                        textAlign = TextAlign.End,
                    )
                    AgentoButton(
                        text = stringResource(R.string.timeline_retry),
                        onClick = onRetry,
                        secondary = true,
                    )
                }
            }
        }
    }
}

/**
 * AgentProgressBlock: Direct on canvas, quiet narration.
 */
@Composable
fun AgentProgressBlock(
    summaryText: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = summaryText,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 13.5.sp,
                lineHeight = 18.sp,
            ),
            color = colors.secondaryContent,
        )
    }
}

@Composable
internal fun ThinkingRow(operation: TimelineItem.Operation) {
    val colors = LocalAgentocColors.current
    val hasDetail = operation.detail.isNotBlank()
    val active = operation.status == TimelineOperationStatus.InProgress || operation.status == TimelineOperationStatus.Pending
    var expanded by rememberSaveable(operation.id) { mutableStateOf(active && hasDetail) }
    val scrollState = rememberScrollState()
    LaunchedEffect(operation.id, active, hasDetail) {
        expanded = active && hasDetail
    }
    LaunchedEffect(operation.id, active, expanded) {
        if (active && expanded) snapshotFlow { scrollState.maxValue }.collectLatest { max ->
            scrollState.animateScrollTo(max)
        }
    }
    val toggleLabel = stringResource(if (expanded) R.string.timeline_details_hide else R.string.timeline_details_show)
    Column(Modifier.fillMaxWidth().testTag("thinking-row")) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp)
                .clickable(enabled = hasDetail) { expanded = !expanded }
                .semantics { contentDescription = toggleLabel }
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(stringResource(R.string.timeline_thinking), style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryContent, maxLines = 1)
            if (hasDetail) AgentoWebIcon(if (expanded) AgentoWebGlyph.ChevronDown else AgentoWebGlyph.ChevronRight, null,
                modifier = Modifier.size(14.dp), tint = colors.secondaryContent)
        }
        AnimatedVisibility(expanded && hasDetail) {
            SelectionContainer(Modifier.heightIn(max = 220.dp).verticalScroll(scrollState).testTag("thinking-content")) {
                Text(operation.detail, modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
                    style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
            }
        }
    }
}

/**
 * OperationGroup: Focus Block discipline.
 * Default shows only a 1-line running summary. Tap to expand into details.
 */
@Composable
fun OperationGroup(
    summary: TurnOperationSummary,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var expanded by rememberSaveable { mutableStateOf(false) }
    val toggleLabel = stringResource(if (expanded) R.string.timeline_details_hide else R.string.timeline_details_show)
    val summaryStatus = when {
        summary.failedCount > 0 -> stringResource(R.string.timeline_failed)
        summary.isWorking -> stringResource(R.string.timeline_running)
        else -> null
    }
    val primaryKind = summary.operations.firstOrNull()?.kind
    val glyph = when (primaryKind) {
        com.andysagent.agentoc.core.timeline.TimelineOperationKind.Command -> AgentoWebGlyph.Terminal
        com.andysagent.agentoc.core.timeline.TimelineOperationKind.FileEdit -> AgentoWebGlyph.Folder
        com.andysagent.agentoc.core.timeline.TimelineOperationKind.SubAgent -> AgentoWebGlyph.Agent
        com.andysagent.agentoc.core.timeline.TimelineOperationKind.Tool -> AgentoWebGlyph.Settings
        else -> AgentoWebGlyph.File
    }
    AgentoFrostedGlassBox(
        modifier = modifier.fillMaxWidth().agentoComposerShadow(RoundedCornerShape(16.dp)),
        shape = RoundedCornerShape(16.dp),
        surface = AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        material = AgentoGlassMaterial.LiquidClear,
        backdropTone = AgentoBackdropTone.QuietHeader,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = true,
        hasShadow = false,
    ) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .agentoPressScale(pressedScale = 0.985f, onClick = { expanded = !expanded })
                    .testTag("operation-toggle")
                    .semantics { contentDescription = listOfNotNull(summary.summaryText, summaryStatus, toggleLabel).joinToString(", ") }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                AgentoWebIcon(glyph, null, modifier = Modifier.size(17.dp),
                    tint = if (summary.isWorking) colors.accentPrimary else colors.secondaryContent)
                Text(summary.summaryText, modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelLarge.copy(fontSize = 13.sp, fontWeight = FontWeight.Medium),
                    color = colors.primaryContent, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (summary.failedCount > 0) {
                    Text(stringResource(R.string.timeline_failed), color = colors.error,
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium), maxLines = 1)
                }
                AgentoWebIcon(AgentoWebGlyph.ChevronDown, null,
                    modifier = Modifier.size(15.dp).rotate(if (expanded) 180f else 0f), tint = colors.secondaryContent)
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(spring(dampingRatio = 0.88f), expandFrom = Alignment.Top) + fadeIn(),
                exit = shrinkVertically(spring(dampingRatio = 0.88f), shrinkTowards = Alignment.Top) + fadeOut(),
            ) {
                Column(
                    modifier = Modifier.fillMaxWidth().background(colors.primaryContent.copy(alpha = if (isDark) 0.045f else 0.025f))
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    summary.operations.forEach { op ->
                        OperationItemRow(op, showTitle = summary.operations.size != 1 || op.title != summary.summaryText,
                            showStatus = summary.operations.size != 1 || summary.failedCount == 0)
                        op.fileChanges.forEach { file ->
                            AgentoButton(text = file.path, secondary = true, onClick = {
                                onOpenFileDiff(FileDiffDetail(path = file.path, additions = file.additions,
                                    deletions = file.deletions, diffContent = file.diffSummary))
                            })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun OperationItemRow(operation: TimelineItem.Operation, showTitle: Boolean, showStatus: Boolean) {
    val colors = LocalAgentocColors.current
    val statusText = stringResource(when (operation.status) {
        TimelineOperationStatus.Completed -> R.string.timeline_done
        TimelineOperationStatus.Failed -> R.string.timeline_failed
        TimelineOperationStatus.InProgress -> R.string.timeline_running
        TimelineOperationStatus.Pending -> R.string.timeline_pending
    })
    val statusColor = when (operation.status) {
        TimelineOperationStatus.Completed -> colors.statusSuccess
        TimelineOperationStatus.Failed -> colors.error
        TimelineOperationStatus.InProgress -> colors.accentPrimary
        TimelineOperationStatus.Pending -> colors.secondaryContent
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (showTitle || showStatus) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (showTitle) Text(operation.title, Modifier.weight(1f),
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = colors.primaryContent)
            if (showStatus) Text(statusText, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium), color = statusColor)
        }
        if (operation.detail.isNotBlank()) {
            Text(operation.detail, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }
        val inputLabel = stringResource(R.string.timeline_input)
        val outputLabel = stringResource(R.string.timeline_output)
        listOf(inputLabel to operation.inputJson, outputLabel to operation.outputJson)
            .filter { (_, body) -> !body.isNullOrBlank() && body != operation.detail }
            .forEach { (label, body) ->
                Text(label, style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
                SelectionContainer {
                    Text(body.orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, lineHeight = 18.sp),
                        color = colors.primaryContent)
                }
            }
        operation.exitCode?.let { code ->
            Text(stringResource(R.string.timeline_exit_code, code), style = MaterialTheme.typography.labelSmall,
                color = if (code == 0) colors.secondaryContent else colors.error)
        }
    }
}

/**
 * PlanBlock: Collapsible plan steps.
 */
@Composable
fun PlanBlock(
    plan: TimelineItem.Plan,
    onPlanAction: (String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var expanded by rememberSaveable { mutableStateOf(true) }

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = if (isDark) Color(0xFF1E1E22) else Color(0xFFF4F4F5),
        border = BorderStroke(0.5.dp, if (isDark) Color(0x26FFFFFF) else Color(0x14000000)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = plan.title.ifBlank { "Task Plan" },
                    style = MaterialTheme.typography.titleSmall.copy(
                        fontSize = 13.5.sp,
                        fontWeight = FontWeight.SemiBold,
                    ),
                    color = colors.primaryContent,
                )
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronDown,
                    contentDescription = null,
                    modifier = Modifier
                        .size(13.dp)
                        .rotate(if (expanded) 180f else 0f),
                    tint = colors.secondaryContent,
                )
            }

            AnimatedVisibility(visible = expanded) {
                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    plan.items.forEachIndexed { index, step ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            val isDone = step.status.equals("completed", ignoreCase = true)
                            val inProgress = step.status.equals("in_progress", ignoreCase = true)

                            Box(
                                modifier = Modifier
                                    .size(14.dp)
                                    .clip(CircleShape)
                                    .background(
                                        when {
                                            isDone -> colors.stateRunning
                                            inProgress -> colors.accentPrimary
                                            else -> colors.surfaceLow
                                        }
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (isDone) {
                                    AgentoWebIcon(
                                        glyph = AgentoWebGlyph.Check,
                                        contentDescription = null,
                                        modifier = Modifier.size(10.dp),
                                        tint = Color.White,
                                    )
                                }
                            }

                            Text(
                                text = step.text,
                                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp),
                                color = if (isDone) colors.secondaryContent else colors.primaryContent,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * TimelineArtifactBlock: Low-contrast solid Surface for file changes and diffs.
 */
@Composable
fun TimelineArtifactBlock(
    files: List<FileChangeItem>,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = if (isDark) Color(0xFF1C1C20) else Color(0xFFF4F4F6),
        border = BorderStroke(0.5.dp, if (isDark) Color(0x26FFFFFF) else Color(0x14000000)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = "${files.size} file${if (files.size > 1) "s" else ""} updated",
                style = MaterialTheme.typography.labelMedium.copy(
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 12.5.sp,
                ),
                color = colors.primaryContent,
            )

            files.forEach { file ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .clickable {
                            onOpenFileDiff(
                                FileDiffDetail(
                                    path = file.path,
                                    additions = file.additions,
                                    deletions = file.deletions,
                                    diffContent = file.diffSummary,
                                )
                            )
                        }
                        .padding(vertical = 4.dp, horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = file.name,
                        style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                        ),
                        color = colors.primaryContent,
                        modifier = Modifier.weight(1f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )

                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (file.additions > 0) {
                            Text(
                                text = "+${file.additions}",
                                style = MaterialTheme.typography.labelSmall.copy(
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = FontWeight.Bold,
                                ),
                                color = Color(0xFF10B981),
                            )
                        }
                        if (file.deletions > 0) {
                            Text(
                                text = "-${file.deletions}",
                                style = MaterialTheme.typography.labelSmall.copy(
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = FontWeight.Bold,
                                ),
                                color = colors.error,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * ResultBlock: Direct on content canvas, headings, paragraphs, code blocks.
 * NOT wrapped in thick cards or bubbles.
 */
@Composable
fun ResultBlock(
    message: TimelineItem.Message,
    isLastTurn: Boolean,
    onBranch: (() -> Unit)?,
    onRestart: (() -> Unit)?,
    modifier: Modifier = Modifier,
    onReport: (() -> Unit)? = null,
    showMessageActions: Boolean = true,
    pauseStreaming: Boolean = false,
) {
    val displayText = displayAgentMessageText(message.text)
    if (displayText.isBlank()) return
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 4.dp),
    ) {
        if (message.completed || pauseStreaming) {
            AgentMarkdown(markdown = displayText, modifier = Modifier.testTag("agent-settled-text"))
        } else {
            AgentStreamingMessage(text = displayText, streaming = true, smoothCatchUp = message.lastEventSeq == 0L,
                modifier = Modifier.testTag("agent-live-text"))
        }

        if (showMessageActions && message.completed && (isLastTurn || onReport != null)) {
            AgentMessageActionBar(
                text = displayText,
                isLastMessage = isLastTurn,
                onBranch = onBranch.takeIf { isLastTurn },
                onRestart = onRestart.takeIf { isLastTurn },
                onReport = onReport,
            )
        }
    }
}

@Composable
fun StreamingResultBlock(
    message: TimelineItem.Message,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 4.dp),
    ) {
        AgentStreamingMessage(
            text = displayAgentMessageText(message.text),
            streaming = true,
            smoothCatchUp = !message.completed && message.lastEventSeq == 0L,
        )
    }
}
