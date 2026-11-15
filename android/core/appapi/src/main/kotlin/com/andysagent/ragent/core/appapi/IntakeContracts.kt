package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Versioned PC routing protocol. File metadata is advisory; resources stay in the local task journal. */
val IntakeJson = Json { encodeDefaults = true; ignoreUnknownKeys = true }

/** A target must explicitly advertise both routing and idempotent project creation. */
@Serializable
data class IntakeCapabilities(
    val protocolVersion: Int,
    val projectRouting: Boolean,
    val projectCreation: Boolean,
) {
    val supportsSmartShare: Boolean get() = protocolVersion == 1 && projectRouting && projectCreation
}

@Serializable
data class IntakeFile(val name: String, val mimeType: String, val size: Long)

@Serializable
data class IntakeInput(
    val intakeId: String,
    val targetInstanceId: String,
    val userRequirement: String,
    val sharedText: String,
    val title: String? = null,
    val sourceUrls: List<String> = emptyList(),
    val files: List<IntakeFile> = emptyList(),
)

@Serializable
data class IntakePrepareRequest(val input: IntakeInput, val runtime: TaskRuntime)

@Serializable
data class IntakeProject(val name: String, val purpose: String, val projectType: String)

@Serializable
data class IntakeDecision(
    val schemaVersion: Int,
    val intakeId: String,
    val decisionId: String,
    val inputDigest: String,
    val targetInstanceId: String,
    val decision: String,
    val indexRevision: String? = null,
    val projectId: String? = null,
    val projectRevision: Long? = null,
    val sessionAction: String? = null,
    val existingSessionId: String? = null,
    val materialRole: String? = null,
    val taskBrief: String? = null,
    val reason: String? = null,
    val question: String? = null,
    val newProject: IntakeProject? = null,
    val contextComplete: Boolean = false,
    val requiresClarification: Boolean = false,
    val evidenceRefs: List<String> = emptyList(),
)

@Serializable
data class IntakeEnsureRequest(val operationId: String, val decisionId: String, val input: IntakeInput)

@Serializable
data class IntakeProjectReceipt(
    val operationId: String,
    val decisionId: String,
    val inputDigest: String,
    val targetInstanceId: String,
    val projectId: String? = null,
    val stage: String,
)

fun CaptureDraft.intakeInput(): IntakeInput {
    val id = intakeId ?: throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Intake identity is missing"))
    val target = targetInstanceId ?: throw AppApiException(ApiError(ApiErrorCode.TARGET_NOT_FOUND, "Choose a computer"))
    return IntakeInput(id, target, instruction, input.sharedText, input.title, input.sourceUrls,
        input.resources.map { IntakeFile(it.originalName, it.mimeType, it.sizeBytes) })
}
