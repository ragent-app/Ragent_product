package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import com.andysagent.ragent.core.domain.SessionRepository
import com.andysagent.ragent.core.domain.SessionRepositoryException
import com.andysagent.ragent.core.domain.SwitchingSessionRepository
import com.andysagent.ragent.core.protocol.CreateSessionRequestDto
import com.andysagent.ragent.core.domain.FileAssetUploadClient
import com.andysagent.ragent.core.domain.FileUploadInput
import com.andysagent.ragent.core.domain.TargetFileAsset
import com.andysagent.ragent.core.domain.SessionScopeCondition
import com.andysagent.ragent.core.domain.ScopedMessageClient
import com.andysagent.ragent.core.domain.ScopedMessageRequest
import com.andysagent.ragent.core.domain.PreparedMessageAsset
import com.andysagent.ragent.core.domain.ScopedMessagePreparation
import com.andysagent.ragent.core.domain.ScopedMessageCommitReceipt
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Authoritative scope returned by the fixed PC's Session detail endpoint. */
data class TaskSessionContext(val sessionId: String, val projectId: String?)

interface TaskTarget {
    suspend fun requireMessageSupport(): Unit = apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional message submission is unavailable")
    suspend fun originalSessionScope(sessionId: String): SessionScopeCondition =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Versioned Session scope is unavailable")
    suspend fun prepareMessage(operation: TaskOperation): ScopedMessagePreparation =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional message preparation is unavailable")
    suspend fun findMessagePreparation(operation: TaskOperation): ScopedMessagePreparation? =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional preparation lookup is unavailable")
    suspend fun commitPreparedMessage(operation: TaskOperation): ScopedMessageCommitReceipt =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional message commit is unavailable")
    suspend fun findMessageCommit(operation: TaskOperation): ScopedMessageCommitReceipt? =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional commit lookup is unavailable")
    suspend fun uploadScopedAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef,
        bytes: ByteArray, onProgress: (com.andysagent.ragent.core.domain.FileUploadProgress) -> Unit = {},
        checkAccess: suspend () -> Unit): TargetFileAsset =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional attachment upload is unavailable")
    suspend fun sessionContext(sessionId: String): TaskSessionContext =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Authoritative Session context is unavailable")
    suspend fun requireUploadSupport(): Unit = apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Stable attachment upload is unavailable")
    suspend fun createSession(operation: TaskOperation): String
    suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt
    suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt?
    suspend fun readResult(operation: TaskOperation): TaskResultSnapshot =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Retained result lookup is unavailable")
    suspend fun readResultExport(operation: TaskOperation, checkAccess: suspend () -> Unit): ResultExportManifest =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Result export is unavailable")
    suspend fun streamResultExport(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
        checkAccess: suspend () -> Unit, prefix: ResultExportPrefix?, sink: suspend (ByteArray) -> Unit): ResultExportReceipt =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Result export is unavailable")
    suspend fun uploadAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef, bytes: ByteArray): TargetFileAsset =
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Attachment upload is unavailable")
}

/** Implementations acquire/release a connection lease and bind a fixed repository. */
interface TargetTaskAccess {
    suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T
}

class RepositoryTaskTarget(private val boundInstanceId: String, private val repository: SessionRepository,
    private val uploader: FileAssetUploadClient? = null, private val exports: ResultExportClient? = null,
    private val messages: ScopedMessageClient? = null) : TaskTarget {
    private fun messageClient() = messages ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Conditional message client is unavailable")
    private fun scope(operation: TaskOperation): SessionScopeCondition {
        require(operation.targetInstanceId == boundInstanceId && operation.messageProtocolVersion == 1)
        return operation.originalScope?.validate() ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Original Session scope is missing")
    }
    override suspend fun requireMessageSupport() = conditionalCall { messageClient().requireSupport() }
    override suspend fun originalSessionScope(sessionId: String) = conditionalCall { messageClient().readScope(sessionId) }
    override suspend fun prepareMessage(operation: TaskOperation) = conditionalCall { messageClient().prepare(scope(operation), scopedMessageRequest(operation)) }
    override suspend fun findMessagePreparation(operation: TaskOperation) = conditionalCall { messageClient().findPreparation(scope(operation), scopedMessageRequest(operation)) }
    override suspend fun commitPreparedMessage(operation: TaskOperation) = conditionalCall { messageClient().commit(scope(operation), scopedMessageRequest(operation),
        operation.pcPreparationId ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "PC preparation identity is missing")) }
    override suspend fun findMessageCommit(operation: TaskOperation) = conditionalCall { messageClient().findCommit(scope(operation), scopedMessageRequest(operation),
        operation.pcPreparationId ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "PC preparation identity is missing")) }
    private suspend fun <T> conditionalCall(block: suspend () -> T): T = try { block() }
    catch (error: com.andysagent.ragent.core.network.ApiException) {
        val code = when {
            error.code == "CAPABILITY_UNSUPPORTED" || error.statusCode == 501 -> ApiErrorCode.CAPABILITY_UNSUPPORTED
            error.statusCode == 401 -> ApiErrorCode.AUTHENTICATION_REQUIRED
            error.statusCode == 403 -> ApiErrorCode.PERMISSION_DENIED
            error.statusCode == 404 -> ApiErrorCode.RESOURCE_NOT_FOUND
            error.statusCode == 409 -> ApiErrorCode.REVISION_CONFLICT
            error.statusCode == 410 -> ApiErrorCode.REQUEST_EXPIRED
            error.statusCode == 413 -> ApiErrorCode.RESOURCE_LIMIT
            error.statusCode == 429 -> ApiErrorCode.RATE_LIMITED
            else -> ApiErrorCode.RESULT_UNKNOWN
        }
        throw AppApiException(ApiError(code, "Conditional PC protocol call was not confirmed", error.retryable))
    } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled
    } catch (offline: java.io.IOException) {
        throw AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "Conditional PC response was not received", true))
    } catch (invalid: IllegalArgumentException) {
        apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Conditional PC protocol returned invalid facts")
    } catch (invalid: IllegalStateException) {
        apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Conditional PC protocol returned inconsistent facts")
    }
    override suspend fun uploadScopedAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef,
        bytes: ByteArray, onProgress: (com.andysagent.ragent.core.domain.FileUploadProgress) -> Unit,
        checkAccess: suspend () -> Unit): TargetFileAsset {
        val original = scope(operation)
        require(original.sessionId == sessionId)
        val client = uploader ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Stable upload is unavailable")
        return client.upload(sessionId, FileUploadInput(resourceUploadRequestId(operation, resource), resource.originalName,
            resource.mimeType, resource.sizeBytes, resource.sha256), bytes, original, onProgress, checkAccess)
    }
    override suspend fun sessionContext(sessionId: String): TaskSessionContext {
        val session = try { repository.readSessionAccessContext(sessionId) }
        catch (error: SessionRepositoryException) {
            if (error.statusCode == 501 && error.code == "SESSION_SCOPE_UNSUPPORTED")
                apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Authoritative Session context is unavailable")
            if (error.code == "SESSION_SCOPE_INVALID")
                apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Authoritative Session context is invalid")
            throw error
        } ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Session context is unavailable")
        if (session.sessionId != sessionId) apiFailure(ApiErrorCode.RESULT_UNKNOWN, "Session context identity differs")
        return TaskSessionContext(session.sessionId, session.projectId)
    }
    override suspend fun requireUploadSupport() {
        (uploader ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Stable upload is unavailable")).requireScopedSupport()
    }
    init {
        require(boundInstanceId.isNotBlank()) { "Target binding is required" }
        require(repository !is SwitchingSessionRepository) { "App API operations require a fixed target repository" }
        require(messages == null || messages.instanceId == boundInstanceId) { "Message client binding differs" }
    }
    override suspend fun createSession(operation: TaskOperation): String {
        require(operation.targetInstanceId == boundInstanceId) { "Operation target does not match the repository binding" }
        require(operation.messageProtocolVersion == 1)
        return repository.createSessionIdempotent(
            CreateSessionRequestDto(tool = operation.request.runtime.tool, name = operation.request.title.orEmpty(),
                projectId = operation.request.projectId, templateId = operation.request.agentId), operation.creationKey,
        ).session.id
    }

    override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt {
        require(operation.targetInstanceId == boundInstanceId) { "Operation target does not match the repository binding" }
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "App API messages require original preparation commit")
    }

    override suspend fun uploadAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef, bytes: ByteArray): TargetFileAsset {
        require(operation.targetInstanceId == boundInstanceId) { "Operation target does not match the repository binding" }
        apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "App API uploads require original Session scope")
    }

    override suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt? {
        require(operation.targetInstanceId == boundInstanceId) { "Operation target does not match the repository binding" }
        return repository.findMessageSubmissionReceipt(sessionId, operation.messageRequestId)
    }

    override suspend fun readResult(operation: TaskOperation): TaskResultSnapshot {
        require(operation.targetInstanceId == boundInstanceId) { "Operation target does not match the repository binding" }
        val sessionId = operation.sessionId ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Submission has no Session")
        return decodeTaskResult(operation, repository.loadMessageResult(sessionId, operation.messageRequestId))
    }

    override suspend fun readResultExport(operation: TaskOperation, checkAccess: suspend () -> Unit): ResultExportManifest {
        require(operation.targetInstanceId == boundInstanceId)
        return (exports ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Result export is unavailable")).readManifest(operation, checkAccess)
    }

    override suspend fun streamResultExport(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
        checkAccess: suspend () -> Unit, prefix: ResultExportPrefix?, sink: suspend (ByteArray) -> Unit): ResultExportReceipt {
        require(operation.targetInstanceId == boundInstanceId)
        return (exports ?: apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Result export is unavailable")).stream(operation, manifest, resourceId, checkAccess, prefix, sink)
    }
}

fun resourceUploadRequestId(operation: TaskOperation, resource: CaptureResourceRef): String = "appapi-upload-" +
    java.security.MessageDigest.getInstance("SHA-256").digest((operation.messageRequestId + ":" + resource.resourceId).toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

internal fun scopedMessageRequest(operation: TaskOperation): ScopedMessageRequest {
    val sessionId = operation.sessionId ?: apiFailure(ApiErrorCode.REVISION_CONFLICT, "Session identity is missing")
    requireCompleteUploads(operation, sessionId)
    return ScopedMessageRequest(operation.messageRequestId, renderTaskInput(operation.request), operation.uploads.map {
        PreparedMessageAsset(it.assetId, it.sha256, it.sizeBytes, "file".takeIf { _ -> it.renderAsFile })
    }, scopedMessageOptions(operation.request), ScopedMessageRequest.expiry(operation.deadlineAt)).validate()
}

internal fun scopedMessageOptions(request: TaskRequest) = buildJsonObject {
        val runtime = request.runtime
        put("tool", runtime.tool); put("serviceTier", runtime.serviceTier); put("interactionMode", runtime.interactionMode)
        runtime.providerProfile?.let { put("providerProfile", it) }; runtime.model?.let { put("model", it) }
        runtime.effort?.let { put("effort", it) }; request.agentId?.let { put("templateId", it) }
}

/** Source text never participates in target resolution, capability selection or authorization. */
fun renderTaskInput(request: TaskRequest): String = buildString {
    append(request.instruction)
    if (!request.sharedText.isNullOrBlank()) {
        append("\n\nSource material (reference content):\n")
        append(request.sharedText)
    }
    if (request.sourceUrls.isNotEmpty()) {
        append("\n\nSource URLs (page content has not been fetched):\n")
        append(request.sourceUrls.joinToString("\n"))
    }
}
