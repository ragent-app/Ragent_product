package com.andysagent.ragent.core.appapi

import android.content.Context
import android.net.Uri
import android.os.CancellationSignal
import android.provider.OpenableColumns
import androidx.room.withTransaction
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID

/** Private immutable copies, outside backup and every FileProvider export root. */
class PersistentCaptureResources(
    private val context: Context,
    private val database: AppApiDatabase,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : TaskResources {
    private val dao = database.resources()
    private val root = File(context.noBackupFilesDir, "ragent-capture-resources")
    private val locks = Array(64) { Mutex() }
    private fun lock(id: String) = locks[(id.hashCode() and Int.MAX_VALUE) % locks.size]
    private fun path(id: String, suffix: String): File {
        require(Regex("[A-Za-z0-9_-]{1,64}").matches(id))
        return File(root, "$id.$suffix").also { check(it.canonicalFile.parentFile == root.canonicalFile) }
    }

    suspend fun get(id: String, caller: VerifiedCaller): CaptureResource? = dao.get(id, caller.binding)?.decodeResource()

    /** Temporary URI permission is consumed here; the URI never becomes a durable handle. */
    suspend fun importContent(uri: Uri, caller: VerifiedCaller, resourceId: String? = null,
        maxBytes: Long = MAX_BYTES, onProgress: (CaptureImportProgress) -> Unit = {}): CaptureResource = withContext(Dispatchers.IO) {
        if (uri.scheme != "content" || uri.authority.isNullOrBlank()
            || context.packageManager.resolveContentProvider(uri.authority!!.substringAfterLast('@'), 0)?.packageName == context.packageName) {
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Only granted external content may be imported")
        }
        val signal = CancellationSignal()
        val cancellation = launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { signal.cancel() } }
        try {
            val resolver = context.contentResolver
            var name = "attachment"
            var size: Long? = null
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null, signal)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn)
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn).takeIf { it >= 0 }
                }
            }
            val mime = resolver.getType(uri) ?: "application/octet-stream"
            importStream(name, mime, size, caller, resourceId, maxBytes, onProgress) {
                resolver.openAssetFileDescriptor(uri, "r", signal)?.createInputStream()
                    ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Shared content could not be opened")
            }
        } catch (failure: SecurityException) {
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Shared content permission is unavailable")
        } finally { withContext(NonCancellable) { cancellation.cancelAndJoin() } }
    }

    /** Trusted in-app importer; adapters supply VerifiedCaller, never an Intent extra. */
    suspend fun importStream(originalName: String, mimeType: String, declaredSize: Long?, caller: VerifiedCaller,
        resourceId: String? = null, maxBytes: Long = MAX_BYTES,
        onProgress: (CaptureImportProgress) -> Unit = {},
        open: suspend () -> InputStream): CaptureResource = withContext(Dispatchers.IO) {
        val name = originalName.replace('\\', '/').substringAfterLast('/').trim().replace(Regex("\\s+"), " ")
            .take(255).ifBlank { "attachment" }
        val mime = mimeType.trim().lowercase(Locale.ROOT).ifBlank { "application/octet-stream" }
        if (name.any { it in "\u0000\r\n" } || mime.length > 256 || mime.any { it in "\u0000\r\n" }
            || maxBytes !in 1..MAX_BYTES || (declaredSize != null && declaredSize !in 1..maxBytes)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Resource metadata exceeds limits")
        val id = resourceId ?: newId()
        lock(id).withLock {
            val initial = CaptureResource(id, caller.binding, name, mime, now(), declaredSize)
            val temp = path(id, "tmp"); val complete = path(id, "bin")
            if (dao.insert(initial.entity()) == -1L) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Resource identity is already allocated")
            try {
                check(root.mkdirs() || root.isDirectory)
                val digest = MessageDigest.getInstance("SHA-256")
                var count = 0L
                var lastProgressAt = 0L
                fun report(phase: CaptureImportPhase, force: Boolean = false) {
                    val tick = System.nanoTime()
                    if (!force && tick - lastProgressAt < 100_000_000L) return
                    lastProgressAt = tick
                    // Rendering failures cannot invalidate a file copy; cancellation still propagates.
                    try { onProgress(CaptureImportProgress(id, name, count, declaredSize, phase)) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Observation is best-effort, storage remains authoritative. */ }
                }
                report(CaptureImportPhase.COPYING, force = true)
                open().use { input ->
                    val closeOnCancellation = launch(start = CoroutineStart.UNDISPATCHED) {
                        try { awaitCancellation() } finally { runCatching { input.close() } }
                    }
                    try {
                        FileOutputStream(temp).use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val read = input.read(buffer)
                                if (read < 0) break
                                if (read == 0) continue
                                count += read
                                if (count > maxBytes || (declaredSize != null && count > declaredSize)) {
                                    apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Resource body exceeds its size limit")
                                }
                                digest.update(buffer, 0, read); output.write(buffer, 0, read)
                                report(CaptureImportPhase.COPYING)
                            }
                            if (count < 1 || (declaredSize != null && count != declaredSize)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Resource body differs from its declared size")
                            report(CaptureImportPhase.SAVING, force = true)
                            output.flush(); output.fd.sync()
                        }
                    } finally { withContext(NonCancellable) { closeOnCancellation.cancelAndJoin() } }
                }
                currentCoroutineContext().ensureActive()
                Files.move(temp.toPath(), complete.toPath(), StandardCopyOption.ATOMIC_MOVE)
                val ready = initial.copy(state = CaptureResourceState.READY, revision = 1, sizeBytes = count, sha256 = hex(digest.digest()))
                withContext(NonCancellable) { replace(initial, ready) }
                ready
            } catch (failure: Exception) {
                val cancelled = failure is CancellationException || !currentCoroutineContext().isActive
                // A complete atomic copy survives a database acknowledgement loss.
                // A partial stream is never repaired into a ready resource.
                withContext(NonCancellable) {
                    temp.delete()
                    if (!complete.exists()) runCatching { replace(initial, initial.copy(state = CaptureResourceState.FAILED, revision = 1,
                        error = if (cancelled) ApiErrorCode.CANCELLED else (failure as? AppApiException)?.error?.code ?: ApiErrorCode.RESOURCE_NOT_FOUND)) }
                }
                if (cancelled && failure !is CancellationException) throw CancellationException("Resource import cancelled").apply { initCause(failure) }
                throw failure
            }
        }
    }

    /** Explicit repair of a completed copy; never reopens a revoked source URI. */
    suspend fun recover(id: String, caller: VerifiedCaller): CaptureResource? = withContext(Dispatchers.IO) {
        lock(id).withLock {
            val old = get(id, caller) ?: return@withLock null
            if (old.state != CaptureResourceState.IMPORTING) return@withLock old
            val complete = path(id, "bin")
            val next = if (complete.isFile) {
                val (size, digest) = digestFile(complete, null)
                if (old.declaredSize != null && size != old.declaredSize) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Recovered content differs from declared size")
                old.copy(state = CaptureResourceState.READY, revision = old.revision + 1, sizeBytes = size, sha256 = digest)
            } else old.copy(state = CaptureResourceState.FAILED, revision = old.revision + 1, error = ApiErrorCode.RESOURCE_NOT_FOUND)
            path(id, "tmp").delete()
            replace(old, next); next
        }
    }

    override suspend fun validate(refs: List<CaptureResourceRef>, caller: VerifiedCaller) {
        validateResourceRefs(refs)
        withContext(Dispatchers.IO) { refs.forEach { ref ->
            requireResourceMatch(get(ref.resourceId, caller), ref)
            digestFile(path(ref.resourceId, "bin"), ref)
        } }
    }

    override suspend fun read(ref: CaptureResourceRef, caller: VerifiedCaller): ByteArray = withContext(Dispatchers.IO) {
        validateResourceRefs(listOf(ref)); requireResourceMatch(get(ref.resourceId, caller), ref)
        val file = path(ref.resourceId, "bin")
        if (!file.isFile) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Private resource content is unavailable")
        val bytes = file.inputStream().use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var size = 0L
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer); if (count < 0) break
                size += count
                if (size > ref.sizeBytes) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Stored content size changed")
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        if (bytes.size.toLong() != ref.sizeBytes || hex(MessageDigest.getInstance("SHA-256").digest(bytes)) != ref.sha256) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Stored content differs from frozen metadata")
        }
        bytes
    }

    /** Tombstone first; a frozen draft/operation pin rejects deletion atomically. */
    suspend fun delete(id: String, caller: VerifiedCaller, expectedRevision: Long): Boolean = withContext(Dispatchers.IO) {
        lock(id).withLock {
            val deleted = database.withTransaction {
                val old = get(id, caller) ?: return@withTransaction false
                if (old.revision != expectedRevision || old.state == CaptureResourceState.IMPORTING || dao.references(id) != 0) return@withTransaction false
                if (old.state != CaptureResourceState.DELETED) replace(old, old.copy(state = CaptureResourceState.DELETED, revision = old.revision + 1))
                true
            }
            if (deleted) { path(id, "bin").delete(); path(id, "tmp").delete() }
            deleted
        }
    }

    private suspend fun digestFile(file: File, expected: CaptureResourceRef?): Pair<Long, String> {
        if (!file.isFile) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Private resource content is unavailable")
        val digest = MessageDigest.getInstance("SHA-256"); var size = 0L
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer); if (count < 0) break
                size += count
                if (size > MAX_BYTES || (expected != null && size > expected.sizeBytes)) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private resource exceeds its frozen size")
                digest.update(buffer, 0, count)
            }
        }
        val sha = hex(digest.digest())
        if (size < 1 || (expected != null && (size != expected.sizeBytes || sha != expected.sha256))) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Private resource integrity differs")
        return size to sha
    }
    private suspend fun replace(old: CaptureResource, next: CaptureResource) {
        val entity = next.entity()
        if (dao.replace(entity.resourceId, entity.callerBinding, entity.state, entity.revision, entity.payload, old.revision) != 1) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Resource changed concurrently")
        }
    }
    private fun CaptureResource.entity() = CaptureResourceEntity(resourceId, callerBinding, state.name, revision, AppApiJson.encodeToString(this))
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    companion object { const val MAX_BYTES = 25L * 1024 * 1024 }
}
