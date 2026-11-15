package com.andysagent.ragent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.*
import android.system.Os
import android.system.OsConstants
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Bound, serialized worker requests. Cancellation terminates that worker, never the caller process. */
internal class DocumentExportClient(private val context: Context, private val timeoutMillis: Long = 120_000) {
    init { require(timeoutMillis in 1..120_000) }
    private val serial = Mutex()
    private fun requireDocumentGrant(document: Uri) {
        if (context.checkUriPermission(document, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED)
            throw SecurityException("Selected document grant is unavailable")
    }
    suspend fun copy(reference: ResultDeliveryRef, file: File, document: Uri, expectedDigest: String,
        reauthorize: suspend () -> Unit): ResultDeliveryRef = serial.withLock {
        withContext(Dispatchers.IO) {
            require(document.scheme == "content" && !document.authority.isNullOrEmpty() && document.authority != "${context.packageName}.result-files")
            requireDocumentGrant(document)
            reauthorize(); currentCoroutineContext().ensureActive()
            val closeOnExec = if (Build.VERSION.SDK_INT >= 27) OsConstants.O_CLOEXEC else 0
            val raw = Os.open(file.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or closeOnExec, 0)
            val source = try { ParcelFileDescriptor.dup(raw) } finally { Os.close(raw) }
            val attempt = UUID.randomUUID().toString()
            val accepting = AtomicBoolean(true)
            val connected = CompletableDeferred<IDocumentExportWorker>()
            val completed = CompletableDeferred<Pair<String, Long>>()
            val died = CompletableDeferred<Unit>()
            var remote: IDocumentExportWorker? = null
            var bound = false
            var monitor: Job? = null
            var workerPid: Int? = null
            val death = IBinder.DeathRecipient {
                died.complete(Unit)
                completed.completeExceptionally(AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "Document worker exited")))
            }
            val connection = object : ServiceConnection {
                override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                    try {
                        binder.linkToDeath(death, 0)
                        val worker = IDocumentExportWorker.Stub.asInterface(binder)
                        remote = worker; connected.complete(worker)
                    } catch (failure: Exception) { connected.completeExceptionally(failure) }
                }
                override fun onServiceDisconnected(name: ComponentName) { death.binderDied() }
                override fun onBindingDied(name: ComponentName) { death.binderDied(); connected.completeExceptionally(IllegalStateException("Worker binding ended")) }
                override fun onNullBinding(name: ComponentName) { connected.completeExceptionally(IllegalStateException("Worker binding unavailable")) }
            }
            val callback = object : IDocumentExportCallback.Stub() {
                override fun authorize(id: String): Boolean {
                    if (Binder.getCallingUid() != Process.myUid() || id != attempt || !accepting.get()) return false
                    return runBlocking(Dispatchers.IO) { runCatching { withTimeout(5_000) { requireDocumentGrant(document); reauthorize() } }.isSuccess && accepting.get() }
                }
                override fun completed(id: String, errorCode: String, bytes: Long) {
                    if (Binder.getCallingUid() == Process.myUid() && id == attempt && accepting.get()) completed.complete(errorCode to bytes)
                }
            }
            try {
                val reply = withTimeout(timeoutMillis) {
                    bound = context.bindService(Intent(context, DocumentExportService::class.java), connection, Context.BIND_AUTO_CREATE)
                    check(bound) { "Document worker binding unavailable" }
                    val worker = withTimeout(minOf(timeoutMillis, 10_000)) { connected.await() }
                    monitor = launch {
                        while (isActive && !completed.isCompleted) {
                            delay(250)
                            try { withTimeout(5_000) { requireDocumentGrant(document); reauthorize() } }
                            catch (_: TimeoutCancellationException) {
                                completed.completeExceptionally(AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "Document authorization check timed out")))
                                runCatching { worker.abort(attempt) }
                                break
                            }
                            catch (cancelled: CancellationException) { throw cancelled }
                            catch (failure: Exception) {
                                completed.completeExceptionally(failure)
                                runCatching { worker.abort(attempt) }
                                break
                            }
                        }
                    }
                    workerPid = worker.start(attempt, reference.id, source, document.toString(), reference.sizeBytes,
                        expectedDigest, SystemClock.elapsedRealtime() + timeoutMillis, callback)
                    check(workerPid!! > 0 && workerPid != Process.myPid()) { "Document worker process differs" }
                    completed.await()
                }
                if (reply.first.isNotEmpty()) {
                    val code = ApiErrorCode.entries.firstOrNull { it.name == reply.first } ?: ApiErrorCode.INTERNAL_ERROR
                    throw AppApiException(ApiError(code, "Document copy was interrupted"))
                }
                if (reply.second != reference.sizeBytes) throw AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "Document copy receipt differs"))
                requireDocumentGrant(document); reauthorize(); currentCoroutineContext().ensureActive()
                reference
            } finally {
                accepting.set(false)
                withContext(NonCancellable) {
                    monitor?.cancelAndJoin()
                    runCatching { remote?.abort(attempt) }
                    // Closing the last binding also terminates a worker whose start callback arrived late.
                    if (bound) withContext(Dispatchers.Main.immediate) { runCatching { context.unbindService(connection) } }
                    // Binder death alone precedes kernel teardown. A blocked FUSE task can retain its lease
                    // even with SIGKILL pending; the journal must then remain COPYING until recovery confirms exit.
                    if (remote != null) withTimeoutOrNull(5_000) {
                        while (true) {
                            val exited = workerPid?.let(::documentWorkerExited) ?: died.isCompleted
                            val unlocked = runCatching { DocumentWorkerLease(context).withLease(reference.id, { false }) { true } }.getOrDefault(false)
                            if (exited && unlocked) break
                            delay(25)
                        }
                    }
                    runCatching { remote?.asBinder()?.unlinkToDeath(death, 0) }
                    source.close()
                }
            }
        }
    }
}

/** A zombie group leader can coexist with a FUSE-blocked thread. Check the entire thread group. */
internal fun documentWorkerExited(pid: Int): Boolean {
    require(pid > 0)
    return try {
        Os.kill(pid, 0)
        runCatching {
            val tasks = File("/proc/$pid/task").listFiles() ?: return@runCatching false
            tasks.isNotEmpty() && tasks.all { File(it, "stat").readText().substringAfterLast(')').trimStart().startsWith("Z ") }
        }.getOrDefault(false)
    } catch (failure: android.system.ErrnoException) { failure.errno == OsConstants.ESRCH }
}
