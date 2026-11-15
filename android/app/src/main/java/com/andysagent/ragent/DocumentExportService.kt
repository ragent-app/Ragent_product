package com.andysagent.ragent

import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.*
import android.system.Os
import android.system.OsConstants
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import java.security.MessageDigest
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Same UID, separate process. No RuntimeGraph, Room, PC access or persisted destination authority. */
class DocumentExportService : Service() {
    private class Attempt(val id: String, val callback: IDocumentExportCallback) {
        val parentDeath = IBinder.DeathRecipient { Process.killProcess(Process.myPid()) }
    }
    private val active = AtomicReference<Attempt?>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val watchdog = Handler(Looper.getMainLooper())
    private val binder = object : IDocumentExportWorker.Stub() {
        override fun start(attempt: String, ticket: String, source: ParcelFileDescriptor, destination: String,
            bytes: Long, sha256: String, deadlineElapsed: Long, callback: IDocumentExportCallback): Int {
            if (Binder.getCallingUid() != Process.myUid()) { source.close(); throw SecurityException("Internal document worker only") }
            val request = Attempt(attempt, callback)
            if (!active.compareAndSet(null, request)) {
                source.close(); callback.completed(attempt, ApiErrorCode.REVISION_CONFLICT.name, 0); return Process.myPid()
            }
            try { callback.asBinder().linkToDeath(request.parentDeath, 0) }
            catch (_: RemoteException) { source.close(); Process.killProcess(Process.myPid()); return Process.myPid() }
            val remaining = deadlineElapsed - SystemClock.elapsedRealtime()
            if (remaining !in 1..120_000) {
                source.close(); finish(request, ApiErrorCode.INVALID_ARGUMENT, 0); return Process.myPid()
            }
            val timeout = Runnable { if (active.get() === request) Process.killProcess(Process.myPid()) }
            watchdog.postDelayed(timeout, remaining)
            scope.launch {
                var error: ApiErrorCode? = null; var copied = 0L
                try {
                    require(attempt.length == 36 && sha256.matches(Regex("[a-f0-9]{64}")) && bytes in 0..RESULT_EXPORT_RESOURCE_BYTES)
                    val uri = Uri.parse(destination)
                    require(uri.scheme == "content" && !uri.authority.isNullOrEmpty() && uri.authority != "$packageName.result-files")
                    if (checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED)
                        throw SecurityException("Selected document grant is unavailable")
                    val stat = Os.fstat(source.fileDescriptor)
                    require(OsConstants.S_ISREG(stat.st_mode) && stat.st_size == bytes && isReadonlyDocumentSource(source))
                    DocumentWorkerLease(this@DocumentExportService).withLease(ticket,
                        { throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Document worker slot is busy")) }) {
                        ParcelFileDescriptor.AutoCloseInputStream(source).use { input ->
                            // Validate the transferred descriptor before any external truncate, then rewind.
                            val buffer = ByteArray(65_536); val initial = MessageDigest.getInstance("SHA-256"); var measured = 0L
                            while (true) {
                                ensureAuthorized(request, deadlineElapsed)
                                val count = input.read(buffer); if (count < 0) break
                                measured += count; require(measured <= bytes); initial.update(buffer, 0, count)
                            }
                            require(measured == bytes && digest(initial) == sha256)
                            input.channel.position(0); ensureAuthorized(request, deadlineElapsed)
                            val descriptor = contentResolver.openFileDescriptor(uri, "wt") ?: throw java.io.FileNotFoundException()
                            ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                                val hash = MessageDigest.getInstance("SHA-256")
                                while (true) {
                                    ensureAuthorized(request, deadlineElapsed)
                                    val count = input.read(buffer); if (count < 0) break
                                    copied += count; require(copied <= bytes); hash.update(buffer, 0, count)
                                    output.write(buffer, 0, count); ensureAuthorized(request, deadlineElapsed)
                                }
                                require(copied == bytes && digest(hash) == sha256)
                                output.flush()
                                // Some SAF providers return pipes. Only regular/proxy file sinks support fsync.
                                if (OsConstants.S_ISREG(Os.fstat(descriptor.fileDescriptor).st_mode)) descriptor.fileDescriptor.sync()
                                ensureAuthorized(request, deadlineElapsed)
                            }
                            ensureAuthorized(request, deadlineElapsed)
                        }
                    }
                } catch (failure: Exception) {
                    error = when (failure) {
                        is AppApiException -> failure.error.code
                        is SecurityException -> ApiErrorCode.PERMISSION_DENIED
                        is IllegalArgumentException -> ApiErrorCode.REVISION_CONFLICT
                        else -> ApiErrorCode.INTERNAL_ERROR
                    }
                } finally {
                    runCatching { source.close() }
                    watchdog.removeCallbacks(timeout)
                }
                finish(request, error, copied)
            }
            return Process.myPid()
        }
        override fun abort(attempt: String) {
            if (Binder.getCallingUid() != Process.myUid()) throw SecurityException("Internal document worker only")
            if (active.get()?.id == attempt) Process.killProcess(Process.myPid())
        }
    }
    private fun ensureAuthorized(request: Attempt, deadline: Long) {
        if (active.get() !== request || SystemClock.elapsedRealtime() >= deadline || !request.callback.authorize(request.id))
            throw SecurityException("Document copy authorization ended")
    }
    private fun digest(hash: MessageDigest) = hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun finish(request: Attempt, error: ApiErrorCode?, bytes: Long) {
        if (!active.compareAndSet(request, null)) return
        runCatching { request.callback.asBinder().unlinkToDeath(request.parentDeath, 0) }
        runCatching { request.callback.completed(request.id, error?.name.orEmpty(), bytes) }
    }
    override fun onBind(intent: Intent): IBinder = binder
    override fun onUnbind(intent: Intent): Boolean { Process.killProcess(Process.myPid()); return false }
    override fun onDestroy() { scope.cancel(); Process.killProcess(Process.myPid()); super.onDestroy() }
}

/** API 26–29 verify the kernel's own fdinfo; newer platforms expose fcntl publicly. */
internal fun isReadonlyDocumentSource(source: ParcelFileDescriptor, legacyProbe: Boolean = false): Boolean {
    val flags = if (Build.VERSION.SDK_INT >= 30 && !legacyProbe) Os.fcntlInt(source.fileDescriptor, OsConstants.F_GETFL, 0).toLong()
        else File("/proc/self/fdinfo/${source.fd}").bufferedReader().use { reader ->
            generateSequence(reader::readLine).take(32).firstOrNull { it.startsWith("flags:") }
                ?.substringAfter(':')?.trim()?.toLongOrNull(8) ?: throw SecurityException("Source descriptor flags unavailable")
        }
    return (flags and OsConstants.O_ACCMODE.toLong()) == OsConstants.O_RDONLY.toLong()
}
