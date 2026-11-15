package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.*
import java.util.UUID

/** Test double for existing coordinator scenarios. Wire protocol has separate client tests. */
abstract class ScopedFixtureTaskTarget : TaskTarget {
    var scopeRevision = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    var losePreparationReply = false
    var preparationWrites = 0
    var preparationLookups = 0
    private val preparations = mutableMapOf<String, ScopedMessagePreparation>()
    override suspend fun requireMessageSupport() {}
    override suspend fun sessionContext(sessionId: String) = TaskSessionContext(sessionId, null)
    override suspend fun originalSessionScope(sessionId: String): SessionScopeCondition {
        val context = sessionContext(sessionId)
        return SessionScopeCondition(context.sessionId, scopeRevision, context.projectId)
    }
    override suspend fun prepareMessage(operation: TaskOperation): ScopedMessagePreparation {
        scopedMessageRequest(operation)
        preparationWrites++
        val result = preparations.getOrPut(operation.messageRequestId) {
            ScopedMessagePreparation(1, operation.sessionId!!, operation.messageRequestId,
                "mprep_${UUID.nameUUIDFromBytes(operation.messageRequestId.toByteArray())}", "prepared", false,
                ScopedMessageRequest.expiry(operation.createdAt), ScopedMessageRequest.expiry(operation.deadlineAt), false, false)
        }
        if (losePreparationReply) { losePreparationReply = false; throw java.io.IOException("PC preparation reply lost") }
        return result
    }
    override suspend fun findMessagePreparation(operation: TaskOperation): ScopedMessagePreparation? {
        preparationLookups++
        return preparations[operation.messageRequestId]
    }
    override suspend fun commitPreparedMessage(operation: TaskOperation) = receipt(operation, submitMessage(operation, operation.sessionId!!))
    override suspend fun findMessageCommit(operation: TaskOperation) = findReceipt(operation, operation.sessionId!!)?.let { receipt(operation, it) }
    private fun receipt(operation: TaskOperation, receipt: MessageSubmissionReceipt) = ScopedMessageCommitReceipt(
        1, receipt.sessionId, receipt.requestId, operation.pcPreparationId!!,
        "run_appapi_" + UUID.nameUUIDFromBytes(operation.messageRequestId.toByteArray()).toString().replace("-", ""),
        if (receipt.queued) "queued" else "accepted", true, receipt.queued, receipt.duplicate,
        ScopedMessageRequest.expiry(operation.deadlineAt), ScopedMessageRequest.expiry(operation.createdAt),
        ScopedMessageRequest.expiry(operation.createdAt), null, false, null,
    )
    override suspend fun uploadScopedAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef,
        bytes: ByteArray, onProgress: (com.andysagent.ragent.core.domain.FileUploadProgress) -> Unit,
        checkAccess: suspend () -> Unit): TargetFileAsset {
        checkAccess()
        return uploadAttachment(operation, sessionId, resource, bytes).copy(scopeContractVersion = 1).also { checkAccess() }
    }
}
