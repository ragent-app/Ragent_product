package com.andysagent.ragent.feature.organization.ui

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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.HourglassTop
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoTopBar
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.RagentCard
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.ButlerBucket
import com.andysagent.ragent.feature.organization.data.ButlerOverviewItemDto
import com.andysagent.ragent.feature.organization.presentation.ButlerFilter
import com.andysagent.ragent.feature.organization.presentation.ButlerUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ButlerOverviewScreen(
    uiState: ButlerUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onSelectFilter: (ButlerFilter) -> Unit,
    onOpenVoiceButler: (responsibilityId: String?, title: String?) -> Unit,
    onOpenApproval: (ButlerOverviewItemDto) -> Unit,
    onOpenResponsibilityDetails: (responsibilityId: String, planId: String?) -> Unit,
    onOpenLegacyReports: () -> Unit,
    onOpenOwnerReportNode: () -> Unit,
    onOpenAllResponsibilities: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val overview = uiState.overview
    val counts = overview?.counts

    val inProgressCount = counts?.inProgress ?: overview?.inProgress?.size ?: 0
    val awaitingDecisionCount = counts?.awaitingDecision ?: overview?.awaitingDecision?.size ?: 0
    val deliveredCount = counts?.deliveredArtifacts ?: overview?.deliveredArtifacts?.size ?: 0
    val blockedCount = counts?.blockedAndAlerts ?: overview?.blockedAndAlerts?.size ?: 0
    val unknownOutcomeCount = counts?.unknownOutcomeCount
        ?: overview?.blockedAndAlerts?.count { it.isUnknownOutcome } ?: 0

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas)
            .testTag("butler-overview-screen"),
    ) {
        AgentoTopBar(
            title = stringResource(R.string.butler_title),
            subtitle = stringResource(R.string.butler_subtitle),
            navigationIcon = {
                TextButton(onClick = onBack) { Text(stringResource(R.string.factory_team_06)) }
            },
            actions = {
                AgentoIconButton(
                    onClick = onRefresh,
                    contentDescription = stringResource(R.string.factory_team_08),
                    enabled = !uiState.overviewLoading,
                ) {
                    Icon(Icons.Rounded.Refresh, contentDescription = null)
                }
            },
        )

        if (uiState.overviewLoading) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            uiState.approvalConfirmNotice?.let { notice ->
                item("approval-notice") {
                    StatusBanner(text = notice, accent = colors.success)
                }
            }

            uiState.overviewError?.let { error ->
                item("overview-error") {
                    StatusBanner(text = error, accent = colors.error)
                }
            }

            if (unknownOutcomeCount > 0) {
                item("unknown-outcome-banner") {
                    StatusBanner(
                        text = stringResource(R.string.butler_unknown_outcome_banner, unknownOutcomeCount),
                        accent = colors.error,
                    )
                }
            }

            // 4-Bucket Tonal Summary Grid
            item("bucket-summary-grid") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ButlerSummaryTile(
                            label = stringResource(R.string.butler_bucket_in_progress),
                            count = inProgressCount,
                            accent = colors.running,
                            icon = Icons.Rounded.HourglassTop,
                            selected = uiState.activeFilter == ButlerFilter.IN_PROGRESS,
                            onClick = {
                                onSelectFilter(
                                    if (uiState.activeFilter == ButlerFilter.IN_PROGRESS) ButlerFilter.ALL
                                    else ButlerFilter.IN_PROGRESS,
                                )
                            },
                            modifier = Modifier.weight(1f).testTag("bucket-tile-in-progress"),
                        )
                        ButlerSummaryTile(
                            label = stringResource(R.string.butler_bucket_awaiting_decision),
                            count = awaitingDecisionCount,
                            accent = colors.actionPrimary,
                            icon = Icons.Rounded.Schedule,
                            selected = uiState.activeFilter == ButlerFilter.AWAITING_DECISION,
                            onClick = {
                                onSelectFilter(
                                    if (uiState.activeFilter == ButlerFilter.AWAITING_DECISION) ButlerFilter.ALL
                                    else ButlerFilter.AWAITING_DECISION,
                                )
                            },
                            modifier = Modifier.weight(1f).testTag("bucket-tile-awaiting-decision"),
                        )
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        ButlerSummaryTile(
                            label = stringResource(R.string.butler_bucket_delivered_artifacts),
                            count = deliveredCount,
                            accent = colors.success,
                            icon = Icons.Rounded.CheckCircle,
                            selected = uiState.activeFilter == ButlerFilter.DELIVERED_ARTIFACTS,
                            onClick = {
                                onSelectFilter(
                                    if (uiState.activeFilter == ButlerFilter.DELIVERED_ARTIFACTS) ButlerFilter.ALL
                                    else ButlerFilter.DELIVERED_ARTIFACTS,
                                )
                            },
                            modifier = Modifier.weight(1f).testTag("bucket-tile-delivered-artifacts"),
                        )
                        ButlerSummaryTile(
                            label = stringResource(R.string.butler_bucket_blocked_alerts),
                            count = blockedCount,
                            accent = colors.error,
                            icon = Icons.Rounded.WarningAmber,
                            selected = uiState.activeFilter == ButlerFilter.BLOCKED_AND_ALERTS,
                            onClick = {
                                onSelectFilter(
                                    if (uiState.activeFilter == ButlerFilter.BLOCKED_AND_ALERTS) ButlerFilter.ALL
                                    else ButlerFilter.BLOCKED_AND_ALERTS,
                                )
                            },
                            modifier = Modifier.weight(1f).testTag("bucket-tile-blocked-alerts"),
                        )
                    }
                }
            }

            // Primary Voice Butler & Navigation Strip
            item("voice-entry-row") {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AgentoButton(
                        text = stringResource(R.string.butler_voice_title),
                        onClick = { onOpenVoiceButler(null, null) },
                        leadingIcon = {
                            Icon(Icons.Rounded.Mic, contentDescription = null, modifier = Modifier.size(18.dp))
                        },
                        modifier = Modifier.weight(1f).testTag("butler-open-voice-button"),
                    )
                    AgentoButton(
                        text = stringResource(R.string.butler_all_controls),
                        onClick = onOpenAllResponsibilities,
                        secondary = true,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            // Filter Chips + Legacy Report Link
            item("filter-chips") {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FilterChip(
                        selected = uiState.activeFilter == ButlerFilter.ALL,
                        onClick = { onSelectFilter(ButlerFilter.ALL) },
                        label = { Text(stringResource(R.string.butler_bucket_all)) },
                    )
                    FilterChip(
                        selected = uiState.activeFilter == ButlerFilter.IN_PROGRESS,
                        onClick = { onSelectFilter(ButlerFilter.IN_PROGRESS) },
                        label = { Text("${stringResource(R.string.butler_bucket_in_progress)} ($inProgressCount)") },
                    )
                    FilterChip(
                        selected = uiState.activeFilter == ButlerFilter.AWAITING_DECISION,
                        onClick = { onSelectFilter(ButlerFilter.AWAITING_DECISION) },
                        label = { Text("${stringResource(R.string.butler_bucket_awaiting_decision)} ($awaitingDecisionCount)") },
                    )
                    FilterChip(
                        selected = uiState.activeFilter == ButlerFilter.DELIVERED_ARTIFACTS,
                        onClick = { onSelectFilter(ButlerFilter.DELIVERED_ARTIFACTS) },
                        label = { Text("${stringResource(R.string.butler_bucket_delivered_artifacts)} ($deliveredCount)") },
                    )
                    FilterChip(
                        selected = uiState.activeFilter == ButlerFilter.BLOCKED_AND_ALERTS,
                        onClick = { onSelectFilter(ButlerFilter.BLOCKED_AND_ALERTS) },
                        label = { Text("${stringResource(R.string.butler_bucket_blocked_alerts)} ($blockedCount)") },
                    )
                    TextButton(onClick = onOpenOwnerReportNode) { Text(stringResource(R.string.owner_node_title)) }
                    TextButton(onClick = onOpenLegacyReports) {
                        Text(stringResource(R.string.butler_legacy_reports))
                    }
                }
            }

            val showAwaiting = uiState.activeFilter in setOf(ButlerFilter.ALL, ButlerFilter.AWAITING_DECISION)
            val showBlocked = uiState.activeFilter in setOf(ButlerFilter.ALL, ButlerFilter.BLOCKED_AND_ALERTS)
            val showInProgress = uiState.activeFilter in setOf(ButlerFilter.ALL, ButlerFilter.IN_PROGRESS)
            val showDelivered = uiState.activeFilter in setOf(ButlerFilter.ALL, ButlerFilter.DELIVERED_ARTIFACTS)

            if (showAwaiting) {
                val awaitingItems = overview?.awaitingDecision.orEmpty()
                item("header-awaiting") {
                    BucketSectionHeader(
                        title = stringResource(R.string.butler_bucket_awaiting_decision),
                        count = awaitingItems.size,
                        accent = colors.actionPrimary,
                    )
                }
                if (awaitingItems.isEmpty()) {
                    item("empty-awaiting") { EmptyBucketRow() }
                } else {
                    items(awaitingItems, key = { "awaiting:${it.itemId}" }) { item ->
                        ButlerItemCard(
                            item = item,
                            bucket = ButlerBucket.AWAITING_DECISION,
                            accent = colors.actionPrimary,
                            onAskVoice = {
                                onOpenVoiceButler(item.resolvedResponsibilityId.takeIf { it.isNotBlank() }, item.responsibilityObjective.ifBlank { item.title })
                            },
                            onOpenApproval = { onOpenApproval(item) },
                            onOpenDetails = {
                                if (item.resolvedResponsibilityId.isNotBlank()) {
                                    onOpenResponsibilityDetails(item.resolvedResponsibilityId, item.actionTarget?.planId)
                                }
                            },
                        )
                    }
                }
            }

            if (showBlocked) {
                val blockedItems = overview?.blockedAndAlerts.orEmpty()
                item("header-blocked") {
                    BucketSectionHeader(
                        title = stringResource(R.string.butler_bucket_blocked_alerts),
                        count = blockedItems.size,
                        accent = colors.error,
                    )
                }
                if (blockedItems.isEmpty()) {
                    item("empty-blocked") { EmptyBucketRow() }
                } else {
                    items(blockedItems, key = { "blocked:${it.itemId}" }) { item ->
                        ButlerItemCard(
                            item = item,
                            bucket = ButlerBucket.BLOCKED_AND_ALERTS,
                            accent = colors.error,
                            onAskVoice = {
                                onOpenVoiceButler(item.resolvedResponsibilityId.takeIf { it.isNotBlank() }, item.responsibilityObjective.ifBlank { item.title })
                            },
                            onOpenApproval = null,
                            onOpenDetails = {
                                if (item.resolvedResponsibilityId.isNotBlank()) {
                                    onOpenResponsibilityDetails(item.resolvedResponsibilityId, item.actionTarget?.planId)
                                }
                            },
                        )
                    }
                }
            }

            if (showInProgress) {
                val progressItems = overview?.inProgress.orEmpty()
                item("header-progress") {
                    BucketSectionHeader(
                        title = stringResource(R.string.butler_bucket_in_progress),
                        count = progressItems.size,
                        accent = colors.running,
                    )
                }
                if (progressItems.isEmpty()) {
                    item("empty-progress") { EmptyBucketRow() }
                } else {
                    items(progressItems, key = { "progress:${it.itemId}" }) { item ->
                        ButlerItemCard(
                            item = item,
                            bucket = ButlerBucket.IN_PROGRESS,
                            accent = colors.running,
                            onAskVoice = {
                                onOpenVoiceButler(item.resolvedResponsibilityId.takeIf { it.isNotBlank() }, item.responsibilityObjective.ifBlank { item.title })
                            },
                            onOpenApproval = null,
                            onOpenDetails = {
                                if (item.resolvedResponsibilityId.isNotBlank()) {
                                    onOpenResponsibilityDetails(item.resolvedResponsibilityId, item.actionTarget?.planId)
                                }
                            },
                        )
                    }
                }
            }

            if (showDelivered) {
                val deliveredItems = overview?.deliveredArtifacts.orEmpty()
                item("header-delivered") {
                    BucketSectionHeader(
                        title = stringResource(R.string.butler_bucket_delivered_artifacts),
                        count = deliveredItems.size,
                        accent = colors.success,
                    )
                }
                if (deliveredItems.isEmpty()) {
                    item("empty-delivered") { EmptyBucketRow() }
                } else {
                    items(deliveredItems, key = { "delivered:${it.itemId}" }) { item ->
                        ButlerItemCard(
                            item = item,
                            bucket = ButlerBucket.DELIVERED_ARTIFACTS,
                            accent = colors.success,
                            onAskVoice = {
                                onOpenVoiceButler(item.resolvedResponsibilityId.takeIf { it.isNotBlank() }, item.responsibilityObjective.ifBlank { item.title })
                            },
                            onOpenApproval = null,
                            onOpenDetails = {
                                if (item.resolvedResponsibilityId.isNotBlank()) {
                                    onOpenResponsibilityDetails(item.resolvedResponsibilityId, item.actionTarget?.planId)
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ButlerSummaryTile(
    label: String,
    count: Int,
    accent: Color,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val bg = if (selected) accent.copy(alpha = 0.14f) else colors.surfaceLow
    val borderColor = if (selected) accent else colors.subtleOutline
    Column(
        modifier = modifier
            .clip(AgentoShapes.SurfaceMediumShape)
            .background(bg)
            .border(if (selected) 1.25.dp else 0.75.dp, borderColor, AgentoShapes.SurfaceMediumShape)
            .clickable(onClick = onClick)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
            Text(
                text = count.toString(),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = colors.primaryContent,
            )
        }
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = colors.secondaryContent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun BucketSectionHeader(
    title: String,
    count: Int,
    accent: Color,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .clip(AgentoShapes.PillShape)
                .background(accent),
        )
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = colors.primaryContent,
        )
        Text(
            text = count.toString(),
            style = MaterialTheme.typography.labelMedium,
            color = colors.secondaryContent,
        )
    }
}

@Composable
private fun EmptyBucketRow() {
    Text(
        text = stringResource(R.string.butler_empty_bucket),
        style = MaterialTheme.typography.bodySmall,
        color = LocalRagentColors.current.secondaryContent,
        modifier = Modifier.padding(vertical = 4.dp),
    )
}

@Composable
private fun StatusBanner(
    text: String,
    accent: Color,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(accent.copy(alpha = 0.12f))
            .border(0.75.dp, accent.copy(alpha = 0.36f), AgentoShapes.SurfaceSmallShape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
        Text(text = text, style = MaterialTheme.typography.bodySmall, color = colors.primaryContent)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ButlerItemCard(
    item: ButlerOverviewItemDto,
    bucket: ButlerBucket,
    accent: Color,
    onAskVoice: () -> Unit,
    onOpenApproval: (() -> Unit)?,
    onOpenDetails: () -> Unit,
) {
    val colors = LocalRagentColors.current
    RagentCard(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("butler-item-${item.itemId}"),
        onClick = onOpenDetails,
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = item.title.ifBlank { item.responsibilityObjective.ifBlank { item.itemId } },
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.primaryContent,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (item.responsibilityObjective.isNotBlank() && item.responsibilityObjective != item.title) {
                        Text(
                            text = item.responsibilityObjective,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                ButlerPill(
                    text = item.status.ifBlank { item.state.ifBlank { bucket.key } },
                    accent = accent,
                )
            }

            if (item.summary.isNotBlank()) {
                Text(
                    text = item.summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.secondaryContent,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ButlerPill(text = item.itemType, accent = colors.secondaryContent)
                item.controlState?.takeIf { it.isNotBlank() && it != "none" }?.let { ctrl ->
                    ButlerPill(text = ctrl, accent = colors.waiting)
                }
                item.stopStatus?.takeIf { it.isNotBlank() }?.let { stop ->
                    ButlerPill(text = "stop: $stop", accent = colors.waiting)
                }
                if (item.isUnknownOutcome) {
                    ButlerPill(
                        text = stringResource(R.string.butler_unknown_outcome_badge),
                        accent = colors.error,
                        emphasized = true,
                    )
                }
            }

            item.diagnostics?.let { diag ->
                val diagLine = listOfNotNull(
                    diag.code?.takeIf { it.isNotBlank() },
                    diag.rootCause?.takeIf { it.isNotBlank() } ?: diag.message?.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (diagLine.isNotBlank()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(AgentoShapes.SurfaceSmallShape)
                            .background(colors.quietSurface)
                            .padding(10.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = diagLine,
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.primaryContent,
                            )
                            val flags = listOfNotNull(
                                if (diag.requiresVerification) "verify receipt" else null,
                                if (diag.safeToRetry) "safe to retry" else "do not auto-replay",
                            ).joinToString(" · ")
                            Text(
                                text = flags,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.secondaryContent,
                            )
                        }
                    }
                }
            }

            item.artifact?.let { artifact ->
                val artifactSummary = listOfNotNull(
                    artifact.milestone?.takeIf { it.isNotBlank() },
                    artifact.packetId?.takeIf { it.isNotBlank() }?.let { "packet $it" },
                    artifact.target?.takeIf { it.isNotBlank() },
                ).joinToString(" · ")
                if (artifactSummary.isNotBlank()) {
                    Text(
                        text = artifactSummary,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.success,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (onOpenApproval != null && bucket == ButlerBucket.AWAITING_DECISION) {
                    AgentoButton(
                        text = stringResource(R.string.butler_review_approve),
                        onClick = onOpenApproval,
                        modifier = Modifier.testTag("butler-approve-${item.itemId}"),
                    )
                }
                if (item.resolvedResponsibilityId.isNotBlank()) {
                    AgentoButton(
                        text = stringResource(R.string.butler_ask_voice),
                        onClick = onAskVoice,
                        secondary = true,
                        leadingIcon = {
                            Icon(Icons.Rounded.AutoAwesome, contentDescription = null, modifier = Modifier.size(16.dp))
                        },
                    )
                }
                Spacer(Modifier.weight(1f))
                if (item.resolvedResponsibilityId.isNotBlank()) {
                    TextButton(onClick = onOpenDetails) {
                        Text(stringResource(R.string.butler_open_details))
                    }
                }
            }
        }
    }
}

@Composable
private fun ButlerPill(
    text: String,
    accent: Color,
    emphasized: Boolean = false,
) {
    Box(
        modifier = Modifier
            .clip(AgentoShapes.PillShape)
            .background(accent.copy(alpha = if (emphasized) 0.18f else 0.11f))
            .border(0.75.dp, accent.copy(alpha = if (emphasized) 0.45f else 0.25f), AgentoShapes.PillShape)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = accent,
            fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
