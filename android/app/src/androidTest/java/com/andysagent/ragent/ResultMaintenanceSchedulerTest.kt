package com.andysagent.ragent

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Actual platform scheduler and production graph; no remote business call is made by maintenance. */
class ResultMaintenanceSchedulerTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @Test fun periodicRegistrationIsStableAndSystemPermissionProtected() {
        ResultMaintenanceSchedule.ensureScheduled(context)
        assertFalse(ResultMaintenanceSchedule.ensureScheduled(context))
        val job = context.getSystemService(JobScheduler::class.java).getPendingJob(ResultMaintenanceSchedule.JOB_ID)!!
        assertTrue(job.isPeriodic); assertTrue(job.isPersisted); assertTrue(job.isRequireBatteryNotLow)
        assertEquals(ResultMaintenanceSchedule.PERIOD_MS, job.intervalMillis)
        assertEquals(ResultMaintenanceSchedule.FLEX_MS, job.flexMillis)
        assertEquals(JobInfo.NETWORK_TYPE_NONE, job.networkType); assertTrue(job.extras.isEmpty)
        @Suppress("DEPRECATION")
        val service = context.packageManager.getServiceInfo(ComponentName(context, ResultMaintenanceJobService::class.java), 0)
        assertEquals("android.permission.BIND_JOB_SERVICE", service.permission); assertTrue(service.exported)
    }
    @Test fun actualForcedSystemJobRemovesOrphanAndPublishesSanitizedReceipt() {
        ResultMaintenanceSchedule.ensureScheduled(context)
        val directory = File(context.noBackupFilesDir, "ragent-result-outputs").apply { mkdirs() }
        val orphan = File(directory, "maintenance_${UUID.randomUUID()}.part").apply { writeText("orphan"); setLastModified(1) }
        val unexpected = File(directory, "maintenance_${UUID.randomUUID()}.keep").apply { writeText("retain"); setLastModified(1) }
        val prefs = context.getSharedPreferences(ResultMaintenanceSchedule.RECEIPT_PREFS, Context.MODE_PRIVATE)
        val previous = prefs.getString("attempt", null)
        try {
            val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                "cmd jobscheduler run -f ${context.packageName} ${ResultMaintenanceSchedule.JOB_ID}")
            val output = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
            assertTrue(output, output.contains("Running job"))
            val until = SystemClock.elapsedRealtime() + 30_000
            while (SystemClock.elapsedRealtime() < until &&
                (prefs.getString("attempt", null) == previous || prefs.getString("state", null) == "RUNNING")) SystemClock.sleep(100)
            assertNotEquals(previous, prefs.getString("attempt", null))
            assertEquals("COMPLETED", prefs.getString("state", null))
            assertTrue(prefs.getInt("removedOrphans", 0) >= 1)
            assertFalse(orphan.exists()); assertTrue(unexpected.exists())
            assertFalse(prefs.all.toString().contains("content://")); assertFalse(prefs.all.toString().contains(orphan.name))
        } finally { orphan.delete(); unexpected.delete() }
    }
}
