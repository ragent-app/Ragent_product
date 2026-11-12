package com.andysagent.agentoc

import android.app.Application
import com.andysagent.agentoc.core.appapi.TargetConnectionResource
import com.andysagent.agentoc.core.auth.AccountSessionException
import com.andysagent.agentoc.core.domain.AccountsRepositoryException
import com.andysagent.agentoc.core.network.*
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import com.andysagent.agentoc.core.p2p.P2PSessionFactory
import com.andysagent.agentoc.core.p2p.P2PSession
import com.andysagent.agentoc.core.p2p.WebRTCDataChannelTransport
import com.andysagent.agentoc.core.protocol.ProtocolCodec
import com.andysagent.agentoc.core.protocol.ConnectionBootstrapReportRequestDto
import com.andysagent.agentoc.core.protocol.ConnectionBootstrapTurnReleaseRequestDto
import com.andysagent.agentoc.core.protocol.ConnectionBootstrapVerifier
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.launchIn
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

internal interface TargetConnectionController : TargetConnectionResource {
    val connectivityState: kotlinx.coroutines.flow.StateFlow<ConnectionState>? get() = null
    fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan)
    fun refresh()
}

/** Wake an unhealthy selected connection when foreground network access returns. */
internal fun retryUnhealthyForegroundConnection(controller: TargetConnectionController?) {
    when (controller?.connectivityState?.value?.status) {
        ConnectionStatus.Offline, ConnectionStatus.Degraded, ConnectionStatus.Error -> controller.refresh()
        else -> Unit // Keep healthy, authenticating and explicitly rejected connections untouched.
    }
}

/** Fixed-target signed bootstrap and carrier controller, shared by all callers. */
internal class BoundTargetConnection(
    private val instanceId: String,
    private val application: Application,
    private val endpointProvider: () -> String,
    private val credentialProvider: () -> String?,
    private val p2pCredentialsProvider: suspend () -> BootstrapP2PCredentials?,
    private val transport: OkHttpAgentoCTransport,
    private val scope: CoroutineScope,
    private val reportingScope: CoroutineScope,
    private val endpointlessBootstrap: suspend () -> BootstrapConnectionPlan,
    private val onAuthenticationRequired: () -> Unit,
    private val onEndpointResolved: (String) -> Unit = {},
    private val credentialRejectionHandler: CredentialRejectionHandler? = null,
    private val credentialRenewalRequired: () -> Boolean = { false },
    private val renewCredential: (suspend (String?, () -> Boolean) -> Unit)? = null,
    private val renewCarrierCredential: (suspend (String?, String, () -> Boolean) -> Unit)? = null,
    private val releaseAccountReservation: (suspend (String) -> Unit)? = null,
    private val onNetworkRestored: () -> Unit = {},
    private val onTurnQuotaExceeded: (AccountSessionException) -> Unit = {},
) : TargetConnectionController {
    private val bootstrapClient = ConnectionBootstrapClient(endpointProvider, credentialProvider)
    @Volatile private var plan: BootstrapConnectionPlan? = null
    @Volatile private var lastReportedTransport: String? = null
    private var refreshJob: Job? = null
    private var refreshPlanApplied = false
    private var renewalMonitorJob: Job? = null
    private var carrierRenewalJob: Job? = null
    private val refreshGeneration = AtomicLong()
    private val refreshLock = Any()
    @Volatile private var started = false
    @Volatile private var authenticationRequired = false
    @Volatile private var lastFailedTurnCarrier: TurnCarrier? = null
    private var preferTcpOnNextBootstrap = false
    private data class CarrierRetentionWindow(val signedExpiry: Long, val monotonicDeadline: Long)
    private class PlannedTurnSession(
        val carrier: TurnCarrier,
        val retentionWindow: CarrierRetentionWindow?,
        delegate: P2PSession,
        release: (String) -> Unit,
    ) : P2PSession by TurnLeaseSession(carrier, delegate, release)
    private val activeTurnSession = java.util.concurrent.atomic.AtomicReference<PlannedTurnSession?>(null)
    @Volatile private var earlyHandoffJob: Job? = null
    @Volatile private var signedHandoffRequested = false
    @Volatile private var signedCandidatePlan: BootstrapConnectionPlan? = null

    private val supervisor: ConnectivitySupervisor = ConnectivitySupervisor(
        endpointProvider = endpointProvider,
        credentialProvider = credentialProvider,
        monitor = AndroidNetworkMonitor(application),
        scope = scope,
        credentialRejectionHandler = CredentialRejectionHandler { credential, current, invalidate ->
            rejectCredential(credential, current, invalidate)
        },
        p2pCandidateProvider = { plan?.p2pCandidate },
        p2pSessionFactory = P2PSessionFactory { candidate ->
            WebRTCDataChannelTransport(candidate, application)
        },
        onP2PSessionReady = { transport.setP2PSession(it) },
        onP2PSessionClosed = { transport.clearP2PSession(it) },
        turnSessionFactory = { carrier: TurnCarrier ->
            try {
                val window = (signedCandidatePlan?.takeIf { it.turnCarrier === carrier }
                    ?: plan?.takeIf { it.turnCarrier === carrier })?.retentionWindow()
                PlannedTurnSession(carrier, window, WebRTCDataChannelTransport(carrier.p2pCandidate, application)) { id ->
                    releaseTurnConnection(id, "turn-session-closed")
                }
            } catch (error: Exception) {
                carrier.connectionId?.let { releaseTurnConnection(it, "turn-session-create-failed") }
                throw error
            }
        },
        onTurnSessionReady = { lastFailedTurnCarrier = null; activeTurnSession.set(it as? PlannedTurnSession); transport.setTurnSession(it); scheduleEarlyHandoff(it as? PlannedTurnSession) },
        onTurnHandoffReady = {
            lastFailedTurnCarrier = null
            val old = activeTurnSession.getAndSet(it as? PlannedTurnSession)
            signedCandidatePlan?.takeIf { candidate -> candidate.turnCarrier === (it as? PlannedTurnSession)?.carrier }?.let { candidate ->
                plan = candidate; lastReportedTransport = null
            }
            transport.handoffTurnSession(it)
            scheduleEarlyHandoff(it as? PlannedTurnSession)
            old?.takeIf { previous -> previous !== it }?.let(::closeRetiringSessionAtExpiry)
        },
        onTurnSessionClosed = {
            transport.clearTurnSession(it)
            if (it is PlannedTurnSession && activeTurnSession.compareAndSet(it, null)) {
                earlyHandoffJob?.cancel(); earlyHandoffJob = null
                signedHandoffRequested = false; signedCandidatePlan = null
            }
        },
        onTurnReservationFailed = { carrier, reason ->
            lastFailedTurnCarrier = carrier
            if (carrier != null) reportTurnOutcome(carrier, "failed", reason)
        },
        bootstrapPending = { synchronized(refreshLock) { refreshJob?.isActive == true } },
        onRecoveryRequired = ::requestRecovery,
        useSignedHandoff = { signedHandoffRequested },
        signedHandoffPlan = ::fetchSignedHandoffPlan,
        onSignedHandoffFinished = { signedHandoffRequested = false; signedCandidatePlan = null },
    )
    override val connectivityState get() = supervisor.state

    internal fun requestRecovery(reason: String) {
        val category = when {
            reason == "carrier-handoff" -> "handoff"
            reason == "network-restored" -> "network-restored"
            reason == "default-network-changed" -> "network-changed"
            reason == "turn-health-probe-failed" -> "health-probe-failed"
            reason == "turn-request-failed" || reason == "p2p-request-failed" -> "request-failed"
            else -> "other"
        }
        connectionDebugTrace(application, instanceId, "recovery-$category")
        val routeChanged = reason == "network-restored" || reason == "default-network-changed"
        // Keep an existing retry (including a server-directed cooldown) for
        // duplicate carrier failures. A new route must wake it immediately.
        synchronized(refreshLock) {
            if (routeChanged) preferTcpOnNextBootstrap = false
            else if (reason == "turn-ice-failed" || reason.contains("ICE connection", ignoreCase = true)) {
                // A refreshed plan may coexist with an older healthy carrier.
                // Recovery must classify the carrier that actually failed.
                val servers = (lastFailedTurnCarrier ?: plan?.turnCarrier)?.p2pCandidate?.iceServers.orEmpty()
                val currentlyTcpOnly = servers.isNotEmpty() && servers.all { isTcpTurnRelay(it.url) }
                // One alternate attempt; a later failure returns to the full
                // signed candidate list rather than trapping the target on TCP.
                preferTcpOnNextBootstrap = !currentlyTcpOnly
            }
            refreshBootstrap(coalesceInFlight = !routeChanged)
        }
        if (routeChanged) onNetworkRestored()
    }

    init {
        supervisor.state.onEach { state ->
            synchronized(refreshLock) {
                if (!started || authenticationRequired || supervisor.state.value != state) return@synchronized
                transport.updateCarrierConnectionState(supervisor.toRuntimeConnectionState(state))
                if (state.status == ConnectionStatus.Connected && transport.connectionState.value == RuntimeConnectionState.Connected) {
                    transport.connectInvalidationSocket()
                    reportConnectionIfNeeded(state.transport)
                }
            }
        }.launchIn(scope)
    }

    override fun start() {
        if (started) return
        connectionDebugTrace(application, instanceId, "controller-start")
        started = true
        authenticationRequired = false
        transport.updateCarrierConnectionState(RuntimeConnectionState.Connecting)
        supervisor.start()
        refreshBootstrap(useCachedPlan = true)
        // Prefer a device-key challenge on the healthy, verified carrier. A
        // failed challenge never creates a new lease or replays business work.
        if (renewCredential != null) renewalMonitorJob = scope.launch {
            while (isActive && started) {
                delay(30_000)
                synchronized(refreshLock) {
                    if (started && !authenticationRequired && refreshJob?.isActive != true && credentialRenewalRequired()) {
                        val session = activeTurnSession.get()
                        val current = plan
                        if (endpointProvider().isBlank() && renewCarrierCredential != null && session?.isOpen == true
                            && current != null && current.turnConnectionId == session.carrier.connectionId
                            && !credentialProvider().isNullOrBlank()
                            && supervisor.state.value.status == ConnectionStatus.Connected) {
                            renewOnCarrier(session, current)
                        } else if (carrierRenewalJob?.isActive != true) {
                            refreshBootstrap(forceRenewal = true)
                        }
                    }
                }
            }
        }
    }

    override suspend fun stop() {
        connectionDebugTrace(application, instanceId, "controller-stop")
        started = false
        signedHandoffRequested = false
        earlyHandoffJob?.cancelAndJoin(); earlyHandoffJob = null
        renewalMonitorJob?.cancelAndJoin()
        renewalMonitorJob = null
        carrierRenewalJob?.cancelAndJoin()
        carrierRenewalJob = null
        val pendingRefresh = synchronized(refreshLock) {
            preferTcpOnNextBootstrap = false
            refreshJob.also { cancelRefresh() }
        }
        pendingRefresh?.cancelAndJoin()
        val connectionIds = setOfNotNull(plan?.turnConnectionId, activeTurnSession.get()?.carrier?.connectionId).filter(String::isNotBlank)
        // Use the still-open verified carrier for endpoint-less control calls.
        // Release is bounded; the server lease TTL also covers an unavailable peer.
        if (connectionIds.isNotEmpty()) {
            runCatching { withTimeout(3_000) { connectionIds.forEach { release(it, "last-connection-user-released") } } }
        }
        plan = null
        supervisor.stop()
        supervisor.clearBootstrap()
        transport.updateCarrierConnectionState(RuntimeConnectionState.Disconnected)
        onEndpointResolved("")
    }

    override fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan) {
        connectionDebugTrace(application, instanceId, "verified-plan-applied")
        require(plan.contract.instanceId == instanceId) { "Pairing bootstrap target differs" }
        cancelRefresh()
        synchronized(refreshLock) { preferTcpOnNextBootstrap = false }
        this.plan = plan
        lastReportedTransport = null
        onEndpointResolved(plan.preferredEndpoint)
        if (started) {
            authenticationRequired = false
            supervisor.start()
            supervisor.applyBootstrap(plan)
            reportSelected(plan)
        }
    }

    fun carrierRequestFailed(failed: P2PSession?) = supervisor.carrierRequestFailed(failed)

    /** Caller holds refreshLock. The guard prevents publishing to a replaced carrier. */
    private fun renewOnCarrier(session: PlannedTurnSession, current: BootstrapConnectionPlan) {
        if (carrierRenewalJob?.isActive == true) return
        val attempted = credentialProvider()?.takeIf { it.isNotBlank() } ?: return
        carrierRenewalJob = scope.launch {
            try {
                renewCarrierCredential!!.invoke(attempted, current.contract.deviceId) {
                    started && !authenticationRequired && activeTurnSession.get() === session && session.isOpen
                        && plan === current && supervisor.state.value.status == ConnectionStatus.Connected
                }
                connectionDebugTrace(application, instanceId, "carrier-credential-renewed")
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (upgrade: com.andysagent.agentoc.core.auth.DeviceAuthorityUpgradeRequired) {
                synchronized(refreshLock) {
                    if (started && activeTurnSession.get() === session && plan === current) refreshBootstrap(forceRenewal = true)
                }
            } catch (_: Exception) {
                // The existing credential and carrier remain authoritative.
                // Retry at the next monitor tick, or recover on actual loss.
                connectionDebugTrace(application, instanceId, "carrier-credential-renewal-failed")
            }
        }
    }

    override fun refresh() {
        if (started) {
            refreshBootstrap()
        }
    }

    private fun refreshBootstrap(useCachedPlan: Boolean = false, forceRenewal: Boolean = false,
        coalesceInFlight: Boolean = false): Unit = synchronized(refreshLock) {
        if (!started) return@synchronized
        if (coalesceInFlight && refreshJob?.isActive == true && !refreshPlanApplied) return@synchronized
        connectionDebugTrace(application, instanceId, when {
            forceRenewal -> "bootstrap-renewal"
            useCachedPlan -> "bootstrap-start"
            coalesceInFlight -> "bootstrap-recovery"
            else -> "bootstrap-refresh"
        })
        cancelRefresh()
        refreshPlanApplied = false
        val generation = refreshGeneration.get()
        refreshJob = scope.launch {
            var attempt = 0
            val baseEndpoint = endpointProvider().trimEnd('/').takeIf { it.isNotBlank() }
            val token = credentialProvider()?.takeIf { it.isNotBlank() }
            var needsRenewal = baseEndpoint != null && renewCredential != null
                && (forceRenewal || token == null || credentialRenewalRequired())
            var renewed = false
            if (baseEndpoint != null && token == null && !needsRenewal) {
                rejectCredential(token, { generation == refreshGeneration.get() }, allowRepair = false)
                return@launch
            }
            // A just-verified endpoint-less join may already supply the initial plan.
            plan?.takeIf { useCachedPlan && baseEndpoint == null && token != null && it.contract.expiresAt.toEpochMillisOrZero() > System.currentTimeMillis() }
                ?.let { supervisor.applyBootstrap(it); reportSelected(it); return@launch }
            val retainedSession = activeTurnSession.get()?.takeIf { baseEndpoint == null }
            val retainedPlan = plan?.takeIf { retainedSession != null && supervisor.state.value.status == ConnectionStatus.Connected }
            val expiryJob = retainedPlan?.let { retained -> launch retentionExpiry@ {
                while (isActive && started && generation == refreshGeneration.get()) {
                    val waitMillis = synchronized(refreshLock) {
                        if (plan !== retained || activeTurnSession.get() !== retainedSession
                            || generation != refreshGeneration.get()) return@retentionExpiry
                        if (!canRetainCarrier(retained, retainedSession, token)) {
                            discardPlan("retained-carrier-window-ended")
                            return@retentionExpiry
                        }
                        val window = retainedSession!!.retentionWindow!!
                        minOf((window.monotonicDeadline - System.nanoTime()) / 1_000_000L,
                            window.signedExpiry - System.currentTimeMillis()).coerceIn(1L, 1_000L)
                    }
                    delay(waitMillis)
                }
            } }
            try {
                while (isActive && started && generation == refreshGeneration.get()) {
                    var attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
                    try {
                        if (needsRenewal) {
                            renewCredential!!.invoke(attemptedCredential) { started && generation == refreshGeneration.get() }
                            ensureActive()
                            if (!started || generation != refreshGeneration.get()) return@launch
                            needsRenewal = false
                            renewed = true
                        }
                        val nextPlan = if (baseEndpoint == null) endpointlessBootstrap() else {
                            attemptedCredential = credentialProvider()?.takeIf { it.isNotBlank() }
                            val verified = bootstrapClient.fetch(attemptedCredential)
                            check(verified.contract.instanceId == instanceId) { "Bootstrap instance does not match persisted instance" }
                            BootstrapConnectionPlanFactory.create(verified, baseEndpoint, p2pCredentialsProvider())
                        }
                        ensureActive()
                        require(nextPlan.contract.instanceId == instanceId) { "Bootstrap target differs" }
                        synchronized(refreshLock) {
                            if (!started || generation != refreshGeneration.get()) return@launch
                            connectionDebugTrace(application, instanceId, "bootstrap-ready")
                            // A fresh verified fixed-target plan is the recovery
                            // boundary. Pending authorization must retain AuthRequired.
                            // Debug-only transport A/B: keep the verified signed
                            // TURN candidates and do not enable direct ICE.
                            val tcpProbe = application.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0 &&
                                android.util.Log.isLoggable("AgentoC.TurnTcpProbe", android.util.Log.DEBUG)
                            val selectedPlan = if (preferTcpOnNextBootstrap || tcpProbe) preferSignedTcpRelay(nextPlan) else nextPlan
                            if (tcpProbe) {
                                val servers = selectedPlan.turnCarrier?.p2pCandidate?.iceServers.orEmpty()
                                android.util.Log.d("AgentoC.Upload", "stage=turn_tcp_probe signedServers=${servers.size} tcpOnly=${servers.isNotEmpty() && servers.all { isTcpTurnRelay(it.url) }}")
                            }
                            preferTcpOnNextBootstrap = false
                            refreshPlanApplied = true
                            plan = selectedPlan
                            lastReportedTransport = null
                            onEndpointResolved(selectedPlan.preferredEndpoint)
                            authenticationRequired = false
                            supervisor.start()
                            supervisor.applyBootstrap(selectedPlan)
                            reportSelected(selectedPlan)
                        }
                        return@launch
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: Throwable) {
                        ensureActive()
                        if (!started || generation != refreshGeneration.get()) return@launch
                        error.asTurnQuotaFailure()?.let { quotaFailure ->
                            connectionDebugTrace(application, instanceId, "turn-connection-quota-exceeded")
                            onTurnQuotaExceeded(quotaFailure)
                            return@launch
                        }
                        if (error.isAuthenticationFailure() || (needsRenewal && (error is IllegalArgumentException
                                || (error is ApiException && error.statusCode in setOf(400, 404, 409))))) {
                            if (credentialProvider()?.takeIf { it.isNotBlank() } != attemptedCredential) return@launch
                            if (!renewed && !needsRenewal && baseEndpoint != null && renewCredential != null) {
                                needsRenewal = true
                                continue
                            }
                            rejectCredential(attemptedCredential,
                                { generation == refreshGeneration.get() }, allowRepair = false)
                            return@launch
                        }
                        synchronized(refreshLock) {
                            if (!started || generation != refreshGeneration.get()) return@launch
                            if (!canRetainCarrier(retainedPlan, retainedSession, token)) discardPlan()
                        }
                        delay(bootstrapRecoveryRetryDelayMs(error, attempt))
                        attempt += 1
                    }
                }
            } finally { expiryJob?.cancel() }
        }
    }

    private fun Throwable.asTurnQuotaFailure(): AccountSessionException? {
        val code = when (this) {
            is ApiException -> code
            is AccountSessionException -> code
            is AccountsRepositoryException -> code
            else -> null
        }?.takeIf { it in setOf("turn_connection_quota_exceeded", "turn_quota_exceeded") } ?: return null
        return this as? AccountSessionException
            ?: AccountSessionException(429, code, "The account has reached its active connection limit.", retryable = false, cause = this)
    }

    private fun canRetainCarrier(retained: BootstrapConnectionPlan?, session: PlannedTurnSession?, credential: String?): Boolean =
        retained != null && plan === retained && !credential.isNullOrBlank() && credentialProvider() == credential
            && session != null && activeTurnSession.get() === session && session.isOpen
            && session.retentionWindow?.let { it.monotonicDeadline - System.nanoTime() > 0L
                && it.signedExpiry > System.currentTimeMillis() } == true
            && supervisor.state.value.status == ConnectionStatus.Connected

    private fun scheduleEarlyHandoff(session: PlannedTurnSession?) {
        earlyHandoffJob?.cancel()
        val current = plan
        val window = session?.retentionWindow
        if (session == null || current == null || window == null || current.rawContract.isBlank()
            || current.turnConnectionId != session.carrier.connectionId || endpointProvider().isNotBlank()) {
            earlyHandoffJob = null; return
        }
        scope.launch {
            closeCarrierAtSignedExpiry(window.signedExpiry, window.monotonicDeadline,
                isOpen = { started && activeTurnSession.get() === session && session.isOpen },
                close = { session.close(); supervisor.carrierRequestFailed(session) })
        }
        earlyHandoffJob = scope.launch {
            requestEarlyCarrierHandoff(window.signedExpiry, window.monotonicDeadline,
                isCurrent = { started && activeTurnSession.get() === session && session.isOpen && plan === current },
                request = {
                    signedHandoffRequested = true
                    try {
                        transport.execute(ApiRequest("POST", "/api/device-auth/turn/handoff/request",
                            "{\"contract\":${current.rawContract}}")).statusCode
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: ApiException) {
                        if (error.statusCode in setOf(401, 403, 404, 405)) signedHandoffRequested = false
                        error.statusCode
                    }
                })
        }
    }

    private suspend fun fetchSignedHandoffPlan(handoffId: String): BootstrapConnectionPlan? {
        if (!handoffId.matches(Regex("[a-f0-9]{32}"))) return null
        val current = plan ?: return null
        val active = activeTurnSession.get() ?: return null
        val key = current.publicKey ?: return null
        val previousId = current.turnConnectionId ?: return null
        if (previousId != active.carrier.connectionId || !active.isOpen) return null
        val credential = credentialProvider()?.takeIf { it.isNotBlank() } ?: return null
        val response = transport.execute(ApiRequest("POST", "/api/device-auth/turn/handoff/plan",
            "{\"handoffId\":\"$handoffId\"}"))
        val verified = ConnectionBootstrapVerifier.verifyHandoff(response.body, key, instanceId,
            current.contract.deviceId, previousId)
        val next = BootstrapConnectionPlanFactory.create(VerifiedBootstrap(verified.contract, verified.publicKey, response.body),
            "", p2pCredentialsProvider())
        if (next.turnCarrier == null || !started || plan !== current || activeTurnSession.get() !== active
            || credentialProvider()?.takeIf { it.isNotBlank() } != credential) return null
        signedCandidatePlan = next
        return next
    }

    private fun closeRetiringSessionAtExpiry(session: PlannedTurnSession) {
        val window = session.retentionWindow ?: return
        scope.launch {
            closeCarrierAtSignedExpiry(window.signedExpiry, window.monotonicDeadline,
                isOpen = { session.isOpen }, close = { session.close() })
        }
    }

    private fun BootstrapConnectionPlan.retentionWindow(): CarrierRetentionWindow {
        val expiry = listOfNotNull(contract.expiresAt, contract.turn?.expiresAt,
            contract.candidates.firstOrNull { it.id == turnCarrier?.candidateId }?.expiresAt)
            .minOf { it.toEpochMillisOrZero() }
        // This window belongs to the actual session, even when a newer plan
        // reuses it. Neither a newer plan nor wall rollback can renew this bound.
        val remaining = (expiry - System.currentTimeMillis()).coerceAtLeast(0L)
        return CarrierRetentionWindow(expiry, System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS
            .toNanos(remaining).coerceAtMost(Long.MAX_VALUE / 2))
    }

    /** Caller holds refreshLock and has checked the current generation. */
    private fun discardPlan(reason: String = "bootstrap-refresh-failed") {
        connectionDebugTrace(application, instanceId, when (reason) {
            "retained-carrier-window-ended" -> "carrier-retention-expired"
            else -> "carrier-plan-discarded"
        })
        plan?.turnConnectionId?.let { releaseTurnConnection(it, reason) }
        plan = null
        onEndpointResolved("")
        lastReportedTransport = null
        supervisor.clearBootstrap()
    }

    /** Shared by business requests, bootstrap failures and carrier health checks. */
    internal suspend fun rejectCredential(attemptedCredential: String?, stillCurrent: () -> Boolean = { true }, invalidateAdditional: () -> Unit = {}, allowRepair: Boolean = true) {
        connectionDebugTrace(application, instanceId, "credential-rejection-observed")
        currentCoroutineContext().ensureActive()
        var invalidatedGeneration: Long? = null
        val current = { started && !authenticationRequired && stillCurrent() }
        val invalidate = { synchronized(refreshLock) {
            if (current()) {
                // Fence queued supervisor notifications before it emits its
                // own auth/stop state. All invalidation is inside the owner's
                // credential-write lock when a graph handler is installed.
                authenticationRequired = true
                cancelRefresh()
                invalidatedGeneration = refreshGeneration.get()
                invalidateAdditional()
                supervisor.stop()
                supervisor.clearBootstrap()
                plan = null
                lastReportedTransport = null
                onEndpointResolved("")
                transport.markAuthenticationRequired()
                onAuthenticationRequired()
            }
        } }
        if (credentialRejectionHandler != null) credentialRejectionHandler.reject(attemptedCredential, current, invalidate)
        else if (credentialProvider()?.takeIf { it.isNotBlank() } == attemptedCredential) invalidate()
        // The rejected caller still receives its original error. Only fresh
        // authentication/bootstrap work runs in the target's owned scope.
        val rejectedGeneration = invalidatedGeneration
        if (allowRepair && rejectedGeneration != null && renewCredential != null) scope.launch {
            synchronized(refreshLock) {
                if (started && authenticationRequired && refreshGeneration.get() == rejectedGeneration) {
                    refreshBootstrap(forceRenewal = true)
                }
            }
        }
    }

    private fun Throwable.isAuthenticationFailure(): Boolean = when (this) {
        is com.andysagent.agentoc.core.auth.DeviceAuthorityUpgradeRequired -> true
        is BootstrapException -> code == "BOOTSTRAP_HTTP_401" || code == "BOOTSTRAP_HTTP_403"
        is AccountSessionException -> statusCode == 401 || statusCode == 403
        is AccountsRepositoryException -> statusCode == 401 || statusCode == 403
        is ApiException -> statusCode == 401 || statusCode == 403
        else -> false
    }

    private fun cancelRefresh() = synchronized(refreshLock) {
        refreshGeneration.incrementAndGet()
        refreshJob?.cancel()
        refreshJob = null
    }

    private fun reportSelected(nextPlan: BootstrapConnectionPlan) {
        report(
            phase = "selected",
            transport = nextPlan.turnCarrier?.let { "turn" },
            connectionId = nextPlan.turnConnectionId,
            candidateId = nextPlan.turnCarrier?.candidateId ?: nextPlan.contract.candidates.firstOrNull()?.id,
        )
    }

    private fun reportConnectionIfNeeded(transportKind: TransportKind) {
        val transportName = when (transportKind) {
            TransportKind.P2P -> "webrtc"
            TransportKind.Turn -> "turn"
            TransportKind.None -> null
        } ?: return
        if (lastReportedTransport == transportName) return
        val previous = lastReportedTransport
        lastReportedTransport = transportName
        val currentPlan = plan ?: return
        val turnCarrier = activeTurnSession.get()?.carrier
        report(
            phase = if (previous == null) "connected" else "migrated",
            transport = transportName,
            connectionId = if (transportKind == TransportKind.Turn) turnCarrier?.connectionId else currentPlan.turnConnectionId,
            candidateId = if (transportKind == TransportKind.Turn) turnCarrier?.candidateId
                else currentPlan.contract.candidates.firstOrNull { it.kind == "webrtc" }?.id,
        )
    }

    private fun reportTurnOutcome(carrier: TurnCarrier, phase: String, reason: String) {
        report(phase, "turn", carrier.connectionId, carrier.candidateId, reason)
    }

    private fun report(
        phase: String,
        transport: String?,
        connectionId: String?,
        candidateId: String?,
        errorCode: String? = null,
    ) {
        reportingScope.launch {
            runCatching {
                val request = ConnectionBootstrapReportRequestDto(
                        requestId = UUID.randomUUID().toString(),
                        phase = phase,
                        candidateId = candidateId,
                        transport = transport,
                        connectionMode = "turn-first",
                        connectionId = connectionId,
                        errorCode = errorCode,
                )
                if (endpointProvider().isBlank()) this@BoundTargetConnection.transport.execute(ApiRequest("POST", "/api/device-auth/bootstrap/report",
                    ProtocolCodec().encode(ConnectionBootstrapReportRequestDto.serializer(), request)))
                else bootstrapClient.report(request)
            }
        }
    }

    private fun releaseTurnConnection(connectionId: String, reason: String) {
        if (connectionId.isBlank()) return
        reportingScope.launch { runCatching { withTimeout(3_000) { release(connectionId, reason) } } }
    }

    private suspend fun release(connectionId: String, reason: String) {
        TurnReservationRelease(peerRelease = { id -> releaseThroughPeer(id, reason) },
            accountRelease = releaseAccountReservation).release(connectionId)
    }

    private suspend fun releaseThroughPeer(connectionId: String, reason: String) {
        if (endpointProvider().isBlank()) {
            val request = ConnectionBootstrapTurnReleaseRequestDto(connectionId = connectionId, reason = reason)
            transport.execute(ApiRequest("POST", "/api/device-auth/turn/release",
                ProtocolCodec().encode(ConnectionBootstrapTurnReleaseRequestDto.serializer(), request)))
        } else bootstrapClient.releaseTurn(connectionId, reason)
    }
}

