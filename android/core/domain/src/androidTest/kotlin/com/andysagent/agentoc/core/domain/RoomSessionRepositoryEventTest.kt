package com.andysagent.agentoc.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.database.ApprovalEntity
import com.andysagent.agentoc.core.database.PendingOperationEntity
import com.andysagent.agentoc.core.database.SessionEntity
import com.andysagent.agentoc.core.database.SyncCursorEntity
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.network.AgentoCTransport
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiResponse
import com.andysagent.agentoc.core.network.InvalidationHint
import com.andysagent.agentoc.core.protocol.AgentocProtocol
import com.andysagent.agentoc.core.protocol.SessionEventDto
import com.andysagent.agentoc.core.timeline.TimelineItem
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

@RunWith(AndroidJUnit4::class)
class RoomSessionRepositoryEventTest {
    @Test fun sessionRefreshKeepsPendingApprovalWhileServerReportsRunning() = runBlocking {
        database.dao().upsertApprovals(listOf(ApprovalEntity(id = "a", sessionId = "session-1", title = "Bash",
            status = "pending", runId = "r", kind = "approval_request", updatedAt = 1L)))
        val transport = RecordingTransport().apply {
            responseBody = """{"sessions":[{"id":"session-1","title":"Task","activity":{"run":{"state":"running"}}}]}"""
        }
        val repository = RoomSessionRepository(database, transport)
        repository.refreshSessions()
        assertEquals(SessionStatus.WaitingApproval, repository.observeSession("session-1").first()?.status)
        transport.responseBody = """{"session":{"id":"session-1","title":"Task","status":"running"}}"""
        assertEquals(SessionStatus.WaitingApproval, repository.refreshSessionDetail("session-1")?.status)
        transport.responseBody = """{"session":{"id":"session-1","title":"Task","activity":{"run":{"state":"running","runId":"other-run"}}}}"""
        assertEquals(SessionStatus.Working, repository.refreshSessionDetail("session-1")?.status)
        transport.responseBody = """{"sessions":[{"id":"session-1","title":"Task","activity":{"run":{"state":"running","id":"r"}}}]}"""
        repository.refreshSessions()
        assertEquals(SessionStatus.WaitingApproval, repository.observeSession("session-1").first()?.status)
        transport.responseBody = """{"session":{"id":"session-1","title":"Task","status":"completed"}}"""
        transport.runResponseBody = """{"run":{"id":"r","sessionId":"session-1","state":"completed"}}"""
        assertEquals(SessionStatus.Completed, repository.refreshSessionDetail("session-1")?.status)
        assertEquals("resolved", database.dao().getApproval("session-1", "a")?.status)
        assertTrue(repository.observePendingApprovals("session-1").first().isEmpty())
        repository.close()
    }
    @Test fun persistsServerExplanationsForIndividualAndBatchApprovals() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"a","runId":"r","title":"Bash","reason":"Provider reason","command":"rm example","explanation":{"summary":"Removes example","reason":"Deletion can be permanent","saferAlternative":"Review first"}},{"seq":2,"type":"privileged_batch_request","batchId":"b","runId":"r","other":[{"opId":"o","explanation":{"summary":"Restart service"}}]},{"seq":3,"type":"approval_request","approvalId":"c","runId":"r","explanation":{"summary":42,"reason":"  "}},{"seq":4,"type":"approved_action_batch_request","batchId":"d","runId":"r","actions":[{"actionId":"x","explanation":{"summary":"Change a setting"}}]}],"latestSeq":4}""",
        )))
        repository.refreshEvents("session-1")
        val approvals = repository.observePendingApprovals("session-1").first()
        val ordinary = approvals.single { it.id == "a" }
        assertEquals("Provider reason", ordinary.reason)
        assertEquals("rm example", ordinary.command)
        assertEquals("Removes example", ordinary.explanation?.summary)
        assertEquals("Deletion can be permanent", ordinary.explanation?.reason)
        assertEquals("Review first", ordinary.explanation?.saferAlternative)
        assertEquals("Restart service", approvals.single { it.id == "b" }.actions.single().explanation?.summary)
        assertEquals(null, approvals.single { it.id == "c" }.explanation)
        assertEquals("Change a setting", approvals.single { it.id == "d" }.actions.single().explanation?.summary)
        repository.close()
        val reopened = RoomSessionRepository(database, QueuedTransport(emptyList()))
        assertEquals("Removes example", reopened.observePendingApprovals("session-1").first().single { it.id == "a" }.explanation?.summary)
        reopened.close()
    }
    @Test fun preservesProviderIdentityForMatchingBatchOperations() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"a","runId":"r","providerRequestId":"provider-1","requestId":"turn"},{"seq":2,"type":"privileged_batch_request","batchId":"b","runId":"r","requestId":"turn","other":[{"opId":"o","providerRequestId":"provider-1"}]},{"seq":3,"type":"approval_request","approvalId":"independent","runId":"r","requestId":"turn"}],"latestSeq":3}""",
        )))
        repository.refreshEvents("session-1")
        val approvals = repository.observePendingApprovals("session-1").first()
        assertEquals(setOf("provider-1"), approvals.single { it.id == "a" }.identityAliases.intersect(setOf("provider-1")))
        assertEquals(setOf("provider-1"), approvals.single { it.id == "b" }.actions.single().identityAliases.intersect(setOf("provider-1")))
        assertEquals(setOf("b", "independent"), com.andysagent.agentoc.core.model.withoutBatchApprovalShadows(approvals).map { it.id }.toSet())
        repository.close()
    }
    @Test fun preservesEachQuestionsMultiSelectFlag() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"q","runId":"r","kind":"question","questions":[{"question":"Choose several","multiSelect":true,"options":[{"label":"One"},{"label":"Two"}]},{"question":"Choose one","multiSelect":false,"options":[{"label":"Three"}]}]}],"latestSeq":1}""",
        )))
        repository.refreshEvents("session-1")
        val questions = repository.observePendingApprovals("session-1").first().single().questions
        assertEquals(listOf(true, false), questions.map { it.isMultiSelect })
        repository.close()
    }
    @Test fun categoryResponseWithoutDecisionDoesNotInventARejection() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"privileged_batch_request","batchId":"b","runId":"r","other":[{"opId":"o","description":"Restart"}],"delete":[{"opId":"d","description":"Remove"}],"defaultSelected":{"other":[],"delete":["d"]}}],"latestSeq":1}""",
            """{"sessionId":"session-1","events":[{"seq":2,"type":"privileged_batch_response","batchId":"b","category":"other"}],"latestSeq":2}""",
        )))
        repository.refreshEvents("session-1")
        repository.refreshEvents("session-1")
        val pending = repository.observePendingApprovals("session-1").first().single()
        assertEquals(emptySet<String>(), pending.defaultSelectedByCategory["privileged_other"])
        assertEquals(setOf("d"), pending.defaultSelectedByCategory["destructive_delete"])
        assertEquals("resolved", pending.actions.single { it.id == "o" }.state)
        assertEquals("waiting_user", pending.actions.single { it.id == "d" }.state)
        repository.close()
    }

    @Test fun privilegedCategoriesRemainPendingUntilEachIsResolved() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"privileged_batch_request","batchId":"b","runId":"r","other":[{"opId":"o","description":"Restart"}],"delete":[{"opId":"d","description":"Remove"}]}],"latestSeq":1}""",
            """{"sessionId":"session-1","events":[{"seq":2,"type":"privileged_batch_response","batchId":"b","category":"privileged_other","decisions":{"o":"approved"}}],"latestSeq":2}""",
            """{"sessionId":"session-1","events":[{"seq":3,"type":"privileged_batch_response","batchId":"b","category":"destructive_delete","decisions":{"d":"denied"}}],"latestSeq":3}""",
        )))
        repository.refreshEvents("session-1")
        repository.refreshEvents("session-1")
        val pending = repository.observePendingApprovals("session-1").first().single()
        assertEquals("approved", pending.actions.single { it.id == "o" }.state)
        assertEquals("waiting_user", pending.actions.single { it.id == "d" }.state)
        assertEquals(SessionStatus.WaitingApproval, repository.observeSession("session-1").first()?.status)
        repository.refreshEvents("session-1")
        assertTrue(repository.observePendingApprovals("session-1").first().isEmpty())
        repository.close()
    }

    @Test fun anotherPendingApprovalKeepsSessionWaitingAcrossResponsesAndDeltas() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"a","runId":"r"},{"seq":2,"type":"approval_request","approvalId":"b","runId":"r"}],"latestSeq":2}""",
            """{"sessionId":"session-1","events":[{"seq":3,"type":"approval_response","approvalId":"a","runId":"r"},{"seq":4,"type":"message_delta","runId":"r","content":"continuing"}],"latestSeq":4}""",
            """{"sessionId":"session-1","events":[{"seq":5,"type":"approval_response","approvalId":"b","runId":"r"}],"latestSeq":5}""",
        )))
        repository.refreshEvents("session-1")
        repository.refreshEvents("session-1")
        assertEquals(listOf("b"), repository.observePendingApprovals("session-1").first().map { it.id })
        assertEquals(SessionStatus.WaitingApproval, repository.observeSession("session-1").first()?.status)
        repository.refreshEvents("session-1")
        assertTrue(repository.observePendingApprovals("session-1").first().isEmpty())
        assertEquals(SessionStatus.Working, repository.observeSession("session-1").first()?.status)
        repository.close()
    }

    @Test fun pendingApprovalDoesNotOverrideAnotherRunOrTerminalStatus() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"a","runId":"old"}],"latestSeq":1}""",
            """{"sessionId":"session-1","events":[{"seq":2,"type":"run_started","runId":"new"}],"latestSeq":2}""",
            """{"sessionId":"session-1","events":[{"seq":3,"type":"run_completed","runId":"old"}],"latestSeq":3}""",
        )))
        repository.refreshEvents("session-1")
        repository.refreshEvents("session-1")
        assertEquals(SessionStatus.Working, repository.observeSession("session-1").first()?.status)
        repository.refreshEvents("session-1")
        assertEquals(SessionStatus.Completed, repository.observeSession("session-1").first()?.status)
        repository.close()
    }

    @Test fun backgroundSyncRecoversPendingApprovalAfterCursorPassedIt() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        val activity = """{"actionRequired":true,"kind":"approval","sourceSeq":10}"""
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[{"seq":10,"type":"approval_request","kind":"command","approvalId":"claude:1","runId":"run-1","title":"Write","command":"echo test","cwd":"/workspace","filePaths":["/workspace/file"],"grantRoot":"/workspace","permissions":{"network":{"enabled":true}},"risk":"high","status":"pending"}],"latestSeq":10}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshEvents("session-1")
        val pending = repository.observePendingApprovals("session-1").first().single()
        assertEquals("claude:1", pending.id)
        assertEquals(false, pending.passkeyRequired)
        assertEquals("command", pending.requestKind)
        assertEquals("echo test", pending.command)
        assertEquals("/workspace", pending.cwd)
        assertEquals(listOf("/workspace/file"), pending.filePaths)
        assertEquals("/workspace", pending.grantRoot)
        assertTrue(pending.permissionsJson!!.contains("network"))
        assertEquals("high", pending.riskLevel)
        repository.close()
    }

    @Test fun stalePendingApprovalDoesNotHideCurrentRequest() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(ApprovalEntity(id = "old", sessionId = "session-1", title = "Old", status = "pending",
            runId = "old-run", kind = "approval_request", detailsJson = """{"sourceSeq":5}""", updatedAt = 1)))
        val activity = """{"actionRequired":true,"kind":"approval","sourceSeq":10,"runId":"run-1"}"""
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[{"seq":10,"type":"approval_request","approvalId":"current","runId":"run-1","title":"Current","status":"pending"}],"latestSeq":10}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshEvents("session-1")
        assertEquals(listOf("current", "old"), repository.observePendingApprovals("session-1").first().map { it.id })
        repository.close()
    }

    @Test fun terminalRunResolvesOnlyItsOwnOutstandingApprovals() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"approval_request","approvalId":"old","runId":"old-run"},{"seq":2,"type":"approval_request","approvalId":"current","runId":"current-run"},{"seq":3,"type":"run_completed","runId":"old-run"}],"latestSeq":3}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshEvents("session-1")
        assertEquals(listOf("current"), repository.observePendingApprovals("session-1").first().map { it.id })
        repository.close()
    }

    @Test fun terminalEventWithoutRunIdUsesRequestIdWithoutRetiringOtherRuns() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "legacy-approval", sessionId = "session-1", title = "Old", status = "pending",
                detailsJson = """{"requestId":"request-old"}""", updatedAt = 1),
            ApprovalEntity(id = "current-approval", sessionId = "session-1", title = "Current", status = "pending",
                runId = "current-run", detailsJson = """{"requestId":"request-current"}""", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[{"seq":1,"type":"run_completed","requestId":"request-old"}],"latestSeq":1}""",
        )))

        repository.refreshEvents("session-1")

        assertEquals("resolved", database.dao().getApproval("session-1", "legacy-approval")?.status)
        assertEquals(listOf("current-approval"), repository.observePendingApprovals("session-1").first().map { it.id })
        repository.close()
    }

    @Test fun terminalRunActivitySnapshotRetiresOnlyItsRunWithoutDurableTerminalEvent() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "old-approval", sessionId = "session-1", title = "Old", status = "pending", runId = "old-run", updatedAt = 1),
            ApprovalEntity(id = "current-approval", sessionId = "session-1", title = "Current", status = "pending", runId = "current-run", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":{"state":"completed","runId":"old-run"}}""",
        )))

        repository.refreshEvents("session-1")

        assertEquals("resolved", database.dao().getApproval("session-1", "old-approval")?.status)
        assertEquals(listOf("current-approval"), repository.observePendingApprovals("session-1").first().map { it.id })
        repository.close()
    }

    @Test fun idleSyncUsesTerminalSessionDetailForPendingApprovalsWithoutRunIds() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "legacy-approval", sessionId = "session-1", title = "Old", status = "pending", updatedAt = 1),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":{"state":"idle"}}""",
            """{"session":{"id":"session-1","title":"Task","status":"completed"}}""",
        )))

        repository.refreshEvents("session-1")

        assertEquals("resolved", database.dao().getApproval("session-1", "legacy-approval")?.status)
        assertTrue(repository.observeAllPendingApprovals().first().isEmpty())
        repository.close()
    }

    @Test fun authoritativeIdleSessionDetailRetiresLegacyApprovalWithoutActiveWait() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "legacy-approval", sessionId = "session-1", title = "Old", status = "pending", updatedAt = 1),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"session":{"id":"session-1","title":"Task","status":"idle","activity":{}}}""",
        )))

        repository.refreshSessionDetail("session-1")

        assertEquals("resolved", database.dao().getApproval("session-1", "legacy-approval")?.status)
        assertTrue(repository.observeAllPendingApprovals().first().isEmpty())
        repository.close()
    }

    @Test fun idleDetailWithExplicitWaitingActionKeepsApprovalPending() = runBlocking {
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "legacy-approval", sessionId = "session-1", title = "Question", status = "pending", updatedAt = 1),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"session":{"id":"session-1","title":"Task","status":"idle","waitingAction":"reply","activity":{"actionRequired":true}}}""",
        )))

        repository.refreshSessionDetail("session-1")

        assertEquals("pending", database.dao().getApproval("session-1", "legacy-approval")?.status)
        repository.close()
    }

    @Test fun terminalRunInSessionDetailRetiresOnlyItsRun() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "old-approval", sessionId = "session-1", title = "Old", status = "pending", runId = "old-run", updatedAt = 1),
            ApprovalEntity(id = "current-approval", sessionId = "session-1", title = "Current", status = "pending", runId = "current-run", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"session":{"id":"session-1","title":"Task","status":"running","activity":{"run":{"id":"old-run","state":"completed"}}}}""",
        )))

        repository.refreshSessionDetail("session-1")

        assertEquals("resolved", database.dao().getApproval("session-1", "old-approval")?.status)
        assertEquals(listOf("current-approval"), repository.observePendingApprovals("session-1").first().map { it.id })
        assertEquals(SessionStatus.Working, repository.observeSession("session-1").first()?.status)
        repository.close()
    }

    @Test fun idleSyncRechecksExactRunsBeforeClearingMissedApprovals() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "old", sessionId = "session-1", title = "Old", status = "pending", runId = "old-run", updatedAt = 1),
            ApprovalEntity(id = "active", sessionId = "session-1", title = "Active", status = "pending", runId = "active-run", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":{"state":"idle"}}""",
            """{"run":{"id":"old-run","sessionId":"session-1","state":"completed"}}""",
            """{"run":{"id":"active-run","sessionId":"session-1","state":"running"}}""",
        )))
        repository.refreshEvents("session-1")
        assertEquals(listOf("active"), repository.observePendingApprovals("session-1").first().map { it.id })
        repository.close()
    }

    @Test fun restoresExplanationForExistingPendingApprovalWithoutReopeningResolved() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(ApprovalEntity(id = "a", sessionId = "session-1", title = "Bash", status = "pending", runId = "r", kind = "approval_request", detailsJson = """{"command":"rm example"}""", updatedAt = 1)))
        val activity = """{"actionRequired":true,"kind":"approval","sourceSeq":10}"""
        val request = """{"seq":10,"type":"approval_request","approvalId":"a","runId":"r","command":"rm example","explanation":{"summary":"Delete example","operation":"delete","targets":["example"],"riskCode":"delete_unresolvable","elevated":true}}"""
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[$request],"latestSeq":10}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshEvents("session-1")
        val restored = repository.observePendingApprovals("session-1").first().single()
        assertEquals("delete", restored.explanation?.operation)
        assertEquals(listOf("example"), restored.explanation?.targets)
        assertEquals(true, restored.explanation?.elevated)
        assertEquals("rm example", restored.command)
        assertEquals("pending", restored.status)
        repository.close()
    }

    @Test fun explanationRecoveryNeverReopensResolvedApproval() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(ApprovalEntity(id = "a", sessionId = "session-1", title = "Bash", status = "denied", runId = "r", kind = "approval_request", detailsJson = """{"command":"rm example"}""", updatedAt = 1)))
        val activity = """{"actionRequired":true,"kind":"approval","sourceSeq":10}"""
        val request = """{"seq":10,"type":"approval_request","approvalId":"a","runId":"r","command":"rm example","explanation":{"summary":"Delete example"}}"""
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[$request],"latestSeq":10}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshEvents("session-1")
        assertTrue(repository.observePendingApprovals("session-1").first().isEmpty())
        assertEquals("denied", database.dao().getApproval("session-1", "a")?.status)
        repository.close()
    }

    @Test fun restoresPendingApprovalWhenCursorAlreadyPassedItsEvent() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        val activity = """{"actionRequired":true,"kind":"approval","sourceSeq":10}"""
        val transport = QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[],"latestSeq":10}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[{"seq":10,"type":"approval_request","approvalId":"claude:1","runId":"run-1","title":"Write","status":"pending"}],"latestSeq":10,"runActivity":$activity}""",
            """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":$activity}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshTimeline("session-1")
        val approval = repository.observePendingApprovals("session-1").first().single()
        assertEquals("claude:1", approval.id)
        assertEquals(false, approval.passkeyRequired)
        assertTrue(transport.requests.any { it.path.contains("afterSeq=9") })
        repository.close()
    }
    @Test fun pinUpdatesUseServerValuesAndUnpinHandlesOmittedFlags() = runBlocking {
        val transport = QueuedTransport(listOf(
            "{}", """{"sessions":[{"id":"s","name":"Chat","pinned":true}]}""",
            "{}", """{"sessions":[{"id":"s","name":"Chat"}]}""",
            "{}", """{"projects":[{"id":"p","name":"Project","pinned":true}]}""",
            "{}", """{"projects":[{"id":"p","name":"Project"}]}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.setSessionPinned("s", true)
        assertTrue(repository.observeSessions().first().single().pinned)
        repository.setSessionPinned("s", false)
        assertEquals(false, repository.observeSessions().first().single().pinned)
        repository.setProjectPinned("p", true)
        assertTrue(repository.observeProjects().first().single().pinned)
        repository.setProjectPinned("p", false)
        assertEquals(false, repository.observeProjects().first().single().pinned)
        val patches = transport.requests.filter { it.method == "PATCH" }
        assertEquals(listOf("/api/sessions/s", "/api/sessions/s", "/api/projects/p", "/api/projects/p"), patches.map { it.path })
        assertEquals(listOf("true", "false", "true", "false"), patches.map { AgentocProtocol.json.parseToJsonElement(it.body!!).jsonObject["pinned"]!!.jsonPrimitive.content })
        repository.close()
    }
    @Test fun deletingProjectReconcilesDetachedSessionsFromServer() = runBlocking {
        val transport = QueuedTransport(listOf(
            """{"projects":[{"id":"p","name":"Project"}]}""",
            """{"sessions":[{"id":"s","name":"Chat","projectId":"p"}]}""",
            "{}", """{"projects":[]}""", """{"sessions":[{"id":"s","name":"Chat"}]}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshProjects(); repository.refreshSessions()
        repository.deleteProject("p", false)
        assertTrue(repository.observeProjects().first().isEmpty())
        assertEquals(null, repository.observeSessions().first().single().projectId)
        val request = transport.requests.single { it.method == "DELETE" }
        assertEquals("/api/projects/p", request.path)
        assertEquals("false", AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject["deleteSessions"]!!.jsonPrimitive.content)
        repository.close()
    }
    @Test fun deletingProjectAndSessionsReconcilesCatalogWithoutTouchingOtherProjects() = runBlocking {
        val transport = QueuedTransport(listOf(
            """{"projects":[{"id":"p","name":"Delete"},{"id":"other","name":"Keep"}]}""",
            """{"sessions":[{"id":"s","name":"Delete","projectId":"p"},{"id":"keep","name":"Keep","projectId":"other"}]}""",
            "{}", """{"projects":[{"id":"other","name":"Keep"}]}""",
            """{"sessions":[{"id":"keep","name":"Keep","projectId":"other"}]}""",
        ))
        val repository = RoomSessionRepository(database, transport)
        repository.refreshProjects(); repository.refreshSessions()
        repository.deleteProject("p", true)
        assertEquals(listOf("other"), repository.observeProjects().first().map { it.id })
        assertEquals(listOf("keep"), repository.observeSessions().first().map { it.id })
        val request = transport.requests.single { it.method == "DELETE" }
        assertEquals("/api/projects/p", request.path)
        assertEquals("true", AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject["deleteSessions"]!!.jsonPrimitive.content)
        repository.close()
    }
    @Test fun unnamedCreateLetsServerNameSessionAndRefreshUpdatesTheTitle() = runBlocking {
        val transport = RecordingTransport()
        transport.responseBody = """{"session":{"id":"title-session","name":"new session","projectId":"p"}}"""
        val repository = RoomSessionRepository(database, transport)
        repository.createSessionInProject("p", name = "")
        val request = transport.requests.single()
        val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
        assertTrue(body["name"] == null || body["name"]?.jsonPrimitive?.content == "")
        assertEquals("p", body["projectId"]?.jsonPrimitive?.content)
        transport.responseBody = """{"sessions":[{"id":"title-session","name":"Weekly report cleanup","projectId":"p"}]}"""
        repository.refreshSessions()
        assertEquals("Weekly report cleanup", repository.observeSessions().first().single { it.id == "title-session" }.title)
        repository.close()
    }

    @Test fun toolRefreshKeepsPreviouslyLoadedOlderHistory() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[
                {"seq":1,"type":"user_message","canonicalMessageId":"m1","text":"Old"},
                {"seq":2,"type":"message","canonicalMessageId":"m2","text":"Older reply"},
                {"seq":3,"type":"user_message","canonicalMessageId":"m3","text":"Recent"},
                {"seq":4,"type":"message","canonicalMessageId":"m4","text":"Recent reply"}
            ],"latestSeq":4}""".trimIndent(),
            """{"sessionId":"session-1","events":[
                {"seq":3,"type":"message","role":"user","canonicalMessageId":"m3","text":"Recent"},
                {"seq":4,"type":"message","canonicalMessageId":"m4","text":"Recent reply"}
            ],"latestSeq":4,"pagination":{"hasMoreBefore":true,"nextBeforeSeq":3}}""".trimIndent(),
            """{"sessionId":"session-1","events":[
                {"seq":1,"type":"message","role":"user","canonicalMessageId":"m1","text":"Old"},
                {"seq":2,"type":"message","canonicalMessageId":"m2","text":"Older reply"}
            ],"latestSeq":4,"pagination":{"hasMoreBefore":false,"nextBeforeSeq":1}}""".trimIndent(),
            """{"sessionId":"session-1","events":[
                {"seq":5,"type":"tool_use","providerToolUseId":"tool-1","toolName":"exec_command"},
                {"seq":6,"type":"tool_result","providerToolUseId":"tool-1","toolName":"exec_command","exitCode":0}
            ],"latestSeq":6}""".trimIndent(),
            """{"sessionId":"session-1","events":[
                {"seq":3,"type":"message","role":"user","canonicalMessageId":"m3","text":"Recent"},
                {"seq":4,"type":"message","canonicalMessageId":"m4","text":"Recent reply"},
                {"seq":5,"endSeq":6,"type":"operation","operationId":"op-1","state":"completed","kind":"command","title":"List files","detail":"ls"}
            ],"latestSeq":6,"pagination":{"hasMoreBefore":true,"nextBeforeSeq":3}}""".trimIndent(),
        )))
        repository.refreshTimeline("session-1")
        repository.loadOlderTimeline("session-1")
        repository.refreshEvents("session-1")
        val timeline = withTimeout(5_000) { repository.observeTimeline("session-1").first { rows -> rows.any { it is TimelineItem.Operation } } }
        assertTrue(timeline.filterIsInstance<TimelineItem.Message>().any { it.text == "Old" })
        assertTrue(!repository.observeTimelinePaging("session-1").first().hasOlder)
        repository.close()
    }

    @Test fun durableToolEventsRefreshCanonicalVisibleOperations() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[
                {"seq":1,"type":"user_message","text":"List files"},
                {"seq":2,"type":"tool_use","providerToolUseId":"tool-1","toolName":"exec_command"},
                {"seq":3,"type":"tool_result","providerToolUseId":"tool-1","toolName":"exec_command","exitCode":0}
            ],"latestSeq":3}""".trimIndent(),
            """{"sessionId":"session-1","events":[
                {"seq":1,"type":"message","role":"user","text":"List files"},
                {"seq":2,"endSeq":3,"type":"operation","operationId":"op-1","state":"completed","kind":"command","title":"List files","detail":"ls","exitCode":0}
            ],"latestSeq":3}""".trimIndent(),
        )))
        assertEquals(RefreshResult.Applied(3, 3), repository.refreshEvents("session-1"))
        val timeline = withTimeout(5_000) { repository.observeTimeline("session-1").first { rows -> rows.any { it is TimelineItem.Operation } } }
        val operation = timeline.filterIsInstance<TimelineItem.Operation>().single()
        assertEquals("List files", operation.title)
        assertEquals("ls", operation.detail)
        assertEquals(com.andysagent.agentoc.core.timeline.TimelineOperationStatus.Completed, operation.status)
        repository.close()
    }

    @Test fun preservesDistinctMessagesAndFirstPositionsAcrossSnapshots() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf("""
            {"sessionId":"session-1","events":[
              {"seq":1,"eventId":"v2-1","type":"message","canonicalMessageId":"a","runId":"r","text":"Initial"},
              {"seq":2,"eventId":"v2-2","type":"user_message","canonicalMessageId":"u","text":"Follow-up"},
              {"seq":3,"eventId":"v2-3","type":"message","canonicalMessageId":"a","runId":"r","text":"Final"},
              {"seq":4,"eventId":"v2-4","type":"message","canonicalMessageId":"b","runId":"r","text":"Final"}
            ],"latestSeq":4}
        """.trimIndent())))
        repository.refreshEvents("session-1")
        val rows = database.dao().getMessages("session-1")
        assertEquals(listOf("Final", "Follow-up", "Final"), rows.map { it.content })
        assertEquals(listOf(1L,2L,4L), rows.map { it.seq })
        repository.close()
    }

    @Test fun failedLegacyRebuildKeepsOfflineCacheAndUnknownSubmission() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "completed", 4, 0,
            timelineProjectionVersion = 0)))
        database.dao().upsertMessages(listOf(com.andysagent.agentoc.core.database.MessageEntity(
            "legacy", "session-1", "assistant", "Offline original", 4, "req", completed = true, updatedAt = 0)))
        database.dao().upsertOperation(PendingOperationEntity("unknown", "send_message", "/api/messages", "{}", "unknown", 0, 0))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf("""
            {"sessionId":"session-1","events":[{"seq":3,"type":"message","text":"Incomplete"}],"latestSeq":4}
        """.trimIndent())))
        assertTrue(runCatching { repository.refreshEvents("session-1") }.isFailure)
        assertEquals("Offline original", database.dao().getMessages("session-1").single().content)
        assertEquals(0, database.dao().getSession("session-1")?.timelineProjectionVersion)
        assertEquals("unknown", database.dao().getPendingOperation("unknown")?.state)
        repository.close()
    }

    @Test fun successfulLegacyRebuildPublishesCompleteProjectionAtomically() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "completed", 3, 0,
            timelineProjectionVersion = 0)))
        database.dao().upsertMessages(listOf(com.andysagent.agentoc.core.database.MessageEntity(
            "legacy", "session-1", "assistant", "Corrupted order", 3, "req", completed = true, updatedAt = 0)))
        val repository = RoomSessionRepository(database, QueuedTransport(listOf("""
            {"sessionId":"session-1","events":[
              {"seq":1,"type":"message","canonicalMessageId":"a","text":"First"},
              {"seq":2,"type":"user_message","canonicalMessageId":"u","text":"Next"},
              {"seq":3,"type":"message","canonicalMessageId":"a","text":"Final"}
            ],"latestSeq":3}
        """.trimIndent(), """{"sessionId":"session-1","events":[],"latestSeq":3}""")))
        repository.refreshEvents("session-1")
        assertEquals(listOf("Final", "Next"), database.dao().getMessages("session-1").map { it.content })
        assertEquals(2, database.dao().getSession("session-1")?.timelineProjectionVersion)
        assertEquals(3L, database.dao().getCursor("session-1")?.lastAppliedSeq)
        repository.close()
    }
    private lateinit var database: AgentoCDatabase

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        runBlocking {
            database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "idle", 0, 0)))
        }
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun mapsUserAndStreamingAssistantEventsWithoutOverwritingRoles() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {
              "sessionId":"session-1",
              "events":[
                {"seq":1,"type":"user_message","requestId":"req-1","text":"hello"},
                {"seq":2,"type":"assistant_delta","requestId":"req-1","text":"he"},
                {"seq":3,"type":"assistant_delta","requestId":"req-1","text":"llo"},
                {"seq":4,"type":"assistant_completed","requestId":"req-1","text":"hello","endSeq":4}
              ],
              "latestSeq":4
            }
            """.trimIndent(),
        )))

        val result = repository.refreshEvents("session-1")
        assertEquals(RefreshResult.Applied(4, 4), result)
        val messages = database.dao().getMessages("session-1")
        assertEquals(2, messages.size)
        assertEquals(listOf("user", "assistant"), messages.map { it.role })
        assertEquals(listOf("hello", "hello"), messages.map { it.content })
        assertEquals(listOf(true, true), messages.map { it.completed })
        assertEquals("completed", database.dao().getSession("session-1")?.status)
    }

    @Test
    fun persistsStructuredDecisionQuestionFromApprovalProjection() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {
              "sessionId":"session-1",
              "events":[{
                "seq":1,
                "type":"approval_request",
                "approvalId":"approval-question-1",
                "runId":"run-1",
                "kind":"question",
                "title":"Release choice",
                "questions":[{
                  "id":"release-mode",
                  "header":"Release mode",
                  "question":"Which release mode should be used?",
                  "options":[
                    {"label":"Canary","value":"canary","description":"Start with 10%"},
                    {"label":"Full","value":"full"}
                  ]
                }]
              }],
              "latestSeq":1
            }
            """.trimIndent(),
        )))

        assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("session-1"))
        val approval = repository.observePendingApprovals("session-1").first().single()

        assertEquals("approval_request", approval.kind)
        assertEquals("release-mode", approval.questions.single().id)
        assertEquals("canary", approval.questions.single().options.first().value)
        assertEquals("Start with 10%", approval.questions.single().options.first().description)
    }

    @Test
    fun approvedActionBatchKeepsPendingUntilEveryActionReachesTerminalState() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {
              "sessionId":"session-1",
              "events":[
                {
                  "seq":1,
                  "eventId":"approval-1",
                  "type":"approved_action_batch_request",
                  "channel":"approved_action",
                  "schemaVersion":1,
                  "batchId":"batch-1",
                  "runId":"run-1",
                  "title":"Review actions",
                  "actions":[
                    {
                      "actionId":"action-1",
                      "description":"Update the report",
                      "executionClass":"product",
                      "state":"waiting_user"
                    },
                    {
                      "actionId":"action-2",
                      "description":"Restart the host service",
                      "executionClass":"host",
                      "needsPasskey":true,
                      "state":"waiting_user"
                    }
                  ]
                },
                {
                  "seq":2,
                  "eventId":"approval-response-1",
                  "type":"approved_action_batch_response",
                  "batchId":"batch-1",
                  "runId":"run-1"
                }
              ],
              "latestSeq":2
            }
            """.trimIndent(),
            """
            {
              "sessionId":"session-1",
              "events":[
                {
                  "seq":3,
                  "eventId":"action-1-state",
                  "type":"approved_action_state",
                  "batchId":"batch-1",
                  "actionId":"action-1",
                  "state":"completed",
                  "updatedAt":"2026-08-26T00:00:03Z"
                },
                {
                  "seq":4,
                  "eventId":"action-2-state",
                  "type":"approved_action_state",
                  "batchId":"batch-1",
                  "actionId":"action-2",
                  "state":"denied",
                  "updatedAt":"2026-08-26T00:00:04Z"
                }
              ],
              "latestSeq":4
            }
            """.trimIndent(),
        )))

        assertEquals(RefreshResult.Applied(2, 2), repository.refreshEvents("session-1"))
        val submitted = repository.observePendingApprovals("session-1").first().single()
        assertEquals("approved_action_batch_request", submitted.kind)
        assertEquals(listOf("action-1", "action-2"), submitted.actions.map { it.id })
        assertTrue(submitted.actions[1].needsPasskey)

        assertEquals(RefreshResult.Applied(2, 4), repository.refreshEvents("session-1"))

        assertTrue(repository.observePendingApprovals("session-1").first().isEmpty())
    }

    @Test
    fun privilegedBatchPasskeySignalDefaultsToRequiredWhenAbsent() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {
              "sessionId":"session-1",
              "events":[
                {
                  "seq":1,
                  "eventId":"batch-click",
                  "type":"privileged_batch_request",
                  "batchId":"pbatch-1",
                  "runId":"run-1",
                  "passkeyRequired":false,
                  "other":[
                    {"opId":"op-1","actionId":"op-1","command":"systemctl restart nginx","description":"Restart nginx"}
                  ],
                  "delete":[]
                },
                {
                  "seq":2,
                  "eventId":"batch-legacy",
                  "type":"privileged_batch_request",
                  "batchId":"pbatch-2",
                  "runId":"run-1",
                  "other":[
                    {"opId":"op-2","actionId":"op-2","command":"systemctl restart nginx","description":"Restart nginx"}
                  ],
                  "delete":[]
                }
              ],
              "latestSeq":2
            }
            """.trimIndent(),
        )))

        repository.refreshEvents("session-1")
        val approvals = repository.observePendingApprovals("session-1").first()
            .sortedBy { it.batchId }
        assertEquals(2, approvals.size)
        // Server-projected owner-click signal is preserved...
        assertEquals(false, approvals.single { it.batchId == "pbatch-1" }.passkeyRequired)
        // ...while persisted approvals without the flag stay passkey-required.
        assertEquals(true, approvals.single { it.batchId == "pbatch-2" }.passkeyRequired)
    }

    @Test
    fun runtimeDecisionUsesApprovalEndpointAndStructuredChoices() = runBlocking {
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        repository.resolveRuntimeApproval(
            runId = "run-1",
            approvalId = "approval-question-1",
            decision = "approve",
            choices = listOf("canary"),
            customAnswer = "Keep the first rollout small",
            requestId = "decision-request-1",
        )

        val request = transport.requests.single()
        assertEquals("/api/runs/run-1/approvals/approval-question-1", request.path)
        val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
        assertEquals("approve", body["decision"]!!.jsonPrimitive.content)
        assertEquals("canary", body["choices"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals("Keep the first rollout small", body["customAnswer"]!!.jsonPrimitive.content)
        assertEquals("decision-request-1", body["requestId"]!!.jsonPrimitive.content)
    }

    @Test
    fun continuesStreamingContentAcrossRefreshCalls() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {"sessionId":"session-1","events":[
              {"seq":1,"type":"assistant_delta","requestId":"req-2","text":"hel"}
            ],"latestSeq":1}
            """.trimIndent(),
            """
            {"sessionId":"session-1","events":[
              {"seq":2,"type":"assistant_delta","requestId":"req-2","text":"lo"},
              {"seq":3,"type":"assistant_completed","requestId":"req-2","text":"hello","endSeq":3}
            ],"latestSeq":3}
            """.trimIndent(),
        )))

        assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("session-1"))
        assertEquals("hel", database.dao().getMessages("session-1").single().content)
        assertEquals(false, database.dao().getMessages("session-1").single().completed)

        assertEquals(RefreshResult.Applied(2, 3), repository.refreshEvents("session-1"))
        val message = database.dao().getMessages("session-1").single()
        assertEquals("hello", message.content)
        assertTrue(message.completed)
    }

    @Test
    fun providerMessageAliasDoesNotCreateSecondRoomRow() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """
            {"sessionId":"session-1","events":[
              {"seq":1,"type":"assistant_delta","canonicalMessageId":"canonical-alias","runId":"run-alias","providerItemId":"live-item","text":"SSH 引号转义出了问题，改用脚本文件方式查询："},
              {"seq":2,"type":"message","canonicalMessageId":"canonical-alias","role":"assistant","runId":"run-alias","providerMessageId":"final-message","content":"SSH 引号转义出了问题，改用脚本文件方式查询："}
            ],"latestSeq":2}
            """.trimIndent(),
        )))

        assertEquals(RefreshResult.Applied(2, 2), repository.refreshEvents("session-1"))
        val messages = database.dao().getMessages("session-1")
        assertEquals(1, messages.size)
        assertEquals("SSH 引号转义出了问题，改用脚本文件方式查询：", messages.single().content)
        assertTrue(messages.single().completed)
    }

    @Test
    fun liveAliasThenDurableCompletionRendersOneMessage() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"sessionId":"session-1","events":[
              {"seq":1,"type":"assistant_delta","canonicalMessageId":"canonical-alias","runId":"run-alias","providerItemId":"live-item","text":"Synthetic response"},
              {"seq":2,"type":"message","canonicalMessageId":"canonical-alias","role":"assistant","runId":"run-alias","providerMessageId":"final-message","content":"Synthetic response"}
            ],"latestSeq":2}""",
        )))
        repository.applyLiveEvents("session-1", listOf(
            SessionEventDto(seq = 1, type = "assistant_delta", canonicalMessageId = "canonical-alias", runId = "run-alias", providerItemId = "live-item", text = "Synthetic response"),
        ))
        assertEquals(1, repository.observeTimeline("session-1").first().filterIsInstance<TimelineItem.Message>().size)
        assertEquals(RefreshResult.Applied(2, 2), repository.refreshEvents("session-1"))
        val messages = repository.observeTimeline("session-1").first().filterIsInstance<TimelineItem.Message>()
        assertEquals(1, messages.size)
        assertEquals("Synthetic response", messages.single().text)
        assertTrue(messages.single().completed)
    }

    @Test
    fun liveEventsUseRoomAsBaselineWithoutAdvancingDurableCursor() = runBlocking {
        val repository = RoomSessionRepository(database, FakeTransport(
            """
            {"sessionId":"session-1","events":[
              {"seq":1,"eventId":"e1","type":"assistant_delta","entityId":"m1","requestId":"r1","text":"Hel"}
            ],"latestSeq":1}
            """.trimIndent(),
        ))
        repository.refreshEvents("session-1")

        val liveResult = repository.applyLiveEvents("session-1", listOf(
            SessionEventDto(seq = 2, eventId = "e2", type = "assistant_delta", entityId = "m1", requestId = "r1", text = "lo"),
        ))
        assertEquals(RefreshResult.Applied(1, 2), liveResult)
        assertEquals(1L, database.dao().getCursor("session-1")?.lastAppliedSeq)

        val item = database.dao().observeMessages("session-1").first().single()
        assertEquals("Hel", item.content)
        val timeline = repository.observeTimeline("session-1").first()
        assertEquals(1, timeline.size)
        assertEquals("Hello", (timeline.single() as TimelineItem.Message).text)
    }

    @Test
    fun refreshSnapshotsRemoveDevicesAndProjectsThatNoLongerExist() = runBlocking {
        val repository = RoomSessionRepository(database, QueuedTransport(listOf(
            """{"instanceId":"i","devices":[{"id":"device-1","deviceName":"Laptop","platform":"linux"}]}""",
            """{"instanceId":"i","devices":[]}""",
            """{"projects":[{"id":"project-1","name":"Reports","rootPath":"/work/reports"}]}""",
            """{"projects":[]}""",
        )))

        repository.refreshComputers()
        assertEquals(1, database.dao().observeComputers().first().size)
        repository.refreshComputers()
        assertEquals(0, database.dao().observeComputers().first().size)
        repository.refreshProjects()
        assertEquals(1, database.dao().observeProjects().first().size)
        repository.refreshProjects()
        assertEquals(0, database.dao().observeProjects().first().size)
    }

    @Test
    fun initialPageWithMissingSequenceDoesNotAdvanceCursorPastGap() = runBlocking {
        val repository = RoomSessionRepository(database, FakeTransport(
            """{"sessionId":"session-1","events":[{"seq":3,"type":"message","eventId":"evt-3","text":"late"}],"latestSeq":3}""",
        ))

        assertEquals(RefreshResult.Gap(1, 3), repository.refreshEvents("session-1"))
        assertEquals(null, database.dao().getCursor("session-1"))
        assertEquals(emptyList<Any>(), database.dao().getMessages("session-1"))
    }

    @Test
    fun approvedActionsDecisionPayloadIsBuiltInsideRepository() = runBlocking {
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(
                id = "batch-1",
                sessionId = "session-1",
                title = "Approve actions",
                status = "pending",
                runId = "run-1",
                batchId = "batch-1",
                kind = "approved_action_batch_request",
                detailsJson = "{\"actions\":[{\"actionId\":\"action-1\"},{\"actionId\":\"action-2\"}]}",
                updatedAt = 1L,
            ),
        ))
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        repository.resolveApprovedActionBatch(
            sessionId = "session-1",
            runId = "run-1",
            batchId = "batch-1",
            decisions = listOf(
                com.andysagent.agentoc.core.model.ApprovalActionDecision("action-1", "approve"),
                com.andysagent.agentoc.core.model.ApprovalActionDecision("action-2", "deny"),
            ),
            approvalIntent = "approve",
            requestId = "request-1",
        )

        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/runs/run-1/approved-actions/batch-1/resolve", request.path)
        val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
        assertTrue("Expected decisions object in ${body}", body["decisions"] != null)
        val decisions = body["decisions"]!!.jsonObject
        assertTrue("Expected action-1 decision in ${body}", decisions["action-1"] != null)
        assertTrue("Expected action-2 decision in ${body}", decisions["action-2"] != null)
        assertEquals("approve", decisions["action-1"]!!.jsonPrimitive.content)
        assertEquals("deny", decisions["action-2"]!!.jsonPrimitive.content)
        assertEquals("request-1", body["requestId"]!!.jsonPrimitive.content)
        assertEquals("approve", body["approvalIntent"]!!.jsonPrimitive.content)
    }

    @Test
    fun approvedActionsRejectUnknownDecisionIdsBeforeSending() = runBlocking {
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(
                id = "batch-1",
                sessionId = "session-1",
                title = "Approve actions",
                status = "pending",
                runId = "run-1",
                batchId = "batch-1",
                kind = "approved_action_batch_request",
                detailsJson = "{\"actions\":[{\"actionId\":\"action-1\"}]}",
                updatedAt = 1L,
            ),
        ))
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        val error = runCatching {
            repository.resolveApprovedActionBatch(
                sessionId = "session-1",
                runId = "run-1",
                batchId = "batch-1",
                decisions = listOf(
                    com.andysagent.agentoc.core.model.ApprovalActionDecision("action-1", "approve"),
                    com.andysagent.agentoc.core.model.ApprovalActionDecision("unknown", "deny"),
                ),
                approvalIntent = "approve",
                requestId = "request-unknown",
            )
        }.exceptionOrNull()

        assertTrue(error is IllegalArgumentException)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun cancelIsDurableAndReplayedAfterAConnectionDrop() = runBlocking {
        val transport = FailOnceTransport()
        val repository = RoomSessionRepository(database, transport)

        runCatching { repository.cancelSession("session-1") }
            .onSuccess { error("The first cancel request should simulate a transport failure") }
        val pending = database.dao().pendingOperations()
        assertEquals(1, pending.size)
        assertEquals("cancel_session", pending.single().kind)
        assertEquals("/api/sessions/session-1/cancel", pending.single().path)
        assertTrue(pending.single().requestId.startsWith("android:"))

        assertEquals(1, repository.resumePendingOperations())
        assertEquals(emptyList<Any>(), database.dao().pendingOperations())
        assertEquals(2, transport.requests.size)
        assertEquals(transport.requests[0].requestId, transport.requests[1].requestId)
        assertEquals(transport.requests[0].idempotencyKey, transport.requests[1].idempotencyKey)
    }

    @Test
    fun pendingReplayPreservesMethodHeadersAndIdempotencyKey() = runBlocking {
        database.dao().upsertOperation(
            PendingOperationEntity(
                requestId = "request-replay",
                kind = "update_goal",
                path = "/api/sessions/session-1",
                payload = "{\"goal\":null}",
                state = "pending",
                createdAt = 1L,
                updatedAt = 1L,
                method = "PATCH",
                headersJson = "{\"X-Test-Header\":\"replay\"}",
                idempotencyKey = "idem-replay",
            ),
        )
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        assertEquals(1, repository.resumePendingOperations())
        val request = transport.requests.single()
        assertEquals("PATCH", request.method)
        assertEquals("replay", request.headers["X-Test-Header"])
        assertEquals("idem-replay", request.idempotencyKey)
        assertEquals("{\"goal\":null}", request.body)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test
    fun planActionUsesDedicatedServerRouteAndStructuredPayload() = runBlocking {
        val transport = RecordingTransport().apply {
            responseBody = "{\"requestId\":\"plan-action-1\",\"session\":{\"id\":\"session-1\",\"title\":\"Task\",\"workflowState\":\"working\"}}"
        }
        val repository = RoomSessionRepository(database, transport)

        repository.submitPlanAction("session-1", "plan-42", "revise", "Add a validation step", "plan-action-1")

        val request = transport.requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/sessions/session-1/plans/plan-42/actions", request.path)
        assertEquals("plan-action-1", request.requestId)
        assertEquals("plan-action-1", request.idempotencyKey)
        val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
        assertEquals("revise", body["action"]!!.jsonPrimitive.content)
        assertEquals("Add a validation step", body["text"]!!.jsonPrimitive.content)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test
    fun refreshSessionsRestoresServerOwnedAgentBinding() = runBlocking {
        val repository = RoomSessionRepository(database, FakeTransport(
            """
            {"sessions":[{"id":"session-1","title":"Task","templateId":"agent_reporter",
              "workflowState":"idle","latestSeq":0}]}
            """.trimIndent(),
        ))

        repository.refreshSessions()

        assertEquals("agent_reporter", database.dao().getSession("session-1")?.templateId)
        assertEquals("agent_reporter", repository.observeSession("session-1").first()?.templateId)
    }

    @Test
    fun refreshSessionDetailPersistsServerOwnedFollowUpQueue() = runBlocking {
        val repository = RoomSessionRepository(database, FakeTransport(
            """{
                "session":{
                    "id":"session-1",
                    "title":"Task",
                    "status":"working",
                    "latestSeq":4,
                    "queuedMessages":[{
                        "requestId":"android:queue-1",
                        "responseId":"android:response-1",
                        "text":"Check the export",
                        "queuedAt":"2026-08-26T04:00:00Z",
                        "attachments":[{"assetId":"asset-1","originalName":"export.csv","mimeType":"text/csv","sizeBytes":24}],
                        "tool":"codex"
                    }]
                }
            }""".trimIndent(),
        ))

        val session = repository.refreshSessionDetail("session-1")

        assertEquals("working", database.dao().getSession("session-1")?.status)
        assertEquals(1, session?.queuedMessages?.size)
        assertEquals("android:queue-1", session?.queuedMessages?.single()?.requestId)
        assertEquals("export.csv", session?.queuedMessages?.single()?.attachments?.single()?.originalName)
        assertEquals("android:queue-1", repository.observeSession("session-1").first()?.queuedMessages?.single()?.requestId)
    }

    @Test
    fun queueMutationsUseControlPlaneActionsAndPersistReturnedProjection() = runBlocking {
        val transport = RecordingTransport().apply {
            responseBody = """{
                "session":{
                    "id":"session-1",
                    "title":"Task",
                    "status":"working",
                    "queuedMessages":[]
                }
            }""".trimIndent()
        }
        val repository = RoomSessionRepository(database, transport)

        repository.updateQueuedFollowUp("session-1", QueuedFollowUpAction.Delete, "android:queue-1")
        val deleteRequest = transport.requests.single()
        assertEquals("/api/sessions/session-1/queue", deleteRequest.path)
        val deleteBody = AgentocProtocol.json.parseToJsonElement(deleteRequest.body!!).jsonObject
        assertEquals("delete", deleteBody["action"]!!.jsonPrimitive.content)
        assertEquals("android:queue-1", deleteBody["requestId"]!!.jsonPrimitive.content)
        assertEquals("[]", database.dao().getSession("session-1")?.queuedMessagesJson)

        transport.requests.clear()
        transport.responseBody = """{
            "requestId":"android:queue-1",
            "steered":true,
            "pendingCancel":false,
            "queued":false,
            "session":{"id":"session-1","status":"working","queuedMessages":[]}
        }""".trimIndent()
        val result = repository.steerQueuedFollowUp("session-1", "android:queue-1")
        val steerRequest = transport.requests.single()
        val steerBody = AgentocProtocol.json.parseToJsonElement(steerRequest.body!!).jsonObject
        assertEquals("steer", steerBody["action"]!!.jsonPrimitive.content)
        assertEquals("android:queue-1", steerBody["requestId"]!!.jsonPrimitive.content)
        assertTrue(result.steered)
        assertEquals(false, result.queued)
    }

    @Test
    fun pendingQueueMutationReplayPersistsReturnedSessionBeforeDeletingOperation() = runBlocking {
        database.dao().upsertOperation(
            PendingOperationEntity(
                requestId = "queue-operation-1",
                kind = "queue_delete",
                path = "/api/sessions/session-1/queue",
                payload = "{\"action\":\"delete\",\"requestId\":\"android:queue-1\"}",
                state = "pending",
                createdAt = 1L,
                updatedAt = 1L,
                method = "POST",
                idempotencyKey = "queue-operation-1",
            ),
        )
        val transport = RecordingTransport().apply {
            responseBody = """{
                "session":{"id":"session-1","status":"working","queuedMessages":[]}
            }""".trimIndent()
        }
        val repository = RoomSessionRepository(database, transport)

        assertEquals(1, repository.resumePendingOperations())
        assertTrue(database.dao().pendingOperations().isEmpty())
        assertEquals("[]", database.dao().getSession("session-1")?.queuedMessagesJson)
    }

    @Test
    fun agentBindingSendsTemplateAndDropsTerminalConflict() = runBlocking {
        val transport = ConflictTransport()
        val repository = RoomSessionRepository(database, transport)

        val error = runCatching { repository.bindAgent("session-1", "agent_reporter") }.exceptionOrNull()

        assertTrue(error is SessionRepositoryException)
        assertEquals(409, (error as SessionRepositoryException).statusCode)
        assertEquals(1, transport.requests.size)
        val body = AgentocProtocol.json.parseToJsonElement(transport.requests.single().body!!).jsonObject
        assertEquals("agent_reporter", body["templateId"]!!.jsonPrimitive.content)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test
    fun messageHistoryActionsUseServerAnchorsAndStructuredContracts() = runBlocking {
        val transport = RecordingTransport().apply {
            responseBody = """
                {"sessionId":"session-1","events":[],"latestSeq":0,
                 "session":{"id":"forked-1","title":"Task branch","workflowState":"idle","latestSeq":4}}
            """.trimIndent()
        }
        val repository = RoomSessionRepository(database, transport)

        repository.regenerateMessage("session-1", "run-source", requestId = "run-regenerated")
        repository.resendEditedMessage(
            sessionId = "session-1",
            parentRequestId = "run-source",
            prompt = "Updated task",
            selection = RuntimeSelection(tool = "claude", model = "model-1", effort = "high"),
            requestId = "run-edited",
        )
        val forked = repository.forkSessionAt(
            sessionId = "session-1",
            anchorSeq = 42,
            mode = "assistant-continue",
            idempotencyKey = "fork-42",
        )

        val posts = transport.requests.filter { it.method == "POST" }
        assertEquals(
            listOf(
                "/api/sessions/session-1/regenerate",
                "/api/sessions/session-1/resend-edited",
                "/api/sessions/session-1/fork-at",
            ),
            posts.map { it.path },
        )
        val regenerate = AgentocProtocol.json.parseToJsonElement(posts[0].body!!).jsonObject
        assertEquals("run-source", regenerate["requestId"]!!.jsonPrimitive.content)
        assertEquals("run-regenerated", regenerate["newRequestId"]!!.jsonPrimitive.content)

        val edited = AgentocProtocol.json.parseToJsonElement(posts[1].body!!).jsonObject
        assertEquals("run-source", edited["requestId"]!!.jsonPrimitive.content)
        assertEquals("run-edited", edited["newRequestId"]!!.jsonPrimitive.content)
        assertEquals("Updated task", edited["prompt"]!!.jsonPrimitive.content)
        assertEquals("claude", edited["tool"]!!.jsonPrimitive.content)
        assertTrue("Edited resend must not invent an agent override: $edited", edited["agentId"] == null)

        val fork = AgentocProtocol.json.parseToJsonElement(posts[2].body!!).jsonObject
        assertEquals("42", fork["anchorSeq"]!!.jsonPrimitive.content)
        assertEquals("assistant-continue", fork["mode"]!!.jsonPrimitive.content)
        assertEquals("fork-42", fork["idempotencyKey"]!!.jsonPrimitive.content)
        assertEquals("forked-1", forked.id)
        assertEquals("forked-1", database.dao().getSession("forked-1")?.id)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test
    fun pendingForkReplayPersistsReturnedChildSessionBeforeDeletingOperation() = runBlocking {
        database.dao().upsertOperation(
            PendingOperationEntity(
                requestId = "fork-replay-1",
                kind = "fork_at",
                path = "/api/sessions/session-1/fork-at",
                payload = "{\"anchorSeq\":42,\"mode\":\"assistant-continue\",\"idempotencyKey\":\"fork-replay-1\"}",
                state = "pending",
                createdAt = 1L,
                updatedAt = 1L,
                method = "POST",
                idempotencyKey = "fork-replay-1",
            ),
        )
        val transport = RecordingTransport().apply {
            responseBody = """
                {"session":{"id":"forked-after-restart","title":"Recovered branch","workflowState":"idle","latestSeq":42}}
            """.trimIndent()
        }
        val repository = RoomSessionRepository(database, transport)

        assertEquals(1, repository.resumePendingOperations())
        assertEquals("forked-after-restart", database.dao().getSession("forked-after-restart")?.id)
        assertTrue(database.dao().pendingOperations().isEmpty())
        assertEquals("fork-replay-1", transport.requests.single().idempotencyKey)
    }

    @Test
    fun attachmentReplayUsesFinalizedAssetWithoutReuploadingSource() = runBlocking {
        database.dao().upsertOperation(
            PendingOperationEntity(
                requestId = "attachment-replay",
                kind = "send_message_with_attachments",
                path = "/api/sessions/session-1/messages",
                payload = """
                    {"sessionId":"session-1","text":"Send this file","requestId":"attachment-replay",
                     "tool":"codex","serviceTier":"standard","attachments":[
                       {"contentUri":"content://unavailable/source","originalName":"report.csv",
                        "mimeType":"text/csv","sizeBytes":12,"renderAsFile":true,"assetId":"asset-1"}
                     ]}
                """.trimIndent(),
                state = "pending",
                createdAt = 1L,
                updatedAt = 1L,
                method = "POST",
                idempotencyKey = "attachment-replay",
            ),
        )
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        assertEquals(1, repository.resumePendingOperations())

        val request = transport.requests.single()
        val body = AgentocProtocol.json.parseToJsonElement(request.body!!).jsonObject
        assertEquals("attachment-replay", request.requestId)
        assertEquals("asset-1", body["attachments"]!!.jsonArray.single().jsonObject["assetId"]!!.jsonPrimitive.content)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test
    fun sendingExistingAttachmentReusesAssetWithoutOpeningOrUploadingSource() = runBlocking {
        val transport = RecordingTransport()
        val repository = RoomSessionRepository(database, transport)

        repository.sendMessage(
            sessionId = "session-1",
            text = "Updated queued message",
            selection = RuntimeSelection(tool = "codex"),
            requestId = "queued-edit-resend",
            attachments = listOf(
                OutboundAttachment(
                    contentUri = "",
                    originalName = "report.pdf",
                    mimeType = "application/pdf",
                    sizeBytes = 4_096,
                    renderAsFile = true,
                    assetId = "asset-existing",
                ),
            ),
        )

        assertTrue(
            "Existing server assets must not create upload requests: ${transport.requests}",
            transport.requests.none { it.path == "/api/assets/upload-intents" || it.path.contains("/finalize") },
        )
        val messageRequest = transport.requests.single {
            it.method == "POST" && it.path == "/api/sessions/session-1/messages"
        }
        val body = AgentocProtocol.json.parseToJsonElement(messageRequest.body!!).jsonObject
        val attachment = body["attachments"]!!.jsonArray.single().jsonObject
        assertEquals("asset-existing", attachment["assetId"]!!.jsonPrimitive.content)
        assertEquals("report.pdf", attachment["originalName"]!!.jsonPrimitive.content)
        assertEquals("file", attachment["renderAs"]!!.jsonPrimitive.content)
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test fun pendingApprovalIsNotBlockedByAnotherSessionsLongPoll() = runBlocking {
        database.dao().upsertSessions(listOf(
            SessionEntity("waiting", "Waiting", null, "working", 0, 0),
            SessionEntity("approval", "Approval", null, "working", 0, 0),
        ))
        val transport = BlockingOtherSessionTransport()
        val repository = RoomSessionRepository(database, transport)
        val waiting = async { repository.refreshEvents("waiting") }
        try {
            withTimeout(5_000L) { transport.entered.await() }
            withTimeout(3_000L) { repository.refreshEvents("approval") }
            assertEquals(listOf("approval-1"), repository.observePendingApprovals("approval").first().map { it.id })
        } finally {
            transport.release.complete(Unit)
            waiting.await()
            repository.close()
        }
    }

    @Test
    fun endpointlessSyncReconcilesPendingApprovalsInAlreadyTerminalSessions() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "completed", 10, 0)))
        database.dao().upsertCursor(SyncCursorEntity("session-1", 10, null, updatedAt = 0))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "old", sessionId = "session-1", title = "Old", status = "pending", runId = "old-run", updatedAt = 1),
            ApprovalEntity(id = "active", sessionId = "session-1", title = "Active", status = "pending", runId = "active-run", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, TerminalApprovalSyncTransport())
        repository.startLiveSync()
        try {
            withTimeout(10_000L) {
                while (database.dao().getApproval("session-1", "old")?.status == "pending") delay(20L)
            }
            assertEquals("resolved", database.dao().getApproval("session-1", "old")?.status)
            assertEquals("pending", database.dao().getApproval("session-1", "active")?.status)
            assertEquals(listOf("active"), repository.observeAllPendingApprovals().first().map { it.id })
        } finally {
            repository.stopLiveSync()
            repository.close()
        }
    }

    @Test
    fun staleApprovalRetirementRemovesOnlyTheRequestedApprovalFromThePendingQueue() = runBlocking {
        database.dao().upsertSessions(listOf(
            SessionEntity("session-1", "Task one", null, "completed", 0, 0),
            SessionEntity("session-2", "Task two", null, "working", 0, 0),
        ))
        database.dao().upsertApprovals(listOf(
            ApprovalEntity(id = "expired-id", sessionId = "session-1", title = "Expired", status = "pending", runId = "run-1", updatedAt = 1),
            ApprovalEntity(id = "current-id", sessionId = "session-2", title = "Current", status = "pending", runId = "run-2", updatedAt = 2),
        ))
        val repository = RoomSessionRepository(database, FakeTransport("{}"))

        repository.retireStaleApproval("session-1", "expired-id")

        assertEquals("resolved", database.dao().getApproval("session-1", "expired-id")?.status)
        assertEquals("pending", database.dao().getApproval("session-2", "current-id")?.status)
        assertEquals(listOf("current-id"), repository.observeAllPendingApprovals().first().map { it.id })
        repository.close()
    }

    @Test
    fun endpointlessLiveSyncReconcilesFinalEventsAfterDetailBecomesTerminal() = runBlocking {
        database.dao().upsertSessions(listOf(SessionEntity("session-1", "Task", null, "working", 0, 0)))
        val transport = LiveSyncTransport()
        val repository = RoomSessionRepository(database, transport)

        repository.startLiveSync()
        try {
            withTimeout(8_000L) {
                while (database.dao().getMessages("session-1").size < 2) delay(20L)
            }
            withTimeout(2_000L) {
                while (transport.requests.count { it.path.contains("/events/wait?") && !it.path.contains("liveOnly=1") } < 2 ||
                    repository.observeSession("session-1").first()?.status != SessionStatus.Completed) delay(20L)
            }

            val messages = database.dao().getMessages("session-1")
            assertEquals(listOf("user", "assistant"), messages.map { it.role })
            assertEquals(listOf("hello", "hello"), messages.map { it.content })
            assertEquals(SessionStatus.Completed, repository.observeSession("session-1").first()?.status)
        } finally {
            repository.stopLiveSync()
        }
    }
}

private class BlockingOtherSessionTransport : AgentoCTransport {
    val entered = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    override val connectionState: StateFlow<RuntimeConnectionState> = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override val requiresEventPolling: Boolean = true
    override suspend fun execute(request: ApiRequest): ApiResponse {
        if (request.path.startsWith("/api/sessions/waiting/")) {
            entered.complete(Unit)
            release.await()
            return ApiResponse(200, """{"sessionId":"waiting","events":[],"latestSeq":0}""")
        }
        return ApiResponse(200, """{"sessionId":"approval","events":[{"seq":1,"type":"approval_request","approvalId":"approval-1","runId":"run-1"}],"latestSeq":1}""")
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class TerminalApprovalSyncTransport : AgentoCTransport {
    override val connectionState: StateFlow<RuntimeConnectionState> = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override val requiresEventPolling: Boolean = true
    override suspend fun execute(request: ApiRequest): ApiResponse {
        val body = when {
            request.path == "/api/sessions" || request.path == "/api/sessions?view=summary" ->
                """{"sessions":[{"id":"session-1","name":"Task","status":"completed","latestSeq":10}]}"""
            request.path.startsWith("/api/runs/") -> {
                val run = request.path.substringAfterLast('/')
                val status = if (run == "old-run") "completed" else "running"
                """{"run":{"id":"$run","sessionId":"session-1","state":"$status"}}"""
            }
            request.path.contains("/events") ->
                """{"sessionId":"session-1","events":[],"latestSeq":10,"runActivity":{"state":"idle"}}"""
            else -> """{"session":{"id":"session-1","status":"completed","latestSeq":10}}"""
        }
        return ApiResponse(200, body)
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class FakeTransport(private val responseBody: String) : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse = ApiResponse(200, responseBody)
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class QueuedTransport(private val responseBodies: List<String>) : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    private var index = 0
    val requests = mutableListOf<ApiRequest>()
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return ApiResponse(200, responseBodies[index++])
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class RecordingTransport : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    val requests = mutableListOf<ApiRequest>()
    var responseBody: String = "{}"
    var runResponseBody: String? = null
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return ApiResponse(200, if (request.path.startsWith("/api/runs/")) runResponseBody ?: responseBody else responseBody)
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class FailOnceTransport : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    private var failNext = true
    val requests = mutableListOf<ApiRequest>()
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        if (failNext) {
            failNext = false
            throw ApiException(0, "NETWORK_ERROR", "simulated connection drop", retryable = true)
        }
        return ApiResponse(200, "{}")
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class ConflictTransport : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    val requests = mutableListOf<ApiRequest>()
    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        throw ApiException(409, "SESSION_TEMPLATE_CONFLICT", "Templates can only be applied before the first message", retryable = true)
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class LiveSyncTransport : AgentoCTransport {
    private val state = MutableStateFlow(RuntimeConnectionState.Connected)
    @Volatile private var detailCount = 0
    val requests = java.util.concurrent.CopyOnWriteArrayList<ApiRequest>()

    override val connectionState: StateFlow<RuntimeConnectionState> = state
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override val requiresEventPolling: Boolean = true

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        if (request.path == "/api/sessions" || request.path == "/api/sessions?view=summary") {
            val status = if (detailCount >= 2) "completed" else "working"
            return ApiResponse(200, """{"sessions":[{"id":"session-1","name":"Task","status":"$status","latestSeq":0}]}""")
        }
        if (request.path.contains("liveOnly=1")) {
            // Model an older server that does not support a dedicated live page.
            return ApiResponse(200, """{"sessionId":"session-1","events":[],"latestSeq":0}""")
        }
        if (request.path.contains("/events/wait?")) {
            val body = if (requests.count { it.path.contains("/events/wait?") && !it.path.contains("liveOnly=1") } == 1) {
                """
                {"sessionId":"session-1","events":[
                  {"seq":1,"type":"user_message","requestId":"req-1","text":"hello"},
                  {"seq":2,"type":"assistant_completed","requestId":"req-1","text":"hello"}
                ],"latestSeq":2}
                """.trimIndent()
            } else {
                """{"sessionId":"session-1","events":[],"latestSeq":2}"""
            }
            return ApiResponse(200, body)
        }
        detailCount += 1
        val status = if (detailCount == 1) "working" else "completed"
        return ApiResponse(200, """{"session":{"id":"session-1","status":"$status","latestSeq":2}}""")
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
