package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.constrainWidth
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoPressScale
import kotlin.math.floor
import kotlin.math.roundToInt

/** A single retained selection surface follows the same transition as the page. */
@Composable
internal fun RunSheetTabs(
    selectedTab: RunSheetTab,
    selection: State<Float>,
    stacked: Boolean,
    fileCount: Int,
    traceCount: Int,
    onSelect: (RunSheetTab) -> Unit,
) {
    val colors = LocalRagentColors.current
    val dark = colors.canvas.red < 0.5f
    Layout(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp))
            .drawBehind {
                val inset = 4.dp.toPx().coerceAtMost(size.height / 2f)
                drawRoundRect(colors.secondaryContent.copy(alpha = if (dark) .08f else .045f),
                    topLeft = Offset(0f, inset), size = Size(size.width, size.height - inset * 2),
                    cornerRadius = CornerRadius(24.dp.toPx()))
            }
            .then(if (stacked) Modifier.horizontalScroll(rememberScrollState()) else Modifier)
            .padding(3.dp),
        content = {
            Box(Modifier.testTag("run-details-selection").clip(RoundedCornerShape(21.dp))
                .background(colors.primaryContent.copy(alpha = if (dark) .10f else .055f)))
            RunSheetTab.entries.forEach { tab ->
                val active = selectedTab == tab
                Surface(
                    color = Color.Transparent,
                    contentColor = if (active) colors.primaryContent else colors.secondaryContent,
                    shape = RoundedCornerShape(21.dp),
                    modifier = Modifier.testTag("run-details-tab-${tab.name}")
                        .agentoPressScale(pressedScale = 0.98f, onClick = { onSelect(tab) }).semantics {
                        role = Role.Tab
                        selected = active
                    },
                ) {
                    // Compact visual lens, with the established full touch row.
                    Box(Modifier.heightIn(min = 48.dp)
                        .padding(horizontal = if (stacked) 16.dp else 0.dp, vertical = 7.dp),
                        contentAlignment = Alignment.Center) {
                        Text(
                            modifier = Modifier.testTag("run-details-tab-label-${tab.name}"),
                            text = when (tab) {
                                RunSheetTab.Metrics -> stringResource(R.string.run_details_metrics)
                                RunSheetTab.Files -> stringResource(R.string.run_details_files, fileCount)
                                RunSheetTab.Trace -> stringResource(R.string.run_details_trace, traceCount)
                            },
                            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp,
                                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium),
                            maxLines = 1,
                            softWrap = false,
                        )
                    }
                }
            }
        },
    ) { measurables, constraints ->
        val gap = 4.dp.roundToPx()
        val equalWidth = if (stacked) null else (constraints.maxWidth - gap * 2).coerceAtLeast(0) / 3
        val tabs = measurables.drop(1).mapIndexed { index, measurable ->
            val width = equalWidth?.let { if (index == 2) constraints.maxWidth - gap * 2 - it * 2 else it }
            measurable.measure(if (width == null) constraints.copy(minWidth = 0, minHeight = 0)
                else constraints.copy(minWidth = width, maxWidth = width, minHeight = 0))
        }
        val offsets = tabs.runningFold(0) { x, tab -> x + tab.width + gap }.dropLast(1)
        val position = selection.value.coerceIn(0f, 2f)
        val from = floor(position).toInt()
        val to = (from + 1).coerceAtMost(2)
        val fraction = position - from
        val x = (offsets[from] + (offsets[to] - offsets[from]) * fraction).roundToInt()
        val width = (tabs[from].width + (tabs[to].width - tabs[from].width) * fraction).roundToInt()
        val height = tabs.maxOf { it.height }
        val visualInset = 4.dp.roundToPx().coerceAtMost(height / 2)
        val indicator = measurables.first().measure(Constraints.fixed(width, height - visualInset * 2))
        layout(constraints.constrainWidth(tabs.sumOf { it.width } + gap * 2), constraints.constrainHeight(height)) {
            indicator.placeRelative(x, visualInset)
            tabs.forEachIndexed { index, tab -> tab.placeRelative(offsets[index], (height - tab.height) / 2) }
        }
    }
}
