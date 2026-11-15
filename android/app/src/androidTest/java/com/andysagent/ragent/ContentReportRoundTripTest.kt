package com.andysagent.ragent

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import androidx.activity.compose.setContent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import com.andysagent.ragent.core.designsystem.RagentTheme
import com.andysagent.ragent.core.domain.HttpContentReportsRepository
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.feature.workbench.ContentReportHost
import com.andysagent.ragent.feature.workbench.ContentReportViewModel
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic loopback integration, deliberately NOT a public receiver or real-model claim. */
@RunWith(AndroidJUnit4::class)
class ContentReportRoundTripTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun lostReplyThenColdLocalRestoreQueriesActualSqliteReceiptWithoutRepost() {
        assumeTrue("Only the owned disposable emulator may run this fixture", Build.FINGERPRINT.contains("generic"))
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit loopback fixture opt-in required", args.getString("reportFixture") == "owned-loopback-20261027")
        val application = ApplicationProvider.getApplicationContext<Context>()
        val root = File(application.cacheDir, "report-roundtrip-${UUID.randomUUID()}")
        check(root.mkdirs())
        val context = object : ContextWrapper(application) { override fun getNoBackupFilesDir() = root }
        // Test-only debug HTTP carrier via adb reverse. The shipped transport separately requires HTTPS.
        val transport = OkHttpRagentTransport({ "http://127.0.0.1:18431/accounts" }, { null },
            OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).build())
        fun repository() = HttpContentReportsRepository(transport, AndroidContentReportJournal(context), "0.0.1")
        val vm = mutableStateOf(ContentReportViewModel(repository()))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val currentActivity = AtomicReference<MainActivity>()
        // startActivitySync waits for first draw; that deadlocks this app's splash
        // gate while Compose's test clock awaits the return from synchronous launch.
        // Launch normally, let the real welcome entry resolve, then host the fixture.
        instrumentation.runOnMainSync {
            application.startActivity(Intent(application, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        }
        try {
            compose.waitUntil(30_000) {
                instrumentation.runOnMainSync {
                    currentActivity.set(ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull())
                }
                currentActivity.get() != null
            }
            compose.onNodeWithText("Connect your work computer").assertIsDisplayed()
            instrumentation.runOnMainSync {
                currentActivity.get().setContent { RagentTheme { ContentReportHost(vm.value) } }
                vm.value.open("SYNTHETIC REPLY MUST NOT BE SENT BY DEFAULT")
            }
            compose.waitUntil(30_000) { !vm.value.state.value.busy }
            compose.onNodeWithTag("content-report-include").performScrollTo().assertIsOff()
            compose.onNodeWithText("Other concern").performScrollTo().performClick()
            compose.onNodeWithTag("content-report-details").performTextInput("synthetic native round-trip")
            screenshot(application, "report-before-submit.png")
            compose.onNodeWithTag("content-report-submit").performClick()
            compose.waitUntil(30_000) { !vm.value.state.value.busy && vm.value.state.value.record != null }
            val requestId = vm.value.state.value.record!!.payload.requestId
            assertNull(vm.value.state.value.record!!.receipt) // Fixture committed, then dropped its response.
            assertNotNull(vm.value.state.value.error)
            instrumentation.runOnMainSync {
                vm.value.dismiss()
                vm.value = ContentReportViewModel(repository())
                vm.value.open()
            }
            compose.waitUntil(30_000) { !vm.value.state.value.busy && vm.value.state.value.record != null }
            assertEquals(requestId, vm.value.state.value.record!!.payload.requestId)
            assertNull(vm.value.state.value.record!!.receipt) // Local restore did not query or resend.
            compose.onNodeWithText("Check receipt").performClick()
            compose.waitUntil(30_000) { !vm.value.state.value.busy && vm.value.state.value.record?.receipt != null }
            assertEquals("received", vm.value.state.value.record!!.receipt!!.status)
            compose.onNodeWithTag("content-report-status").performScrollTo().assertTextEquals("Received by the developer service. Human review is pending.")
            screenshot(application, "report-receipt.png")
            println("REPORT_ROUNDTRIP_RECEIPT=$requestId; excerptSelected=false; syntheticLoopback=true")
        } finally {
            instrumentation.runOnMainSync { currentActivity.get()?.finish() }
            runBlocking { transport.close(); AndroidContentReportJournal(context).clear() }
            check(root.canonicalFile.parentFile == application.cacheDir.canonicalFile)
            check(root.name.startsWith("report-roundtrip-")); check(root.deleteRecursively())
        }
    }
    private fun screenshot(context: Context, name: String) {
        val file = File(context.getExternalFilesDir(null), name)
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().also { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
}
