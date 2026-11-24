package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.network.ActiveCarrier

@Composable
internal fun ConnectionStatusPill(
    connection: AgentConnectionStatus,
    activeCarrier: ActiveCarrier,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    val colors = LocalRagentColors.current
    val labelRes = when (connection) {
        AgentConnectionStatus.Connected -> when (activeCarrier) {
            ActiveCarrier.Direct -> R.string.connection_carrier_direct
            ActiveCarrier.P2P -> R.string.connection_carrier_p2p
            ActiveCarrier.Turn -> R.string.connection_carrier_turn
            ActiveCarrier.None -> R.string.connection_status_connected
        }
        AgentConnectionStatus.Connecting -> R.string.connection_status_connecting
        AgentConnectionStatus.Reconnecting -> R.string.connection_status_reconnecting
        AgentConnectionStatus.AuthenticationRequired -> R.string.connection_status_auth_required
        AgentConnectionStatus.Disconnected,
        AgentConnectionStatus.Error,
        -> R.string.connection_status_offline
    }
    val label = stringResource(labelRes)
    val accent = when (connection) {
        AgentConnectionStatus.Connected -> AgentoFrostedTokens.StatusActive
        AgentConnectionStatus.Connecting,
        AgentConnectionStatus.Reconnecting,
        -> AgentoFrostedTokens.StatusAttention
        AgentConnectionStatus.AuthenticationRequired,
        AgentConnectionStatus.Error,
        -> colors.stateError
        AgentConnectionStatus.Disconnected -> colors.secondaryContent
    }
    val isConnecting = connection == AgentConnectionStatus.Connecting ||
        connection == AgentConnectionStatus.Reconnecting
    val interactive = onClick != null && connection != AgentConnectionStatus.Connected

    Surface(
        modifier = modifier
            .testTag("connection-status-pill")
            .clip(AgentoShapes.PillShape)
            .then(if (interactive) Modifier.clickable(onClick = onClick!!) else Modifier),
        shape = AgentoShapes.PillShape,
        color = accent.copy(alpha = if (connection == AgentConnectionStatus.Disconnected) 0.12f else 0.14f),
        border = BorderStroke(0.5.dp, accent.copy(alpha = 0.28f)),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            if (isConnecting) {
                AgentoBreathingDot(color = accent, size = 6.dp)
            } else {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(accent),
                )
            }
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
                color = if (connection == AgentConnectionStatus.Disconnected) colors.secondaryContent else accent,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun ConnectionStatusBanner(
    connection: AgentConnectionStatus,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (connection == AgentConnectionStatus.Connected) return
    val colors = LocalRagentColors.current
    val messageRes = when (connection) {
        AgentConnectionStatus.Connecting -> R.string.home_connection_connecting
        AgentConnectionStatus.Reconnecting -> R.string.home_connection_reconnecting
        AgentConnectionStatus.Disconnected -> R.string.journey_connection_uncertain
        AgentConnectionStatus.AuthenticationRequired -> R.string.home_connection_authentication_required
        AgentConnectionStatus.Error -> R.string.home_connection_failed
        AgentConnectionStatus.Connected -> return
    }
    val accent = when (connection) {
        AgentConnectionStatus.AuthenticationRequired,
        AgentConnectionStatus.Error,
        -> Color(0xFFFF3B30)
        AgentConnectionStatus.Connecting,
        AgentConnectionStatus.Reconnecting,
        -> AgentoFrostedTokens.StatusAttention
        AgentConnectionStatus.Disconnected,
        AgentConnectionStatus.Connected,
        -> colors.secondaryContent
    }
    val reconnectLabel = stringResource(R.string.workbench_reconnect)

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .testTag("connection-status-banner"),
        shape = RoundedCornerShape(14.dp),
        color = colors.quietSurface,
        border = BorderStroke(0.5.dp, colors.subtleOutline),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Info,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = accent,
            )
            Text(
                text = stringResource(messageRes),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = colors.primaryContent,
            )
            TextButton(
                onClick = onReconnect,
                modifier = Modifier
                    .semantics { contentDescription = reconnectLabel }
                    .testTag("connection-status-reconnect"),
                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.accentPrimary),
            ) {
                Text(
                    text = reconnectLabel,
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}
