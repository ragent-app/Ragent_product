package com.andysagent.ragent.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.database.ApprovalEntity
import com.andysagent.ragent.core.database.SessionEntity
import com.andysagent.ragent.core.database.MessageEntity
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class RoomLiveFeedTest {
    @Test fun replayedApprovalRequestCannotReopenLocallyResolvedCard() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = LiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertApprovals(listOf(ApprovalEntity(
                id = "question-1",
                sessionId = "session-live",
                title = "Choose one",
                status = "resolved",
                runId = "run-ended",
                kind = "approval_request",
                updatedAt = 1,
            )))
            transport.body = """{"sessionId":"session-live","events":[{"seq":1,"eventId":"approval-request-1","type":"approval_request","approvalId":"question-1","runId":"run-ended","title":"Choose one","reason":"Choose one"}],"latestSeq":1}"""

            repo.refreshEvents("session-live")

            assertEquals("resolved", database.dao().getApproval("session-live", "question-1")?.status)
            assertTrue(database.dao().getPendingApprovals("session-live").isEmpty())
        } finally { repo.close(); database.close() }
    }

    @Test fun previouslyCachedCompactionHandoffIsNotShownAsChat() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val repo = RoomSessionRepository(database, LiveFeedTransport())
        try {
            database.dao().upsertMessages(listOf(
                MessageEntity("internal", "session-live", "assistant", "# Auto Compress\n\n## Kept in current context\n- internal", 1, null, completed = true, updatedAt = 0),
                MessageEntity("visible", "session-live", "assistant", "Normal response", 2, null, runId = "run-a", completed = true, updatedAt = 0),
            ))
            assertEquals(listOf("visible"), repo.observeMessages("session-live").first().map { it.id })
            assertEquals(2, database.dao().getMessages("session-live").size)
        } finally { repo.close(); database.close() }
    }

    @Test fun liveTextDoesNotWaitForUnfinishedHistoryOrActivityRequests() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = IndependentLiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Live", null, "running", 0, 0)))
            repo.startLiveSync()
            val visible = withTimeout(5_000) {
                repo.observeTimeline("session-live").first { items -> items.any {
                    it is TimelineItem.Message && it.text == "Real token" && !it.completed
                } }
            }
            assertTrue(visible.isNotEmpty())
            assertTrue("History is still deliberately blocked", !transport.releaseHistory.isCompleted)
            assertEquals(null, database.dao().getCursor("session-live"))
        } finally { transport.releaseHistory.complete(Unit); repo.close(); database.close() }
    }

    @Test fun liveTokensRenderBeforeCompletionWithoutAdvancingTheDurableCursorOrDuplicatingTheFinal() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = LiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        suspend fun reply(text: String, completed: Boolean? = null) = withTimeout(5_000) {
            repo.observeTimeline("session-live").first { items -> items.any {
                it is TimelineItem.Message && it.role == TimelineRole.Agent && it.text == text && (completed == null || it.completed == completed)
            } }.filterIsInstance<TimelineItem.Message>()
        }
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Live", null, "running", 0, 0)))
            transport.body = """{"sessionId":"session-live","events":[{"seq":1,"type":"message","role":"user","content":"hello","requestId":"req-a"}],"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":1,"liveEvents":[{"seq":0,"eventId":"live-1","type":"text_delta","role":"assistant","entityId":"reply-a","text":"Hel","requestId":"req-a","runId":"run-a"}]}"""
            repo.refreshEvents("session-live")
            assertEquals("Hel", reply("Hel").last().text)
            assertEquals(1L, database.dao().getCursor("session-live")?.lastAppliedSeq)
            assertTrue(transport.requests.last().path.contains("includeLive=1"))
            transport.body = """{"sessionId":"session-live","events":[],"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":2,"liveEvents":[{"seq":0,"eventId":"live-2","type":"text_delta","role":"assistant","entityId":"reply-a","text":"lo","requestId":"req-a","runId":"run-a"}]}"""
            repo.refreshEvents("session-live")
            assertEquals("Hello", reply("Hello").last().text)
            assertTrue(transport.requests.last().path.contains("liveAfterCursor=1"))
            repo.refreshEvents("session-live")
            assertEquals("a retried page must not append tokens twice", "Hello", reply("Hello").last().text)
            transport.body = """{"sessionId":"session-live","events":[{"seq":2,"type":"message","role":"assistant","entityId":"reply-a","content":"Hello","requestId":"req-a","runId":"run-a"}],"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":2,"liveEvents":[]}"""
            repo.refreshEvents("session-live")
            val final = reply("Hello", true).filter { it.role == TimelineRole.Agent }
            assertEquals(1, final.size); assertTrue(final.single().completed)
            assertEquals(2L, database.dao().getCursor("session-live")?.lastAppliedSeq)
        } finally { repo.close(); database.close() }
    }

    @Test fun asyncQuestionMetadataPersistsInRoomAndCrossClientReplyMarksItAnswered() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = LiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Async", null, "running", 0, 0)))
            transport.body = """
                {
                  "sessionId": "session-live",
                  "events": [
                    {
                      "seq": 1,
                      "type": "message",
                      "role": "assistant",
                      "entityId": "msg-async",
                      "content": "Pick deploy target",
                      "delivery": "async",
                      "asyncQuestionMessageId": "aqm-99",
                      "asyncQuestionsState": "pending",
                      "asyncQuestions": [
                        {
                          "id": "aq-item-1",
                          "index": 0,
                          "title": "Target",
                          "question": "Which target?",
                          "options": [{"label": "Staging", "value": "staging", "description": "Safe"}]
                        }
                      ]
                    }
                  ],
                  "latestSeq": 1
                }
            """.trimIndent()
            repo.refreshEvents("session-live")

            val beforeReply = repo.observeMessages("session-live").first().single()
            assertEquals("async", beforeReply.messageDelivery)
            assertEquals("aqm-99", beforeReply.asyncQuestionMessageId)
            assertEquals(1, beforeReply.asyncQuestions.size)
            assertEquals("pending", beforeReply.asyncQuestions.single().status)

            // Cross-client reply arrives as a user message containing <send_user_message_question_reply>.
            transport.body = """
                {
                  "sessionId": "session-live",
                  "events": [
                    {
                      "seq": 2,
                      "type": "message",
                      "role": "user",
                      "entityId": "msg-user",
                      "content": "<send_user_message_question_reply>\n[{\"questionItemId\":\"aq-item-1\",\"question\":\"Which target?\",\"answer\":\"staging\"}]\n</send_user_message_question_reply>"
                    }
                  ],
                  "latestSeq": 2
                }
            """.trimIndent()
            repo.refreshEvents("session-live")

            val afterReply = repo.observeMessages("session-live").first()
            val updatedQuestionMsg = afterReply.first { it.id == beforeReply.id }
            assertEquals("answered", updatedQuestionMsg.asyncQuestions.single().status)
            assertEquals("staging", updatedQuestionMsg.asyncQuestions.single().answeredText)
            assertEquals("answered", updatedQuestionMsg.asyncQuestionsState)
        } finally { repo.close(); database.close() }
    }

    @Test fun nonBlockingQuestionPreservesRunningSessionStatusAndApprovalDetailsRoundTrip() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = LiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Codex", null, "running", 0, 0)))
            transport.body = """
                {
                  "sessionId": "session-live",
                  "events": [
                    {
                      "seq": 1,
                      "type": "approval_request",
                      "kind": "question",
                      "approvalId": "q-nb",
                      "runId": "run-1",
                      "isBlocking": false,
                      "title": "Feedback",
                      "questions": [
                        {
                          "id": "q1",
                          "header": "Tone",
                          "question": "Preferred tone?",
                          "isOther": false,
                          "isSecret": true,
                          "options": [{"label": "Concise", "value": "concise", "description": "Short replies"}]
                        }
                      ]
                    },
                    {
                      "seq": 2,
                      "type": "approval_request",
                      "kind": "permissions",
                      "approvalId": "el-1",
                      "runId": "run-1",
                      "title": "MCP Elicitation",
                      "elicitation": {
                        "mode": "form",
                        "serverName": "github",
                        "elicitationId": "el-id",
                        "requestedSchema": {
                          "properties": {"token": {"type": "string", "format": "password"}},
                          "required": ["token"]
                        }
                      }
                    }
                  ],
                  "latestSeq": 2
                }
            """.trimIndent()
            repo.refreshEvents("session-live")

            val pending = repo.observePendingApprovals("session-live").first().associateBy { it.id }
            val nbQuestion = pending.getValue("q-nb")
            assertFalse(nbQuestion.isBlocking)
            assertEquals("Tone", nbQuestion.questions.single().header)
            assertEquals(false, nbQuestion.questions.single().isOther)
            assertTrue(nbQuestion.questions.single().isSecret)
            assertEquals("Short replies", nbQuestion.questions.single().options.single().description)

            val elicitation = pending.getValue("el-1").elicitation
            assertNotNull(elicitation)
            assertEquals("github", elicitation?.serverName)
            assertTrue(elicitation?.schemaProperties?.single()?.isSecretField == true)

            // Non-blocking question alone must not coerce a running session to waiting_approval,
            // though here el-1 is blocking so let's also verify removing el-1 keeps session non-blocked.
            repo.retireStaleApproval("session-live", "el-1")
            assertEquals("waiting_approval", database.dao().getSession("session-live")?.status)
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Codex", null, "running", 0, 0)))
            transport.body = """{"sessionId":"session-live","events":[{"seq":3,"type":"approval_request","kind":"question","approvalId":"q-nb-2","runId":"run-1","isBlocking":false,"questions":[{"question":"Optional?"}]}],"latestSeq":3}"""
            repo.refreshEvents("session-live")
            assertEquals("running", database.dao().getSession("session-live")?.status)
        } finally { repo.close(); database.close() }
    }

    @Test fun refreshTimelinePaginatesForwardDurablePagesUntilCaughtUpToLatestSeq() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val requests = mutableListOf<ApiRequest>()
        val transport = HandlerTransport { request ->
            requests += request
            when {
                request.path.contains("filter=visible") ->
                    ApiResponse(200, """{"sessionId":"session-live","events":[],"latestSeq":250}""")
                request.path.contains("afterSeq=0") -> {
                    val events = (1..200).joinToString(",") { seq ->
                        if (seq == 1 || seq == 200) {
                            """{"seq":$seq,"id":"e-$seq","type":"message","role":"assistant","canonicalMessageId":"msg-$seq","content":"Message $seq"}"""
                        } else {
                            """{"seq":$seq,"id":"e-$seq","type":"status","runId":"run-1","state":"working"}"""
                        }
                    }
                    ApiResponse(200, """{"sessionId":"session-live","events":[$events],"latestSeq":250,"pagination":{"hasMoreAfter":true,"latestSeq":250}}""")
                }
                request.path.contains("afterSeq=200") -> {
                    val events = (201..250).joinToString(",") { seq ->
                        if (seq == 250) {
                            """{"seq":$seq,"id":"e-$seq","type":"message","role":"assistant","canonicalMessageId":"msg-$seq","content":"Final page 2"}"""
                        } else {
                            """{"seq":$seq,"id":"e-$seq","type":"status","runId":"run-1","state":"working"}"""
                        }
                    }
                    ApiResponse(200, """{"sessionId":"session-live","events":[$events],"latestSeq":250,"pagination":{"hasMoreAfter":false,"latestSeq":250}}""")
                }
                else -> error("Unexpected request: ${request.path}")
            }
        }
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Paged", null, "completed", 250, 0)))
            val result = repo.refreshTimeline("session-live")
            assertTrue(result is RefreshResult.Applied)
            assertEquals(250L, database.dao().getCursor("session-live")?.lastAppliedSeq)
            val messages = database.dao().getMessages("session-live")
            assertEquals(listOf("Message 1", "Message 200", "Final page 2"), messages.map { it.content })
            assertTrue(requests.any { it.path.contains("afterSeq=0") })
            assertTrue(requests.any { it.path.contains("afterSeq=200") })
        } finally { repo.close(); database.close() }
    }

    @Test fun refreshTimelineRecoversFromGapAndPreservesCacheWhenGapIsUnrecoverable() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        var phase = "initial"
        val transport = HandlerTransport { request ->
            when {
                request.path.contains("filter=visible") ->
                    ApiResponse(200, """{"sessionId":"session-live","events":[],"latestSeq":2}""")
                phase == "initial" ->
                    ApiResponse(200, """{"sessionId":"session-live","events":[{"seq":1,"id":"evt_000001","type":"message","role":"user","canonicalMessageId":"m-1","content":"First"}],"latestSeq":1}""")
                phase == "collision" && request.path.contains("afterSeq=1") ->
                    // Simulates server restart reusing evt_000001 at seq=2, which hits InvalidEvent -> Gap.
                    ApiResponse(200, """{"sessionId":"session-live","events":[{"seq":2,"id":"evt_000001","type":"message","role":"assistant","canonicalMessageId":"m-2","content":"Recovered reply"}],"latestSeq":2}""")
                phase == "collision" && request.path.contains("afterSeq=0") ->
                    ApiResponse(200, """{"sessionId":"session-live","events":[{"seq":1,"id":"evt_000001","type":"message","role":"user","canonicalMessageId":"m-1","content":"First"},{"seq":2,"id":"evt_000002","type":"message","role":"assistant","canonicalMessageId":"m-2","content":"Recovered reply"}],"latestSeq":2}""")
                phase == "unrecoverable_gap" ->
                    ApiResponse(200, """{"sessionId":"session-live","events":[{"seq":4,"id":"evt_000004","type":"message","role":"assistant","canonicalMessageId":"m-4","content":"Skipped"}],"latestSeq":4}""")
                else -> error("Unexpected request: ${request.path}")
            }
        }
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Gap", null, "idle", 1, 0)))
            assertEquals(RefreshResult.Applied(1, 1), repo.refreshEvents("session-live"))

            phase = "collision"
            val recovered = repo.refreshTimeline("session-live")
            assertTrue(recovered is RefreshResult.Applied)
            assertEquals(2L, database.dao().getCursor("session-live")?.lastAppliedSeq)
            assertEquals(listOf("First", "Recovered reply"), database.dao().getMessages("session-live").map { it.content })

            phase = "unrecoverable_gap"
            val unresolved = repo.refreshTimeline("session-live")
            assertTrue(unresolved is RefreshResult.Gap)
            assertEquals(2L, database.dao().getCursor("session-live")?.lastAppliedSeq)
            assertEquals(listOf("First", "Recovered reply"), database.dao().getMessages("session-live").map { it.content })
        } finally { repo.close(); database.close() }
    }

    @Test fun invalidLiveFeedResetsAndMutesOnlyLiveOverlayWithoutWipingDurableSync() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val transport = LiveFeedTransport()
        val repo = RoomSessionRepository(database, transport)
        try {
            database.dao().upsertSessions(listOf(SessionEntity("session-live", "Live", null, "running", 0, 0)))
            transport.body = """{"sessionId":"session-live","events":[{"seq":1,"type":"message","role":"user","canonicalMessageId":"u1","content":"Prompt"}],"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":1,"liveEvents":[{"seq":0,"eventId":"live-1","type":"text_delta","role":"assistant","entityId":"reply-a","text":"Partial","runId":"run-a"}]}"""
            assertEquals(RefreshResult.Applied(1, 1), repo.refreshEvents("session-live"))

            // Invalid live stream ID or unknown live event must mute only the live overlay, not fail durable sync.
            transport.body = """{"sessionId":"session-live","events":[{"seq":2,"type":"message","role":"assistant","canonicalMessageId":"a1","content":"Durable answer"}],"liveStreamId":"invalid-stream-id","liveCursor":2,"liveEvents":[{"seq":0,"eventId":"live-2","type":"unknown_bad_frame"}]}"""
            val durableAfterInvalidLive = repo.refreshEvents("session-live")
            assertEquals(RefreshResult.Applied(1, 2), durableAfterInvalidLive)
            assertEquals(2L, database.dao().getCursor("session-live")?.lastAppliedSeq)
            assertEquals(listOf("Prompt", "Durable answer"), database.dao().getMessages("session-live").map { it.content })

            val timeline = repo.observeTimeline("session-live").first { items ->
                items.filterIsInstance<TimelineItem.Message>().any { it.text == "Durable answer" }
            }.filterIsInstance<TimelineItem.Message>()
            assertEquals(listOf("Prompt", "Durable answer"), timeline.map { it.text })

            // Invalid live frame inside an otherwise well-formed liveStreamId on an unmuted session also mutes without throwing.
            database.dao().upsertSessions(listOf(SessionEntity("session-live-2", "Live 2", null, "running", 0, 0)))
            transport.body = """{"sessionId":"session-live-2","events":[{"seq":1,"type":"message","role":"user","canonicalMessageId":"u2","content":"Next"}],"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":1,"liveEvents":[{"seq":0,"eventId":"live-3","type":"unknown_bad_frame"}]}"""
            assertEquals(RefreshResult.Applied(1, 1), repo.refreshEvents("session-live-2"))
            assertEquals(1L, database.dao().getCursor("session-live-2")?.lastAppliedSeq)
            assertEquals(listOf("Next"), database.dao().getMessages("session-live-2").map { it.content })
        } finally { repo.close(); database.close() }
    }
}

private class HandlerTransport(
    private val handler: suspend (ApiRequest) -> ApiResponse,
) : RagentTransport {
    override val requiresEventPolling = true
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    override suspend fun execute(request: ApiRequest): ApiResponse = handler(request)
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class IndependentLiveFeedTransport : RagentTransport {
    override val requiresEventPolling = true
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    val releaseHistory = kotlinx.coroutines.CompletableDeferred<Unit>()
    private val historyStarted = kotlinx.coroutines.CompletableDeferred<Unit>()
    private val activityStarted = kotlinx.coroutines.CompletableDeferred<Unit>()
    private var livePages = 0
    override suspend fun execute(request: ApiRequest): ApiResponse {
        if (request.path.contains("liveOnly=1")) {
            val probe = request.path.contains("timeoutMs=1&")
            if (probe) return ApiResponse(200, """{"sessionId":"session-live","events":[],"liveOnly":true,"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":0}""")
            if (livePages++ == 0) {
                historyStarted.await()
                activityStarted.await()
                return ApiResponse(200, """{"sessionId":"session-live","events":[],"liveOnly":true,"liveStreamId":"12345678-1234-1234-1234-123456789abc","liveCursor":1,"liveEvents":[{"type":"text_delta","eventId":"token-1","role":"assistant","entityId":"reply","text":"Real token","messageState":"streaming"}]}""")
            }
            kotlinx.coroutines.awaitCancellation()
        }
        if (request.path == "/api/sessions/session-live") return ApiResponse(200, """{"session":{"id":"session-live","name":"Live","status":"running"}}""")
        if (request.path.contains("filter=visible")) {
            activityStarted.complete(Unit)
            releaseHistory.await()
            return ApiResponse(200, """{"sessionId":"session-live","events":[],"runActivity":{"state":"working","kind":"read","subject":"README.md"}}""")
        }
        historyStarted.complete(Unit)
        releaseHistory.await()
        return ApiResponse(200, """{"sessionId":"session-live","events":[],"latestSeq":0}""")
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}

private class LiveFeedTransport : RagentTransport {
    override val requiresEventPolling = true
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    var body = "{}"
    val requests = mutableListOf<ApiRequest>()
    override suspend fun execute(request: ApiRequest): ApiResponse { requests += request; return ApiResponse(200, body) }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
