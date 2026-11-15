package com.andysagent.ragent

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import com.andysagent.ragent.core.appapi.ApiErrorCode
import com.andysagent.ragent.core.appapi.AppApiException
import com.andysagent.ragent.core.auth.AndroidDeviceIdentityStore
import com.andysagent.ragent.core.auth.BrokerApprovalProtocol
import com.andysagent.ragent.core.auth.BrokerApprovalRemote
import com.andysagent.ragent.core.auth.BrokerEnrollmentMaterial
import com.andysagent.ragent.core.auth.BrokerPendingEnrollment
import com.andysagent.ragent.core.auth.BrokerPendingApproval
import com.andysagent.ragent.core.auth.WindowsServiceControlApproval
import com.andysagent.ragent.core.auth.WindowsServiceControlGrant
import com.andysagent.ragent.core.auth.WindowsServicePendingApproval
import com.andysagent.ragent.core.model.Approval
import com.andysagent.ragent.core.model.AttentionReducer
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.feature.workbench.BrokerApprovalController
import com.andysagent.ragent.feature.workbench.BrokerApprovalOutcomeUnknownException
import com.andysagent.ragent.feature.workbench.BrokerEnrollmentController
import com.andysagent.ragent.feature.workbench.BrokerApprovalRetryGate
import com.andysagent.ragent.feature.workbench.brokerApprovalReconciliationSignals
import com.andysagent.ragent.feature.workbench.observeBrokerApprovalFeed
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.onEach
import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/** Adapts signed Windows Broker requests into the app's shared approval queue. */
internal class WindowsBrokerApprovalController(
    context: Context,
    private val runtime: AndroidRuntimeGraph,
) : BrokerApprovalController, BrokerEnrollmentController {
    constructor(context: Context, app: RagentApplication) : this(context, app.runtime)
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val decisionJournal = BrokerDecisionJournal(
        lock = preferences,
        read = { preferences.getString(it, null) },
        write = { key, status -> preferences.edit().putString(key, status).commit() },
    )
    private val pendingRetryGate = BrokerApprovalRetryGate(SystemClock::elapsedRealtime)
    private val pendingRevisions = ConcurrentHashMap<String, String>()
    private val identity: AndroidDeviceIdentityStore = runtime.identityStore
    private val trustUpdates = MutableSharedFlow<String>(extraBufferCapacity = 1)
    private val decisionUpdates = MutableSharedFlow<String>(extraBufferCapacity = 1)

    /** A target switch cancels the old fetch and clears its cards before reading the new target. */
    override fun observePendingApprovals(): Flow<List<Approval>> =
        observeBrokerApprovalFeed(
            targetIds = runtime.configStore.directory
                .map { it.activeTarget?.instanceId }.distinctUntilChanged()
                .onEach { pendingRevisions.clear() },
            refreshSignals = { targetId ->
                merge(
                    runtime.targetConnectionStates
                        .map { it[targetId] }.distinctUntilChanged().drop(1)
                        .onEach { pendingRevisions.remove(targetId) }
                        .filter { it == RuntimeConnectionState.Connected }.map { Unit },
                    runtime.transport.invalidations
                        .filter { it.type == BROKER_APPROVAL_INVALIDATION }.map { Unit },
                    foregroundStarts().onEach { pendingRevisions.remove(targetId) },
                    trustUpdates.filter { it == targetId }.map { Unit },
                    decisionUpdates.filter { it == targetId }.map { Unit },
                    brokerApprovalReconciliationSignals(
                        intervalMs = {
                            if (runtime.transport.requiresEventPolling) BROKER_APPROVAL_CARRIER_TICK_MS
                            else BROKER_APPROVAL_RECONCILE_MS
                        },
                        shouldRefresh = {
                            ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                                runtime.targetConnectionStates.value[targetId] == RuntimeConnectionState.Connected &&
                                preferences.contains(pinKey(targetId))
                        },
                    ),
                )
            },
            fetch = ::pendingApprovalsForTarget,
            onFailure = { targetId, failure ->
                if (failure is ApiException && failure.statusCode == 429) {
                    pendingRetryGate.defer(targetId, failure.retryAfterMs ?: BROKER_APPROVAL_DEFAULT_RATE_LIMIT_MS)
                } else if (runtime.transport.requiresEventPolling) {
                    pendingRetryGate.defer(targetId, BROKER_APPROVAL_FAILURE_RETRY_MS)
                }
                if (runtime.targetConnectionStates.value[targetId] == RuntimeConnectionState.Connected) {
                    Log.w("WindowsBrokerApproval", "Pending refresh failed: ${failure.javaClass.simpleName}")
                }
            },
            retainOnFailure = { failure ->
                when (failure) {
                    is ApiException -> failure.statusCode != 401 && failure.statusCode != 403
                    is AppApiException -> failure.error.code !in setOf(
                        ApiErrorCode.AUTHENTICATION_REQUIRED,
                        ApiErrorCode.PERMISSION_DENIED,
                        ApiErrorCode.TARGET_NOT_FOUND,
                    )
                    else -> true
                }
            },
        )

    private suspend fun pendingApprovalsForTarget(targetInstanceId: String): List<Approval> {
        val target = runtime.configStore.directory.first().activeTarget
            ?.takeIf { it.instanceId == targetInstanceId } ?: return emptyList()
        val pinnedFingerprint = preferences.getString(pinKey(target.instanceId), null) ?: return emptyList()
        pendingRetryGate.await(target.instanceId)
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(identity.brokerPublicKey())
        val remote = BrokerApprovalRemote { request -> runtime.executeOnTarget(target.instanceId, request) }
        val snapshot = readAllPending(
            remote,
            deviceId,
            if (runtime.transport.requiresEventPolling) pendingRevisions[target.instanceId] else null,
        )
        // Carrier polling can queue several hints during one slow read. Pace
        // the next GET even if those hints drain immediately afterward.
        if (snapshot.revision != null) {
            pendingRevisions[target.instanceId] = snapshot.revision
        } else {
            pendingRevisions.remove(target.instanceId)
        }
        if (runtime.transport.requiresEventPolling && snapshot.revision == null) {
            pendingRetryGate.defer(target.instanceId, BROKER_APPROVAL_CARRIER_RECONCILE_MS)
        }
        val label = target.label.ifBlank { target.instanceId }
        val legacy = snapshot.requests.mapNotNull { request ->
            if (!isAuthentic(request, pinnedFingerprint)) return@mapNotNull null
            val challenge = request.challenge
            val localDecision = preferences.getString(decisionKey(target.instanceId, request), null)
            if (localDecision in setOf("succeeded", "denied", "failed", "expired")) return@mapNotNull null
            val uncertain = localDecision != null
            Approval(
                id = request.requestId,
                sessionId = challenge.sessionId,
                title = if (uncertain) appContext.getString(R.string.windows_broker_outcome_unknown) else when (challenge.operation) {
                    "service.restart" -> appContext.getString(R.string.windows_broker_restart_service)
                    else -> challenge.operation
                },
                status = "pending",
                runId = challenge.runId,
                kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                reason = (if (uncertain) appContext.getString(R.string.windows_broker_outcome_unknown) + "\n" else "") + appContext.getString(
                    R.string.windows_broker_request_reason,
                    label,
                    challenge.targetId,
                    challenge.requestId,
                    challenge.targetFingerprint,
                ),
                riskLevel = "privileged",
                passkeyRequired = false,
                expiresAt = challenge.expiresAt.toString(),
                brokerTargetInstanceId = target.instanceId,
                brokerChallengeDigest = challengeDigest(challenge),
                brokerDecisionUncertain = uncertain,
            )
        }
        val serviceRequests = try {
            readAllServicePending(remote, deviceId)
        } catch (error: ApiException) {
            // Older hosts and installations without the optional service adapter
            // must still be able to use the existing approval feed.
            if (error.statusCode in setOf(404, 501, 503)) emptyList() else throw error
        }
        val services = serviceRequests.mapNotNull { request ->
            val grant = request.grant
            if (!isAuthenticService(request, pinnedFingerprint)) return@mapNotNull null
            val digest = runCatching { serviceDigest(grant) }.getOrNull() ?: return@mapNotNull null
            val localDecision = preferences.getString(brokerDecisionJournalKey(target.instanceId, grant.requestId, digest), null)
            if (localDecision in setOf("executing", "succeeded", "denied", "failed", "expired")) return@mapNotNull null
            val uncertain = localDecision != null
            Approval(
                id = grant.requestId, sessionId = grant.sessionId, runId = grant.runId,
                title = if (uncertain) appContext.getString(R.string.windows_broker_outcome_unknown) else appContext.getString(when (grant.action) {
                    "start-service" -> R.string.windows_broker_start_service
                    "stop-service" -> R.string.windows_broker_stop_service
                    else -> R.string.windows_broker_restart_named_service
                }),
                status = "pending", kind = AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND,
                channel = SERVICE_CONTROL_CHANNEL,
                reason = (if (uncertain) appContext.getString(R.string.windows_broker_outcome_unknown) + "\n" else "") +
                    appContext.getString(R.string.windows_broker_request_reason, label, grant.serviceName, grant.requestId, grant.definitionHash),
                riskLevel = "privileged", passkeyRequired = false,
                expiresAt = Instant.ofEpochMilli(grant.expiresMs).toString(),
                brokerTargetInstanceId = target.instanceId, brokerChallengeDigest = digest, brokerDecisionUncertain = uncertain,
            )
        }
        return legacy + services
    }

    override suspend fun resolve(approval: Approval, approve: Boolean) {
        require(approval.kind == AttentionReducer.WINDOWS_BROKER_APPROVAL_KIND)
        val boundTargetId = approval.brokerTargetInstanceId
            ?: error("This Windows request has no computer binding. Refresh the approval list.")
        val boundDigest = approval.brokerChallengeDigest
            ?: error("This Windows request has no challenge binding. Refresh the approval list.")
        val target = runtime.configStore.directory.first().activeTarget
            ?: error("Connect to the Windows computer again before resolving this request.")
        require(target.instanceId == boundTargetId) {
            "The selected computer changed. Return to the original computer and refresh the approval list."
        }
        val pinnedFingerprint = preferences.getString(pinKey(target.instanceId), null)
            ?: error("The Windows Broker identity is not trusted on this phone.")
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(identity.brokerPublicKey())
        val remote = BrokerApprovalRemote { request -> runtime.executeOnTarget(target.instanceId, request) }
        if (approval.channel == SERVICE_CONTROL_CHANNEL) {
            resolveServiceControl(approval, approve, target.instanceId, pinnedFingerprint, deviceId, remote)
            return
        }
        val request = readAllPending(remote, deviceId, afterRevision = null).requests
            .firstOrNull { it.requestId == approval.id }
            ?: error("This Windows request is no longer pending. Refresh the approval list.")
        require(isAuthentic(request, pinnedFingerprint)) { "The Windows Broker identity or signature could not be verified." }
        require(request.challenge.sessionId == approval.sessionId && request.challenge.runId == approval.runId) {
            "This request no longer matches the approval card. Refresh the approval list."
        }
        require(challengeDigest(request.challenge) == boundDigest) {
            "This Windows challenge changed. Refresh the approval list."
        }
        require(request.challenge.expiresAt.isAfter(Instant.now())) {
            "This Windows request has expired."
        }
        val decisionKey = decisionKey(boundTargetId, request)
        val choice = if (approve) "approve" else "deny"
        val signature = identity.signBrokerBytes(
            BrokerApprovalProtocol.deviceDecisionSignatureBytes(request.challenge, choice),
        )
        // The journal commits before POST. A lost reply or process death must
        // never cause this signed decision to be submitted a second time.
        val result = try {
            decisionJournal.submitOnce(decisionKey) {
                remote.decide(request.requestId, deviceId, choice, signature)
            }
        } catch (recorded: BrokerDecisionAlreadyRecordedException) {
            when (recorded.recordedStatus) {
                "submitted" -> throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown))
                "expired" -> error(appContext.getString(R.string.windows_broker_decision_expired))
                "denied" -> error(appContext.getString(R.string.windows_broker_decision_denied))
                "failed" -> error(appContext.getString(R.string.windows_broker_decision_failed, "unknown"))
                "succeeded" -> error(appContext.getString(R.string.windows_broker_already_completed))
                else -> throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown))
            }
        } catch (notRecorded: BrokerDecisionNotRecordedException) {
            throw notRecorded
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            decisionUpdates.tryEmit(boundTargetId)
            throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown), failure)
        }
        if (result.status == "unknown" || result.code == "SERVICE_RESTART_OUTCOME_UNKNOWN" ||
            result.status !in setOf("succeeded", "denied", "failed", "expired")) {
            decisionUpdates.tryEmit(boundTargetId)
            throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown))
        }
        // Keep the terminal outcome as a guard. A delayed pending projection
        // or process restart cannot re-submit this nonce or show a false card.
        decisionJournal.complete(decisionKey, result.status)
        decisionUpdates.tryEmit(boundTargetId)
        when (result.status) {
            "expired" -> error(appContext.getString(R.string.windows_broker_decision_expired))
            "failed" -> error(appContext.getString(R.string.windows_broker_decision_failed, result.code ?: "unknown"))
            "denied" -> if (approve) error(appContext.getString(R.string.windows_broker_decision_denied))
            "succeeded" -> if (!approve) error(appContext.getString(R.string.windows_broker_denial_conflict))
        }
    }

    /**
     * Reads an administrator-started challenge so the one-time setup surface
     * can show its comparison code before the Owner confirms enrollment.
     */
    override fun enrollmentMaterial(): BrokerEnrollmentMaterial {
        val publicKey = identity.brokerPublicKey()
        return BrokerEnrollmentMaterial(BrokerApprovalProtocol.deviceIdForPublicKey(publicKey), publicKey)
    }

    override suspend fun enrollmentChallenge(targetInstanceId: String): BrokerPendingEnrollment {
        val remote = BrokerApprovalRemote { request -> runtime.executeOnTarget(targetInstanceId, request) }
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(identity.brokerPublicKey())
        val pending = remote.pendingEnrollment(deviceId)
        verifyEnrollmentChallenge(pending, deviceId)
        return pending
    }

    /** Completes one confirmed registration with the app's already registered device key. */
    override suspend fun completeEnrollment(
        targetInstanceId: String,
        enrollmentId: String,
        confirmedCode: String,
    ): String {
        val remote = BrokerApprovalRemote { request -> runtime.executeOnTarget(targetInstanceId, request) }
        val deviceId = BrokerApprovalProtocol.deviceIdForPublicKey(identity.brokerPublicKey())
        val pending = remote.pendingEnrollment(deviceId)
        verifyEnrollmentChallenge(pending, deviceId)
        val challenge = pending.challenge
        require(challenge.enrollmentId == enrollmentId && challenge.verificationCode == confirmedCode) {
            "The enrollment changed or its comparison code did not match. Refresh setup and compare again."
        }
        val signature = identity.signBrokerBytes(BrokerApprovalProtocol.deviceEnrollmentSignatureBytes(challenge))
        val result = remote.completeEnrollment(challenge.enrollmentId, confirmedCode, signature)
        require(result.deviceId == deviceId) { "The Broker enrolled a different device key." }
        val fingerprint = BrokerApprovalProtocol.fingerprint(pending.brokerPublicKey)
        trustBroker(targetInstanceId, fingerprint)
        return fingerprint
    }

    /** Called by the local enrollment completion flow after the owner verifies the Broker fingerprint. */
    internal fun trustBroker(targetInstanceId: String, fingerprint: String) {
        require(fingerprint.matches(Regex("^[0-9a-f]{64}$")))
        val existing = preferences.getString(pinKey(targetInstanceId), null)
        require(existing == null || existing == fingerprint) {
            "The Windows Broker identity changed. Reset its trust from the local administrator setup before enrolling again."
        }
        preferences.edit().putString(pinKey(targetInstanceId), fingerprint).apply()
        trustUpdates.tryEmit(targetInstanceId)
    }

    private fun verifyEnrollmentChallenge(pending: BrokerPendingEnrollment, deviceId: String) {
        val challenge = pending.challenge
        require(challenge.deviceId == deviceId && challenge.publicKeyFingerprint == deviceId) {
            "The enrollment challenge is not bound to this app's existing device key."
        }
        require(challenge.expiresAt.isAfter(Instant.now())) { "The Broker enrollment challenge has expired." }
        require(
            BrokerApprovalProtocol.verifyBrokerSignature(
                pending.brokerPublicKey,
                pending.brokerSignature,
                BrokerApprovalProtocol.brokerEnrollmentSignatureBytes(challenge),
            ),
        ) { "The Broker enrollment signature could not be verified." }
    }

    private fun isAuthentic(request: BrokerPendingApproval, pinnedFingerprint: String): Boolean {
        val challenge = request.challenge
        val fingerprint = runCatching { BrokerApprovalProtocol.fingerprint(request.brokerPublicKey) }.getOrNull()
            ?: return false
        return request.status == "awaiting_device" &&
            fingerprint == pinnedFingerprint &&
            challenge.expiresAt.isAfter(Instant.now()) &&
            runCatching {
                BrokerApprovalProtocol.verifyBrokerSignature(
                    request.brokerPublicKey,
                    request.brokerSignature,
                    BrokerApprovalProtocol.brokerApprovalSignatureBytes(challenge),
                )
            }.getOrDefault(false)
    }

    private fun isAuthenticService(request: WindowsServicePendingApproval, pinnedFingerprint: String): Boolean =
        WindowsServiceControlApproval.verifyBrokerReview(request.grant, request.brokerPublicKey, request.brokerSignature, pinnedFingerprint)

    private fun serviceDigest(grant: WindowsServiceControlGrant): String =
        MessageDigest.getInstance("SHA-256")
            .digest(WindowsServiceControlApproval.brokerReviewSigningBytes(grant))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private suspend fun readAllServicePending(remote: BrokerApprovalRemote, deviceId: String): List<WindowsServicePendingApproval> {
        val requests = mutableListOf<WindowsServicePendingApproval>()
        var cursor: String? = null
        var pages = 0
        do {
            val page = remote.pendingServiceControls(deviceId, cursor)
            requests += page.requests
            cursor = page.nextCursor
            pages++
        } while (page.hasMore && pages < MAX_PAGES)
        return requests
    }

    private suspend fun resolveServiceControl(approval: Approval, approve: Boolean, targetId: String, pinnedFingerprint: String,
        deviceId: String, remote: BrokerApprovalRemote) {
        val request = readAllServicePending(remote, deviceId).firstOrNull { it.grant.requestId == approval.id }
            ?: error("This Windows service request is no longer pending. Refresh the approval list.")
        val grant = request.grant
        require(isAuthenticService(request, pinnedFingerprint)) { "The Windows Broker identity or signature could not be verified." }
        require(grant.sessionId == approval.sessionId && grant.runId == approval.runId && serviceDigest(grant) == approval.brokerChallengeDigest) {
            "This Windows service request changed. Refresh the approval list."
        }
        val key = brokerDecisionJournalKey(targetId, grant.requestId, serviceDigest(grant))
        val choice = if (approve) "approve" else "deny"
        val bytes = if (approve) WindowsServiceControlApproval.ownerSigningBytes(grant) else WindowsServiceControlApproval.ownerDenialSigningBytes(grant)
        val signature = identity.signBrokerBytes(bytes)
        val result = try {
            decisionJournal.submitOnce(key) { remote.decideServiceControl(grant.requestId, deviceId, choice, signature) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: BrokerDecisionNotRecordedException) {
            throw error
        } catch (error: Exception) {
            decisionUpdates.tryEmit(targetId)
            throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown), error)
        }
        if ((approve && result.status !in setOf("executing", "succeeded")) || (!approve && result.status != "denied")) {
            decisionUpdates.tryEmit(targetId)
            throw BrokerApprovalOutcomeUnknownException(appContext.getString(R.string.windows_broker_outcome_unknown))
        }
        decisionJournal.complete(key, result.status)
        decisionUpdates.tryEmit(targetId)
    }

    private data class PendingSnapshot(val requests: List<BrokerPendingApproval>, val revision: String?)

    private suspend fun readAllPending(
        remote: BrokerApprovalRemote,
        deviceId: String,
        afterRevision: String?,
    ): PendingSnapshot {
        val requests = mutableListOf<BrokerPendingApproval>()
        var cursor: String? = null
        var pages = 0
        var revision: String? = null
        do {
            val page = remote.pending(
                deviceId = deviceId,
                cursor = cursor,
                afterRevision = if (pages == 0) afterRevision else null,
                waitMs = if (pages == 0 && afterRevision != null) BROKER_APPROVAL_WAIT_MS else null,
            )
            if (pages == 0) revision = page.revision
            requests += page.requests
            cursor = page.nextCursor
            pages++
        } while (page.hasMore && pages < MAX_PAGES)
        return PendingSnapshot(requests, revision)
    }

    private fun pinKey(instanceId: String) = "broker.$instanceId"

    private fun decisionKey(instanceId: String, request: BrokerPendingApproval): String =
        brokerDecisionJournalKey(instanceId, request.requestId, challengeDigest(request.challenge))

    private fun foregroundStarts(): Flow<Unit> = callbackFlow {
        val lifecycle = ProcessLifecycleOwner.get().lifecycle
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) trySend(Unit)
        }
        lifecycle.addObserver(observer)
        awaitClose { lifecycle.removeObserver(observer) }
    }

    private fun challengeDigest(challenge: com.andysagent.ragent.core.auth.BrokerApprovalChallenge): String =
        MessageDigest.getInstance("SHA-256")
            .digest(BrokerApprovalProtocol.brokerApprovalSignatureBytes(challenge))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private companion object {
        const val PREFERENCES = "ragent_broker_approval_pins"
        const val MAX_PAGES = 8
        // The timeout also bounds recovery when an invalidation hint is lost.
        const val BROKER_APPROVAL_WAIT_MS = 3_000L
        const val BROKER_APPROVAL_CARRIER_TICK_MS = 1_000L
        const val BROKER_APPROVAL_CARRIER_RECONCILE_MS = 5_000L
        const val BROKER_APPROVAL_FAILURE_RETRY_MS = 2_000L
        const val BROKER_APPROVAL_RECONCILE_MS = 15_000L
        const val BROKER_APPROVAL_DEFAULT_RATE_LIMIT_MS = 30_000L
        const val BROKER_APPROVAL_INVALIDATION = "windows_broker_approvals_invalidated"
        const val SERVICE_CONTROL_CHANNEL = "windows_service_control"
    }
}
