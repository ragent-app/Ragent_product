package com.andysagent.ragent

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.andysagent.ragent.core.model.AppLanguage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.Assert.*
import java.util.UUID

/** Real main Activity intake/recreation; no valid paired target or remote effects are requested. */
class SessionNavigationActivityTest {
    @get:Rule val compose = createEmptyComposeRule()
    // Main's first-draw gate consumes Compose effects. startActivitySync waits
    // for that draw, so launch on a worker while the test advances its clock.
    // Keep the real Activity/lifecycle and the original navigation assertions.
    private fun <T> awaitLifecycle(label: String, action: () -> T): T {
        val task = java.util.concurrent.FutureTask(action)
        Thread(task, "NavigationLifecycle").apply { isDaemon = true; start() }
        val started = android.os.SystemClock.elapsedRealtime()
        println("Navigation lifecycle start: $label")
        try {
            compose.waitUntil(20_000) { task.isDone }
            return task.get()
        } finally {
            println("Navigation lifecycle end: $label, complete=${task.isDone}, elapsed=${android.os.SystemClock.elapsedRealtime() - started} ms")
            if (!task.isDone) task.cancel(true)
        }
    }

    private inline fun withMain(intent: Intent, block: (ActivityScenario<MainActivity>) -> Unit) {
        val scenario = awaitLifecycle("launch") { ActivityScenario.launch<MainActivity>(intent) }
        try { block(scenario) } finally { awaitLifecycle("close") { scenario.close() } }
    }
    private fun awaitText(text: String) {
        compose.waitUntil(15_000) {
            try { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
            catch (failure: IllegalStateException) {
                if (failure.message?.startsWith("No compose hierarchies found") == true) false else throw failure
            }
        }
    }
    @Test fun oldNotificationColdRecreationAndNewIntentNeverChooseCurrentComputer() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val oldLanguage = app.runtime.configStore.appLanguage.first()
        val oldTarget = app.runtime.configStore.directory.first().activeTargetId
        try {
            app.runtime.configStore.setAppLanguage(AppLanguage.English)
            val legacy = Intent(app, MainActivity::class.java).putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID, "qa-old-notification")
            withMain(legacy) { scenario ->
                awaitText("Choose the source computer")
                awaitLifecycle("recreate legacy") { scenario.recreate() }; awaitText("Choose the source computer")
                assertEquals(oldTarget, app.runtime.configStore.directory.first().activeTargetId)
                compose.onNodeWithText("Close").performClick()
                app.startActivity(Intent(app, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(RagentFirebaseMessagingService.EXTRA_NOTIFICATION_SESSION_ID, "qa-second-notification"))
                awaitText("Choose the source computer")
                assertEquals(oldTarget, app.runtime.configStore.directory.first().activeTargetId)
                compose.onNodeWithText("Close").performClick()
            }
        } finally { app.runtime.configStore.setAppLanguage(oldLanguage) }
        Unit
    }
    @Test fun canonicalUnknownTargetColdAndRecreatedLinkReportsSourceMissingWithoutFallback() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<RagentApplication>()
        val oldLanguage = app.runtime.configStore.appLanguage.first()
        val oldTarget = app.runtime.configStore.directory.first().activeTargetId
        try {
            app.runtime.configStore.setAppLanguage(AppLanguage.English)
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("ragent://session/qa-session?instanceId=unpaired-${UUID.randomUUID()}"))
                .setClass(app, MainActivity::class.java)
            withMain(intent) { scenario ->
                awaitText("The source computer is no longer paired. This link cannot open a different computer.")
                awaitLifecycle("recreate canonical") { scenario.recreate() }
                awaitText("The source computer is no longer paired. This link cannot open a different computer.")
                assertEquals(oldTarget, app.runtime.configStore.directory.first().activeTargetId)
                compose.onNodeWithText("Close").performClick()
            }
        } finally { app.runtime.configStore.setAppLanguage(oldLanguage) }
        Unit
    }
}
