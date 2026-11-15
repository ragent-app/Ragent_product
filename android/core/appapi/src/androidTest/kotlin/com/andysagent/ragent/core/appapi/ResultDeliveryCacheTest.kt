package com.andysagent.ragent.core.appapi

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.*
import kotlinx.serialization.encodeToString
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Actual Room, files and OS locks; synthetic verified source, no remote execution claim. */
@RunWith(AndroidJUnit4::class)
class ResultDeliveryCacheTest {
    private lateinit var root: File
    private lateinit var context: Context
    private lateinit var db: AppApiDatabase
    private lateinit var outputs: PersistentResultOutputs
    private val caller = VerifiedCaller("external")
    private var granted = true
    private var now = 10L
    private val bytes = "测试结果🙂 abc\n".repeat(10_000).toByteArray()
    private fun sha(data: ByteArray) = MessageDigest.getInstance("SHA-256").digest(data).hex()
    private fun manifest() = ResultExportManifest(1, "pc", "session", "request", "run", "final",
        listOf(ResultExportResource("text", "手机报告.txt", "text/plain", true, bytes.size.toLong(), sha(bytes))),
        bytes.size.toLong(), 65_536, "2099-01-01T00:00:00Z", "b".repeat(64))
    private fun cache(maximumBytes: Long = 256L * 1024 * 1024, maximumFiles: Int = 64) =
        ResultDeliveryCache(context, outputs, now = { now }, maximumBytes = maximumBytes, maximumFiles = maximumFiles, lifetimeMillis = 100)
    private fun metadata(id: String, suffix: String = "json") = File(context.noBackupFilesDir, "ragent-result-deliveries/$id.$suffix")
    private fun shared(reference: ResultDeliveryRef) = File(context.cacheDir, "result-shares/${reference.id}/${reference.name}")
    private fun source() = File(context.noBackupFilesDir, "ragent-result-outputs/download.bin")
    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        root = File(app.cacheDir, "result-delivery-test-${UUID.randomUUID()}").apply { mkdirs() }
        context = object : ContextWrapper(app) {
            override fun getApplicationContext() = this
            override fun getNoBackupFilesDir() = File(root, "private").apply { mkdirs() }
            override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
        }
        db = Room.databaseBuilder(context, AppApiDatabase::class.java, File(root, "journal.db").absolutePath).build()
        val coordinator = TaskCoordinator(RoomOperationStore(db), { TargetDirectorySnapshot(emptyList(), null) },
            GrantAuthorizer("owner", { if (granted) listOf(CallerGrant(caller.binding, setOf(CapabilityRegistry.TASKS_RESULT_EXPORT),
                setOf("pc"), Long.MAX_VALUE, sessionIds = setOf("session"))) else emptyList() }, now = { now }),
            object : TargetTaskAccess {
                override suspend fun <T> withTarget(instanceId: String, block: suspend (TaskTarget) -> T): T = error("Delivery must not contact PC")
            }, now = { now })
        outputs = PersistentResultOutputs(context, db, coordinator, now = { now })
    }
    @After fun teardown() {
        db.close()
        val app = ApplicationProvider.getApplicationContext<Context>()
        assertTrue(root.name.startsWith("result-delivery-test-"))
        assertEquals(app.cacheDir.canonicalFile, root.canonicalFile.parentFile)
        root.deleteRecursively()
    }
    private suspend fun seed(): ResultOutput {
        val operation = TaskOperation("op", caller.binding, "hash", "prep", "pc",
            TaskRequest("op", "Synthetic task", TaskRuntime("tool")), "create", "request", 0, 10,
            stage = OperationStage.ACCEPTED, sessionId = "session", runId = "run", resultExport = manifest())
        assertTrue(RoomOperationStore(db).insert(operation))
        val output = ResultOutput("download", "op", caller.binding, manifest(), "text", now, now,
            state = ResultOutputState.READY, receivedBytes = bytes.size.toLong(), prefixSha256 = sha(bytes), verifiedAt = now)
        assertTrue(db.outputs().insert(output.entity()) != -1L)
        source().parentFile!!.mkdirs(); source().writeBytes(bytes)
        return output
    }
    private suspend fun expect(code: ApiErrorCode, block: suspend () -> Unit) {
        try { block(); fail("Expected $code") } catch (failure: AppApiException) { assertEquals(code, failure.error.code) }
    }
    @Test fun verifiedShareIsIndependentAndColdReopenStreamsExactBytes() = runBlocking {
        seed(); val first = cache(); val reference = first.stage("download", caller)
        assertArrayEquals(bytes, shared(reference).readBytes()); assertArrayEquals(bytes, source().readBytes())
        assertEquals("text/plain", reference.mimeType); assertEquals(bytes.size.toLong(), reference.sizeBytes)
        assertFalse(shared(reference).canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath))
        val reopened = cache(); assertEquals(listOf(reference), reopened.list("op", caller))
        val destination = ByteArrayOutputStream(); assertEquals(reference, reopened.copy(reference.id, caller) { destination.write(it) })
        assertArrayEquals(bytes, destination.toByteArray())
        assertTrue(metadata(reference.id).exists())
    }
    @Test fun revokedGrantAndDeletedSourcePreventNewReadsButOwnerCanRevoke() = runBlocking {
        val output = seed(); val reference = cache().stage("download", caller)
        granted = false
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().withSharedFile(reference.id) { _, _ -> fail("Revoked bytes") } }
        granted = true; assertTrue(outputs.delete("download", caller, output.revision))
        expect(ApiErrorCode.REVISION_CONFLICT) { cache().copy(reference.id, caller) { fail("Deleted bytes") } }
        granted = false; assertEquals(reference, cache().revoke(reference.id, caller))
        assertFalse(shared(reference).exists())
        expect(ApiErrorCode.RESOURCE_NOT_FOUND) { cache().withSharedFile(reference.id) { _, _ -> fail("Revoked ticket") } }
    }
    @Test fun foreignCallerCannotStageReadListOrRevokeOriginalTicket() = runBlocking {
        seed(); val reference = cache().stage("download", caller); val other = VerifiedCaller("other")
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().stage("download", other) }
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().copy(reference.id, other) { fail("Foreign bytes") } }
        assertTrue(cache().list("op", other).isEmpty())
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().revoke(reference.id, other) }
        assertArrayEquals(bytes, shared(reference).readBytes())
    }
    @Test fun expiredTicketsDenyBeforeConsumerAndMaintenanceRetainsOriginalAndLocks() = runBlocking {
        seed(); val reference = cache().stage("download", caller); now = reference.expiresAt
        expect(ApiErrorCode.REQUEST_EXPIRED) { cache().withSharedFile(reference.id) { _, _ -> fail("Expired bytes") } }
        assertTrue(cache().list("op", caller).isEmpty()); assertEquals(listOf(reference), cache().cleanupExpired())
        assertFalse(metadata(reference.id).exists()); assertFalse(shared(reference).exists()); assertArrayEquals(bytes, source().readBytes())
        assertTrue(metadata(reference.id).parentFile!!.listFiles()!!.filter { it.name.endsWith(".lock") }.isNotEmpty())
        assertTrue(cache().cleanupExpired().isEmpty())
    }
    @Test fun corruptionAndEvictedCopyAreNotPublishedOrRegenerated() = runBlocking {
        seed(); val reference = cache().stage("download", caller)
        shared(reference).writeBytes(ByteArray(bytes.size))
        expect(ApiErrorCode.REVISION_CONFLICT) { cache().copy(reference.id, caller) { fail("Corrupt bytes") } }
        assertTrue(shared(reference).delete())
        expect(ApiErrorCode.REVISION_CONFLICT) { cache().withSharedFile(reference.id) { _, _ -> fail("Evicted bytes") } }
        assertFalse(shared(reference).exists()); assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun corruptSourceFailsStagingAndDoesNotConsumeQuotaOrLeakPartial() = runBlocking {
        seed(); source().writeBytes(ByteArray(bytes.size))
        expect(ApiErrorCode.REVISION_CONFLICT) { cache(maximumFiles = 1).stage("download", caller) }
        assertTrue(cache().list("op", caller).isEmpty())
        assertTrue(File(context.cacheDir, "result-shares").listFiles().orEmpty().isEmpty())
        source().writeBytes(bytes); assertEquals(bytes.size.toLong(), cache(maximumFiles = 1).stage("download", caller).sizeBytes)
    }
    @Test fun quotaDoesNotEvictAndRevokeReleasesReservation() = runBlocking {
        seed(); expect(ApiErrorCode.RESOURCE_LIMIT) { cache(maximumBytes = bytes.size - 1L).stage("download", caller) }
        val reference = cache(maximumFiles = 1).stage("download", caller)
        expect(ApiErrorCode.RESOURCE_LIMIT) { cache(maximumFiles = 1).stage("download", caller) }
        assertTrue(shared(reference).exists()); cache().revoke(reference.id, caller)
        assertEquals(bytes.size.toLong(), cache(maximumFiles = 1).stage("download", caller).sizeBytes)
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun revocationDuringStreamingStopsAfterFirstBlockAndLeavesSourceReady() = runBlocking {
        seed(); val reference = cache().stage("download", caller); var delivered = 0
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().copy(reference.id, caller) { delivered++; granted = false } }
        assertEquals(1, delivered); granted = true
        assertEquals(ResultOutputState.READY, outputs.get("download", caller)!!.state)
    }
    @Test fun failedCleanupKeepsTombstoneAndQuotaUntilExactDirectoryIsClean() = runBlocking {
        seed(); val reference = cache(maximumFiles = 1).stage("download", caller)
        val unexpected = File(shared(reference).parentFile, "unexpected").apply { writeBytes(byteArrayOf(1)) }
        expect(ApiErrorCode.REVISION_CONFLICT) { cache().revoke(reference.id, caller) }
        expect(ApiErrorCode.RESOURCE_NOT_FOUND) { cache().withSharedFile(reference.id) { _, _ -> fail("Tombstoned bytes") } }
        expect(ApiErrorCode.RESOURCE_LIMIT) { cache(maximumFiles = 1).stage("download", caller) }
        assertTrue(unexpected.exists()); assertTrue(metadata(reference.id).exists())
        assertTrue(unexpected.delete()); assertEquals(listOf(reference), cache().cleanupExpired())
        assertEquals(bytes.size.toLong(), cache(maximumFiles = 1).stage("download", caller).sizeBytes)
        assertArrayEquals(bytes, source().readBytes())
    }
    @Test fun pendingCrashRecordNeverBecomesReadableAndExpiresSafely() = runBlocking {
        val source = seed(); val id = UUID.randomUUID().toString()
        val reference = ResultDeliveryTicket(id, source, now, now + 100).reference()
        metadata(id).parentFile!!.mkdirs(); metadata(id).writeText(AppApiJson.encodeToString(ResultDeliveryTicket(id, source, now, now + 100)))
        shared(reference).parentFile!!.mkdirs(); shared(reference).writeBytes(bytes)
        metadata(id, "part").writeBytes(byteArrayOf(1))
        expect(ApiErrorCode.RESOURCE_NOT_FOUND) { cache().withSharedFile(id) { _, _ -> fail("Pending bytes") } }
        now += 100; assertEquals(listOf(reference), cache().cleanupExpired()); assertFalse(metadata(id, "part").exists())
        assertArrayEquals(bytes, this@ResultDeliveryCacheTest.source().readBytes())
    }
    @Test fun heldDescriptorLockPreventsConcurrentRevocationAndExpiryCleanup() = runBlocking {
        seed(); val reference = cache().stage("download", caller)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        val reader = async(Dispatchers.IO) { cache().withSharedFile(reference.id, caller) { _, _ -> entered.complete(Unit); release.await() } }
        try {
            withTimeout(15_000) { entered.await() }
            expect(ApiErrorCode.REVISION_CONFLICT) { cache().revoke(reference.id, caller) }
            now = reference.expiresAt; assertTrue(cache().cleanupExpired().isEmpty()); assertTrue(shared(reference).exists())
        } finally { now = 10; release.complete(Unit) }
        withTimeout(15_000) { reader.await() }; cache().revoke(reference.id, caller); assertFalse(shared(reference).exists())
    }
    @Test fun symlinkAndChosenPathCannotExposeUnrelatedFile() = runBlocking {
        seed(); val reference = cache().stage("download", caller)
        val unrelated = File(root, "unrelated").apply { writeBytes(bytes) }
        assertTrue(shared(reference).delete()); Files.createSymbolicLink(shared(reference).toPath(), unrelated.toPath())
        expect(ApiErrorCode.REVISION_CONFLICT) { cache().withSharedFile(reference.id) { _, _ -> fail("Linked file") } }
        expect(ApiErrorCode.INVALID_ARGUMENT) { cache().withSharedFile("../unrelated") { _, _ -> fail("Chosen path") } }
        assertArrayEquals(bytes, unrelated.readBytes())
    }
    @Test fun cancellingConsumerPreservesPrivateResultAndTicket() = runBlocking {
        seed(); val reference = cache().stage("download", caller); var delivered = 0
        try { cache().copy(reference.id, caller) { delivered++; throw CancellationException("Cancel save") }; fail("Expected cancel") }
        catch (_: CancellationException) { }
        assertEquals(1, delivered); assertArrayEquals(bytes, source().readBytes())
        assertEquals(listOf(reference), cache().list("op", caller))
    }
    @Test fun explicitOutputRevocationUsesExactSourceAndCallerAndKeepsPrivateFile() = runBlocking {
        seed(); val one = cache().stage("download", caller); val two = cache().stage("download", caller)
        assertTrue(cache().revokeForOutput("another-download", caller).isEmpty())
        assertTrue(cache().revokeForOutput("download", VerifiedCaller("another-caller")).isEmpty())
        assertEquals(setOf(one, two), cache().revokeForOutput("download", caller).toSet())
        assertTrue(cache().list("op", caller).isEmpty())
        assertArrayEquals(bytes, source().readBytes())
        expect(ApiErrorCode.RESOURCE_NOT_FOUND) { cache().withSharedFile(one.id) { _, _ -> fail("Revoked") } }
    }
    @Test fun deletedSourceDoesNotPoisonOtherLocalRecordsButRevokedAuthorizationStillFails() = runBlocking {
        seed(); cache().stage("download", caller)
        assertTrue(outputs.delete("download", caller, 0))
        assertTrue(cache().list("op", caller).isEmpty())
        granted = false
        expect(ApiErrorCode.PERMISSION_DENIED) { cache().list("op", caller) }
    }
}
