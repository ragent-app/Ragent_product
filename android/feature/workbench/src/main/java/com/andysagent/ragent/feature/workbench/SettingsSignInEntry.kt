package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*

/** Account access is a discoverable settings entry, not the page's hero CTA. */
@Composable
internal fun SettingsSignInEntry(
    title: String,
    actionLabel: String,
    onClick: () -> Unit,
    leadingIcon: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val shape = RoundedCornerShape(24.dp)
    AgentoFrostedGlassBox(
        modifier = Modifier.fillMaxWidth()
            .agentoPressScale(pressedScale = 0.985f, onClick = onClick)
            .testTag("settings-sign-in-entry"),
        shape = shape,
        surface = AgentoGlassSurface.Neutral,
        material = AgentoGlassMaterial.LiquidClear,
        showTopHairline = true,
        specularBrush = if (isDark) com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens.SpecularBorderDark
            else com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens.SpecularBorderLight,
        shadowElevation = 5.dp,
        shadowAlpha = 0.035f,
        shadowSpotAlpha = 0.01f,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) { leadingIcon() }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 16.sp, fontWeight = FontWeight.Medium), color = colors.primaryContent)
                Text(actionLabel, style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = colors.accentPrimary)
            }
            AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, Modifier.size(16.dp), tint = colors.tertiaryContent)
        }
    }
}
