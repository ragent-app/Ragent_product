package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.nio.file.Files
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TemporaryAttachmentUploadTest {
    private val scope = TemporarySessionScope("session_1", "12345678-1234-1234-1234-123456789abc", null)
    private val input = TemporaryAttachmentInput("phone-file-1", "hello.txt", "text/plain", "hello".toByteArray())

    private fun encryptedFiles(directory: java.io.File) = TemporaryAttachmentEncryptedFiles(directory) {
        SecretKeySpec(ByteArray(32) { (it + 1).toByte() }, "AES")
    }

    private class FakeApi : TemporaryAttachmentApi {
        var asset: JsonObject? = null
        var creates = 0
        var uploads = 0
        var finalizes = 0
        var failAfterUpload = false
        var supportsResumable = true
        var lastCreate: JsonObject? = null
        var uploaded = ByteArrayOutputStream()

        override suspend fun createAsset(scope: TemporarySessionScope, body: JsonObject): JsonObject {
            creates++
            lastCreate = body
            asset = asset ?: asset(body, "pending_upload")
            return envelope(asset!!, includeContract = supportsResumable)
        }

        override suspend fun assetReceipt(scope: TemporarySessionScope, requestId: String): JsonObject {
            assertEquals("phone-file-1", requestId)
            return asset?.let { envelope(it, includeContract = supportsResumable) } ?: throw ApiException(404, "not_found", "not found")
        }

        override suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String, bytes: ByteArray): JsonObject {
            uploads++
            assertEquals("fasset_0123456789abcdef01234567", assetId)
            assertEquals("hello", String(bytes))
            if (failAfterUpload) throw ApiException(0, "lost", "response lost", retryable = true)
            return buildJsonObject {
                put("uploadContractVersion", JsonPrimitive(1)); put("uploaded", JsonPrimitive(true))
            }
        }

        override suspend fun uploadCheckpoint(scope: TemporarySessionScope, assetId: String): JsonObject = checkpoint(assetId)

        override suspend fun uploadChunk(scope: TemporarySessionScope, assetId: String, offset: Long,
            source: TemporaryAttachmentBodySource): JsonObject {
            uploads++
            val bytes = source.openStream().use { it.readBytes() }
            assertEquals(source.sizeBytes.toInt(), bytes.size)
            assertEquals(sha256(bytes), source.sha256)
            if (offset < uploaded.size()) assertContentEquals(uploaded.toByteArray().copyOfRange(offset.toInt(),
                offset.toInt() + bytes.size), bytes)
            else {
                assertEquals(uploaded.size().toLong(), offset)
                uploaded.write(bytes)
            }
            if (failAfterUpload) { failAfterUpload = false; throw ApiException(0, "lost", "response lost", retryable = true) }
            return checkpoint(assetId)
        }

        private fun checkpoint(assetId: String) = buildJsonObject {
            put("uploadCheckpointVersion", JsonPrimitive(1)); put("assetId", JsonPrimitive(assetId))
            put("offset", JsonPrimitive(uploaded.size())); put("totalBytes", JsonPrimitive(5))
            put("sha256", JsonPrimitive(sha256(uploadedContractBytes)))
            put("status", JsonPrimitive(if (uploaded.size() == 5) "uploaded" else "uploading"))
        }

        override suspend fun finalizeAsset(scope: TemporarySessionScope, assetId: String, body: JsonObject): JsonObject {
            finalizes++
            assertEquals(5, body.getValue("sizeBytes").jsonPrimitive.content.toInt())
            val pending = requireNotNull(asset)
            asset = JsonObject(pending + mapOf("status" to JsonPrimitive("ready")))
            return envelope(asset!!)
        }

        private fun asset(body: JsonObject, status: String) = buildJsonObject {
            put("id", JsonPrimitive("fasset_0123456789abcdef01234567"))
            put("originalName", body.getValue("originalName")); put("mimeType", body.getValue("mimeType"))
            put("sizeBytes", body.getValue("sizeBytes")); put("sha256", body.getValue("sha256"))
            put("status", JsonPrimitive(status))
        }

        private fun envelope(asset: JsonObject, includeContract: Boolean = supportsResumable) = buildJsonObject {
            put("uploadContractVersion", JsonPrimitive(1)); put("asset", asset)
            if (includeContract) put("resumableUpload", buildJsonObject {
                put("version", JsonPrimitive(1)); put("chunkBytes", JsonPrimitive(2)); put("checkpointTtlMs", JsonPrimitive(86_400_000))
                put("checksum", JsonPrimitive("sha256")); put("fixedChunks", JsonPrimitive(true))
            })
        }

        private val uploadedContractBytes get() = uploaded.takeIf { it.size() == 5 }?.toByteArray() ?: "hello".toByteArray()
        private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }

    @Test fun `uploads a scoped attachment and verifies the finalized digest receipt`() = runBlocking {
        val api = FakeApi()
        val receipt = TemporaryAttachmentUploader(api).upload(scope, input)
        assertEquals("ready", receipt.status)
        assertEquals(64, receipt.sha256.length)
        assertEquals("fasset_0123456789abcdef01234567", receipt.messageAttachment().getValue("assetId").jsonPrimitive.content)
        assertEquals(1, api.creates); assertEquals(3, api.uploads); assertEquals(1, api.finalizes)
        assertEquals(receipt.sha256, api.lastCreate!!.getValue("sha256").jsonPrimitive.content)
    }

    @Test fun `retry resumes the original receipt after an upload response is lost`() = runBlocking {
        val api = FakeApi().apply { failAfterUpload = true }
        val uploader = TemporaryAttachmentUploader(api)
        assertFailsWith<ApiException> { uploader.upload(scope, input) }
        api.failAfterUpload = false
        val receipt = uploader.upload(scope, input)
        assertEquals("ready", receipt.status)
        assertEquals(1, api.creates, "retry must resolve the original intent instead of creating another")
        assertEquals(3, api.uploads)
        assertContentEquals("hello".toByteArray(), api.uploaded.toByteArray())
        assertEquals(1, api.finalizes)
    }

    @Test fun `repeatable body source reopens the same authenticated content for retry`() = runBlocking {
        val api = FakeApi().apply { failAfterUpload = true }
        var opens = 0
        val source = TemporaryAttachmentBodySource(
            requestId = input.requestId,
            originalName = input.originalName,
            mimeType = input.mimeType,
            sizeBytes = 5,
            sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            openStream = { opens++; ByteArrayInputStream("hello".toByteArray()) },
        )
        val uploader = TemporaryAttachmentUploader(api)
        assertFailsWith<ApiException> { uploader.upload(scope, source) }
        api.failAfterUpload = false
        assertEquals("ready", uploader.upload(scope, source).status)
        assertEquals(5, opens)
        assertEquals(1, api.creates)
        assertEquals(3, api.uploads)
        assertContentEquals("hello".toByteArray(), api.uploaded.toByteArray())
    }

    @Test fun `attachment uploader forwards bounded source progress`() = runBlocking {
        val api = FakeApi()
        val progress = mutableListOf<Pair<Long, Long>>()
        val source = TemporaryAttachmentBodySource(input.requestId, input.originalName, input.mimeType,
            input.bytes.size.toLong(), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            { ByteArrayInputStream(input.bytes) })

        val receipt = TemporaryAttachmentUploader(api).upload(scope, source) { sent, total -> progress += sent to total }

        assertEquals("ready", receipt.status)
        assertEquals(listOf(2L to 5L, 4L to 5L, 5L to 5L), progress)
    }

    @Test fun `ready duplicate receipt does not upload bytes again`() = runBlocking {
        val api = FakeApi()
        TemporaryAttachmentUploader(api).upload(scope, input)
        api.asset = JsonObject(api.asset!! + mapOf("status" to JsonPrimitive("ready")))
        val receipt = TemporaryAttachmentUploader(api).upload(scope, input)
        assertTrue(receipt.status == "ready")
        assertEquals(3, api.uploads); assertEquals(1, api.finalizes)
    }

    @Test fun `older computers without checkpoint advertisement keep the legacy upload path`() = runBlocking {
        val api = FakeApi().apply { supportsResumable = false }
        val receipt = TemporaryAttachmentUploader(api).upload(scope, input)
        assertEquals("ready", receipt.status)
        assertEquals(1, api.uploads)
        assertEquals(1, api.finalizes)
    }

    @Test fun `rejects a receipt for different staged bytes`() = runBlocking {
        val api = FakeApi()
        TemporaryAttachmentUploader(api).upload(scope, input)
        val other = input.copy(bytes = "other".toByteArray())
        assertFailsWith<IllegalArgumentException> { TemporaryAttachmentUploader(api).upload(scope, other) }
        assertEquals(3, api.uploads)
    }

    @Test fun `staged file is encrypted and authenticates bytes and metadata`() {
        val directory = Files.createTempDirectory("ragent-temp-attachment").toFile()
        val stagedId = "tast_0123456789abcdef0123456789abcdef"
        try {
            val bytes = ByteArray(8_192) { (it % 239).toByte() }
            val store = encryptedFiles(directory)
            val (size, digest) = store.stage(stagedId, ByteArrayInputStream(bytes))
            assertEquals(bytes.size.toLong(), size)
            assertEquals(bytes.size, directory.resolve("$stagedId.enc").length().toInt() - 28,
                "GCM ciphertext adds the 12-byte IV and 16-byte tag")
            assertTrue(!directory.resolve("$stagedId.enc").readBytes().toString(Charsets.ISO_8859_1)
                .contains(bytes.toString(Charsets.ISO_8859_1)))
            assertContentEquals(bytes, store.read(stagedId, size, digest))
            assertFailsWith<IllegalArgumentException> { store.read(stagedId, size, "0".repeat(64)) }
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test fun `verified staged stream is repeatable and checks integrity at end of stream`() {
        val directory = Files.createTempDirectory("ragent-temp-attachment-stream").toFile()
        val stageId = "tast_${"d".repeat(32)}"
        try {
            val bytes = ByteArray(512 * 1024) { (it % 251).toByte() }
            val store = encryptedFiles(directory)
            val (size, sha256) = store.stage(stageId, ByteArrayInputStream(bytes))
            repeat(2) {
                val output = ByteArrayOutputStream()
                store.openVerifiedStream(stageId, size, sha256).use { input ->
                    val buffer = ByteArray(7_111)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                    }
                }
                assertContentEquals(bytes, output.toByteArray())
            }
            assertFailsWith<IllegalArgumentException> {
                store.openVerifiedStream(stageId, size, "0".repeat(64)).use { it.copyTo(ByteArrayOutputStream()) }
            }
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test fun `failed oversized staging leaves no committed file`() {
        val directory = Files.createTempDirectory("ragent-temp-attachment-limit").toFile()
        val stagedId = "tast_fedcba9876543210fedcba9876543210"
        try {
            assertFailsWith<IllegalArgumentException> {
                encryptedFiles(directory).stage(stagedId, ByteArrayInputStream(ByteArray(9)), maxBytes = 8)
            }
            assertTrue(directory.listFiles().orEmpty().isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test fun `maintenance prunes only old managed staging artifacts`() {
        val directory = Files.createTempDirectory("ragent-temp-attachment-maintenance").toFile()
        try {
            val oldCommitted = directory.resolve("tast_${"a".repeat(32)}.enc").apply {
                writeBytes(byteArrayOf(1)); setLastModified(1_000)
            }
            val oldPartial = directory.resolve("tast_${"b".repeat(32)}.partial").apply {
                writeBytes(byteArrayOf(2)); setLastModified(1_000)
            }
            val recent = directory.resolve("tast_${"c".repeat(32)}.enc").apply {
                writeBytes(byteArrayOf(3)); setLastModified(9_000)
            }
            val unrelated = directory.resolve("keep.tmp").apply { writeBytes(byteArrayOf(4)); setLastModified(1_000) }

            assertEquals(2, encryptedFiles(directory).pruneExpiredBefore(5_000))
            assertTrue(!oldCommitted.exists() && !oldPartial.exists())
            assertTrue(recent.exists() && unrelated.exists())
        } finally {
            directory.deleteRecursively()
        }
    }
}
