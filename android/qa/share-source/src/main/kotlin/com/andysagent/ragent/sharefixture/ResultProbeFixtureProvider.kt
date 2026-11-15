package com.andysagent.ragent.sharefixture

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import java.io.File

/** Standalone QA observations only; no received file contents or production data. */
class ResultProbeFixtureProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri) = "application/json"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        if (uri.pathSegments.size == 2 && uri.pathSegments[0] == "document") {
            return MatrixCursor(arrayOf("observation"), 1).apply {
                ResultDocumentFixtureProvider.observeDocument(uri.pathSegments[1])?.let { addRow(arrayOf(it)) }
            }
        }
        val id = uri.pathSegments.singleOrNull() ?: throw IllegalArgumentException("Probe identity required")
        require(Regex("[a-f0-9-]{36}").matches(id))
        return MatrixCursor(arrayOf("observation"), 1).apply {
            val file = File(requireNotNull(context).filesDir, "result-probes/$id.json")
            if (file.isFile && file.length() <= 8192) addRow(arrayOf(file.readText()))
        }
    }
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        if (uri.pathSegments.size == 2 && uri.pathSegments[0] == "document")
            return ResultDocumentFixtureProvider.releaseDocument(uri.pathSegments[1])
        val id = uri.pathSegments.singleOrNull() ?: throw IllegalArgumentException("Probe identity required")
        require(Regex("[a-f0-9-]{36}").matches(id))
        return if (File(requireNotNull(context).filesDir, "result-probes/$id.json").delete()) 1 else 0
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
}
