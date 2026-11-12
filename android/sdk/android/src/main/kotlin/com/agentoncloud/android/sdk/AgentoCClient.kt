package com.agentoncloud.android.sdk

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.agentoncloud.android.api.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

class AgentoCApiException(val error: PublicError) : RuntimeException(error.message)

/** Explicit binding, typed async calls and bounded operation snapshot watches. No automatic mutation replay. */
class AgentoCClient(context: Context) : Closeable {
    private val context = context.applicationContext
    private val mutex = Mutex()
    private val bindingGuard = Any()
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val pending = ConcurrentHashMap<String, CompletableDeferred<PublicResponse>>()
    private val streams = ConcurrentHashMap<String, (Throwable) -> Unit>()
    @Volatile private var closed = false
    @Volatile private var connection: Connection? = null
    private fun disconnected() = AgentoCApiException(PublicError("RESULT_UNKNOWN", "Service disconnected; reconnect and query the original operation", true))
    private fun failPending(failure: Throwable) {
        pending.values.forEach { it.completeExceptionally(failure) }
        streams.values.forEach { it(failure) }
    }
    private inner class Connection : ServiceConnection {
        val ready = CompletableDeferred<IAppApiService>()
        var bound = false
        var binder: IBinder? = null
        @Volatile var alive = false
        val death = IBinder.DeathRecipient {
            alive = false
            if (connection === this) { ready.completeExceptionally(disconnected()); failPending(disconnected()) }
        }
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            synchronized(bindingGuard) {
                if (closed || connection !== this) return
                if (name != ComponentName(AppApiWire.PACKAGE, AppApiWire.SERVICE)) {
                    ready.completeExceptionally(AgentoCApiException(PublicError("PERMISSION_DENIED", "Unexpected service component"))); return
                }
                binder = service
                try { service.linkToDeath(death, 0); alive = true; ready.complete(IAppApiService.Stub.asInterface(service)) }
                catch (failure: android.os.RemoteException) { ready.completeExceptionally(disconnected()) }
            }
        }
        override fun onServiceDisconnected(name: ComponentName) { alive = false; if (connection === this) { ready.completeExceptionally(disconnected()); failPending(disconnected()) } }
        override fun onBindingDied(name: ComponentName) { alive = false; if (connection === this) { ready.completeExceptionally(disconnected()); failPending(disconnected()) } }
        override fun onNullBinding(name: ComponentName) { ready.completeExceptionally(AgentoCApiException(PublicError("CAPABILITY_UNSUPPORTED", "App API service is unavailable"))) }
        fun release() = synchronized(bindingGuard) {
            binder?.let { runCatching { it.unlinkToDeath(death, 0) } }
            if (bound) runCatching { context.unbindService(this) }
            bound = false
        }
    }
    private suspend fun service(): IAppApiService = mutex.withLock {
        check(!closed) { "Client is closed" }
        connection?.let { active ->
            if (active.alive && active.binder?.isBinderAlive == true) return@withLock active.ready.await()
            active.release(); connection = null
        }
        val next = Connection()
        try {
            synchronized(bindingGuard) {
                check(!closed) { "Client is closed" }
                connection = next
                next.bound = context.bindService(Intent(AppApiWire.ACTION).setComponent(ComponentName(AppApiWire.PACKAGE, AppApiWire.SERVICE)), next, Context.BIND_AUTO_CREATE)
            }
            if (!next.bound) throw AgentoCApiException(PublicError("CAPABILITY_UNSUPPORTED", "Ragent is not installed or does not expose App API"))
            withTimeout(10_000) { next.ready.await() }
        } catch (failure: Throwable) { next.release(); if (connection === next) connection = null; throw failure }
    }
    private fun parse(value: String): PublicResponse {
        require(value.toByteArray(Charsets.UTF_8).size <= AppApiWire.MAX_RESPONSE_BYTES)
        return AppApiWire.json.decodeFromString<PublicResponse>(value).also { require(it.apiVersion == AppApiWire.VERSION) }
    }
    private suspend inline fun <reified T> request(crossinline send: (IAppApiService, String, IAppApiCallback) -> Unit): T = withContext(Dispatchers.IO) {
        val endpoint = service(); val id = UUID.randomUUID().toString()
        val result = CompletableDeferred<PublicResponse>(); pending[id] = result
        val callback = object : IAppApiCallback.Stub() {
            override fun onResponse(requestId: String, responseJson: String) {
                if (requestId == id) try { result.complete(parse(responseJson)) }
                catch (failure: Exception) { result.completeExceptionally(failure) }
            }
        }
        try {
            send(endpoint, id, callback)
            val response = withTimeout(125_000) { result.await() }
            response.error?.let { throw AgentoCApiException(it) }
            require(response.status in setOf("COMPLETED", "ACCEPTED"))
            AppApiWire.json.decodeFromJsonElement<T>(response.data)
        } catch (failure: android.os.RemoteException) { throw disconnected() }
        catch (_: TimeoutCancellationException) { throw AgentoCApiException(PublicError("RESULT_UNKNOWN", "Response budget expired; query the original operation before retrying", true)) }
        finally { pending.remove(id, result) }
    }
    suspend fun connect(): ApiInfo = request<ApiInfo> { service, id, cb -> service.getApiInfo(id, cb) }.also {
        require(AppApiWire.VERSION in it.minimumClientVersion..it.maximumClientVersion)
    }
    suspend fun capabilities(filter: PageFilter = PageFilter()): PublicPage<PublicCapability> {
        filter.validate()
        return request { service, id, cb -> service.listCapabilities(id, AppApiWire.encode(filter), cb) }
    }
    suspend fun computers(filter: PageFilter = PageFilter()): PublicPage<PublicTarget> = invocation(
        PublicInvocation("agentoc.targets.list", page = filter.also { it.validate() }))
    private suspend inline fun <reified T> invocation(value: PublicInvocation): T = request { service, id, cb ->
        service.invoke(id, AppApiWire.encode(value), cb)
    }
    val sessions = Sessions()
    inner class Sessions internal constructor() {
        suspend fun list(targetInstanceId: String, projectId: String? = null, limit: Int = 16, cursor: String? = null): PublicPage<PublicSession> =
            invocation(PublicInvocation("agentoc.sessions.list", session = PublicSessionRequest(targetInstanceId, projectId = projectId, limit = limit, cursor = cursor)))
        suspend fun search(targetInstanceId: String, query: String, projectId: String? = null, limit: Int = 16, cursor: String? = null): PublicPage<PublicSession> =
            invocation(PublicInvocation("agentoc.sessions.search", session = PublicSessionRequest(targetInstanceId, query = query, projectId = projectId, limit = limit, cursor = cursor)))
        suspend fun get(targetInstanceId: String, sessionId: String): PublicSession =
            invocation(PublicInvocation("agentoc.sessions.get", session = PublicSessionRequest(targetInstanceId, sessionId = sessionId)))
        suspend fun prepareMutation(request: PublicSessionMutationRequest): PublicSessionMutation =
            invocation(PublicInvocation("agentoc.sessions.prepareMutation", sessionMutation = request))
        /** An unknown reply must be reconciled using the original operation ID. No automatic retry. */
        suspend fun commitMutation(prepared: PublicSessionMutation): PublicSessionMutation = when (prepared.kind) {
            PublicSessionMutationKind.RENAME -> rename(prepared.operationId)
            PublicSessionMutationKind.SET_PINNED -> pin(prepared.operationId)
            PublicSessionMutationKind.SET_ARCHIVED -> archive(prepared.operationId)
            PublicSessionMutationKind.SET_REVIEWED -> markReviewed(prepared.operationId)
        }
        suspend fun rename(operationId: String): PublicSessionMutation = mutation("rename", operationId)
        suspend fun pin(operationId: String): PublicSessionMutation = mutation("pin", operationId)
        suspend fun archive(operationId: String): PublicSessionMutation = mutation("archive", operationId)
        suspend fun markReviewed(operationId: String): PublicSessionMutation = mutation("markReviewed", operationId)
        suspend fun getMutation(operationId: String): PublicSessionMutation = mutation("getMutation", operationId)
        suspend fun reconcileMutation(operationId: String): PublicSessionMutation = mutation("reconcileMutation", operationId)
        suspend fun cancelMutation(operationId: String): PublicSessionMutation = mutation("cancelMutation", operationId)
        private suspend fun mutation(action: String, operationId: String): PublicSessionMutation =
            invocation(PublicInvocation("agentoc.sessions.$action", operationId = operationId.also(AppApiWire::identifier)))
    }
    val tasks = Tasks()
    inner class Tasks internal constructor() {
        suspend fun prepare(task: PublicTaskRequest): PublicPreparedTask = request { service, id, cb ->
            service.prepare(id, AppApiWire.encode(task), cb)
        }
        suspend fun submit(task: PublicPreparedTask): PublicOperation = submit(task.preparationId)
        suspend fun submit(preparationId: String): PublicOperation = request { service, id, cb -> service.commit(id, preparationId, cb) }
        suspend fun get(operationId: String): PublicOperation = request { service, id, cb -> service.getOperation(id, operationId, cb) }
        suspend fun cancelSubmission(operationId: String): PublicOperation = request { service, id, cb -> service.cancelOperation(id, operationId, cb) }
        suspend fun reconcile(operationId: String): PublicOperation = invocation(PublicInvocation("agentoc.tasks.reconcile", operationId = operationId))
        suspend fun result(operationId: String): PublicTaskResult = invocation(PublicInvocation("agentoc.tasks.getResult", operationId = operationId))
        suspend fun manifest(operationId: String): PublicExportManifest = invocation(PublicInvocation("agentoc.tasks.downloadResult", operationId = operationId))
        suspend fun download(operationId: String, revision: String, resourceId: String, downloadId: String): PublicDownload = invocation(
            PublicInvocation("agentoc.tasks.downloadResult", operationId = operationId, revision = revision, resourceId = resourceId, downloadId = downloadId))
    }
    @OptIn(ExperimentalCoroutinesApi::class)
    fun watch(request: OperationWatch): Flow<OperationEvent> = callbackFlow {
        request.validate()
        val endpoint = service(); val requestId = UUID.randomUUID().toString()
        val subscriptionId = AtomicReference<String?>()
        val callback = object : IAppApiCallback.Stub() {
            override fun onResponse(id: String, payload: String) {
                try {
                    val response = parse(payload)
                    response.error?.let { throw AgentoCApiException(it) }
                    val event = AppApiWire.json.decodeFromJsonElement<OperationEvent>(response.data)
                    if (response.status == "SUBSCRIBED" && id == requestId) subscriptionId.set(event.subscriptionId)
                    else require(response.status == "EVENT" && id == subscriptionId.get() && id == event.subscriptionId)
                    if (trySend(event).isFailure) close(AgentoCApiException(PublicError("RESOURCE_LIMIT", "Snapshot consumer is too slow; resume using the last revision")))
                    if (event.kind in setOf("FAILED", "EXPIRED", "CLOSED")) close()
                } catch (failure: Exception) { close(failure) }
            }
        }
        streams[requestId] = { failure -> close(failure) }
        try {
            withContext(Dispatchers.IO) { endpoint.subscribe(requestId, AppApiWire.encode(request), callback) }
            awaitClose { }
        } finally {
            streams.remove(requestId)
            cleanupScope.launch {
                runCatching { endpoint.unsubscribe(UUID.randomUUID().toString(), subscriptionId.get() ?: "request:$requestId", object : IAppApiCallback.Stub() {
                    override fun onResponse(id: String, payload: String) = Unit
                }) }
            }
        }
    }
    override fun close() {
        synchronized(bindingGuard) { closed = true; connection?.release(); connection = null }
        failPending(AgentoCApiException(PublicError("CANCELLED", "Client closed")))
        cleanupScope.launch { delay(10_000); cleanupScope.cancel() }
    }
}
