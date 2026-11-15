package com.andysagent.ragent

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit

/** Serialize one target's joins while allowing another target to recover independently. */
internal class TargetRendezvousCoordinator(maximumInFlight: Int = 2) {
    private class Entry(val mutex: Mutex = Mutex(), var users: Int = 0)
    private val entries = mutableMapOf<String, Entry>()
    private val slots = Semaphore(maximumInFlight)

    suspend fun <T> withTarget(instanceId: String, action: suspend () -> T): T {
        require(instanceId.isNotBlank())
        val entry = synchronized(entries) {
            entries.getOrPut(instanceId) { Entry() }.also { it.users++ }
        }
        try {
            return entry.mutex.withLock { slots.withPermit { action() } }
        } finally {
            synchronized(entries) {
                entry.users--
                if (entry.users == 0 && entries[instanceId] === entry) entries.remove(instanceId)
            }
        }
    }
}
