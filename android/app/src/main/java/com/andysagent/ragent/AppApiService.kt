package com.andysagent.ragent

import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.content.FileProvider
import com.agentoncloud.android.api.*
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.util.UUID

/** Public bound transport. No binder thread waits for storage, bootstrap or PC execution. */
class AppApiService : Service() {
    private val graph get() = (application as RagentApplication).runtime
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val guard = Any()
    private data class Pending(val identity: InstalledCallerIdentity, val job: Job, val watchRequestId: String? = null)
    private val calls = mutableMapOf<Pair<String, String>, Pending>()
    private val watches = mutableMapOf<String, Pending>()
    private data class Delivery(val response: PublicResponse, val sent: (Boolean) -> Unit = {}, val check: suspend () -> Unit = {})
    private inline fun <reified T> result(value: T, status: String = "COMPLETED") =
        Delivery(PublicResponse(status = status, data = AppApiWire.json.encodeToJsonElement(value)))
    /** Error text is a public projection too; remote/internal exception messages may carry private details. */
    private fun ApiError.publicView() = PublicError(code.name, when (code) {
        ApiErrorCode.INVALID_ARGUMENT -> "Invalid or unsupported request fields"
        ApiErrorCode.AMBIGUOUS_TARGET -> "Choose an exact computer identity"
        ApiErrorCode.TARGET_NOT_FOUND -> "The requested computer is unavailable to this caller"
        ApiErrorCode.TARGET_OFFLINE -> "The target computer is offline"
        ApiErrorCode.AUTHENTICATION_REQUIRED -> "Authentication or pairing is required"
        ApiErrorCode.PERMISSION_DENIED -> "The caller grant does not permit this operation"
        ApiErrorCode.CAPABILITY_UNSUPPORTED -> "The requested capability or version is unsupported"
        ApiErrorCode.RESOURCE_NOT_FOUND -> "The requested resource is unavailable"
        ApiErrorCode.REVISION_CONFLICT -> "The stored identity or revision differs; refresh before retrying"
        ApiErrorCode.REQUEST_EXPIRED -> "The preparation deadline has passed"
        ApiErrorCode.RESULT_UNKNOWN -> "The result is unconfirmed; query the original operation before retrying"
        ApiErrorCode.RATE_LIMITED -> "Too many concurrent requests"
        ApiErrorCode.RESOURCE_LIMIT -> "The resource budget is exceeded"
        ApiErrorCode.CANCELLED -> "The submission has been cancelled"
        ApiErrorCode.INTERNAL_ERROR -> "The operation could not be completed"
    }, retryable)
    private fun error(failure: Exception): PublicError = when (failure) {
        is AppApiException -> failure.error.publicView()
        is IllegalArgumentException -> PublicError("INVALID_ARGUMENT", "Invalid or unsupported request fields")
        is TimeoutCancellationException -> PublicError("RESULT_UNKNOWN", "Call budget expired; query the original operation before retrying", true)
        else -> PublicError("INTERNAL_ERROR", "The operation could not be completed")
    }
    private fun requireCurrent(identity: InstalledCallerIdentity) {
        if (!graph.appApiCallerIdentities.isCurrent(identity))
            throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Caller installation changed"))
    }
    private fun send(callback: IAppApiCallback, id: String, response: PublicResponse): Boolean = try {
        var encoded = AppApiWire.encode(response)
        val delivered = encoded.toByteArray(Charsets.UTF_8).size <= AppApiWire.MAX_RESPONSE_BYTES
        if (!delivered)
            encoded = AppApiWire.encode(PublicResponse(status = "FAILED", error = PublicError("RESOURCE_LIMIT", "Response exceeds the transport budget")))
        callback.onResponse(id, encoded); delivered
    } catch (_: Exception) { false }

    /** UID is captured before coroutine dispatch, including for version discovery and unsubscribe. */
    private fun call(id: String, callback: IAppApiCallback, isWatch: Boolean = false, block: suspend (InstalledCallerIdentity) -> Delivery) {
        AppApiWire.identifier(id)
        val identity = graph.appApiCallerIdentities.captureBinderCaller()
        val key = identity.binding to id
        val job = scope.launch(start = CoroutineStart.LAZY) {
            var allocated: Delivery? = null
            val delivery = try {
                withTimeout(120_000) {
                    requireCurrent(identity)
                    block(identity).also { allocated = it; requireCurrent(identity); it.check(); requireCurrent(identity); currentCoroutineContext().ensureActive() }
                }
            } catch (timeout: TimeoutCancellationException) {
                allocated?.sent?.invoke(false); Delivery(PublicResponse(status = "FAILED", error = error(timeout)))
            } catch (cancelled: CancellationException) { allocated?.sent?.invoke(false); throw cancelled }
            catch (failure: Exception) { allocated?.sent?.invoke(false); Delivery(PublicResponse(status = "FAILED", error = error(failure))) }
            delivery.sent(send(callback, id, delivery.response))
        }
        synchronized(guard) {
            if (key in calls) { job.cancel(); throw IllegalArgumentException("Request identity is already in flight") }
            if (calls.size >= 64 || calls.values.count { it.identity.binding == identity.binding } >= 8) {
                send(callback, id, PublicResponse(status = "FAILED", error = PublicError("RATE_LIMITED", "Too many concurrent calls", true)))
                job.cancel(); return
            }
            calls[key] = Pending(identity, job, if (isWatch) id else null)
        }
        val binder = callback.asBinder()
        val death = IBinder.DeathRecipient { job.cancel() }
        job.invokeOnCompletion {
            runCatching { binder.unlinkToDeath(death, 0) }
            synchronized(guard) { if (calls[key]?.job === job) calls.remove(key) }
        }
        try {
            binder.linkToDeath(death, 0)
            // A cleanup request can cancel the lazy job before the death link is installed.
            if (job.isCompleted) runCatching { binder.unlinkToDeath(death, 0) } else job.start()
        }
        catch (_: android.os.RemoteException) { job.cancel() }
    }
    private fun TaskOperation.publicView() = PublicOperation(operationId, preparationId, targetInstanceId,
        deadlineAt, stage.name, sessionId, runId, messageRequestId, queued, duplicate, revision,
        lastError?.publicView())
    private fun PreparedTask.publicView() = PublicPreparedTask(operationId, preparationId, targetInstanceId, deadlineAt, stage.name)
    private fun caller(identity: InstalledCallerIdentity) = VerifiedCaller(identity.binding)
    private fun operationResult(identity: InstalledCallerIdentity, operation: TaskOperation, capability: String,
        status: String = "COMPLETED") = result(operation.publicView(), status).copy(check = {
            graph.appApi.checkDelivery(operation, caller(identity), capability)
        })

    /** Cursor binds a fresh authorized projection; changes to that projection invalidate it. */
    private inline fun <reified T> page(items: List<T>, filter: PageFilter): PublicPage<T> {
        filter.validate()
        val revision = MessageDigest.getInstance("SHA-256").digest(AppApiWire.encode(items).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        val offset = filter.cursor?.let {
            val parts = it.split(':')
            if (parts.size != 2 || parts[0] != revision) throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Refresh the authorized list"))
            parts[1].toIntOrNull() ?: throw IllegalArgumentException()
        } ?: 0
        require(offset in 0..items.size)
        val end = minOf(offset + filter.limit, items.size)
        return PublicPage(items.subList(offset, end).toList(), if (end < items.size) "$revision:$end" else null, System.currentTimeMillis(), revision)
    }
    private suspend fun capabilities(identity: InstalledCallerIdentity, filter: PageFilter): PublicPage<PublicCapability> {
        filter.validate()
        val grants = graph.appApiCallerGrants.activeGrants().filter { it.callerBinding == identity.binding }
        val ids = grants.filter { filter.targetInstanceId == null || filter.targetInstanceId in it.targetIds }.flatMap { it.capabilityIds }.toSet()
        return page(CapabilityRegistry().list().sortedBy { it.id }.map {
            PublicCapability(it.id, it.version, it.description, it.mutates, it.targetRequired, it.implemented,
                if (it.id in ids) "GRANTED" else "NOT_GRANTED")
        }, filter)
    }

    private suspend fun watch(identity: InstalledCallerIdentity, requestId: String, request: OperationWatch, callback: IAppApiCallback): Delivery {
        request.validate()
        val initial = graph.appApi.get(request.operationId, caller(identity))
        graph.appApi.checkDelivery(initial, caller(identity), CapabilityRegistry.TASKS_GET)
        if (request.afterRevision > initial.revision) throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Watch cursor exceeds the current operation"))
        val id = UUID.randomUUID().toString()
        val binder = callback.asBinder()
        lateinit var job: Job
        val death = IBinder.DeathRecipient { job.cancel() }
        job = scope.launch(start = CoroutineStart.LAZY) {
            var revision = request.afterRevision
            try {
                withTimeout(request.lifetimeMs) {
                    while (isActive) {
                        requireCurrent(identity)
                        val operation = graph.appApi.get(request.operationId, caller(identity))
                        requireCurrent(identity)
                        if (operation.revision > revision) {
                            val event = OperationEvent(id, if (revision >= 0 && operation.revision > revision + 1) "SNAPSHOT_GAP" else "SNAPSHOT",
                                operation.publicView(), System.currentTimeMillis())
                            graph.appApi.checkDelivery(operation, caller(identity), CapabilityRegistry.TASKS_GET)
                            requireCurrent(identity)
                            if (!send(callback, id, result(event, "EVENT").response)) break
                            revision = operation.revision
                        }
                        delay(1_000)
                    }
                }
            } catch (_: TimeoutCancellationException) { send(callback, id, result(OperationEvent(id, "EXPIRED", observedAt = System.currentTimeMillis()), "EVENT").response) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                send(callback, id, result(OperationEvent(id, "FAILED", observedAt = System.currentTimeMillis(), error = error(failure)), "EVENT").response)
            }
        }
        synchronized(guard) {
            if (watches.size >= 64 || watches.values.count { it.identity.binding == identity.binding } >= 4) {
                job.cancel(); throw AppApiException(ApiError(ApiErrorCode.RATE_LIMITED, "Too many operation watches", true))
            }
            watches[id] = Pending(identity, job, requestId)
        }
        job.invokeOnCompletion {
            runCatching { binder.unlinkToDeath(death, 0) }
            synchronized(guard) { if (watches[id]?.job === job) watches.remove(id) }
        }
        try {
            binder.linkToDeath(death, 0)
            if (job.isCompleted) runCatching { binder.unlinkToDeath(death, 0) }
            currentCoroutineContext().ensureActive()
        }
        catch (failure: Exception) { job.cancel(); throw failure }
        return result(OperationEvent(id, "SUBSCRIBED", observedAt = System.currentTimeMillis()), "SUBSCRIBED")
            .copy(sent = { delivered -> if (delivered) job.start() else job.cancel() },
                check = { graph.appApi.checkDelivery(initial, caller(identity), CapabilityRegistry.TASKS_GET) })
    }

    private fun SessionApiItem.publicView() = PublicSession(targetInstanceId, sessionId, title, projectId, state, updatedAt, titleTruncated)

    private fun SessionMutationOperation.publicView() = PublicSessionMutation(request.operationId,
        request.targetInstanceId, request.sessionId, command.expectedProjectId,
        PublicSessionMutationKind.valueOf(request.kind.name), deadlineAt, stage.name, revision,
        receipt?.let { PublicSessionMutationReceipt(it.changed, it.revision, it.scopeRevision, it.observedAt) })

    private suspend fun invoke(identity: InstalledCallerIdentity, request: PublicInvocation): Delivery {
        require(request.apiVersion == 1)
        val principal = caller(identity)
        val isSession = request.capabilityId in SessionCapabilities.descriptors.map { it.id }
        require(isSession == (request.session != null))
        require((request.capabilityId == SessionMutationCapabilities.PREPARE) == (request.sessionMutation != null))
        if (request.capabilityId in SessionMutationCapabilities.descriptors.map { it.id }) {
            require(request.page == null && request.revision == null && request.resourceId == null && request.downloadId == null)
            val operation = if (request.capabilityId == SessionMutationCapabilities.PREPARE) {
                require(request.operationId == null)
                val args = requireNotNull(request.sessionMutation)
                graph.appApiSessionMutations.prepare(SessionMutationRequest(args.operationId, args.targetInstanceId,
                    args.sessionId, com.andysagent.ragent.core.domain.SessionMutationKind.valueOf(args.kind.name),
                    args.title, args.flag, args.projectId, args.deadlineAt, args.apiVersion), principal)
            } else {
                val id = requireNotNull(request.operationId).also(AppApiWire::identifier)
                when (request.capabilityId) {
                    SessionMutationCapabilities.GET -> graph.appApiSessionMutations.get(id, principal)
                    SessionMutationCapabilities.RECONCILE -> graph.appApiSessionMutations.reconcile(id, principal)
                    SessionMutationCapabilities.CANCEL -> graph.appApiSessionMutations.cancel(id, principal)
                    else -> {
                        val kind = com.andysagent.ragent.core.domain.SessionMutationKind.entries.single {
                            SessionMutationCapabilities.effect(it) == request.capabilityId
                        }
                        graph.appApiSessionMutations.commit(id, principal, kind)
                    }
                }
            }
            // COMPLETED describes this query/command response. SUBMITTING remains unconfirmed in the projection.
            return result(operation.publicView()).copy(check = {
                graph.appApiSessionMutations.checkDelivery(operation, principal, request.capabilityId)
            })
        }
        return when (request.capabilityId) {
            SessionCapabilities.LIST, SessionCapabilities.SEARCH, SessionCapabilities.GET -> {
                require(request.operationId == null && request.page == null && request.revision == null &&
                    request.resourceId == null && request.downloadId == null)
                val args = requireNotNull(request.session)
                AppApiWire.identifier(args.targetInstanceId)
                if (request.capabilityId == SessionCapabilities.GET) {
                    require(args.query == null && args.projectId == null && args.cursor == null && args.limit == 16)
                    val id = requireNotNull(args.sessionId).also(AppApiWire::identifier)
                    val item = graph.appApiSessions.get(args.targetInstanceId, id, principal)
                    result(item.publicView()).copy(check = {
                        graph.appApiSessions.checkAccess(principal, request.capabilityId, args.targetInstanceId, listOf(item))
                    })
                } else {
                    require(args.sessionId == null)
                    val page = graph.appApiSessions.list(SessionQuery(args.targetInstanceId, args.limit, args.cursor, args.query, args.projectId),
                        principal, search = request.capabilityId == SessionCapabilities.SEARCH)
                    result(PublicPage(page.items.map { it.publicView() }, page.nextCursor, page.observedAt, page.revision)).copy(check = {
                        graph.appApiSessions.checkAccess(principal, request.capabilityId, args.targetInstanceId, page.items)
                    })
                }
            }
            CapabilityRegistry.TARGETS_LIST -> {
                require(request.operationId == null && request.resourceId == null && request.revision == null && request.downloadId == null)
                val filter = request.page ?: PageFilter(); filter.validate()
                val targets = graph.appApi.listTargets(principal).filter { filter.targetInstanceId == null || it.instanceId == filter.targetInstanceId }
                    .sortedBy { it.instanceId }.map { PublicTarget(it.instanceId, it.name, it.aliases) }
                result(page(targets, filter)).copy(check = {
                    val allowed = graph.appApi.listTargets(principal).map { it.instanceId }.toSet()
                    if (!allowed.containsAll(targets.map { it.instanceId }))
                        throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Target access changed before delivery"))
                })
            }
            CapabilityRegistry.TASKS_RECONCILE, CapabilityRegistry.TASKS_RESULT -> {
                require(request.page == null && request.resourceId == null && request.revision == null && request.downloadId == null)
                val id = requireNotNull(request.operationId).also(AppApiWire::identifier)
                if (request.capabilityId == CapabilityRegistry.TASKS_RECONCILE) operationResult(identity, graph.appApi.reconcile(id, principal), request.capabilityId)
                else {
                    val operation = graph.appApi.readResult(id, principal)
                    val snapshot = operation.result ?: throw AppApiException(operation.lastError ?: ApiError(ApiErrorCode.RESULT_UNKNOWN, "Exact result is not confirmed", true))
                    result(PublicTaskResult(snapshot.sessionId, snapshot.requestId, snapshot.runId, snapshot.finalRunId,
                        snapshot.state.name, snapshot.text, snapshot.textTruncated, snapshot.artifacts.map {
                            PublicArtifact(it.assetId, it.originalName, it.mimeType, it.sizeBytes)
                        }, snapshot.observedAt, snapshot.hasAttachments)).copy(check = {
                            graph.appApi.checkDelivery(operation, principal, request.capabilityId)
                        })
                }
            }
            CapabilityRegistry.TASKS_RESULT_EXPORT -> {
                require(request.page == null)
                val id = requireNotNull(request.operationId).also(AppApiWire::identifier)
                if (request.resourceId == null) {
                    require(request.revision == null && request.downloadId == null)
                    val operation = graph.appApi.readResultExport(id, principal)
                    val manifest = requireNotNull(operation.resultExport)
                    result(PublicExportManifest(manifest.instanceId, manifest.sessionId, manifest.requestId, manifest.runId,
                        manifest.finalRunId, manifest.resources.map { PublicExportResource(it.resourceId, it.originalName,
                            it.mimeType, it.available, it.sizeBytes, it.sha256, it.errorCode) }, manifest.expiresAt, manifest.revision)).copy(check = {
                                graph.appApi.checkDelivery(operation, principal, request.capabilityId)
                            })
                } else {
                    val revision = requireNotNull(request.revision).also(AppApiWire::identifier)
                    val resource = requireNotNull(request.resourceId).also(AppApiWire::identifier)
                    val download = requireNotNull(request.downloadId).also(AppApiWire::identifier)
                    val output = graph.resultOutputs.download(id, principal, revision, resource, download)
                    val reference = graph.resultDeliveries.stage(output.downloadId, principal)
                    var uri: android.net.Uri? = null
                    suspend fun revokeDelivery() {
                        uri?.let { revokeUriPermission(identity.packageName, it, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                        graph.resultDeliveries.revoke(reference.id, principal)
                    }
                    try {
                        val sharedUri = graph.resultDeliveries.withSharedFile(reference.id, principal) { _, file ->
                            FileProvider.getUriForFile(this, "$packageName.result-files", file)
                        }
                        uri = sharedUri
                        requireCurrent(identity)
                        grantUriPermission(identity.packageName, sharedUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        result(PublicDownload(output.downloadId, output.state.name, sharedUri.toString(), reference.name,
                            reference.mimeType, reference.sizeBytes, output.resource.sha256!!, reference.expiresAt))
                            .copy(sent = { delivered -> if (!delivered) scope.launch(NonCancellable) { runCatching { revokeDelivery() } } },
                                check = { requireNotNull(graph.resultOutputs.get(output.downloadId, principal)) })
                    } catch (failure: Exception) {
                        withContext(NonCancellable) { runCatching { revokeDelivery() } }
                        throw failure
                    }
                }
            }
            else -> throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Use the named method or a supported invocation"))
        }
    }

    private val endpoint = object : IAppApiService.Stub() {
        override fun getApiInfo(id: String, cb: IAppApiCallback) = call(id, cb) { result(ApiInfo()) }
        override fun listCapabilities(id: String, filter: String, cb: IAppApiCallback) = call(id, cb) {
            result(capabilities(it, AppApiWire.decode<PageFilter>(filter)))
        }
        override fun prepare(id: String, payload: String, cb: IAppApiCallback) = call(id, cb) {
            val request = AppApiWire.decode<PublicTaskRequest>(payload)
            val internal = AppApiJson.decodeFromString<TaskRequest>(AppApiWire.encode(request))
            val prepared = graph.appApi.prepare(internal, caller(it))
            result(prepared.publicView()).copy(check = {
                graph.appApi.checkPreparedDelivery(prepared, caller(it))
            })
        }
        override fun commit(id: String, preparation: String, cb: IAppApiCallback) = call(id, cb) {
            AppApiWire.identifier(preparation)
            val operation = graph.appApi.commit(preparation, caller(it))
            operationResult(it, operation, CapabilityRegistry.TASKS_COMMIT, if (operation.stage == OperationStage.ACCEPTED) "ACCEPTED" else "COMPLETED")
        }
        override fun getOperation(id: String, operation: String, cb: IAppApiCallback) = call(id, cb) {
            AppApiWire.identifier(operation); operationResult(it, graph.appApi.get(operation, caller(it)), CapabilityRegistry.TASKS_GET)
        }
        override fun cancelOperation(id: String, operation: String, cb: IAppApiCallback) = call(id, cb) {
            AppApiWire.identifier(operation); operationResult(it, graph.appApi.cancelSubmission(operation, caller(it)), CapabilityRegistry.TASKS_CANCEL)
        }
        override fun subscribe(id: String, filter: String, cb: IAppApiCallback) = call(id, cb, isWatch = true) {
            watch(it, id, AppApiWire.decode<OperationWatch>(filter), cb)
        }
        override fun unsubscribe(id: String, subscription: String, cb: IAppApiCallback) = call(id, cb) { identity ->
            AppApiWire.identifier(subscription)
            val jobs = synchronized(guard) {
                if (subscription.startsWith("request:")) {
                    val source = subscription.removePrefix("request:").also(AppApiWire::identifier)
                    return@synchronized (watches.values + calls.values).filter {
                        it.identity.binding == identity.binding && it.watchRequestId == source
                    }.map { it.job }
                }
                val entry = watches[subscription]
                if (entry != null && entry.identity.binding != identity.binding)
                    throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Subscription belongs to another caller"))
                listOfNotNull(entry?.job)
            }
            jobs.forEach { it.cancelAndJoin() }; result(OperationEvent(subscription, "CLOSED", observedAt = System.currentTimeMillis()))
        }
        override fun invoke(id: String, payload: String, cb: IAppApiCallback) = call(id, cb) {
            invoke(it, AppApiWire.decode<PublicInvocation>(payload))
        }
    }
    override fun onBind(intent: Intent): IBinder? = if (intent.action == AppApiWire.ACTION) endpoint else null
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
