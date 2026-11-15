package com.andysagent.ragent.sharefixture

import android.app.Activity
import android.content.Intent
import android.content.ComponentName
import android.content.ServiceConnection
import android.content.Context
import android.os.IBinder
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.provider.OpenableColumns
import android.widget.TextView
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** A real different-UID consumer; stores synthetic test observations, never result bytes. */
class ResultReceiverFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); probe(intent) }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); probe(intent) }
    @Suppress("DEPRECATION")
    private fun probe(request: Intent) {
        val uri = request.getParcelableExtra<Uri>(Intent.EXTRA_STREAM) ?: return
        // Native Sharesheet carries no QA extras. The production ticket URI already has a UUID.
        val id = request.getStringExtra("probeId") ?: uri.pathSegments.getOrNull(1) ?: return
        if (!Regex("[a-f0-9-]{36}").matches(id)) return
        val result = JSONObject().put("uid", Process.myUid()).put("uri", uri.toString())
        Thread {
            if (request.getBooleanExtra("probeWorkerBind", false)) {
                val connection = object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName, service: IBinder) = Unit
                    override fun onServiceDisconnected(name: ComponentName) = Unit
                }
                val bound = runCatching { bindService(Intent().setComponent(ComponentName("com.agentoncloud.android",
                    "com.andysagent.ragent.DocumentExportService")), connection, Context.BIND_AUTO_CREATE) }
                if (bound.getOrDefault(false)) unbindService(connection)
                result.put("workerBindDenied", bound.isFailure || !bound.getOrDefault(false))
            }
            try {
                val digest = MessageDigest.getInstance("SHA-256"); var length = 0L
                contentResolver.openInputStream(uri)!!.use { input ->
                    val buffer = ByteArray(65_536)
                    while (true) {
                        val count = input.read(buffer); if (count < 0) break
                        length += count; require(length <= 26_214_400); digest.update(buffer, 0, count)
                    }
                }
                result.put("read", true).put("bytes", length).put("sha256", digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
                result.put("mimeType", contentResolver.getType(uri))
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)!!.use {
                    check(it.moveToFirst()); result.put("name", it.getString(0)).put("size", it.getLong(1))
                }
            } catch (failure: Exception) { result.put("read", false).put("error", failure.javaClass.simpleName) }
            result.put("writeDenied", runCatching { contentResolver.openFileDescriptor(uri, "w")!!.use { }; false }.getOrElse { true })
            val sibling = uri.buildUpon().path(uri.path!!.substringBeforeLast('/') + "/unrelated.bin").build()
            result.put("siblingDenied", runCatching { contentResolver.openInputStream(sibling)!!.use { }; false }.getOrElse { true })
            if (request.getBooleanExtra("grantDocument", false)) {
                val kind = request.getStringExtra("documentKind")?.takeIf { it in setOf("ready", "fail", "block-open", "block-write", "block-fsync", "block-release") }
                    ?: if (request.getBooleanExtra("failDocument", false)) "fail" else "ready"
                val document = Uri.parse("content://$packageName.result-document/$kind/$id")
                grantUriPermission("com.agentoncloud.android", document, Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                result.put("documentUri", document.toString())
            }
            val directory = File(filesDir, "result-probes").apply { mkdirs() }
            val staged = File(directory, "$id.json.tmp").apply { writeText(result.toString()) }
            check(staged.renameTo(File(directory, "$id.json")))
            runOnUiThread { setContentView(TextView(this).apply { text = result.toString(); textSize = 16f }) }
        }.start()
    }
}
