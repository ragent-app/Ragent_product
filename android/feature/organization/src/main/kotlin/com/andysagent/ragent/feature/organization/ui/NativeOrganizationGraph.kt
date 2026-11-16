package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.data.NativeDelegationDto
import com.andysagent.ragent.feature.organization.data.BirthCue
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel

internal fun nativeNodeId(runId: String, delegationId: String) = "native:${runId.length}:$runId$delegationId"

/** Read-only visual projection of the authenticated session's native delegation snapshots.
 * The parent owns the subscription and scopes [records] to this root session.
 */
@Composable
fun NativeOrganizationGraph(
    transport: RagentTransport,
    sessionId: String,
    records: List<NativeDelegationDto>,
    birthCues: List<BirthCue> = emptyList(),
    modifier: Modifier = Modifier,
    onRootClick: (Rect) -> Unit,
    onRootAnchorChanged: (Rect?) -> Unit = {},
    onRootVisualChanged: (OrganizationRootVisual) -> Unit = {},
    revealRoot: Boolean = false,
    rootHidden: Boolean = false,
    programmaticOpen: Pair<String, String>? = null,
    onProgrammaticOpenConsumed: () -> Unit = {},
) {
    val repository = remember(transport, sessionId) { RealOrganizationRepository(RealOrganizationApi(transport)) }
    val key = remember(transport, sessionId) { "native-organization:$sessionId:${java.util.UUID.randomUUID()}" }
    val factory = remember(repository) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OrganizationViewModel(repository) as T
        }
    }
    val vm: OrganizationViewModel = viewModel(key = key, factory = factory)
    val rootId = remember(sessionId) { "native-root:$sessionId" }
    val rootName = stringResource(R.string.organization_native_root)
    val memberName = stringResource(R.string.organization_native_member)
    val distinct = remember(records) {
        records.groupBy { it.runId to it.delegationId }.mapNotNull { (_, versions) -> versions.maxByOrNull { it.updatedAt ?: it.startedAt ?: 0L } }
            .sortedWith(compareBy<NativeDelegationDto>({ it.startedAt ?: Long.MAX_VALUE }, { it.runId }, { it.delegationId }))
    }
    val nodes = remember(distinct, rootId, sessionId, rootName, memberName) {
        listOf(OrganizationNodeDto(id = rootId, role = "root", displayName = rootName, sessionId = sessionId)) +
            nativeDisplayNodes(distinct, rootId, memberName)
    }
    LaunchedEffect(nodes, sessionId, birthCues) {
        // This projection is held only in this ViewModel; no formal organization is created.
        vm.applyProjection(OrganizationProjectionDto(organizationId = "native:$sessionId", rootSessionId = sessionId, nodes = nodes, edges = nativeDisplayEdges(nodes)), birthCues = birthCues)
    }
    OrganizationScreen(vm, modifier = modifier, embedded = true, embeddedRootId = rootId,
        onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged,
        onRootVisualChanged = onRootVisualChanged, revealRoot = revealRoot, rootHidden = rootHidden,
        openNodeId = programmaticOpen?.let { nativeNodeId(it.first, it.second) },
        onOpenNodeConsumed = onProgrammaticOpenConsumed,
        conversationContent = { _, contentModifier ->
            Text(stringResource(R.string.organization_native_conversation_unavailable), contentModifier.padding(20.dp))
        })
}

/** Names are deliberately generic because native snapshots carry no member name or role. */
internal fun nativeDisplayNodes(records: List<NativeDelegationDto>, rootId: String, memberName: String): List<OrganizationNodeDto> {
    val distinct = records.groupBy { it.runId to it.delegationId }.mapNotNull { (_, versions) ->
        versions.maxByOrNull { it.updatedAt ?: it.startedAt ?: 0L }
    }.sortedWith(compareBy<NativeDelegationDto>({ it.startedAt ?: Long.MAX_VALUE }, { it.runId }, { it.delegationId }))
    val keys = distinct.map { it.runId to it.delegationId }.toSet()
    return distinct.mapIndexed { index, item ->
        val parent = item.parentDelegationId?.let { item.runId to it }
        OrganizationNodeDto(id = nativeNodeId(item.runId, item.delegationId),
            parentId = if (parent != null && parent in keys) nativeNodeId(parent.first, parent.second) else rootId,
            role = "worker", displayName = "$memberName ${index + 1}", status = item.state,
            sessionId = item.childSessionId, currentActivity = item.currentAction)
    }
}

internal fun nativeDisplayEdges(nodes: List<OrganizationNodeDto>): List<OrganizationEdgeDto> =
    nodes.mapNotNull { node -> node.parentId?.let { parent ->
        OrganizationEdgeDto(id = "native-edge:${node.id}", parentId = parent, childId = node.id)
    } }
