package com.andysagent.ragent.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AttentionReducerTest {

    private fun session(
        id: String,
        title: String = "Session $id",
        status: SessionStatus = SessionStatus.Idle,
        updatedAt: Long = 1_000L,
        waitingAction: String? = null,
        workflowState: String? = null,
        workflowStateChangedAt: Long? = null,
    ) = Session(
        id = id,
        title = title,
        status = status,
        updatedAt = updatedAt,
        waitingAction = waitingAction,
        workflowState = workflowState,
        workflowStateChangedAt = workflowStateChangedAt,
    )

    private fun approval(
        id: String,
        sessionId: String,
        status: String = "pending",
        kind: String = "approval",
        batchId: String? = null,
        riskLevel: String? = null,
        passkeyRequired: Boolean = true,
    ) = Approval(
        id = id,
        sessionId = sessionId,
        title = "approval $id",
        status = status,
        kind = kind,
        batchId = batchId,
        riskLevel = riskLevel,
        passkeyRequired = passkeyRequired,
    )

    @Test
    fun `pending approval projects an approval item with stable identity`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1", status = SessionStatus.WaitingApproval)),
            approvals = listOf(approval("a1", "s1")),
        )
        assertEquals(1, items.size)
        assertEquals(AttentionReducer.approvalItemId("s1", "a1"), items.single().id)
        assertEquals(AttentionKind.Approval, items.single().kind)
    }

    @Test
    fun `Windows Broker approval uses shared attention even while its session is open`() {
        val approval = approval(
            id = "broker-1",
            sessionId = "s1",
            kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
            riskLevel = "privileged",
            passkeyRequired = false,
        )
        val items = AttentionReducer.projectBrokerApprovals(listOf(approval))
        val state = AttentionReducer.reduce(AttentionUiState(visibleSessionId = "s1"), items)

        assertEquals("windows-broker:unbound:broker-1:unbound", state.activeItem?.id)
        assertEquals(AttentionKind.Approval, state.activeItem?.kind)
        assertFalse(state.activeItem?.requiresSession ?: true)
        assertEquals(AttentionItem.PRIORITY_DANGEROUS, state.activeItem?.priority)
    }

    @Test
    fun `the same Broker request ID on two computers has distinct presentation identity`() {
        val base = approval(
            id = "same-request",
            sessionId = "same-session",
            kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
        )
        val items = AttentionReducer.projectBrokerApprovals(
            listOf(
                base.copy(brokerTargetInstanceId = "computer-a"),
                base.copy(brokerTargetInstanceId = "computer-b"),
            ),
        )
        assertEquals(
            setOf("windows-broker:computer-a:same-request:unbound", "windows-broker:computer-b:same-request:unbound"),
            AttentionReducer.reduce(AttentionUiState(), items).items.map { it.id }.toSet(),
        )
        val renewed = AttentionReducer.projectBrokerApprovals(
            listOf(base.copy(brokerTargetInstanceId = "computer-a", brokerChallengeDigest = "new-nonce-digest")),
        )
        assertEquals("windows-broker:computer-a:same-request:new-nonce-digest", renewed.single().id)
    }

    @Test
    fun `resolved approvals never reappear from the projection`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1")),
            approvals = listOf(approval("a1", "s1", status = "approved")),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `batch and passkey approvals require the session surface`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1")),
            approvals = listOf(approval("a1", "s1", batchId = "b1", passkeyRequired = true)),
        )
        assertTrue(items.single().requiresSession)
    }

    @Test
    fun `dangerous approvals rank above questions above completions`() {
        val now = System.currentTimeMillis()
        val items = AttentionReducer.project(
            sessions = listOf(
                session("done", status = SessionStatus.Completed, updatedAt = now),
                session("ask", status = SessionStatus.WaitingApproval, waitingAction = "reply", workflowState = "waiting_user", updatedAt = now),
                session("risk", status = SessionStatus.WaitingApproval, updatedAt = now),
            ),
            approvals = listOf(approval("r1", "risk", riskLevel = "destructive")),
        )
        assertEquals(
            listOf("risk", "ask", "done"),
            items.map { it.sessionId },
        )
        assertEquals(AttentionItem.PRIORITY_DANGEROUS, items.first { it.sessionId == "risk" }.priority)
        assertEquals(AttentionItem.PRIORITY_NORMAL, items.first { it.sessionId == "ask" }.priority)
        assertEquals(AttentionItem.PRIORITY_COMPLETION, items.first { it.sessionId == "done" }.priority)
    }

    @Test
    fun `failure outranks completion`() {
        val now = System.currentTimeMillis()
        val items = AttentionReducer.project(
            sessions = listOf(
                session("ok", status = SessionStatus.Completed, updatedAt = now),
                session("bad", status = SessionStatus.Failed, updatedAt = now),
            ),
            approvals = emptyList(),
        )
        assertEquals("bad", items.first().sessionId)
        assertEquals(AttentionKind.Failure, items.first().kind)
        assertEquals(AttentionKind.Completion, items.last().kind)
    }

    @Test
    fun `stale completions are not projected`() {
        val items = AttentionReducer.project(
            sessions = listOf(
                session("old", status = SessionStatus.Completed, updatedAt = 1L),
                session("fresh", status = SessionStatus.Completed, updatedAt = System.currentTimeMillis()),
            ),
            approvals = emptyList(),
        )
        assertEquals(listOf("fresh"), items.map { it.sessionId })
    }

    @Test
    fun `plain runtime approvals resolve inline`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1")),
            approvals = listOf(Approval(id = "a1", sessionId = "s1", title = "Command", runId = "run-1")),
        )
        assertFalse(items.single().requiresSession)
    }

    @Test
    fun `multiple pending requests from one session remain in the queue`() {
        val items = AttentionReducer.project(
            listOf(session("s1", status = SessionStatus.WaitingApproval)),
            listOf(approval("a1", "s1", passkeyRequired = false), approval("a2", "s1", passkeyRequired = false)),
        )
        assertEquals(setOf("a1", "a2"), items.mapNotNull { it.approval?.id }.toSet())
        val current = AttentionReducer.reduce(AttentionUiState(), items)
        assertEquals(1, current.queuedCount)
        assertEquals(1, AttentionReducer.reduce(current, items.filterNot { it.id == current.activeItemId }).items.size)
    }

    @Test
    fun `matching batch hides only the represented provider approval`() {
        val shadow = approval("provider", "s1", kind = "approval_request", passkeyRequired = false)
            .copy(runId = "run", identityAliases = setOf("provider-request"))
        val unrelated = approval("unrelated", "s1", kind = "approval_request", passkeyRequired = false).copy(runId = "run")
        val otherRun = shadow.copy(id = "other-run", runId = "another-run")
        val batch = Approval(id = "batch", sessionId = "s1", title = "Batch", kind = "privileged_batch_request", runId = "run", batchId = "batch",
            actions = listOf(ApprovalAction(id = "op", category = "privileged_other", identityAliases = setOf("provider-request"))))
        val pending = listOf(shadow, unrelated, otherRun, batch)
        assertEquals(setOf("unrelated", "other-run", "batch"), withoutBatchApprovalShadows(pending).map { it.id }.toSet())
        assertEquals(setOf("unrelated", "other-run", "batch"), AttentionReducer.project(listOf(session("s1")), pending).mapNotNull { it.approval?.id }.toSet())
        val resolved = pending.map { if (it.id == "batch") it.copy(status = "resolved") else it }
        assertEquals(resolved, withoutBatchApprovalShadows(resolved))
    }

    @Test
    fun `legacy privileged categories with complete identity can be handled inline`() {
        val legacy = Approval(id = "b", sessionId = "s1", title = "Privileged", kind = "privileged_batch_request",
            runId = "r", batchId = "b", passkeyRequired = false,
            actions = listOf(ApprovalAction(id = "op", description = "Restart", category = "privileged_other")))
        assertFalse(AttentionReducer.project(listOf(session("s1")), listOf(legacy)).single().requiresSession)
        assertTrue(AttentionReducer.project(listOf(session("s1")), listOf(legacy.copy(runId = null))).single().requiresSession)
    }

    @Test
    fun `provider plan kind survives the approval event envelope`() {
        val approval = Approval(id = "plan-1", sessionId = "s1", title = "Plan", requestKind = "plan")
        assertEquals(AttentionKind.Plan, AttentionReducer.project(listOf(session("s1")), listOf(approval)).single().kind)
    }

    @Test
    fun `structured question approval is inline even when legacy passkey default is present`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1")),
            approvals = listOf(
                approval("q1", "s1", kind = "approval_request").copy(
                    questions = listOf(
                        ApprovalQuestion(
                            question = "Which release mode should be used?",
                            options = listOf(ApprovalOption("Canary"), ApprovalOption("Full")),
                        ),
                    ),
                ),
            ),
        )
        assertEquals(AttentionKind.Question, items.single().kind)
        assertFalse(items.single().requiresSession)
        assertEquals(AttentionItem.PRIORITY_NORMAL, items.single().priority)
    }

    @Test
    fun `reduce filters the visible session and keeps dismissal until the fact disappears`() {
        val s1 = session("s1")
        val s2 = session("s2")
        val a1 = approval("a1", "s1")
        val a2 = approval("a2", "s2")
        val projected = AttentionReducer.project(listOf(s1, s2), listOf(a1, a2))
        val state = AttentionReducer.reduce(
            AttentionUiState(visibleSessionId = "s1"),
            projected,
        )
        assertEquals(AttentionReducer.approvalItemId("s2", "a2"), state.activeItemId)

        val dismissed = AttentionReducer.reduce(
            state.copy(dismissedItemIds = setOf(AttentionReducer.approvalItemId("s2", "a2"))),
            projected,
        )
        assertTrue(dismissed.items.isEmpty())
        assertNull(dismissed.activeItemId)

        // The dismissed fact is still live server-side, so it stays hidden.
        val stillDismissed = AttentionReducer.reduce(dismissed, projected)
        assertTrue(stillDismissed.items.isEmpty())

        // Once the fact disappears and re-occurs later, it may surface again.
        val cleaned = AttentionReducer.reduce(dismissed, emptyList())
        assertTrue(cleaned.dismissedItemIds.isEmpty())
    }

    @Test
    fun `reduce deduplicates identical identity keys`() {
        val a1 = approval("a1", "s1")
        val projected = AttentionReducer.project(listOf(session("s1")), listOf(a1))
        val duplicated = projected + projected.first().copy()
        val state = AttentionReducer.reduce(AttentionUiState(), duplicated)
        assertEquals(1, state.items.size)
    }

    @Test
    fun `waiting reply session projects a question`() {
        val items = AttentionReducer.project(
            sessions = listOf(
                session("s1", status = SessionStatus.WaitingApproval, waitingAction = "reply", workflowState = "waiting_user"),
            ),
            approvals = emptyList(),
        )
        assertEquals(AttentionKind.Question, items.single().kind)
        assertTrue(items.single().requiresSession)
    }

    @Test
    fun `running sessions never project`() {
        val items = AttentionReducer.project(
            sessions = listOf(session("s1", status = SessionStatus.Working)),
            approvals = emptyList(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `complex elicitation form requires session while simple form url and unsupported stay inline`() {
        val complex = approval("e-complex", "s1", passkeyRequired = false).copy(
            kind = "permissions",
            elicitation = ElicitationPayload(
                mode = "form",
                schemaProperties = listOf(
                    ElicitationSchemaProperty(name = "a"),
                    ElicitationSchemaProperty(name = "b"),
                    ElicitationSchemaProperty(name = "c"),
                ),
            ),
        )
        val nested = approval("e-object", "s1", passkeyRequired = false).copy(
            kind = "permissions",
            elicitation = ElicitationPayload(
                mode = "openai/form",
                schemaProperties = listOf(ElicitationSchemaProperty(name = "cfg", type = "object")),
            ),
        )
        val simpleForm = approval("e-simple", "s1", passkeyRequired = false).copy(
            kind = "permissions",
            elicitation = ElicitationPayload(
                mode = "form",
                schemaProperties = listOf(
                    ElicitationSchemaProperty(name = "token", format = "password"),
                    ElicitationSchemaProperty(name = "confirm", type = "boolean"),
                ),
            ),
        )
        val externalUrl = approval("e-url", "s1", passkeyRequired = false).copy(
            kind = "permissions",
            elicitation = ElicitationPayload(mode = "url", url = "https://example.com/auth"),
        )
        val unsupported = approval("e-unsupported", "s1", passkeyRequired = false).copy(
            kind = "permissions",
            elicitation = ElicitationPayload(mode = "openai/userVerification"),
        )

        val items = AttentionReducer.project(
            sessions = listOf(session("s1", status = SessionStatus.WaitingApproval)),
            approvals = listOf(complex, nested, simpleForm, externalUrl, unsupported),
        ).associateBy { it.approval?.id }

        assertTrue(items.getValue("e-complex").requiresSession)
        assertTrue(items.getValue("e-object").requiresSession)
        assertFalse(items.getValue("e-simple").requiresSession)
        assertFalse(items.getValue("e-url").requiresSession)
        assertFalse(items.getValue("e-unsupported").requiresSession)
    }

    @Test
    fun `non-blocking question projects even while session stays working`() {
        val q = approval("q-nonblock", "s1", kind = "question").copy(
            isBlocking = false,
            questions = listOf(ApprovalQuestion(question = "Optional note?", isOther = true)),
        )
        val items = AttentionReducer.project(
            sessions = listOf(session("s1", status = SessionStatus.Working)),
            approvals = listOf(q),
        )
        assertEquals(1, items.size)
        assertEquals(AttentionKind.Question, items.single().kind)
        assertFalse(items.single().approval!!.isBlocking)
    }
}
