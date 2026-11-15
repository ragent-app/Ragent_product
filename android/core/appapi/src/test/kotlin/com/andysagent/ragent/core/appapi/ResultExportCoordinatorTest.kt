package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.io.ByteArrayOutputStream
import kotlin.test.*

class ResultExportCoordinatorTest {
    private class Store(var row: TaskOperation = exportOperation()) : OperationStore {
        var afterReplace: () -> Unit = {}
        override suspend fun get(operationId: String) = row.takeIf { it.operationId == operationId }
        override suspend fun getByPreparation(preparationId: String) = row.takeIf { it.preparationId == preparationId }
        override suspend fun insert(operation: TaskOperation) = false
        override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
            if (row.revision != expectedRevision) return false
            row = operation; afterReplace(); return true
        }
    }
    private class Fixture {
        val owner = VerifiedCaller("owner"); val store = Store(); val carrier = ExportCarrier()
        var paired = true; var uiTarget = "pc-a"; var activeLease = false; var granted = true
        var grants = emptyList<CallerGrant>(); val targets = mutableListOf<String>()
        var onConnect: () -> Unit = {}
        val access = object : TargetTaskAccess {
            override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                targets += instanceId; assertEquals("pc-b", instanceId); assertFalse(activeLease)
                activeLease = true
                try {
                    onConnect()
                    val client = ResultExportClient(instanceId, carrier, now = { 1 })
                    return block(object : TaskTarget {
                        override suspend fun createSession(operation: TaskOperation): String = error("must not create")
                        override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt = error("must not send")
                        override suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt? = error("must not reconcile")
                        override suspend fun readResultExport(operation: TaskOperation, checkAccess: suspend () -> Unit) = client.readManifest(operation, checkAccess)
                        override suspend fun streamResultExport(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
                            checkAccess: suspend () -> Unit, prefix: ResultExportPrefix?, sink: suspend (ByteArray) -> Unit) = client.stream(operation, manifest, resourceId, checkAccess, prefix, sink)
                    })
                } finally { activeLease = false }
            }
        }
        fun coordinator() = TaskCoordinator(store, { TargetDirectorySnapshot(
            listOf(ApiTarget("pc-a", "UI")) + if (paired) listOf(ApiTarget("pc-b", "Original")) else emptyList(), uiTarget) },
            GrantAuthorizer("owner", { if (granted) grants else emptyList() }, now = { 1 }), access, now = { 1 })
        fun external(grantSession: String = "session", mayCreate: Boolean = false): VerifiedCaller {
            val caller = VerifiedCaller("external"); store.row = store.row.copy(callerBinding = caller.binding)
            grants = listOf(CallerGrant(caller.binding, setOf(CapabilityRegistry.TASKS_RESULT_EXPORT), setOf("pc-b"), 100,
                sessionIds = setOf(grantSession), mayCreateSessions = mayCreate))
            return caller
        }
    }

    @Test fun fixedComputerLeaseCoversEveryChunkAndSavedManifestRestoresWithoutIo() = runTest {
        val f = Fixture(); val coordinator = f.coordinator()
        f.carrier.afterRequest = { assertTrue(f.activeLease); f.uiTarget = "pc-b" }
        val queried = coordinator.readResultExport("op", f.owner)
        assertEquals("run", queried.runId); assertNotNull(queried.resultExport)
        // Reopen the journal, rather than carrying a mutable caller manifest into transfer.
        f.store.row = AppApiJson.decodeFromString<TaskOperation>(AppApiJson.encodeToString(f.store.row))
        val requestCount = f.carrier.requests.size
        assertEquals(queried.resultExport, f.coordinator().get("op", f.owner).resultExport)
        assertEquals(requestCount, f.carrier.requests.size)
        f.uiTarget = "pc-a"
        val output = ByteArrayOutputStream()
        val receipt = f.coordinator().streamResultExport("op", f.owner, queried.resultExport!!.revision, "text") {
            assertTrue(f.activeLease); output.write(it); f.uiTarget = "pc-a"
        }
        assertContentEquals(f.carrier.payload, output.toByteArray()); assertEquals(f.carrier.digest, receipt.sha256)
        assertEquals(listOf("pc-b", "pc-b"), f.targets); assertFalse(f.activeLease)
        assertTrue(f.carrier.requests.all { it.method == "GET" }); assertEquals(queried, f.store.row)
    }
    @Test fun actualCreatedSessionGrantIsRequiredEvenForPreviouslyPermittedCreators() = runTest {
        val f = Fixture(); val caller = f.external("other", mayCreate = true)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.coordinator().readResultExport("op", caller) }.error.code)
        assertTrue(f.targets.isEmpty()); assertTrue(f.carrier.requests.isEmpty())
        // Downloading existing resources does not require permission to create more Sessions.
        f.external("session", mayCreate = false)
        assertNotNull(f.coordinator().readResultExport("op", caller).resultExport)
    }
    @Test fun callerAndManifestRevisionCannotBeSubstituted() = runTest {
        val f = Fixture(); val operation = f.coordinator().readResultExport("op", f.owner)
        val before = f.carrier.requests.size
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator().streamResultExport("op", VerifiedCaller("forged"), operation.resultExport!!.revision, "text") {}
        }.error.code)
        assertEquals(ApiErrorCode.REVISION_CONFLICT, assertFailsWith<AppApiException> {
            f.coordinator().streamResultExport("op", f.owner, "a".repeat(64), "text") {}
        }.error.code)
        assertEquals(before, f.carrier.requests.size)
    }
    @Test fun unpairingWhileConnectingDoesNotFetchOrSaveManifest() = runTest {
        val f = Fixture(); f.onConnect = { f.paired = false }
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> { f.coordinator().readResultExport("op", f.owner) }.error.code)
        assertTrue(f.carrier.requests.isEmpty()); assertNull(f.store.row.resultExport); assertFalse(f.activeLease)
    }
    @Test fun grantRevokedDuringManifestIoPublishesNothing() = runTest {
        val f = Fixture(); val caller = f.external()
        f.carrier.afterRequest = { if (f.carrier.requests.last().path.endsWith("exports")) f.granted = false }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.coordinator().readResultExport("op", caller) }.error.code)
        assertNull(f.store.row.resultExport); assertFalse(f.activeLease)
    }
    @Test fun revocationDuringJournalWriteDoesNotReturnANewManifestToCaller() = runTest {
        val f = Fixture(); val caller = f.external()
        f.store.afterReplace = { f.granted = false }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.coordinator().readResultExport("op", caller) }.error.code)
        // Already committed private metadata can remain, but cannot be returned under a revoked grant.
        assertNotNull(f.store.row.resultExport); assertFalse(f.activeLease)
    }
    @Test fun revocationAfterOnePrivateChunkStopsFurtherRequestsAndDoesNotMarkComplete() = runTest {
        val f = Fixture(); val caller = f.external(); val op = f.coordinator().readResultExport("op", caller)
        var chunks = 0
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator().streamResultExport("op", caller, op.resultExport!!.revision, "text") { chunks++; f.granted = false }
        }.error.code)
        assertEquals(1, chunks); assertEquals(1, f.carrier.requests.count { '?' in it.path })
        assertEquals(op, f.store.row); assertFalse(f.activeLease)
    }
    @Test fun cancelledDownloadReleasesLeaseAndNeverCancelsRemoteWork() = runTest {
        val f = Fixture(); val op = f.coordinator().readResultExport("op", f.owner)
        assertFailsWith<CancellationException> {
            f.coordinator().streamResultExport("op", f.owner, op.resultExport!!.revision, "text") { throw CancellationException("user stopped download") }
        }
        assertFalse(f.activeLease); assertEquals(op, f.store.row); assertTrue(f.carrier.requests.all { it.method == "GET" })
    }
    @Test fun oldOperationJsonWithoutExportFieldStillRestores() {
        val encoded = AppApiJson.encodeToString(exportOperation())
        val old = kotlinx.serialization.json.JsonObject(AppApiJson.parseToJsonElement(encoded).let { it as kotlinx.serialization.json.JsonObject }.filterKeys { it != "resultExport" })
        assertNull(AppApiJson.decodeFromString<TaskOperation>(old.toString()).resultExport)
    }
}
