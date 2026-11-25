package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.ui.graphics.Shape
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

/** Shared frosted-glass container for floating connection status chrome. */
@Composable
private fun ConnectionStatusFrostedShell(
    shape: Shape,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
    interactionModifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    content: @Composable BoxScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val borderColor = if (isDark) {
        AgentoFrostedTokens.SubtleHairline
    } else {
        AgentoFrostedTokens.LightSubtleHairline
    }
    var shellPosition by remember { mutableStateOf(IntOffset.Zero) }
    val backdropOffset = IntOffset(
        x = backdropOrigin.x - shellPosition.x,
        y = backdropOrigin.y - shellPosition.y,
    )

    AgentoFrostedGlassBox(
        modifier = modifier
            .ragentComposerShadow(shape = shape)
            .clip(shape)
            .border(0.5.dp, borderColor, shape)
            .then(interactionModifier)
            .onGloballyPositioned { coordinates ->
                val position = coordinates.positionInRoot()
                shellPosition = IntOffset(
                    x = position.x.roundToInt(),
                    y = position.y.roundToInt(),
                )
            },
        shape = shape,
        surface = AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        showTopHairline = true,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        backdropTone = AgentoBackdropTone.QuietHeader,
        material = AgentoGlassMaterial.LiquidClear,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        contentAlignment = contentAlignment,
        hasShadow = false,
        content = content,
    )
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
    val label = stringResource(connectionStatusLabelRes(connection, activeCarrier))
    val accent = connectionStatusAccentColor(connection)
    val isConnecting = connection == AgentConnectionStatus.Connecting ||
        connection == AgentConnectionStatus.Reconnecting
    val interactive = onClick != null && connection != AgentConnectionStatus.Connected

    Box(modifier = modifier) {
        ConnectionStatusFrostedShell(
            shape = AgentoShapes.PillShape,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = Modifier.testTag("connection-status-pill"),
            interactionModifier = if (interactive) {
                Modifier
                    .agentoPressScale(
                        pressedScale = 0.96f,
                        onClick = onClick!!,
                    )
                    .semantics { role = Role.Button }
            } else {
                Modifier
            },
            contentAlignment = Alignment.Center,
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
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
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

    Box(modifier = modifier.fillMaxWidth()) {
        ConnectionStatusFrostedShell(
            shape = RoundedCornerShape(14.dp),
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("connection-status-banner"),
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
}
