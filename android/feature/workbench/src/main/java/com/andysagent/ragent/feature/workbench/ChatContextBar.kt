package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.agentui.AgentRunStatus
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoMotion
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens

/**
 * ChatContextBar: Layer A of the Ragent Task Workspace.
 *
 * Replaces the transitional "three floating bubbles" with an integrated, quiet
 * context bar. It informs the user:
 * - What project they are in
 * - What session they are in
 * - Current agent status (Working, Needs approval, Needs attention, or Idle)
 *
 * When scrolled (>24dp), background smoothly gains edge separation and the
 * title condenses to the session title while keeping click targets fixed.
 */
@Composable
fun ChatContextBar(
    sessionTitle: String,
    status: AgentRunStatus,
    onBack: () -> Unit,
    onMenu: () -> Unit,
    modifier: Modifier = Modifier,
    projectName: String? = null,
    hasAttentionOrError: Boolean = false,
    isScrolled: Boolean = false,
    menuEnabled: Boolean = true,
    backdropLayer: GraphicsLayer? = null,
    backContentDescription: String? = null,
    moreContentDescription: String? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    val rawTitle = sessionTitle.trim()
    val isNewSession = rawTitle.isBlank() || rawTitle.equals("New session", ignoreCase = true) || rawTitle.equals("Session", ignoreCase = true)
    val displaySessionTitle = if (isNewSession) {
        stringResource(AgentUiR.string.agentui_new_conversation)
    } else {
        rawTitle
    }

    val displayProject = projectName?.trim()?.takeIf { it.isNotBlank() }

    // When scrolled > 24dp, title shortens to session name alone; otherwise shows project / session
    val headerTitleText = if (isScrolled || displayProject == null) {
        if (isNewSession && displayProject == null) "New task" else displaySessionTitle
    } else {
        "$displayProject / $displaySessionTitle"
    }

    val resolvedBackDescription = backContentDescription ?: stringResource(AgentUiR.string.agentui_back)
    val resolvedMoreDescription = moreContentDescription ?: stringResource(AgentUiR.string.agentui_session_actions)

    // Background transition when content scrolls under
    val targetBgColor = if (isScrolled) {
        if (isDark) {
            Color(0xFF18181B).copy(alpha = 0.88f)
        } else {
            Color(0xFFFAFAFA).copy(alpha = 0.92f)
        }
    } else {
        Color.Transparent
    }

    val animatedBgColor by animateColorAsState(
        targetValue = targetBgColor,
        animationSpec = tween(durationMillis = AgentoMotion.StateChange),
        label = "contextBarBg",
    )

    val bottomBorderColor by animateColorAsState(
        targetValue = if (isScrolled) {
            if (isDark) Color(0x26FFFFFF) else Color(0x14000000)
        } else {
            Color.Transparent
        },
        animationSpec = tween(durationMillis = AgentoMotion.StateChange),
        label = "contextBarBorder",
    )

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = animatedBgColor,
        border = if (isScrolled) BorderStroke(0.5.dp, bottomBorderColor) else null,
        shadowElevation = 0.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp)
                    .padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                // Left: 44dp Back tap target
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(CircleShape)
                        .agentoPressScale(
                            pressedScale = 0.92f,
                            onClick = onBack,
                        )
                        .semantics { contentDescription = resolvedBackDescription },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Back,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = colors.primaryContent,
                    )
                }

                // Middle: Context Title & Semantic Status Dot
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text = headerTitleText,
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = (-0.2).sp,
                        ),
                        color = colors.primaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )

                    // Semantic Status Indicator
                    when {
                        status == AgentRunStatus.Working -> {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = "·",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.secondaryContent,
                            )
                            Spacer(Modifier.width(6.dp))
                            AgentoBreathingDot(
                                color = colors.stateRunning,
                                size = 6.dp,
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                text = "Working",
                                style = MaterialTheme.typography.labelMedium.copy(
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                ),
                                color = colors.stateRunning,
                                maxLines = 1,
                            )
                        }
                        status == AgentRunStatus.WaitingApproval -> {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = "·",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.secondaryContent,
                            )
                            Spacer(Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFFF59E0B)),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                text = "Needs approval",
                                style = MaterialTheme.typography.labelMedium.copy(
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                ),
                                color = Color(0xFFF59E0B),
                                maxLines = 1,
                            )
                        }
                        hasAttentionOrError -> {
                            Spacer(Modifier.width(6.dp))
                            Text(
                                text = "·",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.secondaryContent,
                            )
                            Spacer(Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(colors.error),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                text = "Needs attention",
                                style = MaterialTheme.typography.labelMedium.copy(
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Medium,
                                ),
                                color = colors.error,
                                maxLines = 1,
                            )
                        }
                        else -> {
                            // Idle: do NOT display any status text or dot!
                        }
                    }
                }

                // Right: 44dp More Actions button
                Box(
                    modifier = Modifier
                        .size(44.dp)
                        .clip(CircleShape)
                        .then(
                            if (menuEnabled) {
                                Modifier.agentoPressScale(
                                    pressedScale = 0.92f,
                                    onClick = onMenu,
                                )
                            } else Modifier
                        )
                        .semantics { contentDescription = resolvedMoreDescription },
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Settings,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp),
                        tint = if (menuEnabled) colors.primaryContent else colors.disabledContent,
                    )
                }
            }
        }
    }
}
