package com.andysagent.agentoc.feature.workbench

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import com.andysagent.agentoc.core.designsystem.AgentoSwitch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.agentui.PermissionRequestUiState
import com.andysagent.agentoc.core.designsystem.AgentoBreathingDot
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoColors
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocSizes
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.roundToInt

/**
 * RunDock: Layer C of the AgentoC Task Workspace.
 *
 * The bottom island has one purpose at a time: approval takes priority over
 * queued follow-ups. Run and connection status belong to the top island; an
 * empty queue with no approval leaves this dock absent.
 */
@Composable
fun RunDock(
    runStatus: AgentRunStatus,
    approval: PermissionRequestUiState?,
    isOfflineOrTransportError: Boolean,
    onStop: () -> Unit,
    onOpenRunDetails: () -> Unit,
    onApprove: (String) -> Unit,
    onDeny: (String) -> Unit,
    onReviewChanges: () -> Unit,
    onRetryConnection: () -> Unit,
    modifier: Modifier = Modifier,
    activeActivityText: String? = null,
    filesChangedCount: Int = 0,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    approvalResolving: Boolean = false,
    // Dynamic Island state for the approval request: true renders the full
    // card, false collapses it into the tappable pill above the composer.
    approvalExpanded: Boolean = true,
    onExpandApproval: () -> Unit = {},
    onCollapseApproval: () -> Unit = {},
    queuedMessages: List<QueuedMessageUiState> = emptyList(),
    queueExpanded: Boolean = false,
    onExpandQueue: () -> Unit = {},
    onCollapseQueue: () -> Unit = {},
    onEditQueuedMessage: (QueuedMessageUiState) -> Unit = {},
    onSteerQueue: (QueuedMessageUiState) -> Unit = {},
    onRemoveQueuedMessage: (QueuedMessageUiState) -> Unit = {},
    goalMode: Boolean = false,
    goalText: String = "",
    autoContinue: Boolean = false,
    goalExpanded: Boolean = false,
    onExpandGoal: () -> Unit = {},
    onCollapseGoal: () -> Unit = {},
    onSaveGoal: (String) -> Unit = {},
    onClearGoal: () -> Unit = {},
    onToggleAutoContinue: () -> Unit = {},
) {
    val hasOtherCapsules = approval != null || queuedMessages.isNotEmpty()
    val hasGoal = goalMode
    val isVisible = hasOtherCapsules || hasGoal

    AnimatedVisibility(
        visible = isVisible,
        enter = slideInVertically(
            initialOffsetY = { it / 2 },
            animationSpec = spring(dampingRatio = 0.85f, stiffness = 380f),
        ) + fadeIn(),
        exit = slideOutVertically(
            targetOffsetY = { it / 2 },
            animationSpec = spring(dampingRatio = 0.88f, stiffness = 420f),
        ) + fadeOut(),
        modifier = modifier.fillMaxWidth(),
    ) {
        BoxWithConstraints(
            modifier = Modifier.fillMaxWidth(),
            contentAlignment = Alignment.Center,
        ) {
            val maxCapsuleWidth = maxWidth * 0.75f
            when {
                approval != null -> {
                    ApprovalIsland(
                        approval = approval,
                        expanded = approvalExpanded,
                        onExpand = onExpandApproval,
                        onApprove = { onApprove(approval.id) },
                        onDeny = { onDeny(approval.id) },
                        onReviewChanges = onReviewChanges,
                        backdropLayer = backdropLayer,
                        backdropOrigin = backdropOrigin,
                        modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
                    )
                }
                queuedMessages.isNotEmpty() -> {
                    QueuedMessageIsland(
                        queuedMessages = queuedMessages,
                        expanded = queueExpanded,
                        onExpand = onExpandQueue,
                        onCollapse = onCollapseQueue,
                        onEdit = onEditQueuedMessage,
                        onSteer = onSteerQueue,
                        onRemove = onRemoveQueuedMessage,
                        backdropLayer = backdropLayer,
                        backdropOrigin = backdropOrigin,
                        modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
                    )
                }
                hasGoal -> {
                    GoalIsland(
                        goalText = goalText,
                        autoContinue = autoContinue,
                        expanded = goalExpanded,
                        maxCapsuleWidth = maxCapsuleWidth,
                        onExpand = onExpandGoal,
                        onCollapse = onCollapseGoal,
                        onSaveGoal = onSaveGoal,
                        onClearGoal = onClearGoal,
                        onToggleAutoContinue = onToggleAutoContinue,
                        backdropLayer = backdropLayer,
                        backdropOrigin = backdropOrigin,
                        modifier = Modifier.widthIn(max = AgentocSizes.ContentMaxWidth),
                    )
                }
            }
        }
    }
}

@Composable
private fun GoalIsland(
    goalText: String,
    autoContinue: Boolean,
    expanded: Boolean,
    maxCapsuleWidth: Dp = 280.dp,
    onExpand: () -> Unit,
    onCollapse: () -> Unit,
    onSaveGoal: (String) -> Unit,
    onClearGoal: () -> Unit,
    onToggleAutoContinue: () -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    // Consistent with QueuedMessageIsland:
    // A newly mounted island first paints the compact source geometry. On
    // the next frame the card grows from that same glass surface; otherwise
    // an island created already expanded would simply pop in at full size.
    var presentedExpanded by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) {
        if (expanded) withFrameNanos { }
        presentedExpanded = expanded
    }

    AgentoFrostedGlassBox(
        modifier = modifier
            .testTag("composer-goal-island")
            .wrapContentWidth(Alignment.CenterHorizontally)
            .widthIn(max = AgentocSizes.ContentMaxWidth)
            .islandTapShield()
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
        shape = RoundedCornerShape(20.dp),
        surface = AgentoGlassSurface.Tinted(colors.glassSurface),
        blurRadius = AgentoFrostedTokens.BlurStandard,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidRegular,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = true,
        hasShadow = true,
        shadowElevation = 8.dp,
        shadowAlpha = if (isDark) 0.16f else 0.06f,
    ) {
        AnimatedContent(
            targetState = presentedExpanded,
            transitionSpec = {
                ContentTransform(
                    targetContentEnter = fadeIn(tween(140)) + scaleIn(
                        initialScale = 0.90f,
                        animationSpec = spring(dampingRatio = 0.80f, stiffness = 380f),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    initialContentExit = fadeOut(tween(90)) + scaleOut(
                        targetScale = 0.95f,
                        animationSpec = tween(100),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    sizeTransform = IslandSizeTransform(clip = true),
                )
            },
            // Bottom-center keeps the resting pill anchored at the composer
            // edge while the bounds grow upward around it.
            contentAlignment = Alignment.BottomCenter,
            label = "goal_island_content",
        ) { isExpanded ->
            if (isExpanded) {
                GoalCardContent(
                    goalText = goalText,
                    autoContinue = autoContinue,
                    onCollapse = onCollapse,
                    onSaveGoal = onSaveGoal,
                    onClearGoal = onClearGoal,
                    onToggleAutoContinue = onToggleAutoContinue,
                )
            } else {
                GoalStandardPillContent(
                    goalText = goalText,
                    autoContinue = autoContinue,
                    maxCapsuleWidth = maxCapsuleWidth,
                    onExpand = onExpand,
                    onToggleAutoContinue = onToggleAutoContinue,
                    onClearGoal = onClearGoal,
                )
            }
        }
    }
}

@Composable
private fun GoalStandardPillContent(
    goalText: String,
    autoContinue: Boolean,
    maxCapsuleWidth: Dp,
    onExpand: () -> Unit,
    onToggleAutoContinue: () -> Unit,
    onClearGoal: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val isCreatingGoal = goalText.isBlank()
    val displayText = if (isCreatingGoal) stringResource(R.string.goal_title) else goalText

    val actionDesc = if (isCreatingGoal) {
        stringResource(R.string.goal_disable)
    } else {
        stringResource(if (autoContinue) R.string.goal_pause else R.string.goal_start)
    }

    Row(
        modifier = Modifier
            .height(40.dp)
            .widthIn(max = maxCapsuleWidth)
            .testTag("goal-island-standard-pill")
            .then(
                if (isCreatingGoal) Modifier
                else Modifier.agentoPressScale(pressedScale = 0.96f, onClick = onExpand)
            )
            .padding(start = 13.dp, end = 6.dp)
            .semantics {
                role = if (isCreatingGoal) Role.Tab else Role.Button
                contentDescription = if (goalText.isNotBlank()) "Goal: $goalText" else "Session goal"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AgentoWebIcon(
            glyph = AgentoWebGlyph.TargetArrow,
            contentDescription = null,
            modifier = Modifier.size(17.dp),
            tint = LocalAgentocColors.current.accentPrimary,
        )
        Text(
            text = displayText,
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
            color = if (isCreatingGoal) colors.secondaryContent else colors.primaryContent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        // Action Button: Close 'X' if creating goal, or Play/Pause if active goal
        Box(
            modifier = Modifier
                .size(30.dp)
                .testTag(if (isCreatingGoal) "goal-pill-close" else "goal-pill-play-pause")
                .clip(CircleShape)
                .background(
                    if (isCreatingGoal) colors.primaryContent.copy(alpha = if (isDark) 0.12f else 0.08f)
                    else if (autoContinue) LocalAgentocColors.current.accentPrimary.copy(alpha = if (isDark) 0.25f else 0.14f)
                    else colors.primaryContent.copy(alpha = if (isDark) 0.12f else 0.08f)
                )
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = if (isCreatingGoal) onClearGoal else onToggleAutoContinue,
                )
                .semantics {
                    role = Role.Button
                    contentDescription = actionDesc
                },
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = if (isCreatingGoal) AgentoWebGlyph.Close
                    else if (autoContinue) AgentoWebGlyph.Pause
                    else AgentoWebGlyph.Play,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = if (isCreatingGoal) colors.secondaryContent
                    else if (autoContinue) LocalAgentocColors.current.accentPrimary
                    else colors.primaryContent,
            )
        }
    }
}

@Composable
private fun GoalCompactPillContent(
    isCreatingGoal: Boolean,
    autoContinue: Boolean,
    onExpand: () -> Unit,
    onToggleAutoContinue: () -> Unit,
    onClearGoal: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val actionDesc = if (isCreatingGoal) {
        stringResource(R.string.goal_disable)
    } else {
        stringResource(if (autoContinue) R.string.goal_pause else R.string.goal_start)
    }

    Row(
        modifier = Modifier
            .height(40.dp)
            .testTag("goal-island-compact-pill")
            .then(
                if (isCreatingGoal) Modifier
                else Modifier.agentoPressScale(pressedScale = 0.94f, onClick = onExpand)
            )
            .padding(horizontal = 9.dp)
            .semantics {
                role = if (isCreatingGoal) Role.Tab else Role.Button
                contentDescription = "Session goal"
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        AgentoWebIcon(
            glyph = AgentoWebGlyph.TargetArrow,
            contentDescription = null,
            modifier = Modifier.size(17.dp),
            tint = LocalAgentocColors.current.accentPrimary,
        )
        Box(
            modifier = Modifier
                .width(1.dp)
                .height(16.dp)
                .background(colors.primaryContent.copy(alpha = if (isDark) 0.16f else 0.10f)),
        )
        // Action Button: Close 'X' if creating goal, or Play/Pause if active goal
        Box(
            modifier = Modifier
                .size(28.dp)
                .testTag(if (isCreatingGoal) "goal-compact-close" else "goal-compact-play-pause")
                .clip(CircleShape)
                .background(
                    if (isCreatingGoal) colors.primaryContent.copy(alpha = if (isDark) 0.12f else 0.08f)
                    else if (autoContinue) LocalAgentocColors.current.accentPrimary.copy(alpha = if (isDark) 0.25f else 0.14f)
                    else colors.primaryContent.copy(alpha = if (isDark) 0.12f else 0.08f)
                )
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = if (isCreatingGoal) onClearGoal else onToggleAutoContinue,
                )
                .semantics {
                    role = Role.Button
                    contentDescription = actionDesc
                },
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = if (isCreatingGoal) AgentoWebGlyph.Close
                    else if (autoContinue) AgentoWebGlyph.Pause
                    else AgentoWebGlyph.Play,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = if (isCreatingGoal) colors.secondaryContent
                    else if (autoContinue) LocalAgentocColors.current.accentPrimary
                    else colors.primaryContent,
            )
        }
    }
}

@Composable
private fun GoalCardContent(
    goalText: String,
    autoContinue: Boolean,
    onCollapse: () -> Unit,
    onSaveGoal: (String) -> Unit,
    onClearGoal: () -> Unit,
    onToggleAutoContinue: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var currentInput by remember(goalText) { mutableStateOf(goalText) }
    val closeDesc = stringResource(R.string.goal_close)
    val inputDescription = stringResource(R.string.goal_input)
    val clearDesc = stringResource(if (goalText.isNotBlank()) R.string.goal_clear else R.string.goal_disable)
    val isDirty = currentInput.trim() != goalText.trim()
    val showStatus = isDirty || autoContinue || goalText.isNotBlank()
    val statusText = when {
        isDirty -> stringResource(R.string.goal_unsaved)
        autoContinue -> stringResource(R.string.goal_running)
        else -> stringResource(R.string.goal_saved)
    }
    val statusColor = when {
        isDirty -> colors.stateWarning
        autoContinue -> colors.accentPrimary
        else -> colors.stateSuccess
    }
    val insetCardBg = colors.primaryContent.copy(alpha = if (isDark) 0.065f else 0.038f)
    val primaryLabel = when {
        autoContinue -> stringResource(R.string.goal_pause)
        isDirty -> stringResource(R.string.goal_save)
        else -> stringResource(R.string.goal_start)
    }
    val primaryGlyph = when {
        autoContinue -> AgentoWebGlyph.Pause
        isDirty -> AgentoWebGlyph.TargetArrow
        else -> AgentoWebGlyph.Play
    }

    Column(
        modifier = Modifier
            .widthIn(min = 300.dp, max = 380.dp)
            .testTag("goal-island-card")
            .padding(start = 14.dp, end = 14.dp, top = 11.dp, bottom = 9.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = stringResource(R.string.goal_title),
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 15.5.sp,
                    ),
                    color = colors.primaryContent,
                )
                if (showStatus) {
                    Row(
                        modifier = Modifier.testTag("goal-island-status"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Box(Modifier.size(5.5.dp).clip(CircleShape).background(statusColor))
                        Text(
                            text = statusText,
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 10.5.sp),
                            color = colors.secondaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .testTag("goal-island-collapse")
                    .clip(CircleShape)
                    .agentoPressScale(pressedScale = 0.92f, onClick = onCollapse)
                    .semantics {
                        role = Role.Button
                        contentDescription = closeDesc
                    },
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Close,
                    contentDescription = null,
                    modifier = Modifier.size(13.dp),
                    tint = colors.secondaryContent,
                )
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(insetCardBg)
                .padding(horizontal = 14.dp, vertical = 11.dp),
        ) {
            Box(modifier = Modifier.fillMaxWidth()) {
                if (currentInput.isEmpty()) {
                    Text(
                        text = stringResource(R.string.goal_placeholder),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                        color = colors.secondaryContent.copy(alpha = 0.55f),
                    )
                }
                BasicTextField(
                    value = currentInput,
                    onValueChange = { currentInput = it },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("goal-objective-input")
                        .semantics { contentDescription = inputDescription },
                    textStyle = MaterialTheme.typography.bodyMedium.copy(
                        fontSize = 14.sp,
                        color = colors.primaryContent,
                        lineHeight = 20.sp,
                    ),
                    cursorBrush = SolidColor(colors.accentPrimary),
                    minLines = 2,
                    maxLines = 5,
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .heightIn(min = 40.dp)
                    .clip(AgentoShapes.PillShape)
                    .agentoPressScale(pressedScale = 0.97f, onClick = onClearGoal)
                    .padding(horizontal = 12.dp)
                    .semantics {
                        role = Role.Button
                        contentDescription = clearDesc
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = clearDesc,
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontWeight = FontWeight.Medium,
                        fontSize = 12.5.sp,
                    ),
                    color = colors.secondaryContent.copy(alpha = if (goalText.isNotBlank()) 0.86f else 1f),
                )
            }
            Spacer(Modifier.weight(1f))
            Box(
                modifier = Modifier
                    .heightIn(min = 40.dp)
                    .clip(AgentoShapes.PillShape)
                    .background(colors.actionPrimary)
                    .agentoPressScale(
                        pressedScale = 0.97f,
                        onClick = {
                            when {
                                autoContinue -> onToggleAutoContinue()
                                isDirty -> {
                                    onSaveGoal(currentInput.trim())
                                    onCollapse()
                                }
                                else -> onToggleAutoContinue()
                            }
                        },
                    )
                    .testTag(if (!autoContinue && isDirty) "goal-save-action" else "goal-play-pause-action")
                    .padding(horizontal = 15.dp)
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    AgentoWebIcon(
                        glyph = primaryGlyph,
                        contentDescription = null,
                        modifier = Modifier.size(12.dp),
                        tint = Color.White.copy(alpha = 0.96f),
                    )
                    Text(
                        text = primaryLabel,
                        style = MaterialTheme.typography.labelMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 13.sp,
                            color = Color.White.copy(alpha = 0.96f),
                        ),
                    )
                }
            }
        }
    }
}

/** One sampled glass surface for the queue pill and its message card. */
@Composable
private fun QueuedMessageIsland(
    queuedMessages: List<QueuedMessageUiState>,
    expanded: Boolean,
    onExpand: () -> Unit,
    onCollapse: () -> Unit,
    onEdit: (QueuedMessageUiState) -> Unit,
    onSteer: (QueuedMessageUiState) -> Unit,
    onRemove: (QueuedMessageUiState) -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }
    // A newly sent queue item first paints the compact source geometry. On
    // the next frame the card grows from that same glass surface; otherwise
    // an island created already expanded would simply pop in at full size.
    var presentedExpanded by remember { mutableStateOf(false) }
    LaunchedEffect(expanded) {
        if (expanded) withFrameNanos { }
        presentedExpanded = expanded
    }
    AgentoFrostedGlassBox(
        modifier = modifier
            .testTag("composer-queue-rail")
            .wrapContentWidth(Alignment.CenterHorizontally)
            .widthIn(max = AgentocSizes.ContentMaxWidth)
            .islandTapShield()
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
        shape = RoundedCornerShape(20.dp),
        surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.86f)) else AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = false,
        hasShadow = true,
        shadowElevation = 8.dp,
        shadowAlpha = if (isDark) 0.16f else 0.06f,
    ) {
        AnimatedContent(
            targetState = presentedExpanded,
            transitionSpec = {
                ContentTransform(
                    targetContentEnter = fadeIn(tween(150)) + scaleIn(
                        initialScale = 0.92f,
                        animationSpec = spring(dampingRatio = 0.82f, stiffness = 420f),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    initialContentExit = fadeOut(tween(100)) + scaleOut(
                        targetScale = 0.96f,
                        animationSpec = tween(110),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    sizeTransform = IslandSizeTransform(clip = true),
                )
            },
            contentAlignment = Alignment.BottomCenter,
            label = "queued_message_island",
        ) { isExpanded ->
            if (isExpanded) {
                QueueCardContent(queuedMessages, onCollapse, onEdit, onSteer, onRemove)
            } else {
                QueuePillContent(queuedMessages.size, onExpand)
            }
        }
    }
}

@Composable
private fun QueuePillContent(count: Int, onExpand: () -> Unit) {
    val colors = LocalAgentocColors.current
    val label = pluralStringResource(R.plurals.composer_queued_messages, count, count)
    Row(
        modifier = Modifier
            .height(40.dp)
            .testTag("queue-island-pill")
            .agentoPressScale(pressedScale = 0.94f, onClick = onExpand)
            .padding(start = 15.dp, end = 13.dp)
            .semantics { contentDescription = label; role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        Box(Modifier.size(7.dp).background(colors.accentPrimary, CircleShape))
        Text(label, style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium, color = colors.primaryContent,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        AgentoWebIcon(AgentoWebGlyph.ChevronDown, contentDescription = null,
            modifier = Modifier.size(14.dp).rotate(180f), tint = colors.secondaryContent)
    }
}

@Composable
private fun QueueCardContent(
    queuedMessages: List<QueuedMessageUiState>,
    onCollapse: () -> Unit,
    onEdit: (QueuedMessageUiState) -> Unit,
    onSteer: (QueuedMessageUiState) -> Unit,
    onRemove: (QueuedMessageUiState) -> Unit,
) {
    val colors = LocalAgentocColors.current
    val collapseLabel = stringResource(R.string.composer_collapse_queue)
    Column(Modifier.widthIn(min = 280.dp, max = 420.dp)
        .animateContentSize(spring(dampingRatio = 0.86f, stiffness = 370f))
        .padding(start = 15.dp, end = 15.dp, top = 8.dp, bottom = 12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                pluralStringResource(R.plurals.composer_queued_messages, queuedMessages.size, queuedMessages.size),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                color = colors.primaryContent,
            )
            Box(Modifier.size(48.dp).testTag("queue-island-collapse")
                .clickable(role = Role.Button, onClick = onCollapse)
                .semantics { contentDescription = collapseLabel },
                contentAlignment = Alignment.Center) {
                AgentoWebIcon(AgentoWebGlyph.ChevronDown, contentDescription = null,
                    modifier = Modifier.size(17.dp), tint = colors.secondaryContent)
            }
        }
        Column(Modifier.fillMaxWidth().heightIn(max = 330.dp).verticalScroll(rememberScrollState())) {
            queuedMessages.forEachIndexed { index, message ->
                val removeLabel = stringResource(R.string.composer_remove_queued)
                val editLabel = stringResource(R.string.composer_edit_queued)
                val preview = message.text.ifBlank {
                    if (message.attachments.isNotEmpty()) {
                        pluralStringResource(R.plurals.composer_queued_attachments,
                            message.attachments.size, message.attachments.size)
                    } else stringResource(R.string.composer_message_no_text)
                }
                if (index > 0) Box(Modifier.fillMaxWidth().height(0.5.dp)
                    .background(colors.secondaryContent.copy(alpha = 0.18f)))
                Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    Text(preview, style = MaterialTheme.typography.bodyMedium,
                        color = colors.primaryContent, maxLines = 3,
                        overflow = TextOverflow.Ellipsis)
                    if (message.attachments.isNotEmpty()) {
                        val attachmentCount = pluralStringResource(
                            R.plurals.composer_queued_attachments,
                            message.attachments.size,
                            message.attachments.size,
                        )
                        val attachmentNames = message.attachments.take(2)
                            .joinToString(" · ") { it.name }
                        val overflowCount = (message.attachments.size - 2).coerceAtLeast(0)
                        val attachmentSummary = buildString {
                            append(attachmentNames.ifBlank { attachmentCount })
                            if (attachmentNames.isNotBlank()) {
                                append(" · ")
                                append(attachmentCount)
                            }
                            if (overflowCount > 0) append(" · +$overflowCount")
                        }
                        Row(
                            Modifier.padding(top = 5.dp)
                                .testTag("queue-island-attachments-${index + 1}")
                                .semantics { contentDescription = attachmentSummary },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            AgentoWebIcon(
                                AgentoWebGlyph.File,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = colors.secondaryContent,
                            )
                            Text(
                                attachmentSummary,
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.secondaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { onSteer(message) }
                            .padding(horizontal = 13.dp), contentAlignment = Alignment.Center) {
                            Text(stringResource(R.string.composer_steer),
                                style = MaterialTheme.typography.labelLarge, color = colors.accentPrimary)
                        }
                        Box(Modifier.size(48.dp).clickable(role = Role.Button) { onEdit(message) }
                            .semantics { contentDescription = "$editLabel ${index + 1}" },
                            contentAlignment = Alignment.Center) {
                            AgentoWebIcon(AgentoWebGlyph.Edit, contentDescription = null,
                                modifier = Modifier.size(18.dp), tint = colors.secondaryContent)
                        }
                        Box(Modifier.size(48.dp).clickable(role = Role.Button) { onRemove(message) }
                            .semantics { contentDescription = "$removeLabel ${index + 1}" },
                            contentAlignment = Alignment.Center) {
                            AgentoWebIcon(AgentoWebGlyph.Close, contentDescription = null,
                                modifier = Modifier.size(18.dp), tint = colors.secondaryContent)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Content-sized executing bar with separate 48dp-minimum touch targets.
 */
@Composable
private fun ActiveExecutingDock(
    activityText: String,
    filesChangedCount: Int,
    onOpenRunDetails: () -> Unit,
    onStop: () -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    val changedFilesLabel = if (filesChangedCount > 0)
        stringResource(R.string.run_summary_changed_files, filesChangedCount) else null
    val displayText = listOfNotNull(activityText, changedFilesLabel).joinToString(" · ")
    val stopDescription = stringResource(R.string.run_dock_stop_description)

    AgentoFrostedGlassBox(
        modifier = modifier
            .wrapContentWidth(Alignment.CenterHorizontally)
            .widthIn(min = 240.dp, max = 380.dp)
            .heightIn(min = 48.dp)
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
        shape = AgentoShapes.PillShape,
        surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.85f)) else AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = false,
        hasShadow = true,
        shadowElevation = 6.dp,
        shadowAlpha = if (isDark) 0.16f else 0.06f,
    ) {
        Row(
            modifier = Modifier
                .wrapContentWidth()
                .heightIn(min = 48.dp)
                .padding(start = 14.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Tappable body -> opens Run Details Sheet
            Row(
                modifier = Modifier
                    .weight(1f, fill = false)
                    .heightIn(min = 48.dp)
                    .testTag("run-dock-activity")
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onOpenRunDetails,
                    )
                    .semantics { role = Role.Button; contentDescription = displayText },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AgentoBreathingDot(
                    color = colors.stateRunning,
                    size = 7.dp,
                )
                Text(
                    text = displayText,
                    style = MaterialTheme.typography.bodyMedium.copy(
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                        lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                            alignment = androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                            trim = androidx.compose.ui.text.style.LineHeightStyle.Trim.Both,
                        ),
                    ),
                    color = colors.primaryContent,
                    // This compact activity summary must not split a status
                    // word into a second row beside Stop. The touch target
                    // exposes the complete localized text to accessibility.
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            // Stop button: Only red destructive action
            Box(
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .widthIn(min = 48.dp)
                    .testTag("run-dock-stop")
                    .agentoPressScale(pressedScale = 0.94f, onClick = onStop)
                    .semantics { role = Role.Button; contentDescription = stopDescription },
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    modifier = Modifier
                    .clip(AgentoShapes.PillShape)
                    .background(colors.stateError.copy(alpha = if (isDark) 0.20f else 0.12f))
                    .border(
                        width = 0.5.dp,
                        color = colors.stateError.copy(alpha = 0.35f),
                        shape = AgentoShapes.PillShape,
                    )
                    .padding(horizontal = 9.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.5.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.5.dp)
                            .background(colors.stateError, RoundedCornerShape(1.5.dp)),
                    )
                    Text(
                        text = stringResource(R.string.run_dock_stop),
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 11.5.sp,
                            platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                            lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                                alignment = androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                                trim = androidx.compose.ui.text.style.LineHeightStyle.Trim.Both,
                            ),
                        ),
                        color = colors.stateError,
                    )
                }
            }
        }
    }
}

/**
 * Apple Dynamic Island-style bounds spring: slightly under-damped so the
 * capsule-to-card growth feels organic, with the content swap clipped to
 * the animating surface instead of cross-fading two separate elements.
 */
private class IslandSizeTransform(override val clip: Boolean = true) : SizeTransform {
    override fun createAnimationSpec(initialSize: IntSize, targetSize: IntSize): FiniteAnimationSpec<IntSize> =
        spring(dampingRatio = 0.82f, stiffness = 360f)
}

/**
 * Swallows taps that land on the island card's blank surface so they never
 * reach the dismissal barrier behind the dock. Gestures already consumed
 * by child controls (Approve/Deny, tabs, the pill's expand click) pass
 * through untouched — this only shields inert regions. Do not consume moves:
 * a child scrollable needs them to cross touch slop before it owns the gesture.
 * The shield already participates in hit testing, so the barrier behind this
 * card cannot receive its pointer stream. Consume only the unhandled release,
 * after child controls have processed it.
 */
internal fun Modifier.islandTapShield(): Modifier = pointerInput(Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final)
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Final)
            if (event.changes.none { it.pressed }) {
                event.changes.forEach { change ->
                    if (!change.isConsumed) change.consume()
                }
                break
            }
        }
    }
}

/**
 * The approval Dynamic Island. ONE glass surface continuously morphs
 * between the compact pill (collapsed) and the action card (expanded):
 * the surface bounds spring while the content swap fades inside it, so the
 * transition reads as a single capsule growing — never as two elements
 * cross-fading. A 38dp pill has a 19dp radius and the card uses 20dp
 * corners, so one fixed corner radius keeps the silhouette
 * capsule-continuous at every frame of the morph.
 */
@Composable
private fun ApprovalIsland(
    approval: PermissionRequestUiState,
    expanded: Boolean,
    onExpand: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onReviewChanges: () -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    AgentoFrostedGlassBox(
        modifier = modifier
            .wrapContentWidth(Alignment.CenterHorizontally)
            .widthIn(max = AgentocSizes.ContentMaxWidth)
            .islandTapShield()
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
        shape = RoundedCornerShape(20.dp),
        surface = if (isDark) AgentoGlassSurface.Tinted(Color(0xFF222226).copy(alpha = 0.86f)) else AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = false,
        hasShadow = true,
        shadowElevation = 8.dp,
        shadowAlpha = if (isDark) 0.16f else 0.06f,
    ) {
        AnimatedContent(
            targetState = expanded,
            transitionSpec = {
                ContentTransform(
                    targetContentEnter = fadeIn(tween(150)) + scaleIn(
                        initialScale = 0.9f,
                        animationSpec = spring(dampingRatio = 0.8f, stiffness = 420f),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    initialContentExit = fadeOut(tween(100)) + scaleOut(
                        targetScale = 0.94f,
                        animationSpec = tween(110),
                        transformOrigin = TransformOrigin(0.5f, 1f),
                    ),
                    sizeTransform = IslandSizeTransform(clip = true),
                )
            },
            // Bottom-center keeps the resting pill anchored at the composer
            // edge while the bounds grow upward around it.
            contentAlignment = Alignment.BottomCenter,
            label = "approval_island",
        ) { isExpanded ->
            if (isExpanded) {
                ApprovalCardContent(
                    approval = approval,
                    onApprove = onApprove,
                    onDeny = onDeny,
                    onReviewChanges = onReviewChanges,
                )
            } else {
                ApprovalPillContent(
                    approval = approval,
                    onExpand = onExpand,
                )
            }
        }
    }
}

/**
 * Collapsed approval pill content — the island's resting state. Compact
 * capsule grammar matching the executing dock; tapping expands the card.
 */
@Composable
private fun ApprovalPillContent(
    approval: PermissionRequestUiState,
    onExpand: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    Row(
        modifier = Modifier
            .height(38.dp)
            .agentoPressScale(
                pressedScale = 0.94f,
                onClick = onExpand,
            )
            .padding(start = 14.dp, end = 12.dp)
            .semantics {
                contentDescription = "Expand approval request"
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AgentoBreathingDot(
            color = Color(0xFFF59E0B),
            size = 7.dp,
        )
        Text(
            text = approval.title.ifBlank { "Needs your approval" },
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                    alignment = androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                    trim = androidx.compose.ui.text.style.LineHeightStyle.Trim.Both,
                ),
            ),
            color = colors.primaryContent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        AgentoWebIcon(
            glyph = AgentoWebGlyph.ChevronDown,
            contentDescription = null,
            modifier = Modifier
                .size(13.dp)
                .rotate(180f),
            tint = colors.secondaryContent,
        )
    }
}

/**
 * Expanded action card content living inside the island surface.
 */
@Composable
internal fun ApprovalCardContent(
    approval: PermissionRequestUiState,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onReviewChanges: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(Color(0xFFF59E0B)),
            )
            Text(
                text = stringResource(R.string.journey_approval_needed),
                style = MaterialTheme.typography.titleSmall.copy(
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 14.sp,
                ),
                color = colors.primaryContent,
            )
        }

        // Description / Scope
        val localized = localizedExplanation(approval.explanation)
        val providerDescription = approval.reason.takeIf { it.isNotBlank() && it != "The agent is waiting for your decision before continuing." }
        val description = localized?.summary?.takeIf { localized.operation != null && it.isNotBlank() }
            ?: providerDescription ?: localized?.summary?.takeIf(String::isNotBlank)
            ?: approval.title.ifBlank { "Action requires user confirmation" }
        if (providerDescription != null && description == providerDescription) {
            Text(stringResource(R.string.approval_provider_heading), style = MaterialTheme.typography.labelSmall, color = colors.secondaryContent)
        }
        var descriptionOverflows by remember(approval.id, description) { mutableStateOf(false) }
        Text(
            text = description,
            onTextLayout = { descriptionOverflows = it.hasVisualOverflow },
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 13.sp,
                lineHeight = 18.sp,
            ),
            color = colors.secondaryContent,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (approval.executorUnavailableReasonCode == "macos_administrator_unavailable") {
            Text(stringResource(R.string.approval_macos_executor_unavailable),
                style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }

        val scopeDetails = buildList {
            approval.reason.takeIf { it.isNotBlank() && it != description && it != "The agent is waiting for your decision before continuing." }
                ?.let { add(stringResource(R.string.approval_provider_description, it)) }
            approval.command?.takeIf(String::isNotBlank)?.let { add(stringResource(R.string.attention_command, it)) }
            approval.cwd?.takeIf(String::isNotBlank)?.let { add(stringResource(R.string.attention_directory, it)) }
            addAll(approval.filePaths.filter(String::isNotBlank))
            approval.grantRoot?.takeIf(String::isNotBlank)?.let { add(it) }
            approvalPermissionDetails(approval.permissionsJson).forEach { detail ->
                add(if (detail.label == R.string.approval_scope_network) stringResource(R.string.approval_scope_network)
                    else detail.label?.let { stringResource(it, detail.value) } ?: detail.value)
            }
        }.distinct()
        if (scopeDetails.isNotEmpty() || approval.explanation != null) {
            Column(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                approval.explanation?.let { explanation ->
                    ApprovalExplanationContent(explanation, skipSummary = (localized?.operation == null && localized?.riskCode != null) || (localized?.summary == description && !descriptionOverflows))
                }
                scopeDetails.forEach { detail ->
                    Text(detail, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
                }
            }
        }

        // Review is a separate, non-decision action. Keeping it above the
        // decision pair leaves both targets usable on narrow/large-text screens.
        if (approval.actions.isNotEmpty()) {
            Surface(
                onClick = onReviewChanges,
                shape = RoundedCornerShape(8.dp),
                color = Color.Transparent,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Box(Modifier.padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
                    Text(
                        text = "Review changes",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.accentPrimary,
                    )
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                onClick = onDeny,
                enabled = !approval.resolving,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                shape = RoundedCornerShape(50),
                color = if (isDark) Color(0x1AFFFFFF) else Color(0x0F000000),
            ) {
                Box(
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = approvalLabel(approval.denyLabel, stringResource(R.string.attention_deny)),
                        style = MaterialTheme.typography.labelMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 12.5.sp,
                        ),
                        color = if (approval.resolving) colors.disabledContent else colors.primaryContent,
                    )
                }
            }

            if (approval.executorUnavailableReasonCode != "macos_administrator_unavailable") Surface(
                onClick = onApprove,
                enabled = !approval.resolving,
                modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                shape = RoundedCornerShape(50),
                color = if (approval.resolving) colors.strongSurface else colors.actionPrimary,
            ) {
                Box(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = approvalLabel(approval.approveLabel, stringResource(R.string.attention_approve)),
                        style = MaterialTheme.typography.labelMedium.copy(
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 12.5.sp,
                        ),
                        color = if (approval.resolving) colors.disabledContent else colors.actionPrimaryContent,
                    )
                }
            }
        }
    }
}

/**
 * 38dp compact centered floating pill when offline or connection failed.
 * Content-hugging capsule: strictly vertically centered text and icons,
 * eliminating the awkward stretched-flat appearance.
 */
@Composable
private fun OfflineStatusDock(
    onRetry: () -> Unit,
    backdropLayer: GraphicsLayer?,
    backdropOrigin: IntOffset,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    AgentoFrostedGlassBox(
        modifier = modifier
            .wrapContentWidth(Alignment.CenterHorizontally)
            .height(38.dp)
            .onGloballyPositioned { coords ->
                val pos = coords.positionInRoot()
                backdropOffset = IntOffset(
                    backdropOrigin.x - pos.x.roundToInt(),
                    backdropOrigin.y - pos.y.roundToInt(),
                )
            },
        shape = AgentoShapes.PillShape,
        surface = AgentoGlassSurface.Tinted(if (isDark) Color(0xFF1E1E22).copy(alpha = 0.88f) else Color.White.copy(alpha = 0.90f)),
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        showTopHairline = false,
        hasShadow = true,
        shadowElevation = 5.dp,
        shadowAlpha = if (isDark) 0.15f else 0.05f,
    ) {
        Row(
            modifier = Modifier
                .wrapContentWidth()
                .height(38.dp)
                .padding(start = 14.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // Status Indicator + Caption: Perfect vertical alignment
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(6.5.dp)
                        .clip(CircleShape)
                        .background(colors.stateError),
                )
                Text(
                    text = "Offline · Showing last synced work",
                    style = MaterialTheme.typography.bodySmall.copy(
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Normal,
                        platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                        lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                            alignment = androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                            trim = androidx.compose.ui.text.style.LineHeightStyle.Trim.Both,
                        ),
                    ),
                    color = colors.secondaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            // Divider pip
            Box(
                modifier = Modifier
                    .size(width = 1.dp, height = 12.dp)
                    .background(if (isDark) Color.White.copy(alpha = 0.15f) else Color.Black.copy(alpha = 0.10f)),
            )

            // Clean, integrated Retry text button
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .agentoPressScale(pressedScale = 0.94f, onClick = onRetry)
                    .padding(horizontal = 6.dp, vertical = 4.dp)
                    .semantics { contentDescription = "Retry connection" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = colors.accentPrimary,
                )
                Text(
                    text = "Retry",
                    style = MaterialTheme.typography.labelMedium.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 12.sp,
                        platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
                        lineHeightStyle = androidx.compose.ui.text.style.LineHeightStyle(
                            alignment = androidx.compose.ui.text.style.LineHeightStyle.Alignment.Center,
                            trim = androidx.compose.ui.text.style.LineHeightStyle.Trim.Both,
                        ),
                    ),
                    color = colors.accentPrimary,
                )
            }
        }
    }
}
