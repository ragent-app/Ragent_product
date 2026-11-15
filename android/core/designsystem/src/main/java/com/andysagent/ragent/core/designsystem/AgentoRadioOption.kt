package com.andysagent.ragent.core.designsystem

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

/** A whole-row radio target; the empty circle stays visible for unselected options. */
@Composable
fun AgentoRadioOption(
    title: String,
    description: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val shape = AgentoShapes.SurfaceMediumShape
    Row(
        modifier.fillMaxWidth().heightIn(min = 72.dp)
            .clip(shape)
            .background(if (selected) colors.actionPrimary.copy(alpha = 0.08f) else colors.canvas)
            .border(if (selected) 2.dp else 1.dp,
                if (selected) colors.accentPrimary else colors.subtleOutline, shape)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .semantics(mergeDescendants = true) {}
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = selected,
            onClick = null,
            modifier = Modifier.size(24.dp).clearAndSetSemantics {},
            colors = RadioButtonDefaults.colors(
                selectedColor = colors.accentPrimary,
                unselectedColor = colors.secondaryContent,
            ),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = colors.primaryContent)
            Text(description, style = MaterialTheme.typography.bodySmall, color = colors.secondaryContent)
        }
    }
}

@Preview(name = "Compact light", widthDp = 320)
@Preview(name = "Expanded light", widthDp = 600)
@Composable
private fun RadioOptionsLightPreview() = RadioOptionsPreview(false)

@Preview(name = "Compact dark", widthDp = 320)
@Preview(name = "Expanded dark", widthDp = 600)
@Composable
private fun RadioOptionsDarkPreview() = RadioOptionsPreview(true)

@Composable
private fun RadioOptionsPreview(dark: Boolean) {
    RagentTheme(darkTheme = dark) {
        Column(Modifier.background(LocalRagentColors.current.canvas).padding(16.dp).selectableGroup(),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AgentoRadioOption("Long-term connection", "For everyday use", true, {})
            AgentoRadioOption("Temporary access", "10-minute access", false, {})
        }
    }
}
