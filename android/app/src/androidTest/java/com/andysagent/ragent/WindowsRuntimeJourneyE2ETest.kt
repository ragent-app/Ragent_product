package com.andysagent.ragent

import androidx.lifecycle.ProcessLifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.domain.RefreshResult
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.model.Session
import com.andysagent.ragent.core.model.SessionStatus
import com.andysagent.ragent.core.network.ConnectionStatus
import com.andysagent.ragent.core.network.TransportKind
import com.andysagent.ragent.core.timeline.TimelineItem
import com.andysagent.ragent.core.timeline.TimelineRole
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assume.assumeTrue
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in Android -> Windows runtime journey.
 *
 * The journey accepts either a bound invitation or an already signed-in
 * Accounts session plus an account directory instance id. The latter is the
 * endpoint-less direct-connect path used by Manage devices; it deliberately
 * obtains the target credential through Accounts rendezvous instead of opening
 * a Google sign-in UI or transporting a bearer token through instrumentation.
 * A v3 invitation that is still provisional is skipped: it cannot obtain a
 * TURN-first bootstrap by contract.
 *
 * Example:
 *   adb shell am instrument -w \
 *     -e class com.andysagent.ragent.WindowsRuntimeJourneyE2ETest \
 *     -e accountComputerInstanceId 'inst_windows' \
 *     com.andysagent.ragent.test/androidx.test.runner.AndroidJUnitRunner
 *
 * Use `pairingUri` instead of `accountComputerInstanceId` for the bound-QR
 * variant. The account variant requires the app's persisted `rac_` session.
 */
@RunWith(AndroidJUnit4::class)
class WindowsRuntimeJourneyE2ETest {

    @Test
    fun createsStreamsCancelsRecoversAndReconnectsP2P() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val pairingUri = args.getString("pairingUri")
        val accountComputerInstanceId = args.getString("accountComputerInstanceId")
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        assumeTrue(
            "Windows runtime journey requires -e accountComputerInstanceId <instance> or -e pairingUri <bound invitation>",
            !pairingUri.isNullOrBlank() || accountComputerInstanceId != null,
        )

        val app = InstrumentationRegistry.getInstrumentation().targetContext
            .applicationContext as RagentApplication
        val runtime = app.runtime
        val deviceName = args.getString("deviceName")?.ifBlank { null } ?: "Android Windows E2E"
        val pairing = if (accountComputerInstanceId != null) {
            // This is the same operation triggered by Manage devices after it
            // verifies the stored account session. No GoogleSignInHelper is
            // involved, so a successful run is evidence that Connect did not
            // fall back to a login prompt.
            runtime.ensureAccountSession()
            runtime.pairFromAccountComputer(accountComputerInstanceId, deviceName)
        } else {
            runtime.pairing.redeem(pairingUri!!, deviceName)
        }
        val token = runtime.credentialStore.readToken(pairing.instanceId)
        if (pairing.credentialScope != "device-access" || !token.orEmpty().startsWith("rda_")) {
            // Do not leave a provisional QR enrollment selected after a smoke
            // invocation. Account binding is an external prerequisite, not a
            // condition this test is allowed to fake.
            runtime.credentialStore.clear(pairing.instanceId)
            runtime.p2pSecretStore.clear(pairing.instanceId)
            runtime.configStore.removeTarget(pairing.instanceId)
            assumeTrue(
                "Windows runtime journey requires a bound device credential from Accounts rendezvous or QR",
                false,
            )
            return@runBlocking
        }

        kotlinx.coroutines.withContext(Dispatchers.Main) { runtime.onStart(ProcessLifecycleOwner.get()) }
        awaitTransport(runtime, pairing.instanceId, TransportKind.Turn)
        awaitTransport(runtime, pairing.instanceId, TransportKind.P2P)

        val syncScope = CoroutineScope(Dispatchers.IO)
        try {
            val repository = runtime.sessions
            val marker = "ragent-android-windows-stream-ok"

            val first = repository.createSession(
                name = "Android Windows stream journey",
                tool = args.getString("runtimeTool")?.ifBlank { null } ?: "codex",
            )
            val firstSync = startEventSync(syncScope, repository, first.id)
            try {
                val streamed = syncScope.async {
                    withTimeout(180_000L) {
                        repository.observeTimeline(first.id).first { items ->
                            items.filterIsInstance<TimelineItem.Message>().any { item ->
                                item.role == TimelineRole.Agent &&
                                    item.completed &&
                                    item.text.contains(marker)
                            }
                        }
                    }
                }
                repository.sendMessage(
                    first.id,
                    "Reply with exactly $marker and no tools.",
                )
                val timeline = streamed.await()
                assertTrue(
                    "The assistant completion must be visible through the live-sync Room timeline",
                    timeline.filterIsInstance<TimelineItem.Message>().any { it.text.contains(marker) },
                )
            } finally {
                firstSync.cancel()
            }

            val second = repository.createSession(
                name = "Android Windows cancel journey",
                tool = args.getString("runtimeTool")?.ifBlank { null } ?: "codex",
            )
            val secondSync = startEventSync(syncScope, repository, second.id)
            try {
                repository.sendMessage(
                    second.id,
                    "Run a long task and keep working until cancelled. Do not finish quickly.",
                )
                awaitSessionStatus(repository, second.id, setOf(SessionStatus.Working))
                repository.cancelSession(second.id)
                val cancelled = awaitSessionStatus(
                    repository,
                    second.id,
                    setOf(SessionStatus.Cancelled, SessionStatus.Completed, SessionStatus.Failed),
                )
                assertTrue(
                    "Cancel must settle the run, got ${cancelled.status}",
                    cancelled.status == SessionStatus.Cancelled,
                )
            } finally {
                secondSync.cancel()
            }

            // Lifecycle recovery closes the active carrier, re-fetches the
            // signed bootstrap, reconnects TURN, and then probes P2P again.
            kotlinx.coroutines.withContext(Dispatchers.Main) { runtime.onStop(ProcessLifecycleOwner.get()) }
            runtime.awaitLifecycleUpdate()
            kotlinx.coroutines.withContext(Dispatchers.Main) { runtime.onStart(ProcessLifecycleOwner.get()) }
            awaitTransport(runtime, pairing.instanceId, TransportKind.Turn)
            awaitTransport(runtime, pairing.instanceId, TransportKind.P2P)
            println(
                "ANDROID_WINDOWS_RUNTIME_JOURNEY_OK " +
                    "authPath=${if (accountComputerInstanceId != null) "account-rendezvous" else "bound-qr"} " +
                    "instance=${pairing.instanceId}",
            )
        } finally {
            syncScope.cancel()
        }
    }

    private suspend fun awaitTransport(runtime: AndroidRuntimeGraph, instanceId: String, expected: TransportKind) {
        withTimeout(120_000L) {
            runtime.targetConnectivity(instanceId).first { state ->
                state.status == ConnectionStatus.Connected && state.transport == expected
            }
        }
    }

    private fun startEventSync(
        scope: CoroutineScope,
        repository: SessionRepository,
        sessionId: String,
    ): Job = scope.launch {
        repository.invalidations.collect { hint ->
            if (hint.sessionId != null && hint.sessionId != sessionId) return@collect
            val result = if (hint.events.isEmpty()) {
                repository.refreshEvents(sessionId)
            } else {
                repository.applyLiveEvents(sessionId, hint.events)
            }
            if (result is RefreshResult.Gap || result is RefreshResult.ResetRequired) {
                repository.refreshEvents(sessionId)
            }
        }
    }

    private suspend fun awaitSessionStatus(
        repository: SessionRepository,
        sessionId: String,
        expected: Set<SessionStatus>,
    ): Session = withTimeout(180_000L) {
        repository.observeSession(sessionId).first { session ->
            session?.status?.let(expected::contains) == true
        }
            ?: error("Session $sessionId disappeared while waiting for ${expected.joinToString()}")
    }
}
