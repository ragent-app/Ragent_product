package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.core.datastore.*
import com.andysagent.ragent.core.model.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class CaptureWorkflowTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private val modelChoice = RuntimeModelOption("model", "Model")
    private val catalog = RuntimeCatalog(listOf(RuntimeToolOption("tool", "Tool", models = listOf(modelChoice))))
    private class MemoryDrafts : CaptureDraftStore {
        val rows = MutableStateFlow<List<CaptureDraft>>(emptyList())
        var replacementGate: CompletableDeferred<Unit>? = null
        var reject = false
        override fun observe(caller: VerifiedCaller, limit: Int) = rows.map { list -> list.filter { it.callerBinding == caller.binding }.take(limit) }
        override suspend fun get(draftId: String, caller: VerifiedCaller) = rows.value.firstOrNull { it.draftId == draftId && it.callerBinding == caller.binding }
        override suspend fun getByOperationId(operationId: String, caller: VerifiedCaller) = rows.value.firstOrNull { it.operationId == operationId && it.callerBinding == caller.binding }
        override suspend fun insert(draft: CaptureDraft, caller: VerifiedCaller): Boolean {
            if (get(draft.draftId, caller) != null) return false
            rows.value += draft; return true
        }
        override suspend fun replace(draft: CaptureDraft, caller: VerifiedCaller, expectedRevision: Long): Boolean {
            replacementGate?.await()
            val old = get(draft.draftId, caller) ?: return false
            if (reject || old.revision != expectedRevision) return false
            rows.value = rows.value.map { if (it.draftId == draft.draftId) draft else it }; return true
        }
        override suspend fun delete(draftId: String, caller: VerifiedCaller, expectedRevision: Long): Boolean {
            val old = get(draftId, caller) ?: return false
            if (old.operationId != null || old.revision != expectedRevision) return false
            rows.value = rows.value.filterNot { it == old }; return true
        }
    }
    private inner class Port : CaptureWorkflowPort {
        override val caller = VerifiedCaller("owner")
        override val drafts = MemoryDrafts()
        override var supportsBackgroundDelivery = false
        val computers = listOf(LinkedComputer("a", "", "Office"), LinkedComputer("b", "", "Home"))
        val snapshot = MutableStateFlow(ComputerDirectory(computers, "a", AppApiRoutingPreferences(defaultShareTargetId = "b")))
        override val directory = snapshot
        var smartIntake = false
        override val supportsIntake get() = smartIntake
        val supportChecks = mutableListOf<String>()
        var supportBlock: suspend (String) -> Boolean = { true }
        override suspend fun checkIntakeSupport(targetId: String): Boolean {
            supportChecks += targetId
            return supportBlock(targetId)
        }
        var intakeCalls = 0
        var ensureCalls = 0
        var intakeBlock: (suspend (IntakeInput) -> IntakeDecision)? = null
        var ensureBlock: (suspend (IntakeEnsureRequest) -> IntakeProjectReceipt)? = null
        override suspend fun prepareIntake(input: IntakeInput, runtime: TaskRuntime): IntakeDecision {
            intakeCalls++
            return requireNotNull(intakeBlock).invoke(input)
        }
        override suspend fun ensureIntakeProject(request: IntakeEnsureRequest): IntakeProjectReceipt {
            ensureCalls++
            return requireNotNull(ensureBlock).invoke(request)
        }
        var operation: TaskOperation? = null
        val catalogTargets = mutableListOf<String>()
        var modelLoads = 0
        var catalogBlock: (suspend (String) -> RuntimeCatalog)? = null
        var modelsBlock: (suspend (String, String, String) -> List<RuntimeModelOption>)? = null
        val remembered = mutableListOf<Pair<String, TaskRuntime>>()
        override suspend fun rememberRuntime(targetId: String, runtime: TaskRuntime) {
            remembered += targetId to runtime
            snapshot.value = snapshot.value.copy(shareRuntimeSelections = snapshot.value.shareRuntimeSelections +
                (targetId to ShareRuntimeSelection(runtime.tool, runtime.providerProfile, runtime.model!!)))
        }
        val prepared = mutableListOf<TaskRequest>()
        var commits = 0
        var commitStage = OperationStage.ACCEPTED
        var cancels = 0
        var reconciles = 0
        var commitGate: CompletableDeferred<Unit>? = null
        var uploadObserver: ((TaskUploadProgress) -> Unit)? = null
        var prepareBusy = false
        var failBindingOnce = false
        var importCalls = 0; var restoreCalls = 0
        var hint = CaptureInitialTarget(); var hintCalls = 0; var pins = 0
        var resultReads = 0; var resultGate: CompletableDeferred<Unit>? = null
        var resultTransform: (TaskResultSnapshot) -> TaskResultSnapshot = { it }
        var resultFailure: ApiErrorCode? = null
        var operationFailure: ApiErrorCode? = null
        val connectionChecks = mutableListOf<String>()
        val backgroundSchedules = mutableListOf<String>()
        var backgroundScheduleBlock: suspend (String) -> String = { "consent-$it" }
        override suspend fun scheduleBackgroundDelivery(operationId: String): String {
            backgroundSchedules += operationId
            return backgroundScheduleBlock(operationId)
        }
        var connectionBlock: suspend (String) -> CaptureConnectionStatus = { CaptureConnectionStatus.AVAILABLE }
        override suspend fun checkConnection(targetId: String): CaptureConnectionStatus {
            connectionChecks += targetId
            return connectionBlock(targetId)
        }
        override suspend fun readResult(operationId: String): TaskOperation {
            resultReads++; resultGate?.await()
            resultFailure?.let { throw AppApiException(ApiError(it, "Result unavailable")) }
            operation = operation(operationId).copy(result = resultTransform(TaskResultSnapshot("session", "message", "run", "run",
                TaskResultState.READY, "Exact final text", false, emptyList(), "2026-10-11T00:00:00Z")))
            return operation!!
        }
        override suspend fun initialTarget(): CaptureInitialTarget { hintCalls++; return hint }
        override suspend fun pinTarget(targetId: String): CapturePinResult { pins++; return CapturePinResult.REQUESTED }
        var importBlock: (suspend (CaptureDraft, (CaptureDraft) -> Unit) -> CaptureDraft)? = null
        var progressObserver: ((CaptureImportProgress) -> Unit)? = null
        override suspend fun importInputs(draft: CaptureDraft, onProgress: (CaptureImportProgress) -> Unit,
            onUpdated: (CaptureDraft) -> Unit): CaptureDraft {
            progressObserver = onProgress
            importCalls++; return importBlock?.invoke(draft, onUpdated) ?: draft
        }
        override suspend fun restoreInputs(draft: CaptureDraft): CaptureDraft { restoreCalls++; return drafts.get(draft.draftId, caller)!! }
        override suspend fun catalog(targetId: String): RuntimeCatalog { catalogTargets += targetId; return catalogBlock?.invoke(targetId) ?: catalog }
        override suspend fun models(targetId: String, tool: String, provider: String): List<RuntimeModelOption> {
            modelLoads++
            return modelsBlock?.invoke(targetId, tool, provider) ?: listOf(modelChoice)
        }
        override suspend fun prepare(request: TaskRequest): PreparedTask {
            prepared += request
            if (prepareBusy) throw AppApiException(ApiError(ApiErrorCode.RATE_LIMITED, "Journal in use", true))
            if (operation == null) operation = TaskOperation(request.operationId, caller.binding, "hash", "prep", request.targetInstanceId!!, request, "create", "message", 1, 600_000)
            if (failBindingOnce) { failBindingOnce = false; throw AppApiException(ApiError(ApiErrorCode.INTERNAL_ERROR, "Lost preparation reply")) }
            return operation!!.preparation()
        }
        override suspend fun commit(preparationId: String, onProgress: (TaskUploadProgress) -> Unit): TaskOperation {
            commits++
            uploadObserver = onProgress
            operation = operation!!.copy(stage = OperationStage.SUBMITTING)
            commitGate?.await()
            operation = operation!!.copy(stage = commitStage, sessionId = "session", queued = true)
            return operation!!
        }
        override suspend fun operation(operationId: String): TaskOperation {
            operationFailure?.let { throw AppApiException(ApiError(it, "Operation access revoked")) }
            return operation?.takeIf { it.operationId == operationId }
                ?: throw AppApiException(ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "missing"))
        }
        override suspend fun reconcile(operationId: String): TaskOperation { reconciles++; return operation(operationId) }
        override suspend fun cancelSubmission(operationId: String): TaskOperation {
            val current = operation(operationId)
            if (current.stage in setOf(OperationStage.SUBMITTING, OperationStage.ACCEPTED)) throw AppApiException(ApiError(ApiErrorCode.RESULT_UNKNOWN, "May be accepted"))
            cancels++; operation = current.copy(stage = OperationStage.CANCELLED); return operation!!
        }
    }
    private fun configured(port: Port, selectionMode: CaptureSelectionMode = CaptureSelectionMode.NONE): CaptureViewModel {
        val input = if (selectionMode == CaptureSelectionMode.NONE) CaptureInput("Reference") else
            CaptureInput("Reference", source = CaptureSource.PROCESS_TEXT, selectionReadOnly = selectionMode == CaptureSelectionMode.READ_ONLY)
        val model = CaptureViewModel(port, "draft", input, now = { 10 }, selectionMode = selectionMode)
        runCurrent()
        model.onEvent(CaptureEvent.Instruction("Analyze it"))
        model.onEvent(CaptureEvent.Tool("tool"))
        model.onEvent(CaptureEvent.Model("model"))
        return model
    }
    private fun runCurrent() = dispatcher.scheduler.runCurrent()

    @Test fun explicitCompleteSelectionsAreRememberedPerComputerAndRestoredAfterFreshCatalog() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        assertNull(model.state.value.draft!!.runtime)
        model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model"))
        model.onEvent(CaptureEvent.Target("b")); runCurrent()
        assertEquals(TaskRuntime("tool", model = "model"), model.state.value.draft!!.runtime)
        assertTrue(model.state.value.runtimeRestored)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertEquals(setOf("a", "b"), port.remembered.map { it.first }.toSet())
        val fresh = CaptureViewModel(port, "next", CaptureInput("Next")); runCurrent()
        assertEquals(TaskRuntime("tool", model = "model"), fresh.state.value.draft!!.runtime)
        assertTrue(fresh.state.value.runtimeRestored)
        assertFalse(fresh.state.value.canSubmit) // Restored settings do not provide an instruction.
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun selectingModelBeforeInstructionStillRemembersConfiguration() = runTest(dispatcher) {
        val port = Port(); val model = CaptureViewModel(port, "draft", CaptureInput("Input")); runCurrent()
        model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model"))
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertEquals(listOf("b"), port.remembered.map { it.first })
    }

    @Test fun removedToolProviderOrModelNeverRestoresAnotherConfiguration() = runTest(dispatcher) {
        for (selection in listOf(ShareRuntimeSelection("missing", model = "model"),
            ShareRuntimeSelection("tool", "removed", "model"), ShareRuntimeSelection("tool", model = "removed"))) {
            val port = Port()
            port.snapshot.value = port.snapshot.value.copy(shareRuntimeSelections = mapOf("b" to selection))
            val model = CaptureViewModel(port, "draft", CaptureInput("Input")); runCurrent()
            assertNull(model.state.value.draft!!.runtime)
            assertFalse(model.state.value.runtimeRestored); assertFalse(model.state.value.canSubmit)
            assertEquals(0, port.modelLoads); assertTrue(port.remembered.isEmpty()); assertTrue(port.prepared.isEmpty())
        }
    }

    @Test fun rememberedProviderModelsAreValidatedAndLateOldComputerReplyIsIgnored() = runTest(dispatcher) {
        val port = Port()
        port.snapshot.value = port.snapshot.value.copy(shareRuntimeSelections = mapOf("b" to ShareRuntimeSelection("tool", "provider", "model")))
        port.catalogBlock = { RuntimeCatalog(listOf(RuntimeToolOption("tool", "Tool", providers = listOf(RuntimeProviderOption("provider", "Provider"))))) }
        val gate = CompletableDeferred<List<RuntimeModelOption>>()
        port.modelsBlock = { target, _, _ -> assertEquals("b", target); withContext(NonCancellable) { gate.await() } }
        val model = CaptureViewModel(port, "draft", CaptureInput("Input")); runCurrent()
        assertTrue(model.state.value.catalogLoading); assertNull(model.state.value.draft!!.runtime)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        gate.complete(listOf(modelChoice)); runCurrent()
        assertEquals("a", model.state.value.draft!!.targetInstanceId)
        assertNull(model.state.value.draft!!.runtime); assertFalse(model.state.value.runtimeRestored)
        assertTrue(port.remembered.isEmpty())
    }

    @Test fun storedDraftHasPriorityAndUnavailableProviderCannotUseUnrelatedModels() = runTest(dispatcher) {
        val port = Port()
        val model = configured(port); model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        port.snapshot.value = port.snapshot.value.copy(shareRuntimeSelections = mapOf("b" to ShareRuntimeSelection("missing", model = "other")))
        val restored = CaptureViewModel(port, "draft"); runCurrent()
        assertEquals(TaskRuntime("tool", model = "model"), restored.state.value.draft!!.runtime)
        assertFalse(restored.state.value.runtimeRestored)
        val stale = restored.state.value.copy(draft = restored.state.value.draft!!.copy(runtime = TaskRuntime("tool", "removed", "model")))
        assertFalse(stale.canSubmit)
        assertTrue(port.prepared.isEmpty())
    }

    @Test fun validProviderRestoresOnlyAfterItsModelsReturnAndFailureKeepsPickerUsable() = runTest(dispatcher) {
        val port = Port()
        port.snapshot.value = port.snapshot.value.copy(shareRuntimeSelections = mapOf("b" to ShareRuntimeSelection("tool", "provider", "model")))
        port.catalogBlock = { RuntimeCatalog(listOf(RuntimeToolOption("tool", "Tool", providers = listOf(RuntimeProviderOption("provider", "Provider"))))) }
        port.modelsBlock = { _, _, _ -> throw IllegalStateException("Offline") }
        val model = CaptureViewModel(port, "draft", CaptureInput("Input")); runCurrent()
        assertNull(model.state.value.draft!!.runtime); assertFalse(model.state.value.catalogLoading)
        assertEquals(1, model.state.value.catalog.tools.size)
        assertFalse(model.state.value.canSubmit)
        port.modelsBlock = { _, _, _ -> listOf(modelChoice) }
        model.onEvent(CaptureEvent.ReloadCatalog); runCurrent()
        assertEquals(TaskRuntime("tool", "provider", "model"), model.state.value.draft!!.runtime)
        assertTrue(model.state.value.runtimeRestored)
        assertTrue(port.prepared.isEmpty()); assertTrue(port.remembered.isEmpty())
    }

    @Test fun connectionCheckIsExplicitExpiresWithoutPollingAndDoesNotModifyDraftOrSubmit() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        val saved = port.drafts.rows.value.single()
        assertTrue(port.connectionChecks.isEmpty())
        assertNull(model.state.value.connectionObservation)
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        assertEquals(listOf("b"), port.connectionChecks)
        assertEquals(CaptureConnectionObservation("b", CaptureConnectionStatus.AVAILABLE, 10), model.state.value.connectionObservation)
        assertFalse(model.state.value.connectionObservationStale)
        assertEquals(saved, port.drafts.rows.value.single())
        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.CONNECTION_FRESH_MS + 1); runCurrent()
        assertTrue(model.state.value.connectionObservationStale)
        assertEquals(1, port.connectionChecks.size)
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        assertFalse(model.state.value.connectionObservationStale)
        assertEquals(saved, port.drafts.rows.value.single())
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun connectionChecksArePerComputerAndExpiryDoesNotBleedAcrossTargets() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        val saved = port.drafts.rows.value.single()

        model.onEvent(CaptureEvent.CheckTargetConnection("b")); runCurrent()
        assertEquals(listOf("b"), port.connectionChecks)
        assertEquals(CaptureConnectionStatus.AVAILABLE, model.state.value.connectionObservations["b"]?.status)
        assertNull(model.state.value.connectionObservation)
        assertEquals("a", model.state.value.draft?.targetInstanceId)

        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.CONNECTION_FRESH_MS / 2)
        model.onEvent(CaptureEvent.CheckTargetConnection("a")); runCurrent()
        assertEquals(listOf("b", "a"), port.connectionChecks)
        assertEquals("a", model.state.value.connectionObservation?.targetId)
        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.CONNECTION_FRESH_MS / 2 + 1); runCurrent()
        assertTrue("b" in model.state.value.staleConnectionTargets)
        assertFalse("a" in model.state.value.staleConnectionTargets)
        assertFalse(model.state.value.connectionObservationStale)

        model.onEvent(CaptureEvent.Target("b")); runCurrent()
        assertEquals("b", model.state.value.connectionObservation?.targetId)
        assertTrue(model.state.value.connectionObservationStale)
        assertEquals(saved, port.drafts.rows.value.single())
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun backgroundSubmitRequiresExplicitActionAndSchedulesFrozenOperationWithoutForegroundCommit() = runTest(dispatcher) {
        val port = Port().apply { supportsBackgroundDelivery = true }
        val model = configured(port)
        assertTrue(model.state.value.canSubmit)
        assertTrue(model.state.value.canSubmitInBackground)
        model.onEvent(CaptureEvent.SubmitInBackground); runCurrent()

        val frozen = model.state.value.draft!!
        assertNotNull(frozen.operationId)
        assertNotNull(frozen.preparationId)
        assertEquals(listOf(frozen.operationId), port.backgroundSchedules)
        assertTrue(model.state.value.backgroundDeliveryScheduled)
        assertTrue(model.state.value.close)
        assertEquals(OperationStage.PREPARED, model.state.value.operation?.stage)
        assertEquals(0, port.commits)
        assertEquals(1, port.prepared.size)
    }

    @Test fun backgroundSubmitIsUnavailableForProcessTextThatMustReturnToItsSource() = runTest(dispatcher) {
        val port = Port().apply { supportsBackgroundDelivery = true }
        val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        assertFalse(model.state.value.canSubmitInBackground)
        model.onEvent(CaptureEvent.SubmitInBackground); runCurrent()
        assertTrue(port.backgroundSchedules.isEmpty())
        assertTrue(port.prepared.isEmpty())
        assertEquals(0, port.commits)
    }

    @Test fun failedBackgroundSchedulingKeepsOriginalPreparedOperationForRecovery() = runTest(dispatcher) {
        val port = Port().apply {
            supportsBackgroundDelivery = true
            backgroundScheduleBlock = { throw AppApiException(ApiError(ApiErrorCode.INTERNAL_ERROR, "Scheduler unavailable", true)) }
        }
        val model = configured(port)
        model.onEvent(CaptureEvent.SubmitInBackground); runCurrent()
        assertEquals(1, port.prepared.size)
        assertEquals(1, port.backgroundSchedules.size)
        assertEquals(OperationStage.PREPARED, model.state.value.draft?.operationId?.let { port.operation(it).stage })
        assertFalse(model.state.value.backgroundDeliveryScheduled)
        assertFalse(model.state.value.close)
        assertTrue(model.state.value.error != null)
        assertEquals(0, port.commits)
    }

    @Test fun lateConnectionFromOldTargetAndUnpairedTargetCannotReplaceCurrentObservation() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        val old = CompletableDeferred<CaptureConnectionStatus>()
        var current = CompletableDeferred<CaptureConnectionStatus>()
        port.connectionBlock = { target -> withContext(NonCancellable) { if (target == "b") old.await() else current.await() } }
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        assertEquals(listOf("b"), port.connectionChecks)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        assertNull(model.state.value.connectionObservation)
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        current.complete(CaptureConnectionStatus.AVAILABLE); runCurrent()
        val observed = model.state.value.connectionObservation
        old.complete(CaptureConnectionStatus.UNREACHABLE); runCurrent()
        assertEquals(observed, model.state.value.connectionObservation)
        assertEquals("a", observed!!.targetId)
        current = CompletableDeferred()
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        port.snapshot.value = port.snapshot.value.copy(computers = port.computers.filter { it.instanceId != "a" }); runCurrent()
        current.complete(CaptureConnectionStatus.AVAILABLE); runCurrent()
        assertNull(model.state.value.connectionObservation)
        assertFalse(model.state.value.checkingConnection)
        assertEquals("a", model.state.value.draft!!.targetInstanceId)
        assertTrue(port.prepared.isEmpty())
    }

    @Test fun connectionTimeoutAndCloseKeepExecutionConfigurationAndNeverDispatch() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.connectionBlock = { awaitCancellation() }
        val runtime = model.state.value.draft!!.runtime
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.CONNECTION_CHECK_MS + 1); runCurrent()
        assertEquals(CaptureConnectionStatus.UNREACHABLE, model.state.value.connectionObservation!!.status)
        assertFalse(model.state.value.checkingConnection)
        assertNull(model.state.value.error)
        assertEquals(runtime, model.state.value.draft!!.runtime)
        model.onEvent(CaptureEvent.CheckConnection); runCurrent()
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertTrue(model.state.value.close)
        assertNull(model.state.value.connectionObservation)
        assertFalse(model.state.value.checkingConnection)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun reopeningFrozenDraftDoesNotCheckOrReconnectItsComputer() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val reopened = CaptureViewModel(port, "draft"); runCurrent()
        reopened.onEvent(CaptureEvent.CheckConnection); runCurrent()
        assertTrue(port.connectionChecks.isEmpty())
        assertNull(reopened.state.value.connectionObservation)
        assertFalse(reopened.state.value.canCheckConnection)
        assertEquals(1, port.commits)
    }

    @Test fun uploadProgressRequiresFrozenIdentityAndCannotReappearAfterStopOrCompletion() = runTest(dispatcher) {
        for (stop in listOf(false, true)) {
            val port = Port().apply { commitGate = CompletableDeferred() }
            val ref = CaptureResourceRef("upload", 1, "Report.pdf", "application/pdf", 10, "a".repeat(64))
            val model = CaptureViewModel(port, "draft", CaptureInput(resources = listOf(ref)), now = { 10 })
            runCurrent()
            model.onEvent(CaptureEvent.Instruction("Analyze")); model.onEvent(CaptureEvent.Tool("tool"))
            model.onEvent(CaptureEvent.Model("model")); runCurrent()
            model.onEvent(CaptureEvent.Submit); runCurrent()
            val frozen = model.state.value.draft!!
            val progress = TaskUploadProgress(frozen.operationId!!, frozen.targetInstanceId!!, ref.resourceId,
                ref.originalName, 0, 1, 0, ref.sizeBytes, TaskUploadPhase.TRANSFERRING, ref.sizeBytes, 5)
            val observer = port.uploadObserver!!
            observer(progress.copy(targetInstanceId = "foreign")); assertNull(model.state.value.uploadProgress)
            observer(progress.copy(operationId = "foreign")); assertNull(model.state.value.uploadProgress)
            observer(progress.copy(resourceId = "foreign")); assertNull(model.state.value.uploadProgress)
            observer(progress); assertEquals(progress, model.state.value.uploadProgress)
            assertEquals(frozen, port.drafts.rows.value.single())
            if (stop) model.onEvent(CaptureEvent.StopWaiting) else port.commitGate!!.complete(Unit)
            runCurrent()
            assertNull(model.state.value.uploadProgress)
            observer(progress); assertNull(model.state.value.uploadProgress)
            assertEquals(1, port.commits)
            assertEquals(frozen, port.drafts.rows.value.single())
        }
    }

    @Test fun reselectingCurrentComputerPreservesRuntimeWithoutReloadOrSave() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        val saved = model.state.value.draft
        val requests = port.catalogTargets.toList()
        model.onEvent(CaptureEvent.Target(saved!!.targetInstanceId!!)); runCurrent()
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        assertEquals(saved, model.state.value.draft)
        assertEquals(saved, port.drafts.rows.value.single())
        assertEquals(requests, port.catalogTargets)
        assertTrue(model.state.value.canSubmit)
        assertFalse(model.state.value.dirty)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun reselectingCurrentToolPreservesModelWithoutSave() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        val saved = model.state.value.draft
        model.onEvent(CaptureEvent.Tool("tool")); runCurrent()
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        assertEquals(saved, model.state.value.draft)
        assertEquals(saved, port.drafts.rows.value.single())
        assertTrue(model.state.value.canSubmit)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun reselectingCurrentProviderPreservesModelWithoutReloadOrSave() = runTest(dispatcher) {
        val port = Port()
        port.catalogBlock = { RuntimeCatalog(listOf(RuntimeToolOption("tool", "Tool",
            providers = listOf(RuntimeProviderOption("one", "One"), RuntimeProviderOption("two", "Two"))))) }
        val model = configured(port)
        model.onEvent(CaptureEvent.Provider("one")); runCurrent()
        model.onEvent(CaptureEvent.Model("model"))
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        val saved = model.state.value.draft
        val requests = port.modelLoads
        model.onEvent(CaptureEvent.Provider("one")); runCurrent()
        dispatcher.scheduler.advanceTimeBy(301); runCurrent()
        assertEquals(saved, model.state.value.draft)
        assertEquals(saved, port.drafts.rows.value.single())
        assertEquals(requests, port.modelLoads)
        assertTrue(model.state.value.canSubmit)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun changingParentSelectionStillInvalidatesDependentConfiguration() = runTest(dispatcher) {
        val port = Port()
        port.catalogBlock = { RuntimeCatalog(listOf(
            RuntimeToolOption("tool", "Tool", providers = listOf(RuntimeProviderOption("one", "One"), RuntimeProviderOption("two", "Two"))),
            RuntimeToolOption("other", "Other", models = listOf(modelChoice)))) }
        val model = configured(port)
        model.onEvent(CaptureEvent.Provider("one")); runCurrent()
        model.onEvent(CaptureEvent.Model("model"))
        assertTrue(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Provider("two")); runCurrent()
        assertNull(model.state.value.draft!!.runtime!!.model)
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Model("model"))
        model.onEvent(CaptureEvent.Tool("other")); runCurrent()
        assertNull(model.state.value.draft!!.runtime!!.providerProfile)
        assertNull(model.state.value.draft!!.runtime!!.model)
        model.onEvent(CaptureEvent.Model("model"))
        assertTrue(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        assertEquals("a", model.state.value.draft!!.targetInstanceId)
        assertNull(model.state.value.draft!!.runtime)
        assertEquals(listOf("b", "a"), port.catalogTargets)
        assertFalse(model.state.value.canSubmit)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun selectedTextRequiresExplicitSubmitAndExplicitReturnOfCompleteResult() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        assertEquals(0, port.commits); assertEquals(0, port.resultReads)
        model.onEvent(CaptureEvent.ReturnSelection); runCurrent(); assertFalse(model.state.value.close)
        model.onEvent(CaptureEvent.SourceText("Edited source"))
        assertEquals(false, model.state.value.draft!!.input.selectionReadOnly)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.commits); assertEquals(1, port.resultReads)
        assertTrue(model.state.value.canReturnSelection); assertFalse(model.state.value.close)
        assertNull(model.state.value.replacementText)
        model.onEvent(CaptureEvent.ReturnSelection); runCurrent()
        assertTrue(model.state.value.close); assertFalse(model.state.value.viewSavedTask)
        assertEquals("Exact final text", model.state.value.replacementText)
        assertEquals("b", model.state.value.operation!!.targetInstanceId)
    }

    @Test fun readonlySelectionDetachesAcceptedTaskWithoutQueryOrReplacement() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.READ_ONLY)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.commits); assertEquals(0, port.resultReads)
        assertTrue(model.state.value.close); assertTrue(model.state.value.viewSavedTask)
        assertNull(model.state.value.replacementText); assertEquals(0, port.cancels)
        assertEquals("capture_draft", port.drafts.rows.value.single().operationId)
    }

    @Test fun entireResultLookupBudgetIsBoundedAndDoesNotCancelRemoteWork() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        port.resultGate = CompletableDeferred()
        model.onEvent(CaptureEvent.Submit); runCurrent()
        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.SELECTION_WAIT_MS - 1); runCurrent()
        assertFalse(model.state.value.close); assertTrue(model.state.value.busy)
        dispatcher.scheduler.advanceTimeBy(1); runCurrent()
        assertTrue(model.state.value.close); assertTrue(model.state.value.viewSavedTask)
        assertNull(model.state.value.replacementText); assertEquals(1, port.resultReads)
        assertEquals(1, port.commits); assertEquals(0, port.cancels)
    }

    @Test fun queuedTaskPollsSameIdentityAndDetachesAtBudgetWithoutResubmit() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        port.resultTransform = { it.copy(state = TaskResultState.QUEUED, runId = null, finalRunId = null, text = null) }
        model.onEvent(CaptureEvent.Submit); runCurrent()
        dispatcher.scheduler.advanceTimeBy(CaptureViewModel.SELECTION_WAIT_MS); runCurrent()
        assertTrue(port.resultReads > 1); assertEquals(1, port.commits)
        assertTrue(model.state.value.viewSavedTask); assertFalse(model.state.value.canReturnSelection)
        assertEquals("message", model.state.value.operation!!.messageRequestId)
    }

    @Test fun truncatedAttachmentEmptyFailedAndCancelledResultsNeverReplaceSelection() = runTest(dispatcher) {
        val transforms: List<(TaskResultSnapshot) -> TaskResultSnapshot> = listOf(
            { it.copy(textTruncated = true) }, { it.copy(hasAttachments = true) }, { it.copy(text = "") },
            { it.copy(requestId = "other-request") }, { it.copy(sessionId = "other-session") },
            { it.copy(text = "x".repeat(48 * 1024 + 1)) },
            { it.copy(state = TaskResultState.FAILED, text = null, finalRunId = null) },
            { it.copy(state = TaskResultState.CANCELLED, text = null, finalRunId = null) })
        transforms.forEach { transform ->
            val port = Port(); port.resultTransform = transform
            val model = configured(port, CaptureSelectionMode.REPLACEABLE)
            model.onEvent(CaptureEvent.Submit); runCurrent()
            model.onEvent(CaptureEvent.ReturnSelection); runCurrent()
            assertTrue(model.state.value.viewSavedTask); assertNull(model.state.value.replacementText)
            assertEquals(1, port.commits); assertEquals(0, port.cancels)
        }
    }

    @Test fun stoppedSelectionWaitingAndLostResultDetachWithoutCancellingOrResubmitting() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        port.commitGate = CompletableDeferred()
        model.onEvent(CaptureEvent.Submit); runCurrent()
        model.onEvent(CaptureEvent.StopWaiting); runCurrent()
        assertTrue(model.state.value.close); assertTrue(model.state.value.viewSavedTask)
        assertEquals(OperationStage.SUBMITTING, model.state.value.operation!!.stage)
        assertNull(model.state.value.replacementText); assertEquals(0, port.cancels)
        val lost = Port(); lost.resultFailure = ApiErrorCode.AUTHENTICATION_REQUIRED
        val lostModel = configured(lost, CaptureSelectionMode.REPLACEABLE)
        lostModel.onEvent(CaptureEvent.Submit); runCurrent()
        assertTrue(lostModel.state.value.viewSavedTask); assertNull(lostModel.state.value.replacementText)
        assertEquals(1, lost.commits)
    }

    @Test fun coldSelectionRestoreDetachesLocallyAndInboxNeverInheritsReturnChannel() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val frozen = port.drafts.rows.value.single()
        val restored = CaptureViewModel(port, frozen.draftId, selectionMode = CaptureSelectionMode.REPLACEABLE); runCurrent()
        assertTrue(restored.state.value.viewSavedTask); assertNull(restored.state.value.replacementText)
        val inbox = CaptureViewModel(port, frozen.draftId); runCurrent()
        inbox.onEvent(CaptureEvent.ReturnSelection); runCurrent()
        assertFalse(inbox.state.value.close); assertFalse(inbox.state.value.canReturnSelection)
        assertEquals(1, port.resultReads); assertEquals(1, port.commits)
    }

    @Test fun revocationBeforeExplicitReturnAndCloseNeverReturnStaleText() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        port.snapshot.value = port.snapshot.value.copy(computers = port.computers.filterNot { it.instanceId == "b" }); runCurrent()
        model.onEvent(CaptureEvent.ReturnSelection); runCurrent()
        assertNull(model.state.value.replacementText); assertFalse(model.state.value.close)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertTrue(model.state.value.viewSavedTask); assertNull(model.state.value.replacementText)
    }

    @Test fun returnReauthorizesOperationAndRevokedAccessCannotDeliverOldResult() = runTest(dispatcher) {
        val port = Port(); val model = configured(port, CaptureSelectionMode.REPLACEABLE)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertTrue(model.state.value.canReturnSelection)
        port.operationFailure = ApiErrorCode.PERMISSION_DENIED
        model.onEvent(CaptureEvent.ReturnSelection); runCurrent()
        assertTrue(model.state.value.close); assertTrue(model.state.value.viewSavedTask)
        assertNull(model.state.value.replacementText); assertEquals(ApiErrorCode.PERMISSION_DENIED, model.state.value.error)
        assertEquals(1, port.commits); assertEquals(1, port.resultReads)
    }

    @Test fun intakeUsesSharingDefaultAndNeverOpenUiTargetOrAutoSubmits() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        assertEquals("b", model.state.value.draft!!.targetInstanceId)
        assertEquals(listOf("b"), port.catalogTargets)
        assertTrue(model.state.value.canSubmit)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertTrue(model.state.value.close)
        assertEquals("Analyze it", port.drafts.rows.value.single().instruction)
        assertNull(port.drafts.rows.value.single().operationId)
    }
    @Test fun duplicateSubmitFreezesLatestEditAndQueuedReceiptIsPreserved() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.commitGate = CompletableDeferred()
        model.onEvent(CaptureEvent.Instruction("Latest instruction"))
        model.onEvent(CaptureEvent.Submit); model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.commits)
        assertEquals("Latest instruction", port.operation!!.request.instruction)
        model.onEvent(CaptureEvent.Target("a")); model.onEvent(CaptureEvent.Instruction("Changed"))
        port.snapshot.value = port.snapshot.value.copy(activeTargetId = "b"); runCurrent()
        assertEquals("b", port.operation!!.targetInstanceId)
        port.commitGate!!.complete(Unit); runCurrent()
        assertTrue(model.state.value.operation!!.queued)
        assertEquals(OperationStage.ACCEPTED, model.state.value.operation!!.stage)
        model.onEvent(CaptureEvent.Submit); runCurrent(); assertEquals(1, port.commits)
    }

    @Test fun editingSourcePreservesFilesAndRemovalBeforeFreezeCannotChangeFrozenSubmission() = runTest(dispatcher) {
        val port = Port()
        val first = CaptureResourceRef("first", 1, "first.csv", "text/csv", 4, "a".repeat(64))
        val second = first.copy(resourceId = "second", originalName = "second.csv")
        val model = CaptureViewModel(port, "draft", CaptureInput("Reference", resources = listOf(first, second)), now = { 10 })
        runCurrent()
        model.onEvent(CaptureEvent.SourceText("Updated https://example.com"))
        assertEquals(listOf(first, second), model.state.value.draft!!.input.resources)
        model.onEvent(CaptureEvent.RemoveResource(first.resourceId))
        model.onEvent(CaptureEvent.Instruction("Analyze files"))
        model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model"))
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(listOf(second), port.prepared.single().resources)
        model.onEvent(CaptureEvent.RemoveResource(second.resourceId))
        assertEquals(listOf(second), model.state.value.draft!!.input.resources)
        assertEquals(listOf(second), port.operation!!.request.resources)
    }

    @Test fun pendingOrFailedImportDisablesSubmitAndOnlyExplicitRemovalCanProceed() = runTest(dispatcher) {
        val port = Port()
        val slot = CaptureImportSlot("missing", error = ApiErrorCode.PERMISSION_DENIED)
        val model = CaptureViewModel(port, "draft", CaptureInput("Reference", imports = listOf(slot)), now = { 10 })
        runCurrent()
        model.onEvent(CaptureEvent.Instruction("Analyze")); model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model"))
        model.onEvent(CaptureEvent.SourceText("Edited reference https://example.com"))
        assertEquals(listOf(slot), model.state.value.draft!!.input.imports)
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent(); assertTrue(port.prepared.isEmpty())
        assertEquals(1, port.importCalls)
        model.onEvent(CaptureEvent.RemoveImport(slot.resourceId)); assertTrue(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.commits)
        assertTrue(port.operation!!.request.resources.isEmpty())
    }

    @Test fun recreatedDraftOnlyRestoresLocalAllocationsAndNeverRereadsIncomingSource() = runTest(dispatcher) {
        val port = Port()
        port.drafts.insert(CaptureDraft("draft", port.caller.binding, 1,
            input = CaptureInput("Saved", imports = listOf(CaptureImportSlot("pending")))), port.caller)
        val model = CaptureViewModel(port, "draft", CaptureInput("Replacement input")); runCurrent()
        assertEquals(0, port.importCalls); assertEquals(1, port.restoreCalls)
        assertEquals("Saved", model.state.value.draft!!.input.sharedText)
        assertFalse(model.state.value.busy); assertFalse(model.state.value.canSubmit)
        assertEquals(0, port.commits)
    }

    @Test fun closingDuringImportCancelsLocalCopyAndPreservesDraftWithoutSubmitting() = runTest(dispatcher) {
        val port = Port(); val entered = CompletableDeferred<Unit>()
        port.importBlock = { _, _ -> entered.complete(Unit); awaitCancellation() }
        val model = CaptureViewModel(port, "draft", CaptureInput(imports = listOf(CaptureImportSlot("pending")))); runCurrent()
        assertTrue(entered.isCompleted); assertTrue(model.state.value.busy)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertTrue(model.state.value.close)
        assertFalse(model.state.value.busy)
        assertEquals(1, port.restoreCalls); assertEquals(0, port.commits)
        assertEquals(1, port.drafts.rows.value.single().input.imports.size)
    }

    @Test fun importProgressIsTransientBoundToPendingMaterialAndClearedOnClose() = runTest(dispatcher) {
        val port = Port()
        port.importBlock = { _, _ -> awaitCancellation() }
        val model = CaptureViewModel(port, "progress", CaptureInput(imports = listOf(CaptureImportSlot("pending")))); runCurrent()
        val update = port.progressObserver!!
        val progress = CaptureImportProgress("pending", "Report.pdf", 5, 10)
        update(progress.copy(resourceId = "foreign"))
        assertNull(model.state.value.importProgress)
        update(progress)
        assertEquals(progress, model.state.value.importProgress)
        assertTrue(model.state.value.busy); assertFalse(model.state.value.canSubmit)
        assertNull(port.drafts.rows.value.single().input.imports.single().name)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertTrue(model.state.value.close); assertNull(model.state.value.importProgress)
        update(progress.copy(copiedBytes = 10))
        assertNull(model.state.value.importProgress)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }

    @Test fun readyMaterialDropsProgressBeforeNextImportAndFailureClearsIt() = runTest(dispatcher) {
        val port = Port(); val gate = CompletableDeferred<Unit>()
        port.importBlock = { draft, updated ->
            port.progressObserver!!(CaptureImportProgress("first", "First.pdf", 10, 10, CaptureImportPhase.SAVING))
            gate.await()
            val ready = draft.copy(revision = draft.revision + 1, input = draft.input.copy(
                imports = listOf(CaptureImportSlot("second")),
                resources = listOf(CaptureResourceRef("first", 1, "First.pdf", "application/pdf", 10, "a".repeat(64)))))
            port.drafts.replace(ready, port.caller, draft.revision)
            updated(ready)
            awaitCancellation()
        }
        val model = CaptureViewModel(port, "progress", CaptureInput(imports = listOf(CaptureImportSlot("first"), CaptureImportSlot("second")))); runCurrent()
        assertEquals(CaptureImportPhase.SAVING, model.state.value.importProgress!!.phase)
        assertTrue(model.state.value.draft!!.input.resources.isEmpty())
        gate.complete(Unit); runCurrent()
        assertNull(model.state.value.importProgress)
        port.progressObserver!!(CaptureImportProgress("first", "First.pdf", 10, 10))
        assertNull(model.state.value.importProgress)
        port.progressObserver!!(CaptureImportProgress("second", "Second.pdf", 2, null))
        assertEquals("second", model.state.value.importProgress!!.resourceId)
        model.onEvent(CaptureEvent.StopWaiting); runCurrent()
        assertNull(model.state.value.importProgress); assertFalse(model.state.value.busy)
        val restored = CaptureViewModel(port, "progress"); runCurrent()
        assertNull(restored.state.value.importProgress)
        assertEquals(1, port.importCalls)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.commits)
    }
    @Test fun busyExecutorKeepsFrozenIdentityAndRestoringDoesNotDispatch() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.prepareBusy = true
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val frozen = port.drafts.rows.value.single()
        assertEquals(ApiErrorCode.RATE_LIMITED, model.state.value.error)
        assertEquals("capture_draft", frozen.operationId)
        assertNull(frozen.preparationId); assertEquals(0, port.commits)
        val restored = CaptureViewModel(port, frozen.draftId, now = { 20 }); runCurrent()
        assertEquals(1, port.prepared.size); assertEquals(0, port.commits)
        port.prepareBusy = false
        restored.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(port.prepared[0], port.prepared[1])
        assertEquals(frozen.operationId, port.drafts.rows.value.single().operationId)
        assertEquals(1, port.commits)
    }

    @Test fun preparationReplyLossRestoresFrozenIdentityAndOnlyExplicitResumeCommits() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.failBindingOnce = true
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val frozen = port.drafts.rows.value.single()
        assertEquals("capture_draft", frozen.operationId); assertNull(frozen.preparationId)
        val restored = CaptureViewModel(port, frozen.draftId, now = { 20 }); runCurrent()
        assertEquals(0, port.commits)
        assertEquals(1, port.catalogTargets.size) // No connection during frozen restoration.
        restored.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.commits)
        assertEquals(port.prepared[0], port.prepared[1])
        assertEquals("prep", port.drafts.rows.value.single().preparationId)
    }
    @Test fun stoppingWaitPreservesUnknownReceiptAndCheckDoesNotResend() = runTest(dispatcher) {
        val port = Port(); val model = configured(port); port.commitGate = CompletableDeferred()
        model.onEvent(CaptureEvent.Submit); runCurrent()
        model.onEvent(CaptureEvent.StopWaiting); runCurrent()
        assertEquals(OperationStage.SUBMITTING, model.state.value.operation!!.stage)
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.CheckReceipt); runCurrent()
        assertEquals(1, port.reconciles); assertEquals(1, port.commits)
        val restored = CaptureViewModel(port, "draft"); runCurrent()
        assertEquals(OperationStage.SUBMITTING, restored.state.value.operation!!.stage)
        assertEquals(1, port.commits)
    }
    @Test fun latestKeystrokeDuringSaveIsFlushedBeforeCloseAndRevisionConflictDoesNotSend() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.drafts.replacementGate = CompletableDeferred()
        advanceTimeBy(301); runCurrent()
        model.onEvent(CaptureEvent.Instruction("Edited while saving")); runCurrent()
        port.drafts.replacementGate!!.complete(Unit); runCurrent()
        assertEquals("Edited while saving", port.drafts.rows.value.single().instruction)
        assertFalse(model.state.value.dirty)
        model.onEvent(CaptureEvent.Instruction("Final")); port.drafts.reject = true
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(ApiErrorCode.REVISION_CONFLICT, model.state.value.error)
        assertTrue(port.prepared.isEmpty())
        assertNull(model.state.value.draft!!.operationId)
    }
    @Test fun missingDefaultOrMultipleComputersRequiresChoiceAndRemovedTargetCannotSubmit() = runTest(dispatcher) {
        val port = Port(); port.snapshot.value = port.snapshot.value.copy(appApiRouting = AppApiRoutingPreferences(defaultShareTargetId = "removed"))
        val model = CaptureViewModel(port, "draft", CaptureInput("source")); runCurrent()
        assertNull(model.state.value.draft!!.targetInstanceId)
        assertTrue(port.catalogTargets.isEmpty())
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model")); model.onEvent(CaptureEvent.Instruction("do it"))
        port.snapshot.value = port.snapshot.value.copy(computers = emptyList()); runCurrent()
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent(); assertTrue(port.prepared.isEmpty())
    }
    @Test fun staleTargetCatalogCannotEnableSubmissionOnAnotherComputer() = runTest(dispatcher) {
        val port = Port(); val gate = CompletableDeferred<RuntimeCatalog>()
        port.catalogBlock = { id -> if (id == "b") withContext(NonCancellable) { gate.await() } else RuntimeCatalog() }
        val model = CaptureViewModel(port, "draft", CaptureInput("source")); runCurrent()
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        assertTrue(model.state.value.catalog.tools.isEmpty())
        gate.complete(catalog); runCurrent()
        assertEquals("a", model.state.value.draft!!.targetInstanceId)
        assertTrue(model.state.value.catalog.tools.isEmpty())
        assertFalse(model.state.value.canSubmit)
    }
    @Test fun copyingFrozenSubmissionCreatesEditableIndependentIdentity() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val original = port.drafts.rows.value.single()
        model.onEvent(CaptureEvent.CopyAsNew); runCurrent()
        val copy = model.state.value.draft!!
        assertNotEquals(original.draftId, copy.draftId)
        assertNull(copy.operationId); assertNull(copy.preparationId)
        assertEquals(original.input, copy.input)
        assertEquals(original, port.drafts.rows.value.first())
        assertEquals(1, port.commits)
    }
    @Test fun inboxCannotDeleteFrozenEvidenceAndUsesRevisionForEditableDelete() = runTest(dispatcher) {
        val port = Port(); val draft = CaptureDraft("a", "owner", 0, input = CaptureInput("Source"))
        port.drafts.rows.value = listOf(draft, draft.copy(draftId = "b", operationId = "capture_b"))
        val inbox = DraftInboxViewModel(port); runCurrent()
        assertEquals(2, inbox.state.value.drafts.size)
        inbox.delete(inbox.state.value.drafts[1]); runCurrent(); assertEquals(2, port.drafts.rows.value.size)
        inbox.delete(draft); runCurrent(); assertEquals(1, port.drafts.rows.value.size)
    }
    @Test fun processSnapshotRecoversUnsavedEditAndConflictingVersionRequiresNewDraft() = runTest(dispatcher) {
        val port = Port()
        val base = CaptureDraft("draft", "owner", 0, input = CaptureInput("Reference"))
        port.drafts.rows.value = listOf(base)
        val snapshot = base.copy(instruction = "Unflushed edit")
        val restored = CaptureViewModel(port, "draft", restoredDraft = snapshot); runCurrent()
        assertEquals("Unflushed edit", restored.state.value.draft!!.instruction)
        restored.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertEquals("Unflushed edit", port.drafts.rows.value.single().instruction)
        assertTrue(port.prepared.isEmpty())

        val oldSnapshot = snapshot.copy(instruction = "Keep this conflicting edit")
        val conflicting = CaptureViewModel(port, "draft", restoredDraft = oldSnapshot); runCurrent()
        conflicting.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertEquals(ApiErrorCode.REVISION_CONFLICT, conflicting.state.value.error)
        assertFalse(conflicting.state.value.close)
        assertEquals("Keep this conflicting edit", conflicting.state.value.draft!!.instruction)
        assertEquals("Unflushed edit", port.drafts.rows.value.single().instruction)
        conflicting.onEvent(CaptureEvent.CopyAsNew); runCurrent()
        assertEquals(2, port.drafts.rows.value.size)
        assertEquals("Keep this conflicting edit", conflicting.state.value.draft!!.instruction)
    }
    @Test fun corruptRoutingAndProviderWithoutModelsCannotSubmit() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        port.snapshot.value = port.snapshot.value.copy(appApiRouting = AppApiRoutingPreferences(readable = false)); runCurrent()
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent(); assertTrue(port.prepared.isEmpty())
        val providerPort = Port()
        providerPort.catalogBlock = { RuntimeCatalog(listOf(RuntimeToolOption("tool", "Tool", providerSelectionRequired = true))) }
        val providerModel = CaptureViewModel(providerPort, "other", CaptureInput("Source")); runCurrent()
        providerModel.onEvent(CaptureEvent.Instruction("Analyze")); providerModel.onEvent(CaptureEvent.Tool("tool")); runCurrent()
        assertFalse(providerModel.state.value.canSubmit)
        providerModel.onEvent(CaptureEvent.Submit); runCurrent(); assertTrue(providerPort.prepared.isEmpty())
    }
    @Test fun shortcutTargetOverridesDefaultButNeverSubmitsAndIsRetainedOnReopen() = runTest(dispatcher) {
        val port = Port(); port.hint = CaptureInitialTarget("a")
        val model = CaptureViewModel(port, "shortcut", CaptureInput("Source")); runCurrent()
        assertEquals("a", model.state.value.draft!!.targetInstanceId)
        assertEquals(listOf("a"), port.catalogTargets); assertTrue(port.prepared.isEmpty())
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        port.hint = CaptureInitialTarget("b")
        val restored = CaptureViewModel(port, "shortcut", CaptureInput("Other")); runCurrent()
        assertEquals("a", restored.state.value.draft!!.targetInstanceId)
        assertEquals(1, port.hintCalls); assertEquals("Source", restored.state.value.draft!!.input.sharedText)
    }
    @Test fun unknownShortcutNeverFallsBackAndSelectionRequirementSurvivesClose() = runTest(dispatcher) {
        val port = Port(); port.hint = CaptureInitialTarget(requireSelection = true, error = ApiErrorCode.TARGET_NOT_FOUND)
        val model = CaptureViewModel(port, "unknown", CaptureInput("Keep source")); runCurrent()
        assertNull(model.state.value.draft!!.targetInstanceId); assertTrue(port.catalogTargets.isEmpty())
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, model.state.value.error)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        val restored = CaptureViewModel(port, "unknown"); runCurrent()
        assertNull(restored.state.value.draft!!.targetInstanceId); assertTrue(restored.state.value.draft!!.requireTargetSelection)
        restored.onEvent(CaptureEvent.Target("b")); runCurrent()
        assertEquals("b", restored.state.value.draft!!.targetInstanceId); assertFalse(restored.state.value.draft!!.requireTargetSelection)
        assertTrue(port.prepared.isEmpty())
    }
    @Test fun pinRequestReportsLauncherRequestWithoutCreatingTask() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.PinTarget); runCurrent()
        assertEquals(1, port.pins); assertEquals(CapturePinResult.REQUESTED, model.state.value.pinResult)
        assertEquals(0, port.commits); assertTrue(port.prepared.isEmpty())
    }
    @Test fun resultIsExplicitRestoresLocallyAndTimeoutDoesNotResubmit() = runTest(dispatcher) {
        val port = Port(); val model = configured(port)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(0, port.resultReads)
        model.onEvent(CaptureEvent.CheckResult); runCurrent()
        assertEquals("Exact final text", model.state.value.operation!!.result!!.text)
        val restored = CaptureViewModel(port, "draft"); runCurrent()
        assertEquals(model.state.value.operation, restored.state.value.operation)
        assertEquals(1, port.resultReads); assertEquals(1, port.commits)
        port.resultGate = CompletableDeferred()
        restored.onEvent(CaptureEvent.CheckResult); runCurrent()
        assertTrue(restored.state.value.busy)
        dispatcher.scheduler.advanceTimeBy(30_001); runCurrent()
        assertFalse(restored.state.value.busy)
        assertEquals(ApiErrorCode.TARGET_OFFLINE, restored.state.value.error)
        assertEquals("Exact final text", restored.state.value.operation!!.result!!.text)
        assertEquals(1, port.commits); assertEquals(0, port.cancels)
    }

    @Test fun explicitPreMessageCancellationKeepsJournalAndBlocksResume() = runTest(dispatcher) {
        val port = Port(); val model = configured(port); port.commitStage = OperationStage.CONNECTING
        model.onEvent(CaptureEvent.Submit); runCurrent()
        val frozen = port.drafts.rows.value.single()
        model.onEvent(CaptureEvent.CancelSubmission); runCurrent()
        assertEquals(OperationStage.CANCELLED, model.state.value.operation!!.stage)
        assertEquals(1, port.cancels); assertEquals(frozen, port.drafts.rows.value.single())
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent(); assertEquals(1, port.commits)
    }

    @Test fun smartIntakeBindsExistingProjectBeforeTaskAndEditingInvalidatesDecision() = runTest(dispatcher) {
        val port = Port(); port.smartIntake = true
        port.intakeBlock = { input -> IntakeDecision(1, input.intakeId, "decision", "a".repeat(64),
            input.targetInstanceId, "needs_clarification", question = "Which goal?", contextComplete = true,
            requiresClarification = true) }
        val model = configured(port)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals("needs_clarification", port.drafts.rows.value.single().intakeDecision?.decision)
        assertTrue(port.prepared.isEmpty())
        model.onEvent(CaptureEvent.Instruction("Analyze it for the existing product")); runCurrent()
        assertNull(model.state.value.draft!!.intakeId)
        port.intakeBlock = { input -> IntakeDecision(1, input.intakeId, "decision2", "b".repeat(64),
            input.targetInstanceId, "use_existing", projectId = "project-a", sessionAction = "create_new",
            reason = "Product identity matches", contextComplete = true) }
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals("project-a", port.prepared.single().projectId)
        assertEquals("b", port.prepared.single().targetInstanceId)
        assertEquals(1, port.commits)
    }

    @Test fun unsupportedTargetKeepsDraftEditableAndCannotUseLegacySubmission() = runTest(dispatcher) {
        val port = Port(); port.smartIntake = true; port.supportBlock = { false }
        val model = configured(port)
        assertEquals(CaptureIntakeObservation("b", CaptureIntakeStatus.UNSUPPORTED), model.state.value.intakeObservation)
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.intakeCalls)
        model.onEvent(CaptureEvent.SaveAndClose); runCurrent()
        assertNull(port.drafts.rows.value.single().operationId)
        assertEquals("Analyze it", port.drafts.rows.value.single().instruction)
        port.supportBlock = { true }
        val reopened = CaptureViewModel(port, "draft"); runCurrent()
        assertEquals(CaptureIntakeStatus.SUPPORTED, reopened.state.value.intakeObservation?.status)
        assertTrue(reopened.state.value.canSubmit)
    }

    @Test fun switchingTargetsIgnoresLateCapabilityReplyAndRechecksBeforeSubmission() = runTest(dispatcher) {
        val port = Port(); port.smartIntake = true
        val old = CompletableDeferred<Boolean>()
        port.supportBlock = { target -> if (target == "b") withContext(NonCancellable) { old.await() } else true }
        val model = configured(port)
        assertFalse(model.state.value.canSubmit)
        model.onEvent(CaptureEvent.Target("a")); runCurrent()
        model.onEvent(CaptureEvent.Tool("tool")); model.onEvent(CaptureEvent.Model("model"))
        assertEquals(CaptureIntakeObservation("a", CaptureIntakeStatus.SUPPORTED), model.state.value.intakeObservation)
        old.complete(false); runCurrent()
        assertEquals("a", model.state.value.intakeObservation?.targetId)
        assertTrue(model.state.value.canSubmit)
        port.supportBlock = { false }
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, model.state.value.error)
        assertEquals(CaptureIntakeStatus.UNSUPPORTED, model.state.value.intakeObservation?.status)
        assertFalse(model.state.value.canSubmit)
        assertTrue(port.prepared.isEmpty()); assertEquals(0, port.intakeCalls)
        assertNull(port.drafts.rows.value.single().operationId)
    }

    @Test fun lostProjectCreationReplyResumesSameOperationAfterViewModelRecreation() = runTest(dispatcher) {
        val port = Port(); port.smartIntake = true
        port.intakeBlock = { input -> IntakeDecision(1, input.intakeId, "new-decision", "c".repeat(64),
            input.targetInstanceId, "create_new", newProject = IntakeProject("New work", "Sustained goal", "document"),
            reason = "A separate ongoing goal", contextComplete = true) }
        val operations = mutableListOf<String>()
        port.ensureBlock = { request ->
            operations += request.operationId
            if (operations.size == 1) throw AppApiException(ApiError(ApiErrorCode.TARGET_OFFLINE, "Lost reply", true))
            IntakeProjectReceipt(request.operationId, request.decisionId, "c".repeat(64),
                request.input.targetInstanceId, "new-project", "completed")
        }
        val model = configured(port)
        model.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(ApiErrorCode.TARGET_OFFLINE, model.state.value.error)
        assertEquals(0, port.commits)
        assertEquals("create_new", port.drafts.rows.value.single().intakeDecision?.decision)
        val restored = CaptureViewModel(port, "draft"); runCurrent()
        restored.onEvent(CaptureEvent.Submit); runCurrent()
        assertEquals(1, port.intakeCalls)
        assertEquals(operations.first(), operations.last())
        assertEquals("new-project", port.prepared.single().projectId)
        assertEquals(1, port.commits)
    }
}
