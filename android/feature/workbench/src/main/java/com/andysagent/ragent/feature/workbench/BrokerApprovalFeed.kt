package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.model.Approval
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.runningFold
import java.time.Instant

/** Refreshes only the selected computer, discarding reads canceled by a target switch. */
@OptIn(ExperimentalCoroutinesApi::class)
fun observeBrokerApprovalFeed(
    targetIds: Flow<String?>,
    refreshSignals: (String) -> Flow<Unit>,
    fetch: suspend (String) -> List<Approval>,
    onFailure: (String, Exception) -> Unit = { _, _ -> },
    retainOnFailure: (Exception) -> Boolean = { true },
): Flow<List<Approval>> = targetIds.distinctUntilChanged().flatMapLatest { targetId ->
    if (targetId == null) flowOf(emptyList()) else {
        merge(flowOf(Unit), refreshSignals(targetId))
            // Coalesce bursts without canceling an in-flight signed GET on every poll tick.
            .conflate()
            .map {
                try { fetch(targetId) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    onFailure(targetId, failure)
                    if (retainOnFailure(failure)) null else emptyList()
                }
            }
            .runningFold(emptyList<Approval>()) { previous, fetched ->
                fetched ?: previous.filter { approval ->
                    runCatching { approval.expiresAt?.let { Instant.parse(it).isAfter(Instant.now()) } == true }
                        .getOrDefault(false)
                }
            }
    }
}

/** A short foreground reconciliation interval covers carriers that cannot receive Owner WebSocket hints. */
fun brokerApprovalReconciliationSignals(
    intervalMs: () -> Long,
    shouldRefresh: () -> Boolean,
): Flow<Unit> = flow {
    while (true) {
        delay(intervalMs())
        if (shouldRefresh()) emit(Unit)
    }
}

/** Keeps a server-specified 429 delay intact across periodic and event refresh signals. */
class BrokerApprovalRetryGate(
    private val elapsedMs: () -> Long,
    private val sleepMs: suspend (Long) -> Unit = { delay(it) },
) {
    private val retryAtMs = mutableMapOf<String, Long>()

    @Synchronized
    fun defer(targetId: String, retryAfterMs: Long) {
        val now = elapsedMs()
        val wait = retryAfterMs.coerceAtLeast(0)
        val deadline = if (wait > Long.MAX_VALUE - now) Long.MAX_VALUE else now + wait
        retryAtMs[targetId] = maxOf(retryAtMs[targetId] ?: 0L, deadline)
    }

    suspend fun await(targetId: String) {
        while (true) {
            val remaining = synchronized(this) { (retryAtMs[targetId] ?: 0L) - elapsedMs() }
            if (remaining <= 0) return
            sleepMs(remaining)
        }
    }
}
