package com.andysagent.ragent.core.designsystem

import android.os.Build
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import kotlinx.coroutines.launch
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.roundToInt

@Composable
fun AgentoButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    decision: Boolean = false,
    secondary: Boolean = false,
    destructive: Boolean = false,
    secondaryContainerColor: Color? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp),
    leadingIcon: (@Composable () -> Unit)? = null,
    labelStyle: TextStyle = MaterialTheme.typography.labelLarge,
    hapticFeedback: Boolean = true,
    labelMaxLines: Int = 1,
) {
    val colors = LocalRagentColors.current
    val pressInteractionSource = remember { MutableInteractionSource() }
    val buttonShape = RoundedCornerShape(999.dp)
    val buttonBackground = when {
        // A secondary action is a small neutral glass control. It should not
        // become another blue contained button competing with the primary.
        secondary -> secondaryContainerColor ?: colors.glassSurface
        destructive && enabled -> colors.actionDestructive
        // Keep the supplied brand blue intact. Blending it with the light
        // canvas made the control brighter and more Material-like than the
        // actual Ragent blue.
        enabled -> colors.actionPrimary
        else -> colors.strongSurface
    }
    val buttonContent = when {
        !enabled -> colors.disabledContent
        secondary -> colors.primaryContent
        destructive && enabled -> AgentoFrostedTokens.OnDestructiveAction
        enabled -> colors.actionPrimaryContent
        else -> colors.disabledContent
    }

    val actionModifier = modifier
        .defaultMinSize(
            minHeight = if (decision) RagentSpacing.DecisionTarget else RagentSpacing.TouchTarget,
        )
        .agentoPressScale(
            pressedScale = if (decision) 0.975f else 0.98f,
            onClick = onClick.takeIf { enabled },
            interactionSource = pressInteractionSource,
            hapticFeedback = hapticFeedback,
        )
        .semantics(mergeDescendants = true) {
            role = Role.Button
            if (!enabled) disabled()
        }
    val label: @Composable () -> Unit = {
        CompositionLocalProvider(LocalContentColor provides buttonContent) {
            Row(
                modifier = Modifier.padding(contentPadding),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                if (leadingIcon != null) {
                    leadingIcon()
                    Spacer(Modifier.width(RagentSpacing.Compact))
                }
                Text(
                    text,
                    style = labelStyle,
                    maxLines = labelMaxLines,
                    softWrap = labelMaxLines > 1,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    color = buttonContent,
                )
            }
        }
    }
    if (secondary) {
        AgentoFrostedGlassBox(
            modifier = actionModifier,
            shape = buttonShape,
            surface = AgentoGlassSurface.Tinted(buttonBackground),
            blurRadius = AgentoFrostedTokens.BlurStandard,
            showTopHairline = false,
            specularBrush = null,
            material = if (enabled) AgentoGlassMaterial.LiquidRegular else AgentoGlassMaterial.ContentRegular,
            hasShadow = enabled,
            shadowElevation = 4.dp,
            shadowAlpha = if (colors.canvas.red < 0.5f) 0.12f else 0.035f,
            shadowSpotAlpha = if (colors.canvas.red < 0.5f) 0.14f else 0.05f,
            contentAlignment = Alignment.Center,
        ) { label() }
    } else {
        // A contained action has a defined foreground/background pair. Feeding
        // its fill through the glass tint changes that pair (and contrast).
        // The surrounding panel remains glass; the small action stays crisp.
        Box(
            modifier = actionModifier.clip(buttonShape).background(buttonBackground),
            contentAlignment = Alignment.Center,
        ) { label() }
    }
}

/** Quiet navigation with a full touch target, without another filled surface. */
@Composable
fun AgentoTextAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    androidx.compose.material3.TextButton(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = RagentSpacing.TouchTarget),
        colors = ButtonDefaults.textButtonColors(
            contentColor = LocalRagentColors.current.secondaryContent,
        ),
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

@Composable
fun AgentoIconButton(
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val contentColor = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent
    Box(
        modifier = modifier
            .size(RagentSpacing.TouchTarget)
            .agentoPressScale(pressedScale = 0.94f, onClick = onClick.takeIf { enabled })
            .semantics {
                role = Role.Button
                this.contentDescription = contentDescription
            },
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) {
            content()
        }
    }
}

/**
 * Chat navigation keeps a generous hit target without turning every toolbar
 * action into a floating card. The transcript and composer own elevation.
 */
@Composable
fun AgentoFloatingIconButton(
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    hasGlassBackdrop: Boolean = true,
    /** Live canvas layer for the true defocus blur; null keeps substrate-only glass. */
    backdropLayer: GraphicsLayer? = null,
    /** Root-space origin of [backdropLayer]'s recorded canvas. */
    backdropOrigin: IntOffset = IntOffset.Zero,
    backdropTone: AgentoBackdropTone = AgentoBackdropTone.Standard,
    /** Use the composer's diffuse halo instead of the small elevation shadow. */
    diffuseShadow: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val contentColor = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent
    // The backdrop is a full-screen capture. Each control must translate it
    // back to its own window position before applying RenderEffect; otherwise
    // every icon samples the page's top-left pixels and reads as a flat disc.
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }
    val backdropModifier = if (hasGlassBackdrop) {
        Modifier
            .size(36.dp)
            .agentoPressScale(pressedScale = 0.92f, onClick = onClick.takeIf { enabled })
    } else {
        Modifier
    }

    Box(
        modifier = modifier
            .size(RagentSpacing.TouchTarget)
            .then(backdropModifier)
            .semantics {
                role = Role.Button
                this.contentDescription = contentDescription
            },
        contentAlignment = Alignment.Center,
    ) {
        if (hasGlassBackdrop) {
            // Same One UI defocus material as the islands, composer, and
            // every other floating surface — one continuous glass family.
            AgentoFrostedGlassBox(
                modifier = Modifier
                    .size(36.dp)
                    .then(if (diffuseShadow) Modifier.ragentComposerShadow(shape = CircleShape) else Modifier)
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        backdropOffset = IntOffset(
                            x = backdropOrigin.x - position.x.roundToInt(),
                            y = backdropOrigin.y - position.y.roundToInt(),
                        )
                    },
                shape = CircleShape,
                // Match the composer rather than placing an opaque action
                // disc over the transcript. The icon stays sharp; only the
                // locally sampled backdrop receives the large defocus.
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOffset,
                backdropTone = backdropTone,
                material = AgentoGlassMaterial.LiquidClear,
                hasShadow = !diffuseShadow,
                shadowElevation = 3.dp,
                shadowAlpha = if (isDark) 0.12f else 0.04f,
                contentAlignment = Alignment.Center,
            ) {
                CompositionLocalProvider(LocalContentColor provides contentColor) {
                    content()
                }
            }
        } else {
            CompositionLocalProvider(LocalContentColor provides contentColor) {
                content()
            }
        }
    }
}

@Composable
fun AgentoToolbarIconButton(
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    hasGlassBackdrop: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val contentColor = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent
    val backdropModifier = if (hasGlassBackdrop) {
        val buttonBg = if (isDark) {
            // Apple System Thin Material for circular action discs:
            // Translucent silver-white glass disc that separates clearly from dark canvas
            Color.White.copy(alpha = 0.14f)
        } else {
            Color.Black.copy(alpha = 0.06f)
        }
        val buttonBorder = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(buttonBg)
            .border(androidx.compose.foundation.BorderStroke(0.6.dp, buttonBorder), CircleShape)
    } else {
        Modifier
    }

    Box(
        modifier = modifier
            .size(RagentSpacing.TouchTarget)
            .agentoPressScale(pressedScale = 0.92f, onClick = onClick.takeIf { enabled })
            .semantics {
                role = Role.Button
                this.contentDescription = contentDescription
                if (!enabled) disabled()
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = backdropModifier,
            contentAlignment = Alignment.Center,
        ) {
            CompositionLocalProvider(LocalContentColor provides contentColor) {
                content()
            }
        }
    }
}

@Composable
fun AgentoIcon(
    imageVector: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Icon(imageVector, contentDescription = contentDescription, modifier = modifier, tint = tint)
}

/** Dims the activity behind a modal without blurring the page. */
@Composable
fun AgentoModalBackgroundDim(
    amount: Float,
) {
    val hostView = LocalView.current
    val isDark = LocalRagentColors.current.canvas.red < 0.5f
    SideEffect {
        val window = (hostView.parent as? DialogWindowProvider)?.window ?: return@SideEffect
        androidx.core.view.WindowCompat.getInsetsController(window, hostView).apply {
            isAppearanceLightStatusBars = !isDark
            isAppearanceLightNavigationBars = !isDark
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        window.clearFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.attributes = window.attributes.apply {
            dimAmount = amount.coerceIn(0f, 1f)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                blurBehindRadius = 0
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            window.setBackgroundBlurRadius(0)
        }
    }
}

val LocalModalBottomSheetDismiss = compositionLocalOf<(() -> Unit)?> { null }

/**
 * A bottom sheet whose surface, rather than the activity behind it, owns the
 * defocus. Callers pass the live page layer, exactly as the floating
 * navigation dock does. This stays in the activity's Compose tree rather
 * than opening a second dialog window, so the sampled content keeps updating
 * while the page scrolls or the composer changes.
 */
@Composable
fun AgentoFrostedModalBottomSheet(
    onDismissRequest: () -> Unit,
    backdropLayer: GraphicsLayer?,
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = AgentoShapes.BottomSheetShape,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val density = LocalDensity.current
    val coroutineScope = rememberCoroutineScope()
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }
    var sheetHeightPx by remember { mutableFloatStateOf(0f) }
    val defaultSlidePx = with(density) { 720.dp.toPx() }
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current

    val animProgress = remember { Animatable(0f) }
    var isDismissing by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        animProgress.animateTo(
            targetValue = 1f,
            animationSpec = spring(
                dampingRatio = 0.84f,
                stiffness = 380f,
            ),
        )
    }

    val dismissSheet: () -> Unit = {
        if (!isDismissing) {
            isDismissing = true
            coroutineScope.launch {
                animProgress.animateTo(
                    targetValue = 0f,
                    animationSpec = tween(durationMillis = 200, easing = FastOutSlowInEasing),
                )
                onDismissRequest()
            }
        }
    }

    BackHandler(enabled = !isDismissing) {
        dismissSheet()
    }

    CompositionLocalProvider(LocalModalBottomSheetDismiss provides dismissSheet) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                // This is a sibling of the composer, not its IME-inset child.
                // Constrain the sheet itself to the space above the keyboard.
                .imePadding()
                .zIndex(8f),
        ) {
            // Smoothly fading dim scrim on GPU layer
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer { alpha = animProgress.value }
                    .background(colors.glassScrim.copy(alpha = if (isDark) 0.36f else 0.25f))
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = dismissSheet,
                    )
                    .semantics { contentDescription = "Close sheet" },
            )

            // Sheet container: full-bottom coverage with GPU translation and rich milky frosted glass
            AgentoFrostedGlassBox(
                modifier = modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .heightIn(max = 880.dp)
                    .graphicsLayer {
                        val totalSlide = if (sheetHeightPx > 0f) sheetHeightPx else defaultSlidePx
                        translationY = (1f - animProgress.value) * totalSlide
                    }
                    .onSizeChanged { size ->
                        if (size.height > 0) {
                            sheetHeightPx = size.height.toFloat()
                        }
                    }
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        backdropOffset = IntOffset(
                            x = pageBackdropOrigin.x - position.x.roundToInt(),
                            y = pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                    },
                shape = shape,
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOffset,
                material = AgentoGlassMaterial.LiquidClear,
                backdropTone = AgentoBackdropTone.QuietHeader,
                specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                hasShadow = false,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding(),
                ) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.CenterHorizontally)
                            .padding(top = 10.dp, bottom = 6.dp)
                            .size(width = 36.dp, height = 4.dp)
                            .clip(CircleShape)
                            .background(
                                if (isDark) Color.White.copy(alpha = 0.28f) else Color.Black.copy(alpha = 0.22f),
                            ),
                    )
                    content()
                }
            }
        }
    }
}

/**
 * In-tree Frosted Glass Menu Popover.
 * Operates in the same Window and RenderNode tree as the conversation canvas,
 * enabling TRUE hardware Gaussian defocus blur (散焦模糊玻璃) of the background text.
 * Provides fluid Apple/One UI open and exit scaling transitions.
 */
@Composable
fun AgentoFrostedMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    backdropLayer: GraphicsLayer? = null,
    backdropOrigin: IntOffset = IntOffset.Zero,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }

    BackHandler(enabled = expanded) {
        onDismissRequest()
    }

    androidx.compose.animation.AnimatedVisibility(
        visible = expanded,
        enter = fadeIn(tween(140)),
        exit = fadeOut(tween(110)),
        modifier = Modifier
            .fillMaxSize()
            .zIndex(99f),
    ) {
        Box(
            modifier = Modifier.fillMaxSize(),
        ) {
            // Invisible touch barrier to dismiss menu when clicking outside
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onDismissRequest,
                    ),
            )

            // Anchored Frosted Glass Popover Card with scale & alpha
            Box(
                modifier = modifier
                    .animateEnterExit(
                        enter = scaleIn(
                            initialScale = 0.85f,
                            transformOrigin = TransformOrigin(0.95f, 0.05f),
                            animationSpec = spring(dampingRatio = 0.80f, stiffness = 420f),
                        ) + fadeIn(tween(150)),
                        exit = scaleOut(
                            targetScale = 0.88f,
                            transformOrigin = TransformOrigin(0.95f, 0.05f),
                            animationSpec = tween(120),
                        ) + fadeOut(tween(100)),
                    ),
            ) {
                AgentoFrostedGlassBox(
                    modifier = Modifier
                        .widthIn(min = 196.dp, max = 280.dp)
                        .heightIn(max = 380.dp)
                        .ragentComposerShadow(shape = RoundedCornerShape(20.dp))
                        .onGloballyPositioned { coords ->
                            val pos = coords.positionInRoot()
                            backdropOffset = IntOffset(
                                backdropOrigin.x - pos.x.roundToInt(),
                                backdropOrigin.y - pos.y.roundToInt(),
                            )
                        },
                    shape = RoundedCornerShape(20.dp),
                    surface = AgentoGlassSurface.Tinted(
                        if (isDark) AgentoFrostedTokens.SurfaceLevel2.copy(alpha = 0.92f)
                        else Color.White.copy(alpha = 0.94f),
                    ),
                    blurRadius = AgentoFrostedTokens.BlurNavigation,
                    backdropLayer = backdropLayer,
                    backdropOffset = backdropOffset,
                    showTopHairline = true,
                    material = AgentoGlassMaterial.LiquidRegular,
                    specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                    hasShadow = false,
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(6.dp),
                    ) {
                        CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
                            content()
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun AgentoDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    backdropLayer: GraphicsLayer? = null,
    opaqueFallback: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (backdropLayer != null) {
        AgentoFrostedMenu(
            expanded = expanded,
            onDismissRequest = onDismissRequest,
            modifier = modifier,
            backdropLayer = backdropLayer,
            content = content,
        )
    } else {
        val colors = LocalRagentColors.current
        val isDark = colors.canvas.red < 0.5f
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = onDismissRequest,
            modifier = modifier,
            shape = RoundedCornerShape(18.dp),
            containerColor = Color.Transparent,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
        ) {
            AgentoFrostedGlassBox(
                modifier = Modifier.widthIn(min = 196.dp, max = 320.dp).heightIn(max = 360.dp)
                    .then(if (opaqueFallback) Modifier.background(
                        (if (isDark) colors.quietSurface else colors.surfaceLow).copy(alpha = 1f), RoundedCornerShape(18.dp),
                    ) else Modifier),
                shape = RoundedCornerShape(18.dp),
                surface = AgentoGlassSurface.Tinted(if (isDark) AgentoFrostedTokens.SurfaceLevel2.copy(alpha = 0.96f)
                else AgentoFrostedTokens.LightSurfaceLevel2.copy(alpha = 0.97f)),
                blurRadius = AgentoFrostedTokens.BlurStandard,
                showTopHairline = true,
                material = AgentoGlassMaterial.LiquidRegular,
                hasShadow = true,
                shadowElevation = 18.dp,
                shadowAlpha = if (isDark) 0.26f else 0.12f,
                shadowSpotAlpha = if (isDark) 0.28f else 0.10f,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(4.dp),
                ) {
                    CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
                        content()
                    }
                }
            }
        }
    }
}

@Composable
fun AgentoDropdownMenuItem(
    text: String,
    onClick: () -> Unit,
    leadingIcon: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
    selected: Boolean = false,
    textColor: Color? = null,
    iconColor: Color? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val interactionSource = remember { MutableInteractionSource() }
    val resolvedTextColor = textColor ?: if (selected) colors.accentPrimary else colors.primaryContent
    val resolvedIconColor = iconColor ?: textColor ?: if (selected) colors.accentPrimary else colors.primaryContent
    CompositionLocalProvider(LocalContentColor provides resolvedTextColor) {
        Row(
            modifier = modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = RagentSpacing.TouchTarget)
                .clip(RoundedCornerShape(12.dp))
                .background(
                    if (selected) colors.actionPrimary.copy(alpha = if (colors.canvas.red < 0.5f) 0.25f else 0.11f)
                    else Color.Transparent,
                )
                .alpha(if (enabled) 1f else 0.48f)
                // Keep popup rows in their parent's render node. A separate
                // transformed layer can lose the first row on physical GPUs.
                .clickable(
                    enabled = enabled,
                    interactionSource = interactionSource,
                    indication = null,
                    onClick = onClick,
                )
                .semantics { role = Role.Button }
                .padding(start = 12.dp, end = 10.dp, top = 9.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (leadingIcon != null) {
                CompositionLocalProvider(LocalContentColor provides resolvedIconColor) {
                    Box(modifier = Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                        leadingIcon()
                    }
                }
            }
            Text(
                text = text,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal),
                color = resolvedTextColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (selected) {
                AgentoWebIcon(
                    AgentoWebGlyph.Check,
                    contentDescription = "Selected",
                    modifier = Modifier.size(17.dp),
                    tint = colors.accentPrimary,
                )
            }
        }
    }
}

@Composable
fun AgentoErrorText(text: String, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    // Errors are part of the current content layer, not a raw Material-red
    // footer. Preserve the semantic error tint in a compact standard material
    // so a recoverable failure stays readable without visually taking over the
    // page or competing with navigation controls.
    AgentoFrostedGlassBox(
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        // The material remains neutral; the icon well and its foreground own
        // the semantic error color. This keeps recoverable errors from reading
        // as a stack of pink/red Material cards.
        surface = AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurThin,
        showTopHairline = true,
        material = AgentoGlassMaterial.ContentRegular,
        hasShadow = false,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(colors.error.copy(alpha = if (isDark) 0.26f else 0.13f)),
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Bell,
                    contentDescription = null,
                    modifier = Modifier.size(15.dp),
                    tint = colors.error,
                )
            }
            Text(
                text = text,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodySmall,
                color = colors.primaryContent,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun RagentCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    // Content groups are not floating cards. The compact contour only
    // separates genuine objects (approval, device, setting) from the page.
    Box(
        modifier = modifier
            .clip(AgentoShapes.SurfaceMediumShape)
            .background(colors.surfaceLow)
            .agentoPressScale(pressedScale = 0.985f, onClick = onClick)
            .semantics { if (onClick != null) role = Role.Button },
    ) { content() }
}

@Composable
fun AgentoSurface(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.surface,
    content: @Composable () -> Unit,
) {
    Surface(modifier = modifier, color = color, content = content)
}

@Composable
fun AgentoTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    inputModifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val fieldShape = RoundedCornerShape(14.dp)
    val fieldBg = if (isDark) Color(0xFF242730).copy(alpha = 0.85f) else AgentoFrostedTokens.LightSurfaceLevel2.copy(alpha = 0.85f)

    Box(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = RagentSpacing.TouchTarget)
            .clip(fieldShape)
            .background(fieldBg),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (value.isEmpty()) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary.copy(alpha = 0.72f),
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                keyboardOptions = keyboardOptions,
                keyboardActions = keyboardActions,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.primaryContent),
                cursorBrush = SolidColor(LocalRagentColors.current.accentPrimary),
                modifier = Modifier.fillMaxWidth().then(inputModifier),
            )
        }
    }
}

@Composable
fun AgentoSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val searchShape = RoundedCornerShape(14.dp)
    val searchBg = if (isDark) Color(0xFF242730).copy(alpha = 0.85f) else AgentoFrostedTokens.LightSurfaceLevel2.copy(alpha = 0.85f)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = RagentSpacing.TouchTarget)
            .clip(searchShape)
            .background(searchBg)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        AgentoWebIcon(
            glyph = AgentoWebGlyph.Search,
            contentDescription = null,
            modifier = Modifier.size(RagentSizes.Icon),
            tint = colors.textSecondary.copy(alpha = 0.85f),
        )
        Box(modifier = Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(
                    text = "Search sessions",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary.copy(alpha = 0.72f),
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.primaryContent),
                cursorBrush = SolidColor(LocalRagentColors.current.accentPrimary),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (value.isNotEmpty()) {
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(CircleShape)
                    .background(if (isDark) Color.White.copy(alpha = 0.16f) else Color.Black.copy(alpha = 0.12f))
                    .clickable { onValueChange("") },
                contentAlignment = Alignment.Center,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Close,
                    contentDescription = "Clear",
                    modifier = Modifier.size(12.dp),
                    tint = colors.secondaryContent,
                )
            }
        }
    }
}

@Composable
fun AgentoL1ProjectCard(
    projectName: String,
    projectPath: String,
    sessionCount: Int,
    lastActiveTime: String,
    isAgentActive: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val motionPolicy = LocalMotionPolicy.current
    val alphaAnim: Float
    if (motionPolicy.preference == MotionPreference.Full && !LocalAgentoBackgrounded.current) {
        val infiniteTransition = rememberInfiniteTransition(label = "agent_live_pulse")
        val alpha by infiniteTransition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(1200),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "pulse_alpha",
        )
        alphaAnim = alpha
    } else {
        alphaAnim = 1.0f
    }


    Box(
        modifier = modifier
            .fillMaxWidth()
            .agentoLargeCardShadow(shape = AgentoShapes.SquircleXL)
            .clip(AgentoShapes.SquircleXL)
            .background(Ragentolors.SurfaceLevel1, AgentoShapes.SquircleXL)
            .agentoPressScale(pressedScale = 0.975f, onClick = onClick)
            .padding(18.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            // 1. 项目名称与状态呼吸灯
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Box(
                        modifier = Modifier
                            .size(34.dp)
                            .background(Ragentolors.SurfaceLevel2, AgentoShapes.SquircleIcon),
                        contentAlignment = Alignment.Center,
                    ) {
                        AgentoWebIcon(
                            glyph = AgentoWebGlyph.Folder,
                            contentDescription = null,
                            tint = Ragentolors.TextPrimary,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Text(
                        text = projectName,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Ragentolors.TextPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                if (isAgentActive) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier
                            .background(Ragentolors.SurfaceLevel2, AgentoShapes.SquirclePill)
                            .padding(horizontal = 9.dp, vertical = 4.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(Ragentolors.RunningGlow.copy(alpha = alphaAnim)),
                        )
                        Text(
                            text = "Active",
                            fontSize = 10.5.sp,
                            fontWeight = FontWeight.Bold,
                            color = Ragentolors.RunningGlow,
                            letterSpacing = 0.5.sp,
                        )
                    }
                }
            }

            // 2. 项目路径 (紧凑代码胶囊)
            Box(
                modifier = Modifier
                    .background(Ragentolors.SurfaceLevel2, AgentoShapes.SquircleXS)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            ) {
                Text(
                    text = projectPath,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = Ragentolors.TextSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            // 3. 底部信息行
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "活跃于 $lastActiveTime",
                    fontSize = 12.5.sp,
                    color = Ragentolors.TextTertiary,
                )

                Text(
                    text = "$sessionCount 个会话",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = Ragentolors.TextSecondary,
                )
            }
        }
    }
}

/**
 * Apple iOS Settings-style vibrant squircle badge for setting entries.
 */
@Composable
fun AgentoSettingBadge(
    glyph: AgentoWebGlyph,
    backgroundColor: Color,
    modifier: Modifier = Modifier,
    iconTint: Color = Color.White,
) {
    Box(
        modifier = modifier
            .size(30.dp)
            .clip(RoundedCornerShape(7.5.dp))
            .background(backgroundColor),
        contentAlignment = Alignment.Center,
    ) {
        AgentoWebIcon(
            glyph = glyph,
            contentDescription = null,
            tint = iconTint,
            modifier = Modifier.size(17.dp),
        )
    }
}

@Composable
fun AgentoSettingRow(
    icon: AgentoWebGlyph? = null,
    leadingIcon: (@Composable () -> Unit)? = null,
    title: String,
    subtitle: String? = null,
    showDivider: Boolean = true,
    showChevron: Boolean = true,
    trailing: @Composable (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentHorizontalPadding: Dp = 16.dp,
    onClick: (() -> Unit)? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val dividerBg = if (isDark) AgentoFrostedTokens.SubtleHairline else Color(0x12000000)
    val hasLeadingVisual = leadingIcon != null || icon != null
    Column(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.52f)
            .agentoPressScale(pressedScale = 0.98f, onClick = onClick?.takeIf { enabled }),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = RagentSizes.CardRowHeight)
                .padding(horizontal = contentHorizontalPadding, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (hasLeadingVisual) {
                Box(
                    modifier = Modifier.size(30.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    if (leadingIcon != null) {
                        leadingIcon()
                    } else if (icon != null) {
                        AgentoWebIcon(
                            glyph = icon,
                            contentDescription = null,
                            tint = colors.accentPrimary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = title,
                    fontSize = 16.5.sp,
                    fontWeight = FontWeight.Normal,
                    color = colors.primaryContent,
                )
                if (subtitle != null) {
                    Text(
                        text = subtitle,
                        fontSize = 13.sp,
                        color = colors.secondaryContent,
                    )
                }
            }
            trailing?.invoke() ?: onClick?.takeIf { showChevron }?.let {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.ChevronRight,
                    contentDescription = null,
                    tint = colors.tertiaryContent,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        if (showDivider) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = contentHorizontalPadding + if (hasLeadingVisual) 44.dp else 0.dp,
                        end = contentHorizontalPadding,
                    )
                    .height(0.5.dp)
                    .background(dividerBg),
            )
        }
    }
}

@Composable
fun AgentoTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val contentColor = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent

    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = RagentSizes.TopBar).padding(horizontal = RagentSpacing.Gutter),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(RagentSpacing.Compact),
    ) {
        CompositionLocalProvider(LocalContentColor provides contentColor) {
            navigationIcon?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(RagentSpacing.Grid)) {
                Text(title, style = MaterialTheme.typography.titleLarge, color = contentColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            actions?.invoke(this)
        }
    }
}

@Composable
fun Ragenthip(text: String, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val colors = LocalRagentColors.current
    Box(
        modifier = modifier
            .defaultMinSize(minHeight = RagentSpacing.TouchTarget)
            .clip(AgentoShapes.PillShape)
            .background(colors.surfaceHigh.copy(alpha = 0.82f))
            .agentoPressScale(pressedScale = 0.97f, onClick = onClick)
            .semantics { if (onClick != null) role = Role.Button }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = colors.textPrimary, maxLines = 1)
    }
}

@Composable
fun AgentoBadge(text: String, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    Surface(
        modifier = modifier.defaultMinSize(minHeight = RagentSpacing.TouchTarget),
        shape = AgentoShapes.PillShape,
        color = colors.surfaceHigh,
        contentColor = colors.primaryContent,
    ) { Text(text, modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp), style = MaterialTheme.typography.labelMedium) }
}

@Composable
fun RagentountBadge(
    count: Int,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Surface(
        modifier = modifier,
        shape = AgentoShapes.PillShape,
        color = colors.surfaceHigh,
        contentColor = colors.secondaryContent,
    ) {
        Text(
            text = count.toString(),
            modifier = Modifier.padding(horizontal = RagentSpacing.Compact, vertical = RagentSpacing.Grid),
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
fun AgentoStatusDot(
    tone: AgentoStatusTone,
    contentDescription: String,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val color = when (tone) {
        AgentoStatusTone.Running -> colors.running
        AgentoStatusTone.Waiting, AgentoStatusTone.Warning -> colors.waiting
        AgentoStatusTone.Success -> colors.success
        AgentoStatusTone.Error -> colors.error
        AgentoStatusTone.Neutral -> colors.tertiaryContent
    }
    if (tone == AgentoStatusTone.Running) {
        AgentoBreathingDot(
            color = color,
            size = 8.dp,
            modifier = modifier.semantics { this.contentDescription = contentDescription },
        )
    } else {
        Box(
            modifier
                .size(8.dp)
                .background(color, CircleShape)
                .semantics { this.contentDescription = contentDescription },
        )
    }
}

/**
 * AgentoSwitch: Apple / One UI refined toggle switch.
 *
 * Provides a tactile circular knob (thumb) that is prominent and distinct in both
 * ON and OFF states. Never blends into the background as an empty pill.
 */
@Composable
fun AgentoSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    val trackWidth = 48.dp
    val trackHeight = 28.dp
    val thumbSize = 22.dp
    val horizontalPadding = 3.dp

    val trackColor by animateColorAsState(
        targetValue = if (checked) colors.actionPrimary else if (isDark) Color(0xFF383C46) else Color(0xFFE2E4E9),
        animationSpec = tween(durationMillis = 200),
        label = "switch_track_color",
    )

    val thumbOffset by animateDpAsState(
        targetValue = if (checked) trackWidth - thumbSize - horizontalPadding else horizontalPadding,
        animationSpec = spring(
            dampingRatio = 0.8f,
            stiffness = 500f,
        ),
        label = "switch_thumb_offset",
    )

    Box(
        modifier = modifier
            .size(width = trackWidth, height = trackHeight)
            .clip(CircleShape)
            .background(trackColor)
            .border(
                width = 0.5.dp,
                color = if (checked) Color.Transparent else if (isDark) Color(0x33FFFFFF) else Color(0x18000000),
                shape = CircleShape,
            )
            .then(
                if (onCheckedChange != null && enabled) {
                    Modifier.toggleable(
                        value = checked,
                        role = Role.Switch,
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onValueChange = onCheckedChange,
                    )
                } else Modifier
            )
            .semantics {
                role = Role.Switch
                this[androidx.compose.ui.semantics.SemanticsProperties.ToggleableState] =
                    if (checked) androidx.compose.ui.state.ToggleableState.On else androidx.compose.ui.state.ToggleableState.Off
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .size(thumbSize)
                .shadow(elevation = 2.5.dp, shape = CircleShape)
                .clip(CircleShape)
                .background(if (checked) colors.actionPrimaryContent else Color.White),
        )
    }
}

@Composable
fun AgentoRowSurface(
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val rowModifier = modifier.defaultMinSize(minHeight = AgentoSpacing.MinTouchTarget)
    val rowColor = if (selected) Ragentolors.SurfaceLevel3 else Color.Transparent
    if (onClick == null) {
        Surface(
            modifier = rowModifier,
            shape = RoundedCornerShape(AgentoRadius.M),
            color = rowColor,
            contentColor = colors.primaryContent,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
            content = content,
        )
    } else {
        Surface(
            onClick = onClick,
            enabled = enabled,
            modifier = rowModifier,
            shape = RoundedCornerShape(AgentoRadius.M),
            color = rowColor,
            contentColor = colors.primaryContent,
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
            content = content,
        )
    }
}

@Composable
fun AgentoDivider(modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val dividerColor = if (isDark) Ragentolors.SurfaceLevel2 else Color(0x14000000)
    HorizontalDivider(modifier = modifier, thickness = 0.5.dp, color = dividerColor)
}

@Composable
fun AgentoVerticalDivider(modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val dividerColor = if (isDark) Ragentolors.SurfaceLevel2 else Color(0x14000000)
    VerticalDivider(modifier = modifier, thickness = 0.5.dp, color = dividerColor)
}

@Composable
fun AgentoProgress(progress: Float? = null, modifier: Modifier = Modifier) {
    if (progress == null && LocalMotionPolicy.current.preference != MotionPreference.Full) {
        AgentoWebIcon(AgentoWebGlyph.Clock, contentDescription = "Loading", modifier = modifier.size(24.dp))
    } else if (progress == null) CircularProgressIndicator(modifier = modifier.size(24.dp), strokeWidth = 2.dp)
    else LinearProgressIndicator(progress = { progress.coerceIn(0f, 1f) }, modifier = modifier.fillMaxWidth())
}

@Composable
fun AgentoSkeleton(modifier: Modifier = Modifier, height: Dp = 20.dp) {
    val colors = LocalRagentColors.current
    Box(modifier.height(height).fillMaxWidth().background(colors.surfaceHigh, AgentoShapes.SurfaceSmallShape))
}

@Composable
fun AgentoEmptyState(title: String, body: String, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(RagentSpacing.Section),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(if (isDark) AgentoFrostedTokens.SurfaceLevel1 else AgentoFrostedTokens.LightSurfaceLevel1),
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(AgentoWebGlyph.Agent, contentDescription = null, modifier = Modifier.size(28.dp), tint = colors.accentPrimary)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
            ),
            color = colors.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 14.sp,
                lineHeight = 20.sp,
            ),
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun AgentoErrorState(title: String, body: String, retryLabel: String? = null, onRetry: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(RagentSpacing.Section),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(18.dp))
                .background(colors.error.copy(alpha = if (isDark) 0.16f else 0.10f))
                .border(
                    width = 1.dp,
                    color = colors.error.copy(alpha = 0.35f),
                    shape = RoundedCornerShape(18.dp),
                ),
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(AgentoWebGlyph.Bell, contentDescription = null, modifier = Modifier.size(28.dp), tint = colors.error)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 17.sp,
            ),
            color = colors.textPrimary,
            textAlign = TextAlign.Center,
        )
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontSize = 14.sp,
                lineHeight = 20.sp,
            ),
            color = colors.textSecondary,
            textAlign = TextAlign.Center,
        )
        if (retryLabel != null && onRetry != null) {
            TextButton(onClick = onRetry, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(retryLabel, color = colors.accentPrimary) }
        }
    }
}

enum class AgentoStatusTone { Neutral, Running, Waiting, Success, Warning, Error }

@Composable
fun AgentoStatus(text: String, tone: AgentoStatusTone, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val (container, contentColor, icon) = when (tone) {
        AgentoStatusTone.Running -> Triple(colors.surfaceHigh, colors.running, AgentoWebGlyph.Agent)
        AgentoStatusTone.Waiting -> Triple(colors.surfaceHigh, colors.waiting, AgentoWebGlyph.Bell)
        AgentoStatusTone.Success -> Triple(colors.surfaceHigh, colors.success, AgentoWebGlyph.Check)
        AgentoStatusTone.Warning -> Triple(colors.surfaceHigh, colors.waiting, AgentoWebGlyph.Bell)
        AgentoStatusTone.Error -> Triple(colors.surfaceHigh, colors.error, AgentoWebGlyph.Bell)
        AgentoStatusTone.Neutral -> Triple(colors.surfaceHigh, colors.secondaryContent, AgentoWebGlyph.Info)
    }
    Surface(modifier = modifier, shape = AgentoShapes.PillShape, color = container, contentColor = contentColor) {
        Row(modifier = Modifier.padding(horizontal = RagentSpacing.Compact, vertical = RagentSpacing.Grid), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(RagentSpacing.Grid)) {
            if (tone == AgentoStatusTone.Running) {
                AgentoBreathingDot(color = contentColor, size = 6.dp)
            } else {
                AgentoWebIcon(icon, contentDescription = null, modifier = Modifier.size(RagentSizes.IconSmall), tint = contentColor)
            }
            Text(
                text,
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
fun AgentoSectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(RagentSpacing.Standard),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(RagentSpacing.Grid)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            supportingText?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        trailing?.invoke()
    }
}

@Composable
fun AgentoListItem(
    title: String,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    AgentoRowSurface(selected = selected, onClick = onClick, modifier = modifier.defaultMinSize(minHeight = RagentSpacing.TouchTarget)) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = RagentSpacing.Standard, vertical = RagentSpacing.Compact),
            horizontalArrangement = Arrangement.spacedBy(RagentSpacing.Standard),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(RagentSpacing.Grid)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                supportingText?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            trailing?.invoke()
        }
    }
}

enum class AgentoDialogActionLayout {
    Horizontal,
    PrimaryWithTextDismiss,
    PrimaryOnly,
}

@Composable
fun AgentoDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    onDismissRequest: () -> Unit = onDismiss,
    confirmEnabled: Boolean = true,
    dismissEnabled: Boolean = true,
    dismissLabel: String = "Cancel",
    confirmModifier: Modifier = Modifier,
    icon: (@Composable () -> Unit)? = null,
    confirmLeadingIcon: (@Composable () -> Unit)? = null,
    destructive: Boolean = confirmLabel.equals("delete", ignoreCase = true),
    actionLayout: AgentoDialogActionLayout = AgentoDialogActionLayout.Horizontal,
    backdropLayer: GraphicsLayer? = null,
    backgroundDimAmount: Float? = null,
    opaqueFallback: Boolean = false,
    textureAlpha: Float = 1f,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val pageBackdropOrigin = LocalAgentoPageBackdropOrigin.current
    val localizedContext = androidx.compose.ui.platform.LocalContext.current
    val localizedConfiguration = androidx.compose.ui.platform.LocalConfiguration.current
    var backdropOffset by remember(backdropLayer) { mutableStateOf(IntOffset.Zero) }
    Dialog(
        onDismissRequest = onDismissRequest,
        // Compose can only apply navigation-bar padding when the dialog
        // receives edge-to-edge insets from its own window.
        properties = DialogProperties(
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        AgentoSystemSafeArea {
        // A modal dims the page just enough to establish hierarchy. Its own
        // frosted substrate is the only temporary material treatment.
        AgentoModalBackgroundDim(
            amount = backgroundDimAmount ?: if (colors.canvas.red < 0.5f) 0.20f else 0.16f,
        )

        BoxWithConstraints(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .padding(
                    start = RagentSpacing.Standard,
                    top = RagentSpacing.Grid,
                    end = RagentSpacing.Standard,
                ),
        ) {
            val compact = maxWidth < 600.dp
            // Dialog windows can report a zero navigation inset despite a
            // transparent gesture bar. Keep every compact sheet's actions
            // visibly above that bar, including on edge-to-edge devices.
            val compactBottomSafeArea = if (compact) {
                maxOf(
                    24.dp,
                    remainingAppSystemBars().asPaddingValues().calculateBottomPadding(),
                )
            } else {
                0.dp
            }
            val isDark = colors.canvas.red < 0.5f
            val dialogShape = if (compact) {
                RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp, bottomStart = 0.dp, bottomEnd = 0.dp)
            } else {
                RoundedCornerShape(24.dp)
            }

            AgentoFrostedGlassBox(
                modifier = modifier
                    .align(if (compact) Alignment.BottomCenter else Alignment.Center)
                    .fillMaxWidth()
                    .widthIn(max = 560.dp)
                    // A Dialog uses its own edge-to-edge window. Reserve the
                    // gesture area outside the sheet too, so its primary
                    // action never visually intersects the system handle.
                    .padding(bottom = compactBottomSafeArea)
                    .heightIn(max = maxHeight)
                    // Instructional content must remain readable when the
                    // caller has no sampled backdrop to defocus page text.
                    .then(if (opaqueFallback && backdropLayer == null) Modifier.background(
                        colors.canvas.copy(alpha = 1f), dialogShape,
                    ) else Modifier)
                    .onGloballyPositioned { coordinates ->
                        val position = coordinates.positionInRoot()
                        backdropOffset = IntOffset(
                            x = pageBackdropOrigin.x - position.x.roundToInt(),
                            y = pageBackdropOrigin.y - position.y.roundToInt(),
                        )
                    },
                shape = dialogShape,
                // Use the same neutral glass treatment as the chat capsule.
                surface = AgentoGlassSurface.Neutral,
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                showTopHairline = true,
                backdropLayer = backdropLayer,
                backdropOffset = backdropOffset,
                material = AgentoGlassMaterial.LiquidClear,
                backdropTone = AgentoBackdropTone.QuietHeader,
                specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                hasShadow = false,
                textureAlpha = textureAlpha,
            ) {
                Column(
                    Modifier.padding(
                        start = RagentSpacing.xl,
                        top = if (compact) 12.dp else RagentSpacing.xl,
                        end = RagentSpacing.xl,
                        // Keep the action row clear of transparent gesture bars.
                        // Padding inside the sheet is reliable in Compose Dialogs,
                        // where window insets and visual offsets may be ignored.
                        bottom = RagentSpacing.xl + compactBottomSafeArea,
                    ),
                    verticalArrangement = Arrangement.spacedBy(RagentSpacing.Standard),
                ) {
                    if (compact) {
                        Box(
                            modifier = Modifier
                                .align(Alignment.CenterHorizontally)
                                .size(width = 36.dp, height = 5.dp)
                                .background(
                                    if (isDark) Color.White.copy(alpha = 0.32f) else Color.Black.copy(alpha = 0.20f),
                                    CircleShape,
                                )
                        )
                        Spacer(Modifier.height(4.dp))
                    }
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        icon?.let {
                            Box(
                                modifier = Modifier
                                    .size(42.dp)
                                    .clip(RoundedCornerShape(13.dp))
                                    .background(if (isDark) Color.White.copy(alpha = 0.08f) else Color.Black.copy(alpha = 0.05f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                it()
                            }
                        }
                        Text(
                            title,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.titleLarge.copy(
                                fontWeight = FontWeight.SemiBold,
                                letterSpacing = (-0.3).sp,
                            ),
                            color = colors.primaryContent,
                        )
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .weight(1f, fill = false)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        CompositionLocalProvider(
                            LocalContentColor provides colors.primaryContent,
                            androidx.compose.ui.platform.LocalContext provides localizedContext,
                            androidx.compose.ui.platform.LocalConfiguration provides localizedConfiguration,
                        ) {
                            content()
                        }
                    }
                    when (actionLayout) {
                        AgentoDialogActionLayout.Horizontal -> {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(RagentSpacing.Compact),
                            ) {
                                AgentoButton(
                                    dismissLabel,
                                    onDismiss,
                                    modifier = Modifier.weight(1f),
                                    enabled = dismissEnabled,
                                    decision = true,
                                    secondary = true,
                                    secondaryContainerColor = colors.strongSurface.copy(alpha = 0.78f),
                                )
                                AgentoButton(
                                    confirmLabel,
                                    onConfirm,
                                    modifier = Modifier.weight(1f).then(confirmModifier),
                                    enabled = confirmEnabled,
                                    decision = true,
                                    destructive = destructive,
                                    leadingIcon = confirmLeadingIcon,
                                )
                            }
                        }
                        AgentoDialogActionLayout.PrimaryWithTextDismiss -> {
                            // A recoverable single-path state should not read
                            // like a destructive two-way decision. The compact
                            // primary pill carries the next step while the
                            // dismiss action stays quiet and never competes.
                            Column(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(RagentSpacing.Grid),
                            ) {
                                AgentoButton(
                                    confirmLabel,
                                    onConfirm,
                                    modifier = Modifier.widthIn(min = 168.dp, max = 224.dp).then(confirmModifier),
                                    enabled = confirmEnabled,
                                    decision = true,
                                    destructive = destructive,
                                    leadingIcon = confirmLeadingIcon,
                                )
                                TextButton(
                                    onClick = onDismiss,
                                    enabled = dismissEnabled,
                                    modifier = Modifier.defaultMinSize(minHeight = RagentSpacing.TouchTarget),
                                    colors = ButtonDefaults.textButtonColors(
                                        contentColor = colors.secondaryContent,
                                    ),
                                ) {
                                    Text(
                                        text = dismissLabel,
                                        style = MaterialTheme.typography.bodyMedium.copy(
                                            fontWeight = FontWeight.Medium,
                                        ),
                                    )
                                }
                            }
                        }
                        AgentoDialogActionLayout.PrimaryOnly -> {
                            // Informational states have no competing choice:
                            // a single focused acknowledgement reads as a
                            // lightweight system sheet instead of a decision
                            // dialog.
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.End,
                            ) {
                                AgentoButton(
                                    confirmLabel,
                                    onConfirm,
                                    modifier = Modifier.widthIn(min = 168.dp, max = 224.dp).then(confirmModifier),
                                    enabled = confirmEnabled,
                                    decision = true,
                                    destructive = destructive,
                                    leadingIcon = confirmLeadingIcon,
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
