package com.andysagent.ragent

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.model.RuntimeConnectionState
import com.andysagent.ragent.core.network.OkHttpRagentTransport
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PSession
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.webrtc.DataChannel
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** Explicitly opt-in: close only the auxiliary history channel on a test device. */
class BulkChannelLiveAcceptanceTest {
    @Test fun historyChannelClosureFallsBackWithoutDroppingPrimary(): Unit = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveBulkFallback") == "true")
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as RagentApplication
        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)).use {
            val runtime = app.runtime
            val primary = requireNotNull(runtime.configStore.directory.first().activeTarget).instanceId
            withTimeout(150_000) { runtime.targetConnectionStates.first { it[primary] == RuntimeConnectionState.Connected } }
            runtime.withTargetRuntime(primary) { target ->
                val transport = target.transport as OkHttpRagentTransport
                fun unwrap(session: P2PSession, depth: Int = 0): WebRTCDataChannelTransport? {
                    if (session is WebRTCDataChannelTransport) return session
                    if (depth > 3) return null
                    return session.javaClass.declaredFields.asSequence()
                        .filter { P2PSession::class.java.isAssignableFrom(it.type) }
                        .mapNotNull { field -> field.isAccessible = true; (field.get(session) as? P2PSession)?.let { unwrap(it, depth + 1) } }
                        .firstOrNull()
                }
                val carrier = withTimeout(20_000) {
                    while (true) {
                        val sessions = listOf("turnSession", "p2pSession").mapNotNull { name ->
                            val field = transport.javaClass.getDeclaredField(name).apply { isAccessible = true }
                            (field.get(transport) as AtomicReference<*>).get() as? P2PSession
                        }
                        sessions.firstNotNullOfOrNull { unwrap(it) }?.let { return@withTimeout it }
                        delay(100)
                    }
                    error("unreachable")
                }
                val bulkField = carrier.javaClass.getDeclaredField("bulkChannel").apply { isAccessible = true }
                val channel = withTimeout(20_000) {
                    while (true) {
                        (bulkField.get(carrier) as? DataChannel)?.takeIf { it.state() == DataChannel.State.OPEN }?.let { return@withTimeout it }
                        delay(100)
                    }
                    error("unreachable")
                }
                val session = withTimeout(20_000) { target.sessions.observeSessions().first { it.isNotEmpty() }.first() }
                val credentialField = transport.javaClass.getDeclaredField("credentialProvider").apply { isAccessible = true }
                @Suppress("UNCHECKED_CAST")
                val credential = (credentialField.get(transport) as () -> String?).invoke()
                val headers = credential?.takeIf { it.isNotBlank() }?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()
                val id = UUID.randomUUID().toString()
                val pathId = URLEncoder.encode(session.id, Charsets.UTF_8.name()).replace("+", "%20")
                val request = P2PHttpRequest(id = id, method = "GET", headers = headers,
                    path = "/api/sessions/$pathId/events/wait?filter=all&limit=1&afterSeq=9007199254740991&timeoutMs=15000")
                val pendingField = carrier.javaClass.getDeclaredField("bulkPending").apply { isAccessible = true }
                @Suppress("UNCHECKED_CAST")
                val pending = pendingField.get(carrier) as Set<String>
                val response = async { carrier.request(request) }
                withTimeout(10_000) { while (id !in pending) delay(20) }
                channel.close()
                val result = withTimeout(35_000) { response.await().getOrThrow() }
                assertEquals(200, result.status)
                assertEquals(id, result.id)
                assertTrue("Primary connection must remain usable", target.transport.connectionState.value == RuntimeConnectionState.Connected)
            }
        }
    }
}
