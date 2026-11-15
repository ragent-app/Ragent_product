package com.andysagent.ragent.core.appapi

import com.andysagent.ragent.core.domain.MessageSubmissionReceipt
import com.andysagent.ragent.core.domain.TargetFileAsset
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import java.io.IOException
import java.security.MessageDigest
import kotlin.test.*

class TaskResourceSubmissionTest {
    @Test fun resumeAfterAllFileReceiptsWereSavedReportsConfirmationWithoutReupload() = runTest {
        val f = Fixture(); val prepared = f.coordinator().prepare(f.request(), owner)
        assertFailsWith<kotlinx.coroutines.CancellationException> {
            f.coordinator().commit(prepared.preparationId, owner) {
                if (it.phase == TaskUploadPhase.CONFIRMED) throw kotlinx.coroutines.CancellationException("UI stopped waiting")
            }
        }
        val saved = f.store.rows.getValue(prepared.operationId)
        assertEquals(OperationStage.UPLOADING, saved.stage)
        assertEquals(1, saved.uploads.size); assertEquals(0, f.submits)
        val progress = mutableListOf<TaskUploadProgress>()
        val accepted = f.coordinator().commit(prepared.preparationId, owner) {
            assertEquals(0, f.submits); progress += it
        }
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        val observed = progress.single()
        assertEquals(TaskUploadPhase.CONFIRMED, observed.phase)
        assertEquals(1, observed.confirmedFiles); assertEquals(4L, observed.confirmedBytes)
        assertNull(observed.writtenBytes)
        assertEquals(1, f.uploads); assertEquals(1, f.submits)
    }

    @Test fun lostMessagePreparationRestoresFileProgressBeforeReadingOriginalPreparation() = runTest {
        val f = Fixture(); val prepared = f.coordinator().prepare(f.request(), owner)
        f.target.losePreparationReply = true
        val unknown = f.coordinator().commit(prepared.preparationId, owner)
        assertEquals(OperationStage.MESSAGE_PREPARING, unknown.stage)
        val progress = mutableListOf<TaskUploadProgress>()
        val accepted = f.coordinator().commit(prepared.preparationId, owner) {
            assertEquals(0, f.target.preparationLookups); progress += it
        }
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals(1, progress.single().confirmedFiles)
        assertEquals(1, f.uploads); assertEquals(1, f.submits)
        assertEquals(1, f.target.preparationWrites); assertEquals(1, f.target.preparationLookups)
    }

    @Test fun inconsistentSavedReceiptPreventsFurtherUploadsAndConfirmationOnResume() = runTest {
        val f = Fixture(); val second = ref.copy(resourceId = "resource-two")
        val prepared = f.coordinator().prepare(f.request().copy(resources = listOf(ref, second)), owner)
        assertFailsWith<kotlinx.coroutines.CancellationException> {
            f.coordinator().commit(prepared.preparationId, owner) {
                if (it.phase == TaskUploadPhase.CONFIRMED) throw kotlinx.coroutines.CancellationException("UI stopped waiting")
            }
        }
        val saved = f.store.rows.getValue(prepared.operationId)
        f.store.rows[prepared.operationId] = saved.copy(uploads = listOf(saved.uploads.single().copy(sha256 = "b".repeat(64))))
        val progress = mutableListOf<TaskUploadProgress>()
        val failure = assertFailsWith<AppApiException> { f.coordinator().commit(prepared.preparationId, owner, progress::add) }
        assertEquals(ApiErrorCode.REVISION_CONFLICT, failure.error.code)
        assertTrue(progress.isEmpty()); assertEquals(1, f.uploads); assertEquals(0, f.submits)
    }

    @Test fun uploadProgressCountsOnlySavedReceiptsAndKeepsOriginalTarget() = runTest {
        val f = Fixture(); val c = f.coordinator()
        val second = ref.copy(resourceId = "resource-two", sizeBytes = 7)
        val prepared = c.prepare(f.request().copy(resources = listOf(ref, second)), owner)
        f.directory = f.directory.copy(defaultShareTargetId = "pc-b")
        val progress = mutableListOf<TaskUploadProgress>()
        c.commit(prepared.preparationId, owner) {
            progress += it
            val saved = f.store.rows.getValue(it.operationId)
            assertEquals(saved.uploads.size, it.confirmedFiles)
            assertEquals(saved.uploads.sumOf { receipt -> receipt.sizeBytes }, it.confirmedBytes)
            assertEquals(0, f.submits)
        }
        assertTrue(progress.all { it.targetInstanceId == "pc-a" && it.totalBytes == 11L && it.totalFiles == 2 })
        val confirmed = progress.filter { it.phase == TaskUploadPhase.CONFIRMED }
        assertEquals(listOf(1, 2), confirmed.map { it.confirmedFiles })
        assertEquals(listOf(4L, 11L), confirmed.map { it.confirmedBytes })
        assertEquals(1, f.submits)
    }

    @Test fun lostOrMismatchedUploadReceiptCannotAdvanceConfirmedProgress() = runTest {
        for (mismatched in listOf(false, true)) {
            val f = Fixture(); val c = f.coordinator()
            f.loseUpload = !mismatched; f.wrongReceipt = mismatched
            val prepared = c.prepare(f.request(), owner)
            val progress = mutableListOf<TaskUploadProgress>()
            val operation = c.commit(prepared.preparationId, owner, progress::add)
            assertTrue(operation.uploads.isEmpty())
            assertTrue(progress.isNotEmpty())
            assertTrue(progress.all { it.confirmedFiles == 0 && it.confirmedBytes == 0L })
            assertTrue(progress.none { it.phase == TaskUploadPhase.CONFIRMED })
            assertEquals(0, f.submits)
        }
    }

    private val owner = VerifiedCaller("owner")
    private val ref = CaptureResourceRef("resource-one", 1, "sample.csv", "text/csv", 4, "a".repeat(64))
    private class Store : OperationStore {
        val rows = mutableMapOf<String, TaskOperation>()
        override suspend fun get(operationId: String) = rows[operationId]
        override suspend fun getByPreparation(preparationId: String) = rows.values.firstOrNull { it.preparationId == preparationId }
        override suspend fun insert(operation: TaskOperation): Boolean = rows.putIfAbsent(operation.operationId, operation) == null
        override suspend fun replace(operation: TaskOperation, expectedRevision: Long): Boolean {
            if (rows[operation.operationId]?.revision != expectedRevision) return false
            rows[operation.operationId] = operation; return true
        }
    }
    private inner class Fixture {
        val store = Store()
        var directory = TargetDirectorySnapshot(listOf(ApiTarget("pc-a", "Office"), ApiTarget("pc-b", "Home")), "pc-a")
        var time = 100L
        var creates = 0; var submits = 0; var uploads = 0; var accesses = 0
        var missingResource = false; var unsupported = false; var loseUpload = false; var wrongReceipt = false
        var loseMessage = false
        var loseResourceId: String? = null
        val uploaded = mutableMapOf<String, TargetFileAsset>()
        val uploadedKeys = mutableListOf<String>()
        var afterUpload: () -> Unit = {}
        var submitted: TaskOperation? = null
        val target = object : ScopedFixtureTaskTarget() {
            override suspend fun requireUploadSupport() {
                if (unsupported) apiFailure(ApiErrorCode.CAPABILITY_UNSUPPORTED, "Unsupported target")
            }
            override suspend fun createSession(operation: TaskOperation): String { creates++; return "s" }
            override suspend fun uploadAttachment(operation: TaskOperation, sessionId: String, resource: CaptureResourceRef, bytes: ByteArray): TargetFileAsset {
                uploads++
                val key = resourceUploadRequestId(operation, resource); uploadedKeys += key
                val receipt = uploaded.getOrPut(key) { TargetFileAsset(operation.targetInstanceId, sessionId,
                    "fasset_${MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)}", resource.originalName, resource.mimeType, resource.sizeBytes, resource.sha256, true) }
                afterUpload()
                if (loseUpload || loseResourceId == resource.resourceId) {
                    loseUpload = false; loseResourceId = null; throw IOException("Finalize reply lost")
                }
                return if (wrongReceipt) receipt.copy(instanceId = "pc-other") else receipt
            }
            override suspend fun submitMessage(operation: TaskOperation, sessionId: String): MessageSubmissionReceipt {
                requireCompleteUploads(operation, sessionId)
                submits++; submitted = operation
                if (loseMessage) { loseMessage = false; throw IOException("Message reply lost") }
                return MessageSubmissionReceipt(sessionId, operation.messageRequestId, false, true, null)
            }
            override suspend fun findReceipt(operation: TaskOperation, sessionId: String) =
                MessageSubmissionReceipt(sessionId, operation.messageRequestId, false, true, null).takeIf { submits > 0 }
        }
        fun coordinator() = TaskCoordinator(store, { directory }, GrantAuthorizer(owner.binding, { emptyList() }),
            object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T { accesses++; return block(target) }
            }, now = { time }, resources = object : TaskResources {
                override suspend fun validate(refs: List<CaptureResourceRef>, caller: VerifiedCaller) {
                    if (refs.isNotEmpty() && missingResource) apiFailure(ApiErrorCode.RESOURCE_NOT_FOUND, "Resource unavailable")
                }
                override suspend fun read(ref: CaptureResourceRef, caller: VerifiedCaller) = ByteArray(ref.sizeBytes.toInt())
            })
        fun request() = TaskRequest("resource-op", "Analyze sample", TaskRuntime("codex"), resources = listOf(ref), deadlineAt = 1000)
    }

    @Test fun resourcesFreezeAndPersistBeforeMessageWhileTargetChangesCannotRetarget() = runTest {
        val f = Fixture(); val c = f.coordinator()
        val mutable = mutableListOf(ref)
        val prepared = c.prepare(f.request().copy(resources = mutable), owner)
        assertEquals(0, f.accesses)
        mutable.clear(); f.directory = f.directory.copy(defaultShareTargetId = "pc-b")
        val accepted = c.commit(prepared.preparationId, owner)
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals("pc-a", accepted.targetInstanceId)
        assertEquals(ref.resourceId, accepted.uploads.single().resourceId)
        assertEquals(accepted.uploads, f.submitted!!.uploads)
        assertEquals(1, f.creates); assertEquals(1, f.submits)
        assertTrue(accepted.queued)
    }

    @Test fun uploadReplyLossReopenResumesOriginalKeysAndOnlyOneMessage() = runTest {
        val f = Fixture(); var c = f.coordinator()
        val prepared = c.prepare(f.request(), owner)
        f.loseUpload = true
        val unknown = c.commit(prepared.preparationId, owner)
        assertEquals(OperationStage.UPLOADING, unknown.stage)
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, unknown.lastError!!.code)
        assertEquals(0, f.submits)
        c = f.coordinator()
        assertEquals(unknown, c.get(unknown.operationId, owner))
        val accepted = c.commit(prepared.preparationId, owner)
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals(1, f.uploaded.size)
        assertEquals(f.uploadedKeys.first(), f.uploadedKeys.last())
        assertEquals(1, f.creates); assertEquals(1, f.submits)
    }

    @Test fun messageReplyLossReconciliationNeverReuploadsFilesOrSendsMessage() = runTest {
        val f = Fixture(); val c = f.coordinator(); val prep = c.prepare(f.request(), owner)
        f.loseMessage = true
        val unknown = c.commit(prep.preparationId, owner)
        assertEquals(OperationStage.SUBMITTING, unknown.stage)
        assertEquals(1, unknown.uploads.size)
        assertEquals(OperationStage.ACCEPTED, c.reconcile(unknown.operationId, owner).stage)
        assertEquals(1, f.uploads); assertEquals(1, f.submits)
    }

    @Test fun partialBatchResumeSkipsJournalledFileAndKeepsBothOriginalUploadIdentities() = runTest {
        val f = Fixture()
        val second = ref.copy(resourceId = "resource-two", originalName = "second.csv")
        val prep = f.coordinator().prepare(f.request().copy(resources = listOf(ref, second)), owner)
        f.loseResourceId = second.resourceId
        val unknown = f.coordinator().commit(prep.preparationId, owner)
        assertEquals(OperationStage.UPLOADING, unknown.stage)
        assertEquals(listOf(ref.resourceId), unknown.uploads.map { it.resourceId })
        assertEquals(0, f.submits)
        val accepted = f.coordinator().commit(prep.preparationId, owner)
        assertEquals(OperationStage.ACCEPTED, accepted.stage)
        assertEquals(listOf(ref.resourceId, second.resourceId), accepted.uploads.map { it.resourceId })
        assertEquals(2, accepted.uploads.map { it.assetId }.distinct().size)
        assertEquals(3, f.uploads)
        assertEquals(1, f.uploadedKeys.count { it == f.uploadedKeys.first() })
        assertEquals(f.uploadedKeys[1], f.uploadedKeys[2])
        assertEquals(1, f.creates); assertEquals(1, f.submits)
    }

    @Test fun missingResourceAndOldTargetCannotCreateSessionOrSendMessage() = runTest {
        val f = Fixture(); val c = f.coordinator()
        f.missingResource = true
        assertFailsWith<AppApiException> { c.prepare(f.request(), owner) }
        assertTrue(f.store.rows.isEmpty()); assertEquals(0, f.accesses)
        f.missingResource = false
        val prep = c.prepare(f.request(), owner)
        f.unsupported = true
        assertEquals(ApiErrorCode.CAPABILITY_UNSUPPORTED, c.commit(prep.preparationId, owner).lastError!!.code)
        assertEquals(0, f.creates); assertEquals(0, f.uploads); assertEquals(0, f.submits)
    }

    @Test fun wrongPcReceiptCannotBeSubmittedAndUnpairAfterUploadStopsMessage() = runTest {
        val bad = Fixture(); val b = bad.coordinator(); val prep = b.prepare(bad.request(), owner)
        bad.wrongReceipt = true
        assertEquals(ApiErrorCode.RESULT_UNKNOWN, b.commit(prep.preparationId, owner).lastError!!.code)
        assertEquals(0, bad.submits)
        val revoked = Fixture(); val r = revoked.coordinator(); val prepared = r.prepare(revoked.request(), owner)
        revoked.afterUpload = { revoked.directory = TargetDirectorySnapshot(emptyList()) }
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, assertFailsWith<AppApiException> { r.commit(prepared.preparationId, owner) }.error.code)
        assertEquals(ApiErrorCode.TARGET_NOT_FOUND, revoked.store.rows[prepared.operationId]!!.lastError!!.code)
        assertEquals(0, revoked.submits)
    }

    @Test fun cancellationDuringUnknownUploadPreventsResumeAndDoesNotCancelARun() = runTest {
        val f = Fixture(); val c = f.coordinator(); val prep = c.prepare(f.request(), owner)
        f.loseUpload = true; c.commit(prep.preparationId, owner)
        assertEquals(OperationStage.CANCELLED, c.cancelSubmission(prep.operationId, owner).stage)
        assertFailsWith<AppApiException> { c.commit(prep.preparationId, owner) }
        assertEquals(0, f.submits); assertEquals(1, f.uploads)
    }

    @Test fun textOnlyPreparationFingerprintRemainsCompatibleWithV2Journal() = runTest {
        val f = Fixture(); val request = f.request().copy(resources = emptyList())
        val legacy = AppApiJson.encodeToString(request).replace(",\"resources\":[]", "")
        assertFalse("resources" in legacy)
        val digest = MessageDigest.getInstance("SHA-256").digest(legacy.toByteArray()).joinToString("") { "%02x".format(it) }
        val old = TaskOperation(request.operationId, owner.binding, digest, "old-prep", "pc-a", request,
            "old-create", "old-message", 1, 1000)
        f.store.insert(old)
        assertEquals("old-prep", f.coordinator().prepare(request, owner).preparationId)
        assertEquals(0, f.accesses)
    }

    @Test fun invalidOrDuplicateResourcesAreRejectedBeforeDirectoryEffects() = runTest {
        for (refs in listOf(listOf(ref, ref), listOf(ref.copy(sha256 = "invalid")), listOf(ref.copy(sizeBytes = 0)),
            (1..17).map { ref.copy(resourceId = "resource-$it") })) {
            val f = Fixture()
            assertFailsWith<AppApiException> { f.coordinator().prepare(f.request().copy(resources = refs), owner) }
            assertTrue(f.store.rows.isEmpty()); assertEquals(0, f.accesses)
        }
    }
}
