package com.andysagent.ragent

import android.os.Bundle
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.auth.AccountSessionException
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.cancelAndJoin
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in acceptance of the existing account; never logs bearers or replaces credentials. */
class ReviewAccountLiveAcceptanceTest {
    @Test fun existingReviewerCanDiscoverAndConnectToItsAuthorizedServer() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveHonorAcceptance") == "ADNQ6R5716008635")
        val app = instrumentation.targetContext.applicationContext as RagentApplication
        val graph = app.runtime
        val startedAt = android.os.SystemClock.elapsedRealtime()
        var verifiedAt = startedAt
        fun report(stage: String) = instrumentation.sendStatus(2, Bundle().apply {
            putString("acceptanceStage", stage); putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - startedAt)
        })
        var stage = "verify-account"
        var targetTrace: kotlinx.coroutines.Job? = null
        var restoreHttpClient: (() -> Unit)? = null
        try {
            if (InstrumentationRegistry.getArguments().getString("traceTargetConnection") == "1") {
                val transportField = graph.javaClass.getDeclaredField("accountsDirectoryTransport").apply { isAccessible = true }
                val accountTransport = transportField.get(graph)
                val clientField = accountTransport.javaClass.getDeclaredField("client").apply { isAccessible = true }
                val previousClient = clientField.get(accountTransport) as okhttp3.OkHttpClient
                val tracedClient = previousClient.newBuilder().eventListenerFactory {
                    object : okhttp3.EventListener() {
                        private var requestStarted = 0L
                        private fun label(call: okhttp3.Call): String? {
                            val path = call.request().url.encodedPath.let { raw ->
                                val apiStart = raw.indexOf("/v1/")
                                if (apiStart >= 0) raw.substring(apiStart) else raw
                            }
                            return when {
                                path == "/v1/owner-auth/rendezvous" -> "rendezvous-create"
                                path.startsWith("/v1/owner-auth/account-intents/") && path.endsWith("/authorize") -> "rendezvous-authorize"
                                path.startsWith("/v1/owner-auth/rendezvous/") && path.endsWith("/result") -> "rendezvous-result"
                                path.startsWith("/v1/owner-auth/account/turn/connections") -> "turn-lease-control"
                                else -> null
                            }
                        }
                        override fun callStart(call: okhttp3.Call) {
                            requestStarted = android.os.SystemClock.elapsedRealtime()
                            label(call)?.let { report("http-start:$it") }
                        }
                        override fun responseHeadersEnd(call: okhttp3.Call, response: okhttp3.Response) {
                            label(call)?.let { report("http-response:$it,status=${response.code},durationMs=${android.os.SystemClock.elapsedRealtime() - requestStarted}") }
                        }
                    }
                }.build()
                clientField.set(accountTransport, tracedClient)
                restoreHttpClient = { clientField.set(accountTransport, previousClient) }
            }
            instrumentation.runOnMainSync {
                app.startActivity(android.content.Intent(app, MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            instrumentation.waitForIdleSync()
            val session = withTimeout(15_000) { graph.ensureAccountSession() }
            check(session.accountId.matches(Regex("^acct_demo_[a-f0-9]{48}$"))) { "Expected existing review account" }
            verifiedAt = android.os.SystemClock.elapsedRealtime()
            report("verified-review-account")
            if (InstrumentationRegistry.getArguments().getString("requireFullAccount") == "1") {
                check(session.demoAccessMode == "full") { "Signed account presentation remains restricted" }
                report("verified-full-account-presentation")
            }
            stage = "discover-authorized-computers"
            val computers = withTimeout(15_000) { graph.discoverAccountComputers() }
            report("authorized-computers:${computers.size}")
            check(computers.isNotEmpty()) { "No authorized computers" }
            val requestedTarget = InstrumentationRegistry.getArguments().getString("reviewInstanceId")
            val target = if (requestedTarget.isNullOrBlank()) computers.first().instanceId else {
                check(computers.any { it.instanceId == requestedTarget }) { "Requested instance is outside the verified directory" }
                requestedTarget
            }
            if (InstrumentationRegistry.getArguments().getString("traceTargetConnection") == "1") {
                val runtimesField = graph.javaClass.getDeclaredField("targetRuntimes").apply { isAccessible = true }
                targetTrace = launch {
                    var previous = ""
                    while (isActive) {
                        val runtime = (runtimesField.get(graph) as Map<*, *>)[target] as? TargetRuntime
                        val controller = runtime?.controller
                        val state = controller?.connectivityState?.value
                        val planPresent = controller?.javaClass?.getDeclaredField("plan")?.apply { isAccessible = true }?.get(controller) != null
                        // Deliberately omit endpoint, credentials, contract and error text.
                        val safe = "runtime=${runtime != null},plan=$planPresent,status=${state?.status},transport=${state?.transport},retries=${state?.retryCount}"
                        if (safe != previous) { report("fixed-target:$safe"); previous = safe }
                        delay(10)
                    }
                }
            }
            val initField = graph.javaClass.getDeclaredField("initialized").apply { isAccessible = true }
            val initialized = initField.get(graph) as kotlinx.coroutines.Deferred<*>
            report("runtime-initialized:${initialized.isCompleted}")
            val directory = graph.configStore.directory.first()
            report("retained-target-count:${directory.computers.size}")
            stage = "connect-authorized-computer"
            withTimeout(40_000) { graph.ensureDemoComputerConnection(session.accountId, target) }
            report("pairing-operation-complete")
            stage = "verify-protected-carrier"
            withTimeout(15_000) { graph.transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            check(graph.configStore.directory.first().activeTargetId == target) { "Connected target selection changed" }
            val verifiedToReady = android.os.SystemClock.elapsedRealtime() - verifiedAt
            report("verified-to-carrier-ready-ms:$verifiedToReady")
            if (!requestedTarget.isNullOrBlank()) {
                val providers = withTimeout(15_000) { graph.executeOnTarget(target,
                    com.andysagent.ragent.core.network.ApiRequest(method = "GET", path = "/api/native-providers")) }
                check(providers.body.contains("Review-Codex-Luna-258fa203")) { "Full candidate supplied Provider missing" }
                report("full-candidate-provider-confirmed")
            }
            InstrumentationRegistry.getArguments().getString("inspectSessionId")?.let { id ->
                val response = graph.executeOnTarget(target,
                    com.andysagent.ragent.core.network.ApiRequest(method = "GET", path = "/api/sessions/$id/events?filter=all"))
                val envelope = org.json.JSONObject(response.body)
                val events = envelope.optJSONArray("events")
                report("event-envelope:${envelope.keys().asSequence().toList().sorted().joinToString(",")}")
                report("event-sequences:" + (0 until (events?.length() ?: 0)).joinToString(";") { index ->
                    val event = events!!.getJSONObject(index)
                    listOf("seq", "firstSeq", "lastEventSeq", "endSeq", "mergedEndSeq", "type", "messageState")
                        .filter(event::has).joinToString(",") { key -> "$key=${event.opt(key)}" }
                })
                val result = graph.sessions.refreshTimeline(id)
                report("explicit-timeline-refresh:${result.javaClass.simpleName}")
                report("persisted-message-count:${graph.sessions.observeMessages(id).first().size}")
            }
            report("protected-carrier-connected")
            report("verified-to-ready-ms:$verifiedToReady")
            if (InstrumentationRegistry.getArguments().getString("requireFiveSeconds") == "1") {
                check(verifiedToReady <= 5_000) { "Verified account connection exceeded five seconds" }
            }
        } catch (error: Exception) {
            val safe = if (error is AccountSessionException) "${error.statusCode}:${error.code}" else error.javaClass.simpleName
            throw AssertionError("Honor live acceptance failed at $stage [$safe]")
        } finally {
            targetTrace?.cancelAndJoin()
            restoreHttpClient?.invoke()
        }
    }
}
