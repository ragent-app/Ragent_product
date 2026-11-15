package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.*
import java.security.MessageDigest
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonPrimitive
import kotlin.coroutines.coroutineContext

/** Each helper requires its own grant and the exact underlying metadata effect grant. */
object SessionMutationCapabilities {
    const val PREPARE = "ragent.sessions.prepareMutation"
    const val GET = "ragent.sessions.getMutation"
    const val RECONCILE = "ragent.sessions.reconcileMutation"
    const val CANCEL = "ragent.sessions.cancelMutation"
    fun effect(kind: SessionMutationKind) = when (kind) {
        SessionMutationKind.RENAME -> "ragent.sessions.rename"
        SessionMutationKind.SET_PINNED -> "ragent.sessions.pin"
        SessionMutationKind.SET_ARCHIVED -> "ragent.sessions.archive"
        SessionMutationKind.SET_REVIEWED -> "ragent.sessions.markReviewed"
    }
    val descriptors = listOf(
        CapabilityDescriptor(PREPARE, description = "Freeze a conditional Session mutation without dispatch", mutates = false, targetRequired = true, implemented = true),
        CapabilityDescriptor(GET, description = "Read an authorized caller-bound Session mutation operation", mutates = false, targetRequired = true, implemented = true),
        CapabilityDescriptor(RECONCILE, description = "Query the original Session metadata receipt without dispatch", mutates = false, targetRequired = true, implemented = true),
        CapabilityDescriptor(CANCEL, description = "Cancel an undispatched preparation; never undo a committed effect", mutates = true, targetRequired = true, implemented = true),
    ) + SessionMutationKind.entries.map {
        CapabilityDescriptor(effect(it), description = "Commit prepared ${it.name.lowercase()} metadata using original revisions", mutates = true, targetRequired = true, implemented = true)
    }
}

@Serializable
data class SessionMutationRequest(
    val operationId: String, val targetInstanceId: String, val sessionId: String,
    val kind: SessionMutationKind, val title: String? = null, val flag: Boolean? = null,
    val projectId: String? = null, val deadlineAt: Long? = null, val apiVersion: Int = 1,
) {
    fun validate() {
        if (apiVersion != 1 || !sessionMutationIdentifier(operationId, 200) ||
            !sessionMutationIdentifier(targetInstanceId, 256) || !sessionMutationIdentifier(sessionId, 256) ||
            (projectId != null && !sessionMutationIdentifier(projectId, 256)))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid mutation identity")
        if (kind == SessionMutationKind.RENAME) {
            if (flag != null || title == null || !sessionMutationIdentifier(title, 256))
                apiFailure(ApiErrorCode.INVALID_ARGUMENT, "A bounded title is required")
        } else if (title != null || flag == null) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "A boolean metadata value is required")
    }
}

@Serializable
enum class SessionMutationStage { PREPARED, SUBMITTING, APPLIED, CANCELLED, EXPIRED, CONFLICT }

/** Private journal; never serialize this object directly to an external caller. */
@Serializable
data class SessionMutationOperation(
    val callerBinding: String, val request: SessionMutationRequest, val fingerprint: String,
    val command: SessionMutationCommand, val createdAt: Long, val deadlineAt: Long,
    val revision: Long = 1, val stage: SessionMutationStage = SessionMutationStage.PREPARED,
    val receipt: SessionMutationReceipt? = null,
) {
    fun samePreparation(other: SessionMutationOperation) = callerBinding == other.callerBinding &&
        request == other.request && fingerprint == other.fingerprint && command == other.command &&
        createdAt == other.createdAt && deadlineAt == other.deadlineAt
}

interface SessionMutationStore {
    suspend fun get(callerBinding: String, operationId: String): SessionMutationOperation?
    suspend fun insert(operation: SessionMutationOperation): Boolean
    suspend fun replace(operation: SessionMutationOperation, expectedRevision: Long): Boolean
}
interface SessionMutationTarget {
    suspend fun protocol(): SessionMutationProtocol
    suspend fun context(sessionId: String): SessionMutationContext
    suspend fun apply(sessionId: String, command: SessionMutationCommand): SessionMutationReceipt
    suspend fun receipt(sessionId: String, requestId: String): SessionMutationReceipt?
}
interface TargetSessionMutationAccess {
    suspend fun <T> withTarget(instanceId: String, block: suspend (SessionMutationTarget) -> T): T
}

class RepositorySessionMutationTarget(private val repository: SessionRepository) : SessionMutationTarget {
    init { require(repository !is SwitchingSessionRepository) { "Mutations require a fixed repository" } }
    private suspend fun <T> call(block: suspend () -> T): T = try { block() }
    catch (error: SessionRepositoryException) {
        val code = when (error.statusCode) {
            400, 415 -> ApiErrorCode.INVALID_ARGUMENT
            401 -> ApiErrorCode.AUTHENTICATION_REQUIRED
            403 -> ApiErrorCode.PERMISSION_DENIED
            404 -> ApiErrorCode.RESOURCE_NOT_FOUND
            409 -> ApiErrorCode.REVISION_CONFLICT
            413 -> ApiErrorCode.RESOURCE_LIMIT
            429 -> ApiErrorCode.RATE_LIMITED
            501 -> ApiErrorCode.CAPABILITY_UNSUPPORTED
            502 -> ApiErrorCode.RESULT_UNKNOWN
            else -> if (error.retryable) ApiErrorCode.TARGET_OFFLINE else ApiErrorCode.INTERNAL_ERROR
        }
        throw AppApiException(ApiError(code, "Session mutation response is unavailable", error.retryable))
    } catch (_: IllegalArgumentException) { apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Invalid mutation response") }
    catch (_: java.io.IOException) { throw AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "Mutation response is unconfirmed", true)) }
    override suspend fun protocol() = call { repository.readSessionMutationProtocol() }
    override suspend fun context(sessionId: String) = call { repository.readSessionMutationContext(sessionId) }
    override suspend fun apply(sessionId: String, command: SessionMutationCommand) = call { repository.applySessionMutation(sessionId, command) }
    override suspend fun receipt(sessionId: String, requestId: String) = call { repository.readSessionMutationReceipt(sessionId, requestId) }
}

/** A retry never takes fresh revisions or changes request identity. Reconcile never posts. */
class SessionMutationCoordinator(
    private val store: SessionMutationStore,
    private val directory: suspend () -> TargetDirectorySnapshot,
    private val authorizer: CallerAuthorizer,
    private val access: TargetSessionMutationAccess,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private suspend fun candidate(request: SessionMutationRequest, caller: VerifiedCaller, capability: String) {
        val target = directory().targets.singleOrNull { it.instanceId == request.targetInstanceId }
            ?: apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Computer is not paired")
        for (id in setOf(capability, SessionMutationCapabilities.effect(request.kind))) {
            if (authorizer.authorizedTargets(caller, id, listOf(target)).isEmpty())
                apiFailure(ApiErrorCode.PERMISSION_DENIED, "Mutation access is not granted")
            authorizer.requireSessionCandidate(caller, id, request.targetInstanceId, request.sessionId)
        }
    }
    private suspend fun authorize(request: SessionMutationRequest, caller: VerifiedCaller, capability: String, project: String?) {
        candidate(request, caller, capability)
        for (id in setOf(capability, SessionMutationCapabilities.effect(request.kind)))
            authorizer.require(caller, id, request.targetInstanceId, request.sessionId, project)
    }
    private fun context(context: SessionMutationContext, request: SessionMutationRequest): SessionMutationContext {
        try { context.validate() } catch (_: IllegalArgumentException) { apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Invalid mutation context") }
        if (context.sessionId != request.sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Wrong Session response")
        if (request.projectId != null && request.projectId != context.projectId)
            apiFailure(ApiErrorCode.PERMISSION_DENIED, "Declared project differs from the actual Session")
        return context
    }
    private suspend fun verify(operation: SessionMutationOperation, caller: VerifiedCaller, capability: String, target: SessionMutationTarget): SessionMutationContext {
        candidate(operation.request, caller, capability)
        val actual = context(target.context(operation.request.sessionId), operation.request)
        // Scope drift is forbidden even when the caller has a broad grant or the project returns to A.
        if (actual.scopeRevision != operation.command.expectedScopeRevision || actual.projectId != operation.command.expectedProjectId)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Prepared Session scope changed")
        authorize(operation.request, caller, capability, actual.projectId)
        return actual
    }
    private suspend fun load(id: String, caller: VerifiedCaller): SessionMutationOperation {
        if (!sessionMutationIdentifier(id, 200)) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid operation identity")
        return store.get(caller.binding, id)?.also {
            check(it.callerBinding == caller.binding && it.request.operationId == id) { "Invalid journal identity" }
        } ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Mutation operation is unavailable")
    }
    private suspend fun save(old: SessionMutationOperation, stage: SessionMutationStage, receipt: SessionMutationReceipt? = old.receipt): SessionMutationOperation {
        val next = old.copy(revision = old.revision + 1, stage = stage, receipt = receipt)
        if (!withContext(NonCancellable) { store.replace(next, old.revision) })
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Mutation operation changed; query it again")
        return next
    }
    suspend fun prepare(request: SessionMutationRequest, caller: VerifiedCaller): SessionMutationOperation = mutex.withLock {
        request.validate()
        val fingerprint = sha(AppApiJson.encodeToString(request))
        store.get(caller.binding, request.operationId)?.let {
            if (it.fingerprint != fingerprint || it.request != request) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Operation identity was reused")
            return@withLock checkDelivery(it, caller, SessionMutationCapabilities.PREPARE)
        }
        val timestamp = now()
        val deadline = request.deadlineAt ?: (timestamp + 10 * 60_000)
        if (deadline <= timestamp) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Mutation deadline has passed")
        if (deadline - timestamp > 60 * 60_000) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Mutation deadline exceeds one hour")
        candidate(request, caller, SessionMutationCapabilities.PREPARE)
        access.withTarget(request.targetInstanceId) { target ->
            candidate(request, caller, SessionMutationCapabilities.PREPARE)
            if (!target.protocol().supports(request.kind)) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "PC conditional mutations are unavailable")
            val actual = context(target.context(request.sessionId), request)
            authorize(request, caller, SessionMutationCapabilities.PREPARE, actual.projectId)
            if (actual.remainingMutationReceipts == 0) apiFailure(ApiErrorCode.RATE_LIMITED, "Session receipt budget is exhausted")
            val command = SessionMutationCommand("appapi-session-" + sha(AppApiJson.encodeToString(
                listOf(caller.binding, request.operationId, request.targetInstanceId, request.sessionId))),
                actual.revision, actual.scopeRevision, actual.projectId, request.kind,
                if (request.kind == SessionMutationKind.RENAME) JsonPrimitive(request.title!!) else JsonPrimitive(request.flag!!))
            try { command.validate() } catch (_: IllegalArgumentException) { apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid mutation value") }
            val operation = SessionMutationOperation(caller.binding, request, fingerprint, command, timestamp, deadline)
            verify(operation, caller, SessionMutationCapabilities.PREPARE, target)
            coroutineContext.ensureActive()
            if (!withContext(NonCancellable) { store.insert(operation) }) {
                val retained = load(request.operationId, caller)
                if (retained.fingerprint != fingerprint || retained.request != request)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Operation identity was reused")
                verify(retained, caller, SessionMutationCapabilities.PREPARE, target)
                retained
            } else operation
        }
    }

    suspend fun checkDelivery(operation: SessionMutationOperation, caller: VerifiedCaller, capability: String): SessionMutationOperation {
        if (operation.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Mutation belongs to another caller")
        candidate(operation.request, caller, capability)
        access.withTarget(operation.request.targetInstanceId) { verify(operation, caller, capability, it) }
        return operation
    }
    suspend fun get(operationId: String, caller: VerifiedCaller) = checkDelivery(load(operationId, caller), caller, SessionMutationCapabilities.GET)

    private fun validateReceipt(operation: SessionMutationOperation, receipt: SessionMutationReceipt, lookup: Boolean): SessionMutationReceipt {
        try { receipt.validate() } catch (_: IllegalArgumentException) { apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Invalid mutation receipt") }
        if (receipt.requestId != operation.command.requestId || receipt.sessionId != operation.request.sessionId ||
            receipt.kind != operation.request.kind || receipt.projectId != operation.command.expectedProjectId ||
            receipt.scopeRevision != operation.command.expectedScopeRevision || receipt.revision == operation.command.expectedRevision ||
            (lookup && receipt.duplicate)) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Mutation receipt does not match the prepared request")
        return receipt.copy(duplicate = false) // Journal stores the original fact, independent of transport replay.
    }

    suspend fun reconcile(operationId: String, caller: VerifiedCaller): SessionMutationOperation = mutex.withLock {
        var operation = load(operationId, caller)
        candidate(operation.request, caller, SessionMutationCapabilities.RECONCILE)
        access.withTarget(operation.request.targetInstanceId) { target ->
            verify(operation, caller, SessionMutationCapabilities.RECONCILE, target)
            if (operation.stage == SessionMutationStage.SUBMITTING) {
                target.receipt(operation.request.sessionId, operation.command.requestId)?.let {
                    operation = save(operation, SessionMutationStage.APPLIED, validateReceipt(operation, it, true))
                }
            }
            verify(operation, caller, SessionMutationCapabilities.RECONCILE, target)
            operation
        }
    }

    suspend fun commit(operationId: String, caller: VerifiedCaller, expectedKind: SessionMutationKind? = null): SessionMutationOperation = mutex.withLock {
        var operation = load(operationId, caller)
        if (expectedKind != null && operation.request.kind != expectedKind)
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Capability differs from the prepared mutation kind")
        val capability = SessionMutationCapabilities.effect(operation.request.kind)
        candidate(operation.request, caller, capability)
        access.withTarget(operation.request.targetInstanceId) { target ->
            var actual = verify(operation, caller, capability, target)
            if (operation.stage == SessionMutationStage.APPLIED) return@withTarget operation
            if (operation.stage == SessionMutationStage.CANCELLED) apiFailure(ApiErrorCode.CANCELLED, "Submission was cancelled")
            if (operation.stage == SessionMutationStage.CONFLICT) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Mutation conflicted")
            if (operation.stage == SessionMutationStage.SUBMITTING) {
                // Own accepted write changes the metadata revision: recover its receipt before comparing revisions.
                val receipt = target.receipt(operation.request.sessionId, operation.command.requestId)
                if (receipt != null) {
                    operation = save(operation, SessionMutationStage.APPLIED, validateReceipt(operation, receipt, true))
                    verify(operation, caller, capability, target)
                    return@withTarget operation
                }
                actual = verify(operation, caller, capability, target)
            }
            if (now() >= operation.deadlineAt || operation.stage == SessionMutationStage.EXPIRED) {
                if (operation.stage == SessionMutationStage.PREPARED) save(operation, SessionMutationStage.EXPIRED)
                apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed; reconcile an unknown receipt")
            }
            if (actual.revision != operation.command.expectedRevision) {
                save(operation, SessionMutationStage.CONFLICT)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session metadata changed; prepare a new operation explicitly")
            }
            if (!target.protocol().supports(operation.request.kind)) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "PC conditional mutations are unavailable")
            actual = verify(operation, caller, capability, target)
            if (actual.revision != operation.command.expectedRevision)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session metadata changed")
            if (now() >= operation.deadlineAt) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
            coroutineContext.ensureActive()
            if (operation.stage == SessionMutationStage.PREPARED) operation = save(operation, SessionMutationStage.SUBMITTING)
            actual = verify(operation, caller, capability, target)
            if (actual.revision != operation.command.expectedRevision)
                apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session metadata changed before dispatch")
            if (now() >= operation.deadlineAt) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
            coroutineContext.ensureActive()
            // Any lost/cancelled/invalid response leaves SUBMITTING durable. No automatic POST retry.
            val receipt = try { target.apply(operation.request.sessionId, operation.command) }
            catch (error: AppApiException) {
                if (error.error.code == ApiErrorCode.REVISION_CONFLICT) save(operation, SessionMutationStage.CONFLICT)
                throw error
            }
            operation = save(operation, SessionMutationStage.APPLIED, validateReceipt(operation, receipt, false))
            verify(operation, caller, capability, target)
            operation
        }
    }
    suspend fun cancel(operationId: String, caller: VerifiedCaller): SessionMutationOperation = mutex.withLock {
        val operation = checkDelivery(load(operationId, caller), caller, SessionMutationCapabilities.CANCEL)
        when (operation.stage) {
            SessionMutationStage.PREPARED -> save(operation, SessionMutationStage.CANCELLED)
            SessionMutationStage.CANCELLED -> operation
            else -> apiFailure(ApiErrorCode.REVISION_CONFLICT, "Only an undispatched preparation can be cancelled")
        }
    }
    private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}
