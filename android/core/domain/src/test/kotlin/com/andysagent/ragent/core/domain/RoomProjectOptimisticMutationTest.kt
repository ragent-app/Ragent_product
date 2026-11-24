package com.andysagent.ragent.core.domain

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.database.ProjectEntity
import com.andysagent.ragent.core.database.RagentDatabase
import com.andysagent.ragent.core.database.SessionEntity
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.InvalidationHint
import com.andysagent.ragent.core.network.RagentTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class RoomProjectOptimisticMutationTest {

    @Test
    fun deleteProjectOptimisticallyRemovesRowsFencesPollsAndReconcilesInParallel() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val dao = database.dao()
        dao.upsertProjects(listOf(
            ProjectEntity("p1", "Alpha", "/work/alpha", 100L),
            ProjectEntity("p2", "Beta", "/work/beta", 100L),
        ))
        dao.upsertSessions(listOf(
            SessionEntity("s1", "Task 1", "p1", "idle", 2L, 100L),
            SessionEntity("s2", "Task 2", "p2", "idle", 1L, 100L),
        ))

        val deleteStarted = CompletableDeferred<Unit>()
        val deleteRelease = CompletableDeferred<Unit>()
        val projectsListJson = AtomicReference(
            """{"projects":[{"id":"p1","name":"Alpha","rootPath":"/work/alpha"},{"id":"p2","name":"Beta","rootPath":"/work/beta"}]}"""
        )
        val sessionsListJson = AtomicReference(
            """{"sessions":[{"id":"s1","title":"Task 1","projectId":"p1","status":"idle","latestSeq":2},{"id":"s2","title":"Task 2","projectId":"p2","status":"idle","latestSeq":1}]}"""
        )
        val reconcileGatesEnabled = AtomicReference(false)
        val projectsReconcileStarted = CompletableDeferred<Unit>()
        val sessionsReconcileStarted = CompletableDeferred<Unit>()
        val projectsReconcileRelease = CompletableDeferred<Unit>()
        val sessionsReconcileRelease = CompletableDeferred<Unit>()

        val transport = OptimisticMutationRecordingTransport { request ->
            when {
                request.method == "DELETE" && request.path == "/api/projects/p1" -> {
                    deleteStarted.complete(Unit)
                    deleteRelease.await()
                    ApiResponse(200, """{"ok":true,"sessionIds":["s1"]}""")
                }
                request.method == "GET" && request.path == "/api/projects" -> {
                    if (reconcileGatesEnabled.get()) {
                        projectsReconcileStarted.complete(Unit)
                        projectsReconcileRelease.await()
                    }
                    ApiResponse(200, projectsListJson.get())
                }
                request.method == "GET" && request.path.substringBefore('?') == "/api/sessions" -> {
                    if (reconcileGatesEnabled.get()) {
                        sessionsReconcileStarted.complete(Unit)
                        sessionsReconcileRelease.await()
                    }
                    ApiResponse(200, sessionsListJson.get())
                }
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
        }
        val repository = RoomSessionRepository(database, transport)
        try {
            val op = async(start = CoroutineStart.UNDISPATCHED) {
                repository.deleteProject("p1", deleteSessions = true)
            }
            withTimeout(5_000L) { deleteStarted.await() }

            val deleteReq = transport.requests.single { it.method == "DELETE" }
            assertEquals(10_000L, deleteReq.timeoutMs)
            assertNotNull(UUID.fromString(deleteReq.idempotencyKey))

            // Optimistically removed before the network call finishes.
            assertNull(dao.getProject("p1"))
            assertNull(dao.getSession("s1"))
            assertNotNull(dao.getProject("p2"))
            assertNotNull(dao.getSession("s2"))

            // Concurrent stale poll must NOT resurrect optimistically deleted project or session.
            repository.refreshProjects()
            repository.refreshSessions()
            assertNull(dao.getProject("p1"))
            assertNull(dao.getSession("s1"))

            // Update canonical server lists and verify post-delete reconciliation refreshes in parallel.
            projectsListJson.set("""{"projects":[{"id":"p2","name":"Beta","rootPath":"/work/beta"}]}""")
            sessionsListJson.set("""{"sessions":[{"id":"s2","title":"Task 2","projectId":"p2","status":"idle","latestSeq":1}]}""")
            reconcileGatesEnabled.set(true)
            deleteRelease.complete(Unit)

            withTimeout(5_000L) {
                projectsReconcileStarted.await()
                sessionsReconcileStarted.await()
            }
            projectsReconcileRelease.complete(Unit)
            sessionsReconcileRelease.complete(Unit)
            op.await()

            assertNull(dao.getProject("p1"))
            assertNull(dao.getSession("s1"))
            assertNotNull(dao.getProject("p2"))
            assertNotNull(dao.getSession("s2"))
        } finally {
            deleteRelease.complete(Unit)
            projectsReconcileRelease.complete(Unit)
            sessionsReconcileRelease.complete(Unit)
            repository.close()
            database.close()
        }
    }

    @Test
    fun deleteProjectRollsBackSnapshotOn409ConflictAndNetworkError() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val dao = database.dao()
        dao.upsertProjects(listOf(ProjectEntity("p1", "Alpha", "/work/alpha", 100L, pinned = true)))
        dao.upsertSessions(listOf(SessionEntity("s1", "Task 1", "p1", "idle", 2L, 100L)))

        val deleteStarted = CompletableDeferred<Unit>()
        val deleteRelease = CompletableDeferred<Unit>()
        val failureToThrow = AtomicReference<Throwable>(ApiException(409, "CONFLICT", "Project busy"))

        val transport = OptimisticMutationRecordingTransport { request ->
            when {
                request.method == "DELETE" && request.path == "/api/projects/p1" -> {
                    deleteStarted.complete(Unit)
                    deleteRelease.await()
                    throw failureToThrow.get()
                }
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
        }
        val repository = RoomSessionRepository(database, transport)
        try {
            // Case 1: deleteSessions = false detaches locally then restores projectId on 409.
            val detachFail = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { repository.deleteProject("p1", deleteSessions = false) }.exceptionOrNull()
            }
            withTimeout(5_000L) { deleteStarted.await() }
            assertNull(dao.getProject("p1"))
            assertNull(dao.getSession("s1")?.projectId)

            deleteRelease.complete(Unit)
            val err409 = detachFail.await() as SessionRepositoryException
            assertEquals(409, err409.statusCode)
            assertEquals("Alpha", dao.getProject("p1")?.name)
            assertTrue(dao.getProject("p1")?.pinned == true)
            assertEquals("p1", dao.getSession("s1")?.projectId)

            // Case 2: deleteSessions = true deletes locally then restores project + sessions on NETWORK_ERROR.
            failureToThrow.set(ApiException(0, "NETWORK_ERROR", "offline", retryable = true))
            val networkErr = runCatching {
                repository.deleteProject("p1", deleteSessions = true)
            }.exceptionOrNull() as SessionRepositoryException
            assertEquals("NETWORK_ERROR", networkErr.code)
            assertEquals("Alpha", dao.getProject("p1")?.name)
            assertEquals("p1", dao.getSession("s1")?.projectId)
        } finally {
            deleteRelease.complete(Unit)
            repository.close()
            database.close()
        }
    }

    @Test
    fun updateProjectAndSetProjectPinnedMutateOptimisticallyAndRollbackOnError() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val dao = database.dao()
        dao.upsertProjects(listOf(ProjectEntity("p1", "Before", "/old", 100L, pinned = false)))

        val failNext = AtomicReference<Throwable?>(ApiException(500, "SERVER_ERROR", "boom"))
        val inFlight = AtomicReference<CompletableDeferred<Unit>?>(null)
        val started = AtomicReference<CompletableDeferred<Unit>?>(null)

        val transport = OptimisticMutationRecordingTransport { request ->
            started.get()?.complete(Unit)
            inFlight.get()?.await()
            failNext.get()?.let { throw it }
            when {
                request.method == "PATCH" && request.path == "/api/projects/p1" && request.body?.contains("\"pinned\"") == true ->
                    ApiResponse(200, """{"ok":true}""")
                request.method == "PATCH" && request.path == "/api/projects/p1" ->
                    ApiResponse(200, """{"project":{"id":"p1","name":"After","rootPath":"/new","pinned":false}}""")
                request.method == "GET" && request.path == "/api/projects" ->
                    ApiResponse(200, """{"projects":[{"id":"p1","name":"After","rootPath":"/new","pinned":true}]}""")
                else -> error("Unexpected request: ${request.method} ${request.path}")
            }
        }
        val repository = RoomSessionRepository(database, transport)
        try {
            // Rollback on updateProject error, while verifying optimistic write mid-flight.
            val updateGate = CompletableDeferred<Unit>()
            val updateStarted = CompletableDeferred<Unit>()
            started.set(updateStarted)
            inFlight.set(updateGate)
            val failingUpdate = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { repository.updateProject("p1", name = "After", rootPath = "/new") }.exceptionOrNull()
            }
            withTimeout(5_000L) { updateStarted.await() }
            assertEquals("After", dao.getProject("p1")?.name)
            assertEquals("/new", dao.getProject("p1")?.folder)
            updateGate.complete(Unit)
            assertTrue(failingUpdate.await() is SessionRepositoryException)
            assertEquals("Before", dao.getProject("p1")?.name)
            assertEquals("/old", dao.getProject("p1")?.folder)

            // Success path for updateProject + idempotencyKey + timeoutMs = 10_000L.
            started.set(null); inFlight.set(null); failNext.set(null)
            val updated = repository.updateProject("p1", name = "After", rootPath = "/new")
            assertEquals("After", updated.name)
            assertEquals("After", dao.getProject("p1")?.name)

            // Rollback on setProjectPinned failure, then success.
            val pinGate = CompletableDeferred<Unit>()
            val pinStarted = CompletableDeferred<Unit>()
            started.set(pinStarted); inFlight.set(pinGate)
            failNext.set(ApiException(0, "NETWORK_ERROR", "offline"))
            val failingPin = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { repository.setProjectPinned("p1", true) }.exceptionOrNull()
            }
            withTimeout(5_000L) { pinStarted.await() }
            assertEquals(true, dao.getProject("p1")?.pinned)
            pinGate.complete(Unit)
            assertTrue(failingPin.await() is SessionRepositoryException)
            assertEquals(false, dao.getProject("p1")?.pinned)

            started.set(null); inFlight.set(null); failNext.set(null)
            repository.setProjectPinned("p1", true)
            assertEquals(true, dao.getProject("p1")?.pinned)

            val mutations = transport.requests.filter { it.method == "PATCH" }
            assertTrue(mutations.all { it.timeoutMs == 10_000L && !it.idempotencyKey.isNullOrBlank() })
            mutations.forEach { UUID.fromString(it.idempotencyKey) }
        } finally {
            inFlight.get()?.complete(Unit)
            repository.close()
            database.close()
        }
    }

    @Test
    fun sessionMutationsApplyOptimisticallyFencePollsAndRollbackOnError() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val database = Room.inMemoryDatabaseBuilder(context, RagentDatabase::class.java).allowMainThreadQueries().build()
        val dao = database.dao()
        dao.upsertSessions(listOf(SessionEntity("s1", "Old Title", null, "idle", 1L, 100L, pinned = false)))

        val failNext = AtomicReference<Throwable?>(null)
        val inFlight = AtomicReference<CompletableDeferred<Unit>?>(null)
        val started = AtomicReference<CompletableDeferred<Unit>?>(null)
        val serverSessionsJson = AtomicReference(
            """{"sessions":[{"id":"s1","title":"Old Title","projectId":null,"status":"idle","latestSeq":1,"pinned":false}]}"""
        )

        val transport = OptimisticMutationRecordingTransport { request ->
            if (request.method == "GET" && request.path.substringBefore('?') == "/api/sessions") {
                return@OptimisticMutationRecordingTransport ApiResponse(200, serverSessionsJson.get())
            }
            started.get()?.complete(Unit)
            inFlight.get()?.await()
            failNext.get()?.let { throw it }
            ApiResponse(200, """{"ok":true}""")
        }
        val repository = RoomSessionRepository(database, transport)
        try {
            // renameSession rollback + poll fence
            val renameGate = CompletableDeferred<Unit>()
            val renameStarted = CompletableDeferred<Unit>()
            started.set(renameStarted); inFlight.set(renameGate); failNext.set(ApiException(409, "CONFLICT", "conflict"))
            val renameOp = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { repository.renameSession("s1", "New Title") }.exceptionOrNull()
            }
            withTimeout(5_000L) { renameStarted.await() }
            assertEquals("New Title", dao.getSession("s1")?.title)
            repository.refreshSessions()
            assertEquals("New Title", dao.getSession("s1")?.title)
            renameGate.complete(Unit)
            assertEquals(409, (renameOp.await() as SessionRepositoryException).statusCode)
            assertEquals("Old Title", dao.getSession("s1")?.title)

            // setSessionPinned rollback
            started.set(null); inFlight.set(null); failNext.set(ApiException(500, "ERR", "err"))
            assertTrue(runCatching { repository.setSessionPinned("s1", true) }.exceptionOrNull() is SessionRepositoryException)
            assertEquals(false, dao.getSession("s1")?.pinned)

            // deleteSession optimistic removal, poll fence, and rollback on failure
            val delGate = CompletableDeferred<Unit>()
            val delStarted = CompletableDeferred<Unit>()
            started.set(delStarted); inFlight.set(delGate); failNext.set(ApiException(0, "NETWORK_ERROR", "offline"))
            val delFail = async(start = CoroutineStart.UNDISPATCHED) {
                runCatching { repository.deleteSession("s1") }.exceptionOrNull()
            }
            withTimeout(5_000L) { delStarted.await() }
            assertNull(dao.getSession("s1"))
            repository.refreshSessions()
            assertNull(dao.getSession("s1"))
            delGate.complete(Unit)
            assertTrue(delFail.await() is SessionRepositoryException)
            assertEquals("Old Title", dao.getSession("s1")?.title)

            // deleteSession success
            started.set(null); inFlight.set(null); failNext.set(null)
            serverSessionsJson.set("""{"sessions":[]}""")
            repository.deleteSession("s1")
            assertNull(dao.getSession("s1"))

            val mutReqs = transport.requests.filter { it.method == "PATCH" || it.method == "DELETE" }
            assertEquals(4, mutReqs.size)
            assertTrue(mutReqs.all { it.timeoutMs == 10_000L && !it.idempotencyKey.isNullOrBlank() })
            mutReqs.forEach { UUID.fromString(it.idempotencyKey) }
        } finally {
            inFlight.get()?.complete(Unit)
            repository.close()
            database.close()
        }
    }
}

private class OptimisticMutationRecordingTransport(
    private val handler: suspend (ApiRequest) -> ApiResponse,
) : RagentTransport {
    val requests = CopyOnWriteArrayList<ApiRequest>()
    override val connectionState = MutableStateFlow(RuntimeConnectionState.Connected)
    override val invalidations: Flow<InvalidationHint> = emptyFlow()

    override suspend fun execute(request: ApiRequest): ApiResponse {
        requests += request
        return handler(request)
    }

    override fun connectInvalidationSocket() = Unit
    override suspend fun close() = Unit
}
