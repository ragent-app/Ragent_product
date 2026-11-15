package com.andysagent.ragent

import com.andysagent.ragent.core.auth.PairingWriteGuard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Network work stays outside the shared local configuration lock. */
internal class TargetPairingCommits(private val mutex: Mutex) {
    private class Entry(val jobs: MutableSet<Job> = mutableSetOf())
    private class Operation(val job: Job) : AbstractCoroutineContextElement(Key) {
        companion object Key : CoroutineContext.Key<Operation>
    }
    suspend fun initiatingJob(): Job? = currentCoroutineContext()[Operation]?.job ?: currentCoroutineContext()[Job]

    private val entries = mutableMapOf<String, Entry>()
    private var closed = false
    private var switchingAccount = false

    suspend fun <T> withTarget(instanceId: String, action: suspend (PairingWriteGuard) -> T): T = coroutineScope {
        require(instanceId.isNotBlank())
        currentCoroutineContext().ensureActive()
        // Cancelling this child releases queued permits and network calls without
        // cancelling the UI/recovery scope that requested the connection.
        val operation = currentCoroutineContext()[Job]!!
        val entry = synchronized(entries) {
            if (closed || switchingAccount) throw CancellationException("Pairing runtime is closed or changing account")
            entries.getOrPut(instanceId) { Entry() }.also { it.jobs.add(operation) }
        }
        val guard = PairingWriteGuard { actualId, writes ->
            require(actualId == instanceId) { "Pairing response target differs" }
            mutex.withLock {
                currentCoroutineContext().ensureActive()
                if (!synchronized(entries) { entries[instanceId] === entry }) throw CancellationException("Computer pairing was removed")
                writes()
            }
        }
        try {
            val result = withContext(Operation(operation)) { action(guard) }
            guard.persist(instanceId) { }
            result
        } finally {
            synchronized(entries) {
                entry.jobs.remove(operation)
                if (entry.jobs.isEmpty() && entries[instanceId] === entry) entries.remove(instanceId)
            }
        }
    }

    fun hasPending(instanceId: String): Boolean = synchronized(entries) { entries[instanceId] != null }
    fun pendingTargetIds(): Set<String> = synchronized(entries) { entries.keys.toSet() }

    suspend fun remove(instanceId: String, cleanup: suspend () -> Unit) = mutex.withLock {
        // Dropping the entry fences active AND queued operations. A new
        // explicit pairing after cleanup gets a distinct generation.
        val obsolete = synchronized(entries) { entries.remove(instanceId)?.jobs?.toList().orEmpty() }
        obsolete.forEach { it.cancel(CancellationException("Computer pairing was removed")) }
        // Do not join under the configuration lock: a cancelling write may
        // still be unwinding from its guard. Its finally never takes this lock.
        cleanup()
    }

    /** Fence every old account's pending reply while atomically replacing local authority. */
    suspend fun <T> switchAccount(preserveCaller: Boolean = false, update: suspend () -> T): T {
        val initiator = currentCoroutineContext()[Operation]?.job
        val caller = if (preserveCaller) initiator else null
        return mutex.withLock {
        if (closed) throw CancellationException("Pairing runtime is closed")
        val obsolete = synchronized(entries) {
            switchingAccount = true
            val obsolete = entries.values.flatMap { it.jobs }.filter { it !== initiator }
            entries.entries.removeAll { (_, entry) -> caller == null || caller !in entry.jobs }
            entries.values.forEach { it.jobs.retainAll(listOfNotNull(caller)) }
            obsolete
        }
        obsolete.forEach { it.cancel(CancellationException("Account pairing generation changed")) }
        // Never join under this lock: a late platform callback may be waiting
        // for its final guard. New account writes use fresh entries afterward.
        try { update() }
        finally { synchronized(entries) { switchingAccount = false } }
        }
    }

    suspend fun close() = mutex.withLock {
        val obsolete = synchronized(entries) {
            closed = true
            entries.values.flatMap { it.jobs }.also { entries.clear() }
        }
        obsolete.forEach { it.cancel(CancellationException("Pairing runtime is closed")) }
    }
}
