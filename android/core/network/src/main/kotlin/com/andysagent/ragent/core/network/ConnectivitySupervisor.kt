package com.andysagent.ragent.core.network

import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Result of a connectivity probe. Injected for testability so tests
 * never touch the network or Android framework.
 */
sealed class ProbeResult {
    /** Server returned a successful (2xx) HTTP response. */
    data class HttpSuccess(val statusCode: Int) : ProbeResult()

    /** Server returned a non-2xx HTTP response — endpoint is reachable but auth/data may be missing. */
    data class HttpResponse(val statusCode: Int) : ProbeResult()

    /** TCP / HTTP-level failure (timeout, DNS, reset, etc.). */
    data class NetworkError(val message: String) : ProbeResult()

    /** The platform reports no connectivity — don't even try the probe. */
    data object NetworkOffline : ProbeResult()
}

/**
 * Single authoritative source of truth for device connection state on Android.
 *
 * Uses [ConnectivityManager.NetworkCallback] (via [NetworkMonitor]) rather than
 * polling legacy APIs. Probes the Ragent endpoint over HTTP, retries with
 * exponential backoff, and auto-recovers on network changes.
 *
 * ADR-0001 v3 layering:
 *   Paired -> Reachable -> Authenticated -> Connected -> Degraded/Offline
 *
 * The [state] [StateFlow] is the canonical connection state. Map it to
 * [RuntimeConnectionState] for the transport/UI via [toRuntimeConnectionState].
 */
class ConnectivitySupervisor(
    private val endpointProvider: () -> String?,
    private val credentialProvider: () -> String?,
    private val monitor: NetworkMonitor,
    private val scope: CoroutineScope,
    private val backoffBaseMs: Long = 1_000L,
    // Maximum number of consecutive retry attempts before giving up.
    private val maxRetries: Int = 10,
    // P2P upgrade: when the initial carrier is unavailable or the network
    // permits an upgrade, the supervisor attempts the signed WebRTC candidate.
    private val p2pCandidateProvider: (() -> P2PCandidate?)? = null,
    private val p2pSessionFactory: P2PSessionFactory? = null,
    private val onP2PSessionReady: ((P2PSession) -> Unit)? = null,
    private val onP2PSessionClosed: ((P2PSession) -> Unit)? = null,
    // TURN-first contracts install their signed TURN carrier after bootstrap.
    private val turnSessionFactory: (suspend (TurnCarrier) -> P2PSession)? = null,
    private val onTurnSessionReady: ((P2PSession) -> Unit)? = null,
    private val onTurnSessionClosed: ((P2PSession) -> Unit)? = null,
    private val onTurnFailed: ((String) -> Unit)? = null,
    private val onRecoveryRequired: ((String) -> Unit)? = null,
    private val turnRecheckIntervalMs: Long = CARRIER_HEALTH_INTERVAL_MS,
    private val onAuthenticationRequired: (() -> Unit)? = null,
    private val credentialRejectionHandler: CredentialRejectionHandler? = null,
    private val onTurnReservationFailed: ((TurnCarrier?, String) -> Unit)? = null,
    private val bootstrapPending: () -> Boolean = { false },
    private val onTurnHandoffReady: ((P2PSession) -> Unit)? = null,
    private val useSignedHandoff: () -> Boolean = { false },
    private val signedHandoffPlan: (suspend (String) -> BootstrapConnectionPlan?)? = null,
    private val onSignedHandoffFinished: ((Boolean) -> Unit)? = null,
) {
    companion object {
        // Visible for testing.
        const val MAX_BACKOFF_MS = 30_000L

        // Legacy interval retained for compatibility; no second offer is made.
        const val TURN_RECHECK_INTERVAL_MS = 30_000L
        const val CARRIER_HEALTH_INTERVAL_MS = 3_000L
        const val CARRIER_HEALTH_TIMEOUT_MS = 2_500L
        const val CARRIER_HEALTH_RETRY_DELAY_MS = 500L
        const val CARRIER_HEALTH_RETRY_TIMEOUT_MS = 2_000L
        const val FOREGROUND_PROBE_TIMEOUT_MS = 2_500L
        const val FOREGROUND_PROBE_RETRY_TIMEOUT_MS = 1_500L
        const val FOREGROUND_RECENT_INBOUND_SKIP_MS = 1_500L
        const val PERIODIC_RECENT_INBOUND_SKIP_MS = 3_000L
        const val CAPABILITY_PROBE_DEBOUNCE_MS = 2_000L
        const val TURN_CONNECT_TIMEOUT_MS = 20_000L
        const val P2P_CONNECT_TIMEOUT_MS = 20_000L
    }

    private sealed class CarrierProbeOutcome {
        data object Alive : CarrierProbeOutcome()
        data class AuthDenied(val statusCode: Int) : CarrierProbeOutcome()
        data object Failed : CarrierProbeOutcome()
    }

    private val _state = MutableStateFlow(
        ConnectionState(ConnectionStatus.Offline, updatedAt = System.currentTimeMillis())
    )
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private var probeJob: Job? = null
    private val probeMutex = Mutex()
    private val handlingCarrierClose = AtomicBoolean(false)
    private var wasConnected = false
    private var retryCount = 0
    @Volatile private var started = false
    @Volatile private var stopped = true
    @Volatile private var observedOffline = false

    private var p2pSession: P2PSession? = null

    // Initial TURN carrier and signed P2P upgrade state.
    @Volatile private var turnSession: P2PSession? = null
    @Volatile private var activeTurnCarrier: TurnCarrier? = null
    private var turnRecheckJob: Job? = null
    private var capabilityProbeJob: Job? = null
    private var healthWakeSignal: Channel<Boolean>? = null
    private var activeProbeSession: P2PSession? = null
    private var activeProbeDeferred: Deferred<CarrierProbeOutcome>? = null
    private val carrierHealthLock = Any()
    private var healthSession: P2PSession? = null
    @Volatile private var bootstrapPlan: BootstrapConnectionPlan? = null
    private var bootstrapTurnAttempted = false
    @Volatile private var activeProbeCredential: String? = null
    private class Handoff(val old: P2PSession) {
        val nextPlan = CompletableDeferred<BootstrapConnectionPlan>()
        var job: Job? = null
    }
    private val handoffLock = Any()
    private var handoff: Handoff? = null

    fun start() {
        if (started) return
        started = true
        stopped = false
        observedOffline = !monitor.isOnline
        val endpoint = endpointProvider()?.takeIf { it.isNotBlank() }
        val current = _state.value

        // Process-restart recovery: if a persisted endpoint exists, move to Paired.
        if (endpoint != null) {
            _state.value = current.copy(
                status = ConnectionStatus.Paired,
                transport = TransportKind.None,
                endpoint = endpoint,
                updatedAt = System.currentTimeMillis(),
            )
        }

        monitor.register(object : NetworkMonitor.Callback {
            override fun onAvailable() {
                if (stopped) return
                val restored = observedOffline
                observedOffline = false
                retryCount = 0
                cancelBackoff()
                // An app launched offline may be sleeping in bootstrap retry
                // backoff and have no previous default route to trigger the
                // route-change callback. Wake that bootstrap on first return.
                if (restored && onRecoveryRequired != null && _state.value.status != ConnectionStatus.AuthenticationRequired) {
                    onRecoveryRequired.invoke("network-restored")
                    return
                }
                scheduleProbe(delayMs = 0)
            }

            override fun onLost() {
                if (stopped) return
                observedOffline = true
                cancelBackoff()
                cancelTurnRecheck()
                bootstrapTurnAttempted = false
                closeP2PSession()
                closeTurnSession()
                _state.value = _state.value.copy(
                    status = ConnectionStatus.Offline,
                    reachable = false,
                    authenticated = false,
                    transport = TransportKind.None,
                    retryCount = retryCount,
                    lastError = "Network unavailable",
                    updatedAt = System.currentTimeMillis(),
                )
            }

            override fun onCapabilitiesChanged() {
                if (stopped) return
                val activeSession = p2pSession ?: turnSession
                if (activeSession != null) {
                    scheduleCapabilitiesProbe(activeSession)
                    return
                }
                if (probeMutex.isLocked) return
                // IP change / WiFi <-> 5G — re-probe immediately, don't wait for backoff.
                retryCount = 0
                cancelBackoff()
                scheduleProbe(delayMs = 0)
            }

            override fun onDefaultNetworkChanged() {
                if (stopped) return
                observedOffline = false
                probeJob?.cancel()
                cancelBackoff()
                cancelTurnRecheck()
                closeP2PSession()
                closeTurnSession()
                bootstrapTurnAttempted = false
                retryCount = 0
                updateState(ConnectionStatus.Degraded, reachable = false,
                    transport = TransportKind.None, lastError = "Default network changed")
                // Wi-Fi/mobile transitions are not capability jitter. Obtain
                // a fresh fixed-target contract when a controller owns one.
                onRecoveryRequired?.invoke("default-network-changed") ?: scheduleProbe(delayMs = 0)
            }
        })

        // Kick off the initial probe.
        scheduleProbe(delayMs = 0)
    }

    fun stop() {
        if (!started) return
        started = false
        stopped = true
        cancelHandoff()
        monitor.unregister()
        probeJob?.cancel()
        probeJob = null
        cancelTurnRecheck()
        closeP2PSession()
        closeTurnSession()
        bootstrapTurnAttempted = false
        wasConnected = false
        retryCount = 0
        _state.value = _state.value.copy(
            status = ConnectionStatus.Offline,
            transport = TransportKind.None,
            reachable = false,
            authenticated = false,
            retryCount = 0,
            lastError = null,
            updatedAt = System.currentTimeMillis(),
        )
    }

    /** A failed business exchange detects a dead carrier before the periodic health probe. */
    fun carrierRequestFailed(failed: P2PSession?) {
        if (stopped || _state.value.status == ConnectionStatus.AuthenticationRequired) return
        val turn = turnSession
        val peer = p2pSession
        when {
            turn != null && (failed === turn || failed == null && !turn.isOpen) ->
                handleUnexpectedTurnClose(turn, "request-failed")
            peer != null && (failed === peer || failed == null && !peer.isOpen) ->
                handleUnexpectedP2PClose(peer, "request-failed")
            failed == null && turn == null && peer == null -> {
                // A request can arrive before bootstrap or the authenticated
                // probe has finished. Recovery is already in progress; starting
                // another join would cancel it and invalidate its credential.
                if (handlingCarrierClose.get() || bootstrapPending() || (bootstrapPlan != null && probeJob?.isActive == true)) return
                recoverOrRetry("carrier-unavailable", "Computer connection is unavailable")
            }
        }
    }

    /**
     * Non-destructive hint (e.g. request timeout or ICE DISCONNECTED) that [session] may be silent.
     * Wakes the liveness probe immediately without tearing down a healthy-but-slow carrier.
     */
    fun onCarrierSuspect(session: P2PSession) {
        if (stopped || _state.value.status == ConnectionStatus.AuthenticationRequired) return
        val active = p2pSession ?: turnSession ?: return
        if (active !== session) return
        if (!session.isOpen) {
            if (session === turnSession && p2pSession == null) handleUnexpectedTurnClose(session, "carrier-closed")
            else if (session === p2pSession) handleUnexpectedP2PClose(session, "carrier-closed")
            return
        }
        val wake = synchronized(carrierHealthLock) {
            if (healthSession !== session || turnRecheckJob?.isActive != true) {
                scheduleCarrierHealthCheckLocked()
            }
            healthWakeSignal
        }
        wake?.trySend(true)
    }

    /** Check the existing carrier after foregrounding without replacing a healthy session. */
    suspend fun verifyForegroundCarrier(stillForeground: () -> Boolean) {
        if (!stillForeground() || stopped || _state.value.status != ConnectionStatus.Connected) return
        val turn = turnSession
        val session = p2pSession ?: turn ?: return
        val isTurn = session === turn
        if (session.lastInboundFrameElapsedMs < FOREGROUND_RECENT_INBOUND_SKIP_MS) return

        val startResponseGeneration = session.successfulResponseGeneration
        val startInboundGeneration = session.inboundFrameGeneration
        val startInboundElapsed = session.lastInboundFrameElapsedMs
        val credential = credentialProvider()?.takeIf { it.isNotBlank() }

        val firstOutcome = try {
            runSingleFlightProbe(session, FOREGROUND_PROBE_TIMEOUT_MS, credential)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            CarrierProbeOutcome.Failed
        }
        if (!stillForeground() || stopped || (if (isTurn) turnSession !== session else p2pSession !== session)) return

        if (firstOutcome is CarrierProbeOutcome.AuthDenied) {
            if (credentialProvider()?.takeIf { it.isNotBlank() } == credential) {
                handleAuthenticationRequired(firstOutcome.statusCode, credential) {
                    if (isTurn) turnSession === session else p2pSession === session
                }
            }
            return
        }

        if (firstOutcome is CarrierProbeOutcome.Alive ||
            session.successfulResponseGeneration != startResponseGeneration ||
            session.inboundFrameGeneration != startInboundGeneration ||
            session.lastInboundFrameElapsedMs < startInboundElapsed
        ) {
            return
        }

        if (session.isOpen && session.lastInboundFrameElapsedMs >= FOREGROUND_RECENT_INBOUND_SKIP_MS) {
            val retryCredential = credentialProvider()?.takeIf { it.isNotBlank() }
            val retryOutcome = try {
                runSingleFlightProbe(session, FOREGROUND_PROBE_RETRY_TIMEOUT_MS, retryCredential)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                CarrierProbeOutcome.Failed
            }
            if (!stillForeground() || stopped || (if (isTurn) turnSession !== session else p2pSession !== session)) return

            if (retryOutcome is CarrierProbeOutcome.AuthDenied) {
                if (credentialProvider()?.takeIf { it.isNotBlank() } == retryCredential) {
                    handleAuthenticationRequired(retryOutcome.statusCode, retryCredential) {
                        if (isTurn) turnSession === session else p2pSession === session
                    }
                }
                return
            }

            if (retryOutcome is CarrierProbeOutcome.Alive ||
                session.successfulResponseGeneration != startResponseGeneration ||
                session.inboundFrameGeneration != startInboundGeneration ||
                session.lastInboundFrameElapsedMs < startInboundElapsed
            ) {
                return
            }
        }

        if (isTurn) handleUnexpectedTurnClose(session, "foreground-probe-failed")
        else handleUnexpectedP2PClose(session, "foreground-probe-failed")
    }

    fun recheck() {
        if (stopped) return
        retryCount = 0
        cancelBackoff()
        scheduleProbe(delayMs = 0)
    }

    /**
     * Installs a server-authenticated route. No transport is selected from an endpoint
     * before this method is called for the current paired device.
     */
    fun applyBootstrap(plan: BootstrapConnectionPlan) {
        // A bootstrap refresh normally mints a new short-lived TURN lease.  It
        // can happen more than once during a single foreground transition
        // (pairing persistence, directory observation, and lifecycle recovery
        // all refresh the signed contract).  Do not start a second negotiation
        // while the existing carrier is healthy: OkHttpRagentTransport will
        // install the newer session and close the older one, which turns a
        // successful connection into a visible Connecting -> disconnected
        // loop.
        //
        // Keep the latest verified plan for future recovery, but retain the
        // open DataChannel until it closes, the network changes, or the app is
        // explicitly stopped.  An unexpected close resets the attempt flag and
        // asks the application to fetch a new lease.
        // Repeated publication of the identical plan must not cancel its
        // already connected but still authenticating initial carrier. Keep
        // replacement plans and credentials on the existing fencing path.
        if (bootstrapPlan == plan && bootstrapTurnAttempted && probeMutex.isLocked &&
            probeJob?.isActive == true && activeProbeCredential == credentialProvider()?.takeIf { it.isNotBlank() }) return
        val hasLiveCarrier = turnSession?.isOpen == true || p2pSession?.isOpen == true
        bootstrapPlan = plan
        if (hasLiveCarrier) {
            synchronized(handoffLock) { handoff?.takeIf { it.old === turnSession }?.nextPlan?.complete(plan) }
            return
        }
        bootstrapTurnAttempted = false
        if (!stopped) recheck()
    }

    fun clearBootstrap() {
        bootstrapPlan = null
        bootstrapTurnAttempted = false
        wasConnected = false
        retryCount = 0
        cancelTurnRecheck()
        closeP2PSession()
        closeTurnSession()
        if (!stopped) recheck()
    }

    fun toRuntimeConnectionState(state: ConnectionState = _state.value): RuntimeConnectionState = when (state.status) {
        ConnectionStatus.Connected,
        ConnectionStatus.Authenticated -> RuntimeConnectionState.Connected
        ConnectionStatus.Reachable,
        ConnectionStatus.Paired -> RuntimeConnectionState.Connecting
        ConnectionStatus.Degraded -> RuntimeConnectionState.Reconnecting
        ConnectionStatus.AuthenticationRequired -> RuntimeConnectionState.AuthenticationRequired
        ConnectionStatus.Offline -> if (monitor.isOnline && bootstrapPending()) {
            // A pending authenticated bootstrap has not yet produced a
            // carrier. Keep its progress visible without claiming it is live.
            if (wasConnected) RuntimeConnectionState.Reconnecting else RuntimeConnectionState.Connecting
        } else RuntimeConnectionState.Disconnected
        ConnectionStatus.Error -> RuntimeConnectionState.Error
    }

    // -----------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------

    private fun scheduleProbe(delayMs: Long) {
        if (stopped) return
        probeJob?.cancel()
        probeJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            if (!isActive) return@launch
            executeProbe()
        }
    }

    private fun cancelBackoff() {
        probeJob?.cancel()
    }

    private suspend fun executeProbe() = probeMutex.withLock {
        if (stopped) return

        // Platform reports no connectivity.
        if (!monitor.isOnline) {
            updateState(ConnectionStatus.Offline, reachable = false)
            return
        }

        val plan = bootstrapPlan
        if (plan == null || plan.connectionMode != "turn-first") {
            updateState(
                status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                reachable = false,
                authenticated = false,
                transport = TransportKind.None,
                lastError = "Verified TURN bootstrap is required",
            )
            return
        }
        val credential = credentialProvider()
        if (plan.connectionMode == "turn-first" && !bootstrapTurnAttempted) {
            bootstrapTurnAttempted = true
            val carrier = plan.turnCarrier
            if (carrier == null || turnSessionFactory == null) {
                onTurnFailed?.invoke("turn-unavailable")
                onTurnReservationFailed?.invoke(carrier, "turn-unavailable")
                bootstrapTurnAttempted = false
                updateState(
                    status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                    reachable = false,
                    transport = TransportKind.None,
                    lastError = "TURN bootstrap is unavailable",
                )
                recoverOrRetry("turn-unavailable", "TURN bootstrap is unavailable")
                return
            }
            activeProbeCredential = credential?.takeIf { it.isNotBlank() }
            try {
                when (val result = attemptTurnProbe(carrier, credential)) {
                    is ProbeResult.HttpSuccess -> {
                        val hasCred = !credential.isNullOrBlank()
                        retryCount = 0
                        updateState(
                            status = if (hasCred) ConnectionStatus.Connected else ConnectionStatus.Reachable,
                            reachable = true,
                            authenticated = hasCred,
                            transport = TransportKind.Turn,
                            clearLastError = true,
                        )
                        wasConnected = hasCred
                        scheduleTurnRecheck()
                        return
                    }

                    is ProbeResult.HttpResponse -> {
                        if (result.statusCode == 401 || result.statusCode == 403) {
                            val applied = handleAuthenticationRequired(result.statusCode, credential) { bootstrapPlan === plan }
                            if (!applied && !stopped && bootstrapPlan === plan) {
                                bootstrapTurnAttempted = false
                                scheduleProbe(0)
                            }
                        } else {
                            val failure = "TURN probe returned HTTP ${result.statusCode}"
                            bootstrapTurnAttempted = false
                            updateState(
                                status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                                reachable = false,
                                authenticated = false,
                                transport = TransportKind.None,
                                lastError = failure,
                            )
                            recoverOrRetry("turn-http-${result.statusCode}", failure)
                        }
                        return
                    }

                    else -> {
                        val failure = (result as? ProbeResult.NetworkError)?.message ?: "TURN bootstrap failed"
                        onTurnFailed?.invoke("turn-probe-failed")
                        onTurnReservationFailed?.invoke(carrier, "turn-probe-failed")
                        bootstrapTurnAttempted = false
                        updateState(
                            status = if (onRecoveryRequired != null || wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                            reachable = false,
                            transport = TransportKind.None,
                            lastError = failure,
                        )
                        val recoveryReason = if (failure.contains("ICE connection", ignoreCase = true))
                            "turn-ice-failed" else "turn-bootstrap-failed"
                        recoverOrRetry(recoveryReason, failure)
                        return
                    }
                }
            } finally {
                activeProbeCredential = null
                if (turnSession == null) {
                    bootstrapTurnAttempted = false
                }
            }
        }

        // A TURN-first carrier owns the single host-side peer connection.  Do
        // not try to create a second "direct" WebRTC session while it is
        // healthy: the Windows host replaces the existing peer on a new offer,
        // which disconnects the working DataChannel.  Recovery is instead
        // driven by the unexpected-close listener or an actual network change.
        if (turnSession != null) {
            retainTurnCarrier()
            return
        }
        updateState(
            status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
            reachable = false,
            transport = TransportKind.None,
            lastError = "TURN session is not available",
        )
        recoverOrRetry("turn-session-unavailable", "TURN session is not available")
    }

    private suspend fun attemptP2PProbe(): ProbeResult? {
        val candidate = p2pCandidateProvider?.invoke() ?: return null

        val session = try {
            p2pSessionFactory?.create(candidate) ?: return null
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            return ProbeResult.NetworkError("P2P session creation failed: ${error.message ?: error.javaClass.simpleName}")
        }

        val connectResult = try {
            withTimeoutOrNull(P2P_CONNECT_TIMEOUT_MS) { session.connect() }
        } catch (error: Exception) {
            session.close()
            if (error is CancellationException) throw error
            return ProbeResult.NetworkError("P2P connect failed: ${error.message ?: error.javaClass.simpleName}")
        }

        if (connectResult == null) {
            session.close()
            return ProbeResult.NetworkError("P2P connect timed out after ${P2P_CONNECT_TIMEOUT_MS}ms")
        }

        if (connectResult.isFailure) {
            session.close()
            return ProbeResult.NetworkError("P2P connect failed: ${connectResult.exceptionOrNull()?.message ?: "unknown error"}")
        }

        val credential = credentialProvider()
        val headers = mutableMapOf<String, String>()
        credential?.takeIf { it.isNotBlank() }?.let { headers["Authorization"] = "Bearer $it" }

        val request = P2PHttpRequest(
            id = UUID.randomUUID().toString(),
            method = "GET",
            path = "/api/auth/me",
            headers = headers,
        )

        return try {
            val responseResult = session.request(request)
            currentCoroutineContext().ensureActive()
            responseResult.fold(
                onSuccess = { response ->
                    if (response.error != null) {
                        session.close()
                        ProbeResult.NetworkError("P2P probe returned a remote error")
                    } else if (response.status in 200..299) {
                        p2pSession = session
                        observeUnexpectedClose(session, isTurn = false)
                        onP2PSessionReady?.invoke(session)
                        scheduleCarrierHealthCheck()
                        ProbeResult.HttpSuccess(response.status)
                    } else {
                        session.close()
                        ProbeResult.HttpResponse(response.status)
                    }
                },
                onFailure = {
                    session.close()
                    ProbeResult.NetworkError("P2P probe failed: ${it.message}")
                },
            )
        } catch (e: Exception) {
            session.close()
            if (e is CancellationException) throw e
            ProbeResult.NetworkError("P2P probe error: ${e.message}")
        }
    }

    internal fun installP2PSessionForTest(session: P2PSession) {
        p2pSession = session
        observeUnexpectedClose(session, isTurn = false)
        onP2PSessionReady?.invoke(session)
        wasConnected = true
        updateState(
            status = ConnectionStatus.Connected,
            reachable = true,
            authenticated = true,
            transport = TransportKind.P2P,
            clearLastError = true,
        )
        scheduleCarrierHealthCheck()
    }

    private fun closeP2PSession() {
        val session = p2pSession ?: return
        cancelCarrierHealthCheck(session)
        p2pSession = null
        onP2PSessionClosed?.invoke(session)
        session.close()
    }

    private fun observeUnexpectedClose(session: P2PSession, isTurn: Boolean) {
        if (isTurn && onTurnHandoffReady != null && onRecoveryRequired != null) {
            session.setCarrierHandoffListener { timeoutMs, handoffId -> beginHandoff(session, timeoutMs, handoffId) }
        }
        session.setCarrierSuspectListener { onCarrierSuspect(session) }
        session.setUnexpectedCloseListener { reason ->
            scope.launch {
                if (isTurn) handleUnexpectedTurnClose(session, reason)
                else handleUnexpectedP2PClose(session, reason)
            }
        }
    }

    private fun handleUnexpectedP2PClose(session: P2PSession, reason: String) {
        if (stopped || p2pSession !== session || !handlingCarrierClose.compareAndSet(false, true)) return
        try {
            if (stopped || p2pSession !== session) return
            cancelCarrierHealthCheck(session)
            p2pSession = null
            onP2PSessionClosed?.invoke(session)
            session.close()
            updateState(
                status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                reachable = false,
                transport = TransportKind.None,
                lastError = "P2P connection lost: $reason",
            )
            recoverOrRetry("p2p-$reason", "P2P connection lost: $reason")
        } finally { handlingCarrierClose.set(false) }
    }

    private fun closeTurnSession() {
        cancelHandoff()
        val session = turnSession ?: return
        cancelCarrierHealthCheck(session)
        turnSession = null
        activeTurnCarrier = null
        onTurnSessionClosed?.invoke(session)
        session.close()
    }

    private fun handleUnexpectedTurnClose(session: P2PSession, reason: String) {
        if (stopped || turnSession !== session || !handlingCarrierClose.compareAndSet(false, true)) return
        try {
            if (stopped || turnSession !== session) return
            cancelHandoff()
            val closedCarrier = activeTurnCarrier
            cancelCarrierHealthCheck(session)
            turnSession = null
            activeTurnCarrier = null
            onTurnSessionClosed?.invoke(session)
            session.close()
            bootstrapTurnAttempted = false
            updateState(
                status = if (wasConnected) ConnectionStatus.Degraded else ConnectionStatus.Offline,
                reachable = false,
                transport = TransportKind.None,
                lastError = "TURN connection lost: $reason",
            )
            onTurnFailed?.invoke("turn-$reason")
            onTurnReservationFailed?.invoke(closedCarrier, "turn-$reason")
            recoverOrRetry("turn-$reason", "TURN connection lost: $reason")
        } finally { handlingCarrierClose.set(false) }
    }

    // ── Initial-carrier / extension helpers ─

    private fun cancelHandoff() {
        val pending = synchronized(handoffLock) { handoff.also { handoff = null } }
        pending?.job?.cancel()
    }

    private fun beginHandoff(old: P2PSession, timeoutMs: Long, handoffId: String) {
        val requestRecovery = onRecoveryRequired ?: return
        val ready = onTurnHandoffReady ?: return
        val ticket = synchronized(handoffLock) {
            if (stopped || turnSession !== old || !old.isOpen || handoff != null) return
            Handoff(old).also { handoff = it }
        }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var next: P2PSession? = null
            var installed = false
            val signed = useSignedHandoff()
            try {
                // The host will reclaim signaling at its deadline. Stop our
                // attempt early so a delayed offer cannot evict the old peer.
                withTimeoutOrNull((timeoutMs - 5_000L).coerceIn(1L, 15_000L)) {
                    if (!old.suspendSignalingForHandoff()) return@withTimeoutOrNull
                    val plan = if (signed) signedHandoffPlan?.invoke(handoffId) ?: return@withTimeoutOrNull else {
                        requestRecovery("carrier-handoff")
                        ticket.nextPlan.await()
                    }
                    val carrier = plan.turnCarrier ?: return@withTimeoutOrNull
                    val credential = credentialProvider()?.takeIf { it.isNotBlank() } ?: return@withTimeoutOrNull
                    next = turnSessionFactory?.invoke(carrier) ?: return@withTimeoutOrNull
                    val candidate = next ?: return@withTimeoutOrNull
                    if (!candidate.configureHandoffOffer(handoffId)) return@withTimeoutOrNull
                    if (candidate.connect().isFailure) return@withTimeoutOrNull
                    val result = candidate.request(P2PHttpRequest(id = UUID.randomUUID().toString(), method = "GET",
                        path = "/api/auth/me", headers = mapOf("Authorization" to "Bearer $credential"))).getOrNull()
                    if (result == null || result.status !in 200..299 || !result.error.isNullOrBlank()) return@withTimeoutOrNull
                    if (credentialProvider()?.takeIf { it.isNotBlank() } != credential) return@withTimeoutOrNull
                    if (signed) {
                        val body = "{\"handoffId\":\"$handoffId\"}".toByteArray(Charsets.UTF_8)
                        // The host can commit and promote even if its response is lost.
                        // Its handoff receipt is idempotent, so retry an uncertain
                        // result on the same authenticated standby before abandoning it.
                        var commit: com.andysagent.ragent.core.p2p.P2PHttpResponse? = null
                        repeat(2) {
                            if (commit == null && candidate.isOpen && credentialProvider() == credential) {
                                commit = withTimeoutOrNull(3_000L) {
                                    candidate.request(P2PHttpRequest(id = UUID.randomUUID().toString(), method = "POST",
                                        path = "/api/device-auth/turn/handoff/commit", bodyBase64 = java.util.Base64.getEncoder().encodeToString(body),
                                        headers = mapOf("Authorization" to "Bearer $credential", "Content-Type" to "application/json"))).getOrNull()
                                }
                            }
                        }
                        val committedResponse = commit ?: return@withTimeoutOrNull
                        if (committedResponse.status !in 200..299 || !committedResponse.error.isNullOrBlank()
                            || credentialProvider()?.takeIf { it.isNotBlank() } != credential) return@withTimeoutOrNull
                    }
                    synchronized(handoffLock) {
                        if (handoff !== ticket || stopped || turnSession !== old || !old.isOpen || !candidate.isOpen) return@synchronized
                        cancelTurnRecheck()
                        turnSession = candidate
                        activeTurnCarrier = carrier
                        if (signed) bootstrapPlan = plan
                        observeUnexpectedClose(candidate, isTurn = true)
                        ready(candidate)
                        installed = true
                    }
                    if (installed) scheduleTurnRecheck()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Keep the original carrier if a standby cannot be verified.
            } finally {
                if (signed) onSignedHandoffFinished?.invoke(installed)
                if (!installed) {
                    next?.close()
                    if (!stopped && turnSession === old && old.isOpen) {
                        withContext(kotlinx.coroutines.NonCancellable) { old.resumeSignalingAfterHandoff() }
                    }
                }
                synchronized(handoffLock) { if (handoff === ticket) handoff = null }
            }
        }
        synchronized(handoffLock) {
            if (handoff !== ticket || stopped) { job.cancel(); return }
            ticket.job = job
        }
        job.start()
    }

    /**
     * A TURN-first contract is intentionally TURN-only for the lifetime of a
     * healthy carrier.  The remote host accepts one peer connection per room;
     * a periodic second offer is therefore destructive, not a harmless health
     * probe. Probe the existing channel rather than creating another session.
     */
    private fun retainTurnCarrier() {
        scheduleTurnRecheck()
    }

    private suspend fun attemptTurnProbe(carrier: TurnCarrier, credential: String?): ProbeResult? {
        val session = try {
            turnSessionFactory?.invoke(carrier) ?: return null
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            return ProbeResult.NetworkError("TURN session creation failed: ${error.message ?: error.javaClass.simpleName}")
        }
        val connectResult = try {
            withTimeoutOrNull(TURN_CONNECT_TIMEOUT_MS) { session.connect() }
        } catch (error: Exception) {
            session.close()
            if (error is CancellationException) throw error
            return ProbeResult.NetworkError("TURN connect failed: ${error.message ?: error.javaClass.simpleName}")
        }
        if (connectResult == null) {
            session.close()
            return ProbeResult.NetworkError("TURN connect timed out after ${TURN_CONNECT_TIMEOUT_MS}ms")
        }
        if (connectResult.isFailure) {
            session.close()
            return ProbeResult.NetworkError("TURN connect failed: ${connectResult.exceptionOrNull()?.message ?: "unknown error"}")
        }
        val headers = mutableMapOf<String, String>()
        credential?.takeIf { it.isNotBlank() }?.let { headers["Authorization"] = "Bearer $it" }

        val request = P2PHttpRequest(
            id = UUID.randomUUID().toString(),
            method = "GET",
            path = "/api/auth/me",
            headers = headers,
        )
        return try {
            val responseResult = session.request(request)
            currentCoroutineContext().ensureActive()
            responseResult.fold(
                onSuccess = { response ->
                    if (response.error != null) {
                        session.close()
                        ProbeResult.NetworkError("TURN probe returned a remote error")
                    } else if (response.status in 200..299) {
                        turnSession = session
                        activeTurnCarrier = carrier
                        observeUnexpectedClose(session, isTurn = true)
                        onTurnSessionReady?.invoke(session)
                        ProbeResult.HttpSuccess(response.status)
                    } else {
                        session.close()
                        ProbeResult.HttpResponse(response.status)
                    }
                },
                onFailure = {
                    session.close()
                    ProbeResult.NetworkError("TURN probe failed: ${it.message}")
                },
            )
        } catch (e: Exception) {
            session.close()
            if (e is CancellationException) throw e
            ProbeResult.NetworkError("TURN probe error: ${e.message}")
        }
    }

    private fun scheduleCapabilitiesProbe(session: P2PSession) = synchronized(carrierHealthLock) {
        if (stopped || (p2pSession ?: turnSession) !== session) return@synchronized
        capabilityProbeJob?.cancel()
        capabilityProbeJob = scope.launch {
            delay(CAPABILITY_PROBE_DEBOUNCE_MS)
            if (!isActive || stopped || (p2pSession ?: turnSession) !== session) return@launch
            if (session.lastInboundFrameElapsedMs < FOREGROUND_RECENT_INBOUND_SKIP_MS) return@launch
            onCarrierSuspect(session)
        }
    }

    private suspend fun runSingleFlightProbe(
        session: P2PSession,
        timeoutMs: Long,
        credential: String?,
    ): CarrierProbeOutcome {
        val deferred = synchronized(carrierHealthLock) {
            val existing = activeProbeDeferred
            if (activeProbeSession === session && existing != null && existing.isActive) {
                existing
            } else {
                val created = scope.async {
                    executeBoundedProbe(session, timeoutMs, credential)
                }
                activeProbeSession = session
                activeProbeDeferred = created
                created.invokeOnCompletion {
                    synchronized(carrierHealthLock) {
                        if (activeProbeDeferred === created) {
                            activeProbeDeferred = null
                            activeProbeSession = null
                        }
                    }
                }
                created
            }
        }
        return deferred.await()
    }

    private suspend fun executeBoundedProbe(
        session: P2PSession,
        timeoutMs: Long,
        credential: String?,
    ): CarrierProbeOutcome {
        val attempt = scope.async {
            try {
                if (session.supportsKeepaliveProbe) {
                    if (session.probeLiveness(timeoutMs)) CarrierProbeOutcome.Alive else CarrierProbeOutcome.Failed
                } else {
                    val headers = credential?.let { mapOf("Authorization" to "Bearer $it") }.orEmpty()
                    val response = session.request(
                        P2PHttpRequest(
                            id = UUID.randomUUID().toString(),
                            method = "GET",
                            path = "/api/auth/me",
                            headers = headers,
                        ),
                    ).getOrNull()
                    when {
                        response == null -> CarrierProbeOutcome.Failed
                        response.error == null && response.status in listOf(401, 403) ->
                            CarrierProbeOutcome.AuthDenied(response.status)
                        response.error == null && response.status in 200..299 ->
                            CarrierProbeOutcome.Alive
                        else -> CarrierProbeOutcome.Failed
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                CarrierProbeOutcome.Failed
            }
        }
        val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { attempt.cancel() }
        return try {
            val outcome = withTimeoutOrNull(timeoutMs) { attempt.await() }
            if (outcome == null) {
                attempt.cancel()
                CarrierProbeOutcome.Failed
            } else {
                outcome
            }
        } finally {
            cancelHandle?.dispose()
        }
    }

    private fun scheduleTurnRecheck() = scheduleCarrierHealthCheck()

    private fun scheduleCarrierHealthCheck() = synchronized(carrierHealthLock) {
        scheduleCarrierHealthCheckLocked()
    }

    private fun scheduleCarrierHealthCheckLocked() {
        val session = p2pSession ?: turnSession ?: return
        if (healthSession === session && turnRecheckJob?.isActive == true) return
        turnRecheckJob?.cancel()
        healthSession = session
        val wakeChannel = Channel<Boolean>(Channel.CONFLATED)
        healthWakeSignal = wakeChannel
        turnRecheckJob = scope.launch(start = CoroutineStart.LAZY) {
            var failures = 0
            var lastSuccessfulGeneration = session.successfulResponseGeneration
            var lastInboundGeneration = session.inboundFrameGeneration
            while (isActive && !stopped && (p2pSession ?: turnSession) === session) {
                val waitMs = if (failures == 1) CARRIER_HEALTH_RETRY_DELAY_MS
                    else turnRecheckIntervalMs.coerceAtLeast(1_000L)
                val forcedWake = withTimeoutOrNull(waitMs) { wakeChannel.receiveCatching().getOrNull() } == true
                if (!isActive || stopped || (p2pSession ?: turnSession) !== session) return@launch

                val isTurn = session === turnSession && p2pSession == null
                if (!forcedWake && failures == 0 && session.lastInboundFrameElapsedMs < PERIODIC_RECENT_INBOUND_SKIP_MS) {
                    failures = 0
                    lastSuccessfulGeneration = session.successfulResponseGeneration
                    lastInboundGeneration = session.inboundFrameGeneration
                    val authenticated = !credentialProvider().isNullOrBlank()
                    updateState(
                        if (authenticated) ConnectionStatus.Connected else ConnectionStatus.Reachable,
                        reachable = true,
                        authenticated = authenticated,
                        transport = if (isTurn) TransportKind.Turn else TransportKind.P2P,
                        clearLastError = true,
                    )
                    continue
                }

                val attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
                val probeTimeoutMs = if (failures == 1) CARRIER_HEALTH_RETRY_TIMEOUT_MS else CARRIER_HEALTH_TIMEOUT_MS
                val startInboundElapsed = session.lastInboundFrameElapsedMs
                val outcome = try {
                    runSingleFlightProbe(session, probeTimeoutMs, attemptedCredential)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    CarrierProbeOutcome.Failed
                }

                // Drain duplicate wakeups queued while the probe was already running.
                while (wakeChannel.tryReceive().isSuccess) {}

                // A late response from the former carrier never changes the
                // state or authority of its replacement.
                if (!isActive || stopped || (p2pSession ?: turnSession) !== session) return@launch
                if (outcome is CarrierProbeOutcome.AuthDenied) {
                    failures = 0
                    if (handleAuthenticationRequired(outcome.statusCode, attemptedCredential) {
                            (p2pSession ?: turnSession) === session
                        }) return@launch
                    continue
                }
                val successfulGeneration = session.successfulResponseGeneration
                val inboundGeneration = session.inboundFrameGeneration
                val otherSuccessfulResponse = successfulGeneration != lastSuccessfulGeneration
                val inboundFrameArrived = inboundGeneration != lastInboundGeneration ||
                    session.lastInboundFrameElapsedMs < startInboundElapsed
                lastSuccessfulGeneration = successfulGeneration
                lastInboundGeneration = inboundGeneration
                if (outcome is CarrierProbeOutcome.Alive || otherSuccessfulResponse || inboundFrameArrived) {
                    failures = 0
                    if (credentialProvider()?.takeIf { it.isNotBlank() } != attemptedCredential) continue
                    val authenticated = !attemptedCredential.isNullOrBlank()
                    updateState(
                        if (authenticated) ConnectionStatus.Connected else ConnectionStatus.Reachable,
                        reachable = true,
                        authenticated = authenticated,
                        transport = if (isTurn) TransportKind.Turn else TransportKind.P2P,
                        clearLastError = true,
                    )
                } else {
                    failures++
                    if (failures >= 2) {
                        if (isTurn) handleUnexpectedTurnClose(session, "health-probe-failed")
                        else handleUnexpectedP2PClose(session, "health-probe-failed")
                        return@launch
                    }
                }
            }
        }.also { it.start() }
    }

    private fun cancelTurnRecheck() = cancelCarrierHealthCheck()

    private fun cancelCarrierHealthCheck(expectedSession: P2PSession? = null) = synchronized(carrierHealthLock) {
        if (expectedSession != null && healthSession !== expectedSession) {
            if (activeProbeSession === expectedSession) {
                activeProbeDeferred?.cancel()
                activeProbeDeferred = null
                activeProbeSession = null
            }
            return@synchronized
        }
        capabilityProbeJob?.cancel()
        capabilityProbeJob = null
        turnRecheckJob?.cancel()
        turnRecheckJob = null
        healthWakeSignal?.close()
        healthWakeSignal = null
        activeProbeDeferred?.cancel()
        activeProbeDeferred = null
        activeProbeSession = null
        healthSession = null
    }

    private fun recoverOrRetry(recoveryReason: String, lastError: String) {
        if (onRecoveryRequired != null) {
            onRecoveryRequired.invoke(recoveryReason)
        } else {
            scheduleRetry(lastError)
        }
    }

    private fun scheduleRetry(lastError: String) {
        if (retryCount >= maxRetries) {
            updateState(
                status = ConnectionStatus.Error,
                reachable = false,
                authenticated = false,
                transport = TransportKind.None,
                lastError = lastError,
            )
            return
        }
        val delayMs = minOf(MAX_BACKOFF_MS, backoffBaseMs * (1L shl retryCount.coerceAtMost(5)))
        retryCount += 1
        _state.value = _state.value.copy(
            retryCount = retryCount,
            updatedAt = System.currentTimeMillis(),
        )
        scheduleProbe(delayMs)
    }

    private suspend fun handleAuthenticationRequired(statusCode: Int, attemptedCredential: String?, stillCurrent: () -> Boolean): Boolean {
        currentCoroutineContext().ensureActive()
        var applied = false
        val current = { !stopped && stillCurrent() }
        val invalidate = {
            if (current()) {
                applied = true
                cancelTurnRecheck()
                bootstrapTurnAttempted = false
                closeP2PSession()
                closeTurnSession()
                updateState(ConnectionStatus.AuthenticationRequired, reachable = true, authenticated = false,
                    transport = TransportKind.None, lastError = "Instance authentication failed (HTTP $statusCode)")
                onAuthenticationRequired?.invoke()
            }
        }
        if (credentialRejectionHandler != null) credentialRejectionHandler.reject(attemptedCredential, current, invalidate)
        else if (credentialProvider()?.takeIf { it.isNotBlank() } == attemptedCredential?.takeIf { it.isNotBlank() }) invalidate()
        return applied
    }

    private fun updateState(
        status: ConnectionStatus,
        reachable: Boolean = _state.value.reachable,
        authenticated: Boolean = _state.value.authenticated,
        transport: TransportKind = TransportKind.None,
        lastError: String? = null,
        clearLastError: Boolean = false,
    ) {
        if (stopped) return
        _state.value = _state.value.copy(
            status = status,
            reachable = reachable,
            authenticated = authenticated,
            transport = transport,
            retryCount = retryCount,
            lastError = if (clearLastError) null else lastError ?: _state.value.lastError,
            updatedAt = System.currentTimeMillis(),
        )
    }
}
