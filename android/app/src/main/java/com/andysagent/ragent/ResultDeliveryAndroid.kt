package com.andysagent.ragent

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import com.andysagent.ragent.core.appapi.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Owner-only Android output adapter. A URI grant is issued only by an explicit Activity share action. */
internal class ResultDeliveryAndroid(private val context: Context, private val cache: ResultDeliveryCache,
    private val caller: VerifiedCaller) {
    private val documentWorker = DocumentExportClient(context)
    fun uri(reference: ResultDeliveryRef): Uri = Uri.Builder().scheme("content")
        .authority("${context.packageName}.result-files").appendPath("results")
        .appendPath(reference.id).appendPath(reference.name).build()

    suspend fun stage(downloadId: String): ResultDeliveryRef {
        cleanupExpired()
        return cache.stage(downloadId, caller)
    }
    suspend fun shareIntent(id: String): Intent = cache.withSharedFile(id, caller) { reference, _ ->
        val uri = uri(reference)
        Intent(Intent.ACTION_SEND).apply {
            type = reference.mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData(reference.name, arrayOf(reference.mimeType), ClipData.Item(uri))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
    suspend fun revoke(id: String) {
        cache.revoke(id, caller)?.let { context.revokeUriPermission(uri(it), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
    suspend fun cleanupExpired() {
        cache.cleanupExpired(::revokeGrant)
    }
    fun revokeGrant(reference: ResultDeliveryRef) {
        context.revokeUriPermission(uri(reference), Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    suspend fun revokeForOutput(downloadId: String) {
        cache.revokeForOutput(downloadId, caller).forEach {
            context.revokeUriPermission(uri(it), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /** The non-exported owner Activity passes only an ACTION_CREATE_DOCUMENT Activity Result URI. */
    suspend fun saveToDocument(id: String, document: Uri): ResultDeliveryRef = withContext(Dispatchers.IO) {
        if (document.scheme != "content" || document.authority.isNullOrEmpty() ||
            document.authority == "${context.packageName}.result-files" ||
            context.checkUriPermission(document, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED)
            throw SecurityException("The selected document has no writable URI grant")
        cache.withSharedFileChecked(id, caller) { reference, file, digest, reauthorize ->
            documentWorker.copy(reference, file, document, digest, reauthorize)
        }
    }
}
