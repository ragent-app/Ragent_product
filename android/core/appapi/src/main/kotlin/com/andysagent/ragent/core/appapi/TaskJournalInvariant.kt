package com.andysagent.ragent.core.appapi

internal fun TaskOperation.validateMessageJournal(): TaskOperation = apply {
    require(messageProtocolVersion in 0..1)
    if (messageProtocolVersion == 0) {
        require(originalScope == null && pcPreparationId == null && commitReceipt == null)
        return@apply
    }
    originalScope?.validate()?.let { require(it.sessionId == sessionId) }
    require(uploads.all { it.scopeContractVersion == 1 })
    if (pcPreparationId != null) {
        require(originalScope != null && Regex("mprep_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").matches(pcPreparationId))
    }
    if (stage in setOf(OperationStage.MESSAGE_PREPARING, OperationStage.SUBMITTING, OperationStage.ACCEPTED)) require(originalScope != null)
    if (stage in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) require(pcPreparationId != null)
    if (stage == OperationStage.ACCEPTED) require(commitReceipt?.accepted == true && runId != null)
    commitReceipt?.let {
        require(it.version == 1 && it.sessionId == sessionId && it.requestId == messageRequestId &&
            it.preparationId == pcPreparationId && it.runId == runId && it.accepted &&
            it.expiresAt == com.andysagent.ragent.core.domain.ScopedMessageRequest.expiry(deadlineAt))
    }
}

/** Checks live in both coordinator and Room; a second process cannot replace immutable facts. */
internal fun validateTaskTransition(previous: TaskOperation, next: TaskOperation) {
    previous.validateMessageJournal(); next.validateMessageJournal()
    require(previous.operationId == next.operationId && previous.callerBinding == next.callerBinding &&
        previous.originalFingerprint == next.originalFingerprint && previous.preparationId == next.preparationId &&
        previous.targetInstanceId == next.targetInstanceId && previous.request == next.request &&
        previous.creationKey == next.creationKey && previous.messageRequestId == next.messageRequestId &&
        previous.createdAt == next.createdAt && previous.deadlineAt == next.deadlineAt &&
        previous.messageProtocolVersion == next.messageProtocolVersion)
    require(previous.sessionId == null || previous.sessionId == next.sessionId)
    require(previous.originalScope == null || previous.originalScope == next.originalScope)
    require(previous.pcPreparationId == null || previous.pcPreparationId == next.pcPreparationId)
    require(previous.runId == null || previous.runId == next.runId)
    require(next.uploads.take(previous.uploads.size) == previous.uploads)
    if (previous.stage in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED))
        require(previous.stage == next.stage)
    if (previous.commitReceipt != null) require(next.commitReceipt != null && next.commitReceipt.runId == previous.commitReceipt.runId)
}
