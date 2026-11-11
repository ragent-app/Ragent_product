package com.andysagent.agentoc

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.network.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/** Real controller and Android network monitor; bootstrap replaces the remote server. */
@RunWith(AndroidJUnit4::class)
class BoundTargetConnectionTest {
    private val application get() = ApplicationProvider.getApplicationContext<Application>()

    @Test fun automaticBootstrapQuotaDenialIsReportedOnceAndStopsRetrying() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_quota_fixture" }, requireVerifiedCarrier = true)
        val quotaFailure = AccountSessionException(429, "turn_connection_quota_exceeded", "quota reached", retryable = false)
        val reported = CompletableDeferred<AccountSessionException>()
        val attempts = AtomicInteger()
        val controller = BoundTargetConnection("pc-quota", application, { "" }, { "rda_quota_fixture" }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                attempts.incrementAndGet()
                throw quotaFailure
            }, onAuthenticationRequired = {}, onTurnQuotaExceeded = { reported.complete(it) })
        try {
            controller.start()
            assertSame(quotaFailure, withTimeout(5_000) { reported.await() })
            delay(150)
            assertEquals(1, attempts.get())
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun repeatedCarrierRecoveryKeepsInFlightJoinButRouteChangeRestartsIt() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_fixture" }, requireVerifiedCarrier = true)
        val first = CompletableDeferred<Job>()
        val second = CompletableDeferred<Job>()
        val attempts = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { "rda_fixture" }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                when (attempts.incrementAndGet()) {
                    1 -> first.complete(currentCoroutineContext().job)
                    2 -> second.complete(currentCoroutineContext().job)
                }
                awaitCancellation()
            }, onAuthenticationRequired = {})
        try {
            controller.start()
            val initial = withTimeout(5_000) { first.await() }
            repeat(3) { controller.requestRecovery("turn-bootstrap-failed") }
            delay(100)
            assertEquals(1, attempts.get())
            assertTrue(initial.isActive)
            controller.requestRecovery("default-network-changed")
            withTimeout(5_000) { second.await() }
            assertTrue(initial.isCancelled)
            assertEquals(2, attempts.get())
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun endpointlessExpiredBearerStartsOneOwnedFreshBootstrapWithoutDirectRenewal() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_expired_fixture" }, requireVerifiedCarrier = true)
        val initial = CompletableDeferred<Job>(); val repair = CompletableDeferred<Job>()
        val pendingPlan = CompletableDeferred<BootstrapConnectionPlan>()
        val attempts = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { "rda_expired_fixture" }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) {
                    initial.complete(currentCoroutineContext().job)
                    awaitCancellation()
                }
                repair.complete(currentCoroutineContext().job); pendingPlan.await()
            }, onAuthenticationRequired = {},
            renewCredential = { _, _ -> error("Endpointless repair must use fresh account authorization, not a direct endpoint") })
        try {
            controller.start(); val old = withTimeout(5_000) { initial.await() }
            controller.rejectCredential("rda_expired_fixture")
            val ownedRepair = withTimeout(1_000) { repair.await() }
            assertTrue(old.isCancelled); assertTrue(ownedRepair.isActive)
            assertEquals(2, attempts.get())
            // Pending authorization is not permission to claim Connected.
            assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            controller.stop(); assertTrue(ownedRepair.isCancelled)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun endpointlessFreshAuthorizationDenialDoesNotReclaimOrLoop() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_expired_fixture" }, requireVerifiedCarrier = true)
        val initial = CompletableDeferred<Unit>(); val repair = CompletableDeferred<Job>()
        val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { "rda_expired_fixture" }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) { initial.complete(Unit); awaitCancellation() }
                repair.complete(currentCoroutineContext().job)
                throw AccountSessionException(403, "owner_auth_binding_revoked", "fixture binding was revoked")
            }, onAuthenticationRequired = { notifications.incrementAndGet() },
            renewCredential = { _, _ -> error("No direct endpoint or implicit rebind is allowed") })
        try {
            controller.start(); withTimeout(5_000) { initial.await() }
            controller.rejectCredential("rda_expired_fixture")
            withTimeout(1_000) { repair.await().join() }
            delay(100)
            assertEquals(2, attempts.get())
            assertEquals(1, notifications.get())
            assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun oldBearerRejectionCannotQueueEndpointlessRepairForItsReplacement() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_new_fixture" }, requireVerifiedCarrier = true)
        val initial = CompletableDeferred<Unit>(); val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { "rda_new_fixture" }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                attempts.incrementAndGet(); initial.complete(Unit); awaitCancellation()
            }, onAuthenticationRequired = { notifications.incrementAndGet() },
            renewCredential = { _, _ -> error("No direct renewal") })
        try {
            controller.start(); withTimeout(5_000) { initial.await() }
            controller.rejectCredential("rda_old_fixture")
            delay(150)
            assertEquals(1, attempts.get()); assertEquals(0, notifications.get())
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun expiredCredentialStartsOwnedRenewalAndStoppingCancelsIt() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val entered = CompletableDeferred<Job>(); val hold = CompletableDeferred<Unit>()
        var current: (() -> Boolean)? = null
        val controller = BoundTargetConnection("pc-a", application, { "https://unused.invalid" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = { error("Wrong bootstrap") },
            onAuthenticationRequired = { error("Pending renewal is not a denial") },
            renewCredential = { attempted, stillCurrent ->
                assertNull(attempted); current = stillCurrent; entered.complete(currentCoroutineContext().job); hold.await()
            })
        try {
            controller.start(); val worker = withTimeout(5_000) { entered.await() }
            assertTrue(current!!.invoke()); controller.stop()
            assertTrue(worker.isCancelled); assertFalse(current!!.invoke())
            assertEquals(RuntimeConnectionState.Disconnected, transport.connectionState.value)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun revokedEnrollmentStopsAfterOneRenewalAttempt() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "https://unused.invalid" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = { error("Wrong bootstrap") },
            onAuthenticationRequired = { notifications.incrementAndGet() },
            renewCredential = { _, _ -> attempts.incrementAndGet(); throw ApiException(404, "DEVICE_REVOKED", "revoked") })
        try {
            controller.start()
            withTimeout(5_000) { transport.connectionState.first { it == RuntimeConnectionState.AuthenticationRequired } }
            delay(150)
            assertEquals(1, attempts.get()); assertEquals(1, notifications.get())
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun supersededRenewalCannotRetainAuthorityToPublish() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val first = CompletableDeferred<Job>(); val release = CompletableDeferred<Unit>(); val second = CompletableDeferred<Unit>()
        val hold = CompletableDeferred<Unit>(); val attempts = AtomicInteger(); var oldCurrent: (() -> Boolean)? = null
        val controller = BoundTargetConnection("pc-a", application, { "https://unused.invalid" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = { error("Wrong bootstrap") },
            onAuthenticationRequired = { error("Superseded work is not a denial") },
            renewCredential = { _, current ->
                if (attempts.incrementAndGet() == 1) {
                    oldCurrent = current; first.complete(currentCoroutineContext().job)
                    withContext(NonCancellable) { release.await() }
                    assertFalse(current())
                } else { second.complete(Unit); hold.await() }
            })
        try {
            controller.start(); val old = withTimeout(5_000) { first.await() }
            controller.refresh(); withTimeout(5_000) { second.await() }
            assertFalse(oldCurrent!!.invoke()); release.complete(Unit); withTimeout(5_000) { old.join() }
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        } finally { release.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun sameGenerationOldBootstrapDenialPreservesTheFreshCredential() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val token = java.util.concurrent.atomic.AtomicReference<String?>("rda_old")
        val transport = OkHttpAgentoCTransport({ "" }, { token.get() }, requireVerifiedCarrier = true)
        val started = CompletableDeferred<Job>(); val reply = CompletableDeferred<Unit>(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { token.get() }, { null }, transport, scope, scope,
            endpointlessBootstrap = { started.complete(currentCoroutineContext().job); reply.await(); throw AccountSessionException(403, "OLD", "old request") },
            onAuthenticationRequired = { token.set(null); notifications.incrementAndGet() })
        try {
            controller.start(); val worker = withTimeout(5_000) { started.await() }
            token.set("rda_new"); reply.complete(Unit); withTimeout(5_000) { worker.join() }
            assertEquals("rda_new", token.get()); assertEquals(0, notifications.get())
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun queuedAuthenticationDecisionCannotInvalidateAnExplicitNewRefresh() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val token = java.util.concurrent.atomic.AtomicReference<String?>("rda_old")
        val transport = OkHttpAgentoCTransport({ "" }, { token.get() }, requireVerifiedCarrier = true)
        val decision = CompletableDeferred<Job>(); val allowDecision = CompletableDeferred<Unit>()
        val nextStarted = CompletableDeferred<Unit>(); val next = CompletableDeferred<BootstrapConnectionPlan>()
        val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { token.get() }, { null }, transport, scope, scope,
            endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) throw AccountSessionException(401, "OLD", "old request")
                nextStarted.complete(Unit); next.await()
            }, onAuthenticationRequired = { notifications.incrementAndGet() },
            credentialRejectionHandler = CredentialRejectionHandler { _, _, invalidate ->
                decision.complete(currentCoroutineContext().job)
                withContext(NonCancellable) { allowDecision.await(); invalidate() }
            })
        try {
            controller.start(); val old = withTimeout(5_000) { decision.await() }
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            token.set("rda_new"); controller.refresh(); withTimeout(5_000) { nextStarted.await() }
            allowDecision.complete(Unit); withTimeout(5_000) { old.join() }
            assertEquals(0, notifications.get()); assertEquals("rda_new", token.get())
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
        } finally { allowDecision.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun currentBusinessDenialCancelsPendingBootstrapAndRemainsTerminal() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { "rda_current" }, requireVerifiedCarrier = true)
        val started = CompletableDeferred<Job>(); val next = CompletableDeferred<BootstrapConnectionPlan>()
        val notifications = AtomicInteger(); var additionalInvalidations = 0
        val controller = BoundTargetConnection("pc-a", application, { "" }, { "rda_current" }, { null }, transport, scope, scope,
            endpointlessBootstrap = { started.complete(currentCoroutineContext().job); next.await() },
            onAuthenticationRequired = { notifications.incrementAndGet() })
        try {
            controller.start(); val worker = withTimeout(5_000) { started.await() }
            controller.rejectCredential("rda_current", invalidateAdditional = { additionalInvalidations++ })
            withTimeout(5_000) { worker.join() }; assertTrue(worker.isCancelled)
            assertEquals(1, additionalInvalidations); assertEquals(1, notifications.get())
            delay(100); assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            controller.rejectCredential("rda_current", invalidateAdditional = { additionalInvalidations++ })
            assertEquals(1, additionalInvalidations)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun supersededBootstrapFailureCannotInvalidateTheReplacement() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val oldStarted = CompletableDeferred<Job>(); val releaseOld = CompletableDeferred<Unit>()
        val nextStarted = CompletableDeferred<Unit>(); val holdNext = CompletableDeferred<BootstrapConnectionPlan>()
        val attempts = AtomicInteger(); val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                if (attempts.incrementAndGet() == 1) {
                    oldStarted.complete(currentCoroutineContext().job)
                    withContext(NonCancellable) { releaseOld.await() }
                    throw AccountSessionException(403, "OLD_DEVICE_REVOKED", "late old rejection")
                }
                nextStarted.complete(Unit); holdNext.await()
            }, onAuthenticationRequired = { notifications.incrementAndGet() })
        try {
            controller.start(); val oldJob = withTimeout(5_000) { oldStarted.await() }
            controller.refresh(); withTimeout(5_000) { nextStarted.await() }
            releaseOld.complete(Unit); withTimeout(5_000) { oldJob.join() }
            assertEquals(0, notifications.get())
            assertNotEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            assertEquals(2, attempts.get())
        } finally { releaseOld.complete(Unit); controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun authorizationFailuresAreTerminalAndExplicitRefreshCanRetry() = runBlocking {
        val failures = listOf(
            BootstrapException("BOOTSTRAP_HTTP_401", "expired"),
            BootstrapException("BOOTSTRAP_HTTP_403", "revoked"),
            AccountSessionException(401, "ACCOUNT_EXPIRED", "expired"),
            AccountsRepositoryException(403, "DEVICE_REVOKED", "revoked", false),
        )
        for (error in failures) {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
            val attempts = AtomicInteger()
            val notifications = AtomicInteger()
            val nextBootstrap = CompletableDeferred<BootstrapConnectionPlan>()
            val controller = BoundTargetConnection("pc-a", application, { "" }, { null }, { null },
                transport, scope, scope,
                endpointlessBootstrap = {
                    if (attempts.incrementAndGet() == 1) throw error
                    nextBootstrap.await()
                }, onAuthenticationRequired = { notifications.incrementAndGet() })
            try {
                controller.start()
                withTimeout(5_000) { transport.connectionState.first { it == RuntimeConnectionState.AuthenticationRequired } }
                // No queued Offline/Connected notification may replace the terminal auth result.
                delay(100)
                assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
                assertEquals(ConnectionStatus.Offline, controller.connectivityState.value.status)
                assertEquals(1, attempts.get())
                assertEquals(1, notifications.get())
                controller.refresh()
                withTimeout(5_000) { while (attempts.get() != 2) delay(10) }
                // An explicit retry also waits for a verified plan before
                // leaving the terminal authorization state.
                assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
                controller.stop()
                assertEquals(RuntimeConnectionState.Disconnected, transport.connectionState.value)
            } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
        }
    }

    @Test fun missingDeviceCredentialReturnsAuthenticationInsteadOfRetryingNetwork() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val notifications = AtomicInteger()
        val controller = BoundTargetConnection("pc-a", application, { "https://unused.invalid" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = { error("Endpoint-less bootstrap must not run") },
            onAuthenticationRequired = { notifications.incrementAndGet() })
        try {
            controller.start()
            withTimeout(5_000) { transport.connectionState.first { it == RuntimeConnectionState.AuthenticationRequired } }
            delay(100)
            assertEquals(RuntimeConnectionState.AuthenticationRequired, transport.connectionState.value)
            assertEquals(1, notifications.get())
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }

    @Test fun lastUserStopCancelsBootstrapAndRestartDoesNotReuseConnectedState() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val transport = OkHttpAgentoCTransport({ "" }, { null }, requireVerifiedCarrier = true)
        val attempts = AtomicInteger()
        val cancellations = AtomicInteger()
        val bootstrap = CompletableDeferred<BootstrapConnectionPlan>()
        val controller = BoundTargetConnection("pc-a", application, { "" }, { null }, { null },
            transport, scope, scope, endpointlessBootstrap = {
                attempts.incrementAndGet()
                try { bootstrap.await() } finally { cancellations.incrementAndGet() }
            }, onAuthenticationRequired = { error("Cancellation is not an authentication error") })
        try {
            controller.start()
            withTimeout(5_000) { while (attempts.get() != 1) delay(10) }
            controller.stop()
            assertEquals(1, cancellations.get())
            assertEquals(RuntimeConnectionState.Disconnected, transport.connectionState.value)
            controller.start()
            withTimeout(5_000) { while (attempts.get() != 2) delay(10) }
            assertNotEquals(RuntimeConnectionState.Connected, transport.connectionState.value)
            controller.stop()
            assertEquals(2, cancellations.get())
            assertEquals(RuntimeConnectionState.Disconnected, transport.connectionState.value)
        } finally { controller.stop(); transport.close(); scope.coroutineContext[Job]?.cancelAndJoin() }
    }
}
