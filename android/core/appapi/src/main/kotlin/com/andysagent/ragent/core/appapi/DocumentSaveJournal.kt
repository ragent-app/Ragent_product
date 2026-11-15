package com.andysagent.ragent.core.appapi

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

@Serializable enum class DocumentSaveState { WAITING_SELECTION, COPYING, SAVED, CANCELLED, INTERRUPTED }

/** Private metadata only. An external document URI and its write authority are never persisted. */
@Serializable data class DocumentSaveRecord(
    val ticketId: String, val operationId: String, val downloadId: String, val callerBinding: String,
    val name: String, val mimeType: String, val sizeBytes: Long, val sha256: String,
    val createdAt: Long, val expiresAt: Long, val updatedAt: Long = createdAt,
    val state: DocumentSaveState = DocumentSaveState.WAITING_SELECTION,
    val copyStarted: Boolean = false, val revision: Long = 0, val error: ApiErrorCode? = null, val version: Int = 1,
) {
    fun reference() = DocumentSaveRef(ticketId, name, sizeBytes, state, updatedAt, copyStarted, error)
}
data class DocumentSaveRef(val ticketId: String, val name: String, val sizeBytes: Long,
    val state: DocumentSaveState, val updatedAt: Long, val copyStarted: Boolean, val error: ApiErrorCode?)

/** Atomic phone journal and OS copy lease. Recovery never opens or rewrites an external document. */
class DocumentSaveJournal(context: Context, private val outputs: PersistentResultOutputs,
    private val deliveries: ResultDeliveryCache, private val now: () -> Long = System::currentTimeMillis,
    private val maximumRecords: Int = 256,
) {
    private val parent = context.noBackupFilesDir
    private val root = File(parent, "ragent-document-saves")
    private val workerLease = DocumentWorkerLease(context)
    private suspend fun <T> workerIdle(id: String, block: suspend () -> T) = workerLease.withLease(id,
        { apiFailure(ApiErrorCode.REVISION_CONFLICT, "External document worker is still active") }, block)
    private val idPattern = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    init { require(maximumRecords in 1..256) }
    private fun ensureRoot() {
        if (!(root.mkdirs() || Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS)) ||
            Files.isSymbolicLink(root.toPath()) || root.canonicalFile.parentFile != parent.canonicalFile)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save journal directory differs")
    }
    private fun path(id: String, suffix: String = "json"): File {
        if (!idPattern.matches(id)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid document-save ticket")
        return File(root, "$id.$suffix").also {
            if (Files.isSymbolicLink(it.toPath()) || it.canonicalFile.parentFile != root.canonicalFile)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save metadata path differs")
        }
    }
    private suspend fun <T> lock(name: String, busy: () -> T, block: suspend () -> T): T {
        ensureRoot()
        val file = File(root, "$name.lock")
        if (Files.isSymbolicLink(file.toPath())) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save lock differs")
        FileChannel.open(file.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                ?: return busy()
            lease.use { return block() }
        }
    }
    private suspend fun <T> ticketLock(id: String, block: suspend () -> T): T {
        path(id)
        return lock("copy-${(id.hashCode() and Int.MAX_VALUE) % 128}",
            { apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document save is active; retry explicitly") }, block)
    }
    private fun read(id: String): DocumentSaveRecord? {
        val file = path(id)
        if (!file.exists()) return null
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || file.length() !in 1..8192)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save metadata type or size differs")
        val row = runCatching { AppApiJson.decodeFromString<DocumentSaveRecord>(file.readText()) }
            .getOrElse { apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save metadata cannot be decoded") }
        if (row.version != 1 || row.ticketId != id || row.operationId.isBlank() || row.operationId.length > 64 ||
            row.downloadId.isBlank() || row.downloadId.length > 64 || row.callerBinding.isBlank() ||
            row.name.isBlank() || row.name.length > 512 || row.mimeType.isBlank() || row.mimeType.length > 256 ||
            row.sizeBytes !in 0..RESULT_EXPORT_RESOURCE_BYTES || !exportDigestPattern.matches(row.sha256) ||
            row.createdAt < 0 || row.updatedAt < row.createdAt || row.expiresAt <= row.createdAt ||
            row.expiresAt - row.createdAt > 3_600_000 || row.revision < 0 ||
            (row.state in setOf(DocumentSaveState.COPYING, DocumentSaveState.SAVED) && !row.copyStarted) ||
            (row.state in setOf(DocumentSaveState.WAITING_SELECTION, DocumentSaveState.CANCELLED) && row.copyStarted))
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save metadata identity differs")
        return row
    }
    private fun write(row: DocumentSaveRecord) {
        val bytes = AppApiJson.encodeToString(row).toByteArray()
        if (bytes.size > 8192) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Document-save metadata exceeds limits")
        FileOutputStream(path(row.ticketId, "json.tmp")).use { it.write(bytes); it.fd.sync() }
        Files.move(path(row.ticketId, "json.tmp").toPath(), path(row.ticketId).toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
    private fun records(): List<DocumentSaveRecord> = root.listFiles().orEmpty()
        .filter { it.name.endsWith(".json") && idPattern.matches(it.name.removeSuffix(".json")) }
        .mapNotNull { read(it.name.removeSuffix(".json")) }
    private suspend fun authorize(row: DocumentSaveRecord, caller: VerifiedCaller) {
        if (row.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Document save belongs to another caller")
        val source = outputs.get(row.downloadId, caller) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Saved source is unavailable")
        if (source.operationId != row.operationId || source.resource.originalName != row.name ||
            source.resource.mimeType != row.mimeType || source.resource.sizeBytes != row.sizeBytes || source.resource.sha256 != row.sha256)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save source identity differs")
    }
    private fun changed(row: DocumentSaveRecord, state: DocumentSaveState, error: ApiErrorCode? = null) =
        row.copy(state = state, updatedAt = maxOf(row.updatedAt, now()), revision = row.revision + 1,
            copyStarted = row.copyStarted || state == DocumentSaveState.COPYING, error = error)

    /** Called before creating the system selector effect, never after receiving an arbitrary URI. */
    suspend fun prepare(operationId: String, ticketId: String, caller: VerifiedCaller): DocumentSaveRef = withContext(Dispatchers.IO) {
        val source = deliveries.source(ticketId, caller)
        val ref = deliveries.withSharedFile(ticketId, caller) { reference, _ -> reference }
        if (source.operationId != operationId) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Ticket belongs to another operation")
        lock("index", { apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save journal is busy") }) {
            ticketLock(ticketId) {
                read(ticketId)?.let { existing ->
                    authorize(existing, caller)
                    if (existing.operationId != operationId || existing.state != DocumentSaveState.WAITING_SELECTION)
                        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document selection was already handled")
                    return@ticketLock existing.reference()
                }
                // Terminal metadata may expire, but source files and external documents are never removed.
                pruneFinished(now() - DOCUMENT_HISTORY_RETENTION_MS)
                if (records().size >= maximumRecords) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Document-save journal is full")
                val row = DocumentSaveRecord(ticketId, operationId, source.downloadId, caller.binding, ref.name,
                    ref.mimeType, ref.sizeBytes, source.resource.sha256!!, now(), ref.expiresAt)
                write(row); row.reference()
            }
        }
    }
    suspend fun cancelSelection(operationId: String, ticketId: String, caller: VerifiedCaller): Unit = withContext(Dispatchers.IO) {
        ticketLock(ticketId) {
            val row = read(ticketId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Document selection not found")
            authorize(row, caller)
            if (row.operationId != operationId) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Selection belongs to another operation")
            if (row.state == DocumentSaveState.CANCELLED) return@ticketLock
            if (row.state != DocumentSaveState.WAITING_SELECTION) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Selection was already handled")
            write(changed(row, DocumentSaveState.CANCELLED))
        }
    }
    /** The trusted Android adapter supplies one live result callback; no URI is retained by this journal. */
    suspend fun copy(operationId: String, ticketId: String, caller: VerifiedCaller,
        writer: suspend () -> ResultDeliveryRef): ResultDeliveryRef = withContext(Dispatchers.IO) {
        ticketLock(ticketId) {
            val row = read(ticketId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Document selection not found")
            authorize(row, caller)
            if (row.operationId != operationId) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Selection belongs to another operation")
            if (row.state != DocumentSaveState.WAITING_SELECTION) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document callback was already handled")
            deliveries.source(ticketId, caller)
            currentCoroutineContext().ensureActive()
            val writing = changed(row, DocumentSaveState.COPYING)
            workerIdle(ticketId) { write(writing) } // Durable before open("wt") can truncate the selected document.
            try {
                val receipt = writer()
                if (receipt.id != row.ticketId || receipt.name != row.name || receipt.mimeType != row.mimeType || receipt.sizeBytes != row.sizeBytes)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document copy receipt differs")
                deliveries.source(ticketId, caller); currentCoroutineContext().ensureActive()
                workerIdle(ticketId) { write(changed(writing, DocumentSaveState.SAVED)) }; receipt
            } catch (failure: Throwable) {
                val error = when (failure) {
                    is AppApiException -> failure.error.code
                    is CancellationException -> ApiErrorCode.CANCELLED
                    is SecurityException -> ApiErrorCode.PERMISSION_DENIED
                    else -> ApiErrorCode.INTERNAL_ERROR
                }
                withContext(NonCancellable) {
                    // A dead parent may have left a live worker. Do not claim interruption until its lease is free.
                    runCatching { workerIdle(ticketId) { write(changed(writing, DocumentSaveState.INTERRUPTED, error)) } }
                        .exceptionOrNull()?.let(failure::addSuppressed)
                }
                throw failure
            }
        }
    }
    suspend fun list(operationId: String, caller: VerifiedCaller, recover: Boolean = false): List<DocumentSaveRef> = withContext(Dispatchers.IO) {
        outputs.listForOperation(operationId, caller) // Includes operation read authorization, even for an empty list.
        ensureRoot()
        records().filter { it.operationId == operationId && it.callerBinding == caller.binding }.map { initial ->
            authorize(initial, caller)
            val row = if (!recover) initial else lock("copy-${(initial.ticketId.hashCode() and Int.MAX_VALUE) % 128}", { initial }) {
                val current = read(initial.ticketId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Document-save record disappeared")
                authorize(current, caller)
                workerLease.withLease(current.ticketId, { current }) { when {
                    current.state == DocumentSaveState.COPYING -> changed(current, DocumentSaveState.INTERRUPTED, ApiErrorCode.RESULT_UNKNOWN).also(::write)
                    current.state == DocumentSaveState.WAITING_SELECTION && now() >= current.expiresAt ->
                        changed(current, DocumentSaveState.INTERRUPTED, ApiErrorCode.REQUEST_EXPIRED).also(::write)
                    else -> current
                } }
            }
            row.reference()
        }.sortedByDescending { it.updatedAt }
    }
    /** Explicit local history removal; active selectors/copies and all actual documents are retained. */
    suspend fun clearFinished(operationId: String, caller: VerifiedCaller): Unit = withContext(Dispatchers.IO) {
        outputs.listForOperation(operationId, caller)
        ensureRoot()
        records().filter { it.operationId == operationId && it.callerBinding == caller.binding }.forEach { initial ->
            ticketLock(initial.ticketId) {
                val row = read(initial.ticketId) ?: return@ticketLock
                authorize(row, caller)
                if (row.state in terminalStates) workerIdle(row.ticketId) {
                    if (!path(row.ticketId).delete())
                        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save history could not be removed")
                }
            }
        }
    }

    private suspend fun pruneFinished(updatedBefore: Long, onDeferred: () -> Unit = {}): Int {
        var removed = 0
        for (initial in records()) {
            currentCoroutineContext().ensureActive()
            if (initial.state !in terminalStates || initial.updatedAt >= updatedBefore) continue
            lock("copy-${(initial.ticketId.hashCode() and Int.MAX_VALUE) % 128}", { onDeferred(); Unit }) {
                val row = read(initial.ticketId) ?: return@lock
                workerLease.withLease(row.ticketId, { onDeferred(); Unit }) { if (row.state in terminalStates && row.updatedAt < updatedBefore) {
                    if (!path(row.ticketId).delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save retention cleanup failed")
                    removed++
                } }
            }
        }
        return removed
    }

    /** Trusted local maintenance, independent of PC/caller availability. Never obtains write authority. */
    internal suspend fun maintain(temporaryBefore: Long): DocumentMaintenance = withContext(Dispatchers.IO) {
        lock("index", { apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save maintenance is busy") }) {
            var recovered = 0; var deferred = 0; var temporary = 0
            for (initial in records()) {
                currentCoroutineContext().ensureActive()
                if (initial.state != DocumentSaveState.COPYING &&
                    !(initial.state == DocumentSaveState.WAITING_SELECTION && now() >= initial.expiresAt)) continue
                lock("copy-${(initial.ticketId.hashCode() and Int.MAX_VALUE) % 128}", { deferred++; Unit }) {
                    val row = read(initial.ticketId) ?: return@lock
                    val error = when {
                        row.state == DocumentSaveState.COPYING -> ApiErrorCode.RESULT_UNKNOWN
                        row.state == DocumentSaveState.WAITING_SELECTION && now() >= row.expiresAt -> ApiErrorCode.REQUEST_EXPIRED
                        else -> return@lock
                    }
                    workerLease.withLease(row.ticketId, { deferred++; Unit }) {
                        write(changed(row, DocumentSaveState.INTERRUPTED, error)); recovered++
                    }
                }
            }
            val removed = pruneFinished(now() - DOCUMENT_HISTORY_RETENTION_MS) { deferred++ }
            for (candidate in root.listFiles().orEmpty()) {
                currentCoroutineContext().ensureActive()
                val id = candidate.name.removeSuffix(".json.tmp")
                if (!candidate.name.endsWith(".json.tmp") || !idPattern.matches(id) ||
                    !Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS) || candidate.lastModified() >= temporaryBefore) continue
                lock("copy-${(id.hashCode() and Int.MAX_VALUE) % 128}", { deferred++; Unit }) {
                    workerLease.withLease(id, { deferred++; Unit }) {
                    if (Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS) && candidate.lastModified() < temporaryBefore) {
                        // Decode any published record before removing its abandoned temporary companion.
                        read(id)
                        if (!path(id, "json.tmp").delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Document-save temporary cleanup failed")
                        temporary++
                    }
                    }
                }
            }
            DocumentMaintenance(recovered, removed, temporary, deferred)
        }
    }

    private val terminalStates = setOf(DocumentSaveState.SAVED, DocumentSaveState.CANCELLED, DocumentSaveState.INTERRUPTED)
}

internal const val DOCUMENT_HISTORY_RETENTION_MS = 30L * 24 * 60 * 60 * 1000
internal data class DocumentMaintenance(val recovered: Int, val removed: Int, val temporary: Int, val deferred: Int)
