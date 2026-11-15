package com.andysagent.ragent.core.auth

import com.andysagent.ragent.core.network.ApiException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.Serializable
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.CipherOutputStream
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

data class TemporaryAttachmentInput(
    val requestId: String,
    val originalName: String,
    val mimeType: String,
    val bytes: ByteArray,
)

/** Repeatable, bounded source; persistent operations store the identity, never this callback. */
data class TemporaryAttachmentBodySource(
    val requestId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val openStream: () -> InputStream,
)

private fun temporaryAttachmentSha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it) }

@Serializable
data class StagedTemporaryAttachment(
    val stageId: String,
    val requestId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val assetId: String? = null,
    val ready: Boolean = false,
)

data class TemporaryAttachmentReceipt(
    val assetId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long,
    val sha256: String,
    val status: String,
) {
    fun messageAttachment(): JsonObject = buildJsonObject {
        put("assetId", JsonPrimitive(assetId))
        put("originalName", JsonPrimitive(originalName))
        put("mimeType", JsonPrimitive(mimeType))
        put("sizeBytes", JsonPrimitive(sizeBytes))
    }
}

/** Narrow interface makes the retry protocol testable without weakening the carrier boundary. */
interface TemporaryAttachmentApi {
    suspend fun createAsset(scope: TemporarySessionScope, body: JsonObject): JsonObject
    suspend fun assetReceipt(scope: TemporarySessionScope, requestId: String): JsonObject
    suspend fun uploadCheckpoint(scope: TemporarySessionScope, assetId: String): JsonObject =
        throw UnsupportedOperationException("Resumable attachment upload is unsupported")
    suspend fun uploadChunk(scope: TemporarySessionScope, assetId: String, offset: Long,
        source: TemporaryAttachmentBodySource): JsonObject = uploadAsset(scope, assetId, source)
    suspend fun cancelUpload(scope: TemporarySessionScope, assetId: String): JsonObject =
        throw UnsupportedOperationException("Upload cancellation is unsupported")
    suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String, bytes: ByteArray): JsonObject
    /** Legacy carriers may materialize a bounded body; streaming carriers override this method. */
    suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String,
        source: TemporaryAttachmentBodySource): JsonObject {
        require(source.sizeBytes in 1..TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES.toLong())
        val output = ByteArrayOutputStream(source.sizeBytes.toInt())
        source.openStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                require(output.size().toLong() + count <= source.sizeBytes) { "Attachment source exceeded its declared size" }
                output.write(buffer, 0, count)
            }
        }
        val bytes = output.toByteArray()
        require(bytes.size.toLong() == source.sizeBytes && temporaryAttachmentSha256(bytes) == source.sha256) {
            "Attachment source does not match its declared digest"
        }
        return uploadAsset(scope, assetId, bytes)
    }
    /** Optional progress is the number of source bytes handed to the carrier, not a PC receipt. */
    suspend fun uploadAsset(scope: TemporarySessionScope, assetId: String,
        source: TemporaryAttachmentBodySource,
        onProgress: (sentBytes: Long, totalBytes: Long) -> Unit): JsonObject {
        val result = uploadAsset(scope, assetId, source)
        onProgress(source.sizeBytes, source.sizeBytes)
        return result
    }
    suspend fun finalizeAsset(scope: TemporarySessionScope, assetId: String, body: JsonObject): JsonObject
}

/**
 * Resumes a temporary attachment by its stable request ID. Every retry first reads the private
 * receipt; an unknown create/upload/finalize response therefore cannot mint a second asset.
 * The caller owns durable staging of the source bytes and request ID until this returns ready.
 */
class TemporaryAttachmentUploader(private val api: TemporaryAttachmentApi) {
    suspend fun upload(scope: TemporarySessionScope, input: TemporaryAttachmentInput): TemporaryAttachmentReceipt {
        validate(input)
        return upload(scope, TemporaryAttachmentBodySource(input.requestId, input.originalName,
            input.mimeType, input.bytes.size.toLong(), sha256(input.bytes), { ByteArrayInputStream(input.bytes) }))
    }

    suspend fun upload(scope: TemporarySessionScope, source: TemporaryAttachmentBodySource,
        onProgress: (sentBytes: Long, totalBytes: Long) -> Unit = { _, _ -> }): TemporaryAttachmentReceipt {
        validate(source)
        val priorEnvelope = readReceipt(scope, source.requestId)
        val prior = priorEnvelope?.getValue("asset")?.jsonObject
        val intent = if (priorEnvelope == null) api.createAsset(scope, buildJsonObject {
            put("requestId", JsonPrimitive(source.requestId))
            put("originalName", JsonPrimitive(source.originalName))
            put("mimeType", JsonPrimitive(source.mimeType))
            put("sizeBytes", JsonPrimitive(source.sizeBytes))
            put("sha256", JsonPrimitive(source.sha256))
        }).also(::requireVersion) else null
        var asset = prior ?: requireNotNull(intent).getValue("asset").jsonObject

        validateAsset(asset, source)
        when (asset.getValue("status").jsonPrimitive.content) {
            "ready" -> return receipt(asset)
            "pending_upload" -> Unit
            else -> error("Temporary attachment has an unsupported state")
        }

        val assetId = asset.getValue("id").jsonPrimitive.content
        val resumable = (intent ?: priorEnvelope)?.get("resumableUpload")?.jsonObject
        if (resumable != null) {
            uploadResumable(scope, assetId, source, resumable, onProgress)
        } else api.uploadAsset(scope, assetId, source, onProgress).also {
            requireVersion(it)
            require(it.getValue("uploaded").jsonPrimitive.content == "true")
        }
        val finalized = api.finalizeAsset(scope, assetId,
            buildJsonObject { put("sizeBytes", JsonPrimitive(source.sizeBytes)) })
        requireVersion(finalized)
        asset = finalized.getValue("asset").jsonObject
        validateAsset(asset, source)
        require(asset.getValue("status").jsonPrimitive.content == "ready") {
            "Temporary computer did not verify the uploaded attachment"
        }
        return receipt(asset)
    }

    private suspend fun uploadResumable(scope: TemporarySessionScope, assetId: String,
        source: TemporaryAttachmentBodySource, contract: JsonObject,
        onProgress: (sentBytes: Long, totalBytes: Long) -> Unit) {
        require(contract.getValue("version").jsonPrimitive.content.toInt() == 1)
        val chunkBytes = contract.getValue("chunkBytes").jsonPrimitive.content.toInt()
        require(chunkBytes in 1..MAX_CHUNK_BYTES) { "Temporary computer returned an unsupported chunk size" }
        require(contract.getValue("checksum").jsonPrimitive.content == "sha256" &&
            contract.getValue("fixedChunks").jsonPrimitive.content == "true") {
            "Temporary computer returned an unsupported upload contract"
        }
        // Verify the complete encrypted source before sending any range. Each range below is
        // separately hashed, while the PC still checks the full original digest at finalize.
        source.openStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                total += count
                require(total <= source.sizeBytes) { "Attachment source exceeded its declared size" }
                digest.update(buffer, 0, count)
            }
            val actualSha256 = digest.digest().joinToString("") { "%02x".format(it) }
            require(total == source.sizeBytes && actualSha256 == source.sha256) {
                "Attachment source does not match its declared size and digest"
            }
        }

        val checkpoint = api.uploadCheckpoint(scope, assetId)
        require(checkpoint.getValue("uploadCheckpointVersion").jsonPrimitive.content == "1")
        require(checkpoint.getValue("assetId").jsonPrimitive.content == assetId)
        require(checkpoint.getValue("totalBytes").jsonPrimitive.content.toLong() == source.sizeBytes)
        require(checkpoint.getValue("sha256").jsonPrimitive.content == source.sha256)
        var offset = checkpoint.getValue("offset").jsonPrimitive.content.toLong()
        validateOffset(offset, source.sizeBytes, chunkBytes)
        when (checkpoint.getValue("status").jsonPrimitive.content) {
            "ready" -> return
            "uploading", "uploaded" -> Unit
            else -> error("Temporary computer cannot resume this attachment upload")
        }
        if (offset > 0) onProgress(offset, source.sizeBytes)
        while (offset < source.sizeBytes) {
            val length = minOf(chunkBytes.toLong(), source.sizeBytes - offset).toInt()
            val bytes = readRange(source, offset, length)
            val part = TemporaryAttachmentBodySource(source.requestId, source.originalName, source.mimeType,
                length.toLong(), sha256(bytes), { ByteArrayInputStream(bytes) })
            val response = api.uploadChunk(scope, assetId, offset, part)
            require(response.getValue("uploadCheckpointVersion").jsonPrimitive.content == "1")
            require(response.getValue("assetId").jsonPrimitive.content == assetId)
            require(response.getValue("offset").jsonPrimitive.content.toLong() == offset + length)
            offset += length
            onProgress(offset, source.sizeBytes)
        }
    }

    private fun readRange(source: TemporaryAttachmentBodySource, offset: Long, length: Int): ByteArray {
        require(offset >= 0 && length > 0)
        return source.openStream().use { input ->
            val discard = ByteArray(DEFAULT_BUFFER_SIZE)
            var skipped = 0L
            while (skipped < offset) {
                val count = input.read(discard, 0, minOf(discard.size.toLong(), offset - skipped).toInt())
                require(count > 0) { "Attachment source ended before the acknowledged offset" }
                skipped += count
            }
            val result = ByteArray(length)
            var read = 0
            while (read < length) {
                val count = input.read(result, read, length - read)
                require(count > 0) { "Attachment source ended before the next chunk" }
                read += count
            }
            result
        }
    }

    private fun validateOffset(offset: Long, total: Long, chunkBytes: Int) {
        require(offset in 0..total && (offset == total || offset % chunkBytes == 0L)) {
            "Temporary computer returned an invalid attachment offset"
        }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }

    private suspend fun readReceipt(scope: TemporarySessionScope, requestId: String): JsonObject? = try {
        api.assetReceipt(scope, requestId).also(::requireVersion)
    } catch (error: ApiException) {
        if (error.statusCode == 404) null else throw error
    }

    private fun validateAsset(asset: JsonObject, source: TemporaryAttachmentBodySource) {
        require(asset.getValue("originalName").jsonPrimitive.content == source.originalName &&
            asset.getValue("mimeType").jsonPrimitive.content == source.mimeType &&
            asset.getValue("sizeBytes").jsonPrimitive.content.toLong() == source.sizeBytes &&
            asset.getValue("sha256").jsonPrimitive.content == source.sha256) {
            "Temporary attachment receipt does not match the staged source"
        }
        require(asset.getValue("id").jsonPrimitive.content.matches(Regex("^fasset_[a-f0-9]{24}$")))
    }

    private fun receipt(asset: JsonObject) = TemporaryAttachmentReceipt(
        assetId = asset.getValue("id").jsonPrimitive.content,
        originalName = asset.getValue("originalName").jsonPrimitive.content,
        mimeType = asset.getValue("mimeType").jsonPrimitive.content,
        sizeBytes = asset.getValue("sizeBytes").jsonPrimitive.content.toLong(),
        sha256 = asset.getValue("sha256").jsonPrimitive.content,
        status = asset.getValue("status").jsonPrimitive.content,
    )

    private fun requireVersion(value: JsonObject) {
        require(value.getValue("uploadContractVersion").jsonPrimitive.content == "1") {
            "Temporary computer does not support the stable upload contract"
        }
    }

    private fun validate(input: TemporaryAttachmentInput) {
        require(input.requestId.matches(Regex("^[A-Za-z0-9_-]{1,128}$")))
        require(input.originalName.isNotBlank() && input.originalName.length <= 255 &&
            !input.originalName.contains('\u0000'))
        require(input.mimeType.matches(Regex("^[A-Za-z0-9!#$&^_.+-]{1,127}/[A-Za-z0-9!#$&^_.+-]{1,127}$")))
        require(input.bytes.isNotEmpty() && input.bytes.size <= MAX_ATTACHMENT_BYTES)
    }

    private fun validate(source: TemporaryAttachmentBodySource) {
        require(source.requestId.matches(Regex("^[A-Za-z0-9_-]{1,128}$")))
        require(source.originalName.isNotBlank() && source.originalName.length <= 255 && !source.originalName.contains('\u0000'))
        require(source.mimeType.matches(Regex("^[A-Za-z0-9!#$&^_.+-]{1,127}/[A-Za-z0-9!#$&^_.+-]{1,127}$")))
        require(source.sizeBytes in 1..MAX_ATTACHMENT_BYTES.toLong() && source.sha256.matches(Regex("^[a-f0-9]{64}$")))
    }

    companion object {
        const val MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
        const val MAX_CHUNK_BYTES = 1024 * 1024
    }
}

/** Small durable, authenticated-encryption store for content received through Android sharing. */
interface TemporaryAttachmentByteStore {
    fun stage(stageId: String, input: InputStream, maxBytes: Int = TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES): Pair<Long, String>
    fun read(stageId: String, expectedSize: Long, expectedSha256: String): ByteArray
    /** Opens a repeatable authenticated stream; consumers must read to EOF to verify GCM and SHA-256. */
    fun openVerifiedStream(stageId: String, expectedSize: Long, expectedSha256: String): InputStream =
        ByteArrayInputStream(read(stageId, expectedSize, expectedSha256))
    fun delete(stageId: String)
    /** Remove only old crash leftovers from the store. */
    fun pruneExpiredBefore(cutoffTimeMs: Long): Int = 0
}

class AndroidTemporaryAttachmentByteStore(context: Context) : TemporaryAttachmentByteStore {
    private val store = TemporaryAttachmentEncryptedFiles(
        File(context.applicationContext.noBackupFilesDir, "temporary-attachment-staging"),
        ::key,
    )

    override fun stage(stageId: String, input: InputStream, maxBytes: Int): Pair<Long, String> =
        store.stage(stageId, input, maxBytes)

    override fun read(stageId: String, expectedSize: Long, expectedSha256: String): ByteArray =
        store.read(stageId, expectedSize, expectedSha256)

    override fun openVerifiedStream(stageId: String, expectedSize: Long, expectedSha256: String): InputStream =
        store.openVerifiedStream(stageId, expectedSize, expectedSha256)

    override fun delete(stageId: String) = store.delete(stageId)

    override fun pruneExpiredBefore(cutoffTimeMs: Long): Int = store.pruneExpiredBefore(cutoffTimeMs)

    private fun key(): SecretKey {
        val alias = "ragent_temporary_attachment_staging_key_v1"
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
        }.generateKey()
    }
}

/** Internal file format and cipher pipe kept injectable so the byte protocol is unit-testable. */
internal class TemporaryAttachmentEncryptedFiles(
    private val directory: File,
    private val keyProvider: () -> SecretKey,
) : TemporaryAttachmentByteStore {
    override fun stage(stageId: String, input: InputStream, maxBytes: Int): Pair<Long, String> {
        validateStageId(stageId)
        require(maxBytes in 1..TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES)
        check(directory.exists() || directory.mkdirs()) { "Temporary attachment storage is unavailable" }
        val target = file(stageId)
        val partial = File(directory, "$stageId.partial")
        check(!target.exists()) { "Temporary attachment is already staged" }
        partial.delete()
        var size = 0L
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, keyProvider())
                updateAAD(aad(stageId))
            }
            FileOutputStream(partial).use { raw ->
                raw.write(cipher.iv)
                CipherOutputStream(raw, cipher).use { encrypted ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        size += count
                        require(size <= maxBytes) { "Shared attachment exceeds the size limit" }
                        digest.update(buffer, 0, count)
                        encrypted.write(buffer, 0, count)
                    }
                }
            }
            require(size > 0) { "Shared attachment is empty" }
            check(partial.renameTo(target)) { "Temporary attachment could not be committed" }
            return size to digest.digest().hex()
        } catch (error: Throwable) {
            partial.delete()
            target.delete()
            throw error
        }
    }

    override fun read(stageId: String, expectedSize: Long, expectedSha256: String): ByteArray {
        return openVerifiedStream(stageId, expectedSize, expectedSha256).use { input ->
            val output = ByteArrayOutputStream(expectedSize.toInt())
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
    }

    override fun openVerifiedStream(stageId: String, expectedSize: Long, expectedSha256: String): InputStream {
        validateStageId(stageId)
        require(expectedSize in 1..TemporaryAttachmentUploader.MAX_ATTACHMENT_BYTES.toLong())
        require(expectedSha256.matches(Regex("^[a-f0-9]{64}$")))
        val raw = DataInputStream(FileInputStream(file(stageId)))
        try {
            val iv = ByteArray(12).also(raw::readFully)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, keyProvider(), GCMParameterSpec(128, iv))
                updateAAD(aad(stageId))
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var size = 0L
            var verified = false
            val decrypted = CipherInputStream(raw, cipher)
            return object : java.io.FilterInputStream(decrypted) {
                override fun read(): Int {
                    val value = super.read()
                    if (value < 0) verifyEnd()
                    else {
                        size++
                        require(size <= expectedSize) { "Staged attachment size changed" }
                        digest.update(value.toByte())
                    }
                    return value
                }

                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (length == 0) return 0
                    val count = super.read(buffer, offset, length)
                    if (count < 0) verifyEnd()
                    else if (count > 0) {
                        size += count
                        require(size <= expectedSize) { "Staged attachment size changed" }
                        digest.update(buffer, offset, count)
                    }
                    return count
                }

                override fun skip(n: Long): Long {
                    if (n <= 0) return 0
                    val buffer = ByteArray(minOf(DEFAULT_BUFFER_SIZE.toLong(), n).toInt())
                    var skipped = 0L
                    while (skipped < n) {
                        val count = read(buffer, 0, minOf(buffer.size.toLong(), n - skipped).toInt())
                        if (count < 0) break
                        skipped += count
                    }
                    return skipped
                }

                private fun verifyEnd() {
                    if (verified) return
                    verified = true
                    require(size == expectedSize && digest.digest().hex() == expectedSha256) {
                        "Staged attachment integrity check failed"
                    }
                }
            }
        } catch (error: Throwable) {
            runCatching { raw.close() }
            throw error
        }
    }

    override fun delete(stageId: String) {
        validateStageId(stageId)
        file(stageId).delete()
        File(directory, "$stageId.partial").delete()
    }

    override fun pruneExpiredBefore(cutoffTimeMs: Long): Int {
        require(cutoffTimeMs > 0)
        if (!directory.isDirectory) return 0
        val artifactPattern = Regex("^tast_[a-f0-9]{32}\\.(?:enc|partial)$")
        var removed = 0
        directory.listFiles().orEmpty().forEach { candidate ->
            if (candidate.isFile && artifactPattern.matches(candidate.name) && candidate.lastModified() < cutoffTimeMs &&
                candidate.delete()) removed++
        }
        return removed
    }

    private fun file(stageId: String) = File(directory, "$stageId.enc")
    private fun aad(stageId: String) = "ragent-temporary-attachment-v1:$stageId".toByteArray(Charsets.UTF_8)
    private fun validateStageId(stageId: String) = require(stageId.matches(Regex("^tast_[a-f0-9]{32}$")))

    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
}
