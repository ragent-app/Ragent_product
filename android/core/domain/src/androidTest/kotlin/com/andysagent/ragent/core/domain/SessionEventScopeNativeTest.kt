package com.andysagent.ragent.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.database.SessionEntity
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionEventScopeNativeTest {
    @Test fun openingIdleConversationReadsSnapshotsWithoutLongPolling() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(context.packageName == "com.andysagent.ragent.core.domain.test")
        val db = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).build()
        val transport = EventScopeTransport(listOf("""{"sessionId":"a","events":[],"latestSeq":0}""", """{"sessionId":"a","events":[],"latestSeq":0}"""), polling = true)
        val repository = RoomSessionRepository(db, transport)
        try {
            db.dao().upsertSessions(listOf(SessionEntity("a", "A", null, "idle", 0, 0)))
            repository.refreshTimeline("a")
            assertEquals(2, transport.requests.size)
            assertTrue(transport.requests.none { "/events/wait" in it.path })
        } finally { repository.close(); db.close() }
    }
    @Test fun sessionLocalEventIdsCannotSuppressAnotherConversation() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(context.packageName == "com.andysagent.ragent.core.domain.test")
        val db = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).build()
        val repository = RoomSessionRepository(db, EventScopeTransport(listOf(page("a", "reply-a"), page("b", "reply-b"))))
        try {
            db.dao().upsertSessions(listOf(SessionEntity("a", "A", null, "idle", 0, 0), SessionEntity("b", "B", null, "idle", 0, 0)))
            assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("a"))
            assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("b"))
            assertEquals("reply-a", db.dao().getMessages("a").single().content)
            assertEquals("reply-b", db.dao().getMessages("b").single().content)
        } finally { repository.close(); db.close() }
    }

    @Test fun reusedEventIdWithinOneConversationStillRejectsChangedContent() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(context.packageName == "com.andysagent.ragent.core.domain.test")
        val db = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).build()
        val repository = RoomSessionRepository(db, EventScopeTransport(listOf(page("a", "original"), page("a", "changed"))))
        try {
            db.dao().upsertSessions(listOf(SessionEntity("a", "A", null, "idle", 0, 0)))
            assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("a"))
            assertTrue(repository.refreshEvents("a") is RefreshResult.Gap)
            assertEquals("original", db.dao().getMessages("a").single().content)
        } finally { repository.close(); db.close() }
    }

    @Test fun legacyUnscopedRowFromAnotherConversationDoesNotBlockRecovery() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(context.packageName == "com.andysagent.ragent.core.domain.test")
        val db = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).build()
        val repository = RoomSessionRepository(db, EventScopeTransport(listOf(page("b", "recovered"))))
        try {
            db.dao().upsertSessions(listOf(SessionEntity("b", "B", null, "idle", 0, 0)))
            db.dao().insertSessionEvent(com.andysagent.ragent.core.database.SessionEventEntity(
                "event:evt_000001", "a", 1, null, null, null, "message", "legacy-original", 0))
            assertEquals(RefreshResult.Applied(1, 1), repository.refreshEvents("b"))
            assertEquals("recovered", db.dao().getMessages("b").single().content)
            assertEquals("a", db.dao().getSessionEvent("event:evt_000001")?.sessionId)
            assertEquals("legacy-original", db.dao().getSessionEvent("event:evt_000001")?.fingerprint)
        } finally { repository.close(); db.close() }
    }

    @Test fun legacySameConversationConflictStillRejectsReplay() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        check(context.packageName == "com.andysagent.ragent.core.domain.test")
        val db = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).build()
        val repository = RoomSessionRepository(db, EventScopeTransport(listOf(page("a", "changed"))))
        try {
            db.dao().upsertSessions(listOf(SessionEntity("a", "A", null, "idle", 0, 0)))
            db.dao().insertSessionEvent(com.andysagent.ragent.core.database.SessionEventEntity(
                "event:evt_000001", "a", 1, null, null, null, "message", "legacy-original", 0))
            assertTrue(repository.refreshEvents("a") is RefreshResult.Gap)
            assertTrue(db.dao().getMessages("a").isEmpty())
        } finally { repository.close(); db.close() }
    }

    private fun page(session: String, text: String) = """{"sessionId":"$session","events":[{"seq":1,"id":"evt_000001","type":"message","role":"assistant","canonicalMessageId":"message-$session","content":"$text"}],"latestSeq":1}"""
}

private class EventScopeTransport(pages: List<String>, private val polling: Boolean = false) : RagentTransport {
    private val pending = ArrayDeque(pages)
    val requests = mutableListOf<ApiRequest>()
    override val requiresEventPolling get() = polling
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations = emptyFlow<InvalidationHint>()
    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return ApiResponse(200, pending.removeFirst())
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
