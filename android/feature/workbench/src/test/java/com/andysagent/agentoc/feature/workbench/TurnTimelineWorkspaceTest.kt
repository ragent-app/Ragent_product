package com.andysagent.agentoc.feature.workbench

import com.andysagent.agentoc.core.agentui.AgentRunStatus
import com.andysagent.agentoc.core.domain.RuntimeSelection
import com.andysagent.agentoc.core.timeline.FileChangeItem
import com.andysagent.agentoc.core.timeline.PlanStepItem
import com.andysagent.agentoc.core.timeline.TimelineItem
import com.andysagent.agentoc.core.timeline.TimelineOperationKind
import com.andysagent.agentoc.core.timeline.TimelineOperationStatus
import com.andysagent.agentoc.core.timeline.TimelineRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TurnTimelineWorkspaceTest {

    @Test fun `late run projections cannot undo completion and new runs remain independent`() {
        val completed = RunMetricsUiState(runId = "one", status = AgentRunStatus.Completed)
        assertFalse(shouldAcceptRunProjection(completed, "one", AgentRunStatus.Working))
        assertFalse(shouldAcceptRunProjection(completed, "one", null))
        assertTrue(shouldAcceptRunProjection(completed, "one", AgentRunStatus.Completed))
        assertTrue(shouldAcceptRunProjection(completed, "two", AgentRunStatus.Working))
        val items = listOf(
            TimelineItem.Message("a", 1, TimelineRole.User, "old", true, runId = "one"),
            TimelineItem.Message("b", 2, TimelineRole.User, "new", true, runId = "two"),
            TimelineItem.Message("c", 3, TimelineRole.Agent, "answer", false),
        )
        assertEquals("two", latestTimelineRunId(items))
        assertEquals("two", latestTimelineRunId(items + TimelineItem.Message("late-old", 4, TimelineRole.Agent, "old reply", true, runId = "one")))
    }

    @Test fun `run detail completion settles only its matching latest turn`() {
        val prompt = TimelineItem.Message("user", 1, TimelineRole.User, "request", true, runId = "run-1")
        val answer = TimelineItem.Message("answer", 2, TimelineRole.Agent, "done", false, runId = "run-1")
        val items = listOf(prompt, answer)
        val metrics = RunMetricsUiState(runId = "run-1", status = AgentRunStatus.Completed)
        assertTrue(latestTurnHasTerminalRun(items, null, AgentRunStatus.Idle, metrics))
        assertFalse(latestTurnHasTerminalRun(items, null, AgentRunStatus.Working, metrics.copy(runId = "run-older")))
        assertFalse(latestTurnHasTerminalRun(items, null, AgentRunStatus.Working, metrics.copy(status = AgentRunStatus.Working)))
        val pending = PendingTurnUiState("next", "next request", emptyList(), RuntimeSelection("claude"), null)
        assertFalse(latestTurnHasTerminalRun(items, pending, AgentRunStatus.Completed, metrics))
        assertFalse(latestTurnHasTerminalRun(items, pending.copy(state = PendingTurnState.Accepted), AgentRunStatus.Completed, metrics))
        assertTrue((com.andysagent.agentoc.core.timeline.settleLatestTurnMessages(items,
            latestTurnHasTerminalRun(items, null, AgentRunStatus.Idle, metrics)).last() as TimelineItem.Message).completed)
        val requestOnly = listOf(prompt.copy(runId = null, requestId = "request-1"), answer.copy(requestId = "request-1"))
        assertTrue(latestTurnHasTerminalRun(requestOnly, null, AgentRunStatus.Idle, metrics))
        assertFalse(latestTurnHasTerminalRun(requestOnly, null, AgentRunStatus.Idle, metrics.copy(runId = "other")))
        val ambiguous = requestOnly + answer.copy(id = "other", requestId = "request-1", runId = "other")
        assertFalse(latestTurnHasTerminalRun(ambiguous, null, AgentRunStatus.Idle, metrics))
    }

    @Test fun `active run stays attached to its own turn when another request is queued`() {
        val turns = listOf(TurnGroup("one", requestId = "req-one", runId = "run-one"),
            TurnGroup("two", requestId = "req-two"))
        assertEquals(0, activeRunTurnIndex(turns, "run-one", "req-one"))
        assertEquals(1, activeRunTurnIndex(turns, null, null))
    }

    @Test fun `only explicitly marked final content is separated from ordered process`() {
        val progress = TimelineItem.Message("progress", 1, TimelineRole.Agent, "Checking", true, messagePhase = "commentary")
        val thought = TimelineItem.Operation("thought", 2, TimelineOperationKind.Tool, "Thinking", "Detail", TimelineOperationStatus.Completed, isReasoning = true)
        val final = TimelineItem.Message("answer", 3, TimelineRole.Agent, "Done", true, messagePhase = "final_answer")
        assertEquals(listOf(progress, thought) to listOf(final), splitTurnEntries(listOf(progress, thought, final)))
        val legacy = final.copy(messagePhase = null)
        assertEquals(emptyList<TimelineItem>() to listOf(progress, thought, legacy), splitTurnEntries(listOf(progress, thought, legacy)))
        assertEquals(listOf(progress, thought) to listOf(legacy), splitTurnEntries(listOf(progress, thought, legacy), allowTerminalFallback = true))
        val stillStreaming = legacy.copy(completed = false)
        assertEquals(emptyList<TimelineItem>() to listOf(progress, thought, stillStreaming), splitTurnEntries(listOf(progress, thought, stillStreaming), allowTerminalFallback = true))
        assertEquals(emptyList<TimelineItem>() to listOf(legacy, thought), splitTurnEntries(listOf(legacy, thought), allowTerminalFallback = true))
        val commentary = legacy.copy(messagePhase = "commentary")
        assertEquals(emptyList<TimelineItem>() to listOf(thought, commentary), splitTurnEntries(listOf(thought, commentary)))
        assertEquals(listOf(thought) to listOf(commentary), splitTurnEntries(listOf(thought, commentary), allowTerminalFallback = true))
    }

    private val projector = TurnGroupProjector()

    @Test fun `late reply is paired by request identity rather than the newest user prompt`() {
        val a = TimelineItem.Message("user-a", 1, TimelineRole.User, "hello", true, requestId = "a", runId = "run-a")
        val b = TimelineItem.Message("user-b", 2, TimelineRole.User, "hello", true, requestId = "b", runId = "run-b")
        val replyA = TimelineItem.Message("reply-a", 3, TimelineRole.Agent, "Answer A", false, requestId = "a", runId = "run-a")
        val replyB = TimelineItem.Message("reply-b", 4, TimelineRole.Agent, "Answer B", true, requestId = "b", runId = "run-b")
        val turns = projector.project(listOf(a, b, replyA, replyB))
        assertEquals(listOf("a", "b"), turns.map { it.requestId })
        assertEquals(listOf("run-a", "run-b"), turns.map { it.runId })
        assertEquals(listOf(replyA), turns[0].agentMessages)
        assertEquals(listOf(replyB), turns[1].agentMessages)
        val finalA = replyA.copy(seq = 5, completed = true, text = "Final A")
        val settled = projector.project(listOf(a, b, replyA, replyB, finalA))
        assertEquals(listOf(finalA), settled[0].agentMessages)
        assertEquals(turns[0].id, settled[0].id)
    }

    @Test fun `reply arriving before its user echo remains in its own turn`() {
        val previousUser = TimelineItem.Message("user-a", 5, TimelineRole.User, "old", true, requestId = "a", runId = "run-a")
        val previousReply = TimelineItem.Message("reply-a", 7, TimelineRole.Agent, "old answer", true, requestId = "a", runId = "run-a")
        val newReply = TimelineItem.Message("reply-b", 11, TimelineRole.Agent, "OK", true, requestId = "b", runId = "run-b")
        val pending = PendingTurnUiState("b", "new question", emptyList(), RuntimeSelection(tool = "codex"), null,
            state = PendingTurnState.Accepted)
        val pendingResult = projector.project(listOf(previousUser, previousReply, newReply), acceptedTurns = listOf(pending))
        assertEquals(2, pendingResult.size)
        assertEquals("old", pendingResult[0].userPrompt?.text)
        assertEquals(listOf(previousReply), pendingResult[0].agentMessages)
        assertEquals("new question", pendingResult[1].userPrompt?.text)
        assertEquals(listOf(newReply), pendingResult[1].agentMessages)
        val durableUser = TimelineItem.Message("user-b", 9, TimelineRole.User, "new question", true, requestId = "b", runId = "run-b")
        val settled = projector.project(listOf(previousUser, previousReply, durableUser, newReply), acceptedTurns = listOf(pending))
        assertEquals(2, settled.size)
        assertEquals("new question", settled[1].userPrompt?.text)
        assertEquals(listOf(newReply), settled[1].agentMessages)
    }
    @Test fun `orphan reply is not attached to an unrelated previous turn`() {
        val user = TimelineItem.Message("user-a", 1, TimelineRole.User, "old", true, requestId = "a")
        val replyA = TimelineItem.Message("reply-a", 2, TimelineRole.Agent, "old answer", true, requestId = "a")
        val replyB = TimelineItem.Message("reply-b", 3, TimelineRole.Agent, "new answer", true, requestId = "b")
        val turns = projector.project(listOf(user, replyA, replyB))
        assertEquals(2, turns.size)
        assertEquals(listOf(replyA), turns[0].agentMessages)
        assertNull(turns[1].userPrompt)
        assertEquals(listOf(replyB), turns[1].agentMessages)
    }
    @Test fun `multiple accepted echoes remain visible and reconcile by request not text`() {
        val selection = RuntimeSelection(tool = "codex")
        val a = PendingTurnUiState("a", "hello", emptyList(), selection, null, state = PendingTurnState.Accepted)
        val b = a.copy(requestId = "b")
        assertEquals(2, projector.project(emptyList(), acceptedTurns = listOf(a, b)).size)
        val durableA = TimelineItem.Message("user-a", 1, TimelineRole.User, "hello", true, requestId = "a")
        val turns = projector.project(listOf(durableA), acceptedTurns = listOf(a, b))
        assertEquals(2, turns.size); assertEquals(listOf("a", "b"), turns.map { it.requestId })
        assertFalse(turns.last().isLive)
    }

    @Test fun `distinct assistant replies remain ordered and keep a stable turn identity`() {
        val first = TimelineItem.Message("first", 1, TimelineRole.Agent, "Earlier response", true)
        val second = TimelineItem.Message("second", 2, TimelineRole.Agent, "Latest response", true)
        val before = projector.project(listOf(first)).single()
        val after = projector.project(listOf(first, second)).single()
        assertEquals(listOf(first, second), after.agentMessages)
        assertEquals(second, after.finalAnswer)
        assertEquals(before.id, after.id)
    }

    @Test fun `same entity final replaces its stream without duplicating or reopening it`() {
        val live = TimelineItem.Message("reply", 1, TimelineRole.Agent, "Working", false)
        val final = live.copy(seq = 2, text = "Complete", completed = true)
        val before = projector.project(listOf(live)).single()
        val after = projector.project(listOf(live, final, live.copy(seq = 3))).single()
        assertEquals(listOf(final), after.agentMessages)
        assertEquals(before.id, after.id)
        assertEquals(final, after.finalAnswer)
        assertNull(after.streamingAnswer)
        assertFalse(after.isLive)
    }

    @Test fun `stream and completed reply with different entities are not mutually exclusive`() {
        val live = TimelineItem.Message("progress", 1, TimelineRole.Agent, "Analyzing", false)
        val final = TimelineItem.Message("result", 2, TimelineRole.Agent, "Analysis complete", true)
        val user = TimelineItem.Message("user", 3, TimelineRole.User, "Next task", true)
        val next = final.copy(id = "next-result", seq = 4, text = "Next result")
        val turns = projector.project(listOf(live, final, user, next))
        assertEquals(2, turns.size)
        assertEquals(listOf(live, final), turns[0].agentMessages)
        assertEquals(listOf(next), turns[1].agentMessages)
        assertEquals("Next task", turns[1].userPrompt?.text)
    }

    @Test
    fun `empty items projection produces empty turns`() {
        val turns = projector.project(emptyList(), null)
        assertTrue(turns.isEmpty())
    }

    @Test
    fun `user message and agent answer projected into cohesive TurnGroup`() {
        val reqId = "req-101"
        val userMsg = TimelineItem.Message(
            id = "msg-user-1",
            seq = 1L,
            role = TimelineRole.User,
            text = "Fix the login bug",
            completed = true,
            requestId = reqId,
        )
        val agentMsg = TimelineItem.Message(
            id = "msg-agent-1",
            seq = 2L,
            role = TimelineRole.Agent,
            text = "I have fixed the issue in LoginViewModel.",
            completed = true,
            requestId = reqId,
        )

        val turns = projector.project(listOf(userMsg, agentMsg), null)

        assertEquals(1, turns.size)
        val turn = turns.first()
        assertEquals(reqId, turn.requestId)
        assertNotNull(turn.userPrompt)
        assertEquals("Fix the login bug", turn.userPrompt?.text)
        assertEquals(agentMsg, turn.finalAnswer)
        assertNull(turn.operationSummary)
    }

    @Test
    fun `tool operations are coalesced into focus block summary`() {
        val reqId = "req-202"
        val userMsg = TimelineItem.Message(
            id = "msg-user-2",
            seq = 1L,
            role = TimelineRole.User,
            text = "Run tests and refactor",
            completed = true,
            requestId = reqId,
        )
        val op1 = TimelineItem.Operation(
            id = "op-1",
            seq = 2L,
            kind = TimelineOperationKind.Command,
            title = "run gradle test",
            detail = "passed 12 tests",
            status = TimelineOperationStatus.Completed,
            runId = reqId,
        )
        val op2 = TimelineItem.Operation(
            id = "op-2",
            seq = 3L,
            kind = TimelineOperationKind.FileEdit,
            title = "edit LoginViewModel.kt",
            detail = "modified lines",
            status = TimelineOperationStatus.Completed,
            runId = reqId,
        )
        val op3 = TimelineItem.Operation(
            id = "op-3",
            seq = 4L,
            kind = TimelineOperationKind.Tool,
            title = "code search",
            detail = "searching...",
            status = TimelineOperationStatus.InProgress,
            runId = reqId,
        )

        val turns = projector.project(listOf(userMsg, op1, op2, op3), null)

        assertEquals(1, turns.size)
        val turn = turns.first()
        assertNotNull(turn.operationSummary)
        val summary = turn.operationSummary!!
        assertEquals(3, summary.totalCount)
        assertEquals(1, summary.runningCount)
        assertEquals(0, summary.failedCount)
        assertTrue(summary.isWorking)
        assertEquals(3, summary.operations.size)
    }

    @Test
    fun `plans and file changes are grouped with their respective turn`() {
        val reqId = "req-303"
        val userMsg = TimelineItem.Message(
            id = "msg-user-3",
            seq = 1L,
            role = TimelineRole.User,
            text = "Add settings page",
            completed = true,
            requestId = reqId,
        )
        val plan = TimelineItem.Plan(
            id = "plan-1",
            seq = 2L,
            planId = "p1",
            title = "Implementation Plan",
            state = "active",
            revision = 1L,
            items = listOf(
                PlanStepItem(text = "Create UI", status = "completed"),
                PlanStepItem(text = "Add ViewModel", status = "in_progress"),
            ),
            runId = reqId,
        )
        val fileOp = TimelineItem.Operation(
            id = "op-file-1",
            seq = 3L,
            kind = TimelineOperationKind.FileEdit,
            title = "SettingsScreen.kt",
            detail = "diff",
            fileChanges = listOf(
                FileChangeItem(path = "feature/SettingsScreen.kt", additions = 42, deletions = 5),
            ),
            status = TimelineOperationStatus.Completed,
            runId = reqId,
        )

        val turns = projector.project(listOf(userMsg, plan, fileOp), null)

        assertEquals(1, turns.size)
        val turn = turns.first()
        assertEquals(1, turn.plans.size)
        assertEquals("Implementation Plan", turn.plans.first().title)
        assertEquals(1, turn.fileChanges.size)
        assertEquals("feature/SettingsScreen.kt", turn.fileChanges.first().path)
        assertEquals(42, turn.fileChanges.first().additions)
        assertEquals(5, turn.fileChanges.first().deletions)
    }

    @Test
    fun `pending turn is projected into turn list with pending state`() {
        val pending = PendingTurnUiState(
            requestId = "req-pending-99",
            text = "Streaming query in flight",
            attachments = emptyList(),
            selection = RuntimeSelection(tool = "codex"),
            agentId = null,
            state = PendingTurnState.Sending,
        )

        val turns = projector.project(emptyList(), pending)

        assertEquals(1, turns.size)
        val turn = turns.first()
        assertEquals("turn-pending-req-pending-99", turn.id)
        assertEquals("req-pending-99", turn.requestId)
        assertNotNull(turn.userPrompt)
        assertEquals("pending-req-pending-99", turn.userPrompt?.id)
        assertEquals("Streaming query in flight", turn.userPrompt?.text)
        assertTrue(turn.userPrompt?.isPending == true)
        assertFalse(turn.userPrompt?.pendingFailed == true)
    }

    @Test
    fun `uniqueTurnRenderKeys disambiguates duplicate turn ids`() {
        val turn1 = TurnGroup(id = "turn-1")
        val turn2 = TurnGroup(id = "turn-2")
        val turn3 = TurnGroup(id = "turn-1")

        val keys = uniqueTurnRenderKeys(listOf(turn1, turn2, turn3))

        assertEquals(3, keys.size)
        assertEquals("timeline-turn:6:turn-1:0", keys[0])
        assertEquals("timeline-turn:6:turn-2:0", keys[1])
        assertEquals("timeline-turn:6:turn-1:1", keys[2])
    }

    @Test
    fun `turn render keys remain unique when ids resemble generated or reserved keys`() {
        val turns = listOf("x", "x", "x-0", "empty", "active-run-action", "turn_dock_spacer", "x:0", "x:0")
            .map { TurnGroup(id = it) }
        val keys = uniqueTurnRenderKeys(turns)
        assertEquals(turns.size, keys.toSet().size)
        assertTrue(keys.none { it in setOf("empty", "active-run-action", "turn_dock_spacer") })
        assertEquals(uniqueTurnRenderKeys(listOf(TurnGroup(id = "x"))).first(), keys.first())
    }

    @Test
    fun `resolveTurnDockAnchorIndex correctly finds turn by requestId`() {
        val turn1 = TurnGroup(id = "turn-1", requestId = "req-1")
        val turn2 = TurnGroup(id = "turn-2", requestId = "req-2")
        val turn3 = TurnGroup(id = "pending-req-3", requestId = "req-3")

        val turns = listOf(turn1, turn2, turn3)

        assertEquals(0, resolveTurnDockAnchorIndex(turns, "req-1"))
        assertEquals(1, resolveTurnDockAnchorIndex(turns, "req-2"))
        assertEquals(2, resolveTurnDockAnchorIndex(turns, "req-3"))
        assertEquals(-1, resolveTurnDockAnchorIndex(turns, "non-existent"))
    }
}
