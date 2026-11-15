package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Computer
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus

/**
 * Presentation-only projection for the Projects/Sessions reference slice.
 * Runtime and persistence models remain the source of truth; this layer only
 * gives the visual surface stable ordering and compact state marks.
 */
data class ProjectGroupUi(
    val project: Project,
    val sessionCount: Int,
    val sessions: List<SessionRowUi>,
)

data class SessionRowUi(
    val session: Session,
    val indicator: SessionIndicatorUi,
    val unread: Boolean = session.hasUnreadAssistantMessage(),
    val action: SessionActionUi? = session.sessionAction(),
)

enum class SessionActionUi {
    Reply,
    Approval,
}

enum class SessionIndicatorUi {
    Running,
    NeedsAction,
    Completed,
    Failed,
    Idle,
}

data class SessionCatalogUi(
    val projects: List<Project>,
    val sessions: List<Session>,
)

object ProjectsReferenceSpec {
    private const val UnassignedProjectId = "__unassigned__"
    private const val UnassignedProjectName = "未归类会话"
    const val PreviewLimit = 3
    const val MobilePreviewLimit = 2
    const val DesktopPreviewLimit = 3
    const val ProjectIndentDp = 24
    const val HeaderHeightDp = 52
    const val PreviewRowHeightDp = 44
    const val BottomActionHeightDp = 52

    fun projectGroups(
        projects: List<Project>,
        sessions: List<Session>,
        previewLimit: Int = PreviewLimit,
    ): List<ProjectGroupUi> {
        val byProject = sessions.groupBy { it.projectId }
        fun sessionsFor(group: ProjectGroupUi) = byProject[
            group.project.id.takeUnless { it == UnassignedProjectId }
        ].orEmpty()
        val groups = projects
            .map { project ->
                ProjectGroupUi(
                    project = project,
                    sessionCount = byProject[project.id].orEmpty().size,
                    sessions = previewSessions(byProject[project.id].orEmpty(), previewLimit),
                )
            }
            .toMutableList()
        val unassigned = byProject[null].orEmpty()
        if (unassigned.isNotEmpty()) {
            groups += ProjectGroupUi(
                project = Project(UnassignedProjectId, UnassignedProjectName),
                sessionCount = unassigned.size,
                sessions = previewSessions(unassigned, previewLimit),
            )
        }
        // Activity belongs to the whole project, not just its capped preview.
        // Event sequence numbers are local to a session and cannot rank two
        // different conversations (or projects) by recency.
        return groups.sortedWith(compareByDescending<ProjectGroupUi> { it.project.pinned }
                .thenByDescending { sessionsFor(it).any { session -> session.status == SessionStatus.Working } }
                .thenByDescending { sessionsFor(it).maxOfOrNull { session -> session.updatedAt } ?: 0L }
                .thenBy { it.project.id })
    }

    private fun previewSessions(sessions: List<Session>, previewLimit: Int): List<SessionRowUi> = sessions
        .sortedWith(compareByDescending<Session> { it.pinned }.thenByDescending { it.status.isAttentionOrRunning() }.thenByDescending { it.updatedAt }.thenBy { it.id })
        .take(previewLimit)
        .map { session -> session.toRowUi() }

    fun sessionsOfProject(sessions: List<Session>, projectId: String): List<SessionRowUi> {
        val domainProjectId = projectId.takeUnless { it == UnassignedProjectId }
        return previewSessions(
            sessions.filter { it.projectId == domainProjectId },
            previewLimit = Int.MAX_VALUE,
        )
    }

    fun filterCatalog(projects: List<Project>, sessions: List<Session>, query: String): SessionCatalogUi {
        val normalized = query.trim()
        if (normalized.isEmpty()) return SessionCatalogUi(projects, sessions)
        val matchingProjectIds = projects
            .filter { it.name.contains(normalized, ignoreCase = true) || it.folder?.contains(normalized, ignoreCase = true) == true }
            .mapTo(mutableSetOf()) { it.id }
        val matchingSessions = sessions.filter { session ->
            session.title.contains(normalized, ignoreCase = true) || session.projectId in matchingProjectIds
        }
        val visibleProjectIds = matchingSessions.mapNotNullTo(mutableSetOf()) { it.projectId }
        return SessionCatalogUi(
            projects = projects.filter { it.id in matchingProjectIds || it.id in visibleProjectIds },
            sessions = matchingSessions,
        )
    }

}

fun sessionIndicator(status: SessionStatus): SessionIndicatorUi = status.toIndicator()

private fun SessionStatus.isAttentionOrRunning(): Boolean = this == SessionStatus.Working || this == SessionStatus.WaitingApproval

private fun SessionStatus.toIndicator(): SessionIndicatorUi = when (this) {
    SessionStatus.Working -> SessionIndicatorUi.Running
    SessionStatus.WaitingApproval -> SessionIndicatorUi.NeedsAction
    SessionStatus.Completed -> SessionIndicatorUi.Completed
    SessionStatus.Failed, SessionStatus.Cancelled -> SessionIndicatorUi.Failed
    SessionStatus.Idle -> SessionIndicatorUi.Idle
}

private fun Session.toRowUi(): SessionRowUi = SessionRowUi(
    session = this,
    indicator = status.toIndicator(),
    unread = hasUnreadAssistantMessage(),
    action = sessionAction(),
)

private fun Session.hasUnreadAssistantMessage(): Boolean = status != SessionStatus.Working
    && (lastAssistantMessageAt ?: 0L) > maxOf(lastReviewedAt ?: 0L, 0L)

private fun Session.sessionAction(): SessionActionUi? = when {
    status != SessionStatus.WaitingApproval && waitingAction.equals("approval", ignoreCase = true) -> SessionActionUi.Approval
    status == SessionStatus.WaitingApproval && waitingAction.equals("reply", ignoreCase = true) -> SessionActionUi.Reply
    status == SessionStatus.WaitingApproval -> SessionActionUi.Approval
    else -> null
}

object ProjectsReferenceFixtures {
    private val fixtureNow = System.currentTimeMillis()

    val computers = listOf(
        Computer("computer-windows", "Office PC", "Windows", connected = true),
        Computer("computer-linux", "Build machine", "Linux", connected = false),
    )

    val projects = listOf(
        Project("project-operations", "Operations", "C:/Work/operations"),
        Project("project-reports", "Quarterly reports", "C:/Work/reports"),
        Project("project-inbox", "Unsorted work", "C:/Work/inbox"),
    )

    val sessions = listOf(
        Session(
            "session-cleanup",
            "Clean up weekly exports",
            "project-operations",
            SessionStatus.Working,
            latestSeq = 12,
            updatedAt = fixtureNow,
        ),
        Session(
            "session-approval",
            "Review the monthly export",
            "project-operations",
            SessionStatus.WaitingApproval,
            latestSeq = 10,
            updatedAt = fixtureNow - 2 * 60_000L,
            lastAssistantMessageAt = fixtureNow - 2 * 60_000L,
            lastReviewedAt = fixtureNow - 10 * 60_000L,
            waitingAction = "approval",
        ),
        Session(
            "session-archive",
            "Archive completed files",
            "project-operations",
            SessionStatus.Completed,
            latestSeq = 6,
            updatedAt = fixtureNow - 60 * 60_000L,
            lastAssistantMessageAt = fixtureNow - 60 * 60_000L,
            lastReviewedAt = fixtureNow - 2 * 60 * 60_000L,
        ),
        Session(
            "session-quarterly",
            "Prepare the quarterly report",
            "project-reports",
            SessionStatus.Completed,
            latestSeq = 8,
            updatedAt = fixtureNow - 24 * 60 * 60_000L,
            lastAssistantMessageAt = fixtureNow - 24 * 60 * 60_000L,
            lastReviewedAt = fixtureNow - 24 * 60 * 60_000L,
        ),
        Session(
            "session-inbox",
            "Rename incoming documents",
            "project-inbox",
            SessionStatus.Idle,
            latestSeq = 2,
            updatedAt = fixtureNow - 2 * 24 * 60 * 60_000L,
        ),
    )
}
