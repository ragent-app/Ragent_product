package com.andysagent.ragent.core.designsystem

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Ragent pill-shaped filter control replacing raw Material 3 FilterChip across feature modules.
 */
@Composable
fun AgentoFilterPill(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val view = LocalView.current

    val containerColor by animateColorAsState(
        targetValue = when {
            selected -> colors.accentPrimary.copy(alpha = if (isDark) 0.22f else 0.14f)
            isDark -> colors.surfaceHigh
            else -> colors.surfaceHigh.copy(alpha = 0.72f)
        },
        animationSpec = tween(AgentoMotion.DurationFast),
        label = "filter_pill_bg",
    )
    val contentColor by animateColorAsState(
        targetValue = when {
            !enabled -> colors.disabledContent
            selected -> colors.accentPrimary
            else -> colors.secondaryContent
        },
        animationSpec = tween(AgentoMotion.DurationFast),
        label = "filter_pill_fg",
    )
    val borderColor = if (selected) {
        colors.accentPrimary.copy(alpha = if (isDark) 0.52f else 0.40f)
    } else {
        colors.subtleOutline
    }

    Row(
        modifier = modifier
            .defaultMinSize(minHeight = 40.dp)
            .clip(AgentoShapes.PillShape)
            .background(containerColor)
            .border(0.75.dp, borderColor, AgentoShapes.PillShape)
            .agentoPressScale(
                pressedScale = 0.96f,
                onClick = if (enabled) {
                    {
                        AgentoHaptics.performTick(view)
                        onClick()
                    }
                } else null,
            )
            .semantics(mergeDescendants = true) {
                role = Role.Button
                this.selected = selected
            }
            .padding(horizontal = 13.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) {
            if (leadingIcon != null) {
                leadingIcon()
            }
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium.copy(
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    fontSize = 13.sp,
                ),
                color = contentColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Capsule segmented control with sliding lens indicator matching Ragent's navigation language.
 */
@Composable
fun AgentoSegmentedTabs(
    options: List<String>,
    selectedIndex: Int,
    onSelected: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (options.isEmpty()) return
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val view = LocalView.current
    val safeIndex = selectedIndex.coerceIn(0, options.lastIndex)

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(AgentoShapes.PillShape)
            .background(if (isDark) colors.surfaceHigh else colors.strongSurface.copy(alpha = 0.85f))
            .border(0.5.dp, colors.subtleOutline, AgentoShapes.PillShape)
            .padding(3.dp),
    ) {
        val segmentWidth = maxWidth / options.size
        val indicatorOffset by animateDpAsState(
            targetValue = segmentWidth * safeIndex,
            animationSpec = AgentoMotion.ExpressiveSnappyDp,
            label = "segmented_tab_offset",
        )
        Box(
            modifier = Modifier
                .offset(x = indicatorOffset)
                .width(segmentWidth)
                .fillMaxHeight()
                .clip(AgentoShapes.PillShape)
                .background(if (isDark) colors.surfaceHighest else colors.quietSurface),
        )
        Row(modifier = Modifier.fillMaxWidth().fillMaxHeight()) {
            options.forEachIndexed { index, label ->
                val isSelected = index == safeIndex
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(AgentoShapes.PillShape)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = {
                                if (!isSelected) {
                                    AgentoHaptics.performTick(view)
                                    onSelected(index)
                                }
                            },
                        )
                        .semantics {
                            role = Role.Tab
                            selected = isSelected
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelMedium.copy(
                            fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                        ),
                        color = if (isSelected) colors.primaryContent else colors.secondaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * Rounded capsule progress bar replacing raw Material LinearProgressIndicator.
 */
@Composable
fun AgentoProgressBar(
    progress: Float? = null,
    modifier: Modifier = Modifier,
    accentColor: Color = LocalRagentColors.current.accentPrimary,
    trackColor: Color? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val resolvedTrack = trackColor ?: if (isDark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.08f)
    val motionPreference = LocalMotionPolicy.current.preference

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(5.dp)
            .clip(CircleShape)
            .background(resolvedTrack),
    ) {
        if (progress != null) {
            val clamped = progress.coerceIn(0f, 1f)
            val animatedProgress by animateFloatAsState(
                targetValue = clamped,
                animationSpec = tween(durationMillis = if (motionPreference == MotionPreference.None) 0 else 220),
                label = "agento_progress_fill",
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth(animatedProgress)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(accentColor),
            )
        } else if (motionPreference == MotionPreference.Full && !LocalAgentoBackgrounded.current) {
            val infiniteTransition = rememberInfiniteTransition(label = "agento_progress_indeterminate")
            val sweep by infiniteTransition.animateFloat(
                initialValue = -0.35f,
                targetValue = 1.05f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 1250, easing = LinearEasing),
                    repeatMode = RepeatMode.Restart,
                ),
                label = "agento_progress_sweep",
            )
            val pillWidth = maxWidth * 0.35f
            val offsetX = (maxWidth * sweep)
            Box(
                modifier = Modifier
                    .offset(x = offsetX)
                    .width(pillWidth)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(accentColor),
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth(0.45f)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(accentColor.copy(alpha = 0.7f)),
            )
        }
    }
}

/**
 * Elevated deliverable card container distinguishing final agent artifacts from quiet tool logs.
 */
@Composable
fun AgentoArtifactSurface(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    glyph: AgentoWebGlyph? = null,
    headerTint: Color? = null,
    badge: (@Composable () -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val accent = headerTint ?: colors.accentPrimary
    val headerBg = accent.copy(alpha = if (isDark) 0.14f else 0.08f)
    val surfaceShape = RoundedCornerShape(18.dp)

    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = surfaceShape,
        color = colors.surfaceLow,
        border = BorderStroke(0.75.dp, colors.subtleOutline),
        shadowElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(headerBg)
                    .padding(horizontal = 14.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (glyph != null) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(accent.copy(alpha = if (isDark) 0.22f else 0.14f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = glyph,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = accent,
                        )
                    }
                }
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleMedium.copy(
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                        ),
                        color = colors.primaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!subtitle.isNullOrBlank()) {
                        Text(
                            text = subtitle,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.secondaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                badge?.invoke()
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                content = content,
            )

            if (actions != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 14.dp, end = 14.dp, bottom = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    content = actions,
                )
            }
        }
    }
}
