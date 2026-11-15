package com.andysagent.ragent.core.domain

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class ContentReportsRepositoryTest {
    private val id = "067ba243-89bd-411e-8ea7-5d939e426014"
    private class Journal : ContentReportJournal {
        var record: ContentReportRecord? = null
        var failRead = false
        var failWrite = false
        override suspend fun read(): ContentReportRecord? { if (failRead) throw IOException("private"); return record }
        override suspend fun write(record: ContentReportRecord) { if (failWrite) throw IOException("private"); this.record = record }
        override suspend fun clear() { record = null; failRead = false }
    }
    private class Transport : RagentTransport {
        val requests = mutableListOf<ApiRequest>()
        var answer: suspend (ApiRequest) -> ApiResponse = { error("unexpected request") }
        override val invalidations = emptyFlow<InvalidationHint>()
        override val connectionState = MutableStateFlow(RuntimeConnectionState.Disconnected)
        override suspend fun execute(request: ApiRequest): ApiResponse { requests += request; return answer(request) }
        override fun connectInvalidationSocket() = error("no websocket allowed")
        override suspend fun close() {}
    }
    private fun response(status: String = "received", requestId: String = id, updated: String = "2026-10-27T00:00:00.000Z") = ApiResponse(200,
        """{"contractVersion":1,"requestId":"$requestId","receipt":{"id":"report_$requestId","status":"$status","receivedAt":"2026-10-27T00:00:00.000Z","updatedAt":"$updated"}}""")

    @Test fun journalPrecedesPostAndOnlyExplicitlySelectedFieldsLeavePhone() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { request ->
            assertNotNull(journal.record)
            assertEquals("/v1/content-reports", request.path)
            assertTrue(request.headers.isEmpty()); assertNull(request.requestId); assertNull(request.idempotencyKey)
            val body = Json.parseToJsonElement(request.body!!).jsonObject
            assertEquals(setOf("schemaVersion", "requestId", "reason", "details", "includeContent", "content", "appVersion"), body.keys)
            assertEquals("", body["content"]!!.jsonPrimitive.content)
            response()
        }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertNull(repo.saved()); assertTrue(transport.requests.isEmpty())
        val accepted = repo.submit(ContentReportReason.Privacy, "note", false, "PRIVATE UNSELECTED REPLY")
        assertEquals("received", accepted.receipt!!.status)
        assertFalse(transport.requests.single().body!!.contains("PRIVATE"))
    }

    @Test fun lostResponseSurvivesColdRepositoryAndQueriesOriginalReceiptWithoutReplay() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { throw IOException("lost after acceptance") }
        val first = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertFailsWith<ContentReportException> { first.submit(ContentReportReason.Unsafe, "", true, "excerpt") }
        val frozen = journal.record!!
        val cold = HttpContentReportsRepository(transport, journal, "new-version") { error("must not allocate another ID") }
        assertEquals(frozen, cold.saved()); assertEquals(1, transport.requests.size)
        transport.answer = { assertEquals("GET", it.method); assertTrue(it.path.endsWith(id)); response() }
        assertEquals("received", cold.checkReceipt(true).receipt!!.status)
        assertEquals(listOf("POST", "GET"), transport.requests.map { it.method })
    }

    @Test fun explicitRetryChecksFirstThenReusesIdenticalPayloadAndId() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { ApiResponse(503, "") }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertFailsWith<ContentReportException> { repo.submit(ContentReportReason.Other, "notes", true, "selected") }
        transport.answer = { if (it.method == "GET") ApiResponse(404, "") else response() }
        repo.checkReceipt(true)
        assertEquals(listOf("POST", "GET", "POST"), transport.requests.map { it.method })
        assertEquals(transport.requests.first().body, transport.requests.last().body)
    }

    @Test fun statusQueryNeverPostsAndFailedLookupBlocksEvenExplicitRetry() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { ApiResponse(503, "") }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertFails { repo.submit(ContentReportReason.Other, "", false, "") }
        for (retry in listOf(false, true)) assertFails { repo.checkReceipt(retry) }
        assertEquals(listOf("POST", "GET", "GET"), transport.requests.map { it.method })
        transport.answer = { ApiResponse(404, "") }
        assertFails { repo.checkReceipt(false) }
        assertEquals(1, transport.requests.count { it.method == "POST" })
    }

    @Test fun malformedOrWrongIdentityReceiptCannotBecomeAccepted() = runTest {
        for (invalid in listOf("{}", "<html>ok</html>", response(requestId = "other").body,
            response(status = "success").body, response(updated = "invalid").body)) {
            val journal = Journal(); val transport = Transport()
            transport.answer = { ApiResponse(200, invalid) }
            val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
            assertEquals(ContentReportError.Unconfirmed,
                assertFailsWith<ContentReportException> { repo.submit(ContentReportReason.Other, "", false, "") }.kind)
            assertNull(journal.record!!.receipt)
        }
    }

    @Test fun receiptCannotRegressOrAuthorizeRepostWhenServerLaterLosesIt() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { response("closed") }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        repo.submit(ContentReportReason.Other, "", false, "")
        transport.answer = { response("received") }
        assertFails { repo.checkReceipt() }
        transport.answer = { ApiResponse(404, "") }
        assertFails { repo.checkReceipt(true) }
        assertEquals("closed", repo.saved()!!.receipt!!.status)
        assertEquals(1, transport.requests.count { it.method == "POST" })
    }

    @Test fun storageFailureNeverPermitsExternalWriteOrOverwritesCorruption() = runTest {
        for (onRead in listOf(false, true)) {
            val journal = Journal().apply { failRead = onRead; failWrite = !onRead }
            val transport = Transport()
            val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
            assertEquals(ContentReportError.Storage,
                assertFailsWith<ContentReportException> { repo.submit(ContentReportReason.Other, "", false, "") }.kind)
            assertTrue(transport.requests.isEmpty())
        }
    }

    @Test fun simultaneousTapsCannotCreateSecondWrite() = runTest {
        val journal = Journal(); val transport = Transport(); val gate = CompletableDeferred<Unit>()
        transport.answer = { gate.await(); response() }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        val first = async { repo.submit(ContentReportReason.Other, "", false, "") }
        runCurrent()
        val second = async { runCatching { repo.submit(ContentReportReason.Other, "", false, "") } }
        runCurrent(); gate.complete(Unit); first.await()
        assertTrue(second.await().isFailure); assertEquals(1, transport.requests.size)
    }

    @Test fun boundsAndUnselectedContentAreEnforcedBeforeExternalEffect() = runTest {
        val journal = Journal(); val transport = Transport()
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertFails { repo.submit(ContentReportReason.Other, "x".repeat(1001), false, "") }
        assertFails { repo.submit(ContentReportReason.Other, "", true, "x".repeat(4001)) }
        assertFails { repo.submit(ContentReportReason.Other, "\u0000", false, "") }
        assertEquals(ContentReportError.Rejected, assertFailsWith<ContentReportException> {
            repo.submit(ContentReportReason.Other, "\u0001".repeat(1000), true, "\u0001".repeat(4000)) }.kind)
        assertTrue(transport.requests.isEmpty()); assertNull(journal.record)
    }

    @Test fun localAckWriteFailureRetainsOriginalIdentityAndCanRecoverWithOnlyGet() = runTest {
        val journal = Journal(); val transport = Transport()
        transport.answer = { journal.failWrite = true; response() }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        assertEquals(ContentReportError.Storage,
            assertFailsWith<ContentReportException> { repo.submit(ContentReportReason.Other, "", false, "") }.kind)
        assertNull(journal.record!!.receipt)
        journal.failWrite = false; transport.answer = { response() }
        repo.checkReceipt(true)
        assertEquals(listOf("POST", "GET"), transport.requests.map { it.method })
        assertEquals("received", journal.record!!.receipt!!.status)
    }

    @Test fun clearingPhoneCopyNeverCallsServerDeletion() = runTest {
        val journal = Journal(); val transport = Transport(); transport.answer = { response() }
        val repo = HttpContentReportsRepository(transport, journal, "0.0.1") { id }
        repo.submit(ContentReportReason.Other, "", false, "")
        repo.clearLocal(); assertNull(repo.saved()); assertEquals(1, transport.requests.size)
    }
}
