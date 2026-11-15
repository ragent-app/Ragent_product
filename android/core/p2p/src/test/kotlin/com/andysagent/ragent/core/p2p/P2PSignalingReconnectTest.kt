package com.andysagent.ragent.core.p2p

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertNotNull

class P2PSignalingReconnectTest {
    @Test fun `graceful close followed by failed reconnect continues until joined`(): Unit = runBlocking {
        val room = "a".repeat(40)
        val accepted = LinkedBlockingQueue<WebSocket>()
        fun upgrade() = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (JSONObject(text).optString("type") == "join") {
                    webSocket.send(JSONObject().put("type", "joined").put("roomId", room).put("role", "mobile").toString())
                    accepted.offer(webSocket)
                }
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
        })
        val server = MockWebServer()
        server.enqueue(upgrade())
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(upgrade())
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val client = P2PSignalingClient(server.url("/").toString(), room, "synthetic-secret",
            object : P2PSignalingClient.SignalingCallback {
                override fun onAnswer(sdp: String) = Unit
                override fun onIceCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int) = Unit
                override fun onError(error: String) = Unit
            }, scope)
        try {
            client.connect()
            val original = assertNotNull(accepted.poll(3, TimeUnit.SECONDS))
            original.close(1001, "expired")
            assertNotNull(accepted.poll(12, TimeUnit.SECONDS), "must reconnect after a failed attempt")
        } finally {
            client.close()
            scope.cancel()
            server.shutdown()
        }
    }
}
