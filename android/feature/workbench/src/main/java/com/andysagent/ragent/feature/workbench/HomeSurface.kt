package com.andysagent.ragent.feature.workbench

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.testTag
import com.andysagent.ragent.core.designsystem.AgentoButton
import com.andysagent.ragent.core.designsystem.AgentoListItem
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.andysagent.ragent.core.agentui.AgentConnectionStatus
import com.andysagent.ragent.core.designsystem.AgentoBreathingDot
import com.andysagent.ragent.core.designsystem.AgentoFrostedGlassBox
import com.andysagent.ragent.core.designsystem.AgentoGlassSurface
import com.andysagent.ragent.core.designsystem.AgentoGlassMaterial
import com.andysagent.ragent.core.designsystem.AgentoShapes
import com.andysagent.ragent.core.designsystem.AgentoSurface
import com.andysagent.ragent.core.designsystem.AgentoWebGlyph
import com.andysagent.ragent.core.designsystem.AgentoWebIcon
import com.andysagent.ragent.core.designsystem.RagentSizes
import com.andysagent.ragent.core.designsystem.RagentSpacing
import com.andysagent.ragent.core.designsystem.LocalRagentColors
import com.andysagent.ragent.core.designsystem.agentoPressScale
import com.andysagent.ragent.core.designsystem.theme.AgentoFrostedTokens
import com.andysagent.ragent.core.model.OtherDeviceProject
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.RemoteTarget
import com.andysagent.ragent.core.protocol.TargetSummary
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.navigation.AgentoDestination
import com.andysagent.ragent.core.navigation.AgentoWindowSizeClass
import com.andysagent.ragent.core.navigation.R as NavigationR

data class HomeSummaryUi(
    val focus: List<Session>,
    val running: List<Session>,
    val recent: List<Session>,
)

object HomeReferenceSpec {
    fun fromSessions(sessions: List<Session>): HomeSummaryUi {
        val newestFirst = compareByDescending<Session> { it.updatedAt }.thenByDescending { it.latestSeq }.thenBy { it.id }
        return HomeSummaryUi(
            focus = sessions.filter { it.isAttentionUnread() }.sortedWith(newestFirst),
            running = sessions.filter { it.status == SessionStatus.Working }.sortedWith(newestFirst),
            recent = sessions.filter { it.status == SessionStatus.Completed }.sortedWith(newestFirst).take(6),
        )
    }

    private fun Session.isAttentionUnread(): Boolean {
        // Reading an approval does not resolve it. Keep the pending decision
        // discoverable until the computer reports a different task state.
        if (status == SessionStatus.WaitingApproval) return true
        if (status != SessionStatus.WaitingApproval && status != SessionStatus.Failed) return false
        val reviewedAt = lastReviewedAt ?: return true
        return reviewedAt < updatedAt
    }
}

/** Ordering stays independent from the presentation so Home never relies on paths. */
object HomeProjectSpec {
    const val RecentProjectPreviewLimit = 4

    fun recentProjects(projects: List<Project>, sessions: List<Session>): List<Project> = projects
        .sortedWith(
            compareByDescending<Project> { project ->
                sessions.filter { it.projectId == project.id }.maxOfOrNull { it.updatedAt } ?: Long.MIN_VALUE
            }.thenByDescending { project ->
                sessions.filter { it.projectId == project.id }.maxOfOrNull { it.latestSeq } ?: Long.MIN_VALUE
            }.thenBy { it.name.lowercase() },
        )

    fun recentProjectPreview(projects: List<Project>): List<Project> =
        projects.take(RecentProjectPreviewLimit)

    /** Approval-bearing devices surface first; then recency keeps the rest. */
    fun otherDeviceProjects(projects: List<OtherDeviceProject>): List<OtherDeviceProject> = projects
        .sortedWith(
            compareByDescending<OtherDeviceProject> { it.pendingApprovals > 0 }
                .thenByDescending { it.targetLastSeenAt }
                .thenByDescending { it.updatedAt }
                .thenBy { it.targetLabel.lowercase() }
                .thenBy { it.projectName.lowercase() },
        )
}

private data class HomePalette(
    val page: Color,
    val group: Color,
    val separator: Color,
    val primary: Color,
    val secondary: Color,
    val tertiary: Color,
    val action: Color,
    val attention: Color,
    val running: Color,
)

@Composable
private fun homePalette(): HomePalette {
    val colors = LocalRagentColors.current
    return if (colors.canvas.red < 0.5f) {
        HomePalette(
            page = colors.canvas,
            group = colors.quietSurface,
            separator = colors.subtleOutline,
            primary = colors.primaryContent,
            secondary = colors.secondaryContent,
            tertiary = colors.tertiaryContent,
            action = colors.accentPrimary,
            attention = Color(0xFFD5A653),
            running = colors.running,
        )
    } else {
        HomePalette(
            page = colors.canvas,
            group = colors.quietSurface,
            separator = colors.subtleOutline,
            primary = colors.primaryContent,
            secondary = colors.secondaryContent,
            tertiary = colors.tertiaryContent,
            action = colors.accentPrimary,
            attention = Color(0xFFB77B24),
            running = colors.running,
        )
    }
}

@OptIn(ExperimentalMaterialApi::class)
@Composable
fun HomeSurface(
    state: WorkbenchUiState,
    onEvent: (WorkbenchEvent) -> Unit,
    windowSizeClass: AgentoWindowSizeClass,
    modifier: Modifier = Modifier,
) {
    val summary = remember(state.sessions) { HomeReferenceSpec.fromSessions(state.sessions) }
    val palette = homePalette()
    val hasRecoverableConnectionProblem = state.connection != AgentConnectionStatus.Connected &&
        (state.activeRemoteTargetId != null || state.connection in setOf(
            AgentConnectionStatus.AuthenticationRequired, AgentConnectionStatus.Error))
    val isCompletelyEmpty = state.projects.isEmpty() &&
        state.sessions.isEmpty() &&
        state.otherDeviceProjects.isEmpty() &&
        state.backgroundTargetSummaries.isEmpty() &&
        !hasRecoverableConnectionProblem
    val contentModifier = Modifier
        .fillMaxWidth()
        .widthIn(max = RagentSizes.DetailMaxWidth)

    if (state.projectCatalogLoading) {
        HomeCatalogLoadingSkeleton(
            windowSizeClass = windowSizeClass,
            modifier = modifier,
        )
        return
    }

    // An empty Home is a distinct state, not a sparse first item in a list.
    // Keeping this outside LazyColumn makes the sole next step feel deliberate
    val isDark = LocalRagentColors.current.canvas.red < 0.5f
    val canvasBrush = if (isDark) AgentoFrostedTokens.AtmosphericCanvasDark else AgentoFrostedTokens.AtmosphericCanvasLight
    if (isCompletelyEmpty) {
        Box(
            modifier = modifier
                .fillMaxSize()
                .background(canvasBrush),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .padding(
                        start = if (windowSizeClass == AgentoWindowSizeClass.Compact) 24.dp else RagentSpacing.Gutter,
                        end = if (windowSizeClass == AgentoWindowSizeClass.Compact) 24.dp else RagentSpacing.Gutter,
                        bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                HomeEmptyAction(
                    label = stringResource(if (state.activeRemoteTargetId == null)
                        R.string.journey_setup_computer else R.string.home_create_project),
                    onClick = {
                        if (state.activeRemoteTargetId == null) {
                            onEvent(WorkbenchEvent.OpenComputerSetup)
                        } else {
                        // The project location flow is hosted by the Chat
                        // root. Navigate there before opening it so the
                        // Home affordance is functional, not just visible.
                        onEvent(WorkbenchEvent.SelectDestination(AgentoDestination.Sessions))
                        onEvent(WorkbenchEvent.OpenProjectDialog)
                        }
                    },
                )
            }
        }
        return
    }

    val listState = rememberDestinationListState("home-index-scroll")
    val pullRefreshState = rememberPullRefreshState(
        refreshing = state.projectCatalogRefreshing,
        onRefresh = { onEvent(WorkbenchEvent.RefreshHome) },
    )
    // One UI expandable title: once the in-list large title scrolls away,
    // a compact glass bar takes over so the destination label stays put.
    val showCollapsedTitle = listState.firstVisibleItemIndex > 0

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(canvasBrush)
            // This must live on the parent of the scrollable: it receives
            // nested-scroll deltas that a LazyColumn consumes itself.
            .pullRefresh(pullRefreshState),
    ) {
        // Pull refresh is intentionally confined to Home, where people expect
        // cross-device work to update. It refreshes in place: cached projects
        // remain readable rather than regressing to a full-screen loader.
        LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .statusBarsPadding(),
                contentPadding = PaddingValues(
                    start = if (windowSizeClass == AgentoWindowSizeClass.Compact) 16.dp else RagentSpacing.Gutter,
                    end = if (windowSizeClass == AgentoWindowSizeClass.Compact) 16.dp else RagentSpacing.Gutter,
                    top = 16.dp,
                    bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                item(key = "home-large-title") {
                    Box(
                        modifier = contentModifier
                            .padding(horizontal = 12.dp, vertical = 2.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            text = stringResource(NavigationR.string.navigation_home),
                            style = MaterialTheme.typography.headlineLarge.copy(
                                fontSize = 30.sp,
                                fontWeight = FontWeight.SemiBold,
                            ),
                            color = palette.primary,
                        )
                    }
                }

                // Offline observations must not imply that remote work stopped.
                if (hasRecoverableConnectionProblem) {
                    item(key = "connection-notice") {
                        HomeConnectionNotice(
                            connection = state.connection,
                            onRetry = { onEvent(WorkbenchEvent.Retry) },
                            palette = palette,
                            modifier = contentModifier,
                        )
                    }
                }

                if (summary.focus.isEmpty()) {
                    item(key = "home-quiet") {
                        Text(stringResource(R.string.journey_home_quiet),
                            style = MaterialTheme.typography.bodyMedium, color = palette.secondary,
                            modifier = contentModifier.padding(horizontal = 12.dp).testTag("home-quiet"))
                    }
                }
                if (summary.focus.isNotEmpty()) {
                    item(key = "needs-attention") {
                        NeedsAttentionSection(
                            focusSessions = summary.focus,
                            onSelectSession = { onEvent(WorkbenchEvent.SelectSession(it)) },
                            onMarkSessionRead = { onEvent(WorkbenchEvent.MarkSessionRead(it)) },
                            palette = palette,
                            modifier = contentModifier,
                        )
                    }
                }

                if (summary.running.isNotEmpty()) {
                    item(key = "active-tasks") {
                        ActiveTasksSection(
                            runningSessions = summary.running,
                            onSelectSession = { onEvent(WorkbenchEvent.SelectSession(it)) },
                            palette = palette,
                            modifier = contentModifier,
                        )
                    }
                }

                if (state.backgroundTargetSummaries.isNotEmpty()) {
                    item(key = "background-computer-summaries") {
                        BackgroundComputerSummariesSection(
                            summaries = state.backgroundTargetSummaries,
                            remoteTargets = state.remoteTargets,
                            modifier = contentModifier,
                        )
                    }
                }

                val continueSession = state.sessions.filter {
                    it.latestSeq > 0 && it.status !in setOf(SessionStatus.Working, SessionStatus.WaitingApproval)
                }.maxByOrNull { it.updatedAt }
                if (continueSession != null) {
                    item(key = "continue-work") {
                        HomeSection(title = stringResource(R.string.journey_continue_work), palette = palette,
                            grouped = true, modifier = contentModifier) {
                            AgentoListItem(title = continueSession.title, onClick = {
                                onEvent(WorkbenchEvent.SelectSession(continueSession.id))
                            }, modifier = Modifier.fillMaxWidth().testTag("home-continue-work"),
                                trailing = { AgentoWebIcon(AgentoWebGlyph.ChevronRight, null, Modifier.size(24.dp)) })
                        }
                    }
                }

                item(key = "recent-projects") {
                    RecentProjectsSection(
                        projects = state.projects,
                        sessions = state.sessions,
                        showEmptyAction = state.projects.isEmpty() &&
                            state.sessions.isEmpty() &&
                            state.otherDeviceProjects.isEmpty(),
                        onOpenProject = { onEvent(WorkbenchEvent.OpenProjectSessions(it)) },
                        onOpenAllProjects = { onEvent(WorkbenchEvent.SelectDestination(AgentoDestination.Sessions)) },
                        onOpenProjectDialog = { onEvent(WorkbenchEvent.OpenProjectDialog) },
                        palette = palette,
                        modifier = contentModifier,
                    )
                }

                if (state.otherDeviceProjects.isNotEmpty()) {
                    item(key = "other-device-projects") {
                        OtherDeviceProjectsSection(
                            projects = state.otherDeviceProjects,
                            onOpenProject = { targetId, projectId ->
                                onEvent(WorkbenchEvent.OpenOtherDeviceProject(targetId, projectId))
                            },
                            palette = palette,
                            modifier = contentModifier,
                        )
                    }
                }
        }

        PullRefreshIndicator(
            refreshing = state.projectCatalogRefreshing,
            state = pullRefreshState,
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(top = 12.dp),
            backgroundColor = palette.group,
            contentColor = palette.action,
            scale = true,
        )

        // Compact collapsed bar: fades in over the status bar area once the
        // in-list large title has scrolled off, keeping the destination
        // visible the way One UI's expandable app bar does.
        AnimatedVisibility(
            visible = showCollapsedTitle,
            enter = fadeIn(tween(120)),
            exit = fadeOut(tween(120)),
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth(),
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(canvasBrush)
                    .statusBarsPadding()
                    .padding(
                        start = if (windowSizeClass == AgentoWindowSizeClass.Compact) 24.dp else RagentSpacing.Gutter,
                        end = if (windowSizeClass == AgentoWindowSizeClass.Compact) 24.dp else RagentSpacing.Gutter,
                        top = 8.dp,
                        bottom = 10.dp,
                    ),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    text = stringResource(NavigationR.string.navigation_home),
                    style = MaterialTheme.typography.titleMedium.copy(
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 17.sp,
                    ),
                    color = palette.primary,
                )
            }
        }
    }
}

@Composable
private fun HomeCatalogLoadingSkeleton(
    windowSizeClass: AgentoWindowSizeClass,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val canvasBrush = if (isDark) {
        AgentoFrostedTokens.AtmosphericCanvasDark
    } else {
        AgentoFrostedTokens.AtmosphericCanvasLight
    }
    val placeholder = if (isDark) Color(0xFF45454A) else Color(0xFFE4E5EA)
    val card = if (isDark) Color(0xFF2C2C2E) else Color.White
    val contentInset = if (windowSizeClass == AgentoWindowSizeClass.Compact) 16.dp else RagentSpacing.Gutter

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(canvasBrush),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = RagentSizes.DetailMaxWidth)
                .align(Alignment.TopCenter)
                .statusBarsPadding()
                .padding(
                    start = contentInset,
                    end = contentInset,
                    top = 18.dp,
                    bottom = com.andysagent.ragent.core.designsystem.remainingAppSystemBars().asPaddingValues().calculateBottomPadding() + 120.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                modifier = Modifier
                    .padding(start = 12.dp)
                    .width(120.dp)
                    .height(36.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(placeholder),
            )
            Box(Modifier.fillMaxWidth().height(48.dp).padding(start = 12.dp), contentAlignment = Alignment.CenterStart) {
                Box(Modifier.width(124.dp).height(18.dp).clip(RoundedCornerShape(6.dp)).background(placeholder))
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(card),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    repeat(4) { index ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(RagentSizes.CardRowHeight)
                                .padding(horizontal = 12.dp),
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
                                    .width(if (index == 1) 176.dp else 232.dp)
                                    .height(18.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(placeholder),
                            )
                        }
                        if (index < 3) {
                            HorizontalDivider(
                                modifier = Modifier.padding(start = 44.dp),
                                thickness = 0.5.dp,
                                color = if (isDark) Color(0xFF38383A) else Color(0xFFE7E8ED),
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun HomeConnectionNotice(
    connection: AgentConnectionStatus,
    onRetry: () -> Unit,
    palette: HomePalette,
    modifier: Modifier = Modifier,
) {
    val message = when (connection) {
        AgentConnectionStatus.Connecting,
        AgentConnectionStatus.Reconnecting,
        AgentConnectionStatus.Disconnected,
        -> stringResource(R.string.journey_connection_uncertain)
        AgentConnectionStatus.Connected -> return
        AgentConnectionStatus.AuthenticationRequired -> stringResource(R.string.home_connection_authentication_required)
        AgentConnectionStatus.Error -> stringResource(R.string.home_connection_failed)
    }
    val accent = if (connection == AgentConnectionStatus.AuthenticationRequired || connection == AgentConnectionStatus.Error) {
        Color(0xFFFF3B30)
    } else {
        palette.secondary
    }

    HomeSectionGroup(modifier = modifier, palette = palette) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = RagentSizes.CardRowHeight)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AgentoWebIcon(
                glyph = AgentoWebGlyph.Info,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
                tint = accent,
            )
            Text(
                text = message,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                color = palette.primary,
            )
            HomeIconAction(
                glyph = AgentoWebGlyph.Refresh,
                contentDescription = stringResource(R.string.workbench_reconnect),
                tint = palette.action,
                onClick = onRetry,
            )
        }
    }
}

@Composable
private fun NeedsAttentionSection(
    focusSessions: List<Session>,
    onSelectSession: (String) -> Unit,
    onMarkSessionRead: (String) -> Unit,
    palette: HomePalette,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val visibleSessions = if (expanded) focusSessions else focusSessions.take(2)
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.home_needs_attention),
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleLarge.copy(
                    fontSize = 19.sp,
                    fontWeight = FontWeight.Medium,
                ),
                color = palette.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (focusSessions.size > 2) {
                val actionLabel = stringResource(if (expanded) R.string.journey_show_less else R.string.journey_show_all_actions)
                Text(
                    text = actionLabel,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .agentoPressScale(pressedScale = 0.96f, onClick = { expanded = !expanded })
                        .padding(horizontal = 6.dp)
                        .semantics {
                            role = Role.Button
                            contentDescription = actionLabel
                        },
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                    color = palette.action,
                )
            }
        }
        HomeSectionGroup(palette = palette) {
            visibleSessions.forEachIndexed { index, session ->
                AttentionRow(
                    session = session,
                    onOpen = { onSelectSession(session.id) },
                    onMarkRead = { onMarkSessionRead(session.id) },
                    palette = palette,
                    // Persistent inbox entries stay quiet; the floating alert
                    // already owns the high-priority emphasis for this task.
                    emphasized = false,
                )
                if (index < visibleSessions.lastIndex) HomeDivider(palette)
            }
        }
    }
}

@Composable
private fun AttentionRow(
    session: Session,
    onOpen: () -> Unit,
    onMarkRead: () -> Unit,
    palette: HomePalette,
    emphasized: Boolean,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = RagentSizes.CardRowHeight)
            .agentoPressScale(pressedScale = 0.985f, onClick = onOpen)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        HomeIconBadge(
            glyph = AgentoWebGlyph.Bell,
            tint = palette.attention,
            palette = palette,
            emphasized = emphasized,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = session.title,
                style = MaterialTheme.typography.titleMedium.copy(
                    fontSize = 16.sp,
                    lineHeight = 22.sp,
                    fontWeight = if (emphasized) FontWeight.SemiBold else FontWeight.Medium,
                ),
                color = palette.primary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(stringResource(when {
                session.status == SessionStatus.Failed -> R.string.journey_task_failed
                session.waitingAction == "reply" -> R.string.journey_reply_needed
                else -> R.string.journey_approval_needed
            }), style = MaterialTheme.typography.bodySmall, color = palette.secondary)
        }
        if (session.status != SessionStatus.WaitingApproval) HomeIconAction(
            glyph = AgentoWebGlyph.Check,
            contentDescription = stringResource(R.string.home_mark_read),
            tint = palette.tertiary,
            onClick = onMarkRead,
        )
    }
}

@Composable
private fun ActiveTasksSection(
    runningSessions: List<Session>,
    onSelectSession: (String) -> Unit,
    palette: HomePalette,
    modifier: Modifier = Modifier,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val visibleSessions = if (expanded) runningSessions else runningSessions.take(2)
    HomeSection(
        title = stringResource(R.string.home_active_tasks),
        palette = palette,
        grouped = true,
        actionLabel = stringResource(if (expanded) R.string.journey_show_less else R.string.home_view_all_projects)
            .takeIf { runningSessions.size > 2 },
        onAction = { expanded = !expanded },
        modifier = modifier,
    ) {
        visibleSessions.forEachIndexed { index, session ->
            RunningTaskRow(
                title = session.title,
                onClick = { onSelectSession(session.id) },
                palette = palette,
            )
            if (index < visibleSessions.lastIndex) HomeDivider(palette)
        }
    }
}

@Composable
private fun RunningTaskRow(
    title: String,
    onClick: () -> Unit,
    palette: HomePalette,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = RagentSizes.CardRowHeight)
            .agentoPressScale(pressedScale = 0.985f, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier.size(30.dp),
            contentAlignment = Alignment.Center,
        ) {
            AgentoBreathingDot(color = palette.running, size = 9.dp)
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 16.5.sp, fontWeight = FontWeight.Medium),
                color = palette.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // The task title is the thing that needs attention. Its project
            // is intentionally omitted here so an active list remains
            // scannable instead of becoming a stack of metadata.
        }
        AgentoWebIcon(
            glyph = AgentoWebGlyph.ChevronRight,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = palette.tertiary,
        )
    }
}

@Composable
private fun RecentProjectsSection(
    projects: List<Project>,
    sessions: List<Session>,
    showEmptyAction: Boolean,
    onOpenProject: (String) -> Unit,
    onOpenAllProjects: () -> Unit,
    onOpenProjectDialog: () -> Unit,
    palette: HomePalette,
    modifier: Modifier = Modifier,
) {
    val recentProjects = remember(projects, sessions) { HomeProjectSpec.recentProjects(projects, sessions) }
    val previewProjects = remember(recentProjects) { HomeProjectSpec.recentProjectPreview(recentProjects) }

    if (previewProjects.isEmpty()) {
        if (showEmptyAction) {
            EmptyProjectsState(
                onClick = onOpenProjectDialog,
                modifier = modifier,
            )
        }
        return
    }

    // Home is a continuation surface, not a promotional project card. A
    // regular grouped list keeps a project name readable without making a
    // single item dominate the entire screen.
    HomeSection(
        title = stringResource(R.string.home_recent_projects),
        palette = palette,
        grouped = true,
        actionLabel = stringResource(R.string.home_view_all_projects).takeIf {
            recentProjects.size > previewProjects.size
        },
        onAction = onOpenAllProjects,
        modifier = modifier,
    ) {
        previewProjects.forEachIndexed { index, project ->
            ProjectRow(
                projectName = project.name,
                pendingApprovals = 0,
                onClick = { onOpenProject(project.id) },
                palette = palette,
            )
            if (index < previewProjects.lastIndex) HomeDivider(palette)
        }
    }
}

@Composable
private fun EmptyProjectsState(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val createProjectLabel = stringResource(R.string.home_create_project)
    // Home is a notification surface. When there is no activity, do not turn
    // it into a promotional empty state. The single creation affordance stays
    // in the trailing edge where it remains discoverable without becoming the
    // page's visual subject.
    Box(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.TopEnd,
    ) {
        HomeEmptyAction(label = createProjectLabel, onClick = onClick)
    }
}

/**
 * Creating a project is the only empty-Home action, but it isn't a destructive
 * confirmation. Keep its material neutral and reserve blue for the icon and
 * label, so the page stays calm until real work arrives.
 */
@Composable
private fun HomeEmptyAction(
    label: String,
    onClick: () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    AgentoFrostedGlassBox(
        modifier = Modifier
            .height(52.dp)
            .widthIn(min = 176.dp)
            .agentoPressScale(pressedScale = 0.975f, onClick = onClick)
            .semantics { contentDescription = label },
        shape = AgentoShapes.PillShape,
        // On a quiet canvas, a neutral One UI fog surface protects legibility
        // without inventing a colourful page backdrop.
        surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkDockGlassBrush else AgentoFrostedTokens.LightDockGlassBrush),
        blurRadius = AgentoFrostedTokens.BlurNavigation,
        showTopHairline = true,
        material = AgentoGlassMaterial.LiquidClear,
        hasShadow = true,
        shadowElevation = 10.dp,
        shadowAlpha = if (isDark) 0.10f else 0.06f,
        shadowSpotAlpha = if (isDark) 0.08f else 0.02f,
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
                text = label,
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                color = colors.accentPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun OtherDeviceProjectsSection(
    projects: List<OtherDeviceProject>,
    onOpenProject: (targetId: String, projectId: String) -> Unit,
    palette: HomePalette,
    modifier: Modifier = Modifier,
) {
    val sortedProjects = remember(projects) { HomeProjectSpec.otherDeviceProjects(projects) }
    HomeSection(
        title = stringResource(R.string.home_other_device_projects),
        palette = palette,
        grouped = true,
        modifier = modifier,
    ) {
        sortedProjects.forEachIndexed { index, project ->
            ProjectRow(
                projectName = project.projectName,
                pendingApprovals = project.pendingApprovals,
                onClick = { onOpenProject(project.targetId, project.projectId) },
                palette = palette,
            )
            if (index < sortedProjects.lastIndex) HomeDivider(palette)
        }
    }
}

@Composable
private fun ProjectRow(
    projectName: String,
    pendingApprovals: Int,
    onClick: () -> Unit,
    palette: HomePalette,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = RagentSizes.CardRowHeight)
            .agentoPressScale(pressedScale = 0.985f, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AgentoWebIcon(
            glyph = AgentoWebGlyph.Folder,
            contentDescription = null,
            modifier = Modifier.size(20.dp),
            tint = palette.action,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = projectName,
                style = MaterialTheme.typography.titleMedium.copy(
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Medium,
                ),
                color = palette.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (pendingApprovals > 0) {
            // The device cannot proceed until this phone answers. Surface the
            // count here instead of burying it behind the project page.
            Surface(
                shape = AgentoShapes.PillShape,
                color = palette.attention.copy(alpha = 0.16f),
                contentColor = palette.attention,
            ) {
                Text(
                    text = androidx.compose.ui.res.pluralStringResource(
                        R.plurals.home_approvals_waiting, pendingApprovals, pendingApprovals,
                    ),
                    style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp),
                    maxLines = 1,
                )
            }
        }
        AgentoWebIcon(
            glyph = AgentoWebGlyph.ChevronRight,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = palette.tertiary,
        )
    }
}

@Composable
private fun HomeSection(
    title: String,
    palette: HomePalette,
    modifier: Modifier = Modifier,
    grouped: Boolean = true,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 12.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = title,
                modifier = Modifier.weight(1f),
                style = TextStyle(
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.primary,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (actionLabel != null && onAction != null) {
                // The touch target is a container; a tall Text lays its glyphs
                // at the top and leaves the section title on another baseline.
                Box(
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .agentoPressScale(pressedScale = 0.96f, onClick = onAction)
                        .padding(horizontal = 6.dp)
                        .semantics {
                            role = Role.Button
                            contentDescription = actionLabel
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = actionLabel,
                        style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Medium, color = palette.action),
                    )
                }
            }
        }
        if (grouped) {
            HomeSectionGroup(palette = palette, content = content)
        } else {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) { content() }
        }
    }
}

@Composable
private fun HomeSectionGroup(
    palette: HomePalette,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    val cardShape = RoundedCornerShape(16.dp)
    val cardBg = if (isDark) Color(0xFF2C2C2E) else Color.White
    Box(
        modifier = modifier
            .fillMaxWidth()
            .shadow(
                elevation = if (isDark) 1.dp else 2.dp,
                shape = cardShape,
                clip = false,
                ambientColor = Color.Black.copy(alpha = if (isDark) 0.12f else 0.025f),
                spotColor = Color.Black.copy(alpha = if (isDark) 0.14f else 0.035f),
            )
            .clip(cardShape)
            .background(cardBg),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth(),
        ) {
            content()
        }
    }
}

@Composable
private fun HomeDivider(palette: HomePalette, inset: Dp = 44.dp) {
    val isDark = palette.primary.red > 0.5f
    HorizontalDivider(
        modifier = Modifier.padding(start = inset),
        thickness = 0.5.dp,
        color = if (isDark) Color(0xFF38383A) else Color(0xFFE5E5EA),
    )
}

@Composable
private fun HomeIconBadge(
    glyph: AgentoWebGlyph,
    tint: Color,
    palette: HomePalette,
    emphasized: Boolean = false,
) {
    // Settings-style bare glyph, sized to match the 30dp tile it replaces.
    Box(
        modifier = Modifier.size(30.dp),
        contentAlignment = Alignment.Center,
    ) {
        AgentoWebIcon(glyph, null, Modifier.size(20.dp), tint = tint)
    }
}

@Composable
private fun HomeIconAction(
    glyph: AgentoWebGlyph,
    contentDescription: String,
    tint: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(44.dp)
            .agentoPressScale(pressedScale = 0.94f, onClick = onClick)
            .semantics {
                role = Role.Button
                this.contentDescription = contentDescription
            },
        contentAlignment = Alignment.Center,
    ) {
        AgentoWebIcon(glyph, null, Modifier.size(18.dp), tint = tint)
    }
}

@Composable
private fun BackgroundComputerSummariesSection(
    summaries: List<TargetSummary>,
    remoteTargets: List<RemoteTarget>,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRagentColors.current
    val isDark = colors.canvas.red < 0.5f
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.home_computer_activity),
            style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.5.sp),
            color = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
        )
        summaries.forEach { summary ->
            val label = remoteTargets.firstOrNull { it.instanceId == summary.targetId }?.label
                ?.takeIf(String::isNotBlank)
                ?: summary.targetId
            val detail = buildList {
                add("${summary.sessions.active} active")
                add("${summary.sessions.total} sessions")
                if (summary.approvals.pending > 0) add("${summary.approvals.pending} approval${if (summary.approvals.pending == 1) "" else "s"}")
            }.joinToString(" · ")
            val activity = summary.recentActivity.firstOrNull()?.title?.takeIf(String::isNotBlank)
                ?: "Home summary is up to date"
            AgentoFrostedGlassBox(
                shape = RoundedCornerShape(16.dp),
                surface = AgentoGlassSurface.BrushOverlay(if (isDark) AgentoFrostedTokens.DarkCardGlassBrush else AgentoFrostedTokens.LightCardGlassBrush),
                blurRadius = AgentoFrostedTokens.BlurNavigation,
                material = AgentoGlassMaterial.LiquidClear,
                showTopHairline = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics { contentDescription = "Background computer $label" },
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Surface(
                        modifier = Modifier.size(40.dp),
                        shape = CircleShape,
                        color = colors.actionPrimary.copy(alpha = 0.14f),
                        contentColor = colors.accentPrimary,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            AgentoWebIcon(
                                glyph = AgentoWebGlyph.Monitor,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = colors.accentPrimary,
                            )
                        }
                    }
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = label,
                            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
                            color = if (isDark) AgentoFrostedTokens.TextPrimary else colors.primaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            text = detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (isDark) AgentoFrostedTokens.TextSecondary else colors.secondaryContent,
                        )
                        Text(
                            text = activity,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (isDark) AgentoFrostedTokens.TextTertiary else colors.tertiaryContent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}
