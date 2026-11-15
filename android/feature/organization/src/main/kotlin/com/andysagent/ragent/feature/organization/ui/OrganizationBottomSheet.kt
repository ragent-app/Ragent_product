package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.RagentapsuleGlassBox
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.NodeDetailUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrganizationBottomSheet(
    node: NodeDetailUiState,
    onDismiss: () -> Unit,
    onViewDetails: () -> Unit,
    onSendInstruction: (() -> Unit)? = null,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = Color.Transparent,
        dragHandle = null,
        shape = AgentoShapes.BottomSheetShape,
        scrimColor = colors.glassScrim.copy(alpha = if (isDark) 0.22f else 0.18f),
    ) {
        RagentapsuleGlassBox(modifier = Modifier.fillMaxWidth(), shape = AgentoShapes.BottomSheetShape) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = AgentoSpacing.lg)
                .navigationBarsPadding()
                .padding(bottom = AgentoSpacing.md),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).padding(top = 12.dp, bottom = 16.dp)
                .size(width = 36.dp, height = 4.dp).clip(CircleShape).background(colors.secondaryContent.copy(alpha = 0.32f)))
            // Header: Name + Status badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(
                        text = node.displayName,
                        style = RagentonversationTypography.Heading3,
                        color = colors.primaryContent,
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = "${node.role.name.lowercase().replaceFirstChar { it.uppercase() }} · ${node.domain.name.lowercase().replaceFirstChar { it.uppercase() }}",
                        style = RagentonversationTypography.Meta,
                        color = colors.secondaryContent,
                    )
                }

                StatusPill(runtimeState = node.runtimeState)
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.base))

            // Current Task Card
            InfoSection(
                label = "Current Task",
                value = node.currentTaskSummary ?: "No active task assigned.",
            )

            Spacer(modifier = Modifier.height(AgentoSpacing.sm))

            // Current Activity
            if (!node.currentActivity.isNullOrBlank()) {
                InfoSection(
                    label = "Current Activity",
                    value = node.currentActivity,
                )
                Spacer(modifier = Modifier.height(AgentoSpacing.sm))
            }

            // Progress & Tests Row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(AgentoSpacing.md),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    InfoSection(
                        label = "Acceptance",
                        value = "${node.progressCompleted} / ${node.progressTotal} items",
                    )
                }
            }

            // Blocker (if present)
            if (!node.blockerText.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(AgentoSpacing.sm))
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(AgentoShapes.SurfaceSmallShape)
                        .background(colors.error.copy(alpha = 0.12f))
                        .padding(AgentoSpacing.sm),
                ) {
                    Text(
                        text = "Blocker: ${node.blockerText}",
                        color = colors.error,
                        style = RagentonversationTypography.BodyStrong,
                    )
                }
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.lg))

            // Action buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(AgentoSpacing.sm),
            ) {
                if (node.isRootLeader && onSendInstruction != null) {
                    AgentoButton(
                        text = "Send instruction",
                        onClick = {
                            onDismiss()
                            onSendInstruction()
                        },
                        modifier = Modifier.weight(1f),
                        secondary = false,
                    )
                }

                AgentoButton(
                    text = "View Details",
                    onClick = onViewDetails,
                    modifier = Modifier.weight(1f),
                    secondary = node.isRootLeader,
                )
            }
        }
        }
    }
}

@Composable
private fun InfoSection(label: String, value: String) {
    val colors = LocalRagentColors.current
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceSmallShape)
            .background(colors.strongSurface)
            .padding(horizontal = AgentoSpacing.md, vertical = AgentoSpacing.sm),
    ) {
        Column {
            Text(
                text = label,
                style = RagentonversationTypography.Meta,
                color = colors.secondaryContent,
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = value,
                style = RagentonversationTypography.Body,
                color = colors.primaryContent,
            )
        }
    }
}

@Composable
private fun StatusPill(runtimeState: NodeRuntimeState) {
    val colors = LocalRagentColors.current
    val (dotColor, text) = when (runtimeState) {
        NodeRuntimeState.WORKING -> colors.running to "Working"
        NodeRuntimeState.WAITING -> colors.waiting to "Waiting"
        NodeRuntimeState.BLOCKED -> colors.error to "Blocked"
        NodeRuntimeState.REVIEWING -> colors.waiting to "Reviewing"
        NodeRuntimeState.DONE -> colors.success to "Done"
        NodeRuntimeState.FAILED -> colors.error to "Failed"
        NodeRuntimeState.PROVISIONING -> colors.secondaryContent to "Provisioning"
        else -> colors.secondaryContent to "Idle"
    }

    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(dotColor.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(dotColor),
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = text,
            color = dotColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}
