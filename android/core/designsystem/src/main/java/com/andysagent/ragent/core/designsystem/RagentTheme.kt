package com.andysagent.ragent.core.designsystem

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.RenderEffect
import android.graphics.RuntimeShader
import android.graphics.drawable.ColorDrawable
import android.graphics.Shader
import android.os.Build
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.ShaderBrush
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asComposeRenderEffect
import androidx.compose.ui.graphics.asAndroidColorFilter
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.graphics.layer.drawLayer
import androidx.compose.ui.graphics.rememberGraphicsLayer
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.layout
import android.graphics.Paint as AndroidPaint
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.toIntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

private const val LiquidGlassShaderSource = """
    uniform shader backdrop;
    uniform float2 resolution;
    uniform float tonalAdaptation;

    half4 main(float2 fragCoord) {
        // Multi-layered optical Liquid Glass (Apple HIG / VisionOS)
        float2 uv = fragCoord / resolution;
        float2 centered = uv * 2.0 - 1.0;
        float edgeWeight = smoothstep(0.40, 0.98, max(abs(centered.x), abs(centered.y)));
        float2 outward = normalize(centered + float2(0.0001, 0.0001));
        float refractAmt = 2.4 * edgeWeight * edgeWeight;

        // Apple Vibrancy: Chromatic dispersion along optical meniscus rim
        half4 sampledR = backdrop.eval(fragCoord + outward * (refractAmt * 1.06));
        half4 sampledG = backdrop.eval(fragCoord + outward * refractAmt);
        half4 sampledB = backdrop.eval(fragCoord + outward * (refractAmt * 0.94));
        half4 sampled = half4(sampledR.r, sampledG.g, sampledB.b, sampledG.a);

        // Apple Vibrancy: restore and enrich color saturation through blurred medium
        float luma = dot(float3(sampled.r, sampled.g, sampled.b), float3(0.2126, 0.7152, 0.0722));
        sampled.rgb = mix(half3(luma), sampled.rgb, 1.22);

        // Tonal adaptation: lift deep shadows, gently compress extreme peaks
        float lift = (1.0 - smoothstep(0.04, 0.44, luma)) * tonalAdaptation;
        float damp = smoothstep(0.66, 0.98, luma) * tonalAdaptation * 0.70;
        sampled.rgb = mix(sampled.rgb, half3(1.0), lift);
        sampled.rgb = mix(sampled.rgb, half3(0.0), damp);
        return sampled;
    }
"""

/**
 * The Liquid Glass backdrop is rendered into each control's local offscreen
 * layer before it is blurred and refracted. The supplied [GraphicsLayer] is
 * only a source image; mutating its effect would make sibling glass surfaces
 * race to overwrite each other during a frame.
 */
@androidx.annotation.RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun liquidGlassEffect(
    blurPx: Float,
    widthPx: Float,
    heightPx: Float,
    tonalAdaptation: Float,
): androidx.compose.ui.graphics.RenderEffect? = runCatching {
    val shader = RuntimeShader(LiquidGlassShaderSource).apply {
        setFloatUniform("resolution", widthPx.coerceAtLeast(1f), heightPx.coerceAtLeast(1f))
        setFloatUniform("tonalAdaptation", tonalAdaptation)
    }
    val blurredBackdrop = RenderEffect.createBlurEffect(
        blurPx,
        blurPx,
        Shader.TileMode.CLAMP,
    )
    val refractedBackdrop = RenderEffect.createRuntimeShaderEffect(shader, "backdrop")
    RenderEffect.createChainEffect(refractedBackdrop, blurredBackdrop).asComposeRenderEffect()
}.getOrNull()

/**
 * One UI-inspired material hierarchy. The surface is a soft, high-opacity fog
 * over a locally defocused backdrop; its edge deliberately has no highlight.
 */
enum class AgentoGlassMaterial(
    /** Neutral material substrate; only the background layer receives this wash. */
    val substrateAlphaDark: Float,
    val substrateAlphaLight: Float,
    /** A small luminance stabilizer used only when a live backdrop is available. */
    val backdropVeilDark: Float,
    val backdropVeilLight: Float,
    /** Keeps semantic tints subordinate to the material rather than turning it into a flat card. */
    val semanticTintScale: Float,
) {
    ContentUltraThin(
        substrateAlphaDark = 0.42f,
        substrateAlphaLight = 0.06f,
        backdropVeilDark = 0.03f,
        backdropVeilLight = 0.018f,
        semanticTintScale = 0.62f,
    ),
    ContentRegular(
        substrateAlphaDark = 0.42f,
        substrateAlphaLight = 0.06f,
        backdropVeilDark = 0.03f,
        backdropVeilLight = 0.018f,
        semanticTintScale = 0.62f,
    ),
    ContentThick(
        substrateAlphaDark = 0.42f,
        substrateAlphaLight = 0.08f,
        backdropVeilDark = 0.035f,
        backdropVeilLight = 0.022f,
        semanticTintScale = 0.62f,
    ),
    LiquidRegular(
        substrateAlphaDark = 0.42f,
        substrateAlphaLight = 0.04f,
        backdropVeilDark = 0.03f,
        backdropVeilLight = 0.018f,
        semanticTintScale = 0.62f,
    ),
    LiquidClear(
        substrateAlphaDark = 0.34f,
        substrateAlphaLight = 0.025f,
        backdropVeilDark = 0.025f,
        backdropVeilLight = 0.015f,
        semanticTintScale = 0.62f,
    ),
    /**
     * A temporary form needs to hide competing copy without turning into a
     * pure white Material card. This is a cool, dense One UI-style fog layer;
     * it does not request an activity-wide backdrop blur.
     */
    ModalMilky(
        substrateAlphaDark = 0.46f,
        substrateAlphaLight = 0.40f,
        backdropVeilDark = 0.05f,
        backdropVeilLight = 0.04f,
        semanticTintScale = 0.42f,
    ),
    ;

    internal val isLiquid: Boolean
        get() = this == LiquidRegular || this == LiquidClear
}

// Inter ships as a single variable font (wght 100-900). Register one resource
// entry per used weight so Medium/SemiBold/Bold render as real outlines instead
// of synthetic faux bold. Variable axes apply on API 26+; minSdk is 26.
@OptIn(ExperimentalTextApi::class)
private fun ragentVariableFont(weight: FontWeight): Font = Font(
    resId = R.font.inter_variable,
    weight = weight,
    style = FontStyle.Normal,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

private val RagentUiFont = FontFamily(
    ragentVariableFont(FontWeight(400)),
    ragentVariableFont(FontWeight(450)),
    ragentVariableFont(FontWeight(500)),
    ragentVariableFont(FontWeight(550)),
    ragentVariableFont(FontWeight(600)),
    ragentVariableFont(FontWeight(700)),
)

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private val LightColors = lightColorScheme(
    primary = AgentoFrostedTokens.BrandPrimary,
    onPrimary = AgentoFrostedTokens.OnBrandPrimary,
    primaryContainer = AgentoFrostedTokens.BrandContainerLight,
    onPrimaryContainer = Color(0xFF273769),
    secondary = AgentoFrostedTokens.BrandAccentLight,
    onSecondary = Color.White,
    secondaryContainer = AgentoFrostedTokens.BrandContainerLight,
    onSecondaryContainer = Color(0xFF273769),
    background = Color(0xFFF4F4F7),
    onBackground = Color(0xFF1C1C1E),
    surface = Color(0xFFFFFFFF),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFFFFFFF),
    surfaceContainerHigh = Color(0xFFE8E9F0),
    surfaceContainerHighest = Color(0xFFDEE0E8),
    onSurface = Color(0xFF1C1C1E),
    onSurfaceVariant = Color(0xFF6D6D72),
    outline = Color.Transparent,
    outlineVariant = Color.Transparent,
    error = Color(0xFFFF3B30),
    errorContainer = Color(0xFFFFE5E3),
    onErrorContainer = Color(0xFF8A0900),
)

private val DarkColors = darkColorScheme(
    primary = AgentoFrostedTokens.BrandPrimary,
    onPrimary = AgentoFrostedTokens.OnBrandPrimary,
    primaryContainer = AgentoFrostedTokens.BrandContainerDark,
    onPrimaryContainer = Color(0xFFDDE4FF),
    secondary = AgentoFrostedTokens.BrandAccentDark,
    onSecondary = AgentoFrostedTokens.OnBrandAccentDark,
    secondaryContainer = AgentoFrostedTokens.BrandContainerDark,
    onSecondaryContainer = Color(0xFFDDE4FF),
    background = Color(0xFF000000),
    onBackground = Color(0xFFF5F5F7),
    surface = Color(0xFF1C1C1E),
    surfaceContainerLowest = Color(0xFF000000),
    surfaceContainerLow = Color(0xFF141416),
    surfaceContainer = Color(0xFF1C1C1E),
    surfaceContainerHigh = Color(0xFF2C2C2E),
    surfaceContainerHighest = Color(0xFF3A3A3C),
    onSurface = Color(0xFFF5F5F7),
    onSurfaceVariant = Color.White.copy(alpha = 0.60f),
    outline = Color.Transparent,
    outlineVariant = Color.Transparent,
    error = Color(0xFFFF453A),
    errorContainer = Color(0xFF5A1D1A),
    onErrorContainer = Color(0xFFFFDAD6),
)

private val OledColors = darkColorScheme(
    primary = Color(0xFFFFFFFF).copy(alpha = 0.96f),
    onPrimary = Color.Black,
    primaryContainer = Color.White.copy(alpha = 0.10f),
    onPrimaryContainer = Color.White,
    background = Color(0xFF000000),
    onBackground = Color(0xFFFFFFFF).copy(alpha = 0.96f),
    surface = Color(0xFF000000),
    surfaceContainerLowest = Color(0xFF000000),
    surfaceContainerLow = Color(0xFF0A0A0C),
    surfaceContainer = Color(0xFF0A0A0C),
    surfaceContainerHigh = Color.White.copy(alpha = 0.09f),
    surfaceContainerHighest = Color.White.copy(alpha = 0.14f),
    onSurface = Color(0xFFFFFFFF).copy(alpha = 0.96f),
    onSurfaceVariant = Color(0xFFFFFFFF).copy(alpha = 0.65f),
    outline = Color.Transparent,
    outlineVariant = Color.Transparent,
    error = Color(0xFFF87171),
    errorContainer = Color(0xFF450A0A),
    onErrorContainer = Color(0xFFFECACA),
)

private val AmberColors = darkColorScheme(
    primary = Color(0xFFF59E0B),
    onPrimary = Color(0xFF0D0C0A),
    primaryContainer = Color(0xFF291E0A),
    onPrimaryContainer = Color(0xFFFCD34D),
    background = Color(0xFF0D0C0A),
    onBackground = Color(0xFFFDF6E2),
    surface = Color(0xFF0D0C0A),
    surfaceContainerLowest = Color(0xFF0D0C0A),
    surfaceContainerLow = Color(0xFF181612),
    surfaceContainer = Color(0xFF181612),
    surfaceContainerHigh = Color(0xFF2E2618),
    surfaceContainerHighest = Color(0xFF3D3220),
    onSurface = Color(0xFFFDF6E2),
    onSurfaceVariant = Color(0xFFD4C7A8),
    outline = Color.Transparent,
    outlineVariant = Color.Transparent,
    error = Color(0xFFEF4444),
    errorContainer = Color(0xFF450A0A),
    onErrorContainer = Color(0xFFFECACA),
)

@Immutable
data class RagentColors(
    val canvas: Color,
    val quietSurface: Color,
    val glassSurface: Color,
    val navigationSurface: Color,
    val navigationSelection: Color,
    val strongSurface: Color,
    val subtleOutline: Color,
    val primaryContent: Color,
    val secondaryContent: Color,
    val tertiaryContent: Color,
    val disabledContent: Color,
    val actionPrimary: Color,
    val actionPrimaryContent: Color,
    val floatingControl: Color,
    val floatingControlContent: Color,
    val running: Color,
    val waiting: Color,
    val success: Color,
    val error: Color,
    val surfaceLow: Color = quietSurface,
    val surfaceHigh: Color = strongSurface,
    val surfaceHighest: Color = if (canvas.red < 0.5f) Color(0xFF2A2F3A) else Color(0xFFE2E4E8),
    val glassBackground: Color = glassSurface,
    val glassScrim: Color = if (canvas.red < 0.5f) Color(0x66000000) else Color(0x33000000),
    val textPrimary: Color = primaryContent,
    val textSecondary: Color = secondaryContent,
    val textTertiary: Color = tertiaryContent,
    val iconPrimary: Color = primaryContent,
    val iconSecondary: Color = secondaryContent,
    val accentPrimary: Color = actionPrimary,
    val onAccentPrimary: Color = actionPrimaryContent,
    val stateRunning: Color = running,
    val stateSuccess: Color = success,
    val stateWarning: Color = waiting,
    val stateError: Color = error,
) {
    val surfaceQuiet: Color get() = quietSurface
    val surfaceStrong: Color get() = strongSurface
    val lineSubtle: Color get() = subtleOutline
    val statusRunning: Color get() = running
    val statusWaiting: Color get() = waiting
    val statusSuccess: Color get() = success
    val statusError: Color get() = error
    val actionDestructive: Color get() = if (canvas.red < 0.5f) {
        AgentoFrostedTokens.DestructiveActionDark
    } else {
        AgentoFrostedTokens.DestructiveActionLight
    }
}

private val LightRagentColors = RagentColors(
    // The page is one quiet, neutral content plane. A cool blue wash across
    // the entire screen made the dock and every empty state read as Material
    // navigation chrome rather than a control layer above the content.
    canvas = Color(0xFFF4F4F7),
    quietSurface = Color(0xFFFFFFFF),
    // Glass belongs to foreground controls, never to content lists. Keep it
    // neutral so the brand color identifies the active action instead of
    // tinting the entire navigation system blue.
    glassSurface = Color(0xCFFFFFFF),
    // The dock is a translucent cool-neutral material, not a white container.
    // Its page sample is blurred underneath; this tint keeps that depth legible
    // when the page below happens to be visually quiet.
    navigationSurface = Color(0xCCE8ECF2),
    navigationSelection = AgentoFrostedTokens.LightLensGlassColor,
    strongSurface = Color(0xFFECECF0),
    subtleOutline = Color(0x173C3C43),
    primaryContent = Color(0xFF1C1C1E),
    secondaryContent = Color(0xFF6D6D72),
    tertiaryContent = Color(0xFF8E8E93),
    disabledContent = Color(0xFFAEAEB2),
    actionPrimary = AgentoFrostedTokens.BrandPrimary,
    actionPrimaryContent = AgentoFrostedTokens.OnBrandPrimary,
    floatingControl = Color(0xE6FFFFFF),
    floatingControlContent = Color(0xFF1C1C1E),
    running = AgentoFrostedTokens.AppleGreenLight,
    waiting = AgentoFrostedTokens.AppleOrangeLight,
    success = AgentoFrostedTokens.AppleGreenLight,
    error = AgentoFrostedTokens.AppleRedLight,
    surfaceLow = Color(0xFFFFFFFF),
    surfaceHigh = Color(0xFFE9EBF1),
    surfaceHighest = Color(0xFFDFE2EA),
    glassBackground = Color(0xE6FFFFFF),
    glassScrim = Color(0x33000000),
    textPrimary = Color(0xFF1C1C1E),
    textSecondary = Color(0xFF6D6D72),
    textTertiary = Color(0xFF8E8E93),
    iconPrimary = Color(0xFF1C1C1E),
    iconSecondary = Color(0xFF6D6D72),
    accentPrimary = AgentoFrostedTokens.BrandAccentLight,
    onAccentPrimary = Color.White,
    stateRunning = AgentoFrostedTokens.AppleGreenLight,
    stateSuccess = AgentoFrostedTokens.AppleGreenLight,
    stateWarning = AgentoFrostedTokens.AppleOrangeLight,
    stateError = AgentoFrostedTokens.AppleRedLight,
)

private val DarkRagentColors = RagentColors(
    canvas = Color(0xFF000000),
    quietSurface = Color(0xFF1C1C1E),
    glassSurface = Color(0xFF1C1C1E).copy(alpha = 0.82f),
    navigationSurface = Color(0xCC181B22),
    navigationSelection = AgentoFrostedTokens.DarkLensGlassColor,
    strongSurface = Color(0xFF2C2C2E),
    subtleOutline = Color.White.copy(alpha = 0.12f),
    primaryContent = Color(0xFFF5F5F7),
    secondaryContent = Color.White.copy(alpha = 0.60f),
    tertiaryContent = Color.White.copy(alpha = 0.35f),
    disabledContent = Color.White.copy(alpha = 0.22f),
    actionPrimary = AgentoFrostedTokens.BrandPrimary,
    actionPrimaryContent = AgentoFrostedTokens.OnBrandPrimary,
    floatingControl = Color(0xFF2C2C2E),
    floatingControlContent = Color(0xFFF5F5F7),
    running = AgentoFrostedTokens.AppleGreenDark,
    waiting = AgentoFrostedTokens.AppleOrangeDark,
    success = AgentoFrostedTokens.AppleGreenDark,
    error = AgentoFrostedTokens.AppleRedDark,
    surfaceLow = Color(0xFF141416),
    surfaceHigh = Color(0xFF1C1C1E),
    surfaceHighest = Color(0xFF2C2C2E),
    glassBackground = Color(0xFF1C1C1E).copy(alpha = 0.85f),
    glassScrim = Color(0x66000000),
    textPrimary = Color(0xFFF5F5F7),
    textSecondary = Color.White.copy(alpha = 0.60f),
    textTertiary = Color.White.copy(alpha = 0.35f),
    iconPrimary = Color(0xFFF5F5F7),
    iconSecondary = Color.White.copy(alpha = 0.60f),
    accentPrimary = AgentoFrostedTokens.BrandAccentDark,
    onAccentPrimary = AgentoFrostedTokens.OnBrandAccentDark,
    stateRunning = AgentoFrostedTokens.AppleGreenDark,
    stateSuccess = AgentoFrostedTokens.AppleGreenDark,
    stateWarning = AgentoFrostedTokens.AppleOrangeDark,
    stateError = AgentoFrostedTokens.AppleRedDark,
)

private val OledRagentColors = DarkRagentColors.copy(
    canvas = Color(0xFF000000),
    quietSurface = Color(0xFF0A0A0C),
    glassSurface = Color(0xFF0A0A0C).copy(alpha = 0.85f),
    navigationSurface = Color(0xFF0A0A0C).copy(alpha = 0.92f),
    surfaceLow = Color.White.copy(alpha = 0.04f),
    surfaceHigh = Color.White.copy(alpha = 0.08f),
    surfaceHighest = Color.White.copy(alpha = 0.12f),
    actionPrimary = OledColors.primary,
    actionPrimaryContent = OledColors.onPrimary,
    accentPrimary = OledColors.primary,
    onAccentPrimary = OledColors.onPrimary,
    floatingControl = Color(0xFF141418),
)

private val AmberRagentColors = RagentColors(
    canvas = Color(0xFF0D0C0A),
    quietSurface = Color(0xFF181612),
    glassSurface = Color(0xFF181612).copy(alpha = 0.85f),
    navigationSurface = Color(0xFF1E1A14).copy(alpha = 0.90f),
    navigationSelection = Color(0xFFF59E0B).copy(alpha = 0.18f),
    strongSurface = Color(0xFF2E2618),
    subtleOutline = Color.Transparent,
    primaryContent = Color(0xFFFDF6E2),
    secondaryContent = Color(0xFFD4C7A8),
    tertiaryContent = Color(0xFF9E927A),
    disabledContent = Color(0xFF6B6252),
    actionPrimary = Color(0xFFF59E0B),
    actionPrimaryContent = Color(0xFF0D0C0A),
    floatingControl = Color(0xFF241F16),
    floatingControlContent = Color(0xFFFDF6E2),
    running = Color(0xFFFBBF24),
    waiting = Color(0xFFF59E0B),
    success = Color(0xFF34D399),
    error = Color(0xFFEF4444),
    surfaceLow = Color(0xFF181612),
    surfaceHigh = Color(0xFF2E2618),
    surfaceHighest = Color(0xFF3D3220),
    glassBackground = Color(0xFF181612).copy(alpha = 0.85f),
    glassScrim = Color(0x77000000),
    textPrimary = Color(0xFFFDF6E2),
    textSecondary = Color(0xFFD4C7A8),
    textTertiary = Color(0xFF9E927A),
    iconPrimary = Color(0xFFFDF6E2),
    iconSecondary = Color(0xFFD4C7A8),
    accentPrimary = Color(0xFFF59E0B),
    onAccentPrimary = Color(0xFF0D0C0A),
    stateRunning = Color(0xFFFBBF24),
    stateSuccess = Color(0xFF34D399),
    stateWarning = Color(0xFFF59E0B),
    stateError = Color(0xFFEF4444),
)

/**
 * Maps Android's Monet roles into the app-specific surface vocabulary.
 * Workflow colors intentionally come from the stable semantic palette above.
 */
private fun dynamicRagentColors(
    scheme: ColorScheme,
    semanticColors: RagentColors,
): RagentColors {
    val isDark = semanticColors.canvas.red < 0.5f
    val lightCanvas = Color(0xFFFEFEFE)
    val lightSurface = Color.White
    val lightSurfaceHigh = Color(0xFFF7F7F8)
    val lightSurfaceHighest = Color(0xFFF1F1F3)

    return semanticColors.copy(
        // Monet continues to provide the accent and semantic colors, while the
        // light chat surface stays neutral instead of inheriting wallpaper tint.
        canvas = if (isDark) scheme.background else lightCanvas,
        quietSurface = if (isDark) scheme.surface else lightSurface,
        glassSurface = if (isDark) scheme.surface.copy(alpha = 0.78f) else lightSurface.copy(alpha = 0.78f),
        // Keep the navigation material translucent even in dynamic color mode.
        // Mapping this to an opaque Monet surface hid the captured page and
        // reduced the dock to a conventional Material container.
        navigationSurface = if (isDark) {
            scheme.surfaceContainerHigh.copy(alpha = 0.78f)
        } else {
            scheme.surfaceContainerHigh.copy(alpha = 0.62f)
        },
        navigationSelection = if (isDark) AgentoFrostedTokens.DarkLensGlassColor else AgentoFrostedTokens.LightLensGlassColor,
        strongSurface = if (isDark) scheme.surfaceContainerHigh else lightSurfaceHigh,
        subtleOutline = scheme.outlineVariant,
        primaryContent = scheme.onSurface,
        secondaryContent = scheme.onSurfaceVariant,
        tertiaryContent = scheme.outline,
        disabledContent = scheme.onSurface.copy(alpha = 0.38f),
        actionPrimary = scheme.primary,
        actionPrimaryContent = scheme.onPrimary,
        floatingControl = scheme.surfaceContainerHighest,
        floatingControlContent = scheme.onSurface,
        surfaceLow = if (isDark) scheme.surfaceContainerLow else lightSurface,
        surfaceHigh = if (isDark) scheme.surfaceContainerHigh else lightSurfaceHigh,
        surfaceHighest = if (isDark) scheme.surfaceContainerHighest else lightSurfaceHighest,
        glassBackground = if (isDark) scheme.surface.copy(alpha = 0.85f) else lightSurface.copy(alpha = 0.85f),
        glassScrim = if (isDark) Color(0x66000000) else Color(0x33000000),
        textPrimary = scheme.onSurface,
        textSecondary = scheme.onSurfaceVariant,
        textTertiary = scheme.outline,
        iconPrimary = scheme.onSurface,
        iconSecondary = scheme.onSurfaceVariant,
        accentPrimary = scheme.secondary,
        onAccentPrimary = scheme.onSecondary,
    )
}

val LocalRagentColors = staticCompositionLocalOf { LightRagentColors }

/**
 * Version of the captured canvas, read only by the sampling draw phase.
 * Passing the state holder avoids recomposing the chat and every glass
 * control whenever scrolling invalidates a sibling sampling RenderNode.
 */
val LocalAgentoBackdropRevision = compositionLocalOf<androidx.compose.runtime.State<Int>> {
    androidx.compose.runtime.mutableIntStateOf(0)
}

@Immutable
data class RagentExtendedColors(
    val success: Color,
    val onSuccess: Color,
    val successContainer: Color,
    val onSuccessContainer: Color,
    val warning: Color,
    val onWarning: Color,
    val warningContainer: Color,
    val onWarningContainer: Color,
    val running: Color,
    val runningContainer: Color,
    val onRunningContainer: Color,
    val waiting: Color,
    val needsAction: Color,
)

private val LightExtended = RagentExtendedColors(
    success = Color(0xFF2F6B3C),
    onSuccess = Color.White,
    successContainer = Color(0xFFC9E1CD),
    onSuccessContainer = Color(0xFF14361A),
    warning = Color(0xFF805600),
    onWarning = Color.White,
    warningContainer = Color(0xFFFFDEA6),
    onWarningContainer = Color(0xFF291800),
    running = Color(0xFF2563EB),
    runningContainer = Color(0xFFDBEAFE),
    onRunningContainer = Color(0xFF1E3A8A),
    waiting = Color(0xFFD97706),
    needsAction = Color(0xFFDC2626),
)

private val DarkExtended = RagentExtendedColors(
    success = Color(0xFF34D399),
    onSuccess = Color(0xFF00390C),
    successContainer = Color(0xFF1B4125),
    onSuccessContainer = Color(0xFFC8E9CB),
    warning = Color(0xFFFBBF24),
    onWarning = Color(0xFF432C00),
    warningContainer = Color(0xFF5C4100),
    onWarningContainer = Color(0xFFFFDEA6),
    running = Color(0xFF60A5FA),
    runningContainer = Color(0xFF172554),
    onRunningContainer = Color(0xFFBFDBFE),
    waiting = Color(0xFFFBBF24),
    needsAction = Color(0xFFF87171),
)

val LocalRagentExtendedColors = staticCompositionLocalOf { LightExtended }

object Ragentolors {
    // 1. 画布与基础底色
    val CanvasDark = Color(0xFF0A0A0C)           // 纯黑微暖暗色底色
    val CanvasDarkElevated = Color(0xFF121216)   // 浮层/弹窗底层基底
    val Background = CanvasDark                  // 主画布底色别名
    val SurfaceDark = CanvasDarkElevated         // 顶级浮层底色别名
    
    // 2. 几何表面层级 (Alpha Scale - 绝对禁止使用 border 区分卡片)
    val SurfaceLevel1 = Color.White.copy(alpha = 0.04f)  // 卡片/分组/用户气泡底色
    val SurfaceLevel2 = Color.White.copy(alpha = 0.08f)  // 次级容器/图标基底/输入框内衬
    val SurfaceLevel3 = Color.White.copy(alpha = 0.12f)  // 悬浮条目/按压高亮态
    val SurfaceLevel4 = Color.White.copy(alpha = 0.18f)  // 强强调容器/高亮胶囊
    val SurfaceHighlight = SurfaceLevel4

    // 3. 磨砂玻璃专属表面色
    val GlassBackground = Color(0xFF121216).copy(alpha = 0.72f)
    val GlassHighlightTop = Color.White.copy(alpha = 0.10f) // 顶部 0.5dp 物理微光高光
    val GlassHighlightBottom = Color.Transparent
    val TopSheen = GlassHighlightTop

    // 4. 文字与排版层级
    val TextPrimary = Color(0xFFFFFFFF).copy(alpha = 0.94f)   // 主文本 (标题/正文)
    val TextSecondary = Color(0xFFFFFFFF).copy(alpha = 0.62f) // 次要信息/副标题/时间戳
    val TextTertiary = Color(0xFFFFFFFF).copy(alpha = 0.38f)  // 提示符/占位符/禁用态
    val TextCode = Color(0xFFE2E8F0)                          // 等宽代码主文字

    // 5. 强调与状态语义色 (克制纯正，拒绝荧光渐变)
    val Accent = Color(0xFFFFFFFF)               // 默认极简纯白
    val AccentPrimary = AgentoFrostedTokens.BrandAccentDark // Legacy dark-surface artwork
    val Primary = AgentoFrostedTokens.BrandPrimary
    val Success = Color(0xFF438661)              // 成功/完成/在线
    val Warning = Color(0xFFB77B24)              // 审批/等待/警告
    val Error = Color(0xFFC45A52)                // 失败/错误
    val RunningGlow = Color(0xFF3151B3)           // Existing status glow, independent of brand actions

    // 6. 代码暗盒专属底色
    val CodeBlockBackground = Color(0xFF0D0D11)
    val CodeHeaderBackground = Color(0xFF16161C)
}

object AgentoRadius {
    val XS = 6.dp   // 微型标签、角标
    val S = 10.dp   // 小图标背景、单行输入框内嵌元素
    val M = 12.dp   // 次级容器与工具卡片
    val L = 16.dp   // 独立卡片与对话框；避免过度玩具化
    val Pill = 26.dp// 底部输入框 (Composer)、Floating Dock (完全半圆胶囊)
}

object AgentoSpacing {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val base = 16.dp
    val lg = 20.dp
    val xl = 24.dp
    val xxl = 32.dp
    val huge = 48.dp

    val Grid = 4.dp
    val Micro: Dp = 4.dp             // 极小间距（如 Inline Code 内边距、徽标内联）
    val Compact: Dp = 8.dp           // 紧凑间距（如 图标与文本距离、列表项垂直间距）
    val Element: Dp = 12.dp          // 元素级间距（如 标题与下方正文）
    val Standard: Dp = 12.dp
    val Gutter: Dp = 16.dp
    val Paragraph: Dp = 18.dp        // 段落间距（如 Markdown 段落与段落）
    val Block: Dp = 16.dp            // 同一对话轮次内的基础间距；Markdown 自己管理语义间距。
    val Section: Dp = 24.dp
    val TimelineEvent: Dp = 32.dp    // 事件级大间距（如 User 消息与下一条 Agent 事件）
    val Panel: Dp = 32.dp
    val Screen: Dp = 48.dp
    val TouchTarget: Dp = 48.dp
    val MinTouchTarget: Dp = 48.dp
    val DecisionTarget: Dp = 52.dp

    // 页面安全外边距
    val ScreenHorizontal: Dp = 16.dp
    val ItemGap: Dp = 12.dp
    val SectionGap: Dp = 24.dp

    // OneUI 顶部大标题呼吸留白
    val HeaderCollapsedHeight: Dp = 56.dp
    val HeaderExpandedHeight: Dp = 132.dp

    val ConversationGutter: Dp = 20.dp // 留出阅读宽度，仍保留触控与系统边缘的安全距离。
    val ComposerMargin: Dp = 16.dp     // Composer 左右悬浮边距
}

val RagentSpacing = AgentoSpacing

object RagentSizes {
    val IconSmall = 16.dp
    val Icon = 20.dp
    val IconLarge = 24.dp
    val Avatar = 32.dp
    val TopBar = 64.dp
    val CompactTopBar = 56.dp
    val DeviceSelector = 44.dp
    val ProjectsHeader = 44.dp
    val SessionRow = 40.dp
    val BottomActionBar = 52.dp
    val ActionDock = 52.dp
    val ActionDockButton = 52.dp
    val ComposerButton = 48.dp
    val ComposerAction = 44.dp
    val ComposerSend = 40.dp
    val ComposerMinHeight = 52.dp
    val ComposerMaxHeight = 160.dp
    val ComposerTextMinHeight = 44.dp
    // The idle composer is intentionally narrower than its expanded writing
    // surface. Reuse this exact fraction for compact floating controls that
    // should align with its silhouette.
    const val CollapsedComposerWidthFraction = 0.86f
    // A stable 56dp collapsed rail gives attachment, typing, and send equal
    // tap targets without letting the composer visually outweigh the chat.
    val ComposerActionsHeight = 56.dp
    // A compact 56dp glass rail leaves visual space around the selected
    // 46dp capsule, so navigation reads as a control layer rather than a
    // persistent Material bottom bar.
    val BottomNavigation = 56.dp
    val BottomNavigationSelection = 48.dp
    val BottomNavigationClearance = 98.dp
    val BottomNavigationBackdrop = 120.dp
    val ChatEdgeFade = 88.dp
    // Compact reference canvas used as the fixed phone shell on Expanded
    // windows. The remaining width belongs to the list/detail surface.
    val PhoneShell = 360.dp
    val ContentMaxWidth = 600.dp
    // Standard One UI card row height (56dp)
    val CardRowHeight = 56.dp
    val DetailMaxWidth = 920.dp
}

object RagentonversationTypography {
    // Chat is read as a continuous conversation, not as a dense document.
    // Markdown uses a balanced 15.5sp / 25sp reading rhythm across CJK and Latin with clear hierarchy.
    private val MarkdownPlatformStyle = PlatformTextStyle(includeFontPadding = false)

    // Reading weight for message bodies. Picked from the 400/450/500 on-device
    // screenshot baseline recorded in docs/markdown-rendering-contract.md: 450
    // keeps CJK strokes solid next to Inter without making long Latin
    // paragraphs feel heavy. Bold contrast stays at 700.
    val MessageBodyWeight = FontWeight(450)

    val Body = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = MessageBodyWeight,
        fontSize = 15.5.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val BodyStrong = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Bold,
        fontSize = 15.5.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading1 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 30.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading2 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Bold,
        fontSize = 19.sp,
        lineHeight = 26.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading3 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading4 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.5.sp,
        lineHeight = 23.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading5 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.5.sp,
        lineHeight = 21.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Heading6 = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Code = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val InlineCode = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 13.5.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Blockquote = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = MessageBodyWeight,
        fontSize = 15.sp,
        lineHeight = 23.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val ListItem = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = MessageBodyWeight,
        fontSize = 15.5.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Link = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Medium,
        fontSize = 15.5.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val TableHeader = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight(600),
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val TableCell = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = MessageBodyWeight,
        fontSize = 13.5.sp,
        lineHeight = 19.sp,
        letterSpacing = 0.sp,
        platformStyle = MarkdownPlatformStyle,
    )

    val Meta = TextStyle(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight(550),
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
    )
}

object AgentoShapes {
    // One UI keeps controls compact but gives milky content surfaces a broad,
    // continuous radius. Full pills remain reserved for compact controls.
    val Small = 6.dp
    val SquircleXS = RoundedCornerShape(6.dp)

    val Medium = 10.dp
    val SquircleS = RoundedCornerShape(8.dp)
    val SquircleM = RoundedCornerShape(10.dp)
    val SurfaceSmall = RoundedCornerShape(10.dp)
    val SurfaceSmallShape = RoundedCornerShape(10.dp)
    val SurfaceMedium = RoundedCornerShape(10.dp)
    val SurfaceMediumShape = RoundedCornerShape(10.dp)
    val SquircleIcon = RoundedCornerShape(10.dp)

    val Large = 26.dp
    val SquircleL = RoundedCornerShape(26.dp)
    val SquircleXL = RoundedCornerShape(26.dp)
    val CardLarge = RoundedCornerShape(26.dp)
    val SurfaceLarge = 26.dp
    val SurfaceLargeShape = RoundedCornerShape(26.dp)
    val UserBubble = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp)
    val AgentBubble = RoundedCornerShape(topStart = 4.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 20.dp)
    val AssistantBubble = RoundedCornerShape(20.dp)

    // Pill
    val Pill = RoundedCornerShape(999.dp)
    val PillShape = RoundedCornerShape(999.dp)
    val SquirclePill = RoundedCornerShape(percent = 50)

    val BottomSheet = 20.dp
    val BottomSheetShape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 0.dp, bottomEnd = 0.dp)

    val ExtraSmall = 6.dp
    val Code = 12.dp
    val Tool = 12.dp
    val Control = 12.dp
    val Selector = 12.dp
    val Row = 12.dp
    val Bubble = 18.dp
    val Approval = 20.dp
    val Card = 20.dp
    val Composer = 20.dp
    val Sheet = 24.dp
}

val RagentShapes = AgentoShapes

object AgentoSurfaces {
    val Level0: Color @Composable get() = if (LocalRagentColors.current.canvas.red < 0.5f) AgentoFrostedTokens.Background else LocalRagentColors.current.canvas
    val Level1: Color @Composable get() = if (LocalRagentColors.current.canvas.red < 0.5f) AgentoFrostedTokens.SurfaceLevel1 else LocalRagentColors.current.surfaceLow
    val Level2: Color @Composable get() = if (LocalRagentColors.current.canvas.red < 0.5f) AgentoFrostedTokens.SurfaceLevel2 else LocalRagentColors.current.surfaceHigh
    val Level3: Color @Composable get() = if (LocalRagentColors.current.canvas.red < 0.5f) AgentoFrostedTokens.SurfaceLevel3 else LocalRagentColors.current.strongSurface
}

object AgentoTypography {
    val displayLarge = TextStyle(fontFamily = RagentUiFont, fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold)
    val titleLarge = TextStyle(fontFamily = RagentUiFont, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold)
    val titleMedium = TextStyle(fontFamily = RagentUiFont, fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Medium)
    val bodyLarge = TextStyle(fontFamily = RagentUiFont, fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Normal)
    val bodyMedium = TextStyle(fontFamily = RagentUiFont, fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal)
    val labelLarge = TextStyle(fontFamily = RagentUiFont, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold)
    val labelSmall = TextStyle(fontFamily = RagentUiFont, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium)
    val codeSmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace)
}

/**
 * 苹果级物理磨砂玻璃修饰符 — 背景层专用
 *
 * ⚠️  此 modifier 只能用于**纯背景层**（内容层单独叠放在上方）。
 * 如果把它直接用在内容容器上，文字/图标会被 renderEffect blur 模糊。
 *
 * 正确用法：使用 [AgentoFrostedGlassBox] 代替直接调用此 modifier，
 * 它会自动把 blur 层与内容层分离，保证文字清晰。
 *
 * 1. API 31+ 启用硬件 RenderEffect backdrop-style 实时模糊（仅对背景层自身生效）
 * 2. 纯粹磨砂 4 级 Alpha 色阶底层，确保滚动内容透出但正文清晰
 * 3. Deliberately no default perimeter highlight; glass is defined by tone
 *    and shadow instead of a bright outline.
 */
fun Modifier.agentoFrostedGlassBackground(
    shape: androidx.compose.ui.graphics.Shape = AgentoShapes.SurfaceMediumShape,
    backgroundColor: Color = AgentoFrostedTokens.SurfaceLevel1,
    blurRadius: Dp = AgentoFrostedTokens.BlurStandard,
    showTopHairline: Boolean = false,
): Modifier = this
    .graphicsLayer {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val blurPx = blurRadius.toPx()
            if (blurPx > 0f) {
                renderEffect = RenderEffect
                    .createBlurEffect(
                        blurPx,
                        blurPx,
                        Shader.TileMode.CLAMP,
                    )
                    .asComposeRenderEffect()
            }
        }
        this.shape = shape
        clip = true
    }
    .background(backgroundColor, shape)
    .drawWithCache {
        val outline = shape.createOutline(size, layoutDirection, this)
        val isDark = backgroundColor.red < 0.5f
        val noiseBrush = AgentoFrostedNoise.getBrush(isDark)
        val boundaryBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight
        val hairlineStrokeWidth = 0.65.dp.toPx()
        onDrawBehind {
            drawOutline(outline = outline, brush = noiseBrush)
            if (showTopHairline) {
                drawOutline(outline = outline, brush = boundaryBrush, style = Stroke(width = hairlineStrokeWidth))
            }
        }
    }

/**
 * Offscreen sampling of the live conversation canvas. The draw-phase version
 * invalidates this leaf when its recorded source changes; foreground content
 * is rendered outside this sampling layer so controls remain sharp.
 */
@Composable
@androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
private fun AgentoBackdropDefocus(
    backdropLayer: GraphicsLayer,
    backdropOffset: IntOffset,
    backdropOffsetProvider: (() -> IntOffset)?,
    revision: androidx.compose.runtime.State<Int>,
    profile: AgentoDefocusProfile,
    tone: AgentoBackdropTone,
    canvas: Color,
    frostTint: Color,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    // The scale-only pyramid looked like a blur in code, but on this HWUI
    // path a drawLayer child may keep its original raster and leak readable
    // glyphs. Blur the isolated source RenderNode directly instead. This is
    // deliberately very broad for the large navigation/composer material;
    // it leaves only colour masses, never character strokes.
    val blurDp = when {
        profile.stages.size >= 6 -> 72.dp
        profile.stages.size >= 5 -> 52.dp
        else -> 32.dp
    }
    // Filtering a pill-sized crop with CLAMP stretches its first/last text
    // rows across the blur kernel. Sample neighbours BEFORE filtering, then
    // let the glass shell clip the result. The blur radius itself is unchanged.
    val overscan = with(density) { (blurDp * 2).roundToPx() }
    val motionResponse = LocalAgentoBackdropMotionResponse.current
    val blur = remember(blurDp, density) {
        RenderEffect.createBlurEffect(
            with(density) { blurDp.toPx() },
            with(density) { blurDp.toPx() },
            Shader.TileMode.CLAMP,
        )
    }
    Box(modifier.layout { measurable, constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val placeable = measurable.measure(Constraints.fixed(width + overscan * 2, height + overscan * 2))
        layout(width, height) { placeable.place(-overscan, -overscan) }
    }.graphicsLayer {
        // Observe only in the layer: scroll damping must not recompose the
        // foreground or change grain, saturation, blur, or surface opacity.
        val colourMatrix = android.graphics.ColorMatrix(agentoBackdropColourMatrix(
            saturation = profile.saturation,
            frostWhiteness = profile.frostWhiteness,
            tone = tone,
            canvas = canvas,
            frostTint = frostTint,
            motionResponse = motionResponse.value,
        ))
        val tint = RenderEffect.createColorFilterEffect(
            android.graphics.ColorMatrixColorFilter(colourMatrix),
        )
        compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen
        renderEffect = RenderEffect.createChainEffect(tint, blur).asComposeRenderEffect()
    }) {
        Box(
            Modifier
                .fillMaxSize()
                .drawWithContent {
                    // The revision read keeps this leaf in lockstep with
                    // the freshly-recorded chat canvas.
                    if (revision.value >= 0) {
                        val offset = backdropOffsetProvider?.invoke() ?: backdropOffset
                        translate(
                            left = offset.x.toFloat() + overscan,
                            top = offset.y.toFloat() + overscan,
                        ) {
                            drawLayer(backdropLayer)
                        }
                    }
                }
        )
    }
}

/** The downsampling pyramid selected for each weight of frosted surface. */
private data class AgentoDefocusProfile(
    val stages: List<Float>,
    val saturation: Float,
    /** Mixes the fully opaque blurred snapshot toward a milky surface. */
    val frostWhiteness: Float,
) {
    val inverseScale: Float
        get() = 1f / stages.fold(1f) { accumulated, scale -> accumulated * scale }
}

private fun agentoDefocusProfileFor(blurRadius: Dp): AgentoDefocusProfile = when {
    // Compact circular controls can retain a hint of local context, but still
    // need enough breakup to prevent a tiny, high-contrast glyph from reading.
    blurRadius <= AgentoFrostedTokens.BlurThin -> AgentoDefocusProfile(
        stages = listOf(0.5f, 0.5f, 0.5f, 0.5f),
        saturation = 0.82f,
        frostWhiteness = 0.38f,
    )
    // Header/title pills can sit over multi-line transcript. Keep only broad
    // tonal context; individual glyph strokes must not survive.
    blurRadius <= AgentoFrostedTokens.BlurStandard -> AgentoDefocusProfile(
        stages = listOf(0.5f, 0.5f, 0.5f, 0.5f, 0.5f),
        saturation = 0.70f,
        frostWhiteness = 0.44f,
    )
    // Composer, approval cards, and expanded islands use a deliberately very
    // broad defocus. One UI-style large frosted panes merge an entire word or
    // short line into a tonal island; an individual Chinese glyph must not
    // remain as a recognisable silhouette. Six 0.5 stages produce a live
    // 1/64 sample before it is stretched back to the pane. The deliberately
    // huge defocus is non-negotiable here; transparency comes from retaining
    // this sample's broad colour fields, not by reducing blur.
    else -> AgentoDefocusProfile(
        stages = listOf(0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f),
        // Do not hide the blurred snapshot under a solid white wash. The
        // 1/64 sample has already removed glyph-scale information; retaining
        // its low-frequency colour is what makes the surface read as glass.
        saturation = 0.72f,
        frostWhiteness = 0.51f,
    )
}

@Composable
private fun AgentoDefocusStages(
    stages: List<Float>,
    stageIndex: Int = 0,
    content: @Composable () -> Unit,
) {
    val scale = stages.getOrNull(stageIndex)
    if (scale == null) {
        content()
    } else {
        agentoDefocusStage(scale) {
            AgentoDefocusStages(
                stages = stages,
                stageIndex = stageIndex + 1,
                content = content,
            )
        }
    }
}

/**
 * One offscreen RenderNode that draws its content scaled by [scale] from the
 * top-left corner. Chaining these builds the defocus pyramid out of the same
 * plain UI-layer nodes every scale animation uses.
 */
@Composable
private fun agentoDefocusStage(
    scale: Float,
    content: @Composable () -> Unit,
) {
    androidx.compose.foundation.layout.Box(
        Modifier
            .fillMaxSize()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                transformOrigin = TransformOrigin(0f, 0f)
                compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen
            },
    ) {
        content()
    }
}

/**
 * 向后兼容别名。
 * 历史调用点若直接将此 modifier 套在内容容器上，文字会被模糊 —— 请迁移到 [AgentoFrostedGlassBox]。
 * 此别名暂时保留以避免编译错误，后续应逐步清除。
 */
fun Modifier.agentoFrostedGlass(
    shape: androidx.compose.ui.graphics.Shape = AgentoShapes.SurfaceMediumShape,
    backgroundColor: Color = AgentoFrostedTokens.SurfaceLevel1,
    blurRadius: Dp = AgentoFrostedTokens.BlurStandard,
    showTopHairline: Boolean = false,
): Modifier = agentoFrostedGlassBackground(shape, backgroundColor, blurRadius, showTopHairline)


/**
 * 微观磨砂噪波质感单例 (Sub-pixel Frosted Glass Texture & Micro-roughness).
 *
 * 遵循真实酸蚀/蒙砂玻璃（Acid-etched & Sandblasted Glass）物理光学特性：
 * 1. 表面存在高频微观粗糙度（Micro-roughness），产生极细微的亚像素环境光漫散；
 * 2. 避免计算机生成的半透明纯色块产生的“塑料贴膜感”或 8-bit 色阶断层；
 * 3. 采用预生成 256x256 平铺 BitmapShader；更长的重复周期避免在大面积
 *    浅色玻璃上读成规则网格；
 * 4. 微粒既消除色阶断层，也形成一层低对比的哑光散射，令玻璃具有可见但不脏的磨砂感。
 */
internal object AgentoFrostedNoise {
    private var darkShaderBrush: ShaderBrush? = null
    private var lightShaderBrush: ShaderBrush? = null

    fun getBrush(isDark: Boolean): ShaderBrush {
        if (isDark) {
            darkShaderBrush?.let { return it }
        } else {
            lightShaderBrush?.let { return it }
        }

        val size = 256
        val pixels = IntArray(size * size)
        val random = java.util.Random(1337)
        for (i in 0 until size * size) {
            if (isDark) {
                // A dark pane needs a denser, brighter grain to retain the
                // same matte scatter that is visible on a bright pane.
                val isHighlight = random.nextFloat() > 0.78f
                val lum = if (isHighlight) 245 + random.nextInt(11) else 204 + random.nextInt(40)
                val alpha = if (isHighlight) {
                    ((random.nextFloat() * 0.025f + 0.022f) * 255f).toInt()
                } else {
                    ((random.nextFloat() * 0.026f + 0.016f) * 255f).toInt()
                }
                pixels[i] = (alpha shl 24) or (lum shl 16) or (lum shl 8) or lum
            } else {
                // Acid-etched glass is primarily a field of tiny darker
                // micro-pits with occasional light-catching facets. This is
                // deliberately several code values above the old 1–3/255
                // texture: it remains fine grain, but is still visible over
                // the near-white large panes used by the product.
                val isFacet = random.nextFloat() > 0.78f
                val lum = if (isFacet) 245 + random.nextInt(11) else (138 + random.nextInt(64))
                val alpha = if (isFacet) {
                    ((random.nextFloat() * 0.028f + 0.018f) * 255f).toInt()
                } else {
                    ((random.nextFloat() * 0.030f + 0.016f) * 255f).toInt()
                }
                pixels[i] = (alpha shl 24) or (lum shl 16) or (lum shl 8) or lum
            }
        }
        val bitmap = Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
        val shader = BitmapShader(bitmap, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
        val brush = object : ShaderBrush() {
            override fun createShader(size: Size): Shader = shader
        }

        if (isDark) {
            darkShaderBrush = brush
        } else {
            lightShaderBrush = brush
        }
        return brush
    }
}

/**
 * Records content into a [GraphicsLayer] while correctly redirecting the canvas
 * so child drawing operations are captured into the layer's display list.
 */
fun ContentDrawScope.recordToLayer(
    layer: GraphicsLayer,
) {
    layer.record(this, layoutDirection, size.toIntSize()) {
        val recordingCanvas = this.drawContext.canvas
        val originalCanvas = this@recordToLayer.drawContext.canvas
        this@recordToLayer.drawContext.canvas = recordingCanvas
        try {
            this@recordToLayer.drawContent()
        } finally {
            this@recordToLayer.drawContext.canvas = originalCanvas
        }
    }
    drawLayer(layer)
}

/**
 * One UI-style defocused, milky-surface container.
 *
 * Only an available background snapshot is blurred. Foreground text and
 * icons stay sharp; the material has no specular or gradient border.
 */
@Composable
fun AgentoFrostedGlassBox(
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = AgentoShapes.SurfaceMediumShape,
    surface: AgentoGlassSurface = AgentoGlassSurface.Neutral,
    blurRadius: Dp = AgentoFrostedTokens.BlurNavigation,
    showTopHairline: Boolean = false,
    specularBrush: Brush? = null,
    backdropLayer: GraphicsLayer? = null,
    backdropOffset: IntOffset = IntOffset.Zero,
    material: AgentoGlassMaterial = AgentoGlassMaterial.LiquidClear,
    backdropTone: AgentoBackdropTone = AgentoBackdropTone.Standard,
    contentAlignment: androidx.compose.ui.Alignment = androidx.compose.ui.Alignment.TopStart,
    hasShadow: Boolean = true,
    shadowElevation: Dp = 8.dp,
    shadowAlpha: Float = 0.06f,
    shadowSpotAlpha: Float = 0.02f,
    // Moving controls can update sampling coordinates in draw, without
    // recomposing their sharp foreground on every placement frame.
    backdropOffsetProvider: (() -> IntOffset)? = null,
    textureAlpha: Float = 1f,
    content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val backdropRevision = LocalAgentoBackdropRevision.current
    val defocusProfile = remember(blurRadius) { agentoDefocusProfileFor(blurRadius) }
    val isDark = colors.canvas.red < 0.5f
    // RenderEffect is unavailable before Android 12. Use the established
    // missing-backdrop material there, including its more opaque substrate.
    val hasBackdrop = backdropLayer != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
    val materialBaseColor = if (isDark) {
        if (hasBackdrop) {
            Color(0xFF1E1E22).copy(alpha = material.substrateAlphaDark)
        } else {
            Color(0xFF1E1E22).copy(alpha = material.substrateAlphaDark.coerceAtLeast(0.85f))
        }
    } else {
        if (hasBackdrop) {
            Color.White.copy(alpha = material.substrateAlphaLight)
        } else {
            Color.White.copy(alpha = material.substrateAlphaLight.coerceAtLeast(0.88f))
        }
    }
    val backdropVeilColor = if (!hasBackdrop) {
        Color.Transparent
    } else {
        colors.canvas.copy(alpha = if (isDark) material.backdropVeilDark else material.backdropVeilLight)
    }
    // Callers declare their surface intent; token values and Brush identity
    // must not silently switch the rendering or missing-backdrop fallback.
    val semanticTintColor = surface.tintColor(material)
    val substrateBrush = surface.substrateBrush(hasBackdrop = hasBackdrop)

    // An opaque canvas match blocks the unfiltered physical page. The
    // defocused snapshot is the only carrier of background colour;
    // foreground labels are painted separately and remain sharp.
    androidx.compose.foundation.layout.Box(
        modifier = modifier
            .then(
                if (hasShadow && shadowElevation > 0.dp) {
                    Modifier.agentoAmbientShadow(
                        elevation = shadowElevation,
                        shape = shape,
                        alpha = shadowAlpha,
                        spotAlpha = shadowSpotAlpha,
                    )
                } else {
                    Modifier
                },
            )
            .clip(shape),
        contentAlignment = contentAlignment,
    ) {
        // Layer 1: local page snapshot with GPU spatial defocus. This layer
        // contains no foreground content, so blur never softens text or icons.
        if (backdropLayer != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            androidx.compose.foundation.layout.Box(modifier = Modifier.matchParentSize()) {
                // First block the physical page behind this composable with
                // the *canvas* colour, then paint the defocused snapshot over
                // it. This must be opaque: a GraphicsLayer can contain
                // transparent pixels between transcript glyphs, and a
                // translucent fallback would expose the sharp original page
                // through those holes. It is deliberately canvas-coloured,
                // not white, so blank areas still merge naturally with the
                // page while sampled colour fields remain visible above it.
                androidx.compose.foundation.layout.Box(
                    modifier = Modifier
                        .matchParentSize()
                        // Keep this as an opaque canvas match, not a bright
                        // card. The next layer is the only carrier of page
                        // information and has already been heavily defocused.
                        .drawBehind {
                            drawRect(
                                if (isDark) Color(0xFF1E1E22) else colors.canvas,
                            )
                        },
                )
                AgentoBackdropDefocus(
                    backdropLayer = backdropLayer,
                    backdropOffset = backdropOffset,
                    backdropOffsetProvider = backdropOffsetProvider,
                    revision = backdropRevision,
                    profile = defocusProfile,
                    tone = backdropTone,
                    canvas = colors.canvas,
                    frostTint = agentoFrostTint(colors.canvas, colors.surfaceHighest),
                    modifier = Modifier.matchParentSize(),
                )
            }
        }

        // Layer 2: luminance stabilization and the milky substrate. The order
        // is important: blur first, tint second. One UI separation comes from
        // fog and a diffuse shadow, never from a highlight edge.
        androidx.compose.foundation.layout.Box(
            modifier = Modifier
                .matchParentSize()
                .drawWithCache {
                    val outline = shape.createOutline(size, layoutDirection, this)
                    onDrawBehind {
                        // 1. A little context-aware luminosity control keeps
                        //    labels legible over both bright and dark content.
                        if (backdropVeilColor.alpha > 0f) {
                            drawOutline(outline = outline, color = backdropVeilColor)
                        }

                        // 2. Standard material gets a neutral translucent
                        //    substrate. Explicit brushes are reserved for
                        //    Liquid controls and remain translucent tokens.
                        if (substrateBrush != null) {
                            drawOutline(outline = outline, brush = substrateBrush)
                        } else {
                            drawOutline(outline = outline, color = materialBaseColor)
                        }

                        // 3. Status color is an overlay, never the surface
                        //    itself; this prevents the old flat pink/red cards.
                        if (semanticTintColor.alpha > 0f) {
                            drawOutline(outline = outline, color = semanticTintColor)
                        }

                        val noiseBrush = AgentoFrostedNoise.getBrush(isDark)
                        drawOutline(outline = outline, brush = noiseBrush, alpha = textureAlpha.coerceIn(0f, 1f))

                        if (showTopHairline) {
                            val hairlineColor = if (isDark) {
                                Color.White.copy(alpha = 0.12f)
                            } else {
                                Color.White.copy(alpha = 0.20f)
                            }
                            drawOutline(
                                outline = outline,
                                color = hairlineColor,
                                style = Stroke(width = 0.35.dp.toPx()),
                            )
                        }

                    }
                },
        )

        // Layer 3: Content — sharp text/icons, completely isolated from blur and shaders
        CompositionLocalProvider(LocalContentColor provides colors.primaryContent) {
            content()
        }
    }
}

@Deprecated(
    message = "Do not blur a container that owns foreground content. Use AgentoFrostedGlassBox so the backdrop and content remain separate.",
    level = DeprecationLevel.WARNING,
)
fun Modifier.agentoGlass(
    backgroundColor: Color,
    blurRadius: Dp = 24.dp,
    shape: androidx.compose.ui.graphics.Shape? = null,
): Modifier = composed {
    val base = if (shape != null) this.graphicsLayer { this.shape = shape; clip = true } else this
    // Keep this compatibility modifier visually safe: applying a RenderEffect
    // or blur here would blur the caller's own text and icons. The real blur
    // path lives in AgentoFrostedGlassBox, which samples a separate backdrop.
    @Suppress("UNUSED_VARIABLE")
    val ignoredLegacyBlurRadius = blurRadius
    base.background(backgroundColor)
}

/** Compatibility entry point for the shared press response, without a haptic. */
fun Modifier.agentoPressFeedback(
    pressedScale: Float = 0.98f,
    onClick: (() -> Unit)? = null,
): Modifier = agentoPressScale(pressedScale = pressedScale, onClick = onClick, hapticFeedback = false)

/** Fast compression and interruptible release, sharing the actual click source. */
@OptIn(ExperimentalFoundationApi::class)
fun Modifier.agentoPressScale(
    pressedScale: Float = 0.98f,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    interactionSource: MutableInteractionSource? = null,
    hapticFeedback: Boolean = true,
): Modifier = composed {
    val ownedInteractionSource = remember { MutableInteractionSource() }
    val resolvedInteractionSource = interactionSource ?: ownedInteractionSource
    val isPressed by resolvedInteractionSource.collectIsPressedAsState()
    val hapticView = LocalView.current

    // Touch-down tick for every tappable surface. The dedicated
    // Confirm/Reject calls stay at semantic decision points (approvals).
    LaunchedEffect(isPressed, hapticFeedback) {
        if (isPressed && hapticFeedback) {
            AgentoHaptics.performTick(hapticView)
        }
    }

    val scale = rememberAgentoPressScale(resolvedInteractionSource, pressedScale)

    this
        .then(
            if (onClick != null || onLongClick != null) {
                Modifier.combinedClickable(
                    interactionSource = resolvedInteractionSource,
                    indication = null, // Disable default material ripple
                    onClick = onClick ?: {},
                    onLongClick = onLongClick,
                )
            } else Modifier,
        )
        .graphicsLayer {
            scaleX = scale.value
            scaleY = scaleX
        }
}

/**
 * 极淡全向发散环境阴影修饰符 (Omnidirectional Ambient Diffuse Shadow)。
 * 使用 Compose 的 ambient shadow 通道，让阴影在卡片四周扩散，并把 spot shadow 压到很低，
 * 避免出现明显的单侧投影或黑色描边。
 */
fun Modifier.agentoAmbientShadow(
    elevation: Dp = 8.dp,
    shape: Shape = RoundedCornerShape(percent = 50),
    alpha: Float = 0.05f,
    spotAlpha: Float = 0.05f,
    lightShadowAlphaCap: Float = 0.04f,
    darkShadowAlphaCap: Float = 0.12f,
): Modifier = composed {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    val ambientAlpha = if (isDark) {
        (alpha * 1.3f).coerceIn(0.03f, darkShadowAlphaCap)
    } else {
        (alpha * 0.60f).coerceIn(0.008f, lightShadowAlphaCap)
    }
    val spotShadowAlpha = if (isDark) {
        (alpha * spotAlpha * 1.3f).coerceIn(0.02f, darkShadowAlphaCap)
    } else {
        (alpha * spotAlpha * 0.60f).coerceIn(0.004f, 0.012f)
    }
    // A neutral shadow reads as an ambient halo rather than a cool outline.
    val shadowColor = Color.Black

    this.shadow(
        elevation = elevation,
        shape = shape,
        clip = false,
        ambientColor = shadowColor.copy(alpha = ambientAlpha),
        spotColor = shadowColor.copy(alpha = spotShadowAlpha),
    )
}

/**
 * Draws a real diffuse halo in an inset layer so the blur can extend beyond
 * the surface without being clipped by the surface shape.
 */
@Composable
fun AgentoDiffuseShadowBox(
    modifier: Modifier = Modifier,
    shape: Shape,
    shadowPadding: Dp = 16.dp,
    shadowPaddingVertical: Dp = shadowPadding,
    shadowBlur: Dp = 20.dp,
    shadowAlpha: Float = 0.16f,
    shadowSpotAlpha: Float = 0.10f,
    contentAlignment: androidx.compose.ui.Alignment = androidx.compose.ui.Alignment.TopStart,
    content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val density = LocalDensity.current
    val paddingHorizontalPx = with(density) { shadowPadding.toPx() }
    val paddingVerticalPx = with(density) { shadowPaddingVertical.toPx() }
    val blurPx = with(density) { shadowBlur.toPx() }
    val ambientAlpha = if (isDark) shadowAlpha * 1.35f else shadowAlpha
    val keyAlpha = ambientAlpha * shadowSpotAlpha.coerceIn(0f, 1f)
    val shadowColor = if (isDark) Color.Black else Color(0xFF71859D)

    Box(
        modifier = modifier.drawWithCache {
            val cardWidth = size.width - paddingHorizontalPx * 2f
            val cardHeight = size.height - paddingVerticalPx * 2f
            if (cardWidth <= 0f || cardHeight <= 0f) {
                onDrawBehind { }
            } else {
                val outline = shape.createOutline(
                    size = androidx.compose.ui.geometry.Size(cardWidth, cardHeight),
                    layoutDirection = layoutDirection,
                    density = this,
                )
                val androidPath = when (outline) {
                    is Outline.Rectangle -> Path().apply { addRect(outline.rect) }.asAndroidPath()
                    is Outline.Rounded -> Path().apply { addRoundRect(outline.roundRect) }.asAndroidPath()
                    is Outline.Generic -> outline.path.asAndroidPath()
                }
                val ambientPaint = AndroidPaint().apply {
                    isAntiAlias = true
                    color = shadowColor.copy(alpha = ambientAlpha.coerceIn(0f, 1f)).toArgb()
                    if (blurPx > 0f) {
                        maskFilter = android.graphics.BlurMaskFilter(
                            blurPx,
                            android.graphics.BlurMaskFilter.Blur.NORMAL,
                        )
                    }
                }
                val keyPaint = AndroidPaint().apply {
                    isAntiAlias = true
                    color = shadowColor.copy(alpha = keyAlpha.coerceIn(0f, 1f)).toArgb()
                    if (blurPx > 0f) {
                        maskFilter = android.graphics.BlurMaskFilter(
                            (blurPx * 0.55f).coerceAtLeast(1f),
                            android.graphics.BlurMaskFilter.Blur.NORMAL,
                        )
                    }
                }
                onDrawBehind {
                    drawIntoCanvas { canvas ->
                        val nativeCanvas = canvas.nativeCanvas
                        nativeCanvas.save()
                        nativeCanvas.translate(paddingHorizontalPx, paddingVerticalPx)
                        nativeCanvas.drawPath(androidPath, ambientPaint)
                        nativeCanvas.translate(0f, paddingVerticalPx * 0.12f)
                        nativeCanvas.drawPath(androidPath, keyPaint)
                        nativeCanvas.restore()
                    }
                }
            }
        },
        contentAlignment = contentAlignment,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    horizontal = shadowPadding,
                    vertical = shadowPaddingVertical,
                ),
            contentAlignment = contentAlignment,
            content = content,
        )
    }
}

/** Shared treatment for top-level cards and grouped content surfaces. */
fun Modifier.agentoLargeCardShadow(
    shape: Shape,
    elevation: Dp = 14.dp,
): Modifier = agentoAmbientShadow(
    elevation = elevation,
    shape = shape,
    alpha = 0.13f,
)

/** Visual tokens for the floating composer and navigation bar halo. */
object RagentComposerShadowTokens {
    // Wide, low-opacity layers produce the diffuse falloff of the reference
    // composer without introducing a Material-style hard edge.
    val AmbientBlur = 22.dp
    val KeyBlur = 8.dp
    val OffsetY = 2.dp
    const val AmbientLightAlpha = 0.040f
    const val KeyLightAlpha = 0.022f
    const val AmbientDarkAlpha = 0.16f
    const val KeyDarkAlpha = 0.11f
}

/**
 * Authentic Gaussian diffuse drop shadow for floating pills (Composer & Navigation Dock).
 * Uses hardware-accelerated Skia Gaussian BlurMaskFilter to provide a completely continuous,
 * smooth gradient falloff from inside to outside without any visible color banding or discrete steps.
 */
fun Modifier.ragentComposerShadow(
    shape: Shape = RoundedCornerShape(percent = 50),
    ambientBlur: Dp = RagentComposerShadowTokens.AmbientBlur,
    keyBlur: Dp = RagentComposerShadowTokens.KeyBlur,
    offsetY: Dp = RagentComposerShadowTokens.OffsetY,
    ambientLightAlpha: Float = RagentComposerShadowTokens.AmbientLightAlpha,
    keyLightAlpha: Float = RagentComposerShadowTokens.KeyLightAlpha,
    ambientDarkAlpha: Float = RagentComposerShadowTokens.AmbientDarkAlpha,
    keyDarkAlpha: Float = RagentComposerShadowTokens.KeyDarkAlpha,
): Modifier = composed {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    val effectiveAmbientAlpha = if (isDark) ambientDarkAlpha else ambientLightAlpha
    val effectiveKeyAlpha = if (isDark) keyDarkAlpha else keyLightAlpha

    val density = LocalDensity.current
    val ambientBlurPx = with(density) { ambientBlur.toPx() }
    val keyBlurPx = with(density) { keyBlur.toPx() }
    val offsetYPx = with(density) { offsetY.toPx() }

    val ambientPaint = remember(ambientBlurPx, effectiveAmbientAlpha) {
        AndroidPaint().apply {
            isAntiAlias = true
            color = Color.Black.copy(alpha = effectiveAmbientAlpha).toArgb()
            if (ambientBlurPx > 0f) {
                maskFilter = android.graphics.BlurMaskFilter(
                    ambientBlurPx,
                    android.graphics.BlurMaskFilter.Blur.NORMAL,
                )
            }
        }
    }

    val keyPaint = remember(keyBlurPx, effectiveKeyAlpha) {
        AndroidPaint().apply {
            isAntiAlias = true
            color = Color.Black.copy(alpha = effectiveKeyAlpha).toArgb()
            if (keyBlurPx > 0f) {
                maskFilter = android.graphics.BlurMaskFilter(
                    keyBlurPx,
                    android.graphics.BlurMaskFilter.Blur.NORMAL,
                )
            }
        }
    }

    this.drawBehind {
        drawIntoCanvas { canvas ->
            val outline = shape.createOutline(size, layoutDirection, this)
            val androidPath = when (outline) {
                is Outline.Rectangle -> {
                    androidx.compose.ui.graphics.Path().apply {
                        addRect(outline.rect)
                    }.asAndroidPath()
                }
                is Outline.Rounded -> {
                    androidx.compose.ui.graphics.Path().apply {
                        addRoundRect(outline.roundRect)
                    }.asAndroidPath()
                }
                is Outline.Generic -> outline.path.asAndroidPath()
            }

            val nativeCanvas = canvas.nativeCanvas
            // 1. Wide omnidirectional ambient diffuse halo (360° Gaussian falloff)
            nativeCanvas.drawPath(androidPath, ambientPaint)

            // 2. Directional key shadow (slight Y offset for physical depth)
            if (offsetYPx != 0f) {
                nativeCanvas.save()
                nativeCanvas.translate(0f, offsetYPx)
                nativeCanvas.drawPath(androidPath, keyPaint)
                nativeCanvas.restore()
            } else {
                nativeCanvas.drawPath(androidPath, keyPaint)
            }
        }
    }
}

@Composable
fun AgentoBreathingDot(
    color: Color = LocalRagentColors.current.stateRunning,
    size: Dp = 6.dp,
    modifier: Modifier = Modifier,
) {
    val motion = motionPolicy()
    val alpha = if (LocalAgentoBackgrounded.current || motion.preference != MotionPreference.Full) {
        0.7f
    } else {
        val infiniteTransition = rememberInfiniteTransition(label = "breathing_dot")
        val animatedAlpha by infiniteTransition.animateFloat(
            initialValue = 0.55f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(800, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "breathing_alpha",
        )
        animatedAlpha
    }
    Box(
        modifier = modifier
            .size(size)
            .graphicsLayer { this@graphicsLayer.alpha = alpha }
            .background(color, CircleShape),
    )
}

object RagentElevation {
    val Contained = 0.dp
    val Floating = 0.dp
    val Navigation = 0.dp
    val Sheet = 0.dp
    val Card = 0.dp
}

object AgentoMotion {
    // 4 级统一动效语言规范 (AgentoMotion 2.0)
    // 1. Micro (微交互: 80~140ms) - 按压反馈、图标切换、复选框、微光闪烁
    val Micro = spring<Float>(dampingRatio = 0.75f, stiffness = 380f)
    // 2. UI Transition (状态切换: 160~220ms) - 工具卡片展开/收起、审批栏 Morph、标签切换
    val Transition = spring<Float>(dampingRatio = 0.85f, stiffness = 420f)
    // 3. Spatial (空间转场: 220~320ms) - L1 ⇄ L2 页面进出、Panel 弹出、BottomSheet 升降
    val Spatial = spring<Float>(dampingRatio = 0.82f, stiffness = 300f)
    val SpatialOffset = spring<androidx.compose.ui.unit.IntOffset>(dampingRatio = 0.82f, stiffness = 300f)
    // 4. Gesture (手势连续) - 1:1 跟手

    // Apple 规范交互弹簧 (Fluid, responsive, natural, interruptible)
    val AppleSpring = spring<Float>(
        dampingRatio = 0.96f,
        stiffness = 420f,
    )
    val AppleNavigationOffset = spring<androidx.compose.ui.unit.IntOffset>(
        dampingRatio = 0.96f,
        stiffness = 420f,
    )
    val ApplePressSpring = spring<Float>(
        dampingRatio = 0.92f,
        stiffness = 520f,
    )
    val AppleReleaseSpring = spring<Float>(
        dampingRatio = 1.0f,
        stiffness = 460f,
    )

    // 标准界面位移/展开弹簧
    val PhysicsSpring = spring<Float>(
        dampingRatio = 0.75f,
        stiffness = 400f,
    )

    // 快速状态响应弹簧
    val FastSpring = spring<Float>(
        dampingRatio = 0.92f,
        stiffness = 800f,
    )

    // 持续时间标准 (Timing)
    const val DurationFast = 120        // 点击反馈、图标 Morph、Checkmark 动画
    const val DurationStandard = 200    // 列表展开、Tool 抽屉开合、Approval 状态收束
    const val DurationEmphasized = 280  // 页面转场、BottomSheet 弹出、键盘跟随

    // 物理弹簧 (Spring Specs)
    val SnappySpring = spring<Float>(
        dampingRatio = 0.85f,
        stiffness = 420f,
    )

    val NaturalSpring = spring<Float>(
        dampingRatio = 0.96f,
        stiffness = 320f,
    )

    val LayoutSpring = spring<androidx.compose.ui.unit.IntSize>(
        dampingRatio = 0.82f,
        stiffness = 380f,
    )

    const val Immediate = 0
    const val Feedback = 120
    const val StateChange = 180
    const val Disclosure = 220
    const val Navigation = 280
}

val RagentMotion = AgentoMotion

val RagentTypography = Typography(
    displaySmall = Typography().displaySmall.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Bold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
    ),
    bodyLarge = Typography().bodyLarge.copy(
        fontFamily = RagentUiFont,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = Typography().bodyMedium.copy(
        fontFamily = RagentUiFont,
        fontSize = 15.sp,
        lineHeight = 22.sp,
    ),
    labelLarge = Typography().labelLarge.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Medium,
        fontSize = 15.sp,
    ),
    labelMedium = Typography().labelMedium.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
    ),
    labelSmall = Typography().labelSmall.copy(
        fontFamily = RagentUiFont,
        fontSize = 12.sp,
    ),
    titleLarge = Typography().titleLarge.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    titleMedium = Typography().titleMedium.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
    ),
    titleSmall = Typography().titleSmall.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
    ),
    headlineSmall = Typography().headlineSmall.copy(
        fontFamily = RagentUiFont,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 30.sp,
    ),
)

object RagentTextStyles {
    val brandDisplay = TextStyle(fontFamily = RagentUiFont, fontSize = 28.sp, fontWeight = FontWeight.Bold, lineHeight = 34.sp)
    val pageTitle = TextStyle(fontFamily = RagentUiFont, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp)
    val titlePage = pageTitle
    val projectTitle = TextStyle(fontFamily = RagentUiFont, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, lineHeight = 22.sp)
    val titleProject = projectTitle
    val sessionTitle = TextStyle(fontFamily = RagentUiFont, fontSize = 14.sp, fontWeight = FontWeight.Medium, lineHeight = 20.sp)
    val titleSession = sessionTitle
    val agentBody = TextStyle(fontFamily = RagentUiFont, fontSize = 16.sp, fontWeight = FontWeight(500), lineHeight = 27.5.sp)
    val bodyAgent = agentBody
    val userBody = TextStyle(fontFamily = RagentUiFont, fontSize = 16.sp, fontWeight = FontWeight(500), lineHeight = 27.5.sp)
    val bodyUser = userBody
    val caption = TextStyle(fontFamily = RagentUiFont, fontSize = 13.sp, fontWeight = FontWeight.Medium, lineHeight = 18.sp)
    val captionMeta = caption
    val tabular = TextStyle(fontFamily = RagentUiFont, fontSize = 12.sp, fontWeight = FontWeight.Medium, lineHeight = 16.sp)
    val labelTabular = tabular
    val code = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.5.sp, fontWeight = FontWeight.Normal, lineHeight = 20.sp)
    val codeBlock = code
}

object RagentTheme {
    val colors: RagentColors
        @Composable
        get() = LocalRagentColors.current
    val extendedColors: RagentExtendedColors
        @Composable
        get() = LocalRagentExtendedColors.current
    val typography: Typography
        @Composable
        get() = MaterialTheme.typography
    val textStyles: RagentTextStyles
        get() = RagentTextStyles
    val shapes: Shapes
        @Composable
        get() = MaterialTheme.shapes
}

val AgentoTheme = RagentTheme

@Composable
fun RagentTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    themeVariant: String = "system",
    motionPreference: MotionPreference? = null,
    content: @Composable () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val variant = themeVariant.lowercase()
    val isDark = when (variant) {
        "dark", "oled", "amber" -> true
        "light" -> false
        else -> darkTheme
    }

    val materialColorScheme = when (variant) {
        "oled" -> OledColors
        "amber" -> AmberColors
        "light" -> LightColors
        "dark" -> DarkColors
        "monet" -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (isDark) androidx.compose.material3.dynamicDarkColorScheme(context)
                else androidx.compose.material3.dynamicLightColorScheme(context)
            } else {
                if (isDark) DarkColors else LightColors
            }
        }
        else -> if (isDark) DarkColors else LightColors
    }

    val ragentColors = when (variant) {
        "oled" -> OledRagentColors
        "amber" -> AmberRagentColors
        "light" -> LightRagentColors
        "dark" -> DarkRagentColors
        "monet" -> dynamicRagentColors(
            scheme = materialColorScheme,
            semanticColors = if (isDark) DarkRagentColors else LightRagentColors,
        )
        else -> if (isDark) DarkRagentColors else LightRagentColors
    }
    val extendedColors = if (isDark) DarkExtended else LightExtended
    val resolvedMotionPreference = motionPreference ?: rememberSystemMotionPreference()
    val windowView = LocalView.current
    val windowActivity = windowView.context.findActivity()

    SideEffect {
        // Keep transparent and animated Compose layers backed by the active
        // canvas instead of the platform's default window color.
        windowActivity?.window?.let { window ->
            window.setBackgroundDrawable(ColorDrawable(ragentColors.canvas.toArgb()))
            // Explicit app palettes must not inherit an OS light-mode scrim.
            @Suppress("DEPRECATION")
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            @Suppress("DEPRECATION")
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
            WindowCompat.getInsetsController(window, windowView).apply {
                isAppearanceLightStatusBars = !isDark
                isAppearanceLightNavigationBars = !isDark
            }
        }
    }

    CompositionLocalProvider(
        LocalRagentColors provides ragentColors,
        LocalRagentExtendedColors provides extendedColors,
        LocalMotionPolicy provides MotionPolicy(resolvedMotionPreference),
    ) {
        MaterialTheme(
            colorScheme = materialColorScheme,
            typography = RagentTypography,
            shapes = Shapes(
                extraSmall = RoundedCornerShape(RagentShapes.ExtraSmall),
                small = RoundedCornerShape(RagentShapes.Small),
                medium = RoundedCornerShape(RagentShapes.Control),
                large = RoundedCornerShape(RagentShapes.Row),
                extraLarge = RoundedCornerShape(RagentShapes.Sheet),
            ),
            content = {
                AgentoSystemSafeArea {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(
                            brush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight,
                        ),
                ) {
                    content()
                }
                }
            },
        )
    }
}

object RagentThemeDefaults {
    val contentPadding = RagentSpacing.Gutter
    val itemSpacing = RagentSpacing.Standard
}
