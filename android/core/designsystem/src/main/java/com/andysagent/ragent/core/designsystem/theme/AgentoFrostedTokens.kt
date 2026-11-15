package com.andysagent.ragent.core.designsystem.theme

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * One UI-inspired milky defocus material tokens.
 *
 * The canvas stays intentionally plain. Surfaces carry the hierarchy through
 * their soft, high-opacity fog and diffuse elevation—not through an iOS-style
 * specular rim or a painted background gradient.
 */
object AgentoFrostedTokens {
    // 纯暗色背景 (Deep Canvas - Apple OLED True Black)
    val Background = Color(0xFF000000)
    val BackgroundLight = Color(0xFFF2F2F7)

    // Dark Mode One UI milky surfaces.
    val SurfaceLevel0 = Color(0xFF262626).copy(alpha = 0.72f)
    val SurfaceLevel1 = Color(0xFF262626).copy(alpha = 0.82f)
    val SurfaceLevel2 = Color(0xFF2B2B2B).copy(alpha = 0.86f)
    val SurfaceLevel3 = Color(0xFF303030).copy(alpha = 0.90f)

    // Light Mode One UI milky surfaces.
    // A pure-white fog disappears against the product's solid #F2F2F7
    // canvas. These remain high-opacity, but their restrained cool-grey cast
    // makes the material readable without inventing a backdrop gradient.
    val LightSurfaceLevel0 = Color(0xFFE9EDF3).copy(alpha = 0.82f)
    val LightSurfaceLevel1 = Color(0xFFE2E7EF).copy(alpha = 0.86f)
    val LightSurfaceLevel2 = Color(0xFFE5EAF1).copy(alpha = 0.88f)
    val LightSurfaceLevel3 = Color(0xFFEAEDF3).copy(alpha = 0.90f)

    // 0.5dp 极细微哑光分界线 (Apple HIG Whisper Hairline / Separator)
    val SubtleHairline = Color.White.copy(alpha = 0.12f)
    val LightSubtleHairline = Color.Black.copy(alpha = 0.08f)

    // Physical Glass Optical Tokens (Apple HIG / Modern Flat-Optical Glass)
    val InnerRimHighlightDark = Color.Transparent
    val InnerRimHighlightLight = Color.Transparent
    val SurfaceSheenDark = Color.Transparent
    val SurfaceSheenLight = Color.Transparent
    val BottomOcclusionDark = Color.Transparent
    val BottomOcclusionLight = Color.Transparent

    /** Content cards and general glass surfaces match navigation dock material. */
    val LightDockGlassColor = Color.White.copy(alpha = 0.35f)
    val DarkDockGlassColor = Color(0xFF1E1E22).copy(alpha = 0.42f)

    val LightCardGlassColor = LightDockGlassColor
    val DarkCardGlassColor = DarkDockGlassColor

    // Navigation moving selection lens: frosted glass in light grey, clearly
    // distinct from the translucent white dock for tactile readability.
    val LightLensGlassColor = Color(0xFFD6DAE2).copy(alpha = 0.88f)
    val DarkLensGlassColor = Color(0xFF38383E).copy(alpha = 0.82f)

    val LightDockGlassBrush: Brush = androidx.compose.ui.graphics.SolidColor(LightDockGlassColor)
    val DarkDockGlassBrush: Brush = androidx.compose.ui.graphics.SolidColor(DarkDockGlassColor)

    val LightCardGlassBrush: Brush = LightDockGlassBrush
    val DarkCardGlassBrush: Brush = DarkDockGlassBrush

    val LightLensGlassBrush: Brush = androidx.compose.ui.graphics.SolidColor(LightLensGlassColor)
    val DarkLensGlassBrush: Brush = androidx.compose.ui.graphics.SolidColor(DarkLensGlassColor)

    // Compatibility no-ops for legacy callers. One UI surfaces intentionally
    // have no specular outline; separation comes from fog and diffuse shadow.
    val SpecularBorderDark: Brush = androidx.compose.ui.graphics.SolidColor(Color.Transparent)
    val SpecularBorderLight: Brush = androidx.compose.ui.graphics.SolidColor(Color.Transparent)
    val LensBorderDark: Brush = androidx.compose.ui.graphics.SolidColor(Color.Transparent)
    val LensBorderLight: Brush = androidx.compose.ui.graphics.SolidColor(Color.Transparent)

    // The application canvas remains a single grouped-background colour. Glass
    // derives its cool-grey distinction from its own translucent substrate;
    // individual screens must opt in if they have a genuinely rich backdrop.
    val AtmosphericCanvasDark: Brush = androidx.compose.ui.graphics.SolidColor(Color.Black)
    val AtmosphericCanvasLight: Brush = androidx.compose.ui.graphics.SolidColor(
        Color(0xFFF2F2F7), // Apple systemGroupedBackground
    )

    // A deeper shade of the launcher mark's blue-violet dot makes white
    // button labels readable in both themes. Foreground accents adapt separately.
    val BrandPrimary = Color(0xFF566DD0)
    val OnBrandPrimary = Color.White
    val BrandAccentLight = Color(0xFF536AC2)
    val BrandAccentDark = Color(0xFF8EA8FF)
    val OnBrandAccentDark = Color(0xFF0B0F17)
    val BrandContainerLight = Color(0xFFEDF0FD)
    val BrandContainerDark = Color(0xFF232C48)

    // Historical names retained for source compatibility with integrations.
    val AppleBlueDark = BrandAccentDark
    val OnAppleBlueDark = OnBrandAccentDark
    // Semantic status colors retain their own meaning.
    // Red filled actions use white labels. These deeper reds are independent
    // of error/status colors and keep small labels legible in either theme.
    val DestructiveActionLight = Color(0xFFC8322C)
    val DestructiveActionDark = Color(0xFFD13B34)
    val OnDestructiveAction = Color.White
    val AppleGreenDark = Color(0xFF30D158)
    val AppleIndigoDark = Color(0xFF5E5CE6)
    val AppleOrangeDark = Color(0xFFFF9F0A)
    val ApplePinkDark = Color(0xFFFF375F)
    val ApplePurpleDark = Color(0xFFBF5AF2)
    val AppleRedDark = Color(0xFFFF453A)
    val AppleTealDark = Color(0xFF64D2FF)
    val AppleYellowDark = Color(0xFFFFD60A)

    // Light Mode
    val AppleBlueLight = BrandAccentLight
    val AppleGreenLight = Color(0xFF34C759)
    val AppleIndigoLight = Color(0xFF5856D6)
    val AppleOrangeLight = Color(0xFFFF9500)
    val ApplePinkLight = Color(0xFFFF2D55)
    val ApplePurpleLight = Color(0xFFAF52DE)
    val AppleRedLight = Color(0xFFFF3B30)
    val AppleTealLight = Color(0xFF30B0C7)
    val AppleYellowLight = Color(0xFFFFCC00)

    // Semantic status colors
    val StatusActive = Color(0xFF30D158)   // 运行呼吸绿
    val StatusAttention = Color(0xFFFF9F0A) // 待审批琥珀橙
    val StatusIdle = Color(0xFF8E8E93)      // 就绪中性灰
    val StatusError = Color(0xFFFF453A)     // 错误红

    // 文字阶梯 (Dark)
    val TextPrimary = Color(0xFFF5F5F7)
    val TextSecondary = Color(0xFF9E9EA7)
    val TextTertiary = Color(0xFF636366)

    // 文字阶梯 (Light)
    val LightTextPrimary = Color(0xFF000000)
    val LightTextSecondary = Color(0xFF6C6C70)
    val LightTextTertiary = Color(0xFFAEAEB2)

    // 磨砂模糊半径。浮层采用更强的局部散焦，避免背景正文在玻璃下仍可被辨读。
    val BlurThin = 18.dp
    val BlurSubtle = 20.dp
    val BlurStandard = 24.dp
    val BlurNavigation = 32.dp
    val BlurIntense = 30.dp
}
