package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class ProjectsReferenceSpecTest {
    @Test fun `pinned projects and sessions lead both list levels`() {
        val projects = listOf(Project("running", "Running"), Project("p", "Pinned", pinned = true))
        val sessions = listOf(
            Session("running", "Running", "running", SessionStatus.Working, updatedAt = 10),
            Session("active", "Active", "p", SessionStatus.Working, updatedAt = 20),
            Session("pinned", "Pinned", "p", SessionStatus.Completed, updatedAt = 1, pinned = true),
        )
        val groups = ProjectsReferenceSpec.projectGroups(projects, sessions)
        assertEquals(listOf("p", "running"), groups.map { it.project.id })
        assertEquals(listOf("pinned", "active"), groups.first().sessions.map { it.session.id })
        assertEquals(listOf("pinned", "active"), ProjectsReferenceSpec.sessionsOfProject(sessions, "p").map { it.session.id })
    }
    @Test
    fun `preview preserves attention priority but uses timestamps not per-session sequence numbers`() {
        val sessions = listOf(
            Session("old-active", "Old running task", "p", SessionStatus.Working, updatedAt = 1, latestSeq = 900),
            Session("new-action", "Review export", "p", SessionStatus.WaitingApproval, updatedAt = 2, latestSeq = 1),
            Session("new-finished", "Latest result", "p", SessionStatus.Completed, updatedAt = 4, latestSeq = 1),
            Session("old-finished", "Old result", "p", SessionStatus.Completed, updatedAt = 3, latestSeq = 500),
        )
        val group = ProjectsReferenceSpec.projectGroups(listOf(Project("p", "Operations")), sessions).single()
        assertEquals(listOf("new-action", "old-active", "new-finished"), group.sessions.map { it.session.id })
        assertEquals(4, group.sessionCount)
        assertEquals(listOf("new-action", "old-active", "new-finished", "old-finished"),
            ProjectsReferenceSpec.sessionsOfProject(sessions, "p").map { it.session.id })
    }

    @Test
    fun `project recency includes activity outside the preview and keeps running projects first`() {
        val projects = listOf(Project("active", "Running"), Project("recent", "Recent"), Project("older", "Older"))
        val sessions = listOf(
            Session("running", "Working", "active", SessionStatus.Working, updatedAt = 1),
            Session("approval", "Approval", "recent", SessionStatus.WaitingApproval, updatedAt = 2),
            Session("hidden", "Latest completed result", "recent", SessionStatus.Completed, updatedAt = 100),
            Session("history", "Lots of past events", "older", SessionStatus.Completed, updatedAt = 50, latestSeq = 999),
        )
        assertEquals(listOf("active", "recent", "older"),
            ProjectsReferenceSpec.projectGroups(projects, sessions, previewLimit = 1).map { it.project.id })
    }

    @Test
    fun `unassigned preview uses the same recency and stable tie break`() {
        val sessions = listOf(
            Session("z", "Older", updatedAt = 1, latestSeq = 999),
            Session("b", "Recent b", updatedAt = 2),
            Session("a", "Recent a", updatedAt = 2),
        )
        assertEquals(listOf("a", "b"), ProjectsReferenceSpec.projectGroups(emptyList(), sessions, 2)
            .single().sessions.map { it.session.id })
    }

    @Test
    fun `project groups keep full count while preview stays capped and attention is first`() {
        val project = Project("p", "Operations")
        val sessions = (1..5).map { index ->
            Session("s$index", "Session $index", "p", if (index == 5) SessionStatus.Working else SessionStatus.Completed, latestSeq = index.toLong())
        }

        val group = ProjectsReferenceSpec.projectGroups(listOf(project), sessions).single()

        assertEquals(5, group.sessionCount)
        assertEquals(ProjectsReferenceSpec.PreviewLimit, group.sessions.size)
        assertEquals(SessionIndicatorUi.Running, group.sessions.first().indicator)
        assertEquals(5, ProjectsReferenceSpec.sessionsOfProject(sessions, "p").size)
    }

    @Test
    fun `project groups retain unassigned sessions in a stable inbox group`() {
        val unassigned = Session("s1", "Inbox task", projectId = null, latestSeq = 7)

        val group = ProjectsReferenceSpec.projectGroups(emptyList(), listOf(unassigned)).single()

        assertEquals("未归类会话", group.project.name)
        assertEquals(1, group.sessionCount)
        assertEquals("s1", group.sessions.single().session.id)
    }

    @Test
    fun `catalog search matches session title project name and folder`() {
        val projects = listOf(
            Project("ops", "Operations", "C:/Work/operations"),
            Project("reports", "Quarterly reports", "C:/Work/reports"),
        )
        val sessions = listOf(
            Session("cleanup", "Clean weekly export", "ops"),
            Session("quarterly", "Prepare slides", "reports"),
        )

        assertEquals(listOf("cleanup"), ProjectsReferenceSpec.filterCatalog(projects, sessions, "clean").sessions.map { it.id })
        assertEquals(listOf("quarterly"), ProjectsReferenceSpec.filterCatalog(projects, sessions, "reports").sessions.map { it.id })
        assertEquals(listOf("ops"), ProjectsReferenceSpec.filterCatalog(projects, sessions, "operations").projects.map { it.id })
    }

    @Test
    fun `session rows project web attention metadata into unread and action signals`() {
        val now = 1_700_000_000_000L
        val project = Project("p", "Operations")
        val sessions = listOf(
            Session(
                id = "reply",
                title = "Answer the open question",
                projectId = "p",
                status = SessionStatus.WaitingApproval,
                updatedAt = now,
                waitingAction = "reply",
            ),
            Session(
                id = "unread",
                title = "Review the finished report",
                projectId = "p",
                status = SessionStatus.Completed,
                updatedAt = now - 60_000,
                lastAssistantMessageAt = now,
            ),
        )

        val rows = ProjectsReferenceSpec.projectGroups(listOf(project), sessions).single().sessions

        assertEquals(SessionActionUi.Reply, rows.first { it.session.id == "reply" }.action)
        assertEquals(true, rows.first { it.session.id == "unread" }.unread)
    }
}
