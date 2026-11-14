package com.andysagent.agentoc

import android.content.Context
import com.andysagent.agentoc.core.auth.AndroidTemporaryEncryptedStore
import com.andysagent.agentoc.core.network.ApiRequest
import com.andysagent.agentoc.core.network.ApiException
import com.andysagent.agentoc.core.network.BootstrapConnectionPlan
import com.andysagent.agentoc.core.network.OkHttpAgentoCTransport
import com.andysagent.agentoc.core.model.RuntimeConnectionState
import kotlinx.coroutines.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import java.net.Proxy

internal data class LocalPairing(val instanceId: String, val endpoint: String, val token: String) {
    companion object {
        fun parse(text: String): LocalPairing {
            require(text.toByteArray(Charsets.UTF_8).size <= 4096) { "Pairing file is too large" }
            val obj = Json.parseToJsonElement(text).jsonObject
            require(obj.keys == setOf("version", "kind", "baseUrl", "instanceId", "token")) { "Invalid pairing file" }
            require(obj["version"]?.jsonPrimitive?.let { !it.isString && it.content == "1" } == true &&
                obj["kind"]?.jsonPrimitive?.let { it.isString && it.content == "ragent-proot-local" } == true &&
                listOf("baseUrl", "instanceId", "token").all { obj[it]?.jsonPrimitive?.isString == true }) { "Unsupported pairing file" }
            val endpoint = obj.getValue("baseUrl").jsonPrimitive.content
            val match = Regex("^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})$").matchEntire(endpoint)
            require(match != null && match.groupValues[1].toInt() <= 65535) { "Invalid local address" }
            val id = obj.getValue("instanceId").jsonPrimitive.content
            val token = obj.getValue("token").jsonPrimitive.content
            require(id.matches(Regex("^inst_[A-Za-z0-9_-]{1,120}$")) && token.matches(Regex("^[0-9a-f]{64}$"))) { "Invalid local credentials" }
            return LocalPairing(id, endpoint, token)
        }
    }
}

internal class LocalCredentialStore(context: Context) {
    private val store = AndroidTemporaryEncryptedStore(context, "ragent-local-runtime", "ragent_local_runtime_v1", maxPlaintextBytes = 128)
    fun read(id: String) = store.read(id)
    fun write(id: String, token: String) = store.write(id, token)
    fun clear(id: String) = store.clear(id)
}

internal fun localHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .proxy(Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false)
    // A frozen loopback server leaves TCP open; missed WebSocket pongs must
    // move the UI out of Connected and trigger identity-checked recovery.
    .pingInterval(15, java.util.concurrent.TimeUnit.SECONDS).build()

/** Identity is checked before opening the socket or exposing the transport to callers. */
internal class LocalTargetConnection(
    private val instanceId: String,
    private val transport: OkHttpAgentoCTransport,
    private val scope: CoroutineScope,
    private val identityVerified: java.util.concurrent.atomic.AtomicBoolean,
) : TargetConnectionController {
    private var job: Job? = null
    override fun start() = refresh()
    override fun refresh() {
        identityVerified.set(false)
        job?.cancel()
        job = scope.launch {
            transport.close()
            while (isActive) {
                transport.updateCarrierConnectionState(RuntimeConnectionState.Connecting)
                val valid = try {
                    val response = transport.execute(ApiRequest("GET", "/api/local/identity", isolateCredentialFailure = true))
                    Json.parseToJsonElement(response.body).jsonObject["instanceId"]?.jsonPrimitive?.content == instanceId
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: ApiException) {
                    if (error.statusCode == 401 || error.statusCode == 403) {
                        transport.markAuthenticationRequired()
                        return@launch
                    }
                    false
                }
                catch (_: Exception) { false }
                if (valid) {
                    identityVerified.set(true)
                    transport.connectInvalidationSocket()
                    return@launch
                }
                transport.updateCarrierConnectionState(RuntimeConnectionState.Error)
                delay(5000)
            }
        }
    }
    override suspend fun stop() { identityVerified.set(false); job?.cancelAndJoin(); job = null; transport.close() }
    override fun applyVerifiedBootstrap(plan: BootstrapConnectionPlan) = Unit
}

/** Unauthenticated discovery is only a visibility hint; pairing still verifies identity. */
private val localDiscoveryMutex = kotlinx.coroutines.sync.Mutex()

internal suspend fun discoverLocalRuntime(): Boolean {
    localDiscoveryMutex.lock()
    try { return withContext(Dispatchers.IO) {
    val client = localHttpClient().newBuilder()
        .callTimeout(1200, java.util.concurrent.TimeUnit.MILLISECONDS).build()
    try {
        val request = okhttp3.Request.Builder().url("http://127.0.0.1:17690/api/local/discovery").build()
        client.newCall(request).execute().use { response ->
            if (response.code != 200) return@use false
            val obj = Json.parseToJsonElement(response.peekBody(1024).string()).jsonObject
            obj["version"]?.jsonPrimitive?.let { !it.isString && it.content == "1" } == true &&
                obj["kind"]?.jsonPrimitive?.let { it.isString && it.content == "ragent-proot-local" } == true
        }
    } catch (_: Exception) { false }
    } } finally { localDiscoveryMutex.unlock() }
}
