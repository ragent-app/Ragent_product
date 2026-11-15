package com.andysagent.ragent

import com.andysagent.ragent.core.domain.SessionRepository
import java.lang.reflect.Proxy
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.resume
import kotlinx.coroutines.*
import kotlinx.coroutines.selects.select
import org.junit.Assert.*
import org.junit.Test

class SessionStorageLifetimeTest {
    @Test fun storageRemainsOpenUntilRepositoryObserversExit() = runBlocking {
        supervisorScope {
            val fixture = Fixture()
            val closing = async(Dispatchers.Default) { fixture.lifetime.close() }
            try {
                fixture.awaitClosing(closing)
                assertEquals(0, fixture.storageCloses.get())
                fixture.finish.complete(Unit)
                withTimeout(5_000) { closing.await() }
                assertEquals(listOf("stop", "transport", "repository", "repository-finished", "storage"), fixture.events.toList())
            } finally { fixture.finish.complete(Unit); withTimeout(5_000) { closing.join() } }
        }
    }

    @Test fun callerCancellationCannotLeaveObserversUsingClosedStorage() = runBlocking {
        val fixture = Fixture()
        val closing = launch(Dispatchers.Default) { fixture.lifetime.close() }
        try {
            withTimeout(5_000) {
                select<Unit> {
                    fixture.started.onAwait { }
                    closing.onJoin { fail("Close skipped repository observers") }
                }
            }
            closing.cancel()
            assertEquals(0, fixture.storageCloses.get())
            fixture.finish.complete(Unit)
            withTimeout(5_000) { closing.join() }
            assertEquals(1, fixture.storageCloses.get())
        } finally { fixture.finish.complete(Unit); withTimeout(5_000) { closing.join() } }
    }

    @Test fun concurrentExpiryAndGraphCloseDisposeTheSameStorageOnce() = runBlocking {
        supervisorScope {
            val fixture = Fixture()
            val first = async(Dispatchers.Default) { fixture.lifetime.close() }
            try {
                fixture.awaitClosing(first)
                val second = async(Dispatchers.Default) { fixture.lifetime.close() }
                fixture.finish.complete(Unit)
                withTimeout(5_000) { first.await(); second.await(); fixture.lifetime.close() }
                assertEquals(1, fixture.storageCloses.get())
                assertEquals(1, fixture.transportCloses.get())
                assertEquals(1, fixture.events.count { it == "repository" })
            } finally { fixture.finish.complete(Unit); withTimeout(5_000) { first.join() } }
        }
    }

    @Test fun lateOldWorkbenchCloseCannotDisposeItsReplacement() = runBlocking {
        val old = Fixture()
        val replacement = Fixture()
        old.finish.complete(Unit)
        old.lifetime.close()
        old.lifetime.close()
        assertEquals(1, old.storageCloses.get())
        assertEquals(0, replacement.storageCloses.get())
        assertEquals(0, replacement.transportCloses.get())
        replacement.finish.complete(Unit)
        replacement.lifetime.close()
        assertEquals(1, replacement.storageCloses.get())
    }

    @Test fun transportFailureStillDrainsRepositoryBeforeClosingStorage() = runBlocking {
        val fixture = Fixture(transportFailure = true)
        fixture.finish.complete(Unit)
        val error = runCatching { fixture.lifetime.close() }.exceptionOrNull()
        assertEquals("transport failure", error?.message)
        assertEquals(listOf("stop", "transport", "repository", "repository-finished", "storage"), fixture.events.toList())
        assertEquals(1, fixture.storageCloses.get())
    }

    @Test fun repositoryFailureLeavesStorageOpenAndReportsFailure() = runBlocking {
        val fixture = Fixture(repositoryFailure = true)
        val error = runCatching { fixture.lifetime.close() }.exceptionOrNull()
        assertEquals("repository failure", error?.message)
        assertEquals(0, fixture.storageCloses.get())
    }

    private class Fixture(transportFailure: Boolean = false, repositoryFailure: Boolean = false) {
        val started = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val events = CopyOnWriteArrayList<String>()
        val storageCloses = AtomicInteger()
        val transportCloses = AtomicInteger()
        private val repository = Proxy.newProxyInstance(SessionRepository::class.java.classLoader,
            arrayOf(SessionRepository::class.java)) { proxy, method, args ->
            when (method.name) {
                "stopLiveSync" -> { events += "stop"; Unit }
                "close" -> {
                    events += "repository"
                    started.complete(Unit)
                    if (repositoryFailure) throw IllegalStateException("repository failure")
                    @Suppress("UNCHECKED_CAST")
                    val continuation = args!!.last() as Continuation<Unit>
                    finish.invokeOnCompletion {
                        events += "repository-finished"
                        continuation.resume(Unit)
                    }
                    COROUTINE_SUSPENDED
                }
                "toString" -> "LifecycleRepository"
                "hashCode" -> System.identityHashCode(proxy)
                "equals" -> proxy === args?.firstOrNull()
                else -> error("Unexpected repository call: ${method.name}")
            }
        } as SessionRepository
        val lifetime = SessionStorageLifetime(repository, {
            events += "transport"; transportCloses.incrementAndGet()
            if (transportFailure) throw IllegalStateException("transport failure")
        }, { events += "storage"; storageCloses.incrementAndGet() })

        suspend fun awaitClosing(closing: Deferred<Unit>) = withTimeout(5_000) {
            select<Unit> {
                started.onAwait { }
                closing.onAwait { fail("Close skipped repository observers") }
            }
        }
    }
}
