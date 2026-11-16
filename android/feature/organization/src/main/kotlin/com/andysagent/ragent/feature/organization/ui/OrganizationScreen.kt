package com.andysagent.ragent.feature.organization.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.designsystem.*
import com.andysagent.ragent.feature.organization.R
import com.andysagent.ragent.feature.organization.detail.AgentDetailScreen
import com.andysagent.ragent.feature.organization.presentation.OrganizationUiState
import com.andysagent.ragent.feature.organization.presentation.OrganizationViewModel

@Composable
fun OrganizationScreen(
    viewModel: OrganizationViewModel,
    modifier: Modifier = Modifier,
    onSendRootInstruction: (() -> Unit)? = null,
    showNodeLabels: Boolean = false,
    onBack: (() -> Unit)? = null,
    onOpenWorkItems: (() -> Unit)? = null,
    onOpenTeamMessages: (() -> Unit)? = null,
    isDemo: Boolean = false,
    conversationContent: @Composable (String, Modifier) -> Unit = { _, modifier -> Text(stringResource(R.string.organization_conversation_unavailable), modifier.padding(20.dp)) },
    conversationRuntimeState: (String) -> String? = { null },
) {
    val uiState by viewModel.uiState.collectAsState()
    OrganizationScreenContent(
        uiState = uiState,
        onPan = viewModel::onPan, onZoom = viewModel::onZoom, onReset = viewModel::onResetView,
        onNodeClick = viewModel::onNodeClicked, onNodeDoubleTap = viewModel::onNodeDoubleTapped,
        onDismissSheet = viewModel::onDismissSheet, onOpenDetail = viewModel::onOpenAgentDetail,
        onCloseDetail = viewModel::onCloseAgentDetail, onToggleActivityFeed = viewModel::onToggleActivityFeed,
        onApproveBlocker = viewModel::onApproveBlocker, onRejectBlocker = viewModel::onRejectBlocker,
        onSizeChanged = { w, h, density -> viewModel.updateViewportSize(w.toFloat(), h.toFloat(), density) },
        onSendRootInstruction = onSendRootInstruction, modifier = modifier, showNodeLabels = showNodeLabels,
        onBack = onBack, onOpenWorkItems = onOpenWorkItems, onOpenTeamMessages = onOpenTeamMessages, isDemo = isDemo, conversationContent = conversationContent, conversationRuntimeState = conversationRuntimeState,
    )
}

@Composable
fun OrganizationScreenContent(
    uiState: OrganizationUiState,
    onPan: (androidx.compose.ui.geometry.Offset) -> Unit,
    onZoom: (Float) -> Unit,
    onReset: () -> Unit,
    onNodeClick: (String) -> Unit,
    onNodeDoubleTap: (String) -> Unit,
    onDismissSheet: () -> Unit,
    onOpenDetail: (String) -> Unit,
    onCloseDetail: () -> Unit,
    onToggleActivityFeed: () -> Unit,
    onApproveBlocker: (String) -> Unit,
    onRejectBlocker: (String) -> Unit,
    onSizeChanged: (Int, Int, Float) -> Unit = { _, _, _ -> },
    onSendRootInstruction: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    showNodeLabels: Boolean = false,
    onBack: (() -> Unit)? = null,
    onOpenWorkItems: (() -> Unit)? = null,
    onOpenTeamMessages: (() -> Unit)? = null,
    isDemo: Boolean = false,
    conversationContent: @Composable (String, Modifier) -> Unit = { _, modifier -> Text(stringResource(R.string.organization_conversation_unavailable), modifier.padding(20.dp)) },
    conversationRuntimeState: (String) -> String? = { null },
) {
    val colors = LocalRagentColors.current
    if (uiState.activeDetailNode != null) {
        AgentDetailScreen(node = uiState.activeDetailNode, onBack = onCloseDetail)
        return
    }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var selectedNode by remember { mutableStateOf<com.andysagent.ragent.feature.organization.presentation.RenderedNodeUiState?>(null) }
    var expanded by remember { mutableStateOf(false) }
    var deleted by remember { mutableStateOf(false) }
    var anchors by remember { mutableStateOf<Map<String, OrganizationNodeAnchor>>(emptyMap()) }
    var viewport by remember { mutableStateOf<Rect?>(null) }
    var screenOrigin by remember { mutableStateOf(Offset.Zero) }
    val currentNode = uiState.nodes.firstOrNull { it.id == selectedId }
    val currentCluster = selectedId?.let { id -> uiState.nodes.firstOrNull { it.isCluster && id in it.clusterChildIds } }
    val anchorId = currentNode?.id ?: currentCluster?.id
    val anchor = anchorId?.let { anchors[it] }
    LaunchedEffect(uiState.nodes, selectedId) {
        if (selectedId != null) {
            if (currentNode != null) selectedNode = currentNode
            else if (currentCluster == null) { deleted = true; expanded = false }
        }
    }
    BoxWithConstraints(modifier.fillMaxSize().background(colors.canvas).statusBarsPadding().navigationBarsPadding()
        .onGloballyPositioned { screenOrigin = it.localToRoot(Offset.Zero) }) {
        val density = LocalDensity.current
        val pageScroll = rememberScrollState()
        var navigationHeight by remember { mutableIntStateOf(0) }
        var taskHeight by remember { mutableIntStateOf(0) }
        var activityHeight by remember { mutableIntStateOf(0) }
        val usedHeight = with(density) { (navigationHeight + taskHeight + activityHeight).toDp() }
        val graphHeight = if (maxHeight < 500.dp || density.fontScale >= 1.5f) 300.dp else (maxHeight - usedHeight).coerceIn(280.dp, 460.dp)
        Column(
            Modifier.fillMaxSize().verticalScroll(pageScroll),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 600.dp).fillMaxWidth().padding(horizontal = 20.dp)) {
                val members = uiState.nodes.flatMap { if (it.isCluster) it.clusterChildIds else listOf(it.id) }.toSet().size
                OrganizationNavigation(onBack, members, onOpenWorkItems, onOpenTeamMessages, onReset, Modifier.onSizeChanged { navigationHeight = it.height })
                Column(Modifier.fillMaxWidth().onSizeChanged { taskHeight = it.height }.padding(top = 20.dp, bottom = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(stringResource(R.string.organization_current_task), color = colors.secondaryContent, fontSize = 12.sp, lineHeight = 18.sp)
                        if (isDemo) Text(stringResource(R.string.organization_demo_badge), Modifier.background(colors.quietSurface, CircleShape).padding(horizontal = 10.dp, vertical = 4.dp), color = colors.primaryContent, fontSize = 12.sp)
                    }
                    Text(uiState.objective.ifBlank { stringResource(R.string.organization_workspace) }, color = colors.primaryContent, fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val statusText = when (uiState.state.lowercase()) {
                        "active", "working", "running" -> R.string.organization_state_active
                        "completed", "done" -> R.string.organization_state_done
                        "paused" -> R.string.organization_state_paused
                        "failed" -> R.string.organization_state_failed
                        "idle" -> R.string.organization_state_idle
                        "waiting" -> R.string.organization_state_waiting
                        "blocked" -> R.string.organization_state_blocked
                        else -> R.string.organization_state_unknown
                    }
                    Text(stringResource(if (isDemo) R.string.organization_demo_explanation else statusText), Modifier.padding(top = 6.dp), color = colors.secondaryContent, fontSize = 13.sp, lineHeight = 20.sp, maxLines = 2)
                }
                if (navigationHeight > 0 && taskHeight > 0 && activityHeight > 0) {
                    OrganizationGraph(uiState, onPan, onZoom, { id ->
                        val node = uiState.nodes.firstOrNull { it.id == id }
                        if (node?.isCluster == true) onNodeClick(id)
                        else if (node != null && anchors[id] != null && selectedId == null) {
                            selectedId = id; selectedNode = node; deleted = false; expanded = true
                        }
                    }, onNodeDoubleTap, onSizeChanged, modifier = Modifier.fillMaxWidth().height(graphHeight).clip(AgentoShapes.SurfaceLargeShape),
                        hiddenNodeId = anchorId, onAnchorsChanged = { latest, bounds ->
                            if (anchors != latest) anchors = latest
                            if (viewport != bounds) viewport = bounds
                        })
                } else {
                    Spacer(Modifier.fillMaxWidth().height(graphHeight))
                }
                OrganizationActivityFeed(uiState.activityFeed, uiState.isActivityFeedExpanded, onToggleActivityFeed, Modifier.onSizeChanged { activityHeight = it.height }.padding(top = 12.dp, bottom = 16.dp), reduceMotion = uiState.reduceMotion)
            }
        }
        val rememberedNode = selectedNode
        var lastAnchor by remember(selectedId) { mutableStateOf<OrganizationNodeAnchor?>(null) }
        LaunchedEffect(anchor) { if (anchor != null) lastAnchor = anchor }
        val displayedAnchor = anchor ?: lastAnchor
        val bounds = viewport
        val closeAnchorVisible = if (anchor != null && bounds != null) {
            val left = maxOf(bounds.left, screenOrigin.x)
            val right = minOf(bounds.right, screenOrigin.x + with(density) { maxWidth.toPx() })
            val top = maxOf(bounds.top, screenOrigin.y + navigationHeight)
            val bottom = minOf(bounds.bottom, screenOrigin.y + with(density) { maxHeight.toPx() })
            if (right > left && bottom > top) {
                val margin = anchor.radius.coerceAtMost(minOf((right - left) / 2f, (bottom - top) / 2f))
                anchor.center.x >= left + margin - .5f && anchor.center.x <= right - margin + .5f &&
                    anchor.center.y >= top + margin - .5f && anchor.center.y <= bottom - margin + .5f
            } else false
        } else false
        LaunchedEffect(expanded, deleted, anchor, bounds, screenOrigin, maxWidth, maxHeight) {
            if (!expanded && !deleted && anchor != null && bounds != null) {
                val left = maxOf(bounds.left, screenOrigin.x)
                val right = minOf(bounds.right, screenOrigin.x + with(density) { maxWidth.toPx() })
                val top = maxOf(bounds.top, screenOrigin.y + navigationHeight)
                val bottom = minOf(bounds.bottom, screenOrigin.y + with(density) { maxHeight.toPx() })
                if (right > left && bottom > top) {
                    val margin = anchor.radius.coerceAtMost(minOf((right - left) / 2f, (bottom - top) / 2f))
                    val x = anchor.center.x.coerceIn(left + margin, right - margin)
                    val y = anchor.center.y.coerceIn(top + margin, bottom - margin)
                    val correction = Offset(x - anchor.center.x, y - anchor.center.y)
                    if (correction.getDistance() > .5f) onPan(correction)
                } else if (bounds.top >= screenOrigin.y + with(density) { maxHeight.toPx() }) {
                    pageScroll.scrollBy(bounds.top - (screenOrigin.y + navigationHeight))
                } else if (bounds.bottom <= screenOrigin.y + navigationHeight) {
                    pageScroll.scrollBy(bounds.bottom - (screenOrigin.y + with(density) { maxHeight.toPx() }))
                }
            }
        }
        if (selectedId != null && rememberedNode != null && displayedAnchor != null) {
            val cardWidth = with(density) { minOf(maxWidth - 32.dp, 600.dp).coerceAtLeast(1.dp).toPx() }
            val availableHeight = (with(density) { maxHeight.toPx() } - navigationHeight).coerceAtLeast(1f)
            val cardHeight = minOf(availableHeight * .82f, with(density) { 640.dp.toPx() })
            OrganizationConversationIsland(rememberedNode, displayedAnchor, screenOrigin, cardWidth, cardHeight,
                Offset(with(density) { maxWidth.toPx() } / 2f, navigationHeight + availableHeight / 2f),
                expanded || (!deleted && !closeAnchorVisible), !expanded, deleted, conversationRuntimeState(rememberedNode.id), onDismiss = { expanded = false }, onReopen = { expanded = true }, onClosed = {
                    selectedId = null; selectedNode = null; deleted = false
                }, content = conversationContent)
        }
    }
}

@Composable
internal fun OrganizationNavigation(
    onBack: (() -> Unit)?,
    memberCount: Int?,
    onOpenWorkItems: (() -> Unit)? = null,
    onOpenTeamMessages: (() -> Unit)? = null,
    onReset: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    var menuOpen by remember { mutableStateOf(false) }
    Row(modifier.fillMaxWidth().padding(vertical = 8.dp).height(56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AgentoIconButton(onClick = { onBack?.invoke() }, contentDescription = stringResource(R.string.organization_back), modifier = Modifier.size(48.dp).background(colors.quietSurface, CircleShape)) {
            AgentoWebIcon(AgentoWebGlyph.Back, contentDescription = null, modifier = Modifier.size(20.dp), tint = colors.primaryContent)
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            AgentoFrostedGlassBox(modifier = Modifier.height(48.dp).widthIn(max = 216.dp), shape = CircleShape, hasShadow = false, contentAlignment = Alignment.Center) {
                Column(Modifier.padding(horizontal = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.organization_title), color = colors.primaryContent, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium, maxLines = 1)
                    if (memberCount != null) Text(stringResource(R.string.organization_member_count, memberCount), color = colors.secondaryContent, fontSize = 11.sp, lineHeight = 15.sp, maxLines = 1)
                }
            }
        }
        if (onOpenWorkItems != null || onOpenTeamMessages != null || onReset != null) {
            Box {
                AgentoIconButton(onClick = { menuOpen = true }, contentDescription = stringResource(R.string.organization_menu), modifier = Modifier.size(48.dp).background(colors.quietSurface, CircleShape)) {
                    AgentoWebIcon(AgentoWebGlyph.More, contentDescription = null, modifier = Modifier.size(20.dp), tint = colors.primaryContent)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    if (onOpenWorkItems != null) DropdownMenuItem(text = { Text(stringResource(R.string.organization_work)) }, onClick = { menuOpen = false; onOpenWorkItems() })
                    if (onOpenTeamMessages != null) DropdownMenuItem(text = { Text(stringResource(R.string.organization_messages)) }, onClick = { menuOpen = false; onOpenTeamMessages() })
                    if (onReset != null) DropdownMenuItem(text = { Text(stringResource(R.string.organization_reset)) }, onClick = { menuOpen = false; onReset() })
                }
            }
        } else Spacer(Modifier.size(48.dp))
    }
}
