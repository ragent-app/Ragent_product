package com.andysagent.ragent

import android.app.Application
import com.andysagent.ragent.core.network.*
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Actual controller/supervisor/transport; deterministic platform/RTC boundary only. */
class EndpointlessSuccessAndMonitorTest {
    private fun verifiedCallbackPlan(lifetimeSeconds: Long = 90, candidateLifetimeSeconds: Long = lifetimeSeconds,
        connectionId: String? = null): BootstrapConnectionPlan {
        val candidate = P2PCandidate("wss://fixture.invalid", "fixed-room", "synthetic-secret", emptyList(), true)
        val contract = ConnectionBootstrapContractDto(1, "pc-a", "fixture-device", "account-device", "turn-first",
            Instant.now().toString(), Instant.now().plusSeconds(lifetimeSeconds).toString(),
            listOf(ConnectionBootstrapCandidateDto("fixture-turn", "webrtc", "fixture", "wss://fixture.invalid", 1,
                Instant.now().plusSeconds(candidateLifetimeSeconds).toString(), false)),
            turnAuthorization = connectionId?.let { ConnectionBootstrapTurnAuthorizationDto("turn-account-quota-v1",
                true, "authorized", "fixture", "fixture", 3, 1, it) },
            signature = ConnectionBootstrapSignatureDto("fixture", "fixture", "fixture", "fixture"))
        // Represents output of the trusted verifier callback; signature verification is NOT under test.
        return BootstrapConnectionPlan("", contract, candidate, TurnCarrier("", "fixture-turn", "fixture", candidate, connectionId))
    }

    @Test fun verifiedFreshEndpointlessPlanRestartsStoppedSupervisorAndConnects() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val token = AtomicReference<String?>("rda_old_fixture")
        val transport = OkHttpRagentTransport({ "" }, { token.get() }, requireVerifiedCarrier = true)
        val initial = CompletableDeferred<Unit>(); val repairing = CompletableDeferred<Job>()
        val release = CompletableDeferred<Unit>(); val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { token.get() }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) { initial.complete(Unit); awaitCancellation() }
                repairing.complete(currentCoroutineContext().job); release.await()
                token.set("rda_new_fixture"); verifiedCallbackPlan()
            }, onAuthenticationRequired = { token.set(null); notifications.incrementAndGet() },
            renewCredential = { _, _ -> error("Endpointless cannot use direct renewal") })
        try {
            controller.start(); withTimeout(5_000) { initial.await() }
            controller.rejectCredential("rda_old_fixture")
            withTimeout(1_000) { repairing.await() }
            // Concurrent duplicate rejection must not cancel/duplicate pending RAC authorization.
            controller.rejectCredential(null)
            assertEquals(2, attempts.get()); assertEquals(1, notifications.get())
            assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            release.complete(Unit)
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals(ConnectionStatus.Connected, controller.connectivityState.value.status)
            assertEquals("rda_new_fixture", token.get())
            controller.rejectCredential("rda_old_fixture")
            delay(100)
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            assertEquals(2, attempts.get()); assertEquals(1, notifications.get())
        } finally { release.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun endpointlessMonitorUsesFreshBootstrapAtActualThirtySecondInterval() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val due = AtomicBoolean(false); val attempts = AtomicInteger(); val repair = CompletableDeferred<Job>()
        val release = CompletableDeferred<Unit>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() > 1) { repair.complete(currentCoroutineContext().job); release.await() }
                verifiedCallbackPlan()
            }, onAuthenticationRequired = { error("Valid proactive renewal must not reject") },
            credentialRenewalRequired = { due.get() }, renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            due.set(true)
            val job = withTimeout(32_000) { repair.await() }
            assertEquals(2, attempts.get()); assertTrue(job.isActive)
            // Keep the working carrier while proactive authorization is pending.
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            due.set(false); release.complete(Unit); withTimeout(2_000) { job.join() }
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
        } finally { release.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun transientRefreshKeepsValidCarrierButCannotOutliveOriginalPlan() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val retry = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                when (attempts.incrementAndGet()) {
                    1 -> verifiedCallbackPlan(3)
                    2 -> throw java.io.IOException("Synthetic temporary Accounts outage")
                    else -> { retry.complete(Unit); reply.await(); verifiedCallbackPlan() }
                }
            }, onAuthenticationRequired = { error("Transient network error must not erase credentials") },
            renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            controller.refresh(); withTimeout(2_000) { retry.await() }
            assertEquals(3, attempts.get())
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            // A blocked fresh authorization cannot extend the original contract deadline.
            withTimeout(3_000) { transport.connectionState.first { it != RuntimeConnectionState.Connected } }
            reply.complete(Unit)
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals(ConnectionStatus.Connected, controller.connectivityState.value.status)
        } finally { reply.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun authoritativeRefreshDenialClosesPreviouslyHealthyCarrier() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) verifiedCallbackPlan()
                else throw com.andysagent.ragent.core.auth.AccountSessionException(403, "owner_auth_binding_revoked", "revoked")
            }, onAuthenticationRequired = { notifications.incrementAndGet() },
            renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            controller.refresh()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.AuthenticationRequired } }
            delay(100)
            assertEquals(2, attempts.get()); assertEquals(1, notifications.get())
            assertEquals(ConnectionStatus.Offline, controller.connectivityState.value.status)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun pendingRefreshCannotKeepCarrierAfterCredentialStoreExpires() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val token = AtomicReference<String?>("rda_fixture")
        val transport = OkHttpRagentTransport({ "" }, { token.get() }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val pending = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { token.get() }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() > 1) {
                    pending.complete(Unit); reply.await(); token.set("rda_new_fixture")
                }
                verifiedCallbackPlan()
            }, onAuthenticationRequired = {}, renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            controller.refresh(); withTimeout(2_000) { pending.await() }
            token.set(null) // Real AndroidCredentialStore returns null after expiry.
            withTimeout(2_000) { transport.connectionState.first { it != RuntimeConnectionState.Connected } }
            reply.complete(Unit)
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals("rda_new_fixture", token.get())
        } finally { reply.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun pendingRefreshHonorsEarlierCandidateDeadline() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val pending = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) verifiedCallbackPlan(90, 3)
                else { pending.complete(Unit); reply.await(); verifiedCallbackPlan() }
            }, onAuthenticationRequired = {}, renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            controller.refresh(); withTimeout(2_000) { pending.await() }
            withTimeout(4_000) { transport.connectionState.first { it != RuntimeConnectionState.Connected } }
            reply.complete(Unit)
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertEquals(2, attempts.get())
        } finally { reply.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun freshSelectedPlanCannotExtendReusedCarrierOriginalWindow() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val publishedB = CompletableDeferred<Job>()
        val pending = CompletableDeferred<Unit>(); val reply = CompletableDeferred<Unit>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                when (attempts.incrementAndGet()) {
                    1 -> verifiedCallbackPlan(3)
                    2 -> { publishedB.complete(currentCoroutineContext().job); verifiedCallbackPlan(90) }
                    else -> { pending.complete(Unit); reply.await(); verifiedCallbackPlan() }
                }
            }, onAuthenticationRequired = {}, renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            val connections = com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport.connections.get()
            controller.refresh(); withTimeout(2_000) { publishedB.await().join() }
            assertEquals(connections, com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport.connections.get())
            assertEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            controller.refresh(); withTimeout(2_000) { pending.await() }
            withTimeout(4_000) { transport.connectionState.first { it != RuntimeConnectionState.Connected } }
            reply.complete(Unit)
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            assertTrue(com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport.connections.get() > connections)
        } finally { reply.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun reusedSessionCloseReleasesItsOwnReservationOnce() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpRagentTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val released = java.util.concurrent.CopyOnWriteArrayList<String>()
        val controller = BoundTargetConnection("pc-a", Application(), { "" }, { "rda_fixture" }, { null }, transport, scope, scope,
            endpointlessBootstrap = { verifiedCallbackPlan(connectionId = "turn-A") }, onAuthenticationRequired = {},
            releaseAccountReservation = { released.add(it); Unit })
        try {
            controller.start()
            withTimeout(2_000) { transport.connectionState.first { it == RuntimeConnectionState.Connected } }
            val active = controller.javaClass.getDeclaredField("activeTurnSession").apply { isAccessible = true }
            val sessionA = (active.get(controller) as AtomicReference<*>).get() as com.andysagent.ragent.core.p2p.P2PSession
            controller.applyVerifiedBootstrap(verifiedCallbackPlan(connectionId = "turn-B"))
            assertSame(sessionA, (active.get(controller) as AtomicReference<*>).get())
            sessionA.close(); sessionA.close()
            withTimeout(2_000) { while (released.isEmpty()) delay(10) }
            delay(100)
            // The delegate's close callback belongs to actual A, never selected B.
            // Explicit stop separately cleans both captured plan/session IDs.
            assertEquals(listOf("turn-A"), released.toList())
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }
}
