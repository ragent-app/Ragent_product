package com.andysagent.ragent.core.designsystem

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Quiet navigation chrome keeps the settings content in focus. */
@Composable
fun AgentoSettingsHeader(
    title: String,
    onBack: (() -> Unit)?,
    backDescription: String,
    modifier: Modifier = Modifier,
    backModifier: Modifier = Modifier,
    backEnabled: Boolean = true,
    subtitle: String? = null,
    onRefresh: (() -> Unit)? = null,
    refreshDescription: String = title,
    refreshing: Boolean = false,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp)
            .padding(horizontal = RagentSpacing.Standard, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            AgentoToolbarIconButton(onClick = onBack, contentDescription = backDescription,
                modifier = backModifier, enabled = backEnabled) {
                AgentoWebIcon(AgentoWebGlyph.Back, null, tint = colors.primaryContent)
            }
        } else Spacer(Modifier.width(RagentSpacing.TouchTarget))
        Box(Modifier.weight(1f).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                Column(Modifier.padding(vertical = 7.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(title, color = colors.primaryContent,
                        style = MaterialTheme.typography.titleMedium.copy(fontSize = 21.sp, fontWeight = FontWeight.SemiBold, lineBreak = LineBreak.Heading),
                        textAlign = TextAlign.Center)
                    subtitle?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = colors.secondaryContent, style = MaterialTheme.typography.labelSmall,
                            maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    }
                }
        }
        if (onRefresh != null) {
            AgentoToolbarIconButton(onClick = onRefresh, contentDescription = refreshDescription) {
                if (refreshing) AgentoProgress(modifier = Modifier.size(20.dp))
                else AgentoWebIcon(AgentoWebGlyph.Refresh, null, tint = colors.floatingControlContent)
            }
        } else Spacer(Modifier.width(RagentSpacing.TouchTarget))
    }
}
