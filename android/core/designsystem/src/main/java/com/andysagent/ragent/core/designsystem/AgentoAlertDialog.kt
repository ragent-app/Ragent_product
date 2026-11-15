package com.andysagent.ragent.core.designsystem

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens

@Composable
fun RagentapsuleGlassBox(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(28.dp),
    content: @Composable BoxScope.() -> Unit) {
    val isDark = LocalRagentColors.current.canvas.red < 0.5f
    AgentoFrostedGlassBox(modifier = modifier, shape = shape, surface = AgentoGlassSurface.Neutral,
        blurRadius = AgentoFrostedTokens.BlurNavigation, showTopHairline = true,
        material = AgentoGlassMaterial.LiquidClear, backdropTone = AgentoBackdropTone.QuietHeader,
        specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
        hasShadow = false, content = content)
}

/** Slot-based dialog using the same neutral glass as the conversation capsule. */
@Composable
fun AgentoAlertDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    dismissButton: (@Composable () -> Unit)? = null,
    title: (@Composable () -> Unit)? = null,
    text: (@Composable () -> Unit)? = null,
    properties: DialogProperties = DialogProperties(),
    titleContentColor: Color = LocalRagentColors.current.primaryContent,
    textContentColor: Color = LocalRagentColors.current.secondaryContent,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    Dialog(onDismissRequest = onDismissRequest, properties = properties) {
        CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides configuration) {
            AgentoModalBackgroundDim(amount = if (isDark) 0.20f else 0.16f)
            Box(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding().padding(16.dp),
                contentAlignment = Alignment.Center) {
                AgentoFrostedGlassBox(
                    modifier = modifier.fillMaxWidth().widthIn(max = 560.dp).heightIn(max = 700.dp),
                    shape = RoundedCornerShape(28.dp),
                    surface = AgentoGlassSurface.Neutral,
                    blurRadius = AgentoFrostedTokens.BlurNavigation,
                    showTopHairline = true,
                    material = AgentoGlassMaterial.LiquidClear,
                    backdropTone = AgentoBackdropTone.QuietHeader,
                    specularBrush = if (isDark) AgentoFrostedTokens.SpecularBorderDark else AgentoFrostedTokens.SpecularBorderLight,
                    hasShadow = false,
                ) {
                    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        title?.let {
                            CompositionLocalProvider(LocalContentColor provides titleContentColor) {
                                ProvideTextStyle(MaterialTheme.typography.headlineSmall, it)
                            }
                        }
                        text?.let {
                            Box(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                                CompositionLocalProvider(LocalContentColor provides textContentColor) {
                                    ProvideTextStyle(MaterialTheme.typography.bodyMedium, it)
                                }
                            }
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End,
                            verticalAlignment = Alignment.CenterVertically) {
                            dismissButton?.invoke()
                            confirmButton()
                        }
                    }
                }
            }
        }
    }
}
