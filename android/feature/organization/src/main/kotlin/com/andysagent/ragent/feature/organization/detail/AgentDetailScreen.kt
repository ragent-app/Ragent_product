package com.andysagent.ragent.feature.organization.detail

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoIconButton
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.NodeDetailUiState

@Composable
fun AgentDetailScreen(node: NodeDetailUiState, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    BackHandler(onBack = onBack)
    Column(modifier.fillMaxSize().background(colors.canvas).statusBarsPadding().navigationBarsPadding(), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 600.dp).fillMaxWidth().padding(horizontal = 20.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentoIconButton(onClick = onBack, contentDescription = stringResource(R.string.org_detail_back), modifier = Modifier.size(48.dp).background(colors.quietSurface, CircleShape)) {
                    AgentoWebIcon(AgentoWebGlyph.Back, contentDescription = null, modifier = Modifier.size(20.dp), tint = colors.primaryContent)
                }
                Spacer(Modifier.width(12.dp))
                Text(node.displayName, color = colors.primaryContent, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            }
            Text(stringResource(roleLabel(node.role)) + " · " + stringResource(stateLabel(node.runtimeState)), color = colors.secondaryContent, fontSize = 13.sp, lineHeight = 20.sp, modifier = Modifier.padding(top = 8.dp))
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                node.professionName?.let { value -> DetailSection(stringResource(R.string.org_detail_profession)) { DetailText(value) } }
                DetailSection(stringResource(R.string.org_detail_task)) {
                    DetailText(node.currentTaskSummary?.takeIf { it.isNotBlank() } ?: stringResource(R.string.org_detail_no_task))
                    node.currentTaskDetail?.takeIf { it.isNotBlank() }?.let { DetailText(it) }
                }
                node.currentActivity?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.org_detail_activity)) { DetailText(value) } }
                if (node.progressTotal > 0) DetailSection(stringResource(R.string.org_detail_progress)) { DetailText(stringResource(R.string.org_detail_progress_value, node.progressCompleted, node.progressTotal)) }
                if (node.testsTotal > 0) DetailSection(stringResource(R.string.org_detail_checks)) { DetailText(stringResource(R.string.org_detail_progress_value, node.testsPassed, node.testsTotal)) }
                if (node.changedFiles.isNotEmpty()) DetailSection(stringResource(R.string.org_detail_files)) { node.changedFiles.forEach { DetailText(it) } }
                node.resultPacketSummary?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.org_detail_result)) { DetailText(value) } }
                node.failureCode?.takeIf { it.isNotBlank() && it != node.blockerText }?.let { value ->
                    DetailSection(stringResource(R.string.organization_failure_code)) { DetailText(value) }
                }
                node.blockerText?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.org_detail_blocker)) { DetailText(value) } }
                node.harness?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.organization_harness)) { DetailText(value) } }
                node.workspaceBranch?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.organization_workspace_branch)) { DetailText(value) } }
                node.latestUpdateText?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.org_detail_update)) { DetailText(value) } }
                node.reviewState?.takeIf { it.isNotBlank() }?.let { value -> DetailSection(stringResource(R.string.org_detail_review)) { DetailText(value) } }
            }
        }
    }
}

@Composable
private fun DetailSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 24.dp)) {
        Text(title, color = LocalRagentColors.current.secondaryContent, fontSize = 12.sp, lineHeight = 18.sp)
        Spacer(Modifier.height(6.dp))
        content()
    }
}

@Composable
private fun DetailText(value: String) {
    Text(value, color = LocalRagentColors.current.primaryContent, fontSize = 15.sp, lineHeight = 24.sp)
}

private fun roleLabel(role: NodeRole): Int = when (role) {
    NodeRole.EXECUTIVE -> R.string.org_detail_role_lead
    NodeRole.MANAGER -> R.string.org_detail_role_manager
    NodeRole.PHASE_LEAD -> R.string.org_detail_role_phase_lead
    NodeRole.WORKER -> R.string.org_detail_role_worker
    NodeRole.WRITER -> R.string.org_detail_role_writer
    NodeRole.REVIEWER -> R.string.org_detail_role_reviewer
    NodeRole.EXPERT -> R.string.org_detail_role_expert
    NodeRole.UNKNOWN -> R.string.org_detail_role_unknown
}

private fun stateLabel(state: NodeRuntimeState): Int = when (state) {
    NodeRuntimeState.PROVISIONING -> R.string.org_detail_state_preparing
    NodeRuntimeState.IDLE -> R.string.org_detail_state_idle
    NodeRuntimeState.WORKING -> R.string.org_detail_state_working
    NodeRuntimeState.WAITING -> R.string.org_detail_state_waiting
    NodeRuntimeState.BLOCKED -> R.string.org_detail_state_blocked
    NodeRuntimeState.REVIEWING -> R.string.org_detail_state_reviewing
    NodeRuntimeState.DONE -> R.string.org_detail_state_done
    NodeRuntimeState.FAILED -> R.string.org_detail_state_failed
    NodeRuntimeState.PAUSED -> R.string.org_detail_state_paused
}
