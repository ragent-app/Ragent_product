package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.OtherDeviceProject
import com.andysagent.ragent.core.model.Project
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import kotlin.test.Test
import kotlin.test.assertEquals

class HomeReferenceSpecTest {
    @Test
    fun `recent projects sort by session activity without relying on their folder path`() {
        val projects = listOf(
            Project("older", "Older project", "G:/private/older"),
            Project("newer", "Newer project", "C:/private/newer"),
        )
        val sessions = listOf(
            Session("old-session", "Old", projectId = "older", updatedAt = 10L, latestSeq = 1L),
            Session("new-session", "New", projectId = "newer", updatedAt = 20L, latestSeq = 2L),
        )

        assertEquals(
            listOf("newer", "older"),
            HomeProjectSpec.recentProjects(projects, sessions).map { it.id },
        )
    }

    @Test
    fun `recent project preview keeps Home focused while preserving activity order`() {
        val projects = (1..5).map { index ->
            Project("project-$index", "Project $index", "C:/private/project-$index")
        }
        val sessions = (1..5).map { index ->
            Session("session-$index", "Session $index", projectId = "project-$index", updatedAt = index.toLong())
        }

        val recent = HomeProjectSpec.recentProjects(projects, sessions)

        assertEquals(
            listOf("project-5", "project-4", "project-3", "project-2"),
            HomeProjectSpec.recentProjectPreview(recent).map { it.id },
        )
    }

    @Test
    fun `other device projects keep recently active devices ahead of newer project activity`() {
        val projects = listOf(
            OtherDeviceProject("older-device", "Studio Mac", 100L, "newer-project", "Newer project", 9_000L),
            OtherDeviceProject("recent-device", "Office PC", 200L, "older-project", "Older project", 1_000L),
            OtherDeviceProject("recent-device", "Office PC", 200L, "new-project", "Newest project", 2_000L),
        )

        assertEquals(
            listOf("new-project", "older-project", "newer-project"),
            HomeProjectSpec.otherDeviceProjects(projects).map { it.projectId },
        )
    }

    @Test
    fun `home groups attention running and recent work by current session status`() {
        val summary = HomeReferenceSpec.fromSessions(
            listOf(
                Session("waiting", "Review export", status = SessionStatus.WaitingApproval, latestSeq = 8),
                Session("failed", "Retry upload", status = SessionStatus.Failed, latestSeq = 9),
                Session("running", "Prepare report", status = SessionStatus.Working, latestSeq = 7),
                Session("done", "Archive files", status = SessionStatus.Completed, latestSeq = 6),
                Session("idle", "New session", status = SessionStatus.Idle, latestSeq = 10),
            ),
        )

        assertEquals(listOf("failed", "waiting"), summary.focus.map { it.id })
        assertEquals(listOf("running"), summary.running.map { it.id })
        assertEquals(listOf("done"), summary.recent.map { it.id })
    }

    @Test
    fun `mark read removes reviewed failure until later activity`() {
        val reviewed = Session(
            "waiting",
            "Review export",
            status = SessionStatus.Failed,
            latestSeq = 8,
            updatedAt = 1_000L,
            lastReviewedAt = 1_500L,
        )
        val unreviewed = Session(
            "failed",
            "Retry upload",
            status = SessionStatus.Failed,
            latestSeq = 9,
            updatedAt = 2_000L,
            lastReviewedAt = 1_000L,
        )

        assertEquals(emptyList(), HomeReferenceSpec.fromSessions(listOf(reviewed)).focus)

        // Any server-side activity after the review stamp puts the card back.
        assertEquals(
            listOf("waiting"),
            HomeReferenceSpec.fromSessions(listOf(reviewed.copy(updatedAt = 2_500L))).focus.map { it.id },
        )
        // Cards without a review stamp are always surfaced.
        assertEquals(listOf("failed"), HomeReferenceSpec.fromSessions(listOf(unreviewed)).focus.map { it.id })
    }

    @Test
    fun `reading a pending approval never hides an unresolved decision`() {
        val waiting = Session("approval", "Approve", status = SessionStatus.WaitingApproval,
            updatedAt = 1_000L, lastReviewedAt = 2_000L)
        assertEquals(listOf("approval"), HomeReferenceSpec.fromSessions(listOf(waiting)).focus.map { it.id })
        assertEquals(emptyList(), HomeReferenceSpec.fromSessions(listOf(waiting.copy(status = SessionStatus.Completed))).focus)
    }

    @Test
    fun `Home recency compares time rather than independent session sequence numbers`() {
        val longOldTask = Session("old", "Old", status = SessionStatus.Working, updatedAt = 1, latestSeq = 900)
        val newTask = Session("new", "New", status = SessionStatus.Working, updatedAt = 2, latestSeq = 1)
        assertEquals(listOf("new", "old"), HomeReferenceSpec.fromSessions(listOf(longOldTask, newTask)).running.map { it.id })
    }
}
