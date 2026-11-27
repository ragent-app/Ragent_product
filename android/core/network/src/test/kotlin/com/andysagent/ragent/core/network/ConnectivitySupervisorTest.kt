package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.p2p.IceServer
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PHttpResponse
import com.andysagent.ragent.core.p2p.P2PIceCarrier
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.protocol.ConnectionBootstrapCandidateDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapContractDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapInitialCarrierDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapSignatureDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnAuthorizationDto
import com.andysagent.ragent.core.protocol.ConnectionBootstrapTurnDto
import com.andysagent.ragent.core.model.RuntimeConnectionState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectivitySupervisorTest {
    @Test fun `lost commit response is retried on the authenticated standby`() = runTest {
        for (timeout in listOf(false, true)) {
            val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
            val replacement = FakeSession(Result.success(Unit)).apply { loseFirstCommit = true; hangFirstCommit = timeout }
            var creates = 0; var switched = false
            val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
                turnSessionFactory = { if (creates++ == 0) old else replacement },
                onTurnHandoffReady = { switched = true }, onRecoveryRequired = {},
                useSignedHandoff = { true }, signedHandoffPlan = { plan() })
            try {
                supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
                old.requestHandoff(); runCurrent()
                if (timeout) { advanceTimeBy(3_001); runCurrent() }
                assertEquals(2, replacement.commitAttempts)
                assertTrue(switched)
                assertTrue(old.isOpen)
            } finally { supervisor.stop(); old.close() }
        }
    }
    @Test fun `repeated uncertain commit never switches the old carrier`() = runTest {
        val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
        val replacement = FakeSession(Result.success(Unit)).apply { failAllCommits = true }
        var creates = 0; var switched = false
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (creates++ == 0) old else replacement },
            onTurnHandoffReady = { switched = true }, onRecoveryRequired = {},
            useSignedHandoff = { true }, signedHandoffPlan = { plan() })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            old.requestHandoff(); runCurrent()
            assertEquals(2, replacement.commitAttempts)
            assertFalse(switched)
            assertTrue(old.isOpen)
            assertFalse(replacement.isOpen)
            assertEquals(1, old.resumptions)
        } finally { supervisor.stop(); old.close() }
    }
    @Test fun `signed handoff waits for standby commit and keeps old carrier on rejection`() = runTest {
        for (status in listOf(200, 409)) {
            val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
            val replacement = FakeSession(Result.success(Unit)).apply { commitGate = CompletableDeferred() }
            var creates = 0; var switched = false; var finished: Boolean? = null
            val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
                turnSessionFactory = { if (creates++ == 0) old else replacement },
                onTurnHandoffReady = { switched = true }, onRecoveryRequired = {},
                useSignedHandoff = { true }, signedHandoffPlan = { plan() }, onSignedHandoffFinished = { finished = it })
            try {
                supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
                old.requestHandoff(); runCurrent()
                assertFalse(switched); assertTrue(old.isOpen)
                replacement.commitGate!!.complete(status); runCurrent()
                assertEquals(status == 200, switched); assertEquals(status == 200, finished)
                assertEquals(1, replacement.commitAttempts, "An explicit response must not be retried")
                assertTrue(old.isOpen)
                if (status != 200) { assertFalse(replacement.isOpen); assertEquals(1, old.resumptions) }
            } finally { supervisor.stop(); old.close() }
        }
    }
    @Test fun `verified handoff switches only after the new carrier answers`() = runTest {
        val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
        val replacement = FakeSession(Result.success(Unit))
        var ready: P2PSession? = null
        var handoffReady: P2PSession? = null
        var recovery: String? = null
        var creates = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (creates++ == 0) old else replacement },
            onTurnSessionReady = { ready = it }, onTurnHandoffReady = { handoffReady = it },
            onRecoveryRequired = { recovery = it })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(ready === old)
            old.requestHandoff(); runCurrent()
            assertEquals("carrier-handoff", recovery)
            assertTrue(old.isOpen)
            assertEquals(1, old.suspensions)
            supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(handoffReady === replacement)
            assertTrue(old.isOpen, "old carrier belongs to the transport until requests drain")
            assertTrue(replacement.isOpen)
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        } finally { supervisor.stop(); old.close() }
    }

    @Test fun `failed handoff resumes the still healthy old carrier`() = runTest {
        val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
        val replacement = FakeSession(Result.failure(IllegalStateException("standby unavailable")))
        var creates = 0
        var switched = false
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (creates++ == 0) old else replacement },
            onTurnHandoffReady = { switched = true }, onRecoveryRequired = {})
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            old.requestHandoff(); runCurrent()
            supervisor.applyBootstrap(plan()); runCurrent()
            assertFalse(switched)
            assertTrue(old.isOpen)
            assertEquals(1, old.resumptions)
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        } finally { supervisor.stop() }
    }

    @Test fun `unauthenticated standby cannot replace the live carrier`() = runTest {
        val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
        val replacement = FakeSession(Result.success(Unit), Result.success(P2PHttpResponse(id = "probe", status = 401)))
        var creates = 0
        var switched = false
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (creates++ == 0) old else replacement },
            onTurnHandoffReady = { switched = true }, onRecoveryRequired = {})
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            old.requestHandoff(); runCurrent()
            supervisor.applyBootstrap(plan()); runCurrent()
            assertFalse(switched)
            assertTrue(old.isOpen)
            assertFalse(replacement.isOpen)
            assertEquals(1, old.resumptions)
        } finally { supervisor.stop() }
    }

    @Test fun `timed out handoff restores signaling and shutdown fences late plans`() = runTest {
        val old = FakeSession(Result.success(Unit)).apply { supportsHandoff = true }
        var creates = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { creates++; old }, onTurnHandoffReady = { error("must not switch") },
            onRecoveryRequired = {})
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        old.requestHandoff(); runCurrent()
        advanceTimeBy(15_001); runCurrent()
        assertEquals(1, old.resumptions)
        assertTrue(old.isOpen)
        old.requestHandoff(); runCurrent()
        supervisor.stop(); runCurrent()
        supervisor.applyBootstrap(plan()); runCurrent()
        assertFalse(old.isOpen)
        assertEquals(1, creates, "a late plan must not recreate a carrier after shutdown")
    }
    @Test fun `initial ICE failure requests alternate recovery without treating other errors as ICE`() = runTest {
        for ((message, expected) in listOf(
            "ICE connection entered FAILED" to "turn-ice-failed",
            "signaling unavailable" to "turn-bootstrap-failed",
        )) {
            var reason: String? = null
            val session = FakeSession(Result.failure(IllegalStateException(message)))
            val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
                turnSessionFactory = { session }, onRecoveryRequired = { reason = it })
            try {
                supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
                assertEquals(expected, reason)
                assertFalse(session.isOpen)
            } finally { supervisor.stop() }
        }
    }

    @Test fun `a pending bootstrap is connecting rather than falsely disconnected`() = runTest {
        val monitor = FakeNetworkMonitor()
        var pending = true
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, monitor, this,
            bootstrapPending = { pending })
        val offline = ConnectionState(status = ConnectionStatus.Offline)
        assertEquals(RuntimeConnectionState.Connecting, supervisor.toRuntimeConnectionState(offline))
        pending = false
        assertEquals(RuntimeConnectionState.Disconnected, supervisor.toRuntimeConnectionState(offline))
        pending = true
        monitor.loseNetwork()
        assertEquals(RuntimeConnectionState.Disconnected, supervisor.toRuntimeConnectionState(offline))
    }

    @Test fun `pending recovery after a connected carrier remains reconnecting`() = runTest {
        var pending = false
        val session = FakeSession(Result.success(Unit))
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            bootstrapPending = { pending }, turnSessionFactory = { session })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            pending = true
            assertEquals(RuntimeConnectionState.Reconnecting,
                supervisor.toRuntimeConnectionState(ConnectionState(status = ConnectionStatus.Offline)))
        } finally { supervisor.stop() }
    }

    @Test fun `carrier teardown and a concurrent failed request trigger one recovery`() = runTest {
        val carrier = FakeSession(Result.success(Unit))
        var recoveries = 0
        lateinit var supervisor: ConnectivitySupervisor
        supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { carrier },
            onTurnSessionClosed = { supervisor.carrierRequestFailed(null) },
            onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(carrier.isOpen)
            carrier.disconnectUnexpected("fixture-close"); runCurrent()
            assertEquals(1, recoveries, "One closed carrier must start only one recovery")
        } finally { supervisor.stop() }
    }

    @Test fun `unavailable request does not restart an in flight bootstrap`() = runTest {
        var pending = true; var recoveries = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            bootstrapPending = { pending }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); runCurrent()
            supervisor.carrierRequestFailed(null); runCurrent()
            assertEquals(0, recoveries, "The existing bootstrap already owns recovery")
            pending = false
            supervisor.carrierRequestFailed(null); runCurrent()
            assertEquals(1, recoveries, "A genuinely idle missing carrier must still recover")
        } finally { supervisor.stop() }
    }

    @Test fun `unavailable request does not restart an authenticating carrier`() = runTest {
        val pending = CompletableDeferred<P2PHttpResponse>(); val carrier = FakeSession(Result.success(Unit))
        var recoveries = 0
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> = Result.success(pending.await())
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(carrier.isOpen)
            supervisor.carrierRequestFailed(null); runCurrent()
            assertEquals(0, recoveries)
            pending.complete(response(200)); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertTrue(carrier.isOpen)
        } finally { supervisor.stop() }
    }

    @Test fun `a new verified plan does not cancel a carrier while its initial probe is in flight`() = runTest {
        val pending = CompletableDeferred<P2PHttpResponse>()
        val carrier = FakeSession(Result.success(Unit))
        var creations = 0
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> = Result.success(pending.await())
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { creations++; session }, onRecoveryRequired = {})
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(carrier.isOpen)
            supervisor.applyBootstrap(plan()); runCurrent()
            assertEquals(1, creations)
            assertTrue(carrier.isOpen, "A second plan must not close a carrier being authenticated")
            pending.complete(response(200)); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertTrue(carrier.isOpen)
        } finally { supervisor.stop() }
    }

    @Test fun `a changed plan or credential still replaces an in flight carrier`() = runTest {
        for (changeCredential in listOf(false, true)) {
            val pending = CompletableDeferred<P2PHttpResponse>()
            val old = FakeSession(Result.success(Unit)); val next = FakeSession(Result.success(Unit))
            val oldSession = object : P2PSession by old {
                override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> = Result.success(pending.await())
            }
            var credential = "rda_old"; var creations = 0
            val supervisor = ConnectivitySupervisor({ "" }, { credential }, FakeNetworkMonitor(), this,
                turnSessionFactory = { if (++creations == 1) oldSession else next }, onRecoveryRequired = {})
            try {
                val original = plan()
                supervisor.start(); supervisor.applyBootstrap(original); runCurrent()
                assertTrue(old.isOpen)
                if (changeCredential) credential = "rda_new"
                supervisor.applyBootstrap(if (changeCredential) original else original.copy(bootstrapEndpoint = "https://new.example.test"))
                runCurrent()
                assertEquals(2, creations)
                assertFalse(old.isOpen)
                assertTrue(next.isOpen)
                assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            } finally { supervisor.stop() }
        }
    }

    @Test fun `failed business request immediately recovers its carrier and ignores a late old failure`() = runTest {
        val old = FakeSession(Result.success(Unit)); val replacement = FakeSession(Result.success(Unit))
        var creations = 0; var recoveries = 0
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_fixture" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (++creations == 1) old else replacement }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(old.isOpen)
            supervisor.carrierRequestFailed(old); runCurrent()
            assertEquals(1, recoveries); assertFalse(old.isOpen)
            assertEquals(0L, testScheduler.currentTime, "recovery must not wait for the periodic health probe")
            supervisor.applyBootstrap(plan()); runCurrent()
            assertTrue(replacement.isOpen)
            supervisor.carrierRequestFailed(old); runCurrent()
            assertTrue(replacement.isOpen); assertEquals(1, recoveries)
        } finally { supervisor.stop() }
    }

    @Test fun `failed old carrier keeps its reservation identity while callbacks replace the plan`() = runTest {
        fun leasePlan(id: String) = plan().let { it.copy(turnCarrier = it.turnCarrier!!.copy(connectionId = id)) }
        val released = mutableListOf<String>(); val failed = mutableListOf<String?>(); val sessions = mutableListOf<FakeSession>()
        lateinit var supervisor: ConnectivitySupervisor
        supervisor = ConnectivitySupervisor({ "" }, { "rda_current" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { carrier ->
                val session = FakeSession(Result.success(Unit)); sessions.add(session)
                TurnLeaseSession(carrier, session, released::add)
            },
            onTurnSessionClosed = { if (sessions.size == 1) supervisor.applyBootstrap(leasePlan("replacement")) },
            onTurnReservationFailed = { carrier, _ -> failed.add(carrier?.connectionId) },
            onRecoveryRequired = {})
        supervisor.start(); supervisor.applyBootstrap(leasePlan("original")); runCurrent()
        supervisor.applyBootstrap(leasePlan("unused-new-plan")); runCurrent()
        assertEquals(1, sessions.size)
        sessions[0].disconnectUnexpected("lost"); runCurrent()
        assertEquals(listOf<String?>("original"), failed); assertEquals(listOf("original"), released)
        assertEquals(2, sessions.size); assertTrue(sessions[1].isOpen)
        sessions[0].disconnectUnexpected("late"); runCurrent()
        assertEquals(listOf<String?>("original"), failed); assertTrue(sessions[1].isOpen)
        supervisor.stop(); assertEquals(listOf("original", "replacement"), released)
    }

    @Test fun `remote health error does not revoke the credential`() = runTest {
        val carrier = FakeSession(Result.success(Unit))
        var reads = 0
        var notifications = 0
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                reads++
                return Result.success(if (reads == 1) response(200)
                    else P2PHttpResponse(id = request.id, status = 401, error = "remote error"))
            }
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_current" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onAuthenticationRequired = { notifications++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
            assertEquals(0, notifications)
            assertTrue(carrier.isOpen)
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        } finally { supervisor.stop() }
    }

    @Test fun `old bearer health denial retains the carrier and next check uses new credential`() = runTest {
        val oldReply = CompletableDeferred<P2PHttpResponse>(); val requested = CompletableDeferred<Unit>()
        var token = "rda_old"; var reads = 0; var notifications = 0
        val carrier = FakeSession(Result.success(Unit))
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                reads++
                if (reads == 2) {
                    assertEquals("Bearer rda_old", request.headers["Authorization"]); requested.complete(Unit)
                    return Result.success(oldReply.await())
                }
                assertEquals(if (reads == 1) "Bearer rda_old" else "Bearer rda_new", request.headers["Authorization"])
                return Result.success(response(200))
            }
        }
        val supervisor = ConnectivitySupervisor({ "" }, { token }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onAuthenticationRequired = { notifications++ })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent(); assertTrue(requested.isCompleted)
        token = "rda_new"; oldReply.complete(response(403)); runCurrent()
        assertEquals(0, notifications); assertTrue(carrier.isOpen); assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent(); assertEquals(3, reads)
        supervisor.stop()
    }

    @Test fun `initial probe denial uses the credential actually sent and retries only a replacement`() = runTest {
        var token = "rda_old"; var creates = 0; var notifications = 0
        val rejected = FakeSession(Result.success(Unit))
        val oldSession = object : P2PSession by rejected {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                assertEquals("Bearer rda_old", request.headers["Authorization"])
                token = "rda_new"; return Result.success(response(401))
            }
        }
        val replacement = FakeSession(Result.success(Unit))
        val supervisor = ConnectivitySupervisor({ "" }, { token }, FakeNetworkMonitor(), this,
            turnSessionFactory = { if (++creates == 1) oldSession else replacement }, onAuthenticationRequired = { notifications++ })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        assertEquals(0, notifications); assertEquals(2, creates)
        assertFalse(rejected.isOpen); assertTrue(replacement.isOpen); assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        supervisor.stop()
    }

    @Test fun `late former carrier denial cannot invalidate its replacement`() = runTest {
        val lateAnswer = CompletableDeferred<P2PHttpResponse>()
        val healthStarted = CompletableDeferred<Unit>()
        val oldCarrier = FakeSession(Result.success(Unit))
        var reads = 0
        val oldSession = object : P2PSession by oldCarrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                if (++reads == 1) return Result.success(response(200))
                healthStarted.complete(Unit)
                // A native callback can arrive after the coroutine was cancelled.
                return withContext(NonCancellable) { Result.success(lateAnswer.await()) }
            }
        }
        val replacement = FakeSession(Result.success(Unit))
        val sessions = ArrayDeque(listOf(oldSession, replacement))
        val monitor = FakeNetworkMonitor()
        var authenticationRequired = 0
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(endpointProvider = { "" }, credentialProvider = { "rda_test" },
            monitor = monitor, scope = this, turnSessionFactory = { sessions.removeFirst() },
            onRecoveryRequired = { recoveries++ }, onAuthenticationRequired = { authenticationRequired++ })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
        assertTrue(healthStarted.isCompleted)
        monitor.changeDefaultNetwork(); runCurrent()
        supervisor.applyBootstrap(plan()); runCurrent()
        assertTrue(replacement.isOpen)
        assertFalse(oldCarrier.isOpen)
        lateAnswer.complete(response(403)); runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(0, authenticationRequired)
        assertEquals(1, recoveries)
        assertTrue(replacement.isOpen)
        supervisor.stop()
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS * 2); runCurrent()
        assertFalse(replacement.isOpen)
        assertEquals(1, recoveries)
    }

    @Test fun `healthy response without a credential never becomes authenticated`() = runTest {
        val session = FakeSession(Result.success(Unit), Result.success(response(200)))
        val supervisor = ConnectivitySupervisor(endpointProvider = { "" }, credentialProvider = { null },
            monitor = FakeNetworkMonitor(), scope = this, turnSessionFactory = { session })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        assertEquals(ConnectionStatus.Reachable, supervisor.state.value.status)
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
        assertEquals(ConnectionStatus.Reachable, supervisor.state.value.status)
        assertFalse(supervisor.state.value.authenticated)
        supervisor.stop()
    }
    @Test fun `silent carrier failure is detected with reads without a second offer`() = runTest {
        val session = FakeSession(Result.success(Unit), Result.success(response(200)))
        var creations = 0
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(endpointProvider = { "" }, credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(), scope = this,
            turnSessionFactory = { creations++; session }, onRecoveryRequired = { recoveries++ })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        assertTrue(session.isOpen)
        session.failReads()
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status, "one failed probe must not report a working carrier as disconnected")
        assertEquals(0, recoveries)
        assertTrue(session.isOpen)
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
        assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        assertEquals(1, recoveries)
        assertFalse(session.isOpen)
        assertEquals(1, creations)
        supervisor.stop()
    }

    @Test fun `successful business traffic prevents failed health probes from closing the carrier`() = runTest {
        val carrier = FakeSession(Result.success(Unit))
        var generation = 0L
        var reads = 0
        var recoveries = 0
        val session = object : P2PSession by carrier {
            override val successfulResponseGeneration: Long get() = generation
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                reads++
                return if (reads == 1) Result.success(response(200)) else Result.failure(IllegalStateException("probe failed"))
            }
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_test" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
            generation++ // A separate business request completed successfully.
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_RETRY_DELAY_MS); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertEquals(0, recoveries)
            assertTrue(carrier.isOpen)
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
            assertTrue(carrier.isOpen)
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_RETRY_DELAY_MS); runCurrent()
            assertFalse(carrier.isOpen)
            assertEquals(1, recoveries)
        } finally { supervisor.stop() }
    }

    @Test fun `slow and transient health probes do not churn a working carrier`() = runTest {
        val carrier = FakeSession(Result.success(Unit))
        var reads = 0
        var recoveries = 0
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                reads++
                if (reads == 2) { delay(1_800); return Result.success(response(200)) }
                if (reads == 3) return Result.failure(IllegalStateException("transient"))
                return Result.success(response(200))
            }
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_test" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
            advanceTimeBy(1_800); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_RETRY_DELAY_MS); runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertEquals(4, reads)
            assertEquals(0, recoveries)
            assertTrue(carrier.isOpen)
        } finally { supervisor.stop() }
    }

    @Test fun `two timed out health probes still recover a silent carrier`() = runTest {
        val carrier = FakeSession(Result.success(Unit))
        var reads = 0
        var recoveries = 0
        val session = object : P2PSession by carrier {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                if (++reads == 1) return Result.success(response(200))
                delay(60_000)
                return Result.success(response(200))
            }
        }
        val supervisor = ConnectivitySupervisor({ "" }, { "rda_test" }, FakeNetworkMonitor(), this,
            turnSessionFactory = { session }, onRecoveryRequired = { recoveries++ })
        try {
            supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
            advanceTimeBy(2 * (ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS + ConnectivitySupervisor.CARRIER_HEALTH_TIMEOUT_MS))
            runCurrent()
            assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
            assertEquals(1, recoveries)
            assertFalse(carrier.isOpen)
        } finally { supervisor.stop() }
    }

    @Test fun `carrier health authorization denial is terminal without retry`() = runTest {
        val session = FakeSession(Result.success(Unit), Result.success(response(200)))
        var authenticationRequired = 0
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(endpointProvider = { "" }, credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(), scope = this, turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ }, onAuthenticationRequired = { authenticationRequired++ })
        supervisor.start(); supervisor.applyBootstrap(plan()); runCurrent()
        session.answerReads(response(403))
        advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS); runCurrent()
        assertEquals(ConnectionStatus.AuthenticationRequired, supervisor.state.value.status)
        assertEquals(1, authenticationRequired)
        assertEquals(0, recoveries)
        assertFalse(session.isOpen)
        supervisor.stop()
    }
    @Test
    fun `capability jitter retains TURN but default route change requests fresh recovery`() = runTest {
        val monitor = FakeNetworkMonitor()
        val session = FakeSession(Result.success(Unit), Result.success(response(200)))
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" }, credentialProvider = { "rda_test" },
            monitor = monitor, scope = this, maxRetries = 0,
            turnSessionFactory = { session }, onRecoveryRequired = { recoveries++ },
        )
        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertTrue(session.isOpen)
        monitor.capabilityJitter()
        runCurrent()
        assertTrue(session.isOpen)
        assertEquals(0, recoveries)
        monitor.changeDefaultNetwork()
        runCurrent()
        assertFalse(session.isOpen)
        assertEquals(1, recoveries)
        assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        supervisor.stop()
    }

    @Test
    fun `capability jitter during TURN setup keeps the original probe alive`() = runTest {
        val monitor = FakeNetworkMonitor()
        val session = FakeSession(
            Result.success(Unit), Result.success(response(200)), connectDelayMs = 1_000L,
        )
        var created = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" }, credentialProvider = { "rda_test" },
            monitor = monitor, scope = this, maxRetries = 0,
            turnSessionFactory = { created++; session },
        )
        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        monitor.capabilityJitter()
        runCurrent()
        advanceTimeBy(1_000L)
        runCurrent()
        assertEquals(1, created)
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertTrue(session.isOpen)
        supervisor.stop()
    }

    @Test
    fun `without verified bootstrap supervisor never probes endpoint or selects transport`() = runTest {
        var turnCreates = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            maxRetries = 0,
            turnSessionFactory = { turnCreates += 1; error("must not be called") },
        )

        supervisor.start()
        runCurrent()

        assertEquals(ConnectionStatus.Offline, supervisor.state.value.status)
        assertEquals(TransportKind.None, supervisor.state.value.transport)
        assertEquals(0, turnCreates)
        supervisor.stop()
    }

    @Test
    fun `healthy TURN carrier is retained after the former upgrade interval`() = runTest {
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        val p2pSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        var p2pCreates = 0
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = { turnSession },
            p2pSessionFactory = P2PSessionFactory { p2pCreates += 1; p2pSession },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertEquals(0, p2pCreates)
        assertTrue(turnSession.isOpen)

        advanceTimeBy(ConnectivitySupervisor.TURN_RECHECK_INTERVAL_MS)
        runCurrent()

        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertEquals(0, p2pCreates)
        assertTrue(turnSession.isOpen)
        assertFalse(p2pSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `manual Connect refresh retains the healthy TURN carrier`() = runTest {
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        var turnCreates = 0
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = {
                turnCreates += 1
                turnSession
            },
            p2pSessionFactory = P2PSessionFactory { error("P2P is upgrade-only in this test") },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(1, turnCreates)
        assertTrue(turnSession.isOpen)

        // A user may tap Connect again while this computer is already Online.
        // Pairing persistence and foreground recovery can also provide a
        // freshly verified contract. The active carrier must survive that
        // duplicate input rather than being superseded and closed.
        supervisor.applyBootstrap(plan())
        runCurrent()

        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertEquals(1, turnCreates)
        assertTrue(turnSession.isOpen)
        supervisor.stop()
        assertEquals(ConnectionStatus.Offline, supervisor.state.value.status)
        assertEquals(TransportKind.None, supervisor.state.value.transport)
        assertFalse(supervisor.state.value.reachable)
        assertFalse(supervisor.state.value.authenticated)
    }

    @Test
    fun `TURN failure does not fall through to endpoint or P2P first connection`() = runTest {
        var p2pCreates = 0
        var turnCreates = 0
        val supervisor = supervisor(
            scope = this,
            maxRetries = 0,
            turnSessionFactory = {
                turnCreates += 1
                FakeSession(Result.failure(IllegalStateException("turn down")))
            },
            p2pSessionFactory = P2PSessionFactory { p2pCreates += 1; error("P2P must be upgrade-only") },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()

        assertEquals(ConnectionStatus.Error, supervisor.state.value.status)
        assertEquals(TransportKind.None, supervisor.state.value.transport)
        assertTrue(supervisor.state.value.lastError.orEmpty().contains("turn down"))
        assertEquals(1, turnCreates)
        assertEquals(0, p2pCreates)
        supervisor.stop()
    }

    @Test
    fun `TURN connect timeout closes the temporary session and reaches terminal error`() = runTest {
        val turnSession = FakeSession(
            Result.success(Unit),
            connectDelayMs = ConnectivitySupervisor.TURN_CONNECT_TIMEOUT_MS + 1,
        )
        val supervisor = supervisor(
            scope = this,
            maxRetries = 0,
            turnSessionFactory = { turnSession },
            p2pSessionFactory = P2PSessionFactory { error("P2P must be upgrade-only") },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        advanceTimeBy(ConnectivitySupervisor.TURN_CONNECT_TIMEOUT_MS)
        runCurrent()

        assertEquals(ConnectionStatus.Error, supervisor.state.value.status)
        assertTrue(supervisor.state.value.lastError.orEmpty().contains("timed out"))
        assertFalse(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `healthy TURN carrier never starts a second peer after a recheck interval`() = runTest {
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        val p2pSession = FakeSession(
            Result.success(Unit),
            connectDelayMs = ConnectivitySupervisor.P2P_CONNECT_TIMEOUT_MS + 1,
        )
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = { turnSession },
            p2pSessionFactory = P2PSessionFactory { p2pSession },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        advanceTimeBy(ConnectivitySupervisor.TURN_RECHECK_INTERVAL_MS)
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertFalse(p2pSession.isOpen)
        assertTrue(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `TURN authentication failure is surfaced and does not install an unverified carrier`() = runTest {
        var authenticationRequests = 0
        var readyCallbacks = 0
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(401)))
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_expired" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            maxRetries = 3,
            turnSessionFactory = { turnSession },
            onTurnSessionReady = { readyCallbacks++ },
            onAuthenticationRequired = { authenticationRequests++ },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()

        assertEquals(ConnectionStatus.AuthenticationRequired, supervisor.state.value.status)
        assertEquals(1, authenticationRequests)
        assertEquals(0, readyCallbacks)
        assertFalse(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `failed direct upgrade is not attempted while TURN is healthy`() = runTest {
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        var p2pCreates = 0
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = { turnSession },
            p2pSessionFactory = P2PSessionFactory {
                p2pCreates += 1
                FakeSession(Result.failure(IllegalStateException("no P2P path")))
            },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        advanceTimeBy(ConnectivitySupervisor.TURN_RECHECK_INTERVAL_MS)
        runCurrent()

        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertEquals(0, p2pCreates)
        assertTrue(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `direct health probe is not created while TURN is healthy`() = runTest {
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        val p2pSession = FakeSession(Result.success(Unit), Result.success(response(500)))
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = { turnSession },
            p2pSessionFactory = P2PSessionFactory { p2pSession },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        advanceTimeBy(ConnectivitySupervisor.TURN_RECHECK_INTERVAL_MS)
        runCurrent()

        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertFalse(p2pSession.isOpen)
        assertTrue(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `network loss closes the active TURN carrier before recovery`() = runTest {
        val monitor = FakeNetworkMonitor()
        val turnSession = FakeSession(Result.success(Unit), Result.success(response(200)))
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_test" },
            monitor = monitor,
            scope = this,
            turnSessionFactory = { turnSession },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertTrue(turnSession.isOpen)

        monitor.loseNetwork()
        runCurrent()

        assertEquals(ConnectionStatus.Offline, supervisor.state.value.status)
        assertFalse(turnSession.isOpen)
        supervisor.stop()
    }

    @Test
    fun `unexpected TURN loss clears the carrier and allows signed bootstrap recovery`() = runTest {
        val firstTurn = FakeSession(Result.success(Unit), Result.success(response(200)))
        val recoveredTurn = FakeSession(Result.success(Unit), Result.success(response(200)))
        val turnSessions = ArrayDeque(listOf(firstTurn, recoveredTurn))
        var recoveryRequests = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            maxRetries = 0,
            backoffBaseMs = 100,
            onRecoveryRequired = { recoveryRequests += 1 },
            turnSessionFactory = { turnSessions.removeFirst() },
            p2pCandidateProvider = { plan().p2pCandidate },
            p2pSessionFactory = P2PSessionFactory { error("direct P2P must not be attempted") },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        firstTurn.disconnectUnexpected("network-change")
        runCurrent()

        assertEquals(1, recoveryRequests)
        assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        assertEquals(TransportKind.None, supervisor.state.value.transport)
        assertFalse(firstTurn.isOpen)

        // A fresh signed plan represents the application re-fetching bootstrap
        // and obtaining a new TURN lease after the old carrier died.
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        assertTrue(recoveredTurn.isOpen)
        supervisor.stop()
    }

    @Test
    fun `stop then start rebuilds the TURN carrier for lifecycle recovery`() = runTest {
        val firstTurn = FakeSession(Result.success(Unit), Result.success(response(200)))
        val recoveredTurn = FakeSession(Result.success(Unit), Result.success(response(200)))
        val turnSessions = ArrayDeque(listOf(firstTurn, recoveredTurn))
        val supervisor = supervisor(
            scope = this,
            turnSessionFactory = { turnSessions.removeFirst() },
            p2pSessionFactory = P2PSessionFactory { error("P2P is upgrade-only in this test") },
        )

        supervisor.start()
        supervisor.applyBootstrap(plan())
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertTrue(firstTurn.isOpen)

        supervisor.stop()
        assertFalse(firstTurn.isOpen)

        supervisor.start()
        runCurrent()
        assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        assertTrue(recoveredTurn.isOpen)
        supervisor.stop()
    }

    @Test
    fun `zombie open channel foreground probe triggers reconnect within 4 seconds`() = runTest {
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            livenessProbeHandler = { delay(60_000); true }
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()
            assertTrue(session.isOpen)

            val job = launch { supervisor.verifyForegroundCarrier { true } }
            runCurrent()
            advanceTimeBy(2_500)
            runCurrent()
            assertEquals(0, recoveries, "First timeout should perform one immediate 1.5s retry")
            assertTrue(session.isOpen)

            advanceTimeBy(1_500)
            runCurrent()
            job.join()
            assertFalse(session.isOpen)
            assertEquals(1, recoveries)
            assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `foreground probe skips active check when inbound frame arrived within 1500ms`() = runTest {
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            inboundElapsedMs = 500L
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            supervisor.verifyForegroundCarrier { true }
            runCurrent()
            assertEquals(0, session.livenessProbes)
            assertEquals(0, recoveries)
            assertTrue(session.isOpen)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `foreground probe coalesces with hung background probe and preserves 401 auth handling`() = runTest {
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            livenessProbeHandler = { delay(60_000); true }
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            // Start background health probe at t = 3000ms.
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS)
            runCurrent()
            assertEquals(1, session.livenessProbes)

            // Foreground resumes at t = 4000ms while background probe is hung: must coalesce, not skip.
            advanceTimeBy(1_000)
            val fgJob = launch { supervisor.verifyForegroundCarrier { true } }
            runCurrent()
            assertEquals(1, session.livenessProbes, "Foreground must coalesce onto active background probe")

            // Background probe times out at t = 5500ms; foreground immediately launches 1.5s retry.
            advanceTimeBy(1_500)
            runCurrent()
            assertEquals(2, session.livenessProbes)
            assertTrue(session.isOpen)

            advanceTimeBy(1_500)
            runCurrent()
            fgJob.join()
            assertFalse(session.isOpen)
            assertEquals(1, recoveries)
        } finally {
            supervisor.stop()
        }

        // Legacy session without dc_keepalive_v1 still triggers auth-required on 401/403 foreground probe.
        var authRequired = 0
        var reads = 0
        val legacy = FakeSession(Result.success(Unit))
        val legacyWrapper = object : P2PSession by legacy {
            override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
                reads++
                return Result.success(response(if (reads == 1) 200 else 401))
            }
        }
        val legacySupervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { legacyWrapper },
            onAuthenticationRequired = { authRequired++ },
        )
        try {
            legacySupervisor.start()
            legacySupervisor.applyBootstrap(plan())
            runCurrent()
            legacySupervisor.verifyForegroundCarrier { true }
            runCurrent()
            assertEquals(1, authRequired)
            assertEquals(ConnectionStatus.AuthenticationRequired, legacySupervisor.state.value.status)
            assertFalse(legacy.isOpen)
        } finally {
            legacySupervisor.stop()
        }
    }

    @Test
    fun `foreground probe keeps carrier alive if inbound frame arrives during probe window`() = runTest {
        lateinit var session: FakeSession
        session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            livenessProbeHandler = {
                delay(1_000)
                session.inboundGeneration++
                session.inboundElapsedMs = 0L
                false
            }
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            val fgJob = launch { supervisor.verifyForegroundCarrier { true } }
            runCurrent()
            advanceTimeBy(1_500)
            runCurrent()
            fgJob.join()
            assertTrue(session.isOpen)
            assertEquals(0, recoveries)
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `onCarrierSuspect wakes immediate liveness check without tearing down healthy slow carrier`() = runTest {
        var healthy = true
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            livenessProbeHandler = {
                if (healthy) {
                    delay(20)
                    true
                } else {
                    delay(60_000)
                    true
                }
            }
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            supervisor.onCarrierSuspect(session)
            advanceTimeBy(25)
            runCurrent()
            assertEquals(1, session.livenessProbes)
            assertTrue(session.isOpen)
            assertEquals(0, recoveries)
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)

            // Now simulate a zombie DataChannel where keepalive pings hang.
            healthy = false
            supervisor.onCarrierSuspect(session)
            runCurrent()
            assertEquals(2, session.livenessProbes)
            advanceTimeBy(2_500)
            runCurrent()
            assertTrue(session.isOpen, "Must retry once after 500ms before closing")
            advanceTimeBy(500)
            runCurrent()
            assertEquals(3, session.livenessProbes)
            advanceTimeBy(2_000)
            runCurrent()
            assertFalse(session.isOpen)
            assertEquals(1, recoveries)
            assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `periodic health probe covers p2pSession, skips recent inbound frames, and recovers silent failure under 5s`() = runTest {
        val p2p = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            inboundElapsedMs = 1_000L
        }
        p2p.connect()
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.installP2PSessionForTest(p2p)
            runCurrent()

            // Recent inbound frame (< 3000ms) skips active probe.
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS)
            runCurrent()
            assertEquals(0, p2p.livenessProbes)
            assertTrue(p2p.isOpen)

            // Once inbound traffic stops, two silent probe failures recover within 5s (2.5s + 0.5s + 2.0s).
            p2p.inboundElapsedMs = 5_000L
            p2p.livenessProbeHandler = { delay(60_000); true }
            advanceTimeBy(ConnectivitySupervisor.CARRIER_HEALTH_INTERVAL_MS)
            runCurrent()
            assertEquals(1, p2p.livenessProbes)

            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(2, p2p.livenessProbes)
            assertFalse(p2p.isOpen)
            assertEquals(1, recoveries)
            assertEquals(ConnectionStatus.Degraded, supervisor.state.value.status)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `onCapabilitiesChanged triggers debounced non-destructive liveness probe on active carrier`() = runTest {
        val monitor = FakeNetworkMonitor()
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = monitor,
            scope = this,
            turnRecheckIntervalMs = 60_000L,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            // Rapid capability jitter must debounce for >= 2s.
            monitor.capabilityJitter()
            advanceTimeBy(500)
            monitor.capabilityJitter()
            advanceTimeBy(1_900)
            runCurrent()
            assertEquals(0, session.livenessProbes)

            advanceTimeBy(100)
            runCurrent()
            assertEquals(1, session.livenessProbes)
            assertTrue(session.isOpen)
            assertEquals(0, recoveries)
        } finally {
            supervisor.stop()
        }
    }

    @Test fun `supervisor transport tracks resolvedCarrier across updates and health checks`() = runTest {
        val session = FakeSession(Result.success(Unit)).apply { supportsKeepalive = true }
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_fixture" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnRecheckIntervalMs = 1_000L,
            turnSessionFactory = { session },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertEquals(TransportKind.Turn, supervisor.state.value.transport)

            session.mutableResolvedCarrier.value = P2PIceCarrier.P2P
            runCurrent()
            assertEquals(TransportKind.P2P, supervisor.state.value.transport)

            // Periodic carrier health check preserves P2P rather than overwriting it with Turn.
            advanceTimeBy(1_001L)
            runCurrent()
            assertEquals(TransportKind.P2P, supervisor.state.value.transport)

            session.mutableResolvedCarrier.value = P2PIceCarrier.Turn
            runCurrent()
            assertEquals(TransportKind.Turn, supervisor.state.value.transport)
        } finally {
            supervisor.stop()
        }
    }

    @Test fun `bootstrap report deduplicates per session and emits migrated webrtc for direct ICE`() {
        val currentPlan = plan()
        val sessionA = FakeSession(Result.success(Unit))
        val sessionB = FakeSession(Result.success(Unit))
        val carrier = currentPlan.turnCarrier!!

        val initialTurn = nextBootstrapConnectionReport(
            transportKind = TransportKind.Turn,
            currentPlan = currentPlan,
            currentSession = sessionA,
            sessionCarrier = carrier,
            lastReportedSession = null,
            lastReportedTransport = null,
        )
        assertEquals("connected", initialTurn?.phase)
        assertEquals("turn", initialTurn?.transport)

        val duplicateTurn = nextBootstrapConnectionReport(
            transportKind = TransportKind.Turn,
            currentPlan = currentPlan,
            currentSession = sessionA,
            sessionCarrier = carrier,
            lastReportedSession = initialTurn?.reportedSession,
            lastReportedTransport = initialTurn?.transport,
        )
        assertEquals(null, duplicateTurn)

        val migratedWebrtc = nextBootstrapConnectionReport(
            transportKind = TransportKind.P2P,
            currentPlan = currentPlan,
            currentSession = sessionA,
            sessionCarrier = carrier,
            lastReportedSession = initialTurn?.reportedSession,
            lastReportedTransport = initialTurn?.transport,
        )
        assertEquals("migrated", migratedWebrtc?.phase)
        assertEquals("webrtc", migratedWebrtc?.transport)
        assertEquals("p2p-1", migratedWebrtc?.candidateId)
        assertEquals("turn-connection-1", migratedWebrtc?.connectionId)

        val duplicateWebrtc = nextBootstrapConnectionReport(
            transportKind = TransportKind.P2P,
            currentPlan = currentPlan,
            currentSession = sessionA,
            sessionCarrier = carrier,
            lastReportedSession = migratedWebrtc?.reportedSession,
            lastReportedTransport = migratedWebrtc?.transport,
        )
        assertEquals(null, duplicateWebrtc)

        // Direct P2P confirmed before any Turn report still sends phase="migrated" so TURN lease is released.
        val directInitialWebrtc = nextBootstrapConnectionReport(
            transportKind = TransportKind.P2P,
            currentPlan = currentPlan,
            currentSession = sessionB,
            sessionCarrier = carrier,
            lastReportedSession = migratedWebrtc?.reportedSession,
            lastReportedTransport = migratedWebrtc?.transport,
        )
        assertEquals("migrated", directInitialWebrtc?.phase)
        assertEquals("webrtc", directInitialWebrtc?.transport)
        assertEquals(sessionB, directInitialWebrtc?.reportedSession)
    }

    @Test
    fun `fast foreground probe triggers reconnect within 1500ms`() = runTest {
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
            livenessProbeHandler = { delay(60_000); true }
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            onRecoveryRequired = { recoveries++ },
            foregroundProbeTimeoutMs = ConnectivitySupervisor.FOREGROUND_FAST_PROBE_TIMEOUT_MS,
            foregroundProbeRetryTimeoutMs = ConnectivitySupervisor.FOREGROUND_FAST_PROBE_RETRY_TIMEOUT_MS,
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            val job = launch { supervisor.verifyForegroundCarrier { true } }
            runCurrent()
            advanceTimeBy(800)
            runCurrent()
            assertEquals(0, recoveries, "First 800ms timeout should trigger immediate 700ms retry")
            assertTrue(session.isOpen)

            advanceTimeBy(700)
            runCurrent()
            job.join()
            assertFalse(session.isOpen)
            assertEquals(1, recoveries)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `background health check relaxes interval to 15 seconds`() = runTest {
        var inForeground = false
        val session = FakeSession(Result.success(Unit)).apply {
            supportsKeepalive = true
        }
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "" },
            credentialProvider = { "rda_test" },
            monitor = FakeNetworkMonitor(),
            scope = this,
            turnSessionFactory = { session },
            isForeground = { inForeground },
        )
        try {
            supervisor.start()
            supervisor.applyBootstrap(plan())
            runCurrent()

            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(0, session.livenessProbes, "Background mode must not probe every 3s")

            advanceTimeBy(12_000)
            runCurrent()
            assertEquals(1, session.livenessProbes, "Background mode should probe at 15s")
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `default network change keeps active session when ice restart succeeds`() = runTest {
        val monitor = FakeNetworkMonitor()
        val session = FakeSession(connectResult = Result.success(Unit)).apply {
            iceRestartSupported = true
            iceRestartResult = true
        }
        var recoveries = 0
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_test" },
            monitor = monitor,
            scope = this,
            maxRetries = 0,
            backoffBaseMs = 100,
            turnSessionFactory = { session },
            p2pCandidateProvider = { null },
            p2pSessionFactory = null,
            onRecoveryRequired = { recoveries++ },
        )

        supervisor.start()
        try {
            supervisor.applyBootstrap(plan())
            runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)

            monitor.changeDefaultNetwork()
            runCurrent()

            assertEquals(1, session.iceRestartAttempts)
            assertEquals(0, recoveries, "Successful ICE restart must avoid teardown recovery")
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)
            assertEquals(true, session.isOpen)
        } finally {
            supervisor.stop()
        }
    }

    @Test
    fun `default network change falls back to recovery when ice restart fails`() = runTest {
        val monitor = FakeNetworkMonitor()
        val session = FakeSession(connectResult = Result.success(Unit)).apply {
            iceRestartSupported = true
            iceRestartResult = false
        }
        val reasons = mutableListOf<String>()
        val supervisor = ConnectivitySupervisor(
            endpointProvider = { "https://control.example.com" },
            credentialProvider = { "rda_test" },
            monitor = monitor,
            scope = this,
            maxRetries = 0,
            backoffBaseMs = 100,
            turnSessionFactory = { session },
            p2pCandidateProvider = { null },
            p2pSessionFactory = null,
            onRecoveryRequired = { reasons += it },
        )

        supervisor.start()
        try {
            supervisor.applyBootstrap(plan())
            runCurrent()
            assertEquals(ConnectionStatus.Connected, supervisor.state.value.status)

            monitor.changeDefaultNetwork()
            runCurrent()

            assertEquals(1, session.iceRestartAttempts)
            assertEquals(listOf("default-network-changed"), reasons)
            assertEquals(false, session.isOpen)
        } finally {
            supervisor.stop()
        }
    }

    private fun supervisor(
        scope: kotlinx.coroutines.CoroutineScope,
        maxRetries: Int = 0,
        turnSessionFactory: suspend (TurnCarrier) -> P2PSession,
        p2pSessionFactory: P2PSessionFactory,
    ) = ConnectivitySupervisor(
        endpointProvider = { "https://control.example.com" },
        credentialProvider = { "rda_test" },
        monitor = FakeNetworkMonitor(),
        scope = scope,
        maxRetries = maxRetries,
        backoffBaseMs = 100,
        turnSessionFactory = turnSessionFactory,
        p2pCandidateProvider = { plan().p2pCandidate },
        p2pSessionFactory = p2pSessionFactory,
    )

    private fun plan(): BootstrapConnectionPlan {
        val turnCandidate = P2PCandidate(
            signalingUrl = "https://signal.example.com",
            roomId = "room-1",
            secret = "paired-secret",
            iceServers = listOf(IceServer(
                url = "turn:turn.cloudflare.com:50000?transport=udp",
                username = "123:app",
                password = "signed-password",
            )),
            turnOnly = true,
        )
        val p2pCandidate = turnCandidate.copy(
            iceServers = listOf(IceServer("stun:stun.example.com:19302")),
            turnOnly = false,
        )
        val turn = ConnectionBootstrapTurnDto(
            provider = "cloudflare-realtime",
            endpoint = "turn:turn.cloudflare.com:50000?transport=udp",
            iceServers = listOf(com.andysagent.ragent.core.protocol.ConnectionBootstrapIceServerDto(
                urls = "turn:turn.cloudflare.com:50000?transport=udp",
                username = "123:app",
                password = "signed-password",
            )),
            expiresAt = "2099-01-01T00:00:00.000Z",
            transport = "turn",
            appTrafficOnly = true,
            credentialScope = "device-access",
            source = "turn-broker",
            connectionId = "turn-connection-1",
            authorization = authorization(),
        )
        val contract = ConnectionBootstrapContractDto(
            contractVersion = 2,
            instanceId = "instance-1",
            deviceId = "device-1",
            enrollmentKind = "account-join",
            connectionMode = "turn-first",
            issuedAt = "2098-01-01T00:00:00.000Z",
            expiresAt = "2099-01-01T00:00:00.000Z",
            candidates = listOf(
                ConnectionBootstrapCandidateDto("turn-1", "turn", "cloudflare-realtime", turn.endpoint, 120, turn.expiresAt, false),
                ConnectionBootstrapCandidateDto("p2p-1", "webrtc", "core_p2p", "https://signal.example.com", 60, turn.expiresAt, false),
            ),
            turn = turn,
            turnAuthorization = authorization(),
            initialCarrier = ConnectionBootstrapInitialCarrierDto("turn-1", "turn", "cloudflare-realtime", turn.endpoint),
            upgrade = null,
            fallback = null,
            signature = ConnectionBootstrapSignatureDto("ed25519", "key-1", "2098-01-01T00:00:00.000Z", "signature"),
        )
        return BootstrapConnectionPlan(
            bootstrapEndpoint = "https://control.example.com",
            contract = contract,
            p2pCandidate = p2pCandidate,
            turnCarrier = TurnCarrier(
                endpoint = turn.endpoint,
                candidateId = "turn-1",
                provider = "cloudflare-realtime",
                p2pCandidate = turnCandidate,
            ),
        )
    }

    private fun authorization() = ConnectionBootstrapTurnAuthorizationDto(
        policyVersion = "turn-account-quota-v1",
        authorized = true,
        status = "authorized",
        reasonCode = "turn_authorized",
        plan = "free",
        maxDevices = 1,
        activeDeviceCount = 1,
        connectionId = "turn-connection-1",
    )

    private fun response(status: Int) = P2PHttpResponse(id = "probe", status = status)

    private class FakeNetworkMonitor : NetworkMonitor {
        private var callback: NetworkMonitor.Callback? = null
        private var online = true
        override val isOnline: Boolean get() = online
        override fun register(callback: NetworkMonitor.Callback) { this.callback = callback }
        override fun unregister() { callback = null }
        fun capabilityJitter() { callback?.onCapabilitiesChanged() }
        fun changeDefaultNetwork() { callback?.onDefaultNetworkChanged() }
        fun loseNetwork() {
            online = false
            callback?.onLost()
        }
    }

    private class FakeSession(
        private val connectResult: Result<Unit>,
        private var responseResult: Result<P2PHttpResponse> = Result.success(P2PHttpResponse(id = "probe", status = 200)),
        private val connectDelayMs: Long = 0L,
    ) : P2PSession {
        private var unexpectedCloseListener: ((String) -> Unit)? = null
        private var handoffListener: ((Long, String) -> Unit)? = null
        var supportsHandoff = false
        var suspensions = 0
        var resumptions = 0
        var commitGate: CompletableDeferred<Int>? = null
        var loseFirstCommit = false
        var hangFirstCommit = false
        var failAllCommits = false
        var commitAttempts = 0
        var supportsKeepalive = false
        var inboundElapsedMs: Long = Long.MAX_VALUE
        var inboundGeneration: Long = 0L
        var livenessProbes = 0
        var livenessProbeHandler: (suspend (Long) -> Boolean)? = null
        var iceRestartSupported = false
        var iceRestartResult = false
        var iceRestartAttempts = 0
        val mutableResolvedCarrier = MutableStateFlow(P2PIceCarrier.Unknown)
        override val resolvedCarrier: StateFlow<P2PIceCarrier> = mutableResolvedCarrier.asStateFlow()

        override var isOpen: Boolean = false
            private set

        override val lastInboundFrameElapsedMs: Long get() = inboundElapsedMs
        override val inboundFrameGeneration: Long get() = inboundGeneration
        override val supportsKeepaliveProbe: Boolean get() = supportsKeepalive
        override val supportsIceRestart: Boolean get() = iceRestartSupported && isOpen

        override suspend fun restartIce(timeoutMs: Long): Boolean {
            iceRestartAttempts++
            return iceRestartResult
        }

        override suspend fun probeLiveness(timeoutMs: Long): Boolean {
            livenessProbes++
            return livenessProbeHandler?.invoke(timeoutMs) ?: true
        }

        override fun setUnexpectedCloseListener(listener: ((String) -> Unit)?) {
            unexpectedCloseListener = listener
        }

        override fun setCarrierHandoffListener(listener: ((Long, String) -> Unit)?) { handoffListener = listener }
        override fun configureHandoffOffer(handoffId: String): Boolean = handoffId == "a".repeat(32)
        override fun suspendSignalingForHandoff(): Boolean { suspensions++; return supportsHandoff }
        override suspend fun resumeSignalingAfterHandoff(): Boolean { resumptions++; return supportsHandoff }
        fun requestHandoff() { handoffListener?.invoke(20_000L, "a".repeat(32)) }

        override suspend fun connect(): Result<Unit> {
            if (connectDelayMs > 0) delay(connectDelayMs)
            if (connectResult.isSuccess) isOpen = true
            return connectResult
        }

        override suspend fun request(request: P2PHttpRequest): Result<P2PHttpResponse> {
            if (request.path == "/api/device-auth/turn/handoff/commit") {
                commitAttempts++
                if (failAllCommits) return Result.failure(IllegalStateException("commit response lost"))
                if (loseFirstCommit && commitAttempts == 1) {
                    if (hangFirstCommit) delay(60_000)
                    return Result.failure(IllegalStateException("commit response lost"))
                }
                if (commitGate != null) return Result.success(P2PHttpResponse(id = request.id, status = commitGate!!.await()))
            }
            return responseResult.map { it.copy(id = request.id) }
        }

        fun failReads() { responseResult = Result.failure(IllegalStateException("fixture unreachable")) }
        fun answerReads(response: P2PHttpResponse) { responseResult = Result.success(response) }

        override fun close() {
            isOpen = false
        }

        fun disconnectUnexpected(reason: String) {
            isOpen = false
            unexpectedCloseListener?.invoke(reason)
        }
    }
}
