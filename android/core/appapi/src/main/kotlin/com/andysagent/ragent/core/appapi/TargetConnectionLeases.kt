package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Start schedules authentication/bootstrap; it must not block waiting for a network. */
interface TargetConnectionResource {
    fun start()
    suspend fun stop()
}

/** One carrier owner per target, shared by foreground selections and finite API calls. */
class TargetConnectionLeases<T : TargetConnectionResource>(private val factory: suspend (String) -> T) {
    private class Entry<T>(val resource: T) {
        val owners = mutableSetOf<String>()
        var calls = 0
    }
    private val mutex = Mutex()
    private val entries = mutableMapOf<String, Entry<T>>()
    private val closing = mutableMapOf<String, CompletableDeferred<Unit>>()
    private class Stop<T>(val id: String, val entry: Entry<T>, val done: CompletableDeferred<Unit>)

    class Lease<T> internal constructor(val resource: T, private val release: suspend () -> Unit) {
        suspend fun close() = withContext(NonCancellable) { release() }
    }

    suspend fun acquire(instanceId: String): Lease<T> {
        require(instanceId.isNotBlank())
        while (true) {
            var wait: CompletableDeferred<Unit>? = null
            val lease = mutex.withLock {
                wait = closing[instanceId]
                if (wait != null) return@withLock null
                val entry = entry(instanceId)
                entry.calls++
                var closed = false
                Lease(entry.resource) {
                    val stop = mutex.withLock {
                        if (closed) return@withLock null
                        closed = true
                        if (entries[instanceId] !== entry) return@withLock null
                        entry.calls--
                        markUnused(instanceId, entry)
                    }
                    stop?.let { finishStop(it) }
                }
            }
            if (lease != null) return lease
            wait!!.await()
        }
    }

    suspend fun <R> withTarget(instanceId: String, block: suspend (T) -> R): R {
        val lease = acquire(instanceId)
        try { return block(lease.resource) } finally { lease.close() }
    }

    /** Replacing the UI owner set cannot close a connection held by an API call. */
    suspend fun setOwnerTargets(owner: String, targetIds: Set<String>) {
        require(owner.isNotBlank() && targetIds.none(String::isBlank))
        val frozen = targetIds.toSet()
        while (true) {
            var wait: CompletableDeferred<Unit>? = null
            var failure: Exception? = null
            val stops = mutex.withLock {
                wait = frozen.firstNotNullOfOrNull { closing[it] }
                if (wait != null) return@withLock emptyList()
                // Stage replacements before touching ownership, so a cancelled/failed
                // factory cannot leave a partially acquired UI set behind.
                val originalIds = entries.keys.toSet()
                try {
                    frozen.forEach { entry(it) }
                } catch (error: Exception) {
                    failure = error
                    return@withLock entries.toMap().filterKeys { it !in originalIds }
                        .mapNotNull { (id, entry) -> markUnused(id, entry) }
                }
                frozen.forEach { entries.getValue(it).owners += owner }
                entries.toMap().mapNotNull { (id, entry) ->
                    if (id !in frozen) entry.owners -= owner
                    markUnused(id, entry)
                }
            }
            if (wait != null) { wait!!.await(); continue }
            withContext(NonCancellable) {
                stops.forEach { stop ->
                    try { finishStop(stop) } catch (error: Exception) {
                        if (failure == null) failure = error else failure!!.addSuppressed(error)
                    }
                }
            }
            failure?.let { throw it }
            return
        }
    }

    /** Unpairing revokes all uses. An old lease cannot stop a newly paired generation. */
    suspend fun revoke(instanceId: String) {
        var wait: CompletableDeferred<Unit>? = null
        val stop = mutex.withLock {
            wait = closing[instanceId]
            entries[instanceId]?.let { markStop(instanceId, it) }
        }
        stop?.let { finishStop(it) }
        wait?.await()
    }

    private suspend fun entry(id: String): Entry<T> {
        entries[id]?.let { return it }
        val resource = factory(id)
        try { resource.start() } catch (failure: Exception) {
            withContext(NonCancellable) { runCatching { resource.stop() }.exceptionOrNull()?.let(failure::addSuppressed) }
            throw failure
        }
        return Entry(resource).also { entries[id] = it }
    }

    private fun markUnused(id: String, entry: Entry<T>): Stop<T>? =
        if (entry.calls == 0 && entry.owners.isEmpty()) markStop(id, entry) else null

    private fun markStop(id: String, entry: Entry<T>): Stop<T> {
        // Keep a per-target barrier until teardown completes; unrelated targets
        // may continue using the pool while the network release is in flight.
        check(entries[id] === entry && closing[id] == null)
        entries.remove(id)
        val done = CompletableDeferred<Unit>()
        closing[id] = done
        return Stop(id, entry, done)
    }

    private suspend fun finishStop(stop: Stop<T>) = withContext(NonCancellable) {
        try { stop.entry.resource.stop() } finally {
            mutex.withLock {
                if (closing[stop.id] === stop.done) closing.remove(stop.id)
                stop.done.complete(Unit)
            }
        }
    }
}
