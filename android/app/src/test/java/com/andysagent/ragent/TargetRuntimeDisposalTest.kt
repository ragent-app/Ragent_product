package com.andysagent.ragent

import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiResponse
import com.andysagent.ragent.core.network.BootstrapConnectionPlan
import com.andysagent.ragent.core.network.InvalidationHint
import java.lang.reflect.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.resume
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.selects.select
import org.junit.Assert.*
import org.junit.Test

/** Exercises the actual TargetRuntime; repository storage is an explicit boundary double. */
class TargetRuntimeDisposalTest {
    @Test fun disposalWaitsForTargetAndRepositoryBeforeClosingStorage() = runBlocking {
        supervisorScope {
            val fixture = Fixture()
            val disposal = async(Dispatchers.Default) { fixture.target.dispose() }
            try {
                withTimeout(5_000) { fixture.observerCancelling.await() }
                assertEquals(0, fixture.storageCloses.get())
                assertFalse(disposal.isCompleted)
                assertFalse(fixture.repositoryClosing.isCompleted)

                fixture.finishObserver.complete(Unit)
                withTimeout(5_000) {
                    select<Unit> {
                        fixture.repositoryClosing.onAwait { }
                        disposal.onAwait { fail("Disposal finished without closing its repository") }
                    }
                }
                assertEquals(0, fixture.storageCloses.get())
                assertFalse(disposal.isCompleted)

                fixture.finishRepository.complete(Unit)
                withTimeout(5_000) { disposal.await() }
                assertEquals(1, fixture.storageCloses.get())
                assertEquals(listOf("observer-cancelling", "observer-finished", "repository-closing",
                    "repository-finished", "storage-closed"), fixture.events.toList())
            } finally {
                fixture.release()
                withTimeout(5_000) { disposal.join(); fixture.shutdown() }
            }
        }
    }

    @Test fun cancellingTheDisposalCallerStillCompletesTheOrderedTeardown() = runBlocking {
        supervisorScope {
            val fixture = Fixture()
            val disposal = launch(Dispatchers.Default) { fixture.target.dispose() }
            try {
                withTimeout(5_000) { fixture.observerCancelling.await() }
                disposal.cancel()
                assertEquals(0, fixture.storageCloses.get())
                fixture.finishObserver.complete(Unit)
                withTimeout(5_000) {
                    select<Unit> {
                        fixture.repositoryClosing.onAwait { }
                        disposal.onJoin { fail("Cancelled disposal skipped repository termination") }
                    }
                }
                assertEquals(0, fixture.storageCloses.get())
                fixture.finishRepository.complete(Unit)
                withTimeout(5_000) { disposal.join() }
                assertEquals(1, fixture.storageCloses.get())
            } finally {
                fixture.release()
                withTimeout(5_000) { disposal.join(); fixture.shutdown() }
            }
        }
    }

    @Test fun aRepositoryTeardownFailureIsReportedBeforeStorageIsClosed() = runBlocking {
        supervisorScope {
            val fixture = Fixture(failRepository = true)
            val disposal = async(Dispatchers.Default) { fixture.target.dispose() }
            try {
                fixture.finishObserver.complete(Unit)
                val failure = runCatching { withTimeout(5_000) { disposal.await() } }.exceptionOrNull()
                assertTrue(failure is IllegalStateException)
                assertEquals("fixture repository termination failed", failure?.message)
                assertEquals(0, fixture.storageCloses.get())
            } finally {
                fixture.release()
                withTimeout(5_000) { disposal.join(); fixture.shutdown() }
            }
        }
    }

    private class Fixture(failRepository: Boolean = false) {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val observerCancelling = CompletableDeferred<Unit>()
        val finishObserver = CompletableDeferred<Unit>()
        val repositoryClosing = CompletableDeferred<Unit>()
        val finishRepository = CompletableDeferred<Unit>()
        val storageCloses = AtomicInteger()
        val events = CopyOnWriteArrayList<String>()

        // Using a proxy keeps this test compilable against the old interface,
        // which has no close() yet, so the old implementation can fail behaviorally.
        private val repository = Proxy.newProxyInstance(SessionRepository::class.java.classLoader,
            arrayOf(SessionRepository::class.java)) { proxy, method, args ->
            when (method.name) {
                "stopLiveSync" -> Unit
                "close" -> {
                    events += "repository-closing"
                    repositoryClosing.complete(Unit)
                    if (failRepository) throw IllegalStateException("fixture repository termination failed")
                    @Suppress("UNCHECKED_CAST")
                    val continuation = args!!.last() as Continuation<Unit>
                    finishRepository.invokeOnCompletion { error ->
                        if (error != null) continuation.resumeWith(Result.failure(error))
                        else {
                            events += "repository-finished"
                            continuation.resume(Unit)
                        }
                    }
                    COROUTINE_SUSPENDED
                }
                "toString" -> "FixtureRepository"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> error("Unexpected repository call: ${method.name}")
            }
        } as SessionRepository
        private val transport = object : RagentTransport {
            override val invalidations = emptyFlow<InvalidationHint>()
            override val connectionState = MutableStateFlow<RuntimeConnectionState>(RuntimeConnectionState.Disconnected)
            override suspend fun execute(request: ApiRequest): ApiResponse = error("No network in teardown test")
            override fun connectInvalidationSocket() = Unit
            override suspend fun close() = Unit
        }
        private val controller = object : TargetConnectionController {
            override fun start() = Unit
            override suspend fun stop() = Unit
            override fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan) = Unit
            override fun refresh() = Unit
        }
        val target = TargetRuntime("fixture-target", "", "", transport, repository, controller, scope) {
            events += "storage-closed"
            storageCloses.incrementAndGet()
        }

        init {
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() }
                finally {
                    withContext(NonCancellable) {
                        events += "observer-cancelling"
                        observerCancelling.complete(Unit)
                        finishObserver.await()
                        events += "observer-finished"
                    }
                }
            }
        }

        fun release() { finishObserver.complete(Unit); finishRepository.complete(Unit) }
        suspend fun shutdown() { scope.coroutineContext[Job]!!.cancelAndJoin() }
    }
}
