package com.andysagent.ragent.feature.appapi

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.util.UUID

/** Presentation metadata only; no caller credentials, local paths or remote access tokens. */
data class ResultTaskInfo(val operationId: String, val targetId: String, val sessionId: String?,
    val title: String, val stage: OperationStage, val manifest: ResultExportManifest?)
data class SavedResultRow(val id: String, val resourceId: String, val manifestRevision: String,
    val revision: Long, val name: String, val mimeType: String, val sizeBytes: Long,
    val receivedBytes: Long, val state: ResultOutputState, val error: ApiErrorCode? = null)
data class ResultOutputsSnapshot(val task: ResultTaskInfo, val files: List<SavedResultRow>,
    val deliveries: List<ResultDeliveryRef>, val documentSaves: List<DocumentSaveRef> = emptyList())

/** Trusted owner adapter. Every mutation checks both operation and resource membership. */
interface ResultOutputsPort {
    suspend fun load(operationId: String, recover: Boolean): ResultOutputsSnapshot
    suspend fun queryManifest(operationId: String)
    suspend fun download(operationId: String, revision: String, resourceId: String, downloadId: String)
    suspend fun delete(operationId: String, downloadId: String, expectedRevision: Long)
    suspend fun stage(operationId: String, downloadId: String): ResultDeliveryRef
    suspend fun saveDocument(operationId: String, ticketId: String, documentUri: String)
    suspend fun prepareDocument(operationId: String, ticketId: String)
    suspend fun cancelDocument(operationId: String, ticketId: String)
    suspend fun clearDocumentHistory(operationId: String)
    suspend fun revoke(operationId: String, ticketId: String)
}

enum class ResultDeliveryAction { SHARE, SAVE }
data class ResultOutputsEffect(val id: String, val action: ResultDeliveryAction, val ticket: ResultDeliveryRef)
enum class ResultOutputsNotice { STOPPED, SHARE_REQUESTED, SAVED, SAVE_CANCELLED, SAVE_INTERRUPTED, REVOKED }
data class ResultOutputsUiState(val loading: Boolean = true, val snapshot: ResultOutputsSnapshot? = null,
    val busy: Boolean = false, val error: ApiErrorCode? = null, val notice: ResultOutputsNotice? = null,
    val effect: ResultOutputsEffect? = null, val awaitingSave: ResultDeliveryRef? = null,
    val savingDocument: Boolean = false) {
    val canAct: Boolean get() = !loading && !busy && snapshot != null && effect == null && awaitingSave == null
}
sealed interface ResultOutputsEvent {
    data object RefreshLocal : ResultOutputsEvent
    data object QueryManifest : ResultOutputsEvent
    data object Stop : ResultOutputsEvent
    data object ClearDocumentHistory : ResultOutputsEvent
    data class Download(val resourceId: String) : ResultOutputsEvent
    data class Resume(val id: String) : ResultOutputsEvent
    data class Delete(val id: String) : ResultOutputsEvent
    data class Deliver(val id: String, val action: ResultDeliveryAction) : ResultOutputsEvent
    data class Revoke(val ticketId: String) : ResultOutputsEvent
}

/** Restoring reads private state only. It cannot create/submit a task or reopen a system chooser. */
class ResultOutputsViewModel(private val port: ResultOutputsPort, private val operationId: String,
    private val restoredSaveTicket: String? = null, private val interruptedSave: Boolean = false,
    private val newId: () -> String = { UUID.randomUUID().toString() }) : ViewModel() {
    private val mutable = MutableStateFlow(ResultOutputsUiState())
    val state: StateFlow<ResultOutputsUiState> = mutable.asStateFlow()
    private var action: Job? = null
    private var deferredSaveResult: Pair<String, String?>? = null
    init {
        action = viewModelScope.launch {
            try {
                refresh(recover = true)
                val pending = restoredSaveTicket?.let { id ->
                    mutable.value.snapshot?.takeIf { snapshot -> snapshot.documentSaves.any {
                        it.ticketId == id && it.state == DocumentSaveState.WAITING_SELECTION
                    } }?.deliveries?.firstOrNull { it.id == id }
                }
                mutable.update { it.copy(awaitingSave = pending,
                    notice = if (interruptedSave) ResultOutputsNotice.SAVE_INTERRUPTED else null,
                    error = if (restoredSaveTicket != null && pending == null) ApiErrorCode.REQUEST_EXPIRED else null) }
            } catch (failure: Exception) { failed(failure) }
            finally {
                mutable.update { it.copy(loading = false) }
                deferredSaveResult?.let { result ->
                    deferredSaveResult = null
                    // The initialization job must finish before starting the copy job.
                    viewModelScope.launch { action?.join(); completeSave(result.first, result.second) }
                }
            }
        }
    }

    fun onEvent(event: ResultOutputsEvent) {
        if (event == ResultOutputsEvent.Stop) { action?.cancel(); return }
        if (!mutable.value.canAct && !(event == ResultOutputsEvent.RefreshLocal && !mutable.value.busy && !mutable.value.loading &&
            mutable.value.effect == null && mutable.value.awaitingSave == null)) return
        val snapshot = mutable.value.snapshot
        when (event) {
            ResultOutputsEvent.RefreshLocal -> runAction { refresh(recover = true) }
            ResultOutputsEvent.QueryManifest -> runAction { port.queryManifest(operationId) }
            ResultOutputsEvent.ClearDocumentHistory -> runAction { port.clearDocumentHistory(operationId) }
            is ResultOutputsEvent.Download -> {
                val manifest = snapshot?.task?.manifest ?: return
                if (manifest.resources.none { it.resourceId == event.resourceId && it.available }) return
                // An existing partial is resumed explicitly with its original identity.
                if (snapshot.files.any { it.resourceId == event.resourceId && it.manifestRevision == manifest.revision && it.state != ResultOutputState.DELETED }) return
                val id = newId()
                runAction { download(manifest.revision, event.resourceId, id) }
            }
            is ResultOutputsEvent.Resume -> {
                val row = snapshot?.files?.firstOrNull { it.id == event.id && it.state == ResultOutputState.PARTIAL } ?: return
                runAction { download(row.manifestRevision, row.resourceId, row.id) }
            }
            is ResultOutputsEvent.Delete -> {
                val row = snapshot?.files?.firstOrNull { it.id == event.id && it.state !in setOf(ResultOutputState.DOWNLOADING, ResultOutputState.COMMITTING, ResultOutputState.DELETED) } ?: return
                runAction { port.delete(operationId, row.id, row.revision) }
            }
            is ResultOutputsEvent.Deliver -> {
                val row = snapshot?.files?.firstOrNull { it.id == event.id && it.state == ResultOutputState.READY } ?: return
                runAction {
                    val ticket = port.stage(operationId, row.id)
                    if (event.action == ResultDeliveryAction.SAVE) port.prepareDocument(operationId, ticket.id)
                    mutable.update { it.copy(effect = ResultOutputsEffect(newId(), event.action, ticket)) }
                }
            }
            is ResultOutputsEvent.Revoke -> {
                if (snapshot?.deliveries?.none { it.id == event.ticketId } != false) return
                runAction { port.revoke(operationId, event.ticketId); mutable.update { it.copy(notice = ResultOutputsNotice.REVOKED) } }
            }
            ResultOutputsEvent.Stop -> Unit
        }
    }

    /** Main-thread consume before launching Android UI: a recreated Activity cannot launch it twice. */
    fun consumeEffect(id: String): ResultOutputsEffect? {
        val effect = mutable.value.effect?.takeIf { it.id == id } ?: return null
        mutable.update { it.copy(effect = null, awaitingSave = effect.ticket.takeIf { effect.action == ResultDeliveryAction.SAVE }) }
        return effect
    }
    fun shareRequested() { mutable.update { it.copy(notice = ResultOutputsNotice.SHARE_REQUESTED) } }
    fun launchFailed(failure: Exception) {
        val pending = mutable.value.awaitingSave
        mutable.update { it.copy(awaitingSave = null) }
        if (pending != null) runAction { port.cancelDocument(operationId, pending.id); failed(failure) }
        else failed(failure)
    }
    fun completeSave(ticketId: String, documentUri: String?) {
        if (mutable.value.loading && restoredSaveTicket == ticketId) {
            if (deferredSaveResult == null) deferredSaveResult = ticketId to documentUri
            return
        }
        if (mutable.value.awaitingSave?.id != ticketId || mutable.value.busy) {
            mutable.update { it.copy(error = ApiErrorCode.INVALID_ARGUMENT) }; return
        }
        mutable.update { it.copy(awaitingSave = null) }
        if (documentUri == null) {
            runAction { port.cancelDocument(operationId, ticketId); mutable.update { it.copy(notice = ResultOutputsNotice.SAVE_CANCELLED) } }
            return
        }
        runAction {
            mutable.update { it.copy(savingDocument = true) }
            port.saveDocument(operationId, ticketId, documentUri)
            mutable.update { it.copy(notice = ResultOutputsNotice.SAVED) }
        }
    }
    private fun runAction(block: suspend () -> Unit) {
        if (action?.isActive == true || mutable.value.busy) return
        mutable.update { it.copy(busy = true, error = null, notice = null) }
        action = viewModelScope.launch {
            try { block() }
            catch (cancelled: CancellationException) {
                mutable.update { it.copy(notice = if (it.savingDocument) ResultOutputsNotice.SAVE_INTERRUPTED else ResultOutputsNotice.STOPPED, effect = null) }
                throw cancelled
            } catch (failure: Exception) {
                if (mutable.value.savingDocument) mutable.update { it.copy(notice = ResultOutputsNotice.SAVE_INTERRUPTED) }
                failed(failure)
            }
            finally {
                // The private writer checkpoints before returning cancellation. Refresh never submits.
                try {
                    withContext(NonCancellable) {
                        try { withTimeout(10_000) { refresh(recover = false) } }
                        catch (timeout: TimeoutCancellationException) { mutable.update { it.copy(error = ApiErrorCode.RESULT_UNKNOWN) } }
                        catch (failure: Exception) { failed(failure) }
                    }
                } finally { mutable.update { it.copy(busy = false, loading = false, savingDocument = false) } }
            }
        }
    }
    private suspend fun refresh(recover: Boolean) {
        val snapshot = port.load(operationId, recover)
        if (snapshot.task.operationId != operationId) throw AppApiException(ApiError(ApiErrorCode.PERMISSION_DENIED, "Operation identity differs"))
        mutable.update { it.copy(snapshot = snapshot) }
    }
    private suspend fun download(revision: String, resourceId: String, id: String) = coroutineScope {
        val progress = launch {
            while (isActive) { delay(1_000); refresh(recover = false) }
        }
        try { port.download(operationId, revision, resourceId, id) }
        finally { progress.cancelAndJoin() }
    }
    private fun failed(failure: Exception) {
        if (failure is CancellationException && failure !is TimeoutCancellationException) throw failure
        val code = when (failure) {
            is TimeoutCancellationException -> ApiErrorCode.RESULT_UNKNOWN
            is AppApiException -> failure.error.code
            is SecurityException -> ApiErrorCode.PERMISSION_DENIED
            else -> ApiErrorCode.INTERNAL_ERROR
        }
        mutable.update { it.copy(error = code, effect = null,
            snapshot = if (code in setOf(ApiErrorCode.PERMISSION_DENIED, ApiErrorCode.AUTHENTICATION_REQUIRED, ApiErrorCode.RESOURCE_NOT_FOUND)) null else it.snapshot) }
    }
}
