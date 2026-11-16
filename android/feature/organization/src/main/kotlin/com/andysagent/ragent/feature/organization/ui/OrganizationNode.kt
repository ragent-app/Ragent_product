package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.animation.LocalOrganizationAnimationClock
import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState
import kotlin.math.roundToInt

@Composable
fun OrganizationNode(
    node: RenderedNodeUiState,
    onClick: () -> Unit,
    onDoubleTap: () -> Unit = {},
    modifier: Modifier = Modifier,
    showLabel: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val clock = LocalOrganizationAnimationClock.current
    val density = LocalDensity.current

    val breathingScale = if (node.runtimeState == NodeRuntimeState.WORKING) {
        clock.nodeBreathingScale(node.id)
    } else {
        1.0f
    }

    val outerRingAlpha = if (node.runtimeState == NodeRuntimeState.WORKING) {
        clock.nodeOuterRingAlpha(node.id)
    } else if (node.runtimeState == NodeRuntimeState.BLOCKED) {
        clock.blockedPulseAlpha(node.id)
    } else {
        0.35f
    }

    val stateColor = when (node.runtimeState) {
        NodeRuntimeState.WORKING -> colors.running
        NodeRuntimeState.WAITING -> colors.waiting.copy(alpha = 0.65f)
        NodeRuntimeState.BLOCKED -> colors.error
        NodeRuntimeState.REVIEWING -> colors.waiting
        NodeRuntimeState.DONE -> colors.success
        NodeRuntimeState.FAILED -> colors.error
        NodeRuntimeState.PROVISIONING -> colors.secondaryContent.copy(alpha = 0.5f)
        NodeRuntimeState.PAUSED -> colors.secondaryContent
        NodeRuntimeState.IDLE -> colors.secondaryContent.copy(alpha = 0.8f)
    }

    val hitTargetSize = 48.dp

    Box(
        modifier = modifier
            .offset {
                // Position centered at (node.x, node.y)
                val halfHit = with(density) { (hitTargetSize / 2).toPx() }
                IntOffset((node.x - halfHit).roundToInt(), (node.y - halfHit).roundToInt())
            }
            .size(hitTargetSize)
            .semantics {
                contentDescription = node.accessibilityText
            }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        // Node circle container transformed with graphicsLayer for smooth 60/120fps breathing
        Box(
            modifier = Modifier
                .graphicsLayer {
                    scaleX = node.scale * breathingScale
                    scaleY = node.scale * breathingScale
                    alpha = if (node.runtimeState == NodeRuntimeState.WAITING) 0.55f else node.alpha
                }
                .size((node.radiusDp * 2).dp),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(modifier = Modifier.matchParentSize()) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val radius = size.width / 2f

                when (node.role) {
                    NodeRole.EXECUTIVE -> {
                        // Double ring for Root Executive
                        // Outer glow/ring
                        drawCircle(
                            color = stateColor.copy(alpha = outerRingAlpha),
                            radius = radius,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                        // Inner ring
                        drawCircle(
                            color = colors.primaryContent,
                            radius = radius * 0.72f,
                            style = Stroke(width = 2.5.dp.toPx()),
                        )
                        // Solid core
                        drawCircle(
                            color = colors.quietSurface,
                            radius = radius * 0.60f,
                        )
                    }

                    NodeRole.MANAGER -> {
                        // Single circle with distinct outer ring
                        drawCircle(
                            color = stateColor.copy(alpha = outerRingAlpha),
                            radius = radius,
                            style = Stroke(width = 2.dp.toPx()),
                        )
                        drawCircle(
                            color = colors.quietSurface,
                            radius = radius - 3.dp.toPx(),
                        )
                        drawCircle(
                            color = colors.primaryContent.copy(alpha = 0.85f),
                            radius = radius - 3.dp.toPx(),
                            style = Stroke(width = 1.5.dp.toPx()),
                        )
                    }

                    NodeRole.REVIEWER -> {
                        // Reviewer circle with optional rotation sweep if REVIEWING
                        drawCircle(
                            color = colors.quietSurface,
                            radius = radius,
                        )
                        drawCircle(
                            color = stateColor,
                            radius = radius,
                            style = Stroke(width = 1.5.dp.toPx()),
                        )
                        if (node.runtimeState == NodeRuntimeState.REVIEWING) {
                            // Sweeping outer ring
                            drawArc(
                                color = colors.running,
                                startAngle = clock.sweepRotationDeg,
                                sweepAngle = 90f,
                                useCenter = false,
                                style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round),
                            )
                        }
                    }

                    NodeRole.EXPERT -> {
                        // Lighter, dashed or subtle double ring
                        drawCircle(
                            color = stateColor.copy(alpha = 0.5f),
                            radius = radius,
                            style = Stroke(width = 1.dp.toPx()),
                        )
                        drawCircle(
                            color = colors.quietSurface,
                            radius = radius - 2.dp.toPx(),
                        )
                    }

                    NodeRole.WORKER -> {
                        // Solid clean circle
                        drawCircle(
                            color = colors.quietSurface,
                            radius = radius,
                        )
                        drawCircle(
                            color = if (node.runtimeState == NodeRuntimeState.PROVISIONING) {
                                colors.secondaryContent.copy(alpha = 0.4f)
                            } else {
                                stateColor
                            },
                            radius = radius,
                            style = Stroke(width = 1.75.dp.toPx()),
                        )
                    }
                }

                // If blocked, draw warning indicator border
                if (node.hasBlocker) {
                    drawCircle(
                        color = colors.error.copy(alpha = clock.blockedPulseAlpha(node.id)),
                        radius = radius + 3.dp.toPx(),
                        style = Stroke(width = 2.dp.toPx()),
                    )
                }
            }

            // Cluster badge or glyph in center
            if (node.isCluster) {
                Text(
                    text = "+${node.clusterCount}",
                    color = colors.primaryContent,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                )
            } else {
                // Domain Glyph
                DomainGlyph(
                    role = node.role,
                    domain = node.domain,
                    color = if (node.role == NodeRole.EXECUTIVE) colors.primaryContent else colors.secondaryContent,
                    modifier = Modifier.size((node.radiusDp * 0.9f).dp),
                )
            }
        }
        if (showLabel && !node.isCluster) {
            Text(
                text = node.displayName,
                color = colors.primaryContent,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.BottomCenter).offset(y = 22.dp)
                    .wrapContentSize(unbounded = true).width(100.dp),
            )
        }
    }
}

/**
 * Monochrome, minimal domain glyphs as specified in Section 11.
 * Highly recognizable at small sizes.
 */
@Composable
private fun DomainGlyph(
    role: NodeRole,
    domain: AgentDomain,
    color: Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val cx = w / 2f
        val cy = h / 2f

        if (role == NodeRole.REVIEWER) {
            // Checkmark glyph for Reviewer
            val path = Path().apply {
                moveTo(w * 0.28f, cy)
                lineTo(w * 0.45f, h * 0.68f)
                lineTo(w * 0.75f, h * 0.32f)
            }
            drawPath(path, color = color, style = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round))
            return@Canvas
        }

        when (domain) {
            AgentDomain.BACKEND -> {
                // Code brackets < / >
                val path = Path().apply {
                    moveTo(w * 0.38f, h * 0.32f)
                    lineTo(w * 0.22f, cy)
                    lineTo(w * 0.38f, h * 0.68f)
                    moveTo(w * 0.62f, h * 0.32f)
                    lineTo(w * 0.78f, cy)
                    lineTo(w * 0.62f, h * 0.68f)
                }
                drawPath(path, color = color, style = Stroke(width = 1.3.dp.toPx(), cap = StrokeCap.Round))
            }

            AgentDomain.ANDROID -> {
                // Mobile phone outline
                val r = androidx.compose.ui.geometry.Rect(w * 0.30f, h * 0.20f, w * 0.70f, h * 0.80f)
                drawRoundRect(
                    color = color,
                    topLeft = r.topLeft,
                    size = r.size,
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()),
                    style = Stroke(width = 1.3.dp.toPx()),
                )
                // Bottom dot
                drawCircle(color = color, radius = 1.dp.toPx(), center = Offset(cx, h * 0.72f))
            }

            AgentDomain.SECURITY -> {
                // Shield
                val path = Path().apply {
                    moveTo(cx, h * 0.22f)
                    lineTo(w * 0.74f, h * 0.35f)
                    lineTo(w * 0.74f, h * 0.58f)
                    lineTo(cx, h * 0.80f)
                    lineTo(w * 0.26f, h * 0.58f)
                    lineTo(w * 0.26f, h * 0.35f)
                    close()
                }
                drawPath(path, color = color, style = Stroke(width = 1.3.dp.toPx(), cap = StrokeCap.Round))
            }

            AgentDomain.TESTING -> {
                // Beaker / flask
                val path = Path().apply {
                    moveTo(w * 0.42f, h * 0.22f)
                    lineTo(w * 0.58f, h * 0.22f)
                    moveTo(w * 0.45f, h * 0.22f)
                    lineTo(w * 0.45f, h * 0.42f)
                    lineTo(w * 0.26f, h * 0.78f)
                    lineTo(w * 0.74f, h * 0.78f)
                    lineTo(w * 0.55f, h * 0.42f)
                    lineTo(w * 0.55f, h * 0.22f)
                }
                drawPath(path, color = color, style = Stroke(width = 1.3.dp.toPx(), cap = StrokeCap.Round))
            }

            AgentDomain.DATABASE -> {
                // Database cylinders
                drawOval(
                    color = color,
                    topLeft = Offset(w * 0.26f, h * 0.24f),
                    size = androidx.compose.ui.geometry.Size(w * 0.48f, h * 0.22f),
                    style = Stroke(width = 1.2.dp.toPx()),
                )
                drawLine(
                    color = color,
                    start = Offset(w * 0.26f, h * 0.35f),
                    end = Offset(w * 0.26f, h * 0.70f),
                    strokeWidth = 1.2.dp.toPx(),
                )
                drawLine(
                    color = color,
                    start = Offset(w * 0.74f, h * 0.35f),
                    end = Offset(w * 0.74f, h * 0.70f),
                    strokeWidth = 1.2.dp.toPx(),
                )
                drawArc(
                    color = color,
                    startAngle = 0f,
                    sweepAngle = 180f,
                    useCenter = false,
                    topLeft = Offset(w * 0.26f, h * 0.58f),
                    size = androidx.compose.ui.geometry.Size(w * 0.48f, h * 0.22f),
                    style = Stroke(width = 1.2.dp.toPx()),
                )
            }

            AgentDomain.RUNTIME -> {
                // Lightning bolt
                val path = Path().apply {
                    moveTo(cx + w * 0.05f, h * 0.22f)
                    lineTo(cx - w * 0.18f, h * 0.52f)
                    lineTo(cx, h * 0.52f)
                    lineTo(cx - w * 0.05f, h * 0.80f)
                    lineTo(cx + w * 0.18f, h * 0.46f)
                    lineTo(cx, h * 0.46f)
                    close()
                }
                drawPath(path, color = color, style = Stroke(width = 1.2.dp.toPx(), cap = StrokeCap.Round))
            }

            else -> {
                // Minimal clean dot or core
                drawCircle(color = color, radius = 2.dp.toPx(), center = Offset(cx, cy))
            }
        }
    }
}
