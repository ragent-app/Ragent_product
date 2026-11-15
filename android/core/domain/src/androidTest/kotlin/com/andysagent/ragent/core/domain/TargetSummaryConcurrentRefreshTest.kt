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
import com.andysagent.ragent.core.network.InvalidationHint
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

@RunWith(AndroidJUnit4::class)
class TargetSummaryConcurrentRefreshTest {
    @Test fun simultaneousRefreshesDoNotFetchTheSameEventPage() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), RagentDatabase::class.java).build()
        val transport = SummaryTransport()
        val repository = RoomSessionRepository(database, transport, targetId = "target-1")
        try {
            val first = async { repository.refreshTargetSummary() }
            withTimeout(5_000) { transport.firstEventRequest.await() }
            val second = async { repository.refreshTargetSummary() }
            try {
                assertNull("Second refresh fetched a stale event cursor while the first was in progress",
                    withTimeoutOrNull(500) { transport.secondEventRequest.await() })
            } finally { transport.releaseFirst.complete(Unit) }
            withTimeout(5_000) { first.await(); second.await() }
            assertEquals(listOf("0", "1"), transport.cursors.toList())
        } finally {
            transport.releaseFirst.complete(Unit)
            repository.close()
            database.close()
        }
    }
}

private class SummaryTransport : RagentTransport {
    override val connectionState: StateFlow<RuntimeConnectionState> = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = MutableSharedFlow()
    val firstEventRequest = CompletableDeferred<Unit>()
    val secondEventRequest = CompletableDeferred<Unit>()
    val releaseFirst = CompletableDeferred<Unit>()
    val cursors = Collections.synchronizedList(mutableListOf<String>())
    override suspend fun execute(request: ApiRequest): ApiResponse {
        if (request.path == "/api/runtime/summary") return ApiResponse(200,
            """{"targetId":"target-1","instanceId":"target-1","revision":1,"eventCursor":"1","generatedAt":"2026-10-29T00:00:00Z"}""")
        require(request.path.startsWith("/api/runtime/summary/events?"))
        val cursor = request.path.substringAfter("afterCursor=").substringBefore('&')
        cursors.add(cursor)
        if (cursors.size == 1) { firstEventRequest.complete(Unit); releaseFirst.await() }
        else secondEventRequest.complete(Unit)
        val events = if (cursor == "0") """[{"eventId":"event-1","targetId":"target-1","instanceId":"target-1","entityId":"item-1","revision":1,"emittedAt":"2026-10-29T00:00:00Z","cursor":1}]""" else "[]"
        return ApiResponse(200, """{"revision":1,"cursor":"1","events":$events}""")
    }
    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
