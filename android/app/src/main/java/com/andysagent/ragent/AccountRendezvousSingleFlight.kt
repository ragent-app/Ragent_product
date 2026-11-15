package com.andysagent.ragent

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Share only an overlapping join; later attempts always obtain fresh authority. */
internal class AccountRendezvousSingleFlight<T> {
    private data class Key(val instanceId: String, val deviceName: String)
    private val active = mutableMapOf<Key, CompletableDeferred<T>>()

    suspend fun run(instanceId: String, deviceName: String, action: suspend () -> T): T {
        val key = Key(instanceId, deviceName)
        while (true) {
            var leader = false
            val result = synchronized(active) {
                active[key] ?: CompletableDeferred<T>().also { active[key] = it; leader = true }
            }
            if (!leader) {
                try { return result.await() }
                catch (cancelled: CancellationException) {
                    currentCoroutineContext().ensureActive()
                    continue
                }
            }
            try {
                val value = action()
                synchronized(active) { if (active[key] === result) active.remove(key) }
                result.complete(value)
                return value
            } catch (error: Throwable) {
                synchronized(active) { if (active[key] === result) active.remove(key) }
                result.completeExceptionally(error)
                throw error
            }
        }
    }
}
