package com.andysagent.ragent

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.andysagent.ragent.core.p2p.P2PCandidate
import com.andysagent.ragent.core.p2p.IceServer
import com.andysagent.ragent.core.p2p.P2PHttpRequest
import com.andysagent.ragent.core.p2p.P2PProtocol
import com.andysagent.ragent.core.p2p.WebRTCDataChannelTransport
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Android -> signaling -> Pion -> upstream HTTP journey.
 *
 * The test is intentionally opt-in because it needs a host-side signaling
 * server and Pion sidecar. The host runner passes the room credentials as
 * instrumentation arguments; they are never printed.
 */
@RunWith(AndroidJUnit4::class)
class AndroidP2PDataChannelE2ETest {

    @Test
    fun opensDataChannelAndProxiesProtectedHttp() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val signalingUrl = args.getString("p2pSignalingUrl")
        val roomId = args.getString("p2pRoomId")
        val secret = args.getString("p2pSecret")
        val stunUrl = args.getString("p2pStunUrl")?.takeIf { it.startsWith("stun:") }
        assumeTrue("P2P E2E requires p2pSignalingUrl", !signalingUrl.isNullOrBlank())
        assumeTrue("P2P E2E requires p2pRoomId", !roomId.isNullOrBlank())
        assumeTrue("P2P E2E requires p2pSecret", !secret.isNullOrBlank())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val transport = WebRTCDataChannelTransport(
            candidate = P2PCandidate(
                signalingUrl = signalingUrl!!,
                roomId = roomId!!,
                secret = secret!!,
                // A supplied STUN server permits cross-network testing; with
                // no argument this remains the original host-candidate test.
                iceServers = stunUrl?.let { listOf(IceServer(it)) } ?: emptyList(),
            ),
            appContext = context,
            connectTimeoutMs = 30_000L,
            requestTimeoutMs = 15_000L,
        )

        try {
            val connected = transport.connect()
            assertTrue("real WebRTC DataChannel must open: ${connected.exceptionOrNull()}", connected.isSuccess)
            assertTrue("transport must report OPEN", transport.isOpen)

            val response = transport.request(
                P2PHttpRequest(
                    id = "android-p2p-e2e-1",
                    method = "POST",
                    path = "/probe?q=android",
                    headers = mapOf(
                        "Authorization" to "Bearer rdt_${"a".repeat(64)}",
                        "Content-Type" to "text/plain",
                    ),
                    bodyBase64 = P2PProtocol.encodeBody("hello-android-p2p"),
                ),
            ).getOrThrow()

            assertEquals(200, response.status)
            assertEquals("yes", response.headers["X-Ragent-P2p"])
            assertEquals(
                "hello-android-p2p",
                P2PProtocol.decodeBodyToString(response.bodyBase64),
            )
            println("ANDROID_P2P_DATACHANNEL_E2E_OK status=${response.status} bodyBytes=${response.bodyBase64.length}")
        } finally {
            transport.close()
        }
    }
}
