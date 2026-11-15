package com.andysagent.ragent.core.appapi

import java.io.File
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Serializes journal writers through receipt persistence, not just individual Room transactions. */
interface TaskExecutionLease {
    suspend fun <T> withLease(operationId: String, block: suspend () -> T): T
}

/** For isolated/in-memory coordinators. Android's durable journal uses [FileTaskExecutionLease]. */
class InProcessTaskExecutionLease : TaskExecutionLease {
    private val locks = Array(128) { Mutex() }
    override suspend fun <T> withLease(operationId: String, block: suspend () -> T): T =
        locks[taskLeaseSlot(operationId)].withLock { block() }
}

/**
 * Bounded private lock files are permanent: unlinking a held inode would admit a second executor.
 * A stripe collision can report busy for unrelated operations, but never permits concurrent writers.
 * All same-process instances share a guard before opening a channel: on some platforms closing any
 * channel for an inode can release locks obtained through another channel in that process.
 */
class FileTaskExecutionLease(private val root: File) : TaskExecutionLease {
    private val local = InProcessTaskExecutionLease()

    override suspend fun <T> withLease(operationId: String, block: suspend () -> T): T =
        local.withLease(operationId) {
            withContext(Dispatchers.IO) {
                currentCoroutineContext().ensureActive()
                val directory = root.absoluteFile
                if (!(directory.mkdirs() || Files.isDirectory(directory.toPath(), LinkOption.NOFOLLOW_LINKS)) ||
                    Files.isSymbolicLink(directory.toPath()))
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Task execution directory differs")
                val file = File(directory.canonicalFile, "operation-${taskLeaseSlot(operationId)}.lock")
                val key = file.absolutePath
                if (!synchronized(heldPaths) { heldPaths.add(key) }) busy()
                try {
                    if (Files.isSymbolicLink(file.toPath()))
                        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Task execution lease path differs")
                    FileChannel.open(file.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                        LinkOption.NOFOLLOW_LINKS).use { channel ->
                        val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                            ?: busy()
                        lease.use {
                            currentCoroutineContext().ensureActive()
                            block()
                        }
                    }
                } finally {
                    synchronized(heldPaths) { heldPaths.remove(key) }
                }
            }
        }

    private fun busy(): Nothing = throw AppApiException(ApiError(ApiErrorCode.RATE_LIMITED,
        "Another executor is using this task journal; retry the original operation", retryable = true))

    private companion object {
        val heldPaths = mutableSetOf<String>()
    }
}

internal fun taskLeaseSlot(operationId: String): Int = (operationId.hashCode() and Int.MAX_VALUE) % 128
