package com.andysagent.ragent

import com.andysagent.ragent.core.auth.DeviceIdentityStore
import com.andysagent.ragent.core.auth.TemporaryCarrierApi
import com.andysagent.ragent.core.auth.TemporaryRuntimeOption
import com.andysagent.ragent.core.auth.TemporaryCarrierConnector
import com.andysagent.ragent.core.auth.TemporaryClaimJournal
import com.andysagent.ragent.core.auth.TemporaryPairingClient
import com.andysagent.ragent.core.auth.TemporaryTextOperation
import com.andysagent.ragent.core.auth.TemporaryTextOperationJournal
import com.andysagent.ragent.core.auth.TemporaryTextStage
import com.andysagent.ragent.core.auth.TemporaryTextTaskCoordinator
import com.andysagent.ragent.core.auth.canBeForgottenAfterResultReview
import com.andysagent.ragent.core.auth.TemporaryAttachmentInput
import com.andysagent.ragent.core.auth.TemporaryAttachmentReceipt
import com.andysagent.ragent.core.auth.TemporaryAttachmentUploader
import com.andysagent.ragent.core.auth.TemporaryAttachmentByteStore
import com.andysagent.ragent.core.auth.StagedTemporaryAttachment
import com.andysagent.ragent.core.auth.TemporarySessionScope
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.auth.TemporaryPairingTicket
import com.andysagent.ragent.core.p2p.P2PSessionFactory
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import com.andysagent.ragent.core.protocol.TemporaryAccessProtocol
import com.andysagent.ragent.core.protocol.VerifiedTemporaryConnection
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.ConcurrentHashMap

internal fun shouldRetryTemporaryAccessFailure(failure: ApiException): Boolean =
    failure.retryable && failure.code != "temporary_broker_turn_quota_exceeded"

/** Temporary grants are intentionally absent from Owner credentials and the account computer directory. */
internal class TemporaryAccessRuntime(
    application: android.app.Application,
    broker: RagentTransport,
    private val identity: DeviceIdentityStore,
    private val claims: TemporaryClaimJournal,
    private val operations: TemporaryTextOperationJournal,
    private val attachmentBytes: TemporaryAttachmentByteStore,
    scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    enum class Stage { Idle, AwaitingApproval, Connecting, Ready, Expired }

    sealed interface ClaimReplacementResult {
        data object Released : ClaimReplacementResult
        data object NoExistingClaim : ClaimReplacementResult
        data class BlockedByOperations(val count: Int) : ClaimReplacementResult
    }

    data class Snapshot(val stage: Stage = Stage.Idle, val instanceId: String? = null,
        val keyFingerprint: String? = null, val expiresAt: Long? = null)

    private data class Active(val connection: VerifiedTemporaryConnection,
        val completion: TemporaryAccessProtocol.Completion, val api: TemporaryCarrierApi,
        val text: TemporaryTextTaskCoordinator, val attachments: TemporaryAttachmentUploader)

    private val mutex = Mutex()
    private val operationMutationGuard = Any()
    private val replacingInstances = mutableSetOf<String>()
    private val activeByInstance = ConcurrentHashMap<String, Active>()
    private val pairing = TemporaryPairingClient(broker, identity, claims, nowMs)
    private val carrier = TemporaryCarrierConnector(P2PSessionFactory { candidate ->
        WebRTCDataChannelTransport(candidate, application)
    }, scope, nowMs, onRecoveryRequired = { instanceId, _ ->
        activeByInstance.remove(instanceId)
        if (mutableSnapshot.value.instanceId == instanceId)
            mutableSnapshot.value = mutableSnapshot.value.copy(stage = Stage.Connecting)
    })
    private val mutableSnapshot = MutableStateFlow(Snapshot())
    val snapshot: StateFlow<Snapshot> = mutableSnapshot.asStateFlow()
    init {
        // A share operation expires after two minutes. Keep a wide grace period so only crash
        // leftovers are removed; staging files stay inside this authenticated-encryption store.
        runCatching { attachmentBytes.pruneExpiredBefore(nowMs() - ATTACHMENT_STAGING_RETENTION_MS) }
    }

    /** The signed QR may already have been claimed when a network response was lost. */
    suspend fun beginQr(raw: String): Snapshot = mutex.withLock {
        val record = try { pairing.claimFromQr(raw) }
        catch (failure: ApiException) {
            if (!failure.retryable) throw failure
            val ticket = runCatching { Json.decodeFromString<TemporaryPairingTicket>(raw) }.getOrNull()
                ?: throw failure
            claims.read(ticket.envelope.invitation.instanceId)?.takeIf { it.ticket == ticket }
                ?: throw failure
        }
        val invitation = record.ticket.envelope.invitation
        carrier.stop(invitation.instanceId); activeByInstance.remove(invitation.instanceId)
        mutableSnapshot.value = Snapshot(Stage.AwaitingApproval, invitation.instanceId,
            invitation.instanceKeyFingerprint, invitation.accessExpiresAt)
        mutableSnapshot.value
    }

    /** Ends only the old local claim for an instance encoded by a fully verified replacement ticket. */
    suspend fun replaceClaimForTicket(rawTicket: String): ClaimReplacementResult = mutex.withLock {
        val replacement = pairing.validateTicket(rawTicket)
        val instanceId = replacement.envelope.invitation.instanceId
        val existing = claims.read(instanceId) ?: return@withLock ClaimReplacementResult.NoExistingClaim
        if (existing.ticket == replacement) return@withLock ClaimReplacementResult.NoExistingClaim

        synchronized(operationMutationGuard) {
            check(replacingInstances.add(instanceId)) { "Temporary claim replacement is already running" }
        }
        try {
            val grantId = existing.completion?.let { raw ->
                runCatching {
                    Json.parseToJsonElement(raw).jsonObject.getValue("payload").jsonObject
                        .getValue("result").jsonObject.getValue("grantId").jsonPrimitive.content
                }.getOrElse { throw IllegalStateException("Temporary claim recovery data is damaged", it) }
            }
            val savedOperations = grantId?.let { operations.list(instanceId, it) }.orEmpty()
            val unresolved = savedOperations.filterNot { it.canBeForgottenAfterResultReview() }
            if (unresolved.isNotEmpty()) {
                return@withLock ClaimReplacementResult.BlockedByOperations(unresolved.size)
            }

            carrier.stop(instanceId)
            activeByInstance.remove(instanceId)
            savedOperations.forEach { operations.clear(instanceId, it.grantId, it.operationId) }
            claims.clear(instanceId)
            if (mutableSnapshot.value.instanceId == instanceId) mutableSnapshot.value = Snapshot()
            ClaimReplacementResult.Released
        } finally {
            synchronized(operationMutationGuard) { replacingInstances.remove(instanceId) }
        }
    }

    /** Lists all still-valid invitations without merging them into the Owner computer directory. */
    fun recoverableTargets(): List<Snapshot> = claims.listInstanceIds().asSequence()
        .mapNotNull(claims::read)
        .mapNotNull { record ->
            val invitation = record.ticket.envelope.invitation
            if (nowMs() >= invitation.accessExpiresAt) return@mapNotNull null
            val active = activeByInstance[invitation.instanceId]
            val ready = active != null && carrier.session(active.connection) != null
            Snapshot(if (ready) Stage.Ready else Stage.AwaitingApproval,
                invitation.instanceId, invitation.instanceKeyFingerprint, invitation.accessExpiresAt)
        }
        .sortedByDescending { snapshot ->
            claims.read(requireNotNull(snapshot.instanceId))?.ticket?.envelope?.invitation?.createdAt ?: 0L
        }
        .toList()

    fun latestRecoverableInstanceId(): String? = claims.listInstanceIds().asSequence()
        .mapNotNull(claims::read)
        .filter { nowMs() < it.ticket.envelope.invitation.accessExpiresAt }
        .maxByOrNull { it.ticket.envelope.invitation.createdAt }
        ?.claim?.instanceId

    /** One bounded step. The UI schedules further polls; this never starts an Owner HTTP carrier. */
    suspend fun advance(instanceId: String): Snapshot = mutex.withLock {
        val record = claims.read(instanceId) ?: error("Temporary claim is not saved")
        val invitation = record.ticket.envelope.invitation
        require(invitation.instanceId == instanceId)
        if (nowMs() >= invitation.accessExpiresAt) {
            carrier.stop(instanceId); activeByInstance.remove(instanceId); claims.clear(instanceId)
            mutableSnapshot.value = Snapshot(Stage.Expired, instanceId,
                invitation.instanceKeyFingerprint, invitation.accessExpiresAt)
            return@withLock mutableSnapshot.value
        }
        val base = Snapshot(Stage.AwaitingApproval, instanceId,
            invitation.instanceKeyFingerprint, invitation.accessExpiresAt)
        val completed = pairing.resume(instanceId) ?: run {
            mutableSnapshot.value = base
            return@withLock base
        }
        val pending = base.copy(stage = Stage.Connecting)
        mutableSnapshot.value = pending
        pairing.startConnection(instanceId)
        val delivery = pairing.resumeConnection(instanceId) ?: return@withLock pending
        val existing = activeByInstance[instanceId]
        if (existing?.connection == delivery && carrier.session(delivery) != null) {
            mutableSnapshot.value = pending.copy(stage = Stage.Ready)
            return@withLock mutableSnapshot.value
        }
        carrier.connect(delivery)
        val api = TemporaryCarrierApi(carrier, delivery, completed, identity, nowMs)
        activeByInstance[instanceId] = Active(delivery, completed, api, TemporaryTextTaskCoordinator(instanceId,
            completed.grant.grantId, completed.credential.expiresAt, api, operations, nowMs, attachmentBytes),
            TemporaryAttachmentUploader(api))
        mutableSnapshot.value = pending.copy(stage = Stage.Ready)
        mutableSnapshot.value
    }

    suspend fun waitUntilReady(instanceId: String) {
        val expiry = requireNotNull(claims.read(instanceId))
            .ticket.envelope.invitation.accessExpiresAt
        while (nowMs() < expiry) {
            val stage = try { advance(instanceId).stage }
            catch (failure: ApiException) {
                // Account TURN quotas are an explicit policy denial, not a transient network
                // failure. Retrying until the short grant expires only hides the reason from the
                // share UI and burns the user's limited temporary-access window.
                if (!shouldRetryTemporaryAccessFailure(failure)) throw failure
                delay(1_500)
                continue
            }
            when (stage) {
                Stage.Ready -> if (available(instanceId)) return
                Stage.Expired -> error("Temporary access expired. Scan a new code.")
                else -> delay(1_500)
            }
        }
        error("Temporary computer did not connect before the code expired.")
    }

    fun available(instanceId: String? = null): Boolean {
        val current = resolveActive(instanceId) ?: return false
        return carrier.session(current.connection) != null && nowMs() < current.completion.credential.expiresAt
    }

    suspend fun submitText(text: String, tool: String, instanceId: String? = null): TemporaryTextOperation {
        val operation = createText(text, tool, instanceId = instanceId)
        return resumeText(operation.operationId, instanceId)
    }

    fun createText(
        text: String,
        tool: String,
        attachments: List<StagedTemporaryAttachment> = emptyList(),
        instanceId: String? = null,
    ): TemporaryTextOperation {
        synchronized(operationMutationGuard) {
            val current = requireActive(instanceId)
            check(current.connection.instanceId !in replacingInstances) { "Temporary access is being replaced" }
            require(available(current.connection.instanceId)) { "Temporary computer is not connected" }
            return current.text.create(text, tool, attachments)
        }
    }

    suspend fun listRuntimes(instanceId: String? = null): List<TemporaryRuntimeOption> = mutex.withLock {
        val current = requireActive(instanceId)
        require(available(current.connection.instanceId)) { "Temporary computer is not connected" }
        current.api.listRuntimes()
    }

    fun stageAttachment(
        stageId: String,
        requestId: String,
        originalName: String,
        mimeType: String,
        input: java.io.InputStream,
    ): StagedTemporaryAttachment {
        require(originalName.isNotBlank() && originalName.length <= 255 && !originalName.contains('\u0000'))
        require(mimeType.matches(Regex("^[A-Za-z0-9!#$&^_.+-]{1,127}/[A-Za-z0-9!#$&^_.+-]{1,127}$")))
        val (size, hash) = attachmentBytes.stage(stageId, input)
        return StagedTemporaryAttachment(stageId, requestId, originalName, mimeType, size, hash)
    }

    fun discardStagedAttachment(stageId: String) = attachmentBytes.delete(stageId)

    suspend fun resumeText(operationId: String, instanceId: String? = null,
        onAttachmentProgress: (name: String, sentBytes: Long, totalBytes: Long) -> Unit = { _, _, _ -> }): TemporaryTextOperation = mutex.withLock {
        val current = requireActive(instanceId)
        require(available(current.connection.instanceId)) { "Temporary computer is not connected" }
        current.text.advance(operationId, onAttachmentProgress)
    }

    /** Uploads only through the active temporary grant; callers must keep the staged bytes durable. */
    suspend fun uploadAttachment(
        scope: TemporarySessionScope,
        input: TemporaryAttachmentInput,
        instanceId: String? = null,
    ): TemporaryAttachmentReceipt = mutex.withLock {
        val current = requireActive(instanceId)
        require(available(current.connection.instanceId)) { "Temporary computer is not connected" }
        require(nowMs() < current.completion.credential.expiresAt)
        current.attachments.upload(scope, input)
    }

    suspend fun readTextResult(operationId: String, instanceId: String? = null): JsonObject = mutex.withLock {
        val current = requireActive(instanceId)
        require(available(current.connection.instanceId)) { "Temporary computer is not connected" }
        val operation = requireNotNull(operations.read(current.connection.instanceId,
            current.completion.grant.grantId, operationId))
        require(operation.stage == TemporaryTextStage.Accepted)
        val result = current.api.result(operation.scope(), requireNotNull(operation.runId))
        require(result.getValue("sessionId").jsonPrimitive.content == operation.sessionId &&
            result.getValue("runId").jsonPrimitive.content == operation.runId) {
            "Temporary result identity mismatch"
        }
        if (result["state"]?.jsonPrimitive?.content in TERMINAL_RESULT_STATES && operation.resultRetrievedAt == null) {
            operations.write(operation.copy(resultRetrievedAt = nowMs()))
        }
        result
    }

    fun pendingText(instanceId: String? = null): List<TemporaryTextOperation> {
        val current = resolveActive(instanceId) ?: return emptyList()
        return operations.list(current.connection.instanceId, current.completion.grant.grantId)
    }

    fun disconnect(instanceId: String? = null) {
        carrier.stop(instanceId)
        if (instanceId == null) {
            activeByInstance.clear()
            mutableSnapshot.value = Snapshot()
        } else {
            activeByInstance.remove(instanceId)
            if (mutableSnapshot.value.instanceId == instanceId) mutableSnapshot.value = Snapshot()
        }
    }

    private fun requireActive(instanceId: String?): Active = resolveActive(instanceId)
        ?: error(if (instanceId == null && activeByInstance.size > 1)
            "Select a temporary computer before continuing" else "Temporary computer is not connected")

    private fun resolveActive(instanceId: String?): Active? = if (instanceId != null) activeByInstance[instanceId]
        else activeByInstance.values.singleOrNull()

    private companion object {
        const val ATTACHMENT_STAGING_RETENTION_MS = 24L * 60 * 60 * 1000
        val TERMINAL_RESULT_STATES = setOf("ready", "failed", "cancelled")
    }
}
