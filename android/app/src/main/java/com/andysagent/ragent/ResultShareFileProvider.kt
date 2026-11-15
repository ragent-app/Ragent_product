package com.andysagent.ragent

import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Binder
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import com.andysagent.ragent.core.appapi.ResultDeliveryRef
import kotlinx.coroutines.runBlocking
import java.io.File
import java.io.FileNotFoundException

/** Exact, expiring, read-only share copies; Android's grant gate and original resource authorization both apply. */
class ResultShareFileProvider : FileProvider() {
    private val graph get() = (requireNotNull(context).applicationContext as RagentApplication).runtime

    private fun ticketId(uri: Uri): String {
        val context = requireNotNull(context)
        if (uri.scheme != "content" || uri.authority != "${context.packageName}.result-files" ||
            uri.query != null || uri.fragment != null || uri.pathSegments.size != 3 || uri.pathSegments[0] != "results")
            throw FileNotFoundException("Invalid result URI")
        // The provider owner needs no temporary grant to its own URI. Foreign UIDs do.
        // Original output/ticket authorization below still applies to every caller.
        if (Binder.getCallingUid() != context.applicationInfo.uid &&
            context.checkUriPermission(uri, Binder.getCallingPid(), Binder.getCallingUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED)
            throw SecurityException("A temporary read grant is required")
        return uri.pathSegments[1]
    }
    private fun <T> read(uri: Uri, consume: (ResultDeliveryRef, File) -> T): T {
        val id = ticketId(uri)
        return runBlocking {
            graph.resultDeliveries.withSharedFile(id) { reference, path ->
                val expected = getUriForFile(requireNotNull(context), "${requireNotNull(context).packageName}.result-files", path)
                if (uri != expected || uri.pathSegments[2] != reference.name) throw FileNotFoundException("Result URI differs")
                consume(reference, path)
            }
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("Result shares are read-only")
        var descriptor: ParcelFileDescriptor? = null
        try {
            return read(uri) { _, _ -> (super.openFile(uri, "r") ?: throw FileNotFoundException("Result descriptor unavailable")).also { descriptor = it } }
        } catch (failure: Exception) {
            descriptor?.close()
            throw FileNotFoundException("Result share is unavailable").also { it.initCause(failure) }
        }
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor =
        read(uri) { reference, _ ->
            val columns = (projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE))
                .filter { it == OpenableColumns.DISPLAY_NAME || it == OpenableColumns.SIZE }.toTypedArray()
            MatrixCursor(columns, 1).apply { addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) reference.name else reference.sizeBytes }.toTypedArray()) }
        }
    override fun getType(uri: Uri): String = read(uri) { reference, _ -> reference.mimeType }
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw SecurityException("Result shares are read-only")
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw SecurityException("Result shares are read-only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw SecurityException("Result shares are read-only")
}
