package com.andysagent.agentoc

import com.andysagent.agentoc.core.appapi.TargetConnectionResource
import com.andysagent.agentoc.core.appapi.ResultExportClient
import com.andysagent.agentoc.core.datastore.LinkedComputer
import com.andysagent.agentoc.core.domain.SessionRepository
import com.andysagent.agentoc.core.domain.FileAssetUploadClient
import com.andysagent.agentoc.core.domain.AttachmentRelayTransport
import com.andysagent.agentoc.core.domain.ScopedMessageClient
import com.andysagent.agentoc.core.domain.ScopedRunClient
import com.andysagent.agentoc.core.network.AgentoCTransport
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.withContext

internal fun interface TargetRuntimeFactory {
    fun create(target: LinkedComputer, databaseName: String, scope: CoroutineScope): TargetRuntime
}

/** The same resource is shared by UI and headless callers; none of its IDs can switch. */
internal class TargetRuntime(
    val instanceId: String,
    @Volatile var baseEndpoint: String,
    @Volatile var endpoint: String,
    val transport: AgentoCTransport,
    val sessions: SessionRepository,
    val controller: TargetConnectionController,
    private val scope: CoroutineScope,
    private val relay: AttachmentRelayTransport? = null,
    private val disposeStorage: () -> Unit = {},
) : TargetConnectionResource {
    internal fun ownsJob(candidate: Job?): Boolean = isWithinJobTree(scope.coroutineContext[Job], candidate)

    val assets = FileAssetUploadClient(instanceId, transport, relay)
    val messages = ScopedMessageClient(instanceId, transport)
    val runs = ScopedRunClient(instanceId, transport)
    val exports = ResultExportClient(instanceId, transport)
    override fun start() = controller.start()
    override suspend fun stop() = withContext(NonCancellable) {
        try { controller.stop() } finally { sessions.stopLiveSync(); transport.close() }
    }
    suspend fun dispose() = withContext(NonCancellable) {
        scope.coroutineContext[Job]?.cancelAndJoin()
        sessions.close()
        disposeStorage()
    }
}

internal fun isWithinJobTree(root: Job?, candidate: Job?): Boolean {
    if (root == null || candidate == null) return false
    return root === candidate || root.children.any { isWithinJobTree(it, candidate) }
}
