package com.andysagent.ragent.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.database.SessionEntity
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.launchIn
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Library-only instrumentation. It never opens the installed main App's data. */
@RunWith(AndroidJUnit4::class)
class RoomRepositoryTeardownTest {
    @Test fun terminalCloseWaitsForOwnedWorkAndEndsRealRoomObservers() = runBlocking {
        supervisorScope {
            val fixture = Fixture()
            val owner = repositoryScope(fixture.repository)
            val cancelling = CompletableDeferred<Unit>()
            val finish = CompletableDeferred<Unit>()
            val databaseReadFinished = CompletableDeferred<Unit>()
            var closing: Deferred<Unit>? = null
            try {
                fixture.startObservers()
                owner.launch(start = CoroutineStart.UNDISPATCHED) {
                    try { awaitCancellation() }
                    finally {
                        withContext(NonCancellable) {
                            cancelling.complete(Unit)
                            finish.await()
                            // Real SQLite is still usable during terminal unwind.
                            assertEquals("Retained task", fixture.database.dao().getSession("session-1")?.title)
                            databaseReadFinished.complete(Unit)
                        }
                    }
                }
                val activeClosing = async(Dispatchers.Default) {
                    fixture.repository.close()
                    assertTrue(owner.coroutineContext[Job]!!.isCompleted)
                    fixture.database.close()
                }
                closing = activeClosing
                withTimeout(10_000) { cancelling.await() }
                assertFalse(activeClosing.isCompleted)
                assertTrue(fixture.database.isOpen)
                finish.complete(Unit)
                withTimeout(10_000) { activeClosing.await(); databaseReadFinished.await() }
                assertFalse(fixture.database.isOpen)
                fixture.awaitObservers()
                assertTrue(fixture.failures.isEmpty())

                // Closing the repository must not delete the actual task rows.
                val reopened = Room.databaseBuilder(fixture.context, RagentDatabase::class.java, fixture.name).build()
                try { assertEquals("Retained task", reopened.dao().getSession("session-1")?.title) }
                finally { reopened.close() }
            } finally {
                finish.complete(Unit)
                withContext(NonCancellable) {
                    withTimeout(10_000) { closing?.join(); fixture.close() }
                }
            }
        }
    }

    @Test fun repeatedCloseAndReopenLeavesNoQueryJobsReadingClosedDatabases() = runBlocking {
        repeat(5) {
            val fixture = Fixture()
            try {
                fixture.startObservers()
                val owner = repositoryScope(fixture.repository).coroutineContext[Job]!!
                fixture.repository.close()
                fixture.repository.close()
                assertTrue(owner.isCompleted)
                fixture.database.close()
                fixture.awaitObservers()
                assertTrue(fixture.failures.isEmpty())
            } finally { withContext(NonCancellable) { withTimeout(10_000) { fixture.close() } } }
        }
    }

    private fun repositoryScope(repository: RoomSessionRepository): CoroutineScope =
        RoomSessionRepository::class.java.getDeclaredField("liveSyncScope").let {
            it.isAccessible = true
            it.get(repository) as CoroutineScope
        }

    private class Fixture {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "qa-room-teardown-${UUID.randomUUID()}.db"
        val database = Room.databaseBuilder(context, RagentDatabase::class.java, name).build()
        val failures = CopyOnWriteArrayList<Throwable>()
        private val observerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, error -> failures += error })
        private val observers = mutableListOf<Job>()
        private val transport = object : RagentTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
            override suspend fun execute(request: ApiRequest): ApiResponse = error("No network in Room teardown test")
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        val repository = RoomSessionRepository(database, transport, targetId = "room-fixture")

        suspend fun startObservers() {
            database.dao().upsertSessions(listOf(SessionEntity("session-1", "Retained task", null, "idle", 0, 0)))
            val initial = mutableListOf<CompletableDeferred<Unit>>()
            fun <T> observe(flow: Flow<T>) {
                val entered = CompletableDeferred<Unit>()
                initial += entered
                observers += flow.onEach { entered.complete(Unit) }.launchIn(observerScope)
            }
            observe(repository.observeComputers())
            observe(repository.observeProjects())
            observe(repository.observeSessions())
            observe(repository.observeSession("session-1"))
            observe(repository.observeMessages("session-1"))
            observe(repository.observePendingApprovals("session-1"))
            observe(repository.observeAllPendingApprovals())
            observe(repository.observeTargetSummary())
            withTimeout(10_000) { initial.forEach { it.await() } }
        }

        suspend fun awaitObservers() { withTimeout(10_000) { observers.joinAll() } }
        suspend fun close() {
            repository.close()
            observerScope.coroutineContext[Job]!!.cancelAndJoin()
            database.close()
            if (context.getDatabasePath(name).exists()) {
                check(context.deleteDatabase(name)) { "Could not delete owned Room fixture" }
            }
        }
    }
}
