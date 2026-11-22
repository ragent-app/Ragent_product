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
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoTextField
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardChannelTabUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardMessageUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmBoardUiState
import com.andysagent.ragent.feature.organization.presentation.SwarmOverviewUiState

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SwarmOverviewBar(
    overview: SwarmOverviewUiState,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val pillContent: @Composable () -> Unit = {
        if (overview.showSwarmCounts && !overview.isReadOnlyNative) {
            OverviewPill(
                text = "${stringResource(R.string.organization_swarm_working)}: ${overview.workingCount}",
                accent = colors.running,
            )
            OverviewPill(
                text = "${stringResource(R.string.organization_swarm_waiting)}: ${overview.waitingCount}",
                accent = colors.waiting,
            )
            OverviewPill(
                text = "${stringResource(R.string.organization_swarm_stopped)}: ${overview.stoppedCount}",
                accent = colors.secondaryContent,
            )
            OverviewPill(
                text = "${stringResource(R.string.organization_swarm_killed)}: ${overview.killedCount}",
                accent = colors.error,
            )
        }
        if (overview.isDone) {
            OverviewPill(text = "[done]", accent = colors.success, emphasized = true)
        }
        if (overview.isReadOnlyNative) {
            OverviewPill(text = "read-only", accent = colors.secondaryContent, emphasized = true)
        }
        overview.harnesses.forEach { badge ->
            OverviewPill(
                text = "${badge.harness} ×${badge.count}",
                accent = colors.actionPrimary,
            )
        }
        overview.branches.forEach { branch ->
            OverviewPill(
                text = branch,
                accent = colors.primaryContent,
            )
        }
        overview.stalls.forEach { stall ->
            OverviewPill(
                text = stall.label,
                accent = colors.error,
                emphasized = true,
            )
        }
    }

    if (compact) {
        Row(
            modifier = modifier
                .testTag("swarm-overview-bar")
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            pillContent()
        }
    } else {
        FlowRow(
            modifier = modifier
                .testTag("swarm-overview-bar")
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            pillContent()
        }
    }
}

@Composable
private fun OverviewPill(
    text: String,
    accent: Color,
    emphasized: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val bg = if (emphasized) accent.copy(alpha = 0.14f) else colors.quietSurface
    val borderColor = if (emphasized) accent.copy(alpha = 0.36f) else colors.subtleOutline
    Text(
        text = text,
        color = if (emphasized) accent else colors.primaryContent,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(AgentoShapes.PillShape)
            .background(bg)
            .border(0.75.dp, borderColor, AgentoShapes.PillShape)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SwarmBoardPanel(
    board: SwarmBoardUiState,
    onSelectChannel: (String) -> Unit,
    onComposerDraftChange: (String) -> Unit,
    onSelectReplySeq: (Long?) -> Unit,
    onPostMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Column(
        modifier = modifier
            .testTag("swarm-board-panel")
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceLargeShape)
            .background(colors.quietSurface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = board.title?.takeIf { it.isNotBlank() } ?: stringResource(R.string.organization_swarm_board_title),
                color = colors.primaryContent,
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (board.headSeq > 0L) {
                    OverviewPill(text = "#${board.headSeq}", accent = colors.secondaryContent)
                }
                if (board.isDone) {
                    OverviewPill(text = "[done]", accent = colors.success, emphasized = true)
                }
            }
        }

        if (board.channels.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                board.channels.forEach { tab ->
                    BoardChannelChip(
                        tab = tab,
                        onClick = { onSelectChannel(tab.id) },
                    )
                }
            }
        }

        if (board.activeStalls.isNotEmpty()) {
            FlowRow(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                board.activeStalls.forEach { stall ->
                    OverviewPill(text = stall.label, accent = colors.error, emphasized = true)
                }
            }
        }

        val showOwnerComposer = (board.mode == "ragent_swarm" && !board.readOnly && board.isWritable && !board.isDone)
        if (!showOwnerComposer) {
            val bannerRes = if (board.isDone) {
                R.string.organization_swarm_done_readonly_banner
            } else {
                R.string.organization_swarm_readonly_banner
            }
            Box(
                modifier = Modifier
                    .testTag("swarm-board-readonly-banner")
                    .fillMaxWidth()
                    .clip(AgentoShapes.SurfaceSmallShape)
                    .background(colors.strongSurface)
                    .border(0.75.dp, colors.subtleOutline, AgentoShapes.SurfaceSmallShape)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
                Text(
                    text = stringResource(bannerRes),
                    color = colors.secondaryContent,
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                )
            }
        }

        if (board.messages.isEmpty()) {
            Text(
                text = stringResource(R.string.organization_swarm_empty_board),
                color = colors.secondaryContent,
                fontSize = 13.sp,
                lineHeight = 20.sp,
            )
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                board.messages.forEach { message ->
                    BoardMessageCard(
                        message = message,
                        canReply = showOwnerComposer,
                        onReply = { onSelectReplySeq(message.seq) },
                    )
                }
            }
        }

        if (showOwnerComposer) {
            Column(
                modifier = Modifier
                    .testTag("swarm-board-composer")
                    .fillMaxWidth()
                    .padding(top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                board.replyToSeq?.let { replySeq ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(AgentoShapes.SurfaceSmallShape)
                            .background(colors.strongSurface)
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = stringResource(R.string.organization_swarm_replying_to, replySeq),
                            color = colors.actionPrimary,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                        )
                        Box(
                            modifier = Modifier
                                .heightIn(min = 48.dp)
                                .clickable { onSelectReplySeq(null) }
                                .padding(horizontal = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = stringResource(R.string.organization_swarm_cancel_reply),
                                color = colors.secondaryContent,
                                fontSize = 12.sp,
                            )
                        }
                    }
                }
                board.postError?.takeIf { it.isNotBlank() }?.let { err ->
                    Text(
                        text = err,
                        color = colors.error,
                        fontSize = 12.sp,
                        lineHeight = 16.sp,
                    )
                }
                val targetChannel = board.selectedChannel.takeIf { it != "__all__" }?.let { "#$it" } ?: "#main"
                AgentoTextField(
                    value = board.composerDraft,
                    onValueChange = onComposerDraftChange,
                    label = stringResource(R.string.organization_swarm_composer_placeholder, targetChannel),
                    enabled = !board.isPosting,
                    singleLine = false,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    AgentoButton(
                        text = stringResource(R.string.organization_swarm_send),
                        onClick = onPostMessage,
                        enabled = !board.isPosting && board.composerDraft.isNotBlank(),
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
        }
    }
}

internal fun formatBoardChannelChipLabel(tab: SwarmBoardChannelTabUiState): String =
    if (tab.messageCount > 0) "${tab.label} (${tab.messageCount})" else tab.label

internal fun shouldShowBoardChannelUnreadBadge(tab: SwarmBoardChannelTabUiState): Boolean =
    tab.unreadCount > 0 && tab.unreadCount < tab.messageCount

@Composable
private fun BoardChannelChip(
    tab: SwarmBoardChannelTabUiState,
    onClick: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val bg = if (tab.selected) colors.actionPrimary else colors.strongSurface
    val textColor = if (tab.selected) colors.actionPrimaryContent else colors.primaryContent
    val labelText = formatBoardChannelChipLabel(tab)
    val showUnread = shouldShowBoardChannelUnreadBadge(tab)
    Box(
        modifier = Modifier
            .testTag("board-channel-${tab.id}")
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .clip(AgentoShapes.PillShape)
                .background(bg)
                .padding(horizontal = 12.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = labelText,
                color = textColor,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                fontWeight = if (tab.selected) FontWeight.SemiBold else FontWeight.Medium,
            )
            if (showUnread) {
                val badgeBg = if (tab.selected) {
                    colors.actionPrimaryContent.copy(alpha = 0.18f)
                } else {
                    colors.actionPrimary.copy(alpha = 0.14f)
                }
                val badgeColor = if (tab.selected) colors.actionPrimaryContent else colors.actionPrimary
                Text(
                    text = stringResource(R.string.organization_swarm_unread_badge, tab.unreadCount),
                    color = badgeColor,
                    fontSize = 10.sp,
                    lineHeight = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .testTag("board-channel-unread-${tab.id}")
                        .clip(AgentoShapes.PillShape)
                        .background(badgeBg)
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BoardMessageCard(
    message: SwarmBoardMessageUiState,
    canReply: Boolean,
    onReply: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val borderColor = if (message.isStallAlert) colors.error.copy(alpha = 0.4f) else colors.subtleOutline
    Column(
        modifier = Modifier
            .testTag("board-message-seq-${message.seq}")
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(colors.canvas.copy(alpha = 0.72f))
            .border(0.75.dp, borderColor, AgentoShapes.SurfaceSmallShape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "#${message.seq}",
                color = colors.actionPrimary,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "#${message.channel}",
                color = colors.secondaryContent,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = message.senderName,
                color = colors.primaryContent,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            message.senderHarness?.let { harness ->
                OverviewPill(text = harness, accent = colors.actionPrimary)
            }
            if (message.isDoneSignal) {
                OverviewPill(text = "[done]", accent = colors.success, emphasized = true)
            }
            if (message.isStallAlert) {
                OverviewPill(text = "[stall]", accent = colors.error, emphasized = true)
            }
        }

        if (message.replyToSeq != null) {
            Text(
                text = "↳ #${message.replyToSeq}",
                color = colors.secondaryContent,
                fontSize = 11.sp,
            )
        }

        if (message.bodyMarkdown.isNotBlank()) {
            Text(
                text = message.bodyMarkdown,
                color = colors.primaryContent,
                fontSize = 13.sp,
                lineHeight = 19.sp,
            )
        }

        if (message.artifactLabels.isNotEmpty() || canReply) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                FlowRow(
                    modifier = Modifier.weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    message.artifactLabels.forEach { label ->
                        OverviewPill(text = label, accent = colors.secondaryContent)
                    }
                }
                if (canReply) {
                    Box(
                        modifier = Modifier
                            .testTag("board-reply-seq-${message.seq}")
                            .heightIn(min = 48.dp)
                            .clickable(onClick = onReply)
                            .padding(horizontal = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = stringResource(R.string.organization_swarm_reply),
                            color = colors.actionPrimary,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }
            }
        }
    }
}
