package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.ragent.core.timeline.AttachmentItem
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.RunStatus
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoProgressBar
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoFrostedModalBottomSheet
import com.andysagent.ragent.core.designsystem.AgentoModalBackgroundDim
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTextStyles
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoLargeCardShadow
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import java.util.UUID
import kotlin.math.roundToInt

@Immutable
data class StepTraceItem(
    val stepIndex: Int,
    val toolName: String,
    val title: String,
    val detail: String = "",
    val status: String = "completed",
    val elapsedMs: Long = 0L,
    val reasoning: String? = null,
)

@Immutable
data class FileDiffDetail(
    val path: String,
    val additions: Int,
    val deletions: Int,
    val diffContent: String,
)

@Immutable
data class RunMetricsUiState(
    val durationFormatted: String = "N/A",
    val status: AgentRunStatus = AgentRunStatus.Idle,
    val promptTokens: Int = 0,
    val completionTokens: Int = 0,
    val totalTokens: Int = 0,
    val totalCostUsd: Double = 0.0,
    val toolCallsCount: Int = 0,
    val filesChangedCount: Int = 0,
    val runId: String? = null,
    val phase: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val runtimeFamily: String? = null,
    val failureReason: String? = null,
)

internal enum class RunSheetTab { Metrics, Files, Trace }

@Immutable
internal data class RunSheetPage(
    val tab: RunSheetTab,
    val metrics: RunMetricsUiState,
    val files: List<FileDiffDetail>,
    val deliverables: List<AttachmentItem>,
    val traces: List<StepTraceItem>,
)

/**
 * Run Sheet Full Panorama Bottom Sheet (Spec-04)
 * Clicked from Top Status Capsule to inspect execution time, tokens, modified file diffs, and tool steps.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunSheetModalBottomSheet(
    runMetrics: RunMetricsUiState,
    changedFiles: List<FileDiffDetail>,
    deliverables: List<AttachmentItem> = emptyList(),
    stepTraces: List<StepTraceItem>,
    onDismiss: () -> Unit,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var selectedTab by remember { mutableStateOf(RunSheetTab.Metrics) }

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier,
    ) {
        RunSheetContent(
            runMetrics = runMetrics,
            changedFiles = changedFiles,
            deliverables = deliverables,
            stepTraces = stepTraces,
            onOpenFileDiff = onOpenFileDiff,
            modifier = Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
        )
    }
}

/**
 * Run panorama content shared by the tablet bottom sheet and the phone
 * top run-details Dynamic Island.
 */
@Composable
internal fun RunSheetContent(
    runMetrics: RunMetricsUiState,
    changedFiles: List<FileDiffDetail>,
    deliverables: List<AttachmentItem> = emptyList(),
    stepTraces: List<StepTraceItem>,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    modifier: Modifier = Modifier,
    showStatus: Boolean = true,
    insetContent: Boolean = true,
    showHeading: Boolean = true,
    contentChangeDuration: Int? = null,
    onShowFiles: () -> Unit = {},
    filesVisible: Boolean = true,
) {
    val colors = LocalRagentColors.current
    var selectedTab by remember { mutableStateOf(RunSheetTab.Metrics) }
    LaunchedEffect(selectedTab, filesVisible) {
        if (selectedTab == RunSheetTab.Files && filesVisible) onShowFiles()
    }
    val duration = contentChangeDuration ?: when (motionPolicy().preference) {
        MotionPreference.Full -> 300
        MotionPreference.Reduced -> 160
        MotionPreference.None -> 0
    }
    // Retain the displayed data for each page; live same-tab updates stay local.
    val page = remember(selectedTab, runMetrics, changedFiles, deliverables, stepTraces) {
        RunSheetPage(selectedTab, runMetrics, changedFiles.toList(), deliverables.toList(), stepTraces.toList())
    }
    val pages = remember { mutableMapOf<RunSheetTab, RunSheetPage>() }
    pages[selectedTab] = page
    val frameHolder = remember { RunSheetFrameHolder() }
    var segment by remember { mutableStateOf(RunSheetTabSegment()) }
    LaunchedEffect(segment) {
        segment.progress.animateTo(1f, tween(duration, easing = LinearEasing))
    }
    val selection = remember { derivedStateOf {
        segment.source.selection + (segment.target.ordinal - segment.source.selection) *
            FastOutSlowInEasing.transform(segment.progress.value)
    } }
    val settled by remember { derivedStateOf { segment.progress.value == 1f } }
    BoxWithConstraints(modifier = modifier.fillMaxWidth()) {
        // Allocate space for scaled text rather than forcing the status and three
        // translated tabs to compete with the heading on a fixed-width phone.
        val stacked = maxWidth < 320.dp * LocalDensity.current.fontScale
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = if (insetContent) AgentoSpacing.ComposerMargin else 0.dp,
                    vertical = if (insetContent) 6.dp else 0.dp),
            verticalArrangement = Arrangement.spacedBy(if (insetContent) 14.dp else 8.dp),
        ) {
            if (!showHeading) {
                // The inline island already owns its persistent title and status.
            } else if (!showStatus) {
                RunSheetHeading(Modifier.fillMaxWidth())
            } else if (stacked) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    RunSheetHeading(Modifier.fillMaxWidth())
                    RunStatus(runMetrics.status)
                }
            } else {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RunSheetHeading(Modifier.weight(1f).padding(end = 12.dp))

                    // Shared exhaustive status mapping includes Cancelled and uses
                    // the same localized status language as the rest of the app.
                    RunStatus(runMetrics.status)
                }
            }

            Box(Modifier.runIslandReadingItem()) {
                RunSheetTabs(selectedTab, selection, stacked, changedFiles.size + deliverables.size, stepTraces.size) { target ->
                    if (target != selectedTab) {
                        // Never reset a clock still consumed with the previous
                        // source/target by layout. Retarget from the drawn frame
                        // in one composition, retaining all page identities.
                        segment = RunSheetTabSegment(frameHolder.frame ?: segment.source, target, 0f)
                        selectedTab = target
                    }
                }
            }

            RunSheetPages(
                sourceFrame = segment.source, target = segment.target,
                progress = segment.progress.asState(), holder = frameHolder,
            ) { tab ->
                val displayed = pages[tab] ?: page.copy(tab = tab)
                val inactive = tab != selectedTab || !settled
                Box(Modifier.fillMaxWidth()
                    .then(if (displayed.tab != RunSheetTab.Metrics)
                        Modifier.runIslandReadingItem(protectBottom = false) else Modifier)
                    .then(if (inactive) Modifier
                    .clearAndSetSemantics { }
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                        }
                    } else Modifier).testTag("run-tab-page-${displayed.tab.name}")) {
                    when (displayed.tab) {
                        RunSheetTab.Metrics -> RunMetricsSection(displayed.metrics, displayed.files.size + displayed.deliverables.size, displayed.traces.size, stacked)
                        RunSheetTab.Files -> ChangedFilesSection(displayed.files, displayed.deliverables, onOpenFileDiff)
                        RunSheetTab.Trace -> ExecutionTraceSection(displayed.traces)
                    }
                }
            }

        }
    }
}

@Composable
private fun RunSheetHeading(modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    Column(modifier) {
        Text(
            text = stringResource(R.string.workbench_session_run_details),
            modifier = Modifier.testTag("run-details-heading"),
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold, fontSize = 18.sp),
            color = colors.primaryContent,
        )
        Text(
            text = stringResource(R.string.run_details_subtitle),
            style = RagentTextStyles.caption.copy(fontSize = 12.sp),
            color = colors.secondaryContent,
        )
    }
}

@Composable
private fun RunMetricsSection(metrics: RunMetricsUiState, fileCount: Int, traceCount: Int, stacked: Boolean) {
    val colors = LocalRagentColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        val totalTokens = maxOf(metrics.totalTokens, metrics.promptTokens + metrics.completionTokens)
        val cards = listOf(
            stringResource(R.string.run_metric_time) to (metrics.durationFormatted.takeUnless { it.isBlank() || it == "N/A" } ?: "—"),
            stringResource(R.string.run_metric_tools) to maxOf(metrics.toolCallsCount, traceCount).toString(),
            stringResource(R.string.run_metric_files) to fileCount.toString(),
            stringResource(R.string.run_metric_tokens) to (if (totalTokens > 0) totalTokens.toString() else "—"),
        )
        // One quiet information plane inside the glass shell, not a second
        // raised card competing with the run's state and required action.
        Column(Modifier.fillMaxWidth().testTag("run-metrics-group")) {
                cards.chunked(if (stacked) 1 else 2).forEachIndexed { index, row ->
                    if (index > 0) Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp)
                        .height(0.5.dp).background(colors.secondaryContent.copy(alpha = 0.1f)))
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { (title, value) ->
                            MetricValue(title, value, Modifier.weight(1f))
                        }
                    }
                }
        }

        if (totalTokens > 0) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp)
                    .testTag("run-context-budget-bar"),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                AgentoProgressBar(
                    progress = (totalTokens.toFloat() / 200_000f).coerceIn(0.02f, 1f),
                    accentColor = colors.accentPrimary,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = stringResource(R.string.run_metric_tokens),
                        style = RagentTextStyles.caption,
                        color = colors.secondaryContent,
                    )
                    Text(
                        text = "${metrics.promptTokens} in · ${metrics.completionTokens} out",
                        style = RagentTextStyles.caption.copy(fontFamily = FontFamily.Monospace),
                        color = colors.secondaryContent,
                    )
                }
            }
        }

        val context = runContextPresentation(metrics)
        if (!context.isEmpty) {
            Column(
                modifier = Modifier.fillMaxWidth().testTag("run-context").padding(horizontal = 12.dp, vertical = 4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                context.primary?.let { Text(text = it, modifier = Modifier.testTag("run-context-primary").runIslandReadingItem(),
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.primaryContent) }
                context.supporting?.let { Text(text = it, modifier = Modifier.testTag("run-context-supporting").runIslandReadingItem(),
                    style = RagentTextStyles.caption, color = colors.secondaryContent) }
                val metadata = listOfNotNull(
                    context.phase?.let { stringResource(R.string.run_details_phase_value, it) },
                    context.runId?.let { stringResource(R.string.run_details_run_value, it) },
                )
                if (metadata.isNotEmpty()) Text(text = metadata.joinToString(" · "),
                    modifier = Modifier.testTag("run-context-metadata").runIslandReadingItem(), style = RagentTextStyles.caption,
                    color = colors.secondaryContent)
                context.failure?.let { Text(text = stringResource(R.string.run_details_error_value, it),
                    modifier = Modifier.testTag("run-context-failure").runIslandReadingItem(), style = MaterialTheme.typography.bodySmall,
                    color = colors.error) }
            }
        }
    }
}

@Composable
private fun MetricValue(
    title: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = modifier.padding(horizontal = 12.dp, vertical = 8.dp).runIslandReadingItem(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            modifier = Modifier.weight(1f),
            text = title,
            style = RagentTextStyles.caption.copy(
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = colors.secondaryContent,
            ),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
            ),
            color = colors.primaryContent,
        )
    }
}

@Composable
private fun ChangedFilesSection(
    files: List<FileDiffDetail>,
    deliverables: List<AttachmentItem>,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
) {
    val colors = LocalRagentColors.current
    val openAttachment = LocalTimelineAttachmentOpen.current
    if (files.isEmpty() && deliverables.isEmpty()) {
        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).runIslandReadingItem(), contentAlignment = Alignment.Center) {
            Text(stringResource(R.string.run_details_no_session_files), style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }
        return
    }

    val newestDeliverables = remember(deliverables) { deliverables.asReversed() }
    val deliveryKeys = remember(newestDeliverables) { runSheetOccurrenceKeys(newestDeliverables) { it.assetId ?: it.downloadUrl ?: it.url ?: it.originalName ?: it.filename.orEmpty() } }
    val changeKeys = remember(files) { runSheetOccurrenceKeys(files) { it.path } }
    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 340.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (deliverables.isNotEmpty()) {
            item(key = "deliverables-heading") { RunFilesHeading(stringResource(R.string.run_details_session_deliverables)) }
            itemsIndexed(newestDeliverables, key = { index, _ -> "deliverable-${deliveryKeys[index]}" }) { index, att ->
                val attachment = ComposerAttachment(
                    id = att.assetId ?: att.downloadUrl ?: att.url ?: "attachment-$index",
                    assetId = att.assetId,
                    name = att.originalName ?: att.filename ?: "attachment",
                    mimeType = att.mimeType ?: "application/octet-stream",
                    sizeBytes = att.sizeBytes ?: 0L,
                    previewUrl = att.downloadUrl ?: att.url,
                )
                val context = LocalContext.current
                val size = attachment.sizeBytes.takeIf { it > 0 }?.let { android.text.format.Formatter.formatShortFileSize(context, it) }
                RunFileRow(attachment.name, size) { openAttachment(attachment) }
            }
        }
        if (files.isNotEmpty()) {
            item(key = "changes-heading") { RunFilesHeading(stringResource(R.string.run_details_run_changes)) }
            itemsIndexed(files, key = { index, _ -> "change-${changeKeys[index]}" }) { _, file ->
                RunFileRow(file.path) { onOpenFileDiff(file) }
            }
        }
    }
}

@Composable
private fun RunFilesHeading(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = LocalRagentColors.current.secondaryContent,
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp))
}

@Composable
private fun RunFileRow(name: String, detail: String? = null, onClick: () -> Unit) {
    val colors = LocalRagentColors.current
    Surface(onClick = onClick, shape = AgentoShapes.SquircleS, color = Ragentolors.SurfaceLevel1,
        contentColor = colors.primaryContent, modifier = Modifier.fillMaxWidth().runIslandReadingItem()) {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AgentoWebIcon(glyph = AgentoWebGlyph.File, contentDescription = null, modifier = Modifier.size(16.dp),
                tint = colors.accentPrimary)
            Text(text = name, style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(fontSize = 12.sp),
                maxLines = 1, overflow = TextOverflow.Ellipsis, color = colors.primaryContent, modifier = Modifier.weight(1f))
            if (detail != null) Text(detail, style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
            AgentoWebIcon(glyph = AgentoWebGlyph.ChevronRight, contentDescription = null, modifier = Modifier.size(14.dp),
                tint = colors.secondaryContent)
        }
    }
}

@Composable
private fun ExecutionTraceSection(stepTraces: List<StepTraceItem>) {
    val colors = LocalRagentColors.current
    if (stepTraces.isEmpty()) {
        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).runIslandReadingItem(), contentAlignment = Alignment.Center) {
            Text(
                text = stringResource(R.string.run_details_no_trace),
                style = MaterialTheme.typography.bodySmall,
                color = colors.secondaryContent,
            )
        }
        return
    }

    val keys = remember(stepTraces) { runSheetOccurrenceKeys(stepTraces) { "${it.stepIndex}:${it.toolName}" } }
    LazyColumn(
        modifier = Modifier.fillMaxWidth().heightIn(max = 340.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(stepTraces, key = { index, _ -> keys[index] }) { _, trace ->
            var expanded by remember { mutableStateOf(false) }
            Surface(
                shape = AgentoShapes.SquircleS,
                color = Ragentolors.SurfaceLevel1,
                contentColor = colors.primaryContent,
                modifier = Modifier
                    .fillMaxWidth()
                    .animateContentSize(animationSpec = tween(160))
                    .runIslandReadingItem(),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { expanded = !expanded },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            modifier = Modifier.weight(1f),
                        ) {
                            Surface(
                                shape = CircleShape,
                                color = Ragentolors.SurfaceLevel2,
                            ) {
                                Text(
                                    text = "#${trace.stepIndex}",
                                    style = RagentTextStyles.caption.copy(
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.Bold,
                                    ),
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                    color = colors.secondaryContent,
                                )
                            }
                            Text(
                                text = trace.title.ifBlank { trace.toolName },
                                style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.SemiBold,
                                ),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                color = colors.primaryContent,
                            )
                        }

                        AgentoWebIcon(
                            glyph = if (expanded) AgentoWebGlyph.ChevronDown else AgentoWebGlyph.ChevronRight,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = colors.secondaryContent,
                        )
                    }

                    if (expanded && trace.detail.isNotBlank()) {
                        Surface(
                            shape = AgentoShapes.SquircleXS,
                            color = Ragentolors.SurfaceLevel2,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(
                                text = trace.detail,
                                style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                    fontSize = 10.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                ),
                                modifier = Modifier
                                    .padding(8.dp)
                                    .horizontalScroll(rememberScrollState()),
                                color = colors.primaryContent,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * Built-in Code Diff Viewer Modal (Spec-04)
 * Displays unified diff with JetBrains Mono, line-level color highlighting.
 */
@Composable
fun DiffViewerModal(
    diffFile: FileDiffDetail,
    onDismiss: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember(backdropLayer) { mutableStateOf(androidx.compose.ui.unit.IntOffset.Zero) }
    val pageBackdropOrigin = com.andysagent.ragent.core.designsystem.LocalAgentoPageBackdropOrigin.current

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        com.andysagent.ragent.core.designsystem.AgentoSystemSafeArea {
        AgentoModalBackgroundDim(amount = if (isDark) 0.20f else 0.16f)
        AgentoFrostedGlassBox(
            modifier = modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .onGloballyPositioned { coordinates ->
                    val position = coordinates.positionInRoot()
                    backdropOffset = androidx.compose.ui.unit.IntOffset(
                        x = pageBackdropOrigin.x - position.x.roundToInt(),
                        y = pageBackdropOrigin.y - position.y.roundToInt(),
                    )
                },
            shape = androidx.compose.ui.graphics.RectangleShape,
            surface = AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            backdropLayer = backdropLayer,
            backdropOffset = backdropOffset,
            material = AgentoGlassMaterial.LiquidClear,
            backdropTone = com.andysagent.ragent.core.designsystem.AgentoBackdropTone.QuietHeader,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            hasShadow = false,
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Header
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f),
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.File,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = LocalRagentColors.current.accentPrimary,
                        )
                        Text(
                            text = diffFile.path,
                            style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                fontSize = 13.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = colors.primaryContent,
                        )
                    }

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            text = "+${diffFile.additions} -${diffFile.deletions}",
                            style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color(0xFF34C759),
                            ),
                        )
                        Box(
                            modifier = Modifier
                                .size(30.dp)
                                .clip(CircleShape)
                                .background(Ragentolors.SurfaceLevel2)
                                .clickable(onClick = onDismiss)
                                .semantics { contentDescription = "Close diff viewer" },
                            contentAlignment = Alignment.Center,
                        ) {
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.Stop,
                                contentDescription = null,
                                modifier = Modifier.size(12.dp),
                                tint = colors.primaryContent,
                            )
                        }
                    }
                }

                // Diff Content Lines
                val lines = remember(diffFile.diffContent) { diffFile.diffContent.lines() }
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(horizontal = 4.dp),
                ) {
                    items(lines.size) { index ->
                        val line = lines[index]
                        val isAdd = line.startsWith("+") && !line.startsWith("+++")
                        val isDel = line.startsWith("-") && !line.startsWith("---")
                        val isHeader = line.startsWith("@@") || line.startsWith("diff") || line.startsWith("index")

                        val lineBg = when {
                            isAdd -> Color(0xFF34C759).copy(alpha = if (isDark) 0.16f else 0.12f)
                            isDel -> Color(0xFFEF4444).copy(alpha = if (isDark) 0.16f else 0.12f)
                            isHeader -> LocalRagentColors.current.accentPrimary.copy(alpha = if (isDark) 0.12f else 0.08f)
                            else -> Color.Transparent
                        }

                        val lineTextColor = when {
                            isAdd -> Color(0xFF34C759)
                            isDel -> Color(0xFFEF4444)
                            isHeader -> LocalRagentColors.current.accentPrimary
                            else -> colors.primaryContent
                        }

                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(lineBg)
                                .padding(vertical = 1.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "${index + 1}".padStart(4, ' '),
                                style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                    fontSize = 11.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = colors.disabledContent,
                                ),
                                modifier = Modifier.width(36.dp),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = line,
                                style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                    fontSize = 11.5.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = lineTextColor,
                                ),
                                modifier = Modifier.horizontalScroll(rememberScrollState()),
                            )
                        }
                    }
                }
            }
        }
    }
    }
}

/**
 * File Diff Summary Card (Spec-06)
 * Aggregated presentation of modified files: "📦 File Changes: N files (+X, -Y)"
 */
@Composable
fun FileDiffSummaryCard(
    files: List<FileDiffDetail>,
    onOpenFileDiff: (FileDiffDetail) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (files.isEmpty()) return
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val totalAdds = files.sumOf { it.additions }
    val totalDels = files.sumOf { it.deletions }


    AgentoFrostedGlassBox(
        shape = RoundedCornerShape(16.dp),
        surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
        showTopHairline = true,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        material = AgentoGlassMaterial.LiquidClear,
        hasShadow = true,
        shadowElevation = 6.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.File,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                        tint = LocalRagentColors.current.accentPrimary,
                    )
                    Text(
                        text = "File Changes: ${files.size} files",
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.5.sp,
                        ),
                        color = colors.primaryContent,
                    )
                    Text(
                        text = "+$totalAdds -$totalDels",
                        style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp,
                            color = Color(0xFF34C759),
                        ),
                    )
                }

                Surface(
                    onClick = { files.firstOrNull()?.let(onOpenFileDiff) },
                    shape = RoundedCornerShape(percent = 50),
                    color = LocalRagentColors.current.accentPrimary.copy(alpha = 0.12f),
                ) {
                    Text(
                        text = "Diff",
                        style = RagentTextStyles.caption.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 11.sp,
                            color = LocalRagentColors.current.accentPrimary,
                        ),
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }

            // File items
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                files.forEach { file ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(AgentoShapes.SquircleXS)
                            .agentoPressScale(0.98f, onClick = { onOpenFileDiff(file) })
                            .padding(vertical = 4.dp, horizontal = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = file.path,
                            style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                fontSize = 12.sp,
                                color = colors.primaryContent,
                            ),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (file.additions > 0) {
                                Text(
                                    text = "+${file.additions}",
                                    style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = Color(0xFF34C759),
                                    ),
                                )
                            }
                            if (file.deletions > 0) {
                                Text(
                                    text = "-${file.deletions}",
                                    style = com.andysagent.ragent.core.designsystem.RagentonversationTypography.Code.copy(
                                        fontSize = 11.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = Color(0xFFEF4444),
                                    ),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
