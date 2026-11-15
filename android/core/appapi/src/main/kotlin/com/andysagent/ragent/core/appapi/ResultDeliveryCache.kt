package com.andysagent.ragent.core.appapi

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.channels.OverlappingFileLockException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.security.MessageDigest
import java.util.UUID

@Serializable enum class ResultDeliveryState { PENDING, READY, REVOKED }

/** Private metadata; adapters expose only ResultDeliveryRef, never the caller/origin journal. */
@Serializable data class ResultDeliveryTicket(val id: String, val source: ResultOutput, val createdAt: Long,
    val expiresAt: Long, val state: ResultDeliveryState = ResultDeliveryState.PENDING, val version: Int = 1) {
    fun reference() = ResultDeliveryRef(id, source.resource.originalName, source.resource.mimeType,
        source.resource.sizeBytes!!, expiresAt)
}
data class ResultDeliveryRef(val id: String, val name: String, val mimeType: String, val sizeBytes: Long, val expiresAt: Long)

/** Independent verified share copies, with private durable metadata and bounded explicit maintenance. */
class ResultDeliveryCache(private val context: Context, private val outputs: PersistentResultOutputs,
    private val now: () -> Long = System::currentTimeMillis,
    private val maximumBytes: Long = 256L * 1024 * 1024, private val maximumFiles: Int = 64,
    private val lifetimeMillis: Long = 60L * 60 * 1000,
) {
    private val metadata = File(context.noBackupFilesDir, "ragent-result-deliveries")
    private val shared = File(context.cacheDir, "result-shares")
    private val idPattern = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
    init { require(maximumBytes in 0..256L * 1024 * 1024 && maximumFiles in 1..64 && lifetimeMillis in 1..3_600_000) }

    private fun ensureRoots() {
        for ((root, parent) in listOf(metadata to context.noBackupFilesDir, shared to context.cacheDir)) {
            if (!(root.mkdirs() || Files.isDirectory(root.toPath(), LinkOption.NOFOLLOW_LINKS)) ||
                Files.isSymbolicLink(root.toPath()) || root.canonicalFile.parentFile != parent.canonicalFile)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery directory differs")
        }
    }
    private fun requireId(id: String) {
        if (!idPattern.matches(id)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid delivery identity")
    }
    private fun privateFile(id: String, extension: String): File {
        requireId(id)
        return File(metadata, "$id.$extension").also {
            if (it.canonicalFile.parentFile != metadata.canonicalFile || Files.isSymbolicLink(it.toPath()))
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery metadata path differs")
        }
    }
    private fun file(ticket: ResultDeliveryTicket): File {
        requireId(ticket.id)
        val directory = File(shared, ticket.id)
        if (directory.canonicalFile.parentFile != shared.canonicalFile || Files.isSymbolicLink(directory.toPath()))
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery file directory differs")
        return File(directory, ticket.source.resource.originalName).also {
            if (it.canonicalFile.parentFile != directory.canonicalFile || Files.isSymbolicLink(it.toPath()))
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery file name differs")
        }
    }
    private suspend fun <T> lock(name: String, block: suspend () -> T): T {
        ensureRoots()
        val lockFile = File(metadata, "$name.lock")
        if (Files.isSymbolicLink(lockFile.toPath())) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery lock differs")
        FileChannel.open(lockFile.toPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS).use { channel ->
            val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery cache is busy; retry explicitly")
            lease.use { return block() }
        }
    }
    private suspend fun <T> ticketLock(id: String, block: suspend () -> T): T {
        requireId(id)
        return lock("ticket-${(id.hashCode() and Int.MAX_VALUE) % 256}", block)
    }
    private fun read(id: String): ResultDeliveryTicket? {
        val path = privateFile(id, "json")
        if (!path.exists()) return null
        if (!Files.isRegularFile(path.toPath(), LinkOption.NOFOLLOW_LINKS) || path.length() > 64 * 1024)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery metadata size or type differs")
        val ticket = runCatching { AppApiJson.decodeFromString<ResultDeliveryTicket>(path.readText()) }
            .getOrElse { apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery metadata cannot be decoded") }
        val size = ticket.source.resource.sizeBytes
        if (ticket.id != id || ticket.version != 1 || ticket.source.state != ResultOutputState.READY ||
            ticket.source.verifiedAt == null || ticket.expiresAt <= ticket.createdAt ||
            ticket.expiresAt - ticket.createdAt > 3_600_000 || size == null || size !in 0..RESULT_EXPORT_RESOURCE_BYTES ||
            ticket.source.receivedBytes != size || ticket.source.prefixSha256 != ticket.source.resource.sha256)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery metadata identity differs")
        return ticket
    }
    private fun write(ticket: ResultDeliveryTicket) {
        val temporary = privateFile(ticket.id, "json.tmp")
        val payload = AppApiJson.encodeToString(ticket).toByteArray()
        if (payload.size > 64 * 1024) apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Delivery metadata is too large")
        FileOutputStream(temporary).use { it.write(payload); it.fd.sync() }
        Files.move(temporary.toPath(), privateFile(ticket.id, "json").toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
    private fun records(): List<ResultDeliveryTicket> = metadata.listFiles().orEmpty()
        .filter { it.name.endsWith(".json") && idPattern.matches(it.name.removeSuffix(".json")) }
        .mapNotNull { read(it.name.removeSuffix(".json")) }

    private fun unlinkCopies(ticket: ResultDeliveryTicket) {
        for (path in listOf(privateFile(ticket.id, "part"), file(ticket))) {
            if (path.exists() && !path.delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery cleanup failed; retry maintenance")
        }
        val directory = file(ticket).parentFile!!
        if (directory.exists() && !directory.delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery directory cleanup failed")
    }

    private suspend fun authorize(ticket: ResultDeliveryTicket, caller: VerifiedCaller? = null): ResultOutput {
        if (caller != null && caller.binding != ticket.source.callerBinding)
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Delivery belongs to another caller")
        if (ticket.state != ResultDeliveryState.READY) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Delivery is unavailable")
        if (now() >= ticket.expiresAt) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Delivery has expired; share again explicitly")
        val source = outputs.get(ticket.source.downloadId, VerifiedCaller(ticket.source.callerBinding))
            ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Original saved result is unavailable")
        if (source.state != ResultOutputState.READY || source.operationId != ticket.source.operationId ||
            source.manifest != ticket.source.manifest || source.resourceId != ticket.source.resourceId || source.resource != ticket.source.resource)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Original saved result differs")
        return source
    }
    private suspend fun validateBytes(ticket: ResultDeliveryTicket) {
        val source = file(ticket)
        if (!Files.isRegularFile(source.toPath(), LinkOption.NOFOLLOW_LINKS) || source.length() != ticket.source.resource.sizeBytes)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared copy size or type differs")
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(source.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { input ->
            val buffer = ByteArray(65_536); var total = 0L
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer); if (count < 0) break
                total += count
                if (total > ticket.source.resource.sizeBytes!!) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared copy grew")
                digest.update(buffer, 0, count)
            }
            if (total != ticket.source.resource.sizeBytes || digest.digest().hex() != ticket.source.resource.sha256)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared copy digest differs")
        }
    }

    suspend fun stage(downloadId: String, caller: VerifiedCaller): ResultDeliveryRef = withContext(Dispatchers.IO) {
        val source = outputs.get(downloadId, caller) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Saved output not found")
        if (source.state != ResultOutputState.READY) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Saved output is not ready")
        val id = UUID.randomUUID().toString(); val timestamp = now()
        val ticket = ResultDeliveryTicket(id, source, timestamp, timestamp + lifetimeMillis)
        ticketLock(id) {
            var reserved = false
            val part = privateFile(id, "part")
            try {
                lock("allocation") {
                    // Failed cleanup retains both the tombstone and its quota reservation.
                    val live = records().filter { it.state != ResultDeliveryState.REVOKED ||
                        privateFile(it.id, "part").exists() || file(it).parentFile!!.exists() }
                    if (live.size >= maximumFiles || live.sumOf { it.source.resource.sizeBytes!! } + source.resource.sizeBytes!! > maximumBytes)
                        apiFailure(ApiErrorCode.RESOURCE_LIMIT, "Sharing cache is full; revoke or clean old copies")
                    if (privateFile(id, "json").exists()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery identity collision")
                    write(ticket); reserved = true
                }
                FileOutputStream(part).use { output ->
                    outputs.copyReady(downloadId, caller) { output.write(it) }
                    output.fd.sync()
                }
                val destination = file(ticket); destination.parentFile!!.mkdirs()
                Files.move(part.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE)
                val ready = ticket.copy(state = ResultDeliveryState.READY)
                validateBytes(ready); authorize(ready, caller)
                write(ready)
                authorize(ready, caller); currentCoroutineContext().ensureActive()
                ready.reference()
            } catch (failure: Exception) {
                withContext(NonCancellable) {
                    if (reserved) {
                        runCatching { write(ticket.copy(state = ResultDeliveryState.REVOKED)) }
                        runCatching { unlinkCopies(ticket) }
                    }
                    runCatching { privateFile(id, "json.tmp").delete() }
                }
                throw failure
            }
        }
    }

    /** Hold the ticket lock through descriptor opening; the adapter closes its descriptor on any failed recheck. */
    suspend fun <T> withSharedFile(id: String, caller: VerifiedCaller? = null,
        consume: suspend (ResultDeliveryRef, File) -> T): T = withSharedFileChecked(id, caller) { ref, file, _, _ -> consume(ref, file) }

    /** The trusted worker bridge reauthorizes while this same ticket lease remains held. */
    suspend fun <T> withSharedFileChecked(id: String, caller: VerifiedCaller? = null,
        consume: suspend (ResultDeliveryRef, File, String, suspend () -> Unit) -> T): T = withContext(Dispatchers.IO) {
        ticketLock(id) {
            val ticket = read(id) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Delivery not found")
            authorize(ticket, caller); validateBytes(ticket); authorize(ticket, caller)
            currentCoroutineContext().ensureActive()
            val result = consume(ticket.reference(), file(ticket), ticket.source.resource.sha256!!) { authorize(ticket, caller); currentCoroutineContext().ensureActive() }
            authorize(ticket, caller); currentCoroutineContext().ensureActive()
            result
        }
    }
    /** Trusted journal metadata lookup; never an exported URI or filesystem access. */
    suspend fun source(id: String, caller: VerifiedCaller): ResultOutput = withContext(Dispatchers.IO) {
        ticketLock(id) { authorize(read(id) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Delivery not found"), caller) }
    }
    /** Authorized streaming for a selected SAF document. Failure can leave partial external content. */
    suspend fun copy(id: String, caller: VerifiedCaller, sink: suspend (ByteArray) -> Unit): ResultDeliveryRef = withContext(Dispatchers.IO) {
        withSharedFile(id, caller) { reference, path ->
            val ticket = read(id) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Delivery disappeared")
            val digest = MessageDigest.getInstance("SHA-256"); var total = 0L
            Files.newInputStream(path.toPath(), StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS).use { input ->
                val buffer = ByteArray(65_536)
                while (true) {
                    currentCoroutineContext().ensureActive(); authorize(ticket, caller)
                    val count = input.read(buffer); if (count < 0) break
                    total += count
                    if (total > reference.sizeBytes) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared copy grew during delivery")
                    digest.update(buffer, 0, count)
                    sink(buffer.copyOf(count))
                    authorize(ticket, caller); currentCoroutineContext().ensureActive()
                }
            }
            if (total != reference.sizeBytes || digest.digest().hex() != ticket.source.resource.sha256)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared copy changed during delivery")
            reference
        }
    }
    suspend fun list(operationId: String, caller: VerifiedCaller): List<ResultDeliveryRef> = withContext(Dispatchers.IO) {
        ensureRoots()
        records().filter { it.source.callerBinding == caller.binding && it.source.operationId == operationId &&
            it.state == ResultDeliveryState.READY && now() < it.expiresAt }.mapNotNull { ticket ->
                val source = outputs.get(ticket.source.downloadId, caller) ?: return@mapNotNull null
                if (source.state == ResultOutputState.DELETED) return@mapNotNull null
                authorize(ticket, caller); ticket.reference()
            }
    }
    suspend fun revoke(id: String, caller: VerifiedCaller): ResultDeliveryRef? = withContext(Dispatchers.IO) {
        ticketLock(id) {
            val ticket = read(id) ?: return@ticketLock null
            if (ticket.source.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Delivery belongs to another caller")
            write(ticket.copy(state = ResultDeliveryState.REVOKED))
            unlinkCopies(ticket)
            ticket.reference()
        }
    }
    /** Explicit source deletion invalidates only this caller's copies of this exact private output. */
    suspend fun revokeForOutput(downloadId: String, caller: VerifiedCaller): List<ResultDeliveryRef> = withContext(Dispatchers.IO) {
        ensureRoots()
        records().filter { it.source.callerBinding == caller.binding && it.source.downloadId == downloadId }
            .mapNotNull { revoke(it.id, caller) }
    }
    /** Internal expiry cleanup; pending copies after process death cannot become readable. */
    suspend fun cleanupExpired(revokeGrant: suspend (ResultDeliveryRef) -> Unit = {},
        onDeferred: () -> Unit = {}): List<ResultDeliveryRef> = withContext(Dispatchers.IO) {
        lock("allocation") {
            val removed = mutableListOf<ResultDeliveryRef>()
            for (ticket in records().filter { it.state == ResultDeliveryState.REVOKED || now() >= it.expiresAt }) {
                currentCoroutineContext().ensureActive()
                try {
                    ticketLock(ticket.id) {
                        val current = read(ticket.id) ?: return@ticketLock
                        if (current.state != ResultDeliveryState.REVOKED && now() < current.expiresAt) return@ticketLock
                        write(current.copy(state = ResultDeliveryState.REVOKED))
                        // Keep the durable tombstone until the Android adapter acknowledges revocation.
                        // A lost callback or failed unlink can then be retried without publishing this ticket.
                        revokeGrant(current.reference())
                        unlinkCopies(current)
                        for (path in listOf(privateFile(current.id, "json.tmp"), privateFile(current.id, "json"))) {
                            if (path.exists() && !path.delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Delivery metadata cleanup failed")
                        }
                        removed += current.reference()
                    }
                } catch (busy: AppApiException) {
                    if (busy.error.code != ApiErrorCode.REVISION_CONFLICT) throw busy
                    onDeferred()
                }
            }
            removed
        }
    }

    /** Only unpublished, old regular temporary metadata; no recursive directory or lock deletion. */
    internal suspend fun cleanupUnpublished(updatedBefore: Long, onDeferred: () -> Unit = {}): Int = withContext(Dispatchers.IO) {
        lock("allocation") {
            var removed = 0
            for (candidate in metadata.listFiles().orEmpty()) {
                currentCoroutineContext().ensureActive()
                val suffix = when {
                    candidate.name.endsWith(".json.tmp") -> "json.tmp"
                    candidate.name.endsWith(".part") -> "part"
                    else -> continue
                }
                val id = candidate.name.removeSuffix(".$suffix")
                if (!idPattern.matches(id) || !Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS) ||
                    candidate.lastModified() >= updatedBefore) continue
                try {
                    ticketLock(id) {
                        if (read(id) == null && Files.isRegularFile(candidate.toPath(), LinkOption.NOFOLLOW_LINKS) &&
                            candidate.lastModified() < updatedBefore) {
                            if (!privateFile(id, suffix).delete()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Temporary delivery cleanup failed")
                            removed++
                        }
                    }
                } catch (busy: AppApiException) {
                    if (busy.error.code != ApiErrorCode.REVISION_CONFLICT) throw busy
                    onDeferred()
                }
            }
            removed
        }
    }
}
