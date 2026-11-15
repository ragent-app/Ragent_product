package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*

/** Shared visual rhythm for the existing welcome, account and connection pages. */
@Composable
internal fun OnboardingPageContent(
    modifier: Modifier = Modifier,
    header: @Composable () -> Unit = { OnboardingWordmark() },
    footer: @Composable () -> Unit = {},
    content: @Composable ColumnScope.(compact: Boolean) -> Unit,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val compact = maxHeight < 640.dp || LocalDensity.current.fontScale > 1.3f
        Column(Modifier.fillMaxSize().padding(top = 8.dp)) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp).heightIn(min = 56.dp),
                contentAlignment = Alignment.Center) { header() }
            // Keep Back reachable while the body scrolls at larger font sizes.
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                Column(
                    modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                        .heightIn(min = maxHeight).padding(start = 24.dp, end = 24.dp, bottom = 16.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    Spacer(Modifier.height(0.dp))
                    Column(Modifier.fillMaxWidth().padding(vertical = if (compact) 24.dp else 40.dp),
                        horizontalAlignment = Alignment.CenterHorizontally) { content(compact) }
                    Box(Modifier.fillMaxWidth().heightIn(min = 48.dp), contentAlignment = Alignment.Center) { footer() }
                }
            }
        }
    }
}

@Composable
internal fun OnboardingWordmark() {
    Text("Ragent", style = RagentTextStyles.brandDisplay.copy(
        fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.5).sp,
    ), color = LocalRagentColors.current.primaryContent)
}

@Composable
internal fun OnboardingTextAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingIcon: AgentoWebGlyph? = null,
    quiet: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val tint = if (quiet) colors.secondaryContent else colors.accentPrimary
    TextButton(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 48.dp),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = tint),
    ) {
        leadingIcon?.let {
            AgentoWebIcon(it, null, Modifier.size(18.dp), tint = tint)
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyMedium.copy(
            fontSize = if (quiet) 13.sp else 14.sp, lineHeight = 20.sp,
            fontWeight = if (quiet) FontWeight.Normal else FontWeight.Medium,
        ), textAlign = TextAlign.Center)
    }
}

@Composable
internal fun OnboardingDeviceTile(
    phone: Boolean,
    size: Dp = 56.dp,
) {
    val colors = LocalRagentColors.current
    val dark = colors.canvas.red < 0.5f
    Box(
        Modifier.size(size).clip(RoundedCornerShape(16.dp))
            .background(if (dark) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.9f)),
        contentAlignment = Alignment.Center,
    ) {
        AgentoWebIcon(
            if (phone) AgentoWebGlyph.Device else AgentoWebGlyph.Monitor,
            null, Modifier.size(if (phone) 28.dp else 30.dp),
            tint = if (phone) {
                if (dark) Color(0xFFA39BFF) else Color(0xFF6559D9)
            } else colors.accentPrimary,
        )
    }
}

@Composable
internal fun OnboardingConnectionLine(modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    Box(modifier.height(2.dp).clip(RoundedCornerShape(50))
        .background(Brush.horizontalGradient(listOf(
            colors.accentPrimary.copy(alpha = 0.55f), Color(0xFF8A7EE8).copy(alpha = 0.7f),
        ))))
}
