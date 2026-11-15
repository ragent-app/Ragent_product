package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class TemporaryTextTaskCoordinatorTest {
    private val instanceId = "inst_${"a".repeat(32)}"
    private val grantId = "rtg_${"b".repeat(32)}"
    private val now = 1_800_000_000_000L
    private val revision = "12345678-1234-1234-1234-123456789abc"

    private class MemoryJournal : TemporaryTextOperationJournal {
        val records = mutableMapOf<String, TemporaryTextOperation>()
        override fun read(instanceId: String, grantId: String, operationId: String) = records[operationId]
        override fun list(instanceId: String, grantId: String) = records.values.toList()
        override fun write(operation: TemporaryTextOperation) { records[operation.operationId] = operation }
        override fun clear(instanceId: String, grantId: String, operationId: String) { records.remove(operationId) }
    }

    private inner class Server : TemporaryTextTaskApi, TemporaryAttachmentApi {
        var createCalls = 0
        var sessionsCreated = 0
        var prepareCalls = 0
        var preparationsCreated = 0
        var commitCalls = 0
        var runsCreated = 0
        var failCreateOnce = true
        var failPrepareOnce = true
        var failCommitOnce = true
        var assetCreateCalls = 0
        var assetUploadCalls = 0
        var assetFinalizeCalls = 0
        var loseAssetUploadResponseOnce = false
        var blockAssetUpload = false
        val assetUploadStarted = CompletableDeferred<Unit>()
        var messageAttachments: kotlinx.serialization.json.JsonArray? = null
        private var sessionKey: String? = null
        private var requestId: String? = null
        private var preparationId: String? = null
        private var asset: JsonObject? = null
        override suspend fun createSession(body: JsonObject): JsonObject {
            createCalls++
            val key = body.getValue("idempotencyKey").jsonPrimitive.content
            if (sessionKey == null) { sessionKey = key; sessionsCreated++ }
            assertEquals(sessionKey, key)
            if (failCreateOnce) { failCreateOnce = false; error("response lost after Session acceptance") }
            return JsonObject(mapOf("version" to JsonPrimitive(1), "startsRun" to JsonPrimitive(false),
                "session" to JsonObject(mapOf("sessionId" to JsonPrimitive("session-original"),
                    "scopeRevision" to JsonPrimitive(revision), "projectId" to kotlinx.serialization.json.JsonNull))))
        }
        override suspend fun preparation(scope: TemporarySessionScope, requestId: String): JsonObject {
            if (preparationId == null) throw ApiException(404, "RESOURCE_NOT_FOUND", "not prepared")
            return prepared()
        }
        override suspend fun prepareMessage(scope: TemporarySessionScope, body: JsonObject): JsonObject {
            prepareCalls++
            messageAttachments = body.getValue("attachments") as kotlinx.serialization.json.JsonArray
            val id = body.getValue("requestId").jsonPrimitive.content
            if (preparationId == null) { requestId = id; preparationId = "mprep_12345678-1234-1234-1234-123456789abc"; preparationsCreated++ }
            assertEquals(requestId, id)
            if (failPrepareOnce) { failPrepareOnce = false; error("response lost after preparation") }
            return prepared()
        }
        private fun prepared() = JsonObject(mapOf("sessionId" to JsonPrimitive("session-original"),
            "requestId" to JsonPrimitive(requestId!!), "state" to JsonPrimitive("prepared"),
            "preparationId" to JsonPrimitive(preparationId!!)))
        override suspend fun messageReceipt(scope: TemporarySessionScope, requestId: String): JsonObject {
            if (runsCreated == 0) return JsonObject(mapOf("sessionId" to JsonPrimitive("session-original"),
                "requestId" to JsonPrimitive(requestId), "accepted" to JsonPrimitive(false),
                "runId" to kotlinx.serialization.json.JsonNull))
            return receipt()
        }
        override suspend fun commitMessage(scope: TemporarySessionScope, requestId: String, body: JsonObject): JsonObject {
            commitCalls++
            assertEquals(this.requestId, requestId)
            assertEquals(preparationId, body.getValue("preparationId").jsonPrimitive.content)
            if (runsCreated == 0) runsCreated++
            if (failCommitOnce) { failCommitOnce = false; error("response lost after Run acceptance") }
            return receipt()
        }
        private fun receipt() = JsonObject(mapOf("sessionId" to JsonPrimitive("session-original"),
            "requestId" to JsonPrimitive(requestId!!), "accepted" to JsonPrimitive(true),
            "runId" to JsonPrimitive("run-original")))

        override suspend fun createAsset(scope: TemporarySessionScope, body: JsonObject): JsonObject {
            assetCreateCalls++
            asset = buildJsonObject {
                put("id", JsonPrimitive("fasset_0123456789abcdef01234567"))
                put("originalName", body.getValue("originalName")); put("mimeType", body.getValue("mimeType"))
                put("sizeBytes", body.getValue("sizeBytes")); put("sha256", body.getValue("sha256"))
                put("status", JsonPrimitive("pending_upload"))
            }
            return assetEnvelope()
        }

        override suspend fun assetReceipt(scope: TemporarySessionScope, requestId: String): JsonObject {
            if (asset == null) throw ApiException(404, "RESOURCE_NOT_FOUND", "asset receipt not found")
            return assetEnvelope()
        }

        override suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String, bytes: ByteArray): JsonObject {
            assetUploadCalls++
            assertEquals("fasset_0123456789abcdef01234567", assetId)
            if (blockAssetUpload) {
                assetUploadStarted.complete(Unit)
                awaitCancellation()
            }
            if (loseAssetUploadResponseOnce) {
                loseAssetUploadResponseOnce = false
                error("upload succeeded but response was lost")
            }
            return JsonObject(mapOf("uploadContractVersion" to JsonPrimitive(1),
                "assetId" to JsonPrimitive(assetId), "uploaded" to JsonPrimitive(true)))
        }

        override suspend fun finalizeAsset(scope: TemporarySessionScope, assetId: String, body: JsonObject): JsonObject {
            assetFinalizeCalls++
            val current = requireNotNull(asset)
            asset = JsonObject(current + ("status" to JsonPrimitive("ready")))
            return assetEnvelope()
        }

        private fun assetEnvelope() = JsonObject(mapOf("uploadContractVersion" to JsonPrimitive(1),
            "asset" to requireNotNull(asset)))
    }

    private class MemoryAttachmentBytes(private val content: ByteArray) : TemporaryAttachmentByteStore {
        val present = mutableSetOf("tast_0123456789abcdef0123456789abcdef")
        override fun stage(stageId: String, input: java.io.InputStream, maxBytes: Int): Pair<Long, String> = error("unused")
        override fun read(stageId: String, expectedSize: Long, expectedSha256: String): ByteArray {
            check(stageId in present && content.size.toLong() == expectedSize)
            return content.copyOf()
        }
        override fun delete(stageId: String) { present.remove(stageId) }
    }

    @Test fun `three lost responses recover one Session preparation and Run`() = runBlocking {
        val server = Server()
        val journal = MemoryJournal()
        val first = TemporaryTextTaskCoordinator(instanceId, grantId, now + 600_000, server, journal, { now })
        val operation = first.create("Text shared from Honor")
        assertFailsWith<IllegalStateException> { first.advance(operation.operationId) }
        assertEquals(TemporaryTextStage.PendingSession, journal.records[operation.operationId]?.stage)
        val afterRestart = TemporaryTextTaskCoordinator(instanceId, grantId, now + 600_000, server, journal, { now })
        assertFailsWith<IllegalStateException> { afterRestart.advance(operation.operationId) }
        assertEquals(TemporaryTextStage.Preparing, journal.records[operation.operationId]?.stage)
        assertFailsWith<IllegalStateException> { afterRestart.advance(operation.operationId) }
        assertEquals(TemporaryTextStage.Committing, journal.records[operation.operationId]?.stage)
        val accepted = afterRestart.advance(operation.operationId)
        assertEquals(TemporaryTextStage.Accepted, accepted.stage)
        assertEquals("run-original", accepted.runId)
        assertEquals(operation.messageRequestId, accepted.messageRequestId)
        assertEquals(1, server.sessionsCreated)
        assertEquals(1, server.preparationsCreated)
        assertEquals(1, server.runsCreated)
        assertEquals(1, server.prepareCalls)
        assertEquals(1, server.commitCalls)
        assertEquals(2, server.createCalls)
        assertEquals(accepted, afterRestart.advance(operation.operationId))
        assertEquals(1, server.runsCreated)
    }

    @Test fun `expired share cannot create new work`() = runBlocking {
        val server = Server()
        val journal = MemoryJournal()
        var clock = now
        val coordinator = TemporaryTextTaskCoordinator(instanceId, grantId, now + 600_000, server, journal, { clock })
        val operation = coordinator.create("A test message")
        clock = operation.expiresAt
        assertFailsWith<IllegalArgumentException> { coordinator.advance(operation.operationId) }
        assertEquals(0, server.createCalls)
        assertNotNull(journal.read(instanceId, grantId, operation.operationId))
        Unit
    }

    @Test fun `attachment upload resumes its receipt before the message is prepared`() = runBlocking {
        val bytes = "temporary attachment".toByteArray()
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        val source = StagedTemporaryAttachment("tast_0123456789abcdef0123456789abcdef", "phone-file-1",
            "report.txt", "text/plain", bytes.size.toLong(), hash)
        val server = Server().apply {
            failCreateOnce = false; loseAssetUploadResponseOnce = true
            failPrepareOnce = false; failCommitOnce = false
        }
        val journal = MemoryJournal()
        val staged = MemoryAttachmentBytes(bytes)
        val coordinator = TemporaryTextTaskCoordinator(instanceId, grantId, now + 600_000,
            server, journal, { now }, staged)
        val operation = coordinator.create("Inspect this attachment", attachments = listOf(source))

        assertFailsWith<IllegalStateException> { coordinator.advance(operation.operationId) }
        assertEquals(TemporaryTextStage.Preparing, journal.records[operation.operationId]?.stage)
        assertEquals(1, server.assetCreateCalls)
        assertEquals(1, server.assetUploadCalls)
        assertTrue(staged.present.contains(source.stageId), "staged bytes remain until a ready receipt is journaled")

        val accepted = coordinator.advance(operation.operationId)
        assertEquals(TemporaryTextStage.Accepted, accepted.stage)
        assertEquals(1, server.assetCreateCalls, "retry reuses the same private asset intent")
        assertEquals(2, server.assetUploadCalls)
        assertEquals(1, server.assetFinalizeCalls)
        assertTrue(staged.present.isEmpty(), "encrypted source is deleted after the ready receipt is durable")
        val attachment = server.messageAttachments!!.single() as JsonObject
        assertEquals("fasset_0123456789abcdef01234567", attachment.getValue("assetId").jsonPrimitive.content)
        assertEquals(hash, attachment.getValue("sha256").jsonPrimitive.content)
        assertEquals(bytes.size, attachment.getValue("sizeBytes").jsonPrimitive.content.toInt())
        assertTrue("originalName" !in attachment && "mimeType" !in attachment,
            "prepared attachment follows the strict assetId/hash/size contract")
    }

    @Test fun `cancelling an in-flight attachment upload preserves the operation for same-id retry`() = runBlocking {
        val bytes = "cancel and retry this attachment".toByteArray()
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
        val source = StagedTemporaryAttachment("tast_0123456789abcdef0123456789abcdef", "phone-file-2",
            "retry.txt", "text/plain", bytes.size.toLong(), hash)
        val server = Server().apply {
            failCreateOnce = false; failPrepareOnce = false; failCommitOnce = false; blockAssetUpload = true
        }
        val journal = MemoryJournal()
        val staged = MemoryAttachmentBytes(bytes)
        val coordinator = TemporaryTextTaskCoordinator(instanceId, grantId, now + 600_000,
            server, journal, { now }, staged)
        val operation = coordinator.create("Inspect this attachment", attachments = listOf(source))

        val upload = async { coordinator.advance(operation.operationId) }
        server.assetUploadStarted.await()
        upload.cancelAndJoin()
        assertEquals(TemporaryTextStage.Preparing, journal.records[operation.operationId]?.stage)
        assertEquals(1, server.assetCreateCalls)
        assertEquals(1, server.assetUploadCalls)
        assertTrue(staged.present.contains(source.stageId))

        server.blockAssetUpload = false
        val accepted = coordinator.advance(operation.operationId)
        assertEquals(TemporaryTextStage.Accepted, accepted.stage)
        assertEquals(1, server.assetCreateCalls, "retry retains the original asset request identity")
        assertEquals(2, server.assetUploadCalls)
        assertEquals(1, server.runsCreated)
        assertTrue(staged.present.isEmpty())
    }

    @Test fun `claim replacement can forget only accepted operations whose result was retrieved`() {
        val base = TemporaryTextOperation(operationId = "top_01234567-89ab-cdef-0123-456789abcdef",
            instanceId = instanceId, grantId = grantId, sessionKey = "session", messageRequestId = "message",
            tool = "codex", text = "A test message", createdAt = now, expiresAt = now + 60_000,
            stage = TemporaryTextStage.Accepted, sessionId = "session-id", scopeRevision = revision,
            preparationId = "mprep_01234567-89ab-cdef-0123-456789abcdef", runId = "run-id")

        assertTrue(!base.canBeForgottenAfterResultReview())
        assertTrue(!base.copy(stage = TemporaryTextStage.Committing, resultRetrievedAt = now)
            .canBeForgottenAfterResultReview())
        assertTrue(base.copy(resultRetrievedAt = now).canBeForgottenAfterResultReview())
    }
}
