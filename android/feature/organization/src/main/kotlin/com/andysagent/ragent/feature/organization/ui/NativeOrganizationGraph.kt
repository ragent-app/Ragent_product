package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.andysagent.ragent.feature.organization.data.NativeBirthEvent
import com.andysagent.ragent.feature.organization.data.OrganizationNodeDto
import com.andysagent.ragent.feature.organization.data.OrganizationEdgeDto
import com.andysagent.ragent.feature.organization.data.OrganizationProjectionDto
import com.andysagent.ragent.feature.organization.data.RealOrganizationApi
import com.andysagent.ragent.feature.organization.data.RealOrganizationRepository
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel
import com.andysagent.ragent.feature.organization.presentation.NodeActionKind
import com.andysagent.ragent.feature.organization.data.UnifiedMembersPageDto
import com.andysagent.ragent.feature.organization.OrganizationConversationContent

internal fun nativeNodeId(runId: String, delegationId: String) = "native:${runId.length}:$runId$delegationId"

/** Read-only visual projection of the authenticated session's native delegation snapshots.
 * The parent owns the subscription and scopes [records] to this root session.
 */
@Composable
fun UnifiedOrganizationGraph(
    transport: RagentTransport,
    sessionId: String,
    identityScope: String = "",
    records: List<NativeDelegationDto>,
    nativeEvents: List<NativeBirthEvent> = emptyList(),
    unifiedMembers: UnifiedMembersPageDto? = null,
    unifiedReceiptElapsed: Long = 0L,
    unifiedActionsFresh: Boolean = false,
    rootAction: NodeActionKind? = null,
    nativeActionsFresh: Boolean = false,
    nativeReceiptElapsed: Long = 0L,
    birthCues: List<BirthCue> = emptyList(),
    onBirthCuesConsumed: (List<BirthCue>) -> Unit = {},
    modifier: Modifier = Modifier,
    onRootClick: (Rect) -> Unit,
    onRootAnchorChanged: (Rect?) -> Unit = {},
    onRootVisualChanged: (OrganizationRootVisual) -> Unit = {},
    revealRoot: Boolean = false,
    rootHidden: Boolean = false,
    programmaticOpen: Pair<String, String>? = null,
    onProgrammaticOpenConsumed: () -> Unit = {},
) {
    val repository = remember(transport, sessionId, identityScope) { RealOrganizationRepository(RealOrganizationApi(transport)) }
    val key = remember(transport, sessionId, identityScope) { "member-organization:$sessionId:${java.util.UUID.randomUUID()}" }
    val factory = remember(repository) {
        object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = OrganizationViewModel(repository) as T
        }
    }
    val vm: OrganizationViewModel = viewModel(key = key, factory = factory)
    var conversationRuntime by remember(transport, sessionId, identityScope) { mutableStateOf<Pair<String, String?>?>(null) }
    val rootId = unifiedMembers?.rootCanonicalId ?: "native-root:$sessionId"
    LaunchedEffect(vm, rootId, rootAction, records, nativeActionsFresh, nativeReceiptElapsed, unifiedMembers, unifiedReceiptElapsed, unifiedActionsFresh) {
        while (true) {
            val actions = mutableMapOf<String, NodeActionKind>()
            if (nativeActionsFresh && nativeReceiptElapsed > 0L && android.os.SystemClock.elapsedRealtime() - nativeReceiptElapsed in 0L..15_000L) records.forEach { record ->
                com.andysagent.ragent.feature.organization.presentation.nodeAction(record.activity)?.let {
                    actions[nativeNodeId(record.runId, record.delegationId)] = it
                }
            }
            if (unifiedActionsFresh && unifiedReceiptElapsed > 0L && android.os.SystemClock.elapsedRealtime() - unifiedReceiptElapsed in 0L..15_000L) unifiedMembers?.members?.forEach { member ->
                com.andysagent.ragent.feature.organization.presentation.nodeAction(member.activity)?.let { actions[unifiedUiId(member.canonicalId)] = it }
            }
            if (rootAction != null) actions[rootId] = rootAction
            vm.setNodeActions(actions)
            kotlinx.coroutines.delay(3_000)
        }
    }
    val rootName = stringResource(R.string.organization_native_root)
    val memberName = stringResource(R.string.organization_native_member)
    val nodes = remember(rootId, sessionId, rootName, memberName, unifiedMembers) {
        val root = listOf(OrganizationNodeDto(id = rootId, role = "root", displayName = rootName, sessionId = sessionId))
        unifiedMembers?.let { unifiedMemberNodes(it, rootId, root, memberName) } ?: root
    }
    LaunchedEffect(nodes, sessionId, birthCues) {
        // This projection is held only in this ViewModel; no formal organization is created.
        vm.applyProjection(OrganizationProjectionDto(organizationId = "members:$sessionId", rootSessionId = sessionId, nodes = nodes, edges = unifiedMemberEdges(nodes, emptyList())), birthCues = birthCues.filter { cue -> nodes.any { it.id == cue.nodeId } })
        if (birthCues.isNotEmpty()) onBirthCuesConsumed(birthCues)
    }
    OrganizationScreen(vm, modifier = modifier, embedded = true, embeddedRootId = rootId,
        onRootClick = onRootClick, onRootAnchorChanged = onRootAnchorChanged,
        onRootVisualChanged = onRootVisualChanged, revealRoot = revealRoot, rootHidden = rootHidden,
        openNodeId = programmaticOpen?.let { memberIdForLegacy(unifiedMembers, it.first, it.second) },
        onOpenNodeConsumed = onProgrammaticOpenConsumed,
        conversationRuntimeState = { nodeId ->
            conversationRuntime?.takeIf { it.first == nodeId }?.second
                ?: nodes.firstOrNull { it.id == nodeId }?.member?.activity?.state
        },
        conversationContent = { nodeId, contentModifier ->
            val ref = nodes.firstOrNull { it.id == nodeId }?.member?.conversation?.ref
            if (ref == null) Text(stringResource(R.string.organization_native_conversation_unavailable), contentModifier.padding(20.dp))
            else OrganizationConversationContent(transport, "", nodeId, null, identityScope, modifier = contentModifier,
                rootSessionId = sessionId, memberRef = ref,
                onRuntimeState = { state -> conversationRuntime = nodeId to state })
        })
}

/** Names are deliberately generic because native snapshots carry no member name or role. */
internal fun confirmedRootChildren(events: List<NativeBirthEvent>, sessionId: String): Set<Pair<String, String>> =
    events.asSequence().filter { (runId, event) -> event.runId == runId && event.parentSessionId == sessionId &&
        event.kind == "spawned" && event.parentDelegationId == null && event.birthActor == "root_session" }
        .map { it.runId to it.event.delegationId }.toSet()

internal fun nativeDisplayNodes(records: List<NativeDelegationDto>, rootId: String, memberName: String,
    rootChildren: Set<Pair<String, String>> = emptySet()): List<OrganizationNodeDto> {
    val distinct = records.groupBy { it.runId to it.delegationId }.mapNotNull { (_, versions) ->
        versions.maxByOrNull { it.updatedAt ?: it.startedAt ?: 0L }
    }.sortedWith(compareBy<NativeDelegationDto>({ it.startedAt ?: Long.MAX_VALUE }, { it.runId }, { it.delegationId }))
    val keys = distinct.map { it.runId to it.delegationId }.toSet()
    return distinct.mapIndexed { index, item ->
        val parent = item.parentDelegationId?.let { item.runId to it }
        OrganizationNodeDto(id = nativeNodeId(item.runId, item.delegationId),
            parentId = when {
                parent != null && parent in keys -> nativeNodeId(parent.first, parent.second)
                parent == null && (item.runId to item.delegationId) in rootChildren -> rootId
                else -> null
            },
            role = "worker", displayName = "$memberName ${index + 1}", status = item.state,
            sessionId = item.childSessionId, currentActivity = item.currentAction, activity = item.activity)
    }
}

internal fun nativeDisplayEdges(nodes: List<OrganizationNodeDto>): List<OrganizationEdgeDto> =
    nodes.mapNotNull { node -> node.parentId?.let { parent ->
        OrganizationEdgeDto(id = "native-edge:${node.id}", parentId = parent, childId = node.id)
    } }
