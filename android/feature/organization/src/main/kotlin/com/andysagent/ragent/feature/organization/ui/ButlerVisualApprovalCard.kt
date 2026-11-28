package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.VoiceApprovalCardDto

@Composable
fun ButlerVisualApprovalDialog(
    card: VoiceApprovalCardDto,
    busy: Boolean,
    error: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    onOpenDetails: ((String, String?) -> Unit)? = null,
) {
    Dialog(
        onDismissRequest = { if (!busy) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 24.dp),
            shape = AgentoShapes.SurfaceLargeShape,
            color = LocalRagentColors.current.surfaceLow,
            tonalElevation = 6.dp,
        ) {
            ButlerVisualApprovalCardContent(
                card = card,
                busy = busy,
                error = error,
                onConfirm = onConfirm,
                onDismiss = onDismiss,
                onOpenDetails = onOpenDetails,
                modifier = Modifier
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ButlerVisualApprovalCardContent(
    card: VoiceApprovalCardDto,
    busy: Boolean,
    error: String?,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    onOpenDetails: ((String, String?) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val hasDirectEndpoint = card.confirmationEndpoint != null && card.confirmationEndpoint.path.isNotBlank()
    val isHighRisk = card.riskLevel in setOf("irreversible_write", "external_broadcast", "critical", "high")

    Column(
        modifier = modifier.testTag("butler-visual-approval-card"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentoWebIcon(
                glyph = if (isHighRisk) AgentoWebGlyph.ShieldSolid else AgentoWebGlyph.Shield,
                contentDescription = null,
                tint = if (isHighRisk) colors.error else colors.actionPrimary,
                modifier = Modifier.size(24.dp),
            )
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.butler_approval_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = colors.primaryContent,
                )
                if (card.title.isNotBlank()) {
                    Text(
                        text = card.title,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.secondaryContent,
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(AgentoShapes.SurfaceSmallShape)
                .background((if (isHighRisk) colors.error else colors.actionPrimary).copy(alpha = 0.12f))
                .border(
                    0.75.dp,
                    (if (isHighRisk) colors.error else colors.actionPrimary).copy(alpha = 0.35f),
                    AgentoShapes.SurfaceSmallShape,
                )
                .padding(12.dp),
        ) {
            Text(
                text = stringResource(R.string.butler_approval_voice_guard),
                style = MaterialTheme.typography.bodySmall,
                color = colors.primaryContent,
            )
        }

        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (card.kind.isNotBlank()) {
                ApprovalTagPill(label = card.kind, accent = colors.actionPrimary)
            }
            card.riskLevel?.takeIf { it.isNotBlank() }?.let { risk ->
                ApprovalTagPill(
                    label = risk,
                    accent = if (isHighRisk) colors.error else colors.waiting,
                )
            }
            card.expectedVersion?.let { version ->
                ApprovalTagPill(label = "v$version", accent = colors.secondaryContent)
            }
            ApprovalTagPill(label = card.confirmationPolicy, accent = colors.secondaryContent)
        }

        HorizontalDivider(color = colors.subtleOutline)

        ApprovalField(
            label = stringResource(R.string.butler_approval_target),
            value = card.target.ifBlank { card.responsibilityId ?: "—" },
        )

        ApprovalField(
            label = stringResource(R.string.butler_approval_impact),
            value = card.impactSummary.ifBlank { "Requires explicit owner confirmation before any execution." },
        )

        card.diffSummary?.takeIf { it.isNotBlank() }?.let { diff ->
            ApprovalField(
                label = stringResource(R.string.butler_approval_diff),
                value = diff,
                monospace = true,
            )
        }

        val digestValue = card.actionDigest?.takeIf { it.isNotBlank() }
            ?: card.proposalDigest?.takeIf { it.isNotBlank() }
        if (digestValue != null) {
            ApprovalField(
                label = stringResource(R.string.butler_approval_digest),
                value = digestValue,
                monospace = true,
            )
        }

        val idsSummary = listOfNotNull(
            card.responsibilityId?.takeIf { it.isNotBlank() }?.let { "responsibility: $it" },
            card.planId?.takeIf { it.isNotBlank() }?.let { "plan: $it" },
            card.workItemId?.takeIf { it.isNotBlank() }?.let { "workItem: $it" },
            card.connectorId?.takeIf { it.isNotBlank() }?.let { "connector: $it" },
        ).joinToString(" · ")
        if (idsSummary.isNotBlank()) {
            Text(
                text = idsSummary,
                style = MaterialTheme.typography.labelSmall,
                color = colors.secondaryContent,
                fontFamily = FontFamily.Monospace,
            )
        }

        if (!error.isNullOrBlank()) {
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = colors.error,
                modifier = Modifier.testTag("butler-approval-error"),
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentoButton(
                text = stringResource(R.string.butler_approval_cancel),
                onClick = onDismiss,
                enabled = !busy,
                secondary = true,
                modifier = Modifier.weight(1f),
            )
            if (hasDirectEndpoint) {
                AgentoButton(
                    text = stringResource(R.string.butler_approval_confirm),
                    onClick = onConfirm,
                    enabled = !busy && card.requiresExplicitConfirm && !card.executableViaVoice,
                    decision = true,
                    destructive = isHighRisk,
                    leadingIcon = if (busy) {
                        { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) }
                    } else null,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("butler-approval-confirm-button"),
                )
            } else if (onOpenDetails != null && !card.responsibilityId.isNullOrBlank()) {
                AgentoButton(
                    text = stringResource(R.string.butler_approval_manual_only),
                    onClick = {
                        onDismiss()
                        onOpenDetails(card.responsibilityId, card.planId)
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun ApprovalField(
    label: String,
    value: String,
    monospace: Boolean = false,
) {
    val colors = LocalRagentColors.current
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = colors.secondaryContent,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            color = colors.primaryContent,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
        )
    }
}

@Composable
private fun ApprovalTagPill(
    label: String,
    accent: androidx.compose.ui.graphics.Color,
) {
    Box(
        modifier = Modifier
            .clip(AgentoShapes.PillShape)
            .background(accent.copy(alpha = 0.14f))
            .border(0.75.dp, accent.copy(alpha = 0.35f), AgentoShapes.PillShape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = accent,
            fontWeight = FontWeight.Medium,
        )
    }
}
