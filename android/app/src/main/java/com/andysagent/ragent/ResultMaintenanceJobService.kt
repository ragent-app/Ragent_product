package com.andysagent.ragent

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log
import com.andysagent.ragent.core.appapi.ResultMaintenanceReceipt
import kotlinx.coroutines.*
import java.util.UUID

/** Local retention only. No network constraint, target selection, external URI or business request. */
internal object ResultMaintenanceSchedule {
    const val JOB_ID = 0x414743
    const val PERIOD_MS = 24L * 60 * 60 * 1000
    const val FLEX_MS = 6L * 60 * 60 * 1000
    const val BACKOFF_MS = 30L * 60 * 1000
    const val RECEIPT_PREFS = "ragent_result_maintenance"

    fun ensureScheduled(context: Context): Boolean {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val component = ComponentName(context, ResultMaintenanceJobService::class.java)
        val current = scheduler.getPendingJob(JOB_ID)
        if (current != null && current.service == component && current.isPeriodic && current.isPersisted &&
            current.intervalMillis == PERIOD_MS && current.flexMillis == FLEX_MS && current.isRequireBatteryNotLow &&
            current.initialBackoffMillis == BACKOFF_MS && current.backoffPolicy == JobInfo.BACKOFF_POLICY_EXPONENTIAL &&
            current.networkType == JobInfo.NETWORK_TYPE_NONE && current.extras.isEmpty) return false
        val job = JobInfo.Builder(JOB_ID, component).setPeriodic(PERIOD_MS, FLEX_MS)
            .setPersisted(true).setRequiresBatteryNotLow(true)
            .setBackoffCriteria(BACKOFF_MS, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build()
        check(scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) { "Local maintenance scheduling failed" }
        return true
    }
}

/** Platform callbacks stay on Main; disk/Room work stays on IO. A stopped run cannot finish a new run. */
class ResultMaintenanceJobService : JobService() {
    private class Attempt(val parameters: JobParameters, val id: String = UUID.randomUUID().toString()) {
        var job: Job? = null
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var active: Attempt? = null

    override fun onStartJob(params: JobParameters): Boolean {
        if (params.jobId != ResultMaintenanceSchedule.JOB_ID) return false
        active?.job?.cancel()
        val attempt = Attempt(params)
        active = attempt
        record(attempt, "RUNNING")
        attempt.job = scope.launch {
            var receipt: ResultMaintenanceReceipt? = null
            var retry = true
            try {
                receipt = withContext(Dispatchers.IO) {
                    val graph = (application as RagentApplication).runtime
                    graph.resultMaintenance.run(graph.resultDeliveryAndroid::revokeGrant)
                }
                retry = receipt.needsRetry
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Details may contain paths or provider contents. Keep only a bounded sanitized outcome.
                Log.w("ResultMaintenance", "Local maintenance requires retry")
            }
            if (active === attempt) {
                record(attempt, if (retry) "RETRY" else "COMPLETED", receipt)
                active = null
                jobFinished(attempt.parameters, retry)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        val attempt = active
        if (attempt != null && attempt.parameters.jobId == params.jobId) {
            active = null
            record(attempt, "STOPPED")
            attempt.job?.cancel()
        }
        return params.jobId == ResultMaintenanceSchedule.JOB_ID
    }

    override fun onDestroy() {
        active?.let { record(it, "STOPPED") }
        active = null
        scope.cancel()
        super.onDestroy()
    }

    private fun record(attempt: Attempt, state: String, receipt: ResultMaintenanceReceipt? = null) {
        // Main serializes identity check + receipt publication. apply() queues disk writes off Main.
        getSharedPreferences(ResultMaintenanceSchedule.RECEIPT_PREFS, Context.MODE_PRIVATE).edit().clear()
            .putString("attempt", attempt.id).putString("state", state).putLong("observedAt", System.currentTimeMillis())
            .putInt("recoveredSaves", receipt?.recoveredSaves ?: 0).putInt("removedHistory", receipt?.removedHistory ?: 0)
            .putInt("removedDeliveries", receipt?.removedDeliveries ?: 0).putInt("removedOrphans", receipt?.removedOrphans ?: 0)
            .putInt("removedTemporary", receipt?.removedTemporary ?: 0).putInt("deferred", receipt?.deferred ?: 0)
            .putInt("failures", receipt?.failures?.size ?: 0).apply()
        Log.i("ResultMaintenance", "Local maintenance $state")
    }
}
