package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.LocalMotionPolicy
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import kotlin.math.roundToInt

/** Never show a clipped line: foreground appears only when its whole line fits. */
internal fun searchDisclosureAlpha(revealed: Float, full: Float, padding: Float): Float =
    ((revealed - (full - padding * 5f / 6f)) / (padding * 5f / 6f).coerceAtLeast(1f)).coerceIn(0f, 1f)

@Composable
internal fun ProjectSearchDisclosure(
    visible: Boolean,
    query: String,
    onQueryChanged: (String) -> Unit,
    placeholder: String,
    tag: String,
) {
    val colors = LocalRagentColors.current
    val dark = colors.canvas.red < 0.5f
    val motion = LocalMotionPolicy.current
    val progress = animateFloatAsState(if (visible) 1f else 0f,
        tween(motion.duration(220), easing = FastOutSlowInEasing), label = "project_search_disclosure")
    val interactive = visible && progress.value >= 0.999f
    // The layout, surface and text remain mounted. Only allocated height and
    // optical visibility change; zero height includes the inter-row gap.
    Layout(modifier = Modifier.fillMaxWidth().clipToBounds().testTag(tag), content = {
        Surface(shape = RoundedCornerShape(16.dp),
            color = if (dark) Color(0xFF242730).copy(alpha = 0.90f) else Color.White.copy(alpha = 0.92f)) {}
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .graphicsLayer {
                    alpha = searchDisclosureAlpha(size.height * progress.value, size.height, 24.dp.toPx())
                }
                .padding(horizontal = 14.dp, vertical = 12.dp)
                .then(if (interactive) Modifier else Modifier.clearAndSetSemantics {})
                .testTag("$tag-foreground"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AgentoWebIcon(AgentoWebGlyph.Search, contentDescription = null, modifier = Modifier.size(16.dp),
                tint = if (dark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent)
            BasicTextField(
                value = query, onValueChange = onQueryChanged, enabled = interactive,
                modifier = Modifier.weight(1f), singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.primaryContent),
                cursorBrush = SolidColor(LocalRagentColors.current.accentPrimary),
                decorationBox = { inner ->
                    Box {
                        if (query.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyMedium,
                            color = if (dark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent)
                        inner()
                    }
                },
            )
        }
    }) { measurables, constraints ->
        val foreground = measurables[1].measure(Constraints(maxWidth = constraints.maxWidth))
        val p = progress.value.coerceIn(0f, 1f)
        val revealed = (foreground.height * p).roundToInt()
        val gap = (8.dp.toPx() * p).roundToInt()
        val surface = measurables[0].measure(Constraints.fixed(constraints.maxWidth, revealed))
        layout(constraints.maxWidth, revealed + gap) {
            surface.placeRelative(0, gap)
            foreground.placeRelative(0, gap + (revealed - foreground.height) / 2)
        }
    }
}
