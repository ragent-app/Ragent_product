package com.andysagent.ragent.feature.workbench

import com.andysagent.ragent.core.domain.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlin.test.*

@OptIn(ExperimentalCoroutinesApi::class)
class ContentReportViewModelTest {
    private class Repository : ContentReportsRepository {
        var record: ContentReportRecord? = null
        var submissions = 0
        var lookups = 0
        var clears = 0
        var gate: CompletableDeferred<Unit>? = null
        var failAfterSave = false
        override suspend fun saved() = record
        override suspend fun submit(reason: ContentReportReason, details: String, includeContent: Boolean, content: String): ContentReportRecord {
            submissions++
            record = ContentReportRecord(ContentReportPayload(requestId = "067ba243-89bd-411e-8ea7-5d939e426014",
                reason = reason.wire, details = details, includeContent = includeContent,
                content = if (includeContent) content else "", appVersion = "0.0.1"))
            gate?.await()
            if (failAfterSave) throw ContentReportException(ContentReportError.Unconfirmed)
            return record!!
        }
        override suspend fun checkReceipt(retryIfMissing: Boolean): ContentReportRecord { lookups++; return record!! }
        override suspend fun clearLocal() { clears++; record = null }
    }

    private fun runCase(block: suspend TestScope.() -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        try { block() } finally { Dispatchers.resetMain() }
    }

    @Test fun openingEditingDismissingAndRestoringNeverSends() = runCase {
        val repo = Repository(); val vm = ContentReportViewModel(repo)
        vm.open("private reply"); advanceUntilIdle()
        assertFalse(vm.state.value.includeContent)
        vm.reason(ContentReportReason.Privacy); vm.details("note"); vm.includeContent(true)
        vm.content("edited selected excerpt"); vm.dismiss(); vm.open("another reply"); advanceUntilIdle()
        assertEquals(0, repo.submissions); assertEquals(0, repo.lookups)
        assertFalse(vm.state.value.includeContent)
    }

    @Test fun doubleTapAndDismissWhileSendingPreserveOneRequest() = runCase {
        val repo = Repository().apply { gate = CompletableDeferred() }; val vm = ContentReportViewModel(repo)
        vm.open("reply"); advanceUntilIdle(); vm.reason(ContentReportReason.Other)
        vm.submit(); vm.submit(); runCurrent(); assertEquals(1, repo.submissions)
        vm.dismiss(); assertFalse(vm.state.value.open)
        repo.gate!!.complete(Unit); advanceUntilIdle()
        assertFalse(vm.state.value.open); assertNotNull(vm.state.value.record)
        vm.open(); advanceUntilIdle()
        assertTrue(vm.state.value.open); assertEquals(1, repo.submissions); assertEquals(0, repo.lookups)
    }

    @Test fun unknownResponseFreezesPayloadAndRecreationLoadsOnlyLocalState() = runCase {
        val repo = Repository().apply { failAfterSave = true }; val vm = ContentReportViewModel(repo)
        vm.open("reply"); advanceUntilIdle(); vm.reason(ContentReportReason.Unsafe); vm.submit(); advanceUntilIdle()
        assertEquals(ContentReportError.Unconfirmed, vm.state.value.error)
        val frozen = vm.state.value.record
        vm.reason(ContentReportReason.Other); vm.details("replacement"); vm.includeContent(true); vm.submit()
        assertEquals(frozen, vm.state.value.record); assertEquals(1, repo.submissions)
        val cold = ContentReportViewModel(repo); cold.open(); advanceUntilIdle()
        assertEquals(frozen, cold.state.value.record); assertEquals(0, repo.lookups)
        cold.checkReceipt(); advanceUntilIdle(); assertEquals(1, repo.lookups)
    }

    @Test fun noReasonNoReplyAndUnconfirmedClearCannotDispatchOrErase() = runCase {
        val repo = Repository(); val vm = ContentReportViewModel(repo)
        vm.open(); advanceUntilIdle(); vm.reason(ContentReportReason.Other); vm.submit()
        vm.open("reply"); advanceUntilIdle(); vm.submit(); assertEquals(0, repo.submissions)
        vm.clearLocal(); advanceUntilIdle(); assertEquals(0, repo.clears)
        vm.requestClear(); vm.cancelClear(); vm.clearLocal(); advanceUntilIdle(); assertEquals(0, repo.clears)
        vm.requestClear(); vm.clearLocal(); advanceUntilIdle(); assertEquals(1, repo.clears)
        assertFalse(vm.state.value.selectedReply)
    }
}
