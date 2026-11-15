package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import com.andysagent.ragent.core.domain.TargetFileAsset
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/** Actual PC context, grant refresh and side-effect counts; no caller project assertion is trusted. */
class ProjectScopedTasksTest {
    private val caller = VerifiedCaller("external")
    private class Store : OperationStore {
        var row: TaskOperation? = null
        override suspend fun get(operationId: String) = row?.takeIf { it.operationId == operationId }
        override suspend fun getByPreparation(preparationId: String) = row?.takeIf { it.preparationId == preparationId }
        override suspend fun insert(operation: TaskOperation): Boolean {
            if (row != null) return false
            row = operation; return true
        }
        override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
            if (row?.revision != expectedRevision) return false
            row = operation; return true
        }
    }
    private class Pc : ScopedFixtureTaskTarget() {
        var project: String? = "project-a"
        var wrongId = false
        var unsupported = false
        var onContext: suspend () -> Unit = {}
        var afterResult: suspend () -> Unit = {}
        var afterManifest: suspend () -> Unit = {}
        var afterStream: suspend () -> Unit = {}
        var manifests = 0; var streams = 0
        private val digest = java.security.MessageDigest.getInstance("SHA-256").digest(byteArrayOf(1))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        override suspend fun readResultExport(operation: TaskOperation, checkAccess: suspend () -> Unit): ResultExportManifest {
            manifests++; afterManifest()
            return ResultExportManifest(1, operation.targetInstanceId, operation.sessionId!!, operation.messageRequestId,
                operation.runId!!, operation.messageRequestId, listOf(ResultExportResource("text", "output.txt", "text/plain", true, 1, digest)),
                1, 65536, "2099-01-01T00:00:00Z", "d".repeat(64))
        }
        override suspend fun streamResultExport(operation: TaskOperation, manifest: ResultExportManifest, resourceId: String,
            checkAccess: suspend () -> Unit, prefix: ResultExportPrefix?, sink: suspend (ByteArray) -> Unit): ResultExportReceipt {
            streams++; sink(byteArrayOf(1)); afterStream()
            return ResultExportReceipt(manifest.revision, resourceId, 1, digest)
        }
        var uploads = 0
        var afterUpload: suspend () -> Unit = {}
        override suspend fun requireUploadSupport() {}
        override suspend fun uploadAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef, bytes: ByteArray): TargetFileAsset {
            uploads++; afterUpload()
            return TargetFileAsset(operation.targetInstanceId, sessionId, "fasset_${java.util.UUID.nameUUIDFromBytes(resource.resourceId.toByteArray()).toString().replace("-", "").take(24)}",
                resource.originalName, resource.mimeType, resource.sizeBytes, resource.sha256, true)
        }
        var contexts = 0; var creates = 0; var messages = 0; var receipts = 0; var results = 0
        override suspend fun sessionContext(sessionId: String): TaskSessionContext {
            contexts++; onContext()
            if (unsupported) throw AppApiException(ApiError(ApiErrorCode.CAPABILITY_UNSUPPORTED, "No context endpoint"))
            return TaskSessionContext(if (wrongId) "other" else sessionId, project)
        }
        override suspend fun createSession(operation: TaskOperation): String { creates++; return "session" }
        override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt {
            messages++; return MessageSubmissionReceipt(sessionId, operation.messageRequestId, false, true, null)
        }
        override suspend fun findReceipt(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt? { receipts++; return null }
        override suspend fun readResult(operation: TaskOperation): TaskResultSnapshot {
            results++; afterResult()
            return TaskResultSnapshot(operation.sessionId!!, operation.messageRequestId, operation.runId, operation.messageRequestId,
                TaskResultState.QUEUED, null, false, emptyList(), "2026-10-11T00:00:00Z")
        }
    }
    private inner class Fixture {
        val store = Store(); val pc = Pc()
        var paired = true
        var timestamp = 100L
        var grants = listOf(CallerGrant(caller.binding, CapabilityRegistry.coreCapabilities.map { it.id }.toSet(),
            setOf("pc"), 10_000, projectIds = setOf("project-a"), mayCreateSessions = true))
        var leases = 0
        var onRead: suspend () -> Unit = {}
        val coordinator = TaskCoordinator(store,
            { TargetDirectorySnapshot(if (paired) listOf(ApiTarget("pc", "PC")) else emptyList(), "pc") },
            GrantAuthorizer("owner", { grants }, { timestamp }), object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T {
                    assertEquals("pc", instanceId); leases++; return block(pc)
                }
            }, now = { timestamp }, resources = object : TaskResources {
                override suspend fun validate(refs: List<CaptureResourceRef>, caller: VerifiedCaller) {}
                override suspend fun read(ref: CaptureResourceRef, caller: VerifiedCaller): ByteArray { onRead(); return byteArrayOf(1) }
            })
        fun request(existing: String? = "session") = TaskRequest("op", "Do the work", TaskRuntime("codex"),
            targetInstanceId = "pc", existingSessionId = existing, projectId = "project-a", deadlineAt = 1000)
        suspend fun commit(request: TaskRequest = request()): TaskOperation =
            coordinator.commit(coordinator.prepare(request, caller).preparationId, caller)
    }

    @Test fun spoofedProjectCannotAuthorizeAnotherProjectSession() = runTest {
        val f = Fixture(); f.pc.project = "project-b"
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.prepare(f.request(), caller)
        }.error.code)
        assertEquals(1, f.leases); assertNull(f.store.row)
        assertEquals(0, f.pc.messages); assertEquals(0, f.pc.creates)
    }
    @Test fun actualMatchingContextAllowsSubmissionAndRetainedReads() = runTest {
        val f = Fixture(); val accepted = f.commit()
        assertEquals(OperationStage.ACCEPTED, accepted.stage); assertEquals(1, f.pc.messages)
        f.coordinator.reconcile("op", caller)
        assertEquals(1, f.pc.receipts)
        assertEquals(TaskResultState.QUEUED, f.coordinator.readResult("op", caller).result?.state)
        assertEquals(1, f.pc.results); assertTrue(f.pc.contexts >= 5)
    }
    @Test fun omittedProjectIsResolvedFromPcButCannotAuthorizeUnscopedCreation() = runTest {
        val f = Fixture()
        f.coordinator.prepare(f.request().copy(projectId = null), caller)
        assertEquals("project-a", f.store.row!!.originalScope!!.expectedProjectId)
        val creation = Fixture()
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            creation.coordinator.prepare(creation.request(null).copy(projectId = null), caller)
        }.error.code)
        assertEquals(0, creation.leases); assertNull(creation.store.row)
    }
    @Test fun wrongContextIdentityOrMissingEndpointDoesNotDispatch() = runTest {
        val mismatch = Fixture(); mismatch.pc.wrongId = true
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, assertFailsWith<AppApiException> { mismatch.commit() }.error.code)
        assertEquals(0, mismatch.pc.messages)
        val unavailable = Fixture(); unavailable.pc.unsupported = true
        assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, assertFailsWith<AppApiException> { unavailable.commit() }.error.code)
        assertEquals(0, unavailable.pc.messages)
    }
    @Test fun revocationDuringContextLookupPreventsSubmission() = runTest {
        val f = Fixture(); f.pc.onContext = { f.grants = emptyList() }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.commit() }.error.code)
        assertEquals(0, f.pc.messages)
    }
    @Test fun unpairingDuringContextLookupPreventsSubmission() = runTest {
        val f = Fixture(); f.pc.onContext = { f.paired = false }
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> { f.commit() }.error.code)
        assertEquals(0, f.pc.messages)
    }
    @Test fun unexpectedCreatedSessionProjectNeverStartsWorkOrCreatesAgain() = runTest {
        val f = Fixture(); f.pc.project = "project-b"
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.commit(f.request(null)) }.error.code)
        val denied = f.store.row!!
        assertEquals("session", denied.sessionId); assertEquals(1, f.pc.creates); assertEquals(0, f.pc.messages)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.commit(denied.preparationId, caller)
        }.error.code)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.coordinator.get(denied.operationId, caller) }.error.code)
        assertTrue(denied.receiptEnvelope().resources.isEmpty())
        assertEquals(1, f.pc.creates); assertEquals(0, f.pc.messages)
    }
    @Test fun projectMoveStopsRemoteReconciliationResultAndManifestReads() = runTest {
        val f = Fixture(); f.commit(); f.pc.project = "project-b"
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.coordinator.reconcile("op", caller) }.error.code)
        assertEquals(0, f.pc.receipts)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.readResult("op", caller)
        }.error.code)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.readResultExport("op", caller)
        }.error.code)
        assertEquals(0, f.pc.results)
    }
    @Test fun broaderGrantCannotRelabelRetainedOutputWithFalseProject() = runTest {
        val f = Fixture(); f.grants = f.grants.map { it.copy(projectIds = null) }; f.pc.project = "project-b"
        assertEquals(ApiErrorCode.REVISION_CONFLICT, assertFailsWith<AppApiException> { f.commit() }.error.code)
        assertEquals(0, f.pc.messages)
    }
    @Test fun contextLookupCannotExtendSubmissionDeadline() = runTest {
        val f = Fixture(); f.pc.onContext = { f.timestamp = 1001 }
        assertEquals(ApiErrorCode.REQUEST_EXPIRED, assertFailsWith<AppApiException> { f.commit() }.error.code)
        assertEquals(0, f.pc.messages)
    }
    @Test fun moveDuringResultReadPreventsSnapshotPublication() = runTest {
        val f = Fixture(); f.commit(); f.pc.afterResult = { f.pc.project = "project-b" }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.readResult("op", caller)
        }.error.code)
        assertEquals(1, f.pc.results); assertNull(f.store.row?.result)
    }
    @Test fun projectMoveDuringManifestReadDoesNotPersistPublication() = runTest {
        val f = Fixture(); f.commit(); f.pc.afterManifest = { f.pc.project = "project-b" }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.readResultExport("op", caller)
        }.error.code)
        assertEquals(1, f.pc.manifests); assertNull(f.store.row?.resultExport)
    }
    @Test fun projectMoveDuringDownloadDoesNotReturnVerifiedReceipt() = runTest {
        val f = Fixture(); f.commit()
        val manifest = f.coordinator.readResultExport("op", caller).resultExport!!
        f.pc.afterStream = { f.pc.project = "project-b" }
        var privateBytes = 0
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.coordinator.streamResultExport("op", caller, manifest.revision, "text") { privateBytes += it.size }
        }.error.code)
        assertEquals(1, f.pc.streams); assertEquals(1, privateBytes)
        // The private sink cannot publish bytes without the missing verified receipt.
    }
    private fun attachment() = CaptureResourceRef("00000000-0000-0000-0000-000000000000", 1,
        "input.txt", "text/plain", 1, "a".repeat(64))
    @Test fun projectMoveDuringPrivateResourceReadCannotPublishAttachment() = runTest {
        val f = Fixture(); f.onRead = { f.pc.project = "project-b" }
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> {
            f.commit(f.request().copy(resources = listOf(attachment())))
        }.error.code)
        assertEquals(ApiErrorCode.PERMISSION_DENIED, f.store.row!!.lastError?.code)
        assertEquals(0, f.pc.uploads); assertEquals(0, f.pc.messages)
    }
    @Test fun moveAfterFirstAttachmentPreservesReceiptAndStopsNextEffect() = runTest {
        val f = Fixture(); f.pc.afterUpload = { f.pc.project = "project-b" }
        val refs = listOf(attachment(), attachment().copy(resourceId = "00000000-0000-0000-0000-000000000001"))
        assertEquals(ApiErrorCode.PERMISSION_DENIED, assertFailsWith<AppApiException> { f.commit(f.request().copy(resources = refs)) }.error.code)
        val denied = f.store.row!!
        assertEquals(ApiErrorCode.PERMISSION_DENIED, denied.lastError?.code)
        assertEquals(1, f.pc.uploads); assertEquals(1, denied.uploads.size); assertEquals(0, f.pc.messages)
        f.pc.project = "project-a"; f.pc.afterUpload = {}
        assertEquals(OperationStage.ACCEPTED, f.coordinator.commit(denied.preparationId, caller).stage)
        assertEquals(2, f.pc.uploads); assertEquals(1, f.pc.messages)
    }
    @Test fun matchingCreateContextRetainsCreationPermissionSemantics() = runTest {
        val f = Fixture()
        assertEquals(OperationStage.ACCEPTED, f.commit(f.request(null)).stage)
        assertEquals(1, f.pc.creates); assertEquals(1, f.pc.messages)
    }
}
