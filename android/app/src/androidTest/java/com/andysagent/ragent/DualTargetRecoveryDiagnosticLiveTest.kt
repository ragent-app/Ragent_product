package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in, bounded connection diagnostics with no identifiers or payloads in output. */
class DualTargetRecoveryDiagnosticLiveTest {
    @Test fun observesAutomaticTargetRecovery(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveDualRecoveryDiagnostic") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val primary = requireNotNull(directory.activeTarget).instanceId
            val background = directory.computers.first { it.autoConnect && it.instanceId != primary }.instanceId
            val targets = mapOf("primary" to primary, "background" to background)
            val start = SystemClock.elapsedRealtime()
            val diagnostics = mutableListOf<String>()
            val observers = targets.map { (label, id) ->
                val flow = runtime.targetConnectivity(id)
                launch(start = CoroutineStart.UNDISPATCHED) {
                    var previous = ""
                    flow.collect { state ->
                        val error = state.lastError.orEmpty()
                        val kind = when {
                            error.isBlank() -> "none"
                            error.contains("401") -> "http-401"
                            error.contains("403") -> "http-403"
                            error.contains("429") -> "http-429"
                            error.contains("timeout", true) || error.contains("timed out", true) -> "timeout"
                            error.contains("network", true) -> "network"
                            error.contains("bootstrap", true) -> "bootstrap"
                            error.contains("session", true) -> "session"
                            error.contains("DataChannel", true) -> "data-channel"
                            error.contains("ICE", true) -> "ice"
                            else -> "other"
                        }
                        val current = "${state.status.name}:$kind"
                        if (current != previous && diagnostics.size < 100) diagnostics.add("${SystemClock.elapsedRealtime() - start}:$label:$current")
                        previous = current
                    }
                }
            }
            var success = false
            try {
                withTimeout(60_000) { runtime.targetConnectionStates.first { states ->
                    targets.values.all { states[it] == RuntimeConnectionState.Connected }
                } }
                for (id in targets.values) assertEquals(200, withTimeout(15_000) {
                    runtime.executeOnTarget(id, ApiRequest("GET", "/api/projects"))
                }.statusCode)
                success = true
            } finally {
                observers.forEach { it.cancel() }
                instrumentation.sendStatus(1, Bundle().apply {
                    putBoolean("dualRecoveryCompleted", success)
                    putLong("dualRecoveryElapsedMs", SystemClock.elapsedRealtime() - start)
                    putString("dualRecoveryDiagnostics", diagnostics.joinToString(","))
                })
            }
        }
    }
}
