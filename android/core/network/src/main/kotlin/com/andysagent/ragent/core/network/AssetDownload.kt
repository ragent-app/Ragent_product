package com.andysagent.ragent.core.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest

/** Downloads a server-authorized asset in bounded chunks. The caller must bind this
 * transport to the target that produced the asset and provide a private destination. */
suspend fun RagentTransport.downloadAsset(
    path: String,
    destination: File,
    expectedSize: Long? = null,
    expectedSha256: String? = null,
    maxBytes: Long? = null,
    onProgress: (Long, Long?) -> Unit = { _, _ -> },
) = withContext(Dispatchers.IO) {
    require(path.matches(Regex("^/api/assets/fasset_[a-f0-9]{24}/download(?:\\?download=1)?$")))
    require(expectedSize == null || expectedSize >= 0)
    require(maxBytes == null || maxBytes >= 0)
    require(expectedSize == null || maxBytes == null || expectedSize <= maxBytes)
    require(expectedSha256 == null || expectedSha256.matches(Regex("^[a-fA-F0-9]{64}$")))
    if (this@downloadAsset is OkHttpRagentTransport &&
        this@downloadAsset.downloadDirectAsset(path, destination, expectedSize, expectedSha256, maxBytes, onProgress)) return@withContext
    val digest = MessageDigest.getInstance("SHA-256")
    var offset = 0L
    var total: Long? = null
    try {
        destination.outputStream().buffered().use { output ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val end = if (offset > Long.MAX_VALUE - CHUNK_SIZE + 1) Long.MAX_VALUE else offset + CHUNK_SIZE - 1
                val headers = mapOf("Range" to "bytes=$offset-$end", "Accept-Encoding" to "identity")
                val serverHeaders = headers + ("X-Ragent-Asset-Redirect" to "manual")
                val responseLimit = maxBytes?.let { (it - offset).coerceAtLeast(0L) }
                var response = try { execute(ApiRequest("GET", path, headers = serverHeaders, rawDownload = true, maxResponseBytes = responseLimit)) }
                catch (error: ApiException) {
                    if (offset == 0L && error.statusCode == 416 && error.headers.header("Content-Range")?.trim() == "bytes */0") {
                        if (expectedSize != null && expectedSize != 0L) throw IOException("Asset size mismatch")
                        total = 0L
                        break
                    }
                    throw error
                }
                if (response.statusCode in 300..399) {
                    val location = response.headers.header("Location") ?: throw IOException("Missing asset redirect")
                    val uri = runCatching { URI(location) }.getOrNull()
                    if (uri == null || !uri.scheme.equals("https", true) || uri.host.isNullOrBlank() || uri.userInfo != null || uri.fragment != null)
                        throw IOException("Invalid asset redirect")
                    // This URL came from the authorized server; do not forward bearer or scope headers.
                    response = execute(ApiRequest("GET", location, headers = headers, rawDownload = true, isolateCredentialFailure = true, maxResponseBytes = responseLimit))
                }
                val bytes = response.bodyBytes ?: throw IOException("Asset response has no bytes")
                if (response.statusCode == 206) {
                    val range = response.headers.header("Content-Range")?.let { RANGE.matchEntire(it.trim()) }
                        ?: throw IOException("Invalid asset range")
                    val start = range.groupValues[1].toLongOrNull() ?: throw IOException("Invalid asset range")
                    val last = range.groupValues[2].toLongOrNull() ?: throw IOException("Invalid asset range")
                    val size = range.groupValues[3].toLongOrNull() ?: throw IOException("Invalid asset size")
                    if (start != offset || last < start || last > end || last >= size || last - start + 1 != bytes.size.toLong() || (total != null && total != size))
                        throw IOException("Inconsistent asset range")
                    total = size
                } else if (response.statusCode == 200 && offset == 0L) {
                    val length = response.headers.header("Content-Length")?.toLongOrNull()
                    if (length != null && length != bytes.size.toLong()) throw IOException("Incomplete asset")
                    total = bytes.size.toLong()
                } else throw IOException("Unexpected asset response")
                if (maxBytes != null && total!! > maxBytes) throw IOException("Asset exceeds size limit")
                if (expectedSize != null && total != expectedSize) throw IOException("Asset size mismatch")
                output.write(bytes)
                digest.update(bytes)
                offset += bytes.size
                onProgress(offset, total)
                if (offset == total) break
                if (bytes.isEmpty()) throw IOException("Incomplete asset")
            }
        }
        currentCoroutineContext().ensureActive()
        if (expectedSha256 != null && digest.digest().joinToString("") { "%02x".format(it) } != expectedSha256.lowercase())
            throw IOException("Asset digest mismatch")
    } catch (error: Throwable) {
        destination.delete()
        throw error
    }
}

private const val CHUNK_SIZE = 128L * 1024L
private val RANGE = Regex("bytes (\\d+)-(\\d+)/(\\d+)", RegexOption.IGNORE_CASE)
private fun Map<String, String>.header(name: String): String? = entries.firstOrNull { it.key.equals(name, true) }?.value


data class AssetMetadata(
    val id: String,
    val sessionId: String,
    val originalName: String,
    val mimeType: String,
    val sizeBytes: Long?,
    val sha256: String?,
)

/** Read metadata under the same target and session authority used for download. */
suspend fun RagentTransport.getAssetMetadata(assetId: String, sessionId: String): AssetMetadata {
    require(assetId.matches(Regex("^fasset_[a-f0-9]{24}$")))
    require(sessionId.isNotBlank())
    val response = execute(ApiRequest("GET", "/api/assets/$assetId"))
    val asset = Json.parseToJsonElement(response.body).jsonObject["asset"]?.jsonObject
        ?: throw IOException("Invalid asset metadata")
    fun string(key: String) = asset[key]?.jsonPrimitive?.contentOrNull
    if (string("id") != assetId || string("sessionId") != sessionId || string("status") != "ready")
        throw IOException("Asset is unavailable in this session")
    val size = asset["sizeBytes"]?.jsonPrimitive?.longOrNull
    val hash = string("sha256")
    if (size != null && size < 0 || hash != null && !hash.matches(Regex("^[a-fA-F0-9]{64}$")))
        throw IOException("Invalid asset metadata")
    return AssetMetadata(assetId, sessionId, string("originalName")?.takeIf { it.isNotBlank() } ?: "attachment",
        string("mimeType")?.takeIf { it.isNotBlank() } ?: "application/octet-stream", size, hash)
}
