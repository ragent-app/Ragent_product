package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import com.andysagent.ragent.core.designsystem.AgentoSwitch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.layer.GraphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoFrostedModalBottomSheet
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.model.RuntimeCatalog

/**
 * TaskSettingsSheet: Low-frequency configuration modal sheet.
 *
 * Consolidates Agent/runtime, Model, Reasoning effort, Session Goal, and Service tier
 * into one quiet, out-of-the-way bottom sheet so they do not compete with the composer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskSettingsSheet(
    onDismiss: () -> Unit,
    runtimeCatalog: RuntimeCatalog,
    runtimeTool: String,
    onSelectRuntime: (String) -> Unit,
    runtimeModel: String?,
    onSelectModel: (String) -> Unit,
    effort: Float,
    onEffortChange: (Float) -> Unit,
    goalMode: Boolean,
    goalText: String,
    onToggleGoalMode: (Boolean) -> Unit,
    onGoalChange: (String) -> Unit,
    serviceTier: String,
    onSelectServiceTier: (String) -> Unit,
    modifier: Modifier = Modifier,
    backdropLayer: GraphicsLayer? = null,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    AgentoFrostedModalBottomSheet(
        onDismissRequest = onDismiss,
        backdropLayer = backdropLayer,
        modifier = modifier,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // Sheet Header
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "Task settings",
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 17.sp,
                    ),
                    color = colors.primaryContent,
                )

                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(if (isDark) Color(0x1FFFFFFF) else Color(0x0F000000))
                        .clickable(onClick = onDismiss),
                    contentAlignment = Alignment.Center,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Close,
                        contentDescription = "Close settings",
                        modifier = Modifier.size(16.dp),
                        tint = colors.secondaryContent,
                    )
                }
            }

            // 1. Runtime / Agent selector
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = "Agent runtime",
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.secondaryContent,
                )
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val tools = runtimeCatalog.tools.ifEmpty {
                        listOf(
                            com.andysagent.ragent.core.model.RuntimeToolOption(id = "codex", label = "Codex"),
                            com.andysagent.ragent.core.model.RuntimeToolOption(id = "claude", label = "Claude"),
                        )
                    }
                    tools.forEach { tool ->
                        val selected = tool.id.equals(runtimeTool, ignoreCase = true)
                        Surface(
                            shape = RoundedCornerShape(10.dp),
                            color = if (selected) colors.actionPrimary else if (isDark) Color(0xFF27272A) else Color(0xFFF4F4F5),
                            modifier = Modifier.clickable { onSelectRuntime(tool.id) },
                        ) {
                            Text(
                                text = tool.label,
                                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium),
                                color = if (selected) colors.actionPrimaryContent else colors.primaryContent,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                            )
                        }
                    }
                }
            }

            // 2. Model selection
            val selectedTool = runtimeCatalog.tools.firstOrNull { it.id.equals(runtimeTool, ignoreCase = true) }
            val availableModels = selectedTool?.models.orEmpty()
            if (availableModels.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Model",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.secondaryContent,
                    )
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        availableModels.forEach { model ->
                            val selected = model.id.equals(runtimeModel, ignoreCase = true)
                            Surface(
                                shape = RoundedCornerShape(10.dp),
                                color = if (selected) colors.actionPrimary else if (isDark) Color(0xFF27272A) else Color(0xFFF4F4F5),
                                modifier = Modifier.clickable { onSelectModel(model.id) },
                            ) {
                                Text(
                                    text = model.label,
                                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Medium),
                                    color = if (selected) colors.actionPrimaryContent else colors.primaryContent,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }
                }
            }

            // 3. Reasoning effort
            val effortLevels = runtimeCatalog.tools.firstOrNull { it.id == runtimeTool }?.models
                ?.firstOrNull { it.id == runtimeModel }?.effortLevels.orEmpty()
            if (effortLevels.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val lastStop = effortLevels.lastIndex
                val index = kotlin.math.round(effort.coerceIn(0f, 1f) * lastStop).toInt()
                val effortLabel = effortLevels[index]
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = "Reasoning effort",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.secondaryContent,
                    )
                    Text(
                        text = effortLabel,
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.accentPrimary,
                    )
                }

                Slider(
                    value = effort,
                    onValueChange = { onEffortChange(if (lastStop == 0) 0f else kotlin.math.round(it * lastStop) / lastStop) },
                    valueRange = 0f..1f,
                    steps = (lastStop - 1).coerceAtLeast(0),
                    enabled = lastStop > 0,
                    colors = SliderDefaults.colors(
                        thumbColor = colors.accentPrimary,
                        activeTrackColor = colors.accentPrimary,
                    ),
                )
            }

            // 4. Session Goal
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text(
                            text = "Session Goal",
                            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.primaryContent,
                        )
                        Text(
                            text = "Keep agent focused on overarching objective",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.secondaryContent,
                        )
                    }
                    AgentoSwitch(
                        checked = goalMode,
                        onCheckedChange = onToggleGoalMode,
                    )
                }

                if (goalMode) {
                    var localGoal by remember(goalText) { mutableStateOf(goalText) }
                    OutlinedTextField(
                        value = localGoal,
                        onValueChange = {
                            localGoal = it
                            onGoalChange(it)
                        },
                        placeholder = { Text("Describe the session goal…") },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(10.dp),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = colors.accentPrimary,
                            unfocusedBorderColor = if (isDark) Color(0x33FFFFFF) else Color(0x22000000),
                        ),
                        singleLine = false,
                        maxLines = 3,
                    )
                }
            }

            // 5. Service tier / Fast responses
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(
                        text = "Fast response tier",
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.primaryContent,
                    )
                    Text(
                        text = "Optimize for latency rather than maximum reasoning depth",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.secondaryContent,
                    )
                }
                AgentoSwitch(
                    checked = serviceTier.equals("fast", ignoreCase = true),
                    onCheckedChange = { isFast ->
                        onSelectServiceTier(if (isFast) "fast" else "standard")
                    },
                )
            }

            Spacer(Modifier.height(16.dp))
        }
    }
}
