package com.andysagent.ragent.feature.workbench

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoDivider
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.designsystem.LocalRagentColors

@Composable
fun SubscriptionInfoScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(colors.canvas),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 440.dp)
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars.only(WindowInsetsSides.Top))
                .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentoIconButton(
                    onClick = onBack,
                    contentDescription = "Back to connection",
                ) {
                    AgentoWebIcon(AgentoWebGlyph.Back, contentDescription = null)
                }
            }

            Spacer(Modifier.height(40.dp))
            Text(
                text = "MORE DEVICES,\nONE ACCOUNT",
                style = MaterialTheme.typography.labelMedium.copy(
                    fontSize = 12.sp,
                    lineHeight = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = colors.tertiaryContent,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = "Upgrade to Pro",
                style = MaterialTheme.typography.headlineMedium.copy(
                    fontSize = 30.sp,
                    lineHeight = 36.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = colors.primaryContent,
                textAlign = TextAlign.Center,
                modifier = Modifier.semantics { heading() },
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = "Connect more phones and computers to the same Ragent account. Pro is coming soon.",
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
                color = colors.secondaryContent,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 336.dp),
            )
            Spacer(Modifier.height(32.dp))
            SubscriptionInfoGroup {
                SubscriptionInfoRow(
                    title = "More phone connections",
                    detail = "Keep your mobile surfaces signed in to one account.",
                    glyph = AgentoWebGlyph.Device,
                    tint = LocalRagentColors.current.accentPrimary,
                )
                AgentoDivider(modifier = Modifier.padding(start = 76.dp))
                SubscriptionInfoRow(
                    title = "More computer connections",
                    detail = "Reach the computers you use for work without replacing an existing link.",
                    glyph = AgentoWebGlyph.Monitor,
                    tint = Color(0xFF5E5CE6),
                )
                AgentoDivider(modifier = Modifier.padding(start = 76.dp))
                SubscriptionInfoRow(
                    title = "Account-level device management",
                    detail = "Manage the devices connected to your Ragent account.",
                    glyph = AgentoWebGlyph.Settings,
                    tint = Color(0xFF34C759),
                )
            }
            Spacer(Modifier.height(28.dp))
            AgentoButton(
                text = "Back to connection",
                onClick = onBack,
                modifier = Modifier.fillMaxWidth(),
                secondary = true,
                leadingIcon = { AgentoWebIcon(AgentoWebGlyph.Back, contentDescription = null) },
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = "Subscription and payment are not available yet.",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, lineHeight = 17.sp),
                color = colors.tertiaryContent,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SubscriptionInfoGroup(
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = LocalRagentColors.current
    val groupShape = RoundedCornerShape(22.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(groupShape)
            .background(colors.quietSurface),
        content = content,
    )
}

@Composable
private fun SubscriptionInfoRow(
    title: String,
    detail: String,
    glyph: AgentoWebGlyph,
    tint: Color,
) {
    val colors = LocalRagentColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(13.dp))
                .background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            AgentoWebIcon(
                glyph = glyph,
                contentDescription = null,
                modifier = Modifier.size(21.dp),
                tint = tint,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium.copy(
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = colors.primaryContent,
            )
            Spacer(Modifier.height(3.dp))
            Text(
                text = detail,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.5.sp, lineHeight = 18.sp),
                color = colors.secondaryContent,
            )
        }
    }
}

@Preview(name = "Subscription info", showBackground = true, widthDp = 390, heightDp = 844)
@Composable
private fun SubscriptionInfoScreenPreview() {
    RagentTheme {
        SubscriptionInfoScreen(onBack = {})
    }
}
