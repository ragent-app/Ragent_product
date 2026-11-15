package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import com.andysagent.ragent.core.network.ApiException
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
import org.json.JSONObject

/** Opt-in simultaneous reads through the phone's existing automatic targets. */
@RunWith(AndroidJUnit4::class)
class AccountMultiTargetStabilityLiveTest {
    @Test fun reportConnectionEntitlement(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveMultiTargetEntitlement") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val usage = runtime.accountSessions.getAccountUsage()
            val computers = runtime.discoverAccountComputers()
            instrumentation.sendStatus(2, Bundle().apply {
                putInt("usageComputerLimit", usage.turn.limits.computers)
                putBoolean("discoveryUnlimited", computers.firstOrNull()?.unlimitedConnections == true)
                putInt("discoveryComputerLimit", computers.firstOrNull()?.maximumConcurrentConnections ?: -1)
                putInt("discoveredCount", computers.size)
            })
        }
    }
    @Test fun legacyDemoPermissionDenialIsIdentified(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveLegacyPermission") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val target = runtime.configStore.directory.first().computers.single { it.label == "Ragent Demo · Codex Luna" }.instanceId
            withTimeout(90_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
            val policy = runtime.executeOnTarget(target, ApiRequest("GET", "/api/account-policy"))
            assertEquals(200, policy.statusCode)
            val original = JSONObject(policy.body).getJSONObject("policy").getString("permissionPolicy")
            val denial = try {
                runtime.executeOnTarget(target, ApiRequest("PATCH", "/api/account-policy",
                    body = JSONObject().put("permissionPolicy", original).toString(), requestId = "honor-legacy-policy-probe"))
                error("The legacy instance unexpectedly accepted a policy update")
            } catch (error: ApiException) { error }
            instrumentation.sendStatus(2, Bundle().apply {
                putInt("legacyPolicyPatchStatus", denial.statusCode)
                putString("legacyPolicyPatchCode", denial.code ?: "")
            })
            assertEquals(403, denial.statusCode)
            assertEquals("WORKBENCH_EXECUTION_POLICY_DENIED", denial.code)
        }
    }
    @Test fun largeBackgroundSummaryResponseIsDelivered(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveLargeResponse") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val primary = requireNotNull(directory.activeTarget).instanceId
            val target = directory.computers.first { it.autoConnect && it.instanceId != primary }.instanceId
            withTimeout(150_000) { runtime.targetConnectionStates.first { it[target] == RuntimeConnectionState.Connected } }
            val response = withTimeout(30_000) { runtime.executeOnTarget(target,
                ApiRequest("GET", "/api/runtime/summary/events?afterCursor=0&limit=100")) }
            assertEquals(200, response.statusCode)
            val bytes = response.body.toByteArray(Charsets.UTF_8).size
            assertTrue("The live response must exceed the legacy 256 KiB encoded frame", bytes > 192 * 1024)
            val events = JSONObject(response.body).getJSONArray("events").length()
            assertTrue("The live response must contain real events", events > 0)
            assertEquals(RuntimeConnectionState.Connected, runtime.targetConnectionStates.value[target])
            instrumentation.sendStatus(1, Bundle().apply {
                putInt("largeResponseBodyBytes", bytes)
                putInt("largeResponseEvents", events)
                putString("largeResponseResult", "complete-and-decoded")
            })
        }
    }

    @Test fun automaticTargetsStayUsableConcurrently(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveMultiTargetStability") == "true")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val directory = runtime.configStore.directory.first()
            val selected = requireNotNull(directory.activeTarget).instanceId
            val targets = directory.computers.filter { it.autoConnect }.map { it.instanceId }.distinct()
            assertTrue("This live probe requires at least two existing automatic targets", targets.size >= 2)
            val labels = targets.mapIndexed { index, id -> id to if (id == selected) "primary" else "background-$index" }.toMap()
            val flows = targets.associateWith { runtime.targetConnectivity(it) }
            // Observe automatic recovery before sending requests that might create a lease.
            withTimeout(150_000) { runtime.targetConnectionStates.first { states ->
                targets.all { states[it] == RuntimeConnectionState.Connected }
            } }
            var dropped = false
            val started = SystemClock.elapsedRealtime()
            val transitions = mutableListOf<String>()
            val previous = mutableMapOf<String, RuntimeConnectionState?>()
            val watcher = launch(start = CoroutineStart.UNDISPATCHED) {
                runtime.targetConnectionStates.collect { states ->
                    for (target in targets) {
                        val state = states[target]
                        if (previous[target] != state) transitions.add("${SystemClock.elapsedRealtime() - started}:${labels[target]}:${state?.name ?: "absent"}")
                        previous[target] = state
                        if (state != RuntimeConnectionState.Connected) dropped = true
                    }
                }
            }
            val diagnostics = mutableListOf<String>()
            val diagnosticWatchers = flows.map { (target, flow) ->
                launch(start = CoroutineStart.UNDISPATCHED) {
                    var previousReason = ""
                    flow.collect { state ->
                        val reason = when {
                            state.lastError?.contains("health check", ignoreCase = true) == true -> "health-check"
                            state.lastError?.contains("health-probe-failed", ignoreCase = true) == true -> "health-probe-failed"
                            state.lastError?.contains("request-failed", ignoreCase = true) == true -> "request-failed"
                            state.lastError?.contains("DataChannel entered", ignoreCase = true) == true -> "data-channel-closed"
                            state.lastError?.contains("ICE connection entered", ignoreCase = true) == true -> "ice-closed"
                            state.lastError?.contains("TURN connection lost", ignoreCase = true) == true -> "turn-lost-other"
                            state.lastError?.contains("network", ignoreCase = true) == true -> "network"
                            state.lastError.isNullOrBlank() -> "none"
                            else -> "other"
                        }
                        val value = "${state.status.name}:$reason"
                        if (value != previousReason) diagnostics.add("${SystemClock.elapsedRealtime() - started}:${labels[target]}:$value")
                        previousReason = value
                    }
                }
            }
            var reads = 0
            var failedTarget = "none"
            try {
                while (SystemClock.elapsedRealtime() - started < 60_000) {
                    for (target in targets) {
                        try {
                            assertEquals(200, withTimeout(15_000) { runtime.executeOnTarget(target, ApiRequest("GET", "/api/projects")) }.statusCode)
                            reads++
                        } catch (error: Throwable) {
                            failedTarget = labels[target] ?: "unknown"
                            throw error
                        }
                    }
                    delay(10_000)
                }
                assertTrue("At least one automatic target lost its connected state", !dropped)
                assertEquals(selected, runtime.configStore.directory.first().activeTarget?.instanceId)
            } finally {
                instrumentation.sendStatus(1, Bundle().apply {
                    putLong("multiTargetObservationMs", SystemClock.elapsedRealtime() - started)
                    putInt("observedTargets", targets.size)
                    putInt("protectedReads", reads)
                    putBoolean("anyTargetStateDropped", dropped)
                    putString("failedTarget", failedTarget)
                    putString("targetStateTransitions", transitions.joinToString(","))
                    putString("connectivityDiagnostics", diagnostics.joinToString(","))
                })
                watcher.cancel(); diagnosticWatchers.forEach { it.cancel() }
            }
        }
    }
}
