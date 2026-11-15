package com.andysagent.ragent.core.appapi

import kotlinx.serialization.Serializable

@Serializable
enum class CaptureSource { SHARE, PROCESS_TEXT, SDK, APP_FUNCTION, USER }

/** Origin material is never treated as an instruction, target or permission. */
@Serializable
data class CaptureInput(
    val sharedText: String = "",
    val sourceUrls: List<String> = emptyList(),
    val title: String? = null,
    val source: CaptureSource = CaptureSource.USER,
    val resources: List<CaptureResourceRef> = emptyList(),
    val imports: List<CaptureImportSlot> = emptyList(),
    // Provenance only. A persisted value never grants an Activity Result return channel.
    val selectionReadOnly: Boolean? = null,
)

/** Private draft allocation. No source URI is persisted or exposed as a resource. */
@Serializable
data class CaptureImportSlot(val resourceId: String, val name: String? = null, val error: ApiErrorCode? = null)

/** Phone-owned record, not an exported DTO. Caller binding comes only from a trusted adapter. */
@Serializable
data class CaptureDraft(
    val draftId: String,
    val callerBinding: String,
    val createdAt: Long,
    val updatedAt: Long = createdAt,
    val revision: Long = 0,
    val input: CaptureInput,
    val instruction: String = "",
    val targetInstanceId: String? = null,
    val runtime: TaskRuntime? = null,
    val existingSessionId: String? = null,
    val projectId: String? = null,
    val agentId: String? = null,
    val operationId: String? = null,
    val preparationId: String? = null,
    val schemaVersion: Int = 1,
    val requireTargetSelection: Boolean = false,
    val intakeId: String? = null,
    val intakeDecision: IntakeDecision? = null,
    val projectCreationOperationId: String? = null,
) {
    fun freezeForSubmission(now: Long): CaptureDraft {
        if (operationId != null) return this
        if (input.imports.isNotEmpty()) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Resolve or remove incomplete shared files before submitting")
        val frozen = copy(operationId = "capture_$draftId", revision = revision + 1, updatedAt = maxOf(now, updatedAt),
            input = input.copy(sourceUrls = input.sourceUrls.toList(), resources = input.resources.toList()))
        validateTaskRequest(frozen.toTaskRequest())
        return frozen
    }

    fun bindPreparation(prepared: PreparedTask, now: Long): CaptureDraft {
        if (operationId == null || prepared.operationId != operationId || prepared.targetInstanceId != targetInstanceId) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Preparation does not match the frozen draft")
        }
        if (preparationId == prepared.preparationId) return this
        if (preparationId != null) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Draft already has a preparation")
        return copy(preparationId = prepared.preparationId, updatedAt = maxOf(now, updatedAt), revision = revision + 1)
    }

    fun toTaskRequest(): TaskRequest {
        val operation = operationId ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Draft has not been frozen")
        val target = targetInstanceId ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Choose a computer")
        val selection = runtime ?: apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Choose a runtime")
        return TaskRequest(operation, instruction, selection, targetInstanceId = target,
            existingSessionId = existingSessionId, projectId = projectId, agentId = agentId,
            title = input.title, sharedText = input.sharedText, sourceUrls = input.sourceUrls.toList(), resources = input.resources.toList())
    }
}

/** Parsing does not fetch pages, select a PC, grant rights, or start work. */
fun captureSharedText(text: CharSequence?, title: CharSequence? = null): CaptureInput {
    if (text == null || text.isBlank() || text.length > 48 * 1024 || (title?.length ?: 0) > 512) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Shared text is empty or exceeds limits")
    }
    val original = text.toString()
    if (original.toByteArray(Charsets.UTF_8).size > 48 * 1024) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Shared text exceeds the byte limit")
    val urls = Regex("https?://[^\\s<>\"“”]+", RegexOption.IGNORE_CASE).findAll(original).mapNotNull { match ->
        var candidate = match.value.trimEnd('.', ',', ';', '!', '?', '。', '，', '；', '！', '？', '\'')
        for ((open, close) in listOf('(' to ')', '[' to ']', '{' to '}')) {
            while (candidate.endsWith(close) && candidate.count { it == close } > candidate.count { it == open }) candidate = candidate.dropLast(1)
        }
        candidate = candidate.substringBefore(':').lowercase(java.util.Locale.ROOT) + candidate.substring(candidate.indexOf(':'))
        candidate.takeIf(::isCaptureSourceUrl)
    }.distinct().toList()
    if (urls.size > 16) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Too many shared URLs")
    return CaptureInput(original, urls, title?.toString(), CaptureSource.SHARE)
}

internal fun validateCaptureDraft(draft: CaptureDraft) {
    if (draft.input.selectionReadOnly != null && draft.input.source != CaptureSource.PROCESS_TEXT) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Selection metadata requires selected-text input")
    }
    validateResourceRefs(draft.input.resources)
    val imports = draft.input.imports
    val identities = draft.input.resources.map { it.resourceId } + imports.map { it.resourceId }
    if (identities.size > 16 || identities.distinct().size != identities.size || imports.any {
            !Regex("[A-Za-z0-9_-]{1,64}").matches(it.resourceId) || (it.name?.length ?: 0) > 255
            || it.name?.any { c -> c in "\u0000\r\n" } == true }) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid shared file allocations")
    }
    if (draft.schemaVersion != 1) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unsupported capture draft version")
    if (draft.intakeId != null && !Regex("[A-Za-z0-9_-]{1,160}").matches(draft.intakeId)) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid intake identity")
    }
    if (draft.projectCreationOperationId != null &&
        !Regex("[A-Za-z0-9_-]{1,160}").matches(draft.projectCreationOperationId)) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid Project creation identity")
    }
    draft.intakeDecision?.let { decision ->
        if (decision.schemaVersion != 1 || decision.intakeId != draft.intakeId ||
            decision.targetInstanceId != draft.targetInstanceId || decision.decisionId.isBlank() ||
            !Regex("[a-f0-9]{64}").matches(decision.inputDigest)) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Intake decision does not match this draft")
        }
        if (draft.projectId != null && decision.decision == "use_existing" && draft.projectId != decision.projectId) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Project differs from the intake decision")
        }
    }
    if (!Regex("[A-Za-z0-9_-]{1,64}").matches(draft.draftId) || draft.callerBinding.isBlank() || draft.callerBinding.length > 512
        || draft.createdAt < 0 || draft.updatedAt < draft.createdAt || draft.revision < 0) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid draft identity or revision")
    }
    if ((draft.input.title?.length ?: 0) > 512 || draft.input.sourceUrls.size > 16 || draft.input.sourceUrls.any { !isCaptureSourceUrl(it) }
        || draft.input.sharedText.toByteArray(Charsets.UTF_8).size > 48 * 1024 || draft.instruction.toByteArray(Charsets.UTF_8).size > 48 * 1024) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Draft input exceeds limits")
    }
    if (listOf(draft.targetInstanceId, draft.existingSessionId, draft.projectId, draft.agentId,
            draft.runtime?.providerProfile, draft.runtime?.model, draft.runtime?.effort).any { it != null && (it.isBlank() || it.length > 256) }
        || draft.runtime?.let { it.tool.isBlank() || it.tool.length > 128 || it.interactionMode !in setOf("agent", "plan")
            || it.serviceTier !in setOf("standard", "fast") } == true) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid draft resource or runtime selection")
    }
    if (draft.operationId != null) {
        if (draft.intakeDecision?.decision in setOf("use_existing", "create_new") && draft.projectId.isNullOrBlank()) {
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Routed task requires a Project identity")
        }
        if (imports.isNotEmpty()) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Frozen draft cannot contain incomplete files")
        if (draft.operationId != "capture_${draft.draftId}") apiFailure(ApiErrorCode.REVISION_CONFLICT, "Draft operation identity cannot be replaced")
        validateTaskRequest(draft.toTaskRequest())
    } else if (draft.preparationId != null) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Preparation requires a frozen draft")
    if (draft.preparationId != null && (draft.preparationId.isBlank() || draft.preparationId.length > 256)) {
        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid preparation identity")
    }
}
