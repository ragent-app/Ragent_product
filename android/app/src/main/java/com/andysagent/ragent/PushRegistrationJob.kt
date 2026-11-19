package com.andysagent.ragent

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

internal object PushRegistrationSchedule {
    private const val JOB_ID = 0x52414750
    private const val RETRY_JOB_ID = 0x52414751
    fun ensure(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (scheduler.getPendingJob(JOB_ID) != null) return
        scheduler.schedule(JobInfo.Builder(JOB_ID, ComponentName(context, PushRegistrationJob::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .setPeriodic(15 * 60_000L)
            .build())
    }
    fun request(context: Context) {
        ensure(context)
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (scheduler.getPendingJob(RETRY_JOB_ID) == null) {
            scheduler.schedule(JobInfo.Builder(RETRY_JOB_ID, ComponentName(context, PushRegistrationJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).build())
        }
    }
}

class PushRegistrationJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = mutableMapOf<Int, Pair<JobParameters, Job>>()
    override fun onStartJob(params: JobParameters): Boolean {
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var failed = true
            try {
                val graph = (application as RagentApplication).runtime
                failed = false
                try { graph.retryPushRevocations() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { failed = true }
                currentCoroutineContext().ensureActive()
                try { graph.retryPendingPushMessages() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { failed = true }
                currentCoroutineContext().ensureActive()
                try { graph.retryPushReceipts() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { failed = true }
                currentCoroutineContext().ensureActive()
                try {
                    graph.refreshPushTokenIfRequired()
                    currentCoroutineContext().ensureActive()
                    val token = Tasks.await(FirebaseMessaging.getInstance().token, 30, TimeUnit.SECONDS)
                    currentCoroutineContext().ensureActive()
                    graph.registerFcmToken(token)
                } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { failed = true }
            } finally {
                synchronized(jobs) {
                    if (jobs[params.jobId]?.first === params) {
                        jobs.remove(params.jobId)
                        jobFinished(params, failed)
                    }
                }
            }
        }
        synchronized(jobs) { jobs.put(params.jobId, params to job)?.second?.cancel() }
        job.start()
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean {
        synchronized(jobs) {
            if (jobs[params.jobId]?.first === params) jobs.remove(params.jobId)?.second?.cancel()
        }
        return true
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
