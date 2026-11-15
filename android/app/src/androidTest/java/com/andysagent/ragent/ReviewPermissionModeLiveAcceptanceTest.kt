package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.lifecycle.ViewModelProvider
import com.andysagent.ragent.feature.workbench.accounts.AccountsEvent
import com.andysagent.ragent.feature.workbench.accounts.AccountsViewModel
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import com.andysagent.ragent.core.model.RuntimeConnectionState
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.UUID

/** Normal platform UI writes, protected carrier readback, exact policy restoration. */
class ReviewPermissionModeLiveAcceptanceTest {
    @Test fun fullReviewerCanSwitchEveryAccountPermissionMode() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorPermission") == "ADNQ6R5716008635")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        val device = UiDevice.getInstance(instrumentation)
        val target = "inst_246330d82153ae12c22ffff45f6e033b"
        fun read(): String = runBlocking {
            val response = graph.executeOnTarget(target, ApiRequest("GET", "/api/account-policy"))
            check(response.statusCode == 200)
            JSONObject(response.body).getJSONObject("policy").getString("permissionPolicy")
        }
        fun find(text: String): UiObject2 = device.wait(Until.findObject(By.text(text)), 30_000)
            ?: error("Missing permission control: $text")
        fun scrollTo(text: String): UiObject2 {
            repeat(8) {
                device.wait(Until.findObject(By.text(text)), 1_000)?.let { return it }
                device.wait(Until.findObject(By.scrollable(true)), 5_000)?.scroll(Direction.DOWN, 0.7f)
            }
            return find(text)
        }
        fun report(value: String) = instrumentation.sendStatus(2, Bundle().apply { putString("permissionUi", value) })
        assertEquals("full", runBlocking { graph.ensureAccountSession() }.demoAccessMode)
        instrumentation.runOnMainSync { app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        runBlocking { withTimeout(90_000) { graph.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } } }
        assertEquals("Do not alter another computer's account policy", target, runBlocking { graph.configStore.directory.first().activeTarget?.instanceId })
        val original = read()
        var accounts: AccountsViewModel? = null
        instrumentation.runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single()
            accounts = ViewModelProvider(activity)[AccountsViewModel::class.java]
        }
        var lastWritten: String? = null
        val evidence = File(app.cacheDir, "review-permission-ui").apply { mkdirs() }
        try {
            find(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_title)).click()
            scrollTo(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_permission_mode)).click()
            val options = listOf(
                "conservative-auto" to com.andysagent.ragent.feature.workbench.R.string.settings_permission_conservative_auto,
                "approval" to com.andysagent.ragent.feature.workbench.R.string.settings_permission_approval,
                "full-auto" to com.andysagent.ragent.feature.workbench.R.string.settings_permission_full_auto,
            )
            for ((value, title) in options) {
                lastWritten = value
                find(app.getString(title)).click()
                val deadline = android.os.SystemClock.elapsedRealtime() + 20_000
                var actual = read()
                while (actual != value && android.os.SystemClock.elapsedRealtime() < deadline) {
                    android.os.SystemClock.sleep(250)
                    actual = read()
                }
                assertEquals(value, actual)
                instrumentation.runOnMainSync { requireNotNull(accounts).onEvent(AccountsEvent.Refresh) }
                android.os.SystemClock.sleep(2_000)
                assertEquals("Account refresh must not revert the selected UI policy", value,
                    requireNotNull(accounts).state.value.accountPermissionPolicy?.permissionPolicy)
                assertEquals("Account refresh must not revert the server policy", value, read())
                device.takeScreenshot(File(evidence, "$value.png"))
                report("normal-ui-and-protected-readback:$value")
            }
        } finally {
            val current = read()
            if (current != original) {
                check(current == lastWritten) { "Policy changed externally; will not overwrite it" }
                val id = "honor-policy-restore-" + UUID.randomUUID()
                val response = runBlocking { graph.executeOnTarget(target, ApiRequest("PATCH", "/api/account-policy",
                    body = JSONObject().put("permissionPolicy", original).toString(), requestId = id, idempotencyKey = id)) }
                check(response.statusCode == 200)
            }
            assertEquals(original, read())
            report("original-account-default-restored")
            device.pressBack()
        }
    }
}
