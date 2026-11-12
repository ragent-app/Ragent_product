package com.andysagent.agentoc.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.andysagent.agentoc.core.database.AgentoCDatabase
import com.andysagent.agentoc.core.database.ApprovalEntity
import com.andysagent.agentoc.core.database.PendingOperationEntity
import com.andysagent.agentoc.core.database.SessionEntity
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.model.SessionStatus
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class RoomSessionDirectorySyncTest {
    @Test fun reconnectDoesNotReplayAnOperationStillSending() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        database.dao().upsertSessions(listOf(SessionEntity("live", "Live", "project", "idle", 1L, 1L)))
        val release = CompletableDeferred<Unit>()
        val started = CompletableDeferred<Unit>()
        val sent = AtomicInteger()
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.method == "POST" && request.path == "/api/sessions/live/messages" -> {
                    sent.incrementAndGet()
                    started.complete(Unit)
                    release.await()
                    ApiResponse(200, "{}")
                }
                request.method == "GET" && request.path == "/api/sessions/live" -> ApiResponse(200,
                    """{"session":{"id":"live","projectId":"project","status":"idle","latestSeq":1}}""")
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            val sending = async(start = CoroutineStart.UNDISPATCHED) { repository.sendMessage("live", "hello", "request") }
            withTimeout(5_000) { started.await() }
            assertEquals(1, sent.get())
            assertEquals(0, repository.resumePendingOperations())
            assertEquals(1, sent.get())
            release.complete(Unit)
            sending.await()
            assertNull(database.dao().getPendingOperation("request"))
            database.dao().upsertOperation(PendingOperationEntity(
                requestId = "recovered", kind = "send_message", path = "/api/sessions/live/messages",
                payload = "{}", state = "sending", createdAt = 1L, updatedAt = 1L,
            ))
            assertEquals(1, repository.resumePendingOperations())
            assertEquals(2, sent.get())
            assertNull(database.dao().getPendingOperation("recovered"))
        } finally { release.complete(Unit); repository.close(); database.close() }
    }

    @Test fun staleIdleDetailDoesNotRetireApprovalForAcceptedFirstTurn() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        database.dao().upsertSessions(listOf(SessionEntity("accepted", "New", "project", ACCEPTED_FIRST_TURN_STATUS, 0L, 1L)))
        database.dao().upsertApprovals(listOf(ApprovalEntity("approval", "accepted", "Approve", "pending", updatedAt = 1L)))
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                return when (request.path) {
                    "/api/sessions/accepted" -> ApiResponse(200, """{"session":{"id":"accepted","projectId":"project","status":"idle","latestSeq":0}}""")
                    "/api/sessions?view=summary" -> ApiResponse(200, """{"sessions":[]}""")
                    else -> error("Unexpected request: ${request.path}")
                }
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            assertEquals(SessionStatus.WaitingApproval, repository.refreshSessionDetail("accepted")?.status)
            assertEquals("pending", database.dao().getPendingApprovals("accepted").single().status)
            assertEquals(ACCEPTED_FIRST_TURN_WAITING_STATUS, database.dao().getSession("accepted")?.status)
            repository.close()
            val restarted = RoomSessionRepository(database, carrier)
            try {
                restarted.refreshSessions()
                val session = restarted.observeSessions().first().single()
                assertEquals(SessionStatus.WaitingApproval, session.status)
                assertEquals("project", session.projectId)
            } finally { restarted.close() }
        } finally { repository.close(); database.close() }
    }

    @Test fun acceptedFirstMessagePersistsBeforePendingOperationIsRemoved() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.method == "POST" && request.path == "/api/sessions" -> ApiResponse(200,
                    """{"session":{"id":"new","name":"New","projectId":"project","latestSeq":0}}""")
                request.method == "POST" && request.path == "/api/sessions/new/messages" -> ApiResponse(200, "{}")
                request.method == "GET" && request.path == "/api/sessions/new" -> ApiResponse(200,
                    """{"session":{"id":"new","name":"New","projectId":"project","status":"idle","latestSeq":0}}""")
                request.method == "GET" && request.path == "/api/sessions?view=summary" -> ApiResponse(200, """{"sessions":[]}""")
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val first = RoomSessionRepository(database, carrier)
        try {
            first.createSessionInProject("project", "New", "codex")
            first.sendMessage("new", "hello", "request")
            assertEquals(ACCEPTED_FIRST_TURN_STATUS, database.dao().getSession("new")?.status)
            assertNull(database.dao().getPendingOperation("request"))
            first.close()
            val restarted = RoomSessionRepository(database, carrier)
            try {
                restarted.refreshSessions()
                val retained = restarted.observeSessions().first().single()
                assertEquals(SessionStatus.Working, retained.status)
                assertEquals("project", retained.projectId)
            } finally { restarted.close() }
        } finally { first.close(); database.close() }
    }

    @Test fun acceptedFirstTurnSurvivesRepositoryRestartAndStaleIdleSummary() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        database.dao().upsertSessions(listOf(SessionEntity("accepted", "New", "project", ACCEPTED_FIRST_TURN_STATUS, 0L, 1L)))
        var phase = 0
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                if (request.path == "/api/sessions/accepted") {
                    if (phase == 3) throw ApiException(404, "not_found", "deleted")
                    return ApiResponse(200, "{}")
                }
                return ApiResponse(200, when (phase) {
                    0 -> """{"sessions":[]}"""
                    1 -> """{"sessions":[{"id":"accepted","name":"New","status":"idle","latestSeq":0}]}"""
                    2 -> """{"sessions":[{"id":"accepted","name":"New","projectId":null,"status":"idle","latestSeq":1}]}"""
                    else -> """{"sessions":[]}"""
                })
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshSessions()
            assertEquals(SessionStatus.Working, repository.observeSessions().first().single().status)
            assertEquals("project", repository.observeSessions().first().single().projectId)
            assertEquals(ACCEPTED_FIRST_TURN_STATUS, database.dao().getSession("accepted")?.status)
            phase = 1
            repository.refreshSessions()
            assertEquals(SessionStatus.Working, repository.observeSessions().first().single().status)
            assertEquals("project", repository.observeSessions().first().single().projectId)
            phase = 2
            repository.refreshSessions()
            assertEquals(1L, repository.observeSessions().first().single().latestSeq)
            assertNull(repository.observeSessions().first().single().projectId)
            assertEquals("idle", database.dao().getSession("accepted")?.status)
            database.dao().upsertSessions(listOf(SessionEntity("accepted", "New", "project", ACCEPTED_FIRST_TURN_STATUS, 0L, 1L)))
            phase = 3
            repository.refreshSessions()
            assertTrue(repository.observeSessions().first().isEmpty())
        } finally { repository.close(); database.close() }
    }

    @Test fun freshClientKeepsAcceptedStartingAndQueuedSessionsVisible() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                check(request.path == "/api/sessions?view=summary")
                return ApiResponse(200, """{"sessions":[
                    {"id":"starting","name":"New","projectId":"project","status":"idle","latestSeq":0,"activity":{"run":{"state":"starting"}}},
                    {"id":"queued","name":"Queued","projectId":"project","latestSeq":0,"activity":{"run":{"state":"queued"}}},
                    {"id":"empty","name":"Empty","projectId":"project","latestSeq":0,"activity":{"run":{"state":"idle"}}}
                ]}""")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshSessions()
            val sessions = repository.observeSessions().first().associateBy { it.id }
            assertEquals(SessionStatus.Working, sessions.getValue("starting").status)
            assertEquals(SessionStatus.Working, sessions.getValue("queued").status)
            assertEquals("project", sessions.getValue("starting").projectId)
            assertEquals(SessionStatus.Idle, sessions.getValue("empty").status)
        } finally { repository.close(); database.close() }
    }
    @Test fun durableEventCompactQueryFallsBackOnlyForLegacyRouteDenial() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val requests = mutableListOf<String>()
        var code = "temporary_control_route_denied"
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                requests += request.path
                if ("&compact=1" in request.path) throw ApiException(403, code, "denied")
                return ApiResponse(200, """{"sessionId":"s","events":[]}""")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshEvents("s")
            assertEquals(2, requests.size)
            assertTrue("&compact=1" in requests[0])
            assertEquals(requests[0].replace("&compact=1", ""), requests[1])
            requests.clear(); code = "permission_denied"
            try { repository.refreshEvents("s"); fail("Authorization failure must not fall back") }
            catch (error: SessionRepositoryException) { assertEquals("permission_denied", error.code) }
            assertEquals(1, requests.size)
        } finally { repository.close(); database.close() }
    }

    @Test fun olderTemporaryCarrierFallsBackOnlyForItsRouteDenial() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val requests = mutableListOf<String>()
        var errorCode = "temporary_control_route_denied"
        val carrier = object : AgentoCTransport {
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse {
                requests += request.path
                if (request.path.endsWith("?view=summary")) throw ApiException(403, errorCode, "denied")
                return ApiResponse(200, """{"sessions":[{"id":"one","name":"One"}]}""")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, carrier)
        try {
            repository.refreshSessions()
            assertEquals(listOf("/api/sessions?view=summary", "/api/sessions"), requests)
            assertEquals("one", repository.observeSessions().first().single().id)
            requests.clear(); errorCode = "permission_denied"
            try { repository.refreshSessions(); fail("Authorization failure must not fall back") }
            catch (error: SessionRepositoryException) { assertEquals("permission_denied", error.code) }
            assertEquals(listOf("/api/sessions?view=summary"), requests)
        } finally { repository.close(); database.close() }
    }

    @Test fun deletingOnOneClientRemovesTheIdleSessionOnAnotherWithoutReconnect() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val firstDb = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val peerDb = Room.inMemoryDatabaseBuilder(context, AgentoCDatabase::class.java).allowMainThreadQueries().build()
        val exists = AtomicBoolean(true)
        val deletes = AtomicInteger()
        fun carrier() = object : AgentoCTransport {
            override val requiresEventPolling = true
            override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
            override val invalidations: Flow<InvalidationHint> = emptyFlow()
            override suspend fun execute(request: ApiRequest): ApiResponse = when {
                request.method == "DELETE" && request.path == "/api/sessions/shared-idle" -> {
                    exists.set(false); deletes.incrementAndGet(); ApiResponse(200, "{}")
                }
                request.method == "GET" && request.path == "/api/sessions?view=summary" -> ApiResponse(200,
                    if (exists.get()) """{"sessions":[{"id":"shared-idle","name":"Shared","status":"idle"}]}"""
                    else """{"sessions":[]}""")
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val first = RoomSessionRepository(firstDb, carrier())
        val peer = RoomSessionRepository(peerDb, carrier())
        try {
            first.refreshSessions(); peer.refreshSessions()
            assertEquals(1, peer.observeSessions().first().size)
            peer.startLiveSync()
            first.deleteSession("shared-idle")
            assertEquals(1, deletes.get())
            assertTrue(first.observeSessions().first().isEmpty())
            withTimeout(6_000) { peer.observeSessions().first { it.isEmpty() } }
            Unit
        } finally { first.close(); peer.close(); firstDb.close(); peerDb.close() }
    }
}
