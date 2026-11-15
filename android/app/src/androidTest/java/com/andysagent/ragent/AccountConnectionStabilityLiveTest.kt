package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in live protected reads while observing the already selected target. */
@RunWith(AndroidJUnit4::class)
class AccountConnectionStabilityLiveTest {
    @Test fun selectedTargetRemainsUsableDuringObservation(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveConnectionStability") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val selected = requireNotNull(runtime.configStore.directory.first().activeTarget).instanceId
            withTimeout(150_000) { runtime.targetConnectionStates.first { it[selected] == RuntimeConnectionState.Connected } }
            var dropped = false
            val started = SystemClock.elapsedRealtime()
            val transitions = mutableListOf<String>()
            var previousState: RuntimeConnectionState? = null
            val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
                runtime.targetConnectionStates.collect {
                    val state = it[selected]
                    if (state != previousState) transitions.add("${SystemClock.elapsedRealtime() - started}:${state?.name ?: "absent"}")
                    previousState = state
                    if (state != RuntimeConnectionState.Connected) dropped = true
                }
            }
            val diagnostics = mutableListOf<String>()
            val diagnosticFlow = runtime.targetConnectivity(selected)
            val diagnosticWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                diagnosticFlow.collect { state ->
                    val reason = when {
                        state.lastError?.contains("health check", ignoreCase = true) == true -> "health-check"
                        state.lastError?.contains("TURN connection lost", ignoreCase = true) == true -> "turn-lost"
                        state.lastError?.contains("network", ignoreCase = true) == true -> "network"
                        state.lastError.isNullOrBlank() -> "none"
                        else -> "other"
                    }
                    diagnostics.add("${SystemClock.elapsedRealtime() - started}:${state.status.name}:$reason")
                }
            }
            var reads = 0
            try {
                while (SystemClock.elapsedRealtime() - started < 90_000) {
                    assertEquals(200, withTimeout(15_000) { runtime.transport.execute(ApiRequest("GET", "/api/projects")) }.statusCode)
                    reads++
                    delay(10_000)
                }
                instrumentation.sendStatus(1, Bundle().apply {
                    putLong("observationMs", SystemClock.elapsedRealtime() - started)
                    putInt("protectedReads", reads)
                    putBoolean("connectionStateDropped", dropped)
                    putString("targetStateTransitions", transitions.joinToString(","))
                    putString("connectivityDiagnostics", diagnostics.joinToString(","))
                })
                assertTrue("Selected target lost its connected state during the observation", !dropped)
                assertEquals(selected, runtime.configStore.directory.first().activeTarget?.instanceId)
            } finally { watcher.cancel(); diagnosticWatcher.cancel() }
        }
    }
}
