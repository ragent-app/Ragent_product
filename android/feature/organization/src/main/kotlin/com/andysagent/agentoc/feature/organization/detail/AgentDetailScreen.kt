package com.andysagent.agentoc.feature.organization.detail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoColors
import com.andysagent.agentoc.core.designsystem.AgentoConversationTypography
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.feature.organization.presentation.NodeDetailUiState

@Composable
fun AgentDetailScreen(
    node: NodeDetailUiState,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas)
            .statusBarsPadding()
            .navigationBarsPadding(),
    ) {
        // Top bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = AgentoSpacing.base, vertical = AgentoSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentoIconButton(
                onClick = onBack,
                contentDescription = "Back to organization radar",
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Back,
                    contentDescription = null,
                    tint = colors.primaryContent,
                )
            }

            Spacer(modifier = Modifier.width(AgentoSpacing.sm))

            Text(
                text = node.displayName,
                style = AgentoConversationTypography.Heading3,
                color = colors.primaryContent,
                modifier = Modifier.weight(1f),
            )
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = AgentoSpacing.base, vertical = AgentoSpacing.sm),
        ) {
            // Role & Status section
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "${node.role.name} · ${node.domain.name}",
                        style = AgentoConversationTypography.Meta,
                        color = colors.secondaryContent,
                    )
                    if (!node.sessionId.isNullOrBlank()) {
                        Text(
                            text = "Session: ${node.sessionId}",
                            style = AgentoConversationTypography.Code.copy(fontSize = 11.sp),
                            color = colors.tertiaryContent,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(colors.strongSurface)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(
                        text = node.runtimeState.name,
                        color = when (node.runtimeState) {
                            com.andysagent.agentoc.feature.organization.domain.NodeRuntimeState.WORKING -> colors.running
                            com.andysagent.agentoc.feature.organization.domain.NodeRuntimeState.DONE -> colors.success
                            com.andysagent.agentoc.feature.organization.domain.NodeRuntimeState.BLOCKED -> colors.error
                            else -> colors.secondaryContent
                        },
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.base))

            // Current Task Card
            SectionCard(title = "Current Task") {
                Text(
                    text = node.currentTaskSummary ?: "No active task",
                    style = AgentoConversationTypography.BodyStrong,
                    color = colors.primaryContent,
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = node.currentTaskDetail ?: "",
                    style = AgentoConversationTypography.Body,
                    color = colors.secondaryContent,
                )
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.md))

            // Current Activity (ToolCall / execution)
            SectionCard(title = "Current Activity") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Terminal,
                        contentDescription = null,
                        tint = colors.running,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(modifier = Modifier.width(AgentoSpacing.sm))
                    Text(
                        text = node.currentActivity ?: "Idle",
                        style = AgentoConversationTypography.Code,
                        color = colors.primaryContent,
                    )
                }
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.md))

            // Changed Files
            SectionCard(title = "Changed Files (${node.changedFiles.size})") {
                node.changedFiles.forEach { file ->
                    Row(
                        modifier = Modifier.padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.File,
                            contentDescription = null,
                            tint = colors.secondaryContent,
                            modifier = Modifier.size(14.dp),
                        )
                        Spacer(modifier = Modifier.width(6.dp))
                        Text(
                            text = file,
                            style = AgentoConversationTypography.Code.copy(fontSize = 12.sp),
                            color = colors.primaryContent,
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.md))

            // ResultPacket (if completed)
            if (!node.resultPacketSummary.isNullOrBlank()) {
                SectionCard(title = "Result Packet") {
                    Text(
                        text = node.resultPacketSummary,
                        style = AgentoConversationTypography.Body,
                        color = colors.primaryContent,
                    )
                }
                Spacer(modifier = Modifier.height(AgentoSpacing.md))
            }

            // Blocker (if blocked)
            if (!node.blockerText.isNullOrBlank()) {
                SectionCard(title = "Active Blocker") {
                    Text(
                        text = node.blockerText,
                        style = AgentoConversationTypography.BodyStrong,
                        color = colors.error,
                    )
                }
                Spacer(modifier = Modifier.height(AgentoSpacing.md))
            }

            Spacer(modifier = Modifier.height(AgentoSpacing.xl))
        }
    }
}

@Composable
private fun SectionCard(
    title: String,
    content: @Composable () -> Unit,
) {
    val colors = LocalAgentocColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceMediumShape)
            .background(colors.quietSurface)
            .padding(AgentoSpacing.md),
    ) {
        Text(
            text = title,
            style = AgentoConversationTypography.Meta,
            color = colors.secondaryContent,
        )
        Spacer(modifier = Modifier.height(AgentoSpacing.xs))
        content()
    }
}
