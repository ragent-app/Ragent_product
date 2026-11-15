package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.detail.AgentDetailScreen
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel

@Composable
fun OrganizationScreen(
    viewModel: OrganizationViewModel,
    modifier: Modifier = Modifier,
    onSendRootInstruction: (() -> Unit)? = null,
) {
    val uiState = viewModel.uiState.collectAsState().value
    OrganizationScreenContent(
        uiState = uiState,
        onPan = viewModel::onPan,
        onZoom = viewModel::onZoom,
        onReset = viewModel::onResetView,
        onNodeClick = viewModel::onNodeClicked,
        onNodeDoubleTap = viewModel::onNodeDoubleTapped,
        onDismissSheet = viewModel::onDismissSheet,
        onOpenDetail = viewModel::onOpenAgentDetail,
        onCloseDetail = viewModel::onCloseAgentDetail,
        onToggleActivityFeed = viewModel::onToggleActivityFeed,
        onApproveBlocker = viewModel::onApproveBlocker,
        onRejectBlocker = viewModel::onRejectBlocker,
        onSizeChanged = { w, h -> viewModel.updateViewportSize(w.toFloat(), h.toFloat()) },
        onSendRootInstruction = onSendRootInstruction,
        modifier = modifier,
    )
}

@Composable
fun OrganizationScreenContent(
    uiState: OrganizationUiState,
    onPan: (androidx.compose.ui.geometry.Offset) -> Unit,
    onZoom: (Float) -> Unit,
    onReset: () -> Unit,
    onNodeClick: (String) -> Unit,
    onNodeDoubleTap: (String) -> Unit,
    onDismissSheet: () -> Unit,
    onOpenDetail: (String) -> Unit,
    onCloseDetail: () -> Unit,
    onToggleActivityFeed: () -> Unit,
    onApproveBlocker: (String) -> Unit,
    onRejectBlocker: (String) -> Unit,
    onSizeChanged: (Int, Int) -> Unit = { _, _ -> },
    onSendRootInstruction: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current

    // If detail screen is open, show detail view
    if (uiState.activeDetailNode != null) {
        AgentDetailScreen(
            node = uiState.activeDetailNode,
            onBack = onCloseDetail,
        )
        return
    }

    val transformableState = rememberTransformableState { zoomChange, offsetChange, _ ->
        onZoom(zoomChange)
        onPan(offsetChange)
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas)
            .onSizeChanged { onSizeChanged(it.width, it.height) },
    ) {
        // 1. Radar Graph Layer (Canvas + Nodes)
        Box(
            modifier = Modifier
                .fillMaxSize()
                .transformable(state = transformableState)
                .graphicsLayer {
                    translationX = uiState.panOffset.x
                    translationY = uiState.panOffset.y
                    scaleX = uiState.zoomScale
                    scaleY = uiState.zoomScale
                },
        ) {
            // Edges and communication particles
            OrganizationCanvas(
                edges = uiState.edges,
                particles = uiState.particles,
                modifier = Modifier.fillMaxSize(),
            )

            // Agent Nodes
            uiState.nodes.forEach { node ->
                OrganizationNode(
                    node = node,
                    onClick = { onNodeClick(node.id) },
                    onDoubleTap = { onNodeDoubleTap(node.id) },
                )
            }
        }

        // 2. Top Bar (Objective & Status)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = AgentoSpacing.base, vertical = AgentoSpacing.xs),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = if (uiState.objective.isNotBlank()) uiState.objective else "Organization Radar",
                        style = RagentonversationTypography.BodyStrong,
                        color = colors.primaryContent,
                        maxLines = 1,
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "Revision #${uiState.revisionNumber} · ${uiState.nodes.size} agents",
                        style = RagentonversationTypography.Meta,
                        color = colors.secondaryContent,
                    )
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    AgentoIconButton(
                        onClick = onReset,
                        contentDescription = "Reset view",
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Refresh,
                            contentDescription = null,
                            tint = colors.secondaryContent,
                        )
                    }
                }
            }
        }

        // 3. Bottom Controls & Activity Feed Overlay
        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = AgentoSpacing.base, vertical = AgentoSpacing.sm),
        ) {
            // Approval Overlay if required
            if (uiState.approvalOverlay != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceMediumShape)
                        .background(colors.quietSurface)
                        .padding(AgentoSpacing.md),
                ) {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(colors.error),
                            )
                            Spacer(modifier = Modifier.width(AgentoSpacing.sm))
                            Text(
                                text = "Approval Required",
                                style = RagentonversationTypography.BodyStrong,
                                color = colors.error,
                            )
                        }
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = uiState.approvalOverlay.actionSummary,
                            style = RagentonversationTypography.Body,
                            color = colors.primaryContent,
                        )
                        Spacer(modifier = Modifier.height(AgentoSpacing.sm))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(AgentoSpacing.sm),
                        ) {
                            AgentoButton(
                                text = "Approve",
                                onClick = { onApproveBlocker(uiState.approvalOverlay.id) },
                                modifier = Modifier.weight(1f),
                                secondary = false,
                            )
                            AgentoButton(
                                text = "Reject",
                                onClick = { onRejectBlocker(uiState.approvalOverlay.id) },
                                modifier = Modifier.weight(1f),
                                secondary = true,
                            )
                        }
                    }
                }
                Spacer(modifier = Modifier.height(AgentoSpacing.sm))
            }

            // Collapsible Activity Feed
            OrganizationActivityFeed(
                items = uiState.activityFeed,
                isExpanded = uiState.isActivityFeedExpanded,
                onToggleExpanded = onToggleActivityFeed,
            )
        }

        // 4. Bottom Sheet on node selection
        if (uiState.selectedSheetNode != null) {
            OrganizationBottomSheet(
                node = uiState.selectedSheetNode,
                onDismiss = onDismissSheet,
                onViewDetails = { onOpenDetail(uiState.selectedSheetNode.id) },
                onSendInstruction = onSendRootInstruction,
            )
        }
    }
}
