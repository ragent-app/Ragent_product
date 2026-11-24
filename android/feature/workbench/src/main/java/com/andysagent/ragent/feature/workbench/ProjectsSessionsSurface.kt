package com.andysagent.ragent.feature.workbench

import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import com.andysagent.ragent.core.designsystem.AgentoAlertDialog as AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.Ragentolors
import com.andysagent.ragent.core.designsystem.AgentoDialog
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoStatusDot
import com.andysagent.ragent.core.designsystem.AgentoStatusTone
import com.andysagent.ragent.core.designsystem.AgentoSurface
import com.andysagent.ragent.core.designsystem.AgentoTextField
import com.andysagent.ragent.core.designsystem.AgentoToolbarIconButton
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.RagentTextStyles
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoAmbientShadow
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.network.ActiveCarrier
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.navigation.R as NavigationR
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
internal fun rememberProjectSessionsPresentation(state: WorkbenchUiState): ProjectSessionsPresentation =
    remember(state.projects, state.sessions, state.sessionSearchQuery, state.browsingProjectId) {
        val catalog = ProjectsReferenceSpec.filterCatalog(state.projects, state.sessions, state.sessionSearchQuery)
        val groups = ProjectsReferenceSpec.projectGroups(catalog.projects, catalog.sessions, ProjectsReferenceSpec.MobilePreviewLimit)
        // Search filters the rows, not the identity of an already open project.
        // An empty result must not eject the user from the detail screen.
        val allGroups = ProjectsReferenceSpec.projectGroups(state.projects, state.sessions, ProjectsReferenceSpec.MobilePreviewLimit)
        val detail = allGroups.firstOrNull { it.project.id == state.browsingProjectId }?.let {
            it.copy(sessions = ProjectsReferenceSpec.sessionsOfProject(catalog.sessions, it.project.id))
        }
        ProjectSessionsPresentation(groups, detail)
    }

internal data class ProjectSessionsPresentation(val groups: List<ProjectGroupUi>, val detail: ProjectGroupUi?)

@Composable
internal fun SessionsSurface(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    windowSizeClass: AgentoWindowSizeClass,
    folderBrowser: ProjectFolderBrowser = UnavailableProjectFolderBrowser,
    backProgress: Float = 0f,
    modifier: Modifier = Modifier,
    showProjectCreateAction: Boolean = false,
    presentation: ProjectSessionsPresentation = rememberProjectSessionsPresentation(state),
    motion: WorkbenchBackStackMotion = rememberWorkbenchBackStackMotion(state.projectSessionsOpen && presentation.detail != null, backProgress),
) {
    val groups = presentation.groups
    val fullBrowsingGroup = presentation.detail
    var menuSession by remember(state.activeRemoteTargetId) { mutableStateOf<Session?>(null) }
    var menuProject by remember(state.activeRemoteTargetId) { mutableStateOf<Project?>(null) }
    var dialogMode by remember(state.activeRemoteTargetId) { mutableStateOf<String?>(null) }
    var renameText by remember(state.activeRemoteTargetId) { mutableStateOf("") }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val openListMenu: (String) -> Unit = { id ->
        state.sessions.firstOrNull { it.id == id }?.let { session ->
            onEvent(WorkbenchEvent.PrepareListedSessionAction(state.activeRemoteTargetId, id))
            menuSession = session
            renameText = session.title
            dialogMode = "menu"
        }
    }
    val openProjectMenu: (String) -> Unit = { id ->
        if (state.pendingProjectActionId != id) {
            state.projects.firstOrNull { it.id == id }?.let { project ->
                onEvent(WorkbenchEvent.PrepareListedProjectAction(state.activeRemoteTargetId, id))
                menuProject = project
                renameText = project.name
                dialogMode = "project-menu"
            }
        }
    }
    // Closing clears the domain's browsing id immediately. The visual stack
    // still needs its outgoing content until its slide has left the viewport.
    // This snapshot is presentation-only; it never restores the domain state.
    var outgoingGroup by remember { mutableStateOf<ProjectGroupUi?>(null) }
    SideEffect { if (fullBrowsingGroup != null) outgoingGroup = fullBrowsingGroup }
    val displayedChildGroup = fullBrowsingGroup ?: outgoingGroup
    
    WorkbenchBackStackTransition(
        isOpen = state.projectSessionsOpen && fullBrowsingGroup != null,
        backProgress = backProgress,
        motion = motion,
        modifier = modifier.fillMaxSize(),
        parentContent = {
            CompactProjectsSurface(
                state = state.copy(projectSessionsOpen = false, browsingProjectId = null, projectDialogOpen = false),
                groups = groups,
                onEvent = onEvent,
                onSessionLongClick = openListMenu,
                onProjectLongClick = openProjectMenu,
                modifier = Modifier.fillMaxSize(),
            )
        },
        childContent = {
            if (displayedChildGroup != null) {
                CompactProjectSessionsSurface(
                    state = state,
                    group = displayedChildGroup,
                    onEvent = onEvent,
                    onSessionLongClick = openListMenu,
                    showCreateSession = showProjectCreateAction,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        },
    )
    if (state.projectDialogOpen) ProjectDialog(state, onEvent, folderBrowser)
    menuSession?.let { session ->
        when (dialogMode) {
            "menu" -> AlertDialog(
                onDismissRequest = { dialogMode = null; menuSession = null },
                title = { Text(session.title) },
                text = {
                    Column(Modifier.fillMaxWidth().testTag("session-list-menu")) {
                        Text(stringResource(if (session.pinned) R.string.list_unpin else R.string.list_pin), Modifier.fillMaxWidth().testTag("session-list-pin")
                            .clickable {
                                onEvent(WorkbenchEvent.PinListedSession(state.activeRemoteTargetId, session.id, !session.pinned))
                                dialogMode = null; menuSession = null
                            }.padding(vertical = 14.dp))
                        Text(stringResource(R.string.workbench_session_rename), Modifier.fillMaxWidth().testTag("session-list-rename")
                            .clickable { dialogMode = "rename" }.padding(vertical = 14.dp))
                        Text(stringResource(R.string.workbench_session_copy_id), Modifier.fillMaxWidth()
                            .clickable {
                                clipboard.setText(androidx.compose.ui.text.AnnotatedString(session.id))
                                dialogMode = null; menuSession = null
                            }.padding(vertical = 14.dp))
                        Text(stringResource(R.string.workbench_session_delete), Modifier.fillMaxWidth().testTag("session-list-delete")
                            .clickable { dialogMode = "delete" }.padding(vertical = 14.dp),
                            color = MaterialTheme.colorScheme.error)
                    }
                },
                confirmButton = { TextButton(onClick = { dialogMode = null; menuSession = null }, modifier = Modifier.testTag("session-list-dismiss"), colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.settings_cancel)) } },
            )
            "rename" -> AgentoDialog(
                title = stringResource(R.string.workbench_session_rename), confirmLabel = stringResource(R.string.settings_save),
                onConfirm = {
                    val name = renameText.trim()
                    if (name.isNotEmpty()) onEvent(WorkbenchEvent.RenameListedSession(state.activeRemoteTargetId, session.id, name))
                    dialogMode = null; menuSession = null
                },
                onDismiss = { dialogMode = null; menuSession = null }, dismissLabel = stringResource(R.string.settings_cancel),
                confirmEnabled = renameText.trim().isNotEmpty(),
            ) { AgentoTextField(value = renameText, onValueChange = { renameText = it }, label = stringResource(R.string.session_list_name), modifier = Modifier.fillMaxWidth().testTag("session-list-name")) }
            "delete" -> AgentoDialog(
                title = stringResource(R.string.session_list_delete_title), confirmLabel = stringResource(R.string.session_list_delete_confirm),
                onConfirm = {
                    onEvent(WorkbenchEvent.DeleteListedSession(state.activeRemoteTargetId, session.id))
                    dialogMode = null; menuSession = null
                },
                onDismiss = { dialogMode = null; menuSession = null }, dismissLabel = stringResource(R.string.settings_cancel),
                destructive = true, modifier = Modifier.testTag("session-list-delete-confirmation"),
            ) { Text(stringResource(R.string.session_list_delete_detail)) }
        }
    }
    menuProject?.let { project ->
        val projectActionPending = state.pendingProjectActionId == project.id
        when (dialogMode) {
            "project-menu" -> AlertDialog(
                onDismissRequest = { dialogMode = null; menuProject = null },
                title = { Text(project.name) },
                text = { Column(Modifier.fillMaxWidth().testTag("project-list-menu")) {
                    Text(stringResource(if (project.pinned) R.string.list_unpin else R.string.list_pin), Modifier.fillMaxWidth().testTag("project-list-pin").clickable(enabled = !projectActionPending) {
                        onEvent(WorkbenchEvent.PinListedProject(state.activeRemoteTargetId, project.id, !project.pinned)); dialogMode = null; menuProject = null
                    }.padding(vertical = 14.dp))
                    Text(stringResource(R.string.project_list_rename), Modifier.fillMaxWidth().testTag("project-list-rename").clickable(enabled = !projectActionPending) { dialogMode = "project-rename" }.padding(vertical = 14.dp))
                    Text(stringResource(R.string.project_list_delete), Modifier.fillMaxWidth().testTag("project-list-delete").clickable(enabled = !projectActionPending) { dialogMode = "project-delete" }.padding(vertical = 14.dp), color = MaterialTheme.colorScheme.error)
                } },
                confirmButton = { TextButton(onClick = { dialogMode = null; menuProject = null }, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.settings_cancel)) } },
            )
            "project-rename" -> AgentoDialog(
                title = stringResource(R.string.project_list_rename), confirmLabel = stringResource(R.string.settings_save),
                onConfirm = {
                    val name = renameText.trim()
                    if (name.isNotEmpty() && !projectActionPending) onEvent(WorkbenchEvent.RenameListedProject(state.activeRemoteTargetId, project.id, name))
                    dialogMode = null; menuProject = null
                },
                onDismiss = { dialogMode = null; menuProject = null }, dismissLabel = stringResource(R.string.settings_cancel),
                confirmEnabled = !projectActionPending && renameText.trim().isNotEmpty(),
            ) { AgentoTextField(value = renameText, onValueChange = { renameText = it }, label = stringResource(R.string.project_list_name), modifier = Modifier.fillMaxWidth().testTag("project-list-name")) }
            "project-delete" -> AlertDialog(
                onDismissRequest = { dialogMode = null; menuProject = null },
                title = { Text(stringResource(R.string.project_list_delete)) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(stringResource(R.string.project_list_delete_detail))
                        if (projectActionPending) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.testTag("project-delete-progress"),
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(16.dp),
                                    strokeWidth = 2.dp,
                                    color = LocalRagentColors.current.accentPrimary,
                                )
                            }
                        }
                    }
                },
                confirmButton = { Column {
                    TextButton(
                        modifier = Modifier.testTag("project-delete-keep"),
                        enabled = !projectActionPending,
                        onClick = {
                            if (!projectActionPending) {
                                onEvent(WorkbenchEvent.DeleteListedProject(state.activeRemoteTargetId, project.id, false))
                                dialogMode = null
                                menuProject = null
                            }
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
                    ) { Text(stringResource(R.string.project_list_delete_keep)) }
                    TextButton(
                        modifier = Modifier.testTag("project-delete-all"),
                        enabled = !projectActionPending,
                        onClick = {
                            if (!projectActionPending) {
                                onEvent(WorkbenchEvent.DeleteListedProject(state.activeRemoteTargetId, project.id, true))
                                dialogMode = null
                                menuProject = null
                            }
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary),
                    ) {
                        Text(
                            stringResource(R.string.project_list_delete_all),
                            color = if (projectActionPending) MaterialTheme.colorScheme.error.copy(alpha = 0.38f) else MaterialTheme.colorScheme.error,
                        )
                    }
                } },
                dismissButton = { TextButton(onClick = { dialogMode = null; menuProject = null }, colors = ButtonDefaults.textButtonColors(contentColor = LocalRagentColors.current.accentPrimary)) { Text(stringResource(R.string.settings_cancel)) } },
            )
        }
    }
}

/**
 * L1: Projects Workspace Overview
 */
@OptIn(ExperimentalMaterialApi::class)
@Composable
private fun CompactProjectsSurface(
    state: WorkbenchUiState,
    groups: List<ProjectGroupUi>,
    onEvent: (WorkbenchEvent) -> Unit,
    onSessionLongClick: (String) -> Unit,
    onProjectLongClick: (String) -> Unit,
    modifier: Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val listState = rememberDestinationListState("projects-index-scroll")
    val pullRefreshState = rememberPullRefreshState(
        refreshing = state.projectCatalogRefreshing,
        onRefresh = { onEvent(WorkbenchEvent.RefreshCatalog) },
    )
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                brush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight,
            )
            .pullRefresh(pullRefreshState),
    ) {
        Column(Modifier.fillMaxSize().imePadding()) {
            // Searching an empty chat collection has no value. Keeping the
            // upper edge clear gives a first conversation the same calm entry
            // point as a new chat instead of a management-screen toolbar.
            if (state.projectCatalogLoading || groups.isNotEmpty() || state.remoteTargets.isNotEmpty() ||
                state.sessionSearchQuery.isNotBlank() || state.activeRemoteTargetId != null ||
                state.connection != AgentConnectionStatus.Disconnected
            ) {
                SessionsHeader(
                    state = state,
                    onEvent = onEvent,
                    searchQuery = state.sessionSearchQuery,
                    onSearchQueryChanged = { onEvent(WorkbenchEvent.SessionSearchChanged(it)) },
                )
            }
            if (state.connection != AgentConnectionStatus.Connected && state.activeRemoteTargetId != null) {
                ConnectionStatusBanner(
                    connection = state.connection,
                    onReconnect = { onEvent(WorkbenchEvent.Retry) },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            if (state.projectCatalogLoading) {
                ProjectsCatalogLoadingSkeleton(modifier = Modifier.weight(1f))
            } else if (groups.isEmpty()) {
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) {
                    item(key = "l1-empty") {
                        Box(modifier = Modifier.fillParentMaxSize()) {
                            if (state.sessionSearchQuery.isNotBlank()) {
                                EmptyProjects(
                                    modifier = Modifier.fillMaxSize(),
                                    isSearch = true,
                                )
                            } else {
                                EmptyChatList(
                                    modifier = Modifier.fillMaxSize(),
                                    onCreateProject = { onEvent(WorkbenchEvent.OpenProjectDialog) },
                                )
                            }
                        }
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth().testTag("projects-index-list"),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 14.dp,
                        bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(groups, key = { it.project.id }) { group ->
                        val isActionPending = state.pendingProjectActionId == group.project.id
                        ProjectIndexSection(
                            group = group,
                            selectedSessionId = state.sessionId,
                            actionPending = isActionPending,
                            onOpenProject = if (isActionPending) null else ({
                                onEvent(WorkbenchEvent.OpenProjectSessions(group.project.id))
                            }),
                            onSelectSession = { sessionId ->
                                onEvent(WorkbenchEvent.SelectSession(sessionId))
                            },
                            onLongClickSession = onSessionLongClick,
                            onLongClickProject = if (!isActionPending && state.projects.any { it.id == group.project.id }) ({ onProjectLongClick(group.project.id) }) else null,
                        )
                    }
                }
            }
        }

        PullRefreshIndicator(
            refreshing = state.projectCatalogRefreshing,
            state = pullRefreshState,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 12.dp)
                .testTag("l1-pull-refresh-indicator"),
            backgroundColor = colors.quietSurface,
            contentColor = colors.accentPrimary,
            scale = true,
        )
    }
}

@Composable
private fun ProjectsCatalogLoadingSkeleton(modifier: Modifier = Modifier) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val placeholder = if (isDark) Color(0xFF45454A) else Color(0xFFE4E5EA)
    val card = if (isDark) Color(0xFF2C2C2E) else Color.White

    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(
            start = 16.dp,
            end = 16.dp,
            top = 14.dp,
            bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        items(3) { index ->
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(20.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(placeholder),
                    )
                    Box(
                        modifier = Modifier
                            .width(if (index == 1) 148.dp else 180.dp)
                            .height(18.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(placeholder),
                    )
                }
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(card)) {
                    repeat(2) { preview ->
                        Column(Modifier.fillMaxWidth().height(72.dp).padding(start = 44.dp, end = 12.dp), verticalArrangement = Arrangement.Center) {
                            Box(Modifier.width(if (preview == 1) 172.dp else 210.dp).height(16.dp).clip(RoundedCornerShape(6.dp)).background(placeholder))
                            Spacer(Modifier.height(6.dp))
                            Box(Modifier.width(56.dp).height(12.dp).clip(RoundedCornerShape(6.dp)).background(placeholder))
                        }
                    }
                }
            }
        }
    }
}

/**
 * L2: Project Sessions Details Page (高信息密度与沉浸工作流)
 */
@OptIn(ExperimentalMaterialApi::class)
@Composable
private fun CompactProjectSessionsSurface(
    state: WorkbenchUiState,
    group: ProjectGroupUi,
    onEvent: (WorkbenchEvent) -> Unit,
    onSessionLongClick: (String) -> Unit,
    showCreateSession: Boolean = false,
    modifier: Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val listState = rememberDestinationListState("project-${group.project.id}-scroll")
    val pullRefreshState = rememberPullRefreshState(
        refreshing = state.projectCatalogRefreshing,
        onRefresh = { onEvent(WorkbenchEvent.RefreshCatalog) },
    )

    // One chronological list keeps the project view about conversations.
    // Running work is already visible through its animated status dot, so it
    // does not need a second labelled section or duplicated count badge.
    val orderedSessions = group.sessions.sortedByDescending { it.session.updatedAt }
    val titleProgress = remember(listState) {
        derivedStateOf {
            if (listState.firstVisibleItemIndex > 0) 1f
            else {
                val title = listState.layoutInfo.visibleItemsInfo.firstOrNull()
                if (title == null || title.size == 0) 0f
                else (listState.firstVisibleItemScrollOffset.toFloat() / title.size).coerceIn(0f, 1f)
            }
        }
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(
                brush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight,
            )
            .pullRefresh(pullRefreshState),
    ) {
        Column(Modifier.fillMaxSize().imePadding()) {
            // The toolbar keeps context after the large title leaves the reader.
            // Both renditions follow the actual list, never an independent tween.
            L2SessionsHeader(
                state = state,
                project = group.project,
                titleProgress = if (group.sessions.isEmpty()) null else titleProgress,
                searchQuery = state.sessionSearchQuery,
                onSearchQueryChanged = { onEvent(WorkbenchEvent.SessionSearchChanged(it)) },
                onBack = { onEvent(WorkbenchEvent.CloseProjectSessions) },
                onOpenAgents = { onEvent(WorkbenchEvent.OpenAgents) },
                onReconnect = { onEvent(WorkbenchEvent.Retry) },
            )

            if (state.connection != AgentConnectionStatus.Connected && state.activeRemoteTargetId != null) {
                ConnectionStatusBanner(
                    connection = state.connection,
                    onReconnect = { onEvent(WorkbenchEvent.Retry) },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }

            if (showCreateSession) {
                AgentoButton(
                    text = stringResource(NavigationR.string.navigation_new_session),
                    onClick = { onEvent(WorkbenchEvent.OpenNewSession(group.project.id)) },
                    modifier = Modifier.padding(start = 28.dp, top = 8.dp, bottom = 4.dp)
                        .testTag("tablet-project-new-session"),
                )
            }

            // Conversations are content, not a settings group. Keeping them
            // directly on the canvas prevents the project view from becoming
            // a stack of Material-style containers.
            if (group.sessions.isEmpty()) {
                ProjectReadingTitle(group.project, Modifier.padding(horizontal = 28.dp, vertical = 12.dp))
                LazyColumn(
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                ) {
                    item(key = "l2-empty") {
                        Box(modifier = Modifier.fillParentMaxSize()) {
                            EmptyProjects(
                                modifier = Modifier.fillMaxSize(),
                                isSearch = state.sessionSearchQuery.isNotBlank(),
                                isProjectSessionList = true,
                            )
                        }
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth()
                        .projectReadingEntrance { listState.canScrollBackward }
                        .testTag("project-conversations-list"),
                    contentPadding = PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 12.dp,
                        bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                    ),
                ) {
                    item(key = "project-context-${group.project.id}", contentType = "project-context") {
                        ProjectReadingTitle(
                            group.project,
                            Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 20.dp)
                                .graphicsLayer { alpha = 1f - titleProgress.value },
                        )
                    }
                    items(orderedSessions, key = { it.session.id }, contentType = { "conversation" }) { row ->
                        L2SessionMetricRow(
                            row = row,
                            selected = row.session.id == state.sessionId,
                            onClick = { onEvent(WorkbenchEvent.SelectSession(row.session.id)) },
                            onLongClick = { onSessionLongClick(row.session.id) },
                        )
                    }
                }
            }
        }

        PullRefreshIndicator(
            refreshing = state.projectCatalogRefreshing,
            state = pullRefreshState,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 12.dp)
                .testTag("l2-pull-refresh-indicator"),
            backgroundColor = colors.quietSurface,
            contentColor = colors.accentPrimary,
            scale = true,
        )
    }
}

@Composable
private fun ProjectReadingTitle(project: Project, modifier: Modifier) {
    Text(
        text = project.name,
        modifier = modifier.testTag("project-detail-title"),
        style = MaterialTheme.typography.headlineSmall.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        color = LocalRagentColors.current.primaryContent,
    )
}

/** Fade only the entering reader pixels; this is not an opaque toolbar cover. */
private fun Modifier.projectReadingEntrance(scrolled: () -> Boolean): Modifier =
    graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithCache {
        val mask = Brush.verticalGradient(
            colors = listOf(Color.Transparent, Color.White),
            startY = 0f, endY = minOf(16.dp.toPx(), size.height.coerceAtLeast(1f)),
        )
        onDrawWithContent {
            drawContent()
            if (scrolled()) drawRect(mask, blendMode = BlendMode.DstIn)
        }
    }

/**
 * Conversations share one content plane, not a settings card. Titles get
 * their own width; time and attention signals remain secondary information.
 */
@Composable
private fun L2SessionMetricRow(
    row: SessionRowUi,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit = {},
) {
    val colors = LocalRagentColors.current
    val session = row.session

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) colors.primaryContent.copy(alpha = 0.045f) else Color.Transparent)
            .agentoPressScale(
                pressedScale = 0.985f,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .testTag("project-conversation-${session.id}")
            .semantics(mergeDescendants = true) { this.selected = selected }
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = session.title,
            modifier = Modifier.fillMaxWidth().testTag("project-conversation-title-${session.id}"),
            style = MaterialTheme.typography.bodyMedium.copy(
                fontWeight = if (selected || row.unread) FontWeight.SemiBold else FontWeight.Normal,
                fontSize = 16.sp,
            ),
            color = colors.primaryContent,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.testTag("project-conversation-meta-${session.id}")) { SessionMetaRail(row, compact = true) }
    }
}

/** Project context remains visible; search is revealed only when requested. */
@Composable
private fun L2SessionsHeader(
    state: WorkbenchUiState,
    project: Project,
    titleProgress: State<Float>?,
    searchQuery: String,
    onSearchQueryChanged: (String) -> Unit,
    onBack: () -> Unit,
    onOpenAgents: () -> Unit,
    onReconnect: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    var searchOpen by rememberDestinationFlag("project-${project.id}-search-open", searchQuery.isNotBlank())
    val compactTitleVisible by remember(titleProgress) {
        derivedStateOf { (titleProgress?.value ?: 0f) > .45f }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentoToolbarIconButton(
                onClick = onBack,
                contentDescription = stringResource(R.string.projects_back_to_projects),
                hasGlassBackdrop = false,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Back,
                    contentDescription = null,
                    tint = colors.accentPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }

            Text(
                text = project.name,
                modifier = Modifier.weight(1f)
                    .padding(start = 4.dp, end = 8.dp)
                    .testTag("project-detail-compact-title")
                    .then(if (compactTitleVisible) Modifier else Modifier.clearAndSetSemantics { })
                    .graphicsLayer {
                        alpha = (((titleProgress?.value ?: 0f) - .45f) / .55f).coerceIn(0f, 1f)
                    },
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = colors.primaryContent,
            )

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (state.activeRemoteTargetId != null ||
                    state.activeCarrier != ActiveCarrier.None ||
                    state.connection != AgentConnectionStatus.Disconnected
                ) {
                    ConnectionStatusPill(
                        connection = state.connection,
                        activeCarrier = state.activeCarrier,
                        onClick = onReconnect,
                    )
                }

                AgentoToolbarIconButton(
                    onClick = { searchOpen = !searchOpen },
                    contentDescription = stringResource(R.string.projects_search_sessions),
                    hasGlassBackdrop = true,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Search,
                        contentDescription = null,
                        tint = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
                    )
                }

                AgentoToolbarIconButton(
                    onClick = onOpenAgents,
                    contentDescription = stringResource(R.string.projects_open_agents),
                    hasGlassBackdrop = true,
                ) {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.Agent,
                        contentDescription = null,
                        tint = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
                    )
                }
            }
        }

        ProjectSearchDisclosure(
            visible = searchOpen, query = searchQuery, onQueryChanged = onSearchQueryChanged,
            placeholder = stringResource(R.string.projects_search_placeholder), tag = "project-detail-search",
        )
    }
}

/** The dock names this destination, so the header only exposes search. */
@Composable
private fun SessionsHeader(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    searchQuery: String,
    onSearchQueryChanged: (String) -> Unit,
) {
    var searchOpen by rememberDestinationFlag("projects-index-search-open", searchQuery.isNotBlank())
    var computerPickerOpen by rememberDestinationFlag("projects-computer-picker-open", false)
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .statusBarsPadding()
            .padding(start = 28.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = stringResource(NavigationR.string.navigation_chat),
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 30.sp, fontWeight = FontWeight.SemiBold),
                color = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
            )
            Spacer(Modifier.weight(1f))
            if (state.activeRemoteTargetId != null ||
                state.activeCarrier != ActiveCarrier.None ||
                state.connection != AgentConnectionStatus.Disconnected
            ) {
                ConnectionStatusPill(
                    connection = state.connection,
                    activeCarrier = state.activeCarrier,
                    onClick = { onEvent(WorkbenchEvent.Retry) },
                )
            }
            AgentoToolbarIconButton(
                onClick = { searchOpen = !searchOpen },
                contentDescription = stringResource(R.string.projects_search_sessions),
                hasGlassBackdrop = true,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Search,
                    contentDescription = null,
                    tint = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
                )
            }
        }

        if (state.remoteTargets.isNotEmpty()) {
            val choices = remember(state.remoteTargets) { projectComputerChoices(state.remoteTargets) }
            val computerName = activeComputerDisplayName(
                state.activeRemoteTargetId, state.remoteTargets, state.computers, "This computer",
            )
            Box(Modifier.fillMaxWidth()) {
                Surface(
                    onClick = { computerPickerOpen = true },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
                        .semantics { contentDescription = "Device selector $computerName" },
                    shape = RoundedCornerShape(14.dp),
                    color = colors.quietSurface,
                    contentColor = colors.primaryContent,
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        AgentoWebIcon(AgentoWebGlyph.Monitor, null, Modifier.size(18.dp))
                        Text(computerName, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        AgentoWebIcon(AgentoWebGlyph.ChevronDown, null, Modifier.size(14.dp))
                    }
                }
                DropdownMenu(
                    expanded = computerPickerOpen,
                    onDismissRequest = { computerPickerOpen = false },
                ) {
                    choices.forEach { computer ->
                        DropdownMenuItem(
                            text = { Text(computer.label.ifBlank { computer.instanceId }) },
                            leadingIcon = {
                                if (computer.instanceId == state.activeRemoteTargetId) {
                                    AgentoWebIcon(AgentoWebGlyph.Check, null)
                                }
                            },
                            onClick = {
                                computerPickerOpen = false
                                if (computer.instanceId != state.activeRemoteTargetId) {
                                    onEvent(WorkbenchEvent.SelectRemoteTarget(computer.instanceId))
                                }
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.settings_add_computer)) },
                        onClick = { computerPickerOpen = false; onEvent(WorkbenchEvent.OpenPairing) },
                    )
                }
            }
        }

        ProjectSearchDisclosure(
            visible = searchOpen, query = searchQuery, onQueryChanged = onSearchQueryChanged,
            placeholder = stringResource(R.string.projects_search_sessions), tag = "projects-index-search",
        )

    }
}

/**
 * A project is a section, not another floating control. Its quiet header
 * opens the full list; the content surface below offers recent conversations.
 */
@Composable
private fun ProjectIndexSection(
    group: ProjectGroupUi,
    selectedSessionId: String?,
    actionPending: Boolean,
    onOpenProject: (() -> Unit)?,
    onSelectSession: (String) -> Unit,
    onLongClickSession: (String) -> Unit,
    onLongClickProject: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val cardShape = RoundedCornerShape(16.dp)
    val cardBg = if (isDark) Color(0xFF2C2C2E) else Color.White
    val openProjectDescription = stringResource(R.string.projects_open_project, group.project.name)

    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
            // Project header row
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .graphicsLayer { alpha = if (actionPending) 0.72f else 1f }
                    .agentoPressScale(pressedScale = 0.98f, onClick = onOpenProject, onLongClick = onLongClickProject)
                    .testTag("project-header-${group.project.id}")
                    .semantics(mergeDescendants = true) {
                        contentDescription = openProjectDescription
                    }
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Settings-style bare glyph: the folder reads on its own; a
                // tile behind it adds a box-in-box the surface does not need.
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.Folder,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                    tint = colors.accentPrimary,
                )
                Text(
                    text = group.project.name,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Medium,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
                )
                if (group.project.pinned) AgentoWebIcon(AgentoWebGlyph.Pin, stringResource(R.string.list_pin), Modifier.size(14.dp).testTag("project-pinned"), tint = colors.secondaryContent)
                Text(
                    text = androidx.compose.ui.res.pluralStringResource(
                        R.plurals.projects_session_count, group.sessionCount, group.sessionCount,
                    ),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal),
                    color = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
                    maxLines = 1,
                )
                if (actionPending) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(16.dp)
                            .testTag("project-action-progress-${group.project.id}"),
                        strokeWidth = 2.dp,
                        color = colors.accentPrimary,
                    )
                } else {
                    AgentoWebIcon(
                        glyph = AgentoWebGlyph.ChevronRight,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                        tint = if (isDark) AgentoFrostedTokens.TextTertiary else colors.tertiaryContent,
                    )
                }
            }

            // Attention/active work first, then recent activity. The full
            // project count and chevron remain the one entry to all rows.
            if (group.sessions.isNotEmpty()) {
                Column(modifier = Modifier.fillMaxWidth().clip(cardShape).background(cardBg)) {
                    group.sessions.forEachIndexed { index, row ->
                        L1SessionPreviewRow(
                            row = row,
                            selected = row.session.id == selectedSessionId,
                            onClick = { onSelectSession(row.session.id) },
                            onLongClick = { onLongClickSession(row.session.id) },
                        )
                        if (index < group.sessions.lastIndex) {
                            HorizontalDivider(
                                thickness = 0.5.dp,
                                color = if (isDark) Color(0xFF38383A) else Color(0xFFE5E5EA),
                                modifier = Modifier.padding(start = 44.dp),
                            )
                        }
                    }
                }
            }
    }
}

@Composable
private fun L1SessionPreviewRow(
    row: SessionRowUi,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val session = row.session

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .agentoPressScale(pressedScale = 0.985f, onClick = onClick, onLongClick = onLongClick)
            .testTag("project-preview-${session.id}")
            .semantics(mergeDescendants = true) { this.selected = selected }
            .padding(start = 44.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = session.title,
            modifier = Modifier.fillMaxWidth().testTag("project-preview-title-${session.id}"),
            style = MaterialTheme.typography.bodySmall.copy(
                fontWeight = if (selected || row.unread) FontWeight.SemiBold else FontWeight.Normal,
                fontSize = 15.sp,
            ),
            color = colors.primaryContent,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Box(Modifier.testTag("project-preview-meta-${session.id}")) { SessionMetaRail(row, compact = true) }
    }
}

/** Shared secondary metadata: time and one action/running/unread signal. */
@Composable
private fun SessionMetaRail(
    row: SessionRowUi,
    compact: Boolean = false,
) {
    val runningDescription = stringResource(R.string.projects_running)
    val unreadDescription = stringResource(R.string.projects_unread)
    val time = formatSessionTime(row.session.updatedAt)
    val textColor = if (LocalRagentColors.current.canvas.red < 0.5f) {
        AgentoFrostedTokens.TextSecondary
    } else {
        LocalRagentColors.current.secondaryContent
    }

    Row(
        modifier = Modifier.semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (compact) 7.dp else 9.dp),
    ) {
        if (row.session.pinned) AgentoWebIcon(AgentoWebGlyph.Pin, stringResource(R.string.list_pin), Modifier.size(14.dp).testTag("session-pinned"), tint = textColor)
        if (time.isNotEmpty()) {
            Text(
                text = time,
                style = MaterialTheme.typography.labelSmall,
                color = textColor,
                maxLines = 1,
            )
        }
        when {
            row.action != null -> ActionCapsule(row.action)
            row.indicator == SessionIndicatorUi.Running -> {
                Box(
                    modifier = Modifier.semantics {
                        contentDescription = runningDescription
                    },
                ) {
                    AgentoBreathingDot(color = AgentoFrostedTokens.StatusActive, size = if (compact) 7.dp else 8.dp)
                }
            }
            row.unread -> {
                Box(
                    modifier = Modifier
                        .size(if (compact) 7.dp else 8.dp)
                        .clip(CircleShape)
                        .background(LocalRagentColors.current.accentPrimary)
                        .semantics { contentDescription = unreadDescription },
                )
            }
        }
    }
}

@Composable
private fun ActionCapsule(action: SessionActionUi) {
    val label = when (action) {
        SessionActionUi.Reply -> stringResource(R.string.projects_needs_reply)
        SessionActionUi.Approval -> stringResource(R.string.projects_needs_approval)
    }
    val needsActionDescription = stringResource(R.string.projects_needs_action)
    Surface(
        modifier = Modifier.semantics { contentDescription = needsActionDescription },
        shape = AgentoShapes.PillShape,
        color = AgentoFrostedTokens.StatusAttention.copy(alpha = 0.14f),
        contentColor = AgentoFrostedTokens.StatusAttention,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium),
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
            maxLines = 1,
        )
    }
}

private fun formatSessionTime(timestamp: Long): String {
    if (timestamp <= 0L) return ""
    val zone = ZoneId.systemDefault()
    val date = Instant.ofEpochMilli(timestamp).atZone(zone)
    val now = java.time.ZonedDateTime.now(zone)
    return if (date.toLocalDate() == now.toLocalDate()) {
        DateTimeFormatter.ofPattern("HH:mm").format(date)
    } else {
        DateTimeFormatter.ofPattern("MMM d").format(date)
    }
}

@Composable
private fun EmptyProjects(
    modifier: Modifier,
    isSearch: Boolean = false,
    isProjectSessionList: Boolean = false,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f

    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(
            modifier = Modifier.size(48.dp),
            shape = CircleShape,
            color = if (isDark) AgentoFrostedTokens.SurfaceLevel2 else colors.surfaceHigh,
            contentColor = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
        ) {
            Box(contentAlignment = Alignment.Center) {
                AgentoWebIcon(
                    glyph = when {
                        isSearch -> AgentoWebGlyph.Search
                        isProjectSessionList -> AgentoWebGlyph.ChatBubble
                        else -> AgentoWebGlyph.ChatBubble
                    },
                    contentDescription = null,
                    modifier = Modifier.size(24.dp),
                    tint = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
                )
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(
            text = when {
                isSearch -> stringResource(R.string.projects_no_sessions_found)
                isProjectSessionList -> stringResource(R.string.projects_no_sessions)
                else -> stringResource(R.string.projects_no_projects)
            },
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
            color = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (isSearch) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = stringResource(R.string.projects_search_empty_detail),
                style = MaterialTheme.typography.bodySmall,
                color = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

/** The Chat tab is still the project index. Its first action creates a project,
 * rather than opening an unscoped chat session. */
@Composable
private fun EmptyChatList(
    modifier: Modifier,
    onCreateProject: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val createProjectLabel = stringResource(R.string.home_create_project)
    val isDark = colors.canvas.red < 0.5f
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        AgentoFrostedGlassBox(
            modifier = Modifier
                .height(52.dp)
                .widthIn(min = 176.dp)
                .agentoPressScale(pressedScale = 0.97f, onClick = onCreateProject)
                .semantics { contentDescription = createProjectLabel },
            shape = AgentoShapes.PillShape,
            // This is the one functional control in an otherwise quiet content
            // layer. Keep the material neutral and let the icon and label carry
            // the action tint, rather than using a large opaque-blue contained
            // button that competes with the page content.
            surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkDockGlassBrush else AgentoFrostedTokens.LightDockGlassBrush),
            blurRadius = AgentoFrostedTokens.BlurNavigation,
            showTopHairline = true,
            material = AgentoGlassMaterial.LiquidClear,
            hasShadow = true,
            shadowElevation = 8.dp,
            shadowAlpha = if (isDark) 0.17f else 0.08f,
            shadowSpotAlpha = if (isDark) 0.20f else 0.12f,
            contentAlignment = Alignment.Center,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentoWebIcon(
                    glyph = AgentoWebGlyph.FolderPlus,
                    contentDescription = null,
                    modifier = Modifier.size(19.dp),
                    tint = colors.accentPrimary,
                )
                Text(
                    text = createProjectLabel,
                    style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.accentPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
