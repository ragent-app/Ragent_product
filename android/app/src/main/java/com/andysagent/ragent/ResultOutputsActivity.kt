package com.andysagent.ragent

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.andysagent.ragent.core.appapi.*
import com.andysagent.ragent.feature.appapi.*
import kotlinx.coroutines.withTimeout

/** Owner only. The visible/current PC is never used to route this page's actions. */
internal class OwnerResultOutputsPort(private val graph: AndroidRuntimeGraph) : ResultOutputsPort {
    private val caller get() = graph.appApiOwner
    override suspend fun load(operationId: String, recover: Boolean): ResultOutputsSnapshot {
        val operation = graph.appApi.get(operationId, caller)
        val files = graph.resultOutputs.listForOperation(operationId, caller).map { row ->
            val current = if (recover && row.state in setOf(ResultOutputState.DOWNLOADING, ResultOutputState.COMMITTING)) {
                try { graph.resultOutputs.recover(row.downloadId, caller) ?: row }
                catch (failure: AppApiException) {
                    if (failure.error.code != ApiErrorCode.REVISION_CONFLICT) throw failure
                    // Another writer may hold the lock. Do not interfere with it or claim recovery.
                    row.copy(error = failure.error.code)
                }
            } else row
            SavedResultRow(current.downloadId, current.resourceId, current.manifest.revision, current.revision,
                current.resource.originalName, current.resource.mimeType, current.resource.sizeBytes!!,
                current.receivedBytes, current.state, current.error)
        }
        return ResultOutputsSnapshot(ResultTaskInfo(operation.operationId, operation.targetInstanceId,
            operation.sessionId, operation.request.title ?: operation.request.instruction.take(160),
            operation.stage, operation.resultExport), files, graph.resultDeliveries.list(operationId, caller),
            graph.documentSaves.list(operationId, caller, recover))
    }
    override suspend fun queryManifest(operationId: String) {
        withTimeout(30_000) { graph.appApi.readResultExport(operationId, caller) }
    }
    override suspend fun download(operationId: String, revision: String, resourceId: String, downloadId: String) {
        graph.resultOutputs.download(operationId, caller, revision, resourceId, downloadId)
    }
    private suspend fun output(operationId: String, downloadId: String): ResultOutput {
        graph.appApi.get(operationId, caller)
        val row = graph.resultOutputs.get(downloadId, caller)
        if (row == null || row.operationId != operationId) throw AppApiException(ApiError(ApiErrorCode.RESOURCE_NOT_FOUND, "Output is not part of this task"))
        return row
    }
    override suspend fun delete(operationId: String, downloadId: String, expectedRevision: Long) {
        if (output(operationId, downloadId).revision != expectedRevision)
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Output changed; refresh before deleting"))
        graph.resultDeliveryAndroid.revokeForOutput(downloadId)
        if (!graph.resultOutputs.delete(downloadId, caller, expectedRevision))
            throw AppApiException(ApiError(ApiErrorCode.REVISION_CONFLICT, "Output changed; refresh before deleting"))
    }
    override suspend fun stage(operationId: String, downloadId: String): ResultDeliveryRef {
        output(operationId, downloadId)
        return graph.resultDeliveryAndroid.stage(downloadId)
    }
    suspend fun requireTicket(operationId: String, ticketId: String): ResultDeliveryRef {
        graph.appApi.get(operationId, caller)
        return graph.resultDeliveries.list(operationId, caller).firstOrNull { it.id == ticketId }
            ?: throw AppApiException(ApiError(ApiErrorCode.REQUEST_EXPIRED, "Delivery ticket is not available for this task"))
    }
    suspend fun shareIntent(operationId: String, ticketId: String): Intent {
        requireTicket(operationId, ticketId)
        return graph.resultDeliveryAndroid.shareIntent(ticketId)
    }
    override suspend fun saveDocument(operationId: String, ticketId: String, documentUri: String) {
        requireTicket(operationId, ticketId)
        graph.documentSaves.copy(operationId, ticketId, caller) {
            graph.resultDeliveryAndroid.saveToDocument(ticketId, Uri.parse(documentUri))
        }
    }
    override suspend fun prepareDocument(operationId: String, ticketId: String) {
        requireTicket(operationId, ticketId)
        graph.documentSaves.prepare(operationId, ticketId, caller)
    }
    override suspend fun cancelDocument(operationId: String, ticketId: String) {
        graph.appApi.get(operationId, caller)
        graph.documentSaves.cancelSelection(operationId, ticketId, caller)
    }
    override suspend fun clearDocumentHistory(operationId: String) {
        graph.documentSaves.clearFinished(operationId, caller)
    }
    override suspend fun revoke(operationId: String, ticketId: String) {
        requireTicket(operationId, ticketId)
        graph.resultDeliveryAndroid.revoke(ticketId)
    }
}

/** No exported entry and no caller/target/path extras. Only the actual system result supplies a URI. */
class ResultOutputsActivity : ComponentActivity() {
    private lateinit var operationId: String
    private lateinit var model: ResultOutputsViewModel
    private var pendingSaveTicket: String? = null
    private val createDocument = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val ticket = pendingSaveTicket ?: return@registerForActivityResult
        pendingSaveTicket = null
        model.completeSave(ticket, result.data?.data?.toString().takeIf { result.resultCode == RESULT_OK })
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        operationId = savedInstanceState?.getString(SAVED_OPERATION) ?: intent.getStringExtra(EXTRA_OPERATION_ID).orEmpty()
        if (!Regex("[A-Za-z0-9_-]{1,64}").matches(operationId)) { finish(); return }
        pendingSaveTicket = savedInstanceState?.getString(SAVED_TICKET)
        val graph = (application as RagentApplication).runtime
        val port = OwnerResultOutputsPort(graph)
        val factory = object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                require(modelClass == ResultOutputsViewModel::class.java)
                @Suppress("UNCHECKED_CAST")
                return ResultOutputsViewModel(port, operationId, pendingSaveTicket,
                    savedInstanceState?.getBoolean(SAVED_WRITING) == true) as T
            }
        }
        model = ViewModelProvider(this, factory)[ResultOutputsViewModel::class.java]
        enableEdgeToEdge()
        setContent {
            AppApiSurfaceTheme(graph.configStore) {
                val state by model.state.collectAsStateWithLifecycle()
                ResultOutputsScreen(state, model::onEvent, ::finish)
                LaunchedEffect(state.effect?.id, state.busy) {
                    if (state.busy) return@LaunchedEffect
                    val effect = state.effect ?: return@LaunchedEffect
                    try {
                        if (effect.action == ResultDeliveryAction.SHARE) {
                            val share = port.shareIntent(operationId, effect.ticket.id)
                            if (model.consumeEffect(effect.id) == null) return@LaunchedEffect
                            startActivity(Intent.createChooser(share, getString(com.andysagent.ragent.feature.appapi.R.string.api_outputs_share)))
                            model.shareRequested()
                        } else {
                            val ref = port.requireTicket(operationId, effect.ticket.id)
                            if (model.consumeEffect(effect.id) == null) return@LaunchedEffect
                            pendingSaveTicket = ref.id
                            createDocument.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = ref.mimeType
                                putExtra(Intent.EXTRA_TITLE, ref.name)
                            })
                        }
                    } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
                    catch (failure: Exception) { pendingSaveTicket = null; model.launchFailed(failure) }
                }
            }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        if (::operationId.isInitialized) outState.putString(SAVED_OPERATION, operationId)
        pendingSaveTicket?.let { outState.putString(SAVED_TICKET, it) }
        if (::model.isInitialized) outState.putBoolean(SAVED_WRITING, model.state.value.savingDocument)
        super.onSaveInstanceState(outState)
    }
    companion object {
        const val EXTRA_OPERATION_ID = "ragent.internal.resultOperationId"
        private const val SAVED_OPERATION = "result.operation"
        private const val SAVED_TICKET = "result.saveTicket"
        private const val SAVED_WRITING = "result.writing"
    }
}
