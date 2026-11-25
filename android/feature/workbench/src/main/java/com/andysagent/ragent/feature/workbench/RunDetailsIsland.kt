package com.andysagent.ragent.feature.workbench

import androidx.compose.material3.ButtonDefaults

import com.andysagent.ragent.core.designsystem.AgentoBackdropTone

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.updateTransition
import androidx.compose.ui.res.stringResource
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.zIndex
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.network.ActiveCarrier
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.ragentComposerShadow
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.roundToInt

private enum class RunIslandStage { Collapsed, Compact, Full }

internal enum class RunIslandRequestKind { Approval, Question }

internal data class RunIslandRequest(
    val kind: RunIslandRequestKind,
    val summary: String,
    val submitting: Boolean = false,
)

/**
 * One glass shell owns all three stages, including the collapsed title.
 * Size and corner transitions can reverse without handing off to a second
 * capsule. Only the bottom disclosure opens the full details from the card.
 */
@Composable
internal fun RunDetailsIsland(
    expanded: Boolean,
    onDismiss: () -> Unit,
    runMetrics: RunMetricsUiState,
    changedFiles: List<FileDiffDetail>,
    deliverables: List<com.andysagent.ragent.core.timeline.AttachmentItem>,
    onShowFiles: () -> Unit,
    stepTraces: List<StepTraceItem>,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset = IntOffset.Zero,
    activitySummary: String? = null,
    pendingRequest: RunIslandRequest? = null,
    onOpenRequest: () -> Unit = {},
    onExpand: () -> Unit,
    collapsedContent: @Composable (showStatusIndicator: Boolean) -> Unit,
    modifier: Modifier = Modifier,
    onSideControlsSpaceMeasured: (Float) -> Unit = {},
    connectionStatus: AgentConnectionStatus? = null,
    activeCarrier: ActiveCarrier = ActiveCarrier.None,
    onRetryConnection: (() -> Unit)? = null,
) {
    var detailExpanded by remember { mutableStateOf(false) }
    val motion = motionPolicy()
    val morphDuration = when (motion.preference) {
        MotionPreference.Full -> 300
        MotionPreference.Reduced -> 160
        MotionPreference.None -> 0
    }
    val islandTransition = updateTransition(
        targetState = when {
            !expanded -> RunIslandStage.Collapsed
            detailExpanded -> RunIslandStage.Full
            else -> RunIslandStage.Compact
        },
        label = "run_island_stage",
    )
    // Keep the user's disclosure level across close/reopen. Resetting it in
    // an after-close effect starts a second child animation and can replace
    // the endpoint content while a fast reopening is already in flight.
    val expansion by islandTransition.animateFloat(
        transitionSpec = { runIslandMotionSpec(motion.preference) },
        label = "island_expansion",
    ) { if (it == RunIslandStage.Collapsed) 0f else 1f }
    val detailsProgress = islandTransition.animateFloat(
        transitionSpec = { runIslandMotionSpec(motion.preference) },
        label = "island_details_geometry",
    ) { stage ->
        // Closing the whole island must not also replace its expanded contents.
        if (stage == RunIslandStage.Full || (stage == RunIslandStage.Collapsed && detailExpanded)) 1f else 0f
    }
    val shellGeometry = runIslandShellGeometry(expansion)
    val bodyInteractive = expanded && expansion >= 1f
    val bodyHeight = remember { RunIslandBodyHeight() }
    val readingViewport = remember { RunIslandReadingViewport() }
    var visibleBodyHeight by remember { mutableIntStateOf(0) }
    var visibleBodyWidth by remember { mutableIntStateOf(0) }
    val cornerRadius = lerp(50.dp, 22.dp, shellGeometry.shellProgress)
    // The dismiss barrier must outlive the closing animation and sit above
    // the composer (2.5) and scroll-to-latest button (2.4). Otherwise a tap
    // through the visible card can cancel a run or move the transcript.
    val blocksBackground = expanded || islandTransition.currentState != RunIslandStage.Collapsed ||
        islandTransition.isRunning
    Box(modifier = modifier.fillMaxSize().zIndex(if (blocksBackground) 2.6f else 2.35f)) {
        if (blocksBackground) {
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismiss,
                    ),
            )
        }
        val colors = LocalRagentColors.current
        val isDark = colors.canvas.red < 0.5f
        var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }
        Box(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding(),
        ) {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .padding(
                        start = AgentoSpacing.ComposerMargin,
                        end = AgentoSpacing.ComposerMargin,
                        top = 4.dp,
                    )
                    .widthIn(max = RagentSizes.ContentMaxWidth)
                    .testTag("run-island-shell")
                    // Follow the same continuously morphing outline as the glass.
                    // Keep the halo outside the content clip, as in the composer.
                    .ragentComposerShadow(shape = RoundedCornerShape(cornerRadius))
                    // Expanded card content cannot accidentally open details.
                    .islandTapShield()
                    .onGloballyPositioned { coords ->
                        val pos = coords.positionInRoot()
                        backdropOffset = IntOffset(
                            backdropOrigin.x - pos.x.roundToInt(),
                            backdropOrigin.y - pos.y.roundToInt(),
                        )
                    },
                shape = RoundedCornerShape(cornerRadius),
                // Expanded and collapsed island use the same translucent dock
                // base as the composer. A high-opacity surface here hides the
                // sampled colour field and turns the island into a white card.
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOffset,
                backdropTone = AgentoBackdropTone.QuietHeader,
                material = AgentoGlassMaterial.LiquidClear,
                specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                showTopHairline = false,
                hasShadow = false,
            ) {
                // One persistent title, not two fading copies. The body is
                // measured and placed at its final width throughout the morph.
                // Reveal a normal-size reading surface, not a miniature card.
                Layout(
                    modifier = Modifier.clip(RoundedCornerShape(cornerRadius)),
                    content = {
                        Box(Modifier.testTag("run-island-persistent-title")
                            .then(if (!expanded) Modifier.agentoPressScale(onClick = onExpand) else Modifier)) {
                            collapsedContent(!blocksBackground)
                        }
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 512.dp)
                                .testTag("run-island-body")
                                .onPlaced { readingViewport.coordinates = it }
                                .runIslandForegroundReveal(
                                    { shellGeometry.bodyProgress }, { visibleBodyHeight }, { visibleBodyWidth },
                                )
                                .then(if (!bodyInteractive) Modifier.pointerInput(Unit) {
                                    awaitPointerEventScope {
                                        while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                                    }
                                } else Modifier)
                                .then(if (!bodyInteractive)
                                    Modifier.clearAndSetSemantics { } else Modifier),
                        ) {
                            Box(
                                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                            ) {
                                CompositionLocalProvider(LocalRunIslandReadingViewport provides readingViewport) {
                                    RunIslandCardContent(
                                        runMetrics = runMetrics,
                                        changedFiles = changedFiles,
                                        deliverables = deliverables,
                                        onShowFiles = onShowFiles,
                                        filesVisible = expanded && detailExpanded,
                                        stepTraces = stepTraces,
                                        activitySummary = activitySummary,
                                        pendingRequest = pendingRequest,
                                        onOpenRequest = onOpenRequest,
                                        onOpenFileDiff = onOpenFileDiff,
                                        detailExpanded = detailExpanded,
                                        detailsProgress = { detailsProgress.value },
                                        contentChangeDuration = morphDuration,
                                        connectionStatus = connectionStatus,
                                        activeCarrier = activeCarrier,
                                        onRetryConnection = onRetryConnection,
                                    )
                                }
                            }
                            RunIslandExpansionHandle(
                                onExpand = { detailExpanded = !detailExpanded },
                                detailExpanded = detailExpanded,
                                detailsProgress = { detailsProgress.value },
                            )
                        }
                    },
                ) { measurables, constraints ->
                    val title = measurables[0].measure(constraints.copy(minWidth = 0, minHeight = 0))
                    val body = measurables[1].measure(constraints.copy(
                        minWidth = constraints.maxWidth,
                        minHeight = 0,
                        maxHeight = (constraints.maxHeight - title.height).coerceAtLeast(0),
                    ))
                    val progress = shellGeometry.shellProgress
                    // A closing/reversing shell must not inherit a transient
                    // scroll viewport size from a remeasurement of its body.
                    val endpointHeight = bodyHeight.resolve(body.height, expansion, expanded)
                    val width = constraints.constrainWidth(
                        (title.width + (body.width - title.width) * progress).roundToInt(),
                    )
                    val height = constraints.constrainHeight(
                        title.height + (endpointHeight * shellGeometry.bodyProgress).roundToInt(),
                    )
                    visibleBodyHeight = (height - title.height).coerceAtLeast(0)
                    visibleBodyWidth = width
                    readingViewport.width = width
                    // At rest the scroll containers own visibility. During the
                    // whole-card morph each reading unit must fit the moving
                    // shell before it is drawn.
                    readingViewport.height = if (expansion >= 1f) Int.MAX_VALUE else visibleBodyHeight
                    // Side controls share this measured shell, not a second
                    // animation. Their outer anchors stay fixed while the
                    // remaining space is consumed/released by the title.
                    onSideControlsSpaceMeasured(runIslandSideControlsSpace(
                        body.width, width, 48.dp.roundToPx(),
                    ))
                    layout(width, height) {
                        title.placeRelative((width - title.width) / 2, 0)
                        // Keep the scroll/content-size nodes placed at alpha 0:
                        // skipping placement can change their measured viewport
                        // on the next frame and inflate an otherwise closing shell.
                        body.placeRelativeWithLayer((width - body.width) / 2, title.height) {
                            alpha = shellGeometry.bodyAlpha
                        }
                    }
                }
            }
        }
    }
}

/**
 * Compact island content: status, a short summary and one disclosure. The
 * content itself is deliberately inert; the dedicated bottom handle is the
 * only affordance that reveals the full panorama.
 */
@Composable
private fun RunIslandCardContent(
    runMetrics: RunMetricsUiState,
    changedFiles: List<FileDiffDetail>,
    deliverables: List<com.andysagent.ragent.core.timeline.AttachmentItem>,
    onShowFiles: () -> Unit,
    filesVisible: Boolean,
    stepTraces: List<StepTraceItem>,
    activitySummary: String?,
    pendingRequest: RunIslandRequest?,
    onOpenRequest: () -> Unit,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    detailExpanded: Boolean,
    detailsProgress: () -> Float,
    contentChangeDuration: Int,
    connectionStatus: AgentConnectionStatus? = null,
    activeCarrier: ActiveCarrier = ActiveCarrier.None,
    onRetryConnection: (() -> Unit)? = null,
) {
    val colors = LocalRagentColors.current
    val (dotColor, labelRes) = if (pendingRequest != null) {
        colors.waiting to when {
            pendingRequest.submitting -> R.string.run_summary_request_submitting
            pendingRequest.kind == RunIslandRequestKind.Question -> R.string.run_summary_waiting_answer
            else -> R.string.workbench_status_awaiting_approval
        }
    } else when (runMetrics.status) {
        AgentRunStatus.Working -> colors.stateRunning to R.string.workbench_status_processing
        AgentRunStatus.WaitingApproval -> colors.waiting to R.string.workbench_status_awaiting_approval
        AgentRunStatus.Completed -> colors.success to R.string.run_summary_completed
        AgentRunStatus.Failed -> colors.error to R.string.run_summary_failed
        AgentRunStatus.Cancelled -> colors.secondaryContent to com.andysagent.ragent.core.agentui.R.string.agentui_status_cancelled
        else -> colors.secondaryContent to R.string.run_summary_idle
    }
    val fallback = stringResource(when (runMetrics.status) {
        AgentRunStatus.Working -> R.string.run_summary_working_detail
        AgentRunStatus.WaitingApproval -> R.string.run_summary_approval_detail
        AgentRunStatus.Completed -> R.string.run_summary_completed_detail
        AgentRunStatus.Failed -> R.string.run_summary_failed_detail
        AgentRunStatus.Cancelled -> R.string.run_summary_cancelled_detail
        else -> R.string.run_summary_idle_detail
    })
    val summary = pendingRequest?.summary?.takeIf { it.isNotBlank() } ?: when (runMetrics.status) {
        AgentRunStatus.Working -> activitySummary?.takeIf { it.isNotBlank() }
            ?: stepTraces.lastOrNull { it.status == "running" }?.title
        AgentRunStatus.Failed -> runMetrics.failureReason?.takeIf { it.isNotBlank() }
        else -> null
    } ?: fallback
    Column(
        modifier = Modifier.fillMaxWidth().padding(start = AgentoSpacing.ComposerMargin,
            end = AgentoSpacing.ComposerMargin, top = 8.dp, bottom = 0.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.runIslandReadingItem(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (pendingRequest == null && runMetrics.status == AgentRunStatus.Working) {
                AgentoBreathingDot(color = dotColor, size = 7.dp)
            } else {
                Box(Modifier.height(7.dp).width(7.dp).clip(RoundedCornerShape(4.dp)).background(dotColor))
            }
            androidx.compose.material3.Text(
                text = stringResource(labelRes),
                modifier = Modifier.weight(1f).testTag("run-island-status-label"),
                style = androidx.compose.material3.MaterialTheme.typography.labelMedium.copy(
                    fontSize = 12.sp, fontWeight = FontWeight.Medium),
                color = colors.secondaryContent,
            )
            runMetrics.durationFormatted.takeIf { it.isNotBlank() && it != "N/A" && it != "—" }?.let {
                androidx.compose.material3.Text(
                    text = it,
                    style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                    color = colors.secondaryContent,
                )
            }
            connectionStatus?.let { status ->
                val carrierAccent = connectionStatusAccentColor(status)
                val statusLabel = stringResource(connectionStatusLabelRes(status, activeCarrier))
                val carrierText = if (status == AgentConnectionStatus.Connected && activeCarrier != ActiveCarrier.None) {
                    "${stringResource(R.string.connection_status_connected)} · $statusLabel"
                } else {
                    statusLabel
                }
                val canRetry = status != AgentConnectionStatus.Connected && onRetryConnection != null
                Row(
                    modifier = Modifier
                        .testTag("run-island-connection-carrier")
                        .clip(AgentoShapes.PillShape)
                        .background(colors.quietSurface)
                        .then(if (canRetry) Modifier.clickable(onClick = onRetryConnection!!) else Modifier)
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    if (status == AgentConnectionStatus.Connecting || status == AgentConnectionStatus.Reconnecting) {
                        AgentoBreathingDot(color = carrierAccent, size = 5.dp)
                    } else {
                        Box(
                            modifier = Modifier
                                .size(5.dp)
                                .clip(CircleShape)
                                .background(carrierAccent),
                        )
                    }
                    androidx.compose.material3.Text(
                        text = carrierText,
                        style = androidx.compose.material3.MaterialTheme.typography.labelSmall.copy(
                            fontWeight = FontWeight.Medium,
                        ),
                        color = colors.secondaryContent,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        RunIslandDetailsLayout(
            progress = detailsProgress,
            detailsExpanded = detailExpanded,
            summary = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                androidx.compose.material3.Text(
                    text = summary,
                    modifier = Modifier.testTag("run-island-summary").runIslandReadingItem(),
                    style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                        fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
                    color = colors.primaryContent,
                    // Compact is a preview; full details must not truncate
                    // the explanation preceding a required user decision.
                    maxLines = if (detailExpanded) Int.MAX_VALUE else 3,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
                if (changedFiles.isNotEmpty()) {
                    androidx.compose.material3.Text(
                        text = stringResource(R.string.run_summary_changed_files, changedFiles.size),
                        modifier = Modifier.runIslandReadingItem(),
                        style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                        color = colors.secondaryContent,
                    )
                }
                // The decision follows its explanation, before optional
                // execution details. It only reopens the existing request.
                if (pendingRequest != null) {
                    androidx.compose.material3.TextButton(
                        onClick = onOpenRequest,
                        enabled = !pendingRequest.submitting,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("run-island-request").runIslandReadingItem(),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.textButtonColors(
                            contentColor = colors.accentPrimary,
                            containerColor = colors.actionPrimary.copy(alpha = 0.08f),
                        ),
                    ) {
                        androidx.compose.material3.Text(
                            text = stringResource(if (pendingRequest.kind == RunIslandRequestKind.Question)
                                R.string.run_summary_answer_question else R.string.run_summary_view_request),
                            style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        )
                    }
                }
            }
            },
            details = {
            RunSheetContent(
                // Page text, intrinsic height and selected tab share one clock.
                // Do not add a second outer height animation chasing that size.
                contentChangeDuration = contentChangeDuration,
                runMetrics = runMetrics,
                changedFiles = changedFiles,
                deliverables = deliverables,
                onShowFiles = onShowFiles,
                filesVisible = filesVisible,
                stepTraces = stepTraces,
                onOpenFileDiff = onOpenFileDiff,
                showStatus = false,
                insetContent = false,
                showHeading = false,
            )
            },
        )
    }
}

/**
 * A single, explicit chevron affordance for the compact run island. Keeping
 * the hit target here prevents a tap on a metric or status from unexpectedly
 * turning the card into the panorama while still providing a comfortable
 * 48dp target.
 */
@Composable
private fun RunIslandExpansionHandle(
    onExpand: () -> Unit,
    detailExpanded: Boolean,
    detailsProgress: () -> Float,
) {
    val colors = LocalRagentColors.current
    val expandDescription = stringResource(if (detailExpanded)
        com.andysagent.ragent.core.agentui.R.string.agentui_collapse else R.string.workbench_session_run_details)
    val isDark = colors.canvas.red < 0.5f
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(56.dp)
                .height(48.dp)
                .clip(RoundedCornerShape(22.dp))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = onExpand,
                )
                .semantics {
                    role = Role.Button
                    contentDescription = expandDescription
                },
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .width(32.dp)
                    .height(32.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(
                        if (isDark) Color.White.copy(alpha = 0.16f)
                        else Color.Black.copy(alpha = 0.08f),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronDown,
                    contentDescription = null,
                    modifier = Modifier.height(20.dp).width(20.dp).graphicsLayer { rotationZ = 180f * detailsProgress() },
                    tint = colors.accentPrimary,
                )
            }
        }
    }
}

@Composable
private fun RunIslandMetricChip(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(if (isDark) Color(0x14FFFFFF) else Color(0x0A000000))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        androidx.compose.material3.Text(
            text = label,
            style = androidx.compose.material3.MaterialTheme.typography.labelSmall.copy(
                fontSize = 10.sp,
                letterSpacing = 0.3.sp,
            ),
            color = colors.secondaryContent,
        )
        androidx.compose.material3.Text(
            text = value,
            style = androidx.compose.material3.MaterialTheme.typography.titleSmall.copy(
                fontWeight = FontWeight.Bold,
                fontSize = 14.sp,
            ),
            color = colors.primaryContent,
        )
    }
}
