package com.andysagent.ragent.core.appapi

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Real private files, Room and OS locks. Crash windows are constructed; no whole-process claim. */
class DocumentSaveJournalTest {
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var db: AppApiDatabase
    private lateinit var outputs: PersistentResultOutputs
    private lateinit var cache: ResultDeliveryCache
    private val caller = VerifiedCaller("external")
    private var granted = true
    private var now = 10L
    private val bytes = "文档保存🙂\n".repeat(1000).toByteArray()
    private fun sha() = MessageDigest.getInstance("SHA-256").digest(bytes).hex()
    private fun metadata(id: String) = File(context.noBackupFilesDir, "ragent-document-saves/$id.json")
    private fun source() = File(context.noBackupFilesDir, "ragent-result-outputs/download.bin")
    private fun journal(limit: Int = 256) = DocumentSaveJournal(context, outputs, cache, now = { now }, maximumRecords = limit)
    @Before fun setup() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<Context>()
        root = File(app.cacheDir, "document-save-test-${UUID.randomUUID()}").apply { mkdirs() }
        context = object : ContextWrapper(app) {
            override fun getApplicationContext() = this
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
            override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
        }
        open()
        val manifest = ResultExportManifest(1, "pc", "session", "request", "run", "final",
            listOf(ResultExportResource("text", "报告.txt", "text/plain", true, bytes.size.toLong(), sha())),
            bytes.size.toLong(), 65536, "2099-01-01T00:00:00Z", "b".repeat(64))
        assertTrue(RoomOperationStore(db).insert(TaskOperation("op", caller.binding, "hash", "prep", "pc",
            TaskRequest("op", "Synthetic", TaskRuntime("tool"), existingSessionId = "session"), "create", "request", 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", resultExport = manifest)))
        val output = ResultOutput("download", "op", caller.binding, manifest, "text", now, now,
            state = ResultOutputState.READY, receivedBytes = bytes.size.toLong(), prefixSha256 = sha(), verifiedAt = now)
        assertTrue(db.outputs().insert(output.entity()) != -1L)
        source().parentFile!!.mkdirs(); source().writeBytes(bytes)
    }
    private fun open() {
        db = Room.databaseBuilder(context, AppApiDatabase::class.java, File(root, "journal.db").absolutePath).build()
        val coordinator = TaskCoordinator(RoomOperationStore(db), { TargetDirectorySnapshot(emptyList(), null) },
            GrantAuthorizer("owner", { if (granted) listOf(CallerGrant(caller.binding,
                setOf(CapabilityRegistry.TASKS_RESULT_EXPORT, CapabilityRegistry.TASKS_GET), setOf("pc"), Long.MAX_VALUE,
                sessionIds = setOf("session"))) else emptyList() }, now = { now }),
            object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T = error("Save journal must not contact PC")
            }, now = { now })
        outputs = PersistentResultOutputs(context, db, coordinator, now = { now })
        cache = ResultDeliveryCache(context, outputs, now = { now }, lifetimeMillis = 100)
    }
    @After fun cleanup() {
        db.close()
        assertTrue(root.name.startsWith("document-save-test-"))
        assertEquals(ApplicationProvider.getApplicationContext<Context>().cacheDir.canonicalFile, root.canonicalFile.parentFile)
        root.deleteRecursively()
    }
    private suspend fun prepare() = cache.stage("download", caller).also { journal().prepare("op", it.id, caller) }
    private suspend fun expect(code: ApiErrorCode, block: suspend () -> Unit) {
        try { block(); fail("Expected $code") } catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
    }
    @Test fun prepareAndCompletedCopySurviveRoomAndJournalColdReopen() = runBlocking {
        val ticket = prepare(); val received = ByteArrayOutputStream()
        assertEquals(DocumentSaveState.WAITING_SELECTION, journal().list("op", caller).single().state)
        journal().copy("op", ticket.id, caller) { cache.copy(ticket.id, caller) { received.write(it) } }
        assertArrayEquals(bytes, received.toByteArray()); assertArrayEquals(bytes, source().readBytes())
        db.close(); open()
        val saved = journal().list("op", caller, recover = true).single()
        assertEquals(DocumentSaveState.SAVED, saved.state); assertTrue(saved.copyStarted)
        assertFalse(metadata(ticket.id).readText().contains("content://"))
    }
    @Test fun duplicateCallbackAndRepeatedPrepareNeverInvokeWriterTwice() = runBlocking {
        val ticket = prepare(); var writes = 0
        journal().copy("op", ticket.id, caller) { writes++; ticket }
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { writes++; ticket } }
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().prepare("op", ticket.id, caller) }
        assertEquals(1, writes)
    }
    @Test fun differentCallerAndOperationCannotPrepareCancelOrWrite() = runBlocking {
        val ticket = prepare()
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().prepare("other", ticket.id, caller) }
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().cancelSelection("other", ticket.id, caller) }
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().copy("other", ticket.id, caller) { error("Writer reached") } }
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().cancelSelection("op", ticket.id, VerifiedCaller("foreign")) }
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().copy("op", ticket.id, VerifiedCaller("foreign")) { error("Writer reached") } }
    }
    @Test fun cancelledSelectorIsDurableAndCannotLaterWrite() = runBlocking {
        val ticket = prepare(); journal().cancelSelection("op", ticket.id, caller)
        journal().cancelSelection("op", ticket.id, caller)
        assertEquals(DocumentSaveState.CANCELLED, journal().list("op", caller, true).single().state)
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Writer reached") } }
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun failedWriterPreservesSourceAndRecordsPossiblePartialDocument() = runBlocking {
        val ticket = prepare()
        try { journal().copy("op", ticket.id, caller) { throw java.io.IOException("Provider failed") }; fail("Expected IO failure") }
        catch (_: java.io.IOException) { }
        val row = journal().list("op", caller, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertTrue(row.copyStarted)
        assertEquals(ApiErrorCode.INTERNAL_ERROR, row.error); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun revokedAuthorizationAfterWriterPreventsSavedReceiptAndRecoveryRead() = runBlocking {
        val ticket = prepare()
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().copy("op", ticket.id, caller) { granted = false; ticket } }
        expect(ApiErrorCode.PERMISSION_DENIED) { journal().list("op", caller, true) }
        granted = true
        val row = journal().list("op", caller).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertEquals(ApiErrorCode.PERMISSION_DENIED, row.error)
    }
    @Test fun cancellingCopyPersistsInterruptedBeforeLeaseIsReleased() = runBlocking {
        val ticket = prepare(); val started = CompletableDeferred<Unit>()
        val writing = launch(Dispatchers.IO) { journal().copy("op", ticket.id, caller) { started.complete(Unit); awaitCancellation() } }
        started.await(); writing.cancelAndJoin()
        val row = journal().list("op", caller, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertEquals(ApiErrorCode.CANCELLED, row.error)
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun recoveryDoesNotInterruptActiveOsLeaseOrAllowSecondWriter() = runBlocking {
        val ticket = prepare(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        val writing = async(Dispatchers.IO) { journal().copy("op", ticket.id, caller) { started.complete(Unit); finish.await(); ticket } }
        started.await()
        assertEquals(DocumentSaveState.COPYING, journal().list("op", caller, true).single().state)
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Second writer reached") } }
        finish.complete(Unit); writing.await()
        assertEquals(DocumentSaveState.SAVED, journal().list("op", caller, true).single().state)
    }
    @Test fun orphanedCopyBecomesInterruptedAndNeverChangesExternalBytes() = runBlocking {
        val ticket = prepare()
        val record = AppApiJson.decodeFromString<DocumentSaveRecord>(metadata(ticket.id).readText())
        metadata(ticket.id).writeText(AppApiJson.encodeToString(record.copy(state = DocumentSaveState.COPYING, copyStarted = true, revision = 1)))
        val destination = File(root, "external-document").apply { writeBytes(bytes) }
        db.close(); open()
        val row = journal().list("op", caller, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertEquals(ApiErrorCode.RESULT_UNKNOWN, row.error)
        assertArrayEquals(bytes, destination.readBytes())
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Replay reached") } }
    }
    @Test fun expiredWaitingSelectionHasNoClaimOfPartialExternalWrite() = runBlocking {
        val ticket = prepare(); now = 200
        val row = journal().list("op", caller, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertFalse(row.copyStarted)
        assertEquals(ApiErrorCode.REQUEST_EXPIRED, row.error)
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Expired writer reached") } }
    }
    @Test fun savedHistoryRemainsAfterTemporaryTicketExpiry() = runBlocking {
        val ticket = prepare(); journal().copy("op", ticket.id, caller) { ticket }; now = 200
        assertEquals(DocumentSaveState.SAVED, journal().list("op", caller, true).single().state)
    }
    @Test fun clearFinishedRetainsActiveSelectorsAndActualFiles() = runBlocking {
        val first = prepare(); journal().cancelSelection("op", first.id, caller)
        val pending = prepare(); journal().clearFinished("op", caller)
        assertEquals(listOf(pending.id), journal().list("op", caller).map { it.ticketId })
        assertFalse(metadata(first.id).exists()); assertTrue(metadata(pending.id).exists())
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun metadataQuotaCanBeFreedByExplicitFinishedHistoryClear() = runBlocking {
        val first = cache.stage("download", caller); journal(1).prepare("op", first.id, caller)
        journal().cancelSelection("op", first.id, caller)
        val second = cache.stage("download", caller)
        expect(ApiErrorCode.RESOURCE_LIMIT) { journal(1).prepare("op", second.id, caller) }
        journal().clearFinished("op", caller); journal(1).prepare("op", second.id, caller)
        assertEquals(second.id, journal().list("op", caller).single().ticketId)
    }
    @Test fun corruptOrFutureMetadataIsRejectedWithoutWriter() = runBlocking {
        val ticket = prepare(); val file = metadata(ticket.id)
        val row = AppApiJson.decodeFromString<DocumentSaveRecord>(file.readText())
        file.writeText(AppApiJson.encodeToString(row.copy(version = 2)))
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Writer reached") } }
        file.writeText("x".repeat(8193))
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().list("op", caller, true) }
    }
    @Test fun symlinkedMetadataIsRejectedAndTargetRetained() = runBlocking {
        val ticket = prepare(); val file = metadata(ticket.id); val target = File(root, "metadata-target")
        target.writeText(file.readText()); assertTrue(file.delete())
        Files.createSymbolicLink(file.toPath(), target.toPath())
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { error("Writer reached") } }
        assertTrue(target.exists()); Files.delete(file.toPath())
    }
    @Test fun receiptMismatchCannotBeRecordedAsSaved() = runBlocking {
        val ticket = prepare()
        expect(ApiErrorCode.REVISION_CONFLICT) { journal().copy("op", ticket.id, caller) { ticket.copy(sizeBytes = 0) } }
        assertEquals(DocumentSaveState.INTERRUPTED, journal().list("op", caller).single().state)
    }
    @Test fun maintenanceExpiresSelectorsWithoutCallerGrantOrPcAccess() = runBlocking {
        val ticket = prepare(); granted = false; now = 200
        val receipt = ResultMaintenanceCoordinator(outputs, cache, journal(), now = { now }).run { assertEquals(ticket.id, it.id) }
        assertEquals(1, receipt.recoveredSaves); assertEquals(1, receipt.removedDeliveries)
        assertFalse(receipt.needsRetry)
        granted = true
        val row = journal().list("op", caller).single()
        assertEquals(DocumentSaveState.INTERRUPTED, row.state); assertFalse(row.copyStarted)
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun maintenanceSkipsActiveCopyAndLeavesItsSharedBytes() = runBlocking {
        val ticket = prepare(); val started = CompletableDeferred<Unit>(); val finish = CompletableDeferred<Unit>()
        val writing = async(Dispatchers.IO) { journal().copy("op", ticket.id, caller) {
            cache.withSharedFile(ticket.id, caller) { _, _ -> started.complete(Unit); finish.await(); ticket }
        } }
        started.await(); now = 200
        val receipt = ResultMaintenanceCoordinator(outputs, cache, journal(), now = { now }).run { fail("Active grant revoked") }
        assertTrue(receipt.needsRetry); assertEquals(2, receipt.deferred)
        assertEquals(DocumentSaveState.COPYING, AppApiJson.decodeFromString<DocumentSaveRecord>(metadata(ticket.id).readText()).state)
        now = 10; finish.complete(Unit); writing.await()
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun maintenanceRecoversOrphanButRetainsRecentHistoryAndExternalBytes() = runBlocking {
        val ticket = prepare()
        val row = AppApiJson.decodeFromString<DocumentSaveRecord>(metadata(ticket.id).readText())
        metadata(ticket.id).writeText(AppApiJson.encodeToString(row.copy(state = DocumentSaveState.COPYING, copyStarted = true)))
        val external = File(root, "external").apply { writeBytes(bytes) }
        val receipt = journal().maintain(0)
        assertEquals(1, receipt.recovered); assertEquals(0, receipt.removed)
        assertTrue(journal().list("op", caller).single().copyStarted)
        assertArrayEquals(bytes, external.readBytes()); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun maintenancePrunesOnlyOldTerminalHistoryUnderLease() = runBlocking {
        val ticket = prepare(); journal().cancelSelection("op", ticket.id, caller)
        val lockFile = File(metadata(ticket.id).parentFile, "copy-${(ticket.id.hashCode() and Int.MAX_VALUE) % 128}.lock")
        java.nio.channels.FileChannel.open(lockFile.toPath(), java.nio.file.StandardOpenOption.WRITE).use { channel ->
            channel.lock().use {
                now += DOCUMENT_HISTORY_RETENTION_MS + 1
                assertEquals(0, journal().maintain(0).removed); assertTrue(metadata(ticket.id).exists())
            }
        }
        assertEquals(1, journal().maintain(0).removed); assertFalse(metadata(ticket.id).exists()); assertTrue(lockFile.exists())
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun maintenanceDeletesOnlyOldRegularTemporaryMetadata() = runBlocking {
        val ticket = prepare(); val directory = metadata(ticket.id).parentFile!!
        // API 26 truncates File.setLastModified to seconds; keep fixture ages distinct.
        val abandoned = File(directory, "${UUID.randomUUID()}.json.tmp").apply { writeText("partial"); assertTrue(setLastModified(1_000)) }
        val recent = File(directory, "${UUID.randomUUID()}.json.tmp").apply { writeText("recent"); assertTrue(setLastModified(100_000)) }
        val unknown = File(directory, "unrecognized.json.tmp").apply { writeText("keep"); assertTrue(setLastModified(1_000)) }
        val link = File(directory, "${UUID.randomUUID()}.json.tmp")
        Files.createSymbolicLink(link.toPath(), source().toPath())
        assertTrue(abandoned.lastModified() < 50_000)
        assertTrue(recent.lastModified() >= 50_000)
        assertEquals(1, journal().maintain(50_000).temporary)
        assertFalse(abandoned.exists()); assertTrue(recent.exists()); assertTrue(unknown.exists()); assertTrue(Files.isSymbolicLink(link.toPath()))
        assertTrue(metadata(ticket.id).exists()); assertArrayEquals(bytes, source().readBytes()); Files.delete(link.toPath())
    }
    @Test fun failedGrantRevocationKeepsTombstoneAndRetriesBeforeMetadataRemoval() = runBlocking {
        val ticket = prepare(); now = 200
        val delivery = File(context.noBackupFilesDir, "ragent-result-deliveries/${ticket.id}.json")
        try { cache.cleanupExpired({ throw java.io.IOException("revocation unavailable") }); fail("Expected revocation failure") }
        catch (_: java.io.IOException) { }
        assertEquals(ResultDeliveryState.REVOKED, AppApiJson.decodeFromString<ResultDeliveryTicket>(delivery.readText()).state)
        var revoked = false
        assertEquals(listOf(ticket), cache.cleanupExpired({ assertTrue(delivery.exists()); revoked = true }))
        assertTrue(revoked); assertFalse(delivery.exists()); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun corruptDocumentPhaseStillCleansExpiredSharesWithoutClaimingSuccess() = runBlocking {
        val ticket = prepare(); metadata(ticket.id).writeText("corrupt"); now = 200
        var revoked = false
        val receipt = ResultMaintenanceCoordinator(outputs, cache, journal(), now = { now }).run { revoked = true }
        assertTrue(revoked); assertEquals(1, receipt.removedDeliveries); assertTrue(receipt.needsRetry)
        assertEquals(listOf(ApiErrorCode.REVISION_CONFLICT), receipt.failures)
        assertEquals("corrupt", metadata(ticket.id).readText()); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun maintenanceCancellationNeverBecomesSuccessfulReceipt() = runBlocking {
        val ticket = prepare(); now = 200
        try { ResultMaintenanceCoordinator(outputs, cache, journal(), now = { now }).run { throw CancellationException("cancel") }
            fail("Cancellation swallowed") } catch (_: CancellationException) { }
        assertTrue(File(context.noBackupFilesDir, "ragent-result-deliveries/${ticket.id}.json").exists())
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun deliveryTemporaryCleanupKeepsPublishedAndActiveMetadata() = runBlocking {
        val ticket = prepare()
        val directory = File(context.noBackupFilesDir, "ragent-result-deliveries")
        val published = File(directory, "${ticket.id}.json.tmp").apply { writeText("keep"); setLastModified(1) }
        var id = UUID.randomUUID().toString()
        while ((id.hashCode() and Int.MAX_VALUE) % 256 == (ticket.id.hashCode() and Int.MAX_VALUE) % 256)
            id = UUID.randomUUID().toString()
        val unpublished = File(directory, "$id.part").apply { writeText("partial"); setLastModified(1) }
        val lockFile = File(directory, "ticket-${(id.hashCode() and Int.MAX_VALUE) % 256}.lock")
        var deferred = 0
        java.nio.channels.FileChannel.open(lockFile.toPath(), java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.WRITE).use { channel ->
            channel.lock().use { assertEquals(0, cache.cleanupUnpublished(50) { deferred++ }); assertTrue(unpublished.exists()) }
        }
        assertEquals(1, deferred)
        assertEquals(1, cache.cleanupUnpublished(50)); assertFalse(unpublished.exists()); assertTrue(published.exists()); assertTrue(lockFile.exists())
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun workerLeaseSurvivesLossOfParentLeaseAndDefersRecovery() = runBlocking {
        val ticket = prepare()
        val row = AppApiJson.decodeFromString<DocumentSaveRecord>(metadata(ticket.id).readText())
        metadata(ticket.id).writeText(AppApiJson.encodeToString(row.copy(state = DocumentSaveState.COPYING, copyStarted = true)))
        DocumentWorkerLease(context).withLease(ticket.id, { error("Unexpected worker contention") }) {
            assertEquals(DocumentSaveState.COPYING, journal().list("op", caller, true).single().state)
            val receipt = journal().maintain(0)
            assertEquals(0, receipt.recovered); assertEquals(1, receipt.deferred)
            journal().clearFinished("op", caller)
            assertTrue(metadata(ticket.id).exists())
        }
        assertEquals(DocumentSaveState.INTERRUPTED, journal().list("op", caller, true).single().state)
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun unconfirmedWorkerExitPreservesCopyingInsteadOfFalseInterrupted() = runBlocking {
        val ticket = prepare(); val held = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val acquired = CompletableDeferred<Unit>()
        val worker = launch(Dispatchers.IO) {
            held.await()
            DocumentWorkerLease(context).withLease(ticket.id, { error("Unexpected worker contention") }) {
                acquired.complete(Unit); release.await()
            }
        }
        try {
            journal().copy("op", ticket.id, caller) {
                held.complete(Unit); acquired.await()
                throw java.io.IOException("Callback ended while worker is still alive")
            }
            fail("Expected callback failure")
        } catch (failure: java.io.IOException) { assertTrue(failure.suppressed.any { it is AppApiException }) }
        assertEquals(DocumentSaveState.COPYING, journal().list("op", caller, true).single().state)
        release.complete(Unit); worker.join()
        val recovered = journal().list("op", caller, true).single()
        assertEquals(DocumentSaveState.INTERRUPTED, recovered.state); assertEquals(ApiErrorCode.RESULT_UNKNOWN, recovered.error)
    }
    @Test fun workerLeaseProtectsTerminalRetentionAndTemporaryMetadata() = runBlocking {
        val ticket = prepare(); journal().cancelSelection("op", ticket.id, caller)
        val temp = File(metadata(ticket.id).parentFile, "${ticket.id}.json.tmp").apply { writeText("partial"); setLastModified(1) }
        now += DOCUMENT_HISTORY_RETENTION_MS + 1
        DocumentWorkerLease(context).withLease(ticket.id, { error("Unexpected worker contention") }) {
            val receipt = journal().maintain(50)
            assertEquals(0, receipt.removed); assertEquals(0, receipt.temporary); assertEquals(2, receipt.deferred)
            expect(ApiErrorCode.REVISION_CONFLICT) { journal().clearFinished("op", caller) }
            assertTrue(metadata(ticket.id).exists()); assertTrue(temp.exists())
        }
        val receipt = journal().maintain(50)
        assertEquals(1, receipt.removed); assertEquals(1, receipt.temporary)
        val lockFile = File(metadata(ticket.id).parentFile, "worker-${(ticket.id.hashCode() and Int.MAX_VALUE) % 128}.lock")
        assertTrue(lockFile.exists()); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun workerLeaseRejectsSymlinkAndInvalidIdentity() = runBlocking {
        val ticket = prepare()
        expect(ApiErrorCode.INVALID_ARGUMENT) { DocumentWorkerLease(context).withLease("../other", { Unit }) { fail("Reached lease") } }
        val lockFile = File(metadata(ticket.id).parentFile, "worker-${(ticket.id.hashCode() and Int.MAX_VALUE) % 128}.lock")
        Files.deleteIfExists(lockFile.toPath()); Files.createSymbolicLink(lockFile.toPath(), source().toPath())
        expect(ApiErrorCode.REVISION_CONFLICT) { DocumentWorkerLease(context).withLease(ticket.id, { Unit }) { fail("Reached linked lease") } }
        assertArrayEquals(bytes, source().readBytes()); Files.delete(lockFile.toPath())
    }
    @Test fun coordinatorRemovesOnlyOldUnreferencedOutputWithoutPc() = runBlocking {
        val directory = source().parentFile!!
        val orphan = File(directory, "orphan.bin").apply { writeText("orphan"); setLastModified(1) }
        val unexpected = File(directory, "unknown.keep").apply { writeText("retain"); setLastModified(1) }
        source().setLastModified(1)
        now = 2L * 24 * 60 * 60 * 1000
        val receipt = ResultMaintenanceCoordinator(outputs, cache, journal(), now = { now }).run { fail("No ticket expected") }
        assertEquals(1, receipt.removedOrphans); assertFalse(receipt.needsRetry)
        assertFalse(orphan.exists()); assertTrue(unexpected.exists()); assertArrayEquals(bytes, source().readBytes())
    }
}
