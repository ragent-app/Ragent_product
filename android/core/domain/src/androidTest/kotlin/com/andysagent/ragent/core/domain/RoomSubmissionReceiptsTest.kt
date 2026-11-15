package com.andysagent.ragent.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.protocol.CreateSessionRequestDto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.Assert.*

@RunWith(AndroidJUnit4::class)
class RoomSubmissionReceiptsTest {
    private lateinit var database: RagentDatabase
    @Before fun setup() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), RagentDatabase::class.java)
            .allowMainThreadQueries().build()
    }
    @After fun teardown() = database.close()

    @Test fun idempotentCreationChecksVersionThenAcknowledgesExactKey() = runBlocking {
        val transport = RecordingTransport { request ->
            if (request.method == "GET") ApiResponse(200, """{"version":1}""")
            else ApiResponse(200, """{"session":{"id":"s","name":"Task"},"duplicate":true,"creationContractVersion":1}""")
        }
        val receipt = RoomSessionRepository(database, transport).createSessionIdempotent(CreateSessionRequestDto(tool = "codex"), "op:create")
        assertEquals("s", receipt.session.id)
        assertTrue(receipt.duplicate)
        assertEquals("/api/session-creation-contract", transport.requests[0].path)
        assertEquals("op:create", transport.requests[1].idempotencyKey)
        assertTrue(transport.requests[1].body!!.contains("op:create"))
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test fun oldTargetCannotReceiveUnprotectedCreation() = runBlocking {
        val transport = RecordingTransport { ApiResponse(200, """{"version":0}""") }
        try {
            RoomSessionRepository(database, transport).createSessionIdempotent(CreateSessionRequestDto(tool = "codex"), "op:create")
            fail("Old target must be rejected before POST")
        } catch (_: IllegalStateException) { }
        assertEquals(listOf("GET"), transport.requests.map { it.method })
    }

    @Test fun queueReceiptAndUnknownDeliveryAreNeverOwnedByLegacyReplay() = runBlocking {
        var loseResponse = false
        val transport = RecordingTransport {
            if (loseResponse) throw java.io.IOException("Response lost after remote acceptance")
            ApiResponse(202, """{"requestId":"op:message","duplicate":false,"queued":true,"run":null}""")
        }
        val repository = RoomSessionRepository(database, transport)
        val receipt = repository.submitMessage("s", "Task", RuntimeSelection(tool = "codex"), "op:message")
        assertTrue(receipt.queued)
        assertNull(receipt.runId)
        loseResponse = true
        try {
            repository.submitMessage("s", "Task", RuntimeSelection(tool = "codex"), "op:message")
            fail("Unknown response must remain observable")
        } catch (_: java.io.IOException) { }
        assertTrue(database.dao().pendingOperations().isEmpty())
        assertEquals(listOf("op:message", "op:message"), transport.requests.map { it.idempotencyKey })
    }

    @Test fun receiptLookupOnlyGetsAndNeverAddsPendingReplay() = runBlocking {
        var state = "accepted"
        val transport = RecordingTransport {
            ApiResponse(200, """{"receiptContractVersion":1,"sessionId":"s","requestId":"op:message","state":"$state","queued":false,"runId":"run-1"}""")
        }
        val repository = RoomSessionRepository(database, transport)
        assertEquals("run-1", repository.findMessageSubmissionReceipt("s", "op:message")!!.runId)
        state = "unconfirmed"
        assertNull(repository.findMessageSubmissionReceipt("s", "op:message"))
        assertTrue(transport.requests.all { it.method == "GET" && it.path.endsWith("/message-receipts/op%3Amessage") })
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    @Test fun oldTargetLookupFailureCannotFallBackToPost() = runBlocking {
        val transport = RecordingTransport { throw ApiException(404, null, "No such route") }
        try {
            RoomSessionRepository(database, transport).findMessageSubmissionReceipt("s", "op:message")
            fail("An unsupported receipt route must remain visible")
        } catch (error: SessionRepositoryException) { assertEquals(404, error.statusCode) }
        assertEquals(listOf("GET"), transport.requests.map { it.method })
        assertTrue(database.dao().pendingOperations().isEmpty())
    }

    private class RecordingTransport(val response: suspend (ApiRequest) -> ApiResponse) : RagentTransport {
        val requests = mutableListOf<ApiRequest>()
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
        override suspend fun execute(request: ApiRequest): ApiResponse {
            requests += request
            return response(request)
        }
        override fun connectInvalidationSocket() {}
        override suspend fun close() {}
    }
}
