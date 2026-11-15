package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** One app-scoped importer. Allocations live in the draft before any source is consumed. */
class DraftResourceImports(private val drafts: CaptureDraftStore, private val resources: PersistentCaptureResources,
    private val now: () -> Long = System::currentTimeMillis) {
    private val locks = Array(64) { Mutex() }

    suspend fun restore(draftId: String, caller: VerifiedCaller): CaptureDraft =
        consume(draftId, caller, source = null)

    /** The source callback is transient and trusted; restoration never calls it. */
    suspend fun consume(draftId: String, caller: VerifiedCaller,
        source: (suspend (resourceId: String, maxBytes: Long) -> CaptureResource)?,
        onUpdated: (CaptureDraft) -> Unit = {}): CaptureDraft = locks[(draftId.hashCode() and Int.MAX_VALUE) % locks.size].withLock {
        var draft = drafts.get(draftId, caller) ?: apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Draft not found")
        if (draft.operationId != null || draft.input.imports.isEmpty()) return@withLock draft
        try {
            for (slot in draft.input.imports.toList()) {
                currentCoroutineContext().ensureActive()
                val current = draft.input.imports.firstOrNull { it.resourceId == slot.resourceId } ?: continue
                var resource = resources.get(slot.resourceId, caller)
                val budget = minOf(PersistentCaptureResources.MAX_BYTES, MAX_BATCH_BYTES - draft.input.resources.sumOf { it.sizeBytes })
                var failure: ApiErrorCode? = null
                try {
                    if (budget <= 0) apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Shared files exceed the batch limit")
                    resource = when {
                        resource == null && source != null && current.error == null -> source(slot.resourceId, budget)
                        resource?.state == CaptureResourceState.IMPORTING -> resources.recover(slot.resourceId, caller)
                        else -> resource
                    }
                    if (resource?.state != CaptureResourceState.READY) {
                        apiFailure(resource?.error ?: current.error ?: ApiErrorCode.RESOURCE_NOT_FOUND, "Shared file was not fully saved")
                    }
                    if (resource.resourceId != slot.resourceId || resource.callerBinding != caller.binding || resource.sizeBytes!! > budget) {
                        apiFailure(ApiErrorCode.INVALID_ARGUMENT, "Shared file differs from its draft allocation")
                    }
                    resources.validate(listOf(resource.reference()), caller)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    failure = (error as? AppApiException)?.error?.code ?: ApiErrorCode.RESOURCE_NOT_FOUND
                    resource = resources.get(slot.resourceId, caller) ?: resource
                }
                val input = if (failure == null) draft.input.copy(resources = draft.input.resources + resource!!.reference(),
                    imports = draft.input.imports.filterNot { it.resourceId == slot.resourceId })
                else draft.input.copy(imports = draft.input.imports.map { if (it.resourceId == slot.resourceId)
                    it.copy(name = resource?.originalName ?: it.name, error = failure) else it })
                draft = save(draft, input, caller)
                onUpdated(draft)
            }
            draft
        } catch (cancelled: CancellationException) {
            // Preserve copied files and explicitly fail slots not yet linked. No new URI read.
            withContext(NonCancellable) {
                val current = drafts.get(draftId, caller)
                if (current != null && current.operationId == null && current.input.imports.isNotEmpty()) {
                    draft = save(current, current.input.copy(imports = current.input.imports.map {
                        it.copy(error = it.error ?: ApiErrorCode.CANCELLED)
                    }), caller)
                    onUpdated(draft)
                }
            }
            throw cancelled
        }
    }

    private suspend fun save(previous: CaptureDraft, input: CaptureInput, caller: VerifiedCaller): CaptureDraft {
        if (input == previous.input) return previous
        val next = previous.copy(input = input, revision = previous.revision + 1, updatedAt = maxOf(now(), previous.updatedAt))
        if (!drafts.replace(next, caller, previous.revision)) apiFailure(ApiErrorCode.REVISION_CONFLICT, "Shared draft changed during import")
        return next
    }
    companion object { const val MAX_BATCH_BYTES = 100L * 1024 * 1024 }
}
