package com.andysagent.ragent

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiRequest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Call
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.security.MessageDigest
import java.util.Collections
import java.util.IdentityHashMap

/** Test-only observation of existing clients. Never replaces clients or reads credentials. */
class AccountConnectionTimingLiveProbeTest {
    private class ObservedCall(val client: String, val stage: String, val firstSeenMs: Long) {
        var lastSeenMs = firstSeenMs
        var finishedObservedMs: Long? = null
        var queuedObserved = false
        var runningObserved = false
        fun json() = JSONObject().put("client", client).put("stage", stage)
            .put("firstSeenMs", firstSeenMs).put("lastSeenMs", lastSeenMs)
            .put("finishedObservedMs", finishedObservedMs ?: JSONObject.NULL)
            .put("queuedObserved", queuedObserved).put("runningObserved", runningObserved)
    }

    private fun stage(path: String): String? {
        val local = path.removePrefix("/accounts")
        return when {
            local == "/v1/owner-auth/rendezvous" -> "rendezvous-create"
            Regex("^/v1/owner-auth/account-intents/[^/]+/authorize$").matches(local) -> "rendezvous-authorize"
            Regex("^/v1/owner-auth/rendezvous/[^/]+/result$").matches(local) -> "rendezvous-result-wait"
            Regex("^/v1/owner-auth/rendezvous/[^/]+/grant$").matches(local) -> "rendezvous-grant"
            local == "/v1/owner-auth/account/turn/connections" -> "cold-turn-inventory"
            local == "/v1/owner-auth/account/turn/connections/release" -> "cold-turn-release"
            local == "/v1/owner-auth/native/session/refresh" -> "account-refresh"
            else -> null
        }
    }

    private fun existingClients(manager: Any): List<Pair<String, OkHttpClient>> =
        listOf("anonymousTransport" to "accounts-public", "authenticatedTransport" to "accounts-auth").map { (field, label) ->
            val transport = manager.javaClass.getDeclaredField(field).apply { isAccessible = true }.get(manager)
            val client = transport.javaClass.getDeclaredField("client").apply { isAccessible = true }.get(transport)
            label to (client as OkHttpClient)
        }

    @Test fun observesFixedTargetColdConnectionStages(): Unit = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveConnectionTimingProbe") == "true")
        val started = SystemClock.elapsedRealtime()
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val runtime = app.runtime
        val clients = existingClients(runtime.accountSessions)
        val calls = IdentityHashMap<Call, ObservedCall>()
        val records = mutableListOf<ObservedCall>()
        var maximumSampleGapMs = 0L
        var droppedCalls = 0
        var previousSampleMs = 0L
        val milestones = JSONArray()
        fun milestone(stage: String, state: String? = null) {
            if (milestones.length() < 64) milestones.put(JSONObject().put("stage", stage)
                .put("atMs", SystemClock.elapsedRealtime() - started).apply { state?.let { put("state", it) } })
        }
        val sampler = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
            while (true) {
                val now = SystemClock.elapsedRealtime() - started
                if (previousSampleMs != 0L) maximumSampleGapMs = maxOf(maximumSampleGapMs, now - previousSampleMs)
                previousSampleMs = now
                val present = Collections.newSetFromMap(IdentityHashMap<Call, Boolean>())
                for ((label, client) in clients) {
                    for ((queued, snapshot) in listOf(true to client.dispatcher.queuedCalls(), false to client.dispatcher.runningCalls())) {
                        for (call in snapshot) {
                            val category = stage(call.request().url.encodedPath) ?: continue
                            present.add(call)
                            val observed = calls[call] ?: if (records.size < 128) {
                                ObservedCall(label, category, now).also { calls[call] = it; records.add(it) }
                            } else { droppedCalls++; continue }
                            observed.lastSeenMs = now
                            if (queued) observed.queuedObserved = true else observed.runningObserved = true
                        }
                    }
                }
                for ((call, observed) in calls.toMap()) if (!present.contains(call)) {
                    observed.finishedObservedMs = now
                    calls.remove(call)
                }
                delay(25)
            }
        }
        var completed = false
        try {
            // Setup may precede this point; subtract it from the same monotonic
            // cooperative budget. The host separately caps instrumentation at210s
            // because synchronous Android activity launch cannot be cancelled here.
            withTimeout((started + 150_000L - SystemClock.elapsedRealtime()).coerceAtLeast(1L)) {
                val selected = requireNotNull(withTimeout(30_000) { runtime.configStore.directory.first { it.activeTarget != null } }.activeTarget)
                val fingerprint = MessageDigest.getInstance("SHA-256").digest(selected.instanceId.toByteArray())
                    .joinToString("") { "%02x".format(it) }
                assertEquals("Only the isolated full review target may be observed",
                    "f6ab06e70a1c80e97edb27121d3483be1a9a75f4be458faed34f7113cc4083b5", fingerprint)
                milestone("observer-attached")
                ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use { scenario ->
                    scenario.onActivity { it.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
                    withTimeout(150_000) {
                        runtime.targetConnectionStates.onEach { states -> milestone("primary-state", states[selected.instanceId]?.name ?: "absent") }
                            .first { states -> states[selected.instanceId] == RuntimeConnectionState.Connected }
                    }
                    milestone("primary-connected")
                    milestone("protected-auth-start")
                    assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/auth/me")).statusCode)
                    milestone("protected-auth-end")
                    assertEquals(200, runtime.transport.execute(ApiRequest("GET", "/api/projects")).statusCode)
                    milestone("protected-projects-end")
                    assertEquals(selected.instanceId, runtime.configStore.directory.first().activeTarget?.instanceId)
                    completed = true
                }
            }
        } finally {
            sampler.cancelAndJoin()
            // App initialization can precede test attachment. Sampled request
            // bounds include scheduler error and are not DNS/TLS/server timings.
            val report = JSONObject().put("completed", completed).put("completeStartupCoverage", false)
                .put("observation", "existing-dispatchers-read-only").put("sampleIntervalMs", 25)
                .put("cooperativeBudgetMs", 150_000).put("hostInstrumentationLimitMs", 210_000)
                .put("callTargetAttribution", "shared-account-clients-unattributed")
                .put("sampledCallsMayIncludeBackgroundTargets", true)
                .put("selectedTargetScope", "connection-state-and-protected-reads-only")
                .put("maximumSampleGapMs", maximumSampleGapMs).put("droppedCalls", droppedCalls)
                .put("requestBounds", JSONArray(records.map { it.json() })).put("milestones", milestones)
                .put("requestsMutated", false).put("headersBodiesUrlsOrCredentialsCaptured", false)
            instrumentation.sendStatus(1, Bundle().apply { putString("fixedStageTiming", report.toString()) })
        }
    }
}
