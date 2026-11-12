package com.andysagent.agentoc.feature.workbench

import androidx.compose.material3.ButtonDefaults

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.snap
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CheckCircleOutline
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.NotificationImportant
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoBackdropTone
import com.andysagent.agentoc.core.designsystem.AgentoDiffuseShadowBox
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import com.andysagent.agentoc.core.designsystem.AgentocColors
import com.andysagent.agentoc.core.designsystem.AgentocMotion
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.AgentoIcon
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoTextField
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.designsystem.MotionPreference
import com.andysagent.agentoc.core.designsystem.motionPolicy
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.model.AttentionItem
import com.andysagent.agentoc.core.model.AttentionKind
import com.andysagent.agentoc.core.model.AttentionReducer
import com.andysagent.agentoc.core.model.AttentionUiState
import com.andysagent.agentoc.core.model.Approval
import com.andysagent.agentoc.core.model.ApprovalOption
import com.andysagent.agentoc.core.model.ApprovalQuestion
import com.andysagent.agentoc.core.model.ApprovalAction
import com.andysagent.agentoc.feature.workbench.R

private val AttentionCardShape = RoundedCornerShape(AgentoShapes.Sheet)
// A fixed capsule radius keeps tall multi-question content readable. A 50%
// radius scales with the card height and clips the content into an oval.
private val AskUserCardShape = RoundedCornerShape(32.dp)
private val MaxAttentionCardWidth = 520.dp
private val AttentionShadowPadding = 16.dp

@Composable
private fun AttentionNoticeSurface(modifier: Modifier, shape: Shape, question: Boolean,
    backdropLayer: GraphicsLayer?, backdropOffset: IntOffset, content: @Composable BoxScope.() -> Unit) {
    val colors = LocalAgentocColors.current
    if (question) {
        Surface(modifier, shape = shape, color = colors.surfaceLow, tonalElevation = 0.dp) {
            Box(content = content)
        }
    } else AgentoFrostedGlassBox(modifier = modifier, shape = shape,
        surface = AgentoGlassSurface.Neutral, blurRadius = AgentoFrostedTokens.BlurNavigation,
        showTopHairline = true, backdropTone = AgentoBackdropTone.QuietHeader,
        material = AgentoGlassMaterial.LiquidClear, backdropLayer = backdropLayer, backdropOffset = backdropOffset,
        hasShadow = true, shadowElevation = 14.dp,
        shadowAlpha = if (colors.canvas.red < 0.5f) 0.08f else 0.065f,
        shadowSpotAlpha = if (colors.canvas.red < 0.5f) 0.06f else 0.02f, content = content)
}

/**
 * Global cross-session attention overlay. Presentation only: every fact comes
 * from [AttentionUiState], decisions go through [AttentionEvent], and Session
 * navigation is delegated to the host screen. The surface is intentionally
 * non-blocking — no scrim — so the workbench below stays operable.
 */
@Composable
fun AttentionSurface(
    state: AttentionUiState,
    onEvent: (AttentionEvent) -> Unit,
    onOpenSession: (String) -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
    onRetainedPresenceChanged: (Boolean) -> Unit = {},
) {
    val item = state.activeItem
    var interacted by remember(item?.id) { mutableStateOf(false) }
    LaunchedEffect(item?.id, interacted, state.expanded, state.resolvingItemId) {
        val current = item ?: return@LaunchedEffect
        if (!current.isApproval && !interacted && !state.expanded && state.resolvingItemId != current.id) {
            delay(12_000)
            onEvent(AttentionEvent.Dismiss(current.id))
        }
    }
    BackHandler(enabled = item != null) {
        item?.let { onEvent(AttentionEvent.Dismiss(it.id)) }
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))
            .padding(top = 8.dp, start = 16.dp, end = 16.dp)
            .clipToBounds(),
        contentAlignment = Alignment.TopCenter,
    ) {
        val policy = motionPolicy()
        val reducedTravel = with(LocalDensity.current) { 8.dp.roundToPx() }
        // Retain the actual card through its exit. Its glass and shadow move
        // together at full strength; fading the whole layer reveals raw text.
        val presence = remember { MutableTransitionState<AttentionItem?>(null) }
        presence.targetState = item
        val transition = rememberTransition(presence, label = "attention_presence")
        SideEffect {
            onRetainedPresenceChanged(presence.currentState != null || presence.targetState != null)
        }
        transition.AnimatedContent(
            transitionSpec = {
                val transition = when (policy.preference) {
                    MotionPreference.None -> EnterTransition.None togetherWith ExitTransition.None
                    MotionPreference.Reduced -> slideInVertically(tween(90)) { -reducedTravel } togetherWith
                        slideOutVertically(tween(90)) { -reducedTravel }
                    MotionPreference.Full -> slideInVertically(tween(280)) { -it } togetherWith
                        slideOutVertically(tween(220)) { -it }
                }
                val exitMillis = when (policy.preference) {
                    MotionPreference.None -> 0
                    MotionPreference.Reduced -> 90
                    MotionPreference.Full -> 220
                }
                // The safe-area clip must retain its outgoing viewport until
                // the last travel frame. Snapping its height to the empty
                // target erases the card even though AnimatedContent retains it.
                transition.using(SizeTransform(clip = false) { initialSize, targetSize ->
                    if (targetSize.height == 0 && exitMillis > 0) keyframes {
                        durationMillis = exitMillis
                        initialSize at 0
                        initialSize at exitMillis - 1
                        targetSize at exitMillis
                    } else snap()
                })
            },
            contentAlignment = Alignment.TopCenter,
            contentKey = { it?.id },
        ) { current ->
            current?.let { visibleItem ->
                val currentItem = item?.id == visibleItem.id
                // A dismissal clears the business state immediately. Preserve
                // only its exiting presentation, not a new collapsed/errorless
                // card while the original card is still travelling out.
                var retainedState by remember(visibleItem.id) { mutableStateOf(state) }
                if (currentItem) retainedState = state
                Box(Modifier.testTag("attention-retained-surface").pointerInput(visibleItem.id, currentItem) {
                    awaitPointerEventScope {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Initial)
                            if (currentItem && event.changes.any { it.pressed && !it.previousPressed }) interacted = true
                        }
                    }
                }.then(if (currentItem) Modifier else Modifier
                    .clearAndSetSemantics { }
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                        }
                    })) {
                AttentionCard(
                    item = visibleItem,
                    expanded = retainedState.expanded,
                    resolving = retainedState.resolvingItemId == visibleItem.id,
                    error = retainedState.error,
                    queuedCount = retainedState.queuedCount,
                    onEvent = { if (currentItem) onEvent(it) },
                    onOpenSession = { if (currentItem) onOpenSession(it) },
                    backdropLayer = backdropLayer,
                )
                }
            }
        }
    }
}

@Composable
private fun AttentionCard(
    item: AttentionItem,
    expanded: Boolean,
    resolving: Boolean,
    error: String?,
    queuedCount: Int,
    onEvent: (AttentionEvent) -> Unit,
    onOpenSession: (String) -> Unit,
    backdropLayer: GraphicsLayer?,
) {
    val colors = LocalAgentocColors.current
    val isAskUser = item.kind == AttentionKind.Question && item.isApproval && !item.requiresSession
    val isApprovalNotification = item.isApproval && !isAskUser
    val isPrivilegedCategoryBatch = item.approval?.kind == "privileged_batch_request" && !item.requiresSession
    val isActionBatch = isApprovalNotification && item.approval?.actions?.isNotEmpty() == true && !item.requiresSession
    val isDangerousBatch = item.approval?.batchId != null
    val hasHighRiskAction = isDangerousBatch || item.approval?.riskLevel
        ?.trim()
        ?.lowercase() in setOf("high", "critical", "danger", "dangerous", "severe", "elevated") ||
        item.approval?.actions.orEmpty().any { action ->
            action.risk?.trim()?.lowercase() in setOf("high", "critical", "danger", "dangerous", "severe", "elevated")
        }
    val questions = if (isAskUser) approvalQuestions(item) else emptyList()
    var selectedOptions by remember(item.id, questions) { mutableStateOf<Map<Int, Set<Int>>>(emptyMap()) }
    var customAnswers by remember(item.id, questions) { mutableStateOf<Map<Int, String>>(emptyMap()) }
    var selectedActionIds by remember(item.id) {
        mutableStateOf(item.approval?.actions.orEmpty()
            .filter { it.state in setOf("proposed", "classified", "waiting_user") }
            .filter { action -> !isPrivilegedCategoryBatch ||
                (action.category?.let { item.approval?.defaultSelectedByCategory?.get(it) }?.contains(action.id)
                    ?: (action.category == "privileged_other")) }
            .map { it.id }.toSet())
    }
    val kindLabel = when {
        hasHighRiskAction -> stringResource(R.string.attention_high_risk)
        isApprovalNotification -> stringResource(R.string.attention_approval)
        else -> kindLabel(item.kind)
    }
    val accent = if (hasHighRiskAction) colors.stateError else kindAccent(colors, item.kind)
    // The decision itself is the headline; source and status are supporting information.
    val localized = localizedExplanation(item.approval?.explanation?.toExplanationUiState())
    val originalPresentation = approvalPresentation(item)
    val presentation = if (localized?.riskCode != null || localized?.operation != null) originalPresentation.copy(
        headline = if (localized.operation != null) localized.summary ?: originalPresentation.headline
            else item.approval?.reason?.takeIf(String::isNotBlank) ?: localized.summary ?: originalPresentation.headline,
        consequence = localized.reason ?: originalPresentation.consequence,
    ) else originalPresentation
    val headline = if (isAskUser) questionPrompt(item) else presentation.headline
    var headlineOverflows by remember(item.id, headline) { mutableStateOf(false) }
    var consequenceOverflows by remember(item.id, presentation.consequence) { mutableStateOf(false) }
    val supportingSummary = item.summary.trim().takeIf { summary ->
        summary.isNotBlank() && summary != headline
    }
    val announcement = "$kindLabel，${item.sessionTitle}，$headline"
    val cardShape = if (isAskUser) AskUserCardShape else AttentionCardShape
    val density = LocalDensity.current
    val motion = motionPolicy()
    val scope = rememberCoroutineScope()
    val expandInteractionSource = remember(item.id) { MutableInteractionSource() }
    val currentOnEvent by rememberUpdatedState(onEvent)
    val offset = remember(item.id) { Animatable(0f) }
    var dragOffset by remember(item.id) { mutableStateOf(0f) }
    var isDragging by remember(item.id) { mutableStateOf(false) }
    var backdropOffset by remember(item.id) { mutableStateOf(IntOffset.Zero) }
    val canExpandByTappingCard = !expanded && !resolving && (isApprovalNotification || isAskUser)
    val disclosureMotion = rememberAttentionDisclosureMotion(expanded)
    val disclosureProgress = disclosureMotion.progress(expanded)
    val approvalScroll = rememberScrollState()
    BoxWithConstraints(
        modifier = Modifier
            .widthIn(max = MaxAttentionCardWidth + AttentionShadowPadding * 2)
    ) {
        val widthPx = with(density) {
            (maxWidth - AttentionShadowPadding * 2).toPx().coerceAtLeast(1f)
        }
        val displayedOffset = if (isDragging) dragOffset else offset.value
        AgentoDiffuseShadowBox(
            modifier = Modifier.fillMaxWidth().graphicsLayer { translationX = displayedOffset },
            shape = cardShape,
            shadowPadding = AttentionShadowPadding,
            shadowPaddingVertical = 8.dp,
            shadowBlur = 24.dp,
            shadowAlpha = 0.05f,
            shadowSpotAlpha = 0.06f,
        ) {
            AttentionNoticeSurface(
                modifier = Modifier
                    .fillMaxWidth()
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        backdropOffset = IntOffset(
                            -position.x.roundToInt(),
                            -position.y.roundToInt(),
                        )
                    }
                    // Match the Web notification's discoverable disclosure:
                    // a collapsed card itself is a quick expand target while
                    // the chevron remains a precise, explicit affordance.
                    // Child actions retain their own click handlers and a
                    // horizontal drag still wins over this tap gesture.
                    .then(
                        if (canExpandByTappingCard) {
                            Modifier.clickable(
                                interactionSource = expandInteractionSource,
                                indication = null,
                                role = Role.Button,
                            ) {
                                currentOnEvent(AttentionEvent.SetExpanded(item.id, true))
                            }
                        } else {
                            Modifier
                        },
                    )
                    .pointerInput(item.id, widthPx, motion.preference) {
                    val thresholdPx = (widthPx * 0.4f).coerceAtLeast(with(density) { 120.dp.toPx() })
                    val velocityThresholdPx = with(density) { 1_000.dp.toPx() }
                    val velocityTracker = VelocityTracker()

                    fun settle(target: Float, dismiss: Boolean) {
                        scope.launch {
                            offset.snapTo(dragOffset)
                            isDragging = false
                            if (motion.preference == MotionPreference.None) {
                                offset.snapTo(target)
                            } else {
                                offset.animateTo(
                                    targetValue = target,
                                    animationSpec = if (dismiss) AgentocMotion.AppleSpring else AgentocMotion.AppleReleaseSpring,
                                )
                            }
                            if (dismiss) currentOnEvent(AttentionEvent.Dismiss(item.id))
                        }
                    }

                    detectHorizontalDragGestures(
                        onDragStart = {
                            velocityTracker.resetTracking()
                            dragOffset = offset.value
                            isDragging = true
                            scope.launch { offset.stop() }
                        },
                        onHorizontalDrag = { change, dragAmount ->
                            velocityTracker.addPosition(change.uptimeMillis, change.position)
                            change.consume()
                            val rawOffset = (dragOffset + dragAmount).coerceAtLeast(0f)
                            dragOffset = if (rawOffset <= thresholdPx) {
                                rawOffset
                            } else {
                                thresholdPx + (rawOffset - thresholdPx) * 0.35f
                            }
                        },
                        onDragEnd = {
                            val velocity = velocityTracker.calculateVelocity().x
                            val dismiss = dragOffset >= thresholdPx || velocity >= velocityThresholdPx
                            if (dismiss) {
                                settle(widthPx * 1.2f, dismiss = true)
                            } else {
                                settle(0f, dismiss = false)
                            }
                        },
                        onDragCancel = { settle(0f, dismiss = false) },
                    )
                    }
                    .semantics {
                        liveRegion = if (item.kind == AttentionKind.Approval) LiveRegionMode.Assertive else LiveRegionMode.Polite
                        contentDescription = "$announcement，向右滑动关闭通知"
                    },
                shape = cardShape,
                question = isAskUser,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOffset,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth().testTag("attention-card-content")
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                if (isApprovalNotification) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AgentoIcon(kindIcon(item.kind), null, Modifier.size(18.dp), tint = accent)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f)) {
                            Text(item.sessionTitle, Modifier.testTag("attention-source"),
                                color = colors.secondaryContent, style = MaterialTheme.typography.labelMedium,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(kindLabel, color = accent, style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Medium)
                        }
                        IconButton(
                            onClick = { onEvent(AttentionEvent.SetExpanded(item.id, !expanded)) },
                            enabled = !resolving,
                            modifier = Modifier.size(AgentocSpacing.MinTouchTarget),
                        ) {
                            Icon(Icons.Outlined.ExpandMore,
                                contentDescription = stringResource(if (expanded) R.string.attention_collapse else R.string.attention_expand),
                                modifier = Modifier.rotate(180f * disclosureProgress), tint = colors.secondaryContent)
                        }
                        IconButton(onClick = { onEvent(AttentionEvent.Dismiss(item.id)) }, enabled = !resolving,
                            modifier = Modifier.size(AgentocSpacing.MinTouchTarget)) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.approval_notice_close), tint = colors.secondaryContent)
                        }
                    }
                    Text(headline, Modifier.testTag("attention-headline"), color = colors.primaryContent,
                        style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                        onTextLayout = { headlineOverflows = it.hasVisualOverflow })
                    if (localized?.operation == null && item.approval?.reason?.isNotBlank() == true && item.approval?.reason == headline) {
                        Text(stringResource(R.string.approval_provider_heading), color = colors.secondaryContent,
                            style = MaterialTheme.typography.labelSmall)
                    }
                    presentation.consequence?.let { consequence ->
                        // Expanded content owns the full value if the brief version
                        // was truncated, so do not show the same risk twice.
                        if (!(expanded && consequenceOverflows && localized?.reason == consequence)) {
                            Spacer(Modifier.size(6.dp))
                            Text(consequence, Modifier.testTag("attention-consequence"), color = colors.secondaryContent,
                                style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                onTextLayout = { consequenceOverflows = it.hasVisualOverflow })
                        }
                    }
                    if (queuedCount > 0) {
                        Spacer(Modifier.size(4.dp))
                        Text(stringResource(R.string.attention_queued, queuedCount), color = colors.tertiaryContent,
                            style = MaterialTheme.typography.labelSmall)
                    }
                } else if (isAskUser) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(item.sessionTitle, Modifier.weight(1f), color = colors.secondaryContent,
                            style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        IconButton(onClick = { onEvent(AttentionEvent.SetExpanded(item.id, !expanded)) }, enabled = !resolving,
                            modifier = Modifier.size(AgentocSpacing.MinTouchTarget)) {
                            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                                contentDescription = if (expanded) "收起问题详情" else "展开问题详情", tint = colors.secondaryContent)
                        }
                        IconButton(onClick = { onEvent(AttentionEvent.Dismiss(item.id)) }, enabled = !resolving,
                            modifier = Modifier.size(AgentocSpacing.MinTouchTarget)) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.approval_notice_close), tint = colors.secondaryContent)
                        }
                    }
                    Text(headline, color = colors.primaryContent, style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold, maxLines = if (expanded) Int.MAX_VALUE else 2,
                        overflow = TextOverflow.Ellipsis)
                    if (queuedCount > 0) Text(stringResource(R.string.attention_queued, queuedCount),
                        color = colors.tertiaryContent, style = MaterialTheme.typography.labelSmall)
                } else {
                Row(verticalAlignment = Alignment.Top) {
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(accent.copy(alpha = if (colors.canvas.red < 0.5f) 0.20f else 0.12f))
                            .border(
                                0.5.dp,
                                accent.copy(alpha = if (colors.canvas.red < 0.5f) 0.45f else 0.30f),
                                RoundedCornerShape(10.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoIcon(
                            imageVector = kindIcon(item.kind),
                            contentDescription = kindLabel,
                            modifier = Modifier.size(20.dp),
                            tint = accent,
                        )
                    }
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                            Text(
                                text = item.sessionTitle,
                                color = colors.primaryContent,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        if (isAskUser) {
                            // The question itself is the headline; the generic
                            // "等待回答" label stays only in the accessibility
                            // announcement.
                            Text(
                                text = headline,
                                color = colors.primaryContent,
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = if (expanded) 4 else 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        } else if (!isApprovalNotification) {
                            Text(
                                text = kindLabel,
                                color = accent,
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Medium,
                            )
                        }
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        if (isApprovalNotification || isAskUser) {
                            IconButton(
                                onClick = {
                                    onEvent(AttentionEvent.SetExpanded(item.id, !expanded))
                                },
                                enabled = !resolving,
                                modifier = Modifier.size(AgentocSpacing.MinTouchTarget),
                            ) {
                                Icon(
                                    imageVector = if (expanded) {
                                        Icons.Outlined.ExpandLess
                                    } else {
                                        Icons.Outlined.ExpandMore
                                    },
                                    contentDescription = when {
                                        isApprovalNotification && expanded -> "收起审批详情"
                                        isApprovalNotification -> "展开审批详情"
                                        expanded -> "收起问题详情"
                                        else -> "展开问题详情"
                                    },
                                    tint = colors.secondaryContent,
                                )
                            }
                        }
                        IconButton(onClick = { onEvent(AttentionEvent.Dismiss(item.id)) }, enabled = !resolving,
                            modifier = Modifier.size(AgentocSpacing.MinTouchTarget)) {
                            Icon(Icons.Outlined.Close, contentDescription = stringResource(R.string.approval_notice_close), tint = colors.secondaryContent)
                        }
                        if (queuedCount > 0) {
                            Text(
                                text = "还有 $queuedCount 项",
                                color = colors.tertiaryContent,
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                }
                }
                Spacer(Modifier.size(AgentocSpacing.Compact))
                if (isApprovalNotification) {
                    AttentionDisclosure(expanded, disclosureProgress, disclosureMotion::record) {
                    // Keep all technical material inside one bounded scroll
                    // region. The action rail below never scrolls away.
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 300.dp)
                            .attentionContentEdges(top = { approvalScroll.canScrollBackward }, bottom = { approvalScroll.canScrollForward })
                            .verticalScroll(approvalScroll),
                        verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
                    ) {
                        item.approval?.explanation?.let { explanation ->
                            ApprovalExplanationContent(explanation.toExplanationUiState(), skipSummary = (localized?.operation == null && localized?.riskCode != null) || (localized?.summary == headline && !headlineOverflows), skipReason = localized?.reason != null && localized.reason == presentation.consequence && !consequenceOverflows)
                        }
                        if (isPrivilegedCategoryBatch) {
                            if (item.approval?.executorUnavailableReasonCode == "macos_administrator_unavailable") {
                                Text(stringResource(R.string.approval_macos_executor_unavailable), color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
                            }
                            listOf("privileged_other" to R.string.approval_category_privileged,
                                "destructive_delete" to R.string.approval_category_delete).forEach { (category, title) ->
                                val actions = item.approval?.actions.orEmpty().filter { it.category == category }
                                if (actions.isNotEmpty()) ActionBatchDetails(actions, selectedActionIds,
                                    !resolving && expanded && disclosureProgress >= 0.999f && item.approval?.executorUnavailableReasonCode != "macos_administrator_unavailable",
                                    onToggle = { actionId -> selectedActionIds = if (actionId in selectedActionIds) selectedActionIds - actionId else selectedActionIds + actionId },
                                    heading = title)
                            }
                        } else if (isActionBatch) {
                            ActionBatchDetails(
                                actions = item.approval?.actions.orEmpty(),
                                selectedActionIds = selectedActionIds,
                                enabled = !resolving && expanded && disclosureProgress >= 0.999f,
                                onToggle = { actionId ->
                                    selectedActionIds = if (actionId in selectedActionIds) {
                                        selectedActionIds - actionId
                                    } else {
                                        selectedActionIds + actionId
                                    }
                                },
                            )
                        }
                        ApprovalDetails(item, skipActionList = isActionBatch,
                            skipProviderDescription = item.approval?.reason == headline && !headlineOverflows)
                        Spacer(Modifier.size(AgentocSpacing.Compact))
                    }
                    }
                } else {
                    if (!isAskUser) {
                        supportingSummary?.let { summary ->
                            Text(
                                text = summary,
                                color = colors.secondaryContent,
                                style = MaterialTheme.typography.bodyMedium,
                                // Brief state stays glanceable. The complete
                                // scope is available through the card itself
                                // or its chevron.
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    val reasonText = item.reason
                    if (expanded && !reasonText.isNullOrBlank() && reasonText != item.summary) {
                        Spacer(Modifier.size(AgentocSpacing.Compact))
                        Text(
                            text = reasonText,
                            color = colors.secondaryContent,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                Spacer(Modifier.size(AgentocSpacing.Compact))
                if (isAskUser) {
                    QuestionOptionsBody(
                        item = item,
                        questions = questions,
                        expanded = expanded,
                        resolving = resolving,
                        selectedOptions = selectedOptions,
                        customAnswers = customAnswers,
                        onSelectOption = { questionIndex, optionIndex ->
                            val previous = selectedOptions[questionIndex].orEmpty()
                            val multi = questions[questionIndex].isMultiSelect
                            val next = if (multi) previous.let { if (optionIndex in it) it - optionIndex else it + optionIndex } else setOf(optionIndex)
                            selectedOptions = selectedOptions + (questionIndex to next)
                            if (!multi) customAnswers = customAnswers - questionIndex
                        },
                        onCustomAnswerChange = { questionIndex, answer ->
                            customAnswers = if (answer.isEmpty()) {
                                customAnswers - questionIndex
                            } else {
                                customAnswers + (questionIndex to answer)
                            }
                            if (answer.isNotEmpty() && !questions[questionIndex].isMultiSelect) {
                                selectedOptions = selectedOptions - questionIndex
                            }
                        },
                        onEvent = onEvent,
                    )
                    Spacer(Modifier.size(AgentocSpacing.Compact))
                    QuestionAnswerRail(
                        item = item,
                        questions = questions,
                        selectedOptions = selectedOptions,
                        customAnswers = customAnswers,
                        resolving = resolving,
                        onEvent = onEvent,
                    )
                    TextButton(onClick = { onOpenSession(item.sessionId) }, enabled = !resolving,
                        modifier = Modifier.align(Alignment.End)) { Text("详情", color = colors.secondaryContent) }
                } else if (isPrivilegedCategoryBatch) {
                    PrivilegedCategoryActions(item, selectedActionIds, resolving, error, onEvent, onOpenSession)
                } else {
                    AttentionActions(
                        item = item,
                        resolving = resolving,
                        error = error,
                        onEvent = onEvent,
                        onOpenSession = onOpenSession,
                        selectedActionIds = selectedActionIds,
                        onResolveActionBatch = { onEvent(AttentionEvent.ResolveActionBatch(item.id, selectedActionIds)) },
                        onDenyActionBatch = { onEvent(AttentionEvent.ResolveActionBatch(item.id, emptySet(), "deny")) },
                    )
                }
                }
            }
        }
    }
}

/**
 * Ask-user options. A single question keeps the compact direct-answer flow;
 * multiple questions show all question groups in an internal scroll region so
 * the user can collect a complete answer set before submitting it.
 */
@Composable
private fun QuestionOptionsBody(
    item: AttentionItem,
    questions: List<ApprovalQuestion>,
    expanded: Boolean,
    resolving: Boolean,
    selectedOptions: Map<Int, Set<Int>>,
    customAnswers: Map<Int, String>,
    onSelectOption: (Int, Int) -> Unit,
    onCustomAnswerChange: (Int, String) -> Unit,
    onEvent: (AttentionEvent) -> Unit,
) {
    val colors = LocalAgentocColors.current
    val options = questions.firstOrNull()?.options.orEmpty()
    if (questions.size > 1 || questions.any { it.isMultiSelect }) {
        val answeredCount = questions.indices.count { questionIndex ->
            selectedOptions[questionIndex].orEmpty().isNotEmpty() ||
                customAnswers[questionIndex].orEmpty().trim().isNotEmpty()
        }
        if (questions.size > 1) {
            Text(text = "已回答 $answeredCount/${questions.size}", color = colors.tertiaryContent,
                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
            Spacer(Modifier.size(AgentocSpacing.xs))
        }
        val policy = motionPolicy()
        val duration = policy.duration(AgentocMotion.Feedback)
        AnimatedVisibility(
            visible = expanded,
            enter = if (policy.preference == MotionPreference.None) {
                EnterTransition.None
            } else {
                fadeIn(tween(duration)) + expandVertically(tween(duration))
            },
            exit = if (policy.preference == MotionPreference.None) {
                ExitTransition.None
            } else {
                fadeOut(tween(duration))
            },
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 320.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
            ) {
                questions.forEachIndexed { questionIndex, question ->
                    if (questions.size > 1 && question.question.isNotBlank()) {
                        Text(
                            text = "问题 ${questionIndex + 1}：${question.question}",
                            color = colors.primaryContent,
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    question.options.forEachIndexed { optionIndex, option ->
                        QuestionOptionRow(
                            optionNumber = optionIndex + 1,
                            label = option.label,
                            description = option.description,
                            enabled = !resolving,
                            selected = optionIndex in selectedOptions[questionIndex].orEmpty(),
                            onClick = { onSelectOption(questionIndex, optionIndex) },
                        )
                    }
                    AgentoTextField(
                        value = customAnswers[questionIndex].orEmpty(),
                        onValueChange = { onCustomAnswerChange(questionIndex, it) },
                        label = "其他回复",
                        enabled = !resolving,
                        // Multi-question answers are committed by the footer
                        // button; neither IME action nor Enter submits them.
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.None),
                        modifier = Modifier
                            .fillMaxWidth()
                            .semantics {
                                contentDescription = "问题 ${questionIndex + 1} 的自定义回复"
                            },
                    )
                }
            }
        }
        return
    }
    if (options.isEmpty()) return
    val hasHiddenOptions = questions.sumOf { it.options.size } > 1
    val policy = motionPolicy()
    val duration = policy.duration(AgentocMotion.Feedback)
    val firstOption = options.first()
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
    ) {
        Box(modifier = Modifier.weight(1f)) {
            QuestionOptionRow(
                optionNumber = 1,
                label = firstOption.label,
                description = firstOption.description,
                enabled = !resolving,
                selected = false,
                onClick = {
                    if (expanded) onEvent(AttentionEvent.ResolveQuestion(item.id, 0, 0))
                    else onEvent(AttentionEvent.SetExpanded(item.id, true))
                },
            )
        }
    }
    AnimatedVisibility(
        visible = expanded && hasHiddenOptions,
        enter = if (policy.preference == MotionPreference.None) {
            EnterTransition.None
        } else {
            fadeIn(tween(duration)) + expandVertically(tween(duration))
        },
        exit = if (policy.preference == MotionPreference.None) {
            ExitTransition.None
        } else {
            fadeOut(tween(duration))
        },
    ) {
        Column(
            modifier = Modifier.padding(top = AgentocSpacing.Compact),
            verticalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            questions.forEachIndexed { questionIndex, question ->
                if (questions.size > 1 && question.question.isNotBlank()) {
                    Text(
                        text = question.question,
                        color = colors.tertiaryContent,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
                question.options.forEachIndexed { optionIndex, option ->
                    if (questionIndex != 0 || optionIndex != 0) {
                        val optionNumber = questions
                            .take(questionIndex)
                            .sumOf { it.options.size } + optionIndex + 1
                        QuestionOptionRow(
                            optionNumber = optionNumber,
                            label = option.label,
                            description = option.description,
                            enabled = !resolving,
                            selected = false,
                            onClick = {
                                onEvent(AttentionEvent.ResolveQuestion(item.id, questionIndex, optionIndex))
                            },
                        )
                    }
                }
            }
        }
    }
}

/** A single ask-user option; multi-question prompts keep the choice local until submission. */
@Composable
private fun QuestionOptionRow(
    optionNumber: Int,
    label: String,
    description: String?,
    enabled: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalAgentocColors.current
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        color = if (selected) colors.accentPrimary.copy(alpha = 0.09f) else colors.canvas,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .semantics {
                contentDescription = "以此选项回答：$label"
                stateDescription = if (selected) "已选择" else "未选择"
            },
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            Text(optionNumber.toString(), Modifier.width(20.dp), color = colors.secondaryContent,
                style = MaterialTheme.typography.labelMedium)
            Column(Modifier.weight(1f)) {
                Text(
                    text = label,
                    color = colors.primaryContent,
                    style = MaterialTheme.typography.bodyMedium,
                )
                val detail = questionOptionDetail(label, description)
                if (detail != null) {
                    Spacer(Modifier.size(AgentocSpacing.xs))
                    Text(
                        text = detail,
                        color = colors.secondaryContent,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            if (selected) {
                Icon(
                    imageVector = Icons.Outlined.CheckCircleOutline,
                    contentDescription = null,
                    tint = colors.accentPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

/**
 * Ask-user answer rail. Multi-question prompts use one footer send action for
 * the complete answer set and deny action; single-question prompts retain the
 * compact direct answer field and deny action.
 */
@Composable
private fun QuestionAnswerRail(
    item: AttentionItem,
    questions: List<ApprovalQuestion>,
    selectedOptions: Map<Int, Set<Int>>,
    customAnswers: Map<Int, String>,
    resolving: Boolean,
    onEvent: (AttentionEvent) -> Unit,
) {
    if (questions.size > 1 || questions.any { it.isMultiSelect }) {
        val customAnswerIndexes = questions.indices.filter { questionIndex ->
            selectedOptions[questionIndex].orEmpty().isEmpty() &&
                customAnswers[questionIndex].orEmpty().trim().isNotEmpty()
        }
        val answeredCount = questions.indices.count { questionIndex ->
            selectedOptions[questionIndex].orEmpty().isNotEmpty() ||
                questionIndex in customAnswerIndexes
        }
        val canSubmit = answeredCount == questions.size
        val normalizedAnswer = customAnswerIndexes.singleOrNull()?.let { index ->
            customAnswers[index].orEmpty().trim()
        }.orEmpty()
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            AgentoButton(
                text = "发送",
                onClick = {
                    if (questions.any { it.isMultiSelect }) onEvent(AttentionEvent.ResolveMultiChoices(
                        item.id, questions.indices.map { selectedOptions[it].orEmpty().sorted() },
                        questions.indices.map { customAnswers[it].orEmpty().trim() },
                    )) else onEvent(
                        AttentionEvent.ResolveQuestions(
                            itemId = item.id,
                            choices = questions.indices.map { selectedOptions[it].orEmpty().singleOrNull() ?: -1 },
                            customAnswer = normalizedAnswer,
                            customAnswers = questions.indices.map { customAnswers[it].orEmpty().trim() },
                        ),
                    )
                },
                enabled = !resolving && canSubmit,
                secondary = false,
            )
            Spacer(Modifier.weight(1f))
            AgentoButton(
                text = approvalLabel(item.approval?.denyLabel, "拒绝"),
                onClick = { onEvent(AttentionEvent.ResolveApproval(item.id, approve = false)) },
                enabled = !resolving,
                secondary = true,
            )
        }
        return
    }
    var answer by remember(item.id) { mutableStateOf("") }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
    ) {
        AgentoTextField(
            value = answer,
            onValueChange = { answer = it },
            label = "其他回复",
            enabled = !resolving,
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(
                onSend = {
                    val text = answer.trim()
                    if (text.isNotEmpty()) {
                        onEvent(AttentionEvent.ResolveQuestion(item.id, 0, null, text))
                    }
                },
            ),
            modifier = Modifier.weight(1f).onFocusChanged { if (it.isFocused) onEvent(AttentionEvent.SetExpanded(item.id, true)) },
        )
        if (answer.isNotBlank()) {
            AgentoButton(
                text = "发送",
                onClick = { onEvent(AttentionEvent.ResolveQuestion(item.id, 0, null, answer.trim())) },
                enabled = !resolving,
                secondary = false,
            )
        }
        AgentoButton(
            text = approvalLabel(item.approval?.denyLabel, "拒绝"),
            onClick = { onEvent(AttentionEvent.ResolveApproval(item.id, approve = false)) },
            enabled = !resolving,
            secondary = true,
        )
    }
}

@Composable
private fun AttentionActions(
    item: AttentionItem,
    resolving: Boolean,
    error: String?,
    onEvent: (AttentionEvent) -> Unit,
    onOpenSession: (String) -> Unit,
    selectedActionIds: Set<String> = emptySet(),
    onResolveActionBatch: () -> Unit = {},
    onDenyActionBatch: () -> Unit = {},
) {
    val colors = LocalAgentocColors.current
    val canDecideInline = item.isApproval && !item.requiresSession && item.approval?.brokerDecisionUncertain != true
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
        ) {
            if (item.approval?.actions?.isNotEmpty() == true && !item.requiresSession) {
                AgentoButton(
                    text = approvalLabel(item.approval?.approveLabel, stringResource(R.string.attention_approve_selected)),
                    onClick = onResolveActionBatch,
                    enabled = !resolving && selectedActionIds.isNotEmpty(),
                    decision = true,
                    labelMaxLines = 2,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f),
                )
                AgentoButton(
                    text = approvalLabel(item.approval?.denyLabel, stringResource(R.string.attention_deny)),
                    onClick = onDenyActionBatch,
                    enabled = !resolving,
                    secondary = true,
                    decision = true,
                    labelMaxLines = 2,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f),
                )
            } else if (canDecideInline) {
                AgentoButton(
                    text = approvalLabel(item.approval?.approveLabel, stringResource(R.string.attention_approve)),
                    onClick = { onEvent(AttentionEvent.ResolveApproval(item.id, approve = true)) },
                    enabled = !resolving,
                    decision = true,
                    labelMaxLines = 2,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f),
                )
                AgentoButton(
                    text = approvalLabel(item.approval?.denyLabel, stringResource(R.string.attention_deny)),
                    onClick = { onEvent(AttentionEvent.ResolveApproval(item.id, approve = false)) },
                    enabled = !resolving,
                    secondary = true,
                    decision = true,
                    labelMaxLines = 2,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                    modifier = Modifier.weight(1f),
                )
            } else {
                AgentoButton(
                    text = stringResource(R.string.attention_details),
                    onClick = { onOpenSession(item.sessionId) },
                    enabled = !resolving,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (canDecideInline) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (resolving) {
                    CircularProgressIndicator(Modifier.size(16.dp).testTag("attention-submitting"),
                        strokeWidth = 2.dp, color = colors.secondaryContent)
                    Spacer(Modifier.width(8.dp))
                }
                if (resolving) {
                    Text(stringResource(R.string.attention_submitting), Modifier.weight(1f),
                        color = colors.secondaryContent, style = MaterialTheme.typography.labelSmall)
                } else if (item.approval?.actions?.isNotEmpty() == true) {
                    Text(stringResource(R.string.attention_selection, selectedActionIds.size,
                        item.approval?.actions.orEmpty().count { it.state in setOf("proposed", "classified", "waiting_user") }),
                        Modifier.weight(1f), color = colors.tertiaryContent, style = MaterialTheme.typography.labelSmall)
                } else Spacer(Modifier.weight(1f))
                TextButton(onClick = { onOpenSession(item.sessionId) }, enabled = !resolving, colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary)) {
                    Text(stringResource(R.string.attention_details),
                        color = if (resolving) colors.disabledContent else colors.secondaryContent)
                }
            }
        }
        if (error != null) {
            Spacer(Modifier.size(AgentocSpacing.Compact))
            Row(verticalAlignment = Alignment.CenterVertically) {
                AgentoIcon(
                    imageVector = Icons.Outlined.ErrorOutline,
                    contentDescription = stringResource(R.string.attention_error),
                    modifier = Modifier.size(16.dp),
                    tint = colors.stateError,
                )
                Spacer(Modifier.size(AgentocSpacing.xs))
                Text(
                    text = error,
                    color = colors.stateError,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                TextButton(onClick = { onEvent(AttentionEvent.ClearError) }, enabled = !resolving, colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary)) {
                    Text(stringResource(R.string.attention_clear_error), color = colors.secondaryContent)
                }
            }
        }
    }
}

@Composable
private fun PrivilegedCategoryActions(
    item: AttentionItem,
    selected: Set<String>,
    resolving: Boolean,
    error: String?,
    onEvent: (AttentionEvent) -> Unit,
    onOpenSession: (String) -> Unit,
) {
    val colors = LocalAgentocColors.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        listOf("privileged_other" to R.string.approval_category_privileged,
            "destructive_delete" to R.string.approval_category_delete).forEach { (category, label) ->
            val pending = item.approval?.actions.orEmpty().filter {
                it.category == category && it.state in setOf("proposed", "classified", "waiting_user")
            }
            if (pending.isNotEmpty()) {
                val checked = pending.map { it.id }.filterTo(mutableSetOf()) { it in selected }
                Text(stringResource(label), color = colors.secondaryContent, style = MaterialTheme.typography.labelSmall)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (item.approval?.executorUnavailableReasonCode != "macos_administrator_unavailable") {
                        AgentoButton(text = stringResource(R.string.attention_approve_selected),
                            onClick = { onEvent(AttentionEvent.ResolvePrivilegedCategory(item.id, category, checked)) },
                            enabled = !resolving && checked.isNotEmpty(), decision = true, modifier = Modifier.weight(1f))
                    }
                    AgentoButton(text = stringResource(R.string.attention_deny),
                        onClick = { onEvent(AttentionEvent.ResolvePrivilegedCategory(item.id, category, emptySet())) },
                        enabled = !resolving, secondary = true, decision = true, modifier = Modifier.weight(1f))
                }
            }
        }
        if (resolving) Text(stringResource(R.string.attention_submitting), color = colors.secondaryContent, style = MaterialTheme.typography.labelSmall)
        if (error != null) Text(error, color = colors.stateError, style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { onOpenSession(item.sessionId) }, enabled = !resolving) { Text(stringResource(R.string.attention_details)) }
    }
}

@Composable
private fun ActionBatchDetails(
    actions: List<ApprovalAction>,
    selectedActionIds: Set<String>,
    enabled: Boolean,
    onToggle: (String) -> Unit,
    heading: Int = R.string.attention_actions,
) {
    val colors = LocalAgentocColors.current
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(AgentocSpacing.xs),
    ) {
        Text(stringResource(heading), color = colors.primaryContent, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        actions.forEach { action ->
            val selectable = action.state in setOf("proposed", "classified", "waiting_user")
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(enabled = enabled && selectable) { onToggle(action.id) }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Checkbox(
                    checked = action.id in selectedActionIds,
                    onCheckedChange = if (enabled && selectable) { { onToggle(action.id) } } else null,
                    enabled = enabled && selectable,
                )
                Column(Modifier.weight(1f)) {
                    Text(action.description.ifBlank { action.summary.orEmpty() }, color = colors.primaryContent, style = MaterialTheme.typography.bodyMedium)
                    action.explanation?.let { explanation ->
                        ApprovalExplanationContent(explanation.toExplanationUiState())
                    }
                    action.command?.takeIf(String::isNotBlank)?.let {
                        Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall.copy(
                            fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace))
                    }
                    action.cwd?.takeIf(String::isNotBlank)?.let {
                        Text(stringResource(R.string.attention_directory, it), color = colors.secondaryContent,
                            style = MaterialTheme.typography.bodySmall)
                    }
                    val detail = listOfNotNull(action.category, action.risk).filter { it.isNotBlank() }.joinToString(" · ")
                    if (detail.isNotBlank()) Text(detail, color = colors.secondaryContent, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

internal fun approvalLabel(label: String?, fallback: String): String = when {
    label.isNullOrBlank() -> fallback
    label.equals("Approve", ignoreCase = true) -> fallback
    label.equals("Deny", ignoreCase = true) -> fallback
    else -> label.orEmpty()
}

@Composable
private fun ApprovalDetails(item: AttentionItem, skipActionList: Boolean, skipProviderDescription: Boolean) {
    val colors = LocalAgentocColors.current
    val details = approvalDetails(item, skipActionList).filterNot { skipProviderDescription && it.label == R.string.approval_provider_description }
    if (details.isEmpty()) return
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(AgentocSpacing.xs),
    ) {
        Text(
            text = stringResource(R.string.attention_technical_details),
            color = colors.primaryContent,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
        )
        details.forEach { detail ->
            Text(
                text = if (detail.label == R.string.approval_scope_network) stringResource(R.string.approval_scope_network)
                    else detail.label?.let { stringResource(it, detail.value) } ?: detail.value,
                color = colors.secondaryContent,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

private fun kindLabel(kind: AttentionKind): String = when (kind) {
    AttentionKind.Approval -> "需要审批"
    AttentionKind.Question -> "等待回答"
    AttentionKind.Plan -> "计划待确认"
    AttentionKind.Completion -> "已完成"
    AttentionKind.Failure -> "运行失败"
}

/** The ask-user headline: structured question text, then reason, then title. */
private fun questionPrompt(item: AttentionItem): String {
    val approval = item.approval ?: return item.summary
    val prompt = approval.questions.firstOrNull()?.question?.trim()?.takeIf { it.isNotEmpty() }
        ?: approval.reason?.trim()?.takeIf { it.isNotEmpty() }
        ?: approval.title.trim()
    return prompt.ifBlank { item.summary }
}

/**
 * Structured ask-user payload for the overlay, mirroring the session card's
 * projection: server questions win, otherwise the flat option list and the
 * prompt chain build the single-question fallback.
 */
private fun approvalQuestions(item: AttentionItem): List<ApprovalQuestion> {
    val approval = item.approval ?: return emptyList()
    if (approval.questions.isNotEmpty()) return approval.questions
    val prompt = questionPrompt(item)
    if (approval.options.isEmpty() && prompt.isBlank()) return emptyList()
    return listOf(ApprovalQuestion(question = prompt, options = approval.options.map { ApprovalOption(it) }))
}

private fun kindIcon(kind: AttentionKind): ImageVector = when (kind) {
    AttentionKind.Approval -> Icons.Outlined.NotificationImportant
    AttentionKind.Question -> Icons.AutoMirrored.Outlined.HelpOutline
    AttentionKind.Plan -> Icons.AutoMirrored.Outlined.HelpOutline
    AttentionKind.Completion -> Icons.Outlined.CheckCircleOutline
    AttentionKind.Failure -> Icons.Outlined.ErrorOutline
}

private fun kindAccent(colors: AgentocColors, kind: AttentionKind): Color = when (kind) {
    AttentionKind.Approval -> colors.stateWarning
    AttentionKind.Question -> colors.stateRunning
    AttentionKind.Plan -> colors.stateRunning
    AttentionKind.Completion -> colors.stateSuccess
    AttentionKind.Failure -> colors.stateError
}

@Preview(name = "attention-question", showBackground = true, widthDp = 412)
@Composable
private fun AttentionSurfaceQuestionPreview() {
    AgentocTheme(darkTheme = false) {
        AttentionSurface(
            state = AttentionUiState(
                items = listOf(
                    AttentionItem(
                        id = AttentionReducer.approvalItemId("s3", "q1"),
                        sessionId = "s3",
                        sessionTitle = "数据库迁移",
                        kind = AttentionKind.Question,
                        title = "AskUserQuestion",
                        summary = "迁移需要停机 10 分钟",
                        approval = Approval(
                            id = "q1",
                            sessionId = "s3",
                            title = "AskUserQuestion",
                            kind = "question",
                            runId = "r3",
                            reason = "迁移需要停机 10 分钟",
                            questions = listOf(
                                ApprovalQuestion(
                                    question = "迁移数据库需要停机 10 分钟，现在开始吗？",
                                    options = listOf(
                                        ApprovalOption("现在迁移"),
                                        ApprovalOption("午夜窗口再迁移"),
                                        ApprovalOption("先做一次备份演练"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                activeItemId = AttentionReducer.approvalItemId("s3", "q1"),
            ),
            onEvent = {},
            onOpenSession = {},
        )
    }
}

@Preview(name = "attention-brief", showBackground = true, widthDp = 412)
@Composable
private fun AttentionSurfaceBriefPreview() {
    AgentocTheme(darkTheme = false) {
        AttentionSurface(
            state = AttentionUiState(
                items = listOf(
                    AttentionItem(
                        id = AttentionReducer.approvalItemId("s1", "a1"),
                        sessionId = "s1",
                        sessionTitle = "重构登录模块",
                        kind = AttentionKind.Approval,
                        title = "执行请求",
                        summary = "rm -rf ~/agentoc/tmp — 需要确认",
                        approval = Approval(id = "a1", sessionId = "s1", title = "执行请求", reason = "rm -rf ~/agentoc/tmp"),
                    ),
                ),
                activeItemId = AttentionReducer.approvalItemId("s1", "a1"),
            ),
            onEvent = {},
            onOpenSession = {},
        )
    }
}

@Preview(name = "attention-completion-dark", showBackground = true, widthDp = 412, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun AttentionSurfaceCompletionDarkPreview() {
    AgentocTheme(darkTheme = true) {
        AttentionSurface(
            state = AttentionUiState(
                items = listOf(
                    AttentionItem(
                        id = "w1",
                        sessionId = "s2",
                        sessionTitle = "迁移数据库",
                        kind = AttentionKind.Completion,
                        title = "迁移数据库",
                        summary = "任务已完成",
                    ),
                ),
                activeItemId = "w1",
            ),
            onEvent = {},
            onOpenSession = {},
        )
    }
}
