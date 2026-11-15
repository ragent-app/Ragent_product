package com.andysagent.ragent.core.appapi

import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class AssistantComputer(val delegationId: String, val instanceId: String, val label: String)
@Serializable
data class AssistantComputerPage(val items: List<AssistantComputer>, val nextCursor: String?, val observedAt: Long)
@Serializable
data class AssistantPreparedTask(val delegationId: String, val operationId: String, val preparationId: String,
    val targetInstanceId: String, val deadlineAt: Long, val stage: String)
@Serializable
data class AssistantTaskStatus(val delegationId: String, val operationId: String, val targetInstanceId: String,
    val submissionStage: String, val sessionId: String?, val runId: String?, val queued: Boolean,
    val revision: Long, val errorCode: String?, val retryable: Boolean)
@Serializable
data class AssistantArtifact(val assetId: String, val name: String, val mimeType: String, val sizeBytes: Long?)
@Serializable
data class AssistantTaskResult(val submission: AssistantTaskStatus, val resultState: String?, val text: String?,
    val textTruncated: Boolean, val finalRunId: String?, val artifacts: List<AssistantArtifact>,
    val hasAttachments: Boolean, val observedAt: String?, val cached: Boolean)

/** Typed adapter to the real coordinator. Platform admission is the entry point's responsibility.
 * There is deliberately no owner fallback, grant creation, implicit retry or alias/default routing.
 */
class AssistantTaskBridge(private val delegations: AssistantDelegationAccess, private val tasks: TaskCoordinator,
    private val now: () -> Long = System::currentTimeMillis) {
    suspend fun listComputers(limit: Int = 16, cursor: String? = null): AssistantComputerPage {
        if (limit !in 1..32 || (cursor != null && !Regex("[a-f0-9]{64}:[0-9]{1,5}").matches(cursor)))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Invalid assistant computer page")
        val output = mutableListOf<AssistantComputer>()
        for (delegation in delegations.activeDelegations()) {
            if (CapabilityRegistry.TARGETS_LIST !in delegation.scope.capabilityIds) continue
            val targets = tasks.listTargets(delegation.caller)
            delegations.requireActive(delegation.id)
            output += targets.map {
                val label = it.name.take(128).let { value -> if (value.lastOrNull()?.isHighSurrogate() == true) value.dropLast(1) else value }
                AssistantComputer(delegation.id, it.instanceId, label)
            }
        }
        // Recheck every delivered reference after all suspendable directory/policy work.
        output.map { it.delegationId }.distinct().forEach { delegations.requireActive(it) }
        val sorted = output.sortedWith(compareBy({ it.delegationId }, { it.instanceId }))
        val hash = MessageDigest.getInstance("SHA-256").digest(AppApiJson.encodeToString(sorted).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        if (cursor != null && cursor.substringBefore(':') != hash)
            apiFailure(ApiErrorCode.REVISION_CONFLICT, "Assistant computer grants or directory changed; query the first page")
        val offset = cursor?.substringAfter(':')?.toInt() ?: 0
        if (offset > sorted.size) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Assistant computer cursor exceeds the directory")
        val items = sorted.drop(offset).take(limit)
        val next = offset + items.size
        return AssistantComputerPage(items, if (next < sorted.size) "$hash:$next" else null, now())
    }
    suspend fun prepare(delegationId: String, request: TaskRequest): AssistantPreparedTask {
        val delegation = delegations.requireActive(delegationId)
        if (request.targetInstanceId.isNullOrBlank() || request.targetAlias != null || request.allowDeferredSubmission)
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Assistant preparation requires an explicit computer and immediate submission policy")
        val requestId = request.operationId
        if (requestId.isBlank() || requestId.length > 128 || requestId.any(Char::isISOControl) ||
            !Charsets.UTF_8.newEncoder().canEncode(requestId))
            apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Assistant request identity is invalid")
        val material = "${delegation.id.length}:${delegation.id}${requestId.length}:$requestId"
        val id = "appfunctions-" + MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        val prepared = tasks.prepare(request.copy(operationId = id), delegation.caller)
        tasks.checkPreparedDelivery(prepared, delegation.caller)
        delegations.requireActive(delegationId)
        return AssistantPreparedTask(delegationId, prepared.operationId, prepared.preparationId,
            prepared.targetInstanceId, prepared.deadlineAt, prepared.stage.name)
    }
    suspend fun commit(delegationId: String, preparationId: String): AssistantTaskStatus {
        val delegation = delegations.requireActive(delegationId)
        val operation = tasks.commit(preparationId, delegation.caller)
        tasks.checkDelivery(operation, delegation.caller, CapabilityRegistry.TASKS_COMMIT)
        delegations.requireActive(delegationId)
        return operation.project(delegationId)
    }
    suspend fun get(delegationId: String, operationId: String): AssistantTaskStatus {
        val delegation = delegations.requireActive(delegationId)
        val operation = tasks.get(operationId, delegation.caller)
        tasks.checkDelivery(operation, delegation.caller, CapabilityRegistry.TASKS_GET)
        delegations.requireActive(delegationId)
        return operation.project(delegationId)
    }
    suspend fun reconcile(delegationId: String, operationId: String): AssistantTaskStatus {
        val delegation = delegations.requireActive(delegationId)
        val operation = tasks.reconcile(operationId, delegation.caller)
        tasks.checkDelivery(operation, delegation.caller, CapabilityRegistry.TASKS_RECONCILE)
        delegations.requireActive(delegationId)
        return operation.project(delegationId)
    }
    suspend fun cancelSubmission(delegationId: String, operationId: String): AssistantTaskStatus {
        val delegation = delegations.requireActive(delegationId)
        val operation = tasks.cancelSubmission(operationId, delegation.caller)
        tasks.checkDelivery(operation, delegation.caller, CapabilityRegistry.TASKS_CANCEL)
        delegations.requireActive(delegationId)
        return operation.project(delegationId)
    }
    suspend fun readResult(delegationId: String, operationId: String): AssistantTaskResult {
        val delegation = delegations.requireActive(delegationId)
        val operation = tasks.readResult(operationId, delegation.caller)
        tasks.checkDelivery(operation, delegation.caller, CapabilityRegistry.TASKS_RESULT)
        delegations.requireActive(delegationId)
        val result = operation.result
        return AssistantTaskResult(operation.project(delegationId), result?.state?.name, result?.text,
            result?.textTruncated ?: false, result?.finalRunId,
            result?.artifacts.orEmpty().map { AssistantArtifact(it.assetId, it.originalName, it.mimeType, it.sizeBytes) },
            result?.hasAttachments ?: false, result?.observedAt, result != null && operation.lastError != null)
    }
    private fun TaskOperation.project(delegationId: String) = AssistantTaskStatus(delegationId, operationId,
        targetInstanceId, stage.name, sessionId, runId, queued, revision, lastError?.code?.name, lastError?.retryable ?: false)
}
