package com.andysagent.ragent

import android.graphics.Bitmap
import androidx.annotation.StringRes
import androidx.compose.runtime.MutableState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.feature.workbench.GoogleSignInRequest
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Injected presentation evidence on the installed app; no network fault or sign-in is generated. */
@RunWith(AndroidJUnit4::class)
class ComputerConnectionErrorDeviceUiTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)

    private fun MainActivity.report(error: Throwable) {
        MainActivity::class.java.getDeclaredMethod("reportComputerConnectionFailure", Throwable::class.java)
            .apply { isAccessible = true }
            .invoke(this, error)
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> MainActivity.state(name: String): MutableState<T> =
        MainActivity::class.java.getDeclaredField("${name}\$delegate")
            .apply { isAccessible = true }
            .get(this) as MutableState<T>

    private fun ActivityScenario<MainActivity>.localized(@StringRes res: Int, vararg args: Any): String {
        var value = ""
        onActivity { value = it.getString(res, *args) }
        return value
    }

    private fun assertSheet(title: String, detail: String) {
        assertTrue("Connection sheet did not appear", device.wait(Until.hasObject(By.text(title)), 10_000))
        assertTrue("Connection detail was not visible", device.hasObject(By.text(detail)))
        assertFalse("Connection error showed a Google sign-in title", device.hasObject(By.text("Google sign-in unavailable")))
    }

    private fun capture(name: String) {
        Thread.sleep(600) // Let the platform dialog settle before capturing the physical display.
        val file = File(checkNotNull(instrumentation.targetContext.getExternalFilesDir("connection-error-ui")), name)
        val screenshot = checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        FileOutputStream(file).use { output ->
            check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        screenshot.recycle()
        assertTrue("Screenshot is empty", file.length() > 0)
    }

    private fun closeSheet(title: String, confirmLabel: String) {
        val ok = device.wait(Until.findObject(By.text(confirmLabel)), 5_000)
        assertTrue("OK action did not appear", ok != null)
        ok.click()
        assertTrue("Connection sheet did not close", device.wait(Until.gone(By.text(title)), 5_000))
    }

    @Test fun transportErrorUsesConnectionSheetAndCanBeDismissedAndShownAgain() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val title = scenario.localized(R.string.computer_connection_unsuccessful)
            val detail = scenario.localized(R.string.computer_connection_unavailable)
            val confirmLabel = scenario.localized(R.string.computer_connection_confirm)
            scenario.onActivity { it.report(IllegalStateException("transport unavailable")) }
            assertSheet(title, detail)
            capture("transport-injected.png")
            closeSheet(title, confirmLabel)
            scenario.onActivity { activity ->
                assertNull(activity.state<ConnectionErrorCopy?>("computerConnectionError").value)
                activity.report(IllegalStateException("retry transport unavailable"))
            }
            assertSheet(title, detail)
            device.pressBack()
            assertTrue("Back did not close the connection sheet", device.wait(Until.gone(By.text(title)), 5_000))
        }
    }

    @Test fun rateLimitUsesConnectionSheetAndRetryDelay() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val title = scenario.localized(R.string.computer_connection_unsuccessful)
            val detail = scenario.localized(R.string.computer_connection_busy_retry_after, 3L)
            val confirmLabel = scenario.localized(R.string.computer_connection_confirm)
            scenario.onActivity {
                it.report(AccountSessionException(
                    statusCode = 429,
                    code = "owner_auth_rate_limited",
                    message = "busy",
                    retryable = true,
                    retryAfterMs = 2_100L,
                ))
            }
            assertSheet(title, detail)
            capture("rate-limit-injected.png")
            closeSheet(title, confirmLabel)
        }
    }

    @Test fun account401And403RouteToReauthorizationWithoutConnectionSheet() {
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val accountBefore = runBlocking { app.runtime.configStore.accountSession.first() }
        assertNotNull("A signed-in account is required for this device check", accountBefore)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val pending = activity.state<GoogleSignInRequest?>("pendingGoogleSignIn")
                val connection = activity.state<ConnectionErrorCopy?>("computerConnectionError")
                val googleError = activity.state<String?>("googleSignInError")
                for (status in listOf(401, 403)) {
                    activity.report(AccountSessionException(status, "account_session_expired", "expired"))
                    assertEquals(GoogleSignInRequest.ManageDevices, pending.value)
                    assertNull(connection.value)
                    assertNull(googleError.value)
                    // Clear before the next frame, so this fixture never launches Credential Manager.
                    pending.value = null
                }
            }
            assertFalse(device.hasObject(By.text(scenario.localized(R.string.computer_connection_unsuccessful))))
        }
        val accountAfter = runBlocking { app.runtime.configStore.accountSession.first() }
        assertEquals(accountBefore?.accountId, accountAfter?.accountId)
    }
}
