package com.andysagent.ragent.sharefixture

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import android.net.Uri
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.agentoncloud.android.api.*
import com.agentoncloud.android.sdk.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.security.MessageDigest

/** Different-UID SDK consumer. Exported QA commands are restricted to synthetic local operations. */
class AppApiClientSourceActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var client: RagentClient
    private lateinit var status: TextView
    private lateinit var report: JSONObject
    private fun token() = requireNotNull(intent.getStringExtra("token")).also { require(Regex("[a-f0-9-]{36}").matches(it)) }
    private fun target() = requireNotNull(intent.getStringExtra("target")).also { require(it.startsWith("ipc-test-")) }
    private fun operation() = requireNotNull(intent.getStringExtra("operation")).also { require(it.startsWith("ipc-test-")) }
    private fun request() = PublicTaskRequest(operation(), "SDK synthetic local preparation", PublicRuntime("codex"), targetInstanceId = target())
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        client = RagentClient(this)
        report = JSONObject().put("uid", android.os.Process.myUid()).put("token", token())
        status = TextView(this).apply { text = "App API client ready: ${token()}" }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; fitsSystemWindows = true
            addView(status)
            addView(Button(this@AppApiClientSourceActivity).apply {
                text = "Run App API probe"
                setOnClickListener {
                    isEnabled = false
                    scope.launch {
                        try { withTimeout(30_000) { probe() } }
                        catch (failure: Throwable) { report.put("failure", failure.toString()); save("FAILED") }
                    }
                }
            })
        })
    }
    private fun save(stage: String) {
        report.put("stage", stage)
        val tmp = File(filesDir, "app-api-result.tmp").apply { writeText(report.toString()) }
        check(tmp.renameTo(File(filesDir, "app-api-result.json")))
        status.text = "App API probe: $stage"
    }
    private suspend fun expectedError(name: String, action: suspend () -> Any?) {
        val code = try { action(); "UNEXPECTED_SUCCESS" } catch (failure: RagentApiException) { failure.error.code }
        report.put(name, code)
    }
    private suspend fun probe() {
        report.put("api", JSONObject(AppApiWire.encode(client.connect())))
        report.put("capabilities", JSONObject(AppApiWire.encode(client.capabilities(PageFilter(targetInstanceId = target(), limit = 32)))))
        report.put("computers", JSONObject(AppApiWire.encode(client.computers(PageFilter(targetInstanceId = target())))))
        when (intent.getStringExtra("mode")) {
            "exercise" -> {
                val prepared = client.tasks.prepare(request())
                val replay = client.tasks.prepare(request())
                report.put("preparationStable", replay.preparationId == prepared.preparationId)
                expectedError("changedInput") { client.tasks.prepare(request().copy(instruction = "changed input")) }
                report.put("operation", JSONObject(AppApiWire.encode(client.tasks.get(operation()))))
                val watch = client.watch(OperationWatch(operationId = operation())).first { it.operation != null }
                report.put("firstSnapshot", JSONObject(AppApiWire.encode(watch)))
                val cancelled = client.tasks.cancelSubmission(operation())
                report.put("cancelled", JSONObject(AppApiWire.encode(cancelled)))
                report.put("reconciled", JSONObject(AppApiWire.encode(client.tasks.reconcile(operation()))))
                // Only attempt commit AFTER confirmed cancellation; never sends a synthetic PC task.
                check(cancelled.stage == "CANCELLED")
                expectedError("cancelledCommit") { client.tasks.submit(prepared) }
                expectedError("unsubmittedResult") { client.tasks.result(operation()) }
                expectedError("unsubmittedManifest") { client.tasks.manifest(operation()) }
                expectedError("foreignOwnerOperation") { client.tasks.get(operation() + "-owner") }
                report.put("malformed", JSONObject(raw("""{"apiVersion":1,"operationId":"${operation()}-bad","instruction":"x","runtime":{"tool":"codex"},"callerBinding":"owner"}""")))
                report.put("oversize", JSONObject(raw(AppApiWire.encode(request().copy(instruction = "大".repeat(24_000))))))
                expectedError("futureVersion") { client.tasks.prepare(request().copy(apiVersion = 2)) }
                save("COMPLETED")
            }
            "sessionsDenied" -> {
                expectedError("sessionList") { client.sessions.list(target()) }
                expectedError("sessionSearch") { client.sessions.search(target(), "Title") }
                expectedError("sessionGet") { client.sessions.get(target(), "session") }
                expectedError("emptySearch") { client.sessions.search(target(), " ") }
                expectedError("oversizedPage") { client.sessions.list(target(), limit = 33) }
                val mutation = PublicSessionMutationRequest(operation(), target(), "session", PublicSessionMutationKind.RENAME, title = "Title")
                expectedError("mutationPrepare") { client.sessions.prepareMutation(mutation) }
                expectedError("invalidMutation") { client.sessions.prepareMutation(mutation.copy(flag = true)) }
                expectedError("missingMutation") { client.sessions.getMutation(operation()) }
                expectedError("missingMutationReceipt") { client.sessions.reconcileMutation(operation()) }
                expectedError("missingMutationCancel") { client.sessions.cancelMutation(operation()) }
                expectedError("missingMutationRename") { client.sessions.rename(operation()) }
                save("COMPLETED")
            }
            "denied" -> { expectedError("prepareError") { client.tasks.prepare(request()) }; save("COMPLETED") }
            "get" -> { expectedError("getError") { report.put("operation", JSONObject(AppApiWire.encode(client.tasks.get(operation())))) }; save("COMPLETED") }
            "cachedDownload" -> {
                val download = client.tasks.download(operation(), "d".repeat(64), "text", operation())
                report.put("download", JSONObject(AppApiWire.encode(download)))
                val bytes = contentResolver.openInputStream(Uri.parse(download.uri))!!.use { it.readBytes() }
                report.put("receivedBytes", bytes.size)
                report.put("receivedSha256", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) })
                val again = client.tasks.download(operation(), "d".repeat(64), "text", operation())
                report.put("independentDelivery", again.uri != download.uri)
                report.put("secondUri", again.uri)
                save("COMPLETED")
            }
            "revokedUri" -> {
                val uri = Uri.parse(requireNotNull(intent.getStringExtra("uri")))
                require(uri.scheme == "content" && uri.authority == "com.agentoncloud.android.result-files")
                report.put("uriRead", try {
                    contentResolver.openInputStream(uri)!!.use { it.read() }; "UNEXPECTED_SUCCESS"
                } catch (failure: Exception) { failure.javaClass.simpleName })
                save("COMPLETED")
            }
            "hold" -> {
                client.tasks.prepare(request())
                scope.launch {
                    client.watch(OperationWatch(operationId = operation(), lifetimeMs = 120_000)).collect {
                        if (it.kind == "FAILED" || it.operation != null) {
                            report.put("event", JSONObject(AppApiWire.encode(it))); save(if (it.kind == "FAILED") "WATCH_FAILED" else "WATCH_READY")
                        }
                    }
                }
            }
            "quota" -> {
                client.tasks.prepare(request())
                // Use only the original subscribe request ID; never consume an ACK/subscription ID.
                report.put("requestAliasClosures", withRawEndpoint { endpoint ->
                    repeat(8) {
                        val subscribeId = UUID.randomUUID().toString()
                        endpoint.subscribe(subscribeId, AppApiWire.encode(OperationWatch(operationId = operation(), lifetimeMs = 120_000)), object : IAppApiCallback.Stub() {
                            override fun onResponse(id: String, payload: String) = Unit
                        })
                        val closed = CompletableDeferred<PublicResponse>(); val unsubscribeId = UUID.randomUUID().toString()
                        endpoint.unsubscribe(unsubscribeId, "request:$subscribeId", object : IAppApiCallback.Stub() {
                            override fun onResponse(id: String, payload: String) { if (id == unsubscribeId) closed.complete(AppApiWire.decode(payload)) }
                        })
                        check(closed.await().error == null)
                    }
                    8
                })
                val ready = List(4) { CompletableDeferred<Unit>() }
                val jobs = ready.map { signal -> scope.launch {
                    client.watch(OperationWatch(operationId = operation(), lifetimeMs = 120_000)).collect {
                        if (it.operation != null) signal.complete(Unit)
                    }
                } }
                ready.forEach { it.await() }
                expectedError("fifthWatch") { client.watch(OperationWatch(operationId = operation())).first() }
                jobs.forEach { it.cancelAndJoin() }
                // Repeat cancellation immediately after handshake, exercising cleanup before first snapshot.
                repeat(12) { client.watch(OperationWatch(operationId = operation())).first(); delay(75) }
                delay(500)
                report.put("resumedSnapshot", JSONObject(AppApiWire.encode(client.watch(OperationWatch(operationId = operation())).first { it.operation != null })))
                save("COMPLETED")
            }
            else -> error("Unsupported synthetic probe")
        }
    }
    private suspend fun raw(payload: String): String = withRawEndpoint { endpoint ->
        val result = CompletableDeferred<String>(); val id = UUID.randomUUID().toString()
        endpoint.prepare(id, payload, object : IAppApiCallback.Stub() {
            override fun onResponse(requestId: String, value: String) { if (requestId == id) result.complete(value) }
        })
        result.await()
    }
    private suspend fun <T> withRawEndpoint(block: suspend (IAppApiService) -> T): T {
        val connected = CompletableDeferred<IAppApiService>()
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) { connected.complete(IAppApiService.Stub.asInterface(binder)) }
            override fun onServiceDisconnected(name: ComponentName) = Unit
        }
        check(bindService(Intent(AppApiWire.ACTION).setClassName(AppApiWire.PACKAGE, AppApiWire.SERVICE), connection, Context.BIND_AUTO_CREATE))
        try { return block(connected.await()) } finally { unbindService(connection) }
    }
    override fun onDestroy() { scope.cancel(); client.close(); super.onDestroy() }
}
