package com.andysagent.ragent.feature.workbench

import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.agentui.FullscreenComposerModal
import com.andysagent.ragent.core.agentui.MarkdownComposerEditor
import com.andysagent.ragent.core.agentui.OpposingCornersIcon
import com.andysagent.ragent.core.agentui.R as AgentUiR
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoMotion
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentTextStyles
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.ragentComposerShadow
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.model.RuntimeCatalog
import kotlin.math.roundToInt

private const val MAX_VISIBLE_COMPOSER_LINES = 4

/**
 * TaskComposer: Layer D of the Ragent Task Workspace.
 *
 * The ONLY permanent floating frosted glass layer.
 *
 * Three States:
 * 1. Compact: 56dp height idle input [ + ] Ask Ragent what to do… [ ↑ ]
 * 2. Expanded: 112–188dp typing area with internal attachment preview
 * 3. Task Settings: opened into bottom sheet from a single quiet pill
 */
@Composable
fun TaskComposer(
    value: String,
    onValueChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    working: Boolean,
    onAddAttachment: () -> Unit,
    onOpenTaskSettings: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    attachments: List<ComposerAttachment> = emptyList(),
    onRemoveAttachment: (String) -> Unit = {},
    runtimeCatalog: RuntimeCatalog = RuntimeCatalog(),
    runtimeTool: String = "codex",
    runtimeModel: String? = null,
    effort: Float = 0.5f,
    goalMode: Boolean = false,
    goalText: String = "",
    expanded: Boolean = false,
    onExpandedChange: (Boolean) -> Unit = {},
    pendingSend: Boolean = false,
    onPasteImage: (List<Uri>) -> Unit = {},
    backdropLayer: GraphicsLayer? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    var textLineCount by remember { mutableIntStateOf(1) }
    var isFullscreenOpen by rememberSaveable { mutableStateOf(false) }
    var pendingEditorFocus by remember { mutableStateOf(false) }

    val hasContent = value.isNotBlank() || attachments.isNotEmpty()
    val isExpanded = expanded || hasContent

    val isOverVisibleLines = remember(value, textLineCount) {
        textLineCount > MAX_VISIBLE_COMPOSER_LINES || value.count { it == '\n' } >= MAX_VISIBLE_COMPOSER_LINES
    }

    // Dynamic settings label (e.g. "Codex · High reasoning")
    val selectedTool = runtimeCatalog.tools.firstOrNull { it.id.equals(runtimeTool, ignoreCase = true) }
    val selectedModel = selectedTool?.models?.firstOrNull { it.id.equals(runtimeModel, ignoreCase = true) }
    val toolName = selectedTool?.label ?: if (runtimeTool.equals("codex", ignoreCase = true)) "Codex" else runtimeTool
    val modelName = selectedModel?.label
    val levels = selectedModel?.effortLevels.orEmpty()
    val effortName = levels.getOrNull((effort.coerceIn(0f, 1f) * (levels.size - 1).coerceAtLeast(0)).roundToInt())
    val settingsSummary = buildString {
        append(modelName ?: toolName)
        if (effortName != null) append(" · ").append(effortName)
        if (goalMode && goalText.isNotBlank()) {
            append(" · Goal")
        }
    }

    LaunchedEffect(isExpanded) {
        if (!isExpanded) {
            focusManager.clearFocus(force = true)
        }
    }

    LaunchedEffect(isExpanded, pendingEditorFocus, enabled) {
        if (isExpanded && pendingEditorFocus && enabled) {
            focusRequester.requestFocus()
            pendingEditorFocus = false
        }
    }

    fun expandAndFocus() {
        pendingEditorFocus = true
        onExpandedChange(true)
    }

    if (isFullscreenOpen) {
        FullscreenComposerModal(
            value = value,
            onValueChange = onValueChange,
            onPasteImage = onPasteImage,
            onDismiss = { isFullscreenOpen = false },
            onSend = onSend,
            onStop = onStop,
            working = working,
            pendingSend = pendingSend,
            enabled = enabled,
            hasAttachments = attachments.isNotEmpty(),
        )
    }

    val composerShape = if (isExpanded) RoundedCornerShape(20.dp) else AgentoShapes.PillShape
    var composerBackdropOffset by remember { mutableStateOf(IntOffset.Zero) }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .testTag("task-composer")
            .ragentComposerShadow(shape = composerShape)
            .onGloballyPositioned { coordinates ->
                val pos = coordinates.positionInRoot()
                composerBackdropOffset = IntOffset(-pos.x.roundToInt(), -pos.y.roundToInt())
            }
            .animateContentSize(
                animationSpec = spring(dampingRatio = 0.88f, stiffness = 380f),
                alignment = Alignment.BottomCenter,
            ),
    ) {
        AgentoFrostedGlassBox(
            modifier = Modifier.fillMaxWidth(),
            shape = composerShape,
            surface = AgentoGlassSurface.Tinted(colors.glassSurface),
            blurRadius = AgentoFrostedTokens.BlurStandard,
            showTopHairline = true,
            specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
            backdropLayer = backdropLayer,
            backdropOffset = composerBackdropOffset,
            material = AgentoGlassMaterial.LiquidRegular,
            hasShadow = false,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Top Fullscreen Edit Button (when text exceeds visible line threshold)
                AnimatedVisibility(
                    visible = isExpanded && isOverVisibleLines,
                    enter = expandVertically(spring(dampingRatio = 0.85f)) + fadeIn(),
                    exit = shrinkVertically(spring(dampingRatio = 0.85f)) + fadeOut(),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(30.dp)
                            .padding(end = 10.dp, top = 4.dp),
                        horizontalArrangement = Arrangement.End,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .clickable { isFullscreenOpen = true },
                            contentAlignment = Alignment.Center,
                        ) {
                            OpposingCornersIcon(
                                tint = colors.secondaryContent,
                                modifier = Modifier.size(15.dp),
                            )
                        }
                    }
                }

                // Internal Attachment Preview Tray (embedded inside Composer)
                AnimatedVisibility(
                    visible = isExpanded && attachments.isNotEmpty(),
                    enter = expandVertically(spring(dampingRatio = 0.88f)) + fadeIn(),
                    exit = shrinkVertically(spring(dampingRatio = 0.88f)) + fadeOut(),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        attachments.forEach { att ->
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                color = if (isDark) Color(0xFF27272A) else Color(0xFFE4E4E7),
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    AgentoWebIcon(
                                        glyph = if (att.mimeType.startsWith("image/")) AgentoWebGlyph.Maximize else AgentoWebGlyph.File,
                                        contentDescription = null,
                                        modifier = Modifier.size(13.dp),
                                        tint = colors.secondaryContent,
                                    )
                                    Text(
                                        text = att.name,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = colors.primaryContent,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                    Box(
                                        modifier = Modifier
                                            .size(16.dp)
                                            .clip(CircleShape)
                                            .clickable { onRemoveAttachment(att.id) },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        AgentoWebIcon(
                                            glyph = AgentoWebGlyph.Close,
                                            contentDescription = "Remove attachment",
                                            modifier = Modifier.size(10.dp),
                                            tint = colors.secondaryContent,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                // Expanded Text Area (always expands upwards)
                AnimatedVisibility(
                    visible = isExpanded,
                    enter = expandVertically(spring(dampingRatio = 0.88f)) + fadeIn(),
                    exit = shrinkVertically(spring(dampingRatio = 0.88f)) + fadeOut(),
                ) {
                    val textFieldScrollState = rememberScrollState()
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 60.dp, max = 150.dp)
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                enabled = enabled,
                            ) {
                                expandAndFocus()
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
                                .focusRequester(focusRequester)
                                .onFocusChanged { state ->
                                    if (state.isFocused) onExpandedChange(true)
                                }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            textStyle = RagentTextStyles.userBody.copy(
                                color = if (enabled) colors.primaryContent else colors.disabledContent,
                            ),
                            cursorBrush = SolidColor(LocalRagentColors.current.accentPrimary),
                            maxLines = Int.MAX_VALUE,
                            singleLine = false,
                            isDark = isDark,
                            scrollState = textFieldScrollState,
                            onTextLayout = { textLayoutResult ->
                                textLineCount = textLayoutResult.lineCount
                            },
                            decorationBox = { innerTextField ->
                                Box(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    if (value.isEmpty()) {
                                        Text(
                                            "Ask Ragent what to do…",
                                            style = RagentTextStyles.userBody,
                                            color = colors.secondaryContent,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                    innerTextField()
                                }
                            },
                        )
                    }
                }

                // Bottom Action Row (Always pinned, height 52-56dp)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp)
                        .padding(horizontal = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Pinned '+' Button (Left)
                    AgentoIconButton(
                        onClick = onAddAttachment,
                        enabled = enabled,
                        contentDescription = "Add attachment or quick action",
                    ) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(CircleShape)
                                .background(if (isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.05f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            AgentoWebIcon(
                                AgentoWebGlyph.Plus,
                                contentDescription = null,
                                modifier = Modifier.size(18.dp),
                                tint = if (enabled) colors.primaryContent else colors.disabledContent,
                            )
                        }
                    }

                    // Collapsed state: single-line input field in center
                    if (!isExpanded) {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .clickable(
                                    interactionSource = remember { MutableInteractionSource() },
                                    indication = null,
                                    enabled = enabled,
                                ) {
                                    expandAndFocus()
                                }
                                .padding(horizontal = 8.dp),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            MarkdownComposerEditor(
                                value = value,
                                onValueChange = onValueChange,
                                onPasteImage = onPasteImage,
                                enabled = enabled,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .focusRequester(focusRequester)
                                    .onFocusChanged { state ->
                                        if (state.isFocused) onExpandedChange(true)
                                    },
                                textStyle = RagentTextStyles.userBody.copy(
                                    color = if (enabled) colors.primaryContent else colors.disabledContent,
                                ),
                                cursorBrush = SolidColor(LocalRagentColors.current.accentPrimary),
                                maxLines = 1,
                                singleLine = true,
                                isDark = isDark,
                                decorationBox = { innerTextField ->
                                    Box(
                                        modifier = Modifier.fillMaxWidth(),
                                        contentAlignment = Alignment.CenterStart,
                                    ) {
                                        if (value.isEmpty()) {
                                            Text(
                                                "Ask Ragent what to do…",
                                                style = RagentTextStyles.userBody,
                                                color = colors.secondaryContent,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        innerTextField()
                                    }
                                },
                            )
                        }
                    } else {
                        // Expanded state: Settings summary pill on left
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .padding(start = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                color = if (isDark) Color(0x1AFFFFFF) else Color(0x0F000000),
                                modifier = Modifier
                                    .clip(RoundedCornerShape(8.dp))
                                    .clickable(onClick = onOpenTaskSettings),
                            ) {
                                Row(
                                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    AgentoWebIcon(
                                        glyph = AgentoWebGlyph.Settings,
                                        contentDescription = null,
                                        modifier = Modifier.size(12.dp),
                                        tint = colors.secondaryContent,
                                    )
                                    Text(
                                        text = settingsSummary,
                                        style = MaterialTheme.typography.labelSmall.copy(
                                            fontWeight = FontWeight.Medium,
                                            fontSize = 11.sp,
                                        ),
                                        color = colors.secondaryContent,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }

                    // Right: Send [ ↑ ] / Stop [ ■ ] button
                    val canSend = (value.isNotBlank() || attachments.isNotEmpty()) && enabled && !working
                    Box(
                        modifier = Modifier
                            .size(36.dp)
                            .clip(CircleShape)
                            .background(
                                when {
                                    working -> colors.error
                                    canSend -> colors.actionPrimary
                                    else -> if (isDark) Color(0x1FFFFFFF) else Color(0x0F000000)
                                }
                            )
                            .clickable(
                                enabled = working || canSend,
                                onClick = if (working) onStop else onSend,
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (working) {
                            Box(
                                modifier = Modifier
                                    .size(12.dp)
                                    .clip(RoundedCornerShape(2.dp))
                                    .background(Color.White),
                            )
                        } else {
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.Send,
                                contentDescription = "Send message",
                                modifier = Modifier.size(18.dp),
                                tint = if (canSend) colors.actionPrimaryContent else colors.disabledContent,
                            )
                        }
                    }
                }
            }
        }
    }
}
