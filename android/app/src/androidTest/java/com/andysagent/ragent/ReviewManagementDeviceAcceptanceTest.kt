package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Real platform UI, without installing a Compose test frame clock. Read-only. */
class ReviewManagementDeviceAcceptanceTest {
    @Test fun fullReviewerCanUseManagementPagesThroughPlatformUi() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorManagement") == "ADNQ6R5716008635")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val device = UiDevice.getInstance(instrumentation)
        val evidence = File(app.cacheDir, "review-management-device").apply { mkdirs() }
        fun find(text: String, timeout: Long = 30_000): UiObject2 =
            device.wait(Until.findObject(By.text(text)), timeout) ?: error("Expected management control: $text")
        fun scrollTo(text: String): UiObject2 {
            repeat(9) {
                device.wait(Until.findObject(By.text(text)), 1_000)?.let { return it }
                val scrollable = device.wait(Until.findObject(By.scrollable(true)), 5_000)
                    ?: error("No scrollable management catalog")
                scrollable.scroll(Direction.DOWN, 0.75f)
            }
            return find(text, 2_000)
        }
        fun report(stage: String) = instrumentation.sendStatus(2, Bundle().apply { putString("platformManagement", stage) })
        try {
            runBlocking {
                assertEquals("full", app.runtime.ensureAccountSession().demoAccessMode)
                assertEquals("inst_246330d82153ae12c22ffff45f6e033b", app.runtime.configStore.directory.first().activeTargetId)
            }
            instrumentation.runOnMainSync {
                app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            find(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_title)).click()
            scrollTo(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_workspace_tools)).click()
            scrollTo(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_model_providers)).click()
            find("Review Codex Luna")
            scrollTo("Add provider").click()
            find("Add model provider")
            device.takeScreenshot(File(evidence, "provider-add-dialog.png"))
            report("supplied-provider-visible-add-dialog-open")
            device.pressBack()
            device.wait(Until.gone(By.text("Add model provider")), 5_000)
            device.pressBack()
            find(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_title))
            scrollTo(app.getString(com.andysagent.ragent.feature.workbench.R.string.settings_harnesses)).click()
            find("Codex")
            scrollTo("Claude Code")
            scrollTo("Kilo Code")
            assertFalse(device.hasObject(By.textContains("Session could not be refreshed")))
            device.takeScreenshot(File(evidence, "harness-catalog.png"))
            report("harness-catalog-through-kilo-visible-without-stale-session-error")
        } finally {
            runCatching {
                val response = runBlocking { app.runtime.executeOnTarget("inst_246330d82153ae12c22ffff45f6e033b",
                    com.andysagent.ragent.core.network.ApiRequest("GET", "/api/native-providers")) }
                val rows = org.json.JSONObject(response.body).optJSONArray("providers")
                report("phone-api-provider-count:${rows?.length() ?: -1}")
            }.onFailure { report("phone-api-probe-failed:${it.javaClass.simpleName}") }
            instrumentation.runOnMainSync {
                runCatching {
                    val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<MainActivity>().single()
                    val store = activity.viewModelStore
                    val field = store.javaClass.declaredFields.first { Map::class.java.isAssignableFrom(it.type) }.apply { isAccessible = true }
                    val models = (field.get(store) as Map<*, *>).values
                    val vm = models.filterIsInstance<com.andysagent.ragent.feature.workbench.WebParityViewModel>().single()
                    val state = vm.state.value
                    report("viewmodel:page=${state.page},loading=${state.loading},providers=${state.providers.size},hasError=${state.error != null}")
                }.onFailure { report("viewmodel-probe-failed:${it.javaClass.simpleName}") }
            }
            device.takeScreenshot(File(evidence, "final.png"))
            device.dumpWindowHierarchy(File(evidence, "window.xml"))
        }
    }
}
