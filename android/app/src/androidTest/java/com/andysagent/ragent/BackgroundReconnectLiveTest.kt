package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in live test; restores the original background auto-connect setting. */
class BackgroundReconnectLiveTest {
    @Test fun reconnectsBackgroundWithoutInterruptingPrimary(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveBackgroundReconnect") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        assertTrue("The phone must be awake for foreground connection acceptance",
            app.getSystemService(PowerManager::class.java).isInteractive)
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
            scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val primary = requireNotNull(directory.activeTarget).instanceId
            val background = directory.computers.single { it.instanceId != primary && it.autoConnect }
            val baselineAt = SystemClock.elapsedRealtime()
            val foregroundField = runtime.javaClass.getDeclaredField("foreground").apply { isAccessible = true }
            val baselineTransitions = mutableListOf<String>()
            val baselineObserver = launch(start = CoroutineStart.UNDISPATCHED) {
                var previous = ""
                while (true) {
                    val states = runtime.targetConnectionStates.value
                    val current = "foreground=${foregroundField.getBoolean(runtime)},primary=${states[primary]?.name},background=${states[background.instanceId]?.name}"
                    if (current != previous && baselineTransitions.size < 160) {
                        baselineTransitions.add("${SystemClock.elapsedRealtime() - baselineAt}:$current")
                        previous = current
                    }
                    delay(50)
                }
            }
            instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "awaiting-baseline") })
            var reconnectStartedAt: Long? = null
            try {
                withTimeout(150_000) { runtime.targetConnectionStates.first {
                    it[primary] == RuntimeConnectionState.Connected && it[background.instanceId] == RuntimeConnectionState.Connected
                } }
            } finally {
                baselineObserver.cancel()
                instrumentation.sendStatus(2, Bundle().apply {
                    putLong("baselineElapsedMs", SystemClock.elapsedRealtime() - baselineAt)
                    putString("baselinePrimaryState", runtime.targetConnectionStates.value[primary]?.name ?: "absent")
                    putString("baselineBackgroundState", runtime.targetConnectionStates.value[background.instanceId]?.name ?: "absent")
                    putString("baselineTransitions", baselineTransitions.joinToString(";"))
                    putString("baselinePrimaryTrace", connectionTraceSince(primary, baselineAt)
                        .joinToString(",") { "${it.elapsedMs - baselineAt}:${it.event}" })
                    putString("baselineBackgroundTrace", connectionTraceSince(background.instanceId, baselineAt)
                        .joinToString(",") { "${it.elapsedMs - baselineAt}:${it.event}" })
                })
            }
            var primaryDropped = false
            val started = SystemClock.elapsedRealtime()
            val transitions = mutableListOf<String>()
            val diagnosticTransitions = mutableListOf<String>()
            fun reasonCategory(reason: String?): String = when {
                reason.isNullOrBlank() -> "none"
                reason.contains("health-probe-failed") -> "health_probe_failed"
                reason.contains("request-failed") -> "request_failed"
                reason.contains("ICE connection") -> "ice_connection"
                reason.contains("DataChannel entered") -> "data_channel"
                reason.contains("default-network-changed") -> "network_changed"
                else -> "other"
            }
            val diagnosticObservers = listOf(primary to "primary", background.instanceId to "background").map { (id, label) ->
                val states = runtime.targetConnectivity(id)
                launch(start = CoroutineStart.UNDISPATCHED) {
                    states.collect { state ->
                        if (diagnosticTransitions.size < 100) diagnosticTransitions.add(
                            "${SystemClock.elapsedRealtime() - started}:$label:${state.status}:${reasonCategory(state.lastError)}")
                    }
                }
            }
            val observer = launch(start = CoroutineStart.UNDISPATCHED) {
                runtime.targetConnectionStates.collect { states ->
                    val selected = states[primary]
                    if (selected != RuntimeConnectionState.Connected) primaryDropped = true
                    if (transitions.size < 100) transitions.add("${SystemClock.elapsedRealtime() - started}:${selected?.name}:${states[background.instanceId]?.name}")
                }
            }
            try {
                instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "pause-background") })
                runtime.configStore.upsertComputer(background.copy(autoConnect = false), select = false)
                runtime.awaitLifecycleUpdate()
                withTimeout(30_000) { runtime.targetConnectionStates.first { it[background.instanceId] != RuntimeConnectionState.Connected } }
                val connectAt = SystemClock.elapsedRealtime()
                reconnectStartedAt = connectAt
                instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "reconnect") })
                val overlap = if (InstrumentationRegistry.getArguments().getString("liveForceOverlap") == "true") {
                    async { runCatching { runtime.withTargetRuntime(background.instanceId) { Unit } } }.also {
                        withTimeout(30_000) {
                            while (connectionTraceSince(background.instanceId, connectAt).none { marker ->
                                    marker.event == "rendezvous-recovery-entered"
                                }) delay(20)
                        }
                    }
                } else null
                val primaryDuringReconnect: kotlinx.coroutines.Deferred<Result<List<Long>>>? = if (InstrumentationRegistry.getArguments()
                        .getString("livePrimaryDuringReconnect") == "true") {
                    async(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            val requestAt = SystemClock.elapsedRealtime()
                            var transportAt = requestAt
                            val response = withTimeout(20_000) {
                                runtime.withTargetRuntime(primary) {
                                    transportAt = SystemClock.elapsedRealtime()
                                    it.transport.execute(ApiRequest("GET", "/api/projects"))
                                }
                            }
                            Result.success(listOf(response.statusCode.toLong(), SystemClock.elapsedRealtime() - requestAt,
                                SystemClock.elapsedRealtime() - connectAt, transportAt - requestAt))
                        } catch (error: Exception) {
                            currentCoroutineContext().ensureActive()
                            Result.failure<List<Long>>(error)
                        }
                    }
                } else null
                runtime.connectAccountComputerInBackground(background.instanceId, runtime.accountDeviceAlias)
                withTimeout(150_000) { runtime.targetConnectionStates.first { it[background.instanceId] == RuntimeConnectionState.Connected } }
                val overlapResult = overlap?.await()
                val readyMs = SystemClock.elapsedRealtime() - connectAt
                instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "await-primary-overlap") })
                val concurrentResult = primaryDuringReconnect?.await()
                val concurrentRead = concurrentResult?.getOrNull()
                concurrentResult?.exceptionOrNull()?.let { failure ->
                    instrumentation.sendStatus(2, Bundle().apply {
                        putString("primaryDuringReconnectFailure", failure.javaClass.simpleName)
                    })
                    // Let connection-state observers capture the recovery that
                    // was triggered by the failed request before reporting it.
                    delay(300)
                    throw failure
                }
                val primaryReadAt = SystemClock.elapsedRealtime()
                var primaryTransportAt = primaryReadAt
                instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "read-primary") })
                val primaryResponse = try {
                    withTimeout(20_000) {
                        runtime.withTargetRuntime(primary) {
                            primaryTransportAt = SystemClock.elapsedRealtime()
                            it.transport.execute(ApiRequest("GET", "/api/projects"))
                        }
                    }
                } catch (failure: com.andysagent.ragent.core.network.ApiException) {
                    instrumentation.sendStatus(2, Bundle().apply {
                        putString("primaryReadFailureCode", when (failure.code) {
                            "TURN_NETWORK_ERROR", "P2P_NETWORK_ERROR", "CARRIER_UNAVAILABLE" -> failure.code
                            else -> "other"
                        })
                        putLong("primaryReadFailureMs", SystemClock.elapsedRealtime() - primaryReadAt)
                    })
                    // Give the recovery flow time to publish its state before
                    // the observers in the finally block are cancelled.
                    delay(500)
                    throw failure
                }
                assertEquals(200, primaryResponse.statusCode)
                val primaryReadMs = SystemClock.elapsedRealtime() - primaryReadAt
                val backgroundReadAt = SystemClock.elapsedRealtime()
                instrumentation.sendStatus(2, Bundle().apply { putString("backgroundPhase", "read-background") })
                assertEquals(200, withTimeout(20_000) { runtime.executeOnTarget(background.instanceId, ApiRequest("GET", "/api/projects")) }.statusCode)
                val backgroundReadMs = SystemClock.elapsedRealtime() - backgroundReadAt
                instrumentation.sendStatus(2, Bundle().apply {
                    putLong("backgroundReconnectMs", SystemClock.elapsedRealtime() - connectAt)
                    putLong("backgroundCarrierReadyMs", readyMs)
                    putLong("primaryProjectReadMs", primaryReadMs)
                    putLong("primaryLeaseWaitMs", primaryTransportAt - primaryReadAt)
                    putLong("backgroundProjectReadMs", backgroundReadMs)
                    concurrentRead?.let {
                        putInt("primaryDuringReconnectStatus", it[0].toInt())
                        putLong("primaryDuringReconnectReadMs", it[1])
                        putLong("primaryDuringReconnectFinishedMs", it[2])
                        putLong("primaryDuringReconnectLeaseWaitMs", it[3])
                    }
                    putString("backgroundTrace", connectionTraceSince(background.instanceId, connectAt)
                        .joinToString(",") { "${it.elapsedMs - connectAt}:${it.event}" })
                    putBoolean("primaryDropped", primaryDropped)
                    putString("transitions", transitions.joinToString(","))
                })
                assertFalse("Reconnecting the background computer interrupted the primary", primaryDropped)
                concurrentRead?.let { assertEquals(200L, it[0]) }
                if (overlap != null) {
                    overlapResult?.getOrThrow()
                    assertEquals("Concurrent recovery and explicit connect must share a rendezvous", 1,
                        connectionTraceSince(background.instanceId, connectAt).count { it.event == "intent-create-start" })
                }
            } finally {
                observer.cancel()
                diagnosticObservers.forEach { it.cancel() }
                instrumentation.sendStatus(2, Bundle().apply {
                    putBoolean("primaryDroppedAtExit", primaryDropped)
                    reconnectStartedAt?.let { start ->
                        putString("backgroundTraceAtExit", connectionTraceSince(background.instanceId, start)
                            .joinToString(",") { "${it.elapsedMs - start}:${it.event}" })
                        putString("primaryTraceAtExit", connectionTraceSince(primary, start)
                            .joinToString(",") { "${it.elapsedMs - start}:${it.event}" })
                    }
                    putString("carrierDiagnosticTransitions", diagnosticTransitions.joinToString(";"))
                    putString("carrierStateTransitions", transitions.joinToString(","))
                })
                withContext(NonCancellable) {
                    val current = runtime.configStore.directory.first().computers.single { it.instanceId == background.instanceId }
                    runtime.configStore.upsertComputer(current.copy(autoConnect = background.autoConnect), select = false)
                    runtime.awaitLifecycleUpdate()
                }
            }
        }
    }
}
