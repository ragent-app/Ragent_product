package com.andysagent.ragent.core.appapi

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Sanitized local receipt. No source identity, filesystem path, URI or credential leaves maintenance. */
data class ResultMaintenanceReceipt(
    val recoveredSaves: Int = 0,
    val removedHistory: Int = 0,
    val removedDeliveries: Int = 0,
    val removedOrphans: Int = 0,
    val removedTemporary: Int = 0,
    val deferred: Int = 0,
    val failures: List<ApiErrorCode> = emptyList(),
) {
    val needsRetry: Boolean get() = deferred > 0 || failures.isNotEmpty()
}

/** Internal storage policy; never dispatches, reads a target or reopens an external document. */
class ResultMaintenanceCoordinator(
    private val outputs: PersistentResultOutputs,
    private val deliveries: ResultDeliveryCache,
    private val documentSaves: DocumentSaveJournal,
    private val now: () -> Long = System::currentTimeMillis,
) {
    suspend fun run(revokeGrant: suspend (ResultDeliveryRef) -> Unit): ResultMaintenanceReceipt {
        var result = ResultMaintenanceReceipt()
        val before = now() - 24L * 60 * 60 * 1000
        suspend fun phase(block: suspend () -> Unit) {
            currentCoroutineContext().ensureActive()
            try { block() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                val code = (failure as? AppApiException)?.error?.code ?: ApiErrorCode.INTERNAL_ERROR
                result = result.copy(failures = result.failures + code)
            }
        }
        phase {
            val journal = documentSaves.maintain(before)
            result = result.copy(recoveredSaves = journal.recovered, removedHistory = journal.removed,
                removedTemporary = journal.temporary, deferred = journal.deferred)
        }
        phase {
            val removed = deliveries.cleanupExpired(revokeGrant) { result = result.copy(deferred = result.deferred + 1) }
            result = result.copy(removedDeliveries = removed.size)
        }
        phase {
            val removed = outputs.cleanupOrphans(before) { result = result.copy(deferred = result.deferred + 1) }
            result = result.copy(removedOrphans = removed)
        }
        phase {
            val removed = deliveries.cleanupUnpublished(before) { result = result.copy(deferred = result.deferred + 1) }
            result = result.copy(removedTemporary = result.removedTemporary + removed)
        }
        currentCoroutineContext().ensureActive()
        return result
    }
}
