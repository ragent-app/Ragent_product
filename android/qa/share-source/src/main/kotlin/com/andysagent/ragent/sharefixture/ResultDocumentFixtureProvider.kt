package com.andysagent.ragent.sharefixture

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.*
import android.os.storage.StorageManager
import android.system.ErrnoException
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Granted, different-UID synthetic document sink. This is not a DocumentsUI/SAF selector. */
class ResultDocumentFixtureProvider : ContentProvider() {
    private class Observation {
        val release = CountDownLatch(1)
        @Volatile var phase = "idle"
        @Volatile var pid = 0
        @Volatile var uid = 0
        @Volatile var opens = 0
        @Volatile var written = 0L
    }
    private val observations = ConcurrentHashMap<String, Observation>()
    private val callbacks = HandlerThread("DocumentFixtureCallbacks")
    override fun onCreate(): Boolean { callbacks.start(); activeProvider = this; return true }
    private fun observation(uri: Uri) = observations.getOrPut(uri.pathSegments[1]) { Observation() }
    override fun getType(uri: Uri) = "application/octet-stream"
    private fun file(uri: Uri): File {
        require(uri.pathSegments.size == 2 && uri.pathSegments[0] in setOf("ready", "fail", "block-open", "block-write", "block-fsync", "block-release"))
        val id = uri.pathSegments[1]; require(Regex("[a-f0-9-]{36}").matches(id))
        return File(requireNotNull(context).filesDir, "result-documents/$id.bin").also { it.parentFile!!.mkdirs() }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val path = file(uri)
        val state = observation(uri); val kind = uri.pathSegments[0]
        if (mode != "r") {
            state.pid = Binder.getCallingPid(); state.uid = Binder.getCallingUid(); state.opens++
            state.phase = "open"
        }
        if (kind == "fail") throw FileNotFoundException("Synthetic document provider refuses opening")
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "w", "wt" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw SecurityException("Unsupported document mode")
        }
        if (mode == "r" || kind == "ready") return ParcelFileDescriptor.open(path, flags)
        if (kind == "block-open") {
            state.phase = "blocked-open"; state.release.await(180, TimeUnit.SECONDS)
            // A dead caller must not get a later provider-side truncation after its request ended.
            throw FileNotFoundException("Blocked document opening was released")
        }
        val output = RandomAccessFile(path, "rw").apply { setLength(0) }
        return requireNotNull(context).getSystemService(StorageManager::class.java).openProxyFileDescriptor(
            ParcelFileDescriptor.MODE_WRITE_ONLY, object : ProxyFileDescriptorCallback() {
                override fun onGetSize() = output.length()
                override fun onRead(offset: Long, size: Int, data: ByteArray): Int = throw ErrnoException("write-only", OsConstants.EBADF)
                override fun onWrite(offset: Long, size: Int, data: ByteArray): Int {
                    if (kind == "block-write") { state.phase = "blocked-write"; state.release.await(180, TimeUnit.SECONDS) }
                    output.seek(offset); output.write(data, 0, size); state.written += size; return size
                }
                override fun onFsync() {
                    if (kind == "block-fsync") { state.phase = "blocked-fsync"; state.release.await(180, TimeUnit.SECONDS) }
                    output.fd.sync()
                }
                override fun onRelease() {
                    if (kind == "block-release") { state.phase = "blocked-release"; state.release.await(180, TimeUnit.SECONDS) }
                    output.close(); state.phase = "released"
                }
            }, Handler(callbacks.looper))
    }
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        val path = file(uri)
        if (selection == "revoke") {
            requireNotNull(context).revokeUriPermission("com.agentoncloud.android", uri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            return 1
        }
        observation(uri).release.countDown()
        return if (path.delete()) 1 else 0
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        file(uri); val state = observation(uri)
        return MatrixCursor(arrayOf("observation")).apply { addRow(arrayOf(JSONObject().put("phase", state.phase)
            .put("pid", state.pid).put("uid", state.uid).put("opens", state.opens).put("written", state.written).toString())) }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = throw UnsupportedOperationException()
    companion object {
        @Volatile private var activeProvider: ResultDocumentFixtureProvider? = null
        /** QA metadata only: cold verification does not recreate a lost document write grant. */
        fun observeDocument(id: String): String? {
            require(Regex("[a-f0-9-]{36}").matches(id))
            val state = activeProvider?.observations?.get(id) ?: return null
            return JSONObject().put("phase", state.phase).put("pid", state.pid).put("uid", state.uid)
                .put("opens", state.opens).put("written", state.written).toString()
        }
        fun releaseDocument(id: String): Int {
            require(Regex("[a-f0-9-]{36}").matches(id))
            val provider = activeProvider ?: return 0
            if (!provider.observations.containsKey(id)) return 0
            return provider.delete(Uri.parse("content://${requireNotNull(provider.context).packageName}.result-document/ready/$id"), null, null)
        }
    }
}
