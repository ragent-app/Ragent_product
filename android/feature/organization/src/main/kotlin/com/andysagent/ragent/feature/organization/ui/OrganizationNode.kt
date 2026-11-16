package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
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
    val visual = nodeVisual(node)
    val accent = when (visual.family) {
        NodeColorFamily.PURPLE -> if (dark) listOf(Color(0xFFADC1E5), Color(0xFFBAC1E9), Color(0xFFC5BEE5)) else listOf(Color(0xFF657AA5), Color(0xFF6E76A6), Color(0xFF7B73A1))
        NodeColorFamily.WARM -> if (dark) listOf(Color(0xFFC5B58F), Color(0xFFCBB69B), Color(0xFFD0B7A8)) else listOf(Color(0xFF958263), Color(0xFF9B846C), Color(0xFFA08776))
        NodeColorFamily.GREY -> if (dark) listOf(Color(0xFF95B2BE), Color(0xFF9EB0BC), Color(0xFFA8ADBB)) else listOf(Color(0xFF6F8997), Color(0xFF798696), Color(0xFF838293))
        NodeColorFamily.BLUE -> if (dark) listOf(Color(0xFF92B6D5), Color(0xFF9FB2D4), Color(0xFFAEAED0)) else listOf(Color(0xFF6487A8), Color(0xFF6E84A6), Color(0xFF7A80A1))
        NodeColorFamily.GREEN -> if (dark) listOf(Color(0xFF98BCAF), Color(0xFFA6BCAB), Color(0xFFB2BCA8)) else listOf(Color(0xFF64887F), Color(0xFF6E887C), Color(0xFF7A8A78))
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
    val roleDescription = if (node.isCluster) stringResource(R.string.organization_member_count, node.clusterCount) else stringResource(when (node.role) {
        NodeRole.EXECUTIVE -> R.string.org_detail_role_lead
        NodeRole.MANAGER -> R.string.org_detail_role_manager
        NodeRole.PHASE_LEAD -> R.string.org_detail_role_phase_lead
        NodeRole.WORKER -> R.string.org_detail_role_worker
        NodeRole.WRITER -> R.string.org_detail_role_writer
        NodeRole.REVIEWER -> R.string.org_detail_role_reviewer
        NodeRole.EXPERT -> R.string.org_detail_role_expert
        NodeRole.UNKNOWN -> R.string.org_detail_role_unknown
    })
    val interaction = remember { MutableInteractionSource() }
    val press by rememberAgentoPressScale(interaction)
    val diameter = (node.radiusDp * 2f).dp
    val touchSize = maxOf(diameter, 64.dp)
    val radius = node.radiusDp.coerceIn(24f, 36f)
    val iconSize = when {
        radius < 26f -> 22f + (radius - 24f)
        radius < 28f -> 24f
        radius < 32f -> 24f + (radius - 28f)
        else -> 28f + (radius - 32f)
    }.dp
    Box(
        modifier = modifier.offset {
            val half = with(density) { touchSize.toPx() / 2f }
            IntOffset((node.x - half).roundToInt(), (node.y - half).roundToInt())
        }.size(touchSize).semantics { contentDescription = listOfNotNull(node.displayName, roleDescription, node.professionName, status, node.taskSummary, node.blockerText).joinToString("，") }
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
            if (node.isCluster) {
                Text("+${node.clusterCount}", color = colors.canvas, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            } else {
                Icon(painterResource(visual.icon), contentDescription = null, tint = colors.canvas,
                    modifier = Modifier.size(iconSize))
            }
        }
        val stateColor = when (node.runtimeState) {
            NodeRuntimeState.WORKING, NodeRuntimeState.REVIEWING -> colors.running
            NodeRuntimeState.BLOCKED, NodeRuntimeState.FAILED -> colors.error
            NodeRuntimeState.DONE -> colors.success
            else -> colors.secondaryContent
        }
        if (node.runtimeState != NodeRuntimeState.IDLE) {
            Box(Modifier.align(Alignment.Center).offset(x = (node.radiusDp * .70710678f).dp, y = (node.radiusDp * .70710678f).dp)
                .size(11.dp).clip(CircleShape).background(colors.canvas), contentAlignment = Alignment.Center) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(stateColor))
            }
        }
    }
}

private enum class NodeColorFamily { BLUE, PURPLE, GREEN, GREY, WARM }
private data class NodeVisual(val icon: Int, val family: NodeColorFamily)

private fun nodeVisual(node: RenderedNodeUiState): NodeVisual {
    when (node.role) {
        NodeRole.EXECUTIVE -> return NodeVisual(R.drawable.org_role_explore, NodeColorFamily.PURPLE)
        NodeRole.MANAGER -> return NodeVisual(R.drawable.org_role_route, NodeColorFamily.GREY)
        NodeRole.PHASE_LEAD -> return NodeVisual(R.drawable.org_role_flag, NodeColorFamily.GREY)
        NodeRole.REVIEWER -> return NodeVisual(R.drawable.org_role_find_in_page, NodeColorFamily.WARM)
        else -> Unit
    }
    if (!node.hasRecognizedDomain) return when (node.role) {
        NodeRole.EXPERT -> NodeVisual(R.drawable.org_role_psychology, NodeColorFamily.PURPLE)
        NodeRole.WORKER -> NodeVisual(R.drawable.org_role_construction, NodeColorFamily.GREEN)
        NodeRole.WRITER -> NodeVisual(R.drawable.org_role_edit_note, NodeColorFamily.BLUE)
        else -> NodeVisual(R.drawable.org_domain_person, NodeColorFamily.GREEN)
    }
    return when (node.domain) {
        AgentDomain.BACKEND -> NodeVisual(R.drawable.org_domain_dns, NodeColorFamily.BLUE)
        AgentDomain.MOBILE -> NodeVisual(R.drawable.org_domain_smartphone, NodeColorFamily.BLUE)
        AgentDomain.WEB -> NodeVisual(R.drawable.org_domain_web, NodeColorFamily.BLUE)
        AgentDomain.RUNTIME -> NodeVisual(R.drawable.org_domain_terminal, NodeColorFamily.BLUE)
        AgentDomain.ARCHITECTURE -> NodeVisual(R.drawable.org_domain_schema, NodeColorFamily.PURPLE)
        AgentDomain.DATABASE -> NodeVisual(R.drawable.org_domain_database, NodeColorFamily.GREEN)
        AgentDomain.DATA -> NodeVisual(R.drawable.org_domain_analytics, NodeColorFamily.BLUE)
        AgentDomain.AI -> NodeVisual(R.drawable.org_domain_auto_awesome, NodeColorFamily.BLUE)
        AgentDomain.CLOUD -> NodeVisual(R.drawable.org_domain_cloud, NodeColorFamily.BLUE)
        AgentDomain.NETWORK -> NodeVisual(R.drawable.org_domain_hub, NodeColorFamily.BLUE)
        AgentDomain.HARDWARE -> NodeVisual(R.drawable.org_domain_memory, NodeColorFamily.BLUE)
        AgentDomain.SECURITY -> NodeVisual(R.drawable.org_domain_shield, NodeColorFamily.PURPLE)
        AgentDomain.TESTING -> NodeVisual(R.drawable.org_domain_bug_report, NodeColorFamily.WARM)
        AgentDomain.DESIGN -> NodeVisual(R.drawable.org_domain_palette, NodeColorFamily.PURPLE)
        AgentDomain.PRODUCT -> NodeVisual(R.drawable.org_domain_category, NodeColorFamily.PURPLE)
        AgentDomain.RESEARCH -> NodeVisual(R.drawable.org_domain_science, NodeColorFamily.GREY)
        AgentDomain.WRITING -> NodeVisual(R.drawable.org_role_edit_note, NodeColorFamily.GREY)
        AgentDomain.TRANSLATION -> NodeVisual(R.drawable.org_domain_translate, NodeColorFamily.GREY)
        AgentDomain.EDUCATION -> NodeVisual(R.drawable.org_domain_school, NodeColorFamily.PURPLE)
        AgentDomain.BUSINESS -> NodeVisual(R.drawable.org_domain_work, NodeColorFamily.GREY)
        AgentDomain.FINANCE -> NodeVisual(R.drawable.org_domain_account_balance, NodeColorFamily.WARM)
        AgentDomain.LEGAL -> NodeVisual(R.drawable.org_domain_balance, NodeColorFamily.PURPLE)
        AgentDomain.HEALTH -> NodeVisual(R.drawable.org_domain_medical_services, NodeColorFamily.WARM)
        AgentDomain.MARKETING -> NodeVisual(R.drawable.org_domain_campaign, NodeColorFamily.WARM)
        AgentDomain.SALES -> NodeVisual(R.drawable.org_domain_storefront, NodeColorFamily.WARM)
        AgentDomain.PEOPLE -> NodeVisual(R.drawable.org_domain_groups, NodeColorFamily.GREEN)
        AgentDomain.OPERATIONS -> NodeVisual(R.drawable.org_domain_settings_suggest, NodeColorFamily.GREEN)
        AgentDomain.LOGISTICS -> NodeVisual(R.drawable.org_domain_local_shipping, NodeColorFamily.GREEN)
        AgentDomain.MEDIA -> NodeVisual(R.drawable.org_domain_movie, NodeColorFamily.WARM)
        AgentDomain.ENVIRONMENT -> NodeVisual(R.drawable.org_domain_eco, NodeColorFamily.GREEN)
        AgentDomain.ENGINEERING -> NodeVisual(R.drawable.org_domain_precision_manufacturing, NodeColorFamily.GREEN)
        AgentDomain.GENERAL -> NodeVisual(R.drawable.org_domain_person, NodeColorFamily.GREEN)
    }
}
