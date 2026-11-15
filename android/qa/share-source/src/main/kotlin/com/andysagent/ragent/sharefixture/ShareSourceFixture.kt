package com.andysagent.ragent.sharefixture

import android.app.Activity
import android.content.*
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException

/** Standalone QA APK's own UID/process and a non-exported provider. Synthetic material only. */
class ShareSourceFixtureProvider : ContentProvider() {
    override fun onCreate() = true
    override fun getType(uri: Uri) = if (uri.lastPathSegment == "second.png") "image/png" else "text/csv"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?) =
        MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
            addRow(arrayOf(uri.lastPathSegment, when (uri.lastPathSegment) {
                "unknown.csv" -> null
                "oversized.csv" -> 26L * 1024 * 1024
                "lie.csv" -> 1L
                else -> body(uri).size.toLong()
            }))
        }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r" || uri.lastPathSegment == "missing.csv") throw FileNotFoundException("Synthetic unavailable source")
        val name = uri.lastPathSegment ?: throw FileNotFoundException()
        if (name !in setOf("first.csv", "second.png", "unknown.csv", "lie.csv", "oversized.csv", "missing.csv")) throw FileNotFoundException()
        val file = File(context!!.cacheDir, name)
        file.writeBytes(body(uri))
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun insert(uri: Uri, values: ContentValues?) = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = throw UnsupportedOperationException()
    companion object {
        fun body(uri: Uri): ByteArray {
            if (uri.lastPathSegment == "second.png") return android.util.Base64.decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
                android.util.Base64.DEFAULT,
            )
            val base = "a,b\n1,2\n合成分享文件\n".toByteArray()
            val requestedBytes = uri.getQueryParameter("bytes")?.toIntOrNull()
                ?.coerceIn(base.size, 5 * 1024 * 1024) ?: return base
            val filler = "# synthetic padding\n".toByteArray()
            return ByteArrayOutputStream(requestedBytes).apply {
                write(base)
                while (size() < requestedBytes) {
                    val count = minOf(filler.size, requestedBytes - size())
                    write(filler, 0, count)
                }
            }.toByteArray()
        }
    }
}

class ShareSourceFixtureActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (intent.getBooleanExtra("chooser", false)) {
            val names = intent.getStringExtra("namesBase64")?.let { encoded ->
                String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
                    .split(',').filter(String::isNotBlank)
            } ?: intent.getStringExtra("names")?.split(',')?.filter(String::isNotBlank).orEmpty()
            val material = intent.getStringExtra("materialBase64")?.let { encoded ->
                String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
            } ?: intent.getStringExtra("material") ?: "Synthetic Sharesheet material"
            val fileBytes = intent.getIntExtra("fileBytes", 0)
            val uris = names.map {
                Uri.parse("content://$packageName.share-fixture/$it").buildUpon().apply {
                    if (fileBytes > 0) appendQueryParameter("bytes", fileBytes.toString())
                }.build()
            }
            val mimeType = intent.getStringExtra("mimeType") ?: if (uris.size > 1) "*/*"
                else uris.firstOrNull()?.let { contentResolver.getType(it) } ?: "text/plain"
            val html = intent.getStringExtra("htmlBase64")?.let { encoded ->
                String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
            }
            val share = Intent(if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND)
                .setType(mimeType)
                .putExtra("fixtureSenderUid", android.os.Process.myUid())
            if (!intent.getBooleanExtra("omitText", false)) share.putExtra(Intent.EXTRA_TEXT, material)
            if (html != null) share.putExtra(Intent.EXTRA_HTML_TEXT, html)
            if (uris.size == 1) share.putExtra(Intent.EXTRA_STREAM, uris.single())
            else if (uris.size > 1) share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
            if (uris.isNotEmpty()) {
                share.clipData = ClipData.newRawUri("Synthetic shared files", uris.first()).apply {
                    uris.drop(1).forEach { addItem(ClipData.Item(it)) }
                }
                if (!intent.getBooleanExtra("denyGrant", false)) {
                    share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
            }
            startActivity(Intent.createChooser(share, "Synthetic QA share"))
            finish()
            return
        }
        val names = intent.getStringExtra("namesBase64")?.let { encoded ->
            String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
                .split(',').filter(String::isNotBlank)
        } ?: intent.getStringArrayListExtra("names") ?: arrayListOf("first.csv", "second.png")
        val material = intent.getStringExtra("materialBase64")?.let { encoded ->
            String(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP), Charsets.UTF_8)
        } ?: intent.getStringExtra("material") ?: "Synthetic Sharesheet material"
        val uris = names.map { Uri.parse("content://$packageName.share-fixture/$it") }
        val share = Intent(if (uris.size > 1) Intent.ACTION_SEND_MULTIPLE else Intent.ACTION_SEND)
            .setType(if (uris.size > 1) "*/*" else "text/csv")
            .putExtra(Intent.EXTRA_TEXT, material)
            .putExtra("callerBinding", "forged").putExtra("autoStart", true).putExtra("confirmed", true)
            .putExtra("ragent.internal.draftId", "forged").putExtra("EXTRA_TARGET_DEVICE_ID", "forged")
            .putExtra("fixtureSenderUid", android.os.Process.myUid())
        if (uris.size > 1) share.putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        else share.putExtra(Intent.EXTRA_STREAM, uris.single())
        share.clipData = ClipData.newRawUri("Synthetic captured file", uris.first()).apply {
            uris.drop(1).forEach { addItem(ClipData.Item(it)) }
        }
        if (!intent.getBooleanExtra("denyGrant", false)) share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(share, "Synthetic QA share"))
        finish()
    }
}
