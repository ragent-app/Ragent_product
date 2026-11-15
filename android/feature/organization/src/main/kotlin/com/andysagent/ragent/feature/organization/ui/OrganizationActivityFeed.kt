package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.RagentonversationTypography
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSpacing
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.domain.CommunicationType
import com.andysagent.ragent.feature.organization.presentation.ActivityFeedItemUiState

@Composable
fun OrganizationActivityFeed(
    items: List<ActivityFeedItemUiState>,
    isExpanded: Boolean,
    onToggleExpanded: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(AgentoShapes.SurfaceMediumShape)
            .background(colors.quietSurface.copy(alpha = 0.92f))
            .padding(AgentoSpacing.md),
    ) {
        // Toggle bar header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggleExpanded),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(colors.running),
                )
                Spacer(modifier = Modifier.width(AgentoSpacing.sm))
                Text(
                    text = "Recent Activity",
                    style = RagentonversationTypography.BodyStrong,
                    color = colors.primaryContent,
                )
            }

            Text(
                text = if (isExpanded) "Collapse" else "${items.size} updates",
                style = RagentonversationTypography.Meta,
                color = colors.secondaryContent,
            )
        }

        AnimatedVisibility(
            visible = isExpanded,
            enter = expandVertically(),
            exit = shrinkVertically(),
        ) {
            Column(modifier = Modifier.padding(top = AgentoSpacing.sm)) {
                if (items.isEmpty()) {
                    Text(
                        text = "No recent organization activity",
                        style = RagentonversationTypography.Meta,
                        color = colors.tertiaryContent,
                        modifier = Modifier.padding(vertical = AgentoSpacing.sm),
                    )
                } else {
                    items.take(6).forEach { item ->
                        ActivityRow(item)
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityRow(item: ActivityFeedItemUiState) {
    val colors = LocalRagentColors.current
    val accent = when (item.type) {
        CommunicationType.BLOCKER_ESCALATED -> colors.error
        CommunicationType.RESULT_AVAILABLE -> colors.success
        CommunicationType.REVIEW_REQUESTED, CommunicationType.REVIEW_COMPLETED -> colors.waiting
        else -> colors.running
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(4.dp)
                .clip(CircleShape)
                .background(accent),
        )
        Spacer(modifier = Modifier.width(AgentoSpacing.sm))
        Text(
            text = item.message,
            style = RagentonversationTypography.Meta,
            color = colors.primaryContent,
            modifier = Modifier.weight(1f),
        )
        Spacer(modifier = Modifier.width(AgentoSpacing.sm))
        Text(
            text = item.timeAgo,
            style = RagentonversationTypography.Meta.copy(fontSize = 11.sp),
            color = colors.tertiaryContent,
        )
    }
}
