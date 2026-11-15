package com.andysagent.ragent

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in physical-device test; restores Wi-Fi even if a check fails. */
@RunWith(AndroidJUnit4::class)
class AccountNetworkRecoveryLiveTest {
    @Test fun bothTargetsServeRequestsAfterWifiInterruption(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveNetworkRecovery") == "true")
        fun shell(command: String): String = android.os.ParcelFileDescriptor.AutoCloseInputStream(
            instrumentation.uiAutomation.executeShellCommand(command),
        ).bufferedReader().use { it.readText() }
        assumeTrue("Wi-Fi must initially be enabled", shell("cmd wifi status").contains("Wifi is enabled"))
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val targets = runtime.configStore.directory.first().computers.filter { it.autoConnect }
                .map { it.instanceId }.distinct()
            assertTrue("At least two automatic targets are required", targets.size >= 2)
            suspend fun waitForConnected() = withTimeout(150_000) {
                runtime.targetConnectionStates.first { states -> targets.all { states[it] == RuntimeConnectionState.Connected } }
            }
            suspend fun verifyRequests() {
                for (target in targets) {
                    val response = withTimeout(15_000) { runtime.executeOnTarget(target, ApiRequest("GET", "/api/projects")) }
                    assertEquals(200, response.statusCode)
                }
            }
            waitForConnected()
            verifyRequests()
            var wifiRestoredAt = 0L
            try {
                shell("svc wifi disable")
                withTimeout(15_000) {
                    runtime.targetConnectionStates.first { states -> targets.all { states[it] != RuntimeConnectionState.Connected } }
                }
                delay(6_000)
                val connectivity = app.getSystemService(ConnectivityManager::class.java)
                val networkReady = async {
                    withTimeout(120_000) {
                        while (true) {
                            val network = connectivity.activeNetwork
                            val capabilities = network?.let { connectivity.getNetworkCapabilities(it) }
                            if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
                                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) break
                            delay(50)
                        }
                        SystemClock.elapsedRealtime()
                    }
                }
                wifiRestoredAt = SystemClock.elapsedRealtime()
                shell("svc wifi enable")
                waitForConnected()
                val connectedAfterMs = SystemClock.elapsedRealtime() - wifiRestoredAt
                val networkReadyAfterMs = networkReady.await() - wifiRestoredAt
                verifyRequests()
                instrumentation.sendStatus(1, Bundle().apply {
                    putInt("targetCount", targets.size)
                    putLong("validatedWifiAfterRestoreMs", networkReadyAfterMs)
                    putLong("bothConnectedAfterWifiRestoreMs", connectedAfterMs)
                    putLong("bothConnectedAfterValidatedWifiMs", (connectedAfterMs - networkReadyAfterMs).coerceAtLeast(0L))
                    putLong("bothRequestsSucceededAfterWifiRestoreMs", SystemClock.elapsedRealtime() - wifiRestoredAt)
                    targets.forEachIndexed { index, target ->
                        putString("recoveryTrace$index", connectionTraceSince(target, wifiRestoredAt)
                            .joinToString(",") { "${it.elapsedMs - wifiRestoredAt}:${it.event}" })
                    }
                })
                assertTrue("Both targets must reconnect within five seconds after Wi-Fi validation",
                    connectedAfterMs - networkReadyAfterMs <= 5_000L)
            } finally {
                shell("svc wifi enable")
            }
        }
    }
}
