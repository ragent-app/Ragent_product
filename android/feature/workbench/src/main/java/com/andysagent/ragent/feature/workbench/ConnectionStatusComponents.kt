package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.AgentoBackdropTone
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.ragentComposerShadow
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.network.ActiveCarrier
import kotlin.math.roundToInt

internal fun connectionCarrierLabelRes(activeCarrier: ActiveCarrier): Int? = when (activeCarrier) {
    ActiveCarrier.Direct -> R.string.connection_carrier_direct
    ActiveCarrier.P2P -> R.string.connection_carrier_p2p
    ActiveCarrier.Turn -> R.string.connection_carrier_turn
    ActiveCarrier.None -> null
}

internal fun connectionStatusLabelRes(
    connection: AgentConnectionStatus,
    activeCarrier: ActiveCarrier,
): Int = when (connection) {
    AgentConnectionStatus.Connected ->
        connectionCarrierLabelRes(activeCarrier) ?: R.string.connection_status_connected
    AgentConnectionStatus.Connecting -> R.string.connection_status_connecting
    AgentConnectionStatus.Reconnecting -> R.string.connection_status_reconnecting
    AgentConnectionStatus.AuthenticationRequired -> R.string.connection_status_auth_required
    AgentConnectionStatus.Disconnected,
    AgentConnectionStatus.Error,
    -> R.string.connection_status_offline
}

@Composable
internal fun connectionStatusAccentColor(connection: AgentConnectionStatus): Color {
    val colors = LocalRagentColors.current
    return when (connection) {
        AgentConnectionStatus.Connected -> AgentoFrostedTokens.StatusActive
        AgentConnectionStatus.Connecting,
        AgentConnectionStatus.Reconnecting,
        -> AgentoFrostedTokens.StatusAttention
        AgentConnectionStatus.AuthenticationRequired,
        AgentConnectionStatus.Error,
        -> colors.stateError
        AgentConnectionStatus.Disconnected -> colors.secondaryContent
    }
}

@Composable
internal fun ConnectionStatusPill(
    connection: AgentConnectionStatus,
    activeCarrier: ActiveCarrier,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val label = stringResource(connectionStatusLabelRes(connection, activeCarrier))
    val accent = connectionStatusAccentColor(connection)
    val isConnecting = connection == AgentConnectionStatus.Connecting ||
        connection == AgentConnectionStatus.Reconnecting
    val interactive = onClick != null && connection != AgentConnectionStatus.Connected
    val borderColor = if (isDark) {
        AgentoFrostedTokens.SubtleHairline
    } else {
        AgentoFrostedTokens.LightSubtleHairline
    }
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    Box(modifier = modifier) {
        AgentoFrostedGlassBox(
            modifier = Modifier
                .testTag("connection-status-pill")
                .ragentComposerShadow(shape = AgentoShapes.PillShape)
                .clip(AgentoShapes.PillShape)
                .border(0.5.dp, borderColor, AgentoShapes.PillShape)
                .then(
                    if (interactive) {
                        Modifier
                            .agentoPressScale(
                                pressedScale = 0.96f,
                                onClick = onClick!!,
                            )
                            .semantics { role = Role.Button }
                    } else {
                        Modifier
                    },
                )
                .onGloballyPositioned { coordinates ->
                    val position = coordinates.positionInRoot()
                    backdropOffset = IntOffset(
                        x = backdropOrigin.x - position.x.roundToInt(),
                        y = backdropOrigin.y - position.y.roundToInt(),
                    )
                },
            shape = AgentoShapes.PillShape,
            surface = AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            backdropLayer = backdropLayer,
            backdropOffset = backdropOffset,
            backdropTone = AgentoBackdropTone.QuietHeader,
            material = AgentoGlassMaterial.LiquidClear,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            contentAlignment = Alignment.Center,
            hasShadow = false,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
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
                    color = if (connection == AgentConnectionStatus.Disconnected) colors.secondaryContent else colors.primaryContent,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                )
            }
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
