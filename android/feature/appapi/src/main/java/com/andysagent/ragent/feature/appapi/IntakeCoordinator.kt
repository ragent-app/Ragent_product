package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.appapi.*

/** Coordinates routing before TaskCoordinator receives an immutable TaskRequest. */
internal class IntakeCoordinator(private val port: CaptureWorkflowPort) {
    suspend fun prepare(draft: CaptureDraft): IntakeDecision {
        val input = draft.intakeInput()
        val runtime = draft.runtime ?: throw AppApiException(ApiError(ApiErrorCode.INVALID_ARGUMENT, "Choose a runtime"))
        val decision = port.prepareIntake(input, runtime)
        if (decision.schemaVersion != 1 || decision.intakeId != input.intakeId ||
            decision.targetInstanceId != input.targetInstanceId || decision.decisionId.isBlank() ||
            !Regex("[a-f0-9]{64}").matches(decision.inputDigest) ||
            decision.decision !in setOf("use_existing", "create_new", "wait_context", "needs_clarification")) {
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Computer returned an invalid intake decision"))
        }
        if (decision.decision in setOf("use_existing", "create_new") && !decision.contextComplete) {
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Project context is incomplete"))
        }
        return decision
    }

    suspend fun ensure(draft: CaptureDraft): IntakeProjectReceipt {
        val decision = draft.intakeDecision ?: throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Intake decision is missing"))
        val operationId = draft.projectCreationOperationId
            ?: throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Project creation identity is missing"))
        if (decision.decision != "create_new") {
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Intake does not require a new Project"))
        }
        val receipt = port.ensureIntakeProject(IntakeEnsureRequest(operationId, decision.decisionId, draft.intakeInput()))
        if (receipt.operationId != operationId || receipt.decisionId != decision.decisionId ||
            receipt.inputDigest != decision.inputDigest || receipt.targetInstanceId != draft.targetInstanceId ||
            receipt.stage != "completed" || receipt.projectId.isNullOrBlank()) {
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Project creation receipt is incomplete"))
        }
        return receipt
    }
}
