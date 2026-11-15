package com.andysagent.ragent.feature.appapi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.ComputerDirectory
import com.andysagent.ragent.core.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** Trusted application adapter supplies identity and fixed-target access, never Intent extras. */
interface CaptureWorkflowPort {
    val caller: VerifiedCaller
    val drafts: CaptureDraftStore
    val directory: Flow<ComputerDirectory>
    suspend fun catalog(targetId: String): RuntimeCatalog
    suspend fun models(targetId: String, tool: String, provider: String): List<RuntimeModelOption>
    suspend fun prepare(request: TaskRequest): PreparedTask
    suspend fun commit(preparationId: String, onProgress: (TaskUploadProgress) -> Unit = {}): TaskOperation
    suspend fun operation(operationId: String): TaskOperation
    suspend fun reconcile(operationId: String): TaskOperation
    suspend fun cancelSubmission(operationId: String): TaskOperation
    suspend fun readResult(operationId: String): TaskOperation = throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Result lookup is unavailable"))
    suspend fun restoreInputs(draft: CaptureDraft): CaptureDraft = draft
    suspend fun importInputs(draft: CaptureDraft, onProgress: (CaptureImportProgress) -> Unit = {},
        onUpdated: (CaptureDraft) -> Unit): CaptureDraft = draft
    suspend fun initialTarget(): CaptureInitialTarget = CaptureInitialTarget()
    suspend fun pinTarget(targetId: String): CapturePinResult = CapturePinResult.UNSUPPORTED
    suspend fun checkConnection(targetId: String): CaptureConnectionStatus = CaptureConnectionStatus.UNKNOWN
    val supportsBackgroundDelivery: Boolean get() = false
    suspend fun scheduleBackgroundDelivery(operationId: String): String = throw AppApiException(
        ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Background delivery is unavailable"))
    suspend fun rememberRuntime(targetId: String, runtime: TaskRuntime) = Unit
    val supportsIntake: Boolean get() = false
    suspend fun checkIntakeSupport(targetId: String): Boolean = false
    suspend fun prepareIntake(input: IntakeInput, runtime: TaskRuntime): IntakeDecision =
        throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Smart intake is unavailable"))
    suspend fun ensureIntakeProject(request: IntakeEnsureRequest): IntakeProjectReceipt =
        throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Project creation is unavailable"))
}

data class CaptureInitialTarget(val targetId: String? = null, val requireSelection: Boolean = false, val error: ApiErrorCode? = null)
enum class CapturePinResult { REQUESTED, UNSUPPORTED, FAILED }
enum class CaptureIntakeStatus { CHECKING, SUPPORTED, UNSUPPORTED, UNAVAILABLE }
data class CaptureIntakeObservation(val targetId: String, val status: CaptureIntakeStatus)

/** Supplied by the live Activity invocation, never restored from a draft or caller extras. */
enum class CaptureSelectionMode { NONE, READ_ONLY, REPLACEABLE }

private fun selectionText(draft: CaptureDraft?, operation: TaskOperation?): String? {
    if (draft == null || operation == null || draft.operationId != operation.operationId ||
        draft.targetInstanceId != operation.targetInstanceId || operation.stage != OperationStage.ACCEPTED) return null
    val result = operation.result ?: return null
    val text = result.text ?: return null
    return text.takeIf { result.canReplaceSelection && result.sessionId == operation.sessionId &&
        result.requestId == operation.messageRequestId && (operation.runId == null || result.runId == operation.runId) &&
        result.runId != null && result.finalRunId != null && text.toByteArray(Charsets.UTF_8).size <= 48 * 1024 }
}

data class CaptureUiState(
    val loading: Boolean = true,
    val draft: CaptureDraft? = null,
    val directory: ComputerDirectory = ComputerDirectory(),
    val catalog: RuntimeCatalog = RuntimeCatalog(),
    val models: List<RuntimeModelOption> = emptyList(),
    val catalogLoading: Boolean = false,
    val busy: Boolean = false,
    val dirty: Boolean = false,
    val operation: TaskOperation? = null,
    val error: ApiErrorCode? = null,
    val close: Boolean = false,
    val pinResult: CapturePinResult? = null,
    val selectionMode: CaptureSelectionMode = CaptureSelectionMode.NONE,
    val replacementText: String? = null,
    val viewSavedTask: Boolean = false,
    val importProgress: CaptureImportProgress? = null,
    val uploadProgress: TaskUploadProgress? = null,
    val connectionObservation: CaptureConnectionObservation? = null,
    val checkingConnection: Boolean = false,
    val connectionObservationStale: Boolean = false,
    val connectionObservations: Map<String, CaptureConnectionObservation> = emptyMap(),
    val staleConnectionTargets: Set<String> = emptySet(),
    val checkingConnectionTargetId: String? = null,
    val supportsBackgroundDelivery: Boolean = false,
    val backgroundDeliveryScheduled: Boolean = false,
    val runtimeRestored: Boolean = false,
    val requiresIntake: Boolean = false,
    val intakeObservation: CaptureIntakeObservation? = null,
) {
    val canReturnSelection: Boolean get() = selectionMode == CaptureSelectionMode.REPLACEABLE &&
        !loading && !busy && !close && error == null && selectionText(draft, operation) != null &&
        directory.computers.any { it.instanceId == operation?.targetInstanceId }
    val editable: Boolean get() = !loading && !busy && draft?.operationId == null &&
        draft?.projectCreationOperationId == null && draft != null
    val canCheckConnection: Boolean get() = editable && !close && !checkingConnection &&
        directory.computers.any { it.instanceId == draft?.targetInstanceId }
    val canSubmitInBackground: Boolean get() = canSubmit && supportsBackgroundDelivery &&
        selectionMode == CaptureSelectionMode.NONE && !backgroundDeliveryScheduled
    fun canCheckConnection(targetId: String): Boolean = editable && !close && !checkingConnection &&
        directory.computers.any { it.instanceId == targetId }
    val validRuntimeSelection: Boolean get() {
        val runtime = draft?.runtime ?: return false
        val tool = catalog.tools.firstOrNull { it.id == runtime.tool } ?: return false
        return !catalogLoading && directory.computers.any { it.instanceId == draft.targetInstanceId } &&
            (!(tool.providerSelectionRequired || runtime.providerProfile != null) || tool.providers.any { it.id == runtime.providerProfile }) &&
            models.any { it.id == runtime.model }
    }
    val canSubmit: Boolean get() {
        val current = draft ?: return false
        if (loading || busy || current.instruction.isBlank() || current.input.imports.isNotEmpty()) return false
        if (current.operationId != null) return operation?.stage !in setOf(OperationStage.ACCEPTED, OperationStage.CANCELLED, OperationStage.EXPIRED, OperationStage.SUBMITTING)
        return directory.appApiRouting.readable && validRuntimeSelection &&
            (!requiresIntake || intakeObservation == CaptureIntakeObservation(current.targetInstanceId ?: "", CaptureIntakeStatus.SUPPORTED))
    }
}

sealed interface CaptureEvent {
    data class Instruction(val value: String) : CaptureEvent
    data class SourceText(val value: String) : CaptureEvent
    data class RemoveResource(val id: String) : CaptureEvent
    data class RemoveImport(val id: String) : CaptureEvent
    data class Target(val id: String) : CaptureEvent
    data class Tool(val id: String) : CaptureEvent
    data class Provider(val id: String) : CaptureEvent
    data class Model(val id: String) : CaptureEvent
    data object ReloadCatalog : CaptureEvent
    data object RetryIntakeSupport : CaptureEvent
    data object CheckConnection : CaptureEvent
    data class CheckTargetConnection(val targetId: String) : CaptureEvent
    data object Submit : CaptureEvent
    data object SubmitInBackground : CaptureEvent
    data object CheckReceipt : CaptureEvent
    data object CheckResult : CaptureEvent
    data object SaveAndClose : CaptureEvent
    data object StopWaiting : CaptureEvent
    data object CopyAsNew : CaptureEvent
    data object OpenRoutingSettings : CaptureEvent
    data object CancelSubmission : CaptureEvent
    data object PinTarget : CaptureEvent
    data object ReturnSelection : CaptureEvent
    data object ViewSavedTask : CaptureEvent
    data object ViewOutputs : CaptureEvent
}

/** One saved draft, one immutable operation identity. Restoring never commits or reconnects a frozen task. */
class CaptureViewModel(
    private val port: CaptureWorkflowPort,
    private val draftId: String,
    private val initialInput: CaptureInput? = null,
    private val initialError: ApiErrorCode? = null,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val restoredDraft: CaptureDraft? = null,
    private val selectionMode: CaptureSelectionMode = CaptureSelectionMode.NONE,
) : ViewModel() {
    private val mutableState = MutableStateFlow(CaptureUiState(selectionMode = selectionMode, requiresIntake = port.supportsIntake,
        supportsBackgroundDelivery = port.supportsBackgroundDelivery))
    val state: StateFlow<CaptureUiState> = mutableState.asStateFlow()
    private val saveLock = Mutex()
    private var persisted: CaptureDraft? = null
    private var debounce: Job? = null
    private var catalogJob: Job? = null
    private var catalogGeneration = 0L
    private var intakeJob: Job? = null
    private var intakeGeneration = 0L
    private var action: Job? = null
    private var connectionCheck: Job? = null
    private val connectionExpiries = mutableMapOf<String, Job>()
    private var connectionGeneration = 0L
    private val pendingRuntimePreferences = mutableMapOf<String, TaskRuntime>()

    init {
        viewModelScope.launch {
            try {
                val existing = port.drafts.get(draftId, port.caller)
                val initial = existing ?: initialInput?.let { input ->
                    val hint = port.initialTarget()
                    mutableState.update { it.copy(error = hint.error) }
                    val fresh = CaptureDraft(draftId, port.caller.binding, now(), input = input,
                        targetInstanceId = hint.targetId, requireTargetSelection = hint.requireSelection)
                    if (port.drafts.insert(fresh, port.caller)) fresh else port.drafts.get(draftId, port.caller)
                }
                val loaded = if (initial != null && initial.input.imports.isNotEmpty()) {
                    val importing = initial
                    mutableState.update { it.copy(loading = false, draft = importing, busy = true) }
                    action = viewModelScope.launch {
                        try {
                            val imported = if (existing != null) port.restoreInputs(importing)
                            else port.importInputs(importing, onProgress = { progress ->
                                mutableState.update { current ->
                                    if (current.busy && !current.close && current.draft?.draftId == importing.draftId &&
                                        current.draft.operationId == null && current.draft.input.imports.any {
                                            it.resourceId == progress.resourceId && it.error == null })
                                        current.copy(importProgress = progress) else current
                                }
                            }) { updated ->
                                persisted = updated
                                mutableState.update { it.copy(draft = updated, importProgress = it.importProgress?.takeIf { progress ->
                                    updated.input.imports.any { slot -> slot.resourceId == progress.resourceId && slot.error == null }
                                }) }
                            }
                            persisted = imported
                            mutableState.update { it.copy(draft = imported) }
                        } catch (cancelled: CancellationException) {
                            withContext(NonCancellable) {
                                val restored = port.restoreInputs(importing)
                                persisted = restored
                                mutableState.update { it.copy(draft = restored) }
                            }
                            throw cancelled
                        } catch (failure: Exception) { showFailure(failure) }
                        finally { mutableState.update { it.copy(busy = false, importProgress = null) } }
                    }
                    action!!.join()
                    port.drafts.get(draftId, port.caller)
                } else initial
                persisted = loaded
                val recovered = restoredDraft?.takeIf { candidate -> loaded != null && candidate.draftId == loaded.draftId
                    && candidate.callerBinding == port.caller.binding && candidate.createdAt == loaded.createdAt
                    && candidate.operationId == null && loaded.operationId == null &&
                    loaded.projectCreationOperationId == null && candidate.revision <= loaded.revision }
                val dirty = recovered != null && recovered.copy(revision = loaded!!.revision, updatedAt = loaded.updatedAt) != loaded
                // A newer persisted revision is a conflict, not permission to overwrite another editor.
                if (dirty) persisted = loaded!!.copy(revision = recovered!!.revision)
                mutableState.update { it.copy(loading = false, draft = if (dirty) recovered else loaded, dirty = dirty,
                    error = if (loaded == null) initialError ?: ApiErrorCode.RESOURCE_NOT_FOUND else it.error) }
                if (dirty) scheduleSave()
                loaded?.operationId?.let { id -> readLocalOperation(id) }
                // A new VM after process death has no live short-wait budget. Keep the
                // original operation and release the source instead of polling/replaying.
                if (loaded?.operationId != null && selectionMode != CaptureSelectionMode.NONE) detachSelection()
                port.directory.collect { directory ->
                    pendingRuntimePreferences.keys.retainAll(directory.computers.map { it.instanceId }.toSet())
                    val activeIds = directory.computers.map { it.instanceId }.toSet()
                    connectionExpiries.keys.filterNot(activeIds::contains).forEach { id -> connectionExpiries.remove(id)?.cancel() }
                    mutableState.update { current ->
                        val retained = current.connectionObservations.filterKeys(activeIds::contains)
                        current.copy(directory = directory, connectionObservations = retained,
                            staleConnectionTargets = current.staleConnectionTargets.intersect(activeIds),
                            connectionObservation = current.connectionObservation?.takeIf { it.targetId in activeIds },
                            connectionObservationStale = current.connectionObservation?.targetId?.let { it in current.staleConnectionTargets && it in activeIds } ?: false)
                    }
                    val current = mutableState.value.draft
                    val checkingTarget = mutableState.value.checkingConnectionTargetId
                    if (checkingTarget != null && checkingTarget !in activeIds) invalidateConnectionCheck(clearObservation = false)
                    if (current?.targetInstanceId != null && directory.computers.none { it.instanceId == current.targetInstanceId })
                        invalidateConnectionCheck(clearObservation = true)
                    if (current != null && current.targetInstanceId == null && !current.requireTargetSelection && current.operationId == null && directory.appApiRouting.readable) {
                        val default = directory.appApiRouting.defaultShareTargetId
                        val id = default?.takeIf { candidate -> directory.computers.any { it.instanceId == candidate } }
                            ?: directory.computers.singleOrNull()?.instanceId.takeIf { default == null }
                        if (id != null) onEvent(CaptureEvent.Target(id))
                    } else if (current?.operationId == null && current?.targetInstanceId != null && catalogJob == null) loadCatalog()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { showFailure(failure); mutableState.update { it.copy(loading = false) } }
        }
    }

    fun onEvent(event: CaptureEvent) {
        when (event) {
            CaptureEvent.SaveAndClose -> close()
            CaptureEvent.StopWaiting -> action?.cancel()
            CaptureEvent.ReturnSelection -> if (state.value.canReturnSelection) perform {
                val id = state.value.draft?.operationId ?: return@perform
                val current = port.operation(id) // Reauthorize the saved operation before returning.
                val replacement = selectionText(state.value.draft, current)
                mutableState.update { it.copy(operation = current, error = current.lastError?.code) }
                if (replacement != null &&
                    current.lastError == null && state.value.directory.computers.any { it.instanceId == current.targetInstanceId }) {
                    mutableState.update { it.copy(replacementText = replacement, close = true) }
                } else detachSelection()
            }
            CaptureEvent.ViewSavedTask -> if (!state.value.busy && state.value.draft?.operationId != null &&
                selectionMode != CaptureSelectionMode.NONE) detachSelection()
            CaptureEvent.CheckReceipt -> perform { state.value.draft?.operationId?.let { id ->
                val receipt = port.reconcile(id)
                mutableState.update { it.copy(operation = receipt, error = receipt.lastError?.code) }
            } }
            CaptureEvent.CheckResult -> perform { state.value.draft?.operationId?.let { id ->
                val result = try { withTimeout(30_000) { port.readResult(id) } }
                    catch (_: TimeoutCancellationException) { throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Result query exceeded its waiting budget", true)) }
                mutableState.update { it.copy(operation = result, error = result.lastError?.code) }
            } }
            CaptureEvent.Submit -> if (state.value.canSubmit) perform { submit() }
            CaptureEvent.SubmitInBackground -> if (state.value.canSubmitInBackground) perform { submit(continueInBackground = true) }
            CaptureEvent.CopyAsNew -> if (!state.value.busy) perform { copyAsNew() }
            CaptureEvent.CancelSubmission -> perform {
                val id = state.value.draft?.operationId ?: return@perform
                try {
                    val cancelled = port.cancelSubmission(id)
                    mutableState.update { it.copy(operation = cancelled, error = cancelled.lastError?.code) }
                } catch (failure: AppApiException) {
                    readLocalOperation(id)
                    if (failure.error.code != ApiErrorCode.RESULT_UNKNOWN || state.value.operation?.stage !in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) throw failure
                }
            }
            CaptureEvent.ReloadCatalog -> if (state.value.editable) loadCatalog()
            CaptureEvent.RetryIntakeSupport -> if (state.value.editable) state.value.draft?.targetInstanceId?.let(::loadIntakeSupport)
            CaptureEvent.CheckConnection -> if (state.value.canCheckConnection) checkConnection()
            is CaptureEvent.CheckTargetConnection -> if (state.value.canCheckConnection(event.targetId)) checkConnection(event.targetId)
            CaptureEvent.PinTarget -> if (state.value.editable) perform {
                mutableState.update { it.copy(pinResult = null) }
                val id = state.value.draft?.targetInstanceId ?: return@perform
                mutableState.update { it.copy(pinResult = port.pinTarget(id)) }
            }
            else -> if (state.value.editable) edit(event)
        }
    }

    private fun edit(event: CaptureEvent) {
        val current = state.value.draft ?: return
        try {
            val changed = when (event) {
                is CaptureEvent.Instruction -> current.copy(instruction = event.value)
                is CaptureEvent.SourceText -> current.copy(input = if (event.value.isBlank()) current.input.copy(sharedText = event.value, sourceUrls = emptyList())
                    else captureSharedText(event.value, current.input.title).copy(source = current.input.source,
                        resources = current.input.resources, imports = current.input.imports, selectionReadOnly = current.input.selectionReadOnly))
                is CaptureEvent.RemoveResource -> current.copy(input = current.input.copy(resources = current.input.resources.filterNot { it.resourceId == event.id }))
                is CaptureEvent.RemoveImport -> current.copy(input = current.input.copy(imports = current.input.imports.filterNot { it.resourceId == event.id }))
                is CaptureEvent.Target -> {
                    if (state.value.directory.computers.none { it.instanceId == event.id }) return
                    if (current.targetInstanceId == event.id && !current.requireTargetSelection) return
                    current.copy(targetInstanceId = event.id, runtime = null, requireTargetSelection = false)
                }
                is CaptureEvent.Tool -> {
                    if (state.value.catalogLoading || state.value.catalog.tools.none { it.id == event.id }) return
                    if (current.runtime?.tool == event.id) return
                    current.copy(runtime = TaskRuntime(event.id))
                }
                is CaptureEvent.Provider -> {
                    val tool = state.value.catalog.tools.firstOrNull { it.id == current.runtime?.tool } ?: return
                    if (state.value.catalogLoading || tool.providers.none { it.id == event.id }) return
                    if (current.runtime?.providerProfile == event.id) return
                    current.copy(runtime = current.runtime!!.copy(providerProfile = event.id, model = null))
                }
                is CaptureEvent.Model -> {
                    if (state.value.catalogLoading || state.value.models.none { it.id == event.id }) return
                    current.copy(runtime = current.runtime?.copy(model = event.id))
                }
                else -> return
            }
            if (changed == current) return
            val edited = changed.copy(intakeId = null, intakeDecision = null, projectCreationOperationId = null,
                projectId = null, existingSessionId = null)
            mutableState.update { it.copy(draft = edited, dirty = true, error = null,
                pinResult = if (event is CaptureEvent.Target) null else it.pinResult,
                runtimeRestored = if (event is CaptureEvent.Target || event is CaptureEvent.Tool ||
                    event is CaptureEvent.Provider || event is CaptureEvent.Model) false else it.runtimeRestored) }
            if (event is CaptureEvent.Model && state.value.validRuntimeSelection) {
                pendingRuntimePreferences[requireNotNull(changed.targetInstanceId)] = requireNotNull(changed.runtime)
            }
            scheduleSave()
            when (event) {
                is CaptureEvent.Target -> {
                    invalidateConnectionCheck(clearObservation = true)
                    selectConnectionObservation(event.id)
                    loadCatalog()
                }
                is CaptureEvent.Tool -> {
                    val tool = state.value.catalog.tools.first { it.id == event.id }
                    invalidateCatalogJob()
                    mutableState.update { it.copy(models = tool.models, catalogLoading = false) }
                }
                is CaptureEvent.Provider -> loadModels()
                else -> Unit
            }
        } catch (failure: Exception) { showFailure(failure) }
    }

    private fun scheduleSave() {
        debounce?.cancel()
        debounce = viewModelScope.launch {
            delay(300)
            // The in-flight Room transaction is not cancelled by the next keystroke.
            viewModelScope.launch { try { flush() } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { showFailure(failure) } }
        }
    }

    /** Called on backgrounding too; never submits. Close waits for the same persistence lock. */
    fun saveEdits() {
        if (!state.value.dirty && pendingRuntimePreferences.isEmpty()) return
        debounce?.cancel()
        viewModelScope.launch { try { flush() } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { showFailure(failure) } }
    }

    private suspend fun flush() = saveLock.withLock {
        while (state.value.dirty) {
            val previous = persisted ?: return@withLock
            val snapshot = state.value.draft ?: return@withLock
            if (snapshot.operationId != null) return@withLock
            val saved = snapshot.copy(revision = previous.revision + 1, updatedAt = maxOf(now(), previous.updatedAt))
            if (!port.drafts.replace(saved, port.caller, previous.revision)) fail(ApiErrorCode.REVISION_CONFLICT)
            persisted = saved
            mutableState.update { current ->
                val latest = current.draft ?: return@update current
                current.copy(draft = latest.copy(revision = saved.revision, updatedAt = saved.updatedAt), dirty = latest != snapshot)
            }
        }
        for ((target, runtime) in pendingRuntimePreferences.toMap()) {
            if (state.value.directory.computers.any { it.instanceId == target }) port.rememberRuntime(target, runtime)
            if (pendingRuntimePreferences[target] == runtime) pendingRuntimePreferences.remove(target)
        }
    }

    private fun invalidateCatalogJob(): Long {
        catalogJob?.cancel()
        return ++catalogGeneration
    }
    private fun invalidateConnectionCheck(clearObservation: Boolean) {
        connectionGeneration++
        connectionCheck?.cancel()
        mutableState.update { it.copy(checkingConnection = false, checkingConnectionTargetId = null,
            connectionObservation = if (clearObservation) null else it.connectionObservation,
            connectionObservationStale = if (clearObservation) false else it.connectionObservationStale) }
    }

    private fun selectConnectionObservation(target: String) {
        val observation = state.value.connectionObservations[target]
        mutableState.update { it.copy(connectionObservation = observation,
            connectionObservationStale = target in it.staleConnectionTargets) }
    }

    private fun checkConnection() {
        val target = state.value.draft?.targetInstanceId ?: return
        checkConnection(target)
    }

    private fun checkConnection(target: String) {
        if (!state.value.canCheckConnection(target)) return
        invalidateConnectionCheck(clearObservation = false)
        val generation = connectionGeneration
        mutableState.update { it.copy(checkingConnection = true, checkingConnectionTargetId = target) }
        connectionCheck = viewModelScope.launch {
            try {
                val status = withTimeoutOrNull(CONNECTION_CHECK_MS) { port.checkConnection(target) }
                    ?: CaptureConnectionStatus.UNREACHABLE
                currentCoroutineContext().ensureActive()
                if (generation != connectionGeneration || state.value.close ||
                    state.value.directory.computers.none { it.instanceId == target }) return@launch
                publishConnection(CaptureConnectionObservation(target, status, now()))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (generation == connectionGeneration && !state.value.close && state.value.directory.computers.any { it.instanceId == target })
                    publishConnection(CaptureConnectionObservation(target, CaptureConnectionStatus.UNKNOWN, now()))
            } finally {
                if (generation == connectionGeneration) mutableState.update { it.copy(checkingConnection = false, checkingConnectionTargetId = null) }
            }
        }
    }

    private fun publishConnection(observation: CaptureConnectionObservation) {
        mutableState.update { current ->
            val selected = current.draft?.targetInstanceId == observation.targetId
            current.copy(connectionObservations = current.connectionObservations + (observation.targetId to observation),
                staleConnectionTargets = current.staleConnectionTargets - observation.targetId,
                connectionObservation = if (selected) observation else current.connectionObservation,
                connectionObservationStale = if (selected) false else current.connectionObservationStale)
        }
        connectionExpiries.remove(observation.targetId)?.cancel()
        connectionExpiries[observation.targetId] = viewModelScope.launch {
            delay(CONNECTION_FRESH_MS)
            mutableState.update { current ->
                if (current.close || current.connectionObservations[observation.targetId] != observation) current
                else current.copy(staleConnectionTargets = current.staleConnectionTargets + observation.targetId,
                    connectionObservationStale = if (current.draft?.targetInstanceId == observation.targetId) true else current.connectionObservationStale)
            }
        }
    }
    private fun loadCatalog() {
        val draft = state.value.draft ?: return
        val target = draft.targetInstanceId ?: return
        loadIntakeSupport(target)
        val generation = invalidateCatalogJob()
        mutableState.update { it.copy(catalog = RuntimeCatalog(), models = emptyList(), catalogLoading = true, error = null) }
        catalogJob = viewModelScope.launch {
            try {
                val catalog = port.catalog(target)
                currentCoroutineContext().ensureActive()
                if (!catalogMatches(generation, target)) return@launch
                val existing = state.value.draft?.runtime
                val remembered = pendingRuntimePreferences[target] ?: state.value.directory.shareRuntimeSelections[target]?.let {
                    TaskRuntime(it.tool, it.providerProfile, it.model)
                }
                val candidate = existing ?: remembered
                val provider = candidate?.providerProfile
                val tool = catalog.tools.firstOrNull { it.id == candidate?.tool }
                val validProvider = tool != null && (!(tool.providerSelectionRequired || candidate?.providerProfile != null) ||
                    tool.providers.any { it.id == candidate?.providerProfile })
                mutableState.update { it.copy(catalog = catalog) }
                val models = if (validProvider && provider != null)
                    port.models(target, candidate.tool, provider)
                    else if (validProvider) tool!!.models else emptyList()
                currentCoroutineContext().ensureActive()
                if (!catalogMatches(generation, target)) return@launch
                val restore = existing == null && candidate != null && validProvider && models.any { it.id == candidate.model }
                mutableState.update { current -> current.copy(catalog = catalog, models = models, catalogLoading = false,
                    draft = if (restore) current.draft?.copy(runtime = candidate) else current.draft,
                    dirty = current.dirty || restore, runtimeRestored = restore ||
                        (current.runtimeRestored && validProvider && models.any { it.id == candidate?.model })) }
                if (restore) scheduleSave()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (generation == catalogGeneration) { showFailure(failure); mutableState.update { it.copy(catalogLoading = false) } } }
        }
    }
    private fun loadIntakeSupport(target: String) {
        if (!port.supportsIntake) return
        intakeJob?.cancel()
        val generation = ++intakeGeneration
        mutableState.update { it.copy(intakeObservation = CaptureIntakeObservation(target, CaptureIntakeStatus.CHECKING)) }
        intakeJob = viewModelScope.launch {
            val status = try {
                if (port.checkIntakeSupport(target)) CaptureIntakeStatus.SUPPORTED else CaptureIntakeStatus.UNSUPPORTED
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { CaptureIntakeStatus.UNAVAILABLE }
            if (generation == intakeGeneration && !state.value.close && state.value.draft?.targetInstanceId == target &&
                state.value.directory.computers.any { it.instanceId == target })
                mutableState.update { it.copy(intakeObservation = CaptureIntakeObservation(target, status)) }
        }
    }
    private fun catalogMatches(generation: Long, target: String) = generation == catalogGeneration &&
        !state.value.close && state.value.draft?.operationId == null && state.value.draft?.targetInstanceId == target &&
        state.value.directory.computers.any { it.instanceId == target }
    private fun loadModels() {
        val draft = state.value.draft ?: return
        val target = draft.targetInstanceId ?: return
        val runtime = draft.runtime ?: return
        val provider = runtime.providerProfile ?: return
        val generation = invalidateCatalogJob()
        mutableState.update { it.copy(models = emptyList(), catalogLoading = true, error = null) }
        catalogJob = viewModelScope.launch {
            try {
                val models = port.models(target, runtime.tool, provider)
                currentCoroutineContext().ensureActive()
                if (catalogMatches(generation, target)) mutableState.update { it.copy(models = models, catalogLoading = false) }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (generation == catalogGeneration) { showFailure(failure); mutableState.update { it.copy(catalogLoading = false) } } }
        }
    }

    private fun perform(block: suspend () -> Unit) {
        if (state.value.busy || state.value.loading) return
        invalidateConnectionCheck(clearObservation = false)
        mutableState.update { it.copy(busy = true, error = null) }
        action = viewModelScope.launch {
            try { block() }
            catch (cancelled: CancellationException) {
                withContext(NonCancellable) { state.value.draft?.operationId?.let { readLocalOperation(it) } }
                if (!closing && selectionMode != CaptureSelectionMode.NONE && messageMayBeAccepted()) detachSelection()
                throw cancelled
            } catch (failure: Exception) {
                showFailure(failure)
                // A lost commit reply must also release the selected-text source.
                if (selectionMode != CaptureSelectionMode.NONE) {
                    state.value.draft?.operationId?.let { readLocalOperation(it) }
                    if (messageMayBeAccepted()) detachSelection()
                }
            }
            finally { mutableState.update { it.copy(busy = false) } }
        }
    }
    private suspend fun submit(continueInBackground: Boolean = false) {
        flush()
        var current = state.value.draft ?: return
        if (current.operationId == null && port.supportsIntake) {
            val target = current.targetInstanceId ?: fail(ApiErrorCode.TARGET_NOT_FOUND)
            if (!port.checkIntakeSupport(target)) {
                mutableState.update { it.copy(intakeObservation = CaptureIntakeObservation(target, CaptureIntakeStatus.UNSUPPORTED)) }
                fail(ApiErrorCode.CAPABILITY_UNSUPPORTED)
            }
            try { current = routeIntake(current) ?: return }
            catch (failure: AppApiException) {
                if (failure.error.code == ApiErrorCode.CAPABILITY_UNSUPPORTED)
                    mutableState.update { it.copy(intakeObservation = CaptureIntakeObservation(target, CaptureIntakeStatus.UNSUPPORTED)) }
                throw failure
            }
        }
        if (current.operationId == null) saveLock.withLock {
            current = current.freezeForSubmission(now())
            if (!port.drafts.replace(current, port.caller, persisted!!.revision)) fail(ApiErrorCode.REVISION_CONFLICT)
            persisted = current
            mutableState.update { it.copy(draft = current, dirty = false) }
        }
        // Replaying prepare also repairs the crash window between operation creation and draft binding.
        val prepared = port.prepare(current.toTaskRequest())
        if (current.preparationId == null) saveLock.withLock {
            current = current.bindPreparation(prepared, now())
            if (!port.drafts.replace(current, port.caller, persisted!!.revision)) fail(ApiErrorCode.REVISION_CONFLICT)
            persisted = current
            mutableState.update { it.copy(draft = current) }
        }
        val before = port.operation(current.operationId!!)
        if (continueInBackground) {
            port.scheduleBackgroundDelivery(current.operationId!!)
            mutableState.update { it.copy(operation = before, backgroundDeliveryScheduled = true, close = true) }
            return
        }
        val observingUpload = java.util.concurrent.atomic.AtomicBoolean(true)
        val receipt = if (before.stage == OperationStage.SUBMITTING) port.reconcile(before.operationId)
            else try { port.commit(prepared.preparationId) { progress ->
                mutableState.update { state ->
                    if (observingUpload.get() && state.busy && !state.close && state.draft?.operationId == progress.operationId &&
                        state.draft.targetInstanceId == progress.targetInstanceId &&
                        state.draft.input.resources.any { it.resourceId == progress.resourceId })
                        state.copy(uploadProgress = progress) else state
                }
            } } finally { observingUpload.set(false); mutableState.update { it.copy(uploadProgress = null) } }
        mutableState.update { it.copy(operation = receipt, error = receipt.lastError?.code) }
        if (selectionMode != CaptureSelectionMode.NONE && messageMayBeAccepted()) awaitSelectionResult()
    }

    private suspend fun persistIntake(change: (CaptureDraft) -> CaptureDraft): CaptureDraft = saveLock.withLock {
        val previous = persisted ?: fail(ApiErrorCode.RESOURCE_NOT_FOUND)
        val current = state.value.draft ?: fail(ApiErrorCode.RESOURCE_NOT_FOUND)
        if (current.operationId != null || current.revision != previous.revision) fail(ApiErrorCode.REVISION_CONFLICT)
        val next = change(current).copy(revision = previous.revision + 1,
            updatedAt = maxOf(now(), previous.updatedAt))
        if (!port.drafts.replace(next, port.caller, previous.revision)) fail(ApiErrorCode.REVISION_CONFLICT)
        persisted = next
        mutableState.update { it.copy(draft = next, dirty = false) }
        next
    }

    /** Persist each boundary before calling the PC again; retries keep the same creation identity. */
    private suspend fun routeIntake(original: CaptureDraft): CaptureDraft? {
        val coordinator = IntakeCoordinator(port)
        var current = original
        if (current.intakeId == null) current = persistIntake { it.copy(intakeId = "intake_${newId().replace('-', '_')}") }
        var decision = current.intakeDecision
        if (decision == null || decision.decision in setOf("wait_context", "needs_clarification")) {
            decision = coordinator.prepare(current)
            current = persistIntake { it.copy(intakeDecision = decision) }
        }
        if (decision.decision in setOf("wait_context", "needs_clarification")) return null
        if (decision.decision == "use_existing") {
            val projectId = decision.projectId?.takeIf { it.isNotBlank() }
                ?: throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Existing Project identity is missing"))
            if (current.projectId != projectId || current.existingSessionId != decision.existingSessionId) {
                current = persistIntake { it.copy(projectId = projectId, existingSessionId = decision.existingSessionId) }
            }
            return current
        }
        if (decision.decision != "create_new") fail(ApiErrorCode.REVISION_CONFLICT)
        if (current.projectCreationOperationId == null) current = persistIntake {
            it.copy(projectCreationOperationId = "project_${requireNotNull(it.intakeId)}")
        }
        if (current.projectId == null) {
            val receipt = coordinator.ensure(current)
            current = persistIntake { it.copy(projectId = receipt.projectId) }
        }
        return current
    }
    private fun messageMayBeAccepted() = state.value.operation?.stage in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)

    private fun detachSelection() {
        mutableState.update { it.copy(viewSavedTask = true, replacementText = null, close = true) }
    }

    /** Bounded wait for this exact submission. Never waits for the entire PC Run. */
    private suspend fun awaitSelectionResult() {
        if (selectionMode == CaptureSelectionMode.READ_ONLY) { detachSelection(); return }
        val id = state.value.draft?.operationId ?: return
        val ready = withTimeoutOrNull(SELECTION_WAIT_MS) {
            while (true) {
                val current = port.readResult(id)
                mutableState.update { it.copy(operation = current, error = current.lastError?.code) }
                val result = current.result
                if (current.lastError != null) return@withTimeoutOrNull false
                if (result?.state in setOf(TaskResultState.READY, TaskResultState.FAILED, TaskResultState.CANCELLED)) {
                    return@withTimeoutOrNull selectionText(state.value.draft, current) != null
                }
                delay(750)
            }
            @Suppress("UNREACHABLE_CODE") false
        } == true
        if (!ready) detachSelection()
    }
    private suspend fun readLocalOperation(id: String) {
        try { val operation = port.operation(id); mutableState.update { it.copy(operation = operation, error = operation.lastError?.code) } }
        catch (failure: AppApiException) { if (failure.error.code != ApiErrorCode.RESOURCE_NOT_FOUND) showFailure(failure) }
        catch (failure: Exception) { showFailure(failure) }
    }
    private suspend fun copyAsNew() {
        val original = state.value.draft ?: return
        val timestamp = now()
        val copy = original.copy(draftId = newId(), createdAt = timestamp, updatedAt = timestamp, revision = 0,
            operationId = null, preparationId = null, intakeId = null, intakeDecision = null,
            projectCreationOperationId = null, projectId = null, existingSessionId = null)
        if (!port.drafts.insert(copy, port.caller)) fail(ApiErrorCode.REVISION_CONFLICT)
        persisted = copy
        mutableState.update { it.copy(draft = copy, operation = null, dirty = false, error = null, replacementText = null) }
        loadCatalog()
    }
    private fun close() {
        if (state.value.close || closing) return
        closing = true
        invalidateCatalogJob()
        invalidateConnectionCheck(clearObservation = true)
        connectionExpiries.values.forEach(Job::cancel)
        connectionExpiries.clear()
        val waiting = action
        waiting?.cancel()
        mutableState.update { it.copy(busy = true) }
        action = viewModelScope.launch {
            try {
                waiting?.join(); mutableState.update { it.copy(busy = true) }; flush()
                if (selectionMode != CaptureSelectionMode.NONE && messageMayBeAccepted()) detachSelection()
                else mutableState.update { it.copy(close = true, replacementText = null) }
            }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { showFailure(failure) }
            finally { closing = false; mutableState.update { it.copy(busy = false) } }
        }
    }
    private var closing = false
    private fun showFailure(failure: Exception) { mutableState.update { it.copy(error = (failure as? AppApiException)?.error?.code ?: ApiErrorCode.INTERNAL_ERROR) } }
    private fun fail(code: ApiErrorCode): Nothing = throw AppApiException(ApiError(code, "Capture workflow could not continue"))
    companion object {
        const val SELECTION_WAIT_MS = 8_000L
        const val CONNECTION_CHECK_MS = 15_000L
        const val CONNECTION_FRESH_MS = 60_000L
    }
}

data class DraftInboxUiState(val loading: Boolean = true, val drafts: List<CaptureDraft> = emptyList(), val deleting: Boolean = false, val error: ApiErrorCode? = null)
class DraftInboxViewModel(private val port: CaptureWorkflowPort) : ViewModel() {
    private val mutableState = MutableStateFlow(DraftInboxUiState())
    val state = mutableState.asStateFlow()
    private var observation: Job? = null
    init { reload() }
    fun reload() {
        observation?.cancel()
        observation = viewModelScope.launch {
            try { port.drafts.observe(port.caller).collect { drafts -> mutableState.update { it.copy(loading = false, drafts = drafts, error = null) } } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { mutableState.update { it.copy(loading = false, error = ApiErrorCode.INTERNAL_ERROR) } }
        }
    }
    fun delete(draft: CaptureDraft) {
        if (state.value.deleting || draft.operationId != null) return
        mutableState.update { it.copy(deleting = true, error = null) }
        viewModelScope.launch {
            try { if (!port.drafts.delete(draft.draftId, port.caller, draft.revision)) mutableState.update { it.copy(error = ApiErrorCode.REVISION_CONFLICT) } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { mutableState.update { it.copy(error = ApiErrorCode.INTERNAL_ERROR) } }
            finally { mutableState.update { it.copy(deleting = false) } }
        }
    }
}
