package com.andysagent.ragent

import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID

/** Real native PendingIntents: separate draft identities and private navigation with no result channel. */
class CaptureTaskNotificationTest {
    @get:Rule val compose = createEmptyComposeRule()
    @Test fun savedTaskNotificationsHaveIndependentImmutableNavigationAndNoReturnAuthority() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val graph = app.runtime
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val manager = app.getSystemService(NotificationManager::class.java)
        val granted = Build.VERSION.SDK_INT < 33 || app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val oldLanguage = graph.configStore.appLanguage.first()
        val drafts = (1..2).map { CaptureDraft(UUID.randomUUID().toString(), graph.appApiOwner.binding, 1,
            input = CaptureInput("Synthetic notification draft $it", source = CaptureSource.PROCESS_TEXT, selectionReadOnly = false)) }
        try {
            assertTrue("Grant POST_NOTIFICATIONS on the selected test serial before this native notification test", granted)
            graph.configStore.setAppLanguage(AppLanguage.English)
            drafts.forEach { draft ->
                assertTrue(graph.captureDrafts.insert(draft, graph.appApiOwner))
                showSavedCapture(app, draft.draftId, Intent(app, ShareDraftActivity::class.java).putExtra(ShareDraftActivity.EXTRA_DRAFT_ID, draft.draftId))
            }
            compose.waitUntil(5_000) { manager.activeNotifications.count { it.tag in drafts.map { d -> "capture-${d.draftId}" } } == 2 }
            val pending = drafts.map { draft -> manager.activeNotifications.single { it.tag == "capture-${draft.draftId}" }.notification.contentIntent }
            assertNotEquals(pending[0], pending[1])
            if (Build.VERSION.SDK_INT >= 31) assertTrue(pending.all { it.isImmutable })
            drafts.zip(pending).forEach { (draft, destination) ->
                destination.send()
                compose.waitUntil(5_000) {
                    try { compose.onAllNodesWithText(draft.input.sharedText).fetchSemanticsNodes().isNotEmpty() }
                    catch (failure: IllegalStateException) {
                        // With the source truly resumed, no target Compose root
                        // exists until the PendingIntent's Activity creates it.
                        if (failure.message?.startsWith("No compose hierarchies found") == true) false else throw failure
                    }
                }
                compose.onNodeWithContentDescription("Shared material").assertTextContains(draft.input.sharedText)
                compose.onNodeWithText("Replace selected text with this result").assertDoesNotExist()
                assertNull(graph.captureDrafts.get(draft.draftId, graph.appApiOwner)!!.operationId)
            }
        } finally {
            instrumentation.runOnMainSync {
                (ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED) +
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.STOPPED))
                    .filterIsInstance<ShareDraftActivity>().forEach { it.finish() }
            }
            instrumentation.waitForIdleSync()
            drafts.forEach { draft ->
                manager.cancel("capture-${draft.draftId}", 1)
                graph.captureDrafts.get(draft.draftId, graph.appApiOwner)?.let { graph.captureDrafts.delete(it.draftId, graph.appApiOwner, it.revision) }
            }
            graph.configStore.setAppLanguage(oldLanguage)
        }
    }
}
