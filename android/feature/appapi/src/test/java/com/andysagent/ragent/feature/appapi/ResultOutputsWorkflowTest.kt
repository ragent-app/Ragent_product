package com.andysagent.ragent.feature.appapi

import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class ResultOutputsWorkflowTest {
    private val dispatcher = StandardTestDispatcher()
    @Before fun setup() { Dispatchers.setMain(dispatcher) }
    @After fun cleanup() { Dispatchers.resetMain() }
    private val manifest = ResultExportManifest(1, "pc-original", "session", "request", "run", "final",
        listOf(ResultExportResource("resource", "Report.txt", "text/plain", true, 100, "a".repeat(64))),
        100, 65536, "2099-01-01T00:00:00Z", "b".repeat(64))
    private val row = SavedResultRow("download-original", "resource", "old-revision", 7, "Report.txt", "text/plain", 100, 100, ResultOutputState.READY)
    private val ticket = ResultDeliveryRef("ticket", "Report.txt", "text/plain", 100, Long.MAX_VALUE)
    private val waiting = DocumentSaveRef(ticket.id, ticket.name, ticket.sizeBytes, DocumentSaveState.WAITING_SELECTION, 1, false, null)
    private inner class Port : ResultOutputsPort {
        var snapshot = ResultOutputsSnapshot(ResultTaskInfo("op", "pc-original", "session", "Task", OperationStage.ACCEPTED, manifest), listOf(row), listOf(ticket), listOf(waiting))
        val calls = mutableListOf<String>()
        var loadFailure: ApiErrorCode? = null
        var gate: CompletableDeferred<Unit>? = null
        var saveFailure = false
        override suspend fun load(operationId: String, recover: Boolean): ResultOutputsSnapshot {
            calls += "load:$operationId:$recover"
            loadFailure?.let { throw AppApiException(ApiError(it, "Denied")) }
            return snapshot
        }
        override suspend fun queryManifest(operationId: String) { calls += "query:$operationId"; gate?.await() }
        override suspend fun download(operationId: String, revision: String, resourceId: String, downloadId: String) {
            calls += "download:$operationId:$revision:$resourceId:$downloadId"
            try { gate?.await() }
            catch (cancelled: CancellationException) {
                snapshot = snapshot.copy(files = listOf(row.copy(state = ResultOutputState.PARTIAL, receivedBytes = 50)))
                throw cancelled
            }
        }
        override suspend fun delete(operationId: String, downloadId: String, expectedRevision: Long) {
            calls += "delete:$operationId:$downloadId:$expectedRevision"; snapshot = snapshot.copy(files = emptyList(), deliveries = emptyList())
        }
        override suspend fun stage(operationId: String, downloadId: String): ResultDeliveryRef {
            calls += "stage:$operationId:$downloadId"; return ticket
        }
        override suspend fun saveDocument(operationId: String, ticketId: String, documentUri: String) {
            calls += "save:$operationId:$ticketId:$documentUri"
            if (saveFailure) throw java.io.IOException("Document provider failed")
            gate?.await()
        }
        override suspend fun prepareDocument(operationId: String, ticketId: String) { calls += "prepare-save:$operationId:$ticketId" }
        override suspend fun cancelDocument(operationId: String, ticketId: String) { calls += "cancel-save:$operationId:$ticketId" }
        override suspend fun clearDocumentHistory(operationId: String) { calls += "clear-save:$operationId" }
        override suspend fun revoke(operationId: String, ticketId: String) { calls += "revoke:$operationId:$ticketId" }
    }
    private fun vm(port: Port, pending: String? = null, interrupted: Boolean = false) =
        ResultOutputsViewModel(port, "op", pending, interrupted, newId = { "new-id" })

    @Test fun reopeningLoadsOnlyLocalOriginalOperationAndDoesNotLaunchOrDownload() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle()
        assertEquals(listOf("load:op:true"), port.calls)
        assertEquals("pc-original", model.state.value.snapshot!!.task.targetId)
        assertNull(model.state.value.effect); assertFalse(model.state.value.busy)
    }
    @Test fun queryIsExplicitAndDoubleTapIsSerialized() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle(); port.gate = CompletableDeferred()
        model.onEvent(ResultOutputsEvent.QueryManifest); runCurrent()
        model.onEvent(ResultOutputsEvent.QueryManifest); runCurrent()
        assertEquals(1, port.calls.count { it == "query:op" }); assertTrue(model.state.value.busy)
        port.gate!!.complete(Unit); advanceUntilIdle(); assertFalse(model.state.value.busy)
    }
    @Test fun resumeUsesOriginalDownloadAndRevisionEvenWhenManifestChanged() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = listOf(row.copy(state = ResultOutputState.PARTIAL, receivedBytes = 20)))
        val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Resume(row.id)); advanceUntilIdle()
        assertContains(port.calls, "download:op:old-revision:resource:download-original")
    }
    @Test fun freshDownloadUsesQueriedManifestAndIgnoresUnknownResources() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = emptyList())
        val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Download("unknown")); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("download:") })
        model.onEvent(ResultOutputsEvent.Download("resource")); advanceUntilIdle()
        assertContains(port.calls, "download:op:${manifest.revision}:resource:new-id")
    }
    @Test fun duplicatePrivateCopyIsNotDownloadedAgain() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = listOf(row.copy(manifestRevision = manifest.revision)))
        val model = vm(port); advanceUntilIdle(); model.onEvent(ResultOutputsEvent.Download("resource")); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("download:") })
    }
    @Test fun stopKeepsCheckpointAndNeverCancelsPcTask() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = listOf(row.copy(state = ResultOutputState.PARTIAL)))
        val model = vm(port); advanceUntilIdle(); port.gate = CompletableDeferred()
        model.onEvent(ResultOutputsEvent.Resume(row.id)); runCurrent()
        model.onEvent(ResultOutputsEvent.Stop); advanceUntilIdle()
        assertEquals(ResultOutputState.PARTIAL, model.state.value.snapshot!!.files.single().state)
        assertEquals(50L, model.state.value.snapshot!!.files.single().receivedBytes)
        assertEquals(ResultOutputsNotice.STOPPED, model.state.value.notice); assertFalse(model.state.value.busy)
    }
    @Test fun privateDeleteCarriesDisplayedOptimisticRevision() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Delete("unrelated")); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Delete(row.id)); advanceUntilIdle()
        assertContains(port.calls, "delete:op:download-original:7")
        assertTrue(model.state.value.snapshot!!.files.isEmpty())
    }
    @Test fun partialAndActiveRowsCannotBeSharedAndActiveRowCannotBeDeleted() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = listOf(row.copy(state = ResultOutputState.DOWNLOADING)))
        val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Deliver(row.id, ResultDeliveryAction.SHARE)); model.onEvent(ResultOutputsEvent.Delete(row.id)); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("stage:") || it.startsWith("delete:") })
    }
    @Test fun effectIsConsumedOnceAndShareNoticeDoesNotClaimDelivery() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Deliver(row.id, ResultDeliveryAction.SHARE)); advanceUntilIdle()
        val effect = model.state.value.effect!!
        assertEquals(ResultDeliveryAction.SHARE, model.consumeEffect(effect.id)!!.action)
        assertNull(model.consumeEffect(effect.id)); assertNull(model.state.value.notice)
        model.shareRequested(); assertEquals(ResultOutputsNotice.SHARE_REQUESTED, model.state.value.notice)
    }
    @Test fun saveAcceptsOnlyMatchingPendingTicketAndCancellationNeverCopies() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Deliver(row.id, ResultDeliveryAction.SAVE)); advanceUntilIdle()
        model.consumeEffect(model.state.value.effect!!.id)
        model.completeSave("another-task-ticket", "content://documents/wrong"); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("save:") })
        assertEquals(ticket, model.state.value.awaitingSave)
        model.completeSave(ticket.id, null); advanceUntilIdle()
        assertEquals(ResultOutputsNotice.SAVE_CANCELLED, model.state.value.notice)
        assertContains(port.calls, "cancel-save:op:ticket")
        assertFalse(port.calls.any { it.startsWith("save:") })
    }
    @Test fun successfulSaveUsesOriginalOperationAndExactSelectedUri() = runTest {
        val port = Port(); val model = vm(port, pending = ticket.id); advanceUntilIdle()
        model.completeSave(ticket.id, "content://documents/chosen"); advanceUntilIdle()
        assertContains(port.calls, "save:op:ticket:content://documents/chosen")
        assertEquals(ResultOutputsNotice.SAVED, model.state.value.notice)
    }
    @Test fun failedDocumentDoesNotReportSavedOrDeleteSource() = runTest {
        val port = Port(); val model = vm(port, ticket.id); advanceUntilIdle(); port.saveFailure = true
        model.completeSave(ticket.id, "content://documents/chosen"); advanceUntilIdle()
        assertEquals(ApiErrorCode.INTERNAL_ERROR, model.state.value.error)
        assertEquals(ResultOutputsNotice.SAVE_INTERRUPTED, model.state.value.notice); assertEquals(row, model.state.value.snapshot!!.files.single())
        assertFalse(port.calls.any { it.startsWith("delete:") })
    }
    @Test fun restoredPickerDoesNotReopenAndInterruptedWriteDoesNotRecopy() = runTest {
        val port = Port(); val model = vm(port, ticket.id, interrupted = true); advanceUntilIdle()
        assertEquals(listOf("load:op:true"), port.calls); assertNull(model.state.value.effect)
        assertEquals(ResultOutputsNotice.SAVE_INTERRUPTED, model.state.value.notice)
    }
    @Test fun expiredRestoredTicketDoesNotAcceptCallback() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(deliveries = emptyList())
        val model = vm(port, ticket.id); advanceUntilIdle()
        assertNull(model.state.value.awaitingSave); assertEquals(ApiErrorCode.REQUEST_EXPIRED, model.state.value.error)
        model.completeSave(ticket.id, "content://documents/chosen"); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("save:") })
    }
    @Test fun authorizationLossRemovesStaleFilesAndEffects() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle(); port.loadFailure = ApiErrorCode.PERMISSION_DENIED
        model.onEvent(ResultOutputsEvent.RefreshLocal); advanceUntilIdle()
        assertNull(model.state.value.snapshot); assertNull(model.state.value.effect)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, model.state.value.error)
    }
    @Test fun differentOperationSnapshotCannotBeDisplayed() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(task = port.snapshot.task.copy(operationId = "other"))
        val model = vm(port); advanceUntilIdle()
        assertNull(model.state.value.snapshot); assertEquals(ApiErrorCode.PERMISSION_DENIED, model.state.value.error)
    }
    @Test fun realResultArrivingBeforeRestoredLocalLoadWaitsForAuthorization() = runTest {
        val port = Port(); val model = vm(port, ticket.id)
        model.completeSave(ticket.id, "content://documents/restored")
        assertFalse(port.calls.any { it.startsWith("save:") })
        advanceUntilIdle()
        assertEquals(1, port.calls.count { it == "save:op:ticket:content://documents/restored" })
        assertEquals(ResultOutputsNotice.SAVED, model.state.value.notice)
    }
    @Test fun earlyPickerResultCannotBypassRevokedAuthorization() = runTest {
        val port = Port(); port.loadFailure = ApiErrorCode.PERMISSION_DENIED
        val model = vm(port, ticket.id); model.completeSave(ticket.id, "content://documents/chosen")
        advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("save:") }); assertNull(model.state.value.snapshot)
    }
    @Test fun interruptedJournalCannotRestoreLiveWriteAuthorityEvenWithBundleTicket() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(documentSaves = listOf(waiting.copy(state = DocumentSaveState.INTERRUPTED, copyStarted = true)))
        val model = vm(port, ticket.id); advanceUntilIdle()
        assertNull(model.state.value.awaitingSave)
        model.completeSave(ticket.id, "content://documents/stale"); advanceUntilIdle()
        assertFalse(port.calls.any { it.startsWith("save:") })
    }
    @Test fun journalIsPreparedBeforeSaveEffectAndClearIsExplicit() = runTest {
        val port = Port(); val model = vm(port); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.Deliver(row.id, ResultDeliveryAction.SAVE)); advanceUntilIdle()
        assertNotNull(model.state.value.effect)
        assertTrue(port.calls.indexOf("stage:op:${row.id}") < port.calls.indexOf("prepare-save:op:ticket"))
        model.consumeEffect(model.state.value.effect!!.id)
        model.completeSave(ticket.id, null); advanceUntilIdle()
        model.onEvent(ResultOutputsEvent.ClearDocumentHistory); advanceUntilIdle()
        assertContains(port.calls, "clear-save:op")
    }
    @Test fun downloadingProgressPollsLocalRecordsAndNeverQueriesPcAgain() = runTest {
        val port = Port(); port.snapshot = port.snapshot.copy(files = emptyList())
        val model = vm(port); advanceUntilIdle(); port.gate = CompletableDeferred()
        model.onEvent(ResultOutputsEvent.Download("resource")); runCurrent(); advanceTimeBy(2500); runCurrent()
        assertTrue(port.calls.count { it == "load:op:false" } >= 2)
        assertFalse(port.calls.any { it.startsWith("query:") })
        model.onEvent(ResultOutputsEvent.Stop); advanceUntilIdle(); assertFalse(model.state.value.busy)
    }
}
