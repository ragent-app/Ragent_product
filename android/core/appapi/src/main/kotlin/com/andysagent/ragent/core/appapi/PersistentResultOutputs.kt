package com.andysagent.ragent.core.appapi

import android.content.Context
import androidx.room.withTransaction
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

/** Complete outputs and resumable checkpoints, outside backup and every exported provider root. */
class PersistentResultOutputs(
    private val context: Context, private val database: AppApiDatabase, private val coordinator: TaskCoordinator,
    private val now: () -> Long = System::currentTimeMillis,
    private val maximumBytes: Long = 256L * 1024 * 1024, private val maximumFiles: Int = 64,
) {
    private val dao = database.outputs()
    private val root = File(context.noBackupFilesDir, "ragent-result-outputs")
    init { require(maximumBytes in 0..256L * 1024 * 1024 && maximumFiles in 1..64) }

    private fun path(id: String, suffix: String): File {
        if (!Regex("[A-Za-z0-9_-]{1,64}").matches(id)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid download identity")
        return File(root, "$id.$suffix").also {
            if (it.canonicalFile.parentFile != root.canonicalFile || Files.isSymbolicLink(it.toPath()))
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output path differs")
        }
    }
    private fun ensureRoot() {
        if (!(root.mkdirs() || Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS)) ||
            Files.isSymbolicLink(root.toPath()) || root.canonicalFile.parentFile != context.noBackupFilesDir.canonicalFile)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output directory differs")
    }
    private suspend fun <T> withFileLock(id: String, block: suspend () -> T): T {
        path(id, "part") // Validate the requested identity even though locks use bounded slots.
        ensureRoot()
        val slot = (id.hashCode() and Int.MAX_VALUE) % 256
        FileChannel.open(path("writer-slot-$slot", "lock").toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output writer is busy; wait or stop it first")
            lease.use { return block() }
        }
    }
    private suspend fun owned(id: String, caller: VerifiedCaller): ResultOutput? {
        val record = dao.get(id)?.decodeOutput() ?: return null
        if (record.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Download belongs to another caller")
        coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
        return record
    }
    suspend fun get(id: String, caller: VerifiedCaller): ResultOutput? = owned(id, caller)
    suspend fun list(caller: VerifiedCaller): List<ResultOutput> = dao.list(caller.binding).map { row ->
        row.decodeOutput().also { coordinator.requireOutputAccess(it.operationId, caller, it.manifest) }
    }
    /** One owner page must not depend on authorization of unrelated operations. */
    suspend fun listForOperation(operationId: String, caller: VerifiedCaller): List<ResultOutput> {
        coordinator.get(operationId, caller)
        return dao.listForOperation(operationId, caller.binding).map { row ->
            row.decodeOutput().also { coordinator.requireOutputAccess(it.operationId, caller, it.manifest) }
        }
    }

    /** Explicit action only. Reuse downloadId to resume; a new ID is a new local download request. */
    suspend fun download(operationId: String, caller: VerifiedCaller, revision: String, resourceId: String,
        downloadId: String = UUID.randomUUID().toString()): ResultOutput = withContext(Dispatchers.IO) {
        withFileLock(downloadId) {
            var record = owned(downloadId, caller)
            if (record != null) {
                if (record.operationId != operationId || record.manifest.revision != revision || record.resourceId != resourceId)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Download identity was used for different output")
                if (record.state == ResultOutputState.DELETED) apiFailure(ApiErrorCode.CANCELLED, "Download was deleted; use a new download identity")
                record = recoverLocked(record, caller)
                if (record.state == ResultOutputState.READY) {
                    validateComplete(record)
                    coordinator.requireOutputAccess(operationId, caller, record.manifest)
                    currentCoroutineContext().ensureActive()
                    return@withFileLock record
                }
                if (record.state == ResultOutputState.FAILED) apiFailure(record.error ?: ApiErrorCode.RESULT_UNKNOWN, "Stored download is invalid; remove it or start a new identity")
            }
            val manifest = coordinator.savedResultExport(operationId, caller, revision)
            val resource = manifest.resources.firstOrNull { it.resourceId == resourceId && it.available }
                ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Result resource is unavailable")
            if (record == null) {
                val initial = ResultOutput(downloadId, operationId, caller.binding, manifest, resourceId, now(), now())
                database.withTransaction {
                    if (dao.liveCount() >= maximumFiles || dao.reservedBytes() + resource.sizeBytes!! > maximumBytes)
                        apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Private output budget is full; remove saved downloads first")
                    if (dao.insert(initial.entity()) == -1L) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Download identity collision")
                }
                record = initial
            } else {
                // TTL renewal is allowed only for the same exact immutable publication/resources.
                if (manifest.copy(expiresAt = record.manifest.expiresAt) != record.manifest)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Resumed output metadata differs")
                record = replace(record, record.copy(manifest = manifest, state = ResultOutputState.DOWNLOADING, error = null))
            }
            var current = record!!
            val temp = path(downloadId, "part")
            val hash = MessageDigest.getInstance("SHA-256")
            val prefix = prefix(current)
            feedExportPrefix(prefix, resource.sizeBytes!!, { coordinator.requireOutputAccess(operationId, caller, manifest, paired = true) }) { hash.update(it) }
            var written = current.receivedBytes
            var checkpoint = written
            try {
                RandomAccessFile(temp, "rw").use { output ->
                    output.setLength(written); output.seek(written)
                    suspend fun saveCheckpoint(state: ResultOutputState, error: ApiErrorCode? = null, verifiedAt: Long? = null) {
                        output.fd.sync()
                        val digest = runCatching { (hash.clone() as MessageDigest).digest().hex() }
                            .getOrElse { digestFile(temp, written).second }
                        current = replace(current, current.copy(state = state, receivedBytes = written, prefixSha256 = digest,
                            verifiedAt = verifiedAt, error = error))
                        checkpoint = written
                    }
                    try {
                        coordinator.streamResultExport(operationId, caller, revision, resourceId, prefix) { bytes ->
                            output.write(bytes); written += bytes.size; hash.update(bytes)
                            if (written - checkpoint >= CHECKPOINT_BYTES) saveCheckpoint(ResultOutputState.DOWNLOADING)
                        }
                        currentCoroutineContext().ensureActive()
                        output.fd.sync()
                        val actual = digestFile(temp, resource.sizeBytes!!)
                        if (actual.first != resource.sizeBytes || actual.second != resource.sha256)
                            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Stored output bytes differ from verified publication")
                        coordinator.requireOutputAccess(operationId, caller, manifest, paired = true)
                        saveCheckpoint(ResultOutputState.COMMITTING, verifiedAt = now())
                    } catch (failure: Exception) {
                        if (current.state == ResultOutputState.DOWNLOADING || current.state == ResultOutputState.PARTIAL) {
                            withContext(NonCancellable) {
                                val error = if (failure is CancellationException) ApiErrorCode.CANCELLED else
                                    (failure as? AppApiException)?.error?.code ?: ApiErrorCode.TARGET_OFFLINE
                                runCatching { saveCheckpoint(ResultOutputState.PARTIAL, error) }.exceptionOrNull()?.let(failure::addSuppressed)
                            }
                        }
                        throw failure
                    }
                }
                withContext(NonCancellable) { current = commitLocked(current, caller) }
                coordinator.requireOutputAccess(operationId, caller, manifest)
                currentCoroutineContext().ensureActive()
                current
            } catch (failure: Exception) {
                // A verified COMMITTING copy survives rename/Room acknowledgement loss.
                // Integrity failures before that marker cannot become READY on recovery.
                if (current.state !in setOf(ResultOutputState.COMMITTING, ResultOutputState.READY) && failure is AppApiException &&
                    failure.error.code in setOf(ApiErrorCode.RESULT_UNKNOWN, ApiErrorCode.REVISION_CONFLICT) && !failure.error.retryable) {
                    withContext(NonCancellable) {
                        runCatching { current = replace(current, current.copy(state = ResultOutputState.FAILED, error = failure.error.code)) }
                        temp.delete()
                    }
                }
                throw failure
            }
        }
    }

    /** Local repair only; never bootstraps a PC, fetches bytes or cancels a Run. */
    suspend fun recover(id: String, caller: VerifiedCaller): ResultOutput? = withContext(Dispatchers.IO) {
        withFileLock(id) { owned(id, caller)?.let { recoverLocked(it, caller) } }
    }

    private suspend fun recoverLocked(record: ResultOutput, caller: VerifiedCaller): ResultOutput {
        if (record.state == ResultOutputState.DELETED) {
            path(record.downloadId, "part").delete(); path(record.downloadId, "bin").delete(); return record
        }
        if (record.state in setOf(ResultOutputState.READY, ResultOutputState.COMMITTING)) {
            try {
                val recovered = if (record.state == ResultOutputState.COMMITTING) commitLocked(record, caller)
                    else record.also { validateComplete(it) }
                coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
                currentCoroutineContext().ensureActive()
                return recovered
            } catch (failure: AppApiException) {
                if (failure.error.code != ApiErrorCode.REVISION_CONFLICT) throw failure
                val failed = replace(record, record.copy(state = ResultOutputState.FAILED, error = failure.error.code))
                path(record.downloadId, "part").delete(); path(record.downloadId, "bin").delete()
                return failed
            }
        }
        if (record.state == ResultOutputState.FAILED) return record
        val part = path(record.downloadId, "part")
        try {
            if (!part.exists() && record.receivedBytes != 0L) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Checkpoint file is missing")
            if (part.exists()) {
                if (!Files.isRegularFile(part.toPath(), LinkOption.NOFOLLOW_LINKS) || part.length() < record.receivedBytes)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Checkpoint file ended early")
                // Bytes not acknowledged by Room after a crash are discarded, never appended blindly.
                RandomAccessFile(part, "rw").use { it.setLength(record.receivedBytes); it.fd.sync() }
            }
            feedExportPrefix(prefix(record), record.resource.sizeBytes!!,
                { coordinator.requireOutputAccess(record.operationId, caller, record.manifest) }) {}
            return replace(record, record.copy(state = ResultOutputState.PARTIAL, error = record.error ?: ApiErrorCode.RESULT_UNKNOWN))
        } catch (failure: AppApiException) {
            if (failure.error.code != ApiErrorCode.REVISION_CONFLICT) throw failure
            val failed = replace(record, record.copy(state = ResultOutputState.FAILED, error = failure.error.code))
            part.delete(); return failed
        }
    }

    private fun prefix(record: ResultOutput) = ResultExportPrefix(record.receivedBytes, record.prefixSha256) { consume ->
        if (record.receivedBytes > 0) readFile(path(record.downloadId, "part"), record.receivedBytes, consume)
    }

    private suspend fun commitLocked(record: ResultOutput, caller: VerifiedCaller): ResultOutput {
        if (record.state != ResultOutputState.COMMITTING || record.verifiedAt == null) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Output is not verified for commit")
        coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
        val complete = path(record.downloadId, "bin"); val part = path(record.downloadId, "part")
        val source = if (complete.exists()) complete else part
        val actual = digestFile(source, record.resource.sizeBytes!!)
        if (actual.first != record.resource.sizeBytes || actual.second != record.resource.sha256)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Verified output file differs")
        if (source == part) Files.move(part.toPath(), complete.toPath(), StandardCopyOption.ATOMIC_MOVE)
        val ready = replace(record, record.copy(state = ResultOutputState.READY, error = null))
        coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
        part.delete()
        return ready
    }

    private suspend fun validateComplete(record: ResultOutput) {
        if (record.state != ResultOutputState.READY || record.verifiedAt == null) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Output is not ready")
        val actual = digestFile(path(record.downloadId, "bin"), record.resource.sizeBytes!!)
        if (actual.first != record.resource.sizeBytes || actual.second != record.resource.sha256)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Saved output bytes changed")
    }

    /** A trusted share/SAF adapter uses a private destination until this call succeeds. */
    suspend fun copyReady(id: String, caller: VerifiedCaller, consume: suspend (ByteArray) -> Unit): ResultOutput = withContext(Dispatchers.IO) {
        withFileLock(id) {
            val record = owned(id, caller) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Download not found")
            validateComplete(record)
            val hash = MessageDigest.getInstance("SHA-256")
            readFile(path(id, "bin"), record.resource.sizeBytes!!) { bytes ->
                coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
                hash.update(bytes); consume(bytes)
                coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
                currentCoroutineContext().ensureActive()
            }
            if (hash.digest().hex() != record.resource.sha256) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Saved output changed during copy")
            coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
            currentCoroutineContext().ensureActive()
            record
        }
    }

    /** Tombstone before unlink; passive repair never resurrects deleted output. */
    suspend fun delete(id: String, caller: VerifiedCaller, expectedRevision: Long): Boolean = withContext(Dispatchers.IO) {
        withFileLock(id) {
            val record = owned(id, caller) ?: return@withFileLock false
            if (record.revision != expectedRevision) return@withFileLock false
            if (record.state != ResultOutputState.DELETED) replace(record, record.copy(state = ResultOutputState.DELETED, error = null))
            path(id, "part").delete(); path(id, "bin").delete()
            coordinator.requireOutputAccess(record.operationId, caller, record.manifest)
            true
        }
    }

    /** Explicit caller-scoped cleanup; completed user downloads are retained until deletion. */
    suspend fun cleanupPartials(caller: VerifiedCaller, updatedBefore: Long): Int {
        var removed = 0
        for (record in list(caller)) {
            if (record.state in setOf(ResultOutputState.PARTIAL, ResultOutputState.FAILED) && record.updatedAt < updatedBefore &&
                delete(record.downloadId, caller, record.revision)) removed++
        }
        return removed
    }

    /** App-internal maintenance only. Never unlinks lock inodes or files with a live journal reference. */
    internal suspend fun cleanupOrphans(updatedBefore: Long, onDeferred: () -> Unit = {}): Int = withContext(Dispatchers.IO) {
        ensureRoot()
        var removed = 0
        for (candidate in root.listFiles().orEmpty()) {
            currentCoroutineContext().ensureActive()
            val match = Regex("([A-Za-z0-9_-]{1,64})\\.(part|bin)").matchEntire(candidate.name) ?: continue
            if (!Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS) || candidate.lastModified() >= updatedBefore) continue
            val id = match.groupValues[1]
            try {
                withFileLock(id) {
                    val current = dao.get(id)?.decodeOutput()
                    // Allocation and writes take this same OS lock before committing a row.
                    if (current == null || current.state == ResultOutputState.DELETED) {
                        val exact = path(id, match.groupValues[2])
                        if (Files.isRegularFile(exact.toPath(), LinkOption.NOFOLLOW_LINKS) && exact.lastModified() < updatedBefore) {
                            if (!exact.delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Orphan output cleanup failed")
                            removed++
                        }
                    }
                }
            } catch (busy: AppApiException) {
                if (busy.error.code != ApiErrorCode.REVISION_CONFLICT) throw busy
                onDeferred()
            }
        }
        removed
    }

    private suspend fun replace(old: ResultOutput, next: ResultOutput): ResultOutput {
        val updated = next.copy(revision = old.revision + 1, updatedAt = now())
        if (dao.replace(old.downloadId, old.operationId, old.callerBinding, updated.state.name, updated.revision,
                updated.updatedAt, AppApiJson.encodeToString(updated), old.revision) != 1)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Output journal changed concurrently")
        return updated
    }

    private suspend fun digestFile(file: File, maximum: Long): Pair<Long, String> {
        val hash = MessageDigest.getInstance("SHA-256"); var size = 0L
        readFile(file, maximum) { size += it.size; hash.update(it) }
        return size to hash.digest().hex()
    }
    private suspend fun readFile(file: File, maximum: Long, consume: suspend (ByteArray) -> Unit) {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || file.length() != maximum)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output size or type differs")
        Files.newInputStream(file.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { input ->
            val buffer = ByteArray(RESULT_EXPORT_CHUNK_BYTES); var size = 0L
            while (true) {
                currentCoroutineContext().ensureActive()
                val read = input.read(buffer); if (read < 0) break
                size += read
                if (size > maximum) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output exceeds expected bytes")
                if (read > 0) consume(buffer.copyOf(read))
            }
            if (size != maximum) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private output ended early")
        }
    }
    companion object { private const val CHECKPOINT_BYTES = 1024 * 1024 }
}
