package com.andysagent.ragent.core.appapi

import android.content.Context
import java.io.File
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardOpenOption

/** Independent worker-owned OS lease survives the requesting process. Never unlink its inode. */
class DocumentWorkerLease(context: Context) {
    private val parent = context.noBackupFilesDir
    private val root = File(parent, "ragent-document-saves")
    suspend fun <T> withLease(ticketId: String, busy: () -> T, block: suspend () -> T): T {
        if (!Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(ticketId))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid worker ticket")
        if (!(root.mkdirs() || Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS)) ||
            Files.isSymbolicLink(root.toPath()) || root.canonicalFile.parentFile != parent.canonicalFile)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Worker journal directory differs")
        val file = File(root, "worker-${(ticketId.hashCode() and Int.MAX_VALUE) % 128}.lock")
        if (Files.isSymbolicLink(file.toPath())) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Worker lease path differs")
        FileChannel.open(file.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null } ?: return busy()
            lease.use { return block() }
        }
    }
}
