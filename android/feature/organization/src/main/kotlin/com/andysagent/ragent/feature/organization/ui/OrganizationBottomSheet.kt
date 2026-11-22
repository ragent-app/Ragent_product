package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.RagentapsuleGlassBox
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.domain.NodeRole
import com.andysagent.ragent.feature.organization.domain.NodeRuntimeState
import com.andysagent.ragent.feature.organization.presentation.NodeDetailUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OrganizationBottomSheet(node: NodeDetailUiState, onDismiss: () -> Unit, onViewDetails: () -> Unit, onSendInstruction: (() -> Unit)? = null) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val colors = LocalRagentColors.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, containerColor = Color.Transparent,
        dragHandle = null, shape = AgentoShapes.BottomSheetShape, scrimColor = colors.glassScrim.copy(alpha = .2f)) {
        RagentapsuleGlassBox(modifier = Modifier.fillMaxWidth(), shape = AgentoShapes.BottomSheetShape) {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 16.dp)) {
                Box(Modifier.align(Alignment.CenterHorizontally).padding(top = 12.dp, bottom = 16.dp).size(width = 36.dp, height = 4.dp).clip(CircleShape).background(colors.secondaryContent.copy(alpha = .32f)))
                Text(node.displayName, color = colors.primaryContent, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium)
                val role = when (node.role) {
                    NodeRole.EXECUTIVE -> R.string.organization_role_lead
                    NodeRole.MANAGER -> R.string.organization_role_manager
                    NodeRole.PHASE_LEAD -> R.string.org_detail_role_phase_lead
                    NodeRole.REVIEWER -> R.string.organization_role_reviewer
                    NodeRole.EXPERT -> R.string.organization_role_expert
                    NodeRole.WORKER -> R.string.organization_role_member
                    NodeRole.WRITER -> R.string.org_detail_role_writer
                    NodeRole.UNKNOWN -> R.string.org_detail_role_unknown
                }
                val state = when (node.runtimeState) {
                    NodeRuntimeState.WORKING -> R.string.organization_node_working
                    NodeRuntimeState.WAITING -> R.string.organization_node_waiting
                    NodeRuntimeState.BLOCKED -> R.string.organization_node_blocked
                    NodeRuntimeState.REVIEWING -> R.string.organization_node_reviewing
                    NodeRuntimeState.DONE -> R.string.organization_node_done
                    NodeRuntimeState.FAILED -> R.string.organization_node_failed
                    NodeRuntimeState.PROVISIONING -> R.string.organization_node_provisioning
                    NodeRuntimeState.PAUSED -> R.string.organization_node_paused
                    NodeRuntimeState.IDLE -> R.string.organization_node_idle
                }
                Text(stringResource(role) + " · " + stringResource(state), Modifier.padding(top = 4.dp), color = colors.secondaryContent, fontSize = 13.sp, lineHeight = 20.sp)
                node.professionName?.let { DetailSection(stringResource(R.string.org_detail_profession), it) }
                DetailSection(stringResource(R.string.organization_task_label), node.currentTaskSummary?.takeIf { it.isNotBlank() } ?: stringResource(R.string.organization_no_task))
                if (!node.currentActivity.isNullOrBlank()) DetailSection(stringResource(R.string.organization_activity_label), node.currentActivity)
                if (node.progressTotal > 0) DetailSection(stringResource(R.string.organization_progress), "${node.progressCompleted} / ${node.progressTotal}")
                if (!node.blockerText.isNullOrBlank()) DetailSection(stringResource(R.string.organization_blocker), node.blockerText)
                if (!node.failureCode.isNullOrBlank() && node.failureCode != node.blockerText) {
                    DetailSection(stringResource(R.string.organization_failure_code), node.failureCode)
                }
                if (!node.resultPacketSummary.isNullOrBlank()) {
                    val value = buildString {
                        append(node.resultPacketSummary)
                        node.resultPacketId?.takeIf { id ->
                            id.isNotBlank() && node.resultPacketSummary != "ResultPacket: $id" && !node.resultPacketSummary.contains(id)
                        }?.let { append(" ($it)") }
                    }
                    DetailSection(stringResource(R.string.organization_result_packet), value)
                }
                node.reviewState?.trim()?.takeIf { it.isNotEmpty() && !it.equals("not_applicable", ignoreCase = true) }?.let { raw ->
                    val label = organizationReviewStateRes(raw)?.let { stringResource(it) } ?: raw
                    DetailSection(stringResource(R.string.org_detail_review), label)
                }
                if (!node.harness.isNullOrBlank()) {
                    DetailSection(stringResource(R.string.organization_harness), node.harness)
                }
                if (node.changedFiles.isNotEmpty()) DetailSection(stringResource(R.string.organization_files), node.changedFiles.joinToString("\n"))
                Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (node.isRootLeader && onSendInstruction != null) {
                        AgentoButton(text = stringResource(R.string.organization_send_instruction), onClick = { onDismiss(); onSendInstruction() }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                    }
                    AgentoButton(text = stringResource(R.string.organization_details), onClick = onViewDetails, modifier = Modifier.weight(1f).heightIn(min = 48.dp), secondary = true)
                }
            }
        }
    }
}

@Composable
private fun DetailSection(label: String, value: String) {
    val colors = LocalRagentColors.current
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text(label, color = colors.secondaryContent, fontSize = 13.sp, lineHeight = 20.sp)
        Text(value, color = colors.primaryContent, fontSize = 13.sp, lineHeight = 20.sp)
    }
}

internal fun organizationReviewStateRes(reviewState: String?): Int? = when (reviewState?.trim()?.lowercase()) {
    "needs_changes" -> R.string.organization_review_needs_changes
    "rejected" -> R.string.organization_review_rejected
    "passed", "complete", "completed" -> R.string.organization_review_passed
    "pending" -> R.string.organization_review_pending
    else -> null
}
