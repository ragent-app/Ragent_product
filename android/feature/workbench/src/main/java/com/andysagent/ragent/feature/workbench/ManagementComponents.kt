package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.graphics.Color
import com.andysagent.ragent.core.designsystem.*

/** Flat sections: hierarchy comes from type and spacing, not nested surfaces. */
@Composable
internal fun ManagementSection(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth().padding(vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
        HorizontalDivider(color = LocalRagentColors.current.primaryContent.copy(alpha = 0.07f))
    }
}

internal fun providerRuntimeLabel(id: String): String = when (id) {
    "codex" -> "Codex"
    "claude" -> "Claude"
    "agy" -> "Antigravity"
    else -> id
}

@Composable
internal fun ManagementIdentity(glyph: AgentoWebGlyph) {
    val colors = LocalRagentColors.current
    AgentoWebIcon(glyph, null, Modifier.size(20.dp), tint = colors.secondaryContent)
}

@Composable
internal fun ManagementHint(text: String, glyph: AgentoWebGlyph = AgentoWebGlyph.Info) {
    val colors = LocalRagentColors.current
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        AgentoWebIcon(glyph, null, Modifier.padding(top = 2.dp).size(16.dp), tint = colors.secondaryContent)
        Text(text, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
    }
}

@Composable
internal fun ManagementField(value: String, onChange: (String) -> Unit, label: String,
    enabled: Boolean, inputModifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    OutlinedTextField(value, onChange, modifier = Modifier.fillMaxWidth().then(inputModifier),
        enabled = enabled, singleLine = true, shape = RoundedCornerShape(12.dp),
        textStyle = MaterialTheme.typography.bodyMedium,
        label = { Text(label, style = MaterialTheme.typography.bodySmall) },
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = colors.accentPrimary,
            unfocusedBorderColor = colors.primaryContent.copy(alpha = 0.15f),
            focusedTextColor = colors.primaryContent, unfocusedTextColor = colors.primaryContent,
            focusedLabelColor = colors.accentPrimary, unfocusedLabelColor = colors.secondaryContent,
            focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
            cursorColor = colors.accentPrimary))
}

@Composable
internal fun ManagementAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, secondary: Boolean = true,
    emphasized: Boolean = false) {
    val colors = LocalRagentColors.current
    if (secondary) {
        TextButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp),
            shape = CircleShape, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = if (emphasized) colors.accentPrimary else colors.secondaryContent,
                disabledContentColor = colors.disabledContent)) {
            Text(text, style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp))
        }
    } else AgentoButton(text, onClick, modifier, enabled = enabled,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
        labelStyle = MaterialTheme.typography.labelLarge)
}
