package com.andysagent.ragent

import android.content.Intent
import android.graphics.BitmapFactory
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.res.stringResource
import androidx.core.content.FileProvider
import com.andysagent.ragent.core.network.ApiException
import com.andysagent.ragent.core.network.RagentTransport
import com.andysagent.ragent.core.network.downloadAsset
import com.andysagent.ragent.core.network.getAssetMetadata
import com.andysagent.ragent.feature.workbench.ComposerAttachment
import com.andysagent.ragent.feature.workbench.LocalTimelineAttachmentOpen
import com.andysagent.ragent.feature.workbench.LocalTimelineAttachmentThumbnail
import com.andysagent.ragent.feature.workbench.LocalTimelineThumbnailCache
import com.andysagent.ragent.feature.workbench.TimelineThumbnailCache
import com.andysagent.ragent.feature.workbench.LocalTimelineUriHandler
import java.io.File
import java.net.URI
import java.util.UUID
import kotlinx.coroutines.*

private val assetPathPattern = Regex("^/api/assets/(fasset_[a-f0-9]{24})/download(?:\\?download=1)?$")
private val assetIdPattern = Regex("^fasset_[a-f0-9]{24}$")
private fun targetAssetPath(value: String, endpoint: String?): String? {
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    val base = endpoint?.let { runCatching { URI(it) }.getOrNull() }
    fun effectivePort(parsed: URI) = if (parsed.port >= 0) parsed.port else when (parsed.scheme?.lowercase()) {
        "https" -> 443
        "http" -> 80
        else -> -1
    }
    val path = if (!uri.isAbsolute) value else if (base != null && !uri.host.isNullOrBlank() &&
        uri.scheme.equals(base.scheme, true) && uri.host.equals(base.host, true) &&
        effectivePort(uri) == effectivePort(base) && uri.userInfo == null && uri.fragment == null)
        uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "") else return null
    return path.takeIf { assetPathPattern.matches(it) }
}
private fun assetId(attachment: ComposerAttachment, endpoint: String?): String? {
    attachment.assetId?.takeIf { assetIdPattern.matches(it) }?.let { return it }
    return attachment.previewUrl?.let { targetAssetPath(it, endpoint) }
        ?.let { assetPathPattern.matchEntire(it)?.groupValues?.get(1) }
}
private fun safeName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
    .replace(Regex("[\\p{Cntrl}\\\\/:*?\"<>|]"), "_").take(180).ifBlank { "attachment" }

/** State and transfers are scoped to the displayed target and session, without remounting the workbench. */
@Composable
internal fun TimelineAttachmentHost(
    targetId: String?, sessionId: String?, transport: RagentTransport?, endpoint: String?,
    cacheScope: Any?, content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val outerUriHandler = LocalUriHandler.current
    val thumbnailCache = remember(targetId, sessionId, transport, endpoint, cacheScope) { TimelineThumbnailCache() }
    DisposableEffect(thumbnailCache) { onDispose { thumbnailCache.clear() } }
    val scope = remember(targetId, sessionId, transport) { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
    var current by remember(targetId, sessionId, transport) { mutableStateOf<ComposerAttachment?>(null) }
    var file by remember(targetId, sessionId, transport) { mutableStateOf<File?>(null) }
    var error by remember(targetId, sessionId, transport) { mutableStateOf<Int?>(null) }
    var pendingSave by remember(targetId, sessionId, transport) { mutableStateOf<File?>(null) }
    var saved by remember(targetId, sessionId, transport) { mutableStateOf(false) }
    var progress by remember(targetId, sessionId, transport) { mutableStateOf<Pair<Long, Long?>?>(null) }
    var job by remember(targetId, sessionId, transport) { mutableStateOf<Job?>(null) }
    var generation by remember(targetId, sessionId, transport) { mutableIntStateOf(0) }
    val directory = remember { File(context.cacheDir, "shared/timeline") }
    DisposableEffect(scope) { onDispose { scope.cancel() } }
    LaunchedEffect(Unit) { withContext(Dispatchers.IO) {
        directory.mkdirs()
        directory.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 60 * 60 * 1000L }?.forEach { it.delete() }
    } }
    fun showFile(attachment: ComposerAttachment, source: File) {
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", source, safeName(attachment.name))
            val mime = attachment.mimeType.takeIf { it.isNotBlank() && it != "application/octet-stream" }
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(source.extension.lowercase()) ?: "application/octet-stream"
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startActivity(intent)
        } catch (_: Exception) { error = R.string.timeline_attachment_no_viewer }
    }
    fun download(attachment: ComposerAttachment) {
        job?.cancel()
        generation++
        val serial = generation
        file = null
        saved = false
        error = null
        progress = 0L to null
        val id = assetId(attachment, endpoint)
        val local = attachment.localPath?.let { runCatching { Uri.parse(it) }.getOrNull() }
            ?.takeIf { it.scheme == "content" && ((it.authority == "${context.packageName}.files" && it.path.orEmpty().startsWith("/shared_files/")) ||
                (it.authority != context.packageName && !it.authority.orEmpty().startsWith("${context.packageName}."))) &&
                context.checkUriPermission(it, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED }
        if (id == null && local == null) {
            val external = attachment.previewUrl?.let { runCatching { URI(it) }.getOrNull() }
            if (external?.scheme in setOf("http", "https") && !external?.host.isNullOrBlank() && external?.userInfo == null) {
                runCatching { outerUriHandler.openUri(external.toString()) }
                progress = null; current = null; return
            }
        }
        if (id == null && local == null || id != null && (targetId == null || sessionId == null || transport == null)) {
            progress = null; error = R.string.timeline_attachment_unavailable; return
        }
        job = scope.launch {
            var destination: File? = null
            try {
                val metadata = if (id != null) transport!!.getAssetMetadata(id, sessionId!!) else null
                val resolved = if (metadata != null) attachment.copy(name = metadata.originalName, mimeType = metadata.mimeType) else attachment
                current = resolved
                val outputFile = File(directory, "${UUID.randomUUID()}-${safeName(resolved.name)}")
                destination = outputFile
                withContext(Dispatchers.IO) { directory.mkdirs() }
                if (id != null) transport!!.downloadAsset("/api/assets/$id/download", outputFile,
                    expectedSize = metadata!!.sizeBytes, expectedSha256 = metadata.sha256) { done, total ->
                    scope.launch { if (generation == serial) progress = done to total }
                } else withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(local!!)?.use { input -> outputFile.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                        }
                    } }
                        ?: throw java.io.IOException("Cannot read picker URI")
                }
                ensureActive()
                if (generation == serial) { generation++; file = outputFile; progress = null; if (!resolved.mimeType.startsWith("image/")) showFile(resolved, outputFile) }
            } catch (cancelled: CancellationException) { withContext(NonCancellable + Dispatchers.IO) { destination?.delete() }; throw cancelled }
            catch (failure: Exception) {
                withContext(Dispatchers.IO) { destination?.delete() }
                if (generation == serial) {
                    progress = null
                    error = when ((failure as? ApiException)?.statusCode) {
                        0 -> R.string.timeline_attachment_offline
                        401, 403 -> R.string.timeline_attachment_forbidden
                        404, 410 -> R.string.timeline_attachment_missing
                        else -> if (failure is java.net.SocketException || failure is java.net.UnknownHostException || failure is java.net.SocketTimeoutException) R.string.timeline_attachment_offline else R.string.timeline_attachment_download_failed
                    }
                }
            }
        }
    }
    fun openAttachment(attachment: ComposerAttachment) {
        val active = current
        if (job?.isActive == true && active != null &&
            (assetId(active, endpoint)?.let { it == assetId(attachment, endpoint) } == true ||
                (active.localPath != null && active.localPath == attachment.localPath))) return
        current = attachment
        download(attachment)
    }
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { destination ->
        val source = pendingSave
        pendingSave = null
        if (destination != null && source != null) scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(destination)?.use { output -> source.inputStream().use { it.copyTo(output) } }
                        ?: throw java.io.IOException("Cannot open destination")
                }
                saved = true
                error = null
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { error = R.string.timeline_attachment_save_failed }
        }
    }
    val uriHandler = remember(outerUriHandler, targetId, sessionId, transport, endpoint) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val parsed = runCatching { URI(uri) }.getOrNull() ?: return
                val relative = targetAssetPath(uri, endpoint)
                if (relative != null) {
                    openAttachment(ComposerAttachment(name = "attachment", mimeType = "application/octet-stream", previewUrl = relative))
                } else if ((parsed.scheme in setOf("http", "https") && !parsed.host.isNullOrBlank() && parsed.userInfo == null) ||
                    parsed.scheme in setOf("mailto", "tel")) {
                    runCatching { outerUriHandler.openUri(uri) }
                }
            }
        }
    }
    val thumbnail: suspend (ComposerAttachment) -> ByteArray? = remember(targetId, sessionId, transport, endpoint) { { attachment ->
        val id = assetId(attachment, endpoint)
        if (id == null || transport == null || targetId == null || sessionId == null || attachment.sizeBytes > 8 * 1024 * 1024) null
        else {
            val temp = File(directory, "thumb-${UUID.randomUUID()}")
            try {
                val meta = transport.getAssetMetadata(id, sessionId)
                withContext(Dispatchers.IO) { directory.mkdirs() }
                transport.downloadAsset("/api/assets/$id/download", temp, expectedSize = meta.sizeBytes, expectedSha256 = meta.sha256, maxBytes = 8L * 1024 * 1024)
                withContext(Dispatchers.IO) { temp.readBytes() }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
            finally { withContext(NonCancellable + Dispatchers.IO) { temp.delete() } }
        }
    }
    }
    // The callback must be rebuilt when the chat binding changes. A remembered
    // callable reference can otherwise retain the initial unbound target/session.
    val attachmentOpen: (ComposerAttachment) -> Unit = remember(targetId, sessionId, transport, endpoint, outerUriHandler, scope) {
        { attachment -> openAttachment(attachment) }
    }
    CompositionLocalProvider(
        LocalTimelineAttachmentOpen provides attachmentOpen,
        LocalTimelineAttachmentThumbnail provides thumbnail,
        LocalTimelineThumbnailCache provides thumbnailCache,
        LocalTimelineUriHandler provides uriHandler,
    ) { content() }
    current?.let { attachment ->
        val preview by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, file, attachment.mimeType) {
            val source = file
            if (source != null && attachment.mimeType.startsWith("image/")) value = withContext(Dispatchers.IO) {
                runCatching {
                    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(source.path, options)
                    if (options.outWidth <= 0 || options.outHeight <= 0) null else {
                        var sample = 1
                        while (options.outWidth / sample > 1600 || options.outHeight / sample > 1600) sample *= 2
                        options.inSampleSize = sample
                        options.inJustDecodeBounds = false
                        BitmapFactory.decodeFile(source.path, options)?.asImageBitmap()
                    }
                }.getOrNull()
            }
        }
        AlertDialog(
            onDismissRequest = { generation++; job?.cancel(); current = null; progress = null },
            title = { Text(safeName(attachment.name)) },
            text = {
                when {
                    progress != null -> {
                        Text(stringResource(R.string.timeline_attachment_downloading))
                        val (done, total) = progress!!
                        if (total != null && total > 0) LinearProgressIndicator(progress = { (done.toFloat() / total).coerceIn(0f, 1f) })
                        else LinearProgressIndicator()
                    }
                    error != null -> Text(stringResource(error!!))
                    preview != null -> Column { Image(preview!!, contentDescription = attachment.name, modifier = Modifier.fillMaxWidth().heightIn(max = 400.dp)); if (saved) Text(stringResource(R.string.timeline_attachment_saved)) }
                    saved -> Text(stringResource(R.string.timeline_attachment_saved))
                    else -> Text(stringResource(R.string.timeline_attachment_ready))
                }
            },
            confirmButton = {
                if (file != null) TextButton(onClick = { showFile(attachment, file!!) }) { Text(stringResource(R.string.timeline_attachment_open)) }
                else if (error != null) TextButton(onClick = { download(attachment) }) { Text(stringResource(R.string.timeline_attachment_retry)) }
            },
            dismissButton = {
                if (file != null) TextButton(onClick = { pendingSave = file; saveLauncher.launch(safeName(attachment.name)) }) { Text(stringResource(R.string.timeline_attachment_save)) }
                else TextButton(onClick = { generation++; job?.cancel(); current = null; progress = null }) { Text(stringResource(R.string.timeline_attachment_cancel)) }
            },
        )
    }
}
