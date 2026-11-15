package com.andysagent.ragent

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.appapi.TaskUploadPhase
import com.andysagent.ragent.core.appapi.TaskUploadProgress
import com.andysagent.ragent.core.appapi.CaptureDraft
import com.andysagent.ragent.core.appapi.CaptureInput
import com.andysagent.ragent.core.appapi.CaptureSource
import com.andysagent.ragent.core.appapi.TaskRequest
import com.andysagent.ragent.core.appapi.TaskRuntime
import com.andysagent.ragent.core.datastore.LinkedComputer
import com.andysagent.ragent.feature.appapi.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first

/** Scheduler integration uses a consent ID with no database row, so it cannot reach a PC task. */
@RunWith(AndroidJUnit4::class)
class BackgroundDeliverySchedulingTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun backgroundProgressTextSeparatesPhoneBytesFromComputerReceiptsAndOmitsFileName() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val progress = TaskUploadProgress(
            operationId = "operation-fixture",
            targetInstanceId = "computer-fixture",
            resourceId = "resource-fixture",
            originalName = "private-document.pdf",
            confirmedFiles = 1,
            totalFiles = 2,
            confirmedBytes = 512 * 1024L,
            totalBytes = 1536 * 1024L,
            phase = TaskUploadPhase.TRANSFERRING,
            fileBytes = 1024 * 1024L,
            writtenBytes = 256 * 1024L,
        )

        val text = BackgroundDeliveryJobs.uploadProgressText(context, progress)
        val computerReceipt = context.getString(R.string.api_capture_background_confirmed_files, 1, 2,
            android.text.format.Formatter.formatShortFileSize(context, 512 * 1024L),
            android.text.format.Formatter.formatShortFileSize(context, 1536 * 1024L))
        val phoneWrite = context.getString(R.string.api_capture_background_phone_bytes_written,
            android.text.format.Formatter.formatShortFileSize(context, 256 * 1024L),
            android.text.format.Formatter.formatShortFileSize(context, 1024 * 1024L))

        assertTrue("Notification must label persisted computer receipts", text.contains(computerReceipt))
        assertTrue("Notification must describe measured phone writes separately", text.contains(phoneWrite))
        assertFalse("Notification must not expose the shared file name", text.contains(progress.originalName))
    }

    @Test fun notificationContentIntentOpensTheOriginalDraftAndRejectsInvalidIds() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        val exact = BackgroundDeliveryJobs.notificationContentIntent(context, "draft_42")
        assertEquals(ShareDraftActivity::class.java.name, exact.component?.className)
        assertEquals("draft_42", exact.getStringExtra(ShareDraftActivity.EXTRA_DRAFT_ID))

        val fallback = BackgroundDeliveryJobs.notificationContentIntent(context, "../other")
        assertEquals(DraftInboxActivity::class.java.name, fallback.component?.className)
        assertFalse(fallback.hasExtra(ShareDraftActivity.EXTRA_DRAFT_ID))
    }

    @Test fun backgroundNotificationPendingIntentOpensTheSavedDraftWithoutSubmitting() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val marker = "Background notification draft ${UUID.randomUUID()}"
        val draft = CaptureDraft(UUID.randomUUID().toString(), graph.appApiOwner.binding, 1,
            input = CaptureInput(marker, source = CaptureSource.PROCESS_TEXT, selectionReadOnly = false))
        try {
            assertTrue(graph.captureDrafts.insert(draft, graph.appApiOwner))
            val notification = BackgroundDeliveryJobs.notification(app, 0x42001A4B,
                "consent-navigation-fixture", "Synthetic background delivery", draft.draftId)
            notification.contentIntent.send()
            compose.waitUntil(10_000) {
                try { compose.onAllNodesWithText(marker).fetchSemanticsNodes().isNotEmpty() }
                catch (failure: IllegalStateException) {
                    if (failure.message?.startsWith("No compose hierarchies found") == true) false
                    else throw failure
                }
            }
            compose.onNodeWithText(marker).assertIsDisplayed()
            assertEquals("Notification navigation must preserve the original draft identity", draft.draftId,
                graph.captureDrafts.get(draft.draftId, graph.appApiOwner)?.draftId)
            assertNull("Opening a notification must not submit the draft",
                graph.captureDrafts.get(draft.draftId, graph.appApiOwner)?.operationId)
        } finally {
            instrumentation.runOnMainSync {
                (ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED) +
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.STOPPED))
                    .filterIsInstance<ShareDraftActivity>().forEach { it.finish() }
            }
            graph.captureDrafts.get(draft.draftId, graph.appApiOwner)?.let {
                graph.captureDrafts.delete(it.draftId, graph.appApiOwner, it.revision)
            }
        }
    }

    @Test fun android14PlusUsesExplicitNetworkUidtBoundToTheReviewedConsent() {
        assumeTrue(Build.VERSION.SDK_INT >= 34)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val consentId = "consent-fixture"
        val draftId = "draft-fixture"
        val job = BackgroundDeliveryJobs.buildJobInfo(context, consentId, 0x42000001, draftId)

        assertTrue(job.isUserInitiated)
        assertEquals(JobInfo.NETWORK_TYPE_ANY, job.networkType)
        assertEquals(consentId, job.extras.getString(BackgroundDeliveryJobs.CONSENT_EXTRA))
        assertEquals(draftId, job.extras.getString(BackgroundDeliveryJobs.DRAFT_EXTRA))
        assertFalse(job.isPersisted)
    }

    @Test fun visibleOwnerActivityCanScheduleAndCancelUidtWithoutARealOperation() {
        assumeTrue(Build.VERSION.SDK_INT >= 34)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val component = ComponentName(context, BackgroundDeliveryJobService::class.java)
        val consentId = "scheduler-test-${UUID.randomUUID()}"
        ActivityScenario.launch<AppApiSettingsActivity>(Intent(context, AppApiSettingsActivity::class.java)).use {
            try {
                assertTrue("JobScheduler rejected UIDT", runBlocking { BackgroundDeliveryJobs.schedule(context, consentId) })
                scheduler.allPendingJobs.orEmpty().firstOrNull {
                    it.service == component && it.extras.getString(BackgroundDeliveryJobs.CONSENT_EXTRA) == consentId
                }?.let { pending ->
                    assertTrue(pending.isUserInitiated)
                    assertEquals(JobInfo.NETWORK_TYPE_ANY, pending.networkType)
                }
            } finally {
                stopViaNotificationReceiver(context, consentId)
            }
        }
        assertFalse(scheduler.allPendingJobs.orEmpty().any {
            it.service == component && it.extras.getString(BackgroundDeliveryJobs.CONSENT_EXTRA) == consentId
        })
    }

    @Test fun android8To13VisibleActivityCanStartAndStopForegroundFallback() {
        assumeTrue(Build.VERSION.SDK_INT in 26..33)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val consentId = "foreground-test-${UUID.randomUUID()}"
        ActivityScenario.launch<AppApiSettingsActivity>(Intent(context, AppApiSettingsActivity::class.java)).use {
            assertTrue(runBlocking { BackgroundDeliveryJobs.schedule(context, consentId) })
            stopViaNotificationReceiver(context, consentId)
        }
        val activityManager = context.getSystemService(android.app.ActivityManager::class.java)
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
        fun foregroundServiceRunning() = activityManager.getRunningServices(64).any {
            it.service?.className == BackgroundDeliveryForegroundService::class.java.name
        }
        while (foregroundServiceRunning() && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(20L)
        assertFalse("foreground fallback remained active after the stop action", foregroundServiceRunning())
    }

    @Test fun android8To13ConcurrentSchedulesConfirmTheSameForegroundStart() {
        assumeTrue(Build.VERSION.SDK_INT in 26..33)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val consentId = "foreground-concurrent-test-${UUID.randomUUID()}"
        ActivityScenario.launch<AppApiSettingsActivity>(Intent(context, AppApiSettingsActivity::class.java)).use {
            try {
                val results = runBlocking {
                    (1..2).map { async(Dispatchers.Default) {
                        BackgroundDeliveryJobs.schedule(context, consentId)
                    } }.awaitAll()
                }
                assertTrue("Both callers must observe the same foreground start confirmation", results.all { it })
            } finally {
                stopViaNotificationReceiver(context, consentId)
            }
        }
    }

    @Test fun android8To13StoppingOneOfTwoBackgroundDeliveriesKeepsTheOtherVisible() {
        assumeTrue(Build.VERSION.SDK_INT in 26..33)
        withTwoOfflineConsents { app, consentA, consentB ->
            ActivityScenario.launch<AppApiSettingsActivity>(Intent(app, AppApiSettingsActivity::class.java)).use {
                assertTrue(runBlocking { BackgroundDeliveryJobs.schedule(app, consentA) })
                awaitNotification(app, consentA, present = true)
                assertTrue(runBlocking { BackgroundDeliveryJobs.schedule(app, consentB) })
                awaitNotification(app, consentA, present = true)
                awaitNotification(app, consentB, present = true)
                stopViaNotificationReceiver(app, consentA)
                awaitNotification(app, consentB, present = true)
                awaitNotification(app, consentA, present = false)
            }
        }
    }

    @Test fun android14PlusStoppingOneOfTwoUidtJobsKeepsTheOtherScheduled() {
        assumeTrue(Build.VERSION.SDK_INT >= 34)
        withTwoOfflineConsents { app, consentA, consentB ->
            val scheduler = app.getSystemService(JobScheduler::class.java)
            fun scheduled(id: String) = scheduler.allPendingJobs.orEmpty().any {
                it.service == ComponentName(app, BackgroundDeliveryJobService::class.java) &&
                    it.extras.getString(BackgroundDeliveryJobs.CONSENT_EXTRA) == id
            }
            ActivityScenario.launch<AppApiSettingsActivity>(Intent(app, AppApiSettingsActivity::class.java)).use {
                assertTrue(runBlocking { BackgroundDeliveryJobs.schedule(app, consentA) })
                assertTrue(runBlocking { BackgroundDeliveryJobs.schedule(app, consentB) })
                assertTrue("First UIDT job was not scheduled", scheduled(consentA))
                assertTrue("Second UIDT job was not scheduled", scheduled(consentB))
                stopViaNotificationReceiver(app, consentA)
                val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
                while (scheduled(consentA) && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(20L)
                assertFalse("Stopped UIDT job remains scheduled", scheduled(consentA))
                assertTrue("Stopping the first job cancelled the second", scheduled(consentB))
            }
        }
    }

    private fun awaitNotification(app: Context, consentId: String, present: Boolean) {
        val notifications = app.getSystemService(NotificationManager::class.java)
        fun visible() = notifications.activeNotifications.any { it.id == BackgroundDeliveryJobs.notificationId(consentId) }
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
        while (visible() != present && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(20L)
        assertEquals("Wrong background notification state for $consentId", present, visible())
    }

    private fun withTwoOfflineConsents(block: (RagentApplication, String, String) -> Unit) {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val suffix = UUID.randomUUID().toString()
        val targetA = "qa-offline-a-$suffix"
        val targetB = "qa-offline-b-$suffix"
        val originalTarget = runBlocking { graph.configStore.directory.first().activeTarget }
        var consentA: String? = null
        var consentB: String? = null
        try {
            runBlocking {
                graph.appApi.listTargets(graph.appApiOwner)
                graph.configStore.upsertComputer(LinkedComputer(targetA, "http://127.0.0.1:1", "QA offline A", autoConnect = false))
                graph.configStore.upsertComputer(LinkedComputer(targetB, "http://127.0.0.1:1", "QA offline B", autoConnect = false))
                suspend fun approve(target: String): String {
                    val prepared = graph.appApi.prepare(TaskRequest("qa-$target", "Synthetic offline task",
                        TaskRuntime("codex"), targetInstanceId = target), graph.appApiOwner)
                    val store = graph.backgroundDeliveryConsents
                    return store.approve(store.review(prepared.operationId, graph.appApiOwner), graph.appApiOwner).consentId
                }
                consentA = approve(targetA)
                consentB = approve(targetB)
            }
            block(app, consentA!!, consentB!!)
        } finally {
            consentA?.let { if (!BackgroundDeliveryJobs.wasUserStopped(app, it)) stopViaNotificationReceiver(app, it) }
            consentB?.let { if (!BackgroundDeliveryJobs.wasUserStopped(app, it)) stopViaNotificationReceiver(app, it) }
            runBlocking {
                graph.configStore.removeTarget(targetA)
                graph.configStore.removeTarget(targetB)
                if (originalTarget != null && graph.configStore.directory.first().computers.any { it.instanceId == originalTarget.instanceId })
                    graph.configStore.upsertComputer(originalTarget, select = true)
            }
        }
    }

    private fun stopViaNotificationReceiver(context: Context, consentId: String) {
        context.sendBroadcast(Intent(context, StopBackgroundDeliveryReceiver::class.java)
            .setAction(BackgroundDeliveryJobs.STOP_ACTION)
            .putExtra(BackgroundDeliveryJobs.CONSENT_EXTRA, consentId))
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
        while (!BackgroundDeliveryJobs.wasUserStopped(context, consentId) && android.os.SystemClock.elapsedRealtime() < deadline) {
            Thread.sleep(20L)
        }
        assertTrue("stop receiver did not persist the user stop marker", BackgroundDeliveryJobs.wasUserStopped(context, consentId))
    }
}
