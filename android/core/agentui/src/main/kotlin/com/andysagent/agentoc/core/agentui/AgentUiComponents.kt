package com.andysagent.agentoc.core.agentui

import androidx.compose.material3.ButtonDefaults

import com.andysagent.agentoc.core.designsystem.AgentoBackdropTone
import com.andysagent.agentoc.core.designsystem.AgentoComposerShadowTokens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.updateTransition
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.togetherWith
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import com.andysagent.agentoc.core.designsystem.agentoPressScale
import com.andysagent.agentoc.core.designsystem.AgentoHaptics
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.focusable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import kotlin.math.roundToInt
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.minimumInteractiveComponentSize
import com.andysagent.agentoc.core.designsystem.AgentoGlassMaterial
import android.net.Uri
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.setProgress
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.andysagent.agentoc.core.designsystem.AgentoButton
import com.andysagent.agentoc.core.designsystem.AgentoDiffuseShadowBox
import com.andysagent.agentoc.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.agentoc.core.designsystem.AgentoGlassSurface
import com.andysagent.agentoc.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.agentoc.core.designsystem.agentoAmbientShadow
import com.andysagent.agentoc.core.designsystem.agentoLargeCardShadow
import com.andysagent.agentoc.core.designsystem.AgentoColors
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenu
import com.andysagent.agentoc.core.designsystem.AgentoDropdownMenuItem
import com.andysagent.agentoc.core.designsystem.AgentoErrorState
import com.andysagent.agentoc.core.designsystem.AgentoFloatingIconButton
import com.andysagent.agentoc.core.designsystem.AgentoIconButton
import com.andysagent.agentoc.core.designsystem.AgentoMotion
import com.andysagent.agentoc.core.designsystem.AgentoRadius
import com.andysagent.agentoc.core.designsystem.AgentoShapes
import com.andysagent.agentoc.core.designsystem.AgentoSpacing
import com.andysagent.agentoc.core.designsystem.AgentoSwitch
import com.andysagent.agentoc.core.designsystem.agentoComposerShadow
import com.andysagent.agentoc.core.designsystem.AgentoStatus
import com.andysagent.agentoc.core.designsystem.AgentoStatusTone
import com.andysagent.agentoc.core.designsystem.AgentoWebGlyph
import com.andysagent.agentoc.core.designsystem.AgentoWebIcon
import com.andysagent.agentoc.core.designsystem.AgentocColors
import com.andysagent.agentoc.core.designsystem.AgentocElevation
import com.andysagent.agentoc.core.designsystem.AgentocMotion
import com.andysagent.agentoc.core.designsystem.AgentocShapes
import com.andysagent.agentoc.core.designsystem.AgentocSizes
import com.andysagent.agentoc.core.designsystem.AgentocSpacing
import com.andysagent.agentoc.core.designsystem.AgentocTextStyles
import com.andysagent.agentoc.core.designsystem.AgentocTheme
import com.andysagent.agentoc.core.designsystem.LocalAgentocColors
import com.andysagent.agentoc.core.model.RuntimeCatalog
import com.andysagent.agentoc.core.designsystem.LocalMotionPolicy
import com.andysagent.agentoc.core.designsystem.MotionPreference
import com.andysagent.agentoc.core.designsystem.agentoPressFeedback
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.first


private const val COMPOSER_VISIBLE_LINE_COUNT = 5

internal fun shouldCollapseUserMessage(text: String): Boolean =
    text.length > 220 ||
        text.count { it == '\n' } >= 5 ||
        text.contains("```") ||
        (text.contains("|") && text.count { it == '\n' } >= 3)

data class UserMessageAttachment(
    val id: String,
    val name: String,
    val mimeType: String = "application/octet-stream",
    val sizeBytes: Long = 0L,
    val url: String? = null,
)

@Composable
private fun UserMessageAttachmentStrip(
    attachments: List<UserMessageAttachment>,
    modifier: Modifier = Modifier,
) {
    if (attachments.isEmpty()) return
    val colors = LocalAgentocColors.current
    val uriHandler = LocalUriHandler.current
    Row(
        modifier = modifier
            .widthIn(max = 520.dp)
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        attachments.forEachIndexed { index, attachment ->
            if (index > 0) Spacer(Modifier.width(8.dp))
            val canOpen = !attachment.url.isNullOrBlank()
            val isDark = colors.canvas.red < 0.5f
            val attachmentBorder = if (isDark) {
                BorderStroke(0.75.dp, AgentoFrostedTokens.SpecularBorderDark)
            } else {
                BorderStroke(0.75.dp, AgentoFrostedTokens.SpecularBorderLight)
            }
            Surface(
                modifier = Modifier
                    .widthIn(min = 120.dp, max = 240.dp)
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .then(
                        if (canOpen) Modifier.agentoPressScale(
                            pressedScale = 0.94f,
                            onClick = {
                                runCatching { uriHandler.openUri(attachment.url.orEmpty()) }
                            },
                        ) else Modifier
                    ),
                shape = RoundedCornerShape(14.dp),
                color = if (isDark) AgentoFrostedTokens.SurfaceLevel1 else colors.surfaceHigh,
                contentColor = colors.primaryContent,
                border = attachmentBorder,
                shadowElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(30.dp)
                            .clip(AgentoShapes.SquircleXS)
                            .background(colors.surfaceLow),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = if (attachment.mimeType.startsWith("image/")) AgentoWebGlyph.Maximize else AgentoWebGlyph.File,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = colors.secondaryContent,
                        )
                    }
                    Column(modifier = Modifier.weight(1f, fill = false)) {
                        Text(
                            text = attachment.name,
                            style = AgentocTextStyles.caption.copy(fontWeight = FontWeight.Medium),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UserMessage(
    text: String,
    modifier: Modifier = Modifier,
    attachments: List<UserMessageAttachment> = emptyList(),
    timestamp: String? = null,
    bubbleColor: Color = if (LocalAgentocColors.current.canvas.red < 0.5f) AgentoColors.SurfaceLevel1 else LocalAgentocColors.current.surfaceHigh,
    canEditResend: Boolean = false,
    onCopy: (() -> Unit)? = null,
    onBranch: (() -> Unit)? = null,
    onEditResend: (() -> Unit)? = null,
) {
    val colors = LocalAgentocColors.current
    val motion = LocalMotionPolicy.current
    val clipboardManager = LocalClipboardManager.current
    var isExpanded by rememberSaveable(text) { mutableStateOf(false) }
    var menuExpanded by remember { mutableStateOf(false) }
    val isCollapsible = remember(text) { shouldCollapseUserMessage(text) }

    BoxWithConstraints(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.CenterEnd,
    ) {
        // Sent turns are an acknowledgement of the user's intent, not a
        // second document canvas. A narrower, quiet tonal surface preserves
        // the asymmetry without competing with the assistant's Markdown.
        val maxBubbleWidth = (maxWidth * 0.82f).coerceAtMost(520.dp)
        Column(
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            UserMessageAttachmentStrip(attachments = attachments)
            Box {
            val isDark = colors.canvas.red < 0.5f
            val bubbleBorder = if (isDark) {
                BorderStroke(0.75.dp, AgentoFrostedTokens.SpecularBorderDark)
            } else {
                BorderStroke(0.75.dp, AgentoFrostedTokens.SpecularBorderLight)
            }
            Surface(
                modifier = Modifier
                    .widthIn(min = 64.dp, max = maxBubbleWidth)
                    .defaultMinSize(minHeight = 40.dp)
                    .clip(AgentoShapes.UserBubble)
                    .combinedClickable(
                        onClick = { /* regular click */ },
                        onLongClick = { menuExpanded = true },
                    ),
                shape = AgentoShapes.UserBubble,
                color = bubbleColor,
                contentColor = colors.primaryContent,
                border = bubbleBorder,
                shadowElevation = 0.dp,
            ) {
                Column(
                    modifier = Modifier
                        .padding(horizontal = 13.dp, vertical = 9.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(
                                if (!isExpanded && isCollapsible) {
                                    Modifier.heightIn(max = 160.dp).clip(RoundedCornerShape(4.dp))
                                } else {
                                    Modifier
                                },
                            ),
                    ) {
                        AgentMarkdown(
                            markdown = text,
                            isStreaming = false,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }

                    if (isCollapsible) {
                        Row(
                            modifier = Modifier
                                .align(Alignment.Start)
                                .heightIn(min = 40.dp)
                                .clip(AgentoShapes.SquircleXS)
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    onClick = { isExpanded = !isExpanded },
                                )
                                .padding(horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(
                                text = stringResource(if (isExpanded) R.string.agentui_collapse else R.string.agentui_expand),
                                style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.secondaryContent,
                                ),
                            )
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.ChevronDown,
                                contentDescription = stringResource(if (isExpanded) R.string.agentui_collapse else R.string.agentui_expand),
                                modifier = Modifier
                                    .size(13.dp)
                                    .rotate(if (isExpanded) 180f else 0f),
                                tint = colors.secondaryContent,
                            )
                        }
                    }

                    if (timestamp != null) {
                        Text(
                            text = timestamp,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.5.sp,
                            color = AgentoColors.TextTertiary,
                            modifier = Modifier.align(Alignment.End),
                        )
                    }

                }
            }

            AgentoDropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { menuExpanded = false },
            ) {
                AgentoDropdownMenuItem(
                    text = stringResource(R.string.agentui_copy),
                    onClick = {
                        menuExpanded = false
                        clipboardManager.setText(AnnotatedString(text))
                        onCopy?.invoke()
                    },
                    leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Copy, contentDescription = null) },
                )
                if (onBranch != null) {
                    AgentoDropdownMenuItem(
                        text = stringResource(R.string.agentui_branch),
                        onClick = {
                            menuExpanded = false
                            onBranch.invoke()
                        },
                        leadingIcon = { ClassicForkIcon(modifier = Modifier.size(16.dp)) },
                    )
                }
                if (canEditResend) {
                    AgentoDropdownMenuItem(
                        text = stringResource(R.string.agentui_edit_and_resend),
                        onClick = {
                            menuExpanded = false
                            onEditResend?.invoke()
                        },
                        leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Edit, contentDescription = null) },
                    )
                }
            }
        }
    }
}
}

@Composable
fun ClassicForkIcon(
    modifier: Modifier = Modifier,
    tint: Color = LocalAgentocColors.current.secondaryContent,
) {
    Canvas(modifier = modifier.size(18.dp)) {
        val strokeWidth = 1.85.dp.toPx()
        val circleRadius = 2.4.dp.toPx()
        val w = size.width
        val h = size.height

        val pTopLeft = Offset(w * 0.28f, h * 0.24f)
        val pTopRight = Offset(w * 0.72f, h * 0.24f)
        val pFork = Offset(w * 0.50f, h * 0.52f)
        val pBottom = Offset(w * 0.50f, h * 0.78f)

        // Left curved branch
        val leftPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(pTopLeft.x, pTopLeft.y + circleRadius)
            cubicTo(
                pTopLeft.x, h * 0.42f,
                pFork.x, h * 0.40f,
                pFork.x, pFork.y,
            )
        }
        // Right curved branch
        val rightPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(pTopRight.x, pTopRight.y + circleRadius)
            cubicTo(
                pTopRight.x, h * 0.42f,
                pFork.x, h * 0.40f,
                pFork.x, pFork.y,
            )
        }
        // Bottom stem
        val stemPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(pFork.x, pFork.y)
            lineTo(pBottom.x, pBottom.y - circleRadius)
        }

        drawPath(leftPath, color = tint, style = Stroke(width = strokeWidth, cap = StrokeCap.Round))
        drawPath(rightPath, color = tint, style = Stroke(width = strokeWidth, cap = StrokeCap.Round))
        drawPath(stemPath, color = tint, style = Stroke(width = strokeWidth, cap = StrokeCap.Round))

        drawCircle(color = tint, radius = circleRadius, center = pTopLeft, style = Stroke(width = strokeWidth))
        drawCircle(color = tint, radius = circleRadius, center = pTopRight, style = Stroke(width = strokeWidth))
        drawCircle(color = tint, radius = circleRadius, center = pBottom, style = Stroke(width = strokeWidth))
    }
}

@Composable
fun AgentMessageActionBar(
    text: String,
    isLastMessage: Boolean,
    onBranch: (() -> Unit)?,
    onRestart: (() -> Unit)?,
    modifier: Modifier = Modifier,
    onReport: (() -> Unit)? = null,
) {
    val clipboardManager = LocalClipboardManager.current
    var isCopied by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()
    val colors = LocalAgentocColors.current
    val copyActionDescription = stringResource(
        if (isCopied) R.string.agentui_copied else R.string.agentui_copy_message,
    )
    val branchActionDescription = stringResource(R.string.agentui_branch_from_message)
    val regenerateActionDescription = stringResource(R.string.agentui_regenerate)

    val isDark = colors.canvas.red < 0.5f
    val buttonBg = if (isDark) Color(0x18FFFFFF) else Color(0x0C000000)
    val buttonBorderBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight

    Row(
        modifier = modifier.fillMaxWidth().padding(top = 2.dp),
        horizontalArrangement = Arrangement.Start,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        @Composable
        fun Action(glyph: AgentoWebGlyph, description: String, onClick: () -> Unit, actionModifier: Modifier = Modifier, tint: Color = colors.secondaryContent.copy(alpha = 0.85f)) {
            Box(
                modifier = actionModifier.size(48.dp)
                    .agentoPressScale(pressedScale = 0.88f, onClick = onClick)
                    .semantics { contentDescription = description },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier.size(32.dp).clip(CircleShape).background(buttonBg)
                        .border(width = 0.5.dp, brush = buttonBorderBrush, shape = CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(glyph = glyph, contentDescription = null, modifier = Modifier.size(16.dp), tint = tint)
                }
            }
        }
        Action(
            glyph = if (isCopied) AgentoWebGlyph.Check else AgentoWebGlyph.Copy,
            description = copyActionDescription,
            tint = if (isCopied) AgentoColors.Success else colors.secondaryContent.copy(alpha = 0.85f),
            onClick = {
                clipboardManager.setText(AnnotatedString(text))
                isCopied = true
                coroutineScope.launch { delay(2000); isCopied = false }
            },
        )
        if (onBranch != null) {
            Action(AgentoWebGlyph.Fork, branchActionDescription, onBranch)
        }
        if (onReport != null) {
            Action(AgentoWebGlyph.Report, stringResource(R.string.agentui_report_content), onReport, Modifier.testTag("report-ai-content"))
        }
        if (isLastMessage && onRestart != null) {
            Action(AgentoWebGlyph.Refresh, regenerateActionDescription, onRestart)
        }
    }
}

@Composable
fun AgentMessage(
    text: String,
    modifier: Modifier = Modifier,
    showAgentIdentity: Boolean = false,
    isLastMessage: Boolean = false,
    onBranch: (() -> Unit)? = null,
    onRestart: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 0.dp),
    ) {
        FinalizedMarkdownMessage(text)
        // Historical replies stay focused on reading. The current reply keeps
        // its actions immediately available for the next task decision.
        if (isLastMessage) {
            AgentMessageActionBar(
                text = text,
                isLastMessage = true,
                onBranch = onBranch,
                onRestart = onRestart,
            )
        }
    }
}

@Composable
fun AgentStreamingMessage(
    text: String,
    modifier: Modifier = Modifier,
    showAgentIdentity: Boolean = false,
    streaming: Boolean = true,
    smoothCatchUp: Boolean = false,
) {
    val colors = LocalAgentocColors.current
    val motion = LocalMotionPolicy.current
    // Pace only actual live deltas, as in the Web renderer. Completed/history
    // messages always paint immediately; no synthetic final-response typing.
    var revealedGraphemes by rememberSaveable { mutableIntStateOf(0) }
    val graphemes = remember(text) { streamingGraphemeRanges(text) }
    val latestRanges by rememberUpdatedState(graphemes)
    LaunchedEffect(streaming, smoothCatchUp, motion.preference) {
        if (!streaming || !smoothCatchUp || motion.preference != MotionPreference.Full) return@LaunchedEffect
        var previousFrame = withFrameNanos { it }
        var previousSize = latestRanges.size
        var arrivalRate = 60.0
        var displayRate = 60.0
        var budget = 0.0
        revealedGraphemes = revealedGraphemes.coerceAtMost(previousSize)
        while (true) {
            val frame = withFrameNanos { it }
            val elapsed = ((frame - previousFrame) / 1_000_000_000.0).coerceIn(0.001, 0.12)
            previousFrame = frame
            val size = latestRanges.size
            if (size < previousSize) revealedGraphemes = revealedGraphemes.coerceAtMost(size)
            val received = (size - previousSize).coerceAtLeast(0)
            previousSize = size
            val arrivalAlpha = 1.0 - kotlin.math.exp(-elapsed / 0.45)
            arrivalRate += (received / elapsed - arrivalRate) * arrivalAlpha
            val backlog = size - revealedGraphemes
            if (backlog <= 0) {
                budget = 0.0
                // No frame loop while waiting for the provider. The action row
                // owns that state; resume only after a real source update.
                snapshotFlow { latestRanges.size }.first { it != size }
                previousFrame = withFrameNanos { it }
                continue
            }
            val ceiling = if (backlog > 40) 720.0 else 360.0
            val target = maxOf(arrivalRate, backlog / 1.2, 60.0).coerceAtMost(ceiling)
            val tau = if (target > displayRate) 0.22 else 0.48
            displayRate += (target - displayRate) * (1.0 - kotlin.math.exp(-elapsed / tau))
            budget += displayRate * elapsed
            val frameLimit = if (backlog > 40) maxOf(6, backlog / 8).coerceAtMost(24) else 6
            val advance = maxOf(1, budget.toInt()).coerceAtMost(frameLimit).coerceAtMost(backlog)
            budget = (budget - advance).coerceAtLeast(0.0)
            revealedGraphemes += advance
        }
    }
    val visibleText = if (!streaming || !smoothCatchUp || motion.preference != MotionPreference.Full) text
        else revealStreamingText(text, revealedGraphemes, graphemes)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 2.dp, bottom = 0.dp),
    ) {
        if (streaming || visibleText.isNotBlank()) {
            if (streaming && visibleText.isEmpty()) {
                val infiniteTransition = rememberInfiniteTransition(label = "thinkingPulse")
                val pulseScale by infiniteTransition.animateFloat(
                    initialValue = 0.85f,
                    targetValue = 1.15f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 800, easing = FastOutSlowInEasing),
                        repeatMode = RepeatMode.Reverse,
                    ),
                    label = "pulseScale",
                )
                val pulseAlpha by infiniteTransition.animateFloat(
                    initialValue = 0.35f,
                    targetValue = 0.95f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 800, easing = FastOutSlowInEasing),
                        repeatMode = RepeatMode.Reverse,
                    ),
                    label = "pulseAlpha",
                )
                Row(
                    modifier = Modifier.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(9.dp)
                            .graphicsLayer {
                                if (motion.preference == MotionPreference.Full) {
                                    scaleX = pulseScale
                                    scaleY = pulseScale
                                    alpha = pulseAlpha
                                } else {
                                    alpha = 0.7f
                                }
                            }
                            .clip(CircleShape)
                            .background(colors.stateRunning),
                    )
                }
            } else {
                AgentMarkdown(
                    markdown = visibleText,
                    isStreaming = streaming,
                    latestGraphemeColor = colors.secondaryContent.takeIf {
                        motion.preference == MotionPreference.Full
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

@Composable
fun StreamingMessageBubble(
    tokenFlow: StateFlow<String>,
    modifier: Modifier = Modifier,
) {
    val text by tokenFlow.collectAsStateWithLifecycle()
    Text(
        text = text,
        style = com.andysagent.agentoc.core.designsystem.AgentoTypography.bodyLarge,
        color = AgentoColors.TextPrimary,
        modifier = modifier,
    )
}

@Composable
fun AgentoSpeedometerIcon(
    effort: Float,
    modifier: Modifier = Modifier,
    primaryColor: Color = LocalAgentocColors.current.accentPrimary,
    trackColor: Color = Color(0x308E8E93),
    needleColor: Color = Color.Black,
) {
    Canvas(modifier = modifier) {
        val strokeWidth = 2.2.dp.toPx()
        val radius = (size.minDimension - strokeWidth) / 2f - 1.dp.toPx()
        val center = Offset(size.width / 2f, size.height / 2f + 1.dp.toPx())
        val arcTopLeft = Offset(center.x - radius, center.y - radius)
        val arcSize = Size(radius * 2, radius * 2)

        // 1. 240° 圆弧背景线 (两端有圆角，150° 至 390°/30°)
        drawArc(
            color = trackColor,
            startAngle = 150f,
            sweepAngle = 240f,
            useCenter = false,
            topLeft = arcTopLeft,
            size = arcSize,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )

        // 2. 蓝色覆盖圆弧 (从最左边 150° 开始覆盖至相同指针角度)
        val clampedEffort = effort.coerceIn(0f, 1f)
        val activeSweep = (clampedEffort * 240f).coerceAtLeast(3f)
        drawArc(
            color = primaryColor,
            startAngle = 150f,
            sweepAngle = activeSweep,
            useCenter = false,
            topLeft = arcTopLeft,
            size = arcSize,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )

        // 3. 指针按挡位比例指向不同角度
        val angleDeg = 150f + clampedEffort * 240f
        val angleRad = Math.toRadians(angleDeg.toDouble())
        val needleLength = radius * 0.68f
        val needleEnd = Offset(
            x = center.x + needleLength * kotlin.math.cos(angleRad).toFloat(),
            y = center.y + needleLength * kotlin.math.sin(angleRad).toFloat(),
        )

        // 中心轴圆点
        drawCircle(
            color = needleColor,
            radius = 2.dp.toPx(),
            center = center,
        )

        // 指针线
        drawLine(
            color = needleColor,
            start = center,
            end = needleEnd,
            strokeWidth = 1.8.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun AgentoBoltIcon(
    filled: Boolean,
    modifier: Modifier = Modifier,
    tint: Color = LocalAgentocColors.current.accentPrimary,
) {
    Canvas(modifier) {
        val scaleX = size.width / 24f
        val scaleY = size.height / 24f
        val bolt = androidx.compose.ui.graphics.Path().apply {
            moveTo(13f * scaleX, 2f * scaleY)
            lineTo(4f * scaleX, 14f * scaleY)
            lineTo(10f * scaleX, 14f * scaleY)
            lineTo(9f * scaleX, 22f * scaleY)
            lineTo(18f * scaleX, 10f * scaleY)
            lineTo(12f * scaleX, 10f * scaleY)
            close()
        }
        if (filled) {
            drawPath(path = bolt, color = tint)
        } else {
            drawPath(
                path = bolt,
                color = tint,
                style = Stroke(
                    width = 1.8.dp.toPx(),
                    cap = StrokeCap.Round,
                    join = androidx.compose.ui.graphics.StrokeJoin.Round,
                ),
            )
        }
    }
}

/** Translate the window-local popup back into the chat's capture coordinates. */
@Composable
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
private fun ComposerPickerPopup(
    onDismiss: () -> Unit,
    anchorTop: Int?,
    onPositioned: (Int) -> Unit,
    content: @Composable (IntOffset) -> Unit,
) {
    val sourceView = LocalView.current
    val density = LocalDensity.current
    val margin = with(density) { 8.dp.roundToPx() }
    var sourceToPopup by remember { mutableStateOf(IntOffset.Zero) }
    val positioned by rememberUpdatedState(onPositioned)
    val positionProvider = remember(sourceView, anchorTop, margin) {
        object : PopupPositionProvider {
            override fun calculatePosition(
                anchorBounds: IntRect,
                windowSize: IntSize,
                layoutDirection: LayoutDirection,
                popupContentSize: IntSize,
            ): IntOffset {
                val sourceLocation = IntArray(2)
                sourceView.getLocationInWindow(sourceLocation)
                val top = anchorTop?.plus(sourceLocation[1]) ?: anchorBounds.top
                val preferredX = if (layoutDirection == LayoutDirection.Rtl) anchorBounds.left - margin
                    else anchorBounds.right - popupContentSize.width + margin
                val x = preferredX
                    .coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0))
                val y = (top - popupContentSize.height + margin)
                    .coerceIn(margin, (windowSize.height - popupContentSize.height - margin).coerceAtLeast(margin))
                sourceToPopup = IntOffset(sourceLocation[0] - x, sourceLocation[1] - y)
                positioned(y + popupContentSize.height - sourceLocation[1])
                return IntOffset(x, y)
            }
        }
    }
    Popup(
        popupPositionProvider = positionProvider,
        onDismissRequest = onDismiss,
        // This is a choice surface, not a second text editor. Keep native
        // focus/Back handling without replacing the composer's IME target.
        // A non-focusable popup would instead let Back dismiss the keyboard
        // before the panel, and would lose hardware-key navigation.
        properties = PopupProperties(
            flags = android.view.WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or
                android.view.WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM,
            inheritSecurePolicy = true,
            dismissOnBackPress = true,
            dismissOnClickOutside = true,
        ),
    ) {
        content(sourceToPopup)
    }
}

private data class EffortPickerContent(
    val effort: Float,
    val serviceTier: String,
    val supportsFast: Boolean,
    val modelLabel: String = "",
    val levels: List<String> = emptyList(),
)

@Composable
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
fun EffortSliderPopover(
    effort: Float,
    onEffortChange: (Float) -> Unit,
    onDismiss: () -> Unit,
    serviceTier: String = "standard",
    supportsFast: Boolean = false,
    onServiceTierChange: (String) -> Unit = {},
    modelLabel: String = "",
    effortLevels: List<String> = emptyList(),
    onOpenModelPicker: (() -> Unit)? = null,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    anchorTop: Int? = null,
    modifier: Modifier = Modifier,
    expanded: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    // Retain values, not just a composable lambda whose block may be updated
    // by the compiler while the closed business state changes underneath it.
    val retained = remember { RetainedPickerContent(EffortPickerContent(effort, serviceTier, supportsFast, modelLabel, effortLevels)) }
    val presentation = retained.frame(expanded, EffortPickerContent(effort, serviceTier, supportsFast, modelLabel, effortLevels))
    val stopLabels = presentation.levels
    val lastStop = (stopLabels.size - 1).coerceAtLeast(0)
    val selectedStop = (presentation.effort.coerceIn(0f, 1f) * lastStop).roundToInt()
    val selectedLabel = stopLabels.getOrNull(selectedStop).orEmpty()
    val effortSliderDescription = stringResource(R.string.agentui_thinking_effort_slider)
    val showStopLabels = LocalDensity.current.fontScale < 1.4f && stopLabels.size <= 4
    val modelDescription = stringResource(R.string.agentui_session_configuration, presentation.modelLabel)
    ComposerRuntimePickerPopover(
        expanded = expanded,
        onDismiss = onDismiss,
        title = stringResource(if (stopLabels.isEmpty()) R.string.agentui_model else R.string.agentui_thinking_effort),
        supportingText = selectedLabel,
        backdropLayer = backdropLayer,
        backdropOrigin = backdropOrigin,
        anchorTop = anchorTop,
        modifier = modifier,
        testTag = "composer-effort-picker",
        compactHeader = true,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (lastStop > 0) {
            androidx.compose.material3.Slider(
                value = selectedStop.toFloat() / lastStop,
                onValueChange = { onEffortChange((it * lastStop).roundToInt().toFloat() / lastStop) },
                steps = (lastStop - 1).coerceAtLeast(0),
                thumb = {
                    Surface(
                        modifier = Modifier.size(32.dp),
                        shape = CircleShape,
                        color = Color.White,
                        border = androidx.compose.foundation.BorderStroke(0.5.dp, colors.primaryContent.copy(alpha = 0.12f)),
                        shadowElevation = 1.dp,
                    ) {}
                },
                track = { slider ->
                    Canvas(Modifier.fillMaxWidth().height(20.dp)) {
                        val progress = slider.value.coerceIn(0f, 1f)
                        val y = size.height / 2f
                        drawLine(colors.primaryContent.copy(alpha = 0.16f), Offset(0f, y), Offset(size.width, y), size.height, StrokeCap.Round)
                        drawLine(colors.accentPrimary, Offset(0f, y), Offset(size.width * progress, y), size.height, StrokeCap.Round)
                        (0..lastStop).forEach { index ->
                            drawCircle(if (index.toFloat() / lastStop <= progress) colors.accentPrimary else colors.secondaryContent,
                                radius = 2.dp.toPx(), center = Offset(size.width * index / lastStop, y))
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .pickerItemReveal()
                    .semantics {
                        contentDescription = effortSliderDescription
                        stateDescription = selectedLabel
                    },
                colors = androidx.compose.material3.SliderDefaults.colors(
                    thumbColor = colors.accentPrimary,
                    activeTrackColor = colors.accentPrimary,
                    inactiveTrackColor = colors.primaryContent.copy(alpha = 0.12f),
                ),
            )
            if (showStopLabels) androidx.compose.ui.layout.Layout(
                modifier = Modifier.fillMaxWidth().pickerItemReveal(),
                content = {
                stopLabels.forEach { label ->
                    Text(
                        text = label,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.secondaryContent,
                    )
                }
                },
            ) { measurables, constraints ->
                val labels = measurables.map { it.measure(constraints.copy(minWidth = 0, maxWidth = constraints.maxWidth / stopLabels.size, minHeight = 0)) }
                val thumbInset = 16.dp.roundToPx()
                layout(constraints.maxWidth, labels.maxOf { it.height }) {
                    labels.forEachIndexed { index, label ->
                        val center = thumbInset + (constraints.maxWidth - thumbInset * 2) * index / lastStop
                        label.placeRelative((center - label.width / 2).coerceIn(0, constraints.maxWidth - label.width), 0)
                    }
                }
            }
            }
            if (presentation.modelLabel.isNotBlank() || onOpenModelPicker != null) {
                if (stopLabels.isNotEmpty()) androidx.compose.material3.HorizontalDivider(
                    modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                    color = colors.primaryContent.copy(alpha = 0.08f),
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .pickerItemReveal()
                        .semantics { contentDescription = modelDescription },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.agentui_model),
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.primaryContent,
                    )
                    val modelButtonBg = if (isDark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.05f)
                    Box(
                        modifier = Modifier
                            .height(34.dp)
                            .widthIn(min = 48.dp, max = 160.dp)
                            .clip(AgentoShapes.PillShape)
                            .background(modelButtonBg)
                            .agentoPressScale(
                                pressedScale = 0.95f,
                                onClick = { onOpenModelPicker?.invoke() },
                            )
                            .testTag("composer-model-action")
                            .semantics { role = Role.Button },
                        contentAlignment = Alignment.Center,
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = presentation.modelLabel,
                                modifier = Modifier.weight(1f, fill = false).testTag("composer-model-label"),
                                style = AgentocTextStyles.caption.copy(
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Medium,
                                ),
                                color = colors.primaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            AgentoWebIcon(
                                AgentoWebGlyph.ChevronDown,
                                contentDescription = null,
                                modifier = Modifier.size(12.dp),
                                tint = colors.secondaryContent,
                            )
                        }
                    }
                }
            }
            if (presentation.supportsFast) {
                androidx.compose.material3.HorizontalDivider(
                    modifier = Modifier.padding(top = 4.dp),
                    color = colors.primaryContent.copy(alpha = 0.08f),
                )
                val isFast = presentation.serviceTier == "fast"
                val speedDescription = stringResource(
                    R.string.agentui_response_speed,
                    stringResource(if (isFast) R.string.agentui_speed_fast else R.string.agentui_speed_standard),
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .pickerItemReveal()
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = { onServiceTierChange(if (isFast) "standard" else "fast") },
                        )
                        .semantics { contentDescription = speedDescription },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = stringResource(R.string.agentui_fast_responses),
                        modifier = Modifier.weight(1f),
                        style = MaterialTheme.typography.bodyMedium.copy(
                            fontSize = 14.5.sp,
                            fontWeight = FontWeight.Normal,
                        ),
                        color = colors.primaryContent,
                    )
                    AgentoSwitch(
                        checked = isFast,
                        onCheckedChange = { onServiceTierChange(if (it) "fast" else "standard") },
                    )
                }
            }
        }
    }
}

internal fun effortStopIndex(effort: Float): Int = when {
    effort <= 0.25f -> 0
    effort <= 0.55f -> 1
    effort <= 0.85f -> 2
    else -> 3
}

internal fun effortValueAtStop(index: Int): Float =
    listOf(0f, 0.5f, 0.75f, 1f)[index.coerceIn(0, 3)]

/**
 * The runtime picker deliberately has its own composer treatment instead of
 * inheriting a generic dropdown. It is a small continuation of the composer:
 * live sampled glass, a clear hierarchy, and a persistent current selection.
 */
private data class ComposerPickerContent(
    val title: String,
    val supportingText: String,
    val onNavigateUp: (() -> Unit)?,
    val navigateUpDescription: String?,
    val page: ComposerRuntimePickerPage?,
    val body: @Composable () -> Unit,
)

@Composable
private fun ComposerRuntimePickerPopover(
    expanded: Boolean,
    onDismiss: () -> Unit,
    title: String,
    supportingText: String,
    onNavigateUp: (() -> Unit)? = null,
    navigateUpDescription: String? = null,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    anchorTop: Int? = null,
    modifier: Modifier = Modifier,
    testTag: String = "composer-runtime-picker",
    compactHeader: Boolean = false,
    page: ComposerRuntimePickerPage? = null,
    onPageChoice: (RuntimePickerLevel, String) -> Unit = { _, _ -> },
    onPageNavigateUp: (RuntimePickerLevel) -> Unit = {},
    content: @Composable () -> Unit = {},
) {
    var panelPosition by remember(backdropLayer, backdropOrigin) {
        mutableStateOf(IntOffset.Zero)
    }

    val retained = remember { RetainedPickerContent(ComposerPickerContent(title, supportingText,
        onNavigateUp, navigateUpDescription, page, content)) }
    // Keep the last open presentation while the caller rolls selection back.
    // Reopening starts a fresh page host, not a slide from the departing route.
    val presentation = retained.frame(expanded, ComposerPickerContent(title, supportingText,
        onNavigateUp, navigateUpDescription, page, content))
    val visibility = remember { MutableTransitionState(false) }
    var popupPositioned by remember { mutableStateOf(false) }
    // A native Popup hides its content until it knows both anchor and window
    // bounds. Do not spend the opening spring while that window is invisible.
    visibility.targetState = expanded && popupPositioned
    val transition = updateTransition(visibility, label = "composer_picker_presence")
    val presenceSpec = pickerPresenceSpec(LocalMotionPolicy.current.preference)
    val presenceState = transition.animateFloat(
        transitionSpec = { presenceSpec },
        label = "composer_picker_presence_progress",
    ) { if (it) 1f else 0f }
    val presence by presenceState
    val readingViewport = remember { PickerReadingViewport() }
    val active by rememberUpdatedState(expanded)
    val dismiss by rememberUpdatedState(onDismiss)
    val dismissActive = { if (active) dismiss() }
    if (!expanded && !visibility.currentState && !visibility.targetState && visibility.isIdle) {
        SideEffect { popupPositioned = false }
        return
    }
    ComposerPickerPopup(onDismiss = dismissActive, anchorTop = anchorTop,
        onPositioned = { popupPositioned = true }) { sourceToPopup ->
        // One sampled glass plane, without a coloured halo or specular edge.
        // Selection is carried by type and a checkmark, not nested raised tiles.
        val panel: @Composable () -> Unit = { BoxWithConstraints(
            modifier = modifier
                .widthIn(max = 320.dp)
                .fillMaxWidth()
                .padding(16.dp),
            contentAlignment = Alignment.BottomCenter,
        ) {
            val geometry = pickerGeometryProgress(presence)
            val expandedWidth = maxWidth
            val panelWidth = androidx.compose.ui.unit.lerp(minOf(144.dp, expandedWidth), expandedWidth, pickerWidthProgress(presence))
            val panelShape = RoundedCornerShape(androidx.compose.ui.unit.lerp(24.dp, 20.dp, geometry))
            Box(Modifier.width(panelWidth)
                // Once no heading fits, retire the empty glass and its halo
                // together. Readable phases keep the original material intact.
                .pickerShellPresence(readingViewport)
                .then(if (expanded) Modifier.testTag(testTag) else Modifier
                    .testTag("$testTag-exit")
                    .clearAndSetSemantics {
                        stateDescription = listOf(presentation.title, presentation.supportingText).joinToString(" · ")
                    }
                    .pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                        }
                    })
                .agentoComposerShadow(shape = panelShape)
                // The transparent fixed-window area dismisses, not the glass.
                .pointerInput(Unit) { detectTapGestures(onTap = {}) }) {
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .fillMaxWidth()
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        panelPosition = IntOffset(position.x.roundToInt(), position.y.roundToInt())
                    },
                shape = panelShape,
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = false,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOrigin + sourceToPopup - panelPosition,
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = false,
            ) {
                ComposerPickerMorphBody(expandedWidth, presence, readingViewport) {
                if (presentation.page != null) {
                    key(retained.generation) {
                        ComposerRuntimePickerPages(presentation.page, onPageChoice, onPageNavigateUp,
                            enabled = expanded)
                    }
                } else ComposerPickerPageFrame(presentation.title, presentation.supportingText,
                    presentation.onNavigateUp, presentation.navigateUpDescription,
                    compactHeader = compactHeader, content = presentation.body)
                }
            }
            }
        } }
        run {
            val density = LocalDensity.current
            // Resizing a Popup repositions a second native window later than
            // Compose draws its new height. Reserve one window and change the
            // glass inside it; its bottom now stays in the same layout pass.
            val capacity = 56.dp * density.fontScale.coerceAtLeast(1f) + 319.dp
            val available = anchorTop?.let { with(density) { it.toDp() } - 8.dp } ?: capacity
            Box(
                modifier = Modifier.widthIn(max = 320.dp).fillMaxWidth()
                    .height(minOf(capacity, available).coerceAtLeast(1.dp))
                    .testTag("composer-picker-window")
                    .pointerInput(Unit) { detectTapGestures(onTap = { dismissActive() }) },
                contentAlignment = Alignment.BottomCenter,
            ) { panel() }
        }
    }
}

@Composable
internal fun ComposerPickerPageFrame(
    title: String,
    supportingText: String,
    onNavigateUp: (() -> Unit)? = null,
    navigateUpDescription: String? = null,
    compactHeader: Boolean = false,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
                Column(modifier = modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = if (compactHeader) 36.dp else 56.dp)
                            .pickerItemReveal(heading = true)
                            .padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (onNavigateUp != null) {
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    .clip(CircleShape)
                                    .clickable(
                                        interactionSource = remember { MutableInteractionSource() },
                                        indication = null,
                                        onClick = onNavigateUp,
                                    )
                                    .semantics {
                                        contentDescription = navigateUpDescription.orEmpty()
                                        role = Role.Button
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                AgentoWebIcon(
                                    glyph = AgentoWebGlyph.Back,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                    tint = colors.secondaryContent,
                                )
                            }
                        }
                        Spacer(Modifier.width(10.dp))
                        if (compactHeader) {
                            Text(
                                text = title,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.titleSmall,
                                color = colors.primaryContent,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = supportingText,
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.secondaryContent,
                            )
                            Spacer(Modifier.width(6.dp))
                        } else Column(Modifier.weight(1f)) {
                            Text(
                                text = title,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.primaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = supportingText,
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.secondaryContent,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (!compactHeader) Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(0.5.dp)
                            .background(colors.primaryContent.copy(alpha = if (isDark) 0.12f else 0.08f)),
                    )
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 286.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(horizontal = 6.dp, vertical = if (compactHeader) 2.dp else 6.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        content()
                    }
                }
}

@Composable
internal fun ComposerRuntimePickerOption(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    enabled: Boolean = true,
    disclosure: Boolean = false,
) {
    val colors = LocalAgentocColors.current
    val choiceShape = RoundedCornerShape(14.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .pickerItemReveal()
            .clip(choiceShape)
            .alpha(if (enabled) 1f else 0.48f)
            .agentoPressScale(
                pressedScale = 0.98f,
                onClick = onClick.takeIf { enabled },
                interactionSource = remember { MutableInteractionSource() },
            )
            .semantics {
                contentDescription = label
                role = Role.Button
                this.selected = selected
            }
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
            color = colors.primaryContent,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (selected) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Check,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = colors.accentPrimary,
            )
        } else if (disclosure) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.ChevronRight,
                contentDescription = null,
                modifier = Modifier.size(17.dp),
                tint = colors.secondaryContent,
            )
        }
    }
}

@Composable
internal fun ComposerRuntimePickerStatus(
    text: String,
    isError: Boolean = false,
) {
    val colors = LocalAgentocColors.current
    Text(
        text = text,
        modifier = Modifier.pickerItemReveal().padding(horizontal = 10.dp, vertical = 12.dp),
        style = MaterialTheme.typography.bodySmall,
        color = if (isError) colors.error else colors.secondaryContent,
    )
}

@Composable
fun OpposingCornersIcon(
    modifier: Modifier = Modifier,
    tint: Color = LocalAgentocColors.current.primaryContent,
) {
    Canvas(modifier = modifier.size(16.dp)) {
        val strokeWidth = 1.8.dp.toPx()
        val pad = 1.5.dp.toPx()
        val arm = 4.5.dp.toPx()

        // Top-Right right angle: (w - pad - arm, pad) -> (w - pad, pad) -> (w - pad, pad + arm)
        val trPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(size.width - pad - arm, pad)
            lineTo(size.width - pad, pad)
            lineTo(size.width - pad, pad + arm)
        }
        drawPath(
            path = trPath,
            color = tint,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
        )

        // Bottom-Left right angle: (pad, size.height - pad - arm) -> (pad, size.height - pad) -> (pad + arm, size.height - pad)
        val blPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(pad, size.height - pad - arm)
            lineTo(pad, size.height - pad)
            lineTo(pad + arm, size.height - pad)
        }
        drawPath(
            path = blPath,
            color = tint,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
        )
    }
}

@Composable
fun ContractingCornersIcon(
    modifier: Modifier = Modifier,
    tint: Color = LocalAgentocColors.current.primaryContent,
) {
    Canvas(modifier = modifier.size(16.dp)) {
        val strokeWidth = 1.8.dp.toPx()
        val pad = 1.5.dp.toPx()
        val arm = 4.5.dp.toPx()

        // Top-Right pointing inward
        val trPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(size.width - pad, pad + arm)
            lineTo(size.width - pad - arm, pad + arm)
            lineTo(size.width - pad - arm, pad)
        }
        drawPath(
            path = trPath,
            color = tint,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
        )

        // Bottom-Left pointing inward
        val blPath = androidx.compose.ui.graphics.Path().apply {
            moveTo(pad, size.height - pad - arm)
            lineTo(pad + arm, size.height - pad - arm)
            lineTo(pad + arm, size.height - pad)
        }
        drawPath(
            path = blPath,
            color = tint,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round),
        )
    }
}

/** Standalone host for previews/tests; the chat expands its existing editor in place. */
@Composable
fun FullscreenComposerModal(
    value: String,
    onValueChange: (String) -> Unit,
    onPasteImage: (List<Uri>) -> Unit = {},
    onDismiss: () -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit = {},
    working: Boolean = false,
    pendingSend: Boolean = false,
    enabled: Boolean = true,
    hasAttachments: Boolean = false,
) {
    BoxWithConstraints(
        Modifier.fillMaxSize()
            .background(LocalAgentocColors.current.canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .navigationBarsPadding().imePadding().padding(bottom = 8.dp),
    ) {
        AgentComposer(
            value = value, onValueChange = onValueChange, onPasteImage = onPasteImage,
            onSend = onSend, onStop = onStop, working = working, enabled = enabled,
            pendingSend = pendingSend, hasAttachments = hasAttachments, onAddAttachment = {},
            expanded = true, fullscreen = true, fullscreenProgress = 1f,
            fullscreenHeight = maxHeight,
            onFullscreenChange = { if (!it) onDismiss() },
        )
    }
}

@Composable
private fun FullscreenComposerHeader(value: String, enabled: Boolean = true, onDismiss: () -> Unit) {
    val colors = LocalAgentocColors.current
    val returnLabel = stringResource(R.string.agentui_return_to_composer)
    val characterCount = value.codePointCount(0, value.length)
    val lineCount = value.count { it == '\n' } + 1
    val characterLabel = pluralStringResource(R.plurals.agentui_draft_characters, characterCount, characterCount)
    val lineLabel = pluralStringResource(R.plurals.agentui_draft_lines, lineCount, lineCount)
    val statistics = stringResource(R.string.agentui_draft_statistics, characterLabel, lineLabel)
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(48.dp).clip(CircleShape)
                .clickable(enabled = enabled, role = Role.Button, onClick = onDismiss)
                .semantics { contentDescription = returnLabel },
            contentAlignment = Alignment.Center,
        ) {
            ContractingCornersIcon(tint = colors.primaryContent, modifier = Modifier.size(20.dp))
        }
        // This is an editor tool rail, not a second page heading. Keep the
        // title and metadata together inside the same normal-size control row.
        // It may grow for wrapping text; the morph measures that real endpoint.
        Column(Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 4.dp)) {
            Text(
                stringResource(R.string.agentui_edit_message),
                style = AgentocTextStyles.projectTitle,
                color = colors.primaryContent,
            )
            Text(
                statistics,
                style = AgentocTextStyles.caption,
                color = colors.secondaryContent,
            )
        }
        FullscreenComposerDone(onDismiss, enabled)
    }
}

@Composable
private fun FullscreenComposerDone(onDismiss: () -> Unit, enabled: Boolean = true) {
    TextButton(
        onClick = onDismiss,
        enabled = enabled,
        modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 64.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = LocalAgentocColors.current.accentPrimary),
    ) {
        Text(
            stringResource(R.string.agentui_done),
            style = AgentocTextStyles.projectTitle,
            color = LocalAgentocColors.current.accentPrimary,
        )
    }
}

@Composable
fun AgentoSendButton(
    onClick: () -> Unit,
    working: Boolean,
    pendingSend: Boolean = false,
    enabled: Boolean,
    hasText: Boolean,
    modifier: Modifier = Modifier,
    buttonSize: Dp = 34.dp,
) {
    val colors = LocalAgentocColors.current
    val motion = LocalMotionPolicy.current
    val isDark = colors.canvas.red < 0.5f
    // The action represents the draft, not the transport acknowledgement for
    // the preceding turn. A run with an empty draft can always be stopped;
    // adding text or an attachment immediately turns that action into Send.
    val showStop = working && !hasText
    val showSend = hasText
    // Keep the action's footprint stable. Hiding it when a draft is empty
    // made the editor expand sideways and caused a visible jump as a run
    // started or a draft was cleared.
    val showAction = showStop || showSend
    val actionContentDescription = stringResource(
        if (showStop) R.string.agentui_stop_generating else R.string.agentui_send_message,
    )
    val sendBgColor by animateColorAsState(
        targetValue = when {
            !enabled -> if (isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)
            showStop -> if (isDark) AgentoFrostedTokens.AppleRedDark else AgentoFrostedTokens.AppleRedLight
            showSend -> colors.actionPrimary
            else -> if (isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.06f)
        },
        animationSpec = tween(durationMillis = motion.duration(AgentoMotion.DurationFast)),
        label = "send_button_bg",
    )
    val sendContentColor = when {
        !enabled -> colors.disabledContent
        showStop -> Color.White
        showSend -> colors.actionPrimaryContent
        else -> colors.disabledContent
    }

    val interactionSource = remember { MutableInteractionSource() }

    Box(
        modifier = modifier
            .defaultMinSize(minWidth = buttonSize, minHeight = buttonSize)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                enabled = enabled && showAction,
                role = Role.Button,
                onClick = onClick,
            )
            .agentoPressScale(pressedScale = .88f, interactionSource = interactionSource, hapticFeedback = false)
            .semantics { contentDescription = actionContentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier.size(buttonSize).testTag("composer-send-disc").clip(CircleShape).background(sendBgColor),
            contentAlignment = Alignment.Center,
        ) {
            Box(contentAlignment = Alignment.Center) {
                AnimatedContent(
                    targetState = showStop,
                    transitionSpec = {
                        fadeIn(tween(motion.duration(AgentoMotion.DurationFast))) togetherWith
                            fadeOut(tween(motion.duration(AgentoMotion.DurationFast)))
                    },
                    label = "send_stop_icon_morph",
                ) { isStopping ->
                    AgentoWebIcon(
                        if (isStopping) AgentoWebGlyph.Stop else AgentoWebGlyph.TriangleSend,
                        contentDescription = null,
                        modifier = Modifier.size(if (isStopping) 14.dp else 18.dp),
                        tint = sendContentColor,
                    )
                }
            }
        }
    }
}

@Composable
internal fun PlanModeBadge(
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    // Frosted glass translucent surface without outline border
    val badgeBg = if (isDark) Color.White.copy(alpha = 0.12f) else Color.Black.copy(alpha = 0.06f)

    val closePlanDescription = stringResource(R.string.agentui_close_plan)
    val planText = stringResource(R.string.agentui_plan)

    Row(
        modifier = modifier
            .testTag("composer-plan-badge")
            .height(34.dp)
            .clip(AgentoShapes.PillShape)
            .background(badgeBg)
            .padding(start = 12.dp, end = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(
            text = planText,
            style = MaterialTheme.typography.labelMedium.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                platformStyle = androidx.compose.ui.text.PlatformTextStyle(includeFontPadding = false),
            ),
            color = colors.primaryContent,
        )
        Box(
            modifier = Modifier
                .size(24.dp)
                .clip(CircleShape)
                .background(if (isDark) Color.White.copy(alpha = 0.10f) else Color.Black.copy(alpha = 0.05f))
                .agentoPressScale(
                    pressedScale = 0.88f,
                    onClick = onClose.takeIf { enabled },
                )
                .semantics {
                    role = Role.Button
                    contentDescription = closePlanDescription
                },
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Close,
                contentDescription = null,
                modifier = Modifier.size(11.dp),
                tint = colors.secondaryContent,
            )
        }
    }
}

@Composable
fun AgentComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onPasteImage: (List<Uri>) -> Unit = {},
    onSend: () -> Unit,
    onStop: () -> Unit,
    working: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    actionEnabled: Boolean = true,
    attachmentsEnabled: Boolean = false,
    onAddAttachment: () -> Unit,
    runtimeTool: String = "codex",
    runtimeProvider: String? = null,
    runtimeModel: String? = null,
    runtimeCatalog: RuntimeCatalog = RuntimeCatalog(),
    runtimeSelectionDisplay: ComposerRuntimeIdentity? = null,
    runtimeModelsLoading: Boolean = false,
    runtimeModelsError: String? = null,
    serviceTier: String = "standard",
    runtimePickerOpen: Boolean = false,
    onOpenRuntimePicker: () -> Unit = {},
    onCloseRuntimePicker: () -> Unit = {},
    onSelectRuntime: (String) -> Unit = {},
    onSelectProvider: (String?) -> Unit = {},
    onSelectModel: (String) -> Unit = {},
    onSelectServiceTier: (String) -> Unit = {},
    effort: Float = 0.5f,
    effortPickerOpen: Boolean = false,
    onOpenEffortPicker: () -> Unit = {},
    onCloseEffortPicker: () -> Unit = {},
    onEffortChange: (Float) -> Unit = {},
    goalMode: Boolean = false,
    goalText: String = "",
    onGoalClick: () -> Unit = {},
    onCloseGoalMode: () -> Unit = {},
    onSetGoal: ((String) -> Unit)? = null,
    planMode: Boolean = false,
    onClosePlanMode: () -> Unit = {},
    expanded: Boolean = false,
    onExpandedChange: (Boolean) -> Unit = {},
    fullscreen: Boolean = false,
    fullscreenProgress: Float = if (fullscreen) 1f else 0f,
    fullscreenHeight: Dp = Dp.Unspecified,
    onFullscreenChange: (Boolean) -> Unit = {},
    hasAttachments: Boolean = false,
    pendingSend: Boolean = false,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    onVoiceClick: (() -> Unit)? = null,
    voiceActive: Boolean = false,
    voiceRecording: Boolean = false,
    voiceProcessing: Boolean = false,
    voiceLevel: Float = 0f,
    onVoiceCancelClick: (() -> Unit)? = null,
    voiceEnabled: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val isCreatingGoal = goalMode && goalText.isBlank()
    val composerVoiceProcessing = voiceProcessing
    val composerVoiceRecording = voiceRecording || (voiceActive && !composerVoiceProcessing)
    val composerVoiceActive = onVoiceClick != null && (composerVoiceRecording || composerVoiceProcessing)
    val placeholderText = if (composerVoiceActive && value.isEmpty()) ""
        else if (isCreatingGoal) "设定你的目标..." else composerPlaceholder(enabled)
    val composerContentDescription = stringResource(R.string.agentui_message_composer)
    val approvalPendingDescription = stringResource(R.string.agentui_resolve_approval)
    val fullscreenEditDescription = stringResource(R.string.agentui_fullscreen_edit)
    val attachmentDescription = stringResource(
        if (attachmentsEnabled) R.string.agentui_add_attachment else R.string.agentui_attachment_unavailable,
    )
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val isDark = colors.canvas.red < 0.5f

    var textLineCount by remember { mutableStateOf(1) }
    var textContentHeightPx by remember { mutableIntStateOf(0) }
    var firstLineHeightPx by remember { mutableIntStateOf(0) }
    val fullscreenActive = fullscreen || fullscreenProgress > 0f
    val composerMotion = LocalMotionPolicy.current
    var pendingEditorFocus by remember { mutableStateOf(false) }
    val isOverVisibleLines = remember(value, textLineCount) {
        textLineCount > COMPOSER_VISIBLE_LINE_COUNT
            || value.count { it == '\n' } >= COMPOSER_VISIBLE_LINE_COUNT
    }

    // Expansion is an interaction state, not a focus state. The persistent
    // editor keeps its document, selection and input session in both forms.
    val isExpanded = expanded || fullscreenActive
    val hasComposerContent = value.isNotBlank() || hasAttachments
    val showSendAction = !composerVoiceActive && (hasComposerContent || working || pendingSend)
    val showRightAction = !composerVoiceActive && (isCreatingGoal || showSendAction)
    val committedRuntime = if (runtimePickerOpen && runtimeSelectionDisplay != null) runtimeSelectionDisplay
        else composerRuntimeIdentity(runtimeCatalog, runtimeTool, runtimeProvider, runtimeModel, runtimeSelectionDisplay)
    val supportsFast = committedRuntime.supportsFast
    val runtimeLabel = committedRuntime.description
    val effortLevels = runtimeCatalog.tools.firstOrNull { it.id == runtimeTool }?.models
        ?.firstOrNull { it.id == runtimeModel && it.provider == runtimeProvider }?.effortLevels.orEmpty()
    val effortIndex = if (effortLevels.size > 1) (effort.coerceIn(0f, 1f) * (effortLevels.size - 1)).roundToInt() else 0
    val reasoningLabel = effortLevels.getOrNull(effortIndex).orEmpty()
    val thinkingEffortDescription = stringResource(
        R.string.agentui_thinking_effort_control,
        reasoningLabel,
    )
    val sessionConfigurationDescription = stringResource(
        R.string.agentui_session_configuration,
        runtimeLabel,
    )
    var runtimePickerView by rememberSaveable { mutableStateOf(RuntimePickerLevel.Tools) }

    LaunchedEffect(runtimePickerOpen) {
        if (!runtimePickerOpen) runtimePickerView = RuntimePickerLevel.Tools
    }

    LaunchedEffect(runtimePickerOpen, effortPickerOpen) {
        if (runtimePickerOpen || effortPickerOpen) onExpandedChange(true)
    }

    LaunchedEffect(hasComposerContent) {
        if (hasComposerContent) {
            onExpandedChange(true)
        }
    }

    LaunchedEffect(isExpanded) {
        if (!isExpanded) {
            focusManager.clearFocus(force = true)
        }
    }

    fun expandEditorAndFocus() {
        pendingEditorFocus = true
        onExpandedChange(true)
    }

    // Request focus after the expanded constraints reach the persistent editor.
    LaunchedEffect(isExpanded, pendingEditorFocus, enabled) {
        if (isExpanded && pendingEditorFocus && enabled) {
            focusRequester.requestFocus()
            pendingEditorFocus = false
        }
    }

    val composerAlpha by animateFloatAsState(
        targetValue = if (enabled) 1f else 0.50f,
        animationSpec = tween(durationMillis = composerMotion.duration(AgentoMotion.StateChange)),
        label = "composer_alpha",
    )

    // The persistent composer explicitly uses the neutral glass surface.
    // No extra semantic tint may overpaint its defocused transcript.

    androidx.activity.compose.BackHandler(enabled = fullscreen) { onFullscreenChange(false) }

    // Preserve a single, predictable rail for idle, typing, and streaming
    // states. Only the text area grows upward when the user writes more.
    // The compact composer is a true capsule, matching the bottom dock and
    // its circular actions. The expanded editor keeps a calmer corner radius
    // so multiline writing still has a stable, readable container.
    val composerDensity = LocalDensity.current
    val compactTextStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp)
    val modelTextStyle = AgentocTextStyles.caption.copy(fontSize = 13.sp)
    val compactRailHeight = composerControlHeight(
        with(composerDensity) { compactTextStyle.lineHeight.toDp() }, 20.dp,
        composerTypeMinimum(48.dp, 16.dp, composerDensity.fontScale),
    )
    val modelChipHeight = composerControlHeight(
        with(composerDensity) { modelTextStyle.lineHeight.toDp() }, 12.dp,
        composerTypeMinimum(38.dp, 10.dp, composerDensity.fontScale),
    )
    val expandedRailHeight = composerControlHeight(modelChipHeight, 10.dp, 48.dp)
    val expansion by animateFloatAsState(
        targetValue = if (isExpanded) 1f else 0f,
        animationSpec = composerMorphSpec(composerMotion),
        label = "composer_expansion",
    )
    val morph = expansion.coerceIn(0f, 1f)
    val inlineHeaderProgress by animateFloatAsState(
        targetValue = if (isExpanded && isOverVisibleLines) 1f else 0f,
        // Fullscreen already supplies the geometric clock. A changed document
        // must determine its return endpoint immediately, not after a spring.
        animationSpec = if (fullscreenActive) androidx.compose.animation.core.snap() else composerMorphSpec(composerMotion),
        label = "composer_inline_header",
    )
    val actionRailHeight = androidx.compose.ui.unit.lerp(compactRailHeight, expandedRailHeight, morph)
    val composerCornerRadius = androidx.compose.ui.unit.lerp(compactRailHeight / 2, 20.dp, morph)
    val composerShape = RoundedCornerShape(composerCornerRadius * (1f - fullscreenProgress))

    // The reference interaction has two clearly different silhouettes: a
    // quiet, conversation-width capsule at rest and an almost edge-to-edge
    // writing surface once the editor opens. Keep it centered during the
    // width spring so neither action rail appears to drift.
    val composerWidthFraction = AgentocSizes.CollapsedComposerWidthFraction + (1f - AgentocSizes.CollapsedComposerWidthFraction) * morph
    val collapsedLeftInset = if (planMode) 124.dp else 58.dp
    val animatedCollapsedLeftInset by animateDpAsState(
        targetValue = collapsedLeftInset,
        animationSpec = composerMorphSpec(composerMotion),
        label = "composer_collapsed_left_inset",
    )
    val startPadding = androidx.compose.ui.unit.lerp(animatedCollapsedLeftInset, AgentoSpacing.ScreenHorizontal, morph)
    val compactEndPadding by animateDpAsState(
        targetValue = when {
            onVoiceClick != null && showRightAction -> 106.dp
            onVoiceClick != null || showRightAction -> 58.dp
            else -> AgentoSpacing.ScreenHorizontal
        },
        animationSpec = composerMorphSpec(composerMotion),
        label = "composer_compact_end_inset",
    )
    val endPadding = androidx.compose.ui.unit.lerp(compactEndPadding, AgentoSpacing.ScreenHorizontal, morph)
    val topPadding = 12.dp * morph
    val bottomPadding = AgentoSpacing.Compact * morph
    val editorTextStyle = androidx.compose.ui.text.lerp(compactTextStyle, AgentocTextStyles.userBody, morph)
    val compactEditor = !isExpanded && morph <= .001f

    val composerBackdropOffset = remember { mutableStateOf(IntOffset.Zero) }
    // Target the CURRENT document, not the height saved before fullscreen.
    // Otherwise shortening a draft morphs back to a stale tall composer and
    // only then starts another shrink. Content measurement includes the
    // editor's font-scaled rich-decoration insets, not just text glyph height.
    val inlineEditorHeight = (with(composerDensity) { textContentHeightPx.toDp() } +
        topPadding + bottomPadding).coerceIn(
        AgentocSizes.ComposerTextMinHeight, AgentocSizes.ComposerMaxHeight,
    )
    val inlineHeight = (if (expanded) expandedRailHeight else compactRailHeight) + if (expanded) {
        inlineEditorHeight + if (isOverVisibleLines) 48.dp else 0.dp
    } else 0.dp
    val animatedInlineEditorHeight by animateDpAsState(
        targetValue = inlineEditorHeight,
        animationSpec = if (fullscreenActive) androidx.compose.animation.core.snap() else composerMorphSpec(composerMotion),
        label = "composer_document_height",
    )

    Box(
        modifier = modifier
            .fillMaxWidth(composerWidthFraction)
            .then(if (fullscreenActive && fullscreenHeight != Dp.Unspecified) {
                Modifier.height(inlineHeight * (1f - fullscreenProgress) + fullscreenHeight * fullscreenProgress)
            } else Modifier)
            .testTag(if (fullscreenActive) "fullscreen-composer" else "agent-composer")
            .then(if (fullscreenActive) Modifier.pointerInput(Unit) {
                // Participate in the topmost surface hit test even in blank
                // footer/header regions. Do not consume child editor gestures.
                awaitPointerEventScope { while (true) awaitPointerEvent() }
            } else Modifier)
            .agentoComposerShadow(
                shape = composerShape,
                ambientLightAlpha = AgentoComposerShadowTokens.AmbientLightAlpha * (1f - fullscreenProgress),
                keyLightAlpha = AgentoComposerShadowTokens.KeyLightAlpha * (1f - fullscreenProgress),
                ambientDarkAlpha = AgentoComposerShadowTokens.AmbientDarkAlpha * (1f - fullscreenProgress),
                keyDarkAlpha = AgentoComposerShadowTokens.KeyDarkAlpha * (1f - fullscreenProgress),
            )
            .onGloballyPositioned { coordinates ->
                val position = coordinates.positionInRoot()
                composerBackdropOffset.value = IntOffset(
                    backdropOrigin.x - position.x.roundToInt(),
                    backdropOrigin.y - position.y.roundToInt(),
                )
            }
            // The composer is a bottom-docked control. Keep the bottom edge fixed while
            // its content grows upward; the default center alignment makes the action
            // row visibly bounce during the size spring.
            .semantics {
                // In the expanded state the whole floating surface is the composer landmark.
                // In the compact state the editor below owns the content description so its
                // child controls remain independently discoverable.
                if (isExpanded) contentDescription = composerContentDescription
            },
    ) {
        val isComposerDark = colors.canvas.red < 0.5f
        AgentoFrostedGlassBox(
            modifier = Modifier.fillMaxWidth().then(if (fullscreenActive) Modifier.fillMaxHeight() else Modifier),
            shape = composerShape,
            surface = AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            specularBrush = if (isComposerDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            backdropLayer = backdropLayer,
            backdropOffset = composerBackdropOffset.value,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = false,
        ) {
                ComposerMorphLayout(
                    modifier = Modifier
                        .fillMaxWidth()
                        .then(if (fullscreenActive) Modifier.fillMaxHeight() else Modifier)
                        .background(colors.canvas.copy(alpha = fullscreenProgress))
                        // Disabled controls fade, not their sampled substrate.
                        // Fading the glass itself reveals the sharp transcript
                        // underneath and defeats blur while approval is pending.
                        .graphicsLayer { alpha = composerAlpha },
                    progress = morph,
                    compactEditor = compactEditor,
                    firstLineHeight = with(composerDensity) {
                        if (firstLineHeightPx > 0) firstLineHeightPx.toDp() else editorTextStyle.lineHeight.toDp()
                    } +
                        topPadding + bottomPadding,
                    editorTopPadding = topPadding,
                    inlineEditorHeight = animatedInlineEditorHeight,
                    fullscreen = fullscreenActive,
                    header = {
                        ComposerHeaderMorph(
                            fullscreenProgress = fullscreenProgress,
                            inlineProgress = inlineHeaderProgress,
                            fullscreenTarget = fullscreen,
                            fullscreenHeader = {
                                FullscreenComposerHeader(value = value, enabled = fullscreen && composerFullscreenHeaderOpacity(fullscreenProgress) > 0f,
                                    onDismiss = { if (fullscreen) onFullscreenChange(false) })
                            },
                            inlineHeader = {
                                Row(
                                    modifier = Modifier.fillMaxWidth().height(48.dp)
                                        .padding(start = AgentoSpacing.ScreenHorizontal, end = 10.dp),
                                    horizontalArrangement = Arrangement.End,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box(
                                        modifier = Modifier.size(48.dp).clip(CircleShape)
                                            .clickable(
                                                interactionSource = remember { MutableInteractionSource() },
                                                indication = null,
                                                enabled = enabled && !fullscreen && composerInlineHeaderOpacity(fullscreenProgress) > 0f && isOverVisibleLines,
                                                onClick = {
                                                    onFullscreenChange(true)
                                                    pendingEditorFocus = true
                                                },
                                            ).semantics { contentDescription = fullscreenEditDescription },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        OpposingCornersIcon(tint = colors.primaryContent, modifier = Modifier.size(16.dp))
                                    }
                                }
                            },
                        )
                    },
                    editor = {
                    val textFieldScrollState = rememberScrollState()
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .then(if (fullscreenActive) Modifier.fillMaxSize() else Modifier.heightIn(
                                min = if (compactEditor) 0.dp else AgentocSizes.ComposerTextMinHeight,
                                // userBody is 27.5sp line-height: five lines plus the
                                // 12dp/8dp editor insets fit inside the existing 160dp
                                // design-system cap. The sixth line is the first one
                                // that should require the editor ScrollState.
                                max = if (compactEditor) compactRailHeight else AgentocSizes.ComposerMaxHeight,
                            ))
                            .then(if (isExpanded && morph > .99f) Modifier.clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                enabled = enabled,
                            ) {
                                expandEditorAndFocus()
                            } else Modifier)
                            .semantics {
                                if (!enabled) this.contentDescription = approvalPendingDescription
                            },
                        contentAlignment = Alignment.TopStart,
                    ) {
                        MarkdownComposerEditor(
                            value = value,
                            onValueChange = onValueChange,
                            onPasteImage = onPasteImage,
                            enabled = enabled,
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(if (fullscreenActive) Modifier.fillMaxHeight() else Modifier)
                                .testTag(if (fullscreenActive) "fullscreen-composer-editor" else "inline-composer-editor")
                                .focusRequester(focusRequester)
                                .onFocusChanged { state ->
                                    if (state.isFocused && !isExpanded) expandEditorAndFocus()
                                }
                                .padding(
                                    start = startPadding,
                                    end = endPadding,
                                    top = topPadding,
                                    bottom = bottomPadding,
                                ),
                            textStyle = editorTextStyle.copy(
                                color = if (enabled) colors.primaryContent else colors.disabledContent,
                            ),
                            cursorBrush = SolidColor(LocalAgentocColors.current.accentPrimary),
                            maxLines = if (compactEditor) 1 else Int.MAX_VALUE,
                            singleLine = compactEditor,
                            selectionActive = isExpanded,
                            isDark = isDark,
                            scrollState = textFieldScrollState,
                            onTextLayout = { textLayoutResult ->
                                textLineCount = textLayoutResult.lineCount
                            },
                            onContentSizeChange = { textContentHeightPx = it.height },
                            onFirstLineSizeChange = { if (value.isNotEmpty()) firstLineHeightPx = it },
                        )
                        // Hint stays outside the editor's unbounded horizontal scroll.
                        if (value.isEmpty() && placeholderText.isNotEmpty()) {
                            Text(placeholderText,
                                modifier = Modifier.fillMaxWidth().padding(start = startPadding, end = endPadding,
                                    top = topPadding, bottom = bottomPadding)
                                    .then(if (!isExpanded) Modifier.testTag("composer-collapsed-hint") else Modifier),
                                style = editorTextStyle, color = colors.secondaryContent,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                onTextLayout = { result ->
                                    if (result.lineCount > 0) firstLineHeightPx = kotlin.math.ceil(result.getLineBottom(0)).toInt()
                                })
                        }
                        if (!isExpanded) {
                            Box(Modifier.matchParentSize().padding(start = startPadding, end = endPadding).clickable(
                                interactionSource = remember { MutableInteractionSource() }, indication = null, enabled = enabled,
                            ) { expandEditorAndFocus() }.clearAndSetSemantics {
                                contentDescription = composerContentDescription
                                stateDescription = value
                                if (enabled) onClick { expandEditorAndFocus(); true }
                            })
                        }
                    }
                    },
                    rail = {

                // Bottom Bar: Always pinned at the bottom.
                // Left: '+' button (anchored, does not move).
                // Center (collapsed): single-line text input & placeholder.
                // Center (expanded): Goal pill & Speedometer & Model picker expand in horizontally from left and right.
                // Right: Send/Stop button (anchored, does not move).
                BoxWithConstraints(
                    modifier = Modifier
                        .fillMaxWidth()
                        // Font-scaled text gains space, while edge actions keep
                        // their 48dp targets and stay vertically centered.
                        .height(actionRailHeight)
                        .padding(horizontal = androidx.compose.ui.unit.lerp(6.dp, AgentoSpacing.Compact, morph)),
                ) {
                Row(
                    modifier = Modifier.fillMaxSize().testTag("composer-action-rail"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (composerVoiceActive && !fullscreenActive) {
                        VoiceCaptureActionRail(
                            recording = composerVoiceRecording,
                            processing = composerVoiceProcessing,
                            level = voiceLevel,
                            enabled = enabled && voiceEnabled,
                            onCancel = onVoiceCancelClick ?: onVoiceClick ?: {},
                            onStop = onVoiceClick ?: {},
                            modifier = Modifier.fillMaxSize(),
                        )
                    } else if (!fullscreenActive) {
                    // Pinned '+' Button (Left) - Borderless WebUI Mobile Style
                    val attachmentPressSource = remember { MutableInteractionSource() }
                    Box(
                        modifier = Modifier
                            .width(36.dp)
                            .height(48.dp)
                            .testTag("composer-attachment-action")
                            .clickable(
                                interactionSource = attachmentPressSource,
                                indication = null,
                                enabled = enabled && attachmentsEnabled,
                                onClick = onAddAttachment,
                            )
                            .agentoPressScale(pressedScale = 0.90f, interactionSource = attachmentPressSource)
                            .semantics {
                                role = Role.Button
                                this.contentDescription = attachmentDescription
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Plus,
                            contentDescription = null,
                            modifier = Modifier.size(19.dp).testTag("composer-attachment-glyph"),
                            tint = if (enabled && attachmentsEnabled) colors.secondaryContent else colors.disabledContent,
                        )
                    }

                    // Plan Mode Badge (right after '+')
                    AnimatedVisibility(
                        visible = planMode,
                        enter = expandHorizontally(
                            animationSpec = composerMorphSpec(composerMotion),
                            expandFrom = Alignment.Start,
                        ) + fadeIn(animationSpec = composerMorphSpec(composerMotion)),
                        exit = shrinkHorizontally(
                            animationSpec = composerMorphSpec(composerMotion),
                            shrinkTowards = Alignment.Start,
                        ) + fadeOut(animationSpec = composerMorphSpec(composerMotion)),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            PlanModeBadge(
                                onClose = onClosePlanMode,
                                enabled = enabled,
                            )
                            Spacer(Modifier.width(6.dp))
                        }
                    }

                    // Measure the fixed edge actions before the flexible middle.
                    // Otherwise a long model label consumes the send button's width.
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {

                    // Mirror the Web composer: icon-only thinking entry plus one flat runtime trigger.
                    if (isExpanded || morph > .001f) {
                        Row(
                            modifier = Modifier.weight(1f).graphicsLayer {
                                // Tools appear only after the moving first line clears them.
                                alpha = ((morph - .85f) / .15f).coerceIn(0f, 1f)
                            }.then(if (!isExpanded) Modifier.clearAndSetSemantics {} else Modifier),
                            horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            // The composer follows the Web UI: compact effort
                            // control plus one model trigger, both aligned to
                            // the action rail rather than a second toolbar.
                            Box {
                                Box(
                                    modifier = Modifier
                                        .size(48.dp)
                                        .testTag("composer-effort-action")
                                        .clip(CircleShape)
                                        .clickable(
                                            interactionSource = remember { MutableInteractionSource() },
                                            indication = null,
                                            enabled = enabled && isExpanded && morph > .9f,
                                            onClick = onOpenEffortPicker,
                                        )
                                        .semantics { contentDescription = thinkingEffortDescription },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    AgentoSpeedometerIcon(
                                        effort = effort,
                                        modifier = Modifier.size(24.dp),
                                        primaryColor = LocalAgentocColors.current.accentPrimary,
                                        trackColor = if (isDark) Color(0x408E8E93) else Color(0x308E8E93),
                                        needleColor = if (isDark) Color.White else Color(0xFF1C1C1E),
                                    )
                                }
                                    EffortSliderPopover(
                                        expanded = effortPickerOpen,
                                        effort = effort,
                                        onEffortChange = onEffortChange,
                                        onDismiss = onCloseEffortPicker,
                                        serviceTier = serviceTier,
                                        supportsFast = supportsFast,
                                        onServiceTierChange = onSelectServiceTier,
                                        modelLabel = committedRuntime.label,
                                        effortLevels = effortLevels,
                                        onOpenModelPicker = {
                                            onCloseEffortPicker()
                                            onOpenRuntimePicker()
                                        },
                                        backdropLayer = backdropLayer,
                                        backdropOrigin = backdropOrigin,
                                        anchorTop = backdropOrigin.y - composerBackdropOffset.value.y,
                                    )
                                    val pickerPage = runtimePickerPage(
                                        level = runtimePickerView,
                                        catalog = runtimeCatalog,
                                        toolId = runtimeTool,
                                        providerId = runtimeProvider,
                                        modelId = runtimeModel,
                                        currentLabel = runtimeLabel,
                                        strings = RuntimePickerStrings(
                                            tools = stringResource(R.string.agentui_choose_runtime),
                                            providers = stringResource(R.string.agentui_choose_provider),
                                            models = stringResource(R.string.agentui_choose_model),
                                            returnToTools = stringResource(R.string.agentui_return_to_runtime),
                                            returnToProviders = stringResource(R.string.agentui_return_to_provider),
                                            noProviders = stringResource(R.string.agentui_no_providers_available),
                                            noModels = stringResource(R.string.agentui_no_models_available),
                                            loading = stringResource(R.string.agentui_loading_models),
                                        ),
                                        loading = runtimeModelsLoading,
                                        error = runtimeModelsError,
                                        committedIdentity = committedRuntime,
                                    )
                                    ComposerRuntimePickerPopover(
                                        expanded = runtimePickerOpen,
                                        onDismiss = onCloseRuntimePicker,
                                        title = pickerPage.title,
                                        supportingText = pickerPage.context,
                                        backdropLayer = backdropLayer,
                                        backdropOrigin = backdropOrigin,
                                        anchorTop = backdropOrigin.y - composerBackdropOffset.value.y,
                                        page = pickerPage,
                                        onPageNavigateUp = { runtimePickerView = it },
                                        onPageChoice = { level, id ->
                                            when (level) {
                                                RuntimePickerLevel.Tools -> {
                                                    onSelectRuntime(id)
                                                    runtimePickerView = if (runtimeCatalog.tools.firstOrNull { it.id == id }?.providerSelectionRequired == true)
                                                        RuntimePickerLevel.Providers else RuntimePickerLevel.Models
                                                }
                                                RuntimePickerLevel.Providers -> {
                                                    onSelectProvider(id)
                                                    runtimePickerView = RuntimePickerLevel.Models
                                                }
                                                RuntimePickerLevel.Models -> onSelectModel(id)
                                            }
                                        },
                                    )
                            }

                            Spacer(Modifier.width(8.dp))
                        }
                    }
                    }

                    } else {
                        Spacer(Modifier.weight(1f))
                    }
                    if (!composerVoiceActive && onVoiceClick != null && !fullscreenActive) {
                        val voiceDescription = stringResource(
                            if (voiceActive) R.string.agentui_stop_voice_input else R.string.agentui_start_voice_input,
                        )
                        Box(
                            modifier = Modifier
                                .size(48.dp)
                                .testTag("composer-voice-action")
                                .clip(CircleShape)
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    enabled = enabled && voiceEnabled,
                                    onClick = onVoiceClick,
                                )
                                .semantics { contentDescription = voiceDescription },
                            contentAlignment = Alignment.Center,
                        ) {
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.Microphone,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = when {
                                    !enabled || !voiceEnabled -> colors.disabledContent
                                    voiceActive -> colors.accentPrimary
                                    else -> colors.secondaryContent
                                },
                            )
                        }
                    }

                    // Morphing Right Action: Normal Send/Stop Button <-> ("取消" + "设定目标") Action Buttons
                    AnimatedContent(
                        targetState = isCreatingGoal && !composerVoiceActive,
                        transitionSpec = {
                            (fadeIn(animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f)) +
                                scaleIn(initialScale = 0.88f, animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f)))
                                .togetherWith(
                                    fadeOut(animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f)) +
                                        scaleOut(targetScale = 0.88f, animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f))
                                ).using(SizeTransform(clip = false))
                        },
                        label = "composer_send_or_goal_action",
                    ) { creatingGoal ->
                        if (creatingGoal) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.padding(end = 4.dp),
                            ) {
                                // 灰色的“取消”按钮 (无边框，优雅灰底) - 仅在 composer 展开态显示，折叠态不显示避免拥挤
                                AnimatedVisibility(
                                    visible = isExpanded,
                                    enter = fadeIn(spring(dampingRatio = 0.85f, stiffness = 400f)) +
                                        expandHorizontally(
                                            animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f),
                                            expandFrom = Alignment.End,
                                        ),
                                    exit = fadeOut(spring(dampingRatio = 0.85f, stiffness = 400f)) +
                                        shrinkHorizontally(
                                            animationSpec = spring(dampingRatio = 0.85f, stiffness = 400f),
                                            shrinkTowards = Alignment.End,
                                        ),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .height(34.dp)
                                            .clip(AgentoShapes.PillShape)
                                            .background(
                                                if (isDark) Color(0xFF2C2C2E).copy(alpha = 0.85f)
                                                else Color(0xFFE5E5EA).copy(alpha = 0.90f)
                                            )
                                            .agentoPressScale(
                                                pressedScale = 0.92f,
                                                onClick = onCloseGoalMode,
                                            )
                                            .padding(horizontal = 14.dp)
                                            .semantics {
                                                role = Role.Button
                                                contentDescription = "取消目标"
                                            },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            text = "取消",
                                            style = MaterialTheme.typography.labelMedium.copy(
                                                fontWeight = FontWeight.Medium,
                                                fontSize = 13.5.sp,
                                                color = if (isDark) Color(0xFFEBEBF5) else Color(0xFF3C3C43),
                                            ),
                                        )
                                    }
                                }

                                // “设定目标”按钮 (Primary Accent Blue Pill, 零边框)
                                // 折叠态缩为只剩箭中靶的图标 (圆形/紧凑胶囊)，展开态展开为带“设定目标”文字的完整胶囊
                                val canSetGoal = value.trim().isNotEmpty()
                                Box(
                                    modifier = Modifier
                                        .height(34.dp)
                                        .defaultMinSize(minWidth = 34.dp)
                                        .clip(AgentoShapes.PillShape)
                                        .background(
                                            if (canSetGoal) colors.actionPrimary
                                            else colors.actionPrimary.copy(alpha = if (isDark) 0.35f else 0.40f)
                                        )
                                        .agentoPressScale(
                                            pressedScale = 0.94f,
                                            onClick = {
                                                if (canSetGoal) {
                                                    onExpandedChange(false)
                                                    if (onSetGoal != null) {
                                                        onSetGoal(value.trim())
                                                    } else {
                                                        onSend()
                                                    }
                                                    if (fullscreen) onFullscreenChange(false)
                                                } else if (!isExpanded) {
                                                    expandEditorAndFocus()
                                                }
                                            },
                                        )
                                        .animateContentSize(spring(dampingRatio = 0.82f, stiffness = 420f))
                                        .semantics {
                                            role = Role.Button
                                            contentDescription = "设定目标"
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.Center,
                                        modifier = Modifier.padding(
                                            horizontal = if (isExpanded) 14.dp else 9.dp,
                                        ),
                                    ) {
                                        AgentoWebIcon(
                                            glyph = AgentoWebGlyph.TargetArrow,
                                            contentDescription = null,
                                            modifier = Modifier.size(15.dp),
                                            tint = colors.actionPrimaryContent,
                                        )
                                        AnimatedVisibility(
                                            visible = isExpanded,
                                            enter = fadeIn(spring(dampingRatio = 0.82f, stiffness = 420f)) +
                                                expandHorizontally(
                                                    animationSpec = spring(dampingRatio = 0.82f, stiffness = 420f),
                                                    expandFrom = Alignment.Start,
                                                ),
                                            exit = fadeOut(spring(dampingRatio = 0.82f, stiffness = 420f)) +
                                                shrinkHorizontally(
                                                    animationSpec = spring(dampingRatio = 0.82f, stiffness = 420f),
                                                    shrinkTowards = Alignment.Start,
                                                ),
                                        ) {
                                            Row(verticalAlignment = Alignment.CenterVertically) {
                                                Spacer(Modifier.width(5.dp))
                                                Text(
                                                    text = "设定目标",
                                                    style = MaterialTheme.typography.labelMedium.copy(
                                                        fontWeight = FontWeight.SemiBold,
                                                        fontSize = 13.5.sp,
                                                        color = colors.actionPrimaryContent,
                                                    ),
                                                    maxLines = 1,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            // Pinned Send / Stop Button (Right)
                            AnimatedVisibility(
                                visible = showSendAction,
                                enter = fadeIn(animationSpec = composerMorphSpec(composerMotion)) +
                                    expandHorizontally(
                                        animationSpec = composerMorphSpec(composerMotion),
                                        expandFrom = Alignment.End,
                                    ),
                                exit = fadeOut(animationSpec = composerMorphSpec(composerMotion)) +
                                    shrinkHorizontally(
                                        animationSpec = composerMorphSpec(composerMotion),
                                        shrinkTowards = Alignment.End,
                                    ),
                            ) {
                                AgentoSendButton(
                                    onClick = if (working && !hasComposerContent) {
                                        onStop
                                    } else {
                                        {
                                            onExpandedChange(false)
                                            onSend()
                                            if (fullscreen) onFullscreenChange(false)
                                        }
                                    },
                                    working = working,
                                    pendingSend = pendingSend,
                                    enabled = enabled && actionEnabled,
                                    hasText = hasComposerContent,
                                    modifier = Modifier.size(48.dp).testTag("composer-send-action"),
                                    buttonSize = androidx.compose.ui.unit.lerp(30.dp, 34.dp, morph),
                                )
                            }
                        }
                    }
                }
                }
                    },
                )
        }
    }
}

@Composable
private fun VoiceCaptureActionRail(
    recording: Boolean,
    processing: Boolean,
    level: Float,
    enabled: Boolean,
    onCancel: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val cancelDescription = stringResource(R.string.agentui_cancel_voice_input)
    val stopDescription = stringResource(R.string.agentui_stop_voice_input)
    val waveformDescription = stringResource(
        if (processing) R.string.agentui_voice_processing else R.string.agentui_voice_waveform,
    )

    Row(
        modifier = modifier.fillMaxWidth().height(48.dp).testTag("composer-voice-recording-rail"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(48.dp).testTag("composer-voice-cancel")
                .clip(CircleShape)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    enabled = enabled,
                    onClick = onCancel,
                )
                .semantics {
                    role = Role.Button
                    contentDescription = cancelDescription
                },
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Close,
                contentDescription = null,
                modifier = Modifier.size(17.dp),
                tint = colors.secondaryContent,
            )
        }

        Box(
            modifier = Modifier.weight(1f).fillMaxHeight().padding(horizontal = 12.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (processing) {
                androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(20.dp).testTag("composer-voice-processing")
                        .semantics { contentDescription = waveformDescription },
                    color = colors.accentPrimary,
                    strokeWidth = 2.dp,
                )
            } else {
                VoiceWaveform(
                    level = level,
                    modifier = Modifier.fillMaxWidth().height(32.dp)
                        .testTag("composer-voice-waveform")
                        .semantics { contentDescription = waveformDescription },
                )
            }
        }

        if (recording) {
            Box(
                modifier = Modifier.size(48.dp).testTag("composer-voice-stop")
                    .clip(CircleShape)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        enabled = enabled,
                        onClick = onStop,
                    )
                    .semantics {
                        role = Role.Button
                        contentDescription = stopDescription
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    modifier = Modifier.size(34.dp).clip(CircleShape).background(colors.actionPrimary),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Stop,
                        contentDescription = null,
                        modifier = Modifier.size(15.dp),
                        tint = colors.actionPrimaryContent,
                    )
                }
            }
        }
    }
}

@Composable
private fun VoiceWaveform(level: Float, modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    val smoothedLevel by animateFloatAsState(
        targetValue = level.coerceIn(0f, 1f),
        animationSpec = tween(durationMillis = 90, easing = FastOutSlowInEasing),
        label = "voice_waveform_level",
    )
    val profile = listOf(
        .20f, .34f, .50f, .73f, .42f, .26f, .61f, .88f, .55f, .32f,
        .70f, .44f, .24f, .58f, .82f, .49f, .30f, .66f, .91f, .52f,
        .35f, .72f, .46f, .27f, .57f,
    )
    val activeScale = 0.10f + smoothedLevel * 0.90f

    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        profile.forEachIndexed { index, peak ->
            val targetHeight = 2.5.dp + (24.dp * peak * activeScale)
            val height by animateDpAsState(
                targetValue = targetHeight,
                animationSpec = tween(durationMillis = 100, easing = FastOutSlowInEasing),
                label = "voice_waveform_bar_$index",
            )
            Box(
                modifier = Modifier.padding(horizontal = 1.5.dp)
                    .width(2.5.dp).height(height)
                    .clip(CircleShape)
                    .background(colors.accentPrimary),
            )
        }
    }
}

@Composable
private fun composerPlaceholder(enabled: Boolean): String = stringResource(
    if (enabled) R.string.agentui_composer_prompt else R.string.agentui_resolve_approval,
)

/**
 * AgentToolRow — the shared quiet flat operation row.
 *
 * One visual unit for every agent activity state across the product:
 * bare neutral glyph, monospace action title, and only actionable state.
 * Activity is supporting context in a conversation, not a live dashboard.
 * It appears as a single quiet row so final answers retain visual priority.
 */
@Composable
fun AgentToolRow(
    title: String,
    glyph: AgentoWebGlyph,
    meta: String?,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    breathing: Boolean = false,
    metaColor: Color? = null,
    showChevron: Boolean = true,
    chevronExpanded: Boolean = false,
    titleFontSize: TextUnit = 14.sp,
    titleStyle: TextStyle? = null,
    titleColor: Color? = null,
    glyphTint: Color? = null,
    minHeight: Dp = 0.dp,
    horizontalPadding: Dp = 0.dp,
    revealId: Any? = null,
    revealProgress: Float? = null,
) {
    val colors = LocalAgentocColors.current
    val motion = LocalMotionPolicy.current
    val chevronContentDescription = stringResource(
        if (chevronExpanded) R.string.agentui_collapse else R.string.agentui_expand,
    )

    // Tool updates can arrive quickly. Avoid typewriter or oscillating row
    // animations here: a brief, semantic breathing glyph is enough feedback
    // and respects reduced-motion preferences through the shared policy.
    val iconBreathAlpha = if (breathing && motion.preference == MotionPreference.Full) {
        val transition = rememberInfiniteTransition(label = "tool_row_breath")
        val breathAlpha by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(
                animation = tween(1200, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "tool_row_breath_alpha",
        )
        breathAlpha
    } else {
        1f
    }
    val chevronRotation by animateFloatAsState(
        targetValue = if (chevronExpanded) 90f else 0f,
        animationSpec = AgentoMotion.SnappySpring,
        label = "agent_tool_row_chevron",
    )

    Row(
        modifier = modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .heightIn(min = minHeight)
            .padding(horizontal = horizontalPadding, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AgentoWebIcon(
            glyph = glyph,
            contentDescription = null,
            modifier = Modifier
                .size(15.dp)
                .graphicsLayer { this.alpha = iconBreathAlpha },
            tint = glyphTint ?: colors.secondaryContent,
        )
        Text(
            text = title,
            modifier = Modifier
                .weight(1f)
                .padding(end = 6.dp),
            style = titleStyle ?: com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Code.copy(
                fontSize = titleFontSize,
            ),
            color = titleColor ?: colors.secondaryContent,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        // Routine completion and live work already have structural cues. A
        // textual state is reserved for failure, when it changes the next step.
        if (!meta.isNullOrBlank()) {
            Text(
                text = meta,
                style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Normal,
                ),
                color = metaColor ?: colors.tertiaryContent,
            )
        }
        if (showChevron) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.ChevronRight,
                contentDescription = chevronContentDescription,
                modifier = Modifier
                    .size(15.dp)
                    .graphicsLayer {
                        rotationZ = chevronRotation
                    },
                tint = colors.tertiaryContent,
            )
        }
    }
}

@Composable
fun ToolCallCard(
    state: ToolCallUiState,
    modifier: Modifier = Modifier,
    activitySummary: String? = null,
) {
    var expanded by remember(state.id) { mutableStateOf(false) }
    val colors = LocalAgentocColors.current
    val motion = LocalMotionPolicy.current
    val isDark = colors.canvas.red < 0.5f
    val cleanSummary = activitySummary?.trim()?.takeIf { it.isNotEmpty() }
    val hasDetail = state.detail.isNotBlank() || (cleanSummary != null && cleanSummary != state.title)
    val isLiveActivity = cleanSummary != null && state.status == AgentOperationStatus.InProgress
    val detailText = buildString {
        if (isLiveActivity && state.title.isNotBlank()) append(state.title)
        if (state.detail.isNotBlank()) {
            if (isNotEmpty()) append('\n')
            append(state.detail)
        }
    }
    // A running operation is context for the answer, not a competing message.
    // The compact row is enough to establish progress; only an explicit tap
    // introduces a detail surface with command/file information.
    val activityContent: @Composable () -> Unit = {
        AgentToolRow(
            title = cleanSummary ?: state.title,
            glyph = when (state.kind) {
                AgentOperationKind.Command -> AgentoWebGlyph.Terminal
                AgentOperationKind.FileEdit -> AgentoWebGlyph.Folder
                AgentOperationKind.Diff -> AgentoWebGlyph.File
                AgentOperationKind.Tool -> AgentoWebGlyph.Settings
                AgentOperationKind.SubAgent -> AgentoWebGlyph.Agent
                AgentOperationKind.Unknown -> AgentoWebGlyph.File
            },
            // A live operation already has a breathing glyph and the session
            // tail says that the assistant is processing. Repeating "Working"
            // in every operation row makes the conversation read like a log.
            meta = if (state.status == AgentOperationStatus.Failed) statusLabel(state.status) else null,
            onClick = if (hasDetail) ({ expanded = !expanded }) else null,
            breathing = state.status == AgentOperationStatus.InProgress,
            metaColor = if (state.status == AgentOperationStatus.Failed) colors.error.copy(alpha = 0.85f) else null,
            showChevron = hasDetail,
            chevronExpanded = expanded,
            titleFontSize = 14.sp,
            titleStyle = if (isLiveActivity) {
                com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                )
            } else {
                null
            },
            titleColor = if (isLiveActivity) colors.secondaryContent else null,
            glyphTint = if (isLiveActivity) colors.stateRunning else null,
            minHeight = if (isLiveActivity) 36.dp else 0.dp,
            horizontalPadding = 0.dp,
            revealId = state.id,
        )
        AnimatedVisibility(
            visible = expanded && hasDetail,
            enter = fadeIn(tween(motion.duration(160))) + expandVertically(
                expandFrom = Alignment.Top,
                animationSpec = tween(motion.duration(200)),
            ),
            exit = fadeOut(tween(motion.duration(120))) + shrinkVertically(
                shrinkTowards = Alignment.Top,
                animationSpec = tween(motion.duration(160)),
            ),
        ) {
            val termBg = if (isDark) Color(0xFF0D1117).copy(alpha = 0.92f) else Color(0xFF161B22).copy(alpha = 0.95f)
            val termBorder = BorderStroke(
                width = 0.75.dp,
                brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            )
            Surface(
                color = if (state.kind == AgentOperationKind.Command) termBg else (if (isDark) AgentoFrostedTokens.SurfaceLevel1 else AgentoFrostedTokens.LightSurfaceLevel1),
                shape = RoundedCornerShape(12.dp),
                border = termBorder,
                contentColor = colors.primaryContent,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = AgentoSpacing.Standard, end = AgentoSpacing.Standard, bottom = 10.dp, top = 4.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .width(2.5.dp)
                            .heightIn(min = 20.dp)
                            .background(
                                if (state.kind == AgentOperationKind.Command) LocalAgentocColors.current.accentPrimary.copy(alpha = 0.6f)
                                else colors.primaryContent.copy(alpha = 0.15f),
                                RoundedCornerShape(1.dp),
                            ),
                    )
                    Spacer(Modifier.width(10.dp))
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .horizontalScroll(rememberScrollState()),
                    ) {
                        if (state.kind == AgentOperationKind.Diff || state.detail.contains("\n+") || state.detail.contains("\n-")) {
                            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                state.detail.lines().forEach { line ->
                                    val lineColor = when {
                                        line.startsWith("+") -> colors.statusSuccess
                                        line.startsWith("-") -> colors.statusError
                                        line.startsWith("@@") -> colors.statusRunning
                                        else -> colors.primaryContent
                                    }
                                    val lineBg = when {
                                        line.startsWith("+") -> colors.statusSuccess.copy(alpha = 0.1f)
                                        line.startsWith("-") -> colors.statusError.copy(alpha = 0.1f)
                                        else -> Color.Transparent
                                    }
                                    Surface(
                                        color = lineBg,
                                        shape = RoundedCornerShape(2.dp),
                                    ) {
                                        Text(
                                            text = line,
                                            style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Code.copy(fontSize = 12.5.sp, lineHeight = 17.sp),
                                            color = lineColor,
                                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 1.dp),
                                        )
                                    }
                                }
                            }
                        } else {
                            Text(
                                text = detailText,
                                style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Code.copy(
                                    fontSize = 12.5.sp,
                                    color = if (state.kind == AgentOperationKind.Command) Color(0xFF58A6FF) else colors.primaryContent,
                                ),
                            )
                        }
                    }
                }
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(AgentoMotion.LayoutSpring),
    ) {
        activityContent()
    }
}
/**
 * 专为 "修改了 X 个文件" 设计的原生文件变更结构化卡片
 */
@Composable
fun FileChangeSummaryCard(
    state: FileChangeUiState,
    modifier: Modifier = Modifier,
) {
    var expanded by remember(state.id) { mutableStateOf(false) }
    var selectedFileIndex by remember(state.id) { mutableStateOf<Int?>(null) }
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    // Activity summaries are context for an answer, not a competing card
    // hierarchy. Keep their material quiet until the user explicitly opens it.
    val activitySurface = when {
        expanded && isDark -> colors.strongSurface.copy(alpha = 0.80f)
        expanded -> colors.quietSurface.copy(alpha = 0.92f)
        isDark -> colors.strongSurface.copy(alpha = 0.50f)
        else -> colors.quietSurface.copy(alpha = 0.70f)
    }
    val chevronContentDescription = stringResource(
        if (expanded) R.string.agentui_collapse else R.string.agentui_expand,
    )

    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 90f else 0f,
        animationSpec = AgentoMotion.SnappySpring,
        label = "file_change_chevron",
    )

    val fileChangeBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(AgentoMotion.LayoutSpring),
        shape = RoundedCornerShape(16.dp),
        color = activitySurface,
        border = fileChangeBorder,
        contentColor = colors.primaryContent,
        shadowElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.File,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = LocalAgentocColors.current.accentPrimary,
                )

                Text(
                    text = stringResource(R.string.agentui_changed_files, state.files.size),
                    modifier = Modifier.weight(1f),
                    style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                        fontWeight = FontWeight.Medium,
                        fontSize = 15.sp,
                    ),
                    color = colors.primaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )

                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronRight,
                    contentDescription = chevronContentDescription,
                    modifier = Modifier
                        .size(18.dp)
                        .graphicsLayer { rotationZ = chevronRotation },
                    tint = colors.secondaryContent,
                )
            }

            if (expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 8.dp, end = 8.dp, bottom = 8.dp, top = 2.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    state.files.forEachIndexed { idx, file ->
                        val isFileExpanded = selectedFileIndex == idx
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = if (isDark) Color(0xFF161C26) else Color(0xFFEDF2F7),
                            modifier = Modifier.fillMaxWidth().clickable {
                                selectedFileIndex = if (isFileExpanded) null else idx
                            },
                        ) {
                            Column(modifier = Modifier.padding(8.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Row(
                                        modifier = Modifier.weight(1f),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                    ) {
                                        AgentoWebIcon(
                                            glyph = AgentoWebGlyph.File,
                                            contentDescription = null,
                                            modifier = Modifier.size(13.dp),
                                            tint = colors.secondaryContent,
                                        )
                                        Text(
                                            text = file.name,
                                            style = TextStyle(
                                                fontFamily = FontFamily.Monospace,
                                                fontSize = 12.5.sp,
                                                fontWeight = FontWeight.Medium,
                                            ),
                                            color = colors.primaryContent,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }

                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        if (file.additions > 0) {
                                            Text(
                                                text = "+${file.additions}",
                                                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                                                color = AgentoColors.Success,
                                            )
                                        }
                                        if (file.deletions > 0) {
                                            Text(
                                                text = "-${file.deletions}",
                                                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
                                                color = AgentoColors.Error,
                                            )
                                        }
                                    }
                                }

                                if (isFileExpanded && file.diffSummary.isNotBlank()) {
                                    Spacer(Modifier.height(6.dp))
                                    Surface(
                                        color = if (isDark) Color(0xFF0D1117) else Color(0xFF161B22),
                                        shape = RoundedCornerShape(4.dp),
                                        modifier = Modifier.fillMaxWidth(),
                                    ) {
                                        Text(
                                            text = file.diffSummary,
                                            style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Code.copy(fontSize = 11.5.sp),
                                            color = if (isDark) AgentoColors.TextCode else Color.White,
                                            modifier = Modifier
                                                .horizontalScroll(rememberScrollState())
                                                .padding(6.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * 专为 "运行了 X 个工具" 设计的原生工具调用管线结构化卡片
 */
@Composable
fun ToolActivityGroupCard(
    operations: List<ToolCallUiState>,
    title: String? = null,
    modifier: Modifier = Modifier,
) {
    var expanded by remember(operations.map { it.id }.joinToString()) { mutableStateOf(false) }
    val colors = LocalAgentocColors.current
    val chevronContentDescription = stringResource(
        if (expanded) R.string.agentui_collapse else R.string.agentui_expand,
    )

    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 90f else 0f,
        animationSpec = AgentoMotion.SnappySpring,
        label = "tool_activity_chevron",
    )

    val allCompleted = operations.all { it.status == AgentOperationStatus.Completed }
    val hasFailed = operations.any { it.status == AgentOperationStatus.Failed }
    val summary = title ?: stringResource(R.string.agentui_completed_actions, operations.size)
    // The completed tool trail should recede behind the assistant's outcome.
    // Expanded details regain enough contrast for deliberate inspection.
    val isDark = colors.canvas.red < 0.5f
    val activitySurface = when {
        expanded && isDark -> colors.strongSurface.copy(alpha = 0.88f)
        expanded -> colors.quietSurface.copy(alpha = 0.96f)
        isDark -> colors.strongSurface.copy(alpha = 0.58f)
        else -> colors.quietSurface.copy(alpha = 0.82f)
    }

    val activityBorder = BorderStroke(
        width = 0.75.dp,
        brush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
    )

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(AgentoMotion.LayoutSpring),
        shape = RoundedCornerShape(16.dp),
        color = activitySurface,
        border = activityBorder,
        contentColor = colors.primaryContent,
        shadowElevation = 0.dp,
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .clickable { expanded = !expanded }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                AgentoWebIcon(
                    glyph = if (allCompleted) AgentoWebGlyph.Check else if (hasFailed) AgentoWebGlyph.Stop else AgentoWebGlyph.Terminal,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = if (allCompleted) AgentoColors.Success else if (hasFailed) AgentoColors.Error else LocalAgentocColors.current.accentPrimary,
                )

                Text(
                    text = summary,
                    modifier = Modifier.weight(1f),
                    style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                        fontWeight = FontWeight.Medium,
                        fontSize = 14.sp,
                    ),
                    color = colors.primaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )

                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronRight,
                    contentDescription = chevronContentDescription,
                    modifier = Modifier
                        .size(18.dp)
                        .graphicsLayer { rotationZ = chevronRotation },
                    tint = colors.secondaryContent,
                )
            }

            if (expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 8.dp, end = 8.dp, bottom = 8.dp, top = 2.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    operations.forEach { op ->
                        ToolCallCard(state = op)
                    }
                }
            }
        }
    }
}

/**
 * 专为 "任务已完成 / 等待输入 / 执行失败" 设计的原生任务状态表面
 */
@Composable
fun TaskStatusCard(
    state: TaskStatusUiState,
    onActionClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f

    val (bgTint, iconGlyph, iconTint) = when (state.status) {
        TaskStatusKind.Completed -> Triple(
            if (isDark) Color(0x1810B981) else Color(0xFFECFDF5),
            AgentoWebGlyph.Check,
            AgentoColors.Success,
        )
        TaskStatusKind.WaitingInput -> Triple(
            if (isDark) Color(0x18007AFF) else Color(0xFFEFF6FF),
            AgentoWebGlyph.Agent,
            LocalAgentocColors.current.accentPrimary,
        )
        TaskStatusKind.Failed -> Triple(
            if (isDark) Color(0x18EF4444) else Color(0xFFFEF2F2),
            AgentoWebGlyph.Stop,
            AgentoColors.Error,
        )
        TaskStatusKind.Running -> Triple(
            if (isDark) Color(0x188B5CF6) else Color(0xFFF5F3FF),
            AgentoWebGlyph.Refresh,
            Color(0xFF8B5CF6),
        )
    }

    val statusBorder = BorderStroke(
        width = 0.75.dp,
        brush = when (state.status) {
            TaskStatusKind.Completed -> SolidColor(AgentoColors.Success.copy(alpha = 0.35f))
            TaskStatusKind.WaitingInput -> SolidColor(LocalAgentocColors.current.accentPrimary.copy(alpha = 0.35f))
            TaskStatusKind.Failed -> SolidColor(AgentoColors.Error.copy(alpha = 0.35f))
            TaskStatusKind.Running -> if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight
        },
    )

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .agentoLargeCardShadow(shape = RoundedCornerShape(16.dp)),
        shape = RoundedCornerShape(16.dp),
        color = bgTint,
        border = statusBorder,
        contentColor = colors.primaryContent,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .background(iconTint.copy(alpha = 0.15f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = iconGlyph,
                    contentDescription = null,
                    modifier = Modifier.size(15.dp),
                    tint = iconTint,
                )
            }

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = state.title,
                    style = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold),
                    color = colors.primaryContent,
                )
                // Completed and in-progress activity is intentionally terse.
                // Decisions and failures retain their explanation because the
                // user may need to act on it immediately.
                if (!state.description.isNullOrBlank() &&
                    (state.status == TaskStatusKind.WaitingInput || state.status == TaskStatusKind.Failed)
                ) {
                    Text(
                        text = state.description,
                        style = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
                        color = colors.secondaryContent,
                    )
                }
            }

            if (state.retryLabel != null && onActionClick != null) {
                Surface(
                    onClick = onActionClick,
                    shape = RoundedCornerShape(4.dp),
                    color = iconTint,
                    contentColor = Color.White,
                ) {
                    Text(
                        text = state.retryLabel,
                        style = TextStyle(fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold),
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun PipelineGroupCard(
    operations: List<ToolCallUiState>,
    modifier: Modifier = Modifier,
) {
    ToolActivityGroupCard(operations = operations, modifier = modifier)
}

@Composable
fun CommandCard(command: String, status: AgentOperationStatus, modifier: Modifier = Modifier) {
    ToolCallCard(ToolCallUiState("command:$command", AgentOperationKind.Command, command, command, status), modifier)
}

@Composable
fun FileEditCard(path: String, detail: String, status: AgentOperationStatus, modifier: Modifier = Modifier) {
    ToolCallCard(ToolCallUiState("file:$path", AgentOperationKind.FileEdit, path, detail, status), modifier)
}

@Composable
fun DiffCard(title: String, diff: String, status: AgentOperationStatus = AgentOperationStatus.Completed, modifier: Modifier = Modifier) {
    ToolCallCard(ToolCallUiState("diff:$title", AgentOperationKind.Diff, title, diff, status), modifier)
}

@Composable
fun PermissionRequestCard(
    state: PermissionRequestUiState,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    backdropLayer: GraphicsLayer? = null,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }
    val colors = LocalAgentocColors.current
    val hapticView = LocalView.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }

    LaunchedEffect(state.id) {
        if (!state.resolving) {
            focusRequester.requestFocus()
        }
    }

    AgentoFrostedGlassBox(
        modifier = modifier
            .fillMaxWidth()
            .onGloballyPositioned { coordinates ->
                val position = coordinates.positionInRoot()
                backdropOffset = IntOffset(
                    x = -position.x.roundToInt(),
                    y = -position.y.roundToInt(),
                )
            }
            .animateContentSize(
                animationSpec = spring(
                    dampingRatio = 0.84f,
                    stiffness = 400f,
                ),
            )
            .focusRequester(focusRequester)
            .focusable()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = AgentoShapes.SquircleL,
        surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
        showTopHairline = true,
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        backdropLayer = backdropLayer,
        backdropOffset = backdropOffset,
        material = AgentoGlassMaterial.LiquidClear,
        hasShadow = true,
        shadowElevation = 8.dp,
    ) {
        if (state.resolving) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(36.dp)
                    .padding(horizontal = AgentoSpacing.Standard),
                horizontalArrangement = Arrangement.spacedBy(AgentoSpacing.Compact),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentoWebIcon(
                    AgentoWebGlyph.Check,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = AgentoColors.Success,
                )
                Text(
                    "Approved by user ✓",
                    style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(fontWeight = FontWeight.SemiBold),
                    color = AgentoColors.Success,
                )
            }
        } else {
            Column(
                Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AgentoWebIcon(
                            AgentoWebGlyph.Shield,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                            tint = AgentoColors.Warning,
                        )
                        Text(
                            "Approval Required",
                            style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                                fontWeight = FontWeight.SemiBold,
                            ),
                            color = AgentoColors.Warning,
                        )
                    }

                    Surface(
                        shape = AgentoShapes.SquircleXS,
                        color = Color(0x2EF87171),
                    ) {
                        Text(
                            text = state.riskLevel ?: "High Risk",
                            style = AgentocTextStyles.caption.copy(
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            color = AgentoColors.Error,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }

                val hostName = state.targetHost ?: "Office PC"
                Text(
                    text = "Execute on $hostName",
                    style = AgentocTextStyles.caption.copy(fontSize = 12.sp, color = colors.secondaryContent),
                )

                Text(
                    text = state.title,
                    style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Heading2.copy(fontSize = 16.sp),
                    color = colors.primaryContent,
                )

                if (state.reason.isNotBlank()) {
                    Text(
                        state.reason,
                        style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Body.copy(fontSize = 14.sp, lineHeight = 20.sp),
                        color = colors.secondaryContent,
                    )
                }

                state.saferAlternative?.let { cmd ->
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = AgentoShapes.SquircleS,
                        color = if (isDark) Color(0xFF0D1117) else Color(0xFFF1F3F5),
                    ) {
                        Text(
                            cmd,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Code.copy(fontSize = 12.5.sp),
                            color = colors.primaryContent,
                        )
                    }
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                ) {
                    AgentoButton(
                        text = state.denyLabel,
                        onClick = {
                            AgentoHaptics.performReject(hapticView)
                            onDeny()
                        },
                        modifier = Modifier.weight(1f).height(52.dp),
                        enabled = !state.resolving,
                        decision = true,
                        secondary = true,
                        hapticFeedback = false,
                    )
                    AgentoButton(
                        text = state.approveLabel,
                        onClick = {
                            AgentoHaptics.performConfirm(hapticView)
                            onApprove()
                        },
                        modifier = Modifier.weight(1f).height(52.dp),
                        enabled = !state.resolving,
                        decision = true,
                        secondary = false,
                        hapticFeedback = false,
                    )
                }
            }
        }
    }
}

@Composable
fun ScrollToBottomFab(
    visible: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    unseenCount: Int = 0,
    fastExit: Boolean = false,
) {
    val motion = com.andysagent.agentoc.core.designsystem.motionPolicy()
    val risePx = with(LocalDensity.current) { 4.dp.roundToPx() }
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(tween(motion.duration(120))) + slideInVertically(
            initialOffsetY = { risePx },
            animationSpec = tween(motion.duration(120)),
        ),
        exit = fadeOut(tween(motion.duration(if (fastExit) 90 else 180))),
        modifier = modifier,
    ) {
        val colors = LocalAgentocColors.current
        // Remove the input modifier as soon as exit begins. The fading pixels
        // must not retain a Surface's hit target over the transcript.
        val interaction = if (visible) Modifier
            .testTag("scroll-to-bottom")
            .agentoPressFeedback(onClick = onClick)
            .semantics { contentDescription = "Scroll to bottom" }
        else Modifier.testTag("scroll-to-bottom-exit").clearAndSetSemantics { }
        if (unseenCount > 0) {
            Box(
                modifier = Modifier
                    .agentoAmbientShadow(elevation = 8.dp, shape = AgentoShapes.PillShape)
                    .background(colors.floatingControl, AgentoShapes.PillShape)
                    .then(interaction)
                    .height(38.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "$unseenCount new",
                        style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.primaryContent,
                    )
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.ChevronDown,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = colors.primaryContent,
                    )
                }
            }
        } else {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .agentoAmbientShadow(elevation = 8.dp, shape = CircleShape)
                    .background(colors.floatingControl, CircleShape)
                    .then(interaction),
                contentAlignment = Alignment.Center,
            ) {
                Box(contentAlignment = Alignment.Center) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.ChevronDown,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp).testTag("scroll-to-bottom-glyph"),
                        tint = colors.floatingControlContent,
                    )
                }
            }
        }
    }
}

@Composable
fun FloatingTopChrome(
    sessionTitle: String,
    status: AgentRunStatus,
    onBack: () -> Unit,
    onMenu: () -> Unit,
    modifier: Modifier = Modifier,
    menuEnabled: Boolean = true,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    projectTitle: String? = null,
    hostTitle: String? = null,
    backContentDescription: String? = null,
    hasAttentionOrError: Boolean = false,
    // Dynamic Island affordance: tapping the title capsule expands the run
    // sheet. Null keeps the capsule inert (legacy callers).
    onTitleClick: (() -> Unit)? = null,
    // While the run-details island is expanded the capsule fades to 0 so the
    // island card takes its place without a double capsule.
    titleContentAlpha: Float = 1f,
    showTitle: Boolean = true,
    // The owning title island supplies measured free space. Standalone chrome
    // retains its usual full-size controls; no independent animation clock.
    sideControlsSpace: () -> Float = { 1f },
    sideControlsEnabled: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val isDark = colors.canvas.red < 0.5f
    val displayTitle = sessionTitle.takeIf {
        it.isNotBlank() && it != "New session" && it != "Session"
    } ?: stringResource(R.string.agentui_new_conversation)
    val subtitleText = remember(projectTitle, hostTitle) {
        val proj = projectTitle?.takeIf { it.isNotBlank() }
        val host = hostTitle?.takeIf { it.isNotBlank() }
        when {
            proj != null && host != null -> "$proj · $host"
            proj != null -> proj
            host != null -> host
            else -> null
        }
    }
    val resolvedBackContentDescription = backContentDescription ?: stringResource(R.string.agentui_back)
    val conversationDescription = if (subtitleText == null) {
        stringResource(R.string.agentui_conversation_title, displayTitle)
    } else {
        stringResource(R.string.agentui_conversation_project_title, displayTitle, subtitleText)
    }
    val titleBackdropOffset = remember { mutableStateOf(IntOffset.Zero) }

    // Keep three independent objects over the conversation instead of a
    // full-width toolbar: a back disc, a title/status capsule and an actions
    // disc. The centre capsule samples the live chat canvas just like the
    // composer and dock, while its foreground remains sharp.
    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .padding(horizontal = AgentoSpacing.ComposerMargin, vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (showTitle) AgentoFrostedGlassBox(
            modifier = Modifier
                .align(Alignment.Center)
                .graphicsLayer { alpha = titleContentAlpha }
                .heightIn(min = if (subtitleText != null) 46.dp else 40.dp)
                .widthIn(min = 100.dp, max = 185.dp)
                .agentoComposerShadow(shape = AgentoShapes.PillShape)
                .then(
                    if (onTitleClick != null) {
                        Modifier.agentoPressScale(
                            pressedScale = 0.96f,
                            onClick = onTitleClick,
                        )
                    } else {
                        Modifier
                    },
                )
                .onGloballyPositioned { coordinates ->
                    val position = coordinates.positionInRoot()
                    titleBackdropOffset.value = IntOffset(
                        x = backdropOrigin.x - position.x.roundToInt(),
                        y = backdropOrigin.y - position.y.roundToInt(),
                    )
                }
                .semantics { contentDescription = conversationDescription },
            shape = AgentoShapes.PillShape,
            // The header is part of the same floating-glass family as the
            // composer. Do not substitute a white/charcoal card here: it
            // masks the live backdrop and makes the title read as solid.
            surface = AgentoGlassSurface.Neutral,
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            backdropLayer = backdropLayer,
            backdropOffset = titleBackdropOffset.value,
            backdropTone = AgentoBackdropTone.QuietHeader,
            material = AgentoGlassMaterial.LiquidClear,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            contentAlignment = Alignment.Center,
            hasShadow = false,
        ) {
            ConversationCapsuleLabel(sessionTitle, projectTitle, hostTitle, status, hasAttentionOrError)
        }

        val controlsInteractive = sideControlsEnabled && sideControlsSpace() >= 1f
        AgentoFloatingIconButton(
            onClick = onBack,
            enabled = controlsInteractive,
            contentDescription = resolvedBackContentDescription,
            backdropTone = AgentoBackdropTone.QuietHeader,
            diffuseShadow = true,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = Modifier.align(Alignment.CenterStart)
                .graphicsLayer {
                    val space = sideControlsSpace().coerceIn(0f, 1f)
                    scaleX = space
                    scaleY = space
                    transformOrigin = TransformOrigin(0f, .5f)
                }
                .testTag("conversation-back-shell")
                .then(if (!controlsInteractive) Modifier.clearAndSetSemantics { } else Modifier),
        ) {
            AgentoWebIcon(
                AgentoWebGlyph.Back,
                contentDescription = null,
                tint = colors.floatingControlContent,
            )
        }

        AgentoFloatingIconButton(
            onClick = onMenu,
            contentDescription = stringResource(R.string.agentui_session_actions),
            backdropTone = AgentoBackdropTone.QuietHeader,
            diffuseShadow = true,
            enabled = menuEnabled && controlsInteractive,
            backdropLayer = backdropLayer,
            backdropOrigin = backdropOrigin,
            modifier = Modifier.align(Alignment.CenterEnd)
                .graphicsLayer {
                    val space = sideControlsSpace().coerceIn(0f, 1f)
                    scaleX = space
                    scaleY = space
                    transformOrigin = TransformOrigin(1f, .5f)
                }
                .testTag("conversation-more-shell")
                .then(if (!controlsInteractive) Modifier.clearAndSetSemantics { } else Modifier),
        ) {
            AgentoWebIcon(
                AgentoWebGlyph.More,
                contentDescription = null,
                tint = colors.floatingControlContent,
            )
        }
    }
}

@Composable
fun ConversationCapsuleLabel(
    sessionTitle: String,
    projectTitle: String?,
    hostTitle: String?,
    status: AgentRunStatus,
    hasAttentionOrError: Boolean = false,
    showStatusIndicator: Boolean = true,
) {
    val colors = LocalAgentocColors.current
    val displayTitle = sessionTitle.takeIf {
        it.isNotBlank() && it != "New session" && it != "Session"
    } ?: stringResource(R.string.agentui_new_conversation)
    val subtitleText = remember(projectTitle, hostTitle) {
        val proj = projectTitle?.takeIf { it.isNotBlank() }
        val host = hostTitle?.takeIf { it.isNotBlank() }
        when {
            proj != null && host != null -> "$proj · $host"
            proj != null -> proj
            host != null -> host
            else -> null
        }
    }
    val conversationDescription = if (subtitleText == null) {
        stringResource(R.string.agentui_conversation_title, displayTitle)
    } else {
        stringResource(R.string.agentui_conversation_project_title, displayTitle, subtitleText)
    }
            Column(
                modifier = Modifier
                    .widthIn(min = 100.dp, max = 185.dp)
                    .heightIn(min = 48.dp)
                    .semantics { contentDescription = conversationDescription }
                    .padding(
                    start = 16.dp,
                    end = 16.dp,
                    top = if (subtitleText != null) 7.5.dp else 9.dp,
                    bottom = if (subtitleText != null) 6.5.dp else 9.dp,
                ),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(1.5.dp, Alignment.CenterVertically),
            ) {
                Row(
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = displayTitle,
                        modifier = Modifier.weight(1f, fill = false),
                        style = com.andysagent.agentoc.core.designsystem.AgentoTypography.titleMedium.copy(
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            lineHeight = 17.5.sp,
                        ),
                        color = colors.primaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (status == AgentRunStatus.Working || status == AgentRunStatus.WaitingApproval || hasAttentionOrError) {
                        Spacer(Modifier.width(5.dp))
                        // Reserve the indicator's space during the island morph:
                        // its expanded body owns the readable status, but hiding
                        // this duplicate must not move the persistent title.
                        Box(Modifier.size(6.5.dp)) {
                            if (showStatusIndicator) {
                                val indicator = Modifier.testTag("conversation-status-indicator")
                                if (status == AgentRunStatus.Working) {
                                    com.andysagent.agentoc.core.designsystem.AgentoBreathingDot(
                                        color = colors.stateRunning, size = 6.5.dp, modifier = indicator,
                                    )
                                } else {
                                    Box(indicator.size(6.5.dp).background(
                                        if (status == AgentRunStatus.WaitingApproval) colors.stateWarning else colors.stateError,
                                        CircleShape,
                                    ))
                                }
                            }
                        }
                    }
                }
                if (subtitleText != null) {
                    Text(
                        text = subtitleText,
                        style = MaterialTheme.typography.labelSmall.copy(
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Normal,
                            lineHeight = 16.sp,
                        ),
                        color = colors.secondaryContent.copy(alpha = 0.75f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
}

@Composable
fun ChatTopStatusCapsule(
    status: AgentRunStatus,
    title: String? = null,
    projectTitle: String? = null,
    hostTitle: String? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalAgentocColors.current
    val indicatorColor = when (status) {
        AgentRunStatus.Idle -> Color(0xFF22C55E) // Clear vivid green
        AgentRunStatus.Cancelled -> colors.tertiaryContent
        AgentRunStatus.Working -> Color(0xFF3B82F6) // Clear vivid blue
        AgentRunStatus.WaitingApproval -> Color(0xFFF59E0B) // Amber Warning
        AgentRunStatus.Completed -> Color(0xFF10B981) // Success Green
        AgentRunStatus.Failed -> Color(0xFFEF4444) // Error Red
    }
    val statusLabel = when (status) {
        AgentRunStatus.Idle -> "Ready"
        AgentRunStatus.Working -> "Working"
        AgentRunStatus.WaitingApproval -> "Waiting for approval"
        AgentRunStatus.Completed -> "Completed"
        AgentRunStatus.Failed -> "Stopped"
        AgentRunStatus.Cancelled -> "Cancelled"
    }
    val displayTitle = title?.takeIf { it.isNotBlank() && it != "New session" } ?: "Session"
    val subtitleText = statusLabel

    Surface(
        modifier = modifier
            .height(44.dp)
            .agentoAmbientShadow(elevation = 10.dp, shape = AgentoShapes.PillShape, alpha = 0.04f)
            .semantics { contentDescription = "Session: $displayTitle, Status: $subtitleText" },
        shape = AgentoShapes.PillShape,
        color = colors.floatingControl.copy(alpha = 0.96f),
        contentColor = colors.floatingControlContent,
        shadowElevation = 0.dp,
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxHeight()
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier = Modifier.size(8.dp),
                contentAlignment = Alignment.Center,
            ) {
                if (status == AgentRunStatus.Working) {
                    com.andysagent.agentoc.core.designsystem.AgentoBreathingDot(
                        color = indicatorColor,
                        size = 8.dp,
                    )
                } else {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .background(indicatorColor, CircleShape),
                    )
                }
            }
            Column(
                modifier = Modifier.weight(1f, fill = false),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.Start,
            ) {
                Text(
                    text = displayTitle,
                    style = com.andysagent.agentoc.core.designsystem.AgentoTypography.titleMedium.copy(
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        lineHeight = 18.sp,
                    ),
                    color = colors.primaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = subtitleText,
                    style = AgentocTextStyles.caption.copy(
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.Normal,
                        lineHeight = 15.sp,
                        color = colors.secondaryContent,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
fun TransientStatusIndicator(text: String, modifier: Modifier = Modifier) {
    val colors = LocalAgentocColors.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(32.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        com.andysagent.agentoc.core.designsystem.AgentoBreathingDot(
            color = colors.secondaryContent,
            size = 6.dp,
        )
        Text(
            text = text,
            style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta,
            color = colors.secondaryContent,
        )
    }
}

@Composable
fun RecoverableStatusRow(
    text: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    retryLabel: String = "Retry",
) {
    val colors = LocalAgentocColors.current
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .agentoPressFeedback(onClick = onRetry),
        shape = AgentoShapes.SquircleM,
        color = AgentoColors.SurfaceLevel2,
        contentColor = colors.primaryContent,
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f),
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Info,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                    tint = AgentoColors.Warning,
                )
                Text(
                    text = text,
                    style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta,
                    color = colors.primaryContent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                text = retryLabel,
                style = com.andysagent.agentoc.core.designsystem.AgentoConversationTypography.Meta.copy(
                    fontWeight = FontWeight.SemiBold,
                    color = LocalAgentocColors.current.accentPrimary,
                ),
            )
        }
    }
}

@Composable
fun SubAgentCard(title: String, status: AgentRunStatus, detail: String, modifier: Modifier = Modifier) {
        Surface(
            modifier = modifier
                .fillMaxWidth()
                .agentoLargeCardShadow(shape = MaterialTheme.shapes.medium),
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
        ) {
        Row(Modifier.padding(AgentocSpacing.Standard), horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Standard), verticalAlignment = Alignment.CenterVertically) {
            AgentoWebIcon(AgentoWebGlyph.Agent, contentDescription = null)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            AgentoStatus(statusLabel(status), statusTone(status))
        }
    }
}

@Composable
fun AgentStatus(status: AgentRunStatus, modifier: Modifier = Modifier) = AgentoStatus(statusLabel(status), statusTone(status), modifier)

@Composable
fun RunStatus(status: AgentRunStatus, modifier: Modifier = Modifier) = AgentoStatus(statusLabel(status), statusTone(status), modifier)

@Composable
fun ConnectionStatus(status: AgentConnectionStatus, modifier: Modifier = Modifier) = AgentoStatus(connectionLabel(status), connectionTone(status), modifier)

@Composable
fun RetryCard(
    state: RetryUiState,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    onDismiss: () -> Unit = {},
    compact: Boolean = false,
) {
    val density = LocalDensity.current
    val motionPolicy = LocalMotionPolicy.current
    val scope = rememberCoroutineScope()
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    val offset = remember { androidx.compose.animation.core.Animatable(0f) }
    var dragOffset by remember { mutableStateOf(0f) }
    var isDragging by remember { mutableStateOf(false) }

    BoxWithConstraints(modifier = modifier.fillMaxWidth()) {
        val widthPx = with(density) { maxWidth.toPx() }
        val displayedOffset = if (isDragging) dragOffset else offset.value
        val swipeProgress = if (widthPx > 0f) {
            (displayedOffset / widthPx).coerceIn(0f, 1f)
        } else {
            0f
        }

        val colors = LocalAgentocColors.current
        val isDark = colors.canvas.red < 0.5f
        val shape = RoundedCornerShape(if (compact) 16.dp else 20.dp)
        AgentoFrostedGlassBox(
            modifier = Modifier
                .graphicsLayer {
                    translationX = displayedOffset
                    alpha = 1f - swipeProgress * 0.12f
                    scaleX = 1f - swipeProgress * 0.025f
                    scaleY = 1f - swipeProgress * 0.025f
                }
                .fillMaxWidth()
                .pointerInput(widthPx, motionPolicy.preference) {
                    val thresholdPx = (widthPx * 0.4f).coerceAtLeast(with(density) { 120.dp.toPx() })
                    val velocityThresholdPx = with(density) { 1_000.dp.toPx() }
                    val velocityTracker = VelocityTracker()

                    fun settle(target: Float, dismiss: Boolean) {
                        scope.launch {
                            offset.snapTo(dragOffset)
                            isDragging = false
                            if (motionPolicy.preference == MotionPreference.None) {
                                offset.snapTo(target)
                            } else {
                                offset.animateTo(
                                    targetValue = target,
                                    animationSpec = if (dismiss) AgentoMotion.AppleSpring else AgentoMotion.AppleReleaseSpring,
                                )
                            }
                            if (dismiss) currentOnDismiss()
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
                    contentDescription = "${state.title}. ${state.detail}. Swipe right to dismiss."
                },
            shape = shape,
            // A recoverable failure is a floating control, not a red panel.
            // Keep the material neutral; the icon alone carries the error tone.
            surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = true,
            shadowElevation = 6.dp,
        ) {
            Row(
                Modifier.padding(
                    horizontal = if (compact) 12.dp else AgentocSpacing.Standard,
                    vertical = if (compact) 8.dp else AgentocSpacing.Standard,
                ),
                horizontalArrangement = Arrangement.spacedBy(AgentocSpacing.Compact),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentoWebIcon(
                    AgentoWebGlyph.Refresh,
                    contentDescription = null,
                    modifier = Modifier.size(if (compact) 18.dp else 24.dp),
                    tint = colors.error,
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        state.title,
                        style = if (compact) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleSmall,
                        color = colors.primaryContent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        state.detail,
                        style = if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodyMedium,
                        color = colors.secondaryContent,
                        maxLines = if (compact) 1 else 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Box(
                    modifier = Modifier
                        .defaultMinSize(minHeight = AgentocSpacing.TouchTarget)
                        .clip(AgentoShapes.PillShape)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = onRetry,
                        )
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        state.retryLabel,
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.accentPrimary,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
fun ErrorCard(title: String, detail: String, onRetry: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    if (onRetry == null) AgentoErrorState(title, detail, modifier = modifier)
    else AgentoErrorState(title, detail, retryLabel = "Retry", onRetry = onRetry, modifier = modifier)
}

@Composable
private fun statusContentColor(status: AgentOperationStatus) = when (status) {
    AgentOperationStatus.Completed -> LocalAgentocColors.current.success
    AgentOperationStatus.Failed -> LocalAgentocColors.current.error
    AgentOperationStatus.Pending, AgentOperationStatus.InProgress -> LocalAgentocColors.current.secondaryContent
}

@Composable
private fun statusLabel(status: AgentOperationStatus): String = stringResource(
    when (status) {
        AgentOperationStatus.Pending -> R.string.agentui_status_queued
        AgentOperationStatus.InProgress -> R.string.agentui_status_working
        AgentOperationStatus.Completed -> R.string.agentui_status_completed
        AgentOperationStatus.Failed -> R.string.agentui_status_failed
    },
)

@Composable
private fun statusLabel(status: AgentRunStatus): String = stringResource(
    when (status) {
        AgentRunStatus.Idle -> R.string.agentui_status_ready
        AgentRunStatus.Working -> R.string.agentui_status_working
        AgentRunStatus.WaitingApproval -> R.string.agentui_status_waiting_for_approval
        AgentRunStatus.Completed -> R.string.agentui_status_completed
        AgentRunStatus.Failed -> R.string.agentui_status_failed
        AgentRunStatus.Cancelled -> R.string.agentui_status_cancelled
    },
)

private fun statusTone(status: AgentRunStatus): AgentoStatusTone = when (status) {
    AgentRunStatus.Idle, AgentRunStatus.Cancelled -> AgentoStatusTone.Neutral
    AgentRunStatus.Working -> AgentoStatusTone.Running
    AgentRunStatus.WaitingApproval -> AgentoStatusTone.Waiting
    AgentRunStatus.Completed -> AgentoStatusTone.Success
    AgentRunStatus.Failed -> AgentoStatusTone.Error
}

@Composable
private fun connectionLabel(status: AgentConnectionStatus): String = stringResource(
    when (status) {
        AgentConnectionStatus.Disconnected -> R.string.agentui_connection_disconnected
        AgentConnectionStatus.Connecting -> R.string.agentui_connection_connecting
        AgentConnectionStatus.Connected -> R.string.agentui_connection_connected
        AgentConnectionStatus.Reconnecting -> R.string.agentui_connection_reconnecting
        AgentConnectionStatus.AuthenticationRequired -> R.string.agentui_connection_sign_in_required
        AgentConnectionStatus.Error -> R.string.agentui_connection_error
    },
)

private fun connectionTone(status: AgentConnectionStatus): AgentoStatusTone = when (status) {
    AgentConnectionStatus.Disconnected -> AgentoStatusTone.Neutral
    AgentConnectionStatus.Connecting, AgentConnectionStatus.Reconnecting -> AgentoStatusTone.Running
    AgentConnectionStatus.Connected -> AgentoStatusTone.Success
    AgentConnectionStatus.AuthenticationRequired -> AgentoStatusTone.Waiting
    AgentConnectionStatus.Error -> AgentoStatusTone.Error
}
