package com.andysagent.ragent.feature.organization.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.IntSize
import androidx.compose.animation.core.FiniteAnimationSpec
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.MotionPreference
import com.andysagent.ragent.core.designsystem.motionPolicy
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.presentation.ActivityFeedItemUiState

@Composable
fun OrganizationActivityFeed(items: List<ActivityFeedItemUiState>, isExpanded: Boolean, onToggleExpanded: () -> Unit, modifier: Modifier = Modifier, reduceMotion: Boolean = false) {
    val colors = LocalRagentColors.current
    val motion = if (reduceMotion && motionPolicy().preference == MotionPreference.Full) MotionPreference.Reduced else motionPolicy().preference
    val animation: FiniteAnimationSpec<IntSize> = when (motion) {
        MotionPreference.Full -> spring(dampingRatio = .88f, stiffness = 320f)
        else -> tween(durationMillis = 0)
    }
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(26.dp)).background(colors.quietSurface)
        .animateContentSize(animationSpec = animation).padding(18.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(R.string.organization_activity), color = colors.primaryContent, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium)
            Box(Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).clickable(onClick = onToggleExpanded), contentAlignment = Alignment.Center) {
                Text(stringResource(if (isExpanded) R.string.organization_collapse else R.string.organization_expand), color = colors.secondaryContent, fontSize = 13.sp)
            }
        }
        if (items.isEmpty()) {
            Text(stringResource(R.string.organization_activity_empty), color = colors.secondaryContent, fontSize = 13.sp, lineHeight = 20.sp)
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items.take(2).forEach { item ->
                    ActivityItem(item)
                }
                AnimatedVisibility(visible = isExpanded && items.size > 2,
                    enter = if (motion == MotionPreference.Reduced) fadeIn(tween(100)) else EnterTransition.None,
                    exit = if (motion == MotionPreference.Reduced) fadeOut(tween(100)) else ExitTransition.None) {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items.drop(2).take(4).forEach { item -> ActivityItem(item) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityItem(item: ActivityFeedItemUiState) {
    val colors = LocalRagentColors.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(item.message, Modifier.weight(1f), color = colors.primaryContent, fontSize = 13.sp, lineHeight = 20.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (item.timeAgo.isNotBlank()) Text(item.timeAgo, color = colors.secondaryContent, fontSize = 11.sp)
    }
}
