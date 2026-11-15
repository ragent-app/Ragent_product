package com.andysagent.ragent.core.appapi

import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.JsonObject
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.domain.FileUploadProgress
import com.andysagent.ragent.core.domain.FileUploadPhase
import com.andysagent.ragent.core.domain.SessionRepositoryException
import com.andysagent.ragent.core.domain.SessionScopeCondition
import com.andysagent.ragent.core.domain.ScopedMessageCommitReceipt
import com.andysagent.ragent.core.domain.ScopedMessageRequest

/** Shared task workflow; durable hosts inject a lease shared by every executor of their journal. */
class TaskCoordinator(
    private val store: OperationStore,
    private val directory: suspend () -> TargetDirectorySnapshot,
    private val authorizer: CallerAuthorizer,
    private val targetAccess: TargetTaskAccess,
    private val registry: CapabilityRegistry = CapabilityRegistry(),
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val resources: TaskResources = NoTaskResources,
    private val executionLease: TaskExecutionLease = InProcessTaskExecutionLease(),
) {
    suspend fun listTargets(caller: VerifiedCaller): List<ApiTarget> {
        registry.requireImplemented(CapabilityRegistry.TARGETS_LIST)
        return authorizer.authorizedTargets(caller, CapabilityRegistry.TARGETS_LIST, directory().targets)
    }

    suspend fun prepare(request: TaskRequest, caller: VerifiedCaller): PreparedTask = executionLease.withLease(request.operationId) {
        registry.requireImplemented(CapabilityRegistry.TASKS_PREPARE)
        validate(request)
        // Detach all caller-owned collections before fixing parameters.
        val frozen = AppApiJson.decodeFromString<TaskRequest>(AppApiJson.encodeToString(request))
        // Preserve existing text-only operation fingerprints after this additive upgrade.
        val encoded = AppApiJson.parseToJsonElement(AppApiJson.encodeToString(frozen)).jsonObject
        val canonical = if (frozen.resources.isEmpty()) JsonObject(encoded.filterKeys { it != "resources" }).toString() else encoded.toString()
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        store.get(frozen.operationId)?.let { return@withLease replayPreparation(it, fingerprint, caller) }
        val snapshot = directory()
        val candidates = authorizer.authorizedTargets(caller, CapabilityRegistry.TASKS_PREPARE, snapshot.targets)
        val target = resolveTaskTarget(frozen, snapshot.copy(targets = candidates))
        if (frozen.existingSessionId == null)
            authorizer.require(caller, CapabilityRegistry.TASKS_PREPARE, target.instanceId, null, frozen.projectId)
        else authorizer.requireSessionCandidate(caller, CapabilityRegistry.TASKS_PREPARE, target.instanceId, frozen.existingSessionId)
        resources.validate(frozen.resources, caller)
        val timestamp = now()
        val deadline = frozen.deadlineAt ?: (timestamp + 10 * 60_000)
        if (deadline <= timestamp) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Preparation deadline has passed")
        if (deadline - timestamp > 24 * 60 * 60_000L) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Preparation deadline exceeds PC protocol lifetime")
        val originalScope = frozen.existingSessionId?.let { sessionId ->
            targetAccess.withTarget(target.instanceId) { pc ->
                pc.requireMessageSupport()
                val scope = pc.originalSessionScope(sessionId).validate()
                if (scope.sessionId != sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Session scope identity differs")
                authorizer.require(caller, CapabilityRegistry.TASKS_PREPARE, target.instanceId, sessionId, scope.expectedProjectId)
                if (frozen.projectId != null && frozen.projectId != scope.expectedProjectId)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Declared project differs from actual Session scope")
                if (directory().targets.none { it.instanceId == target.instanceId }) apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Prepared computer was unpaired")
                if (now() >= deadline) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Preparation deadline has passed")
                scope
            }
        }
        val operation = TaskOperation(frozen.operationId, caller.binding, fingerprint, newId(), target.instanceId, frozen,
            "appapi-create-${newId()}", "appapi-message-${newId()}", timestamp, deadline,
            sessionId = frozen.existingSessionId, messageProtocolVersion = 1, originalScope = originalScope)
        if (!store.insert(operation)) {
            val existing = store.get(operation.operationId) ?: apiFailure(ApiErrorCode.INTERNAL_ERROR, "Preparation identity collision")
            return@withLease replayPreparation(existing, fingerprint, caller)
        }
        operation.preparation()
    }

    private suspend fun replayPreparation(operation: TaskOperation, fingerprint: String, caller: VerifiedCaller): PreparedTask {
        authorize(operation, caller, CapabilityRegistry.TASKS_PREPARE)
        if (operation.originalFingerprint != fingerprint) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Operation identity was already used with different parameters")
        verifyStoredScope(operation, caller, CapabilityRegistry.TASKS_PREPARE)
        return operation.preparation()
    }

    suspend fun get(operationId: String, caller: VerifiedCaller): TaskOperation {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        authorize(operation, caller, CapabilityRegistry.TASKS_GET)
        verifyStoredScope(operation, caller, CapabilityRegistry.TASKS_GET)
        return operation
    }

    /** Reauthorize the actual retained resource without granting an extra tasks.get capability. */
    suspend fun checkPreparedDelivery(prepared: PreparedTask, caller: VerifiedCaller): TaskOperation {
        val operation = store.get(prepared.operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        if (operation.preparationId != prepared.preparationId || operation.targetInstanceId != prepared.targetInstanceId)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Preparation delivery identity differs")
        return checkDelivery(operation, caller, CapabilityRegistry.TASKS_PREPARE)
    }

    suspend fun checkDelivery(delivery: TaskOperation, caller: VerifiedCaller, capability: String): TaskOperation {
        val saved = store.get(delivery.operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        if (saved.preparationId != delivery.preparationId || saved.targetInstanceId != delivery.targetInstanceId ||
            saved.callerBinding != delivery.callerBinding || saved.originalFingerprint != delivery.originalFingerprint ||
            (delivery.sessionId != null && saved.sessionId != delivery.sessionId) ||
            (delivery.originalScope != null && saved.originalScope != delivery.originalScope))
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Operation delivery identity differs")
        authorize(saved, caller, capability)
        suspend fun requireActualResource() {
            authorizer.require(caller, capability, saved.targetInstanceId,
                saved.sessionId ?: saved.request.existingSessionId, authorizationProject(saved))
            requirePaired(saved)
        }
        requireActualResource()
        verifyStoredScope(saved, caller, capability)
        requireActualResource() // A PC scope query can race grant revocation or unpairing.
        return saved
    }

    private fun authorizationProject(operation: TaskOperation): String? =
        if (operation.originalScope != null) operation.originalScope.expectedProjectId else operation.request.projectId

    /** Does not create Sessions, send messages or extend submission deadlines. */
    suspend fun reconcile(operationId: String, caller: VerifiedCaller): TaskOperation = executionLease.withLease(operationId) {
        var operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        authorize(operation, caller, CapabilityRegistry.TASKS_RECONCILE)
        if (operation.messageProtocolVersion == 1) return@withLease reconcileScoped(operation, caller)
        val sessionId = operation.sessionId
        if (sessionId == null || operation.stage !in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)
            || (operation.stage == OperationStage.ACCEPTED && operation.runId != null)) return@withLease operation
        try {
            targetAccess.withTarget(operation.targetInstanceId) { target ->
                authorize(operation, caller, CapabilityRegistry.TASKS_RECONCILE)
                requirePaired(operation)
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RECONCILE, target, sessionId)
                val receipt = target.findReceipt(operation, sessionId)
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RECONCILE, target, sessionId)
                authorize(operation, caller, CapabilityRegistry.TASKS_RECONCILE)
                requirePaired(operation)
                if (receipt != null) {
                    if (receipt.sessionId != sessionId || receipt.requestId != operation.messageRequestId) {
                        apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Receipt lookup identity differs")
                    }
                    operation = save(operation, operation.copy(stage = OperationStage.ACCEPTED, runId = receipt.runId,
                        queued = receipt.queued, lastError = null))
                } else if (operation.stage != OperationStage.ACCEPTED) {
                    operation = save(operation, operation.copy(lastError = ApiError(ApiErrorCode.RESULT_UNKNOWN,
                        "No retained PC acceptance evidence; do not create a new submission identity", true)))
                }
            }
            operation
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            if (failure is AppApiException && failure.error.code == ApiErrorCode.REVISION_CONFLICT) throw failure
            val error = when (failure) {
                is AppApiException -> failure.error
                is SessionRepositoryException -> when (failure.statusCode) {
                    401 -> ApiError(ApiErrorCode.AUTHENTICATION_REQUIRED, "Target authentication is required")
                    403 -> ApiError(ApiErrorCode.PERMISSION_DENIED, "Target denied receipt lookup")
                    404 -> ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Receipt lookup or retained Session is unavailable")
                    else -> ApiError(ApiErrorCode.RESULT_UNKNOWN, "PC receipt could not be verified", true)
                }
                else -> ApiError(ApiErrorCode.RESULT_UNKNOWN, "PC receipt could not be verified", true)
            }
            save(operation, operation.copy(lastError = error))
        }
    }

    /** Read-only on the PC; persists a bounded, caller-bound phone snapshot. */
    suspend fun readResult(operationId: String, caller: VerifiedCaller): TaskOperation = executionLease.withLease(operationId) {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        authorize(operation, caller, CapabilityRegistry.TASKS_RESULT)
        if (operation.sessionId == null || operation.stage !in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) {
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Submission has not reached message dispatch")
        }
        if (operation.messageProtocolVersion == 1 && operation.commitReceipt == null)
            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Reconcile original PC acceptance before reading its result")
        try {
            val result = targetAccess.withTarget(operation.targetInstanceId) { target ->
                authorize(operation, caller, CapabilityRegistry.TASKS_RESULT)
                requirePaired(operation)
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT, target, operation.sessionId)
                val read = target.readResult(operation)
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT, target, operation.sessionId)
                read
            }
            // Revocation/unpairing during the read must not publish new data.
            authorize(operation, caller, CapabilityRegistry.TASKS_RESULT)
            requirePaired(operation)
            if (result.sessionId != operation.sessionId || result.requestId != operation.messageRequestId ||
                (operation.runId != null && result.runId != operation.runId)) {
                apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Result identity differs from submission")
            }
            save(operation, operation.copy(result = result, runId = result.runId ?: operation.runId,
                stage = if (result.state != TaskResultState.UNCONFIRMED && (operation.messageProtocolVersion == 0 || operation.commitReceipt != null)) OperationStage.ACCEPTED else operation.stage,
                queued = result.state == TaskResultState.QUEUED, lastError = null))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            if (failure is AppApiException && failure.error.code in setOf(ApiErrorCode.REVISION_CONFLICT,
                    ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.TARGET_NOT_FOUND)) throw failure
            val error = when (failure) {
                is AppApiException -> failure.error
                is SessionRepositoryException -> when (failure.statusCode) {
                    401 -> ApiError(ApiErrorCode.AUTHENTICATION_REQUIRED, "Target authentication is required")
                    403 -> ApiError(ApiErrorCode.PERMISSION_DENIED, "Target denied result lookup")
                    404 -> ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Retained result lookup is unavailable")
                    else -> ApiError(ApiErrorCode.RESULT_UNKNOWN, "PC result could not be verified", true)
                }
                else -> ApiError(ApiErrorCode.RESULT_UNKNOWN, "PC result could not be verified", true)
            }
            save(operation, operation.copy(lastError = error))
        }
    }

    /** Saves only complete export metadata, not temporary or partially downloaded bytes. */
    suspend fun readResultExport(operationId: String, caller: VerifiedCaller): TaskOperation = executionLease.withLease(operationId) {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        val checkAccess: suspend () -> Unit = { authorizeExport(operation, caller) }
        checkAccess()
        if (operation.messageProtocolVersion == 1 && operation.commitReceipt == null)
            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Reconcile original PC acceptance before reading its export")
        val manifest = targetAccess.withTarget(operation.targetInstanceId) { target ->
            checkAccess()
            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT_EXPORT, target, operation.sessionId, operation.sessionId)
            val read = target.readResultExport(operation, checkAccess)
            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT_EXPORT, target, operation.sessionId, operation.sessionId)
            read
        }.validated(operation, now())
        checkAccess()
        val saved = save(operation, operation.copy(resultExport = manifest, runId = manifest.runId,
            stage = if (operation.messageProtocolVersion == 0 || operation.commitReceipt != null) OperationStage.ACCEPTED else operation.stage,
            queued = false, lastError = null))
        checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
        manifest.validated(operation, now())
        saved
    }

    /** The caller's sink must remain private/unpublished until a verified receipt is returned. */
    suspend fun streamResultExport(operationId: String, caller: VerifiedCaller, revision: String, resourceId: String,
        prefix: ResultExportPrefix? = null, sink: suspend (ByteArray) -> Unit): ResultExportReceipt = executionLease.withLease(operationId) {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        val checkAccess: suspend () -> Unit = { authorizeExport(operation, caller) }
        checkAccess()
        val manifest = operation.resultExport?.validated(operation, now())
            ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Query the exact export manifest first")
        if (revision != manifest.revision) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Download manifest revision differs")
        val resource = manifest.resources.firstOrNull { it.resourceId == resourceId && it.available }
            ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Result resource is not downloadable")
        val hash = MessageDigest.getInstance("SHA-256")
        var size = feedExportPrefix(prefix, resource.sizeBytes!!, checkAccess) { hash.update(it) }
        val receipt = targetAccess.withTarget(operation.targetInstanceId) { target ->
            checkAccess()
            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT_EXPORT, target, operation.sessionId, operation.sessionId)
            val streamed = target.streamResultExport(operation, manifest, resourceId, checkAccess, prefix) { bytes ->
                checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
                if (bytes.size > manifest.maxChunkBytes || size + bytes.size > resource.sizeBytes!!) invalidExport()
                size += bytes.size; hash.update(bytes)
                sink(bytes)
                checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
            }
            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RESULT_EXPORT, target, operation.sessionId, operation.sessionId)
            streamed
        }
        checkAccess(); kotlinx.coroutines.currentCoroutineContext().ensureActive()
        manifest.validated(operation, now())
        if (receipt.manifestRevision != revision || receipt.resourceId != resourceId || receipt.sizeBytes != resource.sizeBytes ||
            receipt.sha256 != resource.sha256 || size != resource.sizeBytes || hash.digest().hex() != resource.sha256) invalidExport()
        receipt
    }

    private suspend fun authorizeExport(operation: TaskOperation, caller: VerifiedCaller) {
        registry.requireImplemented(CapabilityRegistry.TASKS_RESULT_EXPORT)
        if (caller.binding != operation.callerBinding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Operation belongs to another caller")
        requireExportOperation(operation, operation.targetInstanceId)
        // Unlike preparation, this resource exists in the actual created Session.
        authorizer.require(caller, CapabilityRegistry.TASKS_RESULT_EXPORT, operation.targetInstanceId,
            operation.sessionId, authorizationProject(operation))
        requirePaired(operation)
    }

    internal suspend fun savedResultExport(operationId: String, caller: VerifiedCaller, revision: String): ResultExportManifest {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        authorizeExport(operation, caller)
        val manifest = operation.resultExport?.validated(operation, now()) ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Query the export manifest first")
        if (manifest.revision != revision) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Export revision differs")
        return manifest
    }

    /** Verified local copies outlive PC snapshot TTL; no connection or remote query. */
    internal suspend fun requireOutputAccess(operationId: String, caller: VerifiedCaller, origin: ResultExportManifest,
        paired: Boolean = false) {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        registry.requireImplemented(CapabilityRegistry.TASKS_RESULT_EXPORT)
        if (operation.callerBinding != caller.binding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Output belongs to another caller")
        origin.validated(operation, Long.MIN_VALUE)
        authorizer.require(caller, CapabilityRegistry.TASKS_RESULT_EXPORT, operation.targetInstanceId,
            operation.sessionId, authorizationProject(operation))
        if (paired) requirePaired(operation)
    }

    suspend fun commit(preparationId: String, caller: VerifiedCaller,
        onUploadProgress: (TaskUploadProgress) -> Unit = {}): TaskOperation =
        commitWithGuard(preparationId, caller, onUploadProgress) { }

    internal suspend fun commitWithGuard(preparationId: String, caller: VerifiedCaller,
        onUploadProgress: (TaskUploadProgress) -> Unit = {}, beforeEffects: suspend (TaskOperation) -> Unit): TaskOperation {
        suspend fun checkExecution(operation: TaskOperation) {
            checkEffectsAllowed(operation, caller)
            beforeEffects(operation)
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
        }
        val initial = store.getByPreparation(preparationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Preparation not found")
        return executionLease.withLease(initial.operationId) {
            var operation = store.get(initial.operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
            authorize(operation, caller, CapabilityRegistry.TASKS_COMMIT)
            if (operation.messageProtocolVersion != 1)
                apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Legacy task journals are read-only; prepare a new explicit operation")
            beforeEffects(operation)
            when (operation.stage) {
                OperationStage.ACCEPTED -> { verifyStoredScope(operation, caller, CapabilityRegistry.TASKS_COMMIT); return@withLease operation }
                OperationStage.CANCELLED -> apiFailure(ApiErrorCode.CANCELLED, "Submission was cancelled")
                OperationStage.EXPIRED -> apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
                else -> Unit
            }
            if (now() >= operation.deadlineAt && operation.stage != OperationStage.SUBMITTING) {
                return@withLease expire(operation)
            }
            fun reportUpload(ref: CaptureResourceRef, progress: FileUploadProgress) {
                try { onUploadProgress(TaskUploadProgress(operation.operationId, operation.targetInstanceId,
                    ref.resourceId, ref.originalName, operation.uploads.size, operation.request.resources.size,
                    operation.uploads.sumOf { it.sizeBytes }, operation.request.resources.sumOf { it.sizeBytes },
                    progress.phase.toTaskPhase(), progress.totalBytes, progress.writtenBytes)) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* Observation cannot replace the durable upload receipt. */ }
            }
            try {
                if (operation.stage != OperationStage.SUBMITTING) resources.validate(operation.request.resources, caller)
                if (operation.stage == OperationStage.PREPARED) operation = save(operation, operation.copy(stage = OperationStage.CONNECTING))
                targetAccess.withTarget(operation.targetInstanceId) { target ->
                    // A possibly accepted POST is resolved before any further write or deadline check.
                    if (operation.stage == OperationStage.SUBMITTING) {
                        authorize(operation, caller, CapabilityRegistry.TASKS_COMMIT); requirePaired(operation)
                        verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, operation.sessionId)
                        val retained = target.findMessageCommit(operation)
                        if (retained?.accepted == true) {
                            operation = acceptScoped(operation, retained)
                            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, operation.sessionId)
                            authorize(operation, caller, CapabilityRegistry.TASKS_COMMIT); requirePaired(operation)
                            return@withTarget
                        }
                        if (now() >= operation.deadlineAt) { operation = expire(operation); return@withTarget }
                    }
                    checkExecution(operation)
                    target.requireMessageSupport()
                    if (operation.request.resources.isNotEmpty() && operation.stage != OperationStage.SUBMITTING) target.requireUploadSupport()
                    checkExecution(operation)
                    var sessionId = operation.sessionId
                    if (sessionId == null) {
                        operation = save(operation, operation.copy(stage = OperationStage.CREATING_SESSION, lastError = null))
                        checkExecution(operation)
                        sessionId = target.createSession(operation)
                        if (sessionId.isBlank()) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Target did not return a Session identity")
                        operation = save(operation, operation.copy(stage = OperationStage.SESSION_READY, sessionId = sessionId))
                    }
                    checkExecution(operation)
                    if (operation.originalScope == null) {
                        val original = target.originalSessionScope(sessionId).validate()
                        if (original.sessionId != sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Session scope identity differs")
                        authorizer.require(caller, CapabilityRegistry.TASKS_COMMIT, operation.targetInstanceId, sessionId, original.expectedProjectId)
                        if (operation.request.projectId != null && original.expectedProjectId != operation.request.projectId)
                            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Created Session project differs from requested scope")
                        requirePaired(operation)
                        operation = save(operation, operation.copy(originalScope = original))
                    }
                    verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, sessionId)
                    checkExecution(operation)
                    // Restored receipts must match the frozen input before any further upload or UI confirmation.
                    requireMatchingUploadReceipts(operation, sessionId)
                    operation.uploads.lastOrNull()?.let { saved ->
                        val ref = operation.request.resources.first { it.resourceId == saved.resourceId }
                        reportUpload(ref, FileUploadProgress(FileUploadPhase.CONFIRMED, ref.sizeBytes))
                    }
                    if (operation.request.resources.isNotEmpty() && operation.stage !in setOf(OperationStage.MESSAGE_PREPARING, OperationStage.SUBMITTING)) {
                        operation = save(operation, operation.copy(stage = OperationStage.UPLOADING, lastError = null))
                        for (ref in operation.request.resources) {
                            checkExecution(operation)
                            if (operation.uploads.any { it.resourceId == ref.resourceId }) continue
                            val bytes = resources.read(ref, caller)
                            checkExecution(operation)
                            verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, sessionId)
                            checkExecution(operation)
                            reportUpload(ref, FileUploadProgress(
                                FileUploadPhase.CHECKING, ref.sizeBytes))
                            val receipt = target.uploadScopedAttachment(operation, sessionId, ref, bytes, onProgress = {
                                if (it.phase != FileUploadPhase.CONFIRMED) reportUpload(ref, it)
                            }) {
                                checkExecution(operation)
                            }
                            if (!receipt.ready || receipt.instanceId != operation.targetInstanceId || receipt.sessionId != sessionId
                                || receipt.scopeContractVersion != 1
                                || receipt.originalName != ref.originalName || receipt.mimeType != ref.mimeType
                                || receipt.sizeBytes != ref.sizeBytes || receipt.sha256 != ref.sha256) {
                                apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Attachment acknowledgement differs from frozen input")
                            }
                            operation = save(operation, operation.copy(uploads = operation.uploads + ResourceUploadReceipt(ref.resourceId,
                                receipt.instanceId, receipt.sessionId, receipt.assetId, receipt.originalName, receipt.mimeType,
                                receipt.sizeBytes, receipt.sha256, ref.renderAsFile, receipt.scopeContractVersion)))
                            reportUpload(ref, FileUploadProgress(
                                FileUploadPhase.CONFIRMED, ref.sizeBytes))
                        }
                    }
                    requireCompleteUploads(operation, sessionId)
                    checkExecution(operation)
                    if (operation.request.resources.isNotEmpty())
                        verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, sessionId)
                    checkExecution(operation)
                    if (operation.pcPreparationId == null) {
                        val recovering = operation.stage == OperationStage.MESSAGE_PREPARING
                        operation = save(operation, operation.copy(stage = OperationStage.MESSAGE_PREPARING, lastError = null))
                        val previous = if (recovering) target.findMessagePreparation(operation) else null
                        checkExecution(operation)
                        val prepared = previous ?: target.prepareMessage(operation)
                        if (prepared.sessionId != sessionId || prepared.requestId != operation.messageRequestId ||
                            prepared.expiresAt != ScopedMessageRequest.expiry(operation.deadlineAt) || prepared.accepted || prepared.dispatched)
                            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "PC preparation acknowledgement differs")
                        operation = withContext(NonCancellable) { save(operation, operation.copy(pcPreparationId = prepared.preparationId)) }
                        verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, sessionId)
                        checkExecution(operation)
                        if (prepared.state != "prepared") apiFailure(ApiErrorCode.REQUEST_EXPIRED, "PC preparation has expired")
                    }
                    operation = save(operation, operation.copy(stage = OperationStage.SUBMITTING, lastError = null))
                    checkExecution(operation)
                    operation = acceptScoped(operation, target.commitPreparedMessage(operation))
                    verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_COMMIT, target, sessionId)
                    authorize(operation, caller, CapabilityRegistry.TASKS_COMMIT); requirePaired(operation)
                }
                operation
            } catch (cancelled: CancellationException) {
                withContext(NonCancellable) {
                    runCatching { save(operation, operation.copy(lastError = uncertainError(operation))) }
                        .exceptionOrNull()?.let(cancelled::addSuppressed)
                }
                throw cancelled
            } catch (failure: Exception) {
                val error = when (failure) {
                    is AppApiException -> failure.error
                    is SessionRepositoryException -> when (failure.statusCode) {
                        401 -> ApiError(ApiErrorCode.AUTHENTICATION_REQUIRED, "Target authentication is required")
                        403 -> ApiError(ApiErrorCode.PERMISSION_DENIED, "Target denied this operation")
                        404 -> ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "Target resource or protocol is unavailable")
                        409 -> ApiError(ApiErrorCode.REVISION_CONFLICT, "Target reports a conflicting operation")
                        else -> uncertainError(operation)
                    }
                    is ApiException -> when (failure.statusCode) {
                        401 -> ApiError(ApiErrorCode.AUTHENTICATION_REQUIRED, "Target authentication is required")
                        403 -> ApiError(ApiErrorCode.PERMISSION_DENIED, "Target denied conditional operation")
                        404, 501 -> ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional operation is unavailable at this target")
                        409 -> ApiError(ApiErrorCode.REVISION_CONFLICT, "Target reports conflicting operation scope or facts")
                        410 -> ApiError(ApiErrorCode.REQUEST_EXPIRED, "PC preparation has expired")
                        413 -> ApiError(ApiErrorCode.RESOURCE_LIMIT, "Conditional operation exceeds target limits")
                        429 -> ApiError(ApiErrorCode.RATE_LIMITED, "Target conditional storage is at capacity")
                        else -> uncertainError(operation)
                    }
                    else -> uncertainError(operation)
                }
                // A journal CAS failure must not overwrite another coordinator.
                if (error.code == ApiErrorCode.REVISION_CONFLICT && failure is AppApiException) throw failure
                val saved = save(operation, operation.copy(lastError = error))
                if (saved.sessionId != null && saved.originalScope == null) throw AppApiException(error)
                if (error.code in setOf(ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.TARGET_NOT_FOUND))
                    throw AppApiException(error)
                // Failures can race revocation just as successful replies can.
                authorize(saved, caller, CapabilityRegistry.TASKS_COMMIT)
                requirePaired(saved)
                saved
            }
        }
    }

    suspend fun cancelSubmission(operationId: String, caller: VerifiedCaller): TaskOperation = executionLease.withLease(operationId) {
        val operation = store.get(operationId) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Operation not found")
        authorize(operation, caller, CapabilityRegistry.TASKS_CANCEL)
        if (operation.stage == OperationStage.SUBMITTING || operation.stage == OperationStage.ACCEPTED) {
            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Message may already be accepted; cancellation of a remote Run is a separate action")
        }
        if (operation.stage == OperationStage.CANCELLED) return@withLease operation
        if (operation.stage == OperationStage.EXPIRED)
            apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
        save(operation, operation.copy(stage = OperationStage.CANCELLED, lastError = null))
    }

    private suspend fun verifyTargetSession(operation: TaskOperation, caller: VerifiedCaller, capability: String,
        target: TaskTarget, sessionId: String?, authorizationSessionId: String? = operation.request.existingSessionId) {
        if (operation.messageProtocolVersion == 1 && operation.originalScope != null) {
            val frozen = operation.originalScope.validate()
            authorizer.require(caller, capability, operation.targetInstanceId, sessionId, frozen.expectedProjectId)
            requirePaired(operation)
            val actual = target.originalSessionScope(frozen.sessionId).validate()
            authorizer.require(caller, capability, operation.targetInstanceId, sessionId, actual.expectedProjectId)
            requirePaired(operation)
            if (actual != frozen) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session scope changed; original operation cannot be rescoped")
            return
        }
        val verify = authorizer.requiresProjectVerification(caller, capability, operation.targetInstanceId,
            authorizationSessionId, operation.request.projectId)
        authorizer.require(caller, capability, operation.targetInstanceId, authorizationSessionId, operation.request.projectId)
        requirePaired(operation)
        if (!verify) return
        val expected = sessionId ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Submission has no Session")
        val actual = target.sessionContext(expected)
        if (actual.sessionId != expected) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Target returned another Session context")
        // Fresh grants and pairing are rechecked after this suspendable PC query.
        authorizer.require(caller, capability, operation.targetInstanceId, authorizationSessionId, actual.projectId)
        requirePaired(operation)
        if (actual.projectId != operation.request.projectId)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session project differs from the frozen request")
    }

    private suspend fun authorize(operation: TaskOperation, caller: VerifiedCaller, capability: String) {
        registry.requireImplemented(capability)
        if (caller.binding != operation.callerBinding) apiFailure(ApiErrorCode.PERMISSION_DENIED, "Preparation belongs to another caller")
        authorizer.require(caller, capability, operation.targetInstanceId,
            if (operation.originalScope != null) operation.sessionId else operation.request.existingSessionId,
            authorizationProject(operation))
    }

    private suspend fun verifyStoredScope(operation: TaskOperation, caller: VerifiedCaller, capability: String) {
        if (operation.sessionId == null) return
        if (operation.messageProtocolVersion == 0 && !authorizer.requiresProjectVerification(caller, capability,
                operation.targetInstanceId, operation.request.existingSessionId, operation.request.projectId)) return
        targetAccess.withTarget(operation.targetInstanceId) { pc ->
            if (operation.messageProtocolVersion == 1 && operation.originalScope == null) {
                requirePaired(operation)
                val actual = pc.originalSessionScope(operation.sessionId).validate()
                if (actual.sessionId != operation.sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Session scope identity differs")
                authorizer.require(caller, capability, operation.targetInstanceId, operation.sessionId, actual.expectedProjectId)
                requirePaired(operation)
                if (operation.request.projectId != null && operation.request.projectId != actual.expectedProjectId)
                    apiFailure(ApiErrorCode.REVISION_CONFLICT, "Created Session project differs from original request")
            } else verifyTargetSession(operation, caller, capability, pc, operation.sessionId)
        }
    }

    private suspend fun acceptScoped(operation: TaskOperation, receipt: ScopedMessageCommitReceipt): TaskOperation {
        if (!receipt.accepted || receipt.version != 1 || receipt.sessionId != operation.sessionId ||
            receipt.requestId != operation.messageRequestId || receipt.preparationId != operation.pcPreparationId ||
            receipt.expiresAt != ScopedMessageRequest.expiry(operation.deadlineAt) ||
            receipt.runId == null || !Regex("run_appapi_[a-f0-9]{32}").matches(receipt.runId!!))
            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Conditional commit acknowledgement identity differs")
        // Retain acknowledged PC acceptance even when caller cancellation/revocation races delivery.
        return withContext(NonCancellable) {
            save(operation, operation.copy(stage = OperationStage.ACCEPTED, runId = receipt.runId, queued = receipt.queued,
                duplicate = receipt.duplicate, commitReceipt = receipt, lastError = null))
        }
    }

    /** Both preparation and commit recovery are GET-only, including after expiry. */
    private suspend fun reconcileScoped(initial: TaskOperation, caller: VerifiedCaller): TaskOperation {
        var operation = initial
        if (operation.originalScope == null || operation.stage !in setOf(OperationStage.MESSAGE_PREPARING,
                OperationStage.SUBMITTING, OperationStage.ACCEPTED)) {
            verifyStoredScope(operation, caller, CapabilityRegistry.TASKS_RECONCILE)
            return operation
        }
        try {
            targetAccess.withTarget(operation.targetInstanceId) { pc ->
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RECONCILE, pc, operation.sessionId)
                if (operation.pcPreparationId == null) {
                    val prepared = pc.findMessagePreparation(operation)
                    if (prepared != null) {
                        if (prepared.sessionId != operation.sessionId || prepared.requestId != operation.messageRequestId ||
                            prepared.expiresAt != ScopedMessageRequest.expiry(operation.deadlineAt) || prepared.accepted || prepared.dispatched)
                            apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Retained PC preparation identity differs")
                        operation = withContext(NonCancellable) { save(operation, operation.copy(pcPreparationId = prepared.preparationId)) }
                    }
                }
                if (operation.pcPreparationId != null) {
                    val receipt = pc.findMessageCommit(operation)
                    if (receipt?.accepted == true) operation = acceptScoped(operation, receipt)
                    else if (operation.stage != OperationStage.ACCEPTED) operation = save(operation, operation.copy(lastError =
                        ApiError(ApiErrorCode.RESULT_UNKNOWN, "No retained PC acceptance; readonly reconciliation never submits", true)))
                }
                verifyTargetSession(operation, caller, CapabilityRegistry.TASKS_RECONCILE, pc, operation.sessionId)
                authorize(operation, caller, CapabilityRegistry.TASKS_RECONCILE); requirePaired(operation)
            }
            return operation
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            if (failure is AppApiException && failure.error.code in setOf(ApiErrorCode.REVISION_CONFLICT,
                    ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.TARGET_NOT_FOUND)) throw failure
            val error = if (failure is AppApiException) failure.error else ApiError(ApiErrorCode.RESULT_UNKNOWN,
                "Original PC receipt could not be verified; no submission was attempted", true)
            return save(operation, operation.copy(lastError = error))
        }
    }

    private suspend fun checkEffectsAllowed(operation: TaskOperation, caller: VerifiedCaller) {
        authorize(operation, caller, CapabilityRegistry.TASKS_COMMIT)
        if (now() >= operation.deadlineAt) apiFailure(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")
        requirePaired(operation)
    }

    private suspend fun requirePaired(operation: TaskOperation) {
        // Revalidate pairing after waiting for a connection; never replace target.
        if (directory().targets.none { it.instanceId == operation.targetInstanceId }) {
            apiFailure(ApiErrorCode.TARGET_NOT_FOUND, "Prepared computer was unpaired")
        }
    }

    private suspend fun save(previous: TaskOperation, next: TaskOperation): TaskOperation {
        validateTaskTransition(previous, next)
        val updated = next.copy(revision = previous.revision + 1)
        if (!store.replace(updated, previous.revision)) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Operation was changed concurrently; query its current state")
        return updated
    }

    private suspend fun expire(operation: TaskOperation): TaskOperation = if (operation.stage == OperationStage.SUBMITTING) {
        // Never resend beyond a deadline to determine whether an unknown POST
        // succeeded. The caller can use the separate read-only reconcile action.
        save(operation, operation.copy(lastError = ApiError(ApiErrorCode.RESULT_UNKNOWN,
            "Submission may have been accepted before expiry; query PC receipt using reconcile")))
    } else save(operation, operation.copy(stage = OperationStage.EXPIRED,
        lastError = ApiError(ApiErrorCode.REQUEST_EXPIRED, "Submission deadline has passed")))

    private fun uncertainError(operation: TaskOperation): ApiError =
        if (operation.stage in setOf(OperationStage.CREATING_SESSION, OperationStage.UPLOADING, OperationStage.MESSAGE_PREPARING, OperationStage.SUBMITTING)) {
            ApiError(ApiErrorCode.RESULT_UNKNOWN, "Remote effect is not confirmed; retry this same preparation within its deadline", true)
        } else ApiError(ApiErrorCode.TARGET_OFFLINE, "Computer connection is unavailable", true)

    private fun validate(request: TaskRequest) = validateTaskRequest(request)
}

internal fun requireCompleteUploads(operation: TaskOperation, sessionId: String) {
    if (operation.uploads.size != operation.request.resources.size) {
        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Attachment receipts are incomplete")
    }
    requireMatchingUploadReceipts(operation, sessionId)
}

/** Accept a valid saved subset during recovery; completeness is checked separately before message effects. */
internal fun requireMatchingUploadReceipts(operation: TaskOperation, sessionId: String) {
    if (operation.uploads.map { it.resourceId }.distinct().size != operation.uploads.size)
        apiFailure(ApiErrorCode.REVISION_CONFLICT, "Attachment receipts contain duplicate identities")
    for (receipt in operation.uploads) {
        val ref = operation.request.resources.firstOrNull { it.resourceId == receipt.resourceId }
            ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Attachment receipt is not part of frozen input")
        if (receipt.targetInstanceId != operation.targetInstanceId || receipt.sessionId != sessionId
            || receipt.originalName != ref.originalName || receipt.mimeType != ref.mimeType || receipt.sizeBytes != ref.sizeBytes
            || receipt.sha256 != ref.sha256 || receipt.renderAsFile != ref.renderAsFile || !Regex("fasset_[a-f0-9]{24}").matches(receipt.assetId)
            || (operation.messageProtocolVersion == 1 && receipt.scopeContractVersion != 1)) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Attachment receipt differs from frozen input")
        }
    }
}
