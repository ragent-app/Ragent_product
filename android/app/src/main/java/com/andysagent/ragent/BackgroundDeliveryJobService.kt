package com.andysagent.ragent

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.app.Service
import android.content.pm.ServiceInfo
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PersistableBundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.app.ServiceCompat
import com.andysagent.ragent.core.appapi.AppApiException
import com.andysagent.ragent.core.appapi.BackgroundDeliveryConsent
import com.andysagent.ragent.core.appapi.TaskUploadPhase
import com.andysagent.ragent.core.appapi.TaskUploadProgress
import com.andysagent.ragent.feature.appapi.R
import kotlinx.coroutines.*

/** Durable consent is the source of truth; a pending JobScheduler entry is only a wake-up hint. */
internal object BackgroundDeliveryJobs {
    const val CONSENT_EXTRA = "ragent.backgroundDelivery.consentId"
    const val DRAFT_EXTRA = "ragent.backgroundDelivery.draftId"
    const val STOP_ACTION = "com.agentoncloud.android.action.STOP_BACKGROUND_DELIVERY"
    private const val CHANNEL_ID = "ragent.backgroundDelivery"
    private const val PREFS = "ragent_background_delivery_jobs"
    private val foregroundStartAcks = java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<Boolean>>()

    fun notificationsAvailable(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    suspend fun schedule(context: Context, consentId: String, draftId: String? = null): Boolean {
        val safeDraftId = draftId?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) }
        if (Build.VERSION.SDK_INT < 34) {
            val started = CompletableDeferred<Boolean>()
            val inFlight = foregroundStartAcks.putIfAbsent(consentId, started)
            if (inFlight != null) return try {
                withTimeout(3_500L) { inFlight.await() }
            } catch (_: TimeoutCancellationException) {
                false
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) { false }
            return try {
                ContextCompat.startForegroundService(context, Intent(context, BackgroundDeliveryForegroundService::class.java)
                    .putExtra(CONSENT_EXTRA, consentId).putExtra(DRAFT_EXTRA, safeDraftId))
                withTimeout(3_500L) { started.await() }
            } catch (_: TimeoutCancellationException) {
                started.complete(false)
                false
            } catch (cancelled: CancellationException) {
                started.complete(false)
                throw cancelled
            } catch (_: Exception) { started.complete(false); false
            } finally {
                foregroundStartAcks.remove(consentId, started)
            }
        }
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return false
        val component = ComponentName(context, BackgroundDeliveryJobService::class.java)
        val matching = scheduler.allPendingJobs.orEmpty().firstOrNull { it.service == component && it.extras.getString(CONSENT_EXTRA) == consentId }
        if (matching != null && matching.extras.getString(DRAFT_EXTRA) == safeDraftId &&
            ((Build.VERSION.SDK_INT < 34) || matching.isUserInitiated)) return true
        var jobId = 0x42000000 or (consentId.hashCode() and 0x001fffff)
        repeat(4096) {
            val occupied = scheduler.getPendingJob(jobId)
            if (occupied == null || occupied.service == component && occupied.extras.getString(CONSENT_EXTRA) == consentId) {
                return scheduler.schedule(buildJobInfo(context, consentId, jobId, safeDraftId)) == JobScheduler.RESULT_SUCCESS
            }
            jobId = 0x42000000 or ((jobId + 1) and 0x001fffff)
        }
        return false
    }

    fun foregroundStarted(consentId: String, succeeded: Boolean) {
        foregroundStartAcks[consentId]?.complete(succeeded)
    }

    fun cancel(context: Context, consentId: String, userStopped: Boolean = false) {
        if (userStopped) context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("stopped:$consentId", true).commit()
        val scheduler = context.getSystemService(JobScheduler::class.java)
        scheduler?.allPendingJobs.orEmpty().filter { it.extras.getString(CONSENT_EXTRA) == consentId }
            .forEach { scheduler?.cancel(it.id) }
        BackgroundDeliveryForegroundService.stopIfMatching(consentId)
        BackgroundDeliveryJobService.cancelRunning(consentId)
    }

    fun wasUserStopped(context: Context, consentId: String): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("stopped:$consentId", false)

    fun notificationId(consentId: String): Int = 0x42000000 or (consentId.hashCode() and 0x001fffff)

    internal fun buildJobInfo(context: Context, consentId: String, jobId: Int, draftId: String? = null): JobInfo {
        val builder = JobInfo.Builder(jobId, ComponentName(context, BackgroundDeliveryJobService::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
            .setExtras(PersistableBundle().apply {
                putString(CONSENT_EXTRA, consentId)
                draftId?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) }?.let { putString(DRAFT_EXTRA, it) }
            })
        if (Build.VERSION.SDK_INT >= 34) builder.setUserInitiated(true)
        return builder.build()
    }

    fun notification(context: Context, jobId: Int, consentId: String, text: String, draftId: String? = null): Notification {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.api_capture_background_channel), NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getBroadcast(context, jobId,
            Intent(context, StopBackgroundDeliveryReceiver::class.java).setAction(STOP_ACTION)
                .putExtra(CONSENT_EXTRA, consentId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val openTask = notificationContentIntent(context, draftId)
        val inbox = PendingIntent.getActivity(context, jobId, openTask,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle(context.getString(R.string.api_capture_background_title))
            .setContentText(text).setContentIntent(inbox)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, context.getString(R.string.api_capture_background_stop), stop).build()
    }

    internal fun notificationContentIntent(context: Context, draftId: String?): Intent {
        val validDraftId = draftId?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) }
        return if (validDraftId != null) Intent(context, ShareDraftActivity::class.java)
            .putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, validDraftId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        else Intent(context, DraftInboxActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }

    fun uploadProgressText(context: Context, progress: TaskUploadProgress): String {
        val confirmed = context.getString(R.string.api_capture_background_confirmed_files,
            progress.confirmedFiles, progress.totalFiles,
            android.text.format.Formatter.formatShortFileSize(context, progress.confirmedBytes),
            android.text.format.Formatter.formatShortFileSize(context, progress.totalBytes))
        val stage = when (progress.phase) {
            TaskUploadPhase.CHECKING -> context.getString(R.string.api_capture_background_checking)
            TaskUploadPhase.PREPARING -> context.getString(R.string.api_capture_background_preparing)
            TaskUploadPhase.TRANSFERRING -> progress.writtenBytes?.let {
                context.getString(R.string.api_capture_background_phone_bytes_written,
                    android.text.format.Formatter.formatShortFileSize(context, it),
                    android.text.format.Formatter.formatShortFileSize(context, progress.fileBytes))
            } ?: context.getString(R.string.api_capture_background_transferring)
            TaskUploadPhase.VERIFYING -> context.getString(R.string.api_capture_background_verifying)
            TaskUploadPhase.CONFIRMED -> context.getString(R.string.api_capture_background_file_confirmed)
        }
        return context.getString(R.string.api_capture_background_progress, confirmed, stage)
    }

    @android.annotation.SuppressLint("MissingPermission")
    fun notifyProgress(context: Context, notificationId: Int, consentId: String, text: String, draftId: String? = null) {
        if (!notificationsAvailable(context)) return
        try {
            NotificationManagerCompat.from(context).notify(notificationId,
                notification(context, notificationId, consentId, text, draftId))
        } catch (_: SecurityException) {
            // Notification permission may be revoked after the check above.
        }
    }
}

/** Android 8–13 fallback, started directly from the visible, explicit user action. */
class BackgroundDeliveryForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private class Attempt(val consentId: String, val draftId: String?, val startId: Int, val notificationId: Int,
        var text: String) { var job: Job? = null }
    /** Service callbacks and coroutine completion both run on Main. */
    private val attempts = LinkedHashMap<String, Attempt>()
    private var foregroundConsentId: String? = null
    private var latestStartId = 0

    override fun onBind(intent: Intent?) = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The installed component is disabled on API34+. Also reject stale/internal
        // explicit starts before posting a notification or touching a consent.
        if (Build.VERSION.SDK_INT >= 34) {
            intent?.getStringExtra(BackgroundDeliveryJobs.CONSENT_EXTRA)?.let {
                BackgroundDeliveryJobs.foregroundStarted(it, false)
            }
            stopSelfResult(startId)
            return START_NOT_STICKY
        }
        latestStartId = startId
        val requested = intent?.getStringExtra(BackgroundDeliveryJobs.CONSENT_EXTRA)?.takeIf(String::isNotBlank)
            ?: run { if (attempts.isEmpty()) stopSelfResult(startId); return START_NOT_STICKY }
        if (BackgroundDeliveryJobs.wasUserStopped(this, requested)) {
            BackgroundDeliveryJobs.foregroundStarted(requested, false)
            attempts[requested]?.job?.cancel()
            if (attempts.isEmpty()) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        val draftId = intent.getStringExtra(BackgroundDeliveryJobs.DRAFT_EXTRA)
            ?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) }
        if (attempts[requested]?.job?.isActive == true) {
            BackgroundDeliveryJobs.foregroundStarted(requested, true)
            return START_NOT_STICKY
        }
        attempts.remove(requested)?.job?.cancel()
        activeService = this
        val notificationId = BackgroundDeliveryJobs.notificationId(requested)
        val attempt = Attempt(requested, draftId, startId, notificationId,
            getString(R.string.api_capture_background_running))
        attempts[requested] = attempt
        val previousForeground = foregroundConsentId?.let(attempts::get)
        try {
            val notification = BackgroundDeliveryJobs.notification(this, notificationId, requested,
                attempt.text, draftId)
            if (Build.VERSION.SDK_INT >= 29) ServiceCompat.startForeground(this, notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(notificationId, notification)
            foregroundConsentId = requested
            previousForeground?.takeIf { it.consentId != requested }?.let {
                BackgroundDeliveryJobs.notifyProgress(this, it.notificationId, it.consentId, it.text, it.draftId)
            }
            BackgroundDeliveryJobs.foregroundStarted(requested, true)
        } catch (_: Exception) {
            attempts.remove(requested, attempt)
            BackgroundDeliveryJobs.foregroundStarted(requested, false)
            if (attempts.isEmpty()) stopSelfResult(startId)
            return START_NOT_STICKY
        }
        attempt.job = scope.launch {
            try {
                val graph = (application as RagentApplication).runtime
                var backoff = 1_000L
                while (isActive) {
                    val consent = withContext(Dispatchers.IO) { graph.backgroundDeliveryConsents.load(requested, graph.appApiOwner) }
                    if (System.currentTimeMillis() >= consent.deadlineAt) break
                    val operation = try {
                        withContext(Dispatchers.IO) {
                            graph.backgroundDelivery.execute(requested) { progress ->
                                val text = BackgroundDeliveryJobs.uploadProgressText(this@BackgroundDeliveryForegroundService, progress)
                                scope.launch {
                                    if (attempts[requested] === attempt && isActive) {
                                        attempt.text = text
                                        BackgroundDeliveryJobs.notifyProgress(
                                            this@BackgroundDeliveryForegroundService, notificationId, requested, text, draftId)
                                    }
                                }
                            }
                        }
                    } catch (failure: AppApiException) {
                        if (!failure.error.retryable) break
                        null
                    } catch (_: java.io.IOException) {
                        null
                    }
                    if (operation != null) {
                        if (operation.stage in setOf(com.andysagent.ragent.core.appapi.OperationStage.ACCEPTED,
                                com.andysagent.ragent.core.appapi.OperationStage.CANCELLED,
                                com.andysagent.ragent.core.appapi.OperationStage.EXPIRED)) break
                        if (operation.stage != com.andysagent.ragent.core.appapi.OperationStage.SUBMITTING ||
                            operation.lastError?.retryable == false) break
                    }
                    delay(backoff)
                    backoff = (backoff * 2).coerceAtMost(30_000L)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // The operation journal retains the original identity for explicit recovery.
            } finally {
                if (attempts[requested] === attempt) {
                    attempts.remove(requested)
                    if (foregroundConsentId == requested) {
                        val next = attempts.values.firstOrNull()
                        if (next != null) {
                            val notification = BackgroundDeliveryJobs.notification(this@BackgroundDeliveryForegroundService,
                                next.notificationId, next.consentId, next.text, next.draftId)
                            if (Build.VERSION.SDK_INT >= 29) ServiceCompat.startForeground(this@BackgroundDeliveryForegroundService,
                                next.notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                            else startForeground(next.notificationId, notification)
                            foregroundConsentId = next.consentId
                        } else {
                            foregroundConsentId = null
                            ServiceCompat.stopForeground(this@BackgroundDeliveryForegroundService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                        }
                    }
                    NotificationManagerCompat.from(this@BackgroundDeliveryForegroundService).cancel(notificationId)
                    if (attempts.isEmpty()) stopSelfResult(latestStartId)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (activeService === this) activeService = null
        attempts.values.forEach {
            it.job?.cancel()
            NotificationManagerCompat.from(this).cancel(it.notificationId)
        }
        attempts.clear()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        @Volatile private var activeService: BackgroundDeliveryForegroundService? = null

        /** Stop only the matching delivery; other consents may share this service. */
        internal fun stopIfMatching(consentId: String) {
            mainHandler.post {
                activeService?.attempts?.get(consentId)?.job?.cancel()
            }
        }
    }
}

class BackgroundDeliveryJobService : JobService() {
    private class Attempt(val params: JobParameters, val consentId: String) { var job: Job? = null }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /** JobService callbacks and completion both run on Main; Android can run several job IDs here. */
    private val active = LinkedHashMap<Int, Attempt>()

    override fun onStartJob(params: JobParameters): Boolean {
        val consentId = params.extras.getString(BackgroundDeliveryJobs.CONSENT_EXTRA)?.takeIf(String::isNotBlank) ?: return false
        val draftId = params.extras.getString(BackgroundDeliveryJobs.DRAFT_EXTRA)
            ?.takeIf { Regex("^[A-Za-z0-9_-]{1,64}$").matches(it) }
        val attempt = Attempt(params, consentId)
        active.put(params.jobId, attempt)?.let { previous ->
            previous.job?.cancel()
            services.remove(previous.consentId, this)
        }
        services[consentId] = this
        val notification = BackgroundDeliveryJobs.notification(this, params.jobId, consentId,
            getString(R.string.api_capture_background_running), draftId)
        if (Build.VERSION.SDK_INT >= 34) setNotification(params, params.jobId, notification, JOB_END_NOTIFICATION_POLICY_DETACH)
        attempt.job = scope.launch {
            var retry = false
            try {
                val result = withContext(Dispatchers.IO) {
                    (application as RagentApplication).runtime.backgroundDelivery.execute(consentId) { progress ->
                        val text = BackgroundDeliveryJobs.uploadProgressText(this@BackgroundDeliveryJobService, progress)
                        mainHandler.post {
                            if (active[params.jobId] === attempt && Build.VERSION.SDK_INT >= 34) {
                                setNotification(attempt.params, attempt.params.jobId,
                                    BackgroundDeliveryJobs.notification(this@BackgroundDeliveryJobService,
                                        attempt.params.jobId, consentId, text, draftId), JOB_END_NOTIFICATION_POLICY_DETACH)
                            }
                        }
                    }
                }
                retry = result.stage == com.andysagent.ragent.core.appapi.OperationStage.SUBMITTING && result.lastError?.retryable != false
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: AppApiException) {
                retry = failure.error.retryable
            } catch (_: Exception) {
                retry = true
            } finally {
                if (active[params.jobId] === attempt) {
                    active.remove(params.jobId)
                    services.remove(consentId, this@BackgroundDeliveryJobService)
                    if (!retry) NotificationManagerCompat.from(this@BackgroundDeliveryJobService).cancel(params.jobId)
                    jobFinished(params, retry)
                }
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val attempt = active.remove(params.jobId) ?: return false
        services.remove(attempt.consentId, this)
        attempt.job?.cancel()
        NotificationManagerCompat.from(this).cancel(params.jobId)
        return !BackgroundDeliveryJobs.wasUserStopped(this, attempt.consentId)
    }

    override fun onDestroy() {
        active.values.forEach { services.remove(it.consentId, this); it.job?.cancel() }
        active.clear()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        private val services = java.util.concurrent.ConcurrentHashMap<String, BackgroundDeliveryJobService>()
        internal fun cancelRunning(consentId: String) {
            mainHandler.post {
                services[consentId]?.active?.values?.filter { it.consentId == consentId }?.forEach { it.job?.cancel() }
            }
        }
    }
}

class StopBackgroundDeliveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != BackgroundDeliveryJobs.STOP_ACTION) return
        val consentId = intent.getStringExtra(BackgroundDeliveryJobs.CONSENT_EXTRA)?.takeIf(String::isNotBlank) ?: return
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val graph = (context.applicationContext as RagentApplication).runtime
                graph.backgroundDeliveryConsents.revoke(consentId, graph.appApiOwner)
            } catch (_: Exception) {
                android.util.Log.w("BackgroundDelivery", "Could not persist delivery stop")
            } finally {
                // Even if persistence fails, stop every local execution path before finishing the receiver.
                try {
                    BackgroundDeliveryJobs.cancel(context, consentId, userStopped = true)
                } catch (_: Exception) {
                    android.util.Log.w("BackgroundDelivery", "Could not cancel local delivery work")
                } finally {
                    pending.finish()
                }
            }
        }
    }
}
