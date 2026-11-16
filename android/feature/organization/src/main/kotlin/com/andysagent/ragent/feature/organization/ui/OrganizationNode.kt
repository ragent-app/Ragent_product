package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.rememberAgentoPressScale
import com.andysagent.ragent.feature.organization.domain.AgentDomain
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState
import com.andysagent.ragent.feature.organization.R
import kotlin.math.roundToInt

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OrganizationNode(node: RenderedNodeUiState, onClick: () -> Unit, onDoubleTap: () -> Unit = {}, modifier: Modifier = Modifier, showLabel: Boolean = true) {
    val colors = LocalRagentColors.current
    val density = LocalDensity.current
    val dark = colors.canvas.luminance() < .5f
    val english = !LocalConfiguration.current.locales[0].language.equals("zh", ignoreCase = true)
    val accent = when {
        node.role == NodeRole.EXECUTIVE -> if (dark) listOf(Color(0xFFADC1E5), Color(0xFFBAC1E9), Color(0xFFC5BEE5)) else listOf(Color(0xFF657AA5), Color(0xFF6E76A6), Color(0xFF7B73A1))
        node.role == NodeRole.REVIEWER -> if (dark) listOf(Color(0xFFC5B58F), Color(0xFFCBB69B), Color(0xFFD0B7A8)) else listOf(Color(0xFF958263), Color(0xFF9B846C), Color(0xFFA08776))
        node.role == NodeRole.MANAGER -> if (dark) listOf(Color(0xFF95B2BE), Color(0xFF9EB0BC), Color(0xFFA8ADBB)) else listOf(Color(0xFF6F8997), Color(0xFF798696), Color(0xFF838293))
        node.domain == AgentDomain.ANDROID -> if (dark) listOf(Color(0xFF92B6D5), Color(0xFF9FB2D4), Color(0xFFAEAED0)) else listOf(Color(0xFF6487A8), Color(0xFF6E84A6), Color(0xFF7A80A1))
        else -> if (dark) listOf(Color(0xFF98BCAF), Color(0xFFA6BCAB), Color(0xFFB2BCA8)) else listOf(Color(0xFF64887F), Color(0xFF6E887C), Color(0xFF7A8A78))
    }
    val glyph = when {
        node.isCluster -> "+${node.clusterCount}"
        node.role == NodeRole.EXECUTIVE -> if (english) "L" else "领"
        node.role == NodeRole.MANAGER -> if (english) "P" else "规"
        node.role == NodeRole.REVIEWER -> if (english) "R" else "审"
        node.domain == AgentDomain.ANDROID -> if (english) "A" else "前"
        node.domain == AgentDomain.BACKEND -> if (english) "B" else "后"
        else -> if (english) "M" else "员"
    }
    val status = when (node.runtimeState) {
        NodeRuntimeState.WORKING -> stringResource(R.string.organization_node_working)
        NodeRuntimeState.WAITING -> stringResource(R.string.organization_node_waiting)
        NodeRuntimeState.BLOCKED -> stringResource(R.string.organization_node_blocked)
        NodeRuntimeState.REVIEWING -> stringResource(R.string.organization_node_reviewing)
        NodeRuntimeState.DONE -> stringResource(R.string.organization_node_done)
        NodeRuntimeState.FAILED -> stringResource(R.string.organization_node_failed)
        NodeRuntimeState.PAUSED -> stringResource(R.string.organization_node_paused)
        NodeRuntimeState.PROVISIONING -> stringResource(R.string.organization_node_provisioning)
        NodeRuntimeState.IDLE -> stringResource(R.string.organization_node_idle)
    }
    val interaction = remember { MutableInteractionSource() }
    val press by rememberAgentoPressScale(interaction)
    val diameter = if (node.role == NodeRole.EXECUTIVE) 64.dp else 56.dp
    Box(
        modifier = modifier.offset {
            IntOffset((node.x - with(density) { 32.dp.toPx() }).roundToInt(), (node.y - with(density) { 32.dp.toPx() }).roundToInt())
        }.size(64.dp).semantics { contentDescription = listOfNotNull(node.displayName, status, node.taskSummary, node.blockerText).joinToString("，") }
            .graphicsLayer { scaleX = node.scale * press; scaleY = node.scale * press; alpha = node.alpha }
            .combinedClickable(interactionSource = interaction, indication = null, onClick = onClick, onDoubleClick = onDoubleTap),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(diameter).clip(CircleShape).drawWithCache {
            val brush = Brush.linearGradient(
                0f to accent[0], .55f to accent[1], 1f to accent[2],
                start = Offset(size.width * .12f, size.height * .08f),
                end = Offset(size.width * .88f, size.height * .92f),
            )
            onDrawBehind { drawRect(brush) }
        }, contentAlignment = Alignment.Center) {
            Text(glyph, color = colors.canvas, fontSize = (if (node.isCluster) 20 else if (node.role == NodeRole.EXECUTIVE) 28 else 26).sp, fontWeight = FontWeight.Bold)
        }
        val stateColor = when (node.runtimeState) {
            NodeRuntimeState.WORKING, NodeRuntimeState.REVIEWING -> colors.running
            NodeRuntimeState.BLOCKED, NodeRuntimeState.FAILED -> colors.error
            NodeRuntimeState.DONE -> colors.success
            else -> colors.secondaryContent
        }
        if (node.runtimeState != NodeRuntimeState.IDLE) {
            Box(Modifier.align(Alignment.BottomEnd).padding(if (node.role == NodeRole.EXECUTIVE) 4.dp else 6.dp)
                .size(11.dp).clip(CircleShape).background(colors.canvas), contentAlignment = Alignment.Center) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(stateColor))
            }
        }
    }
}
