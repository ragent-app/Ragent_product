package com.andysagent.ragent

import com.andysagent.ragent.core.domain.SessionRepository
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Owns one repository, carrier and database, independently of the selected target. */
internal class SessionStorageLifetime(
    private val sessions: SessionRepository,
    private val closeTransport: suspend () -> Unit,
    private val closeStorage: () -> Unit,
) {
    private val closeMutex = Mutex()
    private var closed = false

    suspend fun close() = withContext(NonCancellable) {
        closeMutex.withLock {
            if (closed) return@withLock
            try {
                sessions.stopLiveSync()
                closeTransport()
            } finally {
                // DAO collectors own work independently of live invalidation sync.
                // Never close their database until their cancellation has finished.
                sessions.close()
                closeStorage()
                closed = true
            }
        }
    }
}
