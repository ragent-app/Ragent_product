package com.andysagent.agentoc.feature.workbench

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.agentui.ApprovalActionUiState
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoHaptics
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocShapes
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.roundToInt

private val selectableActionStates = setOf("proposed", "classified", "waiting_user")

/**
 * Native surface for the Web approved-action batch projection. It keeps the
 * selection manifest visible and never turns an action decision into chat
 * text. Host actions remain visible with their risk warnings; actions flagged
 * needsPasskey by the server open the Android system passkey sheet before the
 * server accepts the exact selected subset.
 */
@Composable
fun StructuredApprovalCard(
    state: PermissionRequestUiState,
    onActionSelected: (String, Boolean) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }
    val actionable = state.actions.filter {
        it.state in selectableActionStates && it.category != "software_install"
    }
    val selected = actionable.filter { it.selected }
    val passkeyRequired = selected.any { it.needsPasskey }
    val serverManagedInstall = state.actions.any { it.category == "software_install" }
    val executorUnavailable = state.executorUnavailableReasonCode == "macos_administrator_unavailable"


    AgentoFrostedGlassBox(
        shape = RoundedCornerShape(20.dp),
        surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
        showTopHairline = true,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        hasShadow = true,
        shadowElevation = 10.dp,
        modifier = modifier
            .fillMaxWidth()
            .onGloballyPositioned { coordinates ->
                val position = coordinates.positionInRoot()
                backdropOffset = IntOffset(
                    x = -position.x.roundToInt(),
                    y = -position.y.roundToInt(),
                )
            },
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            // Apple HIG Security / Warning Header Badge
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xFFFF9F0A).copy(alpha = if (isDark) 0.20f else 0.12f))
                        .border(
                            0.5.dp,
                            Color(0xFFFF9F0A).copy(alpha = if (isDark) 0.45f else 0.30f),
                            RoundedCornerShape(10.dp),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Shield,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = Color(0xFFFF9F0A),
                    )
                }
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Approval required",
                        style = AgentocTextStyles.caption.copy(
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.5.sp,
                            color = Color(0xFFFF9F0A),
                        ),
                    )
                    Text(
                        text = state.title,
                        style = AgentocTextStyles.pageTitle.copy(
                            fontSize = 17.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = colors.primaryContent,
                    )
                }
            }

            if (state.reason.isNotBlank()) {
                Text(text = state.reason, style = AgentocTextStyles.agentBody, color = colors.secondaryContent)
            }
            if (executorUnavailable) {
                Text(text = stringResource(R.string.approval_macos_executor_unavailable), style = AgentocTextStyles.caption, color = colors.secondaryContent)
            }
            val metadata = listOfNotNull(
                state.batchId?.takeIf { it.isNotBlank() }?.let { "Batch $it" },
                state.permissionMode?.takeIf { it.isNotBlank() },
                state.expiresAt?.takeIf { it.isNotBlank() }?.let { "Expires $it" },
            )
            if (metadata.isNotEmpty()) {
                Text(
                    text = metadata.joinToString(" · "),
                    style = AgentocTextStyles.caption,
                    color = colors.secondaryContent,
                )
            }

            // Inset list of actionable permissions
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                state.actions.forEach { action ->
                    StructuredApprovalActionRow(
                        action = action,
                        isDark = isDark,
                        enabled = !executorUnavailable && !state.resolving && action.state in selectableActionStates,
                        onSelected = { onActionSelected(action.id, it) },
                    )
                }
            }

            if (passkeyRequired && !executorUnavailable) {
                Text(
                    text = "Your phone's system passkey will open to approve the selected host action.",
                    style = AgentocTextStyles.caption,
                    color = colors.secondaryContent,
                )
            }
            if (serverManagedInstall && !executorUnavailable) {
                Text(
                    text = "Software installs are handled automatically by the host.",
                    style = AgentocTextStyles.caption,
                    color = colors.secondaryContent,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
            ) {
                val hapticView = LocalView.current
                AgentoButton(
                    text = state.denyLabel,
                    onClick = {
                        AgentoHaptics.performReject(hapticView)
                        onDeny()
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !state.resolving,
                    decision = true,
                    secondary = true,
                    destructive = true,
                    hapticFeedback = false,
                )
                if (!executorUnavailable) AgentoButton(
                    text = state.approveLabel,
                    onClick = {
                        AgentoHaptics.performConfirm(hapticView)
                        onApprove()
                    },
                    modifier = Modifier.weight(1f),
                    enabled = !state.resolving && selected.isNotEmpty(),
                    decision = true,
                    secondary = false,
                    hapticFeedback = false,
                )
            }
        }
    }
}

@Composable
private fun StructuredApprovalActionRow(
    action: ApprovalActionUiState,
    isDark: Boolean,
    enabled: Boolean,
    onSelected: (Boolean) -> Unit,
) {
    val colors = LocalAgentocColors.current
    val stateLabel = action.state.replace('_', ' ')
    val subcardBg = when {
        action.selected -> colors.actionPrimary.copy(alpha = if (isDark) 0.16f else 0.08f)
        isDark -> Color.White.copy(alpha = 0.04f)
        else -> Color.Black.copy(alpha = 0.03f)
    }
    val subcardBorder = if (action.selected) {
        colors.accentPrimary.copy(alpha = 0.50f)
    } else {
        if (isDark) AgentoFrostedTokens.SubtleHairline else AgentoFrostedTokens.LightSubtleHairline
    }

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = subcardBg,
        border = BorderStroke(0.5.dp, subcardBorder),
        modifier = Modifier
            .fillMaxWidth()
            .agentoPressScale(pressedScale = 0.98f, onClick = { if (enabled) onSelected(!action.selected) })
            .semantics {
                contentDescription = "${action.description}, $stateLabel"
            },
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Checkbox(
                checked = action.selected,
                onCheckedChange = if (enabled) onSelected else null,
                modifier = Modifier.size(24.dp),
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(text = action.description, style = AgentocTextStyles.agentBody, color = colors.primaryContent)
                action.explanation?.let { explanation ->
                    ApprovalExplanationContent(explanation)
                }
                val detail = listOfNotNull(
                    action.summary?.takeIf { it.isNotBlank() },
                    action.command?.takeIf { it.isNotBlank() },
                    action.category?.takeIf { it.isNotBlank() },
                    action.risk?.takeIf { it.isNotBlank() }?.let { "risk: $it" },
                    if (action.needsPasskey) "passkey required" else null,
                    stateLabel.takeIf { it != "waiting user" },
                ).joinToString(" · ")
                if (detail.isNotBlank()) {
                    Text(text = detail, style = AgentocTextStyles.caption, color = colors.secondaryContent)
                }
            }
        }
    }
}
